/** Disposable PostgreSQL only; never imports the app DB or reads credentials. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
    consumeEnrollmentNonce, createPlacement, lockImagePlacement, readPlacement, reconcileReplacementGeneration,
    setImageReservation, transitionPlacement, withAdmission, writeImagePlacement,
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
