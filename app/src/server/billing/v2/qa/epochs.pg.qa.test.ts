/**
 * QA: epoch store semantics against a real Postgres (CONTRACT-v2 §2 Epoch; §5 sessions).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { BillingStore } from '../../ports';
import { rateWindow } from '../rating';
import { NOW, START, connect, seedTenant, tenant, type Database, type Tenant } from './harness';

const H = 3600 * 1000;
const W = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('qa epochs (Postgres)', () => {
    let conn: ReturnType<typeof connect>;
    let db: Database;
    let store: BillingStore;
    let a: Tenant;
    let b: Tenant;

    beforeAll(() => { conn = connect(); db = conn.db as Database; store = conn.store; });
    beforeEach(async () => {
        await conn.client`begin`;
        a = tenant(); b = tenant();
        await seedTenant(conn.client, db, store, a);
        await seedTenant(conn.client, db, store, b);
    });
    afterEach(async () => { await conn.client`rollback`; });
    afterAll(async () => { await conn.client?.end(); });

    const open = (o: Tenant, readyAt: Date, size: 'std-2' | 'cmp-4' | 'cmp-8' = 'cmp-4', computerId = o.computerId) =>
        store.openEpoch({ userId: o.userId, computerId, subscriptionId: o.subscriptionId, size, readyAt });
    const used = async (o: Tenant, now = NOW) => rateWindow({ epochs: await store.epochsFor(o.userId, START), window: W, now: now.toISOString() });

    it('stores instants rounded in the customer\'s favour (ready up, end down)', async () => {
        await open(a, new Date('2026-10-02T00:00:00.400Z'));
        await store.closeEpoch({ computerId: a.computerId, endedAt: new Date('2026-10-02T01:00:00.900Z'), reason: 'user_stop' });
        const [e] = await store.epochsFor(a.userId, START);
        expect([e.readyAt, e.endedAt]).toEqual(['2026-10-02T00:00:01Z', '2026-10-02T01:00:00Z']);
        expect((await used(a)).stdSeconds).toBe(3599 * 2);
    });

    it('a late close for an already closed epoch does not move its end', async () => {
        await open(a, new Date('2026-10-02T00:00:00Z'));
        expect(await store.closeEpoch({ computerId: a.computerId, endedAt: new Date('2026-10-02T01:00:00Z'), reason: 'user_stop' })).toBe('closed');
        expect(await store.closeEpoch({ computerId: a.computerId, endedAt: new Date('2026-10-02T05:00:00Z'), reason: 'session_max' })).toBe('not_open');
        const [e] = await store.epochsFor(a.userId, START);
        expect([e.endedAt, e.endReason]).toEqual(['2026-10-02T01:00:00Z', 'user_stop']);
        expect((await used(a)).stdSeconds).toBe(7_200);
    });

    it('a stop stamped before ready never yields negative or positive usage', async () => {
        await open(a, new Date('2026-10-02T00:00:00Z'));
        await store.closeEpoch({ computerId: a.computerId, endedAt: new Date('2026-10-01T00:00:00Z'), reason: 'platform_failure' });
        expect((await used(a)).stdSeconds).toBe(0);
    });

    it('a duplicate ready while open keeps the original epoch (no second open epoch, no moved readyAt)', async () => {
        await open(a, new Date('2026-10-02T00:00:00Z'));
        const again = await open(a, new Date('2026-10-02T03:00:00Z'), 'cmp-8');
        expect(again.status).toBe('exists');
        expect([again.epoch.readyAt, again.epoch.size]).toEqual(['2026-10-02T00:00:00Z', 'cmp-4']);
        expect(await store.epochsFor(a.userId, START)).toHaveLength(1);
    });

    it('overhead is recorded but never billed', async () => {
        await open(a, new Date('2026-10-02T00:00:00Z'), 'std-2');
        await store.closeEpoch({ computerId: a.computerId, endedAt: new Date('2026-10-02T01:00:00Z'), reason: 'user_stop', overheadSeconds: 5_000 });
        const [e] = await store.epochsFor(a.userId, START);
        expect(e.overheadSeconds).toBe(5_000);
        expect((await used(a)).stdSeconds).toBe(3_600);
    });

    it('epochs of another user never count, and a user cannot open an epoch on another user\'s computer', async () => {
        await open(b, new Date('2026-10-02T00:00:00Z'), 'cmp-8');
        await store.closeEpoch({ computerId: b.computerId, endedAt: new Date('2026-10-02T06:00:00Z'), reason: 'session_max' });
        await expect(open(a, new Date('2026-10-03T00:00:00Z'), 'cmp-8', b.computerId)).rejects.toThrow();
        expect(await store.epochsFor(a.userId, START)).toEqual([]);
        expect((await used(a)).stdSeconds).toBe(0);
        expect((await used(b)).stdSeconds).toBe(21_600 * 4);
    });

    it('a size the DB does not know, or a weight that does not match, is refused by the schema', async () => {
        await expect(open(a, new Date('2026-10-02T00:00:00Z'), 'gpu-1' as never)).rejects.toThrow();
        await conn.client`rollback`; await conn.client`begin`;
        a = tenant(); await seedTenant(conn.client, db, store, a);
        await expect(conn.client`insert into ezil_billing_compute_epochs (user_id, computer_id, size, weight, ready_at)
            values (${a.userId}::uuid, ${a.computerId}::uuid, 'cmp-8', 1, now())`).rejects.toThrow();
    });
});

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('qa epochs: concurrent ready for one computer (two connections, committed)', () => {
    it('two racing readies for the same computer open exactly one epoch', async () => {
        const one = connect();
        const two = connect();
        try {
            const o = tenant();
            await seedTenant(one.client, one.db as Database, one.store, o);
            for (let round = 0; round < 10; round++) {
                const ready = new Date(Date.UTC(2026, 9, 2 + round));
                const results = await Promise.all([one, two].map(c => c.store.openEpoch({
                    userId: o.userId, computerId: o.computerId, subscriptionId: null, size: 'std-2', readyAt: ready,
                })));
                expect(results.map(r => r.status).sort()).toEqual(['exists', 'opened']);
                expect(new Set(results.map(r => r.epoch.id)).size).toBe(1);
                await one.store.closeEpoch({ computerId: o.computerId, endedAt: new Date(ready.getTime() + H), reason: 'user_stop' });
            }
            expect(await one.store.epochsFor(o.userId, START)).toHaveLength(10);
        } finally {
            await one.client.end();
            await two.client.end();
        }
    });
});
