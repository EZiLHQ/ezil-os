import { db } from '@/server/db';
import { AUTH0_ISSUER } from '@/server/auth/issuer';
import { authenticateBrowserDelegation, authenticateBrowserPageDelegation, authenticateBrowserControlDelegation, delegationConfig } from '@/server/api/delegation-auth';
import { consumeDelegationJti, findDelegatedAccount } from '@/server/api/delegation-store';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from '@/server/lib/compute/preview-token-v2';
import { BROWSER_CONTROL_PROCEDURE, BROWSER_PAGE_PROCEDURE, BROWSER_STAGING_MCP, BROWSER_STAGING_OS, BROWSER_STAGING_WORKER, BROWSER_UI_RESULT_MAX_BYTES } from '@/server/browser-observe/contract';
import { handleBrowserObserve, readSmallBody } from '@/server/browser-observe/receiver';
import {
    awsBrowserTargetAdmitted, browserTargetClaims, resolveAwsBrowserTarget, resolveCloudflareBrowserTarget,
    type AwsBrowserTarget, type CloudflareBrowserTarget,
} from '@/server/browser-observe/target';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
    const secret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    const stagingConfigured = process.env.EZIL_DELEGATION_ISSUER === BROWSER_STAGING_MCP
            && process.env.EZIL_DELEGATION_AUDIENCE === BROWSER_STAGING_OS
            && process.env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.replace(/\/$/, '') === BROWSER_STAGING_WORKER
            && Boolean(secret);
    return handleBrowserObserve<CloudflareBrowserTarget | AwsBrowserTarget>(request, {
        enabled: stagingConfigured && process.env.EZIL_DELEGATED_BROWSER_OBSERVE === 'enabled',
        controlEnabled: stagingConfigured && process.env.EZIL_DELEGATED_BROWSER_CONTROL === 'enabled',
        now: Date.now,
        async verify(headers, serializedInput, procedure) {
            const config = await delegationConfig({
                EZIL_DELEGATION_ISSUER: process.env.EZIL_DELEGATION_ISSUER,
                EZIL_DELEGATION_AUDIENCE: process.env.EZIL_DELEGATION_AUDIENCE,
                EZIL_DELEGATION_PUBLIC_JWKS: process.env.EZIL_DELEGATION_PUBLIC_JWKS,
                EZIL_DELEGATION_CLIENT_IDS: process.env.EZIL_DELEGATION_CLIENT_IDS,
                NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
            }, AUTH0_ISSUER);
            const authenticate = procedure === BROWSER_CONTROL_PROCEDURE
                ? authenticateBrowserControlDelegation
                : procedure === BROWSER_PAGE_PROCEDURE ? authenticateBrowserPageDelegation : authenticateBrowserDelegation;
            const result = await authenticate(headers, {
                enabled: true, config, binding: { procedure, input: serializedInput },
                now: () => Math.floor(Date.now() / 1000),
                consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
                findAccount: identity => findDelegatedAccount(db, identity),
            });
            if (result.kind !== 'accepted') return null;
            const { userId, clientId } = result.call;
            return { userId, clientId };
        },
        // Only an explicitly admitted AWS computer takes the AWS leg; every other computer keeps the Cloudflare one.
        target: (principal, computerId) => awsBrowserTargetAdmitted(process.env.EZIL_DELEGATED_BROWSER_OBSERVE_AWS_TARGETS, computerId)
            ? resolveAwsBrowserTarget(principal, computerId, 'ezil-browser-observe-v1')
            : resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1'),
        async observe({ userId }, computerId, target, input) {
            const endpoint = new URL('/sandbox/' + target.sandboxId + '/browser-observe', BROWSER_STAGING_WORKER);
            const body = JSON.stringify({ binding: target.binding, ...input });
            const signature = mintPreviewTokenV2(secret!, {
                ts: Date.now(), sandboxId: target.sandboxId, computerId, userId, ...browserTargetClaims(target),
            }, { method: 'POST', path: endpoint.pathname, body });
            const response = await fetch(endpoint, {
                method: 'POST', body, signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store',
                headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: signature },
            });
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                return { ok: false, error: "browser_unavailable" };
            }
            return JSON.parse(await readSmallBody(response, 'action' in input ? BROWSER_UI_RESULT_MAX_BYTES : 2048)) as unknown;
        },
    });
}
