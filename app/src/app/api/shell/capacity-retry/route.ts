import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/capacity-retry`: the owner's explicit "Try again" after a
 * `capacity_attempt_expired` open (RETRY-118). It resets ONLY the stated expired
 * capacity attempt of one of the caller's computers (newest, unreleased, no
 * placement, no active demand), then the shell reopens through the normal boot.
 * Automatic polling and transport retries never call it.
 *
 * Exactly like `../restart/route.ts`, this file and the `capacityRetry` key in
 * `SHELL_API_ROUTES` ship together; the shell feature-detects the key.
 *
 * A TRANSPORT only: it authenticates before parsing the body, and ownership is
 * checked exactly once, inside `cloudflareGuacamole.resetCapacityAttempt`.
 *
 *   POST { computerId, attemptId } -> { ok, outcome: 'reset' | 'already_reset' | 'superseded' | 'not_found' }
 */
export const maxDuration = 30;

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

export async function POST(req: Request) {
    try {
        // Authenticate BEFORE parsing the body: an unauthenticated caller learns exactly one thing.
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }

        const { computerId = '', attemptId = '' } = (body ?? {}) as { computerId?: string; attemptId?: string };

        return shellJson(await caller.cloudflareGuacamole.resetCapacityAttempt({ computerId, attemptId }));
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/capacity-retry');
    }
}
