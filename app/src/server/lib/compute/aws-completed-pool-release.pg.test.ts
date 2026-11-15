/** Disposable PostgreSQL only: production codecs, real advisory/row locks and allocation CAS. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { releasedPoolSetup } from './aws-rebase.test-support';
import { reconcileFailedRelease, type ReconcileReleaseDeps } from './aws-pool-release-recovery';
import { type PlacementDb, type PlacementExecutor } from './placement';
import { POOL_RELEASED } from './aws-receipts';

const PG = process.env.EZIL_PG_TEST_URL, schema = 'completed_release_' + randomUUID().replaceAll('-', '');
describe.skipIf(!PG)('completed pool release bookkeeping on production PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 8, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (s: string) => s.replaceAll('public.', schema + '.');
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(c => c instanceof StringChunk ? sql.raw(local(c.value.join('')))
        : c instanceof SQL ? scoped(c) : c), sql.empty());
    const executor = (x: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => x.execute(scoped(q)) });
    const db: PlacementDb = { execute: q => executor(production!).execute(q), transaction: fn => production!.transaction(tx => fn(executor(tx))) };
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$; CREATE SCHEMA ${schema}`);
        created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_ready_pool.sql.txt', '0003_pool_hosts_v2.sql.txt', '0002_image_rebase.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0008_pool_dispatch.sql'), 'utf8')));
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers (id uuid PRIMARY KEY, user_id uuid, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
            CREATE TABLE ${schema}.ezil_compute_migrations (computer_id uuid, state text, workspace_head jsonb)`);
    });
    beforeEach(async () => { await client!.unsafe(`TRUNCATE ${schema}.ezil_computers, ${schema}.ezil_computer_placements,
        ${schema}.ezil_compute_pool_hosts, ${schema}.ezil_computer_image_jobs, ${schema}.ezil_compute_usage, ${schema}.ezil_compute_migrations`); });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });
    async function setup() {
        const s = releasedPoolSetup(), src = s.source;
        const d = { ...s.provisioned, namespace: 'mum', stateMachineVersionArn: s.provisioned.stateMachineVersionArn.replace('ezil-pilot-', 'ezil-mum-'),
            preparationStateMachineVersionArn: s.provisioned.preparationStateMachineVersionArn!.replace('ezil-pilot-', 'ezil-mum-'),
            recoveryStateMachineVersionArn: s.provisioned.recoveryStateMachineVersionArn!.replace('ezil-pilot-', 'ezil-mum-') };
        s.setProvision(d); const arn = s.setRelease({ deployment: d }), owner = s.fake.placements[0]!.owner_user_id;
        await client!.unsafe(`INSERT INTO ${schema}.ezil_computers (id,user_id) VALUES ($1,$2)`, [src.computerId, owner as string]);
        await client!.unsafe(`INSERT INTO ${schema}.ezil_computer_placements
            (computer_id,owner_user_id,provider,workspace_store,generation,lease_epoch,state,region,zone_id,instance_id,instance_type,
             volume_id,fs_uuid,fence_token,last_error,lower_image_digest,lower_digest_observed_at,updated_at)
            VALUES ($1,$2,'aws-ec2','ebs',$3,$4,'STOPPED',$5,$6,$7,'m6i.large',$8,$9,$10,$11,$12,now(),now())`,
        [src.computerId, owner, src.sourceGeneration, src.sourceLeaseEpoch, d.region, d.zoneId, src.sourceInstanceId, src.sourceVolumeId,
            src.fsUuid, src.sourceFenceToken, POOL_RELEASED, src.fromDigest] as never[]);
        await client!.unsafe(`INSERT INTO ${schema}.ezil_compute_pool_hosts
            (id,region,zone_id,instance_type,instance_id,state,health,generation,leased_generation,leased_computer_id,lease_token,leased_at,
             claim_generation,claim_lease_epoch,claim_fence,claim_volume_serial,lifecycle_job_id,lifecycle_digest,lifecycle_input,dispatch_status,updated_at)
            VALUES ($1,$2,$3,'m6i.large',$4,'leased','unknown',1,1,$5,gen_random_uuid(),now(),$6,$7,$8,$9,$10,$11,$12,'settled','2026-10-22 10:01:00.123456+00')`,
        [s.row.id, d.region, d.zoneId, src.sourceInstanceId, src.computerId, src.sourceGeneration, src.sourceLeaseEpoch, src.sourceFenceToken,
            src.sourceVolumeId.replace('-', ''), s.row.lifecycle_job_id, s.row.lifecycle_digest, s.row.lifecycle_input] as never[]);
        Object.assign(s.provider.volume, { zoneId: d.zoneId, volumeType: 'gp3' });
        Object.assign(s.provider.volume.tags, { 'ezil:stage': d.namespace, 'ezil:backup': d.namespace });
        const deps: ReconcileReleaseDeps = { db, starter: s.deps.starter, executions: s.deps.executions, describer: s.deps.describer, now: s.deps.now };
        const run = () => reconcileFailedRelease(deps, { [d.region]: d }, { schemaVersion: 1, operation: 'reconcile-release',
            computerId: src.computerId, expectedJobId: s.release().intent.jobId, releaseExecutionArn: arn });
        const state = async () => ({ placement: (await client!.unsafe(`SELECT row_to_json(p) AS p FROM ${schema}.ezil_computer_placements p`))[0]!.p,
            pool: (await client!.unsafe(`SELECT row_to_json(p) AS p FROM ${schema}.ezil_compute_pool_hosts p`))[0]!.p as Record<string, unknown> });
        return { ...s, run, state, deps };
    }
    it('concurrent repairs burn one claim only, preserving every other column and the full placement', async () => {
        const s = await setup(), before = await s.state(), results = await Promise.all([s.run(), s.run()]);
        expect(results.some(r => r.outcome === 'settled')).toBe(true);
        const after = await s.state(); expect(after.placement).toEqual(before.placement);
        expect(after.pool).toEqual({ ...before.pool, state: 'retired', updated_at: after.pool.updated_at });
        expect(after.pool.updated_at).not.toBe(before.pool.updated_at);
        expect(await s.run()).toEqual({ outcome: 'settled', error: null }); expect(await s.state()).toEqual(after);
        expect(s.started).toHaveLength(0);
    });
    it.each([
        ['claim_generation', '99'], ['claim_lease_epoch', '99'], ['claim_fence', "'99999999-9999-4999-8999-999999999999'"],
        ['claim_volume_serial', "'vol99999999999999999'"], ['leased_generation', '99'], ['lease_token', 'NULL'],
        ['instance_id', "'i-99999999999999999'"], ['dispatch_status', "'started'"], ['lifecycle_input', 'NULL'],
    ])('the actual selector refuses %s=%s', async (key, value) => {
        const s = await setup(); await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET ${key}=${value}`);
        const before = await s.state(); expect((await s.run()).outcome).toBe('not_applicable'); expect(await s.state()).toEqual(before);
    });
    it.each([
        `UPDATE ${schema}.ezil_compute_pool_hosts SET lease_token=gen_random_uuid()`,
        `UPDATE ${schema}.ezil_compute_pool_hosts SET updated_at=updated_at+interval '1 microsecond'`,
        `UPDATE ${schema}.ezil_computer_placements SET lease_epoch=lease_epoch+1`,
    ])('a committed concurrent claim or placement change is not overwritten: %s', async statement => {
        const s = await setup(), describe = vi.mocked(s.deps.describer!.describeVolume!).getMockImplementation()!;
        vi.mocked(s.deps.describer!.describeVolume!).mockImplementation(async (...args) => { const volume = await describe(...args); await client!.unsafe(statement); return volume; });
        expect(await s.run()).toEqual({ outcome: 'unconfirmed', error: 'allocation_changed' });
        expect((await s.state()).pool.state).toBe('leased'); expect(s.started).toHaveLength(0);
    });
});
