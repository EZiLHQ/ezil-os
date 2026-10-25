import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';
import { createFakePlacementDb, DEFAULT_OWNER, placementRow } from './fake-placement-db.test-support';
import {
    findStaleOpenUsage, lockImagePlacement, PLACEMENT_STATES, PLACEMENT_TRANSITIONS, readPlacement,
    RECONCILER_TRANSITIONS, transitionPlacement, transitionPlacementAsReconciler, withAdmission, writeImagePlacement,
    type PlacementDb, type PlacementState,
} from './placement';

const C = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-10-24T10:00:00Z');
const START = new Date('2026-10-22T09:00:00Z');
const dialect = new PgDialect();
const usageRow = (over: Record<string, unknown> = {}) => ({ computer_id: C, user_id: DEFAULT_OWNER,
    instance_id: 'i-old', instance_type: 'm6i.2xlarge', started_at: START, stopped_at: null,
    egress_bytes: null, observed_by: 'lifecycle-receipt', updated_at: START, ...over });
const setup = (state: PlacementState = 'LEASED') => createFakePlacementDb({
    placements: [placementRow({ computer_id: C, state, instance_id: 'i-current' })],
    usage: [usageRow(), usageRow({ instance_id: 'i-current' }), usageRow({ instance_id: 'i-current' }),
        usageRow({ stopped_at: START, egress_bytes: 12 }), usageRow({ computer_id: OTHER })],
}, { clock: () => NOW });
const current = async (db: PlacementDb) => (await readPlacement(db, C)).record!;
const expected = (state: PlacementState) => ({ state, generation: 1, leaseEpoch: 0 });
const closed = (s: ReturnType<typeof setup>, observedBy = 'placement-transition') => {
    expect(s.usage.slice(0, 3)).toEqual(Array.from({ length: 3 }, (_, i) => usageRow({
        instance_id: i === 0 ? 'i-old' : 'i-current', stopped_at: NOW, observed_by: observedBy, updated_at: NOW,
    })));
    expect(s.usage[3]).toEqual(usageRow({ stopped_at: START, egress_bytes: 12 }));
    expect(s.usage[4]).toEqual(usageRow({ computer_id: OTHER }));
};

const terminal = ['STOPPED', 'RETIRED', 'PURGE_ELIGIBLE'];
const edges = (table: Partial<Record<PlacementState, readonly PlacementState[]>>) => Object.entries(table)
    .flatMap(([from, targets]) => targets.filter(to => terminal.includes(to)).map(to => [from as PlacementState, to] as const));

describe('terminal placement transitions close every open usage row atomically', () => {
    for (const reconciler of [false, true]) {
        it.each(edges(PLACEMENT_TRANSITIONS))(`${reconciler ? 'reconciler' : 'owner'} %s → %s`, async (from, to) => {
            const s = setup(from);
            const input = { computerId: C, ownerUserId: DEFAULT_OWNER, expected: expected(from), to };
            const result = await (reconciler ? transitionPlacementAsReconciler(s.db, input) : transitionPlacement(s.db, input));
            expect(result).toMatchObject({ ok: true, placement: { state: to } });
            closed(s);
            const cas = s.statements.find(q => q.sql.includes('placement:cas'))!;
            const close = s.statements.find(q => q.sql.includes('placement:usage-close */'))!;
            expect(close.tx).toBe(cas.tx);
            expect(close.tx).not.toBeNull();
            // Pin the actual SQL: the fake models close rows by statement tag.
            expect(close.sql.replace(/\s+/g, ' ').trim()).toBe('/* placement:usage-close */ UPDATE public.ezil_compute_usage '
                + 'SET stopped_at = now(), observed_by = $1, updated_at = now() WHERE computer_id = $2::uuid AND stopped_at IS NULL');
        });
    }

    it.each(edges(RECONCILER_TRANSITIONS))('resolved reconciler %s → %s', async (from, to) => {
        const s = setup(from);
        expect(await transitionPlacementAsReconciler(s.db, { computerId: C, expected: expected(from), to })).toMatchObject({ ok: true });
        closed(s);
    });

    it('preserves an explicit close observer and closes only once', async () => {
        const s = setup('STOPPING');
        await transitionPlacementAsReconciler(s.db, { computerId: C, expected: expected('STOPPING'), to: 'STOPPED',
            usage: { kind: 'close', observedBy: 'lifecycle-receipt' } });
        closed(s, 'lifecycle-receipt');
        expect(s.statements.filter(q => q.sql.includes('placement:usage-close */'))).toHaveLength(1);
    });

    it('a terminal transition cannot accidentally open usage', async () => {
        const s = setup('STOPPING');
        await transitionPlacementAsReconciler(s.db, { computerId: C, expected: expected('STOPPING'), to: 'STOPPED',
            usage: { kind: 'open', instanceId: 'i-new', instanceType: 'm6i.large', startedAt: NOW, observedBy: 'receipt' } });
        closed(s, 'receipt');
        expect(s.usage).toHaveLength(5);
    });

    it.each(['owner', 'epoch', 'illegal'] as const)('a rejected %s transition never closes usage', async fault => {
        const s = setup();
        const before = structuredClone(s.usage);
        expect(await transitionPlacement(s.db, { computerId: C, ownerUserId: fault === 'owner' ? OTHER : DEFAULT_OWNER,
            expected: { ...expected('LEASED'), leaseEpoch: fault === 'epoch' ? 1 : 0 }, to: fault === 'illegal' ? 'RETIRED' : 'STOPPED' }))
            .toMatchObject({ ok: false });
        expect(s.usage).toEqual(before);
        expect(s.statements.some(q => q.sql.includes('placement:usage-close'))).toBe(false);
    });

    it('a usage write failure rolls back the placement and ledger', async () => {
        const s = setup();
        const before = structuredClone({ placements: s.placements, usage: s.usage });
        const db: PlacementDb = { ...s.db, transaction: fn => s.db.transaction(tx => fn({ execute: async q => {
            const result = await tx.execute(q);
            if (dialect.sqlToQuery(q).sql.includes('placement:usage-close')) throw new Error('usage write failed');
            return result;
        } })) };
        await expect(transitionPlacement(db, { computerId: C, ownerUserId: DEFAULT_OWNER, expected: expected('LEASED'), to: 'STOPPED' }))
            .rejects.toThrow('usage write failed');
        expect({ placements: s.placements, usage: s.usage }).toEqual(before);
    });

    it('only the winning transition closes usage; retries preserve the original close', async () => {
        const s = setup();
        const input = { computerId: C, ownerUserId: DEFAULT_OWNER, expected: expected('LEASED'), to: 'STOPPED' as const };
        const results = await Promise.all([transitionPlacement(s.db, input), transitionPlacement(s.db, input)]);
        expect(results.filter(r => r.ok)).toHaveLength(1);
        closed(s);
        expect(s.statements.filter(q => q.sql.includes('placement:usage-close */'))).toHaveLength(1);
    });

    it.each(['unresolved', 'instance-gone'] as const)('UNCONFIRMED %s uses evidence to decide closure', async evidence => {
        const s = setup('RUNNING');
        const before = structuredClone(s.usage);
        await transitionPlacementAsReconciler(s.db, { computerId: C, expected: expected('RUNNING'), to: 'UNCONFIRMED',
            usage: evidence === 'instance-gone' ? { kind: 'close', observedBy: 'reconcile:instance_lost' } : undefined });
        if (evidence === 'instance-gone') closed(s, 'reconcile:instance_lost');
        else expect(s.usage).toEqual(before);
    });

    it.each(['STOPPED', 'RETIRED', 'PURGE_ELIGIBLE'] as const)('image recovery into %s also closes usage', async state => {
        const s = setup('RECOVERING');
        await withAdmission(s.db, async (tx, lock) => {
            const p = (await lockImagePlacement(tx, lock, C))!;
            await writeImagePlacement(tx, lock, p, { state });
        });
        expect((await current(s.db)).state).toBe(state);
        closed(s);
    });
});

describe('findStaleOpenUsage operator report', () => {
    it('lists all open rows outside RUNNING/STARTING/MOUNTING without modifying billing history', async () => {
        const placements = PLACEMENT_STATES.map((state, i) => placementRow({ computer_id: `c${i}`, state }));
        const usage = placements.flatMap(p => [usageRow({ computer_id: p.computer_id }),
            usageRow({ computer_id: p.computer_id, instance_id: 'i-duplicate' }), usageRow({ computer_id: p.computer_id, stopped_at: NOW })]);
        const s = createFakePlacementDb({ placements, usage });
        const before = structuredClone({ placements: s.placements, usage: s.usage });
        const report = await findStaleOpenUsage(s.db);
        const staleStates = PLACEMENT_STATES.filter(state => !['RUNNING', 'STARTING', 'MOUNTING'].includes(state));
        expect(report).toHaveLength(staleStates.length * 2);
        expect(new Set(report.map(r => r.placementState))).toEqual(new Set(staleStates));
        expect(report.find(r => r.placementState === 'STOPPED')).toMatchObject({
            computerId: 'c1', userId: DEFAULT_OWNER, instanceId: 'i-duplicate', instanceType: 'm6i.2xlarge',
            startedAt: START, stoppedAt: null, egressBytes: null, observedBy: 'lifecycle-receipt',
            placementUpdatedAt: new Date('2026-10-01T00:00:00Z'),
        });
        expect({ placements: s.placements, usage: s.usage }).toEqual(before);
        expect(s.statements).toHaveLength(1);
        const query = s.statements[0]!.sql;
        expect(query).toContain('JOIN public.ezil_computer_placements p ON p.computer_id = u.computer_id');
        expect(query).toContain("WHERE u.stopped_at IS NULL AND p.state NOT IN ('RUNNING', 'STARTING', 'MOUNTING')");
        expect(query).not.toMatch(/\b(UPDATE|DELETE|INSERT|FOR UPDATE)\b/);
    });

    it('returns an empty report when there are no stale rows', async () => {
        const s = createFakePlacementDb();
        expect(await findStaleOpenUsage(s.db)).toEqual([]);
    });

    it('accepts production driver array rows and ISO timestamps', async () => {
        expect(await findStaleOpenUsage({ execute: async () => [{ ...usageRow(), started_at: START.toISOString(),
            placement_state: 'STOPPED', placement_updated_at: NOW.toISOString(), egress_bytes: '42' }] }))
            .toEqual([{ computerId: C, userId: DEFAULT_OWNER, instanceId: 'i-old', instanceType: 'm6i.2xlarge',
                startedAt: START, stoppedAt: null, egressBytes: 42, observedBy: 'lifecycle-receipt',
                placementState: 'STOPPED', placementUpdatedAt: NOW }]);
    });
});
