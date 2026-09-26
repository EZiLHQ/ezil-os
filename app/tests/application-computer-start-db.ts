import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../src/server/db/schema';
import { prepareApplicationComputerStart } from '../src/server/app-platform/application-computer-start';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';
import { runtimeTestDatabase } from './helpers/runtime-database';
import type { LifecycleApproval } from '../src/server/app-platform/lifecycle-approval';

const fixture = await runtimeTestDatabase(), { sql } = fixture, database = drizzle(sql, { schema });
const handle = (prefix: string) => `${prefix}-${randomUUID().replaceAll('-', '').slice(0, 17)}`;
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
async function setup(withHistory = true) {
    const computerId = randomUUID(), userId = randomUUID(), email = `${userId}@example.com`, jobId = randomUUID();
    const volume = handle('vol'), instance = handle('i'), fence = randomUUID();
    await sql`INSERT INTO auth.users(id,email) VALUES (${userId},${email})`;
    await sql`INSERT INTO ezil_os_access(email,invited_by) VALUES (${email},'test')`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${userId},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region,availability_zone,data_volume_id,next_generation)
        VALUES (${computerId},'us-east-1','us-east-1a',${volume},2)`;
    await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state)
        VALUES (${computerId},1,${instance},${fence},'stopped')`;
    const result = { computerId, userId, email, jobId, volume, instance, fence, appJobId: randomUUID(), computerGeneration: 1 };
    if (!withHistory) return result;
    await sql`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key)
        VALUES (${jobId},${computerId},${userId},'stop',${randomUUID()})`;
    await sql`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computerId})`;
    await sql`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,
        provider_instance_id,data_volume_id,deployment) VALUES (${jobId},${computerId},1,'stop',1,${fence},${instance},${volume},${JSON.stringify(deployment)})`;
    await sql`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',completed_at=now() WHERE id=${jobId}`;
    await sql`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${jobId}`;
    return result;
}
type Setup = Awaited<ReturnType<typeof setup>>;
const prepare = (s: Setup, deployments: readonly LifecycleApproval[] = [deployment]) => database.transaction(tx =>
    prepareApplicationComputerStart(tx, { ...s, deployments, osAccessMode: 'invite' }));
const snapshot = async (s: Setup) => ({
    jobs: await sql`SELECT * FROM ezil_computer_lifecycle_jobs WHERE computer_id=${s.computerId} ORDER BY id`,
    intents: await sql`SELECT * FROM ezil_computer_lifecycle_intents WHERE computer_id=${s.computerId} ORDER BY revision`,
    outbox: await sql`SELECT * FROM ezil_computer_lifecycle_outbox WHERE computer_id=${s.computerId} ORDER BY id`,
    runtime: await sql`SELECT * FROM ezil_computer_runtimes WHERE computer_id=${s.computerId}`,
    writers: await sql`SELECT * FROM ezil_computer_instances WHERE computer_id=${s.computerId}`,
});
async function denied(s: Setup, code: string, options?: readonly LifecycleApproval[]) {
    const before = await snapshot(s);
    await assert.rejects(prepare(s, options), (error: Error & { code?: string }) => error.code === code && error.message === code);
    assert.deepEqual(await snapshot(s), before);
}
try {
    await sql`ALTER TABLE auth.users ADD COLUMN email text, ADD COLUMN banned_until timestamptz, ADD COLUMN deleted_at timestamptz`;
    await test('concurrent applications and retries share one immutable computer start and never allocate a new writer', async () => {
        const s = await setup();
        await Promise.all([prepare(s), prepare(s), prepare({ ...s, appJobId: randomUUID() })]);
        const state = await snapshot(s);
        assert.equal(state.jobs.length, 2); assert.equal(state.intents.length, 2); assert.equal(state.outbox.length, 2);
        assert.equal(state.runtime[0]!.desired_state, 'running'); assert.equal(state.runtime[0]!.next_generation, 2);
        assert.equal(state.writers.length, 1); assert.equal(state.writers[0]!.observed_state, 'stopped');
        const i = state.intents[1]!;
        assert.equal(i.provider_instance_id, s.instance); assert.equal(i.data_volume_id, s.volume);
        assert.equal(i.fence_token, s.fence); assert.equal(i.target_generation, 1);
        assert.deepEqual(JSON.parse(i.deployment), deployment);
    });
    await test('ownership, OS invitation, ban, deleted identity and deleted computer deny without writes', async () => {
        for (const kind of ['owner', 'access', 'ban', 'identity', 'computer']) {
            const s = await setup();
            if (kind === 'owner') s.userId = randomUUID();
            if (kind === 'access') await sql`UPDATE ezil_os_access SET revoked_at=now() WHERE email=${s.email}`;
            if (kind === 'ban') await sql`UPDATE auth.users SET banned_until=now()+interval '1 day' WHERE id=${s.userId}`;
            if (kind === 'identity') await sql`UPDATE auth.users SET deleted_at=now() WHERE id=${s.userId}`;
            if (kind === 'computer') await sql`UPDATE ezil_computers SET deleted_at=now() WHERE id=${s.computerId}`;
            await denied(s, 'computer_start_denied');
        }
    });
    await test('missing or changed deployment approval never silently reassigns an existing computer', async () => {
        const s = await setup();
        for (const pins of [[], [{ ...deployment, launchTemplateVersion: '2' }], [{ ...deployment, availabilityZone: 'us-east-1b' }]]) {
            await denied(s, 'computer_start_denied', pins);
        }
        await prepare(s);
        await denied({ ...s, appJobId: randomUUID() }, 'computer_start_denied', []);
    });
    await test('unknown, fenced, mismatched or transitional writers require recovery', async () => {
        for (const kind of ['missing-id', 'fenced', 'generation', 'fence', 'instance', 'volume', 'starting', 'failed', 'retired']) {
            const s = await setup();
            if (kind === 'missing-id') await sql`UPDATE ezil_computer_instances SET provider_instance_id=null WHERE computer_id=${s.computerId}`;
            if (kind === 'fenced') await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${s.computerId}`;
            if (kind === 'generation') s.computerGeneration = 2;
            if (kind === 'fence') await sql`UPDATE ezil_computer_instances SET fence_token=${randomUUID()} WHERE computer_id=${s.computerId}`;
            if (kind === 'instance') await sql`UPDATE ezil_computer_instances SET provider_instance_id=${handle('i')} WHERE computer_id=${s.computerId}`;
            if (kind === 'volume') await sql`UPDATE ezil_computer_runtimes SET data_volume_id=${handle('vol')} WHERE computer_id=${s.computerId}`;
            if (kind === 'starting' || kind === 'failed') await sql`UPDATE ezil_computer_instances SET observed_state=${kind} WHERE computer_id=${s.computerId}`;
            if (kind === 'retired') await sql`UPDATE ezil_computer_runtimes SET desired_state='retired' WHERE computer_id=${s.computerId}`;
            await denied(s, 'computer_recovery_required');
        }
    });
    await test('a running approved writer does not produce a start job', async () => {
        const s = await setup();
        await sql`UPDATE ezil_computer_instances SET observed_state='running' WHERE computer_id=${s.computerId}`;
        await prepare(s);
        const state = await snapshot(s); assert.equal(state.jobs.length, 1); assert.equal(state.intents.length, 1);
    });
    await test('queued stop, replace, retire, migrate, recover or provision prevents an application start', async () => {
        for (const operation of ['stop', 'replace', 'retire', 'migrate', 'recover', 'provision']) {
            const s = await setup();
            await sql`INSERT INTO ezil_computer_lifecycle_jobs(computer_id,requested_by,operation,idempotency_key)
                VALUES (${s.computerId},${s.userId},${operation},${randomUUID()})`;
            await denied(s, 'computer_lifecycle_in_progress');
        }
    });
    await test('an old queued start without an immutable intent is not backfilled or reported accepted', async () => {
        const s = await setup();
        await sql`INSERT INTO ezil_computer_lifecycle_jobs(computer_id,requested_by,operation,idempotency_key,target_generation)
            VALUES (${s.computerId},${s.userId},'start',${randomUUID()},1)`;
        await denied(s, 'computer_recovery_required');
    });
    await test('a writer without deployment history and a pending start from another requester fail closed', async () => {
        await denied(await setup(false), 'computer_recovery_required');
        const s = await setup(), other = await setup();
        await prepare(s);
        await sql`UPDATE ezil_computer_lifecycle_jobs SET requested_by=${other.userId} WHERE computer_id=${s.computerId} AND operation='start'`;
        await denied({ ...s, appJobId: randomUUID() }, 'computer_start_denied');
    });
    await test('failed, cancelled, unacknowledged or spent work is never revived by a new request', async () => {
        for (const kind of ['failed', 'cancelled', 'unacknowledged', 'spent', 'delivered-pending']) {
            const s = await setup(); await prepare(s);
            const [job] = await sql`SELECT id FROM ezil_computer_lifecycle_jobs WHERE computer_id=${s.computerId} AND operation='start'`;
            if (kind !== 'delivered-pending') await sql`UPDATE ezil_computer_lifecycle_jobs
                SET status=${kind === 'failed' || kind === 'cancelled' ? kind : 'succeeded'},completed_at=now() WHERE id=${job!.id}`;
            if (kind !== 'unacknowledged') await sql`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${job!.id}`;
            await denied(kind === 'spent' ? s : { ...s, appJobId: randomUUID() }, 'computer_recovery_required');
        }
    });
    await test('a fresh command after observed stop preserves the writer and gets a new immutable revision', async () => {
        const s = await setup(); await prepare(s);
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',completed_at=now() WHERE computer_id=${s.computerId} AND operation='start'`;
        await sql`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE computer_id=${s.computerId}`;
        await prepare({ ...s, appJobId: randomUUID() });
        const state = await snapshot(s);
        assert.equal(state.intents[2]!.revision, 3); assert.equal(state.intents[2]!.target_generation, 1);
        assert.equal(state.intents[2]!.provider_instance_id, s.instance); assert.equal(state.intents[2]!.data_volume_id, s.volume);
        assert.equal(state.runtime[0]!.next_generation, 2);
    });
    console.log(`${passed} pass, 0 fail, 0 skip — actual PostgreSQL application computer-start transactions`);
} finally { await fixture.close(); }
