import { describe, expect, it } from 'vitest';
import { feedbackFailureRefs, redactDescription, sanitizeDiagnostics } from './redact';
import { diagnosticsSchema, FEEDBACK_LIMITS, feedbackSubmitSchema, type FeedbackDiagnostics } from './types';

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

describe('FEEDBACK-DIAG: recent-event failure annotations', () => {
    const corr = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
    const event = (extra: Record<string, string> = {}) => ({ eventClass: 'api_failure', site: 'ezil-os:apps/desktop#mint', code: 'unauthorized', ...extra });

    it('keeps an allowlisted reason and a server correlation id — the id is NOT uuid-masked', () => {
        const result = sanitizeDiagnostics({ recentEvents: [event({ reason: 'worker_http_401:hmac_signature_mismatch', correlationId: corr })] });
        expect(result?.recentEvents).toEqual([event({ reason: 'worker_http_401:hmac_signature_mismatch', correlationId: corr })]);
        expect(diagnosticsSchema.safeParse(result).success).toBe(true);
    });

    it.each([
        ['a URL with a token', 'https://worker.example.test/?token=abc123'],
        ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'],
        ['a bearer token', 'Bearer abcdef0123456789'],
        ['an sk- key', fake('sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz123456')],
        ['a hex HMAC', 'a3f9c0d1'.repeat(4)],
        ['an email', 'alice@example.com'],
        ['a stack frame', 'at handlePreview (index.ts:12:3)'],
    ])('drops %s in either field, never repairs it', (_name, secret) => {
        const result = sanitizeDiagnostics({ recentEvents: [event({ reason: secret, correlationId: secret })] });
        expect(result?.recentEvents).toEqual([event()]);
        expect(JSON.stringify(result)).not.toContain(secret);
    });

    it('keeps the uuid mask everywhere else, including on the event\'s own text fields', () => {
        const result = sanitizeDiagnostics({ traceId: corr, recentEvents: [event({ code: `x ${corr}`, correlationId: corr })] });
        expect(result?.traceId).toBe('[redacted:uuid]');
        expect(result?.recentEvents?.[0]).toEqual(event({ code: 'x [redacted:uuid]', correlationId: corr }));
    });

    it('accepts only the shapes the server mints, and never the reporter\'s own ids', () => {
        const user = '550e8400-e29b-41d4-a716-446655440000';
        const result = sanitizeDiagnostics({ recentEvents: [
            event({ correlationId: 'srv_0123456789ab' }), event({ correlationId: 'cid_lq2x8k9a3f8d7c6b' }),
            event({ correlationId: corr.toUpperCase() }), event({ correlationId: user }), event({ correlationId: 'corr' }),
        ] }, { excludeIds: [user.toUpperCase(), null] });
        expect(result?.recentEvents?.map((e) => e.correlationId)).toEqual(['srv_0123456789ab', 'cid_lq2x8k9a3f8d7c6b', undefined, undefined, undefined]);
    });

    it('keeps annotations on at most the newest ten events', () => {
        const events = Array.from({ length: 50 }, (_, i) => event({ reason: `worker_http_${500 + i}`, correlationId: 'srv_0123456789ab' }));
        const result = sanitizeDiagnostics({ recentEvents: events })!;
        const annotated = result.recentEvents!.flatMap((e, i) => (e.reason ? [i] : []));
        expect(annotated).toHaveLength(FEEDBACK_LIMITS.recentEventsAnnotatedMax);
        expect(annotated[0]).toBe(40);
        expect(result.recentEvents![49]!.reason).toBe('worker_http_549');
    });

    it('lists the validated failure refs once each, newest last, for the server log', () => {
        expect(feedbackFailureRefs(sanitizeDiagnostics({ recentEvents: [
            event(), event({ reason: 'worker_http_401', correlationId: corr }), event({ reason: 'worker_http_401', correlationId: corr }),
            event({ reason: 'sandbox_starting' }),
        ] }))).toEqual([{ reason: 'worker_http_401', correlationId: corr }, { reason: 'sandbox_starting' }]);
        expect(feedbackFailureRefs(null)).toEqual([]);
    });
});

describe('FEEDBACK-DIAG: the wire schema bounds the new fields', () => {
    const body = (extra: Record<string, unknown>) => ({
        v: 1, clientRequestId: '550e8400-e29b-41d4-a716-446655440002', category: 'bug', description: 'Code would not open.',
        diagnostics: { recentEvents: [{ eventClass: 'api_failure', site: 'ezil-os:apps/code#mint', code: 'unauthorized', ...extra }] },
    });

    it('accepts an event with and without reason/correlationId (old shells keep working)', () => {
        expect(feedbackSubmitSchema.safeParse(body({})).success).toBe(true);
        expect(feedbackSubmitSchema.safeParse(body({ reason: 'worker_http_401:hmac_signature_mismatch',
            correlationId: '7c9e6679-7425-40de-944b-e07fc1f90ae7' })).success).toBe(true);
    });

    it('rejects over-length values and any other new key, but not a merely mis-shaped value', () => {
        expect(feedbackSubmitSchema.safeParse(body({ reason: 'a'.repeat(97) })).success).toBe(false);
        expect(feedbackSubmitSchema.safeParse(body({ correlationId: 'a'.repeat(65) })).success).toBe(false);
        expect(feedbackSubmitSchema.safeParse(body({ detail: 'x' })).success).toBe(false);
        expect(feedbackSubmitSchema.safeParse(body({ reason: 1 })).success).toBe(false);
        // Shape is the sanitizer's job (drop, not 400): a charset drift must not lose the report.
        expect(feedbackSubmitSchema.safeParse(body({ reason: 'Not A Code' })).success).toBe(true);
    });
});
