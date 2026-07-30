import { defineConfig } from 'drizzle-kit';

/**
 * Drizzle Kit config. `dbCredentials.url` is only read by `db:migrate` /
 * `db:push` (both require a live connection); `db:generate` (the one we run
 * in CI/dev to produce SQL migrations from the schema) never connects to a
 * database, so this file is safe to load without `SUPABASE_DATABASE_URL`
 * set.
 */
export default defineConfig({
    schema: './src/server/db/schema/index.ts',
    out: './drizzle',
    dialect: 'postgresql',
    dbCredentials: {
        url: process.env.SUPABASE_DATABASE_URL ?? 'postgresql://unused:unused@localhost:5432/unused',
    },
    // We only manage tables in `public` here — never generate DDL for
    // Supabase's own `auth` schema, which we merely reference (see
    // `./src/server/db/schema/auth-users.ts`).
    schemaFilter: ['public'],
});
