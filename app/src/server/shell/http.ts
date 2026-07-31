/**
 * The shell Route Handlers' response layer.
 *
 * These handlers exist so a jQuery shell can reach our server without
 * bundling `@trpc/client` + `superjson`. They are a TRANSPORT ONLY: every one
 * of them resolves its work through `appRouter.createCaller`, so
 * `protectedProcedure` and the ownership-scoped row filters remain the single
 * authorization implementation. Nothing in this file decides who may do what.
 */

import { TRPCError } from '@trpc/server';
import { getHTTPStatusCodeFromError } from '@trpc/server/http';

/** Shell responses are per-user and can create a row. Never cache them, anywhere. */
const NO_STORE = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate',
} as const;

export function shellJson(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: NO_STORE });
}

export interface ShellErrorBody {
    error: {
        /** The tRPC error code, e.g. `UNAUTHORIZED`, `NOT_FOUND`, `FORBIDDEN`. */
        code: string;
        /**
         * Safe to show or switch on. For a 5xx this is a fixed generic string:
         * an INTERNAL_SERVER_ERROR message can carry a database error, a
         * connection string fragment or a stack detail, and none of that
         * belongs in a browser.
         */
        message: string;
    };
}

const GENERIC_SERVER_ERROR = 'Something went wrong on our side.';

/**
 * Map a thrown error to an HTTP response, reusing tRPC's OWN code -> status
 * table so these handlers and `/api/trpc` agree (401 for UNAUTHORIZED, 403
 * for FORBIDDEN, 404 for NOT_FOUND, 400 for a failed zod parse, ...).
 *
 * A non-TRPCError is a genuine bug: it becomes a 500 with the generic message
 * and is logged server-side with its real text, so the detail is preserved
 * where it belongs and nowhere else.
 */
export function shellErrorResponse(err: unknown, route: string): Response {
    if (err instanceof TRPCError) {
        const status = getHTTPStatusCodeFromError(err);
        if (status >= 500) {
            console.error(`[shell] ${route} failed`, { code: err.code, message: err.message });
            return shellJson({ error: { code: err.code, message: GENERIC_SERVER_ERROR } }, status);
        }
        // Sub-500s are the typed, actionable ones — `computer_limit_reached`,
        // `Computer not found`, `UNAUTHORIZED`. The shell switches on these,
        // so the message crosses unchanged.
        return shellJson({ error: { code: err.code, message: err.message } }, status);
    }

    console.error(`[shell] ${route} threw a non-tRPC error`, {
        error: err instanceof Error ? err.message : String(err),
    });
    return shellJson({ error: { code: 'INTERNAL_SERVER_ERROR', message: GENERIC_SERVER_ERROR } }, 500);
}

/** The one 401 body, so an unauthenticated shell always sees the same shape. */
export function shellUnauthenticated(): Response {
    return shellJson(
        { error: { code: 'UNAUTHORIZED', message: 'Sign in to continue.' } } satisfies ShellErrorBody,
        401,
    );
}
