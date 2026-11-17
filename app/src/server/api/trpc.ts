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

import { AUTH0_ISSUER } from '@/server/auth/issuer';
import { db } from '@/server/db';
import { createClient } from '@/utils/supabase/server';

import { userFromBearer } from './bearer-auth';
import {
    authenticateDelegation, delegatedReadsEnabled, delegationBinding, delegationConfig, isDelegationHeader,
    type DelegatedAccount, type DelegatedCall, type DelegationRejection, type DelegationRequest,
} from './delegation-auth';
import { consumeDelegationJti, findDelegatedAccount } from './delegation-store';

/**
 * Set for every request that presented `Authorization: EZiL-Delegation`. `rejected` keeps the request marked
 * so the procedure gate refuses everything, public procedures included.
 */
export type DelegationState = { status: 'accepted'; call: DelegatedCall } | { status: 'rejected' };

export interface TRPCContext {
    db: typeof db;
    user: User | null;
    headers: Headers;
    delegation?: DelegationState;
}

export type { DelegationRequest };

/** One fixed-category line per delegated decision: never the assertion, header, subject, metadata or a raw error. */
function auditDelegation(procedure: string, outcome: string) {
    console.info(JSON.stringify({ event: 'ezil_delegation', procedure, outcome }));
}

/** Only what the `auth.users` row proves: id and creation time, empty metadata, no email and no role. */
const delegatedUser = (account: DelegatedAccount): User => ({
    id: account.id, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: account.createdAt,
});

async function delegatedContext(headers: Headers, request: DelegationRequest | undefined): Promise<TRPCContext> {
    let reason: DelegationRejection | undefined;
    if (!request) {
        // A caller that did not hand over the actual request line (any other transport) cannot be bound.
        reason = 'transport';
    } else {
        const enabled = delegatedReadsEnabled(process.env.EZIL_DELEGATED_COMPUTER_READS);
        // Read per request from process.env, not `@/env`: the pins are optional and absent ones only reject.
        const outcome = await authenticateDelegation(headers, {
            enabled,
            config: enabled ? await delegationConfig({
                EZIL_DELEGATION_ISSUER: process.env.EZIL_DELEGATION_ISSUER,
                EZIL_DELEGATION_AUDIENCE: process.env.EZIL_DELEGATION_AUDIENCE,
                EZIL_DELEGATION_PUBLIC_JWKS: process.env.EZIL_DELEGATION_PUBLIC_JWKS,
                EZIL_DELEGATION_CLIENT_IDS: process.env.EZIL_DELEGATION_CLIENT_IDS,
                NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
            }, AUTH0_ISSUER) : undefined,
            binding: delegationBinding(request),
            now: () => Math.floor(Date.now() / 1000),
            consumeJti: (jti, expiresAt) => consumeDelegationJti(db, jti, expiresAt),
            findAccount: identity => findDelegatedAccount(db, identity),
        });
        if (outcome.kind === 'accepted') {
            return { db, user: delegatedUser(outcome.account), headers, delegation: { status: 'accepted', call: outcome.call } };
        }
        reason = outcome.kind === 'rejected' ? outcome.reason : 'malformed';
    }
    auditDelegation('<context>', `rejected:${reason}`);
    return { db, user: null, headers, delegation: { status: 'rejected' } };
}

/**
 * The one place a request becomes a caller.
 *
 * Three credentials are accepted, and they are mutually exclusive:
 *
 *  - the Supabase session **cookie**, which is how the browser and the desktop
 *    shell authenticate;
 *  - an `Authorization: Bearer <supabase-jwt>` header, which is how `sdk/` and
 *    the `mcp/` connector authenticate, since neither has a cookie jar; and
 *  - an `Authorization: EZiL-Delegation <assertion>` header: the public EZiL MCP reading one person's
 *    computers (`delegation-auth.ts`). It is recognised FIRST and only on `/api/trpc` GET (`delegationRequest`);
 *    a rejected or unbound one never falls back to the cookie, and the procedure gate below confines an
 *    accepted one to the single read procedure it names.
 *
 * Everything downstream — every tRPC procedure, and every `/api/shell/*` route,
 * which are transports that resolve through `appRouter.createCaller` — reads
 * `ctx.user` and nothing else, so the credentials converge on ONE `user`
 * here and there is no bearer-specific authorization anywhere.
 */
export const createTRPCContext = async (opts: { headers: Headers; delegationRequest?: DelegationRequest }): Promise<TRPCContext> => {
    if (isDelegationHeader(opts.headers.get('authorization'))) return delegatedContext(opts.headers, opts.delegationRequest);
    const supabase = await createClient();

    const bearerUser = await userFromBearer(supabase, opts.headers);

    const user =
        bearerUser === undefined
            ? (await supabase.auth.getUser()).data.user
            : bearerUser;

    return { db, user, headers: opts.headers };
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
 * A delegated request reaches only the one read procedure its assertion names (`proc`, already bound to the
 * request path), and only as a query. Any other procedure or type, a public one, a mutation, or anything after
 * a rejected assertion is UNAUTHORIZED. Public and protected procedures are both built on this, so a signed
 * call cannot escape through either.
 */
const delegationGate = t.middleware(async ({ ctx, path, type, next }) => {
    const delegation = ctx.delegation;
    if (!delegation) return next();
    if (delegation.status !== 'accepted') {
        auditDelegation(path, 'refused:rejected_assertion');
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    if (path !== delegation.call.procedure || type !== 'query') {
        auditDelegation(path, 'refused:not_allowed');
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }
    const result = await next();
    auditDelegation(path, result.ok ? 'ok' : `error:${result.error.code}`);
    return result;
});

const baseProcedure = t.procedure.use(delegationGate).use(timingMiddleware);

/** Base procedure — usable unauthenticated (still behind the delegation gate). */
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
