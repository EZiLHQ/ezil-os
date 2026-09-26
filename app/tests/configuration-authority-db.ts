import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { produceComputerConfiguration } from '../src/server/app-platform/computer-configuration';
import { authorizeConfigurationWork } from '../src/server/app-platform/configuration-authority';
import { configurationMountConfirmed } from '../src/server/app-platform/configuration-mount';
import { eq } from 'drizzle-orm';
import { createConfigurationAuthorityHandler } from '../src/server/app-platform/configuration-authority-http';
import { CONFIGURATION_AUTHORITY_PATH, configurationAuthoritySignature,
    type ConfigurationAuthorityRequest } from '../src/server/app-platform/configuration-authority-protocol';
import { claimConfigurationDelivery, dispatchConfigurationClaim } from '../src/server/app-platform/configuration-delivery';
import { runtimeRecords } from './fixtures/runtime-release';
import { dataMountComputer } from './fixtures/data-mount';
import { recordConfigurationMount, restartConfigurationComputer, ageConfigurationMount } from './fixtures/configuration-mount';
import { runtimeTestDatabase } from './helpers/runtime-database';

const fixture = await runtimeTestDatabase(); const { sql } = fixture;
const options = { database: drizzle(sql, { schema }), enabled: true, osAccessMode: 'invite' as const };
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const handle = (prefix: string) => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 17)}`;
const secret = 'ab'.repeat(32);
const handler = createConfigurationAuthorityHandler({ enabled: true, secret, authorize: input => authorizeConfigurationWork(options, input) });
function signed(input: ConfigurationAuthorityRequest) {
    const body = Buffer.from(JSON.stringify(input)); const timestamp = String(Math.floor(Date.now() / 1000));
    return new Request(`https://control.example${CONFIGURATION_AUTHORITY_PATH}`, { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp,
            'x-ezil-workflow-signature': configurationAuthoritySignature(body, secret, timestamp) } });
}
async function reference(id: string): Promise<ConfigurationAuthorityRequest> {
    const [row] = await sql`SELECT * FROM ezil_computer_configurations WHERE id=${id}`;
    assert.ok(row);
    return { schemaVersion: 1, configurationId: id, operation: 'prepare', revision: row.revision, digest: row.digest,
        scope: { computerId: row.computer_id, computerGeneration: row.computer_generation,
            providerInstanceId: row.provider_instance_id, dataVolumeId: row.data_volume_id, fenceToken: row.fence_token } };
}
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    const admin = randomUUID();
    await sql`INSERT INTO auth.users(id) VALUES (${admin})`;
    await sql`INSERT INTO ezil_app_admins(user_id) VALUES (${admin})`;
    async function setup(mounted = true) {
        const mountComputer = await dataMountComputer(sql);
        const { computerId, userId: owner } = mountComputer, email = `${owner}@example.com`;
        await sql`UPDATE auth.users SET email=${email} WHERE id=${owner}`;
        await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'test')`;
        const mountId = mounted ? await recordConfigurationMount(sql, mountComputer) : null;
        const [publisher] = await sql`INSERT INTO ezil_app_publishers(owner_user_id,display_name,status,invited_by)
            VALUES (${owner},'Test','active',${admin}) RETURNING id`;
        const records = runtimeRecords('reticle', { appId: randomUUID(), publisherId: publisher!.id,
            installationId: randomUUID(), releaseId: randomUUID() }, manifest => { manifest.slug = `test-${randomUUID()}`; });
        const r = records.release, installationId = records.installationId;
        await sql`INSERT INTO ezil_apps(id,publisher_id,slug,name,summary,category,visibility)
            VALUES (${records.app.id},${publisher!.id},${records.app.slug},'Reticle','Test','Development','grant-only')`;
        await sql`INSERT INTO ezil_app_releases(id,app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
            VALUES (${r.id},${records.app.id},${r.version},${JSON.stringify(r.manifest)}::jsonb,${JSON.stringify(r.policy)}::jsonb,
                ${r.manifestDigest},${r.policyDigest},${r.imageReference},${r.provenanceDigest},${r.sourceCommitSha})`;
        await sql`UPDATE ezil_app_releases SET status='validated' WHERE id=${r.id}`;
        await sql`UPDATE ezil_app_releases SET status='approved',approved_by=${admin},approved_at=now() WHERE id=${r.id}`;
        await sql`INSERT INTO ezil_app_grants(user_id,app_id,granted_by) VALUES (${owner},${records.app.id},${admin})`;
        await sql`INSERT INTO ezil_app_installations(id,computer_id,app_id,release_id,installed_by)
            VALUES (${installationId},${computerId},${records.app.id},${r.id},${owner})`;
        await sql`INSERT INTO ezil_app_services(installation_id,computer_id,name,scope,internal_port,health_path)
            VALUES (${installationId},${computerId},'daemon','selected-project',4400,'/status')`;
        await sql`INSERT INTO ezil_app_port_leases(installation_id,computer_id,service_name,host_port)
            VALUES (${installationId},${computerId},'daemon',4400)`;
        const [job] = await sql`INSERT INTO ezil_app_jobs(installation_id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${installationId},${computerId},${owner},'install',${randomUUID()}) RETURNING id`;
        await sql`INSERT INTO ezil_app_outbox(job_id) VALUES (${job!.id})`;
        const result = await produceComputerConfiguration(options, computerId); assert.ok('configurationId' in result);
        return { computerId, owner, email, records, installationId, mountComputer, mountId, jobId: job!.id as string, input: await reference(result.configurationId) };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;
    const check = (s: Setup) => authorizeConfigurationWork(options, s.input);
    const pending = async (s: Setup) => {
        const [row] = await sql`SELECT i.status installation,j.status job,o.delivered_at FROM ezil_app_installations i
            JOIN ezil_app_jobs j ON j.id=${s.jobId} JOIN ezil_app_outbox o ON o.job_id=j.id WHERE i.id=${s.installationId}`;
        assert.deepEqual(row, { installation: 'pending', job: 'queued', delivered_at: null });
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_runtime_commands WHERE computer_id=${s.computerId}`)[0]!.n, 0);
    };
    await test('disabled and malformed input do not open a database transaction', async () => {
        const unavailable = { ...options, database: null as never };
        assert.equal(await authorizeConfigurationWork({ ...unavailable, enabled: false }, null as never), false);
        assert.equal(await authorizeConfigurationWork(unavailable, {} as never), false);
    });
    await test('current preparation authorizes; reload requires a prepared receipt and never completes installation', async () => {
        const s = await setup(); assert.equal(await check(s), true);
        const reload = { ...s.input, operation: 'reload' as const };
        assert.equal(await authorizeConfigurationWork(options, reload), false);
        await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now() WHERE configuration_id=${s.input.configurationId}`;
        assert.equal(await authorizeConfigurationWork(options, reload), true); await pending(s);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_configurations WHERE computer_id=${s.computerId}`)[0]!.n, 1);
    });
    await test('running writer alone cannot authorize preparation or reload; a completed mount enables both', async () => {
        const s = await setup(false), reload = { ...s.input, operation: 'reload' as const };
        assert.equal(await check(s), false);
        await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now() WHERE configuration_id=${s.input.configurationId}`;
        assert.equal(await authorizeConfigurationWork(options, reload), false);
        await recordConfigurationMount(sql, s.mountComputer);
        assert.equal(await check(s), true); assert.equal(await authorizeConfigurationWork(options, reload), true);
        await pending(s);
    });
    await test('revoked mount denies identical signed preparation and reload without changing installation state', async () => {
        const s = await setup();
        await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now() WHERE configuration_id=${s.input.configurationId}`;
        await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${s.mountId}`;
        for (const operation of ['prepare', 'reload'] as const) {
            const response = await handler(signed({ ...s.input, operation }));
            assert.equal(response.status, 403); assert.deepEqual(await response.json(), { code: 'configuration_not_current' });
        }
        await pending(s);
    });
    await test('in-time completed mount remains valid after its execution grant expires', async () => {
        const s = await setup(); await ageConfigurationMount(sql, s.mountId!);
        assert.equal(await check(s), true); await pending(s);
    });
    await test('same-generation stop/start needs its own completed mount, even with identical configuration bytes', async () => {
        const s = await setup(), restarted = await restartConfigurationComputer(sql, s.mountComputer);
        const result = await produceComputerConfiguration(options, s.computerId);
        assert.ok('configurationId' in result); assert.equal(result.configurationId, s.input.configurationId);
        assert.equal(await check(s), false);
        await recordConfigurationMount(sql, restarted);
        assert.equal(await check(s), true); await pending(s);
    });
    await test('mount authority stays locked through the caller transaction, then committed revocation is visible', async () => {
        const s = await setup(); let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(r => { release = r; }), checked = new Promise<void>(r => { entered = r; });
        const holder = options.database.transaction(async tx => {
            await tx.select().from(schema.computers).where(eq(schema.computers.id, s.computerId)).for('update');
            const [target] = await tx.select().from(schema.computerConfigurations).where(eq(schema.computerConfigurations.id, s.input.configurationId));
            assert.equal(await configurationMountConfirmed(tx, target!), true); entered(); await gate;
        });
        await checked;
        try {
            await assert.rejects(sql.begin(async tx => {
                await tx`SET LOCAL lock_timeout='100ms'`;
                await tx`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${s.mountId}`;
            }), (error: { code?: string }) => error.code === '55P03');
        } finally { release(); await holder; }
        await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${s.mountId}`;
        assert.equal(await check(s), false); await pending(s);
    });
    await test('scope, revision, digest, fence and cross-computer forgeries fail', async () => {
        const s = await setup(), other = await setup();
        const variants = [{ ...s.input, revision: 2 }, { ...s.input, digest: 'f'.repeat(64) },
            { ...s.input, configurationId: other.input.configurationId },
            ...Object.entries({ computerId: other.computerId, computerGeneration: 2, providerInstanceId: handle('i'),
                dataVolumeId: handle('vol'), fenceToken: randomUUID() }).map(([key, value]) => ({ ...s.input, scope: { ...s.input.scope, [key]: value } }))];
        for (const variant of variants) assert.equal(await authorizeConfigurationWork(options, variant), false);
        await pending(s); await pending(other);
    });
    const revocations: Record<string, (s: Setup) => Promise<unknown>> = {
        grant: s => sql`UPDATE ezil_app_grants SET revoked_at=now() WHERE app_id=${s.records.app.id}`,
        release: s => sql`UPDATE ezil_app_releases SET status='revoked',revoked_at=now() WHERE id=${s.records.release.id}`,
        osAccess: s => sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`,
        ban: s => sql`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=${s.owner}`,
        publisher: s => sql`UPDATE ezil_app_publishers SET status='revoked',revoked_at=now() WHERE id=${s.records.app.publisherId}`,
        authorization: s => sql`UPDATE ezil_app_installations SET auth_generation=2 WHERE id=${s.installationId}`,
        job: s => sql`UPDATE ezil_app_jobs SET status='cancelled',completed_at=now() WHERE id=${s.jobId}`,
        port: s => sql`UPDATE ezil_app_port_leases SET released_at=now() WHERE installation_id=${s.installationId}`,
        service: s => sql`UPDATE ezil_app_services SET health_path='/changed' WHERE installation_id=${s.installationId}`,
    };
    for (const [name, revoke] of Object.entries(revocations)) await test(`identical signed request loses authority after ${name} revocation`, async () => {
        const s = await setup(), req = signed(s.input);
        await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now() WHERE configuration_id=${s.input.configurationId}`;
        const reload = signed({ ...s.input, operation: 'reload' });
        assert.equal((await handler(req.clone())).status, 200);
        assert.equal((await handler(reload.clone())).status, 200); await revoke(s);
        const rejected = await handler(req.clone()); assert.equal(rejected.status, 403);
        assert.equal((await handler(reload.clone())).status, 403);
        assert.deepEqual(await rejected.json(), { code: 'configuration_not_current' });
        assert.equal((await sql`SELECT status FROM ezil_app_installations WHERE id=${s.installationId}`)[0]!.status, 'pending');
        assert.ok((await sql`SELECT superseded_at FROM ezil_computer_configuration_deliveries WHERE configuration_id=${s.input.configurationId}`)[0]!.superseded_at);
    });
    await test('an empty suspended configuration remains deliverable without mount evidence after OS revocation', async () => {
        const s = await setup(false); await revocations.osAccess!(s);
        assert.equal(await check(s), false);
        const current = await produceComputerConfiguration(options, s.computerId); assert.ok('configurationId' in current);
        const ref = await reference(current.configurationId);
        const [row] = await sql`SELECT configuration::jsonb AS config FROM ezil_computer_configurations WHERE id=${ref.configurationId}`;
        assert.equal(row!.config.suspended, true); assert.deepEqual(row!.config.preparedInstallations, []);
        assert.equal((await handler(signed(ref))).status, 200); await pending(s);
    });
    for (const [name, update] of Object.entries({ stopped: "observed_state='stopped'", stale: "observed_at=now()-interval '6 minutes'",
        future: "observed_at=now()+interval '1 minute'", missing: 'observed_at=NULL', fenced: 'fenced_at=now()' })) {
        await test(`${name} writer cannot authorize host work`, async () => {
            const s = await setup();
            await sql.unsafe(`UPDATE ezil_computer_instances SET ${update} WHERE computer_id=$1`, [s.computerId]);
            assert.equal(await check(s), false); await pending(s);
        });
    }
    await test('replacement rejects old configuration even when the computer retains its data volume', async () => {
        const s = await setup();
        await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${s.computerId}`;
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,observed_state,observed_at)
            VALUES (${s.computerId},2,${handle('i')},'running',now())`;
        assert.equal(await check(s), false);
        const current = await produceComputerConfiguration(options, s.computerId); assert.ok('configurationId' in current);
        assert.equal(await authorizeConfigurationWork(options, await reference(current.configurationId)), false); await pending(s);
    });
    await test('concurrent checks, producer and delivery share lock order and preserve one snapshot', async () => {
        const s = await setup();
        await sql`UPDATE ezil_computer_configuration_deliveries SET available_at=now()+interval '1 day'
            WHERE loaded_at IS NULL AND superseded_at IS NULL`;
        await sql`UPDATE ezil_computer_configuration_deliveries SET available_at=now() WHERE configuration_id=${s.input.configurationId}`;
        const claim = await claimConfigurationDelivery(options); assert.ok(claim); assert.equal(claim.computerId, s.computerId);
        const result = await Promise.all([check(s), check(s), produceComputerConfiguration(options, s.computerId),
            dispatchConfigurationClaim({ ...options, advancePreparation: async () => ({ state: 'pending' }),
                requestReload: async () => { throw new Error('must not reload'); },
                resolveHost: async () => { throw new Error('must not contact host'); } }, claim)]);
        assert.equal(result[0], true); assert.equal(result[1], true); assert.equal(result[3], 'waiting');
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_configurations WHERE computer_id=${s.computerId}`)[0]!.n, 1);
        assert.equal((await sql`SELECT status FROM ezil_app_installations WHERE id=${s.installationId}`)[0]!.status, 'pending');
    });
    await test('a contended computer times out with a fixed code and no partial write', async () => {
        const s = await setup(); let release!: () => void, entered!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        const locked = new Promise<void>(resolve => { entered = resolve; });
        const holder = sql.begin(async tx => { await tx`SELECT id FROM ezil_computers WHERE id=${s.computerId} FOR UPDATE`; entered(); await gate; });
        await locked;
        try { await assert.rejects(check(s), { message: 'configuration_authority_unavailable' }); }
        finally { release(); await holder; }
        assert.equal(await check(s), true); await pending(s);
    });
    console.log(`${passed} configuration authority PostgreSQL tests passed; 0 failed`);
} finally { await fixture.close(); }
