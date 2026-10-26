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
