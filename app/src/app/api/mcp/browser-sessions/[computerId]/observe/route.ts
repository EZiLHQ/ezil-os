import { db } from '@/server/db';
import { AUTH0_ISSUER } from '@/server/auth/issuer';
import { authenticateBrowserDelegation, delegationConfig } from '@/server/api/delegation-auth';
import { consumeDelegationJti, findDelegatedAccount } from '@/server/api/delegation-store';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from '@/server/lib/compute/preview-token-v2';
import { BROWSER_STAGING_MCP, BROWSER_STAGING_OS, BROWSER_STAGING_WORKER } from '@/server/browser-observe/contract';
import { handleBrowserObserve, readSmallBody } from '@/server/browser-observe/receiver';
import { resolveCloudflareBrowserTarget } from '@/server/browser-observe/target';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
    const secret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    return handleBrowserObserve(request, {
        enabled: process.env.EZIL_DELEGATED_BROWSER_OBSERVE === 'enabled'
            && process.env.EZIL_DELEGATION_ISSUER === BROWSER_STAGING_MCP
            && process.env.EZIL_DELEGATION_AUDIENCE === BROWSER_STAGING_OS
            && process.env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.replace(/\/$/, '') === BROWSER_STAGING_WORKER
            && Boolean(secret),
        now: Date.now,
        async verify(headers, serializedInput, procedure) {
            const config = await delegationConfig({
                EZIL_DELEGATION_ISSUER: process.env.EZIL_DELEGATION_ISSUER,
                EZIL_DELEGATION_AUDIENCE: process.env.EZIL_DELEGATION_AUDIENCE,
                EZIL_DELEGATION_PUBLIC_JWKS: process.env.EZIL_DELEGATION_PUBLIC_JWKS,
                EZIL_DELEGATION_CLIENT_IDS: process.env.EZIL_DELEGATION_CLIENT_IDS,
                NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
            }, AUTH0_ISSUER);
            const result = await authenticateBrowserDelegation(headers, {
                enabled: true, config, binding: { procedure, input: serializedInput },
                now: () => Math.floor(Date.now() / 1000),
                consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
                findAccount: identity => findDelegatedAccount(db, identity),
            });
            if (result.kind !== 'accepted') return null;
            const { userId, clientId } = result.call;
            return { userId, clientId };
        },
        target: (principal, computerId) => resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1'),
        async observe({ userId }, computerId, target, input) {
            const endpoint = new URL('/sandbox/' + target.sandboxId + '/browser-observe', BROWSER_STAGING_WORKER);
            const body = JSON.stringify({ binding: target.binding, ...input });
            const signature = mintPreviewTokenV2(secret!, {
                ts: Date.now(), sandboxId: target.sandboxId, computerId, userId,
                provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0,
            }, { method: 'POST', path: endpoint.pathname, body });
            const response = await fetch(endpoint, {
                method: 'POST', body, signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store',
                headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: signature },
            });
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                return { ok: false, error: "browser_unavailable" };
            }
            return JSON.parse(await readSmallBody(response, 2048)) as unknown;
        },
    });
}
