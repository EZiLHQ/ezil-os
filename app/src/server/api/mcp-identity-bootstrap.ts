import { TRPCError } from '@trpc/server';
import { z } from 'zod';

import { Auth0Error, verifyIdTokenForAudience } from '@/server/auth/auth0';
import { ensureMcpAuth0Account } from '@/server/auth/auth0-account';
import { createAdminClient } from '@/server/auth/supabase-admin';

import type { DelegationPolicy } from './delegation-core';
import { bindTrpcDelegation, trpcMutationPath, type TrpcDelegationRequest } from './editor-delegation';
import { mcpIdentityBootstrapAudience } from './onboarding-delegation';
import type { TRPCContext } from './trpc';

export const MCP_IDENTITY_BOOTSTRAP = 'account.completeMcpConnection';
export const MCP_IDENTITY_CONSENT_SECONDS = 600;
const paths = new Set([MCP_IDENTITY_BOOTSTRAP]);

export const MCP_IDENTITY_BOOTSTRAP_POLICY: DelegationPolicy = {
    scopeByProcedure: new Map([[MCP_IDENTITY_BOOTSTRAP, 'ezil:account:bootstrap']]),
};

export function mcpIdentityBootstrapPath(url: URL) {
    return trpcMutationPath(url, paths);
}

export function mcpIdentityBootstrapBinding(request: TrpcDelegationRequest) {
    return bindTrpcDelegation(request, new Set(), paths);
}

export const mcpIdentityProof = z.discriminatedUnion('decision', [
    z.object({
        decision: z.literal('allow'),
        idToken: z.string().max(8192).regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
        nonce: z.string().regex(/^[\w-]{43}$/),
    }).strict(),
    z.object({ decision: z.literal('deny') }).strict(),
]);

export async function completeMcpConnection(
    ctx: Pick<TRPCContext, 'delegation' | 'db' | 'user'>,
    input: z.infer<typeof mcpIdentityProof>,
): Promise<{ ready: true } | { denied: true }> {
    const clientId = mcpIdentityBootstrapAudience(process.env);
    const delegation = ctx.delegation;
    if (!clientId || ctx.user || delegation?.status !== 'bootstrap' || delegation.call.procedure !== MCP_IDENTITY_BOOTSTRAP) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    // The tRPC transport already consumed this consent's shared replay key.
    // A denial identifies only that key and never reads or creates an account.
    if (input.decision === 'deny') {
        if (delegation.call.subject !== 'mcp-consent|' + delegation.call.jti) throw new TRPCError({ code: 'UNAUTHORIZED' });
        return { denied: true };
    }
    if (delegation.call.subject.startsWith('mcp-consent|')) throw new TRPCError({ code: 'UNAUTHORIZED' });
    const identity = await verifyIdTokenForAudience(input.idToken, {
        clientId, nonce: input.nonce, maxAgeSeconds: MCP_IDENTITY_CONSENT_SECONDS,
    }).catch(() => null);
    if (!identity || identity.sub !== delegation.call.subject) throw new TRPCError({ code: 'UNAUTHORIZED' });
    try {
        await ensureMcpAuth0Account(ctx.db, createAdminClient({ timeoutMs: 5_000 }).auth.admin, identity);
        return { ready: true };
    } catch (error) {
        if (error instanceof Auth0Error && error.code === 'account_conflict') throw new TRPCError({ code: 'CONFLICT' });
        // A response failure may have followed an auth provider commit. Fresh consent is safe to retry.
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR' });
    }
}
