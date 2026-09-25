// Runs against an empty disposable loopback PostgreSQL database. The outer
// transaction rolls back the migrations and every fixture on success/failure.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TransactionSql } from 'postgres';

const databaseUrl = process.env.EZIL_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('EZIL_TEST_DATABASE_URL is required');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(databaseUrl).hostname)) {
    throw new Error('EZIL_TEST_DATABASE_URL must target loopback');
}
process.env.SUPABASE_DATABASE_URL = databaseUrl;
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://marketplace-api-test.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'marketplace-api-test-anon';
process.env.EZIL_APP_MARKETPLACE_API_ENABLED = 'true';
process.env.EZIL_APP_SUBMISSION_INTAKE_ENABLED = 'true';
process.env.EZIL_APP_INSTALL_ENABLED = 'true';
process.env.EZIL_OS_ACCESS_MODE = 'open';

const [{ default: postgres }, { drizzle }, { appRouter }, { buildTRPCContext }, schema] = await Promise.all([
    import('postgres'),
    import('drizzle-orm/pg-proxy'),
    import('../src/server/api/root'),
    import('../src/server/api/trpc'),
    import('../src/server/db/schema'),
]);

const db = postgres(databaseUrl, { max: 1, prepare: false, connect_timeout: 5 });
const migrations = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');
const rollback = Symbol('rolled-back');
const alice = '11111111-1111-4111-8111-111111111111';
const bob = '22222222-2222-4222-8222-222222222222';
const admin = '33333333-3333-4333-8333-333333333333';
const digest = `sha256:${'c'.repeat(64)}`;
const image = `123456789012.dkr.ecr.us-east-1.amazonaws.com/notes@sha256:${'b'.repeat(64)}`;
const commit = 'a'.repeat(40);
const requestId = '44444444-4444-4444-8444-444444444444';

async function migrate(tx: TransactionSql, file: string) {
    const content = await readFile(resolve(migrations, file), 'utf8');
    for (const statement of content.split('--> statement-breakpoint').map((part) => part.trim()).filter(Boolean)) {
        await tx.unsafe(statement);
    }
}

function manifest(appId: string, publisherId: string, slug: string) {
    return {
        schemaVersion: 2, appId, publisherId, name: slug === 'reticle' ? 'Reticle' : 'Notes',
        slug, version: '1.0.0',
        source: { kind: 'github', url: `https://github.com/acme/${slug}`, commitSha: commit },
        runtime: { profile: 'node24-computer-v1', architecture: 'linux/amd64' },
        build: { recipe: 'npm-ci-v1', script: 'build' },
        services: [{ name: 'web', protocol: 'http', scope: 'installation',
            process: { kind: 'node', entrypoint: 'dist/server.mjs', args: [] },
            internalPort: 8080, preferredHostPort: 4400,
            health: { path: '/health', status: 200 }, dependsOn: [] }],
        launch: { mode: 'web', service: 'web', path: '/', embedding: { mode: 'iframe', sandbox: ['allow-scripts'] } },
        configuration: slug === 'reticle' ? [{ name: 'THEME', kind: 'text', required: false }] : [],
        capabilities: [], secrets: [], egressOrigins: [],
        resources: { cpu: 0.25, memoryMiB: 512, ephemeralDiskMiB: 1024, maxRuntimeSeconds: 3600 },
        persistence: { mode: 'computer-volume',
            privateDirectories: [{ name: 'state', containerPath: '/data/state' }],
            sharedFolders: [], backup: { mode: 'daily-snapshot' } },
        update: { strategy: 'compatible', stateVersion: '1' },
    };
}

function errorCode(error: unknown): string | undefined {
    return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined;
}

try {
    await db.begin(async (tx) => {
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
        for (const file of [
            '0000_massive_mole_man.sql', '0001_telemetry.sql', '0002_os_access.sql',
            '0003_computer_runtime.sql', '0004_app_marketplace.sql',
        ]) await migrate(tx, file);

        const computer = async (userId: string, slot: number, provider: string) =>
            (await tx.unsafe('INSERT INTO ezil_computers (user_id,slot,provider) VALUES ($1,$2,$3) RETURNING id',
                [userId, slot, provider]))[0]!.id as string;
        const aliceComputer = await computer(alice, 1, 'aws-ec2');
        const aliceLegacy = await computer(alice, 2, 'cloudflare');
        const bobComputer = await computer(bob, 1, 'aws-ec2');
        await tx.unsafe('INSERT INTO ezil_app_admins (user_id) VALUES ($1)', [admin]);
        const [{ id: publisherId }] = await tx.unsafe(
            "INSERT INTO ezil_app_publishers (owner_user_id,display_name,status,invited_by) VALUES ($1,'Alice Apps','active',$2) RETURNING id",
            [alice, admin]);
        const makeApp = async (slug: string, visibility: string) =>
            (await tx.unsafe(
                'INSERT INTO ezil_apps (publisher_id,slug,name,summary,category,visibility) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
                [publisherId, slug, slug === 'reticle' ? 'Reticle' : 'Notes', 'Test application', 'Development', visibility],
            ))[0]!.id as string;
        const reticleApp = await makeApp('reticle', 'grant-only');
        const notesApp = await makeApp('notes', 'all-authenticated');
        async function makeRelease(appId: string, slug: string) {
            const { ComputerAppManifestV2Schema, getComputerManifestDigest } =
                await import('../src/server/app-platform/computer-app-manifest');
            const { ApprovedComputerAppPolicyV2Schema, getComputerPolicyDigest,
                validateComputerPolicyAgainstManifest } =
                await import('../src/server/app-platform/approved-computer-app-policy');
            const application = ComputerAppManifestV2Schema.parse(manifest(appId, publisherId, slug));
            const manifestDigest = getComputerManifestDigest(application);
            const approval = ApprovedComputerAppPolicyV2Schema.parse({
                schemaVersion: 2, manifestDigest,
                image: { reference: image, provenanceDigest: digest },
                allowedOsOrigins: ['https://cloud.ezil.org'], appOriginBase: 'https://apps.ezil.org',
                launch: { mode: 'web', embedding: application.launch.mode === 'web'
                    ? application.launch.embedding : { mode: 'external' } },
                services: [{ name: 'web', scope: 'installation', processKind: 'node', internalPort: 8080 }],
                capabilities: [], secretBindings: [], egressOrigins: [],
                mounts: { privateDirectories: ['state'], sharedFolders: [] },
                resources: { cpuLimit: 0.25, memoryLimitMiB: 512,
                    ephemeralDiskLimitMiB: 1024, maxRuntimeSeconds: 3600 },
                lifecycle: { idleTimeoutSeconds: 600 }, quotas: { runningAppsPerComputer: 2 },
                backup: { mode: 'daily-snapshot', retentionDays: 7 },
            });
            assert.equal(validateComputerPolicyAgainstManifest(application, approval).success, true);
            const [{ id }] = await tx.unsafe(
                `INSERT INTO ezil_app_releases
                 (app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
                 VALUES ($1,'1.0.0',$2::jsonb,$3::jsonb,$4,$5,$6,$7,$8) RETURNING id`,
                [appId, application, approval, manifestDigest,
                    getComputerPolicyDigest(approval), image, digest, commit],
            );
            await tx.unsafe("UPDATE ezil_app_releases SET status='validated' WHERE id=$1", [id]);
            await tx.unsafe("UPDATE ezil_app_releases SET status='approved',approved_by=$2,approved_at=now() WHERE id=$1",
                [id, admin]);
            await tx.unsafe('INSERT INTO ezil_app_publications (app_id,release_id,published_by) VALUES ($1,$2,$3)',
                [appId, id, admin]);
            return id as string;
        }
        const reticleRelease = await makeRelease(reticleApp, 'reticle');
        await makeRelease(notesApp, 'notes');
        await tx.unsafe('INSERT INTO ezil_app_grants (user_id,app_id,granted_by) VALUES ($1,$2,$3)',
            [alice, reticleApp, admin]);
        const [{ id: installationId }] = await tx.unsafe(
            'INSERT INTO ezil_app_installations (computer_id,app_id,release_id,installed_by) VALUES ($1,$2,$3,$4) RETURNING id',
            [aliceComputer, reticleApp, reticleRelease, alice]);
        await tx.unsafe("INSERT INTO ezil_app_services (installation_id,computer_id,name,scope,internal_port,preferred_host_port,health_path) VALUES ($1,$2,'web','installation',8080,4400,'/health')",
            [installationId, aliceComputer]);
        await tx.unsafe("INSERT INTO ezil_app_port_leases (installation_id,computer_id,service_name,host_port) VALUES ($1,$2,'web',4400)",
            [installationId, aliceComputer]);

        // pg-proxy maps SQL results through the same Drizzle schema as the
        // production postgres-js driver, while tx keeps every write rollbackable.
        const queryDb = drizzle(async (query, params) => {
            // Positional rows preserve duplicate column names across joins.
            const rows = await tx.unsafe(query, params).values();
            return { rows };
        }, { schema });
        Object.assign(queryDb, { transaction: async (fn: (db: typeof queryDb) => Promise<unknown>) => fn(queryDb) });
        const callerFor = (id: string | null) => appRouter.createCaller(buildTRPCContext({
            db: queryDb as unknown as Parameters<typeof buildTRPCContext>[0]['db'],
            user: id ? { id, email: `${id}@example.com` } as never : null,
            headers: new Headers(), mode: 'open',
        }));
        const aliceCaller = callerFor(alice);
        const bobCaller = callerFor(bob);
        const adminCaller = callerFor(admin);

        assert.deepEqual((await aliceCaller.apps.catalog()).map((item) => item.slug), ['notes', 'reticle']);
        assert.deepEqual((await bobCaller.apps.catalog()).map((item) => item.slug), ['notes']);
        const storedManifest = (await tx.unsafe('SELECT manifest FROM ezil_app_releases WHERE id=$1', [reticleRelease]))[0]!.manifest;
        const { validateComputerAppManifest } = await import('../src/server/app-platform/computer-app-manifest');
        const validation = validateComputerAppManifest(storedManifest);
        assert.equal(validation.success, true, JSON.stringify(validation));
        const details = await aliceCaller.apps.details({ appId: reticleApp });
        assert.equal(details.source.kind, 'github');
        assert.equal(details.configuration[0]?.name, 'THEME');
        assert.equal(JSON.stringify(details).includes('policy'), false);
        assert.equal(errorCode(await bobCaller.apps.details({ appId: reticleApp }).catch((error) => error)), 'NOT_FOUND');
        assert.equal(errorCode(await bobCaller.apps.installed({ computerId: aliceComputer }).catch((error) => error)), 'NOT_FOUND');
        assert.deepEqual(await aliceCaller.apps.installed({ computerId: aliceLegacy }), []);
        const installed = await aliceCaller.apps.installed({ computerId: aliceComputer });
        assert.equal(installed.length, 1);
        assert.equal(installed[0]?.id, installationId);
        assert.deepEqual(await bobCaller.apps.installed({ computerId: bobComputer }), []);

        const installRequest = { computerId: aliceComputer, appId: notesApp,
            clientRequestId: '77777777-7777-4777-8777-777777777777' };
        assert.equal(errorCode(await bobCaller.apps.install(installRequest).catch((error) => error)), 'NOT_FOUND');
        assert.equal(errorCode(await aliceCaller.apps.install({ ...installRequest, computerId: aliceLegacy })
            .catch((error) => error)), 'PRECONDITION_FAILED');
        assert.equal(errorCode(await bobCaller.apps.install({ ...installRequest, computerId: bobComputer,
            appId: reticleApp }).catch((error) => error)), 'NOT_FOUND');
        const installedNotes = await aliceCaller.apps.install(installRequest);
        assert.equal(installedNotes.status, 'pending');
        assert.equal(installedNotes.reused, false);
        assert.deepEqual(await aliceCaller.apps.install({ ...installRequest,
            clientRequestId: '88888888-8888-4888-8888-888888888888' }), {
            ...installedNotes, reused: true,
        });
        const [{ internalPort, hostPort }] = await tx.unsafe(`SELECT
            s.internal_port AS "internalPort", l.host_port AS "hostPort"
            FROM ezil_app_services s JOIN ezil_app_port_leases l
              ON l.installation_id=s.installation_id AND l.service_name=s.name
            WHERE s.installation_id=$1`, [installedNotes.installationId]);
        assert.deepEqual({ internalPort, hostPort }, { internalPort: 8080, hostPort: 20000 });
        const bobNotes = await bobCaller.apps.install({ ...installRequest, computerId: bobComputer,
            clientRequestId: '99999999-9999-4999-8999-999999999999' });
        const [{ hostPort: bobPort }] = await tx.unsafe('SELECT host_port AS "hostPort" FROM ezil_app_port_leases WHERE installation_id=$1',
            [bobNotes.installationId]);
        assert.equal(bobPort, 4400, 'ports may repeat on separate computers');
        assert.notEqual(installedNotes.installationId, bobNotes.installationId);
        const [{ installJobs, installEvents, folderGrants }] = await tx.unsafe(`SELECT
            (SELECT count(*)::int FROM ezil_app_jobs WHERE installation_id=$1 AND operation='install') AS "installJobs",
            (SELECT count(*)::int FROM ezil_app_outbox WHERE job_id=$2) AS "installEvents",
            (SELECT count(*)::int FROM ezil_app_folder_grants WHERE installation_id=$1) AS "folderGrants"`,
        [installedNotes.installationId, installedNotes.jobId]);
        assert.deepEqual({ installJobs, installEvents, folderGrants },
            { installJobs: 1, installEvents: 1, folderGrants: 0 });

        const request = { schemaVersion: 1 as const,
            repositoryUrl: 'https://github.com/reticlehq/reticle',
            requestedCommitSha: '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19',
            clientRequestId: requestId };
        assert.equal(errorCode(await bobCaller.appSubmissions.create(request).catch((error) => error)), 'FORBIDDEN');
        const created = await aliceCaller.appSubmissions.create(request);
        assert.equal(created.status, 'queued');
        assert.deepEqual(await aliceCaller.appSubmissions.create(request), created);
        assert.equal(errorCode(await aliceCaller.appSubmissions.create({ ...request,
            repositoryUrl: 'https://github.com/acme/another' }).catch((error) => error)), 'CONFLICT');
        assert.equal((await adminCaller.appSubmissions.status({ id: created.id })).status, 'queued');
        assert.equal(errorCode(await bobCaller.appSubmissions.status({ id: created.id }).catch((error) => error)), 'NOT_FOUND');
        assert.equal(errorCode(await bobCaller.appSubmissions.cancel({ id: created.id }).catch((error) => error)), 'NOT_FOUND');
        assert.deepEqual(await aliceCaller.appSubmissions.cancel({ id: created.id }), { id: created.id, status: 'cancelled' });
        assert.deepEqual(await aliceCaller.appSubmissions.cancel({ id: created.id }), { id: created.id, status: 'cancelled' });
        const [{ jobCount, eventCount, cancelAuditCount }] = await tx.unsafe(`SELECT
            (SELECT count(*)::int FROM ezil_app_jobs WHERE submission_id=$1) AS "jobCount",
            (SELECT count(*)::int FROM ezil_app_outbox WHERE job_id=$2) AS "eventCount",
            (SELECT count(*)::int FROM ezil_app_audit_events WHERE submission_id=$1 AND action='submission.cancelled') AS "cancelAuditCount"`,
        [created.id, created.jobId]);
        assert.deepEqual({ jobCount, eventCount, cancelAuditCount }, { jobCount: 1, eventCount: 1, cancelAuditCount: 1 });
        const [{ status: jobStatus }] = await tx.unsafe('SELECT status FROM ezil_app_jobs WHERE id=$1', [created.jobId]);
        assert.equal(jobStatus, 'cancelled');
        await tx.unsafe('UPDATE ezil_app_submissions SET error_code=$2 WHERE id=$1',
            [created.id, 'https://private.example/token/secret-value']);
        assert.equal((await aliceCaller.appSubmissions.status({ id: created.id })).errorCode, 'inspection-failed');
        await tx.unsafe('UPDATE ezil_app_submissions SET inspection=$2::jsonb WHERE id=$1',
            [created.id, { secret: 'secret-value' }]);
        const invalid = await aliceCaller.appSubmissions.status({ id: created.id }).catch((error) => error);
        assert.equal(errorCode(invalid), 'INTERNAL_SERVER_ERROR');
        assert.equal(JSON.stringify(invalid).includes('secret-value'), false);

        throw rollback;
    });
} catch (error) {
    if (error !== rollback) throw error;
} finally {
    await db.end();
}
console.log('marketplace API PostgreSQL integration passed (catalog, scope, intake, install, ports, idempotency, cancellation)');
