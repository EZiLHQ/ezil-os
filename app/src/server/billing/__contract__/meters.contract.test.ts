import { describe, expect, it } from 'vitest';
import { readBillingConfig } from '../config';
import {
    buildSummary, freeWindow, resolvePlan, storageState, workspaceState, workspaceUsedSeconds,
} from '../meters';

const date = (value: string) => new Date(value);
const now = date('2026-10-11T12:00:00.000Z');
const month = { start: date('2026-10-01T00:00:00.000Z'), end: date('2026-11-01T00:00:00.000Z') };
const period = { start: date('2026-10-05T06:00:00.000Z'), end: date('2026-11-05T06:00:00.000Z') };
type SummaryInput = Parameters<typeof buildSummary>[0];
type Subscription = Parameters<typeof resolvePlan>[0][number];

/** The frozen contract names rows but omits their interfaces; fixtures use its camelCase server convention. */
function subscription(overrides: Partial<Subscription> = {}): Subscription {
    return {
        stripeSubscriptionId: 'sub_contract', userId: 'user_contract', status: 'active',
        sku: 'pro_monthly_v1', currentPeriodStart: period.start, currentPeriodEnd: period.end,
        cancelAtPeriodEnd: false, stripeEventCreated: now, updatedAt: now, ...overrides,
    } as Subscription;
}

function summary(overrides: Partial<SummaryInput> = {}) {
    return buildSummary({ config: readBillingConfig({}), now, subs: [], intervals: [], storage: [], ...overrides });
}

describe('workspace meter contract', () => {
    it.each([
        ['2026-10-31T23:59:59.999Z', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z'],
        ['2026-11-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', '2026-12-01T00:00:00.000Z'],
        ['2026-12-31T23:59:59.999Z', '2026-12-01T00:00:00.000Z', '2027-01-01T00:00:00.000Z'],
        ['2028-02-29T12:00:00.000Z', '2028-02-01T00:00:00.000Z', '2028-03-01T00:00:00.000Z'],
        ['2026-10-01T00:30:00+02:00', '2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z'],
    ])('uses UTC calendar boundaries for %s', (instant, start, end) => {
        expect(freeWindow(date(instant))).toEqual({ start: date(start), end: date(end) });
    });

    it.each([[0, 0], [1, 60], [59_999, 60], [60_000, 60], [60_001, 120]])(
        'rounds %i milliseconds up per clipped interval to %i seconds', (duration, expected) => {
            expect(workspaceUsedSeconds([{ startedAt: now, endedAt: new Date(now.getTime() + duration) }], month, month.end)).toBe(expected);
        },
    );

    it('rounds each computer separately and counts overlapping computers twice', () => {
        const interval = { startedAt: now, endedAt: new Date(now.getTime() + 30_000) };
        expect(workspaceUsedSeconds([interval], month, now)).toBe(60);
        expect(workspaceUsedSeconds([interval, interval], month, now)).toBe(120);
    });

    it.each([['calendar month', month], ['Stripe period', period]] as const)(
        'clips both edges of the %s before rounding and excludes touching intervals', (_label, window) => {
            const start = window.start.getTime();
            const end = window.end.getTime();
            const edges = [
                { startedAt: new Date(start - 120_000), endedAt: new Date(start + 1) },
                { startedAt: new Date(end - 1), endedAt: new Date(end + 120_000) },
            ];
            expect(workspaceUsedSeconds(edges, window, window.end)).toBe(120);
            expect(workspaceUsedSeconds([
                { startedAt: new Date(start - 60_000), endedAt: window.start },
                { startedAt: window.end, endedAt: new Date(end + 60_000) },
            ], window, window.end)).toBe(0);
        },
    );

    it('counts open intervals to now and clips them at the window end', () => {
        expect(workspaceUsedSeconds([{ startedAt: new Date(now.getTime() - 60_001), endedAt: null }], month, now)).toBe(120);
        expect(workspaceUsedSeconds([{ startedAt: now, endedAt: null }], month, now)).toBe(0);
        expect(workspaceUsedSeconds([{ startedAt: new Date(month.end.getTime() - 1), endedAt: null }], month,
            new Date(month.end.getTime() + 600_000))).toBe(60);
        expect(workspaceUsedSeconds([{ startedAt: new Date(now.getTime() + 1), endedAt: null }], month, now)).toBe(0);
    });

    it.each([[21, 'ok'], [20, 'low'], [19, 'low'], [1, 'low'], [0, 'exhausted'], [-1, 'exhausted']] as const)(
        'classifies %i remaining of 100 as %s', (remaining, state) => {
            expect(workspaceState(remaining, 100)).toBe(state);
        },
    );
});

describe('storage meter contract', () => {
    it.each([[79, 'ok'], [80, 'low'], [94, 'low'], [95, 'exhausted'], [100, 'exhausted'], [101, 'over_cap']] as const)(
        'classifies %i bytes of 100 as %s', (used, state) => {
            expect(storageState(BigInt(used), BigInt(100))).toBe(state);
        },
    );

    it('keeps exact bigint boundaries beyond Number precision', () => {
        const unit = BigInt('1000000000000000000');
        const cap = unit * BigInt(100);
        expect(storageState(unit * BigInt(80) - BigInt(1), cap)).toBe('ok');
        expect(storageState(unit * BigInt(80), cap)).toBe('low');
        expect(storageState(unit * BigInt(95) - BigInt(1), cap)).toBe('low');
        expect(storageState(unit * BigInt(95), cap)).toBe('exhausted');
        expect(storageState(cap, cap)).toBe('exhausted');
        expect(storageState(cap + BigInt(1), cap)).toBe('over_cap');
    });
});

describe('plan resolution contract', () => {
    it.each(['active', 'trialing'])('grants Pro for %s inside the half-open period', status => {
        const sub = subscription({ status: status as Subscription['status'] });
        expect(resolvePlan([sub], period.start)).toEqual({ plan: 'pro', status: 'active', window: period,
            renewsAt: period.end, cancelsAt: null });
        expect(resolvePlan([sub], now).plan).toBe('pro');
        expect(resolvePlan([sub], new Date(period.start.getTime() - 1)).plan).toBe('free');
        expect(resolvePlan([sub], period.end)).toEqual({ plan: 'free', status: 'free', window: freeWindow(period.end),
            renewsAt: null, cancelsAt: null });
    });

    it('keeps Pro until cancellation at the period end', () => {
        const sub = subscription({ cancelAtPeriodEnd: true });
        expect(resolvePlan([sub], now)).toEqual({ plan: 'pro', status: 'cancels', window: period,
            renewsAt: null, cancelsAt: period.end });
        expect(resolvePlan([sub], period.end).plan).toBe('free');
    });

    it.each(['past_due', 'unpaid'])('falls back to Free while preserving %s payment trouble', status => {
        expect(resolvePlan([subscription()], now).plan).toBe('pro');
        expect(resolvePlan([subscription({ status: status as Subscription['status'] })], now)).toEqual({ plan: 'free', status: 'past_due',
            window: month, renewsAt: null, cancelsAt: null });
    });

    it.each(['canceled', 'incomplete', 'incomplete_expired', 'paused'])('does not grant Pro for %s', status => {
        expect(resolvePlan([subscription()], now).plan).toBe('pro');
        expect(resolvePlan([subscription({ status: status as Subscription['status'] })], now)).toEqual({ plan: 'free', status: 'free',
            window: month, renewsAt: null, cancelsAt: null });
    });

    it('uses Free when there is no subscription', () => {
        expect(resolvePlan([], now)).toEqual({ plan: 'free', status: 'free', window: month,
            renewsAt: null, cancelsAt: null });
    });
});

describe('billing summary wire contract', () => {
    it('suspends Free allowance during Pro and meters the subscription period', () => {
        const intervals = [
            { computerId: 'computer_contract', startedAt: date('2026-10-02T00:00:00.000Z'), endedAt: date('2026-10-02T00:01:00.000Z') },
            { computerId: 'computer_contract', startedAt: now, endedAt: new Date(now.getTime() + 1) },
        ] as SummaryInput['intervals'];
        const free = summary({ intervals });
        const pro = summary({ intervals, subs: [subscription()] });
        expect(free.meters.workspace.allowanceSeconds).toBe(28_800);
        expect(free.meters.workspace.usedSeconds).toBe(120);
        expect(pro.meters.workspace.allowanceSeconds).toBe(72_000);
        expect(pro.meters.workspace.usedSeconds).toBe(60);
        expect(pro.meters.workspace.remainingSeconds).toBe(71_940);
        expect(pro.plan.periodStart).toBe(period.start.toISOString());
        expect(pro.plan.periodEnd).toBe(period.end.toISOString());
        expect(pro.meters.workspace.resetsAt).toBe(period.end.toISOString());
    });

    it('sums only the newest sample per computer, including an unpurged deleted computer', () => {
        const result = summary({ storage: [
            { computerId: 'computer_live', bytes: BigInt(700), measuredAt: now },
            { computerId: 'computer_deleted_unpurged', bytes: BigInt(300), measuredAt: now },
            { computerId: 'computer_live', bytes: BigInt(9000), measuredAt: new Date(now.getTime() - 1) },
        ] });
        expect(result.meters.storage.usedBytes).toBe('1000');
        expect(result.meters.storage.measuredAt).toBe(now.toISOString());
        expect(summary().meters.storage.usedBytes).toBe('0');
        expect(summary().meters.storage.measuredAt).toBeNull();
    });

    it('keeps AI unavailable with zero-string balances even with funding keys configured', () => {
        for (const config of [readBillingConfig({}), readBillingConfig({
            BILLING_FUNDING_URL: 'synthetic-funding-url', BILLING_FUNDING_HMAC_SECRET: 'synthetic-funding-key',
        })]) {
            expect(summary({ config, subs: [subscription()] }).meters.ai).toEqual({ state: 'unavailable',
                trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null });
        }
    });

    it('keeps all actions off with flags off despite configured keys, and gates checkout positively', () => {
        const keys = { STRIPE_SECRET: 'synthetic-stripe-key', STRIPE_WEBHOOK_SECRET: 'synthetic-webhook-key' };
        expect(summary({ config: readBillingConfig(keys) }).actions).toEqual({ checkout: false, portal: false, topup: false });
        const enabled = summary({ config: readBillingConfig({ ...keys, BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1' }) });
        expect(enabled.actions.checkout).toBe(true);
        expect(enabled.actions.portal).toBe(true);
        expect(enabled.actions.topup).toBe(false);
    });

    it('serialises byte and money balances as strings without bigint or synthetic secrets', () => {
        const config = readBillingConfig({ STRIPE_SECRET: 'synthetic-wire-secret', STRIPE_WEBHOOK_SECRET: 'synthetic-wire-webhook' });
        const result = summary({ config, storage: [{ computerId: 'computer_contract',
            bytes: BigInt('9007199254740993'), measuredAt: now }] });
        expect(result.enabled).toBe(true);
        expect(result.version).toBe(1);
        expect(result.meters.storage.usedBytes).toBe('9007199254740993');
        expect(result.meters.storage.capBytes).toBe('2000000000');
        expect(typeof BigInt(1)).toBe('bigint');
        expect(config.stripeSecret).toBe('synthetic-wire-secret');
        expect(config.stripeWebhookSecret).toBe('synthetic-wire-webhook');
        for (const amount of [result.meters.ai.trialMicro, result.meters.ai.includedMicro, result.meters.ai.purchasedMicro]) {
            expect(typeof amount).toBe('string');
        }
        const encoded = JSON.stringify(result, (_key, value: unknown) => {
            expect(typeof value).not.toBe('bigint');
            return value;
        });
        expect(JSON.parse(encoded)).toEqual(result);
        expect(encoded).toContain('9007199254740993');
        expect(encoded).not.toContain('synthetic-wire-secret');
        expect(encoded).not.toContain('synthetic-wire-webhook');
    });

    it('holds Pro storage at Free until large storage is enabled', () => {
        expect(summary({ subs: [subscription()] }).meters.storage.capBytes).toBe('2000000000');
        expect(summary({ subs: [subscription()], config: readBillingConfig({ BILLING_LARGE_STORAGE: '1' }) })
            .meters.storage.capBytes).toBe('20000000000');
    });
});
