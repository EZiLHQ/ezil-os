/**
 * Apply only drizzle/0002_os_access.sql to an already-initialized EZiL database.
 * The hosted database has no Drizzle migration journal, so replaying 0000 is
 * unsafe. This command reads the reviewed SQL file, locks, checks the existing
 * schema, applies it once in a transaction, and verifies it before commit.
 * It never writes an invitation or prints credentials or row data.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const migrationPath = fileURLToPath(new URL('../drizzle/0002_os_access.sql', import.meta.url));
const expectedSha256 = '4c98ec14cc82f82851905cb133218a458836b97bbaa44fc65c4fcba02f0ad397';
const source = readFileSync(migrationPath, 'utf8');
const digest = createHash('sha256').update(source).digest('hex');
if (digest !== expectedSha256) {
    console.error('[migrate-0002] reviewed SQL digest does not match; refusing to run');
    process.exit(1);
}

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) {
    console.error('[migrate-0002] SUPABASE_DATABASE_URL is not set; refusing to run');
    process.exit(1);
}

const expectedColumns = ['email', 'user_id', 'invited_by', 'created_at', 'revoked_at'];
const expectedConstraints = [
    'ezil_os_access_email_lower_chk',
    'ezil_os_access_pkey',
    'ezil_os_access_user_id_fkey',
];

// Only messages constructed by this script may reach logs. Driver errors can
// contain connection details even when they do not expose a SQLSTATE.
class VerificationError extends Error {}

async function verify(tx) {
    const columns = await tx`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ezil_os_access'
         ORDER BY ordinal_position
    `;
    if (JSON.stringify(columns.map(row => row.column_name)) !== JSON.stringify(expectedColumns)) {
        throw new VerificationError('column layout does not match the reviewed migration');
    }

    const constraints = await tx`
        SELECT conname FROM pg_catalog.pg_constraint
         WHERE conrelid = to_regclass('public.ezil_os_access')
           AND contype IN ('p', 'f', 'c')
         ORDER BY conname
    `;
    if (JSON.stringify(constraints.map(row => row.conname)) !== JSON.stringify(expectedConstraints)) {
        throw new VerificationError('constraints do not match the reviewed migration');
    }

    const [table] = await tx`
        SELECT relrowsecurity FROM pg_catalog.pg_class
         WHERE oid = to_regclass('public.ezil_os_access')
    `;
    if (table?.relrowsecurity !== true) throw new VerificationError('row-level security is not enabled');

    const policies = await tx`
        SELECT policyname, cmd, qual FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'ezil_os_access'
    `;
    if (policies.length !== 1
        || policies[0].policyname !== 'Service role full access os access'
        || policies[0].cmd !== 'ALL'
        || !policies[0].qual?.includes("auth.role() = 'service_role'")) {
        throw new VerificationError('service-only policy does not match the reviewed migration');
    }
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10, onnotice: () => {} });
try {
    const outcome = await sql.begin(async tx => {
        // Serialize accidental concurrent release builds using this one-time migration.
        await tx`SELECT pg_advisory_xact_lock(20260924, 2)`;

        const [baseline] = await tx`
            SELECT to_regclass('public.ezil_computers') IS NOT NULL AS computers,
                   to_regclass('auth.users') IS NOT NULL AS auth_users,
                   to_regprocedure('auth.role()') IS NOT NULL AS auth_role,
                   to_regclass('public.ezil_os_access') IS NOT NULL AS os_access,
                   (SELECT count(*)::int FROM pg_catalog.pg_tables WHERE schemaname = 'public') AS table_count
        `;
        if (!baseline.computers || !baseline.auth_users || !baseline.auth_role) {
            throw new VerificationError('required base schema is absent');
        }
        if (baseline.os_access) {
            await verify(tx);
            return { applied: false, before: baseline.table_count, after: baseline.table_count };
        }

        // The checked digest pins every statement to the reviewed migration.
        for (const statement of source.split('--> statement-breakpoint')) {
            const text = statement.trim();
            if (text) await tx.unsafe(text);
        }
        await verify(tx);
        const [{ table_count: after }] = await tx`
            SELECT count(*)::int AS table_count FROM pg_catalog.pg_tables WHERE schemaname = 'public'
        `;
        if (after !== baseline.table_count + 1) {
            throw new VerificationError('public table count did not increase by exactly one');
        }
        return { applied: true, before: baseline.table_count, after };
    });
    console.log(`[migrate-0002] ${outcome.applied ? 'applied' : 'already applied'}; public tables ${outcome.before} -> ${outcome.after}; RLS and constraints verified`);
} catch (error) {
    // The driver error may contain connection details or query parameters.
    // Only our own validation errors and SQLSTATE codes are safe to print.
    const code = typeof error?.code === 'string' && /^[A-Z0-9]{5}$/.test(error.code)
        ? error.code : null;
    const reason = error instanceof VerificationError ? error.message : (code ?? 'unexpected_error');
    console.error(`[migrate-0002] failed; transaction rolled back (${reason})`);
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 1 });
}
