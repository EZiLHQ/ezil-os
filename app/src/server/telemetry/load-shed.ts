/**
 * The leading control. Retention (`./retention.ts`) is a LAGGING control —
 * it runs hourly. This is the ingest-path circuit breaker: above a row
 * ceiling on `ezil_error_events`, new batches are silently dropped (the
 * route still returns 202 — see `../../app/api/shell/telemetry/route.ts`)
 * rather than accepted and written. Telemetry sheds itself before it sheds
 * the product (design §7.3).
 *
 * The estimate is `pg_class.reltuples` — the PLANNER's row-count estimate,
 * refreshed by the last `ANALYZE` (which the retention job runs after every
 * prune, §7.2), NOT a live `count(*)`. That is the point: a live count scans
 * the table, which is exactly the kind of load a system already near its
 * ceiling cannot afford. `reltuples` can be stale by up to an hour; being
 * wrong in the direction of "sheds a little later than ideal" is the safe
 * failure mode here, "makes ingest itself slow" is not.
 */
import { sql } from 'drizzle-orm';

export const SHED_ABOVE_ROWS = 2_000_000;

/** How long a cached row estimate is trusted before it is refreshed. */
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;

export interface RowEstimateDb {
    execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

let cachedRowEstimate = 0;
let cachedAt = 0;
/** Guards against a burst of concurrent requests each kicking off their own
 * refresh query the moment the cache goes stale. */
let refreshInFlight: Promise<void> | null = null;

async function refresh(db: RowEstimateDb): Promise<void> {
    try {
        const result = (await db.execute(
            sql`select reltuples::bigint as estimate from pg_class where relname = 'ezil_error_events'`,
        )) as unknown as { rows?: Array<{ estimate: string | number }> } | Array<{ estimate: string | number }>;
        const rows = Array.isArray(result) ? result : (result?.rows ?? []);
        const estimate = rows[0]?.estimate;
        if (estimate !== undefined) cachedRowEstimate = Number(estimate);
        cachedAt = Date.now();
    } catch {
        // A failed estimate refresh must never block ingest. Keep serving
        // the last known value (or 0, pre-warm) until the next window.
        cachedAt = Date.now();
    }
}

/**
 * `true` when the batch about to be written should instead be dropped.
 * Fire-and-forgets its own refresh (never awaited by the caller) once per
 * `REFRESH_INTERVAL_MS`, so a slow `pg_class` read never adds latency to the
 * request that triggered it — the DECISION always uses the last cached
 * value, even the very first time (starts at 0, i.e. "never shed" until the
 * first refresh completes).
 */
export function shouldShedLoad(db: RowEstimateDb): boolean {
    if (Date.now() - cachedAt > REFRESH_INTERVAL_MS && !refreshInFlight) {
        refreshInFlight = refresh(db).finally(() => {
            refreshInFlight = null;
        });
    }
    return cachedRowEstimate > SHED_ABOVE_ROWS;
}

/** Test-only: force the module's cached state back to its cold-start shape. */
export function resetLoadShedCacheForTests(): void {
    cachedRowEstimate = 0;
    cachedAt = 0;
    refreshInFlight = null;
}

/** Test-only: seed the cache directly, bypassing the async refresh path. */
export function setLoadShedCacheForTests(rowEstimate: number, ageMs = 0): void {
    cachedRowEstimate = rowEstimate;
    cachedAt = Date.now() - ageMs;
}
