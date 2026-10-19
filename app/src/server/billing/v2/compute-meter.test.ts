import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { BillingDeps, BillingStore, OpenEpochInput, StoredComputeEpoch } from '../ports';
import { billingComputeMeter, noopComputeMeter } from './compute-meter';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

const READY = new Date('2026-10-19T12:00:00Z');
const ref = { userId: 'user_a', computerId: 'computer_a' };
const ready = { ...ref, size: 'cmp-4' as const, readyAt: READY, overheadSeconds: 17 };
const stopped = { ...ref, endedAt: new Date('2026-10-19T12:10:00.999Z'), reason: 'user_stop' as const };
const heartbeat = { ...ref, at: READY };

function fixture(flags: Record<string, string | undefined> = { BILLING_TAB_ENABLED: '1' }) {
    let epoch: StoredComputeEpoch | null = null;
    const start = new Date('2026-10-01T00:00:00Z');
    const end = new Date('2026-11-01T00:00:00Z');
    const store = {
        subscriptionsFor: vi.fn(async () => [{ stripeSubscriptionId: 'sub_a', sku: 'compute_monthly_v2', status: 'active',
            currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false }]),
        userCreatedAt: vi.fn(async () => null), openPlanChanges: vi.fn(async () => []),
        epochsFor: vi.fn(async () => epoch ? [epoch] : []),
        grantsForPeriod: vi.fn(async () => [{ id: 'grant_a', userId: ref.userId, subscriptionId: 'sub_a',
            meter: 'compute_std_seconds', kind: 'plan_period', amount: BigInt(2000), periodStart: start, periodEnd: end,
            sourceType: 'invoice', sourceId: 'in_a', createdAt: READY }]),
        latestConsent: vi.fn(async () => null), openPaymentIssues: vi.fn(async () => []), sizePreference: vi.fn(async () => 'std-2'),
        openEpoch: vi.fn(async (input: OpenEpochInput) => {
            if (epoch) return { status: 'exists', epoch };
            epoch = { id: 'epoch_a', ...ref, size: input.size, weight: 2, readyAt: input.readyAt.toISOString(),
                endedAt: null, endReason: null, overheadSeconds: input.overheadSeconds ?? 0, lastHeartbeatAt: null,
                deadlineAt: new Date(input.deadlineAt!).toISOString() };
            return { status: 'opened', epoch };
        }),
        closeEpoch: vi.fn(async () => 'closed'), touchEpoch: vi.fn(async () => 'touched'),
    };
    const deps: BillingDeps = { config: readBillingConfig(flags), store: store as unknown as BillingStore, stripe: null, now: () => READY };
    return { store, deps, meter: billingComputeMeter(() => deps), epoch: () => epoch };
}

afterEach(() => vi.restoreAllMocks());

describe('billingComputeMeter', () => {
    it('both flags off makes zero store accesses for ready, stopped and heartbeat', async () => {
        const access = vi.fn(() => { throw new Error('billing tables absent'); });
        const deps = { config: readBillingConfig({ CHECKOUT_ENABLED: '1', PRICING_PAGE_ENABLED: '1' }),
            store: new Proxy({} as BillingStore, { get: access }), stripe: null, now: () => READY };
        const meter = billingComputeMeter(() => deps);
        await meter.ready(ready);
        await meter.stopped(stopped);
        await meter.heartbeat(heartbeat);
        expect(access).not.toHaveBeenCalled();
    });

    it.each([{ BILLING_TAB_ENABLED: '1' }, { BILLING_ENFORCEMENT: '1' }])('either flag stores a readiness deadline (%j)', async flags => {
        const f = fixture(flags);
        await f.meter.ready(ready);
        expect(f.store.openEpoch).toHaveBeenCalledExactlyOnceWith({ ...ready, subscriptionId: 'sub_a',
            deadlineAt: new Date('2026-10-19T12:16:40Z') });
        expect(f.epoch()).toMatchObject({ size: 'cmp-4', overheadSeconds: 17, deadlineAt: '2026-10-19T12:16:40.000Z' });
        await f.meter.ready({ ...ready, readyAt: new Date('2026-10-19T12:05:00Z'), overheadSeconds: 999 });
        expect(f.epoch()).toMatchObject({ readyAt: READY.toISOString(), overheadSeconds: 17, deadlineAt: '2026-10-19T12:16:40.000Z' });
    });

    it('floors stop time and passes optional overhead; heartbeat keeps its observation time', async () => {
        const f = fixture();
        await f.meter.stopped({ ...stopped, overheadSeconds: 5 });
        expect(f.store.closeEpoch).toHaveBeenCalledExactlyOnceWith({ computerId: ref.computerId,
            endedAt: new Date('2026-10-19T12:10:00Z'), reason: 'user_stop', overheadSeconds: 5 });
        await f.meter.heartbeat(heartbeat);
        expect(f.store.touchEpoch).toHaveBeenCalledExactlyOnceWith(ref.computerId, READY);
    });

    it.each(['subscriptionsFor', 'openEpoch', 'closeEpoch', 'touchEpoch'] as const)('%s throwing cannot fail a meter call', async method => {
        const f = fixture();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        f.store[method].mockRejectedValue(new Error('tables absent'));
        await expect(f.meter.ready(ready)).resolves.toBeUndefined();
        await expect(f.meter.stopped(stopped)).resolves.toBeUndefined();
        await expect(f.meter.heartbeat(heartbeat)).resolves.toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('[billing.meter]'), expect.any(Object));
    });

    it('dependency construction failures are also non-fatal', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const meter = billingComputeMeter(() => { throw new Error('deps unavailable'); });
        await expect(meter.ready(ready)).resolves.toBeUndefined();
        await expect(meter.stopped(stopped)).resolves.toBeUndefined();
        await expect(meter.heartbeat(heartbeat)).resolves.toBeUndefined();
    });

    it('noop defaults accept every signal', async () => {
        await expect(noopComputeMeter.ready(ready)).resolves.toBeUndefined();
        await expect(noopComputeMeter.stopped(stopped)).resolves.toBeUndefined();
        await expect(noopComputeMeter.heartbeat(heartbeat)).resolves.toBeUndefined();
    });
});
