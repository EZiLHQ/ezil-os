import { appRouter } from '@/server/api/root';
import { createTRPCContext } from '@/server/api/trpc';
import {
    SHELL_APPS,
    buildShellBootPayload,
    toShellBootComputer,
    toShellDesktopState,
    type ShellSessionPayload,
} from '@/server/shell/boot-payload';
import { shellErrorResponse, shellJson, shellUnauthenticated } from '@/server/shell/http';

/**
 * `/api/shell/session` — who the shell is, and which computer it owns.
 *
 * A plain Route Handler because the caller is a jQuery bundle. It is a
 * TRANSPORT, not a second authorization implementation: it resolves
 * everything through `appRouter.createCaller`, so `protectedProcedure` and
 * the ownership-scoped row filters are the same single gate `/api/trpc` uses.
 * Nothing here decides who may do what. That is also why the shell does not
 * ship `@trpc/client` + `superjson` — one authorization implementation, two
 * transports, and this one speaks plain JSON.
 *
 *   GET  — read the current session. NEVER writes; `computer` is `null` for a
 *          user who has none. This is the safe one to poll or prefetch.
 *   POST — get-or-create. `computer` is always present. Idempotent: a user
 *          with a computer gets the same one back, and a concurrent double
 *          POST resolves to one row (see `computer.getOrCreateDefault`).
 *
 * No `maxDuration` override on purpose: nothing on this path talks to a
 * container. It is one Supabase auth round trip and one indexed query, and
 * the platform default is ample. The route that DOES need a longer budget is
 * `../desktop/route.ts`, which declares it explicitly.
 */

async function shellCaller(req: Request) {
    const headers = new Headers(req.headers);
    // `/api/trpc` tags its own callers; `src/trpc/server.ts` tags RSC as
    // 'rsc'. Tag this honestly rather than borrowing either label.
    headers.set('x-trpc-source', 'shell-http');
    const ctx = await createTRPCContext({ headers });
    return { ctx, caller: appRouter.createCaller(ctx) };
}

/** Read the session. Never writes — a user with no computer gets `computer: null`. */
export async function GET(req: Request) {
    try {
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        const [computers, provider] = await Promise.all([
            caller.computer.list(),
            caller.cloudflareGuacamole.isConfigured(),
        ]);

        // `computer.list` is already ordered by slot ascending, so the first
        // row IS the default computer — the same one POST would return.
        const lowest = computers[0];

        const payload: ShellSessionPayload = {
            user: { id: ctx.user.id, email: ctx.user.email ?? null },
            computer: lowest ? toShellBootComputer(lowest, false) : null,
            apps: SHELL_APPS,
            desktopState: toShellDesktopState(provider),
        };

        return shellJson(payload);
    } catch (err) {
        return shellErrorResponse(err, 'GET /api/shell/session');
    }
}

/** Get-or-create the caller's default computer and return the full boot payload. */
export async function POST(req: Request) {
    try {
        const { ctx, caller } = await shellCaller(req);
        if (!ctx.user) return shellUnauthenticated();

        const [result, provider] = await Promise.all([
            caller.computer.getOrCreateDefault(),
            caller.cloudflareGuacamole.isConfigured(),
        ]);

        return shellJson(
            buildShellBootPayload({
                user: ctx.user,
                computer: result.computer,
                isNew: result.created,
                provider,
            }),
        );
    } catch (err) {
        return shellErrorResponse(err, 'POST /api/shell/session');
    }
}
