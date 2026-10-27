/** Disposable PostgreSQL only; never imports the app DB or reads credentials. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    consumeEnrollmentNonce, createPlacement, ENROLLMENT_FAILED, findStaleOpenUsage, lockImagePlacement, readPlacement, reconcileReplacementGeneration,
    setImageReservation, transitionPlacement, withAdmission, writeImagePlacement, writePoolOpen,
    type ImagePlacementFields, type Placement, type PlacementDb, type PlacementExecutor,
} from './placement';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `placement_test_${randomUUID().replaceAll('-', '')}`;
const computerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerUserId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const jobId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const fenceToken = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const volumeId = 'vol-11111111111111111';
const instanceId = 'i-11111111111111111';
const nonceHash = 'a'.repeat(64);
const digest = `sha256:${'b'.repeat(64)}`;
const confirmed = { generation: 1, fenceToken: jobId, instanceId, instanceLost: true };

describe.skipIf(!PG)('placement writes on production Drizzle PostgreSQL', () => {
    // Same driver/pool as server/db/index.ts and rebase.pg.test.ts. Only SQL
    // identifiers are scoped; bound values and codecs are never rewritten.
    const client = PG ? postgres(PG, { max: 10, idle_timeout: 20, prepare: false, onnotice: () => {} }) : null;
    const production = client ? drizzle(client) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (db: Pick<NonNullable<typeof production>, 'execute'>): PlacementExecutor => ({ execute: q => db.execute(scoped(q)) });
    const db: PlacementDb = { execute: q => executor(production!).execute(q), transaction: fn =>
        production!.transaction(tx => fn(executor(tx))) };
    const current = async () => (await readPlacement(db, computerId, ownerUserId)).record!;
    const imageUpdate = (fields: ImagePlacementFields) => withAdmission(db, async (tx, lock) => {
        const p = (await lockImagePlacement(tx, lock, computerId))!;
        await writeImagePlacement(tx, lock, p, fields);
        return (await lockImagePlacement(tx, lock, computerId))!;
    });
    const nativeTimestamp = async (tx: PlacementExecutor = db) => {
        const rows = await tx.execute(sql`SELECT updated_at,
            updated_at = date_trunc('milliseconds', updated_at) AS whole_ms
            FROM public.ezil_computer_placements WHERE computer_id = ${computerId}::uuid`) as { updated_at: string; whole_ms: boolean }[];
        expect(rows).toHaveLength(1);
        expect(typeof rows[0]!.updated_at).toBe('string');
        expect(rows[0]!.whole_ms).toBe(true);
        return new Date(rows[0]!.updated_at);
    };
    const start = async () => {
        const result = await transitionPlacement(db, { computerId, ownerUserId, expected: await current(), to: 'STARTING' });
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.reason);
        expect(result.placement.updatedAt).toEqual(await nativeTimestamp());
        return result.placement;
    };
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt'])
            await client!.unsafe(local(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
    });
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_usage, ${schema}.ezil_computer_image_jobs, ${schema}.ezil_computer_placements`);
        await production!.execute(sql.raw(`INSERT INTO ${schema}.ezil_computer_placements
            (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state,
             instance_id, instance_type, volume_id, fence_token, lifecycle_job_id, lifecycle_digest,
             enroll_nonce_hash, enroll_expires_at, updated_at)
            VALUES ('${computerId}', '${ownerUserId}', 'aws-ec2', 'ebs', 2, 4, 'LEASED',
                NULL, 'm6i.large', '${volumeId}', '${fenceToken}', '${jobId}', '${'c'.repeat(64)}',
                '${nonceHash}', '2099-01-02T00:00:00.000Z', '2026-10-22T00:00:00.000Z')`));
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    const seedUsage = async () => {
        for (const instance of ['i-old', 'i-current', 'i-current']) await db.execute(sql`
            INSERT INTO public.ezil_compute_usage
                (computer_id, user_id, instance_id, instance_type, started_at, stopped_at, egress_bytes, observed_by, updated_at)
            VALUES (${computerId}::uuid, ${ownerUserId}::uuid, ${instance}, 'm6i.large',
                '2026-10-22T09:00:00Z', NULL, NULL, 'receipt', '2026-10-22T09:00:00Z')`);
        await db.execute(sql`INSERT INTO public.ezil_compute_usage
            (computer_id, user_id, instance_id, instance_type, started_at, stopped_at, egress_bytes, observed_by, updated_at)
            VALUES (${computerId}::uuid, ${ownerUserId}::uuid, 'i-history', 'm6i.large',
                '2026-10-21T09:00:00Z', '2026-10-21T10:00:00Z', 123, 'history', '2026-10-21T10:00:00Z')`);
    };
    const ledger = () => db.execute(sql`SELECT * FROM public.ezil_compute_usage ORDER BY instance_id, started_at`) as Promise<Record<string, unknown>[]>;

    it('a refused lease closes all instances and duplicates while preserving historical rows', async () => {
        await seedUsage();
        const history = (await ledger()).find(r => r.instance_id === 'i-history');
        expect(await transitionPlacement(db, { computerId, ownerUserId, expected: await current(), to: 'STOPPED' })).toMatchObject({ ok: true });
        const rows = await ledger();
        expect(rows).toHaveLength(4);
        expect(rows.every(r => r.stopped_at !== null)).toBe(true);
        const closed = rows.filter(r => r.instance_id !== 'i-history');
        expect(new Set(closed.map(r => r.stopped_at)).size).toBe(1);
        expect(closed.every(r => r.observed_by === 'placement-transition' && r.updated_at === r.stopped_at)).toBe(true);
        expect(rows.find(r => r.instance_id === 'i-history')).toEqual(history);
    });

    it('a warm open after a failed enrollment reserves its release from the real UNCONFIRMED row, once, on the exact last_error', async () => {
        const releaseJob = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
        const release = { lifecycleJobId: releaseJob, lifecycleDigest: 'd'.repeat(64), lastError: 'pool_open_release',
            enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null };
        await production!.execute(sql.raw(`UPDATE ${schema}.ezil_computer_placements SET state = 'UNCONFIRMED', last_error = '${ENROLLMENT_FAILED}',
            instance_id = '${instanceId}', lifecycle_job_id = NULL, lifecycle_digest = NULL, enroll_nonce_hash = NULL, enroll_expires_at = NULL`));
        const p = await current();
        expect(p).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED, generation: 2, leaseEpoch: 4 });
        // A snapshot with any other UNCONFIRMED reason is refused before any write; a stale snapshot is refused by the CAS.
        expect(await writePoolOpen(db, { ...p, lastError: 'failed:LifecycleUnconfirmed' }, 'STOPPING', release)).toEqual({ ok: false, reason: 'cas_conflict' });
        expect(await writePoolOpen(db, { ...p, updatedAt: new Date(p.updatedAt.getTime() - 1) }, 'STOPPING', release)).toEqual({ ok: false, reason: 'cas_conflict' });
        expect(await current()).toEqual(p);
        const reserved = await writePoolOpen(db, p, 'STOPPING', release);
        expect(reserved).toMatchObject({ ok: true, placement: { state: 'STOPPING', generation: 2, leaseEpoch: 4, instanceId, volumeId,
            lastError: 'pool_open_release', lifecycleJobId: releaseJob, lifecycleDigest: 'd'.repeat(64), enrollNonceHash: null, enrollExpiresAt: null } });
        expect(await current()).toEqual((reserved as { placement: Placement }).placement);
        // The consumed snapshot cannot reserve a second release, and the reserved row answers the lifecycle authority's exact match.
        expect(await writePoolOpen(db, p, 'STOPPING', release)).toEqual({ ok: false, reason: 'cas_conflict' });
        expect((await readPlacement(db, computerId)).record).toMatchObject({ state: 'STOPPING', lifecycleJobId: releaseJob });
    });

    it('image recovery into STOPPED closes the complete open ledger', async () => {
        await seedUsage();
        await imageUpdate({ state: 'RECOVERING' });
        await imageUpdate({ state: 'STOPPED' });
        expect((await ledger()).every(r => r.stopped_at !== null)).toBe(true);
    });

    it('a failed usage write rolls back the terminal placement transition', async () => {
        await seedUsage();
        const before = await ledger(), p = await current();
        await client!.unsafe(`ALTER TABLE ${schema}.ezil_compute_usage ADD CONSTRAINT forbid_close
            CHECK (observed_by <> 'placement-transition')`);
        try {
            await expect(transitionPlacement(db, { computerId, ownerUserId, expected: p, to: 'STOPPED' })).rejects.toThrow();
            expect(await current()).toEqual(p);
            expect(await ledger()).toEqual(before);
        } finally { await client!.unsafe(`ALTER TABLE ${schema}.ezil_compute_usage DROP CONSTRAINT forbid_close`); }
    });

    it('reports stale open rows with native codecs and leaves every row unchanged', async () => {
        await seedUsage();
        const before = await ledger();
        const report = await findStaleOpenUsage(db);
        expect(report).toHaveLength(3);
        expect(report[0]).toMatchObject({ computerId, userId: ownerUserId, placementState: 'LEASED', stoppedAt: null,
            startedAt: new Date('2026-10-22T09:00:00Z'), placementUpdatedAt: new Date('2026-10-22T00:00:00Z') });
        for (const state of ['RUNNING', 'STARTING', 'MOUNTING']) {
            await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET state = '${state}'`);
            expect(await findStaleOpenUsage(db)).toEqual([]);
        }
        expect(await ledger()).toEqual(before);
    });

    it('binds all image Date fields through the production driver and preserves NULL clearing', async () => {
        const times = { enrollExpiresAt: new Date('2026-10-22T12:30:00.123Z'),
            lowerDigestObservedAt: new Date('2026-10-22T12:31:00.456Z'),
            leaseUntil: new Date('2026-10-22T13:30:00.789Z'), presenceAt: new Date('2026-10-22T12:29:00.012Z') };
        expect(await imageUpdate({ ...times, lowerImageDigest: digest })).toMatchObject(times);
        const rows = await production!.execute(sql.raw(`SELECT enroll_expires_at, lower_digest_observed_at, lease_until, presence_at
            FROM ${schema}.ezil_computer_placements`));
        for (const value of Object.values(rows[0]!)) expect(typeof value).toBe('string');
        expect(await imageUpdate({ enrollExpiresAt: null, lowerDigestObservedAt: null, lowerImageDigest: null,
            leaseUntil: null, presenceAt: null })).toMatchObject({ enrollExpiresAt: null, lowerDigestObservedAt: null,
            lowerImageDigest: null, leaseUntil: null, presenceAt: null });
    });

    it('binds the ordinary enrollment observation Date and consumes the nonce atomically', async () => {
        await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET state = 'STARTING'`);
        const observedAt = new Date('2026-10-22T12:31:00.456Z');
        const input = { computerId, expected: await current(), nonceHash, fields: { instanceId, volumeId },
            lowerImageDigest: digest, observedAt };
        expect((await consumeEnrollmentNonce(db, input)).ok).toBe(true);
        const p = await withAdmission(db, (tx, lock) => lockImagePlacement(tx, lock, computerId));
        expect(p).toMatchObject({ lowerImageDigest: digest, lowerDigestObservedAt: observedAt,
            enrollNonceHash: null, enrollConsumedHash: nonceHash });
        expect(await consumeEnrollmentNonce(db, input)).toEqual({ ok: false, reason: 'cas_conflict' });
        expect(await current()).toMatchObject({ enrollConsumedHash: nonceHash });
    });

    it('writes whole milliseconds on placement creation', async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_computer_placements`);
        const result = await createPlacement(db, { computerId, ownerUserId, provider: 'cloudflare', state: 'STOPPED',
            fields: { presenceAt: new Date('2026-10-22T12:00:00.123Z') } });
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.placement.updatedAt).toEqual(await nativeTimestamp());
        expect((await current()).presenceAt).toEqual(new Date('2026-10-22T12:00:00.123Z'));
    });

    it('normalizes a legacy microsecond write before exact generation CAS, with one concurrent winner', async () => {
        // A future timestamp with known nonzero microseconds makes the precision
        // and monotonicity regression deterministic, independent of clock timing.
        await client!.unsafe(`UPDATE ${schema}.ezil_computer_placements SET updated_at = '2099-01-01 00:00:00.123901+00'`);
        const expected = await start();
        expect(expected.updatedAt.toISOString()).toBe('2099-01-01T00:00:00.124Z');
        const results = await Promise.all(Array.from({ length: 8 }, () => reconcileReplacementGeneration(db, expected, confirmed)));
        expect(results.filter(r => r.ok)).toHaveLength(1);
        expect(results.filter(r => !r.ok)).toEqual(Array.from({ length: 7 }, () => ({ ok: false, reason: 'cas_conflict' })));
        expect(await current()).toMatchObject({ state: 'STOPPED', generation: 1, leaseEpoch: 4,
            lifecycleJobId: null, lifecycleDigest: null, enrollNonceHash: null, enrollConsumedHash: null });
        expect(await nativeTimestamp()).toEqual(new Date('2099-01-01T00:00:00.125Z'));
        expect(await reconcileReplacementGeneration(db, expected, confirmed)).toEqual({ ok: false, reason: 'cas_conflict' });
    });

    it('image writes in one transaction invalidate a same-state generation snapshot', async () => {
        const expected = await start();
        await withAdmission(db, async (tx, lock) => {
            let p = (await lockImagePlacement(tx, lock, computerId))!;
            const first = await nativeTimestamp(tx);
            await writeImagePlacement(tx, lock, p, { lastError: 'first observation' });
            const second = await nativeTimestamp(tx);
            p = (await lockImagePlacement(tx, lock, computerId))!;
            await writeImagePlacement(tx, lock, p, { lastError: 'second observation' });
            const third = await nativeTimestamp(tx);
            expect(second.getTime()).toBeGreaterThan(first.getTime());
            expect(third.getTime()).toBe(second.getTime() + 1);
        });
        expect(await current()).toMatchObject({ state: expected.state, generation: expected.generation, leaseEpoch: expected.leaseEpoch });
        expect(await reconcileReplacementGeneration(db, expected, confirmed)).toEqual({ ok: false, reason: 'cas_conflict' });
        expect((await reconcileReplacementGeneration(db, await current(), confirmed)).ok).toBe(true);
    });

    it('reservation writes advance whole milliseconds and invalidate a stale generation snapshot', async () => {
        const expected = await start();
        await withAdmission(db, async (tx, lock) => {
            let p = (await lockImagePlacement(tx, lock, computerId))!;
            await setImageReservation(tx, lock, p, jobId);
            const reservedAt = await nativeTimestamp(tx);
            p = (await lockImagePlacement(tx, lock, computerId))!;
            await setImageReservation(tx, lock, p, null);
            expect((await nativeTimestamp(tx)).getTime()).toBe(reservedAt.getTime() + 1);
        });
        expect(await reconcileReplacementGeneration(db, expected, confirmed)).toEqual({ ok: false, reason: 'cas_conflict' });
        expect((await reconcileReplacementGeneration(db, await current(), confirmed)).ok).toBe(true);
    });

    it('preserves every generation and owner guard after timestamp normalization', async () => {
        const expected = await start();
        const mismatches: Partial<Placement>[] = [{ ownerUserId: jobId }, { generation: 3 }, { leaseEpoch: 5 }, { state: 'MOUNTING' },
            { lifecycleJobId: fenceToken }, { lifecycleDigest: 'd'.repeat(64) }, { fenceToken: jobId }, { volumeId: 'vol-22222222222222222' },
            { updatedAt: new Date(expected.updatedAt.getTime() - 1) }];
        for (const mismatch of mismatches) {
            expect(await reconcileReplacementGeneration(db, { ...expected, ...mismatch }, confirmed)).toEqual({ ok: false, reason: 'cas_conflict' });
            expect(await current()).toEqual(expected);
        }
        expect((await reconcileReplacementGeneration(db, expected, confirmed)).ok).toBe(true);
    });

    it('keeps image owner and epoch guards with normalized Date binds', async () => {
        await withAdmission(db, async (tx, lock) => {
            const p = (await lockImagePlacement(tx, lock, computerId))!;
            for (const mismatch of [{ ownerUserId: jobId }, { leaseEpoch: p.leaseEpoch + 1 }, { fenceToken: jobId }])
                await expect(writeImagePlacement(tx, lock, { ...p, ...mismatch }, { presenceAt: new Date() })).rejects.toThrow('image_job_conflict');
            expect(await lockImagePlacement(tx, lock, computerId)).toEqual(p);
        });
    });
});
