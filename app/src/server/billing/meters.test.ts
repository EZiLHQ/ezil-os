import { describe, expect, it } from 'vitest';

import { AI_PACKS, catalogPro, PRO_PLAN } from './catalog';
import { readBillingConfig } from './config';
import {
    buildSummary,
    freeWindow,
    resolvePlan,
    storageState,
    workspaceState,
    workspaceUsedSeconds,
    type IntervalRow,
    type SubscriptionRow,
} from './meters';

const NOW = new Date('2026-10-11T12:00:00.000Z');
const PERIOD_START = new Date('2026-10-05T08:30:00.000Z');
const PERIOD_END = new Date('2026-11-05T08:30:00.000Z');

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
    return {
        stripeSubscriptionId: 'sub_test',
        status: 'active',
        sku: PRO_PLAN.sku,
        currentPeriodStart: PERIOD_START,
        currentPeriodEnd: PERIOD_END,
        cancelAtPeriodEnd: false,
        ...overrides,
    };
}

function summary(overrides: Partial<Parameters<typeof buildSummary>[0]> = {}) {
    return buildSummary({
        config: readBillingConfig({}),
        now: NOW,
        subs: [],
        intervals: [],
        storage: [],
        ...overrides,
    });
}

describe('freeWindow', () => {
    it.each([
        ['2026-10-01T00:00:00.000Z', '2026-10-01', '2026-11-01'],
        ['2026-10-31T23:59:59.999Z', '2026-10-01', '2026-11-01'],
        ['2026-12-31T23:59:59.999Z', '2026-12-01', '2027-01-01'],
        ['2027-01-01T00:00:00.000Z', '2027-01-01', '2027-02-01'],
        ['2024-02-29T12:00:00.000Z', '2024-02-01', '2024-03-01'],
        ['2025-02-28T23:59:59.999Z', '2025-02-01', '2025-03-01'],
        ['2024-03-01T00:00:00.000Z', '2024-03-01', '2024-04-01'],
        ['2026-10-01T00:30:00.000+02:00', '2026-09-01', '2026-10-01'],
        ['2026-10-31T23:30:00.000-02:00', '2026-11-01', '2026-12-01'],
        ['0099-12-31T23:59:59.999Z', '0099-12-01', '0100-01-01'],
    ])('uses the UTC month containing %s', (instant, start, end) => {
        const now = new Date(instant);
        const original = now.getTime();
        expect(freeWindow(now)).toEqual({
            start: new Date(`${start}T00:00:00.000Z`),
            end: new Date(`${end}T00:00:00.000Z`),
        });
        expect(now.getTime()).toBe(original);
    });
});

describe('workspaceUsedSeconds', () => {
    const start = new Date('2026-10-10T00:00:00.000Z');
    const at = (seconds: number) => new Date(start.getTime() + seconds * 1000);
    const window = { start, end: at(3600) };
    const now = at(600);
    const interval = (from: number, to: number | null): IntervalRow => ({
        startedAt: at(from),
        endedAt: to === null ? null : at(to),
    });

    it.each([
        ['one second rounds to one minute', 0, 1, 60],
        ['one millisecond rounds to one minute', 0, 0.001, 60],
        ['one minute stays one minute', 0, 60, 60],
        ['one minute and one second rounds to two', 0, 61, 120],
        ['zero duration stays zero', 60, 60, 0],
        ['an interval before the window stays zero', -120, -60, 0],
        ['an interval ending at window start stays zero', -60, 0, 0],
        ['an interval starting at window end stays zero', 3600, 3660, 0],
        ['an interval after the window stays zero', 3660, 3720, 0],
        ['straddling the start clips before rounding', -59.999, 0.001, 60],
        ['straddling the end clips before rounding', 3599.999, 3659.999, 60],
        ['straddling both ends counts only the window', -60, 3660, 3600],
        ['an open interval ends at now', 539, null, 120],
        ['an open interval clips its start', -60, null, 600],
        ['an open interval starting now stays zero', 600, null, 0],
        ['an open interval starting in the future stays zero', 601, null, 0],
        ['a reversed interval stays zero', 60, 0, 0],
    ] as const)('%s', (_name, from, to, expected) => {
        // A counted interval is the positive control for every exclusion case.
        expect(workspaceUsedSeconds([interval(0, 1)], window, now)).toBe(60);
        expect(workspaceUsedSeconds([interval(from, to)], window, now)).toBe(expected);
    });

    it('counts overlapping computers twice and rounds each interval separately', () => {
        const intervals = [
            { ...interval(0, 1), computerId: 'computer-a' },
            { ...interval(0, 1), computerId: 'computer-b' },
        ];
        expect(workspaceUsedSeconds(intervals, window, now)).toBe(120);
        expect(workspaceUsedSeconds([interval(0, 2)], window, now)).toBe(60);
        expect(workspaceUsedSeconds([], window, now)).toBe(0);
    });

    it('clips an open interval at window end when now is later', () => {
        expect(workspaceUsedSeconds([interval(3599, null)], window, at(7200))).toBe(60);
        expect(workspaceUsedSeconds([interval(3600, null)], window, at(7200))).toBe(0);
    });
});

describe('workspaceState', () => {
    it.each([
        [100, 100, 'ok'],
        [80, 100, 'ok'],
        [21, 100, 'ok'],
        [20, 100, 'low'],
        [19, 100, 'low'],
        [1, 100, 'low'],
        [0, 100, 'exhausted'],
        [-1, 100, 'exhausted'],
        [0, 0, 'exhausted'],
        [5760, 28800, 'low'],
        [5761, 28800, 'ok'],
    ] as const)('%i remaining of %i is %s', (remaining, allowance, expected) => {
        expect(workspaceState(remaining, allowance)).toBe(expected);
    });
});

describe('storageState', () => {
    it.each([
        ['0', '100', 'ok'],
        ['20', '100', 'ok'],
        ['79', '100', 'ok'],
        ['80', '100', 'low'],
        ['81', '100', 'low'],
        ['94', '100', 'low'],
        ['95', '100', 'exhausted'],
        ['96', '100', 'exhausted'],
        ['100', '100', 'exhausted'],
        ['101', '100', 'over_cap'],
        ['0', '0', 'exhausted'],
        ['1', '0', 'over_cap'],
        ['2', '3', 'ok'],
        ['18', '19', 'low'],
        ['79999999999999999999', '100000000000000000000', 'ok'],
        ['80000000000000000000', '100000000000000000000', 'low'],
        ['94999999999999999999', '100000000000000000000', 'low'],
        ['95000000000000000000', '100000000000000000000', 'exhausted'],
        ['100000000000000000001', '100000000000000000000', 'over_cap'],
    ] as const)('%s bytes of %s is %s', (used, cap, expected) => {
        expect(storageState(BigInt(used), BigInt(cap))).toBe(expected);
    });
});

describe('resolvePlan', () => {
    it.each([
        ['active', 'pro', 'active'],
        ['trialing', 'pro', 'active'],
        ['past_due', 'free', 'past_due'],
        ['unpaid', 'free', 'past_due'],
        ['canceled', 'free', 'free'],
        ['incomplete', 'free', 'free'],
        ['incomplete_expired', 'free', 'free'],
        ['paused', 'free', 'free'],
        ['unknown', 'free', 'free'],
    ] as const)('resolves %s', (status, plan, expectedStatus) => {
        expect(resolvePlan([subscription()], NOW).plan).toBe('pro');
        expect(resolvePlan([subscription({ status })], NOW)).toEqual({
            plan,
            status: expectedStatus,
            window: plan === 'pro'
                ? { start: PERIOD_START, end: PERIOD_END }
                : freeWindow(NOW),
            renewsAt: plan === 'pro' ? PERIOD_END : null,
            cancelsAt: null,
        });
    });

    it.each(['active', 'trialing'])('uses an inclusive start and exclusive end for %s', status => {
        const subs = [subscription({ status })];
        expect(resolvePlan(subs, PERIOD_START).plan).toBe('pro');
        expect(resolvePlan(subs, new Date(PERIOD_END.getTime() - 1)).plan).toBe('pro');
        expect(resolvePlan(subs, new Date(PERIOD_START.getTime() - 1)).plan).toBe('free');
        expect(resolvePlan(subs, PERIOD_END)).toEqual({
            plan: 'free',
            status: 'free',
            window: freeWindow(PERIOD_END),
            renewsAt: null,
            cancelsAt: null,
        });
    });

    it.each([
        { currentPeriodStart: null },
        { currentPeriodEnd: null },
        { currentPeriodStart: null, currentPeriodEnd: null },
        { currentPeriodStart: PERIOD_END, currentPeriodEnd: PERIOD_START },
        { currentPeriodStart: PERIOD_START, currentPeriodEnd: PERIOD_START },
    ])('requires a valid current period: %j', overrides => {
        expect(resolvePlan([subscription()], NOW).plan).toBe('pro');
        expect(resolvePlan([subscription(overrides)], NOW).plan).toBe('free');
    });

    it.each(['active', 'trialing'])('keeps %s Pro until cancellation takes effect', status => {
        const subs = [subscription({ status, cancelAtPeriodEnd: true })];
        expect(resolvePlan(subs, NOW)).toEqual({
            plan: 'pro',
            status: 'cancels',
            window: { start: PERIOD_START, end: PERIOD_END },
            renewsAt: null,
            cancelsAt: PERIOD_END,
        });
        expect(resolvePlan(subs, PERIOD_END).plan).toBe('free');
        expect(resolvePlan([subscription({ status })], NOW).renewsAt).toEqual(PERIOD_END);
    });

    it.each(['past_due', 'unpaid'])('preserves %s without granting a Pro period', status => {
        expect(resolvePlan([subscription()], NOW).plan).toBe('pro');
        for (const overrides of [
            { currentPeriodStart: null, currentPeriodEnd: null },
            { currentPeriodEnd: new Date('2026-10-06T00:00:00.000Z') },
            { cancelAtPeriodEnd: true },
        ]) {
            expect(resolvePlan([subscription({ status, ...overrides })], NOW)).toEqual({
                plan: 'free',
                status: 'past_due',
                window: freeWindow(NOW),
                renewsAt: null,
                cancelsAt: null,
            });
        }
    });

    it.each([false, true])('selects the latest qualifying period end (reversed: %s)', reverse => {
        const latestEnd = new Date('2026-11-10T00:00:00.000Z');
        const subs = [
            subscription(),
            subscription({ stripeSubscriptionId: 'sub_latest', currentPeriodEnd: latestEnd, cancelAtPeriodEnd: true }),
            subscription({ status: 'canceled', currentPeriodEnd: new Date('2026-12-01T00:00:00.000Z') }),
            subscription({ currentPeriodStart: PERIOD_END, currentPeriodEnd: new Date('2026-12-05T00:00:00.000Z') }),
            subscription({ currentPeriodEnd: new Date('2026-10-10T00:00:00.000Z') }),
        ];
        if (reverse) subs.reverse();
        const original = [...subs];
        expect(resolvePlan(subs, NOW)).toEqual({
            plan: 'pro',
            status: 'cancels',
            window: { start: PERIOD_START, end: latestEnd },
            renewsAt: null,
            cancelsAt: latestEnd,
        });
        expect(subs).toEqual(original);
    });

    it.each([false, true])('compares delinquent and active candidates by period end (reversed: %s)', reverse => {
        const older = subscription({ status: 'unpaid', currentPeriodEnd: null });
        const active = subscription();
        const newer = subscription({ status: 'past_due', currentPeriodEnd: new Date('2026-11-10T00:00:00.000Z') });
        const ordered = (subs: SubscriptionRow[]) => reverse ? subs.reverse() : subs;
        expect(resolvePlan(ordered([older, active]), NOW).plan).toBe('pro');
        expect(resolvePlan(ordered([active, newer, older]), NOW).status).toBe('past_due');
    });

    it('falls back to Free when there are no subscriptions', () => {
        expect(resolvePlan([subscription()], NOW).plan).toBe('pro');
        expect(resolvePlan([], NOW)).toEqual({
            plan: 'free',
            status: 'free',
            window: freeWindow(NOW),
            renewsAt: null,
            cancelsAt: null,
        });
    });
});

describe('buildSummary', () => {
    it('builds a complete empty Free summary from the committed catalog', () => {
        expect(summary()).toEqual({
            enabled: true,
            version: 1,
            plan: {
                id: 'free', status: 'free',
                periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z',
                renewsAt: null, cancelsAt: null,
            },
            meters: {
                workspace: {
                    usedSeconds: 0, allowanceSeconds: 28800, remainingSeconds: 28800,
                    resetsAt: '2026-11-01T00:00:00.000Z', state: 'ok',
                },
                storage: { usedBytes: '0', capBytes: '2000000000', state: 'ok', measuredAt: null },
                ai: { state: 'unavailable', trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null },
            },
            actions: { checkout: false, portal: false, topup: false },
            catalog: { pro: catalogPro(), packs: AI_PACKS },
        });
        expect(summary({ config: readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' }), subs: [subscription()] }).actions)
            .toEqual({ checkout: true, portal: true, topup: false });
    });

    it.each([
        ['free', false, '2000000000'],
        ['free', true, '2000000000'],
        ['pro', false, '2000000000'],
        ['pro', true, '20000000000'],
    ] as const)('uses the storage gate for %s (enabled: %s)', (plan, largeStorageEnabled, capBytes) => {
        const result = summary({
            config: { ...readBillingConfig({}), largeStorageEnabled },
            subs: plan === 'pro' ? [subscription()] : [],
        });
        expect(result.meters.storage.capBytes).toBe(capBytes);
        expect(result.meters.workspace.allowanceSeconds).toBe(plan === 'pro' ? 72000 : 28800);
    });

    it('uses the Pro window and allowance without adding the suspended Free allowance', () => {
        const intervals = [
            { startedAt: new Date('2026-10-02T00:00:00.000Z'), endedAt: new Date('2026-10-02T01:00:00.000Z') },
            { startedAt: new Date(PERIOD_START.getTime() - 1000), endedAt: new Date(PERIOD_START.getTime() + 1000) },
        ];
        const result = summary({ subs: [subscription()], intervals });
        expect(result.meters.workspace).toEqual({
            usedSeconds: 60, allowanceSeconds: 72000, remainingSeconds: 71940,
            resetsAt: PERIOD_END.toISOString(), state: 'ok',
        });
        expect(result.plan).toEqual({
            id: 'pro', status: 'active', periodStart: PERIOD_START.toISOString(), periodEnd: PERIOD_END.toISOString(),
            renewsAt: PERIOD_END.toISOString(), cancelsAt: null,
        });
        expect(summary({ intervals }).meters.workspace.usedSeconds).toBe(3660);
    });

    it.each([
        [0, 0, 28800, 'ok'],
        [1, 60, 28740, 'ok'],
        [23040, 23040, 5760, 'low'],
        [28800, 28800, 0, 'exhausted'],
        [28801, 28860, 0, 'exhausted'],
    ] as const)('clamps remaining time after %i seconds', (seconds, used, remaining, state) => {
        const result = summary({ intervals: [{ startedAt: PERIOD_START, endedAt: new Date(PERIOD_START.getTime() + seconds * 1000) }] });
        expect(result.meters.workspace.usedSeconds).toBe(used);
        expect(result.meters.workspace.remainingSeconds).toBe(remaining);
        expect(result.meters.workspace.state).toBe(state);
        expect(summary().meters.workspace.remainingSeconds).toBe(28800);
    });

    it('sums all supplied samples exactly and reports their newest measurement', () => {
        const storage = [
            { computerId: 'computer-a', bytes: BigInt('9007199254740993'), measuredAt: new Date('2026-10-11T11:00:00.000Z') },
            { computerId: 'deleted-unpurged', bytes: BigInt(7), measuredAt: new Date('2026-10-11T11:30:00.000Z') },
            { computerId: 'computer-b', bytes: BigInt(1), measuredAt: new Date('2026-10-10T11:30:00.000Z') },
        ];
        expect(summary({ storage }).meters.storage).toEqual({
            usedBytes: '9007199254741001', capBytes: '2000000000', state: 'over_cap',
            measuredAt: '2026-10-11T11:30:00.000Z',
        });
        expect(summary().meters.storage.measuredAt).toBeNull();
    });

    it.each(['active', 'trialing', 'past_due', 'unpaid', 'canceled'])('gates checkout and portal for %s', status => {
        const available = readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' });
        expect(summary({ config: available, subs: [subscription()] }).actions.portal).toBe(true);
        for (const config of [
            available,
            { ...available, checkoutEnabled: false },
            { ...available, stripeSecret: undefined },
        ]) {
            const result = summary({ config, subs: [subscription({ status })] });
            const enabled = config.checkoutEnabled && config.stripeSecret !== undefined;
            expect(result.actions).toEqual({ checkout: enabled, portal: enabled && status !== 'canceled', topup: false });
            expect(result.catalog.packs).toEqual(AI_PACKS);
        }
    });

    it('offers checkout to Free and the portal to a canceling Pro subscription', () => {
        const config = readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' });
        expect(summary({ config }).actions).toEqual({ checkout: true, portal: false, topup: false });
        const result = summary({ config, subs: [subscription({ cancelAtPeriodEnd: true })] });
        expect(result.actions).toEqual({ checkout: true, portal: true, topup: false });
        expect(result.plan.cancelsAt).toBe(PERIOD_END.toISOString());
        expect(result.plan.renewsAt).toBeNull();
        expect(summary({ subs: [subscription()] }).plan.renewsAt).toBe(PERIOD_END.toISOString());
    });

    it.each(['active', 'past_due', 'canceled'])('round-trips %s through JSON with exact strings and AI unavailable', status => {
        const result = summary({
            config: readBillingConfig({
                CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture', BILLING_LARGE_STORAGE: '1',
                BILLING_FUNDING_URL: 'https://example.com/funding', BILLING_FUNDING_HMAC_SECRET: 'test-only',
            }),
            subs: [subscription({ status })],
            storage: [{ computerId: 'computer-a', bytes: BigInt('9007199254740993'), measuredAt: NOW }],
        });
        expect(JSON.parse(JSON.stringify(result))).toEqual(result);
        expect(result.meters.storage.usedBytes).toBe('9007199254740993');
        expect(result.meters.storage.measuredAt).toBe(NOW.toISOString());
        expect(result.meters.ai).toEqual({
            state: 'unavailable', trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null,
        });
        expect(result.actions.checkout).toBe(true);
        expect(result.actions.topup).toBe(false);
        expect(result.catalog).toEqual({ pro: catalogPro(), packs: AI_PACKS });
    });
});

describe('open intervals that stopped heartbeating', () => {
    const window = { start: new Date('2026-10-01T00:00:00.000Z'), end: new Date('2026-11-01T00:00:00.000Z') };
    const startedAt = new Date('2026-10-10T10:00:00.000Z');
    const now = new Date('2026-10-10T14:00:00.000Z');

    it('counts to now while heartbeats are recent (positive control)', () => {
        const lastSeenAt = new Date('2026-10-10T13:59:00.000Z');
        expect(workspaceUsedSeconds([{ startedAt, endedAt: null, lastSeenAt }], window, now)).toBe(4 * 3600);
    });

    it('stops counting 15 minutes after the last heartbeat', () => {
        const lastSeenAt = new Date('2026-10-10T11:00:00.000Z');
        expect(workspaceUsedSeconds([{ startedAt, endedAt: null, lastSeenAt }], window, now)).toBe(3600 + 15 * 60);
    });

    it('still counts to now when no heartbeat is known', () => {
        expect(workspaceUsedSeconds([{ startedAt, endedAt: null }], window, now)).toBe(4 * 3600);
    });
});
