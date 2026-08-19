import { describe, expect, it } from 'vitest';

import { parseTelemetryBatch, sanitizeAttrs, telemetryEventInputSchema } from './schema';
import {
    ATTRS_ALLOW_LIST,
    BROWSER_FIX_SITES,
    TELEMETRY_CODE_PATTERN,
    TELEMETRY_LIMITS,
    type BrowserFixSite,
} from './types';

function validEvent(overrides: Record<string, unknown> = {}) {
    return {
        eventId: '550e8400-e29b-41d4-a716-446655440000',
        schemaVersion: 1,
        eventClass: 'crash',
        source: 'shell',
        occurredAt: '2026-08-01T00:00:00.000Z',
        site: 'ezil-os:boot#mount',
        code: 'mount_failed',
        outcome: 'error',
        ...overrides,
    };
}

describe('telemetryEventInputSchema: the privacy contract (§5.2)', () => {
    it('accepts a well-formed event with no identity fields', () => {
        expect(telemetryEventInputSchema.safeParse(validEvent()).success).toBe(true);
    });

    it('REJECTS an event carrying userId — .strict() catches an accidental identity leak', () => {
        const result = telemetryEventInputSchema.safeParse(validEvent({ userId: 'abc-123' }));
        expect(result.success).toBe(false);
    });

    it('REJECTS an event carrying email', () => {
        const result = telemetryEventInputSchema.safeParse(validEvent({ email: 'user@example.com' }));
        expect(result.success).toBe(false);
    });

    it('REJECTS an unknown eventClass (closed-set enum)', () => {
        const result = telemetryEventInputSchema.safeParse(validEvent({ eventClass: 'totally_made_up' }));
        expect(result.success).toBe(false);
    });

    it('REJECTS a code with characters outside [a-z0-9_]', () => {
        const result = telemetryEventInputSchema.safeParse(validEvent({ code: 'Bad Code!' }));
        expect(result.success).toBe(false);
    });

    it('REJECTS an oversized detail beyond the 200-char bound', () => {
        const result = telemetryEventInputSchema.safeParse(validEvent({ detail: 'x'.repeat(201) }));
        expect(result.success).toBe(false);
    });

    it('REJECTS a non-uuid eventId', () => {
        const result = telemetryEventInputSchema.safeParse(validEvent({ eventId: 'not-a-uuid' }));
        expect(result.success).toBe(false);
    });
});

describe('sanitizeAttrs: per-class allow-list, strip not reject', () => {
    it('keeps stack_head for crash, drops anything else', () => {
        const out = sanitizeAttrs('crash', { stack_head: 'foo@bar.js', evil: 'should not survive' });
        expect(out).toEqual({ stack_head: 'foo@bar.js' });
    });

    it('drops every attrs key for a class with an empty allow-list (boot_phase)', () => {
        expect(sanitizeAttrs('boot_phase', { anything: 1 })).toBeUndefined();
    });

    it('returns undefined for undefined input, never throws', () => {
        expect(sanitizeAttrs('crash', undefined)).toBeUndefined();
    });

    it('keeps only status/retryable for api_failure, not an arbitrary key', () => {
        const out = sanitizeAttrs('api_failure', { status: 500, retryable: true, extra: 'nope' });
        expect(out).toEqual({ status: 500, retryable: true });
    });
});

describe('parseTelemetryBatch: bounds and flood behaviour', () => {
    it('caps at MAX_EVENTS_PER_BATCH even when the body claims more, without throwing', () => {
        const events = Array.from({ length: 500 }, (_, i) =>
            validEvent({ eventId: `550e8400-e29b-41d4-a716-4466554400${String(i).padStart(2, '0')}` }),
        );
        const result = parseTelemetryBatch({ schemaVersion: 1, events });
        expect(result.rawCount).toBe(500);
        expect(result.events.length).toBe(TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH);
    });

    it('one invalid event in a batch is dropped, not the whole batch', () => {
        const good = validEvent({ eventId: '550e8400-e29b-41d4-a716-446655440001' });
        const bad = validEvent({ eventId: '550e8400-e29b-41d4-a716-446655440002', userId: 'leak' });
        const result = parseTelemetryBatch({ schemaVersion: 1, events: [good, bad] });
        expect(result.events.length).toBe(1);
        expect(result.droppedInvalid).toBe(1);
    });

    it('a malformed top-level body yields an empty batch, never throws', () => {
        expect(() => parseTelemetryBatch(null)).not.toThrow();
        expect(() => parseTelemetryBatch('not an object')).not.toThrow();
        expect(() => parseTelemetryBatch(undefined)).not.toThrow();
        expect(parseTelemetryBatch(null).events).toEqual([]);
        expect(parseTelemetryBatch({ garbage: true }).events).toEqual([]);
    });

    it('an empty events array parses to an empty (not dropped-as-invalid) batch', () => {
        const result = parseTelemetryBatch({ schemaVersion: 1, events: [] });
        expect(result.events).toEqual([]);
        expect(result.droppedInvalid).toBe(0);
    });
});

// ── docs/BROWSER-FIX-CONTRACT.md §8 ─────────────────────────────────────────
//
// Six agents are told to emit these six site/class pairs. This block proves
// the ingest end of that pipe accepts them BEFORE any of them ships, and pins
// the one place the contract's prose and the schema disagree.

describe('the browser-fix contract §8 rows survive ingest validation', () => {
    const ROWS: Array<{ site: BrowserFixSite | string; eventClass: string; code: string }> = [
        { site: BROWSER_FIX_SITES.DESKTOP_SCREEN, eventClass: 'api_failure', code: 'screen_upstream' },
        { site: BROWSER_FIX_SITES.DESKTOP_SCREEN, eventClass: 'contract_violation', code: 'screen_unrequested_size' },
        { site: BROWSER_FIX_SITES.DESKTOP_CLOSE, eventClass: 'window_error', code: 'release_failed' },
        { site: BROWSER_FIX_SITES.DESKTOP_KEYBOARD, eventClass: 'window_error', code: 'xtest_dead' },
        { site: BROWSER_FIX_SITES.NEKO_DECOR, eventClass: 'contract_violation', code: 'decor_still_present' },
        // W4's clean/crash exit reporting, added to §8 after the first draft.
        { site: 'container:neko#app_exit', eventClass: 'boot_phase', code: 'app_exit_clean' },
    ];

    it('every contract site/class/code triple validates', () => {
        for (const row of ROWS) {
            const result = telemetryEventInputSchema.safeParse(
                validEvent({ site: row.site, eventClass: row.eventClass, code: row.code }),
            );
            expect(`${row.site}/${row.eventClass}/${row.code} -> ${result.success}`).toBe(
                `${row.site}/${row.eventClass}/${row.code} -> true`,
            );
        }
    });

    it('every contract site fits MAX_SITE_LEN with room to spare', () => {
        for (const site of Object.values(BROWSER_FIX_SITES)) {
            expect(site.length).toBeLessThanOrEqual(TELEMETRY_LIMITS.MAX_SITE_LEN);
        }
    });

    it('🔴 a HYPHENATED code is REJECTED, which is why §8 was corrected to underscores', () => {
        // Not a nitpick: `parseTelemetryBatch` drops a failing event WHOLE, so
        // a producer emitting `screen-unsupported` would ship telemetry that
        // silently never lands. §8 originally said "hyphenated" and was
        // corrected; the belt-and-braces guard is normalisation at each
        // producer (`normalizeCode` in shell/ezil/telemetry.js,
        // `normalizeTelemetryCode` in worker/src/telemetry.ts). This test
        // exists so widening the regex instead is a deliberate, visible act.
        for (const literal of ['screen-unsupported', 'screen-upstream', 'decor-still-present', 'xtest-dead']) {
            expect(TELEMETRY_CODE_PATTERN.test(literal)).toBe(false);
            expect(telemetryEventInputSchema.safeParse(validEvent({ code: literal })).success).toBe(false);
            // ...and the normalised form is accepted.
            expect(
                telemetryEventInputSchema.safeParse(validEvent({ code: literal.replace(/-/g, '_') })).success,
            ).toBe(true);
        }
    });

    it('TELEMETRY_CODE_PATTERN is the SAME rule the schema enforces, not a second copy', () => {
        for (const probe of ['ok', 'screen_upstream', 'a1_b2', 'Screen', 'a-b', 'a.b', 'a b', '']) {
            const viaSchema = telemetryEventInputSchema.safeParse(validEvent({ code: probe })).success;
            expect(`${probe || '<empty>'}: ${TELEMETRY_CODE_PATTERN.test(probe)}`).toBe(
                `${probe || '<empty>'}: ${viaSchema}`,
            );
        }
    });

    it('no contract row needs an attrs key that is not already allow-listed', () => {
        // §8's rows carry no attrs at all today. `boot_phase` in particular has
        // an EMPTY allow-list, so a container row that wants to say WHICH of
        // something happened must encode it in `code` (`app_exit_clean` vs
        // `app_exit_crash`), never in attrs.
        expect(ATTRS_ALLOW_LIST.boot_phase).toEqual([]);
        expect(ATTRS_ALLOW_LIST.contract_violation).toEqual([]);
        expect(ATTRS_ALLOW_LIST.window_error).toContain('app_id');
        expect(ATTRS_ALLOW_LIST.api_failure).toContain('status');
        // An `xserver` attrs key would be silently stripped, so anyone who
        // tries it gets a row with no answer in it. Proven, not asserted.
        const stripped = sanitizeAttrs('boot_phase', { xserver: 'xorg' });
        expect(stripped).toBeUndefined();
    });
});
