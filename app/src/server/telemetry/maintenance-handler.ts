/**
 * The testable core of `POST /api/cron/telemetry-maintenance`. Separated
 * from `src/app/api/cron/telemetry-maintenance/route.ts` for the same
 * reason as `./http-handler.ts`: keeping `@/env` (which eagerly validates
 * and throws on a missing `SUPABASE_DATABASE_URL`) and a live Postgres
 * connection out of the import graph a unit test exercises.
 *
 * FAIL CLOSED, twice over:
 *   1. If `CRON_SECRET` is not configured at all, the route 404s — a
 *      deploy that forgot to set the secret cannot expose a delete
 *      endpoint to the internet (design §7.2).
 *   2. A present-but-wrong bearer token ALSO 404s, not 401 — a 401 would
 *      confirm to a prober that the route exists and merely needs the
 *      right secret; 404 makes "misconfigured" and "not yours to call"
 *      indistinguishable from the outside.
 */
import { runTelemetryMaintenance, type MaintenanceResult, type RetentionDb } from './retention';

const NOT_FOUND = (): Response => new Response(null, { status: 404 });

export interface MaintenanceHandlerDeps {
    cronSecret: string | undefined;
    db: RetentionDb;
}

export interface MaintenanceResponseBody {
    ok: boolean;
    result?: MaintenanceResult;
}

export async function handleTelemetryMaintenance(req: Request, deps: MaintenanceHandlerDeps): Promise<Response> {
    if (!deps.cronSecret) return NOT_FOUND();
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${deps.cronSecret}`) return NOT_FOUND();

    try {
        const result = await runTelemetryMaintenance(deps.db);
        const body: MaintenanceResponseBody = { ok: true, result };
        return Response.json(body);
    } catch (err) {
        console.error('[telemetry] maintenance run failed', { m: String((err as Error)?.message ?? err) });
        const body: MaintenanceResponseBody = { ok: false };
        return Response.json(body, { status: 500 });
    }
}
