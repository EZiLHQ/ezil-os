import { relations, sql } from 'drizzle-orm';
import {
    bigint,
    char,
    check,
    foreignKey,
    index,
    integer,
    jsonb,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uuid,
    varchar,
} from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';

import { computers } from './computers';

/**
 * Raw crash/error telemetry. APPEND-ONLY, HARD-DELETE-ONLY, SHORT-LIVED.
 *
 * Never contains: secrets, tokens, HMAC values, cookies, file contents,
 * absolute user paths, email addresses, raw user ids, IP addresses, or full
 * URLs. Producers run `sanitizeErrorMessage()` before the wire; the ingest
 * route runs it again (defence in depth) before the insert. See
 * `scratchpad/telemetry-design.md` §8.
 *
 * `fingerprint` is computed SERVER-SIDE ONLY (`server/telemetry/fingerprint.ts`)
 * so all producers (shell, worker-via-R2, container-via-worker) bucket
 * identically. Clients never supply it.
 *
 * ONE CONVENTION IS DELIBERATELY INVERTED from `ezil_computers`, and this is
 * the reason: `ezil_computers` is soft-delete-only because its `id` *is* an
 * R2 prefix root. This table is hard-delete-only — a soft-deleted telemetry
 * row would keep both its bytes and its index entries, which is strictly
 * worse than no row and defeats retention (`server/telemetry/retention.ts`).
 * There is therefore no `deletedAt` column, and `DELETE` is the one command
 * the retention job is *supposed* to run.
 *
 * There is no `user_id` column and no FK to `auth.users`. Only `user_hash`
 * (the existing `safeUserHash()` construction, mirrored in `../telemetry/sanitize.ts`
 * from `worker/src/observability.ts`) — a CORRELATION KEY, not a security
 * primitive. Account deletion does not cascade through `auth.users` for this
 * table; it is handled by (a) the `computerId` FK below, which DOES cascade
 * (`auth.users` -> `ezil_computers` -> here), (b) an explicit
 * `delete from ezil_error_events where user_hash = $1` that MUST be wired
 * into the account-deletion path when one exists, and (c) the 14-day
 * retention ceiling as a backstop.
 */
export const errorEvents = pgTable(
    'ezil_error_events',
    {
        // Client-generated UUIDv4, used as the PK so a re-sent beacon is an
        // idempotent no-op via ON CONFLICT DO NOTHING rather than a duplicate.
        eventId: uuid('event_id').primaryKey(),
        schemaVersion: integer('schema_version').notNull().default(1),
        eventClass: varchar('event_class', { length: 32 }).notNull(),
        source: varchar('source', { length: 16 }).notNull(),
        /** `fp_` + 16 hex chars = 19. */
        fingerprint: char('fingerprint', { length: 19 }).notNull(),
        /** `u_` + 8 hex chars = 10. NEVER a raw user id. */
        userHash: char('user_hash', { length: 10 }).notNull(),
        site: varchar('site', { length: 96 }).notNull(),
        code: varchar('code', { length: 64 }).notNull(),
        outcome: varchar('outcome', { length: 16 }).notNull(),
        detail: varchar('detail', { length: 200 }),
        durationMs: integer('duration_ms'),
        correlationId: varchar('correlation_id', { length: 64 }),
        computerId: uuid('computer_id'),
        /** Allow-listed scalars only (`../telemetry/types.ts`'s `ATTRS_ALLOW_LIST`). Never free-form. */
        attrs: jsonb('attrs'),
        /** Producer's clock. Advisory — clocks lie. */
        occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
        /** OUR clock, at ingest. Every time-window query uses THIS one. */
        receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
        // Q1 "distinct users on this fingerprint in the last hour" — the whole
        // point of the table. Column order matters: equality key first, range
        // key second, payload third so it is an INDEX-ONLY scan.
        index('idx_ezil_error_events_fp_time_user').on(t.fingerprint, t.receivedAt, t.userHash),
        // Q2 error rate over time + Q3 spike detection, sliced by class.
        index('idx_ezil_error_events_class_time').on(t.eventClass, t.receivedAt),
        // Q4 boot-phase ranking, and the retention sweep's driving scan.
        index('idx_ezil_error_events_time').on(t.receivedAt),
        // Per-user drill-down ("show me everything this one reporter hit").
        index('idx_ezil_error_events_user_time').on(t.userHash, t.receivedAt),
        // Cascade path for account deletion. Nullable: a crash can happen
        // before any computer exists, and that crash is exactly the one we
        // most need to see.
        foreignKey({
            name: 'ezil_error_events_computer_id_fkey',
            columns: [t.computerId],
            foreignColumns: [computers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
        check('ezil_error_events_fingerprint_chk', sql`${t.fingerprint} ~ '^fp_[0-9a-f]{16}$'`),
        check('ezil_error_events_user_hash_chk', sql`${t.userHash} ~ '^u_[0-9a-f]{8}$'`),
        check('ezil_error_events_outcome_chk', sql`${t.outcome} in ('ok','error','skipped')`),
    ],
).enableRLS();

/**
 * One row per distinct error class, ever. Tiny (hundreds of rows), permanent,
 * and the join target for every dashboard. Upserted on the ingest path.
 * Outlives the raw events it summarises, so "when did we first see this?"
 * survives retention.
 */
export const errorFingerprints = pgTable(
    'ezil_error_fingerprints',
    {
        fingerprint: char('fingerprint', { length: 19 }).primaryKey(),
        eventClass: varchar('event_class', { length: 32 }).notNull(),
        source: varchar('source', { length: 16 }).notNull(),
        site: varchar('site', { length: 96 }).notNull(),
        code: varchar('code', { length: 64 }).notNull(),
        /** The normalised (not raw) detail — already id-stripped, so safe. */
        normalizedDetail: varchar('normalized_detail', { length: 120 }),
        firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).notNull().defaultNow(),
        lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
        /** Lifetime counter. Survives retention; never reset. */
        totalCount: bigint('total_count', { mode: 'number' }).notNull().default(0),
        /** Set by a human to stop a known-benign class paging anyone. */
        mutedAt: timestamp('muted_at', { withTimezone: true }),
        notes: text('notes'),
    },
    (t) => [
        index('idx_ezil_error_fingerprints_last_seen').on(t.lastSeenAt),
        index('idx_ezil_error_fingerprints_class').on(t.eventClass, t.lastSeenAt),
    ],
).enableRLS();

/**
 * The long-horizon rollup: (fingerprint, hour, user) -> count.
 *
 * This shape — one row per user per hour rather than a pre-summed count — is
 * the ONLY one that keeps DISTINCT-USER counts exact over arbitrary windows
 * after the raw events are pruned. `count(*)` grouped by hour gives distinct
 * users; `sum(event_count)` gives event volume. Costs ~4 rows/user/day.
 */
export const errorUserHours = pgTable(
    'ezil_error_user_hours',
    {
        fingerprint: char('fingerprint', { length: 19 }).notNull(),
        /** `date_trunc('hour', received_at)`. */
        hourBucket: timestamp('hour_bucket', { withTimezone: true }).notNull(),
        userHash: char('user_hash', { length: 10 }).notNull(),
        eventCount: integer('event_count').notNull().default(0),
    },
    (t) => [
        primaryKey({ name: 'ezil_error_user_hours_pkey', columns: [t.fingerprint, t.hourBucket, t.userHash] }),
        index('idx_ezil_error_user_hours_hour').on(t.hourBucket),
        foreignKey({
            name: 'ezil_error_user_hours_fingerprint_fkey',
            columns: [t.fingerprint],
            foreignColumns: [errorFingerprints.fingerprint],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

// Deliberately NO FK from errorEvents.fingerprint to errorFingerprints:
// ingest inserts events and upserts the fingerprint dimension in the same
// transaction, and a hard FK here would turn a fingerprint-upsert hiccup
// into a dropped event. The rollup table does carry the FK (above) because
// it is written by a retryable job, not the latency-sensitive ingest path.
export const errorEventsRelations = relations(errorEvents, ({ one }) => ({
    fingerprintRow: one(errorFingerprints, {
        fields: [errorEvents.fingerprint],
        references: [errorFingerprints.fingerprint],
    }),
    computer: one(computers, { fields: [errorEvents.computerId], references: [computers.id] }),
}));

export const errorEventInsertSchema = createInsertSchema(errorEvents);
export type ErrorEvent = typeof errorEvents.$inferSelect;
export type NewErrorEvent = typeof errorEvents.$inferInsert;
export type ErrorFingerprint = typeof errorFingerprints.$inferSelect;
export type ErrorUserHour = typeof errorUserHours.$inferSelect;
