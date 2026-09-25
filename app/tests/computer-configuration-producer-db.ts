import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { canonicalConfiguration, produceComputerConfiguration, type ComputerConfiguration } from '../src/server/app-platform/computer-configuration';
import { compileRuntimePlan } from '../src/server/app-platform/runtime-plan';
import { ApprovedComputerAppPolicyV2Schema, getComputerPolicyDigest } from '../src/server/app-platform/approved-computer-app-policy';
import { runtimeRecords } from './fixtures/runtime-release';
import { runtimeTestDatabase } from './helpers/runtime-database';

const fixture = await runtimeTestDatabase();
const { sql } = fixture;
const database = drizzle(sql, { schema });
const options = { database, enabled: true, osAccessMode: 'invite' as const };
let passed = 0;
const test = async (name: string, fn: () => Promise<void>) => { await fn(); passed++; console.log(`PASS ${name}`); };
const hash = (body: string) => createHash('sha256').update(body).digest('hex');
const handle = (prefix: string) => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 17)}`;
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    const admin = randomUUID();
    await sql`INSERT INTO auth.users(id,email) VALUES (${admin},'config-admin@example.com')`;
    await sql`INSERT INTO ezil_app_admins(user_id) VALUES (${admin})`;
    async function computer() {
        const owner = randomUUID(), id = randomUUID(), email = `${owner}@example.com`;
        await sql`INSERT INTO auth.users(id,email) VALUES (${owner},${email})`;
        await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'test')`;
        await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${id},${owner},1,'aws-ec2')`;
        await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,availability_zone,data_volume_id,desired_state)
            VALUES (${id},'us-east-1','us-east-1a',${handle('vol')},'running')`;
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,observed_state,observed_at)
            VALUES (${id},1,${handle('i')},'running',now())`;
        return { id, owner, email };
    }
    type Computer = Awaited<ReturnType<typeof computer>>;
    async function installation(c: Computer, kind: 'node' | 'reticle' = 'node', port = 4400, memoryMiB = 512, runningLimit = 2) {
        const publisherOwner = randomUUID();
        await sql`INSERT INTO auth.users(id,email) VALUES (${publisherOwner},${`${publisherOwner}@example.com`})`;
        const [publisher] = await sql`INSERT INTO ezil_app_publishers(owner_user_id,display_name,status,invited_by)
            VALUES (${publisherOwner},'Test','active',${admin}) RETURNING id`;
        const records = runtimeRecords(kind, { appId: randomUUID(), publisherId: publisher!.id,
            installationId: randomUUID(), releaseId: randomUUID() }, manifest => {
            manifest.slug = `test-${randomUUID()}`; manifest.resources.memoryMiB = memoryMiB;
        });
        records.leases[0]!.hostPort = port;
        const policy = ApprovedComputerAppPolicyV2Schema.parse(records.release.policy);
        policy.quotas.runningAppsPerComputer = runningLimit;
        records.release.policy = policy; records.release.policyDigest = getComputerPolicyDigest(policy);
        const r = records.release, id = records.installationId;
        await sql`INSERT INTO ezil_apps(id,publisher_id,slug,name,summary,category,visibility)
            VALUES (${records.app.id},${publisher!.id},${records.app.slug},'Test','Test','Development','grant-only')`;
        await sql`INSERT INTO ezil_app_releases(id,app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
            VALUES (${r.id},${records.app.id},${r.version},${JSON.stringify(r.manifest)}::jsonb,${JSON.stringify(r.policy)}::jsonb,
                ${r.manifestDigest},${r.policyDigest},${r.imageReference},${r.provenanceDigest},${r.sourceCommitSha})`;
        await sql`UPDATE ezil_app_releases SET status='validated' WHERE id=${r.id}`;
        await sql`UPDATE ezil_app_releases SET status='approved',approved_by=${admin},approved_at=now() WHERE id=${r.id}`;
        await sql`INSERT INTO ezil_app_grants(user_id,app_id,granted_by) VALUES (${c.owner},${records.app.id},${admin})`;
        await sql`INSERT INTO ezil_app_installations(id,computer_id,app_id,release_id,installed_by)
            VALUES (${id},${c.id},${records.app.id},${r.id},${c.owner})`;
        const s = records.services[0]!;
        await sql`INSERT INTO ezil_app_services(installation_id,computer_id,name,protocol,scope,internal_port,health_path)
            VALUES (${id},${c.id},${s.name},${s.protocol},${s.scope},${s.internalPort},${s.healthPath})`;
        await sql`INSERT INTO ezil_app_port_leases(installation_id,computer_id,service_name,host_port) VALUES (${id},${c.id},${s.name},${port})`;
        const [job] = await sql`INSERT INTO ezil_app_jobs(installation_id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${id},${c.id},${c.owner},'install',${randomUUID()}) RETURNING id`;
        await sql`INSERT INTO ezil_app_outbox(job_id) VALUES (${job!.id})`;
        return { id, records, installJobId: job!.id as string, c };
    }
    type Installation = Awaited<ReturnType<typeof installation>>;
    async function command(i: Installation, operation: 'start' | 'stop' = 'start', generation?: number) {
        await sql`UPDATE ezil_app_installations SET status='installed',installed_at=now() WHERE id=${i.id}`;
        const [latest] = await sql`SELECT coalesce(max(generation),0)::int n FROM ezil_app_runtime_commands WHERE installation_id=${i.id}`;
        const [writer] = await sql`SELECT generation FROM ezil_computer_instances WHERE computer_id=${i.c.id} AND fenced_at IS NULL`;
        return sql.begin(async tx => {
            const [job] = await tx`INSERT INTO ezil_app_jobs(installation_id,computer_id,requested_by,operation,idempotency_key)
                VALUES (${i.id},${i.c.id},${i.c.owner},${operation},${randomUUID()}) RETURNING id`;
            await tx`INSERT INTO ezil_app_outbox(job_id) VALUES (${job!.id})`;
            await tx`INSERT INTO ezil_app_runtime_commands(job_id,installation_id,computer_id,app_id,release_id,computer_generation,generation,auth_generation,operation,plan)
                VALUES (${job!.id},${i.id},${i.c.id},${i.records.app.id},${i.records.release.id},${generation ?? writer!.generation},
                    ${latest!.n + 1},1,${operation},${JSON.stringify(compileRuntimePlan(i.records))}::jsonb)`;
            return job!.id as string;
        });
    }
    async function produce(c: Computer) {
        const result = await produceComputerConfiguration(options, c.id);
        assert.ok('configurationId' in result);
        const [row] = await sql`SELECT configuration,digest FROM ezil_computer_configurations WHERE id=${result.configurationId}`;
        const config = JSON.parse(row!.configuration) as ComputerConfiguration;
        assert.equal(canonicalConfiguration(config), row!.configuration);
        assert.equal(hash(row!.configuration), result.digest);
        return { ...result, config };
    }
    const bindings = (id: string) => sql`SELECT * FROM ezil_computer_configuration_installations WHERE configuration_id=${id}`;
    await test('disabled producer does not touch even an unavailable database', async () => {
        assert.deepEqual(await produceComputerConfiguration({ ...options, database: null as never, enabled: false }, randomUUID()), { state: 'disabled' });
    });
    await test('Reticle preparation requires no invented project, runtime command or installed success', async () => {
        const c = await computer(), i = await installation(c, 'reticle'); const s = await produce(c);
        assert.equal(s.state, 'created'); assert.equal(s.revision, 1);
        assert.equal(s.config.preparedInstallations[0]!.installationId, i.id); assert.deepEqual(s.config.approvedInstallations, []);
        assert.equal((await bindings(s.configurationId))[0]!.runtime_job_id, null);
        assert.equal((await sql`SELECT status FROM ezil_app_installations WHERE id=${i.id}`)[0]!.status, 'pending');
        assert.equal((await sql`SELECT status FROM ezil_app_jobs WHERE id=${i.installJobId}`)[0]!.status, 'queued');
        const [delivery] = await sql`SELECT * FROM ezil_computer_configuration_deliveries WHERE configuration_id=${s.configurationId}`;
        assert.equal(delivery!.prepared_at, null); assert.equal(delivery!.loaded_at, null);
        assert.equal((await produce(c)).configurationId, s.configurationId);
    });
    await test('full snapshots retain other installations and isolate two computers with the same port', async () => {
        const a = await computer(), b = await computer();
        const retained = await installation(a); await command(retained);
        const first = await produce(a); const added = await installation(a, 'reticle', 20000); const other = await installation(b);
        const next = await produce(a), separate = await produce(b);
        assert.deepEqual(next.config.preparedInstallations.map(i => i.installationId).sort(), [retained.id, added.id].sort());
        assert.equal(next.config.approvedInstallations[0]!.installationId, retained.id);
        assert.deepEqual(separate.config.preparedInstallations.map(i => i.installationId), [other.id]);
        assert.notEqual(next.config.volumeId, separate.config.volumeId);
        assert.equal((await bindings(next.configurationId)).length, 2);
        assert.ok((await sql`SELECT superseded_at FROM ezil_computer_configuration_deliveries WHERE configuration_id=${first.configurationId}`)[0]!.superseded_at);
    });
    await test('simultaneous producers create one revision and reuse it for the loser', async () => {
        const c = await computer(); await installation(c);
        const results = await Promise.all([produce(c), produce(c)]);
        assert.deepEqual(results.map(r => r.state).sort(), ['created', 'reused']);
        assert.equal(results[0]!.configurationId, results[1]!.configurationId);
    });
    await test('two users preparing the same release receive only their own installation bindings', async () => {
        const a = await computer(), b = await computer(), i = await installation(a), otherId = randomUUID();
        await sql`INSERT INTO ezil_app_grants(user_id,app_id,granted_by) VALUES (${b.owner},${i.records.app.id},${admin})`;
        await sql`INSERT INTO ezil_app_installations(id,computer_id,app_id,release_id,installed_by)
            VALUES (${otherId},${b.id},${i.records.app.id},${i.records.release.id},${b.owner})`;
        const [job] = await sql`INSERT INTO ezil_app_jobs(installation_id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${otherId},${b.id},${b.owner},'install',${randomUUID()}) RETURNING id`;
        await sql`INSERT INTO ezil_app_outbox(job_id) VALUES (${job!.id})`;
        const first = await produce(a), second = await produce(b);
        assert.equal(first.config.preparedInstallations[0]!.image, second.config.preparedInstallations[0]!.image);
        assert.equal(second.config.preparedInstallations[0]!.installationId, otherId);
        assert.equal((await bindings(second.configurationId))[0]!.computer_id, b.id);
        assert.equal(JSON.stringify(second.config).includes(i.id), false);
        assert.notEqual(first.config.volumeId, second.config.volumeId);
    });
    await test('identical new Start bytes still require a new immutable command binding', async () => {
        const c = await computer(), i = await installation(c); const start = await command(i); const first = await produce(c);
        const nextStart = await command(i); const next = await produce(c);
        assert.deepEqual(first.config.approvedInstallations, next.config.approvedInstallations);
        assert.equal(next.revision, first.revision + 1);
        assert.equal((await bindings(first.configurationId))[0]!.runtime_job_id, start);
        assert.equal((await bindings(next.configurationId))[0]!.runtime_job_id, nextStart);
        await command(i, 'stop'); assert.deepEqual((await produce(c)).config.approvedInstallations, []);
    });
    await test('successful install acknowledgement can reuse its job binding without rewriting receipt history', async () => {
        const c = await computer(), i = await installation(c); const first = await produce(c);
        await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now(),loaded_at=now(),loaded_digest=${first.digest}
            WHERE configuration_id=${first.configurationId}`;
        await sql`UPDATE ezil_app_installations SET status='installed',installed_at=now() WHERE id=${i.id}`;
        await sql`UPDATE ezil_app_jobs SET status='succeeded',completed_at=now() WHERE id=${i.installJobId}`;
        assert.equal((await produce(c)).configurationId, first.configurationId);
        await installation(c, 'reticle', 20000); await produce(c);
        const [receipt] = await sql`SELECT loaded_digest,superseded_at FROM ezil_computer_configuration_deliveries WHERE configuration_id=${first.configurationId}`;
        assert.equal(receipt!.loaded_digest, first.digest); assert.equal(receipt!.superseded_at, null);
    });
    await test('cancelled pending install is removed; retry changes the job binding', async () => {
        const c = await computer(), i = await installation(c); const first = await produce(c);
        await sql`UPDATE ezil_app_jobs SET status='cancelled',completed_at=now() WHERE id=${i.installJobId}`;
        assert.deepEqual((await produce(c)).config.preparedInstallations, []);
        const [job] = await sql`INSERT INTO ezil_app_jobs(installation_id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${i.id},${c.id},${c.owner},'install',${randomUUID()}) RETURNING id`;
        await sql`INSERT INTO ezil_app_outbox(job_id) VALUES (${job!.id})`;
        const retry = await produce(c); assert.notEqual(retry.configurationId, first.configurationId);
        assert.equal((await bindings(retry.configurationId))[0]!.install_job_id, job!.id);
    });
    await test('grant, publisher, release and installation revocation remove only that app', async () => {
        for (const kind of ['grant', 'publisher', 'release', 'uninstall']) {
            const c = await computer(), i = await installation(c), keep = await installation(c, 'node', 20000);
            await command(i); await produce(c);
            if (kind === 'grant') await sql`UPDATE ezil_app_grants SET revoked_at=now() WHERE app_id=${i.records.app.id}`;
            if (kind === 'publisher') await sql`UPDATE ezil_app_publishers SET status='revoked',revoked_at=now() WHERE id=${i.records.app.publisherId}`;
            if (kind === 'release') await sql`UPDATE ezil_app_releases SET status='revoked',revoked_at=now() WHERE id=${i.records.release.id}`;
            if (kind === 'uninstall') await sql`UPDATE ezil_app_installations SET status='uninstalled',uninstalled_at=now() WHERE id=${i.id}`;
            const next = await produce(c);
            assert.deepEqual(next.config.preparedInstallations.map(x => x.installationId), [keep.id]);
            assert.deepEqual(next.config.approvedInstallations, []);
        }
    });
    await test('bans, deleted users, OS revocation and lifecycle stops produce empty suspended configurations', async () => {
        for (const kind of ['ban', 'deleted', 'os', 'stop', 'replace']) {
            const c = await computer(), i = await installation(c); await command(i); await produce(c);
            if (kind === 'ban') await sql`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=${c.owner}`;
            if (kind === 'deleted') await sql`UPDATE auth.users SET deleted_at=now() WHERE id=${c.owner}`;
            if (kind === 'os') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
            if (kind === 'stop') await sql`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.id}`;
            if (kind === 'replace') await sql`INSERT INTO ezil_computer_lifecycle_jobs(computer_id,operation,idempotency_key)
                VALUES (${c.id},'replace',${randomUUID()})`;
            const next = await produce(c); assert.equal(next.config.suspended, true);
            assert.deepEqual(next.config.preparedInstallations, []); assert.deepEqual(next.config.approvedInstallations, []);
            assert.equal((await bindings(next.configurationId)).length, 0);
            assert.equal((await produce(c)).configurationId, next.configurationId);
        }
    });
    await test('project grants are real owner consent and revocation removes execution while retaining preparation', async () => {
        const c = await computer(), i = await installation(c, 'reticle'), projectId = randomUUID();
        i.records.projectId = projectId;
        i.records.grants = [{ folder: 'Projects', scope: 'selected-projects', access: 'read-write', projectId }];
        const start = await command(i);
        assert.deepEqual((await produce(c)).config.approvedInstallations, []);
        await sql`INSERT INTO ezil_app_folder_grants(installation_id,computer_id,folder,scope,project_id,access,granted_by)
            VALUES (${i.id},${c.id},'Projects','selected-projects',${projectId},'read-write',${c.owner})`;
        const connected = await produce(c); assert.equal(connected.config.approvedInstallations.length, 1);
        assert.equal((await bindings(connected.configurationId))[0]!.runtime_job_id, start);
        await sql`UPDATE ezil_app_folder_grants SET revoked_at=now() WHERE installation_id=${i.id}`;
        const revoked = await produce(c); assert.equal(revoked.config.preparedInstallations.length, 1);
        assert.deepEqual(revoked.config.approvedInstallations, []);
    });
    await test('replacement advances configuration history without approving old generation commands', async () => {
        const c = await computer(), i = await installation(c); await command(i); const first = await produce(c);
        await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.id}`;
        assert.deepEqual(await produceComputerConfiguration(options, c.id), { state: 'unavailable' });
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,observed_state,observed_at)
            VALUES (${c.id},2,${handle('i')},'running',now())`;
        const next = await produce(c); assert.equal(next.revision, first.revision + 1);
        assert.equal(next.config.computerGeneration, 2); assert.equal(next.config.volumeId, first.config.volumeId);
        assert.deepEqual(next.config.approvedInstallations, []);
    });
    await test('failed commands, changed authorization and changed ports never reuse executable authority', async () => {
        for (const kind of ['failed', 'authorization', 'port']) {
            const c = await computer(), i = await installation(c); const start = await command(i); const first = await produce(c);
            if (kind === 'failed') await sql`UPDATE ezil_app_jobs SET status='failed',completed_at=now() WHERE id=${start}`;
            if (kind === 'authorization') await sql`UPDATE ezil_app_installations SET auth_generation=2 WHERE id=${i.id}`;
            if (kind === 'port') await sql`UPDATE ezil_app_port_leases SET released_at=now() WHERE installation_id=${i.id}`;
            const next = await produce(c); assert.notEqual(next.configurationId, first.configurationId);
            assert.deepEqual(next.config.approvedInstallations, []);
        }
    });
    await test('excess simultaneous apps or memory produce a revocable suspended snapshot', async () => {
        for (const [count, memory] of [[3, 512], [2, 2048]]) {
            const c = await computer();
            for (let index = 0; index < count!; index++) await command(await installation(c, 'node', 20000 + index, memory));
            const s = await produce(c); assert.equal(s.config.suspended, true);
            assert.deepEqual(s.config.preparedInstallations, []); assert.deepEqual(s.config.approvedInstallations, []);
            assert.equal((await produce(c)).state, 'reused');
        }
    });
    await test('a lower approved app quota is enforced across the computer', async () => {
        const c = await computer(); await command(await installation(c, 'node', 4400, 512, 1));
        await command(await installation(c, 'node', 20000));
        assert.equal((await produce(c)).config.suspended, true);
    });
    await test('legacy, deleted and unprovisioned computers cannot create provider configuration', async () => {
        for (const kind of ['legacy', 'deleted', 'disk', 'region']) {
            const c = await computer();
            if (kind === 'legacy') {
                await sql`DELETE FROM ezil_computer_instances WHERE computer_id=${c.id}`;
                await sql`DELETE FROM ezil_computer_runtimes WHERE computer_id=${c.id}`;
                await sql`UPDATE ezil_computers SET provider='cloudflare' WHERE id=${c.id}`;
            }
            if (kind === 'deleted') await sql`UPDATE ezil_computers SET deleted_at=now() WHERE id=${c.id}`;
            if (kind === 'disk') await sql`UPDATE ezil_computer_runtimes SET data_volume_id=NULL,availability_zone=NULL WHERE computer_id=${c.id}`;
            if (kind === 'region') await sql`UPDATE ezil_computer_runtimes SET region='us-west-2' WHERE computer_id=${c.id}`;
            assert.deepEqual(await produceComputerConfiguration(options, c.id), { state: 'unavailable' });
        }
    });
    await test('raw database failures expose a fixed error without credentials or query values', async () => {
        const broken = { transaction: async () => { throw new Error('password-sensitive-sentinel'); } };
        await assert.rejects(produceComputerConfiguration({ ...options, database: broken as never }, randomUUID()), /^Error: computer_configuration_unavailable$/);
    });
    await test('producer holds actual authority locks through snapshot commit', async () => {
        const c = await computer(), i = await installation(c);
        await sql.unsafe(`CREATE FUNCTION public.test_pause_configuration() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN PERFORM pg_advisory_xact_lock(927641); RETURN NEW; END $$;
            CREATE TRIGGER test_pause_configuration BEFORE INSERT ON ezil_computer_configurations
            FOR EACH ROW EXECUTE FUNCTION public.test_pause_configuration();`);
        const lock = await sql.reserve();
        await lock`SELECT pg_advisory_lock(927641)`;
        const producing = produce(c);
        const waitFor = async (fragment: string) => {
            for (let attempt = 0; attempt < 100; attempt++) {
                const [state] = await sql`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
                    AND wait_event_type='Lock' AND position(${fragment} in query)>0) waiting`;
                if (state!.waiting) return;
                await delay(20);
            }
            assert.fail('expected a real database lock wait');
        };
        let revoking: Promise<unknown> | undefined;
        try {
            await waitFor('insert into "ezil_computer_configurations"');
            revoking = sql`UPDATE ezil_app_grants /* producer-authority-revocation */ SET revoked_at=now() WHERE app_id=${i.records.app.id}`.then(rows => rows);
            await waitFor('producer-authority-revocation');
        } finally { await lock`SELECT pg_advisory_unlock(927641)`; lock.release(); }
        await producing; await revoking;
        await sql.unsafe('DROP TRIGGER test_pause_configuration ON ezil_computer_configurations; DROP FUNCTION public.test_pause_configuration();');
        assert.deepEqual((await produce(c)).config.preparedInstallations, []);
    });
    if (process.env.EZIL_TEST_CONFIGURATION_OUTPUT) {
        const snapshots = await sql`SELECT configuration,digest FROM ezil_computer_configurations ORDER BY created_at,id`;
        await writeFile(process.env.EZIL_TEST_CONFIGURATION_OUTPUT, JSON.stringify(snapshots), { mode: 0o600 });
    }
    console.log(`${passed} pass, 0 fail, 0 skip — actual PostgreSQL configuration producer`);
} finally { await fixture.close(); }
