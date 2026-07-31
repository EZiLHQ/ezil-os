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
 */
export type GuacamolePreviewErrorCode =
    | 'connection_refused'
    | 'fetch_failed'
    | 'sandbox_runtime_blocked'
    | 'sandbox_start_failed'
    | 'worker_http_error'
    | 'timeout'
    | 'unknown';

export interface GuacamolePreviewError {
    ok: false;
    error: string;
    errorCode?: GuacamolePreviewErrorCode;
}

export type GuacamolePreviewResult = GuacamolePreviewSuccess | GuacamolePreviewError;

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
        return {
            ok: false,
            error: 'cloudflare_guacamole_not_configured: set CLOUDFLARE_GUACAMOLE_WORKER_URL',
        };
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
            const errorCode: GuacamolePreviewErrorCode = /setsockoptint/i.test(text)
                ? 'sandbox_runtime_blocked'
                : 'worker_http_error';
            return { ok: false, error: `worker_http_${res.status}: ${text.slice(0, 300)}`, errorCode };
        }

        const data = (await res.json()) as GuacamolePreviewResult;
        if (!data.ok) {
            const errMsg = (data as GuacamolePreviewError).error ?? '';
            const existing = (data as GuacamolePreviewError).errorCode;
            let errorCode: GuacamolePreviewErrorCode = existing ?? 'unknown';
            if (!existing) {
                if (/setsockoptint/i.test(errMsg)) {
                    errorCode = 'sandbox_runtime_blocked';
                } else if (/sandbox.*start|container.*start/i.test(errMsg)) {
                    errorCode = 'sandbox_start_failed';
                }
            }
            return { ok: false, error: errMsg, errorCode };
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

        return { ok: false, error: msg, errorCode };
    }
}

/** Request termination of a named sandbox. Non-blocking: errors are logged, not thrown. */
export async function requestGuacamoleSandboxTerminate(
    config: CloudflareGuacamoleConfig,
    sandboxName: string,
    correlationId: string = newCorrelationId(),
): Promise<void> {
    if (!config.isConfigured) return;
    try {
        await fetch(`${config.workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxName)}`, {
            method: 'DELETE',
            headers: { [CORRELATION_HEADER]: correlationId },
            signal: AbortSignal.timeout(10_000),
        });
    } catch (err) {
        console.warn('[cloudflare-guacamole] terminate request failed (non-fatal):', {
            sandboxName,
            error: err instanceof Error ? err.message : String(err),
        });
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
    const payload = `ezil-neko:user:${sandboxId}:v1`;
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
 */
export function composeBrowserDesktopUrl(rawUrl: string, hmacSecret: string, sandboxId: string): string {
    const url = new URL(rawUrl);
    const pwd = hmacSecret ? deriveNekoRegularUserValue(hmacSecret, sandboxId) : 'neko';
    url.searchParams.set('usr', 'EZiL');
    url.searchParams.set('pwd', pwd);
    url.searchParams.set('embed', '1');
    return url.toString();
}
