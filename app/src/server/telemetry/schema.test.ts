import { describe, expect, it } from 'vitest';

import { parseTelemetryBatch, sanitizeAttrs, telemetryEventInputSchema } from './schema';
import { TELEMETRY_LIMITS } from './types';

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
