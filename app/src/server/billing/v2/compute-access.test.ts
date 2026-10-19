import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { SubscriptionRow } from '../meters';
import type { BillingDeps, BillingStore, GrantRow, PaymentIssueRow } from '../ports';
import { freeSkuFor } from './catalog';
import { CATALOG_V2, type ComputeEpoch } from './contract';
import { billingMeteringActive, billingV2EntitlementReader, loadComputeBillingState } from './compute-access';
import { buildSummaryV2 } from './summary';
import { resolveEntitlement } from '../../lib/compute/tier';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));

const USER = 'user_a';
const START = '2026-10-10T00:00:00Z';
const END = '2026-11-10T00:00:00Z';
const NOW = new Date('2026-10-18T12:00:00.789Z');
const MONTH = { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' };
type Input = Parameters<typeof buildSummaryV2>[0];

const subscription = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
    stripeSubscriptionId: 'sub_a', sku: 'standard_monthly_v2', status: 'active',
    currentPeriodStart: new Date(START), currentPeriodEnd: new Date(END), cancelAtPeriodEnd: false, ...over,
});
const grant = (over: Partial<GrantRow> = {}): GrantRow => ({
    id: 'grant_a', userId: USER, subscriptionId: 'sub_a', meter: 'compute_std_seconds', kind: 'plan_period',
    amount: BigInt(216000), periodStart: new Date(START), periodEnd: new Date(END),
    sourceType: 'invoice', sourceId: 'in_a', createdAt: NOW, ...over,
});
const issue = (over: Partial<PaymentIssueRow> = {}): PaymentIssueRow => ({
    stripeInvoiceId: 'in_issue', userId: USER, subscriptionId: 'sub_a', invoiceKind: 'subscription',
    issue: 'payment_failed', hostedInvoiceUrl: null, stripeEventCreated: NOW, updatedAt: NOW, resolvedAt: null, ...over,
});
const epoch = (readyAt: string, endedAt: string): ComputeEpoch => ({
    id: readyAt, userId: USER, computerId: 'computer_a', size: 'cmp-8', weight: 4,
    readyAt, endedAt, endReason: 'user_stop', overheadSeconds: 0,
});

function fixture(over: Partial<Input> = {}) {
    const input: Input = {
        config: readBillingConfig({ BILLING_TAB_ENABLED: '1' }), now: NOW, userCreatedAt: null,
        subs: [], epochs: [], grants: [], consent: null, planChanges: [], paymentIssues: [],
        storage: [], sizePreference: null, hasCustomer: false, ...over,
    };
    const calls: { name: string; args: unknown[] }[] = [];
    const methods = {
        subscriptionsFor: async () => input.subs,
        userCreatedAt: async () => input.userCreatedAt,
        openPlanChanges: async () => [...input.planChanges],
        epochsFor: async (_userId: string, since: Date) => input.epochs.filter(e => e.endedAt === null || new Date(e.endedAt) > since),
        grantsForPeriod: async () => [...input.grants],
        latestConsent: async () => input.consent,
        openPaymentIssues: async () => [...input.paymentIssues],
        sizePreference: async () => input.sizePreference,
    } satisfies Partial<BillingStore>;
    const store = new Proxy(methods, {
        get(target, key) {
            if (!(key in target)) throw new Error(`Unexpected store access: ${String(key)}`);
            return (...args: unknown[]) => {
                calls.push({ name: String(key), args });
                return Reflect.apply(target[key as keyof typeof target], target, args);
            };
        },
    }) as unknown as BillingStore;
    const deps: BillingDeps = { config: input.config, store, stripe: null, now: () => NOW };
    return { input, deps, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('loadComputeBillingState', () => {
    it('Free uses the catalog allowance and UTC month, with the exact Billing summary', async () => {
        const { deps, input, calls } = fixture({ epochs: [epoch('2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z')] });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject({
            planSku: freeSkuFor(null), family: 'free', planActive: true, delinquent: false, paymentIssue: false,
            upgradePending: false, entitledSize: 'free-cf', provider: 'cloudflare', window: MONTH,
            usedStdSeconds: 14400, allowanceStdSeconds: CATALOG_V2[freeSkuFor(null)].allowanceStdSeconds, overage: null,
        });
        expect(state.summary).toEqual(buildSummaryV2(input));
        expect(calls.map(c => c.name).sort()).toEqual([
            'epochsFor', 'grantsForPeriod', 'openPaymentIssues', 'openPlanChanges', 'sizePreference', 'subscriptionsFor', 'userCreatedAt',
        ]);
    });

    it.each([
        ['standard_monthly_v2', 'standard', null, 'std-2'],
        ['compute_monthly_v2', 'compute', 'cmp-8', 'cmp-8'],
        ['compute_monthly_v2', 'compute', 'free-cf', 'std-2'],
        ['pro_monthly_v1', 'pro_legacy', null, 'std-2'],
    ] as const)('%s (%s), preference %s selects %s', async (sku, family, sizePreference, entitledSize) => {
        const { deps, input, calls } = fixture({ subs: [subscription({ sku })], grants: [grant()], sizePreference,
            epochs: [epoch(START, '2026-10-10T01:00:00Z')] });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject({ planSku: sku, family, planActive: true, entitledSize, provider: 'aws',
            paymentIssue: false, window: { start: START, end: END }, usedStdSeconds: 14400, allowanceStdSeconds: 216000 });
        expect(state.summary).toEqual(buildSummaryV2(input));
        expect(calls.find(c => c.name === 'grantsForPeriod')?.args).toEqual([
            USER, { start: new Date(START), end: new Date(END) },
            family === 'pro_legacy' ? ['compute_std_seconds', 'workspace_seconds'] : ['compute_std_seconds'],
        ]);
        expect(calls.find(c => c.name === 'latestConsent')?.args).toEqual([USER, 'sub_a']);
    });

    it.each(['past_due', 'incomplete'])('%s falls back to Free and includes usage BEFORE the paid period', async status => {
        const { deps, calls } = fixture({ subs: [subscription({ status })], grants: [grant()], epochs: [
            epoch('2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z'), epoch(START, '2026-10-10T01:00:00Z'),
        ] });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject({ planSku: freeSkuFor(null), family: 'standard', planActive: false, delinquent: true,
            paymentIssue: true, entitledSize: 'free-cf', provider: 'cloudflare', window: MONTH,
            usedStdSeconds: 28800, allowanceStdSeconds: CATALOG_V2[freeSkuFor(null)].allowanceStdSeconds, overage: null });
        expect(state.summary.compute.usedStdSeconds).toBe(14400);
        expect(calls.filter(c => c.name === 'epochsFor').map(c => c.args)).toEqual([[USER, new Date(START)], [USER, new Date(MONTH.start)]]);
    });

    it.each(['subscription', 'upgrade', 'overage'] as const)('an unresolved %s payment issue on an active plan uses Free', async invoiceKind => {
        const { deps } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()],
            sizePreference: 'cmp-8', paymentIssues: [issue({ invoiceKind })] });
        expect(await loadComputeBillingState(deps, USER, NOW)).toMatchObject({ planSku: freeSkuFor(null), planActive: true,
            paymentIssue: true, entitledSize: 'free-cf', provider: 'cloudflare', window: MONTH,
            allowanceStdSeconds: CATALOG_V2[freeSkuFor(null)].allowanceStdSeconds, overage: null });
    });

    it('resolved, voided and unrelated subscription issues do not revoke the current paid size', async () => {
        const { deps } = fixture({ subs: [subscription()], paymentIssues: [
            issue({ resolvedAt: NOW }), issue({ issue: 'voided' }), issue({ subscriptionId: 'sub_old' }),
        ] });
        expect(await loadComputeBillingState(deps, USER, NOW)).toMatchObject({ paymentIssue: false, entitledSize: 'std-2', provider: 'aws' });
    });

    it('a pending upgrade comes from the Billing summary and retains the current paid size', async () => {
        const { deps, input } = fixture({ subs: [subscription()], planChanges: [{
            id: 'change_a', userId: USER, subscriptionId: 'sub_a', kind: 'upgrade', state: 'pending',
            fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2', stripeInvoiceId: 'in_upgrade',
            stripeScheduleId: null, hostedInvoiceUrl: null, effectiveAt: null, expiresAt: null, createdAt: NOW, updatedAt: NOW,
        }] });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject({ upgradePending: true, entitledSize: 'std-2', planActive: true });
        expect(state.summary).toEqual(buildSummaryV2(input));
    });

    it('active Compute keeps the summary overage consent and cap', async () => {
        const { deps, input } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], consent: {
            id: BigInt(1), userId: USER, subscriptionId: 'sub_a', enabled: true, capCents: 1200,
            termsVersion: 'overage-v2-2026-10-18', catalogVersion: 2, rateCentsPerStdHour: 25, actor: 'user', acceptedAt: NOW,
        } });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state.overage).toEqual({ enabled: true, capCents: 1200 });
        expect(state.summary).toEqual(buildSummaryV2(input));
    });

    it('fallback reuses epochs if the paid period starts before the current UTC month', async () => {
        const { deps, calls } = fixture({ subs: [subscription({ status: 'past_due',
            currentPeriodStart: new Date('2026-09-20T00:00:00Z'), currentPeriodEnd: new Date('2026-10-20T00:00:00Z'),
        })], epochs: [epoch('2026-09-30T23:00:00Z', '2026-10-01T01:00:00Z')] });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject({ window: MONTH, usedStdSeconds: 14400, paymentIssue: true });
        expect(calls.filter(c => c.name === 'epochsFor')).toHaveLength(1);
    });
});

describe('billingV2EntitlementReader', () => {
    it('metering inactive returns null with ZERO store calls, even if other billing flags are on', async () => {
        const { deps, calls } = fixture({ config: readBillingConfig({ PRICING_PAGE_ENABLED: '1', CHECKOUT_ENABLED: '1' }) });
        expect(billingMeteringActive(deps.config)).toBe(false);
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toBeNull();
        expect(calls).toEqual([]);
    });

    it.each([{ BILLING_TAB_ENABLED: '1' }, { BILLING_ENFORCEMENT: '1' }])('either metering flag reads billing (%j)', async config => {
        const { deps } = fixture({ config: readBillingConfig(config), subs: [subscription({ sku: 'compute_monthly_v2' })], sizePreference: 'cmp-8' });
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toEqual({ source: 'billing_v2',
            status: 'active', planId: 'compute_monthly_v2', size: 'cmp-8', provider: 'aws', paymentIssue: false });
    });

    it('a failed billing read is logged and resolves as no entitlement', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { deps } = fixture();
        deps.store.subscriptionsFor = async () => { throw new Error('billing unavailable'); };
        expect(await resolveEntitlement(USER, billingV2EntitlementReader(() => deps))).toBeNull();
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
