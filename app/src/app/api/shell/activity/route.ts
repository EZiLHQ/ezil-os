import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/activity` — the container-billing fix's heartbeat transport.
 *
 * `shell/ezil/apps/desktop-window.js` feature-detects this exactly like
 * `../focus/route.ts`'s switcher feature-detects `endpoints.focus`: it reads
 * `desktopState.endpoints.activity` and simply never calls this route when
 * the key is absent, rather than POSTing to a URL it invented. Adding the key
 * to `SHELL_API_ROUTES` and this file at the same time is what turns the
 * heartbeat's NETWORK CALL on; neither alone does anything.
 *
 * 🔴 NO `maxDuration` override, same reasoning as `../focus/route.ts`: this
 * cannot cold-boot a container. `cloudflareGuacamole.reportActivity` ->
 * `requestGuacamoleActivity` writes one field to Durable Object storage and
 * MUST NOT touch the container — no `exec`, no `containerFetch` — or the
 * heartbeat that exists so an idle container can sleep would itself be what
 * keeps waking it up.
 *
 * Like every other `/api/shell/*` handler this is a TRANSPORT only. Ownership
 * is checked exactly once, inside the procedure, and `lastInputAgoMs` is
 * validated exactly once, by that procedure's zod schema.
 *
 *   POST { computerId, lastInputAgoMs } -> { ok, error?, correlationId }
 */

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

export async function POST(req: Request) {
    try {
        // Authenticate BEFORE parsing the body — same order as every sibling
        // shell route, so an unauthenticated caller learns exactly one thing.
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }

        const { computerId = '', lastInputAgoMs } = (body ?? {}) as {
            computerId?: string;
            lastInputAgoMs?: number;
        };

        const result = await caller.cloudflareGuacamole.reportActivity({
            computerId,
            // Cast, not re-validation: the procedure's zod schema is the
            // single gate, and it rejects anything else as a 400.
            lastInputAgoMs: lastInputAgoMs as number,
        });

        return shellJson(result);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/activity');
    }
}
