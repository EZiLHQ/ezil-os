import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { parsePoolConfig } from './config';
import { claim, markReady, reapExpired, refillPlan, release, type PoolDb, type PoolExecutor, type PoolSlot } from './lease';
import type { EntitlementSource } from './entitlement-source';

const subscriber: EntitlementSource = { getPlan: async () => ({ plan: 'subscriber', periodEnd: '2099-01-01' }) };
const free: EntitlementSource = { getPlan: async () => ({ plan: 'free', periodEnd: null }) };
const enabled = parsePoolConfig({ POOL_TARGET_STANDARD: '4', POOL_TARGET_PERFORMANCE: '2', POOL_MAX_TOTAL: '8' });
const input = (userId = randomUUID(), computerId = randomUUID()) => ({ shape: 'standard' as const, userId, computerId });

type Transaction = { writes: Map<string, PoolSlot>; locks: Map<string, () => void> };

/** Local model of READ COMMITTED, transaction advisory locks, SKIP LOCKED,
 * unique-index waits and rollback. It interprets the production SQL, never a
 * second claim/refill API. SQL assertions below pin the interpreted predicates. */
class MemoryPoolDb implements PoolDb {
    slots = new Map<string, PoolSlot>();
    statements: { sql: string; params: unknown[] }[] = [];
    private locks = new Map<string, Promise<void>>();

    seed(state: PoolSlot['state'] = 'ready', shape: PoolSlot['shape'] = 'standard', ageSeconds = 0) {
        const id = randomUUID();
        const row: PoolSlot = { id, state, shape, sandbox_id: `pool-${id}`, created_at: new Date(),
            ready_at: new Date(Date.now() - ageSeconds * 1000), leased_at: null,
            lease_id: null, leased_to_user_id: null, leased_computer_id: null, last_error: null };
        this.slots.set(id, row);
        return row;
    }

    private async lock(tx: Transaction, key: string) {
        if (tx.locks.has(key)) return;
        const previous = this.locks.get(key);
        let unlock!: () => void;
        const held = new Promise<void>((resolve) => { unlock = resolve; });
        this.locks.set(key, held);
        if (previous) await previous;
        tx.locks.set(key, () => {
            if (this.locks.get(key) === held) this.locks.delete(key);
            unlock();
        });
    }

    async transaction<T>(work: (tx: PoolExecutor) => Promise<T>, config?: { isolationLevel: 'read committed' }): Promise<T> {
        if (config) expect(config.isolationLevel).toBe('read committed');
        const tx: Transaction = { writes: new Map(), locks: new Map() };
        try {
            const result = await work({ execute: (query) => this.run(query, tx) });
            for (const [id, row] of tx.writes) this.slots.set(id, row);
            return result;
        } finally {
            for (const unlock of tx.locks.values()) unlock();
        }
    }

    execute(query: SQL): Promise<unknown> {
        return this.transaction((tx) => Promise.resolve(tx.execute(query)));
    }

    // Simulate a different database transaction holding a row lock.
    async holdSlot(id: string) {
        const tx: Transaction = { writes: new Map(), locks: new Map() };
        await this.lock(tx, `row:${id}`);
        return () => { for (const unlock of tx.locks.values()) unlock(); };
    }

    private async run(query: SQL, tx: Transaction): Promise<unknown[]> {
        const compiled = new PgDialect().sqlToQuery(query);
        const statement = { sql: compiled.sql.replace(/\s+/g, ' ').trim(), params: compiled.params };
        this.statements.push(statement);
        const { sql: text, params: p } = statement;
        const current = () => [...new Map([...this.slots, ...tx.writes]).values()];
        const write = (row: PoolSlot, patch: Partial<PoolSlot>) => {
            const updated = { ...row, ...patch };
            tx.writes.set(row.id, updated);
            return updated;
        };
        if (text.startsWith('select pg_advisory_xact_lock')) {
            await this.lock(tx, `advisory:${p[0] ?? 'ezil_pool_refill'}`);
            return [];
        }
        if (text.startsWith('select shape, state, count(*)')) {
            const groups = new Map<string, { shape: string; state: string; count: number }>();
            for (const row of current().filter((row) => row.state !== 'destroyed')) {
                const key = `${row.shape}:${row.state}`;
                const group = groups.get(key) ?? { shape: row.shape, state: row.state, count: 0 };
                group.count++;
                groups.set(key, group);
            }
            return [...groups.values()];
        }
        if (text.startsWith('insert into')) {
            const [id, shape, sandboxId] = p as [string, PoolSlot['shape'], string];
            const row: PoolSlot = { id, shape, sandbox_id: sandboxId, state: 'warming',
                created_at: new Date(), ready_at: null, leased_at: null, lease_id: null,
                leased_to_user_id: null, leased_computer_id: null, last_error: null };
            tx.writes.set(row.id, row);
            return [row];
        }
        if (text.startsWith("update ezil_pool_slots set state = 'leased'")) {
            const [leaseId, userId, computerId, shape, ttl, isSubscriber, , reserve] = p as
                [string, string, string, PoolSlot['shape'], number, boolean, PoolSlot['shape'], number];
            const ready = current().filter((row) => row.state === 'ready' && row.shape === shape);
            if (!isSubscriber && ready.length <= reserve) return [];
            const row = ready.filter((slot) => new Date(slot.ready_at!).getTime() >= Date.now() - ttl * 1000)
                .sort((a, b) => +new Date(a.ready_at!) - +new Date(b.ready_at!))
                .find((slot) => !this.locks.has(`row:${slot.id}`));
            if (!row) return [];
            await this.lock(tx, `row:${row.id}`);
            for (const [key, field, constraint] of [
                [userId, 'leased_to_user_id', 'ezil_pool_slots_live_user_idx'],
                [computerId, 'leased_computer_id', 'ezil_pool_slots_live_computer_idx'],
            ] as const) {
                await this.lock(tx, `${field}:${key}`);
                if (current().some((slot) => slot.state === 'leased' && slot[field] === key)) {
                    throw Object.assign(new Error('unique lease conflict'), { code: '23505', constraint_name: constraint });
                }
            }
            return [write(row, { state: 'leased', lease_id: leaseId, leased_to_user_id: userId,
                leased_computer_id: computerId, leased_at: new Date() })];
        }
        if (text.startsWith("update ezil_pool_slots set state = 'ready'")) {
            const row = current().find((slot) => slot.id === p[0] && slot.state === 'warming');
            return row ? [write(row, { state: 'ready', ready_at: new Date() })] : [];
        }
        if (text.startsWith("update ezil_pool_slots set state = 'draining'")) {
            const selected = text.includes('where lease_id')
                ? current().filter((row) => row.lease_id === p[0] && row.leased_to_user_id === p[1]
                    && row.leased_computer_id === p[2] && ['leased', 'draining'].includes(row.state))
                : current().filter((row) => (row.state === 'draining' || (row.state === 'ready'
                    && +new Date(row.ready_at!) < Date.now() - Number(p[0]) * 1000)) && !this.locks.has(`row:${row.id}`));
            for (const row of selected) await this.lock(tx, `row:${row.id}`);
            return selected.map((row) => write(row, { state: 'draining' }));
        }
        if (text.includes("set state = 'destroyed'") || text.includes('set last_error')) {
            const row = current().find((slot) => slot.id === p[0] && slot.state === 'draining');
            return row ? [write(row, text.includes("state = 'destroyed'")
                ? { state: 'destroyed', last_error: null } : { last_error: 'sandbox_destroy_failed' })] : [];
        }
        throw new Error(`Unmodeled SQL: ${text}`);
    }
}

describe('atomic claims (production SQL and local locking model)', () => {
    it('refuses free performance claims on the server even when pooling is disabled', async () => {
        const db = new MemoryPoolDb();
        await expect(claim(db, parsePoolConfig({}), free, { ...input(), shape: 'performance' })).rejects.toThrow('subscription_required');
        expect(db.statements).toHaveLength(0);
    });

    it('does no pool reads or allocations by default', async () => {
        const db = new MemoryPoolDb();
        expect(await claim(db, parsePoolConfig({}), free, input())).toBeNull();
        expect(await refillPlan(db, parsePoolConfig({}))).toEqual([]);
        expect(await markReady(db, parsePoolConfig({}), randomUUID(), { desktopStream: true, codeServerHttpStatus: 200, relay: true })).toBeNull();
        expect(db.statements).toHaveLength(0);
    });

    it('never returns the same slot to concurrent claims and returns overflow when empty', async () => {
        const db = new MemoryPoolDb();
        for (let i = 0; i < 4; i++) db.seed();
        const results = await Promise.all(Array.from({ length: 12 }, () => claim(db, enabled, subscriber, input())));
        const leases = results.filter((slot) => slot !== null);
        expect(leases).toHaveLength(4);
        expect(new Set(leases.map((slot) => slot.id)).size).toBe(4);
        expect(new Set(leases.map((slot) => slot.lease_id)).size).toBe(4);
    });

    it.each(['user', 'computer'])('enforces one live lease per %s across concurrent shapes', async (key) => {
        const db = new MemoryPoolDb();
        db.seed(); db.seed('ready', 'performance');
        const first = input();
        const second = { ...input(key === 'user' ? first.userId : randomUUID(), key === 'computer' ? first.computerId : randomUUID()), shape: 'performance' as const };
        const results = await Promise.all([claim(db, enabled, subscriber, first), claim(db, enabled, subscriber, second)]);
        expect(results.filter(Boolean)).toHaveLength(1);
        expect([...db.slots.values()].filter((slot) => slot.state === 'ready')).toHaveLength(1);
    });

    it('skips a locked oldest slot', async () => {
        const db = new MemoryPoolDb();
        const oldest = db.seed('ready', 'standard', 10);
        const next = db.seed();
        const unlock = await db.holdSlot(oldest.id);
        try { expect((await claim(db, enabled, subscriber, input()))?.id).toBe(next.id); }
        finally { unlock(); }
    });

    it('protects the reserve, including two concurrent free claims above the threshold', async () => {
        const db = new MemoryPoolDb();
        db.seed(); db.seed();
        const claims = await Promise.all([claim(db, enabled, free, input()), claim(db, enabled, free, input())]);
        expect(claims.filter(Boolean)).toHaveLength(1);
        expect(await claim(db, enabled, free, input())).toBeNull();
        expect(await claim(db, enabled, subscriber, input())).not.toBeNull();
    });

    it('claims in one parameterized UPDATE with the required ordering and locks', async () => {
        const db = new MemoryPoolDb(); db.seed();
        await claim(db, enabled, subscriber, input());
        expect(db.statements).toHaveLength(2);
        expect(db.statements[0]!.sql).toMatch(/pg_advisory_xact_lock\(hashtext\(\$1\)\)/);
        expect(db.statements[1]!.sql).toMatch(/where id = \( select id from ezil_pool_slots where state = 'ready' and shape = \$\d+/);
        expect(db.statements[1]!.sql).toContain('order by ready_at for update skip locked limit 1');
        expect(db.statements[1]!.sql).toMatch(/select count\(\*\).*state = 'ready' and shape = \$\d+ \) > \$\d+/);
        expect(db.statements[1]!.sql).toContain("and state = 'ready' returning *");
    });

    it('propagates database failures other than the two live-lease constraints', async () => {
        for (const error of [new Error('database unavailable'), { code: '23505', constraint_name: 'ezil_pool_slots_lease_id_unique' }]) {
            const db: PoolDb = { execute: async () => [], transaction: async () => { throw error; } };
            await expect(claim(db, enabled, subscriber, input())).rejects.toBe(error);
        }
    });
});

describe('bounded refill', () => {
    it('reserves warming rows under the refill lock and never overshoots parallel targets', async () => {
        const db = new MemoryPoolDb(); db.seed(); db.seed('warming', 'performance');
        const plans = await Promise.all(Array.from({ length: 10 }, () => refillPlan(db, enabled)));
        expect(plans.flat()).toHaveLength(4);
        expect([...db.slots.values()].filter((row) => row.shape === 'standard')).toHaveLength(4);
        expect([...db.slots.values()].filter((row) => row.shape === 'performance')).toHaveLength(2);
        expect(plans.flat().every((row) => row.state === 'warming')).toBe(true);
        expect(db.statements[0]!.sql).toBe("select pg_advisory_xact_lock(hashtext('ezil_pool_refill'))");
        expect(db.statements.find((statement) => statement.sql.startsWith('select shape'))!.sql)
            .toContain("where state <> 'destroyed' group by shape, state");
        expect(new Set(plans.flat().map((row) => row.sandbox_id)).size).toBe(4);
    });

    it.each([3, 8, 100])('never exceeds configured total %s or hard ceiling eight, counting leased and draining', async (maxTotal) => {
        const db = new MemoryPoolDb(); db.seed('leased'); db.seed('draining'); db.seed('destroyed');
        const config = { ...enabled, maxTotal, targets: { standard: 100, performance: 100 } };
        await Promise.all(Array.from({ length: 5 }, () => refillPlan(db, config)));
        expect([...db.slots.values()].filter((row) => row.state !== 'destroyed')).toHaveLength(Math.min(maxTotal, 8));
    });

    it('does not insert when either bound is already exceeded', async () => {
        const db = new MemoryPoolDb();
        for (let i = 0; i < 9; i++) db.seed();
        expect(await refillPlan(db, enabled)).toEqual([]);
    });
});

describe('single-use lifecycle', () => {
    it.each([
        { desktopStream: false, codeServerHttpStatus: 200, relay: true },
        { desktopStream: true, codeServerHttpStatus: 503, relay: true },
        { desktopStream: true, codeServerHttpStatus: 200, relay: false },
    ])('requires all three readiness probes: %j', async (probes) => {
        const db = new MemoryPoolDb(); const slot = db.seed('warming');
        expect(await markReady(db, enabled, slot.id, probes)).toBeNull();
        expect(db.statements).toHaveLength(0);
    });

    it('destroys released slots and can never ready or claim them again', async () => {
        const db = new MemoryPoolDb(); const slot = db.seed('warming');
        const probes = { desktopStream: true, codeServerHttpStatus: 200, relay: true };
        expect((await markReady(db, enabled, slot.id, probes))?.state).toBe('ready');
        const owner = input(); const lease = (await claim(db, enabled, subscriber, owner))!;
        const destroy = vi.fn(async () => { expect(db.slots.get(slot.id)?.state).toBe('draining'); });
        expect((await release(db, { ...owner, leaseId: lease.lease_id! }, destroy))?.state).toBe('destroyed');
        expect(destroy).toHaveBeenCalledWith(slot.sandbox_id);
        expect(await markReady(db, enabled, slot.id, probes)).toBeNull();
        expect(await claim(db, enabled, subscriber, input())).toBeNull();
        expect(await release(db, { ...owner, leaseId: lease.lease_id! }, destroy)).toBeNull();
        expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('fences release by lease, user and computer, retaining capacity after failed teardown', async () => {
        const db = new MemoryPoolDb(); db.seed();
        const owner = input(); const lease = (await claim(db, enabled, subscriber, owner))!;
        const destroy = vi.fn(async () => { throw new Error('unconfirmed destruction'); });
        expect(await release(db, { ...owner, userId: randomUUID(), leaseId: lease.lease_id! }, destroy)).toBeNull();
        expect(destroy).not.toHaveBeenCalled();
        expect(await release(db, { ...owner, leaseId: lease.lease_id! }, destroy)).toBeNull();
        expect(db.slots.get(lease.id)).toMatchObject({ state: 'draining', last_error: 'sandbox_destroy_failed' });
        expect(await claim(db, enabled, subscriber, input())).toBeNull();
        expect((await reapExpired(db, enabled, async () => {}))[0]?.state).toBe('destroyed');
    });

    it('reaps expired ready slots, leaves warming/leased/fresh slots alone and retries draining slots', async () => {
        const db = new MemoryPoolDb();
        const expired = db.seed('ready', 'standard', 1801);
        const fresh = db.seed('ready', 'standard', 10);
        const leased = db.seed('leased', 'standard', 9000);
        const warming = db.seed('warming', 'standard', 9000);
        const draining = db.seed('draining');
        const destroy = vi.fn(async () => {});
        const reaped = await reapExpired(db, enabled, destroy);
        expect(new Set(reaped.map((row) => row.id))).toEqual(new Set([expired.id, draining.id]));
        expect([fresh, leased, warming].map((slot) => db.slots.get(slot.id)?.state)).toEqual(['ready', 'leased', 'warming']);
        expect(destroy).toHaveBeenCalledTimes(2);
        expect(db.statements[0]!.sql).toContain("state = 'ready' and ready_at < now() - $1 * interval '1 second'");
        expect(db.statements[0]!.sql).toContain('for update skip locked');
    });

    it('never claims an expired slot even before the reaper runs', async () => {
        const db = new MemoryPoolDb(); db.seed('ready', 'standard', 1801);
        expect(await claim(db, enabled, subscriber, input())).toBeNull();
    });
});

describe('additive generated migration', () => {
    it('extends the existing snapshot and journal without changing prior tables', () => {
        const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../../drizzle/meta/${name}`, import.meta.url), 'utf8'));
        const previous = read('0002_snapshot.json');
        const next = read('0003_snapshot.json');
        expect(next.prevId).toBe(previous.id);
        const { 'public.ezil_pool_slots': pool, ...existing } = next.tables;
        expect(existing).toEqual(previous.tables);
        expect(pool.isRLSEnabled).toBe(true);
        expect(read('_journal.json').entries.at(-1)).toMatchObject({ idx: 3, tag: '0003_pool_slots', version: '7', breakpoints: true });
    });

    it('contains both partial unique lease indexes, state checks and service-only RLS', () => {
        const migration = readFileSync(new URL('../../../../drizzle/0003_pool_slots.sql', import.meta.url), 'utf8');
        for (const key of ['user', 'computer']) {
            expect(migration).toMatch(new RegExp(`CREATE UNIQUE INDEX "ezil_pool_slots_live_${key}_idx".*WHERE "ezil_pool_slots"\\."state" = 'leased'`));
        }
        expect(migration).toContain("in ('warming','ready','leased','draining','destroyed')");
        expect(migration).toContain('ENABLE ROW LEVEL SECURITY');
        expect(migration).toContain("auth.role() = 'service_role'");
        expect(migration).not.toMatch(/\bDROP\b|\bDELETE\b/);
    });
});
