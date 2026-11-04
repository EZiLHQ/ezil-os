import { describe, expect, it } from 'vitest';
import { redactDescription, sanitizeDiagnostics } from './redact';
import { diagnosticsSchema, type FeedbackDiagnostics } from './types';

// Provider-shaped fixtures are ASSEMBLED AT RUNTIME from obviously synthetic
// parts (alphabet / digit runs), so no source line or git blob holds a
// contiguous provider-format credential for secret scanners to flag. The
// runtime strings are unchanged, so every redactor rule is still exercised.
const fake = (...parts: string[]): string => parts.join('');

describe('description secret redaction', () => {
    it.each([
        ['eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature', 'jwt'],
        [fake('sk', '-', 'abcdefghijklmnopqrstuvwxyz123456'), 'api-key'],
        [fake('sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz123456'), 'api-key'],
        [fake('sk', '_live_', 'abcdefghijklmnopqrstuvwxyz'), 'api-key'],
        [fake('AKIA', '1234567890ABCDEF'), 'aws-key'],
        [fake('ghp', '_', 'abcdefghijklmnopqrstuvwxyz1234567890'), 'github-token'],
        [fake('github', '_pat_', '1234567890_abcdefghijklmnopqrstuvwxyz'), 'github-token'],
        ...['a', 'b', 'p', 'r'].map((kind) => [`xox${kind}-1234567890-abcdefghijklmnop`, 'slack-token']),
        ['Bearer abcDEF0123._~+/-==', 'bearer'],
        ['bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature', 'bearer'],
        ['__Host-ezil-os-auth=top-secret-cookie', 'auth-cookie'],
        ['sb-project-ref-auth-token=top-secret-cookie', 'supabase-auth'],
        ['sb-project-auth-token.0=base64-abcdefghijklmnop', 'supabase-auth'],
        ['key=0123456789abcdef0123456789abcdef', 'secret'],
        ['secret=YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo=', 'secret'],
        ['token="0123456789abcdef0123456789abcdef"', 'secret'],
        ["password='0123456789abcdef0123456789abcdef'", 'secret'],
    ])('redacts %s once', (secret, kind) => {
        expect(redactDescription(`Before ${secret} after`)).toEqual({ text: `Before [redacted:${kind}] after`, count: 1 });
    });

    it('preserves prose, email addresses and short ordinary assignments', () => {
        const text = 'The Settings button is stuck. Email me at alice@example.com; key=Escape, password=example.';
        expect(redactDescription(text)).toEqual({ text, count: 0 });
    });

    it('counts separate credentials without counting nested JWTs twice', () => {
        const result = redactDescription(`Bearer eyJabc.def.ghi and ${fake('AKIA', '1234567890ABCDEF')} and ${fake('ghp', '_', 'abcdefghijklmnopqrstuvwxyz')}`);
        expect(result.count).toBe(3);
        expect(result.text).toBe('[redacted:bearer] and [redacted:aws-key] and [redacted:github-token]');
    });
});

describe('diagnostics: fail-closed projection (re-review 88e642df-feedback-closed-projection-v1)', () => {
    const t = '2026-11-03T21:30:00.000Z';
    const known = { eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'capacity_unavailable' };

    it('keeps closed fields only from their lists, bounds the free ones, and drops fields no shell sends', () => {
        const input: FeedbackDiagnostics = {
            shellVersion: 'alice@example.com', appCommit: 'eyJabc.def.ghi', app: 'browser',
            browser: { family: 'bob@example.com', major: 130 }, os: 'bob@example.com',
            deviceClass: 'desktop', viewport: { w: 1920, h: 1080, dpr: 2 }, fullscreen: false, fullbleed: true,
            computerStatus: 'bob@example.com', traceId: 'id:550e8400-e29b-41d4-a716-446655440000',
            phases: ['bob@example.com'], recentEvents: [known],
            stream: { state: 'bob@example.com', kbps: 1200, rttMs: 40 },
        };
        const result = sanitizeDiagnostics(input)!;
        expect(result).toEqual({
            shellVersion: '[redacted:email]', app: 'browser',
            deviceClass: 'desktop', viewport: input.viewport, fullscreen: false, fullbleed: true,
            computerStatus: '[redacted:email]', traceId: 'id:[redacted:uuid]',
            recentEvents: [known], stream: { kbps: 1200, rttMs: 40 },
        });
        expect(sanitizeDiagnostics({ browser: { family: 'Firefox', major: 140 }, os: 'macOS' })).toEqual({ browser: { family: 'Firefox', major: 140 }, os: 'macOS' });
        expect(input.shellVersion).toBe('alice@example.com');
        expect(diagnosticsSchema.safeParse(result).success).toBe(true);
    });

    it('keeps absent diagnostics absent and empty diagnostics empty', () => {
        expect(sanitizeDiagnostics(null)).toBeNull();
        expect(sanitizeDiagnostics(undefined)).toBeNull();
        expect(sanitizeDiagnostics({})).toEqual({});
        expect(sanitizeDiagnostics({ stream: {} })).toEqual({ stream: {} });
    });

    // The reviewer's cases, as schema-valid values in the fields a forged or buggy client controls.
    const hostile = [
        'opened sports/sports-mobile-main/next.config.ts', 'sports/sports-mobile-main/next.config.ts',
        String.raw`\\fileserver\private\candidate.txt`, '{"password":"synthetic-short-secret","status":"failed"}',
        'open /home/alice/workspace/my project failed', 'sports%2Fsports-mobile-main%2Fnext.config.ts',
        '%2Fhome%2Falice%2Fworkspace', 'home∕alice∕workspace', 'Authorization: Bearer abc123\nnext line ok',
        'carol@example.com', 'AKIAIOSFODNN7EXAMPLEAKIAIOSFODNN7EXAMPLE', 'plain words the user typed',
    ];

    it.each(hostile)('an unknown site or code %j never reaches storage (recentEvents)', (value) => {
        const result = sanitizeDiagnostics({ recentEvents: [
            { ...known, site: value }, { ...known, code: value }, { ...known, eventClass: value }, known,
        ] })!;
        expect(result.recentEvents).toEqual([{ ...known, code: 'other' }, known]);
        expect(result.omitted).toBe(2);
        expect(JSON.stringify(result)).not.toContain(value.slice(0, 12));
        expect(diagnosticsSchema.safeParse(result).success).toBe(true);
    });

    it.each(hostile)('a log line carrying %j is projected or dropped, whatever it claims', (value) => {
        const line = { t, ...known, outcome: 'error' as const };
        const result = sanitizeDiagnostics({ logs: [
            { ...line, site: value }, { ...line, code: value }, { ...line, t: value }, line,
        ] })!;
        expect(result.logs).toEqual([{ ...line, code: 'other' }, line]);
        expect(result.omitted).toBe(2);
        expect(JSON.stringify(result)).not.toContain(value.slice(0, 12));
    });

    it('rejects the retired free-text log shape at the schema', () => {
        expect(diagnosticsSchema.safeParse({ logs: [{ t, source: 'console', text: 'GET /api failed' }] }).success).toBe(false);
        expect(diagnosticsSchema.safeParse({ logs: Array(61).fill({ t, ...known, outcome: 'ok' }) }).success).toBe(false);
        expect(diagnosticsSchema.safeParse({ logs: [{ t, ...known, outcome: 'maybe' }] }).success).toBe(false);
    });

    it('adds its own drops to the client\'s omission count', () => {
        expect(sanitizeDiagnostics({ omitted: 3, recentEvents: [{ ...known, site: 'x' }] })!.omitted).toBe(4);
        expect(sanitizeDiagnostics({ recentEvents: [known] })!.omitted).toBeUndefined();
    });

    it('an unknown app, browser or OS is left out rather than stored as text', () => {
        expect(sanitizeDiagnostics({ app: 'sports/next.config.ts', browser: { family: 'x/y', major: 1 }, os: 'C:\\Users' })).toEqual({});
    });
});
