import { AUTH0_ISSUER } from '@/server/auth/issuer';
import { delegationConfig, verifyDelegation } from '@/server/api/delegation-core';
import { consumeDelegationJti, findDelegatedAccount } from '@/server/api/delegation-store';
import { db } from '@/server/db';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from '@/server/lib/compute/preview-token-v2';
import { readSmallBody } from '../browser-open/body';
import {
    BROWSER_CONTROL_PROCEDURE, BROWSER_CONTROL_SCOPE, BROWSER_OBSERVE_PROCEDURE, BROWSER_OBSERVE_SCOPE,
    BROWSER_PAGE_PROCEDURE, BROWSER_PAGE_SCOPE, BROWSER_UI_RESULT_MAX_BYTES, browserDeployment,
    type BrowserSessionRequest,
} from './contract';
import { resolveCloudflareBrowserTarget } from './target';

type Env = Record<string, string | undefined>;
type Principal = { userId: string; clientId: string };
type Target = { sandboxId: string; binding: string };

/** One exact scope per procedure; the connector's delegation must carry that procedure and that scope. */
export const BROWSER_OBSERVE_POLICY = {
    scopeByProcedure: new Map([
        [BROWSER_OBSERVE_PROCEDURE, BROWSER_OBSERVE_SCOPE],
        [BROWSER_PAGE_PROCEDURE, BROWSER_PAGE_SCOPE],
        [BROWSER_CONTROL_PROCEDURE, BROWSER_CONTROL_SCOPE],
    ]),
};

/**
 * What this deployment serves. Both switches are off unless the connector, the OS audience and the Code Worker name
 * one known deployment exactly and the Worker signing secret is present. Observation and page control are separate
 * switches: neither implies the other.
 */
export function browserObserveSwitches(env: Env) {
    const deployment = browserDeployment(env);
    const secret = env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    const configured = Boolean(deployment && secret);
    return {
        deployment: configured ? deployment : undefined,
        secret: configured ? secret : undefined,
        enabled: configured && env.EZIL_DELEGATED_BROWSER_OBSERVE === 'enabled',
        controlEnabled: configured && env.EZIL_DELEGATED_BROWSER_CONTROL === 'enabled',
    };
}

/** The receiver's dependencies for this deployment, resolved per request so a rendered setting is never cached. */
export function browserObserveRelay(env: Env = process.env) {
    const { deployment, secret, enabled, controlEnabled } = browserObserveSwitches(env);
    return {
        enabled, controlEnabled, now: Date.now,
        async verify(headers: Headers, serializedInput: string, procedure: string, scope: string): Promise<Principal | null> {
            if (!deployment || BROWSER_OBSERVE_POLICY.scopeByProcedure.get(procedure) !== scope) return null;
            const config = await delegationConfig({
                EZIL_DELEGATION_ISSUER: env.EZIL_DELEGATION_ISSUER,
                EZIL_DELEGATION_AUDIENCE: env.EZIL_DELEGATION_AUDIENCE,
                EZIL_DELEGATION_PUBLIC_JWKS: env.EZIL_DELEGATION_PUBLIC_JWKS,
                EZIL_DELEGATION_CLIENT_IDS: env.EZIL_DELEGATION_CLIENT_IDS,
                NEXT_PUBLIC_SUPABASE_URL: env.NEXT_PUBLIC_SUPABASE_URL,
            }, AUTH0_ISSUER);
            const result = await verifyDelegation(headers, {
                enabled: true, config, binding: { procedure, serializedInput }, policy: BROWSER_OBSERVE_POLICY,
                now: () => Math.floor(Date.now() / 1000),
                consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
                findAccount: identity => findDelegatedAccount(db, identity),
            });
            if (result.kind !== 'accepted') return null;
            return { userId: result.caller.userId, clientId: result.caller.clientId };
        },
        target: (principal: Principal, computerId: string) =>
            resolveCloudflareBrowserTarget(principal, computerId, 'ezil-browser-observe-v1'),
        async observe({ userId }: Principal, computerId: string, target: Target, input: BrowserSessionRequest): Promise<unknown> {
            if (!deployment || !secret) return { ok: false, error: 'browser_unavailable' };
            const endpoint = new URL('/sandbox/' + target.sandboxId + '/browser-observe', deployment.worker);
            const body = JSON.stringify({ binding: target.binding, ...input });
            const signature = mintPreviewTokenV2(secret, {
                ts: Date.now(), sandboxId: target.sandboxId, computerId, userId,
                provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0,
            }, { method: 'POST', path: endpoint.pathname, body });
            const response = await fetch(endpoint, {
                method: 'POST', body, signal: AbortSignal.timeout(10_000), redirect: 'error', cache: 'no-store',
                headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: signature },
            });
            if (!response.ok) {
                void response.body?.cancel().catch(() => {});
                return { ok: false, error: 'browser_unavailable' };
            }
            return JSON.parse(await readSmallBody(response, 'action' in input ? BROWSER_UI_RESULT_MAX_BYTES : 2048)) as unknown;
        },
    };
}
