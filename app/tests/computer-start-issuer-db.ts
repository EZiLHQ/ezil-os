import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { issueComputerStart } from '../src/server/app-platform/computer-start-issuer';
import { produceComputerConfiguration } from '../src/server/app-platform/computer-configuration';
import { parseComputerLifecycleWork } from '../src/server/app-platform/computer-lifecycle-work';
import { computerControlKeyIdentity } from '../src/server/app-platform/computer-control-key';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { dataMountComputer, type MountComputer } from './fixtures/data-mount';
import { recordConfigurationMount, ageConfigurationMount, restartConfigurationComputer } from './fixtures/configuration-mount';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';
import { runtimeRecords } from './fixtures/runtime-release';
import { setTimeout as delay } from 'node:timers/promises';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
type Options = Parameters<typeof issueComputerStart>[0];
const policy = { accountId: deployment.accountId, region: deployment.region, namespace: deployment.namespace,
    controlDomain: 'control.example.com', kmsKeyArn: deployment.dataKeyArn };
const options: Options = { database: drizzle(sql, { schema }), enabled: true, osAccessMode: 'invite', deployments: [deployment],
    advance: async () => ({ state: 'pending' }), keys: { policy, prepare: async work => ({ state: 'confirmed',
        versionId: work.versionId, secretArn: `${computerControlKeyIdentity(policy, work).arnPrefix}Ab12Cd` }) } };
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
async function configuration(c: MountComputer, prepared = true) {
    const result = await produceComputerConfiguration(options, c.computerId); assert.ok('configurationId' in result);
    if (prepared) await sql`UPDATE ezil_computer_configuration_deliveries SET prepared_at=now() WHERE configuration_id=${result.configurationId}`;
    return result.configurationId;
}
async function setup(prepared = true) {
    const c = await dataMountComputer(sql), email = `${c.userId}@example.com`;
    await sql`UPDATE auth.users SET email=${email} WHERE id=${c.userId}`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'fixture')`;
    const mountAuthorizationId = await recordConfigurationMount(sql, c), configurationId = await configuration(c, prepared);
    return { ...c, email, input: { computerId: c.computerId, configurationId, mountAuthorizationId } };
}
const observer = (c: MountComputer): Options['advance'] => async (work, allowStart, signal) => {
    assert.equal(allowStart, false); assert.equal(signal.aborted, false);
    const intent = parseComputerLifecycleWork(work);
    return { state: 'observed', observedAt: new Date(), receipt: { schemaVersion: intent.schemaVersion,
        computerId: c.computerId, jobId: c.jobId, digest: work.digest, generation: c.generation,
        fenceToken: c.fence, instanceId: c.instance, volumeId: c.volume, state: 'running' } };
};
const count = async (c: MountComputer) => (await sql`SELECT count(*)::int n FROM ezil_computer_start_authorizations WHERE computer_id=${c.computerId}`)[0]!.n;
const binding = async (c: MountComputer) => (await sql`SELECT * FROM ezil_computer_control_bindings WHERE computer_id=${c.computerId}`)[0];
async function unlocked(c: MountComputer) {
    await sql.begin(async tx => { await tx`SET LOCAL lock_timeout='100ms'`;
        await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`; });
}
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('disabled and malformed input cannot access DB or provider', async () => {
        const o = { ...options, database: null as never };
        assert.equal((await issueComputerStart({ ...o, enabled: false }, null)).state, 'disabled');
        for (const extra of [{}, { computerId: randomUUID(), configurationId: randomUUID(), mountAuthorizationId: randomUUID(), port: 8181 }]) {
            assert.equal((await issueComputerStart(o, extra)).state, 'denied');
        }
    });
    await test('concurrent issuers release SQL locks for I/O and claim exactly one creation attempt, grant, outbox and audit', async () => {
        const c = await setup(); const modes: string[] = [];
        const o: Options = { ...options, advance: async (...args) => { await unlocked(c); return observer(c)(...args); },
            keys: { policy, prepare: async (work, mode, signal) => {
                modes.push(mode); await unlocked(c);
                const b = await binding(c); assert.ok(b?.create_attempted_at); assert.equal(b.id, work.versionId);
                return options.keys.prepare(work, mode, signal);
            } } };
        const [a, b] = await Promise.all([issueComputerStart(o, c.input), issueComputerStart(o, c.input)]);
        assert.ok(a?.state === 'issued'); assert.deepEqual(a, b); assert.equal(await count(c), 1);
        assert.deepEqual(modes.sort(), ['create', 'observe']);
        const [grant] = await sql`SELECT * FROM ezil_computer_start_authorizations WHERE id=${a.authorizationId}`;
        assert.equal(new Date(grant!.expires_at).getTime() - new Date(grant!.issued_at).getTime(), 300000);
        const [delivery] = await sql`SELECT * FROM ezil_computer_start_deliveries WHERE authorization_id=${a.authorizationId}`;
        assert.equal(delivery!.attempts, 0); assert.equal(delivery!.started_at, null); assert.equal(delivery!.receipt, null);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_audit_events WHERE computer_id=${c.computerId}`)[0]!.n, 1);
        assert.equal((await sql`SELECT loaded_at FROM ezil_computer_configuration_deliveries WHERE configuration_id=${c.input.configurationId}`)[0]!.loaded_at, null);
        assert.deepEqual(await issueComputerStart(o, c.input), a); assert.equal(modes.at(-1), 'observe');
        assert.ok((await binding(c))!.key_confirmed_at);
    });
    await test('unprepared, foreign, revoked and unapproved authority cannot reach provider I/O', async () => {
        for (const reason of ['unprepared', 'foreign-mount', 'foreign-config', 'revoked', 'mount', 'deployment', 'policy']) {
            const c = await setup(reason !== 'unprepared'), other = await setup();
            if (reason === 'foreign-mount') c.input.mountAuthorizationId = other.input.mountAuthorizationId;
            if (reason === 'foreign-config') c.input.configurationId = other.input.configurationId;
            if (reason === 'revoked') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
            if (reason === 'mount') await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${c.input.mountAuthorizationId}`;
            let calls = 0;
            const o: Options = { ...options, deployments: reason === 'deployment' ? [] : options.deployments,
                keys: { ...options.keys, policy: reason === 'policy' ? { ...policy, namespace: 'wrong' } : policy },
                advance: async () => { calls++; throw new Error('unexpected'); } };
            assert.equal((await issueComputerStart(o, c.input)).state, 'denied', reason); assert.equal(calls, 0);
            assert.equal(await count(c), 0); assert.equal(await binding(c), undefined);
        }
    });
    await test('invalid or stale provider evidence cannot consume a key creation attempt', async () => {
        for (const reason of ['pending', 'throw', 'stale', 'future', 'invalid-date', 'stopped', 'instance', 'volume']) {
            const c = await setup(); let keys = 0;
            const o: Options = { ...options, keys: { policy, prepare: async () => { keys++; throw new Error('unexpected'); } },
                advance: async (...args) => {
                    if (reason === 'pending') return { state: 'pending' };
                    if (reason === 'throw') throw new Error('PRIVATE_PROVIDER_VALUE');
                    const result = await observer(c)(...args); assert.ok(result.state === 'observed');
                    if (reason === 'stale') result.observedAt = new Date(Date.now() - 60000);
                    if (reason === 'future') result.observedAt = new Date(Date.now() + 60000);
                    if (reason === 'invalid-date') result.observedAt = new Date(NaN);
                    if (reason === 'stopped') result.receipt.state = 'stopped';
                    if (reason === 'instance') result.receipt.instanceId = 'i-99999999999999999';
                    if (reason === 'volume') result.receipt.volumeId = 'vol-99999999999999999';
                    return result;
                } };
            assert.equal((await issueComputerStart(o, c.input)).state, 'unconfirmed', reason);
            assert.equal(keys, 0); assert.equal((await binding(c))!.create_attempted_at, null); assert.equal(await count(c), 0);
        }
    });
    await test('revocation, stop, fencing and operator changes during either I/O boundary deny issuance', async () => {
        for (const phase of ['provider', 'key']) for (const reason of ['access', 'mount', 'stop', 'fence', 'disable', 'policy', 'deployment', 'binding']) {
            const c = await setup();
            const o: Options = { ...options, advance: observer(c), keys: { ...options.keys, policy: { ...policy } } };
            const invalidate = async () => {
                if (reason === 'access') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
                if (reason === 'mount') await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${c.input.mountAuthorizationId}`;
                if (reason === 'stop') await sql`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.computerId}`;
                if (reason === 'fence') await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
                if (reason === 'disable') o.enabled = false;
                if (reason === 'policy') o.keys = { ...o.keys, policy: { ...policy, controlDomain: 'different.example.com' } };
                if (reason === 'deployment') o.deployments = [];
                if (reason === 'binding') await sql`UPDATE ezil_computer_control_bindings SET revoked_at=now() WHERE computer_id=${c.computerId}`;
            };
            if (phase === 'provider') o.advance = async (...args) => { await invalidate(); return observer(c)(...args); };
            else o.keys.prepare = async (...args) => { await invalidate(); return options.keys.prepare(...args); };
            assert.equal((await issueComputerStart(o, c.input)).state, 'denied', `${phase}/${reason}`);
            assert.equal(await count(c), 0); assert.equal((await binding(c))!.key_confirmed_at, null);
        }
    });
    await test('lost create response permanently consumes creation; retry only observes the same version', async () => {
        const c = await setup(); let version = '';
        const o: Options = { ...options, advance: observer(c), keys: { policy, prepare: async (work, mode) => {
            assert.equal(mode, 'create'); version = work.versionId; throw new Error('PRIVATE_KEY_VALUE');
        } } };
        assert.equal((await issueComputerStart(o, c.input)).state, 'unconfirmed');
        o.keys.prepare = async (work, mode, signal) => { assert.equal(mode, 'observe'); assert.equal(work.versionId, version);
            return options.keys.prepare(work, mode, signal); };
        assert.equal((await issueComputerStart(o, c.input)).state, 'issued'); assert.equal(await count(c), 1);
    });
    await test('missing historical key requires recovery without clearing history or recreating it', async () => {
        const c = await setup(); const modes: string[] = [];
        const o: Options = { ...options, advance: observer(c), keys: { policy, prepare: async (_work, mode) => {
            modes.push(mode); return { state: 'missing' }; } } };
        assert.equal((await issueComputerStart(o, c.input)).state, 'recovery_required'); const b = await binding(c);
        assert.equal((await issueComputerStart(o, c.input)).state, 'recovery_required');
        assert.deepEqual(await binding(c), b); assert.deepEqual(modes, ['create', 'observe']); assert.equal(await count(c), 0);
    });
    await test('forged or changed key versions and ARNs never confirm a binding', async () => {
        for (const reason of ['version', 'arn', 'extra']) {
            const c = await setup();
            const o: Options = { ...options, advance: observer(c), keys: { policy, prepare: async (...args) => {
                const key = await options.keys.prepare(...args); assert.ok(key.state === 'confirmed');
                return reason === 'version' ? { ...key, versionId: randomUUID() } : reason === 'arn'
                    ? { ...key, secretArn: key.secretArn.replace(c.computerId, randomUUID()) } : { ...key, secretValue: 'PRIVATE_VALUE' };
            } } };
            assert.equal((await issueComputerStart(o, c.input)).state, 'unconfirmed');
            assert.equal((await binding(c))!.secret_arn, null); assert.equal(await count(c), 0);
        }
    });
    await test('completed mounts remain usable after execution expiry; expired startup grants require reconciliation', async () => {
        const c = await setup(); await ageConfigurationMount(sql, c.input.mountAuthorizationId);
        const o = { ...options, advance: observer(c) }, result = await issueComputerStart(o, c.input); assert.ok(result.state === 'issued');
        await sql.begin(async tx => {
            await tx`ALTER TABLE ezil_computer_start_authorizations DISABLE TRIGGER ezil_start_authority_write_trg`;
            await tx`UPDATE ezil_computer_start_authorizations SET issued_at=issued_at-interval '1 hour',expires_at=expires_at-interval '1 hour',
                provider_observed_at=provider_observed_at-interval '1 hour' WHERE id=${result.authorizationId}`;
            await tx`ALTER TABLE ezil_computer_start_authorizations ENABLE TRIGGER ezil_start_authority_write_trg`;
        });
        const [before] = await sql`SELECT * FROM ezil_computer_start_authorizations WHERE id=${result.authorizationId}`;
        assert.equal((await issueComputerStart({ ...o, advance: async () => { throw new Error('unexpected'); } }, c.input)).state, 'recovery_required');
        assert.deepEqual((await sql`SELECT * FROM ezil_computer_start_authorizations WHERE id=${result.authorizationId}`)[0], before);
    });
    await test('same-generation restart needs a new mount and explicit prior-grant reconciliation, then reuses key', async () => {
        const c = await setup(), first = await issueComputerStart({ ...options, advance: observer(c) }, c.input); assert.ok(first.state === 'issued');
        const b = await binding(c), restarted = await restartConfigurationComputer(sql, c);
        assert.equal((await issueComputerStart({ ...options, advance: observer(restarted) }, c.input)).state, 'denied');
        const input = { ...c.input, mountAuthorizationId: await recordConfigurationMount(sql, restarted) };
        assert.equal((await issueComputerStart({ ...options, advance: observer(restarted) }, input)).state, 'recovery_required');
        await sql`UPDATE ezil_computer_start_authorizations SET revoked_at=now() WHERE id=${first.authorizationId}`;
        const result = await issueComputerStart({ ...options, advance: observer(restarted), keys: { policy, prepare: async (work, mode, signal) => {
            assert.equal(mode, 'observe'); assert.equal(work.versionId, b!.id); return options.keys.prepare(work, mode, signal);
        } } }, input);
        assert.ok(result.state === 'issued'); assert.notEqual(result.authorizationId, first.authorizationId); assert.deepEqual(await binding(c), b);
    });
    await test('transport cancellation and timeout are bounded even when injected callbacks ignore signals', async () => {
        for (const phase of ['provider', 'key']) for (const reason of ['cancel', 'timeout']) {
            const c = await setup(), controller = new AbortController(); let seen: AbortSignal | undefined;
            const never = (signal: AbortSignal) => { seen = signal; if (reason === 'cancel') controller.abort(); return new Promise<never>(() => {}); };
            const o: Options = { ...options, advance: observer(c), signal: controller.signal,
                keys: { policy, prepare: (_work, _mode, signal) => never(signal) } };
            if (phase === 'provider') o.advance = (_work, _start, signal) => never(signal);
            const original = globalThis.setTimeout;
            // Compress only the issuer transport deadline, preserving all DB/driver timers.
            if (reason === 'timeout') globalThis.setTimeout = ((fn: () => void, ms: number, ...args: unknown[]) =>
                original(fn, ms === (phase === 'provider' ? 20000 : 15000) ? 10 : ms, ...args)) as typeof setTimeout;
            try { assert.equal((await issueComputerStart(o, c.input)).state, 'unconfirmed'); }
            finally { globalThis.setTimeout = original; }
            assert.equal(seen?.aborted, true); assert.equal(await count(c), 0);
            assert.equal((await binding(c))!.key_confirmed_at, null);
        }
    });
    await test('late app entitlement revocation recompiles Reticle authority and denies startup', async () => {
        const c = await setup(), admin = randomUUID(); await sql`INSERT INTO auth.users(id) VALUES (${admin})`;
        await sql`INSERT INTO ezil_app_admins(user_id) VALUES (${admin})`;
        const [publisher] = await sql`INSERT INTO ezil_app_publishers(owner_user_id,display_name,status,invited_by)
            VALUES (${c.userId},'Fixture','active',${admin}) RETURNING id`;
        const records = runtimeRecords('reticle', { appId: randomUUID(), publisherId: publisher!.id, installationId: randomUUID(), releaseId: randomUUID() },
            manifest => { manifest.slug = `test-${randomUUID()}`; }), r = records.release;
        await sql`INSERT INTO ezil_apps(id,publisher_id,slug,name,summary,category,visibility)
            VALUES (${records.app.id},${publisher!.id},${records.app.slug},'Reticle','Fixture','Development','grant-only')`;
        await sql`INSERT INTO ezil_app_releases(id,app_id,version,manifest,policy,manifest_digest,policy_digest,image_reference,provenance_digest,source_commit_sha)
            VALUES (${r.id},${records.app.id},${r.version},${JSON.stringify(r.manifest)}::jsonb,${JSON.stringify(r.policy)}::jsonb,
                ${r.manifestDigest},${r.policyDigest},${r.imageReference},${r.provenanceDigest},${r.sourceCommitSha})`;
        await sql`UPDATE ezil_app_releases SET status='validated' WHERE id=${r.id}`;
        await sql`UPDATE ezil_app_releases SET status='approved',approved_by=${admin},approved_at=now() WHERE id=${r.id}`;
        await sql`INSERT INTO ezil_app_grants(user_id,app_id,granted_by) VALUES (${c.userId},${records.app.id},${admin})`;
        await sql`INSERT INTO ezil_app_installations(id,computer_id,app_id,release_id,installed_by)
            VALUES (${records.installationId},${c.computerId},${records.app.id},${r.id},${c.userId})`;
        await sql`INSERT INTO ezil_app_services(installation_id,computer_id,name,scope,internal_port,health_path)
            VALUES (${records.installationId},${c.computerId},'daemon','selected-project',4400,'/status')`;
        await sql`INSERT INTO ezil_app_port_leases(installation_id,computer_id,service_name,host_port)
            VALUES (${records.installationId},${c.computerId},'daemon',4400)`;
        const [job] = await sql`INSERT INTO ezil_app_jobs(installation_id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${records.installationId},${c.computerId},${c.userId},'install',${randomUUID()}) RETURNING id`;
        await sql`INSERT INTO ezil_app_outbox(job_id) VALUES (${job!.id})`;
        c.input.configurationId = await configuration(c);
        const [snapshot] = await sql`SELECT configuration FROM ezil_computer_configurations WHERE id=${c.input.configurationId}`;
        assert.equal(JSON.parse(snapshot!.configuration).preparedInstallations.length, 1);
        const result = await issueComputerStart({ ...options, advance: observer(c), keys: { policy, prepare: async (...args) => {
            await sql`UPDATE ezil_app_grants SET revoked_at=now() WHERE user_id=${c.userId} AND app_id=${records.app.id}`;
            return options.keys.prepare(...args);
        } } }, c.input);
        assert.equal(result.state, 'denied'); assert.equal(await count(c), 0);
        assert.equal((await binding(c))!.key_confirmed_at, null);
    });
    await test('observation that ages during key I/O cannot confirm a key or issue a grant', async () => {
        const c = await setup();
        const result = await issueComputerStart({ ...options, advance: async (...args) => {
            const value = await observer(c)(...args); assert.ok(value.state === 'observed');
            value.observedAt = new Date(Date.now() - 26000); return value;
        }, keys: { policy, prepare: async (...args) => { await delay(4100); return options.keys.prepare(...args); } } }, c.input);
        assert.equal(result.state, 'unconfirmed'); assert.equal((await binding(c))!.key_confirmed_at, null); assert.equal(await count(c), 0);
    });
    await test('failed audit rolls back confirmation, grant and outbox together while preserving the creation attempt', async () => {
        const c = await setup();
        await sql.unsafe(`CREATE FUNCTION public.fixture_reject_start_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
            RAISE EXCEPTION 'PRIVATE_AUDIT_VALUE'; END $$;
            CREATE TRIGGER fixture_reject_start_audit BEFORE INSERT ON ezil_app_audit_events FOR EACH ROW EXECUTE FUNCTION public.fixture_reject_start_audit()`);
        try {
            await assert.rejects(issueComputerStart({ ...options, advance: observer(c) }, c.input), { message: 'computer_start_issuer_unavailable' });
            const b = await binding(c); assert.ok(b!.create_attempted_at); assert.equal(b!.key_confirmed_at, null);
            assert.equal(await count(c), 0);
            assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_start_deliveries d
                JOIN ezil_computer_start_authorizations a ON a.id=d.authorization_id WHERE a.computer_id=${c.computerId}`)[0]!.n, 0);
        } finally { await sql.unsafe('DROP TRIGGER fixture_reject_start_audit ON ezil_app_audit_events; DROP FUNCTION public.fixture_reject_start_audit()'); }
        const result = await issueComputerStart({ ...options, advance: observer(c), keys: { policy, prepare: async (work, mode, signal) => {
            assert.equal(mode, 'observe'); return options.keys.prepare(work, mode, signal);
        } } }, c.input);
        assert.equal(result.state, 'issued');
    });
    await test('settled recovery checks fenced predecessors and issues only for the replacement writer', async () => {
        const source = await dataMountComputer(sql, 'provision', 'failed'), email = `${source.userId}@example.com`;
        await sql`UPDATE auth.users SET email=${email} WHERE id=${source.userId}`;
        await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'fixture')`;
        await sql`UPDATE ezil_computer_lifecycle_jobs SET error_code='lifecycle_recovered' WHERE id=${source.jobId}`;
        await sql`UPDATE ezil_computer_instances SET observed_state='stopped',fenced_at=now() WHERE computer_id=${source.computerId}`;
        const [pin] = await sql`SELECT digest FROM ezil_computer_lifecycle_intents WHERE job_id=${source.jobId}`;
        const c: MountComputer = { ...source, jobId: randomUUID(), generation: 2, fence: randomUUID(), operation: 'recover',
            instance: `i-${randomUUID().replaceAll('-', '').slice(0, 17)}` };
        await sql.begin(async tx => {
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key)
                VALUES (${c.jobId},${c.computerId},${c.userId},'recover',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${c.jobId},${c.computerId})`;
            await tx`INSERT INTO ezil_computer_recovery_intents(job_id,computer_id,source_job_id,source_schema_version,source_digest,
                revision,target_generation,fence_token,data_volume_id,data_generation,data_fence_token,deployment)
                VALUES (${c.jobId},${c.computerId},${source.jobId},1,${pin!.digest},2,2,${c.fence},${c.volume},1,${source.fence},${JSON.stringify(deployment)})`;
            await tx`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state,observed_at)
                VALUES (${c.computerId},2,${c.instance},${c.fence},'running',now())`;
            await tx`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',completed_at=now() WHERE id=${c.jobId}`;
            await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${c.jobId}`;
        });
        const input = { computerId: c.computerId, configurationId: await configuration(c), mountAuthorizationId: await recordConfigurationMount(sql, c) };
        const result = await issueComputerStart({ ...options, advance: async (work, start, signal, context) => {
            assert.equal(context?.fencedWriters.length, 1); assert.equal(context.fencedWriters[0]!.instanceId, source.instance);
            return observer(c)(work, start, signal, context);
        } }, input);
        assert.equal(result.state, 'issued'); assert.equal((await binding(c))!.computer_generation, 2);
    });
    await test('database failures expose a stable error code without original details', async () => {
        await assert.rejects(issueComputerStart({ ...options, database: { transaction: async () => { throw new Error('PRIVATE_DB_VALUE'); } } as never },
            { computerId: randomUUID(), configurationId: randomUUID(), mountAuthorizationId: randomUUID() }),
        { message: 'computer_start_issuer_unavailable' });
    });
    console.log(`PASS ${passed} startup issuer database checks`);
} finally { await fixture.close(); }
