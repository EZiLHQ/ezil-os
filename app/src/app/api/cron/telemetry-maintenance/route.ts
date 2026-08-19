import { db } from '@/server/db';
import { env } from '@/env';
import { mintSandboxPreviewToken } from '@/server/lib/cloudflare-guacamole-provider';
import { handleTelemetryMaintenance } from '@/server/telemetry/maintenance-handler';
import { createDrainTransportFromEnv } from '@/server/telemetry/spool-drain-transport';

/**
 * `GET /api/cron/telemetry-maintenance` — the ONE telemetry cron. It runs two
 * independent daily jobs, in this order:
 *
 *   1. **Retention** (`runTelemetryMaintenance`, `@/server/telemetry/retention.ts`):
 *      prune `ezil_error_events` past 14 days, prune `ezil_error_user_hours`
 *      past 90 days, prune stale low-volume `ezil_error_fingerprints`, then
 *      `ANALYZE ezil_error_events` so `@/server/telemetry/load-shed.ts`'s
 *      circuit breaker reads a fresh row estimate. Every prune is CHUNKED
 *      against a wall-clock budget — see `retention.ts`'s doc comment — so a
 *      large backlog spreads across several scheduled runs instead of one long
 *      transaction.
 *   2. **The R2 spool drain** (`runTelemetrySpoolDrain`,
 *      `@/server/telemetry/spool-drain.ts`): pull the Worker's
 *      `ezil-telemetry-spool` objects through `POST /telemetry/drain` +
 *      `/telemetry/ack` and ingest them, which is the ONLY path by which a
 *      `source='worker'` or `source='container'` row ever reaches Postgres.
 *
 * ⚠️ 🔴 WHY THE DRAIN IS HERE AND NOT ON ITS OWN CRON. `vercel.json` used to
 * declare three crons. The plan permits two. `telemetry-drain` (`43 3 * * *`)
 * is the one that stopped being invoked: zero hour-03 Worker requests from it
 * since 2026-08-09, while `sandbox-reap` (`8 4 * * *`) and this route
 * (`17 3 * * *`) both kept firing — this route demonstrably so, since the raw
 * table's retention boundary tracks the clock exactly. Every other hop of the
 * drain was verified working. So the fix is not to schedule the drain
 * better, it is to stop needing a third schedule at all.
 * `/api/cron/telemetry-drain` still exists and still works, for manual runs.
 *
 * The two jobs cannot break each other — `handleTelemetryMaintenance` awaits
 * each in its own `try` and reports both. See that module's header.
 *
 * Guarded by `CRON_SECRET` (`@/env.ts`): unset -> 404, wrong/missing bearer
 * -> 404. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
 * automatically once the env var and `vercel.json`'s cron entry are both
 * configured on the project.
 *
 * 🔴 `maxDuration` RAISED FROM 90 TO 300 because this invocation now carries
 * both jobs, and `maxDuration` is not inherited (docs/PLATFORM-NOTES.md §13).
 * The arithmetic, deliberately stated rather than guessed:
 *   - retention: 3 chunked prunes at a 20 s budget each + one ANALYZE ≈ 90 s,
 *     which is exactly what this route budgeted before;
 *   - drain: `DEFAULT_DRAIN_BUDGET_MS` (150 s) caps when a new page may START,
 *     and one page can then run for at most `DRAIN_REQUEST_TIMEOUT_MS` (20 s)
 *     plus its ingest — call it 170 s.
 * 90 + 170 = 260 s, inside 300 with room, and 300 is the value every other
 * long route in this app already declares. The drain's clock — not its page
 * count — is what makes that bound real: 10 pages × 20 s would be 200 s on its
 * own and no page count can express "be finished by then".
 */
export const maxDuration = 300;

/**
 * GET, not POST: Vercel Cron Jobs invoke their configured path with a GET
 * request (see `vercel.json`), and design §4's worker-drain diagram writes
 * this same path as `GET /api/cron/telemetry-maintenance` — so a Worker
 * `scheduled()` fallback can hit it the same way with a plain `fetch()`, no
 * method mismatch to remember.
 */
export async function GET(req: Request): Promise<Response> {
    const transport = createDrainTransportFromEnv(env, mintSandboxPreviewToken);
    return handleTelemetryMaintenance(req, {
        cronSecret: env.CRON_SECRET,
        db,
        drain: { db, drainPage: transport.drainPage, ack: transport.ack },
    });
}
