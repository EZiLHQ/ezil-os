import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from '@/server/billing/config';
import type { BillingDeps, BillingStore, StoredComputeEpoch } from '@/server/billing/ports';
import { loadComputeBillingState } from '@/server/billing/v2/compute-access';
import { SIZES } from '@/server/billing/v2/contract';
import { rateWindow } from '@/server/billing/v2/rating';
import { epochSeconds, isoSeconds } from '@/server/billing/v2/time';
import { handleBillingSessionSweep } from './handler';

vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ advanceStaleMigrations: vi.fn() }));
vi.mock('@/server/lib/compute/provider-migrate-reconcile', () => ({ reconcilePaidCloudflareUsers: vi.fn() }));

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

const T = new Date('2026-10-18T00:00:00Z');
const at = (seconds: number) => new Date(T.getTime() + seconds * 1000);
const iso = (seconds: number) => isoSeconds(epochSeconds(at(seconds)));
const window = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };
const zeros = { examined: 0, stopped: 0, closed: 0, stopFailed: 0, heartbeatClosed: 0, retried: 0, shadow: 0 };
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
        closeEpoch: vi.fn<BillingStore['closeEpoch']>(async input => {
            const open = epochs.find(e => e.computerId === input.computerId && e.endedAt === null);
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
    it('is not due at 21,599 seconds and closes at exactly 21,600', async () => {
        const f = fixture();
        expect(await f.run(21599)).toEqual({ ...zeros, examined: 1 });
        expect(f.stop).not.toHaveBeenCalled();
        expect(await f.run(21600)).toEqual({ ...zeros, examined: 1, stopped: 1, closed: 1 });
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'session_max');
        expect(f.store.closeEpoch).toHaveBeenCalledExactlyOnceWith({ computerId: ref.computerId, endedAt: at(21600), reason: 'session_max' });
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
        expect(console.info).toHaveBeenCalledExactlyOnceWith('[billing.sweep] shadow', expect.objectContaining({ epochId: 'epoch', reason: 'session_max' }));
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
        expect(f.isStillRunning).toHaveBeenCalledTimes(1);
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
    it('stops a paid session with a subscription payment issue before fair use', async () => {
        const f = fixture([epoch()], { sku: 'standard_monthly_v3', allowance: 144000 });
        f.store.openPaymentIssues.mockResolvedValue([{ stripeInvoiceId: 'in', userId: ref.userId, subscriptionId: 'sub',
            invoiceKind: 'subscription', issue: 'payment_failed', hostedInvoiceUrl: null, stripeEventCreated: T, updatedAt: T, resolvedAt: null }]);
        await f.run(10);
        expect(f.stop).toHaveBeenCalledExactlyOnceWith(ref, 'allowance_exhausted');
        expect(f.epochs[0].endedAt).toBe(iso(10));
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
