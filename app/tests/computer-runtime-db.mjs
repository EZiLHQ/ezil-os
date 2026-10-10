// Run only against a disposable local Postgres or the dedicated local Supabase.
// All DDL and fixtures are rolled back, including when an assertion fails.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const rawUrl = process.env.EZIL_TEST_DATABASE_URL;
if (!rawUrl) throw new Error('EZIL_TEST_DATABASE_URL is required');
const parsedUrl = new URL(rawUrl);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsedUrl.hostname)) {
    throw new Error('EZIL_TEST_DATABASE_URL must target loopback');
}

const migrationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
const sql = postgres(rawUrl, { max: 1, prepare: false, connect_timeout: 5 });
const rollbackMarker = Symbol('rollback-complete');
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';

async function applyMigration(tx, name) {
    const file = await readFile(path.join(migrationDir, name), 'utf8');
    for (const statement of file.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
        await tx.unsafe(statement);
    }
}

async function expectSqlState(tx, code, statement, values = []) {
    await tx.unsafe('SAVEPOINT expected_error');
    let actual;
    try { await tx.unsafe(statement, values); } catch (error) { actual = error; }
    await tx.unsafe('ROLLBACK TO SAVEPOINT expected_error');
    await tx.unsafe('RELEASE SAVEPOINT expected_error');
    assert.equal(actual?.code, code, `expected PostgreSQL ${code}; got ${actual?.code ?? 'success'}`);
}

async function bootstrapEmptyPostgres(tx) {
    await tx.unsafe('CREATE SCHEMA auth');
    await tx.unsafe('CREATE TABLE auth.users (id uuid PRIMARY KEY)');
    await tx.unsafe(`CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);
    await tx.unsafe(`CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
        SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$`);
    await tx.unsafe(`DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
            CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
            CREATE ROLE service_role NOLOGIN;
        END IF;
    END $$`);
    await tx.unsafe('GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role');
    await tx.unsafe('GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, service_role');
    await tx.unsafe('INSERT INTO auth.users (id) VALUES ($1), ($2)', [a, b]);
    await applyMigration(tx, '0000_massive_mole_man.sql');
    await applyMigration(tx, '0001_telemetry.sql');
    await applyMigration(tx, '0002_os_access.sql');
    await tx.unsafe("INSERT INTO ezil_computers (user_id,slot) VALUES ($1,1), ($2,1)", [a, b]);
}

try {
    await sql.begin(async (tx) => {
        const [{ exists }] = await tx.unsafe("SELECT to_regclass('public.ezil_computers') IS NOT NULL AS exists");
        if (!exists) await bootstrapEmptyPostgres(tx);
        const [{ alreadyApplied }] = await tx.unsafe("SELECT to_regclass('public.ezil_computer_runtimes') IS NOT NULL AS \"alreadyApplied\"");
        assert.equal(alreadyApplied, false, 'computer runtime migration is already present in test database');

        const original = await tx.unsafe('SELECT id, user_id FROM ezil_computers WHERE deleted_at IS NULL ORDER BY id LIMIT 2');
        assert.equal(original.length, 2, 'two existing computers are needed');
        await applyMigration(tx, '0003_computer_runtime.sql');
        const [{ legacyCount }] = await tx.unsafe("SELECT count(*)::int AS \"legacyCount\" FROM ezil_computers WHERE provider = 'cloudflare'");
        assert.ok(legacyCount >= 2, 'existing computers must receive the Cloudflare default');

        const [first, second] = original;
        await expectSqlState(tx, '23503',
            "INSERT INTO ezil_computer_runtimes (computer_id,region) VALUES ($1,'us-east-1')", [second.id]);

        await tx.unsafe("UPDATE ezil_computers SET provider='aws-ec2' WHERE id=$1", [first.id]);
        await tx.unsafe("INSERT INTO ezil_computer_runtimes (computer_id,region,availability_zone,data_volume_id) VALUES ($1,'us-east-1','us-east-1a','vol-test-one')", [first.id]);
        await tx.unsafe('INSERT INTO ezil_computer_instances (computer_id,generation) VALUES ($1,1)', [first.id]);
        await expectSqlState(tx, '23505', 'INSERT INTO ezil_computer_instances (computer_id,generation) VALUES ($1,2)', [first.id]);
        await tx.unsafe("UPDATE ezil_computer_instances SET observed_state='stopped' WHERE computer_id=$1 AND generation=1", [first.id]);
        await expectSqlState(tx, '23505', 'INSERT INTO ezil_computer_instances (computer_id,generation) VALUES ($1,2)', [first.id]);
        await tx.unsafe('UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=$1 AND generation=1', [first.id]);
        await tx.unsafe('INSERT INTO ezil_computer_instances (computer_id,generation) VALUES ($1,2)', [first.id]);

        const [job] = await tx.unsafe("INSERT INTO ezil_computer_lifecycle_jobs (computer_id,operation,idempotency_key) VALUES ($1,'start','same-request') RETURNING id", [first.id]);
        await expectSqlState(tx, '23505',
            "INSERT INTO ezil_computer_lifecycle_jobs (computer_id,operation,idempotency_key) VALUES ($1,'start','same-request')", [first.id]);
        await expectSqlState(tx, '23503',
            "INSERT INTO ezil_computer_lifecycle_outbox (job_id,computer_id) VALUES ($1,$2)", [job.id, second.id]);
        await tx.unsafe('INSERT INTO ezil_computer_lifecycle_outbox (job_id,computer_id) VALUES ($1,$2)', [job.id, first.id]);
        await expectSqlState(tx, '23505',
            'INSERT INTO ezil_computer_lifecycle_outbox (job_id,computer_id) VALUES ($1,$2)', [job.id, first.id]);

        // Grant direct access in this rollback-only transaction so the test
        // proves RLS denies it, rather than passing through missing grants.
        await tx.unsafe('GRANT ALL ON ezil_computers, ezil_computer_runtimes, ezil_computer_instances, ezil_computer_lifecycle_jobs, ezil_computer_lifecycle_outbox TO authenticated');
        await tx.unsafe('SET LOCAL ROLE authenticated');
        await tx.unsafe("SELECT set_config('request.jwt.claim.sub',$1,true)", [first.user_id]);
        await tx.unsafe("SELECT set_config('request.jwt.claim.role','authenticated',true)");
        const [{ ownRows }] = await tx.unsafe('SELECT count(*)::int AS "ownRows" FROM ezil_computer_runtimes');
        assert.equal(ownRows, 0, 'authenticated owners must not read runtime records directly');
        const [{ jobsSeen }] = await tx.unsafe('SELECT count(*)::int AS "jobsSeen" FROM ezil_computer_lifecycle_jobs');
        assert.equal(jobsSeen, 0, 'authenticated owners must not read lifecycle jobs directly');
        const [{ instancesSeen }] = await tx.unsafe('SELECT count(*)::int AS "instancesSeen" FROM ezil_computer_instances');
        assert.equal(instancesSeen, 0, 'authenticated owners must not read instance handles directly');
        const [{ eventsSeen }] = await tx.unsafe('SELECT count(*)::int AS "eventsSeen" FROM ezil_computer_lifecycle_outbox');
        assert.equal(eventsSeen, 0, 'authenticated owners must not read outbox events directly');
        await expectSqlState(tx, '42501',
            "INSERT INTO ezil_computer_lifecycle_jobs (computer_id,operation,idempotency_key) VALUES ($1,'start','forged-request')", [first.id]);
        await tx.unsafe("SELECT set_config('request.jwt.claim.sub',$1,true)", [second.user_id]);
        await expectSqlState(tx, '42501', "UPDATE ezil_computers SET provider='aws-ec2' WHERE id=$1", [second.id]);
        const renamed = await tx.unsafe("UPDATE ezil_computers SET name='Legacy allowed' WHERE id=$1 RETURNING id", [second.id]);
        assert.equal(renamed.length, 1, 'legacy Cloudflare owners may still update their computer');
        await tx.unsafe('RESET ROLE');

        await tx.unsafe("UPDATE ezil_computers SET provider='aws-ec2' WHERE id=$1", [second.id]);
        await expectSqlState(tx, '23505',
            "INSERT INTO ezil_computer_runtimes (computer_id,region,availability_zone,data_volume_id) VALUES ($1,'us-east-1','us-east-1a','vol-test-one')", [second.id]);
        await tx.unsafe("INSERT INTO ezil_computer_runtimes (computer_id,region,availability_zone,data_volume_id) VALUES ($1,'us-east-1','us-east-1a','vol-test-two')", [second.id]);
        throw rollbackMarker;
    });
} catch (error) {
    if (error !== rollbackMarker) throw error;
} finally {
    await sql.end();
}

console.log('PASS computer runtime migration: legacy default, provider ownership, one writer, scoped jobs/outbox, and RLS');
