// Run only against disposable loopback Postgres. All DDL and fixtures roll back.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import postgres from 'postgres';

const databaseUrl = process.env.EZIL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('EZIL_TEST_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname)) {
    throw new Error('EZIL_TEST_DATABASE_URL must target loopback');
}
const migrationDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');
const db = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 5 });
const rolledBack = Symbol('rolled-back');
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const admin = '33333333-3333-4333-8333-333333333333';
const commit = 'a'.repeat(40);
const image = 'registry.example/reticle@sha256:' + 'b'.repeat(64);
const digest = 'sha256:' + 'c'.repeat(64);

async function migrate(tx, name) {
    const contents = await readFile(path.join(migrationDir, name), 'utf8');
    for (const part of contents.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) {
        await tx.unsafe(part);
    }
}
async function reject(tx, code, statement, args = []) {
    await tx.unsafe('SAVEPOINT expected_error');
    let error;
    try { await tx.unsafe(statement, args); } catch (caught) { error = caught; }
    await tx.unsafe('ROLLBACK TO SAVEPOINT expected_error');
    await tx.unsafe('RELEASE SAVEPOINT expected_error');
    assert.equal(error?.code, code, `expected PostgreSQL ${code}; got ${error?.code ?? 'success'}`);
}
async function release(tx, appId) {
    const manifest = { schemaVersion: 2, source: { kind: 'github', commitSha: commit } };
    const policy = { schemaVersion: 2, image: { reference: image } };
    const [row] = await tx.unsafe(
        `INSERT INTO ezil_app_releases
         (app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
         VALUES ($1,'1.0.0',$2::jsonb,$3::jsonb,$4,$4,$5,$4,$6) RETURNING id`,
        [appId, manifest, policy, digest, image, commit],
    );
    return row.id;
}
async function approve(tx, releaseId) {
    await tx.unsafe("UPDATE ezil_app_releases SET status='validated' WHERE id=$1", [releaseId]);
    await tx.unsafe("UPDATE ezil_app_releases SET status='approved',approved_by=$2,approved_at=now() WHERE id=$1",
        [releaseId, admin]);
}

try {
    await db.begin(async tx => {
        const [{ exists }] = await tx.unsafe("SELECT to_regclass('public.ezil_computers') IS NOT NULL AS exists");
        assert.equal(exists, false, 'test database must be empty and disposable');
        await tx.unsafe('CREATE SCHEMA auth');
        await tx.unsafe('CREATE TABLE auth.users (id uuid PRIMARY KEY)');
        await tx.unsafe(`CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$`);
        await tx.unsafe(`CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
            SELECT nullif(current_setting('request.jwt.claim.role', true), '') $$`);
        await tx.unsafe(`DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
        END $$`);
        await tx.unsafe('GRANT USAGE ON SCHEMA public, auth TO authenticated, service_role');
        await tx.unsafe('GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, service_role');
        await tx.unsafe('INSERT INTO auth.users (id) VALUES ($1),($2),($3)', [alice, bob, admin]);
        for (const name of [
            '0000_massive_mole_man.sql', '0001_telemetry.sql', '0002_os_access.sql',
            '0003_computer_runtime.sql', '0004_app_marketplace.sql',
        ]) await migrate(tx, name);

        const tables = [
            'ezil_app_admins', 'ezil_app_publishers', 'ezil_apps', 'ezil_app_releases',
            'ezil_app_publications', 'ezil_app_grants', 'ezil_app_submissions',
            'ezil_app_installations', 'ezil_app_services', 'ezil_app_port_leases',
            'ezil_app_folder_grants', 'ezil_app_jobs', 'ezil_app_outbox', 'ezil_app_audit_events',
        ];
        const rls = await tx.unsafe(`SELECT c.relname, c.relrowsecurity, count(p.policyname)::int AS policies
            FROM pg_class c LEFT JOIN pg_policies p ON p.tablename=c.relname AND p.schemaname='public'
            WHERE c.relname LIKE 'ezil_app_%' AND c.relnamespace='public'::regnamespace AND c.relkind='r'
            GROUP BY c.relname,c.relrowsecurity ORDER BY c.relname`);
        assert.deepEqual(rls.map(r => r.relname), [...tables].sort());
        assert.ok(rls.every(r => r.relrowsecurity && r.policies === 1), 'all marketplace tables need service-only RLS');

        const computer = async (user, slot, provider) =>
            (await tx.unsafe('INSERT INTO ezil_computers (user_id,slot,provider) VALUES ($1,$2,$3) RETURNING id',
                [user, slot, provider]))[0].id;
        const cAlice = await computer(alice, 1, 'aws-ec2');
        const cBob = await computer(bob, 1, 'aws-ec2');
        const cLegacy = await computer(alice, 2, 'cloudflare');
        await tx.unsafe("INSERT INTO ezil_computer_runtimes (computer_id,region) VALUES ($1,'us-east-1'),($2,'us-east-1')",
            [cAlice, cBob]);
        await tx.unsafe('INSERT INTO ezil_app_admins (user_id) VALUES ($1)', [admin]);
        const [publisher] = await tx.unsafe(
            "INSERT INTO ezil_app_publishers (owner_user_id,display_name,status,invited_by) VALUES ($1,'Publisher','active',$2) RETURNING id",
            [alice, admin]);
        const createApp = async (slug, name) =>
            (await tx.unsafe('INSERT INTO ezil_apps (publisher_id,slug,name,summary,category) VALUES ($1,$2,$3,$3,$4) RETURNING id',
                [publisher.id, slug, name, 'Developer']))[0].id;
        const reticle = await createApp('reticle', 'Reticle');
        const another = await createApp('another', 'Another app');
        const reticleRelease = await release(tx, reticle);
        const anotherRelease = await release(tx, another);
        await reject(tx, '23505',
            "INSERT INTO ezil_apps (publisher_id,slug,name,summary,category) VALUES ($1,'reticle','Duplicate','Duplicate','Developer')",
            [publisher.id]);
        await reject(tx, '23514',
            "UPDATE ezil_app_releases SET manifest=jsonb_set(manifest,'{name}','\"tampered\"') WHERE id=$1",
            [reticleRelease]);
        await reject(tx, '23514',
            "UPDATE ezil_app_releases SET status='approved',approved_by=$2,approved_at=now() WHERE id=$1",
            [reticleRelease, admin]);
        await reject(tx, '23514',
            'INSERT INTO ezil_app_publications (app_id,release_id,published_by) VALUES ($1,$2,$3)',
            [reticle, reticleRelease, admin]);
        await approve(tx, reticleRelease);
        await tx.unsafe('INSERT INTO ezil_app_publications (app_id,release_id,published_by) VALUES ($1,$2,$3)',
            [reticle, reticleRelease, admin]);
        await reject(tx, '23514',
            'INSERT INTO ezil_app_publications (app_id,release_id,published_by) VALUES ($1,$2,$3)',
            [another, reticleRelease, admin]);
        await reject(tx, '23514',
            "UPDATE ezil_app_releases SET status='revoked',revoked_at=now() WHERE id=$1", [reticleRelease]);

        const install = async (computerId, appId, releaseId, owner) =>
            (await tx.unsafe(
                'INSERT INTO ezil_app_installations (computer_id,app_id,release_id,installed_by) VALUES ($1,$2,$3,$4) RETURNING id',
                [computerId, appId, releaseId, owner]))[0].id;
        const iAlice = await install(cAlice, reticle, reticleRelease, alice);
        const iBob = await install(cBob, reticle, reticleRelease, bob);
        await reject(tx, '23505',
            'INSERT INTO ezil_app_installations (computer_id,app_id,release_id,installed_by) VALUES ($1,$2,$3,$4)',
            [cAlice, reticle, reticleRelease, alice]);
        await reject(tx, '23514',
            'INSERT INTO ezil_app_installations (computer_id,app_id,release_id,installed_by) VALUES ($1,$2,$3,$4)',
            [cLegacy, reticle, reticleRelease, alice]);
        await reject(tx, '23514',
            'INSERT INTO ezil_app_installations (computer_id,app_id,release_id,installed_by) VALUES ($1,$2,$3,$4)',
            [cAlice, another, anotherRelease, alice]);
        await reject(tx, '23514', 'UPDATE ezil_app_installations SET auth_generation=0 WHERE id=$1', [iAlice]);
        await reject(tx, '23514', 'UPDATE ezil_app_installations SET computer_id=$2 WHERE id=$1', [iAlice, cBob]);
        await approve(tx, anotherRelease);
        const iAnother = await install(cAlice, another, anotherRelease, alice);
        await reject(tx, '23503',
            'INSERT INTO ezil_app_installations (computer_id,app_id,release_id,installed_by) VALUES ($1,$2,$3,$4)',
            [cBob, another, anotherRelease, alice]);

        for (const [installation, computerId] of [[iAlice, cAlice], [iBob, cBob], [iAnother, cAlice]]) {
            await tx.unsafe(
                "INSERT INTO ezil_app_services (installation_id,computer_id,name,scope,internal_port,preferred_host_port,health_path) VALUES ($1,$2,'daemon','installation',4400,4400,'/health')",
                [installation, computerId]);
        }
        await reject(tx, '23503',
            "INSERT INTO ezil_app_services (installation_id,computer_id,name,scope,internal_port,health_path) VALUES ($1,$2,'forged','installation',4400,'/health')",
            [iAlice, cBob]);
        const lease = async (installation, computerId, port) =>
            (await tx.unsafe(
                "INSERT INTO ezil_app_port_leases (installation_id,computer_id,service_name,host_port) VALUES ($1,$2,'daemon',$3) RETURNING id",
                [installation, computerId, port]))[0].id;
        const firstLease = await lease(iAlice, cAlice, 4400);
        await lease(iBob, cBob, 4400);
        await reject(tx, '23505',
            "INSERT INTO ezil_app_port_leases (installation_id,computer_id,service_name,host_port) VALUES ($1,$2,'daemon',4400)",
            [iAnother, cAlice]);
        await lease(iAnother, cAlice, 20000);
        await reject(tx, '23514', 'UPDATE ezil_app_port_leases SET host_port=4401 WHERE id=$1', [firstLease]);
        await tx.unsafe('UPDATE ezil_app_port_leases SET released_at=now() WHERE id=$1', [firstLease]);
        await reject(tx, '23514', 'UPDATE ezil_app_port_leases SET released_at=null WHERE id=$1', [firstLease]);

        const folderInsert = "INSERT INTO ezil_app_folder_grants (installation_id,computer_id,folder,scope,project_id,access,granted_by) VALUES ($1,$2,'Projects','selected-projects',$3,'read-write',$4)";
        const project = '44444444-4444-4444-8444-444444444444';
        await tx.unsafe(folderInsert, [iAlice, cAlice, project, alice]);
        await reject(tx, '23505', folderInsert, [iAlice, cAlice, project, alice]);
        await reject(tx, '23503', folderInsert, [iAlice, cAlice, '55555555-5555-4555-8555-555555555555', bob]);
        await reject(tx, '23514',
            "INSERT INTO ezil_app_folder_grants (installation_id,computer_id,folder,scope,project_id,access,granted_by) VALUES ($1,$2,'Documents','selected-projects',$3,'read-write',$4)",
            [iAlice, cAlice, project, alice]);
        await tx.unsafe(
            "UPDATE ezil_app_installations SET status='uninstalled',uninstalled_at=now(),auth_generation=2 WHERE id=$1",
            [iAlice]);
        const reinstalled = await install(cAlice, reticle, reticleRelease, alice);
        assert.notEqual(reinstalled, iAlice, 'reinstall keeps the old installation record');
        await tx.unsafe(
            "INSERT INTO ezil_app_services (installation_id,computer_id,name,scope,internal_port,health_path) VALUES ($1,$2,'daemon','installation',4400,'/health')",
            [reinstalled, cAlice]);
        await lease(reinstalled, cAlice, 4400);
        await reject(tx, '23514', 'DELETE FROM ezil_app_installations WHERE id=$1', [iAlice]);

        const [submission] = await tx.unsafe(
            "INSERT INTO ezil_app_submissions (submitted_by,repository_url,idempotency_key) VALUES ($1,'https://github.com/reticlehq/reticle','request-1') RETURNING id",
            [alice]);
        const [job] = await tx.unsafe(
            "INSERT INTO ezil_app_jobs (submission_id,requested_by,operation,idempotency_key) VALUES ($1,$2,'inspect','inspect-1') RETURNING id",
            [submission.id, alice]);
        await reject(tx, '23505',
            "INSERT INTO ezil_app_jobs (submission_id,requested_by,operation,idempotency_key) VALUES ($1,$2,'inspect','inspect-1')",
            [submission.id, alice]);
        await reject(tx, '23503',
            "INSERT INTO ezil_app_jobs (installation_id,computer_id,requested_by,operation,idempotency_key) VALUES ($1,$2,$3,'install','forged')",
            [iAlice, cBob, alice]);
        await tx.unsafe('INSERT INTO ezil_app_outbox (job_id) VALUES ($1)', [job.id]);
        await reject(tx, '23505', 'INSERT INTO ezil_app_outbox (job_id) VALUES ($1)', [job.id]);
        const [audit] = await tx.unsafe(
            "INSERT INTO ezil_app_audit_events (actor_user_id,action,app_id,release_id) VALUES ($1,'release.approved',$2,$3) RETURNING id",
            [admin, reticle, reticleRelease]);
        await reject(tx, '23514', "UPDATE ezil_app_audit_events SET action='tampered' WHERE id=$1", [audit.id]);
        await reject(tx, '23514', 'DELETE FROM ezil_app_audit_events WHERE id=$1', [audit.id]);

        await tx.unsafe('GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated');
        await tx.unsafe('SET LOCAL ROLE authenticated');
        await tx.unsafe("SELECT set_config('request.jwt.claim.sub',$1,true)", [alice]);
        await tx.unsafe("SELECT set_config('request.jwt.claim.role','authenticated',true)");
        for (const name of tables) {
            const [{ count }] = await tx.unsafe(`SELECT count(*)::int AS count FROM public.${name}`);
            assert.equal(count, 0, `authenticated must not directly read ${name}`);
        }
        await reject(tx, '42501',
            'INSERT INTO ezil_app_grants (user_id,app_id,granted_by) VALUES ($1,$2,$3)',
            [alice, reticle, admin]);
        await tx.unsafe('RESET ROLE');
        await tx.unsafe('DELETE FROM ezil_app_publications WHERE app_id=$1', [reticle]);
        await tx.unsafe("UPDATE ezil_app_releases SET status='revoked',revoked_at=now() WHERE id=$1", [reticleRelease]);
        await reject(tx, '23514', 'DELETE FROM ezil_app_releases WHERE id=$1', [reticleRelease]);
        throw rolledBack;
    });
} catch (error) {
    if (error !== rolledBack) throw error;
} finally {
    await db.end();
}
console.log('PASS marketplace migration: approval, computer ownership, installs, ports, folders, jobs, audit, and RLS');
