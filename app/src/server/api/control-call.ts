/**
 * The shared wrapper of the EZiL MCP control procedures (`computer.start`, `agentSession.create` and `.configure`):
 * the OAuth client the call acts through, store errors as tRPC errors, and ONE audit line per call carrying the
 * delegation's `jti`, client and subject, the procedure, the idempotency key and the outcome (CONTRACT.md v2 and
 * proposals/session-controls.md). The gate's own line (`ezil_delegation`) records that the call was let through;
 * this one records what it did, keyed so the MCP's own log line can be correlated. It never holds instruction text,
 * a URL, a token, an email or the assertion.
 */
import { TRPCError } from '@trpc/server';

import { SessionStoreError } from '@/server/agent-session/store';

import type { TRPCContext } from './trpc';

/** The OAuth client a delegated caller acts through; '' for the person's own session. Part of the idempotency key. */
export const clientOf = (ctx: Pick<TRPCContext, 'delegation'>) => (ctx.delegation?.status === 'accepted' ? ctx.delegation.call.clientId : '');

export async function controlCall<T extends { status: string }>(ctx: TRPCContext & { user: { id: string } }, procedure: string,
    idempotencyKey: string, work: () => Promise<T>): Promise<T> {
    const call = ctx.delegation?.status === 'accepted' ? ctx.delegation.call : null;
    const audit = (outcome: string) => console.info(JSON.stringify({
        event: 'ezil_control', jti: call?.jti ?? null, client_id: call?.clientId ?? null, sub: call?.sub ?? null,
        user_id: ctx.user.id, procedure, idempotency_key: idempotencyKey, outcome,
    }));
    try {
        const result = await work();
        audit(result.status);
        return result;
    } catch (error) {
        if (error instanceof SessionStoreError) {
            audit(`error:${error.code}`);
            throw new TRPCError({ code: error.code, ...(error.reason ? { message: error.reason } : {}) });
        }
        audit('error:INTERNAL_SERVER_ERROR');
        throw error;
    }
}
