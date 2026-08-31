/**
 * tRPC server setup — context, router/procedure builders, middleware.
 * Fresh boilerplate for this repo (not carried from anywhere): a minimal
 * context (db + Supabase user), a `protectedProcedure` that requires an
 * authenticated user, and superjson as the transformer.
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
 * `ctx.user` and nothing else. That is deliberate: authorization has exactly
 * one implementation, so adding a second way to *authenticate* does not add a
 * second way to *authorize*.
 */
export const createTRPCContext = async (opts: { headers: Headers }) => {
    const supabase = await createClient();

    const bearerUser = await userFromBearer(supabase, opts.headers);

    const user =
        bearerUser === undefined
            ? (await supabase.auth.getUser()).data.user
            : bearerUser;

    return {
        db,
        user,
        ...opts,
    };
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

/** Requires an authenticated Supabase user; narrows `ctx.user` to non-null. */
export const protectedProcedure = t.procedure.use(timingMiddleware).use(({ ctx, next }) => {
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
