/**
 * The testable core of `GET /api/cron/telemetry-maintenance`. Separated
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
 *
 * ── THREE JOBS, ONE CRON ────────────────────────────────────────────────────
 * This handler runs telemetry retention, feedback retention, and, when
 * `deps.drain` is supplied, the R2 telemetry spool drain.
 *
 * 🔴 That is not tidiness, it is the fix for a 16-day outage. `app/vercel.json`
 * declared THREE crons; the plan permits two, and the one that stopped being
 * invoked was `telemetry-drain` — Cloudflare's invocation analytics show zero
 * hour-03 Worker requests from it since 2026-08-09, while `sandbox-reap` and
 * this route both kept firing on schedule. Rather than argue about which cron
 * a platform silently dropped, the drain is folded into the job that is
 * PROVEN to run, and `vercel.json` is back to two entries. Both jobs are
 * daily, both already authenticate with the same `CRON_SECRET`, and neither
 * needs the other's output.
 *
 * 🔴 THE JOBS ARE ISOLATED FROM EACH OTHER, and that is the whole point
 * of running them here rather than chaining one route's handler into another's.
 * Each is awaited inside its own `try`, so:
 *   - either retention job throwing does not stop the other or the drain;
 *   - the drain throwing does not undo or hide retention that already ran;
 *   - the response body reports every outcome, and `failed` names whichever
 *     job broke, so "the drain is down" can never again look like "the cron
 *     did nothing".
 * They run in sequence, not concurrently: all write to the same Postgres and
 * the retention prunes are already chunked against a wall-clock budget —
 * interleaving them would double the connection pressure for no gain, and the
 * drain's own budget (`DEFAULT_DRAIN_BUDGET_MS`) assumes it starts after
 * retention has finished. Feedback shares one 20-second budget across all
 * three stores, within the existing route's 300-second execution allowance.
 */
import { feedbackTablesPresent, runFeedbackRetention, type FeedbackRetentionResult } from '../feedback/retention';
import { runTelemetryMaintenance, type MaintenanceResult, type RetentionDb } from './retention';
import { runTelemetrySpoolDrain, type SpoolDrainEngineDeps, type SpoolDrainResult } from './spool-drain';

const NOT_FOUND = (): Response => new Response(null, { status: 404 });

export interface MaintenanceHandlerDeps {
    cronSecret: string | undefined;
    db: RetentionDb;
    /**
     * When present, the R2 spool drain runs after retention, in the same
     * invocation. Feedback retention always runs, including without a drain.
     */
    drain?: SpoolDrainEngineDeps;
}

/** Which jobs threw. Absent when nothing did. */
export type MaintenanceFailure = 'maintenance' | 'feedback' | 'drain';

export interface MaintenanceResponseBody {
    /** `true` only when every job that was asked to run finished without throwing. */
    ok: boolean;
    result?: MaintenanceResult;
    feedback?: FeedbackRetentionResult;
    drain?: SpoolDrainResult;
    failed?: MaintenanceFailure[];
}

export async function handleTelemetryMaintenance(req: Request, deps: MaintenanceHandlerDeps): Promise<Response> {
    if (!deps.cronSecret) return NOT_FOUND();
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${deps.cronSecret}`) return NOT_FOUND();

    const failed: MaintenanceFailure[] = [];
    const body: MaintenanceResponseBody = { ok: true };

    try {
        body.result = await runTelemetryMaintenance(deps.db);
    } catch (err) {
        console.error('[telemetry] maintenance run failed', { m: String((err as Error)?.message ?? err) });
        failed.push('maintenance');
    }

    // The existing cron carries feedback too: no third Vercel schedule.
    // Each job reports independently, even when an earlier job threw.
    try {
        // Absent tables (SQL not yet registered) are skipped, not a failure.
        body.feedback = await runFeedbackRetention(deps.db, { tables: await feedbackTablesPresent(deps.db) });
    } catch (err) {
        console.error('[feedback] retention run failed', { m: String((err as Error)?.message ?? err) });
        failed.push('feedback');
    }

    if (deps.drain) {
        try {
            body.drain = await runTelemetrySpoolDrain(deps.drain);
        } catch (err) {
            console.error('[telemetry] spool-drain run failed', { m: String((err as Error)?.message ?? err) });
            failed.push('drain');
        }
    }

    if (failed.length === 0) return Response.json(body);
    body.ok = false;
    body.failed = failed;
    return Response.json(body, { status: 500 });
}
