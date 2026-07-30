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

export const createTRPCContext = async (opts: { headers: Headers }) => {
    const supabase = await createClient();

    const {
        data: { user },
    } = await supabase.auth.getUser();

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
