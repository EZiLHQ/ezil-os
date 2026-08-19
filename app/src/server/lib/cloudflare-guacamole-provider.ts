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
 * (authored post-Onlook-import, listed as safe to carry). Originally dropped
 * from the source on purpose, since none of it was wired in this app:
 *   - The app-preview ("Option D" dev-server iframe) bootstrap/status path
 *     — the source file's own doc comment said this was "NOT wired in this
 *     wave" even there, and this repo had no dev-server-in-sandbox story at
 *     all. NOW WIRED (the "App-preview (Option D) bootstrap token + URL"
 *     section below + `routers/cloudflare-guacamole.ts`'s `appPreviewUrl`):
 *     the Worker side (`worker/src/preview-bridge.ts`, `desktop-mode.ts`'s
 *     `appPortFor`, `hmac.ts`'s `mintPreviewBootstrapToken` family) already
 *     existed; this is the app-side minting server that contract calls for.
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
 * 🔴 HOW LONG ONE PREVIEW REQUEST MAY HOLD A CALLER BEFORE IT ADMITS THE
 * CONTAINER IS STILL WAKING.
 *
 * ── The regression this exists for ──────────────────────────────────────────
 * Containers now hibernate when idle. The first request after a hibernation
 * wakes one, and the Worker's readiness wait (`WORKER_DESKTOP_READY_TIMEOUT_MS`,
 * 180s) does not survive it: measured in production, `POST /sandbox/preview`
 * came back 500 `desktop_failed_to_start` at 187s, the tRPC layer threw
 * BAD_GATEWAY over it, and both shell clients — which map every non-401 HTTP
 * failure to `unknown` — showed "We couldn't start your computer." Clicking
 * Retry two seconds later succeeded in 5-22s, every single time, because the
 * wake HAD worked. The only thing that failed was the request that triggered it.
 *
 * ── Why answering early is the fix, and not a papering-over ─────────────────
 * The container boot is NOT bound to this request. `ensureDesktop` issues
 * `sandbox.startProcess` inside the first ~6s (measured: container_start ~0.3s,
 * workspace_mount ~5.9s) and the container proceeds on the Durable Object's own
 * lifetime from there. So a caller that stops WAITING has not stopped the wake;
 * it has only stopped pretending that one request must witness it. 12s sits
 * comfortably past that ~6s, so we never abandon a request before the thing we
 * are waiting for has even been asked for.
 *
 * What comes back instead is `sandbox_starting` — LABELLED, retryable, and
 * carrying the one true statement available: it is waking, ask again. Callers
 * turn that into the `waking`/`mounting`/`starting`/`connecting` progress the
 * boot UI already knows how to draw, instead of a dead end.
 *
 * 🔴 This does NOT abort the in-flight Worker call. Aborting would be the one
 * way to actually damage the wake — it would cancel the Worker invocation that
 * is driving it. The fetch is left running under its own
 * `SANDBOX_COLD_START_TIMEOUT_MS` budget with its rejection swallowed; whatever
 * it eventually answers is discarded, because the caller has already been told
 * the truth and has already moved on.
 */
export const SANDBOX_WAKE_ANSWER_BUDGET_MS = 12_000;

/** The race sentinel. A unique object, so nothing off the wire can impersonate it. */
const WAKE_STILL_RUNNING = Symbol('sandbox_wake_still_running');

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
    /**
     * The X screen the container should BOOT at, already snapped to the closed
     * mode table (`SCREEN_MODES` below) by `resolveScreenRequest`.
     *
     * 🔴 OMITTED ENTIRELY, never sent as a default, when the caller asked for
     * nothing or asked for something rejected. The Worker only injects
     * `NEKO_SCREEN` when this field is present, so "absent" and "1920x1080"
     * produce byte-for-byte the same container — which is what makes an OLD
     * shell bundle against a NEW server behave exactly as it does today.
     */
    screen?: { width: number; height: number };
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
    /**
     * Outcome of the Worker's best-effort app-preview (Option D) raw-port
     * exposure step (`AppPreviewExposeResult`, `worker/src/index.ts`).
     *
     * 🔴 `attempted: false` is NOT a negative signal on its own. It means
     * either (a) `desktopMode` has no app-preview surface at all
     * (guacamole mode), OR (b) the desktop port was already exposed from a
     * PRIOR call, in which case `ensureDesktop`'s fast path skips
     * re-attempting the app-preview expose too and reports `attempted:
     * false` even when a previous call already exposed it successfully.
     * The only trustworthy NEGATIVE is `attempted: true, exposed: false` —
     * see `cloudflareGuacamole.appPreviewUrl`'s doc comment for how that
     * distinction is used.
     */
    appPreviewExpose?: {
        attempted: boolean;
        exposed: boolean;
        error?: string;
        /** The raw exposed base URL, when the Worker has one. Added Wave A. */
        url?: string;
    };

    /**
     * The same, for the code-server bridge (`CODE_PREVIEW_PORT` 8443). Read by
     * `cloudflareGuacamole.codePreviewUrl` exactly as `appPreviewExpose` is
     * read by `.appPreviewUrl` — same three-state reasoning, same "only
     * `attempted: true, exposed: false` is a real negative" rule.
     */
    codePreviewExpose?: {
        attempted: boolean;
        exposed: boolean;
        error?: string;
        url?: string;
    };

    /**
     * 🔴 THE COMPOSED URL, STRAIGHT FROM THE WORKER — prefer this over
     * recomputing it. RECONCILED Wave A.
     *
     * `worker/src/index.ts`'s `handlePreview` now mints the bootstrap token
     * and composes the full `…/preview-bootstrap?token=…` URL itself, from the
     * hostname `exposePreviewPort` ACTUALLY produced. This app also knows how
     * to build that URL (`composeAppPreviewOrigin` +
     * `mintAppPreviewBootstrapToken`), and two independent implementations of
     * one wire format is precisely the drift this codebase keeps getting bitten
     * by: the app would have to re-derive the Worker's per-request zone-collapse
     * decision, and be wrong the moment its zone config changed.
     *
     * So `cloudflareGuacamole.appPreviewUrl` uses THIS when present and falls
     * back to composing its own only when it is absent. The fallback is not
     * dead code and must not be deleted: app and Worker are separate deploy
     * targets, so an app release can reach a Worker that predates this field.
     *
     * `null` (never omitted) means the port was not exposed — the Worker
     * distinguishes "not available" from "this Worker is too old to say", and
     * so does the caller.
     */
    appPreviewUrl?: string | null;

    /**
     * The same, for the code-server bridge (`CODE_PREVIEW_PORT` 8443 /
     * `CODE_PREVIEW_TOKEN` 'code'). MODIFIED BY EZIL 2026-08-01 (T7): this
     * field is now read, by `cloudflareGuacamole.codePreviewUrl` — see that
     * procedure and `composeCodePreviewOrigin` below for the fallback path.
     */
    codePreviewUrl?: string | null;
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
    /**
     * The container is WAKING and this request is not going to wait for it.
     * A soft, labelled, retryable "not ready yet" — see
     * `SANDBOX_WAKE_ANSWER_BUDGET_MS`. It is never a statement that anything
     * failed, and callers must render it as progress, not as an error.
     */
    | 'sandbox_starting'
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
 * our budget), worker_http_error (now only ever a 5xx/408/429 — see
 * `classifyWorkerHttpFailure`), and sandbox_starting, which is not merely
 * retryable but is a REQUEST to be re-asked: it means the wake is under way
 * and the next attempt is how we find out it finished.
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
 * Expected operational failures — not server bugs. The tRPC router returns
 * these as typed result objects instead of throwing, so the browser gets a
 * first-class actionable panel rather than a generic one.
 */
const OPERATIONAL_PREVIEW_ERROR_CODES: ReadonlySet<string> = new Set<GuacamolePreviewErrorCode>([
    'connection_refused',
    'fetch_failed',
    'sandbox_runtime_blocked',
    'sandbox_start_failed',
    'sandbox_starting',
    'timeout',
]);

/**
 * Does this failure reach the browser WITH ITS CODE, or as a thrown 502 the
 * browser can only call `unknown`?
 *
 * 🔴 A THROW DESTROYS THE LABEL. Anything the router raises as a `TRPCError`
 * becomes `{error:{code:'BAD_GATEWAY', message:<generic>}}` with a 502
 * (`server/shell/http.ts` strips 5xx detail on purpose, because an internal
 * message can carry internals), and both shell clients map every non-401 HTTP
 * failure to `unknown` — whose copy is the dead end "We couldn't start your
 * computer." So this is not a stylistic choice about throwing: it is the
 * difference between a code the browser can act on and no code at all.
 *
 * It lives HERE rather than in the router because the router imports the
 * database and cannot be loaded by a unit test — and an untestable rule is how
 * this one went unexamined while it silently deleted every label that mattered.
 *
 * `sandbox_starting` is the most important member of the operational set: it
 * is the answer a hibernated container gives, it is PROGRESS rather than a
 * failure, and it is worthless if it arrives unlabelled.
 */
export function surfacePreviewErrorAsValue(
    errorCode: string | undefined,
    retryable: boolean,
): boolean {
    // Nothing to surface. Unreachable from `previewError` now that the code is
    // required, and kept as the belt on those braces.
    if (!errorCode) return false;
    // A deterministic failure must never be thrown: a thrown error is the only
    // thing TanStack Query retries, and re-asking a fixed question is pure
    // latency in front of the same panel.
    return !retryable || OPERATIONAL_PREVIEW_ERROR_CODES.has(errorCode);
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
    /**
     * 🔴 REQUIRED. Not optional, and this is the whole point.
     *
     * It was optional, and `previewError`'s second parameter was optional to
     * match, so it was possible — and legal, and silent — to construct a soft
     * failure carrying no code at all. Every caller downstream then has exactly
     * one thing left to say about it: `errorCode ?? 'unknown'`, whose user-facing
     * copy is the dead end "We couldn't start your computer." A failure with no
     * label cannot be classified, cannot be retried on purpose, and cannot be
     * told apart from a genuine bug.
     *
     * Making it required is not a lint: it is the reason `previewError` below
     * can no longer be called without deciding what kind of failure this is.
     * `'unknown'` is still available for a failure that genuinely is unknown —
     * but now somebody has to write the word.
     */
    errorCode: GuacamolePreviewErrorCode;
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

/**
 * The single construction site for a preview failure, so `retryable` is always
 * consistent with `errorCode`.
 *
 * 🔴 `errorCode` IS REQUIRED, AT THE TYPE LEVEL. It used to be optional, which
 * made an unlabelled soft failure constructible by simply not passing it — and
 * that is exactly what reached production: a 200 or a 502 whose body carried no
 * code, which both shell clients collapsed to `unknown` and rendered as "We
 * couldn't start your computer." over a container that was merely waking.
 *
 * There is now no way to build a `GuacamolePreviewError` without naming its
 * kind. `'unknown'` remains a legitimate answer for a failure that genuinely is
 * unknown; the difference is that somebody has to type it, and a reviewer can
 * see them do it. See `previewError refuses to build an unlabelled failure` in
 * `cloudflare-guacamole-provider.test.ts` for the compile-time proof.
 */
function previewError(error: string, errorCode: GuacamolePreviewErrorCode): GuacamolePreviewError {
    return { ok: false, error, errorCode, retryable: isRetryablePreviewErrorCode(errorCode) };
}

/**
 * Call the Worker's `/sandbox/preview` endpoint. Returns a typed result —
 * never throws. Errors are captured and returned as `{ ok: false, ... }` so
 * the tRPC router can surface them cleanly to the browser without leaking
 * internal details.
 *
 * 🔴 IT NO LONGER WAITS FOR A HIBERNATED CONTAINER. Past
 * `SANDBOX_WAKE_ANSWER_BUDGET_MS` it answers `sandbox_starting` — labelled,
 * retryable, and true — and leaves the Worker call running so the wake it
 * started is not disturbed. See that constant for the measured failure this
 * replaces.
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
        const workerCall = fetch(`${config.workerUrl.replace(/\/$/, '')}/sandbox/preview`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', [CORRELATION_HEADER]: correlationId },
            body: JSON.stringify(body),
            // Generous timeout to allow the container's cold start.
            signal: AbortSignal.timeout(SANDBOX_COLD_START_TIMEOUT_MS),
        });
        // Whatever happens to this call after the wake budget expires is not
        // this caller's business any more, but an unhandled rejection IS
        // everybody's business. Swallow it here, once, at the source.
        workerCall.catch(() => {});

        let wakeTimer: ReturnType<typeof setTimeout> | undefined;
        let res: Response;
        try {
            const answered = await Promise.race([
                workerCall,
                new Promise<typeof WAKE_STILL_RUNNING>((resolve) => {
                    wakeTimer = setTimeout(() => resolve(WAKE_STILL_RUNNING), SANDBOX_WAKE_ANSWER_BUDGET_MS);
                }),
            ]);
            if (answered === WAKE_STILL_RUNNING) {
                // 🔴 NOT A FAILURE, AND SAID SO IN THE LABEL. The Worker is
                // still working and the container is still coming up; we are
                // simply declining to hold this connection for another ~175s
                // and then hand back something nobody can classify.
                console.info('[requestGuacamolePreview] container still waking; answering early', {
                    correlationId,
                    afterMs: SANDBOX_WAKE_ANSWER_BUDGET_MS,
                });
                return previewError(
                    `sandbox_starting: the container is still waking after ${SANDBOX_WAKE_ANSWER_BUDGET_MS}ms`,
                    'sandbox_starting',
                );
            }
            res = answered;
        } finally {
            // Both directions: a fetch that won the race must not leave a live
            // timer behind either.
            if (wakeTimer !== undefined) clearTimeout(wakeTimer);
        }

        if (!res.ok) {
            const text = await res.text();
            return previewError(
                `worker_http_${res.status}: ${text.slice(0, 300)}`,
                classifyWorkerHttpFailure(res.status, text),
            );
        }

        const data = (await res.json()) as GuacamolePreviewResult;
        if (!data.ok) {
            // 🔴 READ AS A WIRE SHAPE, NOT AS OUR OWN TYPE. `errorCode` is
            // required on `GuacamolePreviewError` so that WE cannot build one
            // without it — but the Worker is a separate deploy target and the
            // body is untrusted JSON, so a response that omits it is a real
            // state, not an impossible one. Typing the read as optional is
            // what keeps the `?? 'unknown'` below honest rather than dead code
            // that the compiler has been told to disbelieve.
            const wire = data as { error?: string; errorCode?: GuacamolePreviewErrorCode };
            const errMsg = wire.error ?? '';
            const existing = wire.errorCode;
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

// ─── Window-focus control (POST /sandbox/:name/focus) ─────────────────────────

/**
 * The apps this product will ask the container to focus.
 *
 * 🔴 THIS IS DELIBERATELY NARROWER THAN THE WORKER'S ENUM, and the difference
 * is the whole point. `worker/src/sandbox-control.ts`'s `validateFocusApp`
 * accepts `'vscode' | 'chromium'`, because the Worker is a generic primitive
 * over `/usr/local/bin/neko-switch-app.sh` and has no business deciding which
 * apps a given container image ships.
 *
 * The image no longer ships one of them. Wave A's container task replaced
 * Electron VS Code with **code-server**, which is an HTTP server on
 * `127.0.0.1:8443`, not an X client — so it never appears in `wmctrl -x -l`
 * and can never be focused. `neko-switch-app.sh`'s own heredoc in
 * `worker/scripts/start-neko.sh` says so ("The `vscode` case now has no window
 * to ever find … prints an ERROR to stderr and exits 1"), and
 * `worker/scripts/validate-neko-focus.sh` ASSERTS that non-zero exit as the
 * correct behaviour. `handleFocus` turns a non-zero exit into HTTP 500.
 *
 * So offering `'vscode'` here would be a control that fails 100% of the time —
 * the exact class of thing the container task deleted from
 * `worker/assets/ebuilder-menu.xml` ("Focus VS Code", a visible menu item that
 * silently did nothing). The reconciliation is to narrow at THIS layer, where
 * the product decision lives, and leave the Worker's generic enum alone.
 *
 * Reaching code-server is a different mechanism entirely, not a focus call:
 * it is served over the code bridge host (`CODE_PREVIEW_PORT` 8443 /
 * `CODE_PREVIEW_TOKEN` 'code'), which `worker/src/index.ts` `handleCodeBridge`
 * already proxies. Wiring a window for it is a feature, not a seam; see the
 * Wave A seams report.
 *
 * TO RE-ADD an app: put its id here AND confirm it has a real X window in the
 * shipped image (`validate-neko-focus.sh` is the check). Both, or neither.
 */
export const FOCUSABLE_APPS = ['chromium'] as const;

export type FocusableApp = (typeof FOCUSABLE_APPS)[number];

/** Type guard for the closed enum above. */
export function isFocusableApp(value: unknown): value is FocusableApp {
    return typeof value === 'string' && (FOCUSABLE_APPS as readonly string[]).includes(value);
}

export interface GuacamoleFocusResult {
    ok: boolean;
    /** The Worker's own error string, when it answered at all. */
    error?: string;
}

/**
 * Ask the Worker to foreground an app inside the container's X session.
 *
 * Signed with the SAME HMAC envelope as `DELETE /sandbox/:name` and
 * `POST /sandbox/preview` (`mintSandboxPreviewToken`), presented as
 * `Authorization: Bearer` — the transport `authorizeSignedControlRequest`
 * prefers precisely because it keeps the token out of URLs and request logs.
 * No new auth scheme.
 *
 * NEVER THROWS. A transport failure, a 401, a `SANDBOX_FOCUS=off` 404 or a
 * non-zero `neko-switch-app.sh` exit all come back as `{ ok: false, error }`.
 * A resolved promise is NOT a confirmed focus switch — callers must read `ok`,
 * and the shell must never claim the pixel changed on the strength of it (the
 * round trip is a real completion signal for the REQUEST; the encoder catching
 * up is a separate, estimated thing).
 */
export async function requestGuacamoleFocusApp(
    config: CloudflareGuacamoleConfig,
    hmacSecret: string,
    sandboxName: string,
    app: FocusableApp,
    correlationId: string = newCorrelationId(),
): Promise<GuacamoleFocusResult> {
    if (!config.isConfigured) {
        return { ok: false, error: 'provider_not_configured' };
    }

    const token = mintSandboxPreviewToken(hmacSecret);
    const endpoint = `${config.workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxName)}/focus`;

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                [CORRELATION_HEADER]: correlationId,
            },
            body: JSON.stringify({ app }),
            // Generous against the measured 150-400ms round trip, and well
            // under any route budget: this must not sit on a slow path.
            signal: AbortSignal.timeout(15_000),
        });

        // The Worker answers a failed switch as 500 WITH a JSON body carrying
        // the reason, so parse either way — same reasoning as
        // `requestGuacamoleSandboxTerminate`.
        const text = await res.text().catch(() => '');
        let data: { ok?: unknown; error?: unknown } = {};
        try {
            data = text ? (JSON.parse(text) as typeof data) : {};
        } catch {
            // Non-JSON (an edge error page). The raw text still reaches the log.
        }

        if (!res.ok || data.ok !== true) {
            console.warn('[cloudflare-guacamole] focus request rejected', {
                sandboxName,
                app,
                status: res.status,
                body: text.slice(0, 300),
            });
            return {
                ok: false,
                error:
                    typeof data.error === 'string'
                        ? data.error
                        : `worker_http_${res.status}: ${text.slice(0, 300)}`,
            };
        }

        return { ok: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[cloudflare-guacamole] focus request failed (non-fatal):', {
            sandboxName,
            app,
            error: message,
        });
        return { ok: false, error: message };
    }
}

// ─── Activity heartbeat (POST /sandbox/:name/activity) ────────────────────────
//
// The client-side half of the container-billing fix: `boot.js` used to warm a
// container on every login and `worker/src/index.ts`'s 10s workspace-flush
// alarm called `containerFetch()` on every tick, which auto-starts a stopped
// container per the SDK — so nothing could ever tell the difference between
// "someone is watching this desktop" and "a tab is merely still open", and a
// container could sit resident (billed) for HOURS with nobody at the wheel.
// This is the request `shell/ezil/apps/desktop-window.js`'s heartbeat sends
// every `HEARTBEAT_INTERVAL_MS` (`shell/ezil/activity-heartbeat.js`) while a
// human is actually there, so the Worker's own idle-reaper alarm has a real
// signal to cool down on instead of none at all.

export interface GuacamoleActivityResult {
    ok: boolean;
    /** The Worker's own error string, when it answered at all. */
    error?: string;
}

/**
 * Tell the Worker a human is present at this sandbox's desktop.
 *
 * 🔴 `worker/src/index.ts`'s `POST /sandbox/:name/activity` handler MUST NOT
 * touch the container to serve this — no `exec`, no `containerFetch` — or a
 * heartbeat that exists so an idle container can sleep would itself be what
 * keeps waking it up, exactly the `flushWorkspaceScheduled` defect this whole
 * fix is closing. This function has no way to enforce that from here; it
 * only has to not make the mistake worse by calling anything OTHER than this
 * one lightweight route.
 *
 * Same HMAC envelope as `/focus` and `/restart` (`mintSandboxPreviewToken`,
 * presented as `Authorization: Bearer`) — no new auth scheme. The Worker
 * gates this route behind the same `authorizeSignedControlRequest` and a
 * `SANDBOX_ACTIVITY=off` kill switch that 404s before auth is attempted.
 *
 * NEVER THROWS, and a resolved promise here is NOT proof the Worker recorded
 * anything — callers must read `ok`. This is a best-effort heartbeat: a
 * failed beat is swallowed by the client (`session.js#reportActivity`'s own
 * doc comment), never retried, because the next one is only
 * `HEARTBEAT_INTERVAL_MS` away and retrying a heartbeat is a contradiction in
 * terms.
 */
export async function requestGuacamoleActivity(
    config: CloudflareGuacamoleConfig,
    hmacSecret: string,
    sandboxName: string,
    lastInputAgoMs: number,
    correlationId: string = newCorrelationId(),
): Promise<GuacamoleActivityResult> {
    if (!config.isConfigured) {
        return { ok: false, error: 'provider_not_configured' };
    }

    const token = mintSandboxPreviewToken(hmacSecret);
    const endpoint = `${config.workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxName)}/activity`;

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                [CORRELATION_HEADER]: correlationId,
            },
            body: JSON.stringify({ lastInputAgoMs }),
            // A Durable Object storage write, not a container call — generous
            // against any transient edge latency, well under any route budget.
            signal: AbortSignal.timeout(10_000),
        });

        // Same parse-either-way rule as `requestGuacamoleFocusApp`: a
        // rejected/disabled heartbeat can still carry a JSON body worth
        // logging.
        const text = await res.text().catch(() => '');
        let data: { ok?: unknown; error?: unknown } = {};
        try {
            data = text ? (JSON.parse(text) as typeof data) : {};
        } catch {
            // Non-JSON (an edge error page). The raw text still reaches the log.
        }

        if (!res.ok || data.ok !== true) {
            console.warn('[cloudflare-guacamole] activity heartbeat rejected', {
                sandboxName,
                status: res.status,
                body: text.slice(0, 300),
            });
            return {
                ok: false,
                error:
                    typeof data.error === 'string'
                        ? data.error
                        : `worker_http_${res.status}: ${text.slice(0, 300)}`,
            };
        }

        return { ok: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[cloudflare-guacamole] activity heartbeat failed (non-fatal):', {
            sandboxName,
            error: message,
        });
        return { ok: false, error: message };
    }
}

// ─── Desktop restart control (POST /sandbox/:name/restart) ────────────────────

/**
 * What the Worker's `handleRestart` answers with (`worker/src/index.ts`), which
 * is `{ sandboxName, ...RestartReport }` from
 * `worker/src/sandbox-control.ts`'s `buildRestartReport`.
 *
 * `ok` is true ONLY for the Worker's `restarted` / `started` outcomes. It is
 * false for `stop_timed_out` (the old stack would not die — the Worker
 * deliberately does NOT relaunch on top of a maybe-alive one), `boot_failed`,
 * `unsupported_mode` (guacamole-mode containers have no SIGTERM trap to reuse),
 * `restart_in_progress`, a non-2xx, or a transport failure. As everywhere else
 * in this file, a resolved promise is NOT a confirmed restart — read `ok`.
 */
export interface GuacamoleRestartResult {
    ok: boolean;
    /** The Worker's own discriminator: `restarted` | `started` | `stop_timed_out`
     * | `boot_failed` | `unsupported_mode` | `restart_in_progress`. */
    outcome?: string;
    /** True when a stack was actually running and got torn down by this call
     * (as opposed to `started`, where there was nothing to stop). */
    wasRunning?: boolean;
    error?: string;
}

/**
 * Restart the desktop stack inside a LIVE container, without destroying the
 * container, the computer row, or the workspace.
 *
 * Same HMAC envelope as `DELETE /sandbox/:name` and `POST /sandbox/:name/focus`
 * (`mintSandboxPreviewToken` presented as `Authorization: Bearer`) — no new
 * auth scheme. The Worker gates this route behind the same
 * `authorizeSignedControlRequest` and a `SANDBOX_RESTART=off` kill switch that
 * 404s before auth is even attempted.
 *
 * 🔴 The timeout is 120s, an order of magnitude above `focus`'s 15s, and that
 * is the route's real cost rather than a padded guess: the Worker's own
 * `RESTART_STOP_DEADLINE_MS` gives the SIGTERM'd launcher up to 20s to confirm
 * exit, and only then runs `ensureDesktop()` — the same cold boot measured at
 * ~22s on `/sandbox/preview`. 20 + 22 is the floor, not the ceiling, so a
 * 15s budget would abort a restart that was going to succeed and report a
 * timeout for a desktop that then came back anyway. The calling Route Handler
 * carries `maxDuration = 300` for the same reason (docs/PLATFORM-NOTES.md §13).
 *
 * NEVER THROWS.
 */
export async function requestGuacamoleDesktopRestart(
    config: CloudflareGuacamoleConfig,
    hmacSecret: string,
    sandboxName: string,
    correlationId: string = newCorrelationId(),
): Promise<GuacamoleRestartResult> {
    if (!config.isConfigured) {
        return { ok: false, error: 'provider_not_configured' };
    }

    const token = mintSandboxPreviewToken(hmacSecret);
    const endpoint = `${config.workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxName)}/restart`;

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                [CORRELATION_HEADER]: correlationId,
            },
            // No `desktopMode`: an omitted mode is what makes the Worker
            // AUTO-DETECT whatever is actually running (`handleRestart`'s
            // `explicitMode` stays undefined), which is the honest thing to do
            // from here — this layer does not know, and must not assert, which
            // stack the container booted.
            body: JSON.stringify({}),
            signal: AbortSignal.timeout(120_000),
        });

        // Like terminate/focus: the Worker answers a failed restart as 400/500
        // WITH a JSON body carrying `outcome` and `error`, so parse either way
        // or the most useful field is lost on exactly the responses where it
        // matters most.
        const text = await res.text().catch(() => '');
        let data: { ok?: unknown; outcome?: unknown; wasRunning?: unknown; error?: unknown } = {};
        try {
            data = text ? (JSON.parse(text) as typeof data) : {};
        } catch {
            // Non-JSON (an edge error page). The raw text still reaches the log.
        }

        const outcome = typeof data.outcome === 'string' ? data.outcome : undefined;

        if (!res.ok || data.ok !== true) {
            console.warn('[cloudflare-guacamole] restart request rejected', {
                sandboxName,
                status: res.status,
                outcome,
                body: text.slice(0, 300),
            });
            return {
                ok: false,
                outcome,
                wasRunning: data.wasRunning === true,
                error:
                    typeof data.error === 'string'
                        ? data.error
                        : `worker_http_${res.status}: ${text.slice(0, 300)}`,
            };
        }

        return { ok: true, outcome, wasRunning: data.wasRunning === true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn('[cloudflare-guacamole] restart request failed (non-fatal):', {
            sandboxName,
            error: message,
        });
        return { ok: false, error: message };
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

// ─── App-preview (Option D) bootstrap token + URL ──────────────────────────────
//
// The "second worker's tRPC procedure" `worker/src/hmac.ts`'s own module doc
// names as the minting side of the `/preview-bootstrap` contract:
//
//   "unlike Azure's payload, this Worker's payload ALSO binds sandboxId ...
//    the minting server (the "second worker"'s tRPC procedure) MUST include
//    the exact sandboxId the token is meant to unlock."
//
// This is that minting server. `mintAppPreviewBootstrapToken` below MUST stay
// byte-for-byte identical to `worker/src/hmac.ts`'s `mintPreviewBootstrapToken`
// / `PREVIEW_BOOTSTRAP_TOKEN_PAYLOAD` — a drift here is a silent 401 on every
// app-preview window, since the Worker verifies against its own copy of the
// same payload string. Deliberately a SEPARATE implementation rather than an
// import from `worker/src`: this app deploys to Vercel (Node runtime) and the
// Worker deploys to Cloudflare via wrangler — different build/deploy targets,
// same pattern this file already follows for `deriveGuacamoleSandboxId`
// (mirrors the Worker's own `deriveSandboxId`) and `deriveNekoAdminValue`
// (mirrors `deriveNekoCredentials`).

/**
 * In-container port the user's dev server listens on. MUST match
 * `worker/src/desktop-mode.ts`'s `APP_PREVIEW_PORT`.
 */
export const APP_PREVIEW_PORT = 3002;

/**
 * Preview-URL token label for the app port. MUST match
 * `worker/src/desktop-mode.ts`'s `APP_PREVIEW_TOKEN`.
 */
export const APP_PREVIEW_TOKEN = 'app';

/**
 * In-container port code-server listens on. MUST match
 * `worker/src/desktop-mode.ts`'s `CODE_PREVIEW_PORT`. MODIFIED BY EZIL
 * 2026-08-01 (T7): added alongside the app-preview constants above, for
 * `composeCodePreviewOrigin`'s fallback path — see that function's doc
 * comment for why a fallback is needed at all.
 */
export const CODE_PREVIEW_PORT = 8443;

/**
 * Preview-URL token label for the code-server port. MUST match
 * `worker/src/desktop-mode.ts`'s `CODE_PREVIEW_TOKEN`.
 */
export const CODE_PREVIEW_TOKEN = 'code';

/**
 * Freshness window for a minted `/preview-bootstrap` token. MUST match
 * `worker/src/hmac.ts`'s `PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS` (5 min) — the
 * Worker is the one that actually enforces this; this constant only has to
 * agree so `expiresAt` on the wire tells the truth.
 */
export const APP_PREVIEW_BOOTSTRAP_TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Mint a `/preview-bootstrap?token=...` token scoped to one sandbox.
 *
 * Token format: `t=<unix_ms>,v1=<hex_hmac_sha256>`
 * Payload:      `${timestamp}.GET./preview-bootstrap.${sandboxId}.`
 * (byte-for-byte `worker/src/hmac.ts`'s `PREVIEW_BOOTSTRAP_TOKEN_PAYLOAD`.)
 *
 * Minted PER WINDOW-OPEN (`cloudflareGuacamole.appPreviewUrl`), never baked
 * into `/api/shell/session`'s boot payload: the 5-minute TTL means a token
 * minted once at session/boot time could already be stale by the time a user
 * actually opens the window, and stale again if the window stays open
 * longer than the TTL — see that procedure's doc comment for the refetch
 * cadence this is designed around.
 *
 * When `hmacSecret` is empty (local dev without a secret), returns the same
 * plaintext "local-dev" placeholder `mintSandboxPreviewToken` uses; the
 * Worker's `verifyPreviewBootstrapToken` has an identical local-dev branch
 * that accepts any token when no secret is configured.
 */
export function mintAppPreviewBootstrapToken(
    hmacSecret: string,
    sandboxId: string,
    now: number = Date.now(),
): string {
    if (!hmacSecret) {
        return 'local-dev';
    }
    const payload = `${now}.GET./preview-bootstrap.${sandboxId}.`;
    const sig = createHmac('sha256', hmacSecret).update(payload).digest('hex');
    return `t=${now},v1=${sig}`;
}

/**
 * Derive the app-preview origin (scheme + hostname, no path) from the
 * DESKTOP preview URL the SAME `/sandbox/preview` call already returned.
 *
 * Deliberately reuses `guacamoleUrl`'s own hostname suffix rather than
 * recomputing it from `CLOUDFLARE_GUACAMOLE_WORKER_URL`: the Worker's own
 * `normalizeSandboxHostname` (`worker/src/index.ts`) decides, per request,
 * whether to collapse the inbound host to its configured zone root, and
 * `guacamoleUrl` already carries whatever it decided for THIS request. A
 * second, independent implementation of that zone-collapse decision would
 * silently drift the moment the Worker's zone config changes; reusing the
 * host this call actually observed cannot drift by construction.
 *
 * `${APP_PREVIEW_PORT}-${sandboxId}-${APP_PREVIEW_TOKEN}` mirrors the exact
 * `${port}-${sandboxId}-${token}` hostname pattern `worker/src/desktop-mode.ts`
 * documents for `@cloudflare/sandbox`'s `exposePort`/`getExposedPorts` — the
 * desktop hostname in `guacamoleUrl` is the SAME pattern with the desktop's
 * own port/token in place of the app-preview ones.
 *
 * Returns `null` for a `guacamoleUrl` this cannot parse, or one whose
 * hostname has no label to strip — never expected from a real Worker
 * response; a defensive `null` here, not a throw, on a malformed upstream
 * value.
 */
export function composeAppPreviewOrigin(guacamoleUrl: string, sandboxId: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(guacamoleUrl);
    } catch {
        return null;
    }
    const dot = parsed.hostname.indexOf('.');
    if (dot <= 0) return null;
    const zoneSuffix = parsed.hostname.slice(dot + 1);
    if (!zoneSuffix) return null;
    // `URL#hostname` never includes the port — a local `wrangler dev` desktop
    // URL like `http://8181-...-nekodesktop.localhost:8787/` would otherwise
    // silently lose `:8787` here, producing an app-preview URL that points at
    // the wrong (default) port. `URL#port` carries it separately; re-attach
    // it when present.
    const zoneHost = parsed.port ? `${zoneSuffix}:${parsed.port}` : zoneSuffix;
    const host = `${APP_PREVIEW_PORT}-${sandboxId}-${APP_PREVIEW_TOKEN}.${zoneHost}`;
    return `${parsed.protocol}//${host}`;
}

/**
 * The code-server counterpart of `composeAppPreviewOrigin` — byte-for-byte
 * the same derivation, against `CODE_PREVIEW_PORT`/`CODE_PREVIEW_TOKEN`
 * instead of the app-preview pair. MODIFIED BY EZIL 2026-08-01 (T7).
 *
 * Kept as a SEPARATE function rather than a parameterised one so a reader of
 * `cloudflareGuacamole.codePreviewUrl` sees a call that names what it derives,
 * matching the existing `appPreviewUrl` / `composeAppPreviewOrigin` pairing.
 * Not the primary path in practice — `handlePreview` already composes and
 * returns `codePreviewUrl` on the wire (see `readWorkerBridgeUrl` below), so
 * this only runs against a Worker deployed before that field existed. See
 * `composeAppPreviewOrigin`'s doc comment for the full reasoning, which
 * applies here unchanged.
 */
export function composeCodePreviewOrigin(guacamoleUrl: string, sandboxId: string): string | null {
    let parsed: URL;
    try {
        parsed = new URL(guacamoleUrl);
    } catch {
        return null;
    }
    const dot = parsed.hostname.indexOf('.');
    if (dot <= 0) return null;
    const zoneSuffix = parsed.hostname.slice(dot + 1);
    if (!zoneSuffix) return null;
    const zoneHost = parsed.port ? `${zoneSuffix}:${parsed.port}` : zoneSuffix;
    const host = `${CODE_PREVIEW_PORT}-${sandboxId}-${CODE_PREVIEW_TOKEN}.${zoneHost}`;
    return `${parsed.protocol}//${host}`;
}

/**
 * What the Worker's own `appPreviewUrl` field is telling us.
 *
 *   'use'      — a composed URL arrived; use it verbatim.
 *   'refuse'   — the Worker KNOWS about the field and said `null`: the port is
 *                not exposed. A real negative.
 *   'compose'  — the field is absent, so this Worker predates it. Compose the
 *                URL on this side, as before.
 */
export type WorkerBridgeUrlVerdict =
    | { kind: 'use'; url: string }
    | { kind: 'refuse' }
    | { kind: 'compose' };

/**
 * Read the Worker's three-state `appPreviewUrl` field.
 *
 * 🔴 The three states are the whole point, and collapsing any two of them is a
 * bug with a different symptom each way:
 *
 *   - treating `null` as `undefined` composes a URL for a port that is not
 *     exposed — a window that loads nothing, with no error to show;
 *   - treating `undefined` as `null` refuses to open a preview against any
 *     Worker deployed before this field existed. The app and the Worker are
 *     separate deploy targets, so that combination is routine during a
 *     rollout, not a corner case.
 *
 * `handlePreview` in `worker/src/index.ts` is explicit that it emits `null`
 * "(never omitted) when the corresponding port wasn't exposed, so the caller
 * can tell 'not available' from 'field doesn't exist yet'". This is the caller
 * honouring that.
 */
export function readWorkerBridgeUrl(value: string | null | undefined): WorkerBridgeUrlVerdict {
    if (value === undefined) return { kind: 'compose' };
    if (value === null || value === '') return { kind: 'refuse' };
    return { kind: 'use', url: value };
}

/**
 * Compose the full `/preview-bootstrap` URL the shell opens in its
 * app-preview window: `appPreviewOrigin` (from `composeAppPreviewOrigin`)
 * plus the freshly minted token. `path` defaults to the dev server's root —
 * see `worker/src/preview-bridge.ts`'s module doc for the `GET
 * /preview-bootstrap?token=...&path=/foo` contract this composes against.
 */
export function composeAppPreviewBootstrapUrl(
    appPreviewOrigin: string,
    token: string,
    path: string = '/',
    extraParams?: Record<string, string>,
): string {
    const url = new URL('/preview-bootstrap', appPreviewOrigin);
    url.searchParams.set('token', token);
    if (path && path !== '/') {
        url.searchParams.set('path', path);
    }
    // `extraParams` exists ONLY for `codePreviewUrl`'s `folder=` (see
    // `cloudflareGuacamole.codePreviewUrl`'s compose-fallback branch) — a
    // generic escape hatch rather than a `folder`-specific parameter so this
    // function stays byte-for-byte reusable by `appPreviewUrl` above, which
    // never passes it.
    if (extraParams) {
        for (const [key, value] of Object.entries(extraParams)) {
            url.searchParams.set(key, value);
        }
    }
    return url.toString();
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

// ─── Is there actually a desktop at the other end of that URL? ────────────────
//
// 🔴 THE HANDOFF BLIND SPOT THIS SECTION CLOSES.
//
// `requestGuacamolePreview` resolving `ok: true` means one thing only: the
// Worker registered a preview port and handed back a URL. It does NOT mean a
// browser pointed at that URL gets a desktop. The two are genuinely separable,
// and were observed separated live on 2026-07-31: the Worker reported
// `guacamoleRunning: true` while every request to the preview host returned
// **HTTP 500 "Proxy routing error"**.
//
// That is not a contradiction. `worker/src/sandbox-control.ts`'s
// `describeDesktopStatus` derives `guacamoleRunning` from
// `sandbox.getExposedPorts()`, which reads Durable Object storage plus
// `ctx.container.running` and never issues a request through the edge. A port
// registered in DO storage whose EDGE ROUTE is broken reports running forever.
// So the container-side signal, which is the one the boot contract already
// trusts, structurally cannot see this failure.
//
// An iframe cannot see it either: the `load` event fires for a 500 error page
// exactly as it does for a working desktop, and cross-origin script has no
// access to the status code or the document. The browser has NO honest signal
// here at all.
//
// The one place that does is the server, which can make a plain HTTP request
// to the preview origin and read the status code. That path is not
// hypothetical: `enableImplicitHosting` below has always made exactly this
// call (`POST {origin}/api/login`) from the app server, and its success is
// what puts `implicit_hosting: true` on the wire at Neko's websocket init.

/**
 * What a probe of the desktop origin actually observed.
 *
 * `alive: true` is the ONLY value that may be turned into a "ready"/"Live"
 * claim anywhere in the product. Everything else — including "we could not
 * tell" — is not a confirmation, and callers must not launder it into one.
 * There is deliberately no third `unknown` variant: a probe that could not
 * answer is `alive: false, reason: 'unreachable'`, because the question the
 * caller is asking is "may I claim this is working?" and the answer to that
 * is unambiguously no.
 */
export type DesktopFrameProbe =
    | { alive: true; status: number }
    | {
          alive: false;
          /**
           * `http_error`  — the origin answered with >= 400. The observed 500
           *                 "Proxy routing error" lands here.
           * `unreachable` — no answer at all (transport failure or our own
           *                 timeout elapsed). Not evidence of health.
           * `bad_url`     — the string we were handed is not a URL we can probe.
           */
          reason: 'http_error' | 'unreachable' | 'bad_url';
          status?: number;
          detail?: string;
      };

/**
 * Whole budget for one desktop-frame probe. Short on purpose: this sits on the
 * desktop-open critical path, the origin is a Cloudflare edge hostname that
 * either routes or does not, and a slow answer is not a healthy desktop.
 */
export const DESKTOP_FRAME_PROBE_TIMEOUT_MS = 6_000;

/**
 * The ONE path whose query string is load-bearing rather than decorative.
 *
 * `worker/src/preview-bridge.ts`'s `handlePreviewBootstrap` answers
 * `GET /preview-bootstrap` with `401` unless `?token=` carries a valid,
 * sandbox-bound HMAC. See `PROBE_QUERY_BEARING_PATH`'s use in
 * `probeDesktopFrame` for why that makes it the exception to the drop rule.
 */
const PREVIEW_BOOTSTRAP_PATH = '/preview-bootstrap';

/**
 * Ask a frame origin, over plain HTTP, whether it is serving.
 *
 * ── The query string is DROPPED, with exactly one exception ─────────────────
 * Normally the query is removed before the request: the composed DESKTOP URL
 * carries the per-sandbox Neko credential in `?pwd=`, and this probe's URL can
 * end up in a server log or an upstream trace. Origin + path is the same
 * document either way — Neko serves its SPA shell at `/` regardless of the
 * auto-connect params, so nothing about the answer changes.
 *
 * 🔴 That last sentence is FALSE for the app-preview and code-server bridge
 * origins Wave A added, and taking it on faith inverts this whole contract
 * into a false negative. Their URL is the other way round:
 *
 *     https://3002-<sandbox>-app.<zone>/preview-bootstrap?token=t=<ts>,v1=<hmac>
 *                                       └── the document ─┘└─ the credential ─┘
 *
 * Strip that query and the Worker answers `401` — every time, for every user,
 * for a perfectly healthy preview. `confirmFrame` would then report a working
 * app-preview window as "not answering" forever. A false negative dressed as
 * caution is not safer than the false positive this contract was built to
 * stop; it is the same lie with the sign flipped, and harder to notice.
 *
 * So `/preview-bootstrap` — and ONLY that path — keeps its query. Everything
 * else, including `/preview/…` (whose `?ezil_pv=` fallback is also a
 * credential) and the desktop's `/`, is stripped exactly as before. The
 * exception is a path allow-list, not a "keep the query when it looks
 * important" heuristic.
 *
 * Keeping the token makes this a genuinely end-to-end probe rather than a
 * weaker one: the bootstrap 302s to `/preview/?ezil_pv=…`, `redirect: 'follow'`
 * walks it, and the status judged is the one the container's own dev server
 * (or code-server) returned. That is precisely what the browser's iframe is
 * about to experience.
 *
 * "Alive" is `status < 400`, i.e. the origin answered without an error status.
 * That is deliberately the weakest claim the status line can support, and it
 * is exactly the claim the product needs to stop making falsely. It does not
 * assert the bytes are a working Neko client; it asserts the edge route
 * exists and the thing behind it is not erroring, which is precisely what was
 * false during the live failure.
 *
 * NEVER THROWS.
 */
export async function probeDesktopFrame(
    rawUrl: string,
    timeoutMs: number = DESKTOP_FRAME_PROBE_TIMEOUT_MS,
): Promise<DesktopFrameProbe> {
    let target: string;
    try {
        const u = new URL(rawUrl);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') {
            return { alive: false, reason: 'bad_url', detail: 'unsupported_protocol' };
        }
        target =
            u.pathname === PREVIEW_BOOTSTRAP_PATH
                ? `${u.origin}${u.pathname}${u.search}`
                : `${u.origin}${u.pathname}`;
    } catch {
        return { alive: false, reason: 'bad_url', detail: 'unparseable' };
    }

    try {
        const res = await fetch(target, {
            method: 'GET',
            headers: { Accept: 'text/html,*/*' },
            // A redirect that lands somewhere healthy is healthy; follow it
            // (the default) rather than treating a 302 as a status to judge.
            redirect: 'follow',
            cache: 'no-store',
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.status >= 400) {
            return { alive: false, reason: 'http_error', status: res.status };
        }
        return { alive: true, status: res.status };
    } catch (err) {
        const raw = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
        // The bootstrap branch above puts a live (if short-lived) credential in
        // `target`, and some transport errors quote the URL they failed on.
        // `detail` is not returned to the browser, but it is the kind of string
        // that ends up in a log line, so redact before it can.
        const detail = raw.replace(/token=[^&\s]*/gi, 'token=[redacted]');
        return { alive: false, reason: 'unreachable', detail: detail.slice(0, 200) };
    }
}

// ─── The probe that was a coin flip, and the re-probe that is not ────────────
//
// 🔴 A SINGLE 6-SECOND GET WAS DECIDING 38% OF DESKTOP LAUNCHES.
//
// `desktop_unreachable` has exactly one producer: the pre-handoff guard in
// `routers/cloudflare-guacamole.ts`. In all ten observed production failures
// THE WORKER SUCCEEDED — it returned `ok` with a `guacamoleUrl`,
// `ensureDesktop` had already passed `desktop_ready_wait`, and the port was
// exposed. What failed was `probeDesktopFrame` above: one GET, no retry.
//
// The discriminator is decisive rather than suggestive: `codePreviewUrl` has NO
// frame probe at all, and in every one of those failures the code app minted
// successfully on the same sandbox in the same seconds. The launch with a probe
// failed; the launch without one succeeded.
//
// The mechanism is that the edge answers FAST and WRONG during a normal boot
// transition. `proxyToSandbox` returns `404 INVALID_TOKEN`,
// `410 STALE_PREVIEW_URL` and `500 Container suddenly disconnected` in well
// under a second while a container is still settling. All are `>= 400`, so the
// probe reports `alive:false` immediately — a 27.9s success and a 33s failure
// are the same boot, and the probe merely missed at the finish line.
//
// 🔴 THE CORRECT POLICY ALREADY EXISTED AND NEVER RAN. `FRAME_CONFIRM_DEADLINE_MS`
// (45s, `components/desktop/boot-phases.ts`) carries a comment saying anything
// shorter "would fire the deadline BEFORE the caller had finished asking,
// turning a slow confirmation into a fabricated failure". This 6s server-side
// probe fires first, so that 45s policy was dead code in practice.
//
// ── What this costs ─────────────────────────────────────────────────────────
// ZERO on a healthy boot: the first probe answers `alive` and the loop breaks
// before any sleep. At most +20s on a boot that was going to fail anyway —
// inside the route's `maxDuration = 300` and well inside the shell's own 215s
// `DESKTOP_BOOT_TIMEOUT_MS`.
//
// 🔴 `probeDesktopFrame`'s own default is deliberately UNCHANGED. `confirmFrame`
// (the shell's post-handoff `?confirm=frame` check) shares that function and is
// a genuinely one-shot question asked repeatedly by a client that owns its own
// retry policy. Lengthening it there would make each of those asks slower
// without making any of them more informative.

/**
 * Whole budget for the pre-handoff frame confirmation, across all attempts.
 *
 * 🔴 20s WAS NOT ENOUGH, and this is the number production picked, not a guess.
 * The re-probe shipped at 20s on 2026-08-19 and immediately did what it was
 * designed to do — the failure shape changed rather than disappearing:
 *
 *     before the re-probe   fail at 32-35s   (one 6s probe, then a retry
 *                                             0.4-1.6s later that could never
 *                                             work — 10 of 10 never recovered)
 *     with a 20s budget     fail at 43-50s   (retry legs 20,970ms / 27,852ms,
 *                                             i.e. the budget fully consumed)
 *
 * A budget that is fully consumed and still fails is a budget that is too
 * small, not a mechanism that does not work: the origin is genuinely not
 * answering for longer than 20s. That is the edge, not the container — by this
 * point `ensureDesktop` has already passed `desktop_ready_wait`, which is an
 * in-container `wget` on `127.0.0.1:8181`, so neko is serving *inside* while
 * the public `*-nekodesktop` hostname is still not routable. There is no local
 * analogue of that gap, which is precisely why every local run passed.
 *
 * 🔴 30s, NOT the 45s used elsewhere for the same question, and the difference
 * is a hard constraint rather than taste. 45s was tried and
 * `desktop-frame-reprobe.test.ts`'s "stays inside the route and shell budgets
 * that contain it" caught it: a worst-case ~180s Worker wait is already inside
 * this request, and 180 + 45 = 225s overruns the shell's own
 * `DESKTOP_BOOT_TIMEOUT_MS` of 215s — the client would give up while the server
 * was still patiently probing, converting a slow success into a failure at a
 * different layer. 180 + 30 = 210s fits. The guard was right and this comment
 * exists so nobody "fixes" it upward again without moving the 180s first.
 *
 * The related 45s figures (`FRAME_CONFIRM_DEADLINE_MS` in
 * `shell/ezil/apps/desktop-window.js`, and `boot-phases.ts`) are CLIENT-side
 * deadlines with no 180s sitting inside them. Same reasoning, different
 * containing budget — do not conflate them.
 *
 * ⚠️ This makes a FAILING boot slower (~55s worst case) to make a SLOW boot
 * succeed, and 30s may still not be enough. If production keeps failing at the
 * budget, the answer is NOT a bigger number here — it is the boot panel telling
 * the user "your computer is running, we cannot reach its screen yet" while it
 * waits, and shrinking the 180s Worker wait that owns most of the envelope.
 */
export const DESKTOP_FRAME_CONFIRM_BUDGET_MS = 30_000;

/** Gap between attempts. Long enough not to hammer the edge, short enough to catch a fast settle. */
export const DESKTOP_FRAME_CONFIRM_GAP_MS = 1_500;

/**
 * Ask the desktop origin whether it is serving, and keep asking until it is or
 * the budget runs out.
 *
 * Reports `attempts` and `elapsedMs` alongside the verdict so a failure can be
 * read as "we asked N times over M ms and it never answered" rather than as an
 * unqualified "unreachable" — which is what nobody could tell apart before.
 *
 * NEVER THROWS: every attempt is a `probeDesktopFrame`, which never throws.
 */
export async function confirmDesktopFrame(
    rawUrl: string,
    budgetMs: number = DESKTOP_FRAME_CONFIRM_BUDGET_MS,
    gapMs: number = DESKTOP_FRAME_CONFIRM_GAP_MS,
): Promise<DesktopFrameProbe & { attempts: number; elapsedMs: number }> {
    const started = Date.now();
    let attempts = 0;
    let last: DesktopFrameProbe = { alive: false, reason: 'unreachable', detail: 'no probe attempted' };

    for (;;) {
        attempts++;
        // Each attempt gets the SHORTER of the per-probe timeout and whatever
        // is left of the whole budget, so the loop cannot overrun its own
        // ceiling by up to a full probe timeout on the last try.
        const remaining = started + budgetMs - Date.now();
        last = await probeDesktopFrame(rawUrl, Math.max(1, Math.min(DESKTOP_FRAME_PROBE_TIMEOUT_MS, remaining)));
        if (last.alive) break;
        // 🔴 `bad_url` is DETERMINISTIC — an unparseable or non-HTTP URL is the
        // same answer however many times it is asked, and retrying it would
        // spend the whole budget learning nothing. Every other reason
        // (`http_error`, `unreachable`) is exactly the transient the retry
        // exists for.
        if (last.reason === 'bad_url') break;
        if (Date.now() + gapMs >= started + budgetMs) break;
        await sleep(gapMs);
    }

    return { ...last, attempts, elapsedMs: Date.now() - started };
}

// ─── Did any pixels actually reach the browser? ───────────────────────────────
//
// 🔴 THE SECOND BLIND SPOT, ONE LAYER BELOW THE FIRST.
//
// `probeDesktopFrame` above closed the gap between "the Worker registered a
// port" and "the desktop origin serves". It cannot close the next one, and
// measured under WebKit it did not: the shell declared **ready in 4.6s** with
// `videoWidth: 0, paused: true, srcObject: false`. The origin answered 200 —
// it served Neko's SPA shell perfectly — and then WebRTC never connected, so
// the user sat looking at a third-party spinner under a checkmark we had
// already drawn. Every signal the contract had was true; the screen was blank.
//
// The browser cannot report this. The desktop iframe is
// `8181-<sandbox>-nekodesktop.<zone>` inside the app origin, so
// `video.videoWidth` is unreadable from the parent, and it is not fixable by
// injecting a reporter either: `parseBridgeHost` (`worker/src/preview-bridge.ts`)
// accepts only ports 3002/8443 and routes 8181 down the SDK's raw
// `proxyToSandbox` path, so the shim injector never sees this response at all.
// Putting the desktop behind the bridge proxy to change that would hand our
// own proxy Neko's WebSocket — which is its WebRTC SIGNALLING channel — and
// this repo already carries that scar: wrapping code-server's non-HMR socket
// "breaks the extension host immediately and silently".
//
// The server can answer it, because Neko keeps the books itself. Per session it
// tracks `state.is_watching`, and that flag has exactly one writer:
//
//     // internal/webrtc/manager.go
//     connection.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
//         switch state {
//         case webrtc.PeerConnectionStateConnected:
//             session.SetWebRTCConnected(peer, true)   // -> state.IsWatching = true
//
// So `is_watching: true` means a real `RTCPeerConnection` belonging to a real
// browser reached `connected` and Neko is pushing media into it. That is not a
// reachability probe and not a timer; it is the far end of the same pipe whose
// near end is the `<video>` element we are not allowed to look at.
//
// We already hold the credential and the code path: `enableImplicitHosting`
// below has logged into this exact API, from this exact server, since the
// control-mode work. This adds one authenticated GET to it.

/**
 * What a probe of the desktop's WebRTC bookkeeping actually observed.
 *
 * 🔴 Three values, and the third is load-bearing. `probeDesktopFrame`
 * deliberately has no `unknown` variant — for a reachability question, "no
 * answer" IS the answer, because the browser is about to fetch that same URL
 * and get the same nothing. This question is different: it is answered by an
 * API on the far side of OUR OWN plumbing, so a non-answer is a fact about our
 * plumbing, not about the user's display. Collapsing it into `blank` would
 * mean a single deploy-time mistake — a renamed field, a Neko bump, an admin
 * password that stopped deriving — showing every user in the product a failure
 * panel over a desktop that is streaming perfectly. That is the same lie as the
 * one being fixed, with the sign flipped, and it is worse because it is total.
 *
 * So:
 *   'live'    — at least one session's WebRTC peer is connected. The ONLY value
 *               that may be turned into "ready" anywhere.
 *   'blank'   — a WELL-FORMED session list in which nobody is watching. A real,
 *               positive observation that no pixels are being delivered. `[]`
 *               counts: no sessions means no viewer.
 *   'unknown' — we could not obtain a well-formed answer. Never a pass, and
 *               never a failure either.
 */
export type DesktopDisplayProbe =
    | { display: 'live'; sessions: number; watching: number }
    | { display: 'blank'; sessions: number }
    | {
          display: 'unknown';
          /**
           * `bad_url`      — not a URL we can probe.
           * `login_failed` — the Neko API refused our admin credential, or
           *                  handed back no token.
           * `http_error`   — `/api/sessions` answered >= 400.
           * `unrecognised` — it answered 2xx with something that is not a list
           *                  of sessions carrying a boolean `is_watching`. The
           *                  shape we rely on changed; we must not guess.
           * `unreachable`  — no answer at all, or our own timeout elapsed.
           */
          reason: 'bad_url' | 'login_failed' | 'http_error' | 'unrecognised' | 'unreachable';
          status?: number;
      };

/**
 * Whole budget for one display probe: login + list. Sits on the desktop-open
 * critical path and is polled, so it is kept tight — the container is already
 * awake and these are two small JSON round trips to an edge hostname that has
 * just been observed answering.
 */
export const DESKTOP_DISPLAY_PROBE_TIMEOUT_MS = 6_000;

// ─── One admin session per container, not one per question ───────────────────
//
// 🔴 THE PROBE'S OWN SERIAL ROUND TRIP WAS THE WHOLE COST.
//
// Measured in production: the display gate added a median 1508ms to a warm
// boot, of which 1454ms was `probeDesktopDisplay` itself — and half of that is
// `POST /api/login`, which the probe repeated on every single ask while
// `enableImplicitHosting` had logged into the SAME origin with the SAME derived
// password seconds earlier and thrown the token away.
//
// So the token is kept. One process-local entry per origin, spent by both call
// sites, re-minted on expiry or on a 401.
//
// ── Why this cannot make the gate dishonest ─────────────────────────────────
// A cached token can only ever be WRONG in the direction of `unknown`. If it
// has been revoked (container restarted, Neko restarted, password rotated) the
// sessions GET answers 401/403; the probe then drops it, logs in once, and asks
// again — and if THAT fails it returns `unknown`, exactly as it does today.
// There is no path on which a stale token produces `live` or `blank`: both come
// only from a 2xx body that passed the well-formedness gate.
//
// ── What it costs ───────────────────────────────────────────────────────────
// The admin session now outlives the request that opened it, so a container can
// carry one for up to the TTL. It is not a watcher (it holds no peer
// connection) and so cannot inflate the probe's own answer; it only appears in
// the `sessions` COUNT, which is reported and never decided on. Against that:
// the polling gate used to open and close an admin session every second, and
// now opens at most one per TTL. The room is quieter, not busier.
//
// 🔴 Process-local and best-effort BY DESIGN. On a serverless deployment a
// later request may land on a cold instance and simply log in again. That is a
// missed saving, never a wrong answer, and it is why nothing here is allowed to
// be load-bearing.

/** How long a minted Neko admin token may be reused before it is re-minted. */
export const NEKO_ADMIN_TOKEN_TTL_MS = 120_000;

interface CachedAdminToken {
    token: string;
    /** The credential it was minted with. A rotated password must not reuse it. */
    password: string;
    expiresAt: number;
}

const nekoAdminTokens = new Map<string, CachedAdminToken>();

/** Best-effort `POST /api/logout`. Never awaited, never throws. */
function releaseNekoAdminToken(origin: string, token: string): void {
    void fetch(`${origin}/api/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(3_000),
    }).catch(() => undefined);
}

/**
 * Hand a freshly minted admin token to the cache. Any token it replaces is
 * logged out, so the room never accumulates sessions.
 */
export function cacheNekoAdminToken(origin: string, password: string, token: string): void {
    const previous = nekoAdminTokens.get(origin);
    if (previous && previous.token !== token) releaseNekoAdminToken(origin, previous.token);
    nekoAdminTokens.set(origin, { token, password, expiresAt: Date.now() + NEKO_ADMIN_TOKEN_TTL_MS });
}

/** The cached token for this origin, if one was minted with this password and is not stale. */
export function cachedNekoAdminToken(origin: string, password: string): string | null {
    const hit = nekoAdminTokens.get(origin);
    if (!hit) return null;
    if (hit.password !== password || hit.expiresAt <= Date.now()) {
        nekoAdminTokens.delete(origin);
        releaseNekoAdminToken(origin, hit.token);
        return null;
    }
    return hit.token;
}

/** Forget a token the far end has stopped honouring. No logout — it is already gone. */
export function dropNekoAdminToken(origin: string, token: string): void {
    if (nekoAdminTokens.get(origin)?.token === token) nekoAdminTokens.delete(origin);
}

/**
 * Empty the cache without talking to anything. For tests only — a module-level
 * cache that survives between cases is a test that passes for the wrong reason.
 */
export function resetNekoAdminTokenCacheForTests(): void {
    nekoAdminTokens.clear();
}

/**
 * Is anything actually being decoded at the other end of that desktop URL?
 *
 * ── The well-formedness gate is the whole safety property ───────────────────
 * `blank` is only ever returned for a body that is an ARRAY every one of whose
 * entries carries a BOOLEAN `state.is_watching`. Anything else — an object, a
 * string, an array of entries missing the field, an HTML error page that
 * somehow arrived with a 2xx — is `unrecognised`, i.e. `unknown`. The rule is
 * not "parse leniently and assume the worst"; it is "either we understood the
 * answer or we did not have one". A future Neko that renames the field makes
 * every probe `unknown` and every desktop reveal exactly as it does today,
 * rather than making every desktop fail.
 *
 * The admin session this opens is never a watcher (it holds no peer
 * connection), so it cannot inflate its own answer.
 *
 * ── 🔴 KNOWN GAP: `live` counts ANY watcher, not necessarily THIS viewer ─────
 * `watching > 0` means some browser's peer connection is up against this
 * container. If the same user has the same computer open in a second tab and
 * that tab is streaming, this probe answers `live` for a boot whose own peer
 * has not connected yet — a false positive, narrow but real. It is not fixed
 * here, and the reason is a cost/blast-radius judgement rather than an
 * oversight:
 *
 *   - Nothing in the session list distinguishes the tabs. `composeBrowserDesktopUrl`
 *     logs every viewer in as `usr=EZiL`, so `profile.name` is identical
 *     across them and `id` is opaque to us.
 *   - The fix is therefore a per-boot identity in that URL (`usr=EZiL-<nonce>`,
 *     matched here against the `usr` in the caller's own `frameUrl`). That
 *     changes the credential path every production desktop authenticates
 *     through. Neko does not key on the name — `enableImplicitHosting` and this
 *     function already log in under two different ones — but "does not key on
 *     the name" is a belief about the pinned build, and if it is wrong the
 *     failure is not a false positive, it is every desktop failing to connect.
 *   - The other discriminator on offer, `state.watching_since` vs. the moment
 *     the shell navigated, needs the container's clock and ours to agree. They
 *     have no reason to. A skewed container would make every genuine watcher
 *     look like somebody else's, which is the same total failure again.
 *
 * Both need a live container to verify and neither is worth shipping unverified
 * against a defect that requires one user, one computer, two tabs and a race.
 * The nonce is the right fix when someone can run it against a real Neko: add
 * it in `composeBrowserDesktopUrl`, read it from `desktopUrl` here, and — this
 * is the load-bearing half — return `unknown` rather than `blank` when there
 * ARE watchers but none is attributable, so a wrong guess about the shape
 * degrades to `ready_unverified` instead of hiding working desktops.
 *
 * NEVER THROWS. Never logs or returns the credential or the session token.
 */
export async function probeDesktopDisplay(
    desktopUrl: string,
    adminPassword: string,
    timeoutMs: number = DESKTOP_DISPLAY_PROBE_TIMEOUT_MS,
): Promise<DesktopDisplayProbe> {
    let origin: string;
    try {
        const u = new URL(desktopUrl);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') {
            return { display: 'unknown', reason: 'bad_url' };
        }
        origin = u.origin;
    } catch {
        return { display: 'unknown', reason: 'bad_url' };
    }

    const deadline = AbortSignal.timeout(timeoutMs);

    /** Mint a fresh admin session and remember it. `null` = the login failed. */
    const login = async (): Promise<{ token: string } | { status?: number }> => {
        const loginRes = await fetch(`${origin}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            // A distinct username from `enableImplicitHosting`'s so the two
            // server-side sessions are told apart in Neko's own logs. Both
            // authenticate by password; Neko does not key on the name. (A probe
            // that REUSES the control session's token borrows its name too —
            // that is the price of not paying for a second round trip.)
            body: JSON.stringify({ username: 'ezil-os-display', password: adminPassword }),
            cache: 'no-store',
            signal: deadline,
        });
        if (!loginRes.ok) return { status: loginRes.status };
        const body = (await loginRes.json()) as { token?: unknown };
        if (typeof body.token !== 'string' || body.token.length === 0) return {};
        cacheNekoAdminToken(origin, adminPassword, body.token);
        return { token: body.token };
    };

    try {
        // 🔴 The saving, and the only structural change to this function: a
        // token minted by `enableImplicitHosting` moments ago (or by the
        // previous ask of this very gate) turns the probe from two serial round
        // trips into one. Everything below is unchanged, including every path
        // that can produce a verdict.
        let token = cachedNekoAdminToken(origin, adminPassword);
        let reused = token !== null;
        if (token === null) {
            const fresh = await login();
            if (!('token' in fresh)) {
                return { display: 'unknown', reason: 'login_failed', status: fresh.status };
            }
            token = fresh.token;
        }

        let listRes = await fetch(`${origin}/api/sessions`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            cache: 'no-store',
            signal: deadline,
        });

        // The far end stopped honouring a token we were reusing — the container
        // restarted, or Neko did. That is not an observation of the display, so
        // re-mint once and ask again rather than reporting anything about it.
        if (reused && (listRes.status === 401 || listRes.status === 403)) {
            dropNekoAdminToken(origin, token);
            reused = false;
            const fresh = await login();
            if (!('token' in fresh)) {
                return { display: 'unknown', reason: 'login_failed', status: fresh.status };
            }
            token = fresh.token;
            listRes = await fetch(`${origin}/api/sessions`, {
                headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
                cache: 'no-store',
                signal: deadline,
            });
        }

        if (!listRes.ok) return { display: 'unknown', reason: 'http_error', status: listRes.status };

        let body: unknown;
        try {
            body = await listRes.json();
        } catch {
            return { display: 'unknown', reason: 'unrecognised' };
        }
        if (!Array.isArray(body)) return { display: 'unknown', reason: 'unrecognised' };

        let watching = 0;
        for (const entry of body) {
            const state = (entry as { state?: { is_watching?: unknown } } | null)?.state;
            if (typeof state?.is_watching !== 'boolean') {
                // One entry we cannot read makes the whole count untrustworthy:
                // the unreadable one could be the watcher.
                return { display: 'unknown', reason: 'unrecognised' };
            }
            if (state.is_watching) watching++;
        }

        return watching > 0
            ? { display: 'live', sessions: body.length, watching }
            : { display: 'blank', sessions: body.length };
    } catch {
        // Timeout, transport failure, non-JSON login body. None of them is an
        // observation of the user's screen, and none may be dressed up as one.
        return { display: 'unknown', reason: 'unreachable' };
    }
    // 🔴 NO `finally { logout }` ANY MORE, and that is the point. The token
    // belongs to `nekoAdminTokens` now; logging it out here would guarantee the
    // next ask paid for a fresh login, which is the cost this whole section
    // exists to remove. The cache logs out whatever it replaces.
}

// ─── z1: the gate spent most of its time waiting to ASK, not to connect ──────
//
// Measured in production (`y3-open-latency`, 4/4 real warm opens): the display
// gate took a median 5604ms to observe `live`, needing 2-3 client round trips.
// Each round trip is a REAL network hop, Vercel function -> container's Neko
// admin API (~1-2s), and `desktop-window.js` additionally sleeps
// `DISPLAY_POLL_MS` (measured dead-on 1000ms, every time) between asks. So a
// peer that finished connecting one second after the first ask still cost the
// user a second full round trip plus a second of pure client-side waiting to
// find out.
//
// The fix is not a faster probe — `probeDesktopDisplay` above is already one
// round trip with a cached token. It is asking FEWER TIMES, by having THIS
// SIDE do the waiting: hold the request open and re-check internally on a
// short interval, so a peer that connects mid-hold is caught before the
// answer is ever sent, instead of being caught by a client re-ask a second
// (or more) later.
//
// 🔴 ONLY `blank` IS WORTH RE-ASKING. `live` is already the best answer there
// is — return it the instant it is seen. `unknown` means our OWN plumbing
// (login, shape, transport) did not produce a well-formed read; re-hitting
// the exact same broken thing every 300ms will not fix a wrong password or a
// renamed field, so holding for it would only spend the budget for nothing
// and delay an honest `unknown` reaching the client. The pre-existing
// client-side retry loop (`desktop-window.js`'s `ask()`, unchanged) is what
// recovers from a TRANSIENT `unknown` a second later; this function exists
// only to catch a peer that connects WHILE we are already holding a `blank`.
//
// 🔴 THE INVARIANTS ABOVE ARE UNTOUCHED, NOT RE-DERIVED. This function never
// inspects `is_watching` itself and never constructs a verdict — it only
// calls `probeDesktopDisplay` again and again, so every well-formedness rule
// and every `unknown`/`blank` boundary above applies unchanged to each
// attempt. A hold that expires returns whatever `probeDesktopDisplay` most
// recently, honestly answered — never a synthesized "nobody's watching" for
// the mere fact that time ran out.

/**
 * Default hold budget: comfortably under the shell's own
 * `DISPLAY_UNVERIFIED_DEADLINE_MS` (6000ms, `desktop-window.js`) so a typical
 * hold that finds nothing still leaves headroom for network transit and the
 * ownership check before that CLIENT-SIDE timer would fire, and comfortably
 * under the client's own fetch abort (`STATUS_TIMEOUT_MS` = 12000ms,
 * `session.js`) so a full hold is never itself mistaken for a hung request.
 */
export const DISPLAY_LONGPOLL_HOLD_MS = 4_000;

/** How often to re-check `is_watching` while holding a `blank`. */
export const DISPLAY_LONGPOLL_INTERVAL_MS = 300;

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * `probeDesktopDisplay`, held open across a short window instead of asked
 * once and handed straight back.
 *
 * 🔴 `holdMs <= 0` IS THE BOUNDED FALLBACK, NOT A SPECIAL CASE BOLTED ON. It
 * degrades to calling `probeDesktopDisplay` exactly once, with its own
 * default budget — byte-for-byte the pre-long-poll behaviour. That is what an
 * older deployment (or this one, with the feature dialled to 0) falls back
 * to: never a hang, just the single-shot probe this whole gate used to be.
 *
 * 🔴 THE HOLD CAN NEVER RUN LONGER THAN `holdMs` PLUS ONE ATTEMPT'S OWN
 * TRANSIT SLACK. Every attempt's own timeout is clamped to whatever time is
 * left before the deadline (`attemptBudget`), so a hanging final attempt is
 * cut short at the deadline rather than being handed a fresh full budget —
 * the loop cannot be walked past its budget by a slow network the way a
 * naive `while (not done) probe()` could be.
 *
 * @param holdMs total wall-clock budget for this whole call, including any
 *   login. `<= 0` disables holding (see above).
 * @param intervalMs how long to sleep between re-checks while `blank`.
 */
export async function probeDesktopDisplayLongPoll(
    desktopUrl: string,
    adminPassword: string,
    holdMs: number = DISPLAY_LONGPOLL_HOLD_MS,
    intervalMs: number = DISPLAY_LONGPOLL_INTERVAL_MS,
): Promise<DesktopDisplayProbe> {
    if (holdMs <= 0) return probeDesktopDisplay(desktopUrl, adminPassword);

    const deadline = Date.now() + holdMs;
    const attemptBudget = () =>
        Math.max(Math.min(deadline - Date.now(), DESKTOP_DISPLAY_PROBE_TIMEOUT_MS), 1);

    let probe = await probeDesktopDisplay(desktopUrl, adminPassword, attemptBudget());

    while (probe.display === 'blank' && Date.now() < deadline) {
        await sleep(Math.min(intervalMs, Math.max(deadline - Date.now(), 0)));
        if (Date.now() >= deadline) break;
        probe = await probeDesktopDisplay(desktopUrl, adminPassword, attemptBudget());
    }

    return probe;
}

/**
 * May this server fetch `candidateUrl` on behalf of a caller who owns
 * `sandboxId`?
 *
 * This exists because the post-handoff re-confirmation (`confirmFrame` in
 * `routers/cloudflare-guacamole.ts`) is driven by the browser, which has to
 * name the URL its iframe is actually pointed at — and a server that fetches a
 * client-named URL is a server-side request forgery primitive unless something
 * pins the target. Two independent conditions do:
 *
 *  1. The hostname's FIRST label must contain `-<sandboxId>-`. The SDK composes
 *     preview hostnames as `` `${port}-${sandboxId}-${token}.${host}` ``
 *     (`worker/src/index.ts` `normalizeSandboxHostname`), and `sandboxId` comes
 *     from `deriveGuacamoleSandboxId(authenticatedUserId, ownedComputerId)`.
 *     A caller therefore cannot name another user's sandbox, let alone an
 *     unrelated first label. Port and token are NOT hardcoded here on purpose —
 *     they live in `worker/src/desktop-mode.ts` `portFor()` and would be a
 *     drift trap on this side of the wire.
 *  2. The REST of the hostname must be the Worker's own host, or that host with
 *     its first label removed. Those are the only two possibilities the Worker
 *     itself can produce: `normalizeSandboxHostname` passes the request host
 *     through, collapsing any host under `PREVIEW_ZONE_ROOT` to the bare zone
 *     root first. Matched exactly — never as a loose suffix, which would accept
 *     `…-nekodesktop.org` for a Worker on `ezil.org`.
 *
 * Both must hold. `8181-guac-a-b-nekodesktop.evil.com` fails (2);
 * `8181-guac-SOMEONE-ELSE-nekodesktop.ezil.org` fails (1).
 *
 * @param workerHost   hostname of `CLOUDFLARE_GUACAMOLE_WORKER_URL` — server config, never client input
 * @param sandboxId    `deriveGuacamoleSandboxId(userId, computerId)` for the AUTHENTICATED owner
 * @param candidateUrl the URL the browser says its iframe is showing
 */
export function isOwnDesktopOrigin(
    workerHost: string,
    sandboxId: string,
    candidateUrl: string,
): boolean {
    if (!workerHost || !sandboxId) return false;

    let host: string;
    try {
        const u = new URL(candidateUrl);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
        host = u.hostname.toLowerCase();
    } catch {
        return false;
    }

    const dot = host.indexOf('.');
    if (dot <= 0) return false;
    const firstLabel = host.slice(0, dot);
    const rest = host.slice(dot + 1);

    // (1) this caller's own sandbox, as a whole hyphen-delimited run.
    if (!firstLabel.includes(`-${sandboxId.toLowerCase()}-`)) return false;

    // (2) our own Worker's host, or its zone root after the one-label collapse.
    const wh = workerHost.toLowerCase().replace(/:\d+$/, '');
    const whDot = wh.indexOf('.');
    const zoneRoot = whDot > 0 ? wh.slice(whDot + 1) : '';
    // A single-label collapse target (`localhost`) is legitimate; an empty one
    // is not, and a bare TLD is never reachable here because `zoneRoot` is
    // produced by removing exactly one label, never by matching a suffix.
    return rest === wh || (zoneRoot !== '' && rest === zoneRoot);
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
        // 🔴 THE SEED. This runs inside the boot request, seconds before the
        // display gate's first ask hits the same origin with the same derived
        // password — and it used to throw the token away, so that ask paid for
        // a second login. Handing it to the cache is what makes the gate's
        // first question cost one round trip instead of two.
        cacheNekoAdminToken(origin, adminPassword, token);

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
    }
    // 🔴 The logout that used to live here is gone, deliberately. It ran
    // milliseconds before the display gate asked the same origin the same
    // question with the same credential, so its only measurable effect was to
    // make the next login unavoidable. `cacheNekoAdminToken` above owns the
    // token's lifetime now and logs out whatever it replaces; a container that
    // is torn down before the TTL takes its own sessions with it.
}

// ─── The requestable screen modes, and the snap that chooses one ──────────────
//
// The streamed desktop used to be hard-pinned to 1920x1080 (`start-neko.sh`'s
// `NEKO_SCREEN=${NEKO_SCREEN:-1920x1080x24}`), and the shell letterboxed it to
// 16:9 whatever shape the window was. On a 390x844 phone that produced a
// 390x219 strip — about a quarter of the screen, at a 4.9x downscale.
//
// This section is the app-side half of the fix: it turns a MEASUREMENT the
// shell made of its own window into one of a closed list of screen modes, and
// reports back which one, and why. The Worker (`worker/src/screen-modes.ts`)
// re-validates independently and is the only place a mode becomes an
// `NEKO_SCREEN` string.
//
// 🔴 THE TABLE IS DUPLICATED IN THE WORKER, ON PURPOSE. The two are separate
// deploy targets and cannot import each other — the same situation as
// `worker/src/preview-timeouts.ts` and its canonical twin. The Worker's
// `screen-modes.test.ts` reads THIS FILE and fails if the two lists differ, so
// the copies cannot drift silently. This copy is the canonical one: snapping
// (and therefore the `source` the shell is told) happens here.

/** One entry of the closed mode table. */
export interface ScreenMode {
    width: number;
    height: number;
}

/** Where a served screen size came from, as reported to the shell. */
export type ScreenModeSource =
    /** The shell's ask was already a table entry and was honoured verbatim. */
    | 'requested'
    /** A different table entry was chosen — nearest by aspect, then by area. */
    | 'snapped'
    /** Nothing was asked, or the ask was rejected. 1920x1080. */
    | 'default';

/** The resolved answer: what will be applied, and why. */
export interface ResolvedScreen extends ScreenMode {
    source: ScreenModeSource;
}

/** The default, the fallback, and the largest mode there is. */
export const DEFAULT_SCREEN_MODE: ScreenMode = { width: 1920, height: 1080 };

/** No mode may exceed this many pixels — see `docs/PLATFORM-NOTES.md` §23. */
export const SCREEN_PIXEL_CEILING = 1920 * 1080;

/**
 * Sanity bounds on a REQUEST (not on a mode). Anything outside is rejected
 * rather than snapped: it is not a plausible measurement of a window, and
 * snapping it would invent a screen nobody asked for.
 */
export const MIN_REQUESTED_AXIS = 64;
export const MAX_REQUESTED_AXIS = 16384;

/**
 * How close two aspect ratios have to be (in log space, so ~1%) to count as
 * THE SAME aspect class, inside which area decides.
 *
 * 🔴 NOT a rounding fudge — it is what the platform's own quantisation forces.
 * The three 16:9 entries are bit-identical in ratio, but the portrait
 * "9:16 cheaper" mode is `896x1600` (0.5600) rather than `900x1600` (0.5625)
 * because Xvfb floors screen widths to a multiple of 8. Without a tolerance
 * that 0.4% difference would make `896x1600` its own aspect class and win
 * every phone request on aspect alone — so a phone would get 1,433,600 pixels
 * where the area rule says it should get either 921,600 or 2,073,600. The
 * nearest DISTINCT pair of classes in this table is 4:3 vs 5:4, 0.065 apart in
 * log space, so 0.01 cannot merge two classes that were meant to be different.
 */
const ASPECT_CLASS_TOLERANCE = 0.01;

/**
 * Xvfb rounds the screen WIDTH down to a multiple of this and reports success.
 *
 * 🔴 MEASURED against a real container, not assumed: `900x1600` produces a
 * display that is actually `896x1600`, and `902x902` produces `896x902`.
 * Height is NOT quantised (`1080x1918` applies exactly). This is why the
 * table's phone-portrait-cheaper entry reads `896x1600` rather than the
 * contract's original `900x1600` — that was the one entry the platform could
 * not deliver, and it would have shipped as a size we told the client we had
 * applied and had not.
 */
export const SCREEN_WIDTH_ALIGNMENT = 8;

/**
 * Fixed text — exactly the modes the container's X server can actually be set
 * to. Order matters only as the final, deterministic tie-break in
 * `snapScreenMode`.
 *
 * Every width and height is EVEN (vp8 encoding of an odd dimension is a known
 * source of chroma artefacts) and every WIDTH is a multiple of
 * `SCREEN_WIDTH_ALIGNMENT` (see above).
 */
export const SCREEN_MODES: readonly ScreenMode[] = [
    { width: 1920, height: 1080 }, // 16:9  landscape — default; desktop
    { width: 1600, height: 900 }, //  16:9  landscape — smaller desktop window
    { width: 1280, height: 720 }, //  16:9  landscape — low-bandwidth / small window
    { width: 1440, height: 900 }, //  16:10 landscape — laptop
    { width: 1280, height: 800 }, //  16:10 landscape — laptop
    { width: 1024, height: 768 }, //  4:3   landscape — tablet landscape
    { width: 1280, height: 1024 }, // 5:4   landscape — legacy monitor
    { width: 1200, height: 1600 }, // 3:4   portrait  — tablet portrait
    { width: 1080, height: 1920 }, // 9:16  portrait  — phone portrait
    { width: 896, height: 1600 }, //  9:16  portrait  — phone portrait, cheaper (896, not 900 — see SCREEN_WIDTH_ALIGNMENT)
    { width: 720, height: 1280 }, //  9:16  portrait  — phone portrait, cheapest
    { width: 768, height: 1024 }, // 3:4   portrait  — tablet portrait, cheaper
];

/** Is this pair one of the modes above, exactly? */
export function isScreenMode(width: unknown, height: unknown): boolean {
    return SCREEN_MODES.some((m) => m.width === width && m.height === height);
}

function isPlainAxis(value: unknown): value is number {
    return (
        typeof value === 'number' &&
        Number.isInteger(value) &&
        value >= MIN_REQUESTED_AXIS &&
        value <= MAX_REQUESTED_AXIS
    );
}

/**
 * Read a `screen` value off an untrusted request body.
 *
 * Returns `null` — never a coerced guess — for anything that is not an object
 * carrying two PLAIN INTEGERS in range. `"1080"`, `1080.5`, `NaN`, `Infinity`,
 * `-1080` and `1e9` are all `null`, and `null` means "behave exactly as before
 * this field existed".
 */
export function parseRequestedScreen(raw: unknown): ScreenMode | null {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const { width, height } = raw as { width?: unknown; height?: unknown };
    if (!isPlainAxis(width) || !isPlainAxis(height)) return null;
    return { width, height };
}

/**
 * Choose the table entry nearest to a request: **by aspect ratio first, then by
 * area**, exactly as the contract states.
 *
 * 🔴 Aspect distance is measured on the LOG of the ratio, not on the ratio
 * itself. `|a - b|` is not scale-symmetric: 16:9 (1.778) and 5:4 (1.25) are
 * 0.53 apart while their portrait mirrors 9:16 (0.5625) and 4:5 (0.8) are only
 * 0.24 apart, so a plain difference silently gives portrait asks less
 * discrimination than their landscape mirrors. `|ln a − ln b|` gives both the
 * same.
 *
 * "Then by area" means NEAREST area to the request, not largest: a phone asking
 * for 1170x2532 wants a 9:16 screen it can actually afford, and the table
 * offers three. Preferring the largest would put every phone at the
 * 2,073,600-pixel ceiling.
 *
 * Ties inside an aspect class are broken by table order, so the answer is a
 * pure function of its inputs and does not depend on sort stability.
 */
export function snapScreenMode(
    width: number,
    height: number,
): ScreenMode & { source: 'requested' | 'snapped' } {
    if (isScreenMode(width, height)) return { width, height, source: 'requested' };

    const askAspect = Math.log(width / height);
    const askArea = width * height;

    let best: ScreenMode = SCREEN_MODES[0] ?? DEFAULT_SCREEN_MODE;
    let bestAspect = Number.POSITIVE_INFINITY;
    let bestArea = Number.POSITIVE_INFINITY;

    for (const mode of SCREEN_MODES) {
        const aspect = Math.abs(Math.log(mode.width / mode.height) - askAspect);
        const area = Math.abs(mode.width * mode.height - askArea);
        // `ASPECT_CLASS_TOLERANCE` groups the three 16:9 entries (and the three
        // 9:16, and the two 3:4) as EQUAL — see its own comment for why an
        // exact comparison is not enough once the platform's 8-pixel width
        // quantisation is in the table. Inside a class, area decides.
        if (aspect < bestAspect - ASPECT_CLASS_TOLERANCE) {
            best = mode;
            bestAspect = aspect;
            bestArea = area;
        } else if (aspect <= bestAspect + ASPECT_CLASS_TOLERANCE && area < bestArea) {
            best = mode;
            bestAspect = Math.min(bestAspect, aspect);
            bestArea = area;
        }
    }

    return { width: best.width, height: best.height, source: 'snapped' };
}

/**
 * The whole server-side rule, in one place: untrusted value in, applied screen
 * out. A rejected or absent ask is `default` at 1920x1080 — which is also what
 * the container boots at when no `NEKO_SCREEN` is injected, so `default` and
 * "this field did not exist" are byte-for-byte the same container.
 */
export function resolveScreenRequest(raw: unknown): ResolvedScreen {
    const parsed = parseRequestedScreen(raw);
    if (!parsed) return { ...DEFAULT_SCREEN_MODE, source: 'default' };
    return snapScreenMode(parsed.width, parsed.height);
}

// ─── Live resize (POST /sandbox/:name/screen) ─────────────────────────────────

/** Closed error set for a live-resize attempt. Fixed text; the shell renders these. */
export type ScreenErrorCode = 'BAD_REQUEST' | 'NOT_FOUND' | 'UNSUPPORTED' | 'UPSTREAM' | 'TIMEOUT';

export type GuacamoleScreenResult =
    | {
          ok: true;
          /**
           * What the X display ACTUALLY is, read back after the set — not what
           * was asked for. See `requestGuacamoleScreen`'s doc comment.
           */
          width: number;
          height: number;
          /** False when the read-back did not answer, so `width`/`height` are the ASK. */
          verified: boolean;
      }
    | { ok: false; code: ScreenErrorCode; message: string };

/**
 * Ask a LIVE container to change its X screen mode.
 *
 * Signed with the same HMAC envelope as `requestGuacamoleFocusApp` above, and
 * for the same reason: this is a control-plane call to a container the caller
 * has already been proven to own.
 *
 * 🔴 NEVER THROWS, and never reports a success it did not observe. Every
 * failure comes back as one of the five closed codes so the shell can decide
 * between "stop asking and letterbox forever" (`UNSUPPORTED`) and "this one
 * attempt failed" (everything else) without parsing prose.
 *
 * 🔴 THE SIZE THAT COMES BACK IS A READ-BACK, NOT AN ECHO. Measured against a
 * real container: neko's own `POST /api/room/screen` answers 200 and echoes
 * the REQUEST — asking for `900x1600` returns `{"width":900,"height":1600}`
 * while the display is actually `896x1600`. The Worker therefore re-reads
 * `GET /api/room/screen` after every set and reports THAT; `verified: false`
 * means the read-back did not answer and the numbers are only the ask. The
 * caller must not claim `source: 'requested'` on an unverified answer.
 *
 * `UNSUPPORTED` is not a condition to retry: it is what a container answers for
 * a size outside the framebuffer it started with (measured: HTTP 422, display
 * unchanged), and no number of retries grows a framebuffer.
 */
export async function requestGuacamoleScreen(
    config: CloudflareGuacamoleConfig,
    hmacSecret: string,
    sandboxName: string,
    width: number,
    height: number,
    correlationId: string = newCorrelationId(),
): Promise<GuacamoleScreenResult> {
    if (!config.isConfigured) {
        return { ok: false, code: 'NOT_FOUND', message: 'provider_not_configured' };
    }
    // Belt and braces with the procedure's own zod check: this helper is
    // exported and directly callable, and the value it is about to put on the
    // wire ends up next to an X server.
    if (!isScreenMode(width, height)) {
        return { ok: false, code: 'BAD_REQUEST', message: 'not_a_screen_mode' };
    }

    const token = mintSandboxPreviewToken(hmacSecret);
    const endpoint = `${config.workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxName)}/screen`;

    try {
        const res = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
                [CORRELATION_HEADER]: correlationId,
            },
            body: JSON.stringify({ width, height }),
            // A mode set is a capture-pipeline restart inside the container.
            // Its real cost is UNMEASURED (no container run was available);
            // 20s is above the 15s the sibling control routes use and still
            // far below any route budget.
            signal: AbortSignal.timeout(20_000),
        });

        // Same parse-either-way rule as `requestGuacamoleFocusApp`: the Worker
        // answers a refused resize as a non-2xx WITH a JSON body carrying the
        // reason.
        const text = await res.text().catch(() => '');
        let data: { ok?: unknown; error?: unknown; detail?: unknown; width?: unknown; height?: unknown; verified?: unknown } = {};
        try {
            data = text ? (JSON.parse(text) as typeof data) : {};
        } catch {
            // Non-JSON (an edge error page). The raw text still reaches the log.
        }

        if (res.ok && data.ok === true) {
            // Strict: a success that names no size is a success we cannot act
            // on, and inventing the ask back would be exactly the echo this
            // whole read-back exists to avoid.
            const observed =
                Number.isInteger(data.width) && Number.isInteger(data.height)
                    ? { width: data.width as number, height: data.height as number }
                    : null;
            if (!observed) {
                return { ok: false, code: 'UPSTREAM', message: 'worker confirmed a size it did not name' };
            }
            return { ok: true, ...observed, verified: data.verified === true };
        }

        const workerError = typeof data.error === 'string' ? data.error : '';
        // 🔴 The Worker sends `detail` alongside `error` and this used to read
        // only `error`, so the exception message never left the Worker. Measured
        // in production 2026-08-19: 20 of 20 live resizes failed with
        // `screen_upstream_exception` — the catch branch at
        // `worker/src/index.ts`, i.e. something THREW inside the handler — and
        // the message naming what threw was discarded here. `error` alone tells
        // you an exception happened; `detail` is the only field that says which.
        const workerDetail = typeof data.detail === 'string' ? data.detail : '';
        console.warn('[cloudflare-guacamole] screen request rejected', {
            sandboxName,
            width,
            height,
            status: res.status,
            body: text.slice(0, 300),
        });
        return {
            ok: false,
            code: classifyScreenFailure(res.status, workerError),
            // Both, joined — the code is the closed set the client branches on,
            // the detail is the only thing that makes one `UPSTREAM` row
            // distinguishable from another in telemetry.
            message: [workerError || `worker_http_${res.status}`, workerDetail]
                .filter(Boolean)
                .join(': ')
                .slice(0, 200),
        };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        console.warn('[cloudflare-guacamole] screen request failed (non-fatal):', {
            sandboxName,
            width,
            height,
            error: message,
        });
        return { ok: false, code: timedOut ? 'TIMEOUT' : 'UPSTREAM', message };
    }
}

// ─── Reading the desktop's real size back (GET /api/room/screen) ─────────────

/** Budget for the boot-time screen read-back. It is on the desktop-open critical path. */
export const SCREEN_READBACK_TIMEOUT_MS = 3_000;

/**
 * What the container's X display ACTUALLY is, asked of neko itself.
 *
 * ── Why this exists rather than trusting `NEKO_SCREEN` ──────────────────────
 * The boot env is a REQUEST. What the X server did with it is a separate fact,
 * and they are measurably not always the same: Xvfb floors the screen width to
 * a multiple of 8 and reports success, so `900x1600` becomes `896x1600` with
 * nothing in the response saying so. Every mode in `SCREEN_MODES` is
 * 8-aligned precisely so that cannot happen — but "cannot happen because of an
 * argument" is exactly the kind of claim this repo has been burned by, and one
 * cheap GET turns it into an observation.
 *
 * ── Why it uses the CACHED admin token ──────────────────────────────────────
 * `enableImplicitHosting` logs into this same origin, with this same derived
 * password, milliseconds earlier in the same request, and hands the token to
 * `nekoAdminTokens`. So on the boot path this is ONE small GET, not a login
 * plus a GET. Minting is still available for a cold instance, and a 401 on a
 * reused token drops it and re-mints once — the same shape
 * `probeDesktopDisplay` already uses.
 *
 * NEVER THROWS. Returns null for anything that is not a well-formed answer: a
 * non-2xx, a non-JSON body, or one whose `width`/`height` are not plain
 * integers. Null means "we do not know", never a guess — the caller reports
 * `source: 'default'`/`'snapped'` rather than claiming a size it never saw.
 */
export async function readDesktopScreen(
    desktopUrl: string,
    adminPassword: string,
    timeoutMs: number = SCREEN_READBACK_TIMEOUT_MS,
): Promise<{ width: number; height: number } | null> {
    let origin: string;
    try {
        const u = new URL(desktopUrl);
        if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
        origin = u.origin;
    } catch {
        return null;
    }

    const deadline = AbortSignal.timeout(timeoutMs);

    const login = async (): Promise<string | null> => {
        const res = await fetch(`${origin}/api/login`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: 'ezil-os-screen', password: adminPassword }),
            cache: 'no-store',
            signal: deadline,
        });
        if (!res.ok) return null;
        const body = (await res.json()) as { token?: unknown };
        if (typeof body.token !== 'string' || body.token.length === 0) return null;
        cacheNekoAdminToken(origin, adminPassword, body.token);
        return body.token;
    };

    const ask = async (token: string) =>
        fetch(`${origin}/api/room/screen`, {
            headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
            cache: 'no-store',
            signal: deadline,
        });

    try {
        let token = cachedNekoAdminToken(origin, adminPassword);
        const reused = token !== null;
        if (token === null) {
            token = await login();
            if (token === null) return null;
        }

        let res = await ask(token);
        if (reused && (res.status === 401 || res.status === 403)) {
            dropNekoAdminToken(origin, token);
            const fresh = await login();
            if (fresh === null) return null;
            token = fresh;
            res = await ask(token);
        }
        if (!res.ok) return null;

        const body = (await res.json()) as { width?: unknown; height?: unknown };
        if (!Number.isInteger(body.width) || !Number.isInteger(body.height)) return null;
        const width = body.width as number;
        const height = body.height as number;
        if (width <= 0 || height <= 0) return null;
        return { width, height };
    } catch {
        // Timeout, transport failure, non-JSON body. None is an observation of
        // the screen, and none may be dressed up as one.
        return null;
    }
}

/**
 * Turn an OBSERVED screen into the `source` the shell is told, given what the
 * shell originally asked for.
 *
 * 🔴 `requested` is a claim about the CLIENT's ask matching REALITY, not about
 * the server having accepted it. So it is only ever produced from an
 * observation: an unverified size is `snapped` at best, because "we set it and
 * were not able to check" is not the same statement as "you got what you asked
 * for".
 */
export function describeAppliedScreen(
    requested: ScreenMode | null,
    observed: ScreenMode,
): ResolvedScreen {
    const matches =
        requested !== null && requested.width === observed.width && requested.height === observed.height;
    return { width: observed.width, height: observed.height, source: matches ? 'requested' : 'snapped' };
}

/**
 * Map the Worker's answer onto the closed code set.
 *
 * The Worker's own `error` string is read BEFORE the HTTP status, because only
 * the Worker can tell "the X server has no such mode" (`UNSUPPORTED`) from
 * "neko refused for some other reason" (`UPSTREAM`) — both of which arrive
 * here as the same 502.
 */
export function classifyScreenFailure(status: number, workerError: string): ScreenErrorCode {
    const e = workerError.toLowerCase();
    if (e.startsWith('screen_unsupported')) return 'UNSUPPORTED';
    if (e.startsWith('screen_timeout')) return 'TIMEOUT';
    if (e.startsWith('screen_bad_request') || e === 'invalid_json_body') return 'BAD_REQUEST';
    if (e === 'screen_disabled' || e.startsWith('sandbox_not_found')) return 'NOT_FOUND';
    if (status === 400) return 'BAD_REQUEST';
    if (status === 401 || status === 403 || status === 404) return 'NOT_FOUND';
    if (status === 408 || status === 504) return 'TIMEOUT';
    return 'UPSTREAM';
}
