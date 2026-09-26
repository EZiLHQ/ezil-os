import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { claimLifecycleWork, dispatchLifecycleClaim, authorizeLifecycleWork, authorizeComputerRecoveryWork,
    type LifecycleConsumerOptions } from '../src/server/app-platform/lifecycle-consumer';
import { parseComputerLifecycleWork, type ComputerRecoveryReceipt, type ComputerRecoveryCleanup } from '../src/server/app-platform/computer-lifecycle-work';
import { type LifecycleWork } from '../src/server/app-platform/lifecycle-protocol';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { createLifecycleAuthorityHandler } from '../src/server/app-platform/lifecycle-authority-http';
import { LIFECYCLE_AUTHORITY_PATH, lifecycleAuthoritySignature } from '../src/server/app-platform/lifecycle-authority-protocol';
import { prepareApplicationComputerStart } from '../src/server/app-platform/application-computer-start';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
const { instanceProfileArn: _profile, ...shared } = deployment;
const options: LifecycleConsumerOptions = { database: drizzle(sql, { schema }), enabled: true, osAccessMode: 'invite',
    deployments: [deployment, { profileMode: 'per-writer', deployment: shared }], advance: async () => ({ state: 'pending' }) };
assert.ok(_profile);
const handle = (prefix: string) => prefix + '-' + randomUUID().replaceAll('-', '').slice(0, 17);
let passed = 0;
async function isolate() {
    // Only fixture cleanup in this disposable database, never provider evidence.
    await sql`UPDATE ezil_computer_lifecycle_jobs SET status='cancelled' WHERE status IN ('queued','running')`;
    await sql`UPDATE ezil_computer_instances SET observed_state='stopped',observed_at=now()`;
}
const test = async (name: string, run: () => Promise<void>) => { await isolate(); await run(); passed++; console.log(`PASS ${name}`); };
async function claim(jobId: string) {
    await sql`UPDATE ezil_computer_lifecycle_outbox SET available_at=CASE WHEN job_id=${jobId} THEN now() ELSE now()+interval '1 day' END`;
    const c = await claimLifecycleWork(options); assert.ok(c); assert.equal(c.jobId, jobId); return c;
}
async function state(jobId: string) { return (await sql`SELECT j.status,j.error_code,o.delivered_at FROM ezil_computer_lifecycle_jobs j
    JOIN ezil_computer_lifecycle_outbox o ON o.job_id=j.id WHERE j.id=${jobId}`)[0]!; }
async function provision() {
    const computerId = randomUUID(), userId = randomUUID(), email = userId + '@example.com', jobId = randomUUID(), fence = randomUUID();
    await sql`INSERT INTO auth.users(id,email) VALUES (${userId},${email})`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'test')`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${userId},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,desired_state) VALUES (${computerId},'us-east-1','running')`;
    await sql.begin(async tx => {
        await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${jobId},${computerId},${userId},'provision',${randomUUID()})`;
        await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computerId})`;
        await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,deployment)
            VALUES (${jobId},${computerId},1,'provision',1,${fence},${JSON.stringify(deployment)})`;
    });
    return { computerId, userId, email, jobId, fence };
}
async function recovery(allocated = true) {
    const s = await provision(), volume = handle('vol'), instance = handle('i');
    // Drive the real v1 cleanup consumer before inserting v2. The adapter result
    // is a fixture; these tests make no claim about a real EC2 allocation.
    assert.equal(await dispatchLifecycleClaim({ ...options, advance: async work => ({ state: 'fenced', observedAt: new Date(), receipt: {
        schemaVersion: 1, sourceExecutionArn: deployment.stateMachineVersionArn.slice(0, -2).replace(':stateMachine:', ':execution:') + `:computer-${s.jobId}`,
        computerId: s.computerId, jobId: s.jobId, digest: work.digest, state: 'fenced', volumeId: volume,
        instances: allocated ? [{ instanceId: instance, generation: 1, fenceToken: s.fence, state: 'terminated' }] : [],
    } }) }, await claim(s.jobId)), 'failed');
    const jobId = await nextRecovery(s.computerId, s.userId, s.jobId, volume, 1, s.fence, 2, 1);
    return { ...s, sourceJobId: s.jobId, jobId, volume, instance };
}
async function nextRecovery(computer: string, user: string, source: string, volume: string, dataGeneration: number,
    dataFence: string, generation: number, sourceVersion: 1 | 2) {
    const jobId = randomUUID(), table = sourceVersion === 1 ? 'ezil_computer_lifecycle_intents' : 'ezil_computer_recovery_intents';
    const [row] = await sql`SELECT digest,revision FROM ${sql(table)} WHERE job_id=${source}`;
    const pins = { ...deployment, instanceProfileArn: `arn:aws:iam::123456789012:instance-profile/ezil/pilot/computers/${computer}/g${generation}` };
    await sql.begin(async tx => {
        await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key)
            VALUES (${jobId},${computer},${user},'recover',${randomUUID()})`;
        await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computer})`;
        await tx`INSERT INTO ezil_computer_recovery_intents(job_id,computer_id,source_job_id,source_schema_version,source_digest,revision,
            target_generation,fence_token,data_volume_id,data_generation,data_fence_token,deployment)
            VALUES (${jobId},${computer},${source},${sourceVersion},${row!.digest},${row!.revision + 1},${generation},${randomUUID()},${volume},
                ${dataGeneration},${dataFence},${JSON.stringify(pins)})`;
    }); return jobId;
}
const observed = (work: LifecycleWork) => {
    const i = parseComputerLifecycleWork(work); assert.equal(i.schemaVersion, 2); assert.equal(i.operation, 'recover');
    const receipt: ComputerRecoveryReceipt = { schemaVersion: 2, jobId: i.jobId, digest: work.digest, computerId: i.computerId,
        generation: i.targetGeneration, fenceToken: i.fenceToken, instanceId: handle('i'), volumeId: i.dataVolumeId!, state: 'running' };
    return { state: 'observed' as const, receipt, observedAt: new Date() };
};
const cleaned = (work: LifecycleWork, allocated = true) => {
    const { receipt } = observed(work), i = parseComputerLifecycleWork(work);
    const result: ComputerRecoveryCleanup = { schemaVersion: 2, jobId: i.jobId, digest: work.digest, computerId: i.computerId,
        sourceExecutionArn: i.deployment.stateMachineVersionArn.slice(0, -2).replace(':stateMachine:', ':execution:') + `:computer-${i.jobId}`,
        state: 'fenced', volumeId: receipt.volumeId, instances: allocated ? [{ instanceId: receipt.instanceId,
            generation: receipt.generation, fenceToken: receipt.fenceToken, state: 'terminated' }] : [] };
    return { state: 'fenced' as const, receipt: result, observedAt: new Date() };
};
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('v2 success registers one fresh writer on the retained disk and preserves old fences', async () => {
        for (const allocated of [false, true]) {
            await isolate(); const s = await recovery(allocated); let received: ComputerRecoveryReceipt | undefined;
            assert.equal(await dispatchLifecycleClaim({ ...options, advance: async (work, allow, _signal, context) => {
                assert.equal(allow, true); assert.equal(context!.fencedWriters.length, allocated ? 1 : 0);
                const [row] = await sql`SELECT digest,ezil_computer_recovery_document(i) document FROM ezil_computer_recovery_intents i WHERE job_id=${s.jobId}`;
                assert.equal(work.document, row!.document); assert.equal(work.digest, row!.digest);
                await sql.begin(async tx => { await tx`SET LOCAL lock_timeout='200ms'`; await tx`SELECT * FROM ezil_computers WHERE id=${s.computerId} FOR UPDATE`; });
                const result = observed(work); received = result.receipt; return result;
            } }, await claim(s.jobId)), 'succeeded');
            const rows = await sql`SELECT * FROM ezil_computer_instances WHERE computer_id=${s.computerId} ORDER BY generation`;
            assert.equal(rows.length, allocated ? 2 : 1); assert.equal(rows.at(-1)!.provider_instance_id, received!.instanceId);
            assert.equal(rows.at(-1)!.fenced_at, null); if (allocated) assert.ok(rows[0]!.fenced_at);
            assert.equal((await sql`SELECT data_volume_id FROM ezil_computer_runtimes WHERE computer_id=${s.computerId}`)[0]!.data_volume_id, s.volume);
            assert.ok((await state(s.jobId)).delivered_at);
            // A later Open on this recovered writer must retain v2 deployment
            // pins and the disk while emitting the existing v1 start protocol.
            await sql`UPDATE ezil_computer_instances SET observed_state='stopped' WHERE computer_id=${s.computerId} AND fenced_at IS NULL`;
            await options.database.transaction(tx => prepareApplicationComputerStart(tx, { computerId: s.computerId,
                userId: s.userId, computerGeneration: received!.generation, appJobId: randomUUID(),
                deployments: options.deployments, osAccessMode: 'invite' }));
            const [start] = await sql`SELECT i.* FROM ezil_computer_lifecycle_intents i WHERE computer_id=${s.computerId} AND operation='start'`;
            assert.equal(start!.target_generation, received!.generation);
            assert.equal(start!.provider_instance_id, received!.instanceId);
            assert.equal(start!.data_volume_id, s.volume);
            assert.equal(JSON.parse(start!.deployment).instanceProfileArn,
                `arn:aws:iam::123456789012:instance-profile/ezil/pilot/computers/${s.computerId}/g${received!.generation}`);
        }
    });
    await test('signed v2 authority reads current scope on replay and cannot be confused with v1 or another computer', async () => {
        const s = await recovery();
        await dispatchLifecycleClaim({ ...options, advance: async work => {
            const input = { schemaVersion: 2 as const, computerId: s.computerId, jobId: s.jobId, digest: work.digest };
            assert.equal((await authorizeComputerRecoveryWork(options, input))?.writers[0]?.instanceId, s.instance);
            assert.equal(await authorizeLifecycleWork(options, input), false);
            assert.equal(await authorizeComputerRecoveryWork(options, { ...input, computerId: randomUUID() }), null);
            const secret = 'ab'.repeat(32), body = JSON.stringify(input), timestamp = String(Math.floor(Date.now()/1000));
            const request = new Request('https://control.example' + LIFECYCLE_AUTHORITY_PATH, { method: 'POST', body,
                headers: { 'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp,
                    'x-ezil-workflow-signature': lifecycleAuthoritySignature(Buffer.from(body), secret, timestamp) } });
            const handler = createLifecycleAuthorityHandler({ enabled: true, secret, authorize: input => authorizeLifecycleWork(options, input),
                authorizeRecovery: input => authorizeComputerRecoveryWork(options, input) });
            assert.equal((await handler(request.clone())).status, 200);
            await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
            assert.equal((await handler(request)).status, 403); return { state: 'pending' };
        } }, await claim(s.jobId));
    });
    await test('v1 and v2 share atomic admission and expired leases keep their reservations', async () => {
        const a = await recovery(), b = await recovery(), c = await provision(); const claims = [];
        for (const s of [a,b,c]) claims.push(await claim(s.jobId));
        let calls = 0; await Promise.all(claims.map(c => dispatchLifecycleClaim({ ...options, advance: async () => { calls++; return { state: 'pending' }; } }, c)));
        assert.equal(calls, 2); assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_lifecycle_jobs WHERE status='running'`)[0]!.n, 2);
        await sql`UPDATE ezil_computer_lifecycle_outbox SET lease_until=now()-interval '1 second'`;
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_lifecycle_jobs WHERE status='running'`)[0]!.n, 2);
    });
    await test('wrong approval, revoked access, unacknowledged source and changed writer state deny before provider work', async () => {
        for (const kind of ['approval', 'revoked', 'source', 'writer']) {
            await isolate(); const s = await recovery();
            if (kind === 'revoked') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
            if (kind === 'source') await sql`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=null WHERE job_id=${s.sourceJobId}`;
            if (kind === 'writer') await sql`UPDATE ezil_computer_instances SET observed_state='running' WHERE computer_id=${s.computerId}`;
            let calls = 0; await dispatchLifecycleClaim({ ...options, deployments: kind === 'approval' ? [] : options.deployments,
                advance: async () => { calls++; return { state: 'pending' }; } }, await claim(s.jobId));
            assert.equal(calls, 0); assert.equal((await state(s.jobId)).status, 'queued');
        }
    });
    await test('lease takeover and stale or foreign receipts cannot register a new writer', async () => {
        for (const kind of ['lease', 'time', 'disk', 'old-id', 'fence-set']) {
            await isolate(); const s = await recovery(), c = await claim(s.jobId);
            const result = dispatchLifecycleClaim({ ...options, advance: async work => {
                const r = observed(work);
                if (kind === 'time') r.observedAt = new Date(0);
                if (kind === 'disk') r.receipt.volumeId = handle('vol');
                if (kind === 'old-id') r.receipt.instanceId = s.instance;
                if (kind === 'fence-set') await sql`UPDATE ezil_computer_instances SET observed_at=observed_at-interval '1 second' WHERE computer_id=${s.computerId}`;
                if (kind === 'lease') { await sql`UPDATE ezil_computer_lifecycle_outbox SET lease_until=now()-interval '1 second' WHERE job_id=${s.jobId}`; await claim(s.jobId); }
                return r;
            } }, c);
            if (kind === 'disk') await assert.rejects(result); else assert.equal(await result, kind === 'lease' ? 'stale' : 'waiting');
            assert.equal((await state(s.jobId)).status, 'running'); assert.equal((await state(s.jobId)).delivered_at, null);
            assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_instances WHERE computer_id=${s.computerId}`)[0]!.n, 1);
        }
    });
    await test('revocation racing success retains admission; separately verified failed-work cleanup survives revocation', async () => {
        const s = await recovery();
        assert.equal(await dispatchLifecycleClaim({ ...options, advance: async work => {
            await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`; return observed(work);
        } }, await claim(s.jobId)), 'waiting'); assert.equal((await state(s.jobId)).status, 'running');
        // A SUCCEEDED source cannot use failure cleanup. This separate pending
        // fixture models a workflow that failed after revocation instead.
        const pending = await recovery();
        await dispatchLifecycleClaim(options, await claim(pending.jobId));
        await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${pending.email}`;
        assert.equal(await dispatchLifecycleClaim({ ...options, advance: async (work, allow) => { assert.equal(allow, false); return cleaned(work); } }, await claim(pending.jobId)), 'failed');
        assert.equal((await state(pending.jobId)).error_code, 'lifecycle_recovered');
        assert.equal((await state(s.jobId)).status, 'running');
    });
    await test('data-only and allocated v2 failures retain the same disk for another recovery generation', async () => {
        for (const allocated of [false, true]) {
            await isolate(); const s = await recovery(false);
            assert.equal(await dispatchLifecycleClaim({ ...options, advance: async work => cleaned(work, allocated) }, await claim(s.jobId)), 'failed');
            const next = await nextRecovery(s.computerId, s.userId, s.jobId, s.volume, 1, s.fence, 3, 2);
            assert.equal(await dispatchLifecycleClaim({ ...options, advance: async work => observed(work) }, await claim(next)), 'succeeded');
            assert.equal((await sql`SELECT data_volume_id FROM ezil_computer_runtimes WHERE computer_id=${s.computerId}`)[0]!.data_volume_id, s.volume);
        }
    });
    console.log(`${passed} recovery consumer database checks passed; 0 failed`);
} finally { await fixture.close(); }
