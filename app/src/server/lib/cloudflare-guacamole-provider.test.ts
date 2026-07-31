import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    classifyWorkerHttpFailure,
    isRetryablePreviewErrorCode,
    requestGuacamolePreview,
    type CloudflareGuacamoleConfig,
    type GuacamolePreviewError,
    type GuacamolePreviewErrorCode,
} from './cloudflare-guacamole-provider';

/**
 * Retry classification for the desktop-boot path.
 *
 * Before this suite existed, EVERY non-2xx Worker response collapsed into one
 * code (`worker_http_error`), which the tRPC router threw as a `BAD_GATEWAY`
 * — and a thrown error is exactly what TanStack Query retries. So a
 * `400 missing_project_id`, a rejected HMAC signature and a
 * `CustomDomainRequiredError` were each attempted three times, with backoff
 * in between, before the user saw anything. Every one of those answers was
 * fixed from the first request.
 *
 * The two properties worth defending, in the user's terms:
 *   1. a deterministic failure is classified as such on the FIRST attempt, and
 *   2. a genuinely transient one is still classified as retryable.
 */

const CONFIG: CloudflareGuacamoleConfig = {
    workerUrl: 'https://ezil-os-worker.example.workers.dev',
    hasHmacSecret: true,
    isConfigured: true,
};

const INPUT = {
    sessionId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    projectId: '00000000-0000-4000-8000-000000000003',
    desktopMode: 'neko' as const,
};

/** Stub `fetch` with a single canned Worker response; returns the spy so call COUNT can be asserted. */
function stubWorkerResponse(status: number, body: string) {
    const spy = vi.fn(async () => new Response(body, { status }));
    vi.stubGlobal('fetch', spy);
    return spy;
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('classifyWorkerHttpFailure — deterministic vs retryable', () => {
    it('classifies the Worker\'s 400 missing_project_id as a deterministic bad request', () => {
        // The exact body worker/src/index.ts returns when projectId is absent.
        const code = classifyWorkerHttpFailure(400, '{"ok":false,"error":"missing_project_id"}');
        expect(code).toBe('bad_request');
        expect(isRetryablePreviewErrorCode(code)).toBe(false);
    });

    it.each([
        'hmac_required: worker configured with a secret but request was unsigned',
        'hmac_malformed_token',
        'hmac_token_expired',
        'hmac_signature_mismatch',
    ])('classifies the 401 auth/signature failure %s as deterministic', (error) => {
        const code = classifyWorkerHttpFailure(401, JSON.stringify({ ok: false, error }));
        expect(code).toBe('unauthorized');
        expect(isRetryablePreviewErrorCode(code)).toBe(false);
    });

    it('classifies a 403 ownership/authorization rejection as deterministic', () => {
        expect(isRetryablePreviewErrorCode(classifyWorkerHttpFailure(403, 'forbidden'))).toBe(false);
    });

    it('classifies the Worker\'s 412 unmet precondition (no ICE/TURN config) as deterministic', () => {
        const code = classifyWorkerHttpFailure(412, '{"ok":false,"error":"ice_not_configured","mode":"neko"}');
        expect(code).toBe('preconditions_unmet');
        expect(isRetryablePreviewErrorCode(code)).toBe(false);
    });

    it('classifies CustomDomainRequiredError as deterministic even though it arrives as a 500', () => {
        // The Sandbox SDK's exposePort() throws this for any .workers.dev
        // hostname; the Worker's catch-all returns `err.message` with a 500,
        // so the message text is the ONLY signal on the wire — matching on
        // status alone would read a permanently-misrouted deployment as a
        // retryable server error and burn three cold-boot attempts on it.
        const message =
            'Port exposure requires a custom domain. .workers.dev domains do not support wildcard subdomains required for port proxying.';
        const code = classifyWorkerHttpFailure(500, JSON.stringify({ ok: false, error: message }));
        expect(code).toBe('custom_domain_required');
        expect(isRetryablePreviewErrorCode(code)).toBe(false);
    });

    it('also recognizes CustomDomainRequiredError by name, for callers that stringify the error', () => {
        expect(classifyWorkerHttpFailure(500, 'CustomDomainRequiredError: nope')).toBe(
            'custom_domain_required',
        );
    });

    it('keeps the platform-level setsockoptint block deterministic, whatever the status', () => {
        expect(classifyWorkerHttpFailure(500, 'setsockoptint failed')).toBe('sandbox_runtime_blocked');
        expect(isRetryablePreviewErrorCode('sandbox_runtime_blocked')).toBe(false);
    });

    it.each([500, 502, 503, 504])('classifies a plain %i as retryable', (status) => {
        const code = classifyWorkerHttpFailure(status, 'internal error');
        expect(code).toBe('worker_http_error');
        expect(isRetryablePreviewErrorCode(code)).toBe(true);
    });

    it('classifies 408 and 429 as retryable — they mean "later", not "never"', () => {
        expect(isRetryablePreviewErrorCode(classifyWorkerHttpFailure(408, ''))).toBe(true);
        expect(isRetryablePreviewErrorCode(classifyWorkerHttpFailure(429, ''))).toBe(true);
    });
});

describe('isRetryablePreviewErrorCode — the classification, stated whole', () => {
    const DETERMINISTIC: GuacamolePreviewErrorCode[] = [
        'bad_request',
        'unauthorized',
        'preconditions_unmet',
        'custom_domain_required',
        'sandbox_runtime_blocked',
    ];
    const RETRYABLE: GuacamolePreviewErrorCode[] = [
        'connection_refused',
        'fetch_failed',
        'sandbox_start_failed',
        'timeout',
        'worker_http_error',
        'unknown',
    ];

    it.each(DETERMINISTIC)('%s is deterministic', (code) => {
        expect(isRetryablePreviewErrorCode(code)).toBe(false);
    });

    it.each(RETRYABLE)('%s is retryable', (code) => {
        expect(isRetryablePreviewErrorCode(code)).toBe(true);
    });

    it('treats an unclassified failure as retryable (safe direction)', () => {
        expect(isRetryablePreviewErrorCode(undefined)).toBe(true);
    });

    it('defaults an UNRECOGNIZED code to retryable, not deterministic', () => {
        // Deterministic is the closed set. A code arriving from the Worker on
        // the wire, or added to the union later without touching that set,
        // must cost at most a duplicate request — never a transient blip
        // silently hardened into a user-visible failure.
        expect(isRetryablePreviewErrorCode('some_future_code' as GuacamolePreviewErrorCode)).toBe(true);
    });
});

describe('requestGuacamolePreview — the failure carries its own retryability', () => {
    it('marks a 400 missing_project_id non-retryable after exactly ONE request', async () => {
        const fetchSpy = stubWorkerResponse(400, '{"ok":false,"error":"missing_project_id"}');

        const result = (await requestGuacamolePreview(
            CONFIG,
            'secret',
            INPUT,
            'cid-1',
        )) as GuacamolePreviewError;

        expect(result.ok).toBe(false);
        expect(result.errorCode).toBe('bad_request');
        expect(result.retryable).toBe(false);
        // The provider itself must not have re-tried behind the router's back.
        expect(fetchSpy).toHaveBeenCalledTimes(1);
        // And the raw Worker text survives for the server log.
        expect(result.error).toContain('missing_project_id');
    });

    it('marks a rejected HMAC signature non-retryable', async () => {
        stubWorkerResponse(401, '{"ok":false,"error":"hmac_signature_mismatch"}');
        const result = (await requestGuacamolePreview(CONFIG, 'wrong-secret', INPUT)) as GuacamolePreviewError;
        expect(result.errorCode).toBe('unauthorized');
        expect(result.retryable).toBe(false);
    });

    it('marks a Worker 503 retryable', async () => {
        stubWorkerResponse(503, 'service unavailable');
        const result = (await requestGuacamolePreview(CONFIG, 'secret', INPUT)) as GuacamolePreviewError;
        expect(result.errorCode).toBe('worker_http_error');
        expect(result.retryable).toBe(true);
    });

    it('marks a transport failure retryable', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('fetch failed');
            }),
        );
        const result = (await requestGuacamolePreview(CONFIG, 'secret', INPUT)) as GuacamolePreviewError;
        expect(result.errorCode).toBe('fetch_failed');
        expect(result.retryable).toBe(true);
    });

    it('marks a real client-side AbortSignal.timeout retryable (a cold-start race can win next time)', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw Object.assign(new Error('The operation was aborted due to timeout'), {
                    name: 'TimeoutError',
                });
            }),
        );
        const result = (await requestGuacamolePreview(CONFIG, 'secret', INPUT)) as GuacamolePreviewError;
        expect(result.errorCode).toBe('timeout');
        expect(result.retryable).toBe(true);
    });

    it('marks a missing Worker URL non-retryable without issuing any request at all', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const result = (await requestGuacamolePreview(
            { workerUrl: '', hasHmacSecret: false, isConfigured: false },
            '',
            INPUT,
        )) as GuacamolePreviewError;
        expect(result.retryable).toBe(false);
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('classifies a 200 body that reports failure the same way as the 500 that carries it', async () => {
        // The classification must not depend on which status the Worker
        // happened to use for the same underlying failure.
        stubWorkerResponse(
            200,
            JSON.stringify({ ok: false, error: 'Port exposure requires a custom domain.' }),
        );
        const result = (await requestGuacamolePreview(CONFIG, 'secret', INPUT)) as GuacamolePreviewError;
        expect(result.errorCode).toBe('custom_domain_required');
        expect(result.retryable).toBe(false);
    });
});
