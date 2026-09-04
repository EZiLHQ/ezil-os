import { sql } from 'drizzle-orm';
import { check, foreignKey, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { createInsertSchema } from 'drizzle-zod';

import { authUsers } from './auth-users';

/**
 * `ezil_os_access` — the invite allow-list. One row per invited email; a row
 * with `revoked_at is null` is the ONLY thing that lets an account past
 * `assertOsAccess` (`@/server/api/os-access.ts`) while
 * `EZIL_OS_ACCESS_MODE` is `invite` (its default — see `@/env`).
 *
 * ── Why the PRIMARY KEY is the EMAIL and not the user id ──────────────────
 * An invite has to exist BEFORE the account does. Supabase Auth only creates
 * an `auth.users` row when the invited person actually accepts, so a
 * `user_id`-keyed table could not hold an invitation at all. `user_id` below
 * is therefore nullable and is a BACKFILL (row A2 fills it on first
 * sign-in), never the lookup key: every read is by email.
 *
 * ── `text` + a CHECK, not `citext` ────────────────────────────────────────
 * Neither `drizzle/0000_massive_mole_man.sql` nor `drizzle/0001_telemetry.sql`
 * contains a `CREATE EXTENSION`, so nothing in this repository has ever
 * enabled `citext` on the hosted database — and this row is not permitted to
 * connect to that database to find out whether some other project sharing it
 * did (`public` already holds ~40 tables that are not ours; see
 * `docs/RUNBOOK.md` § "Database migrations"). A migration that assumed the
 * extension and was wrong would fail on the one machine that matters.
 *
 * So the invariant is enforced where it can be proved: the column is plain
 * `text`, `ezil_os_access_email_lower_chk` refuses any row whose email is not
 * already lower-cased, and every writer/reader normalises through
 * `normalizeAccessEmail()` in `@/server/api/os-access.ts`. Two independent
 * guards, neither of which depends on an extension being present. (Trailing
 * whitespace is likewise trimmed in code; the CHECK deliberately does not
 * test for it, because `lower()` is the only normalisation Postgres can
 * express here without a second function call in the constraint.)
 *
 * ── SOFT REVOKE ONLY ──────────────────────────────────────────────────────
 * Same rule as `ezil_computers` (see `./computers.ts`), for the same class of
 * reason: `revoked_at` is set, the row is NEVER deleted. Deleting it would
 * destroy the only record that this address was ever invited, by whom, and
 * when it was withdrawn — which is exactly the audit trail an access gate
 * exists to keep. `tools/invite.ts revoke` issues an UPDATE, never a DELETE,
 * and `tools/invite.ts add` on an already-revoked row CLEARS `revoked_at`
 * rather than inserting a second row (the PK makes a second row impossible
 * anyway).
 *
 * There is deliberately NO partial index on `(email) where revoked_at is
 * null`. It would never be used: `email` is the primary key, and the lookup
 * (`osAccessLookup`) fetches the row by email equality WITHOUT a
 * `revoked_at` predicate — on purpose, so that "revoked" and "never invited"
 * stay distinguishable to the caller instead of collapsing into one silent
 * "no row". An index that no query can reach is maintenance cost with no
 * reader.
 */
export const osAccess = pgTable(
    'ezil_os_access',
    {
        /** Lower-cased, trimmed. See the CHECK below and `normalizeAccessEmail()`. */
        email: text('email').primaryKey(),
        /**
         * Backfilled by A2 on first sign-in — null until the invitee accepts.
         * Never the lookup key.
         */
        userId: uuid('user_id'),
        /** Who issued the invite (`tools/invite.ts --by`, or `$USER`). Free text; an audit note, not an identity. */
        invitedBy: text('invited_by').notNull(),
        createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
        /** SOFT REVOKE — set, never deleted. Non-null means denied. */
        revokedAt: timestamp('revoked_at', { withTimezone: true }),
    },
    (t) => [
        check('ezil_os_access_email_lower_chk', sql`${t.email} = lower(${t.email})`),
        // ON DELETE SET NULL, *not* cascade: deleting the Supabase Auth user
        // must not hard-delete the allow-list row (that would be a delete on a
        // soft-revoke-only table, and would silently erase the invite record).
        // Explicit `..._fkey` name, matching `ezil_computers_user_id_fkey` —
        // see `./computers.ts` for why the name is pinned here rather than
        // left to drizzle-kit's auto-derived `..._users_id_fk`.
        foreignKey({
            name: 'ezil_os_access_user_id_fkey',
            columns: [t.userId],
            foreignColumns: [authUsers.id],
        })
            .onDelete('set null')
            .onUpdate('cascade'),
    ],
).enableRLS();

export const osAccessInsertSchema = createInsertSchema(osAccess);

export type OsAccessRow = typeof osAccess.$inferSelect;
export type NewOsAccessRow = typeof osAccess.$inferInsert;
