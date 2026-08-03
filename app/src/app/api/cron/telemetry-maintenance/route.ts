import { db } from '@/server/db';
import { env } from '@/env';
import { handleTelemetryMaintenance } from '@/server/telemetry/maintenance-handler';

/**
 * `POST /api/cron/telemetry-maintenance` — the hourly retention job.
 *
 * Runs `runTelemetryMaintenance()` (`@/server/telemetry/retention.ts`):
 * prune `ezil_error_events` past 14 days, prune `ezil_error_user_hours` past
 * 90 days, prune stale low-volume `ezil_error_fingerprints`, then
 * `ANALYZE ezil_error_events` so `@/server/telemetry/load-shed.ts`'s circuit
 * breaker reads a fresh row estimate. Every prune is CHUNKED against a
 * wall-clock budget — see `retention.ts`'s doc comment — so a large backlog
 * spreads across several scheduled runs instead of one long transaction.
 *
 * Guarded by `CRON_SECRET` (`@/env.ts`): unset -> 404, wrong/missing bearer
 * -> 404. Vercel Cron sends `Authorization: Bearer $CRON_SECRET`
 * automatically once the env var and `vercel.json`'s cron entry are both
 * configured on the project.
 *
 * ⚠️ Vercel's Hobby plan only permits DAILY cron schedules, not the hourly
 * cadence `vercel.json` requests. On Hobby this must either run daily (raise
 * the chunk budget / retention margins to tolerate a day's backlog) or be
 * triggered from a Worker `scheduled()` handler hitting this same route with
 * the same bearer instead (`docs/telemetry.md` documents both paths) — the
 * Worker has no `scheduled()` handler today, so that is genuinely new code
 * either way.
 *
 * `maxDuration` set well above the retention job's own 20s-per-prune budget
 * (3 chunked prunes + 1 ANALYZE) to leave headroom for a slow Postgres
 * round trip — deliberately explicit; see docs/PLATFORM-NOTES.md §13
 * ("maxDuration is not inherited").
 */
export const maxDuration = 90;

/**
 * GET, not POST: Vercel Cron Jobs invoke their configured path with a GET
 * request (see `vercel.json`), and design §4's worker-drain diagram writes
 * this same path as `GET /api/cron/telemetry-maintenance` — so a Worker
 * `scheduled()` fallback (see this file's doc comment) can hit it the same
 * way with a plain `fetch()`, no method mismatch to remember.
 */
export async function GET(req: Request): Promise<Response> {
    return handleTelemetryMaintenance(req, { cronSecret: env.CRON_SECRET, db });
}
