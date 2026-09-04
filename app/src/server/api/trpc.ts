/**
 * tRPC server setup — context, router/procedure builders, middleware.
 * Fresh boilerplate for this repo (not carried from anywhere): a minimal
 * context (db + Supabase user + the EZiL OS access decision), a
 * `protectedProcedure` that requires an authenticated AND allowed user, and
 * superjson as the transformer.
 *
 * @see https://trpc.io/docs/server/context
 */
import { initTRPC, TRPCError } from '@trpc/server';
import superjson from 'superjson';
import { ZodError } from 'zod';

import type { User } from '@supabase/supabase-js';

import { env } from '@/env';
import { db } from '@/server/db';
import { createClient } from '@/utils/supabase/server';

import { userFromBearer } from './bearer-auth';
import {
    OS_ACCESS_NOT_INVITED,
    osAccessFor,
    osAccessLookup,
    type OsAccessMode,
    type OsAccessResult,
} from './os-access';

/**
 * Everything `createTRPCContext` resolves from the request, before the context
 * object is assembled. Separated from `createTRPCContext` itself for exactly
 * one reason: `createTRPCContext` reaches `next/headers`' `cookies()` through
 * `createClient()`, which throws outside a real request, so the assembly step
 * — which is where the access decision is wired — would otherwise be
 * unreachable from a test. See `trpc-access.test.ts`.
 */
export interface TRPCContextParts {
    db: typeof db;
    user: User | null;
    headers: Headers;
    /** `env.EZIL_OS_ACCESS_MODE`, passed in so this half stays free of `@/env`. */
    mode: OsAccessMode;
}

/**
 * Assemble the context. The interesting member is `access()`.
 *
 * 🔴 LAZY, and MEMOISED — both halves are deliberate.
 *
 *  - Memoised, because a single page renders several procedures through one
 *    context (`/os` calls `computer.getOrCreateDefault` and
 *    `cloudflareGuacamole.isConfigured` concurrently). Recomputing per
 *    procedure would put one `ezil_os_access` round trip per call into a page
 *    whose whole budget is 200ms (docs/PLATFORM-NOTES.md §15).
 *  - Lazy — a method rather than an eagerly-created promise field — for two
 *    reasons. A request that touches only `publicProcedure`, or that carries
 *    no session at all, should not query the database; and an eagerly-created
 *    promise that nobody awaits turns a transient Postgres failure into an
 *    unhandled rejection, which on some runtimes is a process-level crash
 *    rather than one failed request.
 *
 * 🔴 The decision is NOT caught here, and must not be caught downstream. If
 * the lookup throws, the throw propagates and the request fails closed. A
 * `try { ... } catch { /* let them in *\/ }` around `access()` is the single
 * edit that would disable the gate for everyone the moment the database
 * hiccups — see the same warning on `./os-access.ts`.
 */
export function buildTRPCContext(parts: TRPCContextParts) {
    let decision: Promise<OsAccessResult> | undefined;

    return {
        db: parts.db,
        user: parts.user,
        headers: parts.headers,
        /** May this caller use EZiL OS at all? One lookup per request, at most. */
        access: (): Promise<OsAccessResult> =>
            (decision ??= osAccessFor(osAccessLookup(parts.db), parts.user, parts.mode)),
    };
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
 * Everything downstream — every tRPC procedure, and every `/api/shell/*` route,
 * which are transports that resolve through `appRouter.createCaller` — reads
 * `ctx.user` and `ctx.access()` and nothing else. That is deliberate:
 * authorization has exactly one implementation, so adding a second way to
 * *authenticate* does not add a second way to *authorize*.
 *
 * 🔴 The two credentials converge on ONE `user` before the context is built,
 * and `buildTRPCContext` is called exactly once, below. That is why a bearer
 * caller is refused by the allow-list with no bearer-specific code anywhere:
 * there is no second path for one to live on. `trpc-access.test.ts` asserts
 * both the behaviour and, in source, that this function has a single call into
 * the builder.
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
    const supabase = await createClient();

    const bearerUser = await userFromBearer(supabase, opts.headers);

    const user =
        bearerUser === undefined
            ? (await supabase.auth.getUser()).data.user
            : bearerUser;

    return buildTRPCContext({
        db,
        user,
        headers: opts.headers,
        mode: env.EZIL_OS_ACCESS_MODE,
    });
};

const t = initTRPC.context<typeof createTRPCContext>().create({
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

/** Base procedure — usable unauthenticated. */
export const publicProcedure = t.procedure.use(timingMiddleware);

/**
 * Requires an authenticated Supabase user **who is allowed to use EZiL OS**;
 * narrows `ctx.user` to non-null and `ctx.access` to the allowing result.
 *
 * ── Two refusals, two codes, and they are not interchangeable ───────────────
 *  - `UNAUTHORIZED` — no credential resolved to a user. "Go and sign in."
 *  - `FORBIDDEN`    — a user WAS resolved and is not on the allow-list. The
 *    caller proved who they are and it did not help; telling them to sign in
 *    again would loop them forever. See `./os-access.ts`.
 *
 * 🔴 The message is always `OS_ACCESS_NOT_INVITED`, never `access.reason`.
 * "Revoked" and "never invited" are different facts about the allow-list and
 * they are logged as such below, but on the wire they are one refusal: the
 * difference is only observable to someone probing which addresses have ever
 * been invited, and it changes nothing the caller can act on.
 */
export const protectedProcedure = t.procedure.use(timingMiddleware).use(async ({ ctx, next }) => {
    if (!ctx.user) {
        throw new TRPCError({ code: 'UNAUTHORIZED' });
    }

    const access = await ctx.access();
    if (!access.allowed) {
        // The reason kept where it is useful and nowhere else. No email is
        // logged: the user id is enough to answer "why was this refused?".
        console.warn('[os-access] refused', { userId: ctx.user.id, reason: access.reason });
        throw new TRPCError({ code: 'FORBIDDEN', message: OS_ACCESS_NOT_INVITED });
    }

    return next({
        ctx: {
            user: ctx.user as User,
            db: ctx.db,
            access,
        },
    });
});
