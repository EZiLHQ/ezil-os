import { after } from 'next/server';

import { createTRPCContext } from '@/server/api/trpc';
import { handleTelemetryPost } from '@/server/telemetry/http-handler';

/**
 * `POST /api/shell/telemetry` — a batch of crash/error telemetry events.
 *
 * Per `docs/telemetry-design.md` §4.4-4.6. This route is reachable by
 * anyone with a session and accepts arbitrary client-controlled JSON, so it
 * is treated as a hostile-input surface: every bound (body size, event
 * count, per-user rate, global row-count) is enforced in
 * `@/server/telemetry/http-handler.ts` and its dependencies, not here.
 *
 * 🔴 ALWAYS 202, whatever happens — unauthenticated, malformed body,
 * over-limit, rate-limited, load-shed active, or a downstream Postgres
 * outage all look identical to the caller: `null` body, `202`,
 * `cache-control: no-store`. The client has nothing to branch on, so no
 * telemetry response can ever change product behaviour, and a client bug
 * that "helpfully" started reading this response would learn nothing
 * useful anyway.
 *
 * `maxDuration = 10`: deliberately SHORT, the opposite of `../desktop/route.ts`.
 * The actual Postgres write happens in `after()` — AFTER this response is
 * flushed — so this handler's own work is just: verify a session, read a
 * bounded body, validate it, and check two cheap in-memory/cached gates.
 * None of that should ever approach 10s; if it does, something upstream
 * (the Supabase auth round trip) is broken in a way a longer budget would
 * only hide.
 *
 * No `@trpc/client` involved, same as every other `/api/shell/*` handler —
 * this is a transport only, and `createTRPCContext` is the one place a
 * session is resolved.
 */
export const maxDuration = 10;

export async function POST(req: Request): Promise<Response> {
    return handleTelemetryPost(req, {
        getContext: async (request) => {
            const headers = new Headers(request.headers);
            headers.set('x-trpc-source', 'shell-http');
            const ctx = await createTRPCContext({ headers });
            return { user: ctx.user, db: ctx.db };
        },
        schedule: after,
    });
}
