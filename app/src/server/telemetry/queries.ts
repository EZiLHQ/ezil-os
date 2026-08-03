/**
 * The four aggregation queries from `scratchpad/telemetry-design.md` §6, as
 * real parameterised Drizzle `sql` templates rather than only prose SQL a
 * human pastes into the Supabase editor during an incident. Each function
 * still reads as plain SQL (deliberately) so that pasting one into the SQL
 * editor and this file never drift apart in intent.
 *
 * `QueryDb` is the narrowest possible `Pick<>` — just `execute` — of
 * Drizzle's generic `PgDatabase`, exercised in tests via `drizzle-orm/pg-proxy`
 * so every assertion is about the actual SQL text, not a mock's call log.
 */
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '@/server/db/schema';

export type QueryDb = Pick<
    PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>,
    'execute'
>;

/** Unwraps whatever shape `db.execute()` returns across drivers
 * (`postgres-js` gives an array-like with `.rows`-free rows directly under
 * some configs; `pg-proxy` returns `{ rows }`) into a plain row array. */
function rowsOf<T>(result: unknown): T[] {
    if (Array.isArray(result)) return result as T[];
    const withRows = result as { rows?: T[] };
    return withRows?.rows ?? [];
}

// ── Q1 — distinct users per fingerprint per window ──────────────────────────
// "How many distinct users hit THIS error in the last N hours?" — the
// owner's actual question, and the reason `idx_ezil_error_events_fp_time_user`
// exists: this is an index-only scan on (fingerprint, received_at, user_hash).

export interface FingerprintWindowStats {
    distinctUsers: number;
    events: number;
    firstInWindow: string | null;
    lastInWindow: string | null;
}

export async function distinctUsersForFingerprint(
    db: QueryDb,
    fingerprint: string,
    windowHours = 1,
): Promise<FingerprintWindowStats> {
    const result = await db.execute(sql`
        SELECT count(DISTINCT user_hash)::int AS "distinctUsers",
               count(*)::int                  AS events,
               min(received_at)               AS "firstInWindow",
               max(received_at)               AS "lastInWindow"
        FROM   ezil_error_events
        WHERE  fingerprint = ${fingerprint}
          AND  received_at >= now() - (${windowHours} || ' hours')::interval
    `);
    const row = rowsOf<FingerprintWindowStats>(result)[0];
    return row ?? { distinctUsers: 0, events: 0, firstInWindow: null, lastInWindow: null };
}

export interface LeaderboardRow {
    fingerprint: string;
    eventClass: string;
    source: string;
    site: string;
    code: string;
    normalizedDetail: string | null;
    distinctUsers: number;
    events: number;
    lastSeen: string;
    firstSeenAt: string;
}

/** "What is hurting the most people right now?" — the fleet-wide leaderboard,
 * within the raw-retention window. Muted fingerprints are excluded. */
export async function fingerprintLeaderboard(
    db: QueryDb,
    opts: { windowHours?: number; limit?: number } = {},
): Promise<LeaderboardRow[]> {
    const windowHours = opts.windowHours ?? 1;
    const limit = Math.min(opts.limit ?? 50, 200);
    const result = await db.execute(sql`
        SELECT e.fingerprint,
               f.event_class AS "eventClass", f.source, f.site, f.code,
               f.normalized_detail AS "normalizedDetail",
               count(DISTINCT e.user_hash)::int AS "distinctUsers",
               count(*)::int                    AS events,
               max(e.received_at)               AS "lastSeen",
               f.first_seen_at                  AS "firstSeenAt"
        FROM   ezil_error_events e
        JOIN   ezil_error_fingerprints f USING (fingerprint)
        WHERE  e.received_at >= now() - (${windowHours} || ' hours')::interval
          AND  e.outcome = 'error'
          AND  f.muted_at IS NULL
        GROUP  BY e.fingerprint, f.event_class, f.source, f.site, f.code,
                  f.normalized_detail, f.first_seen_at
        ORDER  BY "distinctUsers" DESC, events DESC
        LIMIT  ${limit}
    `);
    return rowsOf<LeaderboardRow>(result);
}

export interface RollupLeaderboardRow {
    fingerprint: string;
    distinctUsers: number;
    events: number;
}

/** Same question as `fingerprintLeaderboard`, but from the hour-rollup table
 * — EXACT (not estimated) distinct-user counts beyond the raw-retention
 * horizon, since raw events are pruned but the rollup is kept 90 days. */
export async function fingerprintLeaderboardFromRollup(
    db: QueryDb,
    opts: { days?: number; limit?: number } = {},
): Promise<RollupLeaderboardRow[]> {
    const days = opts.days ?? 90;
    const limit = Math.min(opts.limit ?? 50, 200);
    const result = await db.execute(sql`
        SELECT fingerprint,
               count(DISTINCT user_hash)::int AS "distinctUsers",
               sum(event_count)::int          AS events
        FROM   ezil_error_user_hours
        WHERE  hour_bucket >= now() - (${days} || ' days')::interval
        GROUP  BY fingerprint
        ORDER  BY "distinctUsers" DESC
        LIMIT  ${limit}
    `);
    return rowsOf<RollupLeaderboardRow>(result);
}

// ── Q2 — error rate over time ────────────────────────────────────────────────
// The denominator is EVERY user who sent anything in that hour, including a
// successful `boot_summary` — that is why boot_summary is emitted on success
// too (see the worker-side design), without it there is no denominator and
// "error rate" degenerates into "error count", which just tracks signups.

export interface ErrorRateBucket {
    hour: string;
    errors: number;
    usersWithErrors: number;
    usersReporting: number;
    pctUsersAffected: number | null;
}

export async function errorRateOverTime(
    db: QueryDb,
    opts: { hours?: number; eventClass?: string } = {},
): Promise<ErrorRateBucket[]> {
    const hours = opts.hours ?? 48;
    // The class filter MUST live in the JOIN condition, not the WHERE clause
    // — a WHERE predicate on the outer side of a LEFT JOIN turns it back
    // into an INNER JOIN and silently drops the zero-error hours, which are
    // exactly the ones that prove a fix worked.
    const classFilter = opts.eventClass ? sql`AND e.event_class = ${opts.eventClass}` : sql``;
    const result = await db.execute(sql`
        WITH buckets AS (
          SELECT generate_series(
                   date_trunc('hour', now()) - (${hours - 1} || ' hours')::interval,
                   date_trunc('hour', now()),
                   interval '1 hour'
                 ) AS h
        )
        SELECT b.h AS hour,
               count(*) FILTER (WHERE e.outcome = 'error')::int                    AS errors,
               count(DISTINCT e.user_hash) FILTER (WHERE e.outcome = 'error')::int AS "usersWithErrors",
               count(DISTINCT e.user_hash)::int                                    AS "usersReporting",
               round(100.0 * count(DISTINCT e.user_hash) FILTER (WHERE e.outcome = 'error')
                     / nullif(count(DISTINCT e.user_hash), 0), 1)                   AS "pctUsersAffected"
        FROM   buckets b
        LEFT   JOIN ezil_error_events e
               ON e.received_at >= b.h AND e.received_at < b.h + interval '1 hour'
               ${classFilter}
        GROUP  BY b.h
        ORDER  BY b.h
    `);
    return rowsOf<ErrorRateBucket>(result);
}

// ── Q3 — is this error spiking? ──────────────────────────────────────────────
// Compares the last hour to the SAME hour-of-day over the previous 7 days
// (from the rollup, so pruning of raw events doesn't blind this), so a
// nightly batch job or a timezone traffic peak doesn't read as a regression.
// A brand-new fingerprint needs >= 3 distinct users before it counts as a
// spike — one user with a broken extension is not an outage.

export interface SpikeRow {
    fingerprint: string;
    site: string;
    code: string;
    normalizedDetail: string | null;
    usersNow: number;
    baselineMean: number;
    baselineSd: number;
    sampleHours: number;
    z: number;
    isNew: boolean;
}

export async function spikeDetection(db: QueryDb): Promise<SpikeRow[]> {
    const result = await db.execute(sql`
        WITH recent AS (
          SELECT fingerprint, count(DISTINCT user_hash)::numeric AS users
          FROM   ezil_error_events
          WHERE  received_at >= now() - interval '1 hour' AND outcome = 'error'
          GROUP  BY fingerprint
        ),
        baseline AS (
          SELECT fingerprint,
                 avg(users)                       AS mean_users,
                 coalesce(stddev_samp(users), 0)   AS sd_users,
                 count(*)                          AS sample_hours
          FROM (
            SELECT fingerprint, hour_bucket, count(*)::numeric AS users
            FROM   ezil_error_user_hours
            WHERE  hour_bucket >= now() - interval '7 days'
              AND  hour_bucket <  date_trunc('hour', now())
              AND  extract(hour FROM hour_bucket AT TIME ZONE 'UTC')
                   = extract(hour FROM now()     AT TIME ZONE 'UTC')
            GROUP  BY fingerprint, hour_bucket
          ) h
          GROUP BY fingerprint
        )
        SELECT r.fingerprint, f.site, f.code, f.normalized_detail AS "normalizedDetail",
               r.users::int                          AS "usersNow",
               round(coalesce(b.mean_users, 0), 2)::float AS "baselineMean",
               round(coalesce(b.sd_users, 0), 2)::float   AS "baselineSd",
               coalesce(b.sample_hours, 0)::int            AS "sampleHours",
               round((r.users - coalesce(b.mean_users, 0))
                     / greatest(coalesce(b.sd_users, 0), 1), 2)::float AS z,
               (b.fingerprint IS NULL)              AS "isNew"
        FROM   recent r
        JOIN   ezil_error_fingerprints f ON f.fingerprint = r.fingerprint
        LEFT   JOIN baseline b ON b.fingerprint = r.fingerprint
        WHERE  f.muted_at IS NULL
          AND  ( (b.fingerprint IS NULL AND r.users >= 3)
              OR (r.users - coalesce(b.mean_users, 0))
                 / greatest(coalesce(b.sd_users, 0), 1) >= 3.0 )
        ORDER  BY "isNew" DESC, z DESC
    `);
    return rowsOf<SpikeRow>(result);
}

// ── Q4 — which boot phase fails most ─────────────────────────────────────────
// `site` here is one of the 11 phase names already emitted by
// `worker/scripts/start-neko.sh`, so this answers "where does boot die" in
// the container's own vocabulary, no translation table needed.

export interface BootPhaseFailureRow {
    phase: string;
    failures: number;
    usersAffected: number;
    bootAttempts: number;
    pctOfBoots: number | null;
    avgMsBeforeFailure: number | null;
    mostCommonCode: string | null;
}

export async function bootPhaseFailureRanking(db: QueryDb, hours = 24): Promise<BootPhaseFailureRow[]> {
    const result = await db.execute(sql`
        WITH attempts AS (
          SELECT count(*)::numeric AS n
          FROM   ezil_error_events
          WHERE  event_class = 'boot_summary'
            AND  received_at >= now() - (${hours} || ' hours')::interval
        )
        SELECT p.site                                AS phase,
               count(*)::int                          AS failures,
               count(DISTINCT p.user_hash)::int        AS "usersAffected",
               (SELECT n FROM attempts)::int           AS "bootAttempts",
               round(100.0 * count(*) / nullif((SELECT n FROM attempts), 0), 2)::float AS "pctOfBoots",
               round(avg(p.duration_ms))::float        AS "avgMsBeforeFailure",
               mode() WITHIN GROUP (ORDER BY p.code)   AS "mostCommonCode"
        FROM   ezil_error_events p
        WHERE  p.event_class = 'boot_phase'
          AND  p.outcome = 'error'
          AND  p.received_at >= now() - (${hours} || ' hours')::interval
        GROUP  BY p.site
        ORDER  BY failures DESC
    `);
    return rowsOf<BootPhaseFailureRow>(result);
}
