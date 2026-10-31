import { describe, expect, it } from 'vitest';

import {
    FAILURE_REASON_MAX,
    FailureDiagnosticsError,
    failureFields,
    failureFieldsOf,
    failureReason,
    isCorrelationId,
    isFailureReason,
    isReasonSegment,
    leadingCode,
    newShortCorrelationId,
    workerBodyCode,
} from './failure-diagnostics';

// Secret-shaped fixtures are ASSEMBLED AT RUNTIME (see feedback/redact.test.ts)
// so no source line holds a contiguous provider-format credential.
const fake = (...parts: string[]): string => parts.join('');
const SECRETS: [string, string][] = [
    ['a URL with a token', 'https://worker.example.test/sandbox/preview?token=abc123'],
    ['a JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'],
    ['a bearer header', 'Bearer abcdef0123456789'],
    ['an sk- key', fake('sk', '-proj-', 'abcdefghijklmnopqrstuvwxyz123456')],
    ['a 32-char lowercase hex HMAC', 'a3f9c0d1'.repeat(4)],
    ['a 64-char lowercase hex HMAC', 'deadbeef'.repeat(8)],
    ['a hex run with no digits', 'deadbeefcafe'],
    ['a UUID', '550e8400-e29b-41d4-a716-446655440000'],
    ['an email', 'alice@example.com'],
    ['a long opaque word', 'abcdefghijklmnopqrstuvwxyz'],
    ['a timestamp', 'ts_1730367000000'],
    ['mixed case', 'Hmac_Signature_Mismatch'],
    ['a stack frame', 'at handlePreview (index.ts:12:3)'],
    ['a path', '/home/alice/workspace/project'],
    ['whitespace', 'hmac signature mismatch'],
];

describe('isReasonSegment / isFailureReason — the allowlist', () => {
    it.each([
        'worker_http_401', 'hmac_signature_mismatch', 'sandbox_starting', 'aws_preview_unavailable',
        'enrollment_failed', 'desktop_frame_http_error_404', 'hmac_v2_required', 'aws_ec2', 'session_missing',
    ])('accepts the code %s', (code) => {
        expect(isReasonSegment(code)).toBe(true);
        expect(isFailureReason(code)).toBe(true);
    });

    it.each(SECRETS)('rejects %s', (_name, value) => {
        expect(isReasonSegment(value)).toBe(false);
        expect(isFailureReason(value)).toBe(false);
        expect(failureReason(value)).toBeUndefined();
    });

    it('rejects non-strings, empties, doubled or trailing separators', () => {
        for (const value of [undefined, null, 401, {}, [], '', '_x', 'x_', 'a__b', 'a::b', ':a', 'a:']) {
            expect(isFailureReason(value), String(value)).toBe(false);
        }
    });

    it('bounds segment count and total length', () => {
        expect(isFailureReason('a:b:c')).toBe(true);
        expect(isFailureReason('a:b:c:d')).toBe(false);
        const long = `${'abcde_'.repeat(8)}x`; // 49 chars, one segment too long
        expect(isReasonSegment(long)).toBe(false);
        expect(isFailureReason('x'.repeat(FAILURE_REASON_MAX + 1))).toBe(false);
    });
});

describe('failureReason — joins what passes, drops what does not', () => {
    it('builds the production case', () => {
        expect(failureReason('worker_http_401', 'hmac_signature_mismatch')).toBe('worker_http_401:hmac_signature_mismatch');
    });

    it.each(SECRETS)('drops %s and keeps the code beside it', (_name, secret) => {
        expect(failureReason('worker_http_401', secret)).toBe('worker_http_401');
        expect(failureReason(secret, 'worker_http_401')).toBe('worker_http_401');
    });

    it('accepts a whole reason as a part, caps at three segments and never repeats a segment', () => {
        expect(failureReason('aws_preview_unavailable:worker_status_401', 'hmac_signature_mismatch'))
            .toBe('aws_preview_unavailable:worker_status_401:hmac_signature_mismatch');
        expect(failureReason('a', 'b', 'c', 'd')).toBe('a:b:c');
        expect(failureReason('sandbox_starting', 'sandbox_starting')).toBe('sandbox_starting');
        expect(failureReason()).toBeUndefined();
        expect(failureReason(undefined, null)).toBeUndefined();
    });

    it('never exceeds the length bound', () => {
        const segment = `${'abcdefghijklmno_'.repeat(2)}abcdefghijklmno`; // 47 chars, valid
        expect(isReasonSegment(segment)).toBe(true);
        const joined = failureReason(segment, segment.replace(/^a/, 'b'), segment.replace(/^a/, 'c'))!;
        expect(joined.length).toBeLessThanOrEqual(FAILURE_REASON_MAX);
        expect(isFailureReason(joined)).toBe(true);
    });
});

describe('leadingCode / workerBodyCode', () => {
    it('reads the code in front of an internal error string, and only that', () => {
        expect(leadingCode('worker_http_401: {"ok":false,"error":"hmac_signature_mismatch"}')).toBe('worker_http_401');
        expect(leadingCode('sandbox_starting: the container is still waking after 12000ms')).toBe('sandbox_starting');
        expect(leadingCode('desktop_frame_http_error_404')).toBe('desktop_frame_http_error_404');
        expect(leadingCode('https://worker.example.test/x?token=abc')).toBeUndefined();
        expect(leadingCode('fetch failed')).toBeUndefined();
        expect(leadingCode('TypeError: fetch failed')).toBeUndefined();
        expect(leadingCode(undefined)).toBeUndefined();
    });

    it('reads the Worker\'s own body code and nothing else from the body', () => {
        expect(workerBodyCode('{"ok":false,"error":"hmac_signature_mismatch"}')).toBe('hmac_signature_mismatch');
        for (const [, secret] of SECRETS) expect(workerBodyCode(JSON.stringify({ error: secret }))).toBeUndefined();
        expect(workerBodyCode('{"ok":false,"message":"hmac_signature_mismatch"}')).toBeUndefined();
        expect(workerBodyCode('not json')).toBeUndefined();
        expect(workerBodyCode('null')).toBeUndefined();
        expect(workerBodyCode(undefined)).toBeUndefined();
    });
});

describe('correlation ids', () => {
    it('accepts exactly the shapes this app mints', () => {
        expect(isCorrelationId('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
        expect(isCorrelationId('cid_lq2x8k9a3f8d7c6b')).toBe(true);
        expect(isCorrelationId(newShortCorrelationId())).toBe(true);
        expect(newShortCorrelationId()).toMatch(/^srv_[0-9a-f]{12}$/);
        expect(newShortCorrelationId()).not.toBe(newShortCorrelationId());
    });

    it.each([
        '550E8400-E29B-41D4-A716-446655440000', 'corr', 'https://x.test/?id=1', 'srv_xyz', 'cid_', 'a'.repeat(64),
        'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature', ' 550e8400-e29b-41d4-a716-446655440000',
    ])('rejects %s', (value) => {
        expect(isCorrelationId(value)).toBe(false);
    });
});

describe('failureFields / FailureDiagnosticsError', () => {
    it('keeps valid fields, drops invalid ones, never repairs', () => {
        expect(failureFields({ reason: 'worker_http_401:hmac_signature_mismatch', correlationId: 'srv_0123456789ab' }))
            .toEqual({ reason: 'worker_http_401:hmac_signature_mismatch', correlationId: 'srv_0123456789ab' });
        expect(failureFields({ reason: 'Worker_HTTP_401', correlationId: 'nope' })).toEqual({});
        expect(failureFields({})).toEqual({});
    });

    it('travels as an Error cause and is read back validated', () => {
        const cause = new FailureDiagnosticsError({ reason: 'worker_http_502', correlationId: 'srv_0123456789ab' });
        expect(cause).toBeInstanceOf(Error);
        expect(cause.message).toBe('failure diagnostics');
        expect(failureFieldsOf({ cause })).toEqual({ reason: 'worker_http_502', correlationId: 'srv_0123456789ab' });
        expect(failureFieldsOf({ cause: new FailureDiagnosticsError({ reason: SECRETS[0]![1] }) })).toEqual({});
        // A look-alike plain object is not trusted.
        expect(failureFieldsOf({ cause: { fields: { reason: 'x' } } })).toEqual({});
        expect(failureFieldsOf(null)).toEqual({});
    });
});

describe('every code this app emits as a reason passes the allowlist (a failing one would degrade silently)', () => {
    it.each([
        // GuacamolePreviewErrorCode (cloudflare-guacamole-provider.ts)
        'bad_request', 'unauthorized', 'preconditions_unmet', 'custom_domain_required', 'connection_refused', 'fetch_failed',
        'sandbox_runtime_blocked', 'sandbox_start_failed', 'sandbox_starting', 'worker_http_error', 'timeout', 'unknown',
        // UnavailableReason (compute/aws-preview.ts), prefixed as the answer carries it
        ...['config_missing', 'zone_invalid', 'endpoint_invalid', 'placement_missing', 'placement_foreign', 'placement_provider',
            'placement_not_running', 'placement_epoch_invalid', 'placement_integrity', 'placement_reserved', 'placement_read_failed',
            'enrollment_failed', 'sign_failed', 'parse_failed', 'worker_status_401', 'worker_status_502']
            .map((r) => `aws_preview_unavailable:${r}`),
        // Desktop frame answers (cloudflare-guacamole router), preview-unavailable reasons and fixed literals
        'desktop_frame_http_error_404', 'desktop_frame_unreachable', 'desktop_frame_bad_url',
        'app_preview_expose_failed', 'app_preview_port_not_exposed', 'app_preview_origin_unresolvable',
        'code_preview_expose_failed', 'code_preview_port_not_exposed', 'code_preview_origin_unresolvable',
        'cloudflare_guacamole_not_configured', 'hmac_secret_not_configured', 'session_missing',
        'worker_http_401:hmac_signature_mismatch', 'computer_starting', 'capacity_unavailable:region_capacity',
    ])('%s', (reason) => {
        expect(isFailureReason(reason)).toBe(true);
        expect(failureReason(reason)).toBe(reason);
    });
});
