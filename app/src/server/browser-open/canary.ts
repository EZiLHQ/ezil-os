import { AUTH0_ISSUER } from '@/server/auth/issuer';
import { delegationConfig, verifyDelegation } from '@/server/api/delegation-core';
import { consumeDelegationJti, findDelegatedAccount } from '@/server/api/delegation-store';
import { db } from '@/server/db';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from '@/server/lib/compute/preview-token-v2';
import { readSmallBody } from './body';
import {
    BROWSER_CAPABILITIES_BODY, BROWSER_CAPABILITIES_PROCEDURE, BROWSER_CAPABILITIES_SCOPE,
    BROWSER_OPEN_PROCEDURE, BROWSER_OPEN_SCOPE, parseBrowserTestUrl,
} from './contract';
import type { BrowserOpenRequest } from './contract';
import type { BrowserPrincipal, BrowserTarget } from './receiver';
import { resolveCloudflareBrowserTarget } from './target';

const OS_ORIGIN = 'https://os.ezil.work';
const WORKER_ORIGIN = 'https://api-desktop.ezil.org';
const CONNECTOR_ORIGIN = 'https://connect.ezil.work';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const POLICY = {
    scopeByProcedure: new Map([
        [BROWSER_CAPABILITIES_PROCEDURE, BROWSER_CAPABILITIES_SCOPE],
        [BROWSER_OPEN_PROCEDURE, BROWSER_OPEN_SCOPE],
    ]),
};

export function productionBrowserCanary() {
    const userId = process.env.EZIL_BROWSER_PROD_CANARY_USER_ID ?? '';
    const computerId = process.env.EZIL_BROWSER_PROD_CANARY_COMPUTER_ID ?? '';
    const origin = process.env.EZIL_BROWSER_PROD_CANARY_TEST_ORIGIN ?? '';
    const targetUrl = parseBrowserTestUrl(origin);
    const secret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    if (process.env.EZIL_DELEGATED_BROWSER_PROD_CANARY !== 'enabled'
        || process.env.EZIL_DELEGATION_ISSUER !== CONNECTOR_ORIGIN
        || process.env.EZIL_DELEGATION_AUDIENCE !== OS_ORIGIN
        || process.env.CLOUDFLARE_GUACAMOLE_WORKER_URL?.replace(/\/$/, '') !== WORKER_ORIGIN
        || !secret || !UUID.test(userId) || !UUID.test(computerId)
        || targetUrl?.protocol !== 'https:' || targetUrl.origin !== origin) return undefined;

    async function worker(
        name: 'browser-open-url' | 'browser-open-capabilities', target: BrowserTarget, body: string,
        signal: AbortSignal, timeoutMs: number,
    ): Promise<unknown> {
        const endpoint = new URL('/sandbox/' + target.sandboxId + '/' + name, WORKER_ORIGIN);
        const signature = mintPreviewTokenV2(secret!, {
            ts: Date.now(), sandboxId: target.sandboxId, computerId, userId,
            provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0,
        }, { method: 'POST', path: endpoint.pathname, body });
        const response = await fetch(endpoint, {
            method: 'POST', body, signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
            redirect: 'error', cache: 'no-store',
            headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: signature },
        });
        if (!response.ok) return null;
        return JSON.parse(await readSmallBody(response, 4096)) as unknown;
    }

    return {
        enabled: true,
        allowedOrigins: new Set([origin]),
        async verify(headers: Headers, serializedInput: string, procedure: string): Promise<BrowserPrincipal | null> {
            const config = await delegationConfig({
                EZIL_DELEGATION_ISSUER: process.env.EZIL_DELEGATION_ISSUER,
                EZIL_DELEGATION_AUDIENCE: process.env.EZIL_DELEGATION_AUDIENCE,
                EZIL_DELEGATION_PUBLIC_JWKS: process.env.EZIL_DELEGATION_PUBLIC_JWKS,
                EZIL_DELEGATION_CLIENT_IDS: process.env.EZIL_DELEGATION_CLIENT_IDS,
                NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
            }, AUTH0_ISSUER);
            const result = await verifyDelegation(headers, {
                enabled: true, config, binding: { procedure, serializedInput }, policy: POLICY,
                now: () => Math.floor(Date.now() / 1000),
                consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
                findAccount: identity => findDelegatedAccount(db, identity),
            });
            if (result.kind !== 'accepted' || result.caller.userId !== userId) return null;
            return { userId, clientId: result.caller.clientId };
        },
        target: (principal: BrowserPrincipal, id: string) => (
            id === computerId && principal.userId === userId
                ? resolveCloudflareBrowserTarget(principal, id)
                : Promise.resolve(null)
        ),
        open: (_principal: BrowserPrincipal, _id: string, target: BrowserTarget, input: BrowserOpenRequest, signal: AbortSignal) =>
            worker('browser-open-url', target, JSON.stringify({ binding: target.binding, ...input }), signal, input.timeoutMs + 5000),
        ready: (target: BrowserTarget, signal: AbortSignal) =>
            worker('browser-open-capabilities', target, BROWSER_CAPABILITIES_BODY, signal, 3500),
    };
}
