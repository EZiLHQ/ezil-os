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

describe('diagnostics sanitization', () => {
    it('sanitizes every string field and preserves typed numeric/boolean fields', () => {
        const input: FeedbackDiagnostics = {
            shellVersion: 'alice@example.com', appCommit: 'eyJabc.def.ghi',
            browser: { family: 'bob@example.com', major: 130 }, os: 'bob@example.com',
            deviceClass: 'desktop', viewport: { w: 1920, h: 1080, dpr: 2 }, fullscreen: false, fullbleed: true,
            computerStatus: 'bob@example.com', traceId: 'id:550e8400-e29b-41d4-a716-446655440000',
            phases: ['bob@example.com'], recentEvents: [{ eventClass: 'bob@example.com', site: 'eyJabc.def.ghi', code: 'https://example.test/private?token=abc' }],
            stream: { state: 'bob@example.com', kbps: 1200, rttMs: 40 },
        };
        const result = sanitizeDiagnostics(input)!;
        expect(result).toEqual({
            shellVersion: '[redacted:email]', appCommit: '[redacted:jwt]',
            browser: { family: '[redacted:email]', major: 130 }, os: '[redacted:email]',
            deviceClass: 'desktop', viewport: input.viewport, fullscreen: false, fullbleed: true,
            computerStatus: '[redacted:email]', traceId: 'id:[redacted:uuid]', phases: ['[redacted:email]'],
            recentEvents: [{ eventClass: '[redacted:email]', site: '[redacted:jwt]', code: '<url>]' }],
            stream: { state: '[redacted:email]', kbps: 1200, rttMs: 40 },
        });
        expect(input.shellVersion).toBe('alice@example.com');
        expect(diagnosticsSchema.safeParse(result).success).toBe(true);
    });

    it('masks UUIDs embedded in text and retains schema bounds after replacements expand', () => {
        const result = sanitizeDiagnostics({ traceId: 'prefix 550e8400-e29b-41d4-a716-446655440000 suffix', stream: { state: 'a@b.co c@d.co e@f.co' } });
        expect(result?.traceId).toBe('prefix [redacted:uuid] suffix');
        expect(result?.stream?.state?.length).toBeLessThanOrEqual(24);
        expect(JSON.stringify(result)).not.toContain('@');
        expect(diagnosticsSchema.safeParse(result).success).toBe(true);
    });

    it('keeps absent diagnostics absent and empty diagnostics empty', () => {
        expect(sanitizeDiagnostics(null)).toBeNull();
        expect(sanitizeDiagnostics(undefined)).toBeNull();
        expect(sanitizeDiagnostics({})).toEqual({});
        expect(sanitizeDiagnostics({ stream: {} })).toEqual({ stream: {} });
    });
});
