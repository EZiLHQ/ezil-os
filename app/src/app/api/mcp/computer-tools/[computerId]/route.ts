import { AUTH0_ISSUER } from '@/server/auth/issuer';
import { delegationConfig, verifyDelegation } from '@/server/api/delegation-core';
import { consumeDelegationJti, findDelegatedAccount } from '@/server/api/delegation-store';
import { readSmallBody } from '@/server/browser-observe/receiver';
import { createComputerToolsAudit } from '@/server/computer-tools/audit';
import {
    COMPUTER_TOOLS_DELEGATION_POLICY, COMPUTER_TOOLS_STAGING_WORKER,
    FORWARD_TIMEOUT_MS, MAX_WORKER_REPLY_BYTES, computerToolsConfigured, opSwitchEnabled,
} from '@/server/computer-tools/contract';
import { handleComputerTools } from '@/server/computer-tools/receiver';
import { resolveComputerToolsTarget } from '@/server/computer-tools/target';
import { db } from '@/server/db';
import { mintPreviewTokenV2, PREVIEW_TOKEN_V2_HEADER } from '@/server/lib/compute/preview-token-v2';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
    const secret = process.env.CLOUDFLARE_GUACAMOLE_HMAC_SECRET?.trim();
    return handleComputerTools(request, {
        enabled: computerToolsConfigured(process.env),
        opEnabled: (op) => opSwitchEnabled(process.env, op),
        async verify(headers, serializedInput, procedure) {
            const config = await delegationConfig({
                EZIL_DELEGATION_ISSUER: process.env.EZIL_DELEGATION_ISSUER,
                EZIL_DELEGATION_AUDIENCE: process.env.EZIL_DELEGATION_AUDIENCE,
                EZIL_DELEGATION_PUBLIC_JWKS: process.env.EZIL_DELEGATION_PUBLIC_JWKS,
                EZIL_DELEGATION_CLIENT_IDS: process.env.EZIL_DELEGATION_CLIENT_IDS,
                NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
            }, AUTH0_ISSUER);
            const result = await verifyDelegation(headers, {
                enabled: true,
                config,
                binding: { procedure, serializedInput },
                policy: COMPUTER_TOOLS_DELEGATION_POLICY,
                now: () => Math.floor(Date.now() / 1000),
                consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
                findAccount: (identity) => findDelegatedAccount(db, identity),
            });
            if (result.kind !== 'accepted') return null;
            const { userId, clientId, scope: verifiedScope, procedure: verifiedProcedure, jti } = result.caller;
            return { userId, clientId, scope: verifiedScope, procedure: verifiedProcedure, jti };
        },
        resolveTarget: (principal, computerId) => resolveComputerToolsTarget(principal, computerId),
        async forward(principal, computerId, target, op, input) {
            const endpoint = new URL(`/sandbox/${target.sandboxId}/computer-tools`, COMPUTER_TOOLS_STAGING_WORKER);
            const body = JSON.stringify({ binding: target.binding, op, input });
            const signature = mintPreviewTokenV2(secret!, {
                ts: Date.now(), sandboxId: target.sandboxId, computerId, userId: principal.userId,
                provider: 'cloudflare', store: '', generation: 0, leaseEpoch: 0,
            }, { method: 'POST', path: endpoint.pathname, body });
            try {
                const response = await fetch(endpoint, {
                    method: 'POST', body, signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS),
                    redirect: 'error', cache: 'no-store',
                    headers: { 'content-type': 'application/json', [PREVIEW_TOKEN_V2_HEADER]: signature },
                });
                const text = await readSmallBody(response, MAX_WORKER_REPLY_BYTES);
                return { kind: 'reply', status: response.status, text };
            } catch {
                return { kind: 'error' };
            }
        },
        audit: createComputerToolsAudit(db),
    });
}
