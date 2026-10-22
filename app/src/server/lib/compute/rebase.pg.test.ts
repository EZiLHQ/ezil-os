/** Disposable PostgreSQL only; never resolves the app connection or credentials. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createImageJobStore, newReservedImageJob } from './aws-rebase-store';
import { fixtureRebasePreparation, fixtureRebaseRelease } from './aws-intent.test-support';
import { assertNoImageReservation, type PlacementDb, type PlacementExecutor } from './placement';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `rebase_test_${randomUUID().replaceAll('-', '')}`;
const repository = '123456789012.dkr.ecr.ap-south-1.amazonaws.com/desktop';
const prep = fixtureRebasePreparation();
const job = () => newReservedImageJob({ preparation: prep, ownerUserId: '33333333-3333-4333-8333-333333333333',
    sourceRelease: fixtureRebaseRelease(prep.intent.sourceDeployment), targetRelease: fixtureRebaseRelease(prep.intent.deployment) });

describe.skipIf(!PG)('image reservation on disposable PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 12, onnotice: () => {} }) : null;
    const dialect = new PgDialect();
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const executor = (c: { unsafe: (q: string, params: never[]) => PromiseLike<unknown> }): PlacementExecutor => ({ execute: async q => {
        const r = dialect.sqlToQuery(q); return c.unsafe(local(r.sql), r.params as never[]);
    } });
    const db: PlacementDb = { execute: q => executor(client!).execute(q), transaction: async fn =>
        client!.begin(tx => fn(executor(tx))) as Promise<Awaited<ReturnType<typeof fn>>> };
    const store = createImageJobStore(db);
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_ready_pool.sql.txt', '0002_image_rebase.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers (id uuid, user_id uuid, deleted_at timestamptz)`);
        // Local migration double used only for the active-migration exclusion query.
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_compute_migrations (id uuid, computer_id uuid, state text)`);
    });
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_computer_image_jobs, ${schema}.ezil_computer_placements, ${schema}.ezil_compute_migrations, ${schema}.ezil_computers`);
        const j = job();
        await client!.unsafe(`INSERT INTO ${schema}.ezil_computers VALUES ($1,$2,NULL)`, [j.computerId, j.ownerUserId]);
        await client!.unsafe(`INSERT INTO ${schema}.ezil_computer_placements
            (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id,
             instance_id, instance_type, volume_id, fs_uuid, fence_token, lower_image_digest, lower_digest_observed_at, updated_at)
            VALUES ($1,$2,'aws-ec2','ebs',$3,$4,'STOPPED',$5,$6,$7,'m6i.large',$8,$9,$10,$11,$12,$12)`,
        [j.computerId, j.ownerUserId, j.sourceGeneration, j.sourceLeaseEpoch, j.region, j.zoneId, j.sourceInstanceId,
            j.sourceVolumeId, j.fsUuid, j.sourceFenceToken, j.fromDigest, j.createdAt]);
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });
    it('concurrent identical reservations yield one row and one placement reservation', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => store.reserve(job(), repository)));
        expect(new Set(results.map(j => j.jobId)).size).toBe(1);
        expect(await client!.unsafe(`SELECT job_id FROM ${schema}.ezil_computer_image_jobs`)).toHaveLength(1);
        await expect(assertNoImageReservation(db, job().computerId)).rejects.toThrow('image_job_conflict');
    });
    it('only one phase CAS consumes the old timestamp', async () => {
        const j = await store.reserve(job(), repository);
        const next = { ...j, phase: 'fencing' as const, updatedAt: '2026-10-22T11:00:01.000Z' };
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.transition(j, next)));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(7);
    });
    it('duplicate job rows fail closed and do not release the placement', async () => {
        const j = await store.reserve(job(), repository);
        await client!.unsafe(`INSERT INTO ${schema}.ezil_computer_image_jobs SELECT * FROM ${schema}.ezil_computer_image_jobs`);
        await expect(store.read(j.jobId)).rejects.toThrow('image_job_conflict');
        await expect(assertNoImageReservation(db, j.computerId)).rejects.toThrow('image_job_conflict');
    });
    it('orphan reservation fails closed', async () => {
        await store.reserve(job(), repository);
        await client!.unsafe(`DELETE FROM ${schema}.ezil_computer_image_jobs`);
        await expect(store.reserve(job(), repository)).rejects.toThrow('image_job_conflict');
        await expect(assertNoImageReservation(db, job().computerId)).rejects.toThrow('image_job_conflict');
    });
    it('owner changes and active migration cannot reserve', async () => {
        await expect(store.reserve({ ...job(), ownerUserId: job().computerId }, repository)).rejects.toThrow('image_job_conflict');
        await client!.unsafe(`INSERT INTO ${schema}.ezil_compute_migrations VALUES ($1,$2,'requested')`, [randomUUID(), job().computerId]);
        await expect(store.reserve(job(), repository)).rejects.toThrow('image_job_conflict');
    });
    it('actual test writer can write, while anon/authenticated have no table privilege and RLS is enabled', async () => {
        await store.reserve(job(), repository);
        const r = await client!.unsafe(`SELECT relrowsecurity AS rls,
            has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon,
            has_table_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated
            FROM pg_class WHERE oid = '${schema}.ezil_computer_image_jobs'::regclass`);
        expect(r[0]).toMatchObject({ rls: true, anon: false, authenticated: false });
    });
});
