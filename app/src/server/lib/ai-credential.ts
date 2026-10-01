import { createHash, createHmac } from 'node:crypto';

import type { CloudflareGuacamoleConfig } from './cloudflare-guacamole-provider';

/**
 * EZiL AI credential push: the server half of the Worker's `/ai/v1/*` proxy
 * (`worker/src/ai-proxy.ts`, `docs/AI-GATEWAY.md`).
 *
 * The chat extension in a computer calls `ai.ezil.work` through the Worker,
 * which forwards with the signed-in user's Supabase **access** token. This
 * module delivers that token to the computer's Durable Object over
 * `POST /sandbox/:name/ai-credential`, on desktop start (`previewUrl`) and on
 * every activity beat (`reportActivity`), so the Worker always holds a token
 * that is at most one beat old.
 *
 * 🔴 Only the access token leaves this server. The refresh token never does:
 * Supabase rotates refresh tokens, and a second refresher (the Worker) would
 * trip reuse detection and sign the user out of the OS.
 *
 * 🔴 Never throws and never logs the token: a failed push only means the next
 * AI call in that computer answers "session missing" until the next beat.
 */

/** Refresh the cookie session first when it has less than this left, so the pushed token outlives the next beat. */
export const AI_CREDENTIAL_REFRESH_BEFORE_MS = 5 * 60_000;

/** `t=<ms>,v1=<hex>` over `${ts}.POST./sandbox/<id>/ai-credential.<sha256(body)>`, matching the Worker. */
export function mintAiCredentialSignature(secret: string, sandboxName: string, body: string, now: number = Date.now()): string {
    const bodyHash = createHash('sha256').update(body, 'utf8').digest('hex');
    const payload = `${now}.POST./sandbox/${sandboxName}/ai-credential.${bodyHash}`;
    return `t=${now},v1=${createHmac('sha256', secret).update(payload).digest('hex')}`;
}

export interface AccessTokenClaims {
    sub: string;
    /** Milliseconds. */
    expiresAt: number;
    ezilRole: string | null;
}

/**
 * Read (not verify) an access token's claims. Used only to decide whether a
 * push is worth sending — identity always comes from `supabase.auth.getUser`,
 * and the gateway verifies the token itself on every call.
 */
export function readAccessTokenClaims(token: string): AccessTokenClaims | null {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    try {
        const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
        if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') return null;
        const appMetadata = claims.app_metadata as Record<string, unknown> | undefined;
        const role = appMetadata?.ezil_role;
        return { sub: claims.sub, expiresAt: claims.exp * 1000, ezilRole: typeof role === 'string' ? role : null };
    } catch {
        return null;
    }
}

/** The subset of a Supabase server client this module uses (injectable for tests). */
export interface SessionSource {
    auth: {
        getSession(): Promise<{ data: { session: { access_token: string } | null } }>;
        refreshSession(): Promise<{ data: { session: { access_token: string } | null }; error: unknown }>;
    };
}

/**
 * The cookie session's access token for `userId` (already authenticated by
 * `getUser()` upstream), refreshed first when it is close to expiry. `null`
 * when the caller authenticated with a bearer (SDK/MCP clients run no
 * desktop), when there is no session, or when it belongs to someone else.
 */
export async function currentAccessToken(
    userId: string,
    headers: Headers,
    supabase: SessionSource,
    now: number = Date.now(),
): Promise<string | null> {
    if (headers.get('authorization') !== null) return null;
    let token = (await supabase.auth.getSession()).data.session?.access_token ?? null;
    if (token === null) return null;
    let claims = readAccessTokenClaims(token);
    if (claims === null || claims.sub !== userId) return null;
    if (claims.expiresAt - now < AI_CREDENTIAL_REFRESH_BEFORE_MS) {
        const refreshed = await supabase.auth.refreshSession();
        const next = refreshed.error ? null : (refreshed.data.session?.access_token ?? null);
        if (next === null) return claims.expiresAt > now ? token : null;
        token = next;
        claims = readAccessTokenClaims(token);
        if (claims === null || claims.sub !== userId) return null;
    }
    return token;
}

export type AiCredentialPushResult =
    | { ok: true; stored: boolean }
    | { ok: false; skipped?: 'no_session' | 'no_ezil_role' | 'not_configured'; error?: string };

/**
 * Push `accessToken` to the Worker for `sandboxName`. Skipped (no request) when
 * the provider is unconfigured, there is no HMAC secret (the Worker refuses
 * unsigned pushes), or the token has no `app_metadata.ezil_role` (the gateway
 * would refuse it with 401 `no_ezil_role`).
 */
export async function pushAiCredential(
    config: CloudflareGuacamoleConfig,
    hmacSecret: string,
    sandboxName: string,
    accessToken: string | null,
    fetchImpl: typeof fetch = fetch,
): Promise<AiCredentialPushResult> {
    if (!config.isConfigured || !hmacSecret) return { ok: false, skipped: 'not_configured' };
    if (accessToken === null) return { ok: false, skipped: 'no_session' };
    if (readAccessTokenClaims(accessToken)?.ezilRole == null) return { ok: false, skipped: 'no_ezil_role' };

    const body = JSON.stringify({ accessToken });
    const endpoint = `${config.workerUrl.replace(/\/$/, '')}/sandbox/${encodeURIComponent(sandboxName)}/ai-credential`;
    try {
        const res = await fetchImpl(endpoint, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-ezil-signature': mintAiCredentialSignature(hmacSecret, sandboxName, body),
            },
            body,
            // A Durable Object storage write; short, because desktop start awaits it.
            signal: AbortSignal.timeout(5_000),
        });
        const text = await res.text().catch(() => '');
        let data: { ok?: unknown; stored?: unknown; error?: unknown } = {};
        try {
            data = text ? (JSON.parse(text) as typeof data) : {};
        } catch {
            // An edge error page; only its status is reported.
        }
        if (!res.ok || data.ok !== true) {
            // `ai_proxy_disabled` (404) is an operator's choice, not a failure worth a warning.
            const error = typeof data.error === 'string' ? data.error : `worker_http_${res.status}`;
            if (error !== 'ai_proxy_disabled') {
                console.warn('[ai-credential] push rejected', { sandboxName, status: res.status, error });
            }
            return { ok: false, error };
        }
        return { ok: true, stored: data.stored === true };
    } catch (err) {
        const error = err instanceof Error ? err.name : 'unknown';
        console.warn('[ai-credential] push failed (non-fatal)', { sandboxName, error });
        return { ok: false, error };
    }
}

/**
 * `currentAccessToken` + `pushAiCredential`, for the router. Never throws.
 */
export async function syncAiCredential(params: {
    config: CloudflareGuacamoleConfig;
    hmacSecret: string;
    sandboxName: string;
    userId: string;
    headers: Headers;
    supabase: () => Promise<SessionSource>;
    fetchImpl?: typeof fetch;
}): Promise<AiCredentialPushResult> {
    try {
        if (!params.config.isConfigured || !params.hmacSecret) return { ok: false, skipped: 'not_configured' };
        const token = await currentAccessToken(params.userId, params.headers, await params.supabase());
        return await pushAiCredential(params.config, params.hmacSecret, params.sandboxName, token, params.fetchImpl);
    } catch (err) {
        console.warn('[ai-credential] sync failed (non-fatal)', {
            sandboxName: params.sandboxName,
            error: err instanceof Error ? err.name : 'unknown',
        });
        return { ok: false, error: 'sync_failed' };
    }
}
