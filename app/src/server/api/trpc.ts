/**
 * tRPC server setup — context, router/procedure builders, middleware.
 * Fresh boilerplate for this repo (not carried from anywhere): a minimal
 * context (db + Supabase user), a `protectedProcedure` that requires an
 * authenticated user, and superjson as the transformer.
 *
 * Anyone who can sign in may use EZiL OS. There is no allow-list: the invite
 * gate (`ezil_os_access`) was removed when sign-up opened to everyone at
 * os.ezil.org. The table and its rows are left in place, unread.
 *
 * @see https://trpc.io/docs/server/context
 */
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';

import type { User } from '@supabase/supabase-js';

import { db } from '@/server/db';
import { createClient } from '@/utils/supabase/server';

import { AUTH0_ISSUER } from '@/server/auth/issuer';

import { userFromBearer } from './bearer-auth';
import {
    authenticateDelegation,
    delegationBinding,
    delegationConfig,
    delegatedProcedureType,
    isDelegationHeader,
    type DelegatedAccount,
    type DelegatedCall,
    type DelegationOutcome,
    type DelegationRequest,
} from './delegation-auth';
import { consumeDelegationJti, findDelegatedAccount } from './delegation-store';

/**
 * A request that presented `Authorization: EZiL-Delegation`. `rejected` keeps
 * the request marked so the gate refuses every procedure, public ones included.
 */
export type DelegationState = { status: 'accepted'; call: DelegatedCall } | { status: 'rejected' };

/** The request a delegation is bound to (its `proc` and `inp` claims): the request line, and a POST's raw body. */
export type { DelegationRequest };

/**
 * `delegation` is set by `createTRPCContext` for every request that offered one;
 * absent only on contexts built by hand (server-side callers, tests), which
 * never carry request credentials.
 */
export interface TRPCContext {
    db: typeof db;
    user: User | null;
    headers: Headers;
    delegation?: DelegationState | null;
}

/** One audit line per delegated decision. Never the assertion itself (CONTRACT.md v2, requirement 6). */
function auditDelegation(fields: { jti?: string; clientId?: string; sub?: string; userId?: string }, procedure: string, outcome: string) {
    console.info(JSON.stringify({
        event: 'ezil_delegation', jti: fields.jti ?? null, client_id: fields.clientId ?? null, sub: fields.sub ?? null,
        user_id: fields.userId ?? null, procedure, outcome,
    }));
}

/** Only what the `auth.users` row proves. No email: anything email-gated stays closed to a delegate. */
const delegatedUser = (account: DelegatedAccount): User => ({
    id: account.id, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: account.createdAt,
});

async function delegatedContext(headers: Headers, request: DelegationRequest | undefined): Promise<TRPCContext> {
    const outcome: DelegationOutcome = request
        ? await authenticateDelegation(headers, {
              binding: delegationBinding(request),
              // Read per request from process.env (not `@/env`, which validates the whole
              // server environment at import and would make this module untestable).
              config: await delegationConfig({
                  EZIL_DELEGATION_ISSUER: process.env.EZIL_DELEGATION_ISSUER,
                  EZIL_DELEGATION_AUDIENCE: process.env.EZIL_DELEGATION_AUDIENCE,
                  EZIL_DELEGATION_PUBLIC_JWKS: process.env.EZIL_DELEGATION_PUBLIC_JWKS,
                  EZIL_DELEGATION_CLIENT_IDS: process.env.EZIL_DELEGATION_CLIENT_IDS,
                  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
              }, AUTH0_ISSUER),
              now: () => Math.floor(Date.now() / 1000),
              consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
              findAccount: (identity) => findDelegatedAccount(db, identity),
          })
        : { kind: 'rejected', reason: 'transport' };
    if (outcome.kind === 'accepted') {
        const delegation: DelegationState = { status: 'accepted', call: outcome.call };
        return { db, user: delegatedUser(outcome.account), headers, delegation };
    }
    if (outcome.kind === 'rejected') auditDelegation(outcome, '<context>', `rejected:${outcome.reason}`);
    const delegation: DelegationState = { status: 'rejected' };
    return { db, user: null, headers, delegation };
}

/**
 * The one place a request becomes a caller.
 *
 * Two credentials are accepted, and they are mutually exclusive:
 *
 *  - the Supabase session **cookie**, which is how the browser and the desktop
 *    shell authenticate; and
 *  - an `Authorization: Bearer <supabase-jwt>` header, which is how `sdk/` and
 *    the `mcp/` connector authenticate, since neither has a cookie jar.
 *
 * A third, `Authorization: EZiL-Delegation <jws>` (the EZiL MCP acting for a
 * person within one scope), is accepted ONLY when the caller passes
 * `acceptDelegation` (its request line and a POST's raw body) — the
 * `/api/trpc` route, where the assertion must name that one call (`proc`,
 * `inp`) and `delegationGate` lets only that procedure run. Every other caller (the `/api/shell/*` routes, RSC)
 * reads `ctx.user` outside any procedure, so there a delegation resolves to no
 * user at all. Like a bad bearer, it never falls back to the cookie.
 *
 * Everything downstream — every tRPC procedure, and every `/api/shell/*` route,
 * which are transports that resolve through `appRouter.createCaller` — reads
 * `ctx.user` and nothing else, so the two credentials converge on ONE `user`
 * here and there is no bearer-specific authorization anywhere.
 */
export const createTRPCContext = async (opts: { headers: Headers; acceptDelegation?: DelegationRequest }): Promise<TRPCContext> => {
    if (isDelegationHeader(opts.headers.get('authorization'))) {
        return delegatedContext(opts.headers, opts.acceptDelegation);
    }

    const supabase = await createClient();

    const bearerUser = await userFromBearer(supabase, opts.headers);

    const user =
        bearerUser === undefined
            ? (await supabase.auth.getUser()).data.user
            : bearerUser;

    return { db, user, headers: opts.headers, delegation: null };
};

const t = initTRPC.context<TRPCContext>().create({
    transformer: superjson,
    errorFormatter({ shape, error }) {
        return {
            ...shape,
            data: {
                ...shape.data,
                zodError: error.cause instanceof ZodError ? error.cause.flatten() : null,
            },
        };
    },
});

export const createCallerFactory = t.createCallerFactory;
export const createTRPCRouter = t.router;

const timingMiddleware = t.middleware(async ({ next, path }) => {
    const start = Date.now();
    const result = await next();
    if (process.env.NODE_ENV === 'development') {
        console.log(`[TRPC] ${path} took ${Date.now() - start}ms`);
    }
    return result;
});

/**
 * A delegated request reaches only the one allow-listed procedure its
 * assertion names (`proc`, already checked against the scope and the request
 * line), and only as that procedure's own type (a query by GET, a mutation by
 * POST); anything else — another procedure or type, a public one, or any
 * procedure after a rejected assertion — is UNAUTHORIZED. Every procedure is
 * built on this, so there is no way around it.
 */
const delegationGate = t.middleware(async ({ ctx, path, type, next }) => {
    const delegation = ctx.delegation;
    if (!delegation) return next();
    if (delegation.status !== 'accepted') {
        auditDelegation({}, path, 'refused:rejected_assertion');
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    if (path !== delegation.call.procedure || type !== delegatedProcedureType(path)) {
        auditDelegation(delegation.call, path, 'refused:not_allowed');
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    const result = await next();
    auditDelegation(delegation.call, path, result.ok ? 'ok' : `error:${result.error.code}`);
    return result;
});

const baseProcedure = t.procedure.use(delegationGate).use(timingMiddleware);

/** Base procedure — usable unauthenticated. */
export const publicProcedure = baseProcedure;

/**
 * Requires an authenticated Supabase user; narrows `ctx.user` to non-null.
 * `UNAUTHORIZED` when no credential resolved to a user.
 */
export const protectedProcedure = baseProcedure.use(async ({ ctx, next }) => {
    if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }

    return next({
        ctx: {
            user: ctx.user as User,
            db: ctx.db,
        },
    });
});
