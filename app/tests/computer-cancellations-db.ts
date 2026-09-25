import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TransactionSql } from 'postgres';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';
import { parseComputerCancellation } from '../src/server/app-platform/computer-cancellation-protocol';
import type { LifecycleIntent } from '../src/server/app-platform/lifecycle-protocol';

const fixture = await runtimeTestDatabase({ throughMigration: '0008_computer_recovery_intents' }), { sql } = fixture;
const workflow = 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-cancel:1';
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const reject = (run: () => Promise<unknown>, code = '23514') => assert.rejects(run, (e: { code?: string }) => e.code === code);
const handle = (prefix: string) => prefix + '-' + randomUUID().replaceAll('-', '').slice(0, 17);
async function source(operation: LifecycleIntent['operation'] | 'recover' = 'provision', running = false) {
    const computerId = randomUUID(), userId = randomUUID(), jobId = randomUUID(), fence = randomUUID(), volume = handle('vol'), instance = handle('i');
    await sql`INSERT INTO auth.users(id) VALUES (${userId})`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${userId},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region) VALUES (${computerId},'us-east-1')`;
    await sql.begin(async tx => {
        const initialJob = operation === 'recover' ? randomUUID() : jobId;
        if (operation !== 'provision' && operation !== 'recover') {
            await tx`UPDATE ezil_computer_runtimes SET data_volume_id=${volume},availability_zone='us-east-1a',next_generation=2 WHERE computer_id=${computerId}`;
            await tx`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state,observed_at)
                VALUES (${computerId},1,${instance},${fence},'running',now())`;
        }
        const op = operation === 'recover' ? 'provision' : operation;
        await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key) VALUES (${initialJob},${computerId},${userId},${op},${randomUUID()})`;
        await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${initialJob},${computerId})`;
        await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,
            provider_instance_id,data_volume_id,previous_generation,previous_instance_id,previous_fence_token,deployment)
            VALUES (${initialJob},${computerId},1,${op},${op === 'replace' ? 2 : 1},${op === 'replace' ? randomUUID() : fence},
                ${['provision','replace'].includes(op) ? null : instance},${op === 'provision' ? null : volume},
                ${op === 'replace' ? 1 : null},${op === 'replace' ? instance : null},${op === 'replace' ? fence : null},${JSON.stringify(deployment)})`;
        if (operation === 'recover') {
            await tx`UPDATE ezil_computer_runtimes SET data_volume_id=${volume},availability_zone='us-east-1a' WHERE computer_id=${computerId}`;
            await tx`UPDATE ezil_computer_lifecycle_jobs SET status='failed',error_code='lifecycle_recovered',completed_at=now() WHERE id=${initialJob}`;
            await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${initialJob}`;
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key) VALUES (${jobId},${computerId},${userId},'recover',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computerId})`;
            await tx`INSERT INTO ezil_computer_recovery_intents(job_id,computer_id,source_job_id,source_schema_version,source_digest,
                revision,target_generation,fence_token,data_volume_id,data_generation,data_fence_token,deployment)
                SELECT ${jobId},${computerId},${initialJob},1,digest,2,2,${randomUUID()},${volume},1,${fence},${JSON.stringify(deployment)}
                FROM ezil_computer_lifecycle_intents WHERE job_id=${initialJob}`;
        }
        if (running) await tx`UPDATE ezil_computer_lifecycle_jobs SET status='running',started_at=now() WHERE id=${jobId}`;
    });
    const [row] = operation === 'recover'
        ? await sql`SELECT digest,created_at,ezil_computer_recovery_document(i) document FROM ezil_computer_recovery_intents i WHERE job_id=${jobId}`
        : await sql`SELECT digest,created_at,ezil_lifecycle_intent_document(i) document FROM ezil_computer_lifecycle_intents i WHERE job_id=${jobId}`;
    const work = { digest: row!.digest as string, document: row!.document as string, createdAt: row!.created_at as Date };
    return { computerId, userId, jobId, fence, volume, instance, work, version: operation === 'recover' ? 2 : 1 };
}
type Source = Awaited<ReturnType<typeof source>>;
async function cancel(tx: TransactionSql, c: Source, options: {
    computer?: string; job?: string; digest?: string; version?: number; workflow?: string; outbox?: boolean;
    reason?: string; requester?: string | null;
} = {}) {
    const [row] = await tx`INSERT INTO ezil_computer_cancellations(computer_id,source_job_id,source_schema_version,source_digest,
        reason,requested_by,workflow_version_arn,source_state,digest,created_at)
        VALUES (${options.computer ?? c.computerId},${options.job ?? c.jobId},${options.version ?? c.version},${options.digest ?? c.work.digest},
            ${options.reason ?? 'stop_requested'},${options.requester === undefined ? c.userId : options.requester},${options.workflow ?? workflow},
            'queued','ignored-client-digest','2000-01-01') RETURNING id`;
    if (options.outbox !== false) await tx`INSERT INTO ezil_computer_cancellation_outbox(cancellation_id) VALUES (${row!.id})`;
    return row!.id as string;
}
async function settle(tx: TransactionSql, c: Source, id: string, code = 'lifecycle_recovered', omit?: 'job' | 'original' | 'delivery') {
    await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`;
    if (omit !== 'job') await tx`UPDATE ezil_computer_lifecycle_jobs SET status='cancelled',error_code=${code},completed_at=clock_timestamp() WHERE id=${c.jobId}`;
    if (omit !== 'original') await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=clock_timestamp(),lease_until=null WHERE job_id=${c.jobId}`;
    if (omit !== 'delivery') await tx`UPDATE ezil_computer_cancellation_outbox SET delivered_at=clock_timestamp(),lease_until=null,error_code=null WHERE cancellation_id=${id}`;
}
try {
    const before = await source('start', true);
    const migration = await readFile(new URL('../drizzle/0009_computer_cancellations.sql', import.meta.url), 'utf8');
    await sql.begin(async tx => { for (const s of migration.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await tx.unsafe(s); });
    await test('migration preserves existing active work, immutable bytes, generation and disk', async () => {
        const [i] = await sql`SELECT digest,ezil_lifecycle_intent_document(i) document FROM ezil_computer_lifecycle_intents i WHERE job_id=${before.jobId}`;
        assert.equal(i!.digest, before.work.digest); assert.equal(i!.document, before.work.document);
        assert.equal((await sql`SELECT status FROM ezil_computer_lifecycle_jobs WHERE id=${before.jobId}`)[0]!.status, 'running');
        assert.equal((await sql`SELECT data_volume_id FROM ezil_computer_runtimes WHERE computer_id=${before.computerId}`)[0]!.data_volume_id, before.volume);
    });
    await test('cancellation derives source state/digest/time and keeps original resources and admission', async () => {
        for (const op of ['provision', 'start', 'replace', 'recover'] as const) {
            const c = await source(op, true);
            const resources = await sql`SELECT to_jsonb(r) runtime,(SELECT jsonb_agg(i) FROM ezil_computer_instances i WHERE computer_id=${c.computerId}) writers FROM ezil_computer_runtimes r WHERE computer_id=${c.computerId}`;
            const id = await sql.begin(tx => cancel(tx, c));
            const [r] = await sql`SELECT digest,created_at,ezil_computer_cancellation_document(c) document FROM ezil_computer_cancellations c WHERE id=${id}`;
            const parsed = parseComputerCancellation({ document: r!.document, digest: r!.digest, createdAt: r!.created_at }, c.work);
            assert.equal(parsed.source.stateAtRequest, 'running'); assert.equal(parsed.source.schemaVersion, c.version);
            assert.ok(r!.created_at.getTime() > new Date('2026-01-01').getTime());
            assert.deepEqual(await sql`SELECT to_jsonb(r) runtime,(SELECT jsonb_agg(i) FROM ezil_computer_instances i WHERE computer_id=${c.computerId}) writers FROM ezil_computer_runtimes r WHERE computer_id=${c.computerId}`, resources);
            assert.equal((await sql`SELECT status FROM ezil_computer_lifecycle_jobs WHERE id=${c.jobId}`)[0]!.status, 'running');
        }
    });
    await test('incomplete delivery, cross-computer/source pins, mutable or foreign workflows are rejected', async () => {
        const c = await source(), other = await source();
        for (const o of [{ outbox: false }, { computer: other.computerId }, { job: other.jobId }, { digest: '0'.repeat(64) },
            { version: 2 }, { version: 3 }, { workflow: workflow.replace('123456789012','111111111111') },
            { workflow: workflow.replace(/:1$/,':LIVE') }, { workflow: deployment.stateMachineVersionArn.replace(/:1$/,':2') },
            { requester: null }, { reason: 'authority_revoked' }]) await reject(() => sql.begin(tx => cancel(tx, c, o)));
        assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_cancellations WHERE source_job_id=${c.jobId}`)[0]!.n, 0);
        await sql.begin(tx => cancel(tx, c, { reason: 'authority_revoked', requester: null }));
    });
    await test('terminal jobs and stop/retire operations do not grant cancellation authority', async () => {
        for (const status of ['succeeded','failed','cancelled']) {
            const c = await source(); await sql`UPDATE ezil_computer_lifecycle_jobs SET status=${status} WHERE id=${c.jobId}`;
            await reject(() => sql.begin(tx => cancel(tx, c)));
        }
        for (const op of ['stop','retire'] as const) {
            const c = await source(op); await reject(() => sql.begin(tx => cancel(tx, c)));
        }
    });
    await test('concurrent cancellation requests create exactly one immutable intent and delivery', async () => {
        const c = await source();
        const r = await Promise.allSettled([sql.begin(tx => cancel(tx, c)), sql.begin(tx => cancel(tx, c))]);
        assert.equal(r.filter(x => x.status === 'fulfilled').length, 1);
        assert.equal((r.find(x => x.status === 'rejected') as PromiseRejectedResult).reason.code, '23505');
    });
    await test('queued work cannot start, succeed, fail or release admission after cancellation', async () => {
        const c = await source(); await sql.begin(tx => cancel(tx, c));
        for (const status of ['running','succeeded','failed','cancelled']) await reject(() => sql`UPDATE ezil_computer_lifecycle_jobs SET status=${status} WHERE id=${c.jobId}`);
        await reject(() => sql`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${c.jobId}`);
        assert.equal((await sql`SELECT status FROM ezil_computer_lifecycle_jobs WHERE id=${c.jobId}`)[0]!.status, 'queued');
    });
    await test('cancellation racing a claim captures the locked state and cannot lose the reservation', async () => {
        for (const first of ['cancellation','claim']) {
            const c = await source();
            let entered!: () => void, release!: () => void;
            const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
            const leading = sql.begin(async tx => {
                await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`;
                if (first === 'cancellation') await cancel(tx, c);
                else await tx`UPDATE ezil_computer_lifecycle_jobs SET status='running',started_at=now() WHERE id=${c.jobId}`;
                entered(); await gate;
            });
            await ready;
            const following = sql.begin(async tx => {
                await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`;
                if (first === 'claim') await cancel(tx, c);
                else await tx`UPDATE ezil_computer_lifecycle_jobs SET status='running',started_at=now() WHERE id=${c.jobId}`;
            });
            const results = Promise.allSettled([leading, following]); release();
            const done = await results;
            assert.equal(done[0]!.status, 'fulfilled');
            assert.equal(done[1]!.status, first === 'claim' ? 'fulfilled' : 'rejected');
            const [row] = await sql`SELECT c.source_state,j.status FROM ezil_computer_cancellations c
                JOIN ezil_computer_lifecycle_jobs j ON j.id=c.source_job_id WHERE c.source_job_id=${c.jobId}`;
            assert.equal(row!.source_state, first === 'claim' ? 'running' : 'queued');
            assert.equal(row!.status, row!.source_state);
        }
    });
    await test('cancellation and healthy success serialize without killing finalized work', async () => {
        for (const first of ['success','cancellation']) {
            const c = await source('provision', true);
            let entered!: () => void, release!: () => void;
            const ready = new Promise<void>(r => { entered = r; }), gate = new Promise<void>(r => { release = r; });
            const success = async (tx: TransactionSql) => {
                await tx`UPDATE ezil_computer_lifecycle_jobs SET status='succeeded',completed_at=now() WHERE id=${c.jobId}`;
                await tx`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=now() WHERE job_id=${c.jobId}`;
            };
            const leading = sql.begin(async tx => {
                await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`;
                if (first === 'success') await success(tx); else await cancel(tx, c);
                entered(); await gate;
            });
            await ready;
            const following = sql.begin(async tx => {
                await tx`SELECT id FROM ezil_computers WHERE id=${c.computerId} FOR UPDATE`;
                if (first === 'success') await cancel(tx, c); else await success(tx);
            });
            const results = Promise.allSettled([leading, following]); release();
            const done = await results;
            assert.equal(done[0]!.status, 'fulfilled'); assert.equal(done[1]!.status, 'rejected');
            assert.equal((await sql`SELECT status FROM ezil_computer_lifecycle_jobs WHERE id=${c.jobId}`)[0]!.status,
                first === 'success' ? 'succeeded' : 'running');
        }
    });
    await test('settlement requires cancelled source and both acknowledgments in the same transaction', async () => {
        const c = await source('start', true), id = await sql.begin(tx => cancel(tx, c));
        await sql`UPDATE ezil_computer_instances SET fenced_at=now(),observed_state='stopped' WHERE computer_id=${c.computerId}`;
        for (const omit of ['job','original','delivery'] as const) await reject(() => sql.begin(tx => settle(tx, c, id, 'lifecycle_recovered', omit)));
        await sql.begin(tx => settle(tx, c, id));
        assert.equal((await sql`SELECT status,error_code FROM ezil_computer_lifecycle_jobs WHERE id=${c.jobId}`)[0]!.error_code, 'lifecycle_recovered');
        assert.equal((await sql`SELECT data_volume_id FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.data_volume_id, c.volume);
    });
    await test('running, unfenced and unobserved writers cannot settle as recovered', async () => {
        const c = await source('start', true), id = await sql.begin(tx => cancel(tx, c));
        await reject(() => sql.begin(tx => settle(tx, c, id)));
        await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
        await reject(() => sql.begin(tx => settle(tx, c, id)));
        await sql`UPDATE ezil_computer_instances SET observed_state='stopped',observed_at=null WHERE computer_id=${c.computerId}`;
        await reject(() => sql.begin(tx => settle(tx, c, id)));
    });
    await test('settlement retains a source disk and historical writer instead of deleting evidence', async () => {
        for (const op of ['start','replace','recover'] as const) {
            const c = await source(op, true), id = await sql.begin(tx => cancel(tx, c));
            await sql`UPDATE ezil_computer_instances SET fenced_at=now(),observed_state='stopped' WHERE computer_id=${c.computerId}`;
            await reject(() => sql.begin(async tx => {
                await tx`UPDATE ezil_computer_runtimes SET data_volume_id=${handle('vol')} WHERE computer_id=${c.computerId}`;
                await settle(tx, c, id);
            }));
            if (op !== 'recover') await reject(() => sql.begin(async tx => {
                await tx`UPDATE ezil_computer_instances SET provider_instance_id=${handle('i')} WHERE computer_id=${c.computerId}`;
                await settle(tx, c, id);
            }));
            await sql.begin(tx => settle(tx, c, id));
        }
    });
    await test('settled cancellation allows a new retained-disk recovery and harmless acknowledgment replay', async () => {
        const c = await source('start', true), id = await sql.begin(tx => cancel(tx, c)), recovery = randomUUID();
        await sql.begin(async tx => {
            await tx`UPDATE ezil_computer_instances SET fenced_at=now(),observed_state='stopped' WHERE computer_id=${c.computerId}`;
            await settle(tx, c, id);
        });
        await sql.begin(async tx => {
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,operation,idempotency_key) VALUES (${recovery},${c.computerId},'recover',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${recovery},${c.computerId})`;
            await tx`INSERT INTO ezil_computer_recovery_intents(job_id,computer_id,source_job_id,source_schema_version,source_digest,
                revision,target_generation,fence_token,data_volume_id,data_generation,data_fence_token,deployment)
                VALUES (${recovery},${c.computerId},${c.jobId},1,${c.work.digest},2,2,${randomUUID()},${c.volume},1,${c.fence},${JSON.stringify(deployment)})`;
        });
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state)
            VALUES (${c.computerId},2,${handle('i')},${randomUUID()},'running')`;
        await sql`UPDATE ezil_computer_cancellation_outbox SET delivered_at=delivered_at WHERE cancellation_id=${id}`;
        await sql`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=delivered_at WHERE job_id=${c.jobId}`;
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status=status WHERE id=${c.jobId}`;
        assert.equal((await sql`SELECT data_volume_id,next_generation FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.data_volume_id, c.volume);
    });
    await test('only an unclaimed resource-free queued provision can settle without provider observation', async () => {
        const c = await source(), id = await sql.begin(tx => cancel(tx, c));
        await sql.begin(tx => settle(tx, c, id, 'lifecycle_cancelled'));
        for (const [op, running] of [['provision',true],['start',false],['replace',false],['recover',false]] as const) {
            const s = await source(op, running), cancellation = await sql.begin(tx => cancel(tx, s));
            await reject(() => sql.begin(tx => settle(tx, s, cancellation, 'lifecycle_cancelled')));
        }
        const s = await source(), cancellation = await sql.begin(tx => cancel(tx, s));
        await sql`UPDATE ezil_computer_runtimes SET data_volume_id=${s.volume},availability_zone='us-east-1a' WHERE computer_id=${s.computerId}`;
        await reject(() => sql.begin(tx => settle(tx, s, cancellation, 'lifecycle_cancelled')));
    });
    await test('cancellation documents and deliveries cannot be rewritten, removed or reopened', async () => {
        const c = await source(), id = await sql.begin(tx => cancel(tx, c));
        await reject(() => sql`UPDATE ezil_computer_cancellations SET source_state='running' WHERE id=${id}`);
        await reject(() => sql`DELETE FROM ezil_computer_cancellations WHERE id=${id}`);
        await reject(() => sql`TRUNCATE ezil_computer_cancellations CASCADE`);
        await reject(() => sql`DELETE FROM ezil_computer_cancellation_outbox WHERE cancellation_id=${id}`);
        await reject(() => sql`TRUNCATE ezil_computer_cancellation_outbox`);
        await reject(() => sql`UPDATE ezil_computer_cancellation_outbox SET created_at=now() WHERE cancellation_id=${id}`);
        await sql`UPDATE ezil_computer_cancellation_outbox SET attempts=1,lease_until=now()+interval '1 minute' WHERE cancellation_id=${id}`;
        await reject(() => sql`UPDATE ezil_computer_cancellation_outbox SET attempts=0 WHERE cancellation_id=${id}`);
        await reject(() => sql`UPDATE ezil_computer_cancellation_outbox SET error_code='sensitive input' WHERE cancellation_id=${id}`);
        await sql.begin(tx => settle(tx, c, id, 'lifecycle_cancelled'));
        await reject(() => sql`UPDATE ezil_computer_cancellation_outbox SET delivered_at=null WHERE cancellation_id=${id}`);
        await reject(() => sql`UPDATE ezil_computer_lifecycle_outbox SET delivered_at=null WHERE job_id=${c.jobId}`);
        await reject(() => sql`UPDATE ezil_computer_lifecycle_jobs SET error_code='lifecycle_recovered' WHERE id=${c.jobId}`);
    });
    await test('service-only RLS denies cross-user reads and writes with explicit table grants', async () => {
        const c = await source(), id = await sql.begin(tx => cancel(tx, c));
        await sql`GRANT ALL ON ezil_computer_cancellations,ezil_computer_cancellation_outbox TO authenticated,service_role`;
        await sql.begin(async tx => {
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',${c.userId},true)`;
            for (const table of ['ezil_computer_cancellations','ezil_computer_cancellation_outbox']) {
                assert.equal((await tx.unsafe(`SELECT count(*)::int n FROM ${table}`))[0]!.n, 0);
                assert.equal((await tx.unsafe(`DELETE FROM ${table}`)).count, 0);
            }
        });
        await reject(() => sql.begin(async tx => {
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true)`;
            await tx`INSERT INTO ezil_computer_cancellation_outbox(cancellation_id) VALUES (${randomUUID()})`;
        }), '42501');
        await sql.begin(async tx => {
            await tx`SET LOCAL ROLE service_role`;
            await tx`SELECT set_config('request.jwt.claim.role','service_role',true)`;
            assert.equal((await tx`SELECT id FROM ezil_computer_cancellations WHERE id=${id}`).length, 1);
        });
    });
    console.log(`${passed} computer cancellation database checks passed; 0 failed`);
} finally { await fixture.close(); }
