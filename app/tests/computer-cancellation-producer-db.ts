import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';
import { requestComputerStopCancellation, requestRevokedComputerCancellation,
    type ComputerCancellationOptions } from '../src/server/app-platform/computer-cancellation-producer';
import { claimLifecycleWork, dispatchLifecycleClaim, authorizeLifecycleWork,
    authorizeComputerRecoveryWork, type LifecycleConsumerOptions } from '../src/server/app-platform/lifecycle-consumer';
import { parseComputerLifecycleWork } from '../src/server/app-platform/computer-lifecycle-work';
import { parseComputerCancellation } from '../src/server/app-platform/computer-cancellation-protocol';

const fixture = await runtimeTestDatabase(), { sql } = fixture;
const options: ComputerCancellationOptions = { database: drizzle(sql, { schema }), enabled: true, osAccessMode: 'invite',
    deployments: [deployment], workflows: { [deployment.stateMachineVersionArn]: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-cancel:1' } };
const lifecycle: LifecycleConsumerOptions = { ...options, advance: async () => ({ state: 'pending' }) };
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const reject = (run: () => Promise<unknown>, code = 'lifecycle_conflict') => assert.rejects(run,
    (error: { message?: string; code?: string }) => error.message === code && error.code === code);
async function user() {
    const id = randomUUID(), email = id + '@example.com';
    await sql`INSERT INTO auth.users(id,email) VALUES (${id},${email})`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'test')`;
    return { id, email };
}
async function setup(recovery = false) {
    const owner = await user(), computerId = randomUUID(), jobId = randomUUID(), fence = randomUUID();
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${owner.id},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,desired_state) VALUES (${computerId},'us-east-1','running')`;
    await sql.begin(async tx => {
        const source = recovery ? randomUUID() : jobId;
        await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key) VALUES (${source},${computerId},${owner.id},'provision',${randomUUID()})`;
        await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${source},${computerId})`;
        await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,deployment)
            VALUES (${source},${computerId},1,'provision',1,${fence},${JSON.stringify(deployment)})`;
        if (recovery) {
            const volume = 'vol-' + randomUUID().replaceAll('-', '').slice(0,17);
            await tx`UPDATE ezil_computer_runtimes SET data_volume_id=${volume},availability_zone='us-east-1a' WHERE computer_id=${computerId}`;
            await tx`UPDATE ezil_computer_lifecycle_jobs SET status='failed',error_code='lifecycle_recovered',completed_at=now() WHERE id=${source}`;
            await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${source}`;
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key) VALUES (${jobId},${computerId},${owner.id},'recover',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computerId})`;
            await tx`INSERT INTO ezil_computer_recovery_intents(job_id,computer_id,source_job_id,source_schema_version,source_digest,
                revision,target_generation,fence_token,data_volume_id,data_generation,data_fence_token,deployment)
                SELECT ${jobId},${computerId},${source},1,digest,2,2,${randomUUID()},${volume},1,${fence},${JSON.stringify(deployment)}
                FROM ezil_computer_lifecycle_intents WHERE job_id=${source}`;
        }
    });
    const [row] = recovery
        ? await sql`SELECT digest,created_at,ezil_computer_recovery_document(i) document FROM ezil_computer_recovery_intents i WHERE job_id=${jobId}`
        : await sql`SELECT digest,created_at,ezil_lifecycle_intent_document(i) document FROM ezil_computer_lifecycle_intents i WHERE job_id=${jobId}`;
    const work = { digest: row!.digest as string, document: row!.document as string, createdAt: new Date(row!.created_at) };
    return { computerId, jobId, owner, work, intent: parseComputerLifecycleWork(work) };
}
type Setup = Awaited<ReturnType<typeof setup>>;
async function running(s: Setup) { await sql`UPDATE ezil_computer_lifecycle_jobs SET status='running',started_at=now() WHERE id=${s.jobId}`; }
async function current(s: Setup) {
    const input = { computerId: s.computerId, jobId: s.jobId, digest: s.work.digest };
    return s.intent.schemaVersion === 1 ? authorizeLifecycleWork(lifecycle, input)
        : Boolean(await authorizeComputerRecoveryWork(lifecycle, { schemaVersion: 2, ...input }));
}
async function snapshot(s: Setup) { return (await sql`SELECT j.status,o.delivered_at,r.desired_state,r.data_volume_id,r.next_generation
    FROM ezil_computer_lifecycle_jobs j JOIN ezil_computer_lifecycle_outbox o ON o.job_id=j.id
    JOIN ezil_computer_runtimes r ON r.computer_id=j.computer_id WHERE j.id=${s.jobId}`)[0]!; }
async function claim(s: Setup) {
    await sql`UPDATE ezil_computer_lifecycle_outbox SET available_at=CASE WHEN job_id=${s.jobId} THEN now() ELSE now()+interval '1 day' END
        WHERE delivered_at IS NULL`;
    return claimLifecycleWork(lifecycle);
}
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('disabled producers do not access a database and invalid public input is redacted', async () => {
        const disabled = { ...options, enabled: false, database: null as never };
        assert.deepEqual(await requestComputerStopCancellation(disabled, '', null), { state: 'disabled' });
        assert.deepEqual(await requestRevokedComputerCancellation(disabled, null), { state: 'disabled' });
        for (const input of [null, { computerId: 'sensitive-marker' }, { computerId: randomUUID(), instanceId: 'sensitive-marker' }]) {
            await reject(() => requestComputerStopCancellation(options, randomUUID(), input), 'lifecycle_invalid');
        }
        await reject(() => requestComputerStopCancellation(options, null as never, { computerId: randomUUID() }), 'lifecycle_invalid');
    });
    await test('owner stop binds v1/v2 work, preserves admission/disk and revokes current launch authority', async () => {
        for (const version of [false,true]) {
            const s = await setup(version); await running(s); assert.equal(await current(s), true);
            const before = await snapshot(s), result = await requestComputerStopCancellation(options, s.owner.id, { computerId: s.computerId });
            assert.equal(result.state, 'pending'); if (result.state !== 'pending') throw new Error('missing cancellation');
            const [row] = await sql`SELECT digest,created_at,ezil_computer_cancellation_document(c) document FROM ezil_computer_cancellations c WHERE id=${result.cancellationId}`;
            const c = parseComputerCancellation({ document: row!.document, digest: row!.digest, createdAt: new Date(row!.created_at) }, s.work);
            assert.equal(c.requestedBy, s.owner.id); assert.equal(c.source.stateAtRequest, 'running');
            assert.deepEqual(await snapshot(s), { ...before, desired_state: 'stopped' });
            assert.equal(await current(s), false);
            assert.equal(await claim(s), null);
            await sql`UPDATE ezil_computer_runtimes SET desired_state='running' WHERE computer_id=${s.computerId}`;
            assert.equal(await current(s), false); // An immutable stop cannot be rescinded by desired state alone.
            assert.deepEqual(await requestComputerStopCancellation(options, s.owner.id, { computerId: s.computerId }), result);
        }
    });
    await test('another owner, revoked admin and revoked requester cannot create cancellations', async () => {
        const s = await setup(), other = await user();
        await reject(() => requestComputerStopCancellation(options, other.id, { computerId: s.computerId }));
        await sql`INSERT INTO ezil_app_admins(user_id,revoked_at) VALUES (${other.id},now())`;
        await reject(() => requestComputerStopCancellation(options, other.id, { computerId: s.computerId }));
        await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.owner.email}`;
        await reject(() => requestComputerStopCancellation(options, s.owner.id, { computerId: s.computerId }));
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_cancellations WHERE computer_id=${s.computerId}`)[0]!.n, 0);
    });
    await test('an active platform admin can request a scoped, attributable stop', async () => {
        const s = await setup(), admin = await user();
        await sql`INSERT INTO ezil_app_admins(user_id) VALUES (${admin.id})`;
        assert.equal((await requestComputerStopCancellation(options, admin.id, { computerId: s.computerId })).state, 'pending');
        const [audit] = await sql`SELECT actor_user_id,reason_code,action FROM ezil_app_audit_events WHERE computer_id=${s.computerId}`;
        assert.deepEqual(audit, { actor_user_id: admin.id, reason_code: 'stop_requested', action: 'computer.cancellation_requested' });
    });
    await test('automatic cancellation requires actual revocation and preserves retired intent', async () => {
        for (const reason of ['revoked','banned','deleted','retired','owner_changed']) {
            const s = await setup(); await running(s);
            assert.deepEqual(await requestRevokedComputerCancellation(options, { computerId: s.computerId }), { state: 'inactive' });
            if (reason === 'revoked') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.owner.email}`;
            if (reason === 'banned') await sql`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=${s.owner.id}`;
            if (reason === 'deleted') await sql`UPDATE ezil_computers SET deleted_at=now() WHERE id=${s.computerId}`;
            if (reason === 'retired') await sql`UPDATE ezil_computer_runtimes SET desired_state='retired' WHERE computer_id=${s.computerId}`;
            if (reason === 'owner_changed') { const next = await user(); await sql`UPDATE ezil_computers SET user_id=${next.id} WHERE id=${s.computerId}`; }
            assert.equal((await requestRevokedComputerCancellation(options, { computerId: s.computerId })).state, 'pending');
            const [c] = await sql`SELECT reason,requested_by FROM ezil_computer_cancellations WHERE source_job_id=${s.jobId}`;
            assert.deepEqual(c, { reason: 'authority_revoked', requested_by: null });
            assert.equal((await snapshot(s)).desired_state, reason === 'retired' ? 'retired' : 'stopped');
        }
    });
    await test('lookup failure rolls back instead of inferring revocation', async () => {
        const s = await setup();
        await sql`ALTER TABLE auth.users RENAME COLUMN banned_until TO temporarily_missing`;
        try { await reject(() => requestRevokedComputerCancellation(options, { computerId: s.computerId }), 'lifecycle_unavailable'); }
        finally { await sql`ALTER TABLE auth.users RENAME COLUMN temporarily_missing TO banned_until`; }
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_cancellations WHERE source_job_id=${s.jobId}`)[0]!.n, 0);
        assert.equal((await snapshot(s)).desired_state, 'running');
    });
    await test('healthy finalized work is inactive even though its launch authority is false', async () => {
        const s = await setup(); await sql`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',completed_at=now() WHERE id=${s.jobId}`;
        assert.equal(await current(s), false);
        assert.deepEqual(await requestRevokedComputerCancellation(options, { computerId: s.computerId }), { state: 'inactive' });
        assert.deepEqual(await requestComputerStopCancellation(options, s.owner.id, { computerId: s.computerId }), { state: 'inactive' });
        assert.equal((await snapshot(s)).desired_state, 'running');
    });
    await test('missing deployment approval or workflow mapping never changes desired state', async () => {
        const s = await setup();
        for (const changed of [{ ...options, deployments: [] }, { ...options, workflows: {} }]) {
            await reject(() => requestComputerStopCancellation(changed, s.owner.id, { computerId: s.computerId }));
        }
        await reject(() => requestComputerStopCancellation({ ...options, workflows: { [deployment.stateMachineVersionArn]: deployment.stateMachineVersionArn } },
            s.owner.id, { computerId: s.computerId }), 'lifecycle_unavailable');
        assert.equal((await snapshot(s)).desired_state, 'running');
    });
    await test('concurrent stop requests return one cancellation and one audit event', async () => {
        const s = await setup();
        const results = await Promise.all([requestComputerStopCancellation(options, s.owner.id, { computerId: s.computerId }),
            requestComputerStopCancellation(options, s.owner.id, { computerId: s.computerId })]);
        assert.deepEqual(results[0], results[1]); assert.equal(results[0]!.state, 'pending');
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_app_audit_events WHERE computer_id=${s.computerId}`)[0]!.n, 1);
    });
    await test('a claim cancelled before dispatch makes no provider call', async () => {
        const s = await setup(), c = await claim(s); assert.ok(c);
        await requestComputerStopCancellation(options, s.owner.id, { computerId: s.computerId });
        assert.equal(await dispatchLifecycleClaim({ ...lifecycle, advance: async () => { throw new Error('must not call provider'); } }, c), 'stale');
        assert.equal((await snapshot(s)).status, 'queued');
    });
    await test('cancellation racing provider success or failure cleanup retains the reservation for its own consumer', async () => {
        for (const [recovery, cleanup] of [[false,false],[true,false],[false,true],[true,true]] as const) {
            const s = await setup(recovery); await running(s); const c = await claim(s); assert.ok(c);
            assert.equal(await dispatchLifecycleClaim({ ...lifecycle, advance: async (work, allowed) => {
                assert.equal(allowed, true);
                await requestComputerStopCancellation(options, s.owner.id, { computerId: s.computerId });
                assert.equal(await current(s), false);
                const i = parseComputerLifecycleWork(work);
                if (cleanup) return { state: 'fenced', observedAt: new Date(), receipt: { schemaVersion: i.schemaVersion,
                    sourceExecutionArn: deployment.stateMachineVersionArn.slice(0,-2).replace(':stateMachine:',':execution:') + `:computer-${i.jobId}`,
                    jobId: i.jobId, computerId: i.computerId, digest: work.digest, state: 'fenced',
                    volumeId: i.dataVolumeId ?? 'vol-11111111111111111', instances: [] } };
                return { state: 'observed', observedAt: new Date(), receipt: { schemaVersion: i.schemaVersion,
                    jobId: i.jobId, computerId: i.computerId, digest: work.digest, generation: i.targetGeneration,
                    fenceToken: i.fenceToken, instanceId: 'i-11111111111111111', volumeId: i.dataVolumeId ?? 'vol-11111111111111111', state: 'running' } };
            } }, c), 'stale');
            const state = await snapshot(s); assert.equal(state.status, 'running'); assert.equal(state.delivered_at, null);
            assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_instances WHERE computer_id=${s.computerId}`)[0]!.n, 0);
        }
    });
    console.log(`${passed} computer cancellation producer database checks passed; 0 failed`);
} finally { await fixture.close(); }
