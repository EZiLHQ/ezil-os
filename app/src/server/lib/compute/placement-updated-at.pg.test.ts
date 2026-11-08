/** Disposable PostgreSQL, production drizzle(postgres-js) codecs; no app DB/credential imports. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SQL, StringChunk, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ENROLLMENT_FAILED, ImageJobConflictError, failStalledPoolEnrollment, lockPoolClaimPlacement,
    publishAttachedPoolClaim, readPlacement, savePoolEnrollmentNonce, withAdmission, writeLivePoolRecovery,
    type Placement, type PlacementDb, type PlacementExecutor } from './placement';

const PG = process.env.EZIL_PG_TEST_URL;
const schema = `placement_ms_${randomUUID().replaceAll('-', '')}`;
const directory = path.resolve(__dirname, '../../../../../docs/aws-computers/sql');
const computerId = randomUUID(), ownerUserId = randomUUID(), poolHostId = randomUUID();
const fenceToken = randomUUID(), lifecycleJobId = randomUUID(), lifecycleDigest = 'a'.repeat(64);
const instanceId = `i-${randomUUID().replaceAll('-', '').slice(0, 17)}`, volumeId = 'vol-test';
// Future values make fractional precision and next-millisecond rollover independent of wall time.
const LEGACY = '2099-01-01T00:00:00.123901Z';
const nonce = { nonceHash: 'b'.repeat(64), expiresAt: new Date('2099-01-01T00:10:00Z') };
const conflict = { ok: false, reason: 'cas_conflict' };

describe('placement updated_at writer pins', () => {
    const source = readFileSync(path.join(__dirname, 'placement.ts'), 'utf8');
    it('never uses clock_timestamp() in a placement UPDATE', () => {
        const updates = source.match(/UPDATE public\.ezil_computer_placements\b[\s\S]*?RETURNING/g) ?? [];
        expect(updates.length).toBeGreaterThan(0);
        expect(updates).toHaveLength((source.match(/UPDATE public\.ezil_computer_placements\b/g) ?? []).length);
        for (const update of updates) expect(update).not.toMatch(/clock_timestamp\s*\(/i);
    });
    it('saves the pool nonce with PLACEMENT_UPDATE_TIME', () => {
        const writer = source.split('export async function savePoolEnrollmentNonce(')[1]?.split('\nexport ')[0];
        expect(writer).toContain('updated_at = ${PLACEMENT_UPDATE_TIME}');
    });
});

describe.skipIf(!PG)('placement updated_at millisecond CAS on PostgreSQL', () => {
    const options = { max: 4, idle_timeout: 20, connect_timeout: 5, prepare: false,
        connection: { TimeZone: 'Asia/Kolkata' }, onnotice: () => {} };
    const client = PG ? postgres(PG, options) : null;
    const local = (q: string) => q.replaceAll('public.', `${schema}.`).replaceAll('auth.users', `${schema}.test_users`);
    const scoped = (q: SQL): SQL => sql.join(q.queryChunks.map(chunk => chunk instanceof StringChunk
        ? sql.raw(local(chunk.value.join(''))) : chunk instanceof SQL ? scoped(chunk) : chunk), sql.empty());
    const executor = (source: Pick<ReturnType<typeof drizzle>, 'execute'>): PlacementExecutor => ({ execute: q => source.execute(scoped(q)) });
    const database = (connection: ReturnType<typeof postgres>): PlacementDb => {
        const production = drizzle(connection);
        return { execute: q => executor(production).execute(q), transaction: fn => production.transaction(tx => fn(executor(tx))) };
    };
    const db = client ? database(client) : null;
    const current = async (tx: PlacementExecutor = db!) => (await readPlacement(tx, computerId)).record!;
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`); created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_image_rebase.sql.txt', '0002_ready_pool.sql.txt', '0003_pool_hosts_v2.sql.txt'])
            await client!.unsafe(local(readFileSync(path.join(directory, file), 'utf8')));
        await client!.unsafe(`CREATE TABLE ${schema}.ezil_computers
            (id uuid PRIMARY KEY, user_id uuid NOT NULL, deleted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now())`);
    });
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_computer_placements, ${schema}.ezil_compute_usage,
            ${schema}.ezil_computer_image_jobs, ${schema}.ezil_compute_pool_hosts, ${schema}.ezil_computers`);
    });
    afterAll(async () => { try { if (created) await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`); } finally { await client?.end(); } });

    async function seed(at = LEGACY) {
        await db!.execute(sql`INSERT INTO public.ezil_computers (id, user_id) VALUES (${computerId}::uuid, ${ownerUserId}::uuid)`);
        await db!.execute(sql`INSERT INTO public.ezil_computer_placements
            (computer_id, owner_user_id, provider, workspace_store, generation, lease_epoch, state, region, zone_id,
             instance_id, instance_type, volume_id, fence_token, lifecycle_job_id, lifecycle_digest, last_error, updated_at)
            VALUES (${computerId}::uuid, ${ownerUserId}::uuid, 'aws-ec2', 'ebs', 3, 4, 'STARTING', 'ap-south-1', 'aps1-az1',
                ${instanceId}, 'm6i.large', ${volumeId}, ${fenceToken}::uuid, ${lifecycleJobId}::uuid, ${lifecycleDigest}, 'pool_adopt', ${at}::timestamptz)`);
        await db!.execute(sql`INSERT INTO public.ezil_compute_pool_hosts
            (id, region, zone_id, instance_id, instance_type, state, leased_computer_id, leased_at,
             claim_generation, claim_lease_epoch, claim_fence, claim_volume_serial)
            VALUES (${poolHostId}::uuid, 'ap-south-1', 'aps1-az1', ${instanceId}, 'm6i.large', 'leased', ${computerId}::uuid,
                ${at}::timestamptz, 3, 4, ${fenceToken}, ${volumeId.replaceAll('-', '')})`);
        return current();
    }
    async function stamp(tx: PlacementExecutor = db!) {
        const [row] = await tx.execute(sql`SELECT extract(microseconds FROM updated_at)::int AS micros,
            (extract(epoch FROM updated_at) * 1000000)::bigint::text AS epoch,
            to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS value
            FROM public.ezil_computer_placements WHERE computer_id = ${computerId}::uuid`) as { micros: number; epoch: string; value: string }[];
        return { micros: row!.micros, epoch: BigInt(row!.epoch), value: row!.value };
    }
    function advanced(before: Awaited<ReturnType<typeof stamp>>, after: Awaited<ReturnType<typeof stamp>>) {
        expect(after.micros % 1000).toBe(0);
        expect(after.epoch).toBeGreaterThan(before.epoch);
        expect(after.epoch).toBe(before.epoch / BigInt(1000) * BigInt(1000) + BigInt(1000));
    }
    const fail = (p: Placement, store = db!) => failStalledPoolEnrollment(store, p, async tx => {
        const rows = await tx.execute(sql`SELECT id FROM public.ezil_compute_pool_hosts
            WHERE id = ${poolHostId}::uuid AND state = 'leased' AND leased_computer_id = ${computerId}::uuid
                AND instance_id = ${instanceId} AND claim_generation = 3 AND claim_lease_epoch = 4 AND claim_fence = ${fenceToken}
            FOR UPDATE`) as unknown[];
        return rows.length === 1;
    }, tx => tx.execute(sql`UPDATE public.ezil_compute_pool_hosts SET state = 'retiring' WHERE id = ${poolHostId}::uuid`));
    const save = () => withAdmission(db!, async tx => {
        const p = (await lockPoolClaimPlacement(tx, computerId))!;
        expect(await savePoolEnrollmentNonce(tx, p, nonce)).toBe(true);
    });
    const saveOld = () => withAdmission(db!, async tx => {
        const p = (await lockPoolClaimPlacement(tx, computerId))!;
        const rows = await tx.execute(sql`UPDATE public.ezil_computer_placements
            SET enroll_nonce_hash = ${nonce.nonceHash}, enroll_expires_at = ${nonce.expiresAt.toISOString()}::timestamptz,
                updated_at = greatest(updated_at + interval '1 millisecond', clock_timestamp())
            WHERE computer_id = ${p.computerId}::uuid AND generation = ${p.generation} AND lease_epoch = ${p.leaseEpoch}
                AND instance_id = ${p.instanceId} AND enroll_consumed_hash IS NULL AND enroll_nonce_hash IS NULL
            RETURNING computer_id`) as unknown[];
        expect(rows).toHaveLength(1);
    });

    it('1: transitions a legacy fractional snapshot without normalizing it first', async () => {
        const p = await seed(), before = await stamp();
        expect(before.micros).toBe(123901);
        expect(p.updatedAt.toISOString()).toBe('2099-01-01T00:00:00.123Z');
        expect(await fail(p)).toMatchObject({ ok: true, placement: { state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED } });
        advanced(before, await stamp());
        expect((await stamp()).value).toBe('2099-01-01T00:00:00.124000Z');
        expect(await current()).toMatchObject({ state: 'UNCONFIRMED', lastError: ENROLLMENT_FAILED });
        const hosts = await db!.execute(sql`SELECT state FROM public.ezil_compute_pool_hosts WHERE id = ${poolHostId}::uuid`);
        expect(hosts).toMatchObject([{ state: 'retiring' }]);
    });
    it('2: transitions a re-read snapshot after the old microsecond nonce writer', async () => {
        await seed(); await saveOld();
        const before = await stamp();
        expect(before.micros).toBe(124901);
        expect(await fail(await current())).toMatchObject({ ok: true, placement: { state: 'UNCONFIRMED' } });
        advanced(before, await stamp());
    });
    it('3: the new nonce writer stores whole milliseconds, rejects the old snapshot and accepts the re-read', async () => {
        const stale = await seed(), before = await stamp();
        await save();
        const saved = await stamp();
        advanced(before, saved);
        expect(await fail(stale)).toEqual(conflict);
        expect(await stamp()).toEqual(saved);
        expect(await fail(await current())).toMatchObject({ ok: true });
        advanced(saved, await stamp());
    });
    it.each(['old', 'new'] as const)('4: a stale snapshot loses after the %s nonce writer', async writer => {
        const stale = await seed(), before = await stamp();
        await (writer === 'old' ? saveOld() : save());
        const saved = await stamp();
        expect(saved.epoch).toBeGreaterThan(before.epoch);
        expect(saved.micros % 1000).toBe(writer === 'old' ? 901 : 0);
        let published = false;
        await publishAttachedPoolClaim(db!, stale, volumeId, async () => { published = true; });
        expect(published).toBe(false);
        expect(await fail(stale)).toEqual(conflict);
        expect(await stamp()).toEqual(saved);
    });
    it('5: concurrent same-state CAS attempts on separate connections have exactly one winner', async () => {
        expect(await fail(await seed())).toMatchObject({ ok: true });
        const p = await current(), before = await stamp();
        const connections = [postgres(PG!, { ...options, max: 1 }), postgres(PG!, { ...options, max: 1 })];
        try {
            const pids = await Promise.all(connections.map(c => c`SELECT pg_backend_pid() AS pid`));
            expect(pids[0]![0]!.pid).not.toBe(pids[1]![0]!.pid);
            const results = await Promise.all(connections.map(c => writeLivePoolRecovery(database(c), p, 'UNCONFIRMED', {})));
            expect(results.filter(r => r.ok)).toHaveLength(1);
            expect(results.filter(r => !r.ok)).toEqual([conflict]);
            advanced(before, await stamp());
        } finally { await Promise.all(connections.map(c => c.end())); }
    });
    it('6: successive writes with fixed now() advance distinct milliseconds and refuse an intermediate snapshot', async () => {
        expect(await fail(await seed())).toMatchObject({ ok: true });
        await withAdmission(db!, async tx => {
            const store: PlacementDb = { execute: q => tx.execute(q), transaction: fn => fn(tx) };
            const clock = await tx.execute(sql`SELECT now()::text AS value`), before = await stamp(tx);
            expect(await writeLivePoolRecovery(store, await current(tx), 'UNCONFIRMED', {})).toMatchObject({ ok: true });
            const intermediate = await current(tx), first = await stamp(tx);
            advanced(before, first);
            expect(await writeLivePoolRecovery(store, intermediate, 'UNCONFIRMED', {})).toMatchObject({ ok: true });
            const second = await stamp(tx);
            advanced(first, second);
            expect(await writeLivePoolRecovery(store, intermediate, 'UNCONFIRMED', {})).toEqual(conflict);
            expect(await stamp(tx)).toEqual(second);
            expect(await tx.execute(sql`SELECT now()::text AS value`)).toEqual(clock);
        });
    });
    it.each([
        ['second', '2099-01-01T00:00:00.999901+05:30', '2098-12-31T18:30:01.000000Z'],
        ['minute', '2099-01-01T00:00:59.999901+05:30', '2098-12-31T18:31:00.000000Z'],
        ['day', '2099-01-01T23:59:59.999901+05:30', '2099-01-01T18:30:00.000000Z'],
    ])('7: rolls over the %s boundary in a non-UTC session', async (_, at, expected) => {
        const p = await seed(at), before = await stamp();
        expect(before.micros % 1000000).toBe(999901);
        await withAdmission(db!, async tx => {
            expect(await tx.execute(sql`SELECT current_setting('TimeZone') AS zone`)).toMatchObject([{ zone: 'Asia/Kolkata' }]);
            const store: PlacementDb = { execute: q => tx.execute(q), transaction: fn => fn(tx) };
            expect(await fail(p, store)).toMatchObject({ ok: true });
            const after = await stamp(tx);
            advanced(before, after);
            expect(after.value).toBe(expected);
        });
    });
    it.each([
        ['lease epoch', { leaseEpoch: 5 }], ['fence', { fenceToken: randomUUID() }],
        ['job id', { lifecycleJobId: randomUUID() }], ['digest', { lifecycleDigest: 'c'.repeat(64) }],
        ['lastError', { lastError: 'wrong' }],
    ] satisfies [string, Partial<Placement>][])('8: refuses a wrong %s on a fractional row with a matching timestamp', async (_, mismatch) => {
        const p = await seed(), before = await stamp();
        expect(before.micros).toBe(123901);
        let published = false;
        await publishAttachedPoolClaim(db!, { ...p, ...mismatch }, volumeId, async () => { published = true; });
        expect(published).toBe(false);
        expect(await fail({ ...p, ...mismatch })).toEqual(conflict);
        expect(await stamp()).toEqual(before);
        expect(await fail(p)).toMatchObject({ ok: true });
        advanced(before, await stamp());
    });
    it('8: refuses an image reservation on a fractional row with a matching timestamp', async () => {
        const p = await seed(), before = await stamp();
        expect(before.micros).toBe(123901);
        await db!.execute(sql`UPDATE public.ezil_computer_placements SET image_upgrade_job_id = ${randomUUID()}::uuid
            WHERE computer_id = ${computerId}::uuid`);
        await expect(fail(p)).rejects.toBeInstanceOf(ImageJobConflictError);
        await expect(publishAttachedPoolClaim(db!, p, volumeId, async () => {})).rejects.toBeInstanceOf(ImageJobConflictError);
        expect(await stamp()).toEqual(before);
    });
});
