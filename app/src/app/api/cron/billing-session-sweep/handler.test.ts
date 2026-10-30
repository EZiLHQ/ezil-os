import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from '@/server/billing/config';
import type { BillingDeps, BillingStore, StoredComputeEpoch } from '@/server/billing/ports';
import { gateComputerStart, loadComputeBillingState } from '@/server/billing/v2/compute-access';
import { SIZES } from '@/server/billing/v2/contract';
import { rateWindow } from '@/server/billing/v2/rating';
import { epochSeconds, isoSeconds } from '@/server/billing/v2/time';
import { handleBillingSessionSweep, HELD_BUDGET_MS, HELD_PAGE_SIZE, HELD_PAGES, HELD_SWEEP_BUDGET_MS, RUNNING_GRACE_MS } from './handler';
import * as aiOutbox from '@/server/billing/ai-credit-outbox';

vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ advanceStaleMigrations: vi.fn() }));
vi.mock('@/server/lib/compute/provider-migrate-reconcile', () => ({ reconcilePaidCloudflareUsers: vi.fn() }));

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

const T = new Date('2026-10-18T00:00:00Z');
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);
const iso = (seconds: number) => isoSeconds(epochSeconds(at(seconds)));
const window = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };
const zeros = { examined: 0, stopped: 0, closed: 0, stopFailed: 0, heartbeatClosed: 0, retried: 0, shadow: 0, awsStaleClosed: 0, heldOverrun: 0,
    ai: { drained: 0, delivered: 0, retried: 0, failed: 0 } };
const ref = { userId: 'owner', computerId: 'computer' };
type SweepInput = Parameters<typeof handleBillingSessionSweep>[0];

function epoch(over: Partial<StoredComputeEpoch> = {}): StoredComputeEpoch {
    return { id: 'epoch', ...ref, size: 'std-2', weight: 1, readyAt: iso(0), endedAt: null,
        endReason: null, deadlineAt: null, lastHeartbeatAt: null, overheadSeconds: 0, ...over };
}

function fixture(epochs = [epoch()], { sku = 'standard_monthly_v2', allowance = 216000, overage = false,
    capCents = 25, enforcement = true }: {
    sku?: string | null; allowance?: number; overage?: boolean; capCents?: number; enforcement?: boolean;
} = {}) {
    const store = {
        subscriptionsFor: vi.fn<BillingStore['subscriptionsFor']>(async () => sku === null ? [] : [{
            stripeSubscriptionId: 'sub', sku, status: 'active', currentPeriodStart: new Date(window.start),
            currentPeriodEnd: new Date(window.end), cancelAtPeriodEnd: false,
        }]),
        userCreatedAt: vi.fn<BillingStore['userCreatedAt']>().mockResolvedValue(null),
        openPlanChanges: vi.fn<BillingStore['openPlanChanges']>().mockResolvedValue([]),
        openPaymentIssues: vi.fn<BillingStore['openPaymentIssues']>().mockResolvedValue([]),
        sizePreference: vi.fn<BillingStore['sizePreference']>().mockResolvedValue(null),
        grantsForPeriod: vi.fn<BillingStore['grantsForPeriod']>(async userId => [{
            id: 'grant', userId, subscriptionId: 'sub', meter: 'compute_std_seconds', kind: 'plan_period',
            amount: BigInt(allowance), periodStart: new Date(window.start), periodEnd: new Date(window.end),
            sourceType: 'invoice', sourceId: 'invoice', createdAt: T,
        }]),
        latestConsent: vi.fn<BillingStore['latestConsent']>(async userId => ({
            id: BigInt(1), userId, subscriptionId: 'sub', enabled: overage, capCents,
            termsVersion: 'overage-v2-2026-10-18', catalogVersion: 2, rateCentsPerStdHour: 25, actor: 'user', acceptedAt: T,
        })),
        epochsFor: vi.fn<BillingStore['epochsFor']>(async (userId, since) => epochs.filter(e =>
            e.userId === userId && (e.endedAt === null || Date.parse(e.endedAt) > since.getTime()))),
        openEpochsForSweep: vi.fn<BillingStore['openEpochsForSweep']>(async ({ limit }) => epochs.filter(e => e.endedAt === null).slice(0, limit)),
        openEpochFor: vi.fn<BillingStore['openEpochFor']>(async computerId => epochs.find(e => e.computerId === computerId && e.endedAt === null) ?? null),
        closeEpoch: vi.fn<BillingStore['closeEpoch']>(async input => {
            const open = epochs.find(e => e.computerId === input.computerId && e.endedAt === null
                && (input.epochId === undefined || e.id === input.epochId));
            if (!open) return 'not_open';
            open.endedAt = isoSeconds(Math.max(epochSeconds(open.readyAt), epochSeconds(input.endedAt)));
            open.endReason = input.reason;
            return 'closed';
        }),
        openEpoch: vi.fn<BillingStore['openEpoch']>(async input => {
            const existing = epochs.find(e => e.computerId === input.computerId && e.endedAt === null);
            if (existing) return { status: 'exists', epoch: existing };
            const concurrent = epochs.find(e => e.userId === input.userId && e.endedAt === null);
            if (concurrent) return { status: 'concurrent', epoch: concurrent };
            const next = epoch({ id: `epoch-${epochs.length}`, userId: input.userId, computerId: input.computerId,
                readyAt: isoSeconds(epochSeconds(input.readyAt, 'ceil')), size: input.size, weight: SIZES[input.size].weight });
            epochs.push(next);
            return { status: 'opened', epoch: next };
        }),
        policyClosedEpochsSince: vi.fn<BillingStore['policyClosedEpochsSince']>(async (since, limit) => epochs.filter(e =>
            e.endedAt !== null && Date.parse(e.endedAt) >= since.getTime()
            && ['session_max', 'allowance_exhausted', 'overage_cap'].includes(e.endReason ?? '')
            && !epochs.some(open => open.computerId === e.computerId && open.endedAt === null))
            .sort((a, b) => Date.parse(b.endedAt!) - Date.parse(a.endedAt!)).slice(0, limit)),
    };
    const deps: BillingDeps = { config: readBillingConfig(enforcement ? { BILLING_ENFORCEMENT: '1' } : { BILLING_TAB_ENABLED: '1' }),
        store: store as unknown as BillingStore, stripe: null, usage: null, now: () => { throw new Error('Use the injected sweep clock'); } };
    const stop = vi.fn<SweepInput['stop']>().mockResolvedValue({ kind: 'aws-ec2', result: { ok: true, terminated: true } });
    const isStillRunning = vi.fn<SweepInput['isStillRunning']>().mockResolvedValue(false);
    const run = (seconds: number, limit?: number) => handleBillingSessionSweep({ deps, now: at(seconds), stop, isStillRunning, limit });
    return { deps, store, epochs, stop, isStillRunning, run };
}

beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('billing session sweep', () => {
    it('drains AI credits with the shared forty-second deadline even when compute metering is disabled', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(T.getTime());
        const drain = vi.spyOn(aiOutbox, 'drainAiCreditOutbox').mockResolvedValue({ claimed: 0, done: 0, failed: 0, retry: 0, skipped: 0 });
        const f = fixture([]); f.deps.config.enforcementEnabled = false; f.deps.config.tabEnabled = false;
        await f.run(0);
        expect(drain).toHaveBeenCalledExactlyOnceWith(f.deps, { limit: 25, deadlineMs: T.getTime() + 40_000 });
    });
    it('drains after compute work and redacts outbox failures without failing the sweep', async () => {
        const drain = vi.spyOn(aiOutbox, 'drainAiCreditOutbox').mockRejectedValue(new Error('secret-token'));
        const f = fixture([]); await expect(f.run(0)).resolves.toEqual(zeros);
        expect(drain).toHaveBeenCalledTimes(1);
        expect(console.warn).toHaveBeenCalledWith('[billing.ai] outbox sweep unavailable');
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('secret-token');
    });
    it('is not due at 21,599 seconds and closes at exactly 21,600', async () => {
        const f = fixture();
        expect(await f.run(21599)).toEqual({ ...zeros, examined: 1 });
        expect(f.stop).not.toHaveBeenCalled();
        expect(await f.run(21600)).toEqual({ ...zeros, examined: 1, stopped: 1, closed: 1 });
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
        expect(f.store.closeEpoch).toHaveBeenCalledExactlyOnceWith({ computerId: ref.computerId, epochId: 'epoch', endedAt: at(21600), reason: 'session_max' });
    });

    it.each([null, iso(21600), iso(40000)])('late sweeps never extend the six-hour bound (deadline %s)', async deadlineAt => {
        const f = fixture([epoch({ deadlineAt })]);
        await f.run(24000);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(21600), endReason: 'session_max' });
        expect(f.store.subscriptionsFor).toHaveBeenCalledWith(ref.userId);
    });

    it('a six-hour restart adds the next session to the same monthly meter', async () => {
        const f = fixture();
        await f.run(21600);
        await f.store.openEpoch({ ...ref, subscriptionId: 'sub', size: 'std-2', readyAt: at(21600) });
        await f.run(25200);
        const state = await loadComputeBillingState(f.deps, ref.userId, at(25200));
        expect(f.epochs).toHaveLength(2);
        expect(state.usedStdSeconds).toBe(21600 + 3600);
        expect(rateWindow({ epochs: f.epochs, window, now: iso(25200) }).stdSeconds).toBe(21600 + 3600);
        expect(state.allowanceStdSeconds).toBe(216000);
        expect(f.stop).toHaveBeenCalledTimes(1);
    });

    it.each(['throws', 'not-ok'] as const)('still closes at the deadline if stop %s', async failure => {
        const f = fixture();
        if (failure === 'throws') f.stop.mockRejectedValue(new Error('stop unavailable'));
        else f.stop.mockResolvedValue({ kind: 'aws-ec2', result: { ok: false, terminated: false, outcome: 'stopping' } });
        expect(await f.run(21601)).toEqual({ ...zeros, examined: 1, closed: 1, stopFailed: 1 });
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(21600), endReason: 'session_max' });
        expect(f.stop).toHaveBeenCalledTimes(1); // no immediate second attempt in the retry pass
    });

    it.each([
        ['standard_monthly_v2', false, 'allowance_exhausted'],
        ['compute_monthly_v2', true, 'overage_cap'],
    ] as const)('headroom deadline for %s closes with %s/%s', async (sku, overage, reason) => {
        const f = fixture([epoch({ deadlineAt: iso(1000) })], { sku, overage });
        await f.run(1001);
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, reason);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(1000), endReason: reason });
    });

    it.each(['standard_monthly_v2', 'pro_monthly_v1', 'compute_monthly_v2'])('grant revocation exhausts %s at detection time', async sku => {
        const f = fixture([epoch()], { sku });
        expect(await f.run(100)).toEqual({ ...zeros, examined: 1 });
        f.store.grantsForPeriod.mockResolvedValue([]);
        expect(await f.run(200)).toMatchObject({ stopped: 1, closed: 1 });
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(200), endReason: 'allowance_exhausted' });
    });

    it('Free without headroom closes at detection time', async () => {
        const f = fixture([
            ...Array.from({ length: 8 }, (_, i) => epoch({ id: `past-${i}`, computerId: `past-${i}`, readyAt: iso(-3600 * (i + 1)), endedAt: iso(-3600 * i), endReason: 'session_max', size: 'free-cf', weight: 1 })),
            epoch({ size: 'free-cf', lastHeartbeatAt: iso(100) }),
        ], { sku: null });
        await f.run(100);
        expect(f.epochs[8]).toMatchObject({ endedAt: iso(100), endReason: 'allowance_exhausted' });
    });

    it('Compute overage continues past its allowance until the billable cap is reached', async () => {
        const f = fixture([epoch()], { sku: 'compute_monthly_v2', overage: true, allowance: 0, capCents: 1 });
        expect(await f.run(143)).toEqual({ ...zeros, examined: 1 });
        expect(await f.run(144)).toMatchObject({ stopped: 1, closed: 1 });
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(144), endReason: 'overage_cap' });
    });

    it.each([null, iso(100)])('stale Cloudflare closes at its last heartbeat or readiness (%s), without stopping', async lastHeartbeatAt => {
        const f = fixture([epoch({ size: 'free-cf', lastHeartbeatAt })]);
        expect(await f.run(1001)).toEqual({ ...zeros, examined: 1, closed: 1, heartbeatClosed: 1 });
        expect(f.epochs[0]).toMatchObject({ endedAt: lastHeartbeatAt ?? iso(0), endReason: 'idle_sleep' });
        expect(f.stop).not.toHaveBeenCalled();
    });

    it.each([iso(100), iso(101)])('fresh Cloudflare heartbeat, including exactly 15 minutes old, stays open (%s)', async lastHeartbeatAt => {
        const f = fixture([epoch({ size: 'free-cf', lastHeartbeatAt })]);
        expect(await f.run(1000)).toEqual({ ...zeros, examined: 1 });
        expect(f.store.closeEpoch).not.toHaveBeenCalled();
        expect(f.stop).not.toHaveBeenCalled();
    });

    it('stale Cloudflare heartbeat takes precedence even when the policy deadline is due', async () => {
        const f = fixture([epoch({ size: 'free-cf', lastHeartbeatAt: iso(100) })]);
        await f.run(21600);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(100), endReason: 'idle_sleep' });
        expect(f.stop).not.toHaveBeenCalled();
    });

    it('shadow logs policy decisions once per epoch, while still closing stale heartbeats', async () => {
        const f = fixture([epoch(), epoch({ id: 'cf', computerId: 'cf', size: 'free-cf' })], { enforcement: false });
        expect(await f.run(21600)).toEqual({ ...zeros, examined: 2, closed: 1, heartbeatClosed: 1, shadow: 1 });
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.epochs[0]!.endedAt).toBeNull();
        expect(vi.mocked(console.info).mock.calls.filter(call => call[0] === '[billing.sweep] shadow'))
            .toEqual([['[billing.sweep] shadow', expect.objectContaining({ epochId: 'epoch', reason: 'session_max' })]]);
        expect(f.store.policyClosedEpochsSince).not.toHaveBeenCalled();
        expect(f.isStillRunning).not.toHaveBeenCalled();
    });

    it('metering off makes zero store accesses', async () => {
        const f = fixture();
        const access = vi.fn(() => { throw new Error('store touched'); });
        f.deps.config = readBillingConfig({});
        f.deps.store = new Proxy({} as BillingStore, { get: access });
        expect(await f.run(21600)).toEqual(zeros);
        expect(access).not.toHaveBeenCalled();
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.isStillRunning).not.toHaveBeenCalled();
    });

    it('a second run at the same time does not stop or close an already stopped session', async () => {
        const f = fixture();
        await f.run(21600);
        expect(await f.run(21600)).toEqual(zeros);
        expect(f.stop).toHaveBeenCalledTimes(1);
        expect(f.store.closeEpoch).toHaveBeenCalledTimes(1);
    });

    it('does not count a close already won by another sweeper', async () => {
        const f = fixture();
        f.store.closeEpoch.mockResolvedValue('not_open');
        expect(await f.run(21600)).toMatchObject({ closed: 0 });
    });

    it('loads monthly state once per owner per run', async () => {
        const f = fixture([epoch(), epoch({ id: 'second', computerId: 'second' }),
            epoch({ id: 'third', computerId: 'third', userId: 'other' })]);
        await f.run(100);
        expect(f.store.subscriptionsFor.mock.calls).toEqual([[ref.userId], ['other']]);
        expect(f.store.epochsFor).toHaveBeenCalledTimes(2);
        expect(f.store.grantsForPeriod).toHaveBeenCalledTimes(2);
    });

    it('corrects stale usage before loading monthly headroom for another computer', async () => {
        const f = fixture([epoch(), epoch({ id: 'cf', computerId: 'cf', size: 'free-cf' })], { allowance: 1500 });
        await f.run(1000);
        expect(f.epochs[0]!.endedAt).toBeNull();
        expect(f.epochs[1]).toMatchObject({ endedAt: iso(0), endReason: 'idle_sleep' });
        expect(f.stop).not.toHaveBeenCalled();
    });

    it.each([true, false])('retries a recent policy close only if still running (%s)', async running => {
        const f = fixture([epoch({ endedAt: iso(21600), endReason: 'session_max' })]);
        f.isStillRunning.mockResolvedValue(running);
        expect(await f.run(22000)).toEqual({ ...zeros, retried: Number(running), stopped: Number(running) });
        expect(f.stop).toHaveBeenCalledTimes(Number(running));
        if (running) expect(f.stop).toHaveBeenCalledWith(ref, 'session_max');
        expect(f.store.closeEpoch).not.toHaveBeenCalled();
        expect(f.store.policyClosedEpochsSince).toHaveBeenCalledExactlyOnceWith(at(22000 - 7200), 50);
    });

    it('retries a failed stop on the next run without altering its billing close', async () => {
        const f = fixture();
        f.stop.mockRejectedValueOnce(new Error('transient stop error'));
        await f.run(21600);
        f.isStillRunning.mockResolvedValue(true);
        expect(await f.run(21600)).toEqual({ ...zeros, retried: 1, stopped: 1 });
        expect(f.stop).toHaveBeenCalledTimes(2);
        expect(f.store.closeEpoch).toHaveBeenCalledTimes(1);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(21600), endReason: 'session_max' });
    });

    it('bounds retries to recent policy closes, skips restarts and attempts each computer once', async () => {
        const f = fixture([
            epoch({ id: 'old', computerId: 'old', endedAt: iso(-7201), endReason: 'session_max' }),
            epoch({ id: 'user', computerId: 'user', endedAt: iso(-1), endReason: 'user_stop' }),
            epoch({ id: 'idle', computerId: 'idle', endedAt: iso(-1), endReason: 'idle_sleep' }),
            epoch({ id: 'prior', endedAt: iso(-1), endReason: 'session_max' }), epoch(),
            epoch({ id: 'recent', computerId: 'recent', readyAt: iso(-8000), endedAt: iso(-7200), endReason: 'overage_cap' }),
            epoch({ id: 'duplicate', computerId: 'recent', readyAt: iso(-10000), endedAt: iso(-7200), endReason: 'allowance_exhausted' }),
        ]);
        f.isStillRunning.mockResolvedValue(true);
        await f.run(0);
        expect(f.stop).toHaveBeenCalledExactlyOnceWith({ userId: ref.userId, computerId: 'recent' }, 'overage_cap');
        // Round 6: with the close it retries, so a host that stopped after it (a later open) is never taken for it.
        expect(f.isStillRunning).toHaveBeenCalledExactlyOnceWith({ userId: ref.userId, computerId: 'recent' }, at(-7200));
    });

    it('passes the batch limit to both scans and honors it', async () => {
        const f = fixture([epoch({ endedAt: iso(0), endReason: 'session_max' }),
            epoch({ id: 'second', computerId: 'second', endedAt: iso(0), endReason: 'overage_cap' })]);
        f.isStillRunning.mockResolvedValue(true);
        expect(await f.run(1, 1)).toMatchObject({ retried: 1 });
        expect(f.store.openEpochsForSweep).toHaveBeenCalledWith({ limit: 1 });
        expect(f.store.policyClosedEpochsSince).toHaveBeenCalledWith(at(1 - 7200), 1);
        expect(f.stop).toHaveBeenCalledTimes(1);
    });

    it('does not retry blindly if the running check throws', async () => {
        const f = fixture([epoch({ endedAt: iso(0), endReason: 'session_max' })]);
        f.isStillRunning.mockRejectedValue(new Error('status unavailable'));
        expect(await f.run(1)).toEqual(zeros);
        expect(f.stop).not.toHaveBeenCalled();
    });
});

describe('v3 session deadlines', () => {
    it('stops cmp-8 after one actual hour consumes four standard-hours', async () => {
        const f = fixture([epoch({ size: 'cmp-8', weight: 4 })], { sku: 'premium_monthly_v3', allowance: 14400 });
        expect(await f.run(3599)).toMatchObject({ stopped: 0 });
        expect(await f.run(3600)).toMatchObject({ stopped: 1, closed: 1 });
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(3600), endReason: 'allowance_exhausted' });
    });

    it.each([[null, 3600]] as const)
    ('stops %s exactly at its plan cap, even with no stored deadline', async (sku, cap) => {
        const f = fixture([epoch()], { sku, allowance: 1800000 });
        expect(await f.run(cap - 1)).toMatchObject({ stopped: 0 });
        expect(await f.run(cap)).toMatchObject({ stopped: 1, closed: 1 });
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(cap), endReason: 'session_max' });
    });
    it('v3 receipt revocation exhausts the running session', async () => {
        const f = fixture([epoch()], { sku: 'premium_monthly_v3', allowance: 1800000 });
        await f.run(100);
        f.store.grantsForPeriod.mockResolvedValue([]);
        await f.run(200);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(200), endReason: 'allowance_exhausted' });
    });
});

// Round 6 CR-1: store.ts rounds readiness up and the deadline down, so a hold opened at 05:42:00.400 is stored
// 05:42:01 → 06:42:00 (ready + 3599). Live 217b9546 closed those as allowance_exhausted with hours left.
describe('round 6 CR-1: the hold cap survives whole-second rounding', () => {
    const stored = (readyMs: number, maxRunSeconds: number) => ({
        readyAt: isoSeconds(epochSeconds(new Date(T.getTime() + readyMs), 'ceil')),
        deadlineAt: isoSeconds(epochSeconds(new Date(T.getTime() + readyMs + maxRunSeconds * 1000))),
    });
    /** Closed earlier hold sessions (each ≤ 1 h, so Free rating counts them in full) that leave `left` seconds of fair use. */
    async function leaving(left: number) {
        const probe = fixture([], { sku: null });
        const spent = (await loadComputeBillingState(probe.deps, ref.userId, T)).allowanceStdSeconds - left;
        return Array.from({ length: Math.ceil(spent / 3600) }, (_, i) => {
            const readyAt = -7200 * (i + 1);
            return epoch({ id: `past-${i}`, readyAt: iso(readyAt), endedAt: iso(readyAt + Math.min(3600, spent - i * 3600)), endReason: 'session_max' });
        });
    }

    it('a 05:42:00.400 hold (stored ready + 3599) closes session_max at its stored deadline', async () => {
        const f = fixture([epoch(stored(400, 3600))], { sku: null });
        expect(f.epochs[0]).toMatchObject({ readyAt: iso(1), deadlineAt: iso(3600) });
        expect(await f.run(3599)).toMatchObject({ stopped: 0, closed: 0 });
        expect(await f.run(3600)).toMatchObject({ stopped: 1, closed: 1 });
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(3600), endReason: 'session_max' });
    });

    it.each([[0, 3601], [400, 3601], [400, 3600]])('ready +%i ms with %i s of fair use left is cut by the session cap', async (readyMs, left) => {
        const f = fixture([...await leaving(left), epoch(stored(readyMs, Math.min(3600, left)))], { sku: null });
        await f.run(3700);
        expect(f.epochs.at(-1)).toMatchObject({ endReason: 'session_max' });
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
    });

    it.each([[0, 1800], [400, 1800], [0, 3599], [400, 3599], [0, 3598], [400, 3598]])(
        'ready +%i ms with only %i s left is cut by the allowance: allowance_exhausted', async (readyMs, left) => {
            const e = epoch(stored(readyMs, left));
            const f = fixture([...await leaving(left), e], { sku: null });
            expect(await f.run(epochSeconds(e.deadlineAt!) - epochSeconds(T))).toMatchObject({ stopped: 1, closed: 1 });
            expect(f.epochs.at(-1)).toMatchObject({ endedAt: e.deadlineAt, endReason: 'allowance_exhausted' });
            expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'allowance_exhausted');
        });

    it('after the session_max cut the next hold open is admitted, never refused as time used up', async () => {
        const f = fixture([...await leaving(4 * 3600), epoch(stored(400, 3600))], { sku: null });
        await f.run(3600);
        expect(f.epochs.at(-1)).toMatchObject({ endReason: 'session_max' });
        expect(await gateComputerStart({ deps: f.deps, ...ref, kind: 'aws-ec2', instanceType: 'm6i.large', now: at(3700) })).toEqual({ allowed: true });
    });
});

// Round 6 R1-04: the Free cap used to back-date a paid-era session to ready + 1 h, erasing the paid hours after it.
describe('round 6 R1-04: a paid-era session still open after the drop to Free ends at the drop', () => {
    const canceled = (periodEnd: Date) => [{ stripeSubscriptionId: 'sub', sku: 'standard_monthly_v3', status: 'canceled',
        currentPeriodStart: new Date(periodEnd.getTime() - 30 * 86_400_000), currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false }];
    // Opened on Standard: no session cap, so the stored deadline is the fair-use bound (40 h).
    const paidEra = () => epoch({ deadlineAt: iso(40 * 3600) });

    it('an immediate cancel (no recorded drop time) closes at the sweep that sees it, not ready + 1 h', async () => {
        const f = fixture([paidEra()], { sku: null });
        f.store.subscriptionsFor.mockResolvedValue(canceled(new Date(window.end)));
        expect(await f.run(18 * 3600)).toMatchObject({ stopped: 1, closed: 1 });
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(18 * 3600), endReason: 'session_max' });
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
    });

    it('a period that ended at ready + 5 h closes at that period end', async () => {
        const f = fixture([paidEra()], { sku: null });
        f.store.subscriptionsFor.mockResolvedValue(canceled(at(5 * 3600)));
        await f.run(18 * 3600);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(5 * 3600), endReason: 'session_max' });
    });

    it('a drop within the first hour still gives the Free hour: ready + 1 h, and not before it', async () => {
        const f = fixture([paidEra()], { sku: null });
        f.store.subscriptionsFor.mockResolvedValue(canceled(at(1800)));
        expect(await f.run(3599)).toMatchObject({ stopped: 0, closed: 0 });
        await f.run(3600);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(3600), endReason: 'session_max' });
    });

    it('a session opened on Free keeps its own 1-hour bound however late the sweep runs', async () => {
        const f = fixture([epoch({ deadlineAt: iso(3600) })], { sku: null });
        f.store.subscriptionsFor.mockResolvedValue(canceled(new Date(window.end)));
        await f.run(18 * 3600);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(3600), endReason: 'session_max' });
    });

    // A Worker 'start' (processor.ts) opens free-cf with no stored deadline; that is no paid era, so a late sweep never
    // moves its close past ready + 1 h. Sweeping at the cap itself would not tell the two branches apart.
    it.each([
        ['never paid', null],
        ['canceled', 'canceled'],
    ] as const)('a Free epoch with no stored deadline (%s) still closes at ready + 1 h when swept late', async (_, history) => {
        for (const late of [3660, 7200]) {
            const f = fixture([epoch({ size: 'free-cf', deadlineAt: null, lastHeartbeatAt: iso(late - 60) })], { sku: null });
            if (history) f.store.subscriptionsFor.mockResolvedValue(canceled(new Date(window.end)));
            expect(await f.run(late)).toMatchObject({ stopped: 1, closed: 1 });
            expect(f.epochs[0]).toMatchObject({ endedAt: iso(3600), endReason: 'session_max' });
            expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
        }
    });
});

describe('paid sessions have no time cap', () => {
    it.each([['standard_monthly_v3', 'std-2', 1], ['premium_monthly_v3', 'std-2', 1],
        ['premium_monthly_v3', 'cmp-4', 2], ['premium_monthly_v3', 'cmp-8', 4]] as const)(
        '%s / %s ignores 2h and 6h, stopping exactly at fair-use exhaustion', async (sku, size, weight) => {
            const allowance = 144000, deadline = allowance / weight;
            const f = fixture([epoch({ size, weight, deadlineAt: iso(sku === 'standard_monthly_v3' ? 7200 : 21600) })], { sku, allowance });
            for (const seconds of [7200, 21600, deadline - 1]) expect(await f.run(seconds)).toMatchObject({ stopped: 0 });
            expect(await f.run(deadline)).toMatchObject({ stopped: 1, closed: 1 });
            expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'allowance_exhausted');
            expect(f.epochs[0]).toMatchObject({ endedAt: iso(deadline), endReason: 'allowance_exhausted' });
        });
    it('a late failed provider stop still closes at fair-use exhaustion', async () => {
        const f = fixture([epoch({ size: 'cmp-8', weight: 4 })], { sku: 'premium_monthly_v3', allowance: 144000 });
        f.stop.mockRejectedValue(new Error('missed stop'));
        await f.run(144000);
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(36000), endReason: 'allowance_exhausted' });
    });
    it.each(['standard_monthly_v3', 'premium_monthly_v3'])('does not retry the retired session cap for %s', async sku => {
        const f = fixture([epoch({ endedAt: iso(7200), endReason: 'session_max' })], { sku });
        f.isStillRunning.mockResolvedValue(true);
        await f.run(7201);
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.isStillRunning).not.toHaveBeenCalled();
    });
    // Round 4 (D17): a fresh subscription payment issue opens a 7-day grace, so the paid session keeps running.
    it('keeps a paid session running during the payment grace', async () => {
        const f = fixture([epoch()], { sku: 'standard_monthly_v3', allowance: 144000 });
        f.store.openPaymentIssues.mockResolvedValue([{ stripeInvoiceId: 'in', userId: ref.userId, subscriptionId: 'sub',
            invoiceKind: 'subscription', issue: 'payment_failed', hostedInvoiceUrl: null, stripeEventCreated: T, updatedAt: T, resolvedAt: null }]);
        await f.run(10);
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.epochs[0].endedAt).toBeNull();
    });
    it('cuts a paid session to the Free limits once the payment grace has ended', async () => {
        const f = fixture([epoch()], { sku: 'standard_monthly_v3', allowance: 144000 });
        const eightDaysAgo = new Date(T.getTime() - 8 * 86_400_000);
        f.store.openPaymentIssues.mockResolvedValue([{ stripeInvoiceId: 'in', userId: ref.userId, subscriptionId: 'sub',
            invoiceKind: 'subscription', issue: 'payment_failed', hostedInvoiceUrl: null, stripeEventCreated: eightDaysAgo, updatedAt: eightDaysAgo, resolvedAt: null }]);
        await f.run(3601);
        expect(f.stop).toHaveBeenCalledTimes(1);
        expect(f.epochs[0].endedAt).not.toBeNull();
    });
    it('runs reconciliation after existing migration work with the original launch budget', async () => {
        const { advanceStaleMigrations } = await import('@/server/lib/compute/provider-migrate-orchestrator');
        const { reconcilePaidCloudflareUsers } = await import('@/server/lib/compute/provider-migrate-reconcile');
        vi.mocked(advanceStaleMigrations).mockClear(); vi.mocked(reconcilePaidCloudflareUsers).mockClear();
        vi.spyOn(Date, 'now').mockReturnValue(1234);
        await fixture().run(1);
        expect(advanceStaleMigrations).toHaveBeenCalledExactlyOnceWith(1234);
        expect(reconcilePaidCloudflareUsers).toHaveBeenCalledExactlyOnceWith(1234);
        expect(vi.mocked(advanceStaleMigrations).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(reconcilePaidCloudflareUsers).mock.invocationCallOrder[0]!);
    });
});

describe('round 6 R1-01: a held host is bounded by its session alone', () => {
    const canceled = [{ stripeSubscriptionId: 'sub', sku: 'standard_monthly_v3', status: 'canceled',
        currentPeriodStart: new Date(window.start), currentPeriodEnd: new Date(window.end), cancelAtPeriodEnd: false }];
    type Candidate = Awaited<ReturnType<NonNullable<SweepInput['runningAwsPlacements']>>>['candidates'][number];
    /**
     * A held candidate: `since` is the placement row's last write and `closedAt` its newest session's close (seconds
     * from T); `stoppedSinceClose` that its host stopped after that close (a later open now runs with no epoch).
     */
    const candidate = (over: { since?: number; closedAt?: number; stoppedSinceClose?: boolean; state?: Candidate['state']; computerId?: string } = {}): Candidate => ({
        ...ref, state: over.state ?? 'RUNNING', since: at(over.since ?? -600), closedAt: at(over.closedAt ?? -86_400),
        stoppedSinceClose: over.stoppedSinceClose ?? true, ...(over.computerId ? { computerId: over.computerId } : {}),
    });
    /** A Free (held) owner unless `paid`, whose placement read answers `pages` (one page by default). */
    function held(epochs: StoredComputeEpoch[], { paid = false, enforcement = true, pages = [[candidate()]] as Candidate[][] } = {}) {
        const f = fixture(epochs, { sku: paid ? 'standard_monthly_v3' : null, allowance: 144000, enforcement });
        if (!paid) f.store.subscriptionsFor.mockResolvedValue(canceled);
        const runningAwsPlacements = vi.fn<NonNullable<SweepInput['runningAwsPlacements']>>(async after => {
            const index = after === null ? 0 : Number(after);
            return { candidates: pages[index] ?? [], next: index + 1 < pages.length ? String(index + 1) : null };
        });
        const run = (seconds: number) => handleBillingSessionSweep({ deps: f.deps, now: at(seconds), stop: f.stop,
            isStillRunning: f.isStillRunning, runningAwsPlacements });
        return { ...f, runningAwsPlacements, run };
    }
    const lines = (event: string) => [...vi.mocked(console.info).mock.calls, ...vi.mocked(console.warn).mock.calls]
        .map(call => String(call[0])).filter(line => line.startsWith(`{"event":"${event}"`)).map(line => JSON.parse(line));

    it('the grace is two minutes (route.test pins the same), and a pass reads 10 pages of 100 within 10 s, by 30 s of the sweep', () => {
        expect(RUNNING_GRACE_MS).toBe(120_000);
        expect([HELD_PAGE_SIZE, HELD_PAGES, HELD_BUDGET_MS, HELD_SWEEP_BUDGET_MS]).toEqual([100, 10, 10_000, 30_000]);
    });

    it('stops a held RUNNING host whose later open never opened a session, once the grace has passed', async () => {
        const f = held([]);
        expect(await f.run(0)).toEqual({ ...zeros, heldOverrun: 1, stopped: 1 });
        expect(f.runningAwsPlacements).toHaveBeenCalledExactlyOnceWith(null, 100);
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
        expect(lines('held-overrun')).toEqual([{ event: 'held-overrun', computer: 'computer', session: 'none', enforced: true, overSeconds: 600 }]);
    });

    it.each([0, 60, 119])('leaves a held host alone %i s after its row changed (an epoch may be opening now)', async age => {
        const f = held([], { pages: [[candidate({ since: -age })]] });
        expect(await f.run(0)).toEqual(zeros);
        expect(f.store.openEpochFor).not.toHaveBeenCalled();
        expect(f.stop).not.toHaveBeenCalled();
    });

    it('leaves an open held session to the policy pass (stopped at its deadline there, not here)', async () => {
        const f = held([epoch({ deadlineAt: iso(3600) })]);
        expect(await f.run(100)).toEqual({ ...zeros, examined: 1 });
        expect(f.stop).not.toHaveBeenCalled();
    });

    it('keeps stopping a held host past the 2 h retry window while it still runs', async () => {
        const f = held([epoch({ readyAt: iso(-4 * 3600), endedAt: iso(-3 * 3600), endReason: 'session_max', deadlineAt: iso(-3 * 3600) })],
            { pages: [[candidate({ since: -4 * 3600, closedAt: -3 * 3600, stoppedSinceClose: false })]] });
        f.isStillRunning.mockResolvedValue(true);
        expect(await f.run(0)).toEqual({ ...zeros, heldOverrun: 1, stopped: 1 });
        expect(f.store.policyClosedEpochsSince).toHaveBeenCalledExactlyOnceWith(at(-7200), 50);
        expect(f.isStillRunning).not.toHaveBeenCalled(); // outside the retry window: only the held bound acts
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
        expect(lines('held-overrun')).toEqual([expect.objectContaining({ session: 'closed', overSeconds: 3 * 3600 })]);
    });

    // Review: a lease renewal moves the row's updated_at past the close; the line must still say how long since the cut.
    it('measures a never-stopped session from its close, not from a later lease renewal of the row', async () => {
        const f = held([], { pages: [[candidate({ since: -600, closedAt: -2 * 3600 - 1800, stoppedSinceClose: false })]] });
        await f.run(0);
        expect(lines('held-overrun')).toEqual([expect.objectContaining({ session: 'closed', overSeconds: 9000 })]);
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
    });

    it('a paid host keeps the 2 h window: no stop past it, and no lapsed-lease stop', async () => {
        const f = held([epoch({ readyAt: iso(-4 * 3600), endedAt: iso(-3 * 3600), endReason: 'allowance_exhausted' })],
            { paid: true, pages: [[candidate({ since: -4 * 3600, closedAt: -3 * 3600, stoppedSinceClose: false })]] });
        f.isStillRunning.mockResolvedValue(true);
        expect(await f.run(0)).toEqual(zeros);
        expect(f.stop).not.toHaveBeenCalled();
        expect(lines('held-overrun')).toEqual([]);
    });

    it('a paid host with no open session is not the held bound\'s to stop', async () => {
        const f = held([], { paid: true });
        expect(await f.run(0)).toEqual(zeros);
        expect(f.stop).not.toHaveBeenCalled();
    });

    it('stops a computer once per pass: a retry inside the window already attempted it', async () => {
        const f = held([epoch({ readyAt: iso(-3600), endedAt: iso(-60), endReason: 'session_max', deadlineAt: iso(-60) })],
            { pages: [[candidate({ since: -3600, closedAt: -60, stoppedSinceClose: false })]] });
        f.isStillRunning.mockResolvedValue(true);
        expect(await f.run(0)).toEqual({ ...zeros, retried: 1, stopped: 1 });
        expect(f.isStillRunning).toHaveBeenCalledExactlyOnceWith(ref, at(-60));
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
    });

    it('shadow-logs with BILLING_ENFORCEMENT off, never stopping', async () => {
        const f = held([], { enforcement: false });
        expect(await f.run(0)).toEqual({ ...zeros, heldOverrun: 1, shadow: 1 });
        expect(f.stop).not.toHaveBeenCalled();
        expect(lines('held-overrun')).toEqual([expect.objectContaining({ enforced: false, session: 'none' })]);
    });

    // Only a stop that leaves the row RUNNING (a lost CAS, a config failure) can be retried from here; a refused or
    // failed Step Functions stop leaves it UNCONFIRMED (next test).
    it('a stop that throws and leaves the row RUNNING is counted and retried on the next pass', async () => {
        const f = held([]);
        f.stop.mockRejectedValueOnce(new Error('stop unavailable'));
        expect(await f.run(0)).toMatchObject({ heldOverrun: 1, stopFailed: 1 });
        expect(await f.run(60)).toMatchObject({ heldOverrun: 1, stopped: 1 });
        expect(f.stop).toHaveBeenCalledTimes(2);
    });

    it('reports a held UNCONFIRMED row (a refused or failed stop) every pass, and never stops it from here', async () => {
        const f = held([], { pages: [[candidate({ state: 'UNCONFIRMED', since: -3600, closedAt: -4000 })]] });
        expect(await f.run(0)).toEqual(zeros);
        expect(await f.run(60)).toEqual(zeros);
        expect(f.stop).not.toHaveBeenCalled();
        expect(lines('held-unconfirmed')).toEqual([
            { event: 'held-unconfirmed', computer: 'computer', closedSeconds: 4000 },
            { event: 'held-unconfirmed', computer: 'computer', closedSeconds: 4060 },
        ]);
        const paid = held([], { paid: true, pages: [[candidate({ state: 'UNCONFIRMED' })]] });
        await paid.run(0);
        expect(lines('held-unconfirmed')).toHaveLength(2); // a paid row is not held: nothing new
    });

    it('reads every page until the last, so a held host behind other closes is still found', async () => {
        // Newer closes of paid computers fill the first pages; the held host's own session closed 9 days ago.
        const paidPage = (page: number) => Array.from({ length: 3 }, (_, i) =>
            ({ ...candidate({ computerId: `paid-${page}-${i}`, stoppedSinceClose: false }), userId: 'paid' }));
        const f = held([], { pages: [paidPage(0), paidPage(1), [candidate({ closedAt: -9 * 86_400 })]] });
        f.store.subscriptionsFor.mockImplementation(async userId => userId === ref.userId ? canceled : [{ stripeSubscriptionId: 'sub',
            sku: 'standard_monthly_v3', status: 'active', currentPeriodStart: new Date(window.start), currentPeriodEnd: new Date(window.end), cancelAtPeriodEnd: false }]);
        await f.run(0);
        expect(f.runningAwsPlacements.mock.calls).toEqual([[null, 100], ['1', 100], ['2', 100]]);
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
    });

    it('stops reading after HELD_PAGES pages, and when its own time budget is spent', async () => {
        const pages = Array.from({ length: 12 }, () => [] as Candidate[]);
        const f = held([], { pages });
        await f.run(0);
        expect(f.runningAwsPlacements).toHaveBeenCalledTimes(10);
        const clock = vi.spyOn(Date, 'now');
        let t = 0;
        clock.mockImplementation(() => (t += 4_000));
        f.runningAwsPlacements.mockClear();
        await f.run(60);
        // Each clock read is 4 s later: the pass starts at s, reads at s + 4 and s + 8, and stops at s + 12 (≥ 10 s).
        expect(f.runningAwsPlacements).toHaveBeenCalledTimes(2);
        // A held pass that starts late in the sweep ends by 30 s from the sweep's start, not 10 s after its own: the
        // sweep starts at 1 ms, the pass at 27 s, reads at 28, 29 and 30 s, and stops at 31 s (its own 10 s: 37 s).
        let late = 0;
        clock.mockImplementation(() => (late += late === 0 ? 1 : late < 27_000 ? 26_999 : 1_000));
        f.runningAwsPlacements.mockClear();
        await f.run(120);
        expect(f.runningAwsPlacements).toHaveBeenCalledTimes(3);
        expect(console.warn).toHaveBeenCalledWith('[billing.sweep] held pass out of time', expect.objectContaining({ page: expect.any(Number) }));
    });

    it('an unreadable placement list or billing state skips the held pass, never the rest of the sweep', async () => {
        const f = held([]);
        f.runningAwsPlacements.mockRejectedValueOnce(new Error('placements unavailable'));
        expect(await f.run(0)).toEqual(zeros);
        f.store.subscriptionsFor.mockRejectedValueOnce(new Error('billing unavailable'));
        expect(await f.run(0)).toEqual(zeros);
        expect(f.stop).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith('[billing.sweep] held scan unavailable');
        expect(console.warn).toHaveBeenCalledWith('[billing.sweep] held check failed', { computer: 'computer' });
    });
});

// Round 6 R2-3: a session opened while the new paid period's grant was still on its way is not out of allowance.
describe('round 6 R2-3: a paid session waits for its period grant', () => {
    function fresh(periodStartSeconds: number) {
        const f = fixture([epoch({ readyAt: iso(0), deadlineAt: iso(0) })], { sku: 'standard_monthly_v3' });
        f.store.subscriptionsFor.mockResolvedValue([{ stripeSubscriptionId: 'sub', sku: 'standard_monthly_v3', status: 'active',
            currentPeriodStart: at(periodStartSeconds), currentPeriodEnd: at(periodStartSeconds + 30 * 86_400), cancelAtPeriodEnd: false }]);
        f.store.grantsForPeriod.mockResolvedValue([]);
        return f;
    }
    it('is not stopped as allowance_exhausted while the grant is pending', async () => {
        const f = fresh(-120);
        expect(await f.run(60)).toEqual({ ...zeros, examined: 1 });
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.epochs[0]!.endedAt).toBeNull();
    });
    it('is stopped once the pending bound has passed with no grant (unchanged)', async () => {
        const f = fresh(-600);
        await f.run(60);
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'allowance_exhausted');
    });
});

describe('round 3: stale AWS epochs and drain counts (D9/D6)', () => {
    function run(f: ReturnType<typeof fixture>, seconds: number, awsStopProof?: SweepInput['awsStopProof']) {
        return handleBillingSessionSweep({ deps: f.deps, now: at(seconds), stop: f.stop, isStillRunning: f.isStillRunning, awsStopProof });
    }
    it('closes a stale AWS epoch whose placement stopped at the proven stop time, without stopping anything', async () => {
        const f = fixture([epoch({ lastHeartbeatAt: iso(600) })], { sku: 'premium_monthly_v3', allowance: 1_800_000 });
        const proof = vi.fn<NonNullable<SweepInput['awsStopProof']>>().mockResolvedValue({ running: false, stoppedAt: at(900) });
        expect(await run(f, 7200, proof)).toEqual({ ...zeros, examined: 1, closed: 1, awsStaleClosed: 1 });
        expect(proof).toHaveBeenCalledExactlyOnceWith(ref);
        expect(f.store.closeEpoch).toHaveBeenCalledExactlyOnceWith({ computerId: 'computer', epochId: 'epoch', endedAt: at(900), reason: 'provider_stop' });
        expect(f.stop).not.toHaveBeenCalled();
        expect(f.epochs[0]).toMatchObject({ endedAt: iso(900), endReason: 'provider_stop' });
    });
    it('closes only the epoch it examined: a newer generation opened meanwhile stays open', async () => {
        const f = fixture([epoch({ lastHeartbeatAt: iso(600) })], { sku: 'premium_monthly_v3', allowance: 1_800_000 });
        const proof = vi.fn<NonNullable<SweepInput['awsStopProof']>>(async () => {
            // While the sweep reads the placement, the receipts close the old epoch and the restarted host opens the next one.
            f.epochs[0]!.endedAt = iso(900); f.epochs[0]!.endReason = 'provider_stop';
            f.epochs.push(epoch({ id: 'epoch-next', readyAt: iso(7000) }));
            return { running: false, stoppedAt: at(900) };
        });
        expect(await run(f, 7200, proof)).toEqual({ ...zeros, examined: 1 });
        expect(f.store.closeEpoch).toHaveBeenCalledExactlyOnceWith({ computerId: 'computer', epochId: 'epoch', endedAt: at(900), reason: 'provider_stop' });
        expect(f.epochs[1]).toMatchObject({ id: 'epoch-next', endedAt: null });
    });
    it.each([[null, 600], [at(-5), 600], [at(9000), 7200]] as const)('falls back to the last heartbeat, or bounds by now, when the stop time is %s', async (stoppedAt, endedAt) => {
        const f = fixture([epoch({ lastHeartbeatAt: iso(600) })], { sku: 'premium_monthly_v3', allowance: 1_800_000 });
        await run(f, 7200, async () => ({ running: false, stoppedAt }));
        expect(f.epochs[0]!.endedAt).toBe(iso(endedAt));
    });
    it.each(['running', 'throws', 'fresh heartbeat', 'no proof port', 'cloudflare'] as const)('keeps the AWS epoch open when %s', async scenario => {
        const e = epoch({ lastHeartbeatAt: scenario === 'fresh heartbeat' ? iso(7000) : iso(600), size: scenario === 'cloudflare' ? 'free-cf' : 'std-2' });
        const f = fixture([e], { sku: 'premium_monthly_v3', allowance: 1_800_000 });
        const proof = vi.fn<NonNullable<SweepInput['awsStopProof']>>(async () => {
            if (scenario === 'throws') throw new Error('placement read failed');
            return { running: scenario === 'running', stoppedAt: at(900) };
        });
        const counts = await run(f, 7200, scenario === 'no proof port' ? undefined : proof);
        expect(counts.awsStaleClosed).toBe(0);
        if (scenario === 'cloudflare') { expect(counts.heartbeatClosed).toBe(1); expect(proof).not.toHaveBeenCalled(); return; }
        expect(f.epochs[0]!.endedAt).toBeNull();
        expect(f.store.closeEpoch).not.toHaveBeenCalled();
        if (scenario === 'fresh heartbeat' || scenario === 'no proof port') expect(proof).not.toHaveBeenCalled();
    });
    it('returns and logs the AI outbox drain counts', async () => {
        vi.spyOn(aiOutbox, 'drainAiCreditOutbox').mockResolvedValue({ claimed: 5, done: 3, failed: 1, retry: 1, skipped: 1 });
        const f = fixture([]);
        expect(await f.run(0)).toEqual({ ...zeros, ai: { drained: 5, delivered: 3, retried: 1, failed: 1 } });
        expect(vi.mocked(console.info).mock.calls.map(call => String(call[0])).filter(line => line.startsWith('{')).map(line => JSON.parse(line)))
            .toEqual([{ event: 'billing-sweep', ...zeros, ai: { drained: 5, delivered: 3, retried: 1, failed: 1 } }]);
        f.deps.config.enforcementEnabled = false; f.deps.config.tabEnabled = false;
        expect((await f.run(0)).ai).toEqual({ drained: 5, delivered: 3, retried: 1, failed: 1 });
    });
});
