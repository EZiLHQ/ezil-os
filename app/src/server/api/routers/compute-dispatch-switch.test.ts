/**
 * Round 3 (contract v3 D5): `computer.switchConfiguration` / `restartComputer` drivers.
 * Real placement reads (fake Postgres running placement.ts SQL), a scripted lifecycle provider that
 * moves the placement exactly like the stop and replace paths do, an in-memory twin of the
 * advisory `ezil_computers.metadata` store (its SQL is proven in progress.pg.test.ts) and fake billing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SizeCode } from '@/server/billing/v2/contract';

const h = vi.hoisted(() => ({
    owned: true,
    metadata: {} as { transition?: unknown; opening?: unknown },
    writes: 0,
    plan: { sku: 'premium_monthly_v3', status: 'active', offer: { machineChoice: ['std-2', 'cmp-4', 'cmp-8'] } } as Record<string, unknown>,
    entitlement: { source: 'billing_v2', status: 'active', provider: 'aws', paymentIssue: false, planId: 'premium_monthly_v3' } as Record<string, unknown>,
    preference: 'std-2' as string | null,
    gate: { allowed: true } as { allowed: boolean; reason?: string },
}));

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/env', () => ({ env: {} }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('tests inject billing'); } }));
vi.mock('@/server/billing/v3/catalog', () => ({ planFromSubscriptions: () => h.plan }));
vi.mock('@/server/billing/v2/compute-access', () => ({
    billingV2EntitlementReader: () => ({ read: async () => ({ ...h.entitlement, size: h.preference }) }),
    gateComputerStart: async () => h.gate,
}));
vi.mock('@/server/lib/compute/progress', async original => {
    const real = await original<typeof import('@/server/lib/compute/progress')>();
    const IN_FLIGHT = ['requested', 'stopping', 'waking'];
    return {
        ...real,
        readComputerMeta: async (_db: unknown, computer: { computerId: string; userId: string }) => {
            await Promise.resolve();
            if (!h.owned) return null;
            return { transition: real.parseTransition(h.metadata.transition, computer), opening: real.parseOpening(h.metadata.opening),
                rawTransition: h.metadata.transition ?? null, rawOpening: h.metadata.opening ?? null };
        },
        // Same guard as the SQL: null = nothing in flight (or stale); else the exact stored id and phase.
        writeTransition: async (_db: unknown, _c: unknown, expected: { transitionId: string; phase: string } | null, next: { requestedAt: string }) => {
            await Promise.resolve();
            const stored = h.metadata.transition as { transitionId?: string; phase?: string; requestedAt?: string } | undefined;
            const ok = expected === null
                ? !stored || !IN_FLIGHT.includes(stored.phase ?? '') || (stored.requestedAt ?? '') < new Date(Date.parse(next.requestedAt) - real.TRANSITION_MAX_AGE_MS).toISOString()
                : stored?.transitionId === expected.transitionId && stored?.phase === expected.phase;
            if (ok) { h.metadata.transition = structuredClone(next); h.writes++; }
            return ok;
        },
    };
});

import { createFakePlacementDb, placementRow } from '@/server/lib/compute/fake-placement-db.test-support';
import { readComputerMeta, resolveTransition, transitionView, type ComputerTransition } from '@/server/lib/compute/progress';
import type { ComputeProvider } from '@/server/lib/compute/provider';
import type { BillingDeps } from '@/server/billing/ports';
import { restartWholeComputer, switchComputerConfiguration, type TransitionDeps, type RouteOptions } from './compute-dispatch';

const U = '11111111-1111-4111-8111-111111111111';
const C = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const computer = { userId: U, computerId: C };
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_COMPUTE_PLACEMENT_READS: '1' };
const TYPE: Record<string, string> = { 'std-2': 'm6i.large', 'cmp-4': 'm6i.xlarge', 'cmp-8': 'm6i.2xlarge' };

function harness(row: Record<string, unknown> = {}, script: { ensure?: 'ok' | 'capacity' | 'stuck' | 'unconfirmed'; stop?: 'ok' | 'never' } = {}) {
    const fake = createFakePlacementDb({ placements: [placementRow({
        computer_id: C, owner_user_id: U, state: 'RUNNING', generation: 3, lease_epoch: 7, region: 'ap-south-1', zone_id: 'aps1-az1',
        instance_id: 'i-1', instance_type: 'm6i.large', volume_id: 'vol-1', fence_token: 'fe0fe0fe-fe0f-4e0f-8e0f-e0fe0fe0fe0f', ...row,
    })] });
    const p = () => fake.placements[0]!;
    let clock = Date.parse('2026-10-28T10:00:00.000Z');
    const calls = { stop: 0, ensure: 0, leases: 0, status: 0, leasedSizes: [] as string[] };
    const provider = (options: RouteOptions): ComputeProvider => ({
        kind: 'aws-ec2',
        async stop() {
            calls.stop++;
            if (p().state === 'STOPPED') return { ok: true, terminated: false, outcome: 'already_stopped' };
            if (p().state !== 'RUNNING') return { ok: false, terminated: false, outcome: `placement_${String(p().state).toLowerCase()}` };
            p().state = 'DRAINING';
            return { ok: false, terminated: false, outcome: 'stopping' };
        },
        async status() {
            calls.status++;
            const next: Record<string, string> = script.stop === 'never' ? {} : { DRAINING: 'STOPPING', STOPPING: 'STOPPED' };
            Object.assign(next, { LEASED: 'STARTING', STARTING: 'MOUNTING', MOUNTING: 'RUNNING' });
            if (next[p().state as string]) p().state = next[p().state as string];
            return { ok: true, placementState: p().state } as never;
        },
        async ensure() {
            calls.ensure++;
            // Like aws-ec2 `ensure`: an in-flight placement first applies its lifecycle receipt.
            if (p().state !== 'STOPPED') {
                const next: Record<string, string> = { LEASED: 'STARTING', STARTING: 'MOUNTING', MOUNTING: 'RUNNING' };
                if (next[p().state as string]) p().state = next[p().state as string];
                return { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true };
            }
            if (script.ensure === 'capacity') return { ok: false, error: 'max_running', errorCode: 'capacity_unavailable', retryable: false };
            if (script.ensure === 'stuck') return { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true };
            // The replace path: one lease CAS moves generation and epoch by one, with a new fence, onto the entitled size.
            const size = String((await (options.entitlements!).read(U))?.size);
            calls.leases++; calls.leasedSizes.push(size);
            Object.assign(p(), { state: script.ensure === 'unconfirmed' ? 'UNCONFIRMED' : 'LEASED', generation: Number(p().generation) + 1,
                lease_epoch: Number(p().lease_epoch) + 1, instance_type: TYPE[size], instance_id: null, fence_token: `fence-${calls.leases}`,
                last_error: script.ensure === 'unconfirmed' ? 'capacity:region' : null });
            return { ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true };
        },
        activity: async () => ({ ok: true }), restart: async () => ({ ok: true }), terminate: async () => ({ ok: true, terminated: true }),
    });
    const scheduled: (() => Promise<void>)[] = [];
    const store = {
        sizePreference: vi.fn(async () => h.preference as SizeCode | null),
        setSizePreference: vi.fn(async (_u: string, size: SizeCode) => { h.preference = size; }),
        subscriptionsFor: async () => [], userCreatedAt: async () => null,
    };
    const billing = { store, now: () => new Date(clock), config: {} } as unknown as BillingDeps;
    const preflight = vi.fn(async () => ({ ok: true as const, wait: false }));
    const deps: TransitionDeps = {
        env, billing: () => billing, now: () => new Date(clock), preflight,
        schedule: work => { scheduled.push(work); },
        sleep: async ms => { clock += ms; },
        stop: { pollMs: 5_000 }, wake: { pollMs: 5_000 },
        routeComputer: async (_db, _c, options) => {
            const reader = options.entitlements ?? { read: async () => ({ ...h.entitlement, size: h.preference }) as never };
            return { kind: 'aws-ec2', instanceType: String(p().instance_type), provider: provider({ ...options, entitlements: reader }) };
        },
    };
    const run = async () => { while (scheduled.length) await scheduled.shift()!(); };
    const stored = () => h.metadata.transition as ComputerTransition | undefined;
    return { fake, p, calls, deps, run, store, preflight, stored, tick: (ms: number) => { clock += ms; }, now: () => new Date(clock) };
}

beforeEach(() => {
    h.owned = true; h.metadata = {}; h.writes = 0; h.preference = 'std-2'; h.gate = { allowed: true };
    h.plan = { sku: 'premium_monthly_v3', status: 'active', offer: { machineChoice: ['std-2', 'cmp-4', 'cmp-8'] } };
    h.entitlement = { source: 'billing_v2', status: 'active', provider: 'aws', paymentIssue: false, planId: 'premium_monthly_v3' };
    vi.spyOn(console, 'info').mockImplementation(() => {});
});

describe('switchConfiguration: RUNNING applies now (stop, then wake on the target), never a silent no-op', () => {
    it('RUNNING 2 vCPU → 8 vCPU: one transition, one stop, one replace on the target size, then done', async () => {
        const s = harness();
        const out = await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-8', requestId: 'click-000001' }, s.deps);
        expect(out).toEqual({ ok: true, effective: 'switching', current: 'std-2', target: 'cmp-8', transitionId: s.stored()!.transitionId });
        expect(s.stored()).toMatchObject({ phase: 'requested', current: 'std-2', target: 'cmp-8', fromGeneration: 3, fromLeaseEpoch: 7 });
        expect(h.preference).toBe('cmp-8');
        expect(s.calls.stop).toBe(0); // the stop runs after the answer
        await s.run();
        expect(s.calls).toMatchObject({ stop: 1, leases: 1, leasedSizes: ['cmp-8'] });
        expect(s.p()).toMatchObject({ state: 'RUNNING', instance_type: 'm6i.2xlarge', generation: 4, lease_epoch: 8, fence_token: 'fence-1' });
        expect(s.stored()).toMatchObject({ phase: 'done', reason: null });
        expect(s.stored()!.stoppingAt && s.stored()!.wakingAt && s.stored()!.endedAt).toBeTruthy();
        expect(h.preference).toBe('cmp-8');
    });

    it('a preflight capacity refusal (8 vCPU near the cap) answers before any stop: still RUNNING, nothing written', async () => {
        const s = harness();
        s.preflight.mockResolvedValueOnce({ ok: false, reason: 'region_capacity' } as never);
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-8', requestId: 'click-000001' }, s.deps))
            .toEqual({ ok: false, reason: 'capacity_unavailable' });
        expect(s.preflight).toHaveBeenCalledWith(s.fake.db, expect.objectContaining({ state: 'RUNNING', instanceType: 'm6i.large' }), 'm6i.2xlarge', env, expect.any(Date));
        await s.run();
        expect(s.calls).toMatchObject({ stop: 0, ensure: 0 });
        expect(s.p()).toMatchObject({ state: 'RUNNING', instance_type: 'm6i.large', generation: 3 });
        expect(s.stored()).toBeUndefined();
        expect(s.store.setSizePreference).not.toHaveBeenCalled();
    });

    it('a monthly-cap preflight refusal is not_entitled, not capacity', async () => {
        const s = harness();
        s.preflight.mockResolvedValueOnce({ ok: false, reason: 'user_hours_cap' } as never);
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps)).toEqual({ ok: false, reason: 'not_entitled' });
    });

    it('the same requestId twice, and two concurrent tabs, are ONE transition and ONE host', async () => {
        const s = harness();
        const [a, b] = await Promise.all([
            switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps),
            switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000002' }, s.deps),
        ]);
        const again = await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps);
        expect(a).toMatchObject({ ok: true, effective: 'switching' });
        expect(b).toEqual(a);
        expect(again).toEqual(a);
        expect(h.writes).toBe(1);
        await s.run();
        expect(s.calls).toMatchObject({ stop: 1, leases: 1 });
        expect(s.p()).toMatchObject({ generation: 4, lease_epoch: 8, instance_type: 'm6i.xlarge' });
    });

    it('a different target while one is in flight is switch_in_progress', async () => {
        const s = harness();
        await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps);
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-8', requestId: 'click-000002' }, s.deps)).toEqual({ ok: false, reason: 'switch_in_progress' });
        expect(h.preference).toBe('cmp-4');
    });

    it.each([['capacity', 'capacity_unavailable'], ['unconfirmed', 'capacity_unavailable'], ['stuck', 'wake_timeout']] as const)(
        'a failed wake (%s) ends failed with %s, reverts the preference and offers the revert', async (ensure, reason) => {
            const s = harness({}, { ensure });
            await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-8', requestId: 'click-000001' }, s.deps);
            await s.run();
            expect(s.stored()).toMatchObject({ phase: 'failed', reason });
            expect(h.preference).toBe('std-2');
            expect(transitionView(s.stored()!, resolveTransition(s.stored()!, null, s.now())).revertAvailable).toBe(true);
            // "Back to 2 vCPU" is a normal switch to `current`: with the computer down it is the next start.
            const back = await switchComputerConfiguration(s.fake.db, computer, { size: 'std-2', requestId: 'click-000002' }, s.deps);
            expect(back).toMatchObject({ ok: true, target: 'std-2' });
        });

    it('a stop that is never confirmed fails as stop_timeout and reverts', async () => {
        const s = harness({}, { stop: 'never' });
        await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps);
        await s.run();
        expect(s.stored()).toMatchObject({ phase: 'failed', reason: 'stop_timeout' });
        expect(s.calls.leases).toBe(0);
        expect(h.preference).toBe('std-2');
    });

    it('a billing refusal at wake time fails with that reason', async () => {
        const s = harness();
        await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps);
        h.gate = { allowed: false, reason: 'fair_use_paused' };
        await s.run();
        expect(s.stored()).toMatchObject({ phase: 'failed', reason: 'billing_fair_use_paused' });
        expect(h.preference).toBe('std-2');
    });

    it('a driver that died is settled by the next call: past its budget it fails, reverts, and a new switch may start', async () => {
        const s = harness();
        await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-8', requestId: 'click-000001' }, s.deps);
        // The scheduled driver never runs. The stop budget passes with the computer still RUNNING.
        s.tick(240_000);
        expect(resolveTransition(s.stored()!, null, s.now()).phase).toBe('failed');
        const next = await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000002' }, s.deps);
        expect(next).toMatchObject({ ok: true, effective: 'switching', target: 'cmp-4' });
        expect(h.preference).toBe('cmp-4');
    });
});

describe('switchConfiguration: everything that is not RUNNING', () => {
    it('STOPPED stores the preference only (next_start); nothing starts', async () => {
        const s = harness({ state: 'STOPPED' });
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-8', requestId: 'click-000001' }, s.deps))
            .toMatchObject({ ok: true, effective: 'next_start', current: 'std-2', target: 'cmp-8' });
        expect(h.preference).toBe('cmp-8');
        expect(s.stored()).toBeUndefined();
        await s.run();
        expect(s.calls).toMatchObject({ stop: 0, ensure: 0 });
    });
    it('the size it already runs is stored, never restarted', async () => {
        const s = harness({ instance_type: 'm6i.xlarge' });
        h.preference = 'cmp-8';
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps))
            .toMatchObject({ ok: true, effective: 'next_start', current: 'cmp-4', target: 'cmp-4' });
        expect(h.preference).toBe('cmp-4');
        expect(s.calls.stop).toBe(0);
    });
    it.each(['LEASED', 'STARTING', 'MOUNTING', 'DRAINING', 'STOPPING', 'RECOVERING'])('%s is computer_busy', async state => {
        const s = harness({ state });
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps)).toEqual({ ok: false, reason: 'computer_busy' });
        expect(s.store.setSizePreference).not.toHaveBeenCalled();
    });
    it('another owner\'s placement, or no live owned row, is foreign_computer', async () => {
        const s = harness({ owner_user_id: '33333333-3333-4333-8333-333333333333' });
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps)).toEqual({ ok: false, reason: 'foreign_computer' });
        const t = harness();
        h.owned = false;
        expect(await switchComputerConfiguration(t.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, t.deps)).toEqual({ ok: false, reason: 'foreign_computer' });
        expect(t.store.setSizePreference).not.toHaveBeenCalled();
    });
    it.each([
        ['Standard plan', () => { h.plan = { sku: 'standard_monthly_v3', status: 'active', offer: { machineChoice: ['std-2'] } }; }],
        ['inactive Premium', () => { h.plan = { ...h.plan, status: 'past_due' }; }],
        ['payment issue', () => { h.entitlement = { ...h.entitlement, paymentIssue: true }; }],
        ['no allowance', () => { h.entitlement = { ...h.entitlement, status: 'expired' }; }],
    ])('%s is not_entitled, before anything else is written', async (_name, arrange) => {
        arrange();
        const s = harness();
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-8', requestId: 'click-000001' }, s.deps)).toEqual({ ok: false, reason: 'not_entitled' });
        expect(s.store.setSizePreference).not.toHaveBeenCalled();
        expect(s.preflight).not.toHaveBeenCalled();
    });
    it('the Cloudflare size and a malformed request id are not_entitled', async () => {
        const s = harness();
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'free-cf', requestId: 'click-000001' }, s.deps)).toEqual({ ok: false, reason: 'not_entitled' });
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'x' }, s.deps)).toEqual({ ok: false, reason: 'not_entitled' });
    });
});

describe('restartComputer: the whole computer, on the same size', () => {
    it('stops and wakes on the size it ran, even when the next-start preference differs; path restart', async () => {
        const s = harness({ instance_type: 'm6i.xlarge' });
        h.preference = 'cmp-8';
        const out = await restartWholeComputer(s.fake.db, computer, { requestId: 'restart-0001' }, s.deps);
        expect(out).toEqual({ ok: true, transitionId: s.stored()!.transitionId, path: 'restart', size: 'cmp-4' });
        await s.run();
        expect(s.calls).toMatchObject({ stop: 1, leases: 1, leasedSizes: ['cmp-4'] });
        expect(s.p()).toMatchObject({ state: 'RUNNING', instance_type: 'm6i.xlarge', lease_epoch: 8 });
        expect(s.stored()).toMatchObject({ kind: 'restart', phase: 'done' });
        expect(h.preference).toBe('cmp-8');
        expect((await readComputerMeta(s.fake.db, computer))!.transition!.kind).toBe('restart');
    });
    it('the same request twice is one restart; a restart during a switch is switch_in_progress', async () => {
        const s = harness();
        const a = await restartWholeComputer(s.fake.db, computer, { requestId: 'restart-0001' }, s.deps);
        expect(await restartWholeComputer(s.fake.db, computer, { requestId: 'restart-0001' }, s.deps)).toEqual(a);
        expect(await restartWholeComputer(s.fake.db, computer, { requestId: 'restart-0002' }, s.deps)).toEqual({ ok: false, reason: 'switch_in_progress' });
        expect(await switchComputerConfiguration(s.fake.db, computer, { size: 'cmp-4', requestId: 'click-000001' }, s.deps)).toEqual({ ok: false, reason: 'switch_in_progress' });
    });
    it.each([['STOPPED', 'not_running'], ['LEASED', 'busy'], ['DRAINING', 'busy']])('%s answers %s without a stop', async (state, reason) => {
        const s = harness({ state });
        expect(await restartWholeComputer(s.fake.db, computer, { requestId: 'restart-0001' }, s.deps)).toEqual({ ok: false, reason });
        expect(s.calls.stop).toBe(0);
    });
    it('a foreign computer is refused before any write', async () => {
        const s = harness({ owner_user_id: '33333333-3333-4333-8333-333333333333' });
        expect(await restartWholeComputer(s.fake.db, computer, { requestId: 'restart-0001' }, s.deps)).toEqual({ ok: false, reason: 'foreign_computer' });
        expect(h.writes).toBe(0);
    });
});
