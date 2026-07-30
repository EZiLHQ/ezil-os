import { pgSchema, uuid } from 'drizzle-orm/pg-core';

/**
 * Minimal read-only reference to Supabase's own `auth.users` table.
 *
 * We never migrate or write this table (Supabase Auth owns it entirely) —
 * this declaration exists solely so our own tables (e.g. `ezil_computers`)
 * can declare a foreign key against `auth.users.id` and Drizzle can resolve
 * the reference. Only the primary key column is modeled; anything else
 * about a user's identity lives in Supabase Auth, not here.
 */
export const authSchema = pgSchema('auth');

export const authUsers = authSchema.table('users', {
    id: uuid('id').primaryKey(),
});
