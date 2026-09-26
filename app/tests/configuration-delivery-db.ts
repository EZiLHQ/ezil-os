import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { produceComputerConfiguration } from '../src/server/app-platform/computer-configuration';
import { claimConfigurationDelivery, dispatchConfigurationClaim, dispatchNextConfiguration,
    type ConfigurationDeliveryOptions, type ConfigurationWork } from '../src/server/app-platform/configuration-delivery';
import type { HostConfigurationObservation } from '../src/server/app-platform/host-control-client';
import { computerControlKeyIdentity } from '../src/server/app-platform/computer-control-key';
import { lifecycleDeployment } from './fixtures/lifecycle';
import { runtimeRecords } from './fixtures/runtime-release';
import { dataMountComputer } from './fixtures/data-mount';
import { recordConfigurationMount, restartConfigurationComputer, ageConfigurationMount } from './fixtures/configuration-mount';
import { runtimeTestDatabase } from './helpers/runtime-database';

const fixture = await runtimeTestDatabase(); const { sql } = fixture;
const database = drizzle(sql, { schema });
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const handle = (prefix: string) => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 17)}`;
const descriptor = (work: ConfigurationWork): HostConfigurationObservation => ({ computerId: work.scope.computerId,
    computerGeneration: work.scope.computerGeneration, configurationRevision: work.revision, configurationDigest: work.digest });
const options: ConfigurationDeliveryOptions = { database, enabled: true, osAccessMode: 'invite',
    advancePreparation: async () => { throw new Error('unconfigured provisioner'); },
    requestReload: async () => { throw new Error('unconfigured provisioner'); },
    resolveHost: async () => { throw new Error('unconfigured provisioner'); },
};
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
        return { computerId, owner, email, records, installationId, mountComputer, mountId, jobId: job!.id as string, configurationId: result.configurationId };
    }
    type Setup = Awaited<ReturnType<typeof setup>>;
    const due = async (s: Setup) => {
        await sql`UPDATE ezil_computer_configuration_deliveries SET available_at=now()+interval '1 day'
            WHERE loaded_at IS NULL AND superseded_at IS NULL`;
        await sql`UPDATE ezil_computer_configuration_deliveries SET available_at=now()
            WHERE configuration_id=${s.configurationId} AND loaded_at IS NULL AND superseded_at IS NULL`;
    };
    const claim = async (s: Setup) => { await due(s); const c = await claimConfigurationDelivery(options); assert.ok(c); assert.equal(c.computerId, s.computerId); return c; };
    const state = async (s: Setup) => {
        const [row] = await sql`SELECT i.status install_status,j.status job_status,j.error_code,d.prepared_at,d.loaded_at,d.loaded_digest,
            d.attempts,d.superseded_at,o.delivered_at FROM ezil_app_installations i JOIN ezil_app_jobs j ON j.id=${s.jobId}
            JOIN ezil_app_outbox o ON o.job_id=j.id JOIN ezil_computer_configuration_deliveries d ON d.configuration_id=${s.configurationId}
            WHERE i.id=${s.installationId}`;
        return row!;
    };
    function transport() {
        const work = new Map<string, ConfigurationWork>();
        const loaded = new Map<string, HostConfigurationObservation>();
        const calls = { preparation: 0, reload: 0, host: 0 };
        const adapter: ConfigurationDeliveryOptions = { ...options,
            advancePreparation: async item => { calls.preparation++; work.set(item.configurationId, item);
                return { state: 'prepared', descriptor: descriptor(item) }; },
            requestReload: async () => { calls.reload++; },
            resolveHost: async scope => ({ scope, configuration: async () => { calls.host++;
                return loaded.get(scope.computerId) ?? { computerId: scope.computerId, computerGeneration: scope.computerGeneration,
                    configurationRevision: 1, configurationDigest: 'f'.repeat(64) }; },
                observe: async () => { throw new Error('installation observation is not configuration evidence'); },
                reconcile: async () => { throw new Error('delivery must not start an application'); },
            }),
        };
        const load = (s: Setup) => loaded.set(s.computerId, descriptor(work.get(s.configurationId)!));
        const prepare = async (s: Setup) => assert.equal(await dispatchConfigurationClaim(adapter, await claim(s)), 'waiting');
        return { adapter, calls, work, loaded, load, prepare };
    }
    function startupTransport(s: Setup, t: ReturnType<typeof transport>) {
        const counts={keys:0,dispatch:0}, policy={accountId:lifecycleDeployment.accountId,region:lifecycleDeployment.region,
            namespace:lifecycleDeployment.namespace,controlDomain:'control.example.com',kmsKeyArn:lifecycleDeployment.dataKeyArn};
        const adapter:ConfigurationDeliveryOptions={...t.adapter,startup:{deployments:[lifecycleDeployment],
            advance:async work=>({state:'observed',observedAt:new Date(),receipt:{schemaVersion:1,
                computerId:s.computerId,jobId:s.mountComputer.jobId,digest:work.digest,generation:s.mountComputer.generation,
                fenceToken:s.mountComputer.fence,instanceId:s.mountComputer.instance,volumeId:s.mountComputer.volume,state:'running'}}),
            keys:{policy,prepare:async work=>{counts.keys++;return {state:'confirmed',versionId:work.versionId,
                secretArn:computerControlKeyIdentity(policy,work).arnPrefix+'Ab12Cd'};}},
            advanceStart:async work=>{counts.dispatch++;return {state:'started',receipt:{schemaVersion:1,
                authorizationId:work.authorizationId,scope:work.scope,state:'started',descriptor:{computerId:work.scope.computerId,
                    computerGeneration:work.scope.computerGeneration,configurationRevision:work.configuration.revision,
                    configurationDigest:work.configuration.digest}}};},
        }};
        const poll=async()=>dispatchConfigurationClaim(adapter,await claim(s));
        const dueStart=async()=>{await sql`UPDATE ezil_computer_start_deliveries SET available_at=now() WHERE authorization_id IN
            (SELECT id FROM ezil_computer_start_authorizations WHERE computer_id=${s.computerId})`;};
        return {adapter,counts,poll,dueStart};
    }
    await test('first preparation issues and delivers startup before observing; receipt alone cannot finish installation',async()=>{
        const s=await setup(),t=transport(),start=startupTransport(s,t);
        assert.equal(await start.poll(),'waiting'); // prepares, no reload against a nonexistent supervisor
        assert.deepEqual(t.calls,{preparation:1,reload:0,host:0});
        assert.equal(await start.poll(),'waiting'); // issuer records a grant, no host start in this poll
        assert.deepEqual(start.counts,{keys:1,dispatch:0});
        await start.dueStart();assert.equal(await start.poll(),'waiting');
        assert.deepEqual(start.counts,{keys:1,dispatch:1});
        assert.equal((await state(s)).install_status,'pending');assert.equal((await state(s)).loaded_at,null);
        assert.equal(t.calls.host,0);t.load(s);
        assert.equal(await start.poll(),'loaded');assert.equal((await state(s)).install_status,'installed');
        assert.deepEqual(start.counts,{keys:1,dispatch:1});assert.equal(t.calls.host,1);
    });
    await test('startup claim for one computer does not consume another computer queue',async()=>{
        const a=await setup(),b=await setup(),ta=transport(),tb=transport(),sa=startupTransport(a,ta),sb=startupTransport(b,tb);
        await sa.poll();await sa.poll();await sb.poll();await sb.poll();
        await sa.dueStart();await sb.dueStart();
        assert.equal(await sb.poll(),'waiting');assert.deepEqual(sa.counts,{keys:1,dispatch:0});
        const rows=await sql`SELECT a.computer_id,d.started_at,d.attempts FROM ezil_computer_start_authorizations a
            JOIN ezil_computer_start_deliveries d ON d.authorization_id=a.id WHERE a.computer_id IN (${a.computerId},${b.computerId})`;
        assert.equal(rows.find(r=>r.computer_id===a.computerId)!.attempts,0);
        assert.ok(rows.find(r=>r.computer_id===b.computerId)!.started_at);
    });
    await test('mount revocation and computer restart between issue and dispatch cannot start the supervisor',async()=>{
        for(const kind of ['revoke','restart']) {
            const s=await setup(),t=transport(),start=startupTransport(s,t);await start.poll();await start.poll();
            if(kind==='revoke')await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${s.mountId}`;
            else await restartConfigurationComputer(sql,s.mountComputer);
            await start.dueStart();assert.equal(await start.poll(),'waiting');assert.equal(start.counts.dispatch,0);
            assert.equal(t.calls.host,0);assert.equal((await state(s)).install_status,'pending');
        }
    });
    await test('unreachable started host is observed without reissuing or dispatching startup',async()=>{
        const s=await setup(),t=transport(),start=startupTransport(s,t);await start.poll();await start.poll();
        await start.dueStart();await start.poll();
        start.adapter.resolveHost=async()=>{throw new Error('host unavailable');};
        for(let n=0;n<2;n++)assert.equal(await start.poll(),'waiting');
        assert.deepEqual(start.counts,{keys:1,dispatch:1});assert.equal((await state(s)).install_status,'pending');
    });
    await test('startup key revocation during host observation blocks installation acknowledgement',async()=>{
        const s=await setup(),t=transport(),start=startupTransport(s,t);await start.poll();await start.poll();
        await start.dueStart();await start.poll();t.load(s);
        const resolve=start.adapter.resolveHost;
        start.adapter.resolveHost=async(scope,signal)=>{const host=await resolve(scope,signal);return {...host,
            configuration:async()=>{await sql`UPDATE ezil_computer_control_bindings SET revoked_at=now() WHERE computer_id=${s.computerId}`;
                return host.configuration();}};};
        assert.equal(await start.poll(),'waiting');assert.equal((await state(s)).install_status,'pending');
        assert.equal((await state(s)).loaded_at,null);assert.equal((await state(s)).error_code,'computer_start_unconfirmed');
    });
    await test('a suspended revocation snapshot reloads without requiring or issuing startup authority',async()=>{
        const s=await setup(),t=transport(),start=startupTransport(s,t);await start.poll();await start.poll();
        await start.dueStart();await start.poll();t.load(s);assert.equal(await start.poll(),'loaded');
        await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
        const next=await produceComputerConfiguration(options,s.computerId);assert.ok('configurationId' in next);s.configurationId=next.configurationId;
        assert.equal(await start.poll(),'waiting');assert.equal(t.calls.reload,1);t.load(s);
        assert.equal(await start.poll(),'loaded');assert.deepEqual(start.counts,{keys:1,dispatch:1});
    });
    await test('expired unfinished startup reports recovery without renewing its allowance',async()=>{
        const s=await setup(),t=transport(),start=startupTransport(s,t);await start.poll();await start.poll();
        await sql.begin(async tx=>{
            // Time travel in this disposable fixture only; production grants stay immutable.
            await tx`ALTER TABLE ezil_computer_start_authorizations DISABLE TRIGGER ezil_start_authority_write_trg`;
            await tx`UPDATE ezil_computer_start_authorizations SET issued_at=issued_at-interval '1 hour',expires_at=expires_at-interval '1 hour',
                provider_observed_at=provider_observed_at-interval '1 hour' WHERE computer_id=${s.computerId}`;
            await tx`ALTER TABLE ezil_computer_start_authorizations ENABLE TRIGGER ezil_start_authority_write_trg`;
        });
        for(let n=0;n<2;n++)assert.equal(await start.poll(),'waiting');
        assert.equal((await state(s)).error_code,'computer_start_recovery_required');assert.deepEqual(start.counts,{keys:1,dispatch:0});
    });
    await test('later configuration reload uses the already-started supervisor without another start',async()=>{
        const s=await setup(),t=transport(),start=startupTransport(s,t);await start.poll();await start.poll();
        await start.dueStart();await start.poll();t.load(s);assert.equal(await start.poll(),'loaded');
        await sql`UPDATE ezil_app_grants SET revoked_at=now() WHERE app_id=${s.records.app.id} AND user_id=${s.owner}`;
        const next=await produceComputerConfiguration(options,s.computerId);assert.ok('configurationId' in next);s.configurationId=next.configurationId;
        assert.equal(await start.poll(),'waiting'); // new immutable preparation
        assert.equal(await start.poll(),'waiting'); // old authenticated descriptor requests reload
        assert.equal(t.calls.reload,1);t.load(s);assert.equal(await start.poll(),'loaded');
        assert.deepEqual(start.counts,{keys:1,dispatch:1});
    });
    await test('disabled consumers never access database or transport', async () => {
        const disabled = { ...options, enabled: false, database: null as never };
        assert.equal(await claimConfigurationDelivery(disabled), null);
        assert.equal(await dispatchNextConfiguration(disabled), 'disabled');
        assert.equal(await dispatchConfigurationClaim(disabled, { computerId: randomUUID(), configurationId: randomUUID(), attempt: 1 }), 'disabled');
    });
    await test('metadata is produced without a mount, but delivery waits without host effects until mount completion', async () => {
        const s = await setup(false), other = await setup(), t = transport();
        assert.ok(other.mountId); // Another computer's receipt confers no authority.
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'waiting');
        const row = await state(s);
        assert.deepEqual(t.calls, { preparation: 0, reload: 0, host: 0 });
        assert.equal(row.error_code, 'computer_data_mount_unconfirmed');
        assert.equal(row.prepared_at, null); assert.equal(row.loaded_at, null); assert.equal(row.delivered_at, null);
        assert.equal(row.install_status, 'pending'); assert.equal(row.job_status, 'queued');
        await recordConfigurationMount(sql, s.mountComputer);
        await t.prepare(s); t.load(s);
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'loaded');
    });
    await test('completed in-time mount permits installation after grant expiry', async () => {
        const s = await setup(), t = transport(); await ageConfigurationMount(sql, s.mountId!);
        await t.prepare(s); t.load(s);
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'loaded');
    });
    await test('mount revocation after preparation blocks reload and host observation', async () => {
        const s = await setup(), t = transport(); await t.prepare(s); t.load(s);
        await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${s.mountId}`;
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'waiting');
        assert.deepEqual(t.calls, { preparation: 1, reload: 1, host: 0 });
        const row = await state(s); assert.equal(row.error_code, 'computer_data_mount_unconfirmed');
        assert.equal(row.loaded_at, null); assert.equal(row.install_status, 'pending'); assert.equal(row.delivered_at, null);
    });
    for (const phase of ['preparation', 'observation'] as const) for (const change of ['revocation', 'restart'] as const) {
        await test(`${change} during ${phase} rejects delayed receipts without retaining SQL locks`, async () => {
            const s = await setup(), t = transport();
            if (phase === 'observation') { await t.prepare(s); t.load(s); }
            let entered!: () => void, finish!: () => void;
            const reached = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { finish = r; });
            const blocked = { ...t.adapter, ...(phase === 'preparation' ? {
                advancePreparation: async (w: ConfigurationWork) => { entered(); await gate; return { state: 'prepared', descriptor: descriptor(w) }; },
            } : {
                resolveHost: async (scope: Parameters<typeof t.adapter.resolveHost>[0]) => {
                    const host = await t.adapter.resolveHost(scope, new AbortController().signal);
                    return { ...host, configuration: async () => { entered(); await gate; return host.configuration(); } };
                },
            }) };
            const running = dispatchConfigurationClaim(blocked, await claim(s)); await reached;
            try {
                if (change === 'revocation') await sql.begin(async tx => {
                    await tx`SET LOCAL lock_timeout='1s'`;
                    await tx`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${s.mountId}`;
                });
                else await restartConfigurationComputer(sql, s.mountComputer);
            } finally { finish(); }
            assert.equal(await running, 'waiting');
            const row = await state(s); assert.equal(row.error_code, 'computer_data_mount_unconfirmed');
            assert.equal(row.loaded_at, null); assert.equal(row.install_status, 'pending'); assert.equal(row.delivered_at, null);
            assert.equal(t.calls.reload, phase === 'preparation' ? 0 : 1);
            if (phase === 'preparation') assert.equal(row.prepared_at, null);
            assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_audit_events
                WHERE installation_id=${s.installationId} AND action='installation.installed'`)[0]!.n, 0);
        });
    }
    await test('concurrent claims allocate one lease; preparation and reload cannot complete install', async () => {
        const s = await setup(), t = transport(); await due(s);
        const claims = await Promise.all([claimConfigurationDelivery(options), claimConfigurationDelivery(options)]);
        assert.equal(claims.filter(Boolean).length, 1);
        assert.equal(await dispatchConfigurationClaim(t.adapter, claims.find(Boolean)!), 'waiting');
        const row = await state(s); assert.ok(row.prepared_at); assert.equal(row.loaded_at, null);
        assert.equal(row.install_status, 'pending'); assert.equal(row.job_status, 'running');
        assert.equal(row.delivered_at, null); assert.equal(t.calls.reload, 1); assert.equal(t.calls.host, 0);
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'waiting');
        assert.equal((await state(s)).error_code, 'host_response_invalid');
        t.load(s); assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'loaded');
        const final = await state(s); assert.equal(final.install_status, 'installed'); assert.equal(final.job_status, 'succeeded');
        assert.ok(final.loaded_at); assert.ok(final.delivered_at); assert.equal(t.calls.preparation, 1);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_folder_grants WHERE installation_id=${s.installationId}`)[0]!.n, 0);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_runtime_commands WHERE installation_id=${s.installationId}`)[0]!.n, 0);
    });
    await test('pending preparation retains one stable work identity across polls and lease takeovers', async () => {
        const s = await setup(), t = transport(), identities: string[] = [];
        const slow = { ...t.adapter, advancePreparation: async (w: ConfigurationWork) => { identities.push(w.configurationId); return { state: 'pending' }; } };
        const old = await claim(s);
        await sql`UPDATE ezil_computer_configuration_deliveries SET lease_until=now()-interval '1 second' WHERE configuration_id=${s.configurationId}`;
        const next = await claim(s); assert.equal(next.attempt, old.attempt + 1);
        assert.equal(await dispatchConfigurationClaim(slow, old), 'stale'); assert.equal(identities.length, 0);
        assert.equal(await dispatchConfigurationClaim(slow, next), 'waiting');
        assert.equal(await dispatchConfigurationClaim(slow, await claim(s)), 'waiting');
        assert.deepEqual(identities, [s.configurationId, s.configurationId]);
        assert.equal((await state(s)).prepared_at, null); assert.equal(t.calls.reload, 0);
        assert.equal((await state(s)).job_status, 'running');
    });
    await test('cross-computer claims, wrong target scopes and forged preparation receipts cannot install', async () => {
        const a = await setup(), b = await setup(), t = transport(); const c = await claim(a);
        assert.equal(await dispatchConfigurationClaim(t.adapter, { ...c, computerId: b.computerId }), 'stale');
        assert.equal(t.calls.preparation, 0);
        const forged = { ...t.adapter, advancePreparation: async (w: ConfigurationWork) => ({ state: 'prepared',
            descriptor: { ...descriptor(w), computerId: b.computerId } }) };
        assert.equal(await dispatchConfigurationClaim(forged, c), 'waiting'); assert.equal((await state(a)).prepared_at, null);
        await t.prepare(a); t.load(a);
        const wrongTarget = { ...t.adapter, resolveHost: async (scope: Parameters<typeof t.adapter.resolveHost>[0]) => {
            const host = await t.adapter.resolveHost(scope, new AbortController().signal);
            return { ...host, scope: { ...scope, providerInstanceId: handle('i') } };
        } };
        assert.equal(await dispatchConfigurationClaim(wrongTarget, await claim(a)), 'waiting');
        assert.equal((await state(a)).error_code, 'host_rejected'); assert.equal(t.calls.host, 0);
    });
    await test('revocation can commit while preparation waits; its delayed receipt is fenced', async () => {
        const s = await setup(), t = transport(); let entered!: () => void, finish!: () => void;
        const atTransport = new Promise<void>(r => { entered = r; }), release = new Promise<void>(r => { finish = r; });
        const blocked = { ...t.adapter, advancePreparation: async (w: ConfigurationWork) => {
            entered(); await release; return { state: 'prepared', descriptor: descriptor(w) };
        } };
        const running = dispatchConfigurationClaim(blocked, await claim(s)); await atTransport;
        try {
            // A real separate PostgreSQL connection; this would time out if a
            // database transaction stayed locked across external preparation.
            await sql.begin(async tx => { await tx`SET LOCAL lock_timeout='1s'`;
                await tx`UPDATE ezil_app_grants SET revoked_at=now() WHERE app_id=${s.records.app.id}`; });
        } finally { finish(); }
        assert.equal(await running, 'stale'); const row = await state(s);
        assert.equal(row.prepared_at, null); assert.equal(row.loaded_at, null); assert.ok(row.superseded_at); assert.equal(t.calls.reload, 0);
    });
    await test('revocation during authenticated host observation is rechecked before commit', async () => {
        const s = await setup(), t = transport(); await t.prepare(s); t.load(s);
        const revoked = { ...t.adapter, resolveHost: async (scope: Parameters<typeof t.adapter.resolveHost>[0]) => {
            const host = await t.adapter.resolveHost(scope, new AbortController().signal);
            return { ...host, configuration: async () => { const value = await host.configuration();
                await sql`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=${s.owner}`; return value; } };
        } };
        assert.equal(await dispatchConfigurationClaim(revoked, await claim(s)), 'stale');
        assert.equal((await state(s)).install_status, 'pending'); assert.equal((await state(s)).loaded_at, null);
    });
    await test('cancelled jobs and revoked releases cannot be completed from previously prepared files', async () => {
        for (const kind of ['job', 'release', 'authorization', 'port']) {
            const s = await setup(), t = transport(); await t.prepare(s); t.load(s); const c = await claim(s);
            if (kind === 'job') await sql`UPDATE ezil_app_jobs SET status='cancelled',completed_at=now() WHERE id=${s.jobId}`;
            if (kind === 'release') await sql`UPDATE ezil_app_releases SET status='revoked',revoked_at=now() WHERE id=${s.records.release.id}`;
            if (kind === 'authorization') await sql`UPDATE ezil_app_installations SET auth_generation=2 WHERE id=${s.installationId}`;
            if (kind === 'port') await sql`UPDATE ezil_app_port_leases SET released_at=now() WHERE installation_id=${s.installationId}`;
            assert.equal(await dispatchConfigurationClaim(t.adapter, c), 'stale'); assert.equal((await state(s)).loaded_at, null);
        }
    });
    await test('a stopped computer is observed without provisioning, reload, host request or wake', async () => {
        const s = await setup(), t = transport(); const c = await claim(s);
        await sql`UPDATE ezil_computer_instances SET observed_state='stopped',observed_at=now() WHERE computer_id=${s.computerId}`;
        assert.equal(await dispatchConfigurationClaim(t.adapter, c), 'waiting');
        assert.deepEqual(t.calls, { preparation: 0, reload: 0, host: 0 });
        assert.equal((await state(s)).error_code, 'computer_not_running');
    });
    await test('replacement fences the old writer receipt even with the same data volume', async () => {
        const s = await setup(), t = transport(); await t.prepare(s); t.load(s); const c = await claim(s);
        await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${s.computerId}`;
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,observed_state,observed_at)
            VALUES (${s.computerId},2,${handle('i')},'running',now())`;
        assert.equal(await dispatchConfigurationClaim(t.adapter, c), 'stale');
        assert.equal((await state(s)).loaded_at, null); assert.equal(t.calls.host, 0);
    });
    await test('suspension loads a revocation configuration without completing unbound install jobs', async () => {
        const s = await setup(), t = transport(); await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
        await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${s.mountId}`;
        const produced = await produceComputerConfiguration(options, s.computerId); assert.ok('configurationId' in produced);
        s.configurationId = produced.configurationId;
        await t.prepare(s); t.load(s); assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'loaded');
        const row = await state(s); assert.equal(row.install_status, 'pending'); assert.equal(row.job_status, 'queued');
        assert.equal(row.delivered_at, null);
    });
    await test('duplicate observations complete one receipt and one attributable audit event', async () => {
        const s = await setup(), t = transport(); await t.prepare(s); t.load(s); const c = await claim(s);
        const results = await Promise.all([dispatchConfigurationClaim(t.adapter, c), dispatchConfigurationClaim(t.adapter, c)]);
        assert.deepEqual(results.sort(), ['loaded', 'stale']);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_audit_events WHERE installation_id=${s.installationId} AND action='installation.installed'`)[0]!.n, 1);
    });
    await test('an audit failure rolls back receipt, installation, job and outbox and remains safely retryable', async () => {
        const s = await setup(), t = transport(); await t.prepare(s); t.load(s);
        await sql.unsafe(`CREATE FUNCTION public.test_configuration_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$
            BEGIN RAISE EXCEPTION 'sensitive-sentinel'; END $$;
            CREATE TRIGGER test_configuration_audit_failure BEFORE INSERT ON ezil_app_audit_events
            FOR EACH ROW EXECUTE FUNCTION public.test_configuration_audit_failure();`);
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'waiting');
        const row = await state(s); assert.equal(row.loaded_at, null); assert.equal(row.delivered_at, null);
        assert.equal(row.install_status, 'pending'); assert.equal(row.job_status, 'running'); assert.equal(row.error_code, 'configuration_delivery_failed');
        await sql.unsafe('DROP TRIGGER test_configuration_audit_failure ON ezil_app_audit_events; DROP FUNCTION public.test_configuration_audit_failure();');
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(s)), 'loaded'); assert.equal(t.calls.preparation, 1);
    });
    await test('lease takeover during observation rejects the old callback without completing its job', async () => {
        const s = await setup(), t = transport(); await t.prepare(s); t.load(s); let entered!: () => void, finish!: () => void;
        const observing = new Promise<void>(r => { entered = r; }), release = new Promise<void>(r => { finish = r; });
        const blocked = { ...t.adapter, resolveHost: async (scope: Parameters<typeof t.adapter.resolveHost>[0]) => {
            const host = await t.adapter.resolveHost(scope, new AbortController().signal);
            return { ...host, configuration: async () => { entered(); await release; return host.configuration(); } };
        } };
        const old = await claim(s); const running = dispatchConfigurationClaim(blocked, old); await observing;
        await sql`UPDATE ezil_computer_configuration_deliveries SET lease_until=now()-interval '1 second' WHERE configuration_id=${s.configurationId}`;
        const next = await claim(s); finish(); assert.equal(await running, 'stale');
        assert.equal((await state(s)).loaded_at, null); assert.equal((await state(s)).attempts, next.attempt);
        assert.equal(await dispatchConfigurationClaim(t.adapter, next), 'loaded');
    });
    await test('short leases and untrusted error details cannot cause side effects or secret-bearing job errors', async () => {
        const s = await setup(), t = transport(), c = await claim(s);
        await sql`UPDATE ezil_computer_configuration_deliveries SET lease_until=now()+interval '1 second' WHERE configuration_id=${s.configurationId}`;
        assert.equal(await dispatchConfigurationClaim(t.adapter, c), 'waiting'); assert.equal(t.calls.preparation, 0);
        assert.equal((await state(s)).error_code, 'configuration_lease_short');
        const broken = { ...t.adapter, advancePreparation: async () => { throw new Error('secret-token-sentinel'); } };
        assert.equal(await dispatchConfigurationClaim(broken, await claim(s)), 'waiting');
        assert.equal((await state(s)).error_code, 'configuration_delivery_failed');
    });
    await test('preparation timeout aborts the transport and cannot accept a receipt returned by its abort handler', async () => {
        const s = await setup(), t = transport(); let aborted = false;
        const timeout = { ...t.adapter, advancePreparation: (w: ConfigurationWork, signal: AbortSignal) => new Promise(resolve => {
            signal.addEventListener('abort', () => { aborted = true; resolve({ state: 'prepared', descriptor: descriptor(w) }); }, { once: true });
        }) };
        assert.equal(await dispatchConfigurationClaim(timeout, await claim(s)), 'waiting'); assert.equal(aborted, true);
        assert.equal((await state(s)).prepared_at, null); assert.equal((await state(s)).error_code, 'configuration_delivery_failed');
        assert.equal(t.calls.reload, 0);
    });
    await test('two computers complete separately and cannot accept each other’s loaded descriptor', async () => {
        const a = await setup(), b = await setup(), t = transport(); await t.prepare(a); await t.prepare(b);
        t.load(a); t.loaded.set(b.computerId, t.loaded.get(a.computerId)!);
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(a)), 'loaded');
        assert.equal((await state(b)).install_status, 'pending');
        assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(b)), 'waiting');
        assert.equal((await state(b)).loaded_at, null);
        t.load(b); assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(b)), 'loaded');
    });
    await test('one loaded snapshot completes all and only its member jobs', async () => {
        const a = await setup(), b = await setup(), installationId = randomUUID(), t = transport();
        await sql`INSERT INTO ezil_app_grants(user_id,app_id,granted_by) VALUES (${a.owner},${b.records.app.id},${admin})`;
        await sql`INSERT INTO ezil_app_installations(id,computer_id,app_id,release_id,installed_by)
            VALUES (${installationId},${a.computerId},${b.records.app.id},${b.records.release.id},${a.owner})`;
        await sql`INSERT INTO ezil_app_services(installation_id,computer_id,name,scope,internal_port,health_path)
            VALUES (${installationId},${a.computerId},'daemon','selected-project',4400,'/status')`;
        await sql`INSERT INTO ezil_app_port_leases(installation_id,computer_id,service_name,host_port)
            VALUES (${installationId},${a.computerId},'daemon',20000)`;
        const [job] = await sql`INSERT INTO ezil_app_jobs(installation_id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${installationId},${a.computerId},${a.owner},'install',${randomUUID()}) RETURNING id`;
        await sql`INSERT INTO ezil_app_outbox(job_id) VALUES (${job!.id})`;
        const current = await produceComputerConfiguration(options, a.computerId); assert.ok('configurationId' in current);
        a.configurationId = current.configurationId;
        await t.prepare(a); t.load(a); assert.equal(await dispatchConfigurationClaim(t.adapter, await claim(a)), 'loaded');
        assert.equal((await state(a)).job_status, 'succeeded');
        assert.equal((await sql`SELECT status FROM ezil_app_jobs WHERE id=${job!.id}`)[0]!.status, 'succeeded');
        assert.equal((await state(b)).job_status, 'queued');
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_audit_events WHERE computer_id=${a.computerId} AND action='installation.installed'`)[0]!.n, 2);
    });
    await test('unavailable writer work is superseded so it cannot starve later candidates', async () => {
        const s = await setup(); await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${s.computerId}`;
        await due(s); assert.equal(await claimConfigurationDelivery(options), null);
        assert.ok((await state(s)).superseded_at);
        const next = await setup(); const c = await claim(next); assert.equal(c.computerId, next.computerId);
    });
    console.log(`${passed} pass, 0 fail, 0 skip — actual PostgreSQL configuration delivery`);
} finally { await fixture.close(); }
