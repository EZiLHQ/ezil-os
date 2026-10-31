import { relations, sql } from 'drizzle-orm';
import {
    bigint,
    check,
    foreignKey,
    index,
    integer,
    jsonb,
    pgTable,
    smallint,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from 'drizzle-orm/pg-core';
import { createInsertSchema, createUpdateSchema } from 'drizzle-zod';

import { authUsers } from './auth-users';

/**
 * A user's "computer" — the top-level unit of the EZiL OS product. Each
 * row's `id` is used VERBATIM as the R2 workspace prefix root for its EZiL
 * OS desktop (see `worker/src/index.ts`'s `ensureWorkspaceMount` /
 * `deriveSandboxId` and `server/lib/cloudflare-guacamole-provider.ts`'s
 * `deriveGuacamoleSandboxId`, both of which key off an opaque "scope id"
 * that the Cloudflare path never joins against any table).
 *
 * Capped at 2 computers per user (see `slot`'s CHECK constraint below). The
 * cap intentionally lives in the schema rather than only in application
 * code, so raising it later is a one-line migration.
 *
 * SOFT DELETE ONLY (`deletedAt`) — never hard-delete a row. This id IS the
 * R2 prefix root; hard-deleting the row would orphan that prefix with no
 * way for anything to ever address it again. The partial unique index below
 * excludes soft-deleted rows so a freed slot can be reused by a new
 * computer.
 *
 * Carried near-verbatim from EBuilder's `packages/db/src/schema/computer`
 * (authored post-Onlook-import, safe to carry) — the only change is the
 * `userId` foreign key, which now references this repo's own minimal
 * `auth.users` reference (`./auth-users`) instead of EBuilder's Onlook-era
 * `public.users` mirror table, which this fresh repo does not carry.
 *
 * The `userId` FK is named EXPLICITLY (`ezil_computers_user_id_fkey`,
 * Postgres/Supabase's own default naming) rather than left to drizzle-kit's
 * usual auto-derived `..._users_id_fk` — this FK was, for a time, wrongly
 * pointed at `public.users` live (blocking every fresh signup: a new
 * Supabase Auth user only ever exists in `auth.users`) and was repointed
 * directly against the database rather than by regenerating a migration.
 * Naming it here matches what is actually live (see
 * `drizzle/0000_massive_mole_man.sql`) so a future `drizzle-kit generate`
 * diffs against the real constraint name instead of proposing a spurious
 * rename.
 */
export const computers = pgTable(
    'ezil_computers',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').notNull(),
        name: text('name').notNull().default('Computer'),
        // 1 | 2 — see the CHECK constraint. Cap enforced in the schema, not
        // just application code, so a concurrent double-click racing
        // `computer.create` cannot slip a 3rd row past the limit — the
        // partial unique index on (userId, slot) makes that race a
        // guaranteed unique-violation instead of a silent double-insert.
        slot: smallint('slot').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        lastOpenedAt: timestamp('last_opened_at', { withTimezone: true }),
        // SOFT DELETE ONLY — see doc comment above. Never hard-delete.
        deletedAt: timestamp('deleted_at', { withTimezone: true }),
        metadata: jsonb('metadata'),
    },
    (table) => [
        // Slot uniqueness scoped to *live* (non-soft-deleted) computers
        // only, so a deleted computer's slot can be reclaimed by a new one.
        uniqueIndex('ezil_computers_user_slot_uidx')
            .on(table.userId, table.slot)
            .where(sql`${table.deletedAt} is null`),
        check('ezil_computers_slot_chk', sql`${table.slot} in (1, 2)`),
        foreignKey({
            name: 'ezil_computers_user_id_fkey',
            columns: [table.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('cascade')
            .onUpdate('cascade'),
    ],
).enableRLS();

export const computersRelations = relations(computers, ({ one }) => ({
    user: one(authUsers, {
        fields: [computers.userId],
        references: [authUsers.id],
    }),
}));

export const computerInsertSchema = createInsertSchema(computers);
export const computerUpdateSchema = createUpdateSchema(computers);

export type Computer = typeof computers.$inferSelect;
export type NewComputer = typeof computers.$inferInsert;

/**
 * AWS → Cloudflare moves (Phase B). Mirrors `app/drizzle/0012_compute_reverse_moves.sql` column for
 * column (constraint names are PostgreSQL's own column-CHECK names); the SQL file is authoritative and
 * `provider-reverse-store.pg.test.ts` compares the two. Staging-only: written by
 * `server/lib/compute/provider-reverse-store.ts` through raw SQL, like the forward
 * `ezil_compute_migrations` table (0006), which has no Drizzle model.
 * Contract: docs/compute/REVERSE-MOVE-CONTRACT.md.
 */
export const computeReverseMoves = pgTable(
    'ezil_compute_reverse_moves',
    {
        id: uuid('id').primaryKey().defaultRandom(),
        userId: uuid('user_id').notNull(),
        computerId: uuid('computer_id').notNull(),
        startedBy: text('started_by').notNull(),
        state: text('state').notNull().default('requested'),
        /** The Cloudflare import generation (chunk owner, new v1 head generation). Immutable per row. */
        generation: uuid('generation').notNull().defaultRandom(),
        exportBoot: jsonb('export_boot'),
        exportHead: jsonb('export_head'),
        importProgress: jsonb('import_progress'),
        bytesTotal: bigint('bytes_total', { mode: 'number' }),
        skipped: integer('skipped'),
        awsVolumeId: text('aws_volume_id'),
        awsFsUuid: uuid('aws_fs_uuid'),
        awsSnapshotId: text('aws_snapshot_id'),
        retainUntil: timestamp('retain_until', { withTimezone: true }),
        attempts: integer('attempts').notNull().default(0),
        lastError: text('last_error'),
        /** Set on every state change (never by claimStale or a retry): the anchor of every per-state timeout. */
        stateEnteredAt: timestamp('state_entered_at', { withTimezone: true }).notNull().defaultNow(),
        /** The point of no return (checking → flipping): the Worker commit may have been sent. */
        commitSentAt: timestamp('commit_sent_at', { withTimezone: true }),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (t) => [
        uniqueIndex('ezil_compute_reverse_moves_one_active_per_computer')
            .on(t.computerId)
            .where(sql`state NOT IN ('committed', 'failed_reopened')`),
        index('ezil_compute_reverse_moves_computer_created').on(t.computerId, t.createdAt),
        check('ezil_compute_reverse_moves_started_by_check', sql`started_by IN ('user', 'open', 'cron')`),
        check('ezil_compute_reverse_moves_state_check', sql`state IN ('requested', 'booting', 'exporting', 'copying', 'checking', 'flipping', 'committed', 'failed_reopened', 'failed_needs_operator')`),
        check('ezil_compute_reverse_moves_export_boot_check', sql`export_boot IS NULL OR jsonb_typeof(export_boot) = 'object'`),
        check('ezil_compute_reverse_moves_export_head_check', sql`export_head IS NULL OR jsonb_typeof(export_head) = 'object'`),
        check('ezil_compute_reverse_moves_import_progress_check', sql`import_progress IS NULL OR jsonb_typeof(import_progress) = 'object'`),
        check('ezil_compute_reverse_moves_bytes_total_check', sql`bytes_total IS NULL OR bytes_total BETWEEN 0 AND 536870912`),
        check('ezil_compute_reverse_moves_skipped_check', sql`skipped IS NULL OR skipped >= 0`),
        check('ezil_compute_reverse_moves_aws_volume_id_check', sql`aws_volume_id IS NULL OR aws_volume_id ~ '^vol-[0-9a-f]{8,17}$'`),
        check('ezil_compute_reverse_moves_aws_snapshot_id_check', sql`aws_snapshot_id IS NULL OR aws_snapshot_id ~ '^snap-[0-9a-f]{8,17}$'`),
        check('ezil_compute_reverse_moves_retain_until_check', sql`retain_until IS NULL OR state = 'committed'`),
        check('ezil_compute_reverse_moves_attempts_check', sql`attempts BETWEEN 0 AND 5`),
        check('ezil_compute_reverse_moves_last_error_check', sql`last_error IS NULL OR length(last_error) <= 200`),
        check('ezil_compute_reverse_moves_commit_sent_at_check',
            sql`commit_sent_at IS NULL OR state IN ('flipping', 'committed', 'failed_needs_operator')`),
    ],
).enableRLS();

export type ComputeReverseMoveRow = typeof computeReverseMoves.$inferSelect;
