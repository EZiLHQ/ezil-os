/**
 * The reverse move's two placement writers (REVERSE-MOVE-CONTRACT §5.2 `releaseExportBoot`, §5.6 `flipPlacementToCloudflare`)
 * on disposable PostgreSQL with the production Drizzle driver, next to the reverse store over the same transaction.
 * Never imports the app DB or reads credentials.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    ENROLLMENT_FAILED, ENROLLMENT_SUCCEEDED, flipPlacementToCloudflare, INSTANCE_LOST, readPlacement, releaseExportBoot,
    type Placement, type PlacementDb, type PlacementExecutor,
} from './placement';
import { createProviderReverseStore, EXPORT_CHUNK_BYTES, type ComputeReverseMove } from './provider-reverse-store';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `placement_reverse_test_${randomUUID().replaceAll('-', '')}`;
const computerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const otherUser = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fenceToken = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const fsUuid = 'abababab-abab-4bab-8bab-abababababab';
const volumeId = 'vol-11111111111111111';
const instanceId = 'i-11111111111111111';
/** The export boot's claim: N = 4, E = 7 → N+1 = 5, E+1 = 8. */
const N1 = 5, E1 = 8;

describe.skipIf(!PG)('reverse-move placement writers on production Drizzle PostgreSQL', () => {
    const client = PG ? postgres(PG, { max: 10, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => db.execute(scoped(q)) });
    const db: PlacementDb = { execute: q => executor(production!).execute(q), transaction: fn =>
        production!.transaction(tx => fn(executor(tx))) };
    const q = (text: string) => client!.unsafe(text.replaceAll('$S', schema));
    const current = async () => (await readPlacement(db, computerId)).record;
    const seed = (state: string, over: Record<string, string> = {}) => {
        const v: Record<string, string> = { generation: String(N1), lease_epoch: String(E1), state: `'${state}'`, lifecycle_job_id: 'NULL',
            last_error: `'${state === 'MOUNTING' ? ENROLLMENT_SUCCEEDED : INSTANCE_LOST}'`, instance_id: `'${instanceId}'`, owner: `'${ownerUserId}'`,
            enroll: state === 'MOUNTING' ? `NULL, '${'a'.repeat(64)}', '2099-01-02T00:00:00.000Z'` : 'NULL, NULL, NULL', ...over };
        return q(`INSERT INTO $S.ezil_computer_placements (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state,
            region, zone_id, instance_id, instance_type, volume_id, fs_uuid, fence_token, lifecycle_job_id, lifecycle_digest, last_error,
            enroll_nonce_hash, enroll_consumed_hash, enroll_expires_at, updated_at)
            VALUES ('${computerId}', ${v.owner}, 'aws-ec2', 'ebs', ${v.generation}, ${v.lease_epoch}, ${v.state}, 'ap-south-1', 'aps1-az1',
                ${v.instance_id}, 't3a.medium', '${volumeId}', '${fsUuid}', '${fenceToken}', ${v.lifecycle_job_id},
                ${v.lifecycle_job_id === 'NULL' ? 'NULL' : `'${'c'.repeat(64)}'`}, ${v.last_error}, ${v.enroll}, '2026-10-22T00:00:00.000Z')`);
    };
    const usageRows = async () => Number((await q(`SELECT count(*)::int AS n FROM $S.ezil_compute_usage`))[0]!.n);
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
        for (const file of ['0006_compute_migrations.sql', '0010_migration_restore_progress.sql', '0012_compute_reverse_moves.sql'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../drizzle', file), 'utf8')));
    });
    beforeEach(async () => {
        await q(`TRUNCATE $S.ezil_compute_usage, $S.ezil_computer_image_jobs, $S.ezil_computer_placements, $S.ezil_compute_reverse_moves, $S.ezil_compute_migrations`);
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    describe('releaseExportBoot (§5.2)', () => {
        it('MOUNTING at N+1/E+1 with no job → UNCONFIRMED/ENROLLMENT_FAILED with the enrollment proofs cleared; a replay is cas_conflict', async () => {
            await seed('MOUNTING');
            const p = (await current())!;
            const released = await releaseExportBoot(db, p, { placementGeneration: N1, leaseEpoch: E1 });
            expect(released.ok && released.placement).toMatchObject({ state: 'UNCONFIRMED', generation: N1, leaseEpoch: E1, instanceId, volumeId,
                lastError: ENROLLMENT_FAILED, enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null, lifecycleJobId: null });
            expect(await releaseExportBoot(db, p, { placementGeneration: N1, leaseEpoch: E1 })).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(await usageRows()).toBe(0);
        });

        it('never with a job pending, at another generation or epoch, or from a stale copy', async () => {
            await seed('MOUNTING', { lifecycle_job_id: `'${jobId}'` });
            const withJob = (await current())!;
            expect(await releaseExportBoot(db, withJob, { placementGeneration: N1, leaseEpoch: E1 })).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(await releaseExportBoot(db, { ...withJob, lifecycleJobId: null }, { placementGeneration: N1, leaseEpoch: E1 }))
                .toEqual({ ok: false, reason: 'cas_conflict' });
            expect((await current())).toMatchObject({ state: 'MOUNTING', lifecycleJobId: jobId });
            await q(`TRUNCATE $S.ezil_computer_placements`);
            await seed('MOUNTING');
            const p = (await current())!;
            expect(await releaseExportBoot(db, p, { placementGeneration: N1 + 1, leaseEpoch: E1 })).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(await releaseExportBoot(db, p, { placementGeneration: N1, leaseEpoch: E1 + 1 })).toEqual({ ok: false, reason: 'cas_conflict' });
            await q(`UPDATE $S.ezil_computer_placements SET updated_at = updated_at + interval '1 millisecond'`);
            expect(await releaseExportBoot(db, p, { placementGeneration: N1, leaseEpoch: E1 })).toEqual({ ok: false, reason: 'cas_conflict' });
            expect((await current())).toMatchObject({ state: 'MOUNTING', lastError: ENROLLMENT_SUCCEEDED });
        });

        it('only MOUNTING: LEASED, STARTING and RUNNING are never released', async () => {
            for (const state of ['LEASED', 'STARTING', 'RUNNING']) {
                await q(`TRUNCATE $S.ezil_computer_placements`);
                await seed(state);
                const p = (await current())!;
                expect(await releaseExportBoot(db, p, { placementGeneration: N1, leaseEpoch: E1 }), state).toEqual({ ok: false, reason: 'cas_conflict' });
                expect((await current())!.state, state).toBe(state);
            }
        });
    });

    describe('flipPlacementToCloudflare (§5.6 transaction 2)', () => {
        const flip = (finishInTx: (tx: PlacementExecutor) => Promise<void> = async () => {}, over: Partial<Parameters<typeof flipPlacementToCloudflare>[1]> = {}) =>
            flipPlacementToCloudflare(db, { computerId, ownerUserId, expected: { placementGeneration: N1, leaseEpoch: E1, volumeId }, store: 'r2', finishInTx, ...over });

        it('retires and deletes the STOPPED aws-ec2 row and inserts the Cloudflare row (generation 1, epoch 0, r2), opening no usage', async () => {
            await seed('STOPPED');
            const cf = await flip();
            expect(cf).toMatchObject({ provider: 'cloudflare', store: 'r2', state: 'STOPPED', generation: 1, leaseEpoch: 0, ownerUserId,
                instanceId: null, volumeId: null, region: null, lifecycleJobId: null });
            expect(await q(`SELECT provider, workspace_store, state, generation, lease_epoch FROM $S.ezil_computer_placements`))
                .toEqual([{ provider: 'cloudflare', workspace_store: 'r2', state: 'STOPPED', generation: '1', lease_epoch: '0' }]);
            expect(await usageRows()).toBe(0);
        });

        it('a throw from finishInTx rolls the whole flip back: the aws-ec2 row is untouched', async () => {
            await seed('STOPPED');
            const before = (await current())!;
            await expect(flip(async () => { throw new Error('reverse_move_conflict:lost_race'); })).rejects.toThrow('lost_race');
            expect(await current()).toEqual(before);
        });

        it('refuses (throws, nothing written) anything but this owner\'s STOPPED aws-ec2 row at N+1/E+1, no job, on the move\'s volume, store r2', async () => {
            const cases: [string, string, Record<string, string>, Partial<Parameters<typeof flipPlacementToCloudflare>[1]>][] = [
                ['job pending', 'STOPPED', { lifecycle_job_id: `'${jobId}'` }, {}],
                ['not retired yet', 'UNCONFIRMED', {}, {}],
                ['settled at N (a refused replace)', 'STOPPED', { generation: String(N1 - 1) }, {}],
                ['another epoch', 'STOPPED', { lease_epoch: String(E1 + 1) }, {}],
                ['another owner', 'STOPPED', { owner: `'${otherUser}'` }, {}],
                ['another volume', 'STOPPED', {}, { expected: { placementGeneration: N1, leaseEpoch: E1, volumeId: 'vol-22222222222222222' } }],
                ['store s3', 'STOPPED', {}, { store: 's3' }],
            ];
            for (const [name, state, over, input] of cases) {
                await q(`TRUNCATE $S.ezil_computer_placements`);
                await seed(state, over);
                const before = await q(`SELECT * FROM $S.ezil_computer_placements`);
                let finished = false;
                await expect(flip(async () => { finished = true; }, input), name).rejects.toThrow(/reverse_flip_/);
                expect(finished, name).toBe(false);
                expect(await q(`SELECT * FROM $S.ezil_computer_placements`), name).toEqual(before);
            }
            await q(`TRUNCATE $S.ezil_computer_placements`);
            await expect(flip(), 'no placement').rejects.toThrow('reverse_flip_source_mismatch');
        });

        it('with the reverse store over the same transaction: committed and Cloudflare together, or neither', async () => {
            const reverse = createProviderReverseStore(db);
            let m: ComputeReverseMove = await reverse.createOrGetActive({ computerId, userId: ownerUserId, startedBy: 'user' });
            m = await reverse.recordExportBoot(m, { placementGeneration: N1, leaseEpoch: E1, region: 'ap-south-1', volumeId, jobId,
                instanceId: 'i-0123456789abcdef0', fsUuid, claimedAt: new Date().toISOString() });
            m = await reverse.advance(m, 'exporting');
            m = await reverse.recordExportHead(m, { generation: m.generation, sha256: 'f'.repeat(64), entries: 1, skipped: 0, bytes: EXPORT_CHUNK_BYTES,
                chunks: [{ i: 0, size: EXPORT_CHUNK_BYTES, sha256: '0'.repeat(64) }] });
            m = await reverse.recordImportProgress(m, [0]);
            m = await reverse.advance(await reverse.advance(m, 'checking'), 'flipping');
            await seed('STOPPED');
            // A stale copy loses its CAS: the placement flip rolls back with it.
            await expect(flip(tx => createProviderReverseStore(tx).finish({ ...m, updatedAt: '1999-01-01 00:00:00+00' },
                { awsVolumeId: volumeId, awsFsUuid: fsUuid, awsSnapshotId: null }).then(() => undefined))).rejects.toThrow('lost_race');
            expect((await current())).toMatchObject({ provider: 'aws-ec2', state: 'STOPPED' });
            expect((await reverse.readById(m.id))!.state).toBe('flipping');
            let done: ComputeReverseMove | null = null;
            const cf: Placement = await flip(async tx => { done = await createProviderReverseStore(tx).finish(m, { awsVolumeId: volumeId, awsFsUuid: fsUuid, awsSnapshotId: null }); });
            expect(cf).toMatchObject({ provider: 'cloudflare', generation: 1, leaseEpoch: 0 });
            expect(done).toMatchObject({ state: 'committed', awsVolumeId: volumeId, awsFsUuid: fsUuid, awsSnapshotId: null });
            expect((await reverse.readById(m.id))!).toMatchObject({ state: 'committed', retainUntil: expect.any(Date) });
        });
    });
});
