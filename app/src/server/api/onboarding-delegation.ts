import { TRPCError } from '@trpc/server';

import type { DelegationPolicy } from './delegation-core';
import { bindTrpcDelegation, trpcMutationPath, type TrpcDelegationRequest } from './editor-delegation';
import type { TRPCContext } from './trpc';
import { onboardingOriginsConfigured } from './parity-config';

export const ACCOUNT_SETTINGS_PROCEDURE = 'account.mcpSettings';
export const NAMED_COMPUTER_PROCEDURE = 'computer.createNamed';
const reads = new Set([ACCOUNT_SETTINGS_PROCEDURE]);
const writes = new Set([NAMED_COMPUTER_PROCEDURE]);

export const ONBOARDING_DELEGATION_POLICY = {
    scopeByProcedure: new Map([
        [ACCOUNT_SETTINGS_PROCEDURE, 'ezil:settings:read'],
        [NAMED_COMPUTER_PROCEDURE, 'ezil:computers:create'],
    ]),
} satisfies DelegationPolicy;

export function onboardingDelegationEnabled(env: Record<string, string | undefined>): boolean {
    return env.EZIL_DELEGATED_ONBOARDING === 'enabled'
        && onboardingOriginsConfigured(env);
}

export function mcpIdentityBootstrapAudience(env: Record<string, string | undefined>): string | undefined {
    const audience = env.EZIL_MCP_IDENTITY_BOOTSTRAP_AUTH0_CLIENT_ID;
    return onboardingDelegationEnabled(env) && audience && /^[A-Za-z0-9_-]{16,128}$/.test(audience) ? audience : undefined;
}

export function onboardingMutationPath(url: URL): boolean {
    return trpcMutationPath(url, writes);
}

export function onboardingDelegationBinding(request: TrpcDelegationRequest) {
    return bindTrpcDelegation(request, reads, writes);
}

export function requireOnboardingCaller(
    ctx: Pick<TRPCContext, 'delegation' | 'user'>,
    procedure: typeof ACCOUNT_SETTINGS_PROCEDURE | typeof NAMED_COMPUTER_PROCEDURE,
) {
    const delegation = ctx.delegation;
    if (!onboardingDelegationEnabled(process.env) || delegation?.status !== 'accepted'
        || delegation.call.procedure !== procedure || delegation.call.userId !== ctx.user?.id) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    return delegation.call;
}
