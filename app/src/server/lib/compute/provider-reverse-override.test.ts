/**
 * The explicit Free override lane (provider-reverse-override.ts): bounded discovery, every gate, the guarded stop before
 * the move, no duplicate work per pass, and the production wiring's own gates and SQL shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { BillingSummaryV3 } from '@/server/billing/v3/contract';
import { ImageJobConflictError, PlacementOwnerError, type Placement } from './placement';
import {
    explicitFreeOverrideState, freeOverrideCandidates, freeOverrideInEffect, freeOverrideLaneEnabled, OVERRIDE_PASS_BUDGET_MS, OVERRIDE_PASS_LIMIT,
    reconcileFreeOverrideMoves, reconcileFreeOverrideMovesInSweep, type OverrideMoveCandidate, type OverrideReconcilePorts,
} from './provider-reverse-override';

const U = '11111111-1111-4111-8111-111111111111';
const C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
const NOW = new Date('2026-11-25T12:00:00Z');
const me: OverrideMoveCandidate = { userId: U, computerId: C };

const placement = (over: Partial<Placement> = {}): Placement => ({
    computerId: C, ownerUserId: U, provider: 'aws-ec2', store: 'ebs', generation: 3, leaseEpoch: 4, state: 'RUNNING', region: 'ap-south-1', zoneId: null,
    instanceId: 'i-11111111111111111', instanceType: 't3a.medium', volumeId: 'vol-11111111111111111', fsUuid: null, tunnelId: null, enrollNonceHash: null,
    enrollExpiresAt: null, enrollConsumedHash: null, leaseUntil: null, presenceAt: null, fenceToken: 'fe0fe0fe-fe0f-4e0f-8e0f-e0fe0fe0fe0f',
    lifecycleJobId: null, lifecycleDigest: null, lastError: null, updatedAt: new Date(NOW.getTime() - 3_600_000), ...over,
} as Placement);

function ports(over: Partial<OverrideReconcilePorts> & { placements?: Record<string, Placement | null> } = {}) {
    const placements = over.placements ?? { [C]: placement() };
    const log = vi.fn<NonNullable<OverrideReconcilePorts['log']>>();
    const p: OverrideReconcilePorts = {
        startedAt: 1_000, clock: () => 2_000,
        enabled: () => true,
        schemaPresent: async () => true,
        candidates: async () => ({ candidates: [me], deferred: 0 }),
        overrideLive: vi.fn(async () => true),
        conflicting: vi.fn(async () => false),
        readPlacement: vi.fn(async c => placements[c.computerId] ?? null),
        openEpoch: vi.fn(async () => false),
        stop: vi.fn(async () => ({ kind: 'aws-ec2' as const, result: { ok: false, terminated: false, outcome: 'stopping' } })),
        start: vi.fn(async () => ({ ok: true as const, move: { stage: 'requested' } as never })),
        log,
        ...over,
    };
    return { p, log, run: () => reconcileFreeOverrideMoves(p) };
}
const skips = (log: ReturnType<typeof vi.fn>) => log.mock.calls.filter(c => c[0] === 'override-move-skip').map(c => (c[1] as { reason: string }).reason);

beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('reconcileFreeOverrideMoves: gates before any candidate', () => {
    it('does nothing with the lane off, past the budget, or without 0019/0012: no candidate read, no stop, no start', async () => {
        for (const over of [{ enabled: () => false }, { clock: () => 1_000 + OVERRIDE_PASS_BUDGET_MS }, { schemaPresent: async () => false }]) {
            const candidates = vi.fn(async () => ({ candidates: [me], deferred: 0 }));
            const { p, run } = ports({ candidates, ...over });
            expect(await run()).toEqual({ candidates: 0, deferred: 0, stopped: 0, started: 0, skipped: 0, errors: 0 });
            expect(candidates).not.toHaveBeenCalled();
            expect(p.stop).not.toHaveBeenCalled();
            expect(p.start).not.toHaveBeenCalled();
        }
    });

    it('bounds the batch to OVERRIDE_PASS_LIMIT and attempts each computer once per pass, whatever the listing repeats', async () => {
        const many = Array.from({ length: 12 }, (_, i) => ({ userId: U, computerId: i < 6 ? C : C2 }));
        const candidates = vi.fn(async (limit: number) => ({ candidates: many.slice(0, limit), deferred: 2 }));
        const { p, log, run } = ports({ candidates, placements: { [C]: placement(), [C2]: placement({ computerId: C2, state: 'STOPPED' }) } });
        const counts = await run();
        expect(candidates).toHaveBeenCalledExactlyOnceWith(OVERRIDE_PASS_LIMIT);
        expect(counts).toMatchObject({ candidates: 10, deferred: 2, stopped: 1, started: 1, skipped: 8 });
        expect(p.stop).toHaveBeenCalledTimes(1);
        expect(p.start).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith('override-move-pass', expect.objectContaining({ deferred: 2 }));
    });
});

describe('reconcileFreeOverrideMoves: per-computer gates (each a skip, never a stop or a start)', () => {
    type Over = Partial<OverrideReconcilePorts> & { placements?: Record<string, Placement | null> };
    const gates: [string, Over][] = [
        ['override_gone', { overrideLive: async () => false }],
        ['conflicting_work', { conflicting: async () => true }],
        ['conflicting_work', { conflicting: async (): Promise<boolean> => { throw new Error('db'); } }],
        ['placement_unavailable', { readPlacement: async () => { throw new PlacementOwnerError(C); } }],
        ['placement_unavailable', { readPlacement: async () => { throw new ImageJobConflictError(); } }],
        ['not_own_aws', { placements: { [C]: null } }],
        ['not_own_aws', { placements: { [C]: placement({ provider: 'cloudflare' }) } }],
        ['not_own_aws', { placements: { [C]: placement({ ownerUserId: '22222222-2222-4222-8222-222222222222' }) } }],
        ['lifecycle_job', { placements: { [C]: placement({ lifecycleJobId: '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a' }) } }],
        ['placement_draining', { placements: { [C]: placement({ state: 'DRAINING' }) } }],
        ['placement_unconfirmed', { placements: { [C]: placement({ state: 'UNCONFIRMED' }) } }],
        ['route_not_aws', { stop: async () => null }],
    ];
    it.each(gates)('%s', async (reason, over) => {
        const { p, log, run } = ports(over);
        const counts = await run();
        expect(counts).toMatchObject({ candidates: 1, stopped: 0, started: 0, skipped: 1, errors: 0 });
        expect(skips(log)).toEqual([reason]);
        expect(p.start).not.toHaveBeenCalled();
        if (reason !== 'route_not_aws') expect(p.stop).not.toHaveBeenCalled();
    });

    it('a candidate that throws is an error for that computer only; the next candidate still runs', async () => {
        const { p, run } = ports({
            candidates: async () => ({ candidates: [me, { userId: U, computerId: C2 }], deferred: 0 }),
            readPlacement: async c => { if (c.computerId === C) throw new Error('boom'); return placement({ computerId: C2, state: 'STOPPED' }); },
        });
        expect(await run()).toMatchObject({ candidates: 2, errors: 1, started: 1, stopped: 0 });
        expect(p.start).toHaveBeenCalledExactlyOnceWith({ userId: U, computerId: C2 });
    });
});

describe('reconcileFreeOverrideMoves: the stop-then-move sequence', () => {
    it('RUNNING with an old paid session still open: the guarded stop runs (the receipt closes the session), no start', async () => {
        const { p, log, run } = ports({ openEpoch: async () => true, placements: { [C]: placement({ updatedAt: NOW }) } });
        expect(await run()).toMatchObject({ stopped: 1, started: 0, skipped: 0, errors: 0 });
        expect(p.stop).toHaveBeenCalledExactlyOnceWith(me, expect.objectContaining({ state: 'RUNNING', generation: 3, leaseEpoch: 4 }));
        expect(p.start).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('override-move-stop', expect.objectContaining({ accepted: true, outcome: 'stopping' }));
    });

    it('RUNNING with no session: the same guarded stop, with no grace on the row\'s age', async () => {
        const { p, run } = ports({ placements: { [C]: placement({ updatedAt: NOW }) } });
        expect(await run()).toMatchObject({ stopped: 1, started: 0 });
        expect(p.stop).toHaveBeenCalledTimes(1);
    });

    it('a stop the guard refused or that lost its compare-and-swap is an error, not a stop; nothing starts; the next pass retries', async () => {
        for (const outcome of ['stop_guard_refused', 'stop_guard_mismatch', 'cas_conflict']) {
            const { p, run } = ports({ stop: async () => ({ kind: 'aws-ec2', result: { ok: false, terminated: false, outcome } }) });
            expect(await run()).toMatchObject({ stopped: 0, started: 0, errors: 1 });
            expect(p.start).not.toHaveBeenCalled();
        }
    });

    it('STOPPED with no job and no lingering session: the move starts (startReverseMove), with no stop', async () => {
        const { p, log, run } = ports({ placements: { [C]: placement({ state: 'STOPPED' }) } });
        expect(await run()).toMatchObject({ stopped: 0, started: 1 });
        expect(p.start).toHaveBeenCalledExactlyOnceWith(me);
        expect(p.stop).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('override-move-start', expect.objectContaining({ stage: 'requested' }));
    });

    it('STOPPED with a session still open (its receipt not yet applied): deferred to the sweep that closes it; no billing write, no start', async () => {
        const { p, log, run } = ports({ placements: { [C]: placement({ state: 'STOPPED' }) }, openEpoch: async () => true });
        expect(await run()).toMatchObject({ stopped: 0, started: 0, skipped: 1 });
        expect(skips(log)).toEqual(['open_session_stopped']);
        expect(p.start).not.toHaveBeenCalled();
    });

    it('a start refusal (the click\'s own pinned values) is a skip named by its reason', async () => {
        const { log, run } = ports({ placements: { [C]: placement({ state: 'STOPPED' }) }, start: async () => ({ ok: false, reason: 'move_paused' }) });
        expect(await run()).toMatchObject({ started: 0, skipped: 1 });
        expect(skips(log)).toEqual(['start_move_paused']);
    });

    it('the budget is checked before each stop or start: out of time means neither', async () => {
        let t = 1_000;
        const { p, run } = ports({ clock: () => t, overrideLive: async () => { t = 1_000 + OVERRIDE_PASS_BUDGET_MS; return true; } });
        expect(await run()).toMatchObject({ candidates: 1, stopped: 0, started: 0 });
        expect(p.stop).not.toHaveBeenCalled();
    });
});

describe('explicitFreeOverrideState: the sweep\'s deferral predicate', () => {
    const v3 = (plan: Partial<BillingSummaryV3['plan']>) => ({ summary: { version: 3, plan: { sku: 'free_v3', ...plan } } as unknown as BillingSummaryV3 });
    it('true only for summary v3, plan free_v3 decided by an operator row marked override', () => {
        expect(explicitFreeOverrideState(v3({ access: { source: 'operator', ref: 'r', endsAt: null, untilRevoked: true, issuedBy: 'EZiL', override: true } }))).toBe(true);
        expect(explicitFreeOverrideState(v3({ access: { source: 'operator', ref: 'r', endsAt: null, untilRevoked: true, issuedBy: 'EZiL' } }))).toBe(false);
        expect(explicitFreeOverrideState(v3({}))).toBe(false); // natural Free
        expect(explicitFreeOverrideState(v3({ sku: 'standard_monthly_v3', access: { source: 'operator', ref: 'r', endsAt: null, untilRevoked: true, issuedBy: 'EZiL', override: true } }))).toBe(false);
        expect(explicitFreeOverrideState({ summary: { version: 2 } as never })).toBe(false);
    });
});

describe('freeOverrideLaneEnabled and the SQL readers', () => {
    const AWS = { EZIL_COMPUTE_PLACEMENT_READS: '1', EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_REGIONS: 'ap-south-1', AWS_MAX_RUNNING: '10',
        EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
        EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200' };
    it('runs only with placement reads on, AWS enabled and the kill switch off', () => {
        expect(freeOverrideLaneEnabled(AWS)).toBe(true);
        expect(freeOverrideLaneEnabled({ ...AWS, EZIL_AWS_KILL_SWITCH: '1' })).toBe(false);
        // AWS admission implies placement reads (aws-config.ts); AWS off is the lane off, reads on or not.
        expect(freeOverrideLaneEnabled({ ...AWS, EZIL_AWS_COMPUTERS_ENABLED: '0' })).toBe(false);
        expect(freeOverrideLaneEnabled({ EZIL_COMPUTE_PLACEMENT_READS: '1' })).toBe(false);
        expect(freeOverrideLaneEnabled({})).toBe(false);
    });

    it('the sweep step is a no-op (no import, no read) while the lane is off, and returns null', async () => {
        expect(await reconcileFreeOverrideMovesInSweep(Date.now(), {})).toBeNull();
        expect(await reconcileFreeOverrideMovesInSweep(Date.now(), { ...AWS, EZIL_AWS_KILL_SWITCH: '1' })).toBeNull();
        expect(await reconcileFreeOverrideMovesInSweep(Date.now() - OVERRIDE_PASS_BUDGET_MS, AWS)).toBeNull();
    });

    function recording(answer: (text: string) => unknown[] = () => []) {
        const dialect = new PgDialect();
        const queries: { text: string; params: unknown[] }[] = [];
        return { queries, db: { async execute(q: SQL) { const { sql: text, params } = dialect.sqlToQuery(q); queries.push({ text, params }); return answer(text); } } };
    }

    it('candidates: own live AWS computers joined to a live explicit Free override (through to_jsonb), actionable rows only, bounded; plus the deferred count', async () => {
        const { db, queries } = recording(text => text.includes('override-candidates') ? [{ computer_id: C.toUpperCase(), user_id: U }] : [{ n: 3 }]);
        expect(await freeOverrideCandidates(db, NOW, 50)).toEqual({ candidates: [{ userId: U, computerId: C }], deferred: 3 });
        const [list, deferred] = queries;
        for (const q of [list!, deferred!]) {
            expect(q.text).toContain("to_jsonb(o)->>'access_override' = 'true'");
            expect(q.text).toContain("o.sku = 'free_v3'");
            expect(q.text).toContain('o.ended_at IS NULL');
            expect(q.text).toContain('p.owner_user_id = c.user_id');
            expect(q.text).toContain("p.provider = 'aws-ec2'");
            expect(q.text).toContain('c.deleted_at IS NULL');
            expect(q.text).toContain("p.state IN ('RUNNING', 'STOPPED') AND p.lifecycle_job_id IS NULL");
            expect(q.text).toContain('public.ezil_compute_reverse_moves');
            expect(q.params).toContain(NOW.toISOString());
        }
        expect(list!.text).toContain('ORDER BY p.updated_at ASC');
        expect(list!.params).toContain(OVERRIDE_PASS_LIMIT);
        expect(deferred!.text).toContain('count(*)');
        expect(deferred!.text).toContain('AND NOT (');
        expect(await freeOverrideCandidates(recording().db, NOW, 0)).toEqual({ candidates: [], deferred: 0 });
    });

    it('the re-read decides with the shared rule: a live Free override is in effect; an ended, future, expired or paid-newer one is not', async () => {
        const row = (over: Record<string, unknown> = {}) => ({ ref: 'a', sku: 'free_v3', starts_at: '2026-11-25T00:00:00Z', ends_at: null, ended_at: null, ...over });
        const ask = (rows: unknown[]) => freeOverrideInEffect(recording(() => rows).db, U, NOW);
        expect(await ask([row()])).toBe(true);
        expect(await ask([])).toBe(false);
        expect(await ask([row({ ended_at: '2026-11-25T01:00:00Z' })])).toBe(false);
        expect(await ask([row({ starts_at: '2026-11-26T00:00:00Z' })])).toBe(false);
        expect(await ask([row({ ends_at: '2026-11-25T11:00:00Z' })])).toBe(false);
        expect(await ask([row({ ref: 'b', sku: 'standard_monthly_v3', starts_at: '2026-11-25T06:00:00Z' }), row()])).toBe(false);
        const { db, queries } = recording(() => []);
        await freeOverrideInEffect(db, U.toUpperCase(), NOW);
        expect(queries[0]!.text).toContain("to_jsonb(o)->>'access_override' = 'true'");
        expect(queries[0]!.params).toContain(U);
    });
});
