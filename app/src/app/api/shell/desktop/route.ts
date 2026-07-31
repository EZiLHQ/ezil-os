import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/desktop` — start a computer's desktop, and poll whether it is up.
 *
 * 🔴 `maxDuration` is NOT inherited from any platform default
 * (docs/PLATFORM-NOTES.md §13). A cold container boot is ~22-24s measured
 * (§11) and `requestGuacamolePreview` carries a 210s client budget
 * (`SANDBOX_COLD_START_TIMEOUT_MS` = 180s worker wait + 30s margin), so a
 * route left on the platform default is killed at 10-15s — long before the
 * desktop it is waiting for exists. The user would see a hard failure on
 * every single cold start, and a retry would fail identically. 300s is the
 * same value, for the same reason, as `src/app/api/trpc/[trpc]/route.ts`.
 *
 * Like `../session/route.ts` this is a TRANSPORT only. Ownership is checked
 * exactly once, inside `cloudflareGuacamole.previewUrl` / `.status`, which
 * derive the sandbox id from the AUTHENTICATED user id plus an
 * ownership-verified computer id. The Worker URL and HMAC secret never leave
 * the server; the browser receives only the opaque preview URL.
 *
 *   GET  ?computerId=... — cheap status poll. Does NOT wake a sleeping
 *                          container. Safe to call every 2s while a boot is
 *                          in flight, which is the one real mid-boot signal
 *                          the shell has (see `boot-phases`).
 *   GET  ?computerId=...&confirm=frame&frameUrl=...
 *                        — the POST-HANDOFF check. Asks the desktop origin
 *                          itself, over HTTP, whether it is serving. This is
 *                          the only signal that can tell a desktop from a 500
 *                          error page: the status poll above reads Durable
 *                          Object state and never crosses the edge, and the
 *                          iframe's `load` event fires for both. Also cheap —
 *                          one GET to an edge hostname, no Worker call, no
 *                          container wake.
 *   POST { computerId }  — the long one. Starts/attaches the desktop and
 *                          resolves only at the end, success or a specific
 *                          error.
 *
 * Input is deliberately NOT re-validated here: it is forwarded as given and
 * the procedures' own zod schemas reject anything malformed, surfacing as a
 * 400. One validation implementation, same as one authorization
 * implementation.
 */
export const maxDuration = 300;

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

/**
 * Cheap health poll for a computer's sandbox — or, with `confirm=frame`, the
 * post-handoff check that the desktop origin is really serving. Neither wakes
 * a container.
 */
export async function GET(req: Request) {
    try {
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        const params = new URL(req.url).searchParams;
        const computerId = params.get('computerId') ?? '';

        if (params.get('confirm') === 'frame') {
            // `frameUrl` is client-supplied and is pinned server-side to this
            // user's own sandbox origin inside the procedure — see
            // `isOwnDesktopOrigin`. Forwarded as given, like every other input
            // on this route: the procedure's zod schema is the one validator.
            const confirmation = await caller.cloudflareGuacamole.confirmFrame({
                computerId,
                frameUrl: params.get('frameUrl') ?? '',
            });
            return shellJson({ ok: true, ...confirmation });
        }

        const status = await caller.cloudflareGuacamole.status({ computerId });

        return shellJson(status);
    } catch (err) {
        return shellErrorResponse(err, 'GET /api/shell/desktop');
    }
}

/**
 * Start (or attach to) the computer's desktop and return its preview URL.
 * This is the request that can take ~22s cold — see `maxDuration` above.
 */
export async function POST(req: Request) {
    try {
        // Authenticate BEFORE parsing the body. An unauthenticated caller
        // should learn exactly one thing — that they are not signed in — not
        // whether their JSON happened to be well-formed.
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        let body: unknown;
        try {
            body = await req.json();
        } catch {
            return shellJson({ error: { code: 'BAD_REQUEST', message: 'Expected a JSON body.' } }, 400);
        }

        const { computerId = '', sessionId } = (body ?? {}) as {
            computerId?: string;
            sessionId?: string;
        };

        const preview = await caller.cloudflareGuacamole.previewUrl({
            // The session id is a correlation key only. Defaulting it to the
            // computer id matches what `/computer/[id]` already passes, so the
            // shell path and the fallback path correlate identically in logs.
            sessionId: sessionId ?? computerId,
            computerId,
        });

        return shellJson(preview);
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/desktop');
    }
}
