import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { SubscriptionRow } from '../meters';
import type { BillingDeps, BillingStore, GrantRow, PaymentIssueRow } from '../ports';
import { aiIncludedModels, aiIncludedModelsFor, FREE_AI_MODELS } from './ai-models';
import type { OperatorEntitlementRow } from './operator-access';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

const USER = 'user_a';
const DAY = 86_400_000;
const NOW = new Date('2026-10-18T12:00:00.789Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const START = ago(8 * DAY), END = new Date(NOW.getTime() + 22 * DAY);

const subscription = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
    stripeSubscriptionId: 'sub_a', sku: 'standard_monthly_v3', status: 'active',
    currentPeriodStart: START, currentPeriodEnd: END, cancelAtPeriodEnd: false, ...over,
});
const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
    id: 'grant_a', userId: USER, subscriptionId: 'sub_a', meter: 'compute_std_seconds', kind: 'plan_period',
    amount: BigInt(144_000), periodStart: START, periodEnd: END, sourceType: 'invoice', sourceId: 'in_a', createdAt: START, ...over,
});
const issue = (stripeEventCreated: Date): PaymentIssueRow => ({
    stripeInvoiceId: 'in_issue', userId: USER, subscriptionId: 'sub_a', invoiceKind: 'subscription', issue: 'payment_failed',
    hostedInvoiceUrl: null, stripeEventCreated, updatedAt: stripeEventCreated, resolvedAt: null,
});
const operatorGrant = (): OperatorEntitlementRow => ({ ref: 'osg-00000000-0000-4000-8000-000000000001', revision: 1, userId: USER,
    accountPublicId: '10000000-0000-4000-8000-0000000000a1', sku: 'standard_monthly_v3', startsAt: ago(DAY), endsAt: new Date(NOW.getTime() + 30 * DAY), endedAt: null });
// A failed renewal: the period moved on and its invoice is unpaid (compute-access.test.ts round 4).
const renewal = () => subscription({ status: 'past_due', currentPeriodStart: ago(2 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 28 * DAY) });

/** The reads loadComputeBillingState makes, over fixed rows; every other store access is an error. */
function deps(rows: { subs?: SubscriptionRow[]; grants?: GrantRow[]; paymentIssues?: PaymentIssueRow[]; operator?: OperatorEntitlementRow[] } = {},
    config = readBillingConfig({ BILLING_TAB_ENABLED: '1' })): BillingDeps {
    const methods = {
        subscriptionsFor: async () => rows.subs ?? [], operatorEntitlementsFor: async () => rows.operator ?? [],
        userCreatedAt: async () => null, openPlanChanges: async () => [], epochsFor: async () => [],
        grantsForPeriod: async () => rows.grants ?? [], latestConsent: async () => null,
        openPaymentIssues: async () => rows.paymentIssues ?? [], sizePreference: async () => null,
    } satisfies Partial<BillingStore>;
    const store = new Proxy(methods, {
        get(target, key) {
            if (!(key in target)) throw new Error(`Unexpected store access: ${String(key)}`);
            return target[key as keyof typeof target];
        },
    }) as unknown as BillingStore;
    return { config, store, stripe: null, usage: null, now: () => NOW };
}

afterEach(() => vi.restoreAllMocks());

describe('aiIncludedModels: Free includes Gemini 3.8 Flash only; every paid plan includes every model', () => {
    it('keys on the plan the computer runs under', () => {
        expect(FREE_AI_MODELS).toEqual(['gemini-3.8-flash']);
        for (const sku of ['free_v3', 'free_v2', 'free_v1_legacy'] as const) expect(aiIncludedModels(sku)).toBe(FREE_AI_MODELS);
        for (const sku of ['standard_monthly_v3', 'premium_monthly_v3', 'standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1'] as const) {
            expect(aiIncludedModels(sku)).toBeNull();
        }
    });

    it.each([
        ['Free (no subscription)', {}, FREE_AI_MODELS],
        ['Standard, paid this period', { subs: [subscription()], grants: [grant()] }, null],
        ['Standard trial', { subs: [subscription({ status: 'trialing' })], grants: [grant()] }, null],
        ['Premium, paid this period', { subs: [subscription({ sku: 'premium_monthly_v3' })], grants: [grant({ amount: BigInt(1_800_000) })] }, null],
        ['operator-granted Standard (no Stripe)', { operator: [operatorGrant()] }, null],
        ['legacy Standard v2', { subs: [subscription({ sku: 'standard_monthly_v2' })], grants: [grant({ amount: BigInt(216_000) })] }, null],
        ['legacy Compute v2', { subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant({ amount: BigInt(216_000) })] }, null],
        ['legacy v2 past_due (runs as Free)', { subs: [subscription({ sku: 'standard_monthly_v2', status: 'past_due' })] }, FREE_AI_MODELS],
        ['Standard renewal unpaid, inside its seven-day grace', { subs: [renewal()], paymentIssues: [issue(ago(2 * DAY))] }, null],
        ['Standard renewal unpaid, grace ended (runs as Free)', { subs: [renewal()], paymentIssues: [issue(ago(7 * DAY))] }, FREE_AI_MODELS],
        ['Standard cancelled (runs as Free)', { subs: [subscription({ status: 'canceled' })], grants: [grant()] }, FREE_AI_MODELS],
        ['Standard never paid (incomplete)', { subs: [subscription({ status: 'incomplete' })] }, FREE_AI_MODELS],
    ] as const)('%s', async (_name, rows, expected) => {
        expect(await aiIncludedModelsFor(USER, () => deps(rows as Parameters<typeof deps>[0]))).toEqual(expected);
    });

    it('unknown or absent policy never means every model', () => {
        for (const sku of ['unknown', '', 'toString', 'constructor', undefined, null]) {
            expect(aiIncludedModels(sku as Parameters<typeof aiIncludedModels>[0])).toBeUndefined();
        }
    });

    it('billing metering off still resolves the owner plan, including paid access', async () => {
        expect(await aiIncludedModelsFor(USER, () => deps({}, readBillingConfig({})))).toBe(FREE_AI_MODELS);
        expect(await aiIncludedModelsFor(USER, () => deps({ subs: [subscription()], grants: [grant()] }, readBillingConfig({})))).toBeNull();
    });

    it('a failed read or composition is unknown (undefined), never every model, and never throws', async () => {
        const failing = deps({});
        failing.store = new Proxy({}, { get: () => async () => { throw new Error('db down'); } }) as BillingStore;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        expect(await aiIncludedModelsFor(USER, () => failing)).toBeUndefined();
        failing.config = readBillingConfig({});
        expect(await aiIncludedModelsFor(USER, () => failing)).toBeUndefined();
        expect(await aiIncludedModelsFor(USER, () => { throw new Error('no config'); })).toBeUndefined();
        expect(warn).toHaveBeenCalledWith('[billing.ai-models] plan read failed', { userId: USER });
    });
});
