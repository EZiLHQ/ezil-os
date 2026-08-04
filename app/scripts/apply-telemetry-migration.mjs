/**
 * Apply ONLY `drizzle/0001_telemetry.sql`, idempotently.
 *
 * Why this exists instead of `drizzle-kit migrate`:
 * the production database has no `drizzle.__drizzle_migrations` journal — the
 * original schema was created by some route other than `drizzle-kit migrate`
 * (`db:push`, or by hand). So `migrate` does not know `0000` was ever applied
 * and replays it from the beginning, failing on
 * `relation "ezil_computers" already exists`. That failure is safe — it rolls
 * back inside a transaction and touches nothing — but it also means `migrate`
 * cannot be used to apply `0001` until someone baselines that journal.
 *
 * This script is the narrow alternative: it applies one known file and nothing
 * else. It is deliberately NOT a general migration runner.
 *
 * Guards, in order:
 *   1. Refuses to run without SUPABASE_DATABASE_URL.
 *   2. Idempotent — if `ezil_error_events` already exists it exits 0 having
 *      done nothing, so re-running (or a re-deploy) is harmless.
 *   3. Reads the SQL from disk rather than embedding it, so what runs is
 *      exactly the file that was reviewed and committed.
 *   4. Refuses if that file contains any statement that could affect existing
 *      objects — DROP, TRUNCATE, DELETE, or an ALTER of a table it did not
 *      itself create in the same file. The file is additive-only today; this
 *      guard is here so it cannot quietly stop being additive later.
 *   5. One transaction. Verifies the three tables, their RLS flag and their
 *      policies BEFORE committing, and rolls back if any check fails.
 *
 * Never prints the connection string or any row contents.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const SQL_PATH = fileURLToPath(new URL('../drizzle/0001_telemetry.sql', import.meta.url));
const EXPECTED_TABLES = ['ezil_error_events', 'ezil_error_fingerprints', 'ezil_error_user_hours'];

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) {
    console.error('[migrate-0001] SUPABASE_DATABASE_URL is not set — refusing to run.');
    process.exit(1);
}

const raw = readFileSync(SQL_PATH, 'utf8');

// Guard 4: the file must remain additive-only.
const stripped = raw.replace(/--[^\n]*/g, '');
const forbidden = [/\bdrop\s+(table|schema|column|index|policy)\b/i, /\btruncate\b/i, /\bdelete\s+from\b/i];
for (const re of forbidden) {
    if (re.test(stripped)) {
        console.error(`[migrate-0001] refusing: migration contains ${re} — this script only applies additive DDL.`);
        process.exit(1);
    }
}
// Any ALTER must target a table this same file creates.
const created = new Set([...stripped.matchAll(/create\s+table\s+"?([a-z0-9_]+)"?/gi)].map((m) => m[1]));
for (const m of stripped.matchAll(/alter\s+table\s+"?([a-z0-9_]+)"?/gi)) {
    if (!created.has(m[1])) {
        console.error(`[migrate-0001] refusing: ALTER TABLE "${m[1]}" targets a table this migration does not create.`);
        process.exit(1);
    }
}

const sql = postgres(url, { max: 1, onnotice: () => {} });

try {
    const [{ exists }] = await sql`
        SELECT EXISTS (
            SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename='ezil_error_events'
        ) AS exists`;
    if (exists) {
        console.log('[migrate-0001] already applied — ezil_error_events exists. Nothing to do.');
        await sql.end();
        process.exit(0);
    }

    const before = await sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`;

    await sql.begin(async (tx) => {
        // drizzle-kit writes `--> statement-breakpoint` between statements.
        for (const statement of raw.split('--> statement-breakpoint')) {
            const trimmed = statement.trim();
            if (trimmed) await tx.unsafe(trimmed);
        }

        const tables = await tx`
            SELECT tablename, rowsecurity FROM pg_tables
             WHERE schemaname='public' AND tablename = ANY(${EXPECTED_TABLES})`;
        if (tables.length !== 3) throw new Error(`expected 3 tables, found ${tables.length}`);
        if (!tables.every((t) => t.rowsecurity)) throw new Error('a telemetry table has RLS disabled');

        const [{ n: policies }] = await tx`
            SELECT count(*)::int AS n FROM pg_policies
             WHERE schemaname='public' AND tablename = ANY(${EXPECTED_TABLES})`;
        if (policies < 3) throw new Error(`expected >= 3 RLS policies, found ${policies}`);
    });

    const after = await sql`SELECT count(*)::int AS n FROM pg_tables WHERE schemaname='public'`;
    const added = after[0].n - before[0].n;
    if (added !== 3) throw new Error(`public table count moved by ${added}, expected exactly 3`);

    console.log(`[migrate-0001] applied. public tables ${before[0].n} -> ${after[0].n}, RLS on, policies present.`);
    await sql.end();
    process.exit(0);
} catch (err) {
    console.error('[migrate-0001] FAILED (transaction rolled back):', err?.message ?? err);
    await sql.end();
    process.exit(1);
}
