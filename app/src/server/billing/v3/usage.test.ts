import { describe, expect, it } from 'vitest';
import { readBillingConfig } from '../config';
import type { StoredComputeEpoch } from '../ports';
import { buildUsageV3 } from './usage';

type Input = Parameters<typeof buildUsageV3>[0];
const now = new Date('2026-10-26T12:00:00Z');
const epoch: StoredComputeEpoch = { id: 'e', userId: 'u', computerId: 'c', size: 'cmp-4', weight: 2,
    readyAt: '2026-10-26T11:00:00Z', endedAt: null, endReason: null, overheadSeconds: 0,
    deadlineAt: null, lastHeartbeatAt: '2026-10-26T11:59:30Z' };
const input = (): Input => ({ config: readBillingConfig({ BILLING_TAB_ENABLED: '1' }), now, userCreatedAt: now,
    subs: [{ sku: 'premium_monthly_v3', stripeSubscriptionId: 'sub', status: 'active',
        currentPeriodStart: new Date('2026-10-01Z'), currentPeriodEnd: new Date('2026-11-01Z'), cancelAtPeriodEnd: false }],
    epochs: [epoch], grants: [{ id: 'g', userId: 'u', subscriptionId: 'sub', meter: 'compute_std_seconds',
        kind: 'plan_period', amount: BigInt(500 * 3600), periodStart: new Date('2026-10-01Z'), periodEnd: new Date('2026-11-01Z'),
        sourceType: 'invoice', sourceId: 'in', createdAt: now }],
    storage: [], consent: null, overageInvoices: [], planChanges: [], paymentIssues: [], sizePreference: null, hasCustomer: false });

describe('read-only usage observations', () => {
    it('separates wall time from weighted quota and never fabricates storage or egress', () => {
        const result = buildUsageV3(input());
        expect(result.session).toMatchObject({ state: 'recording', elapsedSeconds: 3600, observedAt: epoch.lastHeartbeatAt });
        expect(result.period).toMatchObject({ usedStandardSeconds: 7200, allowanceStandardSeconds: 1800000,
            remainingStandardSeconds: 1792800, unit: 'standard_seconds' });
        expect(result.storage).toMatchObject({ state: 'unavailable', samples: [] });
        expect(result.egress).toEqual({ state: 'unavailable', usedBytes: null });
    });
    it.each([null, '2026-10-26T13:00:00Z', '2026-10-26T10:00:00Z'])(
        'does not extrapolate a missing or invalid heartbeat %s', lastHeartbeatAt => {
            const args = input(); args.epochs = [{ ...epoch, lastHeartbeatAt } as StoredComputeEpoch];
            expect(buildUsageV3(args).session).toMatchObject({ state: 'stale', elapsedSeconds: 0, observedAt: epoch.readyAt });
        });
    it('freezes stale time and uses actual stop even with a newer heartbeat', () => {
        const args = input(); args.epochs = [{ ...epoch, lastHeartbeatAt: '2026-10-26T11:10:00Z' } as StoredComputeEpoch];
        expect(buildUsageV3(args).session).toMatchObject({ state: 'stale', elapsedSeconds: 600 });
        args.epochs = [{ ...epoch, endedAt: '2026-10-26T11:20:00Z' }];
        expect(buildUsageV3(args).session).toMatchObject({ state: 'ended', elapsedSeconds: 1200 });
    });
    it('selects the requested computer without borrowing another computer session', () => {
        const args = input(); args.computerId = 'other';
        expect(buildUsageV3(args).session).toMatchObject({ computerId: 'other', state: 'unavailable', elapsedSeconds: null });
        args.epochs = [epoch, { ...epoch, id: 'older', computerId: 'other', readyAt: '2026-10-26T10:00:00Z', endedAt: '2026-10-26T10:30:00Z' }];
        expect(buildUsageV3(args).session).toMatchObject({ computerId: 'other', state: 'ended', elapsedSeconds: 1800 });
    });
    it('clips period usage at the period start and server now, excluding future sessions', () => {
        const args = input(); args.now = new Date('2026-10-01T00:30:00Z');
        args.epochs = [{ ...epoch, readyAt: '2026-09-30T23:00:00Z', endedAt: '2026-10-01T02:00:00Z' },
            { ...epoch, id: 'future', readyAt: '2026-10-02T00:00:00Z', endedAt: '2026-10-02T01:00:00Z' }];
        expect(buildUsageV3(args).period.usedStandardSeconds).toBe(3600);
        expect(buildUsageV3(args).session.elapsedSeconds).toBe(5400);
    });
    it('counts only the actual closed duration after an outage', () => {
        const args = input(); args.epochs = [{ ...epoch, endedAt: '2026-10-26T11:20:00Z' }];
        args.now = new Date('2026-10-30T12:00:00Z');
        expect(buildUsageV3(args).period.usedStandardSeconds).toBe(2400);
        expect(buildUsageV3(args).session.elapsedSeconds).toBe(1200);
    });
    it('keeps each storage observation timestamp and never claims a complete aggregate', () => {
        const args = input(); args.storage = [
            { computerId: 'a', bytes: BigInt(100), measuredAt: new Date('2026-10-20Z') },
            { computerId: 'a', bytes: BigInt(200), measuredAt: now },
            { computerId: 'b', bytes: BigInt(300), measuredAt: new Date('2026-10-01Z') },
        ];
        const result = buildUsageV3(args).storage;
        expect(result.state).toBe('sampled');
        expect(result.samples).toEqual([
            { computerId: 'a', bytes: '200', measuredAt: now.toISOString() },
            { computerId: 'b', bytes: '300', measuredAt: '2026-10-01T00:00:00.000Z' },
        ]);
        expect(result).not.toHaveProperty('usedBytes');
    });
});

describe('round 3 hours at the current configuration (D3/D8)', () => {
    // 452 standard-hours left: the founder's example.
    function at(remainingHours: number) {
        const args = input();
        args.grants[0]!.amount = BigInt(remainingHours * 3600);
        args.epochs = [];
        return args;
    }
    it.each([['std-2', 1, 452], ['cmp-4', 2, 226], ['cmp-8', 4, 113]] as const)('a stopped %s computer shows %s× weight: %s hours', (size, weight, hours) => {
        const args = at(452); args.sizePreference = size;
        expect(buildUsageV3(args).period).toMatchObject({ remainingStandardSeconds: 452 * 3600, currentSize: size, currentWeight: weight,
            remainingHoursAtCurrent: hours, equivalents: [{ size: 'std-2', weight: 1, hours: 452 }, { size: 'cmp-4', weight: 2, hours: 226 },
                { size: 'cmp-8', weight: 4, hours: 113 }] });
    });
    it('a running session wins over the next-open choice, and an invalid choice falls back to the plan default', () => {
        const args = at(452);
        args.epochs = [{ ...epoch, size: 'cmp-8', weight: 4, readyAt: '2026-10-26T12:00:00Z', lastHeartbeatAt: null } as StoredComputeEpoch];
        args.sizePreference = 'std-2';
        expect(buildUsageV3(args).period).toMatchObject({ currentSize: 'cmp-8', currentWeight: 4, remainingHoursAtCurrent: 113 });
        const standard = at(30); standard.subs[0]!.sku = 'standard_monthly_v3'; standard.sizePreference = 'cmp-8';
        expect(buildUsageV3(standard).period).toMatchObject({ currentSize: 'std-2', currentWeight: 1, remainingHoursAtCurrent: 30,
            equivalents: [{ size: 'std-2', weight: 1, hours: 30 }] });
    });
    it('rounds down and never goes negative', () => {
        const args = at(0); args.grants[0]!.amount = BigInt(3599);
        args.sizePreference = 'std-2';
        expect(buildUsageV3(args).period.remainingHoursAtCurrent).toBe(0);
        args.epochs = [{ ...epoch, endedAt: '2026-10-26T11:30:00Z' }];
        const period = buildUsageV3(args).period; // Rating stops a weight-2 session at the last whole second it can afford.
        expect(period).toMatchObject({ remainingStandardSeconds: 1, remainingHoursAtCurrent: 0, currentWeight: 1 });
        expect(period.equivalents.every(item => item.hours === 0)).toBe(true);
    });
});

describe('round 3 storage in usage (D10)', () => {
    it('reports the provisioned AWS disk, and no cap at all on Free', () => {
        expect(buildUsageV3(input()).storage).toEqual({ state: 'unavailable', capBytes: String(50 * 1024 ** 3), samples: [],
            disk: { provisionedGiB: 50, usedBytes: null } });
        const free = input(); free.subs = []; free.grants = [];
        expect(buildUsageV3(free).storage).toMatchObject({ state: 'unavailable', capBytes: null, disk: { provisionedGiB: null, usedBytes: null } });
        free.storage = [{ computerId: 'c', bytes: BigInt(7), measuredAt: now }];
        expect(buildUsageV3(free).storage).toMatchObject({ state: 'sampled', capBytes: null, disk: { provisionedGiB: null, usedBytes: '7' } });
    });
});
