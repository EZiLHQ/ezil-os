/** Disposable PostgreSQL only; never resolves the app connection or credentials. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createImageJobStore, newReservedImageJob, parseImageJobRow } from './aws-rebase-store';
import { fixtureRebasePreparation, fixtureRebaseRelease, fixtureRebaseIntent } from './aws-intent.test-support';
import { buildLifecycleWork } from './aws-intent';
import { rebaseEnv, rebaseSetup, releasedPoolSetup, RELEASED_POOL_HOST } from './aws-rebase.test-support';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { nonceHashOf } from './aws-enroll';
import { buildRebasePreparation } from './aws-rebase-preparation';
import { leasePoolHost } from './ready-pool';
import { assertNoImageReservation, leasePlacement, mintAdmissionTicket, readAdmissionCounters, withAdmission, type PlacementDb, type PlacementExecutor } from './placement';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `rebase_test_${randomUUID().replaceAll('-', '')}`;
const repository = '123456789012.dkr.ecr.ap-south-1.amazonaws.com/desktop';
const prep = fixtureRebasePreparation();
const job = () => newReservedImageJob({ preparation: prep, ownerUserId: '33333333-3333-4333-8333-333333333333',
    sourceRelease: fixtureRebaseRelease(prep.intent.sourceDeployment), targetRelease: fixtureRebaseRelease(prep.intent.deployment) });

describe.skipIf(!PG)('image reservation on disposable PostgreSQL', () => {
    // Match server/db/index.ts: Drizzle installs transparent timestamp codecs,
    // whereas the old raw postgres-js executor returned Date objects.
    const client = PG ? postgres(PG, { max: 10, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const dialect = new PgDialect();
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    // Rewrite SQL identifiers only; preserve bound values and let the real
    // Drizzle executor and transaction implementation handle every store call.
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => db.execute(scoped(q)) });
    const db: PlacementDb = { execute: q => executor(production!).execute(q), transaction: fn =>
        production!.transaction(tx => fn(executor(tx))) };
    const store = createImageJobStore(db, rebaseEnv);
    const expectMillisecondWrites = async () => {
        const rows = await production!.execute(sql.raw(`SELECT job_id,
            created_at = date_trunc('milliseconds', created_at) AS created_ms,
            updated_at = date_trunc('milliseconds', updated_at) AS updated_ms,
            reconciled_at IS NOT DISTINCT FROM date_trunc('milliseconds', reconciled_at) AS reconciled_ms,
            completed_at IS NOT DISTINCT FROM date_trunc('milliseconds', completed_at) AS completed_ms,
            retain_until IS NOT DISTINCT FROM date_trunc('milliseconds', retain_until) AS retain_ms
            FROM ${schema}.ezil_computer_image_jobs`));
        expect(rows.length).toBeGreaterThan(0);
        for (const row of rows) expect(row).toMatchObject({ created_ms: true, updated_ms: true, reconciled_ms: true, completed_ms: true, retain_ms: true });
    };
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        // Pool hosts as staging has them (v2 claim columns, 0008 dispatch), which the released-pool evidence read selects.
        for (const file of ['0001_compute_placement.sql.txt', '0002_ready_pool.sql.txt', '0003_pool_hosts_v2.sql.txt', '0002_image_rebase.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0008_pool_dispatch.sql'), 'utf8')));
        // The real capacity-demand schema (admission counts other active demands; placement:count-demand), every constraint kept.
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0009_capacity_demands.sql'), 'utf8')));
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers (id uuid, user_id uuid, deleted_at timestamptz)`);
        // Local migration double used only for the active-migration exclusion query.
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_compute_migrations (id uuid, computer_id uuid, state text, user_id uuid, workspace_head jsonb)`);
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0010_migration_restore_progress.sql'), 'utf8')));
    });
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_usage, ${schema}.ezil_computer_image_jobs, ${schema}.ezil_computer_placements, ${schema}.ezil_compute_migrations, ${schema}.ezil_computers, ${schema}.ezil_compute_capacity_demands, ${schema}.ezil_compute_pool_hosts`);
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
    it('reads every timestamp as production Drizzle text and normalizes microseconds and offsets', async () => {
        const j = await store.reserve(job(), repository);
        await production!.transaction(async tx => {
            await tx.execute(sql`SET LOCAL TIME ZONE 'Asia/Kolkata'`);
            // Read-only projection tests PostgreSQL's six-digit output without
            // violating the millisecond-write invariant of persisted jobs.
            const rows = await tx.execute(sql.raw(`SELECT j.*,
                created_at + interval '901 microseconds' AS created_at,
                '2026-10-22 19:28:51.068901+00'::timestamptz AS updated_at,
                '2026-10-22 19:28:50.067901+00'::timestamptz AS reconciled_at,
                '2026-10-22 19:28:51.068901+00'::timestamptz AS completed_at,
                '2026-10-29 19:28:51.068901+00'::timestamptz AS retain_until,
                'cancelled'::text AS phase FROM ${schema}.ezil_computer_image_jobs j`));
            expect(rows).toHaveLength(1);
            for (const key of ['created_at', 'updated_at', 'reconciled_at', 'completed_at', 'retain_until']) {
                expect(typeof rows[0]![key]).toBe('string');
                expect(rows[0]![key]).toMatch(/901\+05:30$/);
            }
            expect(parseImageJobRow(rows[0]!)).toEqual({ ...j, phase: 'cancelled', updatedAt: '2026-10-22T19:28:51.068Z',
                reconciledAt: '2026-10-22T19:28:50.067Z', completedAt: '2026-10-22T19:28:51.068Z', retainUntil: '2026-10-29T19:28:51.068Z' });
        });
        expect(await store.read(j.jobId)).toEqual(j);
        await expectMillisecondWrites();
    });
    it('concurrent identical reservations yield one row and one placement reservation', async () => {
        const results = await Promise.all(Array.from({ length: 8 }, () => store.reserve(job(), repository)));
        expect(new Set(results.map(j => j.jobId)).size).toBe(1);
        expect(await client!.unsafe(`SELECT job_id FROM ${schema}.ezil_computer_image_jobs`)).toHaveLength(1);
        await expect(assertNoImageReservation(db, job().computerId)).rejects.toThrow('image_job_conflict');
    });
    it('stores releases as JSONB objects and absent evidence as SQL NULL', async () => {
        const expected = job();
        expect(await store.reserve(expected, repository)).toEqual(expected);
        expect(await store.read(expected.jobId)).toEqual(expected);
        const rows = await client!.unsafe(`SELECT jsonb_typeof(source_release) AS source_type,
            jsonb_typeof(target_release) AS target_type, snapshot_evidence IS NULL AS no_snapshot,
            host_evidence IS NULL AS no_host FROM ${schema}.ezil_computer_image_jobs`);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toEqual({ source_type: 'object', target_type: 'object', no_snapshot: true, no_host: true });
    });
    it('only one phase CAS consumes the old timestamp', async () => {
        const j = await store.reserve(job(), repository);
        const next = { ...j, phase: 'fencing' as const, updatedAt: '2026-10-22T11:00:01.000Z' };
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.transition(j, next)));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(7);
        await expectMillisecondWrites();
    });
    it('preserves exact CAS after a microsecond PostgreSQL clock is normalized at the write boundary', async () => {
        const s = rebaseSetup(db);
        expect((await s.run('prepare')).status).toBe(202);
        const j = await s.current();
        const clock = await production!.execute(sql`SELECT date_trunc('milliseconds', now()) + interval '901 microseconds' AS now`);
        expect(typeof clock[0]!.now).toBe('string');
        expect(clock[0]!.now).toMatch(/\d{3}901[+-]/);
        await expect(s.store.transition(j, { ...j, updatedAt: String(clock[0]!.now) })).rejects.toThrow();
        const observed = new Date(Math.max(Date.parse(String(clock[0]!.now)), Date.parse(j.updatedAt) + 1));
        const candidate = { ...j, phase: 'unconfirmed' as const, failureCode: 'operator_required' as const, updatedAt: observed.toISOString() };
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => s.store.transition(j, candidate)));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(7);
        const current = (await store.read(j.jobId))!;
        expect(current.updatedAt).toBe(observed.toISOString());
        await expectMillisecondWrites();
        const next = await s.store.transition(current, { ...current, updatedAt: new Date(observed.getTime() + 1).toISOString() });
        expect(Date.parse(next.updatedAt)).toBe(Date.parse(current.updatedAt) + 1);
        await expect(s.store.transition(current, { ...current, updatedAt: new Date(observed.getTime() + 2).toISOString() })).rejects.toThrow('image_job_conflict');
        await expectMillisecondWrites();
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
        await client!.unsafe(`INSERT INTO ${schema}.ezil_compute_migrations (id, computer_id, state) VALUES ($1,$2,'requested')`, [randomUUID(), job().computerId]);
        await expect(store.reserve(job(), repository)).rejects.toThrow('image_job_conflict');
    });
    it('a holding reverse move refuses the reservation (REVERSE-MOVE-CONTRACT §5.2.1); a released one and a schema without 0012 do not', async () => {
        // This suite's schema has no 0012 (as production): every other test here proves the probe answers "no reverse move".
        const j = job();
        const reset = async () => {
            await client!.unsafe(`DELETE FROM ${schema}.ezil_computer_image_jobs`);
            await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET image_upgrade_job_id = NULL`);
        };
        expect((await store.reserve(job(), repository)).phase).toBe('reserved');
        await reset();
        await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle/0012_compute_reverse_moves.sql'), 'utf8')));
        try {
            const row = (state: string) => client!.unsafe(`INSERT INTO ${schema}.ezil_compute_reverse_moves (computer_id, user_id, started_by, state, commit_sent_at, retain_until)
                VALUES ($1, $2, 'user', $3, ${state === 'flipping' || state === 'committed' ? 'now()' : 'NULL'}, ${state === 'committed' ? "now() + interval '14 days'" : 'NULL'})`,
            [j.computerId, j.ownerUserId, state]);
            for (const state of ['requested', 'booting', 'exporting', 'copying', 'checking', 'flipping', 'failed_needs_operator']) {
                await client!.unsafe(`DELETE FROM ${schema}.ezil_compute_reverse_moves`);
                await row(state);
                await expect(store.reserve(job(), repository), state).rejects.toThrow('image_job_conflict');
                const [placement] = await client!.unsafe(`SELECT image_upgrade_job_id FROM ${schema}.ezil_computer_placements`);
                expect(placement!.image_upgrade_job_id, state).toBeNull();
                expect((await client!.unsafe(`SELECT count(*)::int AS n FROM ${schema}.ezil_computer_image_jobs`))[0]!.n, state).toBe(0);
            }
            for (const state of ['committed', 'failed_reopened']) {
                await client!.unsafe(`DELETE FROM ${schema}.ezil_compute_reverse_moves`);
                await row(state);
                expect((await store.reserve(job(), repository)).phase, state).toBe('reserved');
                await reset();
            }
        } finally { await client!.unsafe(`DROP TABLE ${schema}.ezil_compute_reverse_moves`); }
    });
    it('actual test writer can write, while anon/authenticated have no table privilege and RLS is enabled', async () => {
        await store.reserve(job(), repository);
        const r = await client!.unsafe(`SELECT relrowsecurity AS rls,
            has_table_privilege('anon', oid, 'SELECT,INSERT,UPDATE,DELETE') AS anon,
            has_table_privilege('authenticated', oid, 'SELECT,INSERT,UPDATE,DELETE') AS authenticated
            FROM pg_class WHERE oid = '${schema}.ezil_computer_image_jobs'::regclass`);
        expect(r[0]).toMatchObject({ rls: true, anon: false, authenticated: false });
    });
    const ready = async () => {
        let j = await store.reserve(job(), repository);
        j = await store.transition(j, { ...j, phase: 'fencing', updatedAt: '2026-10-22T11:00:01.000Z' });
        j = await store.transition(j, { ...j, phase: 'snapshot_pending', updatedAt: '2026-10-22T11:00:02.000Z' });
        const receipt = { schemaVersion: 1 as const, jobId: j.jobId, digest: j.preparationDigest, computerId: j.computerId, state: 'snapshot_ready' as const,
            sourceInstanceId: j.sourceInstanceId, sourceVolumeId: j.sourceVolumeId, fsUuid: j.fsUuid, sourceGeneration: j.sourceGeneration,
            sourceLeaseEpoch: j.sourceLeaseEpoch, sourceFenceToken: j.sourceFenceToken, fromDigest: j.fromDigest, toDigest: j.toDigest,
            snapshotId: 'snap-11111111111111111', snapshotOwnerId: prep.intent.deployment.accountId, snapshotVolumeGiB: prep.intent.volumeGiB,
            snapshotKmsKeyArn: prep.intent.deployment.dataKeyArn, fencedAt: '2026-10-22T11:00:03.000Z', snapshotStartedAt: '2026-10-22T11:00:04.000Z',
            snapshotCompletedAt: '2026-10-22T11:01:00.000Z', verifiedAt: '2026-10-22T11:01:01.000Z' };
        return store.reconcilePreparation(j, receipt, new Date('2026-10-22T11:01:01.000Z'));
    };
    it('concurrent launch admissions commit exactly one document/nonce/epoch CAS', async () => {
        const j = await ready(), w = buildLifecycleWork(fixtureRebaseIntent());
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.admitLaunch(j, w, new Date('2026-10-22T12:00:00.000Z'))));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(7);
        const rows = await client!.unsafe(`SELECT generation, lease_epoch, fence_token, enroll_nonce_hash, lifecycle_digest FROM ${schema}.ezil_computer_placements`);
        expect(Number(rows[0]!.generation)).toBe(j.sourceGeneration);
        expect(Number(rows[0]!.lease_epoch)).toBe(w.intent.leaseEpoch);
        expect(rows[0]!.fence_token).toBe(j.sourceFenceToken);
        expect(rows[0]!.enroll_nonce_hash).toBe(nonceHashOf('n'.repeat(43)));
        expect(rows[0]!.lifecycle_digest).toBe(w.digest);
    });
    it('concurrent image enrollment accepts one digest and preserves replay evidence', async () => {
        const j = await store.admitLaunch(await ready(), buildLifecycleWork(fixtureRebaseIntent()), new Date('2026-10-22T12:00:00.000Z'));
        const input = { nonceHash: nonceHashOf('n'.repeat(43)), instanceId: 'i-22222222222222222', volumeId: j.sourceVolumeId, lowerImageDigest: j.toDigest };
        const results = await Promise.allSettled(Array.from({ length: 8 }, () => store.enroll(j, input, new Date('2026-10-22T12:01:00.000Z'))));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(r => r.status === 'rejected')).toHaveLength(7);
        const current = (await store.read(j.jobId))!;
        expect(await store.enroll(current, input, new Date('2026-10-22T12:01:01.000Z'))).toMatchObject({ lowerImageDigest: j.toDigest });
        await expect(store.enroll(current, { ...input, lowerImageDigest: j.fromDigest }, new Date('2026-10-22T12:01:01.000Z'))).rejects.toThrow();
        expect((await store.read(j.jobId))!.hostEvidence).toEqual(current.hostEvidence);
        await expectMillisecondWrites();
    });
    it('a placement update failure rolls back the launch document and nonce admission', async () => {
        const j = await ready();
        const broken: PlacementDb = { ...db, transaction: fn => db.transaction(tx => fn({ execute: async q => {
            if (dialect.sqlToQuery(q).sql.includes('placement:image-write')) return [];
            return tx.execute(q);
        } })) };
        await expect(createImageJobStore(broken, rebaseEnv).admitLaunch(j, buildLifecycleWork(fixtureRebaseIntent()), new Date('2026-10-22T12:00:00.000Z'))).rejects.toThrow();
        expect((await store.read(j.jobId))!.launchDocument).toBeNull();
        const rows = await client!.unsafe(`SELECT enroll_nonce_hash, lease_epoch FROM ${schema}.ezil_computer_placements`);
        expect(rows[0]!.enroll_nonce_hash).toBeNull(); expect(Number(rows[0]!.lease_epoch)).toBe(j.sourceLeaseEpoch);
    });
    it('changed owner and duplicate jobs revoke image authority before mutation', async () => {
        const j = await store.reserve(job(), repository);
        const a = { computerId: j.computerId, imageJobId: j.jobId, imageJobPhase: 'preparation' as const,
            jobId: j.jobId, leaseEpoch: j.sourceLeaseEpoch, digest: j.preparationDigest };
        expect(await store.authority(a)).toBe(true);
        await client!.unsafe(`UPDATE ${schema}.ezil_computers SET user_id = $1`, [randomUUID()]);
        await expect(store.authority(a)).rejects.toThrow('image_job_conflict');
    });

    it('persists completion and retention timestamps at millisecond precision', async () => {
        const s = rebaseSetup(db);
        expect((await s.run('prepare')).status).toBe(202);
        await s.completePreparation(); expect((await s.run('launch')).status).toBe(202);
        await s.completeLaunch();
        const j = await s.current(), lease = parseEnrollmentUserData(JSON.parse(j.launchDocument!).userData);
        const input = { nonceHash: nonceHashOf(lease.nonce), instanceId: s.provider.host!.instanceId,
            volumeId: j.sourceVolumeId, lowerImageDigest: j.toDigest };
        await s.store.enroll(j, input, s.deps.now());
        await s.store.finishEnroll(await s.current(), { instanceId: input.instanceId, success: true }, s.deps.now());
        expect((await s.run('verify')).body.phase).toBe('succeeded');
        const completed = (await s.store.read(j.jobId))!;
        expect(completed.completedAt).not.toBeNull();
        expect(completed.retainUntil).not.toBeNull();
        await expectMillisecondWrites();
    });

    it('recovery/rebind custody transfers atomically to exactly one new linked preparation', async () => {
        const s = rebaseSetup(db);
        expect((await s.run('prepare')).status).toBe(202);
        await s.completePreparation(); expect((await s.run('launch')).status).toBe(202);
        let j = await s.current();
        Object.assign(s.executions.get(j.launchExecutionArn!)!, { status: 'FAILED' });
        await s.run('verify'); expect((await s.run('recover', j.jobId)).body.phase).toBe('restore_pending');
        await s.completeRecovery(); expect((await s.run('recover', j.jobId)).body.phase).toBe('rebind_pending');
        await s.completeRebind(); j = await s.current();
        const lease = parseEnrollmentUserData(JSON.parse(j.rebindDocument!).userData);
        await s.store.enrollMaintenance(j, { nonceHash: nonceHashOf(lease.nonce), instanceId: s.provider.host!.instanceId, lowerImageDigest: j.fromDigest,
            report: { v: 1, recoveryJobId: j.recoveryJobId!, snapshotId: j.snapshotId!, originalVolumeId: j.sourceVolumeId,
                volumeId: j.restoredVolumeId!, fsUuid: j.fsUuid } }, s.deps.now());
        const results = await Promise.all(Array.from({ length: 4 }, () => s.run('recover', j.jobId)));
        expect(results.some(r => r.body.phase === 'recovered' && r.status === 200)).toBe(true);
        const parent = await s.store.read(j.jobId), child = await s.current();
        expect(parent).toMatchObject({ phase: 'recovered', retentionHold: true });
        expect(child).toMatchObject({ parentJobId: j.jobId, sourceVolumeId: j.restoredVolumeId, snapshotId: null });
        const rows = await client!.unsafe(`SELECT job_id FROM ${schema}.ezil_computer_image_jobs WHERE parent_job_id = $1`, [j.jobId]);
        expect(rows).toHaveLength(1);
        await expectMillisecondWrites();
    });

    describe('DESIGN R: released warm-pool host on PostgreSQL', () => {
        const OTHER = '99999999-9999-4999-8999-999999999999', START_JOB = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
        const insertPool = (row: Record<string, unknown>) => client!.unsafe(`INSERT INTO ${schema}.ezil_compute_pool_hosts
            (id, region, zone_id, instance_id, instance_type, state, health, generation, leased_computer_id, leased_generation, lease_token,
             leased_at, created_at, updated_at, claim_generation, claim_lease_epoch, claim_fence, claim_volume_serial,
             lifecycle_job_id, lifecycle_digest, lifecycle_input, dispatch_status)
            VALUES ($1, $2, $3, $4, $5, $6, 'unknown', $7, $8, $7, gen_random_uuid(), now(), now(), now(), $9, $10, $11, $12, $13, $14, $15, $16)`,
        [row.id, row.region, row.zone_id, row.instance_id, row.instance_type, row.state, row.generation, row.leased_computer_id,
            row.claim_generation, row.claim_lease_epoch, row.claim_fence, row.claim_volume_serial,
            row.lifecycle_job_id, row.lifecycle_digest, row.lifecycle_input, row.dispatch_status] as never[]);
        const releasedJob = (s: ReturnType<typeof releasedPoolSetup>) => newReservedImageJob({ ownerUserId: job().ownerUserId,
            preparation: buildRebasePreparation({ ...prep.intent, releasedPoolHost: { poolHostId: RELEASED_POOL_HOST,
                lifecycleDigest: s.provision().digest, releaseExecutionArn: s.releaseArn } }),
            sourceRelease: fixtureRebaseRelease(prep.intent.sourceDeployment), targetRelease: fixtureRebaseRelease(prep.intent.deployment) });
        const placementRow = async () => (await client!.unsafe(`SELECT image_upgrade_job_id, lifecycle_job_id, state, lease_epoch FROM ${schema}.ezil_computer_placements`))[0]!;
        const jobCount = async () => (await client!.unsafe(`SELECT count(*)::int AS n FROM ${schema}.ezil_computer_image_jobs`))[0]!.n;

        it('selects exactly the retired claim row of this allocation; every predicate is load-bearing', async () => {
            const s = releasedPoolSetup({ db }); await insertPool(s.row);
            expect((await store.releasedPoolHost(prep.intent.computerId)).row).toEqual({ id: RELEASED_POOL_HOST, generation: 1, region: 'ap-south-1',
                zone_id: prep.intent.deployment.zoneId, instance_type: 'm6i.large', instance_id: prep.intent.sourceInstanceId,
                lifecycle_job_id: s.row.lifecycle_job_id, lifecycle_digest: s.provision().digest, lifecycle_input: s.provision().input });
            for (const [column, value] of [['state', `'leased'`], ['state', `'retiring'`], ['dispatch_status', `'started'`], ['dispatch_status', 'NULL'],
                ['leased_computer_id', `'${OTHER}'`], ['leased_computer_id', 'NULL'], ['instance_id', `'i-99999999999999999'`], ['region', `'us-east-1'`],
                ['zone_id', `'aps1-az2'`], ['claim_generation', '2'], ['claim_lease_epoch', '2'], ['claim_fence', `'${OTHER}'`],
                ['claim_volume_serial', `'vol99999999999999999'`], ['lifecycle_job_id', 'NULL'], ['lifecycle_digest', 'NULL'], ['lifecycle_input', 'NULL']]) {
                await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET ${column} = ${value}`);
                expect((await store.releasedPoolHost(prep.intent.computerId)).row, `${column}=${value}`).toBeNull();
                await client!.unsafe(`DELETE FROM ${schema}.ezil_compute_pool_hosts`); await insertPool(s.row);
            }
            await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET lease_epoch = 4`);
            expect((await store.releasedPoolHost(prep.intent.computerId)).row).toBeNull();
        });
        it('plans and reserves through the orchestrator with the real lock and SQL', async () => {
            const s = releasedPoolSetup({ db }); await insertPool(s.row);
            expect((await s.request('plan')).body).toMatchObject({ eligible: true, failureCode: null });
            expect(await jobCount()).toBe(0);
            expect((await s.request('prepare')).status).toBe(202);
            const j = (await store.read(s.started[0]!.name.replace('computer-', '')))!;
            expect(JSON.parse(j.preparationDocument).releasedPoolHost).toEqual({ poolHostId: RELEASED_POOL_HOST,
                lifecycleDigest: s.provision().digest, releaseExecutionArn: s.releaseArn });
            expect((await placementRow()).image_upgrade_job_id).toBe(j.jobId);
            await expectMillisecondWrites();
        });
        it.each([
            ['no row', 'DELETE FROM pool'], ['row not retired', `UPDATE pool SET state = 'leased'`],
            ['row digest changed', `UPDATE pool SET lifecycle_digest = '${'e'.repeat(64)}'`],
            ['placement RUNNING', `UPDATE placements SET state = 'RUNNING'`],
        ])('reserve re-reads the row under its lock: %s refuses', async (_name, statement) => {
            const s = releasedPoolSetup({ db }); await insertPool(s.row);
            await client!.unsafe(statement.replace('pool', `${schema}.ezil_compute_pool_hosts`).replace('placements', `${schema}.ezil_computer_placements`));
            await expect(store.reserve(releasedJob(s), repository)).rejects.toThrow('image_job_conflict');
            expect(await jobCount()).toBe(0); expect((await placementRow()).image_upgrade_job_id).toBeNull();
        });
        // A lifecycle start (STOPPED -> LEASED with its job) and a pool claim (the same lease plus a spare host) under
        // admission's real lock and casInTx: exactly one of them or the reservation commits, never both.
        const start = (claim: boolean) => withAdmission(db, async (tx, lock) => {
            const now = new Date(), computerId = prep.intent.computerId, userId = job().ownerUserId;
            await readAdmissionCounters(tx, lock, { userId, computerId, monthStart: new Date(0), now });
            const r = await leasePlacement(tx, lock, mintAdmissionTicket(tx, lock, { computerId, userId, kind: 'lease' }), { computerId,
                ownerUserId: userId, expected: { generation: 1, leaseEpoch: 3 }, leaseUntil: new Date(now.getTime() + 3600000),
                fields: { lifecycleJobId: START_JOB, lifecycleDigest: 'f'.repeat(64) } });
            if (!r.ok) throw new Error('lease_lost');
            if (claim && !await leasePoolHost(tx, { region: 'ap-south-1', zoneId: prep.intent.deployment.zoneId, instanceType: 'm6i.large' }, computerId, 1, now))
                throw new Error('no_spare');
            return r;
        });
        const spare = async () => {
            const at = new Date(Date.now() - 60000).toISOString();
            await client!.unsafe(`INSERT INTO ${schema}.ezil_compute_pool_hosts (id, region, zone_id, instance_id, instance_type, state, health,
                editor_ready_at, generation, created_at, updated_at, ready_at, enrolled_at) VALUES ($1, 'ap-south-1', $2, 'i-77777777777777777',
                'm6i.large', 'ready', 'healthy', $3, 1, $3, $3, $3, $3)`, [OTHER, prep.intent.deployment.zoneId, at]);
        };
        const spareLeased = async () => (await client!.unsafe(`SELECT leased_computer_id FROM ${schema}.ezil_compute_pool_hosts WHERE id = $1`, [OTHER]))[0]!.leased_computer_id;
        for (const claim of [false, true]) {
            const name = claim ? 'pool claim' : 'lifecycle start';
            it(`${name} first: the reservation refuses on the recorded job and moved epoch`, async () => {
                const s = releasedPoolSetup({ db }); await insertPool(s.row); if (claim) await spare();
                await start(claim);
                await expect(store.reserve(releasedJob(s), repository)).rejects.toThrow('image_job_conflict');
                expect(await placementRow()).toMatchObject({ image_upgrade_job_id: null, lifecycle_job_id: START_JOB, state: 'LEASED' });
                expect(await jobCount()).toBe(0); if (claim) expect(await spareLeased()).toBe(prep.intent.computerId);
            });
            it(`reservation first: the ${name} refuses on the reservation and rolls back`, async () => {
                const s = releasedPoolSetup({ db }); await insertPool(s.row); if (claim) await spare();
                const j = await store.reserve(releasedJob(s), repository);
                await expect(start(claim)).rejects.toThrow('image_job_conflict');
                expect(await placementRow()).toMatchObject({ image_upgrade_job_id: j.jobId, lifecycle_job_id: null, state: 'STOPPED' });
                if (claim) expect(await spareLeased()).toBeNull();
            });
            it(`concurrent ${name} and reservation: exactly one commits`, async () => {
                for (let n = 0; n < 4; n++) {
                    await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_pool_hosts, ${schema}.ezil_computer_image_jobs`);
                    await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET state = 'STOPPED', lease_epoch = 3, lifecycle_job_id = NULL,
                        lifecycle_digest = NULL, image_upgrade_job_id = NULL, lease_until = NULL`);
                    const s = releasedPoolSetup({ db }); await insertPool(s.row); if (claim) await spare();
                    const [reserved, started] = await Promise.allSettled([store.reserve(releasedJob(s), repository), start(claim)]);
                    expect([reserved.status, started.status].filter(x => x === 'fulfilled')).toHaveLength(1);
                    const loser = reserved.status === 'rejected' ? reserved : started as PromiseRejectedResult;
                    expect(String((loser.reason as Error).message)).toBe('image_job_conflict');
                    const p = await placementRow();
                    expect(p.image_upgrade_job_id === null).toBe(p.lifecycle_job_id !== null);
                    expect(await jobCount()).toBe(reserved.status === 'fulfilled' ? 1 : 0);
                    if (claim) expect(await spareLeased()).toBe(reserved.status === 'fulfilled' ? null : prep.intent.computerId);
                }
            });
        }
    });
});
