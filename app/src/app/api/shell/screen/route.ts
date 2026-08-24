import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/screen` — change the X screen mode of a LIVE desktop.
 *
 * This is the transport for the shell's live-resize path, and it is
 * FEATURE-DETECTED exactly the way `./focus/route.ts` is: adding the `screen`
 * key to `SHELL_API_ROUTES` and this file at the same time is what turns live
 * resizing on. `shell/ezil/apps/desktop-screen.js` reads
 * `desktopState.endpoints.screen` and stays permanently dark — no observer
 * hookup, no debounce timer, no request — when the key is absent, rather than
 * POSTing to a URL it invented. The bundle and the server deploy separately, so
 * a shell newer than its server is a real state, not a hypothetical one.
 *
 * 🔴 NO `maxDuration` override, for the same reason as `./focus/route.ts` and
 * unlike `../desktop/route.ts` (docs/PLATFORM-NOTES.md §13). This cannot cold-
 * boot a container: `cloudflareGuacamole.setScreen` calls `POST
 * /sandbox/:name/screen`, whose whole job is two loopback HTTP calls inside a
 * container the user is already streaming, bounded at 12s by the Worker's own
 * budget and at 20s by the provider's `AbortSignal.timeout`. A resize that
 * needs five minutes is a resize that has failed, and should say so rather than
 * hang while the user drags the window somewhere else.
 *
 * Like every other `/api/shell/*` handler this is a TRANSPORT only.
 * Authorization happens exactly once, inside the procedure
 * (`assertOwnedComputer`), and the width/height are validated exactly once, by
 * that procedure's `z.number().int()` bounds — one authorization
 * implementation, one validation implementation. Nothing here re-checks them,
 * because a second implementation of the same rule is free to drift from the
 * first.
 *
 *   POST { computerId, width, height }
 *     -> 200 { ok: true,  width, height, source: 'requested'|'snapped', correlationId }
 *     -> 200 { ok: false, error: { code, message }, correlationId }
 *
 * `code` is the closed set `BAD_REQUEST | NOT_FOUND | UNSUPPORTED | UPSTREAM |
 * TIMEOUT`. `UNSUPPORTED` is the honest answer from a container whose X server
 * has a fixed framebuffer — every container running Xvfb — and the client's
 * correct response to it is to letterbox and stop asking, never to retry.
 */

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

/**
 * `GET /api/shell/screen?computerId=…` — OBSERVE the live screen, change
 * nothing.
 *
 * The shell calls this to reconcile a belief it may no longer be entitled to.
 * It is on the same path as the POST and behind the same ownership gate; the
 * only difference is that it costs a read instead of a capture-pipeline
 * restart, which is exactly why the shell can afford to call it on a restore.
 *
 *   GET ?computerId=…
 *     -> 200 { ok: true,  width, height, source: 'observed', correlationId }
 *     -> 200 { ok: false, error: { code, message }, correlationId }
 *
 * `computerId` travels in the query string rather than a body because a GET
 * with a body is a request many intermediaries are free to drop.
 */
export async function GET(req: Request) {
    try {
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        const computerId = new URL(req.url).searchParams.get('computerId') ?? '';
        // Cast, not re-validation — the procedure's `z.string().uuid()` is the
        // single gate, same rule the POST follows one function below.
        const result = await caller.cloudflareGuacamole.getScreen({ computerId });
        return shellJson(result);
    } catch (err) {
        return shellErrorResponse(err, 'GET /api/shell/screen');
    }
}

export async function POST(req: Request) {
    try {
        // Authenticate BEFORE parsing the body — an unauthenticated caller
        // should learn exactly one thing (not signed in), not whether their
        // JSON happened to be well-formed. Same order as the sibling routes.
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }

        const {
            computerId = '',
            width,
            height,
        } = (body ?? {}) as { computerId?: string; width?: number; height?: number };

        const result = await caller.cloudflareGuacamole.setScreen({
            computerId,
            // Cast, not re-validation: the procedure's zod schema is the single
            // gate and rejects a non-integer as a 400 before anything reaches
            // the Worker. `NaN` is deliberately passed through to it rather
            // than coerced here — a client that measured nothing should get a
            // BAD_REQUEST, not a silently invented screen.
            width: width as number,
            height: height as number,
        });

        return shellJson(result);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/screen');
    }
}
