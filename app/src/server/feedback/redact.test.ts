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

describe('v2 diagnostics: the app in front and the recent activity log', () => {
    const t = '2026-11-03T21:30:00.000Z';

    it('redacts every log line on the server even when the shell sent it raw', () => {
        // The shell scrubs first; this proves the server does not depend on it.
        const raw = [
            'error GET https://os.example.test/api/shell/start?token=abc failed',
            fake('Authorization: Bearer ', 'abcdefghijklmnopqrstuvwxyz0123456789'),
            'cookie: __Host-ezil-os-auth=top-secret-cookie',
            `opened /home/alice/workspace/secret-project/src/main.ts for 550e8400-e29b-41d4-a716-446655440000`,
            'mailed carol@example.com about eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.signature',
            fake('key=', 'AKIA', '1234567890ABCDEF'),
        ];
        const result = sanitizeDiagnostics({ app: 'dave@example.com', logs: raw.map((text) => ({ t, source: 'console', text })) })!;
        const sent = JSON.stringify(result);
        for (const leaked of ['os.example.test', 'abcdefghijklmnopqrstuvwxyz0123456789', 'top-secret-cookie', 'alice',
            'secret-project', '550e8400', 'carol@', 'eyJhbGci', 'AKIA1234567890ABCDEF', 'dave@']) {
            expect(sent).not.toContain(leaked);
        }
        expect(result.app).toBe('[redacted:email]');
        expect(result.logs).toHaveLength(raw.length);
        expect(result.logs!.every((line) => line.t === t && line.source === 'console')).toBe(true);
        expect(diagnosticsSchema.safeParse(result).success).toBe(true);
    });

    it('keeps an ordinary app name and log line readable', () => {
        const result = sanitizeDiagnostics({ app: 'browser', logs: [{ t, source: 'event', text: 'api_failure shell.start start_failed failure' }] });
        expect(result).toEqual({ app: 'browser', logs: [{ t, source: 'event', text: 'api_failure shell.start start_failed failure' }] });
    });

    it('bounds the log: at most 60 lines of 200 characters, closed sources, UTC instants only', () => {
        const line = { t, source: 'console' as const, text: 'x'.repeat(200) };
        expect(diagnosticsSchema.safeParse({ logs: Array(60).fill(line) }).success).toBe(true);
        expect(diagnosticsSchema.safeParse({ logs: Array(61).fill(line) }).success).toBe(false);
        expect(diagnosticsSchema.safeParse({ logs: [{ ...line, text: 'x'.repeat(201) }] }).success).toBe(false);
        expect(diagnosticsSchema.safeParse({ logs: [{ ...line, source: 'network' }] }).success).toBe(false);
        expect(diagnosticsSchema.safeParse({ logs: [{ ...line, t: 'Mon Nov 03 2026 22:30 GMT+0100' }] }).success).toBe(false);
        expect(diagnosticsSchema.safeParse({ logs: [{ ...line, url: 'https://example.test/' }] }).success).toBe(false);
        expect(diagnosticsSchema.safeParse({ app: 'x'.repeat(33) }).success).toBe(false);
        // A redaction that lengthens a line still fits the bound it is stored under.
        const expanded = sanitizeDiagnostics({ logs: [{ t, source: 'console', text: 'a@b.co '.repeat(28) }] })!;
        expect(expanded.logs![0].text.length).toBeLessThanOrEqual(200);
        expect(diagnosticsSchema.safeParse(expanded).success).toBe(true);
    });
});
