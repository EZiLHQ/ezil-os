/**
 * The single writer. Every telemetry producer (shell over HTTP today; a
 * Worker R2-spool drain and a container-log drain are worker-side/future
 * work per `scratchpad/telemetry-design.md` §4.1-4.2) funnels through
 * `ingestBatch`, and this is the only place a `fingerprint` or a
 * `normalizedDetail` is computed for storage.
 *
 * One transaction, three statements: EVENTS, then the fingerprints
 * dimension, then the hour rollup.
 *
 * 🔴 Events first is load-bearing, and is a correction to the order the
 * design sketched (§4.5). The two counter statements derive their increments
 * from what the events insert ACTUALLY STORED (`RETURNING` on
 * `ON CONFLICT DO NOTHING`), because otherwise a re-delivered batch bumps
 * `total_count`/`event_count` for events that were dropped as duplicates and
 * the aggregates drift permanently above the raw table they summarise. That
 * defect passed every mocked test in `ingest.test.ts` and was found only by
 * POSTing the same batch twice at a real Postgres.
 *
 * The dimension is still upserted BEFORE the rollup, because
 * `ezil_error_user_hours` carries a real FK to `ezil_error_fingerprints`.
 * There is deliberately no FK from `ezil_error_events.fingerprint` to the
 * dimension table (see `../db/schema/telemetry.ts`), which is exactly what
 * frees the events insert to go first.
 *
 * `IngestDb` is a narrow `Pick<>` of Drizzle's generic `PgDatabase` (exactly
 * the pattern `computer-store.ts` uses) — this file exercises it entirely
 * with `drizzle-orm/pg-proxy` in tests, no live Postgres required, and the
 * production `ctx.db` (`@/server/db`) satisfies the same type.
 */
import { sql, type ExtractTablesWithRelations } from 'drizzle-orm';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';

import * as schema from '@/server/db/schema';
import { errorEvents, errorFingerprints, errorUserHours } from '@/server/db/schema';
import { fingerprint, normalizeDetail } from './fingerprint';
import { sanitizeAttrs, type ParsedTelemetryEventInput } from './schema';
import { sanitizeErrorMessage } from './sanitize';
import { TELEMETRY_LIMITS } from './types';

export type IngestDb = Pick<
    PgDatabase<PgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>,
    'transaction'
>;

export interface IngestResult {
    /** Distinct fingerprints touched by this batch (rows upserted into the dimension table). */
    fingerprintsTouched: number;
    /** Events actually inserted. A re-sent `eventId` is silently absorbed by
     * `ON CONFLICT DO NOTHING` and is NOT counted here. */
    inserted: number;
    attempted: number;
}

const EMPTY_RESULT: IngestResult = { fingerprintsTouched: 0, inserted: 0, attempted: 0 };

/**
 * Ingest an already-validated (`schema.ts`) batch of events for one caller.
 *
 * `userHash` is computed by the CALLER from the authenticated session — this
 * function never receives a raw user id and has no way to derive one. This
 * is the same non-negotiable rule the shell/worker producers follow: no
 * identity travels on the wire, only a hash.
 */
export async function ingestBatch(
    db: IngestDb,
    events: ParsedTelemetryEventInput[],
    userHash: string,
): Promise<IngestResult> {
    if (events.length === 0) return EMPTY_RESULT;
    // Defence in depth — the route/schema layer already caps at 50, but this
    // is the last line before a write, so it caps again independently.
    const capped = events.slice(0, TELEMETRY_LIMITS.MAX_EVENTS_PER_BATCH);

    const now = new Date();
    const hourBucket = new Date(Math.floor(now.getTime() / 3_600_000) * 3_600_000);

    const rows = capped.map((e) => {
        // Sanitized AGAIN here even though every producer already ran
        // `sanitizeErrorMessage` before the wire (design §8.1) — defence in
        // depth against a producer bug, never trusting the client's word
        // that its own string was already safe.
        const detail = e.detail !== undefined ? sanitizeErrorMessage(e.detail) : undefined;
        const fp = fingerprint({
            eventClass: e.eventClass,
            source: e.source,
            site: e.site,
            code: e.code,
            detail,
        });
        return {
            eventId: e.eventId,
            schemaVersion: e.schemaVersion,
            eventClass: e.eventClass,
            source: e.source,
            fingerprint: fp,
            userHash,
            site: e.site,
            code: e.code,
            outcome: e.outcome,
            detail: detail || null,
            durationMs: e.durationMs ?? null,
            correlationId: e.correlationId ?? null,
            computerId: e.computerId ?? null,
            attrs: sanitizeAttrs(e.eventClass, e.attrs) ?? null,
            occurredAt: new Date(e.occurredAt),
            receivedAt: now,
            normalizedDetail: normalizeDetail(detail ?? ''),
        };
    });

    /**
     * Fold to one row per distinct fingerprint — so a client sending the same
     * crash 3 times in one flush increments `total_count` and `event_count`
     * by 3 in one statement rather than racing itself.
     *
     * 🔴 Takes the ACTUALLY-STORED rows, not the submitted batch. See the
     * statement order in the transaction below for why that distinction is
     * the whole correctness of this function.
     */
    function foldByFingerprint(stored: typeof rows) {
        const byFingerprint = new Map<string, { row: (typeof rows)[number]; count: number }>();
        for (const row of stored) {
            const existing = byFingerprint.get(row.fingerprint);
            if (existing) existing.count++;
            else byFingerprint.set(row.fingerprint, { row, count: 1 });
        }
        return [...byFingerprint.values()];
    }

    return db.transaction(async (tx) => {
        /**
         * 1. The events themselves, FIRST, and idempotently on `event_id`.
         *
         * 🔴 THIS RUNS FIRST FOR A REASON, and the reason was found by sending
         * the same batch twice at a real Postgres. The counters in statements 2
         * and 3 must be derived from what this statement ACTUALLY STORED, not
         * from what the client submitted. When the dimension upsert ran first
         * it added `+N` unconditionally while this statement silently dropped
         * all N as duplicates — so a re-delivered beacon left `total_count` and
         * `event_count` permanently inflated with events that exist nowhere in
         * `ezil_error_events`, and every rollup-backed number
         * (`fingerprintLeaderboardFromRollup`, the admin page's totals) drifted
         * upward with no way to reconcile it. The events table was idempotent;
         * the aggregates over it were not, which is the worse half to get wrong
         * because raw rows are pruned at retention and the rollup is what
         * survives.
         *
         * `RETURNING` on an `ON CONFLICT DO NOTHING` insert yields exactly the
         * rows that were inserted, which is precisely the set we need.
         *
         * Nothing here depends on statement 2: `ezil_error_events.fingerprint`
         * deliberately carries NO foreign key to the dimension table (see
         * `../db/schema/telemetry.ts`). The one ordering constraint that is
         * real — `ezil_error_user_hours` -> `ezil_error_fingerprints` — is
         * still honoured, 2 before 3.
         */
        const insertResult = await tx
            .insert(errorEvents)
            .values(
                rows.map((row) => ({
                    eventId: row.eventId,
                    schemaVersion: row.schemaVersion,
                    eventClass: row.eventClass,
                    source: row.source,
                    fingerprint: row.fingerprint,
                    userHash: row.userHash,
                    site: row.site,
                    code: row.code,
                    outcome: row.outcome,
                    detail: row.detail,
                    durationMs: row.durationMs,
                    correlationId: row.correlationId,
                    computerId: row.computerId,
                    attrs: row.attrs,
                    occurredAt: row.occurredAt,
                    receivedAt: row.receivedAt,
                })),
            )
            .onConflictDoNothing({ target: errorEvents.eventId })
            .returning({ eventId: errorEvents.eventId });

        // Only what became a row. A batch whose every event was already
        // stored is now a TRUE no-op — no counters move, nothing to fold —
        // which is what "a re-sent batch is idempotent" has to mean if it is
        // going to be worth saying. Deduped by eventId first, so a client that
        // repeats one eventId inside a single batch cannot count it twice
        // either (Postgres inserts it once; `rows` still holds it twice).
        const storedIds = new Set(insertResult.map((r) => r.eventId));
        const seen = new Set<string>();
        const stored = rows.filter(
            (row) => storedIds.has(row.eventId) && !seen.has(row.eventId) && (seen.add(row.eventId), true),
        );
        if (stored.length === 0) {
            return { fingerprintsTouched: 0, inserted: 0, attempted: rows.length };
        }
        const grouped = foldByFingerprint(stored);

        // 2. Fingerprints dimension (upsert). Must run before 3 (the FK).
        //    `last_seen_at` advances only when something was actually stored,
        //    for the same reason the counters do — a replay is not a sighting.
        await tx
            .insert(errorFingerprints)
            .values(
                grouped.map(({ row, count }) => ({
                    fingerprint: row.fingerprint,
                    eventClass: row.eventClass,
                    source: row.source,
                    site: row.site,
                    code: row.code,
                    normalizedDetail: row.normalizedDetail || null,
                    totalCount: count,
                })),
            )
            .onConflictDoUpdate({
                target: errorFingerprints.fingerprint,
                set: {
                    lastSeenAt: now,
                    totalCount: sql`${errorFingerprints.totalCount} + excluded.total_count`,
                },
            });

        // 3. Keep the current hour's rollup live so Q1/Q3 work even before
        // an hourly maintenance job runs. Requires (2) to have run first
        // (FK to errorFingerprints).
        await tx
            .insert(errorUserHours)
            .values(
                grouped.map(({ row, count }) => ({
                    fingerprint: row.fingerprint,
                    hourBucket,
                    userHash,
                    eventCount: count,
                })),
            )
            .onConflictDoUpdate({
                target: [errorUserHours.fingerprint, errorUserHours.hourBucket, errorUserHours.userHash],
                set: {
                    eventCount: sql`${errorUserHours.eventCount} + excluded.event_count`,
                },
            });

        return {
            fingerprintsTouched: grouped.length,
            inserted: stored.length,
            attempted: rows.length,
        };
    });
}
