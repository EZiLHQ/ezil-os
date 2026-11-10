import { pgSchema, uuid } from 'drizzle-orm/pg-core';

/**
 * Minimal read-only reference to Supabase's own `auth.users` table.
 *
 * We never alter or write this table (Supabase Auth owns it entirely); the one exception is a read-only capture hook,
 * 0021's `ezil_billing_trial_identity_capture` triggers, which copy a started trial account's verified identity into
 * our own table on change and before deletion and never modify a users row —
 * this declaration exists solely so our own tables (e.g. `ezil_computers`)
 * can declare a foreign key against `auth.users.id` and Drizzle can resolve
 * the reference. Only the primary key column is modeled; anything else
 * about a user's identity lives in Supabase Auth, not here.
 */
export const authSchema = pgSchema('auth');

export const authUsers = authSchema.table('users', {
    id: uuid('id').primaryKey(),
});
