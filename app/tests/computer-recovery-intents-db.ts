import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { TransactionSql } from 'postgres';
import { runtimeTestDatabase } from './helpers/runtime-database';
import { lifecycleDeployment as deployment } from './fixtures/lifecycle';
import { parseComputerRecoveryWork } from '../src/server/app-platform/computer-recovery-protocol';

const fixture = await runtimeTestDatabase({ throughMigration: '0007_computer_lifecycle_intents' }), { sql } = fixture;
let passed = 0;
const test = async (name: string, run: () => Promise<void>) => { await run(); passed++; console.log(`PASS ${name}`); };
const reject = (work: () => Promise<unknown>, code = '23514') => assert.rejects(work, (e: { code?: string }) => e.code === code);
const handle = (prefix: string) => prefix + '-' + randomUUID().replaceAll('-', '').slice(0, 17);
async function source(allocated = false, status: 'failed' | 'cancelled' = 'failed') {
    const computerId = randomUUID(), userId = randomUUID(), fence = randomUUID(), volume = handle('vol'), instance = handle('i'), jobId = randomUUID();
    await sql`INSERT INTO auth.users(id) VALUES (${userId})`;
    await sql`INSERT INTO ezil_computers(id,user_id,slot,provider) VALUES (${computerId},${userId},1,'aws-ec2')`;
    await sql`INSERT INTO ezil_computer_runtimes(computer_id,region) VALUES (${computerId},'us-east-1')`;
    await sql.begin(async tx => {
        await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key) VALUES (${jobId},${computerId},${userId},'provision',${randomUUID()})`;
        await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${computerId})`;
        await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,deployment)
            VALUES (${jobId},${computerId},1,'provision',1,${fence},${JSON.stringify(deployment)})`;
    });
    // Simulate the independently observed cleanup transaction in a disposable
    // database. These writes do not assert that any AWS operation occurred.
    await sql`UPDATE ezil_computer_runtimes SET data_volume_id=${volume},availability_zone='us-east-1a' WHERE computer_id=${computerId}`;
    if (allocated) await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state,fenced_at,observed_at)
        VALUES (${computerId},1,${instance},${fence},'stopped',now(),now())`;
    await sql`UPDATE ezil_computer_lifecycle_jobs SET status=${status},error_code='lifecycle_recovered',completed_at=now() WHERE id=${jobId}`;
    const [row] = await sql`SELECT digest,created_at,ezil_lifecycle_intent_document(i) document FROM ezil_computer_lifecycle_intents i WHERE job_id=${jobId}`;
    return { computerId, userId, fence, volume, instance, jobId, digest: row!.digest as string, document: row!.document as string };
}
type Source = Awaited<ReturnType<typeof source>>;
async function recover(tx: TransactionSql, c: Source, options: {
    sourceJob?: string; sourceVersion?: number; sourceDigest?: string; revision?: number; generation?: number;
    dataGeneration?: number; dataFence?: string; fence?: string; volume?: string; deployment?: unknown; event?: boolean;
} = {}) {
    const jobId = randomUUID();
    await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,requested_by,operation,idempotency_key) VALUES (${jobId},${c.computerId},${c.userId},'recover',${randomUUID()})`;
    if (options.event !== false) await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${jobId},${c.computerId})`;
    const [row] = await tx`INSERT INTO ezil_computer_recovery_intents(job_id,computer_id,source_job_id,source_schema_version,source_digest,
        revision,target_generation,fence_token,data_volume_id,data_generation,data_fence_token,deployment,digest)
        VALUES (${jobId},${c.computerId},${options.sourceJob ?? c.jobId},${options.sourceVersion ?? 1},${options.sourceDigest ?? c.digest},
            ${options.revision ?? 2},${options.generation ?? 2},${options.fence ?? randomUUID()},${options.volume ?? c.volume},
            ${options.dataGeneration ?? 1},${options.dataFence ?? c.fence},${JSON.stringify(options.deployment ?? deployment)},'untrusted-digest') RETURNING *`;
    return row!;
}
try {
    const before = await source(true);
    const migration = await readFile(new URL('../drizzle/0008_computer_recovery_intents.sql', import.meta.url), 'utf8');
    await sql.begin(async tx => { for (const statement of migration.split('--> statement-breakpoint').map(s => s.trim()).filter(Boolean)) await tx.unsafe(statement); });
    await test('migration preserves populated v1 documents, hashes, writer and disk associations', async () => {
        const [row] = await sql`SELECT digest,ezil_lifecycle_intent_document(i) document FROM ezil_computer_lifecycle_intents i WHERE job_id=${before.jobId}`;
        assert.equal(row!.document, before.document); assert.equal(row!.digest, before.digest);
        assert.equal((await sql`SELECT data_volume_id FROM ezil_computer_runtimes WHERE computer_id=${before.computerId}`)[0]!.data_volume_id, before.volume);
    });
    await test('retained-disk recovery reserves a new generation without replacing the disk or creating a writer', async () => {
        for (const allocated of [false, true]) {
            const c = await source(allocated), row = await sql.begin(tx => recover(tx, c));
            const [stored] = await sql`SELECT digest,created_at,ezil_computer_recovery_document(i) document FROM ezil_computer_recovery_intents i WHERE job_id=${row.job_id}`;
            assert.equal(stored!.digest, createHash('sha256').update(stored!.document).digest('hex'));
            const parsed = parseComputerRecoveryWork({ document: stored!.document, digest: stored!.digest, createdAt: stored!.created_at });
            assert.equal(parsed.schemaVersion, 2); assert.equal(parsed.operation, 'recover'); assert.equal(parsed.source.digest, c.digest);
            assert.equal(parsed.dataVolumeId, c.volume); assert.equal(parsed.dataScope.generation, 1); assert.equal(parsed.targetGeneration, 2);
            const [runtime] = await sql`SELECT data_volume_id,next_generation FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`;
            assert.equal(runtime!.data_volume_id, c.volume); assert.equal(runtime!.next_generation, 3);
            assert.equal((await sql`SELECT count(*)::int n FROM ezil_computer_instances WHERE computer_id=${c.computerId}`)[0]!.n, allocated ? 1 : 0);
        }
    });
    await test('unfenced or unobserved writers block recovery', async () => {
        for (const kind of ['unfenced', 'running']) {
            const c = await source(true);
            if (kind === 'unfenced') await sql`UPDATE ezil_computer_instances SET fenced_at=null WHERE computer_id=${c.computerId}`;
            else await sql`UPDATE ezil_computer_instances SET observed_state='running' WHERE computer_id=${c.computerId}`;
            await reject(() => sql.begin(tx => recover(tx, c)));
            assert.equal((await sql`SELECT next_generation FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.next_generation, 2);
        }
    });
    await test('a cancelled job is eligible only after positive cleanup was recorded', async () => {
        const c = await source(true, 'cancelled');
        await sql`UPDATE ezil_computer_lifecycle_jobs SET error_code=null WHERE id=${c.jobId}`;
        await reject(() => sql.begin(tx => recover(tx, c)));
        await sql`UPDATE ezil_computer_lifecycle_jobs SET error_code='lifecycle_recovered' WHERE id=${c.jobId}`;
        const row = await sql.begin(tx => recover(tx, c)); assert.equal(row.source_job_id, c.jobId);
    });
    await test('another computer source, mismatched digest, disk, tags or reused generation cannot authorize recovery', async () => {
        const a = await source(), b = await source();
        for (const changed of [{ sourceJob: b.jobId, sourceDigest: b.digest }, { sourceDigest: '0'.repeat(64) },
            { volume: b.volume }, { dataFence: b.fence }, { dataGeneration: 2 }, { generation: 1 }, { fence: a.fence }, { sourceVersion: 3 }]) {
            await reject(() => sql.begin(tx => recover(tx, a, changed)));
        }
    });
    await test('failed but unreconciled source jobs and incomplete outboxes cannot consume a generation', async () => {
        const c = await source(); await sql`UPDATE ezil_computer_lifecycle_jobs SET error_code='unconfirmed' WHERE id=${c.jobId}`;
        await reject(() => sql.begin(tx => recover(tx, c)));
        await sql`UPDATE ezil_computer_lifecycle_jobs SET error_code='lifecycle_recovered' WHERE id=${c.jobId}`;
        await reject(() => sql.begin(tx => recover(tx, c, { event: false })), '23503');
        assert.equal((await sql`SELECT next_generation FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.next_generation, 2);
    });
    await test('deployment pins reject credentials, mutable versions and storage-account/AZ/key changes', async () => {
        const c = await source();
        for (const changed of [{ ...deployment, secret: 'not-a-secret-value' }, { ...deployment, launchTemplateVersion: '$Latest' },
            { ...deployment, availabilityZone: 'us-east-1b' }, { ...deployment, namespace: 'different' },
            { ...deployment, dataKeyArn: deployment.dataKeyArn.replace(/1/g, '2') }]) await reject(() => sql.begin(tx => recover(tx, c, { deployment: changed })));
    });
    await test('concurrent recovery requests consume only one new generation', async () => {
        const c = await source();
        const results = await Promise.allSettled([sql.begin(tx => recover(tx, c)), sql.begin(tx => recover(tx, c))]);
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        assert.equal((await sql`SELECT next_generation FROM ezil_computer_runtimes WHERE computer_id=${c.computerId}`)[0]!.next_generation, 3);
    });
    await test('an active v2 intent prevents v1 work and consumes the shared revision sequence', async () => {
        const c = await source(), row = await sql.begin(tx => recover(tx, c));
        const newInstance = handle('i');
        await sql`INSERT INTO ezil_computer_instances(computer_id,generation,provider_instance_id,fence_token,observed_state)
            VALUES (${c.computerId},2,${newInstance},${row.fence_token},'running')`;
        // This start is otherwise valid: exact existing writer, disk and next
        // shared revision. The active v2 job alone must deny a competing start.
        await reject(() => sql.begin(async tx => {
            const id = randomUUID();
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,operation,idempotency_key) VALUES (${id},${c.computerId},'start',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${id},${c.computerId})`;
            await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,provider_instance_id,data_volume_id,deployment)
                VALUES (${id},${c.computerId},3,'start',2,${row.fence_token},${newInstance},${c.volume},${JSON.stringify(deployment)})`;
        }));
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status='failed',error_code='lifecycle_recovered' WHERE id=${row.job_id}`;
        await sql`UPDATE ezil_computer_instances SET fenced_at=now(),observed_state='stopped',observed_at=now() WHERE computer_id=${c.computerId}`;
        await reject(() => sql.begin(tx => recover(tx, c, { revision: 3, generation: 3 })));
        const next = await sql.begin(tx => recover(tx, c, { sourceJob: row.job_id, sourceVersion: 2, sourceDigest: row.digest, revision: 3, generation: 3 }));
        assert.equal(next.target_generation, 3); assert.equal(next.data_generation, 1);
    });
    await test('active v1 work prevents a recovery intent even after its writer is fenced', async () => {
        const c = await source(true), active = randomUUID();
        await sql`UPDATE ezil_computer_instances SET fenced_at=null WHERE computer_id=${c.computerId}`;
        await sql.begin(async tx => {
            await tx`INSERT INTO ezil_computer_lifecycle_jobs(id,computer_id,operation,idempotency_key) VALUES (${active},${c.computerId},'start',${randomUUID()})`;
            await tx`INSERT INTO ezil_computer_lifecycle_outbox(job_id,computer_id) VALUES (${active},${c.computerId})`;
            await tx`INSERT INTO ezil_computer_lifecycle_intents(job_id,computer_id,revision,operation,target_generation,fence_token,provider_instance_id,data_volume_id,deployment)
                VALUES (${active},${c.computerId},2,'start',1,${c.fence},${c.instance},${c.volume},${JSON.stringify(deployment)})`;
        });
        await sql`UPDATE ezil_computer_instances SET fenced_at=now() WHERE computer_id=${c.computerId}`;
        await assert.rejects(sql.begin(tx => recover(tx, c, { revision: 3 })), /recovery work still active/);
    });
    await test('v2 documents, source bindings, jobs and outboxes cannot be rewritten or removed', async () => {
        const c = await source(), row = await sql.begin(tx => recover(tx, c));
        await reject(() => sql`UPDATE ezil_computer_recovery_intents SET source_digest=${'0'.repeat(64)} WHERE job_id=${row.job_id}`);
        await reject(() => sql`DELETE FROM ezil_computer_recovery_intents WHERE job_id=${row.job_id}`);
        await reject(() => sql`TRUNCATE ezil_computer_recovery_intents`);
        await reject(() => sql`UPDATE ezil_computer_lifecycle_jobs SET target_generation=99 WHERE id=${row.job_id}`);
        await reject(() => sql`DELETE FROM ezil_computer_lifecycle_outbox WHERE job_id=${row.job_id}`, '23503');
        await sql`UPDATE ezil_computer_lifecycle_jobs SET status='running' WHERE id=${row.job_id}`;
        await reject(() => sql`UPDATE ezil_computer_lifecycle_jobs SET status='queued' WHERE id=${row.job_id}`);
    });
    await test('service-only RLS denies direct authenticated reads even with table grants', async () => {
        const c = await source(); await sql.begin(tx => recover(tx, c));
        await sql.begin(async tx => {
            await tx`GRANT ALL ON ezil_computer_recovery_intents TO authenticated`;
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',${c.userId},true)`;
            assert.equal((await tx`SELECT count(*)::int n FROM ezil_computer_recovery_intents`)[0]!.n, 0);
        });
        await assert.rejects(sql.begin(async tx => {
            await tx`SET LOCAL ROLE authenticated`;
            await tx`SELECT set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claim.sub',${c.userId},true)`;
            await recover(tx, c);
        }), (error: { code?: string }) => error.code === '42501');
    });
    console.log(`${passed} retained computer recovery database checks passed; 0 failed`);
} finally { await fixture.close(); }
