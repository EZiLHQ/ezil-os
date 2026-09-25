/** Read-only production schema probe. Prints no row data or credentials. */
import postgres from 'postgres';

const url = process.env.SUPABASE_DATABASE_URL;
if (!url) {
    console.error('OS_ACCESS_SCHEMA_PROBE: database URL is unavailable');
    process.exit(1);
}

const sql = postgres(url, { max: 1, prepare: false, connect_timeout: 10 });
try {
    const [presence] = await sql`
        SELECT to_regclass('public.ezil_computers') IS NOT NULL AS computers,
               to_regclass('public.ezil_error_events') IS NOT NULL AS telemetry,
               to_regclass('public.ezil_os_access') IS NOT NULL AS os_access,
               to_regclass('auth.users') IS NOT NULL AS auth_users,
               to_regprocedure('auth.role()') IS NOT NULL AS auth_role,
               (SELECT count(*)::int FROM pg_catalog.pg_tables WHERE schemaname = 'public') AS public_table_count
    `;
    const columns = await sql`
        SELECT column_name FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'ezil_os_access'
         ORDER BY ordinal_position
    `;
    const policies = await sql`
        SELECT policyname FROM pg_catalog.pg_policies
         WHERE schemaname = 'public' AND tablename = 'ezil_os_access'
         ORDER BY policyname
    `;
    const [rls] = await sql`
        SELECT relrowsecurity FROM pg_catalog.pg_class
         WHERE oid = to_regclass('public.ezil_os_access')
    `;
    console.log('OS_ACCESS_SCHEMA_PROBE ' + JSON.stringify({
        ...presence,
        columns: columns.map(row => row.column_name),
        policies: policies.map(row => row.policyname),
        rls: rls?.relrowsecurity ?? null,
    }));
} catch (error) {
    console.error('OS_ACCESS_SCHEMA_PROBE_FAILED ' + JSON.stringify({ code: error?.code ?? 'unknown' }));
    process.exitCode = 1;
} finally {
    await sql.end({ timeout: 1 });
}
