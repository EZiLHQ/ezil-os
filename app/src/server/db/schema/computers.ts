import { relations, sql } from 'drizzle-orm';
import {
    check,
    foreignKey,
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
