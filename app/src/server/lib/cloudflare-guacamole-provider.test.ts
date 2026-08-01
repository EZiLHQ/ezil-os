import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS,
    APP_PREVIEW_PORT,
    APP_PREVIEW_TOKEN,
    classifyWorkerHttpFailure,
    CODE_PREVIEW_PORT,
    CODE_PREVIEW_TOKEN,
    composeAppPreviewBootstrapUrl,
    composeAppPreviewOrigin,
    composeBrowserDesktopUrl,
    composeCodePreviewOrigin,
    deriveNekoAdminValue,
    enableImplicitHosting,
    isRetryablePreviewErrorCode,
    mintAppPreviewBootstrapToken,
    requestGuacamolePreview,
    requestGuacamoleSandboxTerminate,
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

describe('requestGuacamoleSandboxTerminate — the regression: an unsigned, unchecked DELETE that lied', () => {
    it('signs the request the same way as /sandbox/preview, as Authorization: Bearer', async () => {
        const fetchSpy = stubWorkerResponse(
            200,
            JSON.stringify({ ok: true, terminated: true, outcome: 'destroyed' }),
        );

        await requestGuacamoleSandboxTerminate(CONFIG, 'secret', 'guac-u-c', 'cid-1');

        expect(fetchSpy).toHaveBeenCalledTimes(1);
        const [url, init] = fetchSpy.mock.calls[0] as unknown as [RequestInfo, RequestInit];
        expect(String(url)).toContain('/sandbox/guac-u-c');
        expect(init.method).toBe('DELETE');
        const headers = init.headers as Record<string, string>;
        expect(headers.Authorization).toMatch(/^Bearer t=\d+,v1=[0-9a-f]+$/);
    });

    it('reports ok:true, terminated:true for a confirmed destroy', async () => {
        stubWorkerResponse(200, JSON.stringify({ ok: true, terminated: true, outcome: 'destroyed' }));
        const result = await requestGuacamoleSandboxTerminate(CONFIG, 'secret', 'guac-u-c');
        expect(result).toEqual({ ok: true, terminated: true, outcome: 'destroyed', error: undefined });
    });

    it('reports ok:true, terminated:false for the idempotent not_running outcome', async () => {
        stubWorkerResponse(200, JSON.stringify({ ok: true, terminated: false, outcome: 'not_running' }));
        const result = await requestGuacamoleSandboxTerminate(CONFIG, 'secret', 'guac-u-c');
        expect(result.ok).toBe(true);
        expect(result.terminated).toBe(false);
        expect(result.outcome).toBe('not_running');
    });

    it('THE REGRESSION: a 401 (unsigned/rejected) is reported as ok:false, never silently discarded', async () => {
        // Before the fix, this function sent no token at all, never checked
        // `res.ok`, and returned `void` — a caller had no way to learn a 401
        // had happened, and `softDeleteComputer` reported `sandboxTerminated:
        // true` regardless. `fetch` resolving normally on a 4xx is exactly why
        // an unchecked status silently passes: the `catch` block never fires.
        stubWorkerResponse(401, JSON.stringify({ ok: false, error: 'hmac_signature_mismatch' }));
        const result = await requestGuacamoleSandboxTerminate(CONFIG, 'wrong-secret', 'guac-u-c');
        expect(result.ok).toBe(false);
        expect(result.error).toBe('hmac_signature_mismatch');
    });

    it('reports ok:false for still_running (HTTP 500) — a slow/incomplete teardown is not success', async () => {
        stubWorkerResponse(
            500,
            JSON.stringify({
                ok: false,
                terminated: false,
                outcome: 'still_running',
                error: 'container_still_running_after_destroy',
            }),
        );
        const result = await requestGuacamoleSandboxTerminate(CONFIG, 'secret', 'guac-u-c');
        expect(result.ok).toBe(false);
        expect(result.outcome).toBe('still_running');
        expect(result.error).toBe('container_still_running_after_destroy');
    });

    it('reports ok:false, never throws, on a transport failure', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('fetch failed');
            }),
        );
        const result = await requestGuacamoleSandboxTerminate(CONFIG, 'secret', 'guac-u-c');
        expect(result.ok).toBe(false);
        expect(result.error).toContain('fetch failed');
    });

    it('is a no-op success when the provider is not configured — nothing to tear down', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const result = await requestGuacamoleSandboxTerminate(
            { workerUrl: '', hasHmacSecret: false, isConfigured: false },
            '',
            'guac-u-c',
        );
        expect(result).toEqual({ ok: true, terminated: false });
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});

// ─── Taking control of your own computer ──────────────────────────────────────
//
// The desktop was look-but-don't-touch: `implicitHosting:false` in the pinned
// image's `/etc/neko/neko.yaml` reduces a click on the desktop to a 5s shake
// animation on a component `embed=1` does not render — i.e. to nothing. The
// only way anyone ever gained control was by calling `$accessor.remote.request()`
// from inside the iframe, which no real user can do.
//
// These tests defend the two things that make the fix trustworthy rather than
// merely present:
//   1. the flip MERGES — Neko's `settingsSet` is a whole-object replace, and a
//      hand-written body silently resets every field it omits (observed live:
//      posting without `heartbeat_interval` reset the room's 10 to 0);
//   2. it can NEVER take a working desktop down with it, and when it does fail
//      it says so, so the UI can show the fallback instead of shipping a
//      computer that ignores clicks in silence.

/** A Neko room-settings payload with the shape the live server actually returns. */
const LIVE_SETTINGS = {
    private_mode: false,
    locked_logins: false,
    locked_controls: false,
    control_protection: false,
    implicit_hosting: false,
    inactive_cursors: false,
    merciful_reconnect: true,
    heartbeat_interval: 10,
    plugins: null,
};

const DESKTOP_URL = 'https://8181-guac-abc-def-nekodesktop.ezil.org/?usr=EZiL&pwd=x&embed=1';

/**
 * Route a stubbed `fetch` by path so each leg of the handshake (login ->
 * read -> write -> logout) can be asserted independently.
 */
function stubNeko(handlers: Record<string, () => Response>) {
    const calls: { url: string; method: string; body?: string }[] = [];
    const spy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
        const key = `${method} ${new URL(url).pathname}`;
        const handler = handlers[key];
        if (!handler) return new Response('not stubbed', { status: 404 });
        return handler();
    });
    vi.stubGlobal('fetch', spy);
    return { calls };
}

const okJson = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

describe('deriveNekoAdminValue — must byte-match the Worker, and never be the user value', () => {
    it("uses the Worker's exact payload shape `ezil-neko:admin:<sandboxId>:v1`", () => {
        // Drift guard against worker/src/hmac.ts's deriveNekoValue(). If the
        // two ever disagree, the admin login below 401s and control silently
        // falls back to manual on every single boot.
        const expected = createHmac('sha256', 'shared-secret')
            .update('ezil-neko:admin:guac-u-c:v1')
            .digest('hex')
            .toLowerCase()
            .slice(0, 32);
        expect(deriveNekoAdminValue('shared-secret', 'guac-u-c')).toBe(expected);
    });

    it('never equals the regular-user value the browser is given', () => {
        // The browser receives the USER value in the iframe URL's `pwd`. If
        // the admin value collided with it, that URL would hand out admin.
        const admin = deriveNekoAdminValue('shared-secret', 'guac-u-c');
        const browserUrl = composeBrowserDesktopUrl('https://d.example/', 'shared-secret', 'guac-u-c');
        expect(new URL(browserUrl).searchParams.get('pwd')).not.toBe(admin);
        expect(browserUrl).not.toContain(admin);
    });
});

describe('composeBrowserDesktopUrl — embed=1 is load-bearing, not cosmetic', () => {
    it('keeps embed=1 (it hides Neko\'s own branding AND keeps the control button visible)', () => {
        // `.video-menu li.extra-control { display:none }` above 768px, and the
        // button only escapes that class in embed mode. Dropping the param
        // would remove the fallback affordance the manual hint points at.
        const url = new URL(composeBrowserDesktopUrl('https://d.example/', 'secret', 'guac-u-c'));
        expect(url.searchParams.get('embed')).toBe('1');
        expect(url.searchParams.get('usr')).toBe('EZiL');
    });
});

describe('enableImplicitHosting — a click on your own computer must just work', () => {
    it('reads the live settings and writes back a MERGE, changing exactly one field', async () => {
        const { calls } = stubNeko({
            'POST /api/login': () => okJson({ id: 'm1', token: 'tok-abc', profile: {}, state: {} }),
            'GET /api/room/settings': () => okJson(LIVE_SETTINGS),
            'POST /api/room/settings': () => new Response(null, { status: 204 }),
            'POST /api/logout': () => new Response(null, { status: 200 }),
        });

        expect(await enableImplicitHosting(DESKTOP_URL, 'admin-pwd')).toBe('implicit');

        const write = calls.find((c) => c.method === 'POST' && c.url.includes('/api/room/settings'));
        expect(write).toBeDefined();
        const sent = JSON.parse(write!.body!) as typeof LIVE_SETTINGS;
        expect(sent.implicit_hosting).toBe(true);
        // Everything else survives verbatim — this is the assertion that would
        // have caught the live heartbeat_interval 10 -> 0 clobber.
        expect(sent).toEqual({ ...LIVE_SETTINGS, implicit_hosting: true });
    });

    it('talks to the DESKTOP origin, not the Worker, and does so before the browser has the URL', async () => {
        const { calls } = stubNeko({
            'POST /api/login': () => okJson({ token: 'tok' }),
            'GET /api/room/settings': () => okJson(LIVE_SETTINGS),
            'POST /api/room/settings': () => new Response(null, { status: 204 }),
            'POST /api/logout': () => new Response(null, { status: 200 }),
        });
        await enableImplicitHosting(DESKTOP_URL, 'admin-pwd');
        for (const call of calls) {
            expect(new URL(call.url).origin).toBe('https://8181-guac-abc-def-nekodesktop.ezil.org');
        }
    });

    it('does not write at all when the container already has implicit hosting on', async () => {
        // The durable fix is a flag on the container's own `neko serve`. When
        // that lands this must become a no-op, not a redundant write.
        const { calls } = stubNeko({
            'POST /api/login': () => okJson({ token: 'tok' }),
            'GET /api/room/settings': () => okJson({ ...LIVE_SETTINGS, implicit_hosting: true }),
            'POST /api/logout': () => new Response(null, { status: 200 }),
        });
        expect(await enableImplicitHosting(DESKTOP_URL, 'admin-pwd')).toBe('implicit');
        expect(calls.some((c) => c.method === 'POST' && c.url.includes('/api/room/settings'))).toBe(false);
    });

    it('releases the admin session it opened, so no phantom member is left in the room', async () => {
        const { calls } = stubNeko({
            'POST /api/login': () => okJson({ token: 'tok' }),
            'GET /api/room/settings': () => okJson(LIVE_SETTINGS),
            'POST /api/room/settings': () => new Response(null, { status: 204 }),
            'POST /api/logout': () => new Response(null, { status: 200 }),
        });
        await enableImplicitHosting(DESKTOP_URL, 'admin-pwd');
        expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/api/logout'))).toBe(true);
    });

    it.each([
        ['a rejected admin credential', { 'POST /api/login': () => new Response('{}', { status: 401 }) }],
        [
            'a login that returns no token',
            { 'POST /api/login': () => okJson({ id: 'm1' }) },
        ],
        [
            'settings that cannot be read',
            {
                'POST /api/login': () => okJson({ token: 'tok' }),
                'GET /api/room/settings': () => new Response('nope', { status: 500 }),
            },
        ],
        [
            'a write the server refuses',
            {
                'POST /api/login': () => okJson({ token: 'tok' }),
                'GET /api/room/settings': () => okJson(LIVE_SETTINGS),
                'POST /api/room/settings': () => new Response('nope', { status: 500 }),
                'POST /api/logout': () => new Response(null, { status: 200 }),
            },
        ],
        [
            'a non-JSON body where settings should be',
            {
                'POST /api/login': () => okJson({ token: 'tok' }),
                'GET /api/room/settings': () => new Response('<html>proxy error</html>', { status: 200 }),
                'POST /api/logout': () => new Response(null, { status: 200 }),
            },
        ],
    ])('reports manual (never throws) on %s', async (_label, handlers) => {
        stubNeko(handlers as Record<string, () => Response>);
        await expect(enableImplicitHosting(DESKTOP_URL, 'admin-pwd')).resolves.toBe('manual');
    });

    it('reports manual when the desktop is unreachable, rather than failing the boot', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new Error('fetch failed');
            }),
        );
        await expect(enableImplicitHosting(DESKTOP_URL, 'admin-pwd')).resolves.toBe('manual');
    });

    it('reports manual on an unparseable desktop URL without issuing a request', async () => {
        const spy = vi.fn();
        vi.stubGlobal('fetch', spy);
        await expect(enableImplicitHosting('not a url', 'admin-pwd')).resolves.toBe('manual');
        expect(spy).not.toHaveBeenCalled();
    });

    it('never returns the admin credential or the session token to its caller', async () => {
        stubNeko({
            'POST /api/login': () => okJson({ token: 'tok-secret' }),
            'GET /api/room/settings': () => okJson(LIVE_SETTINGS),
            'POST /api/room/settings': () => new Response(null, { status: 204 }),
            'POST /api/logout': () => new Response(null, { status: 200 }),
        });
        const mode = await enableImplicitHosting(DESKTOP_URL, 'admin-pwd-secret');
        expect(mode).toBe('implicit');
        expect(JSON.stringify(mode)).not.toContain('secret');
    });
});

// ─── App-preview (Option D) bootstrap token + URL ──────────────────────────────
//
// `mintAppPreviewBootstrapToken` MUST byte-for-byte match
// `worker/src/hmac.ts`'s `mintPreviewBootstrapToken` /
// `PREVIEW_BOOTSTRAP_TOKEN_PAYLOAD` — a drift here is a silent 401 on every
// app-preview window, since the Worker verifies against its own copy of the
// same payload string. The reference vector below is computed independently
// (`node:crypto`, not the function under test) precisely so this suite would
// catch that drift instead of just re-deriving the same bug twice.

describe('mintAppPreviewBootstrapToken — byte-for-byte match with worker/src/hmac.ts', () => {
    it('signs the exact payload the Worker verifies against: "${ts}.GET./preview-bootstrap.${sandboxId}."', () => {
        const now = 1_700_000_000_000;
        const token = mintAppPreviewBootstrapToken('shared-secret', 'guac-u-c', now);

        const expectedPayload = `${now}.GET./preview-bootstrap.guac-u-c.`;
        const expectedSig = createHmac('sha256', 'shared-secret').update(expectedPayload).digest('hex');

        expect(token).toBe(`t=${now},v1=${expectedSig}`);
    });

    it('binds sandboxId into the signature — two sandboxes never share a valid token', () => {
        const now = 1_700_000_000_000;
        const a = mintAppPreviewBootstrapToken('shared-secret', 'guac-u-a', now);
        const b = mintAppPreviewBootstrapToken('shared-secret', 'guac-u-b', now);
        expect(a).not.toBe(b);
    });

    it('changes signature when the secret changes, at the same timestamp and sandboxId', () => {
        const now = 1_700_000_000_000;
        const a = mintAppPreviewBootstrapToken('secret-a', 'guac-u-c', now);
        const b = mintAppPreviewBootstrapToken('secret-b', 'guac-u-c', now);
        expect(a).not.toBe(b);
    });

    it('falls back to the plaintext "local-dev" placeholder when no secret is configured', () => {
        // Matches `mintSandboxPreviewToken`'s own local-dev branch, and the
        // Worker's `verifyPreviewBootstrapToken` local-dev branch that
        // accepts any token when no secret is configured.
        expect(mintAppPreviewBootstrapToken('', 'guac-u-c')).toBe('local-dev');
    });

    it('defaults `now` to the current time and produces a well-formed envelope', () => {
        const token = mintAppPreviewBootstrapToken('shared-secret', 'guac-u-c');
        expect(token).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    });
});

describe('composeAppPreviewOrigin — derives the app-preview hostname from the OBSERVED desktop URL', () => {
    it('mirrors the ${port}-${sandboxId}-${token} hostname pattern, reusing the desktop URL\'s own zone suffix', () => {
        const origin = composeAppPreviewOrigin('https://8181-guac-abc-def-nekodesktop.ezil.org/', 'guac-abc-def');
        expect(origin).toBe(`https://${APP_PREVIEW_PORT}-guac-abc-def-${APP_PREVIEW_TOKEN}.ezil.org`);
    });

    it('preserves the desktop URL\'s protocol (http in local dev, https in production)', () => {
        const origin = composeAppPreviewOrigin('http://8181-guac-a-b-nekodesktop.localhost:8787/', 'guac-a-b');
        expect(origin).toBe(`http://${APP_PREVIEW_PORT}-guac-a-b-${APP_PREVIEW_TOKEN}.localhost:8787`);
    });

    it('never invents a zone from CLOUDFLARE_GUACAMOLE_WORKER_URL — it reuses whatever the Worker actually returned', () => {
        // A worker that (for whatever reason) collapsed to a different zone
        // than expected must still be followed exactly, not second-guessed.
        const origin = composeAppPreviewOrigin('https://8181-guac-x-y-nekodesktop.some-other-zone.example/', 'guac-x-y');
        expect(origin).toBe(`https://${APP_PREVIEW_PORT}-guac-x-y-${APP_PREVIEW_TOKEN}.some-other-zone.example`);
    });

    it('returns null for an unparseable guacamoleUrl, never throws', () => {
        expect(composeAppPreviewOrigin('not a url', 'guac-a-b')).toBeNull();
    });

    it('returns null for a hostname with no label to strip', () => {
        expect(composeAppPreviewOrigin('https://localhost/', 'guac-a-b')).toBeNull();
    });
});

describe('composeCodePreviewOrigin — the code-server counterpart of composeAppPreviewOrigin', () => {
    it('mirrors the ${CODE_PREVIEW_PORT}-${sandboxId}-${CODE_PREVIEW_TOKEN} hostname pattern', () => {
        const origin = composeCodePreviewOrigin('https://8181-guac-abc-def-nekodesktop.ezil.org/', 'guac-abc-def');
        expect(origin).toBe(`https://${CODE_PREVIEW_PORT}-guac-abc-def-${CODE_PREVIEW_TOKEN}.ezil.org`);
    });

    it('uses the code label, not the app label — the two bridges must never collide', () => {
        const origin = composeCodePreviewOrigin('https://8181-guac-a-b-nekodesktop.ezil.org/', 'guac-a-b');
        expect(origin).toContain('-code.');
        expect(origin).not.toContain('-app.');
        expect(CODE_PREVIEW_PORT).not.toBe(APP_PREVIEW_PORT);
    });

    it('preserves protocol and local-dev port, same as composeAppPreviewOrigin', () => {
        const origin = composeCodePreviewOrigin('http://8181-guac-a-b-nekodesktop.localhost:8787/', 'guac-a-b');
        expect(origin).toBe(`http://${CODE_PREVIEW_PORT}-guac-a-b-${CODE_PREVIEW_TOKEN}.localhost:8787`);
    });

    it('returns null for an unparseable guacamoleUrl, never throws', () => {
        expect(composeCodePreviewOrigin('not a url', 'guac-a-b')).toBeNull();
    });

    it('returns null for a hostname with no label to strip', () => {
        expect(composeCodePreviewOrigin('https://localhost/', 'guac-a-b')).toBeNull();
    });
});

describe('composeAppPreviewBootstrapUrl', () => {
    it('builds /preview-bootstrap with the token, defaulting path to root (no path param)', () => {
        const url = composeAppPreviewBootstrapUrl('https://3002-guac-a-b-app.ezil.org', 't=1,v1=abc');
        const parsed = new URL(url);
        expect(parsed.origin).toBe('https://3002-guac-a-b-app.ezil.org');
        expect(parsed.pathname).toBe('/preview-bootstrap');
        expect(parsed.searchParams.get('token')).toBe('t=1,v1=abc');
        expect(parsed.searchParams.has('path')).toBe(false);
    });

    it('forwards a non-root path as the ?path= query param', () => {
        const url = composeAppPreviewBootstrapUrl('https://3002-guac-a-b-app.ezil.org', 't=1,v1=abc', '/dashboard');
        expect(new URL(url).searchParams.get('path')).toBe('/dashboard');
    });
});

describe('APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS', () => {
    it('is 5 minutes, matching worker/src/hmac.ts\'s PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS', () => {
        expect(APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS).toBe(5 * 60 * 1000);
    });
});
