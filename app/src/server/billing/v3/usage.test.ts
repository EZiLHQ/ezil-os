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
            disk: { provisionedGiB: 50, usedBytes: null, usedGiB: null, growsOnSwitch: false } });
        const free = input(); free.subs = []; free.grants = [];
        expect(buildUsageV3(free).storage).toMatchObject({ state: 'unavailable', capBytes: null, disk: { provisionedGiB: null, usedBytes: null } });
        free.storage = [{ computerId: 'c', bytes: BigInt(7), measuredAt: now }];
        expect(buildUsageV3(free).storage).toMatchObject({ state: 'sampled', capBytes: null, disk: { provisionedGiB: null, usedBytes: '7' } });
    });
});

describe('round 6 settings truth: Free, and Free held on AWS (D16)', () => {
    // contact@ on 10-30: every subscription cancelled at once, the AWS computer kept, a std-2 hold session running.
    const held = (): Input => ({ ...input(), userCreatedAt: new Date('2026-10-22T00:00:00Z'), grants: [], sizePreference: 'std-2',
        subs: [{ sku: 'premium_monthly_v3', stripeSubscriptionId: 'sub', status: 'canceled',
            currentPeriodStart: new Date('2026-10-27Z'), currentPeriodEnd: new Date('2026-11-27Z'), cancelAtPeriodEnd: false }],
        epochs: [{ ...epoch, size: 'std-2', weight: 1, readyAt: '2026-10-26T11:30:00Z', deadlineAt: '2026-10-26T12:29:59Z', lastHeartbeatAt: null }],
        placementProvider: 'aws-ec2' });
    it('legacy Free: the allowance is the real 8 hours (FREE_V2_EFFECTIVE_AT is null), never the 5 the new Free offer has', () => {
        const period = buildUsageV3(held()).period;
        expect(period).toMatchObject({ allowanceStandardSeconds: 8 * 3600, usedStandardSeconds: 1800, remainingHoursAtCurrent: 7 });
        const newer = held(); newer.freeEffectiveAt = '2026-10-01T00:00:00Z';
        expect(buildUsageV3(newer).period.allowanceStandardSeconds).toBe(5 * 3600);
    });
    it('held std-2: the only configuration is the held 2 vCPU (no "Same as" Cloudflare equivalent) and the disk is the real AWS volume', () => {
        const result = buildUsageV3({ ...held(), volumeGiB: 50 });
        expect(result.period).toMatchObject({ currentSize: 'std-2', currentWeight: 1, equivalents: [{ size: 'std-2', weight: 1, hours: 7 }] });
        expect(result.storage).toMatchObject({ capBytes: String(50 * 1024 ** 3), disk: { provisionedGiB: 50 } });
        // Stopped between hold sessions: still the held computer, still its disk (unreadable → the 50 GB fallback).
        const stopped = held(); stopped.epochs = [{ ...stopped.epochs[0]!, endedAt: '2026-10-26T11:45:00Z' }];
        expect(buildUsageV3(stopped).period).toMatchObject({ currentSize: 'std-2', equivalents: [{ size: 'std-2' }] });
        expect(buildUsageV3(stopped).storage.disk.provisionedGiB).toBe(50);
    });
    it('Free with the files on Cloudflare, or an unknown placement, keeps the Cloudflare configuration and invents no disk', () => {
        for (const placementProvider of ['cloudflare', null, undefined] as const) {
            const free = held(); free.placementProvider = placementProvider; free.epochs = [];
            const result = buildUsageV3(free);
            expect(result.period).toMatchObject({ currentSize: 'free-cf', equivalents: [{ size: 'free-cf', weight: 1, hours: 8 }] });
            expect(result.storage.disk.provisionedGiB).toBeNull();
        }
    });
    it('a paid account in its payment grace is not held, even with an AWS placement', () => {
        const grace = input(); grace.placementProvider = 'aws-ec2';
        grace.subs = [{ ...grace.subs[0]!, status: 'past_due' }];
        grace.paymentIssues = [{ subscriptionId: 'sub', invoiceKind: 'subscription', issue: 'payment_failed', resolvedAt: null,
            stripeEventCreated: new Date('2026-10-25T00:00:00Z') } as Input['paymentIssues'][number]];
        expect(buildUsageV3(grace).period.equivalents.map(item => item.size)).toEqual(['std-2', 'cmp-4', 'cmp-8']);
    });
});

describe('round 5 D3: usage shows the REAL volume and used space in GiB', () => {
    const GiB = 1024 ** 3;
    it('the volume size passed in is the disk (100 GiB Premium today, 50 GiB older); unreadable falls back to 50', () => {
        const args = input();
        args.storage = [{ computerId: 'c', bytes: BigInt(43) * BigInt(GiB), measuredAt: now }];
        expect(buildUsageV3({ ...args, volumeGiB: 100 }).storage).toMatchObject({ capBytes: String(100 * GiB),
            disk: { provisionedGiB: 100, usedBytes: String(43 * GiB), usedGiB: 43, growsOnSwitch: false } });
        expect(buildUsageV3({ ...args, volumeGiB: 50 }).storage).toMatchObject({ capBytes: String(50 * GiB), disk: { provisionedGiB: 50 } });
        for (const volumeGiB of [null, undefined, 0, Number.NaN]) {
            expect(buildUsageV3({ ...args, volumeGiB }).storage).toMatchObject({ capBytes: String(50 * GiB), disk: { provisionedGiB: 50 } });
        }
    });
    it('usage for one computer meters that computer\'s used space against that computer\'s volume (not every computer\'s sum)', () => {
        const args = input();
        const [c1, c2] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
        args.storage = [{ computerId: c1, bytes: BigInt(10) * BigInt(GiB), measuredAt: now },
            { computerId: c2, bytes: BigInt(45) * BigInt(GiB), measuredAt: now }];
        const scoped = buildUsageV3({ ...args, computerId: c1, volumeGiB: 50 }).storage;
        expect(scoped).toMatchObject({ capBytes: String(50 * GiB), disk: { provisionedGiB: 50, usedBytes: String(10 * GiB), usedGiB: 10 } });
        // The upper-case id the router accepts scopes the same computer; the raw samples list stays complete.
        expect(buildUsageV3({ ...args, computerId: c1.toUpperCase(), volumeGiB: 50 }).storage.disk).toMatchObject({ usedGiB: 10 });
        expect(scoped.samples.map(sample => sample.computerId).sort()).toEqual([c1, c2]);
        // No computer named: every computer's latest sample, as before.
        expect(buildUsageV3({ ...args, volumeGiB: 50 }).storage.disk).toMatchObject({ usedGiB: 55 });
    });
});
