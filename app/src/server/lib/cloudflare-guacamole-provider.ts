/**
 * Cloudflare Guacamole/Neko Sandbox Provider
 *
 * Server-only helpers for talking to the `worker/` Cloudflare Worker (the
 * "computer" itself — @cloudflare/sandbox + Neko desktop). Handles:
 *   - Config resolution from env (key names only; secrets never logged)
 *   - HMAC token minting for authenticating calls to the Worker
 *   - Typed request/response shapes
 *
 * The browser NEVER sees the Worker URL, HMAC secret, or raw preview
 * tokens — `routers/cloudflare-guacamole.ts` is the only entry point.
 *
 * Carried and simplified from EBuilder's
 * `apps/web/client/src/server/lib/cloudflare-guacamole-provider.ts`
 * (authored post-Onlook-import, listed as safe to carry). Dropped from the
 * source on purpose, since none of it is wired in this app:
 *   - The app-preview ("Option D" dev-server iframe) bootstrap/status path
 *     — the source file's own doc comment says this is "NOT wired in this
 *     wave" even there; this repo has no dev-server-in-sandbox story at all.
 *   - Twen workspace orchestration — a forward-looking capability with no
 *     UI surface anywhere, carried or otherwise.
 *   - The dual Guacamole/Neko `desktopMode` switch and the Azure
 *     `sandboxSessions` sealed workspace-startup delivery — this repo has
 *     no Azure/ACA desktop path to switch away from; Neko is the only mode.
 */

import { createHmac, randomUUID } from 'node:crypto';

// ─── Correlation ──────────────────────────────────────────────────────────────

/**
 * HTTP header the Worker reads to stitch its per-preview lifecycle log to
 * the originating request. Must match the header name the Worker honours
 * (`worker/src/index.ts`).
 */
export const CORRELATION_HEADER = 'x-correlation-id';

/**
 * Max time (ms) the Worker waits for the Neko desktop to bind + serve,
 * covering a cold container boot end to end (measured ~22s typical; the
 * Worker's own ceiling is much higher to tolerate a slow boot without
 * false-failing it). MUST stay strictly below `SANDBOX_COLD_START_TIMEOUT_MS`
 * below, or the client could give up before a Worker that is still healthy
 * and about to succeed.
 */
const WORKER_DESKTOP_READY_TIMEOUT_MS = 180_000;

/** Safety margin (ms) the client's cold-start budget adds on top of the Worker's own ceiling. */
const CLIENT_TIMEOUT_MARGIN_MS = 30_000;

/**
 * Timeout (ms) for server-to-Worker preview requests, which may involve a
 * cold container boot. Derived from the Worker's own ceiling plus a fixed
 * margin so the two constants cannot silently drift out of order (see
 * `docs/PLATFORM-NOTES.md` §13 — a container cold start is ~22s and this
 * client budget is 210s).
 */
const SANDBOX_COLD_START_TIMEOUT_MS = WORKER_DESKTOP_READY_TIMEOUT_MS + CLIENT_TIMEOUT_MARGIN_MS;

/**
 * Mint a fresh correlation id for one product action -> API -> Worker
 * chain. Non-sensitive and non-reversible.
 */
export function newCorrelationId(): string {
    try {
        return randomUUID();
    } catch {
        return `cid_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    }
}

// ─── Config ───────────────────────────────────────────────────────────────────

export interface CloudflareGuacamoleConfig {
    /** Base URL of the deployed Cloudflare Worker (or local wrangler dev URL). */
    workerUrl: string;
    /** Whether a valid HMAC secret is configured. */
    hasHmacSecret: boolean;
    /** Whether the provider is fully configured (workerUrl + secret present). */
    isConfigured: boolean;
}

/**
 * Resolve Cloudflare Guacamole/Neko provider config from environment.
 *
 * Env var names:
 *   CLOUDFLARE_GUACAMOLE_WORKER_URL  — Worker base URL (required for the provider to be active)
 *   CLOUDFLARE_GUACAMOLE_HMAC_SECRET — Shared HMAC secret; must byte-match the
 *                                      Worker's own SANDBOX_HMAC_SECRET
 */
export function resolveCloudflareGuacamoleConfig(): CloudflareGuacamoleConfig {
    const workerUrl = process.env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.trim() ?? '';
    const hmacSecret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim() ?? '';
    const hasHmacSecret = hmacSecret.length > 0;
    const isConfigured = workerUrl.length > 0;

    return { workerUrl, hasHmacSecret, isConfigured };
}

// ─── HMAC token minting ───────────────────────────────────────────────────────

/**
 * Mint a short-lived HMAC-signed token for authenticating a sandbox preview
 * request to the Worker.
 *
 * Token format: `t=<unix_ms>,v1=<hex_hmac_sha256>`
 * Payload: `${timestamp}.POST./sandbox/preview.`
 *
 * When `hmacSecret` is empty (local dev without a secret), returns a
 * plaintext "local-dev" token; the Worker skips verification in this mode.
 */
export function mintSandboxPreviewToken(hmacSecret: string): string {
    if (!hmacSecret) {
        return 'local-dev';
    }
    const timestamp = Date.now().toString();
    const payload = `${timestamp}.POST./sandbox/preview.`;
    const sig = createHmac('sha256', hmacSecret).update(payload).digest('hex');
    return `t=${timestamp},v1=${sig}`;
}

// ─── Worker call helpers ──────────────────────────────────────────────────────

export interface GuacamolePreviewRequest {
    sessionId: string;
    userId: string;
    /**
     * REQUIRED scope id — named `projectId` because that is the exact field
     * name the Worker's `handlePreview` reads off the request body
     * (`worker/src/index.ts`); in this app it is always a computer id. It
     * feeds the R2 workspace mount prefix directly — the Worker rejects a
     * missing value rather than falling back to a shared prefix, so this
     * must never be omitted.
     */
    projectId: string;
    /** Always 'neko' — EZiL OS's sole desktop mode. Sent explicitly rather
     *  than relying on the Worker's own default, which is 'guacamole'
     *  unless its SANDBOX_DEFAULT_DESKTOP_MODE env var says otherwise. */
    desktopMode: 'neko';
    token: string;
}

export interface GuacamolePreviewSuccess {
    ok: true;
    guacamoleUrl: string;
    expiresAt: number;
    /** The Worker reports 'cloudflare-neko' for desktopMode 'neko' (our only mode). */
    provider: 'cloudflare-guacamole' | 'cloudflare-neko';
    /** 'local-dev-stub' (wrangler dev, no real container) or 'production'. */
    mode?: 'local-dev-stub' | 'production';
    /** Status of the R2-backed workspace mount inside the sandbox container. */
    workspace?: {
        mounted: boolean;
        mountPath?: string;
        detail?: string;
    };
}

/**
 * Structured error codes for preview failures, used to render actionable UI
 * instead of a generic error panel.
 *
 * The four deterministic codes (`bad_request`, `unauthorized`,
 * `preconditions_unmet`, `custom_domain_required`) exist because every
 * non-2xx Worker response used to collapse into `worker_http_error`, which
 * the router then threw as a `BAD_GATEWAY` — and a thrown error is exactly
 * what TanStack Query retries. A `400 missing_project_id` or an HMAC
 * signature mismatch was therefore attempted three times before the user saw
 * anything. See `isRetryablePreviewErrorCode` below.
 */
export type GuacamolePreviewErrorCode =
    /** Worker rejected the request as malformed — `missing_project_id`, `invalid_json_body`, unknown desktop mode. Deterministic. */
    | 'bad_request'
    /** Worker rejected our HMAC envelope — unsigned, malformed, expired, or signature mismatch. Deterministic. */
    | 'unauthorized'
    /** Worker is missing a precondition it cannot acquire mid-request (e.g. no ICE/TURN configuration, HTTP 412). Deterministic. */
    | 'preconditions_unmet'
    /** `@cloudflare/sandbox` refused to expose a port because the host is a `.workers.dev` domain (`CustomDomainRequiredError`). Deterministic. */
    | 'custom_domain_required'
    | 'connection_refused'
    | 'fetch_failed'
    | 'sandbox_runtime_blocked'
    | 'sandbox_start_failed'
    | 'worker_http_error'
    | 'timeout'
    | 'unknown';

/**
 * Failures where a second, byte-identical attempt returns the identical
 * answer. This is the CLOSED set, and retryable is the default, deliberately:
 * an unrecognized code (a future addition here, or one arriving from the
 * Worker on the wire) then costs at most a duplicate request, rather than
 * silently hardening a transient blip into a user-visible failure.
 *
 * Enumerated, with reasons:
 *   bad_request           — the Worker rejected the request itself (`400
 *                           missing_project_id`, `invalid_json_body`, bad
 *                           desktop mode). Resending it changes nothing.
 *   unauthorized          — our HMAC envelope was rejected. A secret mismatch
 *                           does not heal between attempts.
 *   preconditions_unmet   — deployment-level config the request cannot supply.
 *   custom_domain_required— the host is a `.workers.dev` domain; the SDK will
 *                           refuse to expose a port on it every single time.
 *   sandbox_runtime_blocked—the container runtime is blocked at the platform
 *                           level (`setsockoptint`); retrying has never once
 *                           resolved it.
 *
 * Everything else is retryable, notably: connection_refused / fetch_failed
 * (the Worker never answered — it may next time), sandbox_start_failed
 * (containers vanish without notice, `docs/PLATFORM-NOTES.md` §8, and a
 * restart genuinely can succeed), timeout (a cold-start race that ran past
 * our budget), and worker_http_error (now only ever a 5xx/408/429 — see
 * `classifyWorkerHttpFailure`).
 */
const DETERMINISTIC_PREVIEW_ERROR_CODES: ReadonlySet<string> = new Set<GuacamolePreviewErrorCode>([
    'bad_request',
    'unauthorized',
    'preconditions_unmet',
    'custom_domain_required',
    'sandbox_runtime_blocked',
]);

/** True when re-sending the identical preview request could plausibly change the answer. */
export function isRetryablePreviewErrorCode(code: GuacamolePreviewErrorCode | undefined): boolean {
    if (!code) return true; // unclassified — safe direction is one duplicate request
    return !DETERMINISTIC_PREVIEW_ERROR_CODES.has(code);
}

/**
 * Match the message `@cloudflare/sandbox` puts on `CustomDomainRequiredError`
 * (`exposePort` throws it verbatim for any `.workers.dev` hostname). The
 * Worker's own catch-all returns `err.message` with a 500, so the class name
 * is NOT on the wire — the message text is the only signal, and it must be
 * recognized or a permanently-misrouted deployment reads as a retryable 5xx.
 * The name is matched too, for the paths that stringify the error instead.
 */
const CUSTOM_DOMAIN_REQUIRED_RE = /CustomDomainRequiredError|Port exposure requires a custom domain/i;

/**
 * Classify a non-2xx response from the Worker. Body text is matched before
 * status, because the two failures that arrive with a misleading status
 * (`setsockoptint` and `CustomDomainRequiredError`, both surfaced as the
 * Worker's catch-all 500) are deterministic and must not be retried as 5xx.
 */
export function classifyWorkerHttpFailure(status: number, body: string): GuacamolePreviewErrorCode {
    if (/setsockoptint/i.test(body)) return 'sandbox_runtime_blocked';
    if (CUSTOM_DOMAIN_REQUIRED_RE.test(body)) return 'custom_domain_required';
    // 408/429 are the 4xx statuses that mean "later", not "never" — leave them
    // in the retryable bucket rather than treating them as a bad request.
    if (status === 408 || status === 429) return 'worker_http_error';
    if (status === 401 || status === 403) return 'unauthorized';
    if (status === 412) return 'preconditions_unmet';
    if (status >= 400 && status < 500) return 'bad_request';
    return 'worker_http_error';
}

export interface GuacamolePreviewError {
    ok: false;
    error: string;
    errorCode?: GuacamolePreviewErrorCode;
    /**
     * Whether re-sending the identical request could plausibly change the
     * answer. Travels WITH the failure rather than being re-derived by each
     * caller, so a caller cannot forget to ask — the tRPC router reads it to
     * decide whether to surface the error immediately or let it be retried.
     * Always set by `previewError` below; never hand-written.
     */
    retryable: boolean;
}

export type GuacamolePreviewResult = GuacamolePreviewSuccess | GuacamolePreviewError;

/** The single construction site for a preview failure, so `retryable` is always consistent with `errorCode`. */
function previewError(error: string, errorCode?: GuacamolePreviewErrorCode): GuacamolePreviewError {
    return { ok: false, error, errorCode, retryable: isRetryablePreviewErrorCode(errorCode) };
}

/**
 * Call the Worker's `/sandbox/preview` endpoint. Returns a typed result —
 * never throws. Errors are captured and returned as `{ ok: false, ... }` so
 * the tRPC router can surface them cleanly to the browser without leaking
 * internal details.
 */
export async function requestGuacamolePreview(
    config: CloudflareGuacamoleConfig,
    hmacSecret: string,
    input: Omit<GuacamolePreviewRequest, 'token'>,
    correlationId: string = newCorrelationId(),
): Promise<GuacamolePreviewResult> {
    if (!config.isConfigured) {
        // Deterministic by definition: no amount of retrying supplies a
        // missing env var. (The router checks `isConfigured` before it ever
        // gets here — this is the direct-caller guard.)
        return previewError(
            'cloudflare_guacamole_not_configured: set CLOUDFLARE_GUACAMOLE_WORKER_URL',
            'preconditions_unmet',
        );
    }

    const token = mintSandboxPreviewToken(hmacSecret);
    const body: GuacamolePreviewRequest = { ...input, token };

    try {
        const res = await fetch(`${config.workerUrl.replace(/\/$/, '')}/sandbox/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [CORRELATION_HEADER]: correlationId },
            body: JSON.stringify(body),
            // Generous timeout to allow the container's cold start.
            signal: AbortSignal.timeout(SANDBOX_COLD_START_TIMEOUT_MS),
        });

        if (!res.ok) {
            const text = await res.text();
            return previewError(
                `worker_http_${res.status}: ${text.slice(0, 300)}`,
                classifyWorkerHttpFailure(res.status, text),
            );
        }

        const data = (await res.json()) as GuacamolePreviewResult;
        if (!data.ok) {
            const errMsg = (data as GuacamolePreviewError).error ?? '';
            const existing = (data as GuacamolePreviewError).errorCode;
            let errorCode: GuacamolePreviewErrorCode = existing ?? 'unknown';
            if (!existing) {
                if (/setsockoptint/i.test(errMsg)) {
                    errorCode = 'sandbox_runtime_blocked';
                } else if (CUSTOM_DOMAIN_REQUIRED_RE.test(errMsg)) {
                    // Same deterministic failure as the 500 path above — the
                    // classification must not depend on which status it
                    // happened to arrive with.
                    errorCode = 'custom_domain_required';
                } else if (/sandbox.*start|container.*start/i.test(errMsg)) {
                    errorCode = 'sandbox_start_failed';
                }
            }
            return previewError(errMsg, errorCode);
        }
        return data;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const cause = (err as { cause?: unknown })?.cause;
        const causeCode = (cause as { code?: string })?.code ?? '';
        const causeMsg = cause instanceof Error ? cause.message : String(cause ?? '');
        const combined = `${msg} ${causeMsg}`;

        let errorCode: GuacamolePreviewErrorCode = 'unknown';
        if (err instanceof Error && err.name === 'TimeoutError') {
            // Real, not fabricated: this fires only when our own
            // `AbortSignal.timeout(SANDBOX_COLD_START_TIMEOUT_MS)` above
            // actually elapses (verified against Node's undici fetch —
            // AbortSignal.timeout rejects with a DOMException named exactly
            // 'TimeoutError'). Distinct from a network-level ETIMEDOUT below,
            // which is the remote end being slow to connect, not our own
            // budget running out.
            errorCode = 'timeout';
        } else if (
            /ECONNREFUSED/i.test(combined) ||
            causeCode === 'ECONNREFUSED' ||
            /connection refused/i.test(combined)
        ) {
            errorCode = 'connection_refused';
        } else if (/setsockoptint/i.test(combined)) {
            errorCode = 'sandbox_runtime_blocked';
        } else if (/fetch failed|ENOTFOUND|ETIMEDOUT|network error/i.test(combined)) {
            errorCode = 'fetch_failed';
        }

        return previewError(msg, errorCode);
    }
}

/**
 * Result of a `DELETE /sandbox/:name` request.
 *
 * `ok` is true ONLY when the Worker positively confirmed no container is
 * running under this name — its `outcome` was `destroyed` (a running
 * container was torn down) or `not_running` (idempotent: nothing was running,
 * so there was nothing to destroy). It is false for `still_running` /
 * `destroy_failed`, for a non-2xx HTTP response (including 401 — an unsigned
 * or wrongly-signed request), and for a transport failure. A caller must
 * check `ok`, never just that this function resolved without throwing — a
 * resolved promise here is NOT the same thing as a confirmed teardown.
 */
export interface GuacamoleTerminateResult {
    ok: boolean;
    /** True only when a running container was actually torn down by this call. */
    terminated: boolean;
    /** The Worker's own outcome discriminator, when it answered at all (`destroyed` | `not_running` | `still_running` | `destroy_failed`). */
    outcome?: string;
    error?: string;
}

/**
 * Request termination of a named sandbox.
 *
 * Signed with the SAME HMAC envelope every other mutating Worker route uses
 * (`mintSandboxPreviewToken`, already used for `/sandbox/preview` above) —
 * sent as `Authorization: Bearer <token>`, the transport
 * `worker/src/index.ts`'s `authorizeSignedControlRequest` prefers for a
 * body-less DELETE. This is not a new scheme; see that function's doc
 * comment and `worker/README.md`'s "Callers must sign DELETE" note.
 *
 * Never throws: a transport failure or an unconfirmed/non-2xx response comes
 * back as `{ ok: false, ... }`, exactly like every other Worker-call helper
 * in this file. UNLIKE the defect this replaces, the failure is now visible
 * to the caller (logged AND returned) instead of a silently discarded 401 —
 * `fetch` resolves normally for 4xx/5xx, so a caller that only checked for a
 * thrown exception never noticed the Worker had rejected the request.
 */
export async function requestGuacamoleSandboxTerminate(
    config: CloudflareGuacamoleConfig,
    hmacSecret: string,
    sandboxName: string,
    correlationId: string = newCorrelationId(),
): Promise<GuacamoleTerminateResult> {
    if (!config.isConfigured) {
        // No provider configured -> no sandbox to tear down. Not a failure.
        return { ok: true, terminated: false };
    }

    const token = mintSandboxPreviewToken(hmacSecret);

    try {
        const res = await fetch(`${config.workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxName)}`, {
            method: 'DELETE',
            headers: { Authorization: `Bearer ${token}`, [CORRELATION_HEADER]: correlationId },
            signal: AbortSignal.timeout(10_000),
        });

        // The Worker answers `still_running`/`destroy_failed` as HTTP 500 (see
        // `worker/src/index.ts`'s `handleTerminate`: `report.ok ? 200 : 500`),
        // so a non-2xx response can still carry a meaningful JSON body — parse
        // it either way rather than only on the 2xx path, or the most useful
        // field (`outcome`) is lost on exactly the responses where it matters.
        const text = await res.text().catch(() => '');
        let data: { ok?: unknown; terminated?: unknown; outcome?: unknown; error?: unknown } = {};
        try {
            data = text ? (JSON.parse(text) as typeof data) : {};
        } catch {
            // Non-JSON body (e.g. an edge/proxy error page) — fall through
            // with an empty `data`; the raw text still reaches the log/error.
        }

        if (!res.ok) {
            console.warn('[cloudflare-guacamole] terminate request rejected', {
                sandboxName,
                status: res.status,
                outcome: data.outcome,
                body: text.slice(0, 300),
            });
            return {
                ok: false,
                terminated: false,
                outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
                error: typeof data.error === 'string' ? data.error : `worker_http_${res.status}: ${text.slice(0, 300)}`,
            };
        }

        const ok = data.ok === true;
        if (!ok) {
            console.warn('[cloudflare-guacamole] terminate not confirmed', {
                sandboxName,
                outcome: data.outcome,
                error: data.error,
            });
        }
        return {
            ok,
            terminated: data.terminated === true,
            outcome: typeof data.outcome === 'string' ? data.outcome : undefined,
            error: typeof data.error === 'string' ? data.error : undefined,
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[cloudflare-guacamole] terminate request failed (non-fatal):', {
            sandboxName,
            error: message,
        });
        return { ok: false, terminated: false, error: message };
    }
}

/** Health-check the named sandbox. */
export async function getGuacamoleSandboxStatus(
    config: CloudflareGuacamoleConfig,
    sandboxName: string,
    correlationId: string = newCorrelationId(),
): Promise<{ ok: boolean; guacamoleRunning?: boolean; error?: string }> {
    if (!config.isConfigured) {
        return { ok: false, error: 'provider_not_configured' };
    }
    try {
        const res = await fetch(
            `${config.workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxName)}/status`,
            { headers: { [CORRELATION_HEADER]: correlationId }, signal: AbortSignal.timeout(10_000) },
        );
        if (!res.ok) return { ok: false, error: `http_${res.status}` };
        return (await res.json()) as { ok: boolean; guacamoleRunning?: boolean; error?: string };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Derive a deterministic sandbox name from a user + computer pair. Must
 * match the Worker's own `deriveSandboxId()` (`worker/src/index.ts`) exactly.
 */
export function deriveGuacamoleSandboxId(userId: string, computerId: string): string {
    const base = userId.replace(/[^a-z0-9]/gi, '').slice(0, 16);
    const scope = computerId.replace(/[^a-z0-9]/gi, '').slice(0, 16);
    return `guac-${base}-${scope}`;
}

// ─── Neko browser auto-connect URL composition ─────────────────────────────────

/**
 * Derive the deterministic per-sandbox Neko regular-user credential value
 * the browser auto-connects with. MUST byte-for-byte match the Worker's
 * `deriveNekoCredentials(...).user` so the login the container seeds and
 * the login the browser presents agree.
 *
 *   payload = `ezil-neko:user:<sandboxId>:v1`
 *   value   = HMAC-SHA256(secret, payload) -> lowercase hex, first 32 chars
 *
 * Never logged or returned to the browser directly — only embedded, opaque,
 * in the composed Neko URL's `pwd` query field for this exact preview iframe.
 */
function deriveNekoRegularUserValue(hmacSecret: string, sandboxId: string): string {
    return deriveNekoRoleValue(hmacSecret, 'user', sandboxId);
}

/**
 * Same derivation for the ADMIN role. Used only server-side, to log in to the
 * container's own Neko HTTP API (see `enableImplicitHosting` below). It is
 * NEVER placed in a URL, returned to the browser, or logged.
 *
 *   payload = `ezil-neko:admin:<sandboxId>:v1`
 */
export function deriveNekoAdminValue(hmacSecret: string, sandboxId: string): string {
    return deriveNekoRoleValue(hmacSecret, 'admin', sandboxId);
}

function deriveNekoRoleValue(hmacSecret: string, role: 'user' | 'admin', sandboxId: string): string {
    const payload = `ezil-neko:${role}:${sandboxId}:v1`;
    return createHmac('sha256', hmacSecret).update(payload).digest('hex').toLowerCase().slice(0, 32);
}

/**
 * Compose the browser-safe desktop preview URL: sets the auto-connect query
 * params so the iframe logs straight into the EZiL OS desktop instead of
 * stopping at Neko's login form.
 *
 * When no `hmacSecret` is configured (local dev), falls back to Neko's
 * built-in local default member password so a keyless environment still
 * auto-connects; the raw HMAC secret is NEVER placed in the URL.
 *
 * `embed=1` is deliberate and load-bearing — it is what makes this look like
 * the user's own computer instead of somebody else's app. In the pinned
 * client bundle (`/var/www/js/app.*.js`) it drives:
 *
 *   get videoOnly() { return this.isCastMode || this.isEmbedMode }
 *
 * and `videoOnly` is what suppresses Neko's header (which contains an
 * `<a href="https://github.com/m1k1o/neko">` logo), member list, chat sidebar,
 * emote bar and toast overlay, leaving only the desktop.
 *
 * It ALSO — counter-intuitively — is what keeps Neko's own in-video control
 * button reachable. The button renders as
 * `<li :class="extraControls || 'extra-control'">`, `extraControls` is bound
 * to embed mode, and the stylesheet says
 * `.video-menu li.extra-control { display: none }` above 768px. In embed mode
 * the class binding evaluates to the boolean `true`, which Vue 2 stringifies
 * to `''` — so the button carries no class and stays visible at every width.
 * Dropping `embed=1` would hide it on desktop. Do not remove this param.
 */
export function composeBrowserDesktopUrl(rawUrl: string, hmacSecret: string, sandboxId: string): string {
    const url = new URL(rawUrl);
    const pwd = hmacSecret ? deriveNekoRegularUserValue(hmacSecret, sandboxId) : 'neko';
    url.searchParams.set('usr', 'EZiL');
    url.searchParams.set('pwd', pwd);
    url.searchParams.set('embed', '1');
    return url.toString();
}

// ─── Taking control of your own computer ──────────────────────────────────────

/**
 * Outcome of trying to put the desktop into implicit-hosting mode.
 *
 *   'implicit' — the user just clicks the desktop and it is theirs; the click
 *                itself is replayed, so the handshake is invisible.
 *   'manual'   — we could not enable it. The desktop still works, but the
 *                user must first click Neko's small mouse icon in the video's
 *                top-right corner. The UI says so rather than leaving them to
 *                discover that their computer ignores them.
 */
export type DesktopControlMode = 'implicit' | 'manual';

/** Whole time budget for the control-mode handshake, on the desktop-open critical path. */
const IMPLICIT_HOSTING_BUDGET_MS = 8_000;

/** The one field we change. Every other setting is read back and preserved verbatim. */
type NekoRoomSettings = Record<string, unknown> & { implicit_hosting?: boolean };

/**
 * Make the computer respond to a plain click, the way a computer should.
 *
 * WHY THIS EXISTS. Neko is built for *shared* browsing, so control is a
 * request/grant handshake between members. This product is a single-user
 * computer: there is exactly one member, and asking them to request control of
 * their own machine is pure friction. Neko has a switch for precisely this —
 * `session.implicit_hosting` — but the pinned image's baked
 * `/etc/neko/neko.yaml` turns it OFF (`# default setting for legacy API`),
 * overriding Neko's own default of ON.
 *
 * With it OFF, the shipped client's `implicitHostingRequest()` reduces a click
 * to `$emit('control-attempt')`, whose only effect is a 5s shake animation on
 * `<neko-controls>` — a component `embed=1` does not even render. So a click
 * on the desktop does nothing at all, silently, forever.
 *
 * With it ON, the same handler calls `remote.request()` AND buffers the
 * mousedown/mouseup, replaying them from `onControlChange` once control lands.
 * The user experiences one ordinary click.
 *
 * HOW. Neko exposes the flag on its own admin API. We log in with the
 * per-sandbox admin credential the Worker already derives, read the CURRENT
 * settings, flip exactly one field, and write the merged object back —
 * `settingsSet` is a whole-object replace, so a hand-written body silently
 * resets everything it omits (observed live: posting without
 * `heartbeat_interval` reset the room's 10 to 0).
 *
 * ORDERING. The client reads `implicit_hosting` exactly once, from the legacy
 * `system/init` websocket message; there is no live update path. This runs
 * server-side BEFORE the preview URL is handed to the browser, so the flag is
 * already true by the time the iframe connects.
 *
 * NEVER THROWS, and never blocks a working desktop: any failure returns
 * 'manual' and the caller renders a visible fallback affordance. Nothing about
 * the admin credential or the session token is logged or returned.
 *
 * (The durable fix is one flag on the container's own `neko serve` invocation
 * — `--session.implicit_hosting=true` in `worker/scripts/start-neko.sh`. When
 * that lands, this becomes a cheap no-op: the read below already reports
 * `true` and it returns without writing.)
 */
export async function enableImplicitHosting(
    desktopUrl: string,
    adminPassword: string,
): Promise<DesktopControlMode> {
    let origin: string;
    try {
        origin = new URL(desktopUrl).origin;
    } catch {
        return 'manual';
    }

    const deadline = AbortSignal.timeout(IMPLICIT_HOSTING_BUDGET_MS);
    let token: string | null = null;

    try {
        const loginRes = await fetch(`${origin}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'ezil-os-control', password: adminPassword }),
            signal: deadline,
        });
        if (!loginRes.ok) return 'manual';
        const login = (await loginRes.json()) as { token?: unknown };
        if (typeof login.token !== 'string' || login.token.length === 0) return 'manual';
        token = login.token;

        const auth = { Authorization: `Bearer ${token}` };

        const currentRes = await fetch(`${origin}/api/room/settings`, { headers: auth, signal: deadline });
        if (!currentRes.ok) return 'manual';
        const current = (await currentRes.json()) as NekoRoomSettings;
        if (current.implicit_hosting === true) return 'implicit';

        const setRes = await fetch(`${origin}/api/room/settings`, {
            method: 'POST',
            headers: { ...auth, 'Content-Type': 'application/json' },
            // Merge, never replace — see the doc comment above.
            body: JSON.stringify({ ...current, implicit_hosting: true }),
            signal: deadline,
        });
        return setRes.ok ? 'implicit' : 'manual';
    } catch {
        // Timeout, transport failure, non-JSON body — all mean the same thing
        // to the user, and none of them may take the desktop down with them.
        return 'manual';
    } finally {
        if (token) {
            // Don't leave a phantom admin session in the room. Best effort:
            // its failure changes nothing the user can perceive.
            void fetch(`${origin}/api/logout`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(3_000),
            }).catch(() => undefined);
        }
    }
}
