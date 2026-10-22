/** Disposable Postgres only. Isolate BOTH SQL files in a suite-owned schema so
 * parallel placement tests never lose their public tables. No AWS calls. */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PgDialect } from 'drizzle-orm/pg-core';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PlacementDb, PlacementExecutor } from './placement';
import { insertPoolHost, leasePoolHost, releasePoolHost, type PoolExecutor, type PoolInstanceType } from './ready-pool';

const PG = process.env.EZIL_PG_TEST_URL;
const NOW = new Date('2026-10-19T12:00:00Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const schema = `ready_pool_r6_${randomUUID().replaceAll('-', '')}`;
const tables = ['ezil_compute_pool_hosts', 'ezil_compute_writer_leases', 'ezil_computer_placements', 'ezil_compute_usage'];

describe.skipIf(!PG)('ready pool on disposable Postgres', () => {
    const client = PG ? postgres(PG, { max: 16, onnotice: () => {} }) : null;
    const dialect = new PgDialect();
    const localSql = (s: string) => s.replaceAll('public.', `${schema}.`);
    const executor = (c: { unsafe: (q: string, params: never[]) => PromiseLike<unknown> }): PlacementExecutor => ({ execute: async query => {
        const statement = dialect.sqlToQuery(query);
        return c.unsafe(localSql(statement.sql), statement.params as never[]);
    } });
    const db: PlacementDb = { execute: q => executor(client!).execute(q), transaction: async fn =>
        client!.begin(tx => fn(executor(tx))) as Promise<Awaited<ReturnType<typeof fn>>> };
    let created = false;
    beforeAll(async () => {
        await client!.unsafe(`DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
            DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;`);
        await client!.unsafe(`CREATE SCHEMA ${schema}`);
        created = true;
        for (const file of ['0001_compute_placement.sql.txt', '0002_ready_pool.sql.txt', '0002_image_rebase.sql.txt']) {
            await client!.unsafe(localSql(readFileSync(path.resolve(__dirname, '../../../../../docs/aws-computers/sql', file), 'utf8')));
        }
    });
    beforeEach(async () => {
        await client!.unsafe(`TRUNCATE ${schema}.ezil_compute_pool_hosts, ${schema}.ezil_compute_writer_leases`);
    });
    afterAll(async () => {
        try {
            if (created) {
                await client!.unsafe(`DROP SCHEMA ${schema} CASCADE`);
            }
        } finally { await client?.end(); }
    });

    async function host(n: number, overrides: {
        state?: string; health?: string; editorReadyAt?: Date | null; region?: string; instanceType?: string; generation?: number;
    } = {}) {
        await insertPoolHost(db, {
            id: uuid(n), region: overrides.region ?? 'ap-south-1', zoneId: 'aps1-az1', instanceId: `i-${n}`,
            instanceType: (overrides.instanceType ?? 'm6i.large') as PoolInstanceType,
            state: overrides.state ?? 'ready', health: overrides.health ?? 'healthy',
            editorReadyAt: overrides.editorReadyAt === null ? null : overrides.editorReadyAt ?? NOW,
            generation: overrides.generation, now: NOW,
        });
    }
    const lease = (n: number) => leasePoolHost(db, { region: 'ap-south-1', instanceType: 'm6i.large', computerId: uuid(100 + n), now: NOW });
    const rows = () => client!.unsafe(`SELECT * FROM ${schema}.ezil_compute_pool_hosts ORDER BY id`);

    it.each([1, 3])('16 concurrent callers on %i ready hosts yield exactly that many distinct winners', async count => {
        for (let i = 1; i <= count; i++) await host(i);
        const results = await Promise.all(Array.from({ length: 16 }, (_, i) => lease(i)));
        const winners = results.filter(r => r !== null);
        expect(winners).toHaveLength(count);
        expect(results.filter(r => r === null)).toHaveLength(16 - count);
        expect(new Set(winners.map(r => r.id)).size).toBe(count);
        expect(new Set(winners.map(r => r.leaseToken)).size).toBe(count);
        for (const winner of winners) expect(winner).toMatchObject({ state: 'leased', generation: 2, leasedGeneration: 1, leasedAt: NOW });
        for (const row of await rows()) {
            expect(row.state).toBe('leased');
            expect(Number(row.generation)).toBe(2);
            expect(Number(row.leased_generation)).toBe(1);
            const winner = winners.find(w => w.id === row.id)!;
            expect(row.lease_token).toBe(winner.leaseToken);
            expect(row.leased_computer_id).toBe(winner.leasedComputerId);
        }
    });

    it('never leases unhealthy, unknown-health, editor-not-ready, wrong type/region or non-ready hosts', async () => {
        const excluded = [
            { health: 'unhealthy' }, { health: 'unknown' }, { editorReadyAt: null },
            { instanceType: 'm6i.xlarge' }, { region: 'us-east-1' },
            { state: 'booting' }, { state: 'draining' }, { state: 'retired' },
        ];
        for (let i = 0; i < excluded.length; i++) await host(i + 1, excluded[i]);
        const before = await rows();
        expect(await Promise.all(Array.from({ length: 16 }, (_, i) => lease(i)))).toEqual(Array(16).fill(null));
        expect(await rows()).toEqual(before);
    });

    it('leases the earliest editor-ready host, breaking ties by id', async () => {
        await host(1);
        await host(3, { editorReadyAt: new Date(NOW.getTime() - 1_000) });
        await host(2, { editorReadyAt: new Date(NOW.getTime() - 1_000) });
        expect((await lease(1))?.id).toBe(uuid(2));
        expect((await lease(2))?.id).toBe(uuid(3));
    });

    it('stale generation or token changes nothing; the exact holder drains once', async () => {
        await host(1);
        const winner = (await lease(1))!;
        const before = await rows();
        expect(await releasePoolHost(db, { ...winner, generation: winner.generation - 1 })).toBe('fenced');
        expect(await rows()).toEqual(before);
        expect(await releasePoolHost(db, { ...winner, generation: winner.generation + 1 })).toBe('fenced');
        expect(await rows()).toEqual(before);
        expect(await releasePoolHost(db, { ...winner, leaseToken: uuid(999) })).toBe('fenced');
        expect(await rows()).toEqual(before);
        expect(await releasePoolHost(db, winner)).toBe('released');
        expect((await rows())[0]).toMatchObject({ state: 'draining', leased_computer_id: null, leased_generation: null, lease_token: null, leased_at: null });
        expect(await releasePoolHost(db, winner)).toBe('fenced');
        expect(await lease(2)).toBeNull();
    });

    it('validates host writes before SQL and refuses corrupted lease candidates', async () => {
        await expect(host(1, { state: 'leased' })).rejects.toThrow('pool_state_invalid');
        await expect(host(2, { instanceType: 't3.medium' })).rejects.toThrow('pool_class_invalid');
        await expect(host(3, { region: 'ap-south-1;invalid' })).rejects.toThrow('pool_class_invalid');
        await expect(host(4, { health: 'invalid' })).rejects.toThrow('pool_health_invalid');
        await expect(host(5, { generation: 0 })).rejects.toThrow('pool_generation_invalid');
        expect(await rows()).toEqual([]);
        await host(6);
        await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET lease_token = $1::uuid`, [uuid(99)]);
        const before = await rows();
        expect(await lease(1)).toBeNull();
        expect(await rows()).toEqual(before);
    });

    it.each([0, -1, Number.MAX_SAFE_INTEGER])('never leases an invalid or overflowing generation %s', async generation => {
        await host(1);
        await client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET generation = $1`, [generation]);
        const before = await rows();
        expect(await lease(1)).toBeNull();
        expect(await rows()).toEqual(before);
    });

    it('preserves non-null unique host keys and instance identities', async () => {
        await host(1);
        await expect(host(1)).rejects.toMatchObject({ code: '23505' });
        await expect(client!.unsafe(`INSERT INTO ${schema}.ezil_compute_pool_hosts
            SELECT $1::uuid, region, zone_id, instance_id, instance_type, state, health, editor_ready_at,
                generation, leased_computer_id, leased_generation, lease_token, leased_at, created_at, updated_at
            FROM ${schema}.ezil_compute_pool_hosts`, [uuid(2)])).rejects.toMatchObject({ code: '23505' });
        await expect(client!.unsafe(`UPDATE ${schema}.ezil_compute_pool_hosts SET id = NULL`)).rejects.toMatchObject({ code: '23502' });
    });

    it('the writer lease is global per computer, even across different regions', async () => {
        const insert = (region: string) => client!.unsafe(`INSERT INTO ${schema}.ezil_compute_writer_leases
            (computer_id, region, generation, holder, expires_at) VALUES ($1::uuid, $2, 1, 'operator', $3::timestamptz)`,
        [uuid(1), region, NOW.toISOString()]);
        await insert('ap-south-1');
        await expect(insert('us-east-1')).rejects.toMatchObject({ code: '23505' });
    });
});
