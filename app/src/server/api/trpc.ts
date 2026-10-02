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

import { userFromBearer } from './bearer-auth';

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
 * `ctx.user` and nothing else, so the two credentials converge on ONE `user`
 * here and there is no bearer-specific authorization anywhere.
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
    const supabase = await createClient();

    const bearerUser = await userFromBearer(supabase, opts.headers);

    const user =
        bearerUser === undefined
            ? (await supabase.auth.getUser()).data.user
            : bearerUser;

    return { db, user, headers: opts.headers };
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
 * Requires an authenticated Supabase user; narrows `ctx.user` to non-null.
 * `UNAUTHORIZED` when no credential resolved to a user.
 */
export const protectedProcedure = t.procedure.use(timingMiddleware).use(async ({ ctx, next }) => {
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
