import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { issueComputerDataMount } from '../src/server/app-platform/computer-mount-authority';
import { parseComputerLifecycleWork } from '../src/server/app-platform/computer-lifecycle-work';
import { loadRecoveryWriters } from '../src/server/app-platform/computer-recovery-authority';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { dataMountComputer, type MountComputer } from './fixtures/data-mount';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
type Options = Parameters<typeof issueComputerDataMount>[0];
const options: Options = { database: drizzle(sql, { schema }), enabled: true, osAccessMode: 'invite', deployments: [deployment],
    advance: async () => ({ state: 'pending' }) };
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
async function setup(operation: 'provision' | 'start' | 'replace' = 'provision') {
    const c = await dataMountComputer(sql, operation), email = `${randomUUID()}@example.com`;
    await sql`UPDATE auth.users SET email=${email} WHERE id=${c.userId}`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'fixture')`;
    return { ...c, email };
}
const input = (c: MountComputer) => ({ computerId: c.computerId, jobId: c.jobId });
const observer = (c: MountComputer): Options['advance'] => async (work, allowStart, signal) => {
    assert.equal(allowStart, false, 'mount issuer must never start a missing execution'); assert.equal(signal.aborted, false);
    const i = parseComputerLifecycleWork(work);
    return { state: 'observed', observedAt: new Date(), receipt: { schemaVersion: i.schemaVersion,
        computerId: c.computerId, jobId: c.jobId, digest: work.digest, generation: c.generation,
        fenceToken: c.fence, instanceId: c.instance, volumeId: c.volume, state: 'running' } };
};
const count = async (c: MountComputer) => (await sql`SELECT count(*)::int n FROM ezil_computer_data_mount_authorizations WHERE computer_id=${c.computerId}`)[0]!.n;
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('disabled and forged inputs never reach database or provider', async () => {
        const invalid = { ...options, database: null as never, advance: async () => { throw new Error('must_not_call'); } };
        assert.equal((await issueComputerDataMount({ ...invalid, enabled: false }, null)).state, 'disabled');
        assert.equal((await issueComputerDataMount(invalid, { computerId: randomUUID(), jobId: randomUUID(), volume: 'vol-selected-by-browser' })).state, 'denied');
    });
    await test('provider observation holds no SQL locks; concurrent issuance reuses one immutable grant and deadline', async () => {
        const c = await setup(); let calls = 0;
        const o = { ...options, advance: async (...args: Parameters<Options['advance']>) => {
            calls++;
            await sql.begin(async tx => { await tx`SET LOCAL lock_timeout='200ms'`; await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`; });
            return observer(c)(...args);
        } };
        const results = await Promise.all([issueComputerDataMount(o, input(c)), issueComputerDataMount(o, input(c))]);
        assert.equal(calls, 2); assert.equal(await count(c), 1);
        const [a, b] = results; assert.ok(a?.state === 'issued' && b?.state === 'issued');
        assert.deepEqual(a, b); assert.equal(a.plan.mode, 'initialize');
        assert.equal(a.authorization.digest, createHash('sha256').update(JSON.stringify(a.plan)).digest('hex'));
        assert.equal(a.authorization.expiresAt - a.authorization.issuedAt, 900);
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_data_mount_deliveries WHERE authorization_id=${a.authorization.authorizationId}`)[0]!.n, 1);
    });
    await test('start and replacement issue mount-only records', async () => {
        for (const operation of ['start', 'replace'] as const) {
            const c = await setup(operation), result = await issueComputerDataMount({ ...options, advance: observer(c) }, input(c));
            assert.ok(result.state === 'issued'); assert.equal(result.plan.mode, 'mount');
        }
    });
    await test('revoked users, wrong deployments and cross-computer jobs deny before observation', async () => {
        for (const reason of ['revoked', 'deployment', 'foreign']) {
            const c = await setup(), other = await setup(); let calls = 0;
            if (reason === 'revoked') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
            const o = { ...options, deployments: reason === 'deployment' ? [] : options.deployments,
                advance: async (...args: Parameters<Options['advance']>) => { calls++; return observer(c)(...args); } };
            const result = await issueComputerDataMount(o, { ...input(c), jobId: reason === 'foreign' ? other.jobId : c.jobId });
            assert.equal(result.state, 'denied'); assert.equal(calls, 0); assert.equal(await count(c), 0);
        }
    });
    await test('access, desired state, writer fencing and kill-switch changes during observation prevent issuance', async () => {
        for (const reason of ['access', 'stop', 'fence', 'disable']) {
            const c = await setup();
            const o: Options = { ...options, advance: async (...args) => {
                if (reason === 'access') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${c.email}`;
                if (reason === 'stop') await sql`UPDATE ezil_computer_runtimes SET desired_state='stopped' WHERE computer_id=${c.computerId}`;
                if (reason === 'fence') await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
                if (reason === 'disable') o.enabled = false;
                return observer(c)(...args);
            } };
            assert.equal((await issueComputerDataMount(o, input(c))).state, 'denied'); assert.equal(await count(c), 0);
        }
    });
    await test('missing, stale and failed provider observations never turn DB running state into authority', async () => {
        for (const reason of ['pending', 'stale', 'failure', 'volume']) {
            const c = await setup();
            const advance: Options['advance'] = async (...args) => {
                if (reason === 'pending') return { state: 'pending' };
                if (reason === 'failure') throw new Error('PRIVATE_PROVIDER_VALUE');
                const result = await observer(c)(...args); assert.ok(result.state === 'observed');
                if (reason === 'stale') result.observedAt = new Date(Date.now() - 60000);
                if (reason === 'volume') result.receipt.volumeId = 'vol-99999999999999999';
                return result;
            };
            assert.equal((await issueComputerDataMount({ ...options, advance }, input(c))).state, 'unconfirmed');
            assert.equal(await count(c), 0);
        }
    });
    await test('revoked initialization authority cannot be reissued or have its deadline extended', async () => {
        const c = await setup(), o = { ...options, advance: observer(c) };
        const issued = await issueComputerDataMount(o, input(c)); assert.ok(issued.state === 'issued');
        await sql`UPDATE ezil_computer_data_mount_authorizations SET revoked_at=now() WHERE id=${issued.authorization.authorizationId}`;
        assert.equal((await issueComputerDataMount({ ...o, advance: async () => { throw new Error('should_not_observe'); } }, input(c))).state, 'denied');
        assert.equal(await count(c), 1);
    });
    await test('settled recovery re-observes fenced predecessors while active recovery validation stays unchanged', async () => {
        const source = await dataMountComputer(sql, 'provision', 'failed'), email = `${randomUUID()}@example.com`;
        await sql`UPDATE auth.users SET email=${email} WHERE id=${source.userId}`; await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'fixture')`;
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
        const result = await issueComputerDataMount({ ...options, advance: async (work, allowStart, signal, context) => {
            assert.equal(context?.fencedWriters.length, 1); assert.equal(context.fencedWriters[0]!.instanceId, source.instance);
            const intent = parseComputerLifecycleWork(work); assert.equal(intent.schemaVersion, 2);
            if (intent.schemaVersion !== 2) throw new Error('wrong_version');
            assert.equal(await options.database.transaction(tx => loadRecoveryWriters(tx, intent)), null);
            return observer(c)(work, allowStart, signal, context);
        } }, input(c));
        assert.ok(result.state === 'issued'); assert.equal(result.plan.mode, 'mount'); assert.equal(result.plan.filesystemUuid, source.filesystemUuid);
    });
    console.log(`PASS ${passed} mount issuer database checks`);
} finally { await fixture.close(); }
