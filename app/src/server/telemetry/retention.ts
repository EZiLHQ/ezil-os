/**
 * Retention. An unbounded error table living on the same Postgres the
 * product runs on is its own outage (design §7.2) — this module is that
 * statement turned into code, run hourly by
 * `src/app/api/cron/telemetry-maintenance/route.ts`.
 *
 * Every delete here is CHUNKED, never a single unbounded `DELETE`: a
 * million-row delete on a shared transaction-pooler connection is exactly
 * the outage this file exists to prevent. Each prune function loops,
 * re-issuing a small bounded `DELETE ... LIMIT n` until either it deletes
 * zero rows (done) or a wall-clock budget is spent (the next hourly run
 * continues where this one left off).
 */
import { sql } from 'drizzle-orm';

export interface RetentionDb {
    execute(query: ReturnType<typeof sql>): Promise<unknown>;
}

export const RETENTION_DAYS_EVENTS = 14;
export const RETENTION_DAYS_USER_HOURS = 90;
export const STALE_FINGERPRINT_YEARS = 1;
export const STALE_FINGERPRINT_MAX_COUNT = 10;
export const DEFAULT_CHUNK_SIZE = 5000;
export const DEFAULT_BUDGET_MS = 20_000;

function rowsOf(result: unknown): unknown[] {
    if (Array.isArray(result)) return result;
    const withRows = result as { rows?: unknown[] };
    return withRows?.rows ?? [];
}

export interface PruneResult {
    deletedRows: number;
    /** `true` if the wall-clock budget ran out before a zero-row delete —
     * i.e. more remains, and the next scheduled run will continue. Never a
     * failure by itself. */
    hitBudget: boolean;
}

/**
 * Delete `ezil_error_events` rows older than `retentionDays`, oldest first,
 * `chunkSize` at a time, until either nothing is left to delete or
 * `budgetMs` of wall clock has been spent.
 */
export async function pruneErrorEvents(
    db: RetentionDb,
    opts: { retentionDays?: number; chunkSize?: number; budgetMs?: number } = {},
): Promise<PruneResult> {
    const retentionDays = opts.retentionDays ?? RETENTION_DAYS_EVENTS;
    const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    const start = Date.now();
    let deletedRows = 0;

    for (;;) {
        if (Date.now() - start > budgetMs) return { deletedRows, hitBudget: true };
        const result = await db.execute(sql`
            DELETE FROM ezil_error_events
            WHERE event_id IN (
                SELECT event_id FROM ezil_error_events
                WHERE received_at < now() - (${retentionDays} || ' days')::interval
                ORDER BY received_at
                LIMIT ${chunkSize}
            )
            RETURNING event_id
        `);
        const rows = rowsOf(result);
        deletedRows += rows.length;
        if (rows.length === 0) return { deletedRows, hitBudget: false };
    }
}

/** Same chunked-loop shape as `pruneErrorEvents`, for the 90-day rollup. */
export async function pruneUserHours(
    db: RetentionDb,
    opts: { retentionDays?: number; chunkSize?: number; budgetMs?: number } = {},
): Promise<PruneResult> {
    const retentionDays = opts.retentionDays ?? RETENTION_DAYS_USER_HOURS;
    const chunkSize = opts.chunkSize ?? DEFAULT_CHUNK_SIZE;
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    const start = Date.now();
    let deletedRows = 0;

    for (;;) {
        if (Date.now() - start > budgetMs) return { deletedRows, hitBudget: true };
        const result = await db.execute(sql`
            DELETE FROM ezil_error_user_hours
            WHERE (fingerprint, hour_bucket, user_hash) IN (
                SELECT fingerprint, hour_bucket, user_hash FROM ezil_error_user_hours
                WHERE hour_bucket < now() - (${retentionDays} || ' days')::interval
                ORDER BY hour_bucket
                LIMIT ${chunkSize}
            )
            RETURNING fingerprint
        `);
        const rows = rowsOf(result);
        deletedRows += rows.length;
        if (rows.length === 0) return { deletedRows, hitBudget: false };
    }
}

/**
 * `ezil_error_fingerprints` is permanent EXCEPT rows that are both stale
 * (unseen for a year) AND low-volume (fewer than 10 events ever) — a
 * one-off blip nobody needs remembered forever. Design §7.2's population is
 * "hundreds of rows"; a single unchunked delete is fine at that scale, but
 * still capped defensively.
 */
export async function pruneStaleFingerprints(
    db: RetentionDb,
    opts: { staleYears?: number; maxTotalCount?: number; cap?: number } = {},
): Promise<PruneResult> {
    const staleYears = opts.staleYears ?? STALE_FINGERPRINT_YEARS;
    const maxTotalCount = opts.maxTotalCount ?? STALE_FINGERPRINT_MAX_COUNT;
    const cap = opts.cap ?? DEFAULT_CHUNK_SIZE;
    const result = await db.execute(sql`
        DELETE FROM ezil_error_fingerprints
        WHERE fingerprint IN (
            SELECT fingerprint FROM ezil_error_fingerprints
            WHERE last_seen_at < now() - (${staleYears} || ' years')::interval
              AND total_count < ${maxTotalCount}
            LIMIT ${cap}
        )
        RETURNING fingerprint
    `);
    return { deletedRows: rowsOf(result).length, hitBudget: false };
}

/** Refreshes `pg_class.reltuples` for `ezil_error_events` — the estimate
 * `../load-shed.ts`'s circuit breaker reads. Run this AFTER pruning so the
 * breaker's view of "how full is this table" stays current. */
export async function analyzeErrorEvents(db: RetentionDb): Promise<void> {
    await db.execute(sql`ANALYZE ezil_error_events`);
}

export interface MaintenanceResult {
    events: PruneResult;
    userHours: PruneResult;
    fingerprints: PruneResult;
}

/**
 * The whole hourly job, in order: roll up is NOT done here (`ingestBatch`
 * already keeps the current hour's rollup live on every write, per design
 * §4.5 statement 3 — there is nothing separate to "catch up"), so this is
 * prune events -> prune rollup -> prune stale fingerprints -> re-ANALYZE.
 */
export async function runTelemetryMaintenance(db: RetentionDb): Promise<MaintenanceResult> {
    const events = await pruneErrorEvents(db);
    const userHours = await pruneUserHours(db);
    const fingerprints = await pruneStaleFingerprints(db);
    await analyzeErrorEvents(db);
    return { events, userHours, fingerprints };
}
