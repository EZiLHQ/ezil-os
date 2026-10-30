import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { SubscriptionRow } from '../meters';
import type { BillingDeps, BillingStore, GrantRow, PaymentIssueRow, StoredComputeEpoch } from '../ports';
import { freeSkuFor } from './catalog';
import { CATALOG_V2, SIZES, type ComputeEpoch } from './contract';
import { billingMeteringActive, billingV2EntitlementReader, computeGrantPending, loadComputeBillingState, gateComputerStart, openComputeEpochAtReady } from './compute-access';
import { buildSummaryV2 } from './summary';
import { buildSummaryV3 } from '../v3/summary';
import * as rating from './rating';
import * as admissionV3 from '../v3/admission';
import { epochSeconds, isoSeconds } from './time';
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

function stored(epoch: Input['epochs'][number]): StoredComputeEpoch {
    return { lastHeartbeatAt: null, ...epoch, deadlineAt: epoch.deadlineAt ?? null };
}

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
        epochsFor: async (_userId: string, since: Date) => input.epochs.filter(e => e.endedAt === null || new Date(e.endedAt) > since).map(stored),
        openEpochFor: async (computerId: string) => {
            const epoch = input.epochs.find(e => e.computerId === computerId && e.endedAt === null);
            return epoch ? stored(epoch) : null;
        },
        openEpoch: async (data: Parameters<BillingStore['openEpoch']>[0]) => {
            const existing = input.epochs.find(e => e.computerId === data.computerId && e.endedAt === null);
            if (existing) return { status: 'exists' as const, epoch: stored(existing) };
            const concurrent = input.epochs.find(e => e.userId === data.userId && e.endedAt === null);
            if (concurrent) return { status: 'concurrent' as const, epoch: stored(concurrent) };
            const ready = epochSeconds(data.readyAt, 'ceil');
            const opened = stored({ id: 'new_epoch', userId: data.userId, computerId: data.computerId, size: data.size,
                weight: SIZES[data.size].weight, readyAt: isoSeconds(ready), endedAt: null, endReason: null,
                overheadSeconds: data.overheadSeconds ?? 0,
                deadlineAt: data.deadlineAt == null ? null : isoSeconds(Math.max(ready, Math.min(ready + (data.sessionMaxSeconds === null ? Infinity : 21600), epochSeconds(data.deadlineAt)))) });
            input.epochs = [...input.epochs, opened];
            return { status: 'opened' as const, epoch: opened };
        },
        touchEpoch: async () => { throw new Error('Unused touchEpoch'); },
        openEpochsForSweep: async () => { throw new Error('Unused openEpochsForSweep'); },
        policyClosedEpochsSince: async () => { throw new Error('Unused policyClosedEpochsSince'); },
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
    const deps: BillingDeps = { config: input.config, store, stripe: null, usage: null, now: () => NOW };
    return { input, deps, calls };
}

afterEach(() => vi.restoreAllMocks());

describe('loadComputeBillingState', () => {
    it('Free uses the catalog allowance and UTC month, with the exact Billing summary', async () => {
        const { deps, input, calls } = fixture({ epochs: [epoch('2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z')] });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject({
            planSku: 'free_v3', family: 'free', planActive: true, delinquent: false, paymentIssue: false,
            upgradePending: false, entitledSize: 'free-cf', provider: 'cloudflare', window: MONTH,
            usedStdSeconds: 14400, allowanceStdSeconds: CATALOG_V2[freeSkuFor(null)].allowanceStdSeconds, overage: null,
        });
        expect(state.summary).toEqual(buildSummaryV3(input));
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
        expect(state).toMatchObject({ planSku: 'free_v3', family: 'standard', planActive: false, delinquent: true,
            paymentIssue: true, entitledSize: 'free-cf', provider: 'cloudflare', window: MONTH,
            usedStdSeconds: 28800, allowanceStdSeconds: CATALOG_V2[freeSkuFor(null)].allowanceStdSeconds, overage: null });
        expect(state.summary.version === 2 && state.summary.compute.usedStdSeconds).toBe(14400);
        expect(calls.filter(c => c.name === 'epochsFor').map(c => c.args)).toEqual([[USER, new Date(START)], [USER, new Date(MONTH.start)]]);
    });

    it.each(['subscription', 'upgrade'] as const)('an unresolved %s payment issue on an active plan uses Free', async invoiceKind => {
        const { deps } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()],
            sizePreference: 'cmp-8', paymentIssues: [issue({ invoiceKind })] });
        expect(await loadComputeBillingState(deps, USER, NOW)).toMatchObject({ planSku: 'free_v3', planActive: true,
            paymentIssue: true, entitledSize: 'free-cf', provider: 'cloudflare', window: MONTH,
            allowanceStdSeconds: CATALOG_V2[freeSkuFor(null)].allowanceStdSeconds, overage: null });
    });

    it.each(['payment_failed', 'requires_action'] as const)('unpaid overage (%s) keeps the paid AWS size and only disables overage', async payment => {
        const { deps } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()],
            sizePreference: 'cmp-8', paymentIssues: [issue({ invoiceKind: 'overage', issue: payment })],
            consent: { id: BigInt(1), userId: USER, subscriptionId: 'sub_a', enabled: true, capCents: 1200,
                termsVersion: 'overage-v2-2026-10-18', catalogVersion: 2, rateCentsPerStdHour: 25, actor: 'user', acceptedAt: NOW } });
        expect(await loadComputeBillingState(deps, USER, NOW)).toMatchObject({ planSku: 'compute_monthly_v2',
            planActive: true, paymentIssue: false, entitledSize: 'cmp-8', provider: 'aws',
            allowanceStdSeconds: 216000, overage: { enabled: false, capCents: 1200 },
            summary: { plan: { paymentIssue: 'overage_unpaid' }, overage: { enabled: false, capCents: 1200 } } });
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
        const { deps } = fixture({ config: readBillingConfig(config), subs: [subscription({ sku: 'compute_monthly_v2' })], grants:[grant()], sizePreference: 'cmp-8' });
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

const COMPUTER = 'computer_a';
const READY = new Date('2026-10-18T13:00:00Z');
const gate = (deps: BillingDeps, overrides: Partial<Parameters<typeof gateComputerStart>[0]> = {}) =>
    gateComputerStart({ deps, userId: USER, computerId: COMPUTER, kind: 'aws-ec2', instanceType: 'm6i.large', now: NOW, ...overrides });
const open = (deps: BillingDeps, overrides: Partial<Parameters<typeof openComputeEpochAtReady>[0]> = {}) =>
    openComputeEpochAtReady({ deps, userId: USER, computerId: COMPUTER, size: 'cmp-4', readyAt: READY, overheadSeconds: 12, ...overrides });
const running = (computerId = COMPUTER): StoredComputeEpoch => stored({
    ...epoch(NOW.toISOString(), NOW.toISOString()), computerId, endedAt: null, endReason: null,
});
const enforced = () => readBillingConfig({ BILLING_ENFORCEMENT: '1' });

describe('gateComputerStart', () => {
    it.each([
        ['standard_monthly_v2', true], ['standard_monthly_v2', false],
        ['premium_monthly_v3', true], ['premium_monthly_v3', false],
    ] as const)('%s rejects unlisted AWS types with enforcement %s without rating them', async (sku, enforcement) => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const legacyAdmit = vi.spyOn(rating, 'admitStart');
        const v3Admit = vi.spyOn(admissionV3, 'admitStart');
        const { deps } = fixture({ config: readBillingConfig({ BILLING_TAB_ENABLED: '1', BILLING_ENFORCEMENT: enforcement ? '1' : '0' }),
            subs: [subscription({ sku })], grants: [grant()] });
        for (const instanceType of ['m7g.large', '', 'toString', '__proto__', 'constructor']) {
            const decision = { admit: false, reason: 'size_not_allowed' };
            expect(await gate(deps, { instanceType })).toEqual(enforcement
                ? { allowed: false, reason: 'size_not_allowed' } : { allowed: true, shadow: decision });
            if (!enforcement) expect(info).toHaveBeenLastCalledWith('[billing.gate] shadow', { userId: USER, computerId: COMPUTER, decision });
        }
        expect(legacyAdmit).not.toHaveBeenCalled();
        expect(v3Admit).not.toHaveBeenCalled();
        if (enforcement) expect(info).not.toHaveBeenCalled();
    });

    it('an unlisted AWS type does not affect a Cloudflare start', async () => {
        const { deps } = fixture({ config: enforced(), subs: [subscription()], grants: [grant()] });
        expect(await gate(deps, { kind: 'cloudflare', instanceType: 'm7g.large' })).toEqual({ allowed: true });
    });

    it('metering off makes zero store calls', async () => {
        const { deps, calls } = fixture({ config: readBillingConfig({}) });
        expect(await gate(deps)).toEqual({ allowed: true });
        expect(calls).toEqual([]);
    });

    it('an open epoch bypasses admission and every state read on repeated preview polls', async () => {
        const admit = vi.spyOn(rating, 'admitStart');
        const { deps, calls } = fixture({ config: enforced(), epochs: [running()] });
        expect(await gate(deps)).toEqual({ allowed: true });
        expect(calls.map(call => call.name)).toEqual(['openEpochFor']);
        expect(admit).not.toHaveBeenCalled();
    });

    it.each([true, false])('exhausted Standard with enforcement %s', async enforcement => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const { deps } = fixture({ config: readBillingConfig({ BILLING_TAB_ENABLED: '1', BILLING_ENFORCEMENT: enforcement ? '1' : '0' }),
            subs: [subscription()], grants: [grant({ amount: BigInt(14400) })], epochs: [epoch(START, '2026-10-10T01:00:00Z')] });
        const decision = { admit: false, reason: 'allowance_exhausted' };
        expect(await gate(deps)).toEqual(enforcement
            ? { allowed: false, reason: 'allowance_exhausted' } : { allowed: true, shadow: decision });
        if (enforcement) expect(info).not.toHaveBeenCalled();
        else {
            expect(info).toHaveBeenCalledExactlyOnceWith('[billing.gate] shadow', { userId: USER, computerId: COMPUTER, decision });
        }
    });

    it('Compute at the overage cap refuses', async () => {
        const { deps } = fixture({ config: enforced(), subs: [subscription({ sku: 'compute_monthly_v2' })],
            grants: [grant({ amount: BigInt(14256) })], epochs: [epoch(START, '2026-10-10T01:00:00Z')],
            consent: { id: BigInt(1), userId: USER, subscriptionId: 'sub_a', enabled: true, capCents: 1,
                termsVersion: 'overage-v2-2026-10-18', catalogVersion: 2, rateCentsPerStdHour: 25, actor: 'user', acceptedAt: NOW } });
        expect(await gate(deps)).toEqual({ allowed: false, reason: 'overage_cap_reached' });
    });

    it('another computer running refuses even if its epoch predates the billing window', async () => {
        const { deps } = fixture({ config: enforced(), subs: [subscription()], grants: [grant()],
            epochs: [{ ...running('computer_b'), readyAt: '2026-09-01T00:00:00Z' }] });
        expect(await gate(deps)).toEqual({ allowed: false, reason: 'concurrent_limit' });
    });

    it.each(['past_due', 'incomplete'])('AWS with a %s subscription refuses for payment', async status => {
        const { deps } = fixture({ config: enforced(), subs: [subscription({ status })], grants: [grant()] });
        expect(await gate(deps)).toEqual({ allowed: false, reason: 'payment_issue' });
        expect(await gate(deps, { instanceType: null })).toEqual({ allowed: false, reason: 'payment_issue' });
    });

    it.each(['payment_failed', 'requires_action'] as const)('AWS with a subscription %s issue refuses', async payment => {
        const { deps } = fixture({ config: enforced(), subs: [subscription()], grants: [grant()], paymentIssues: [issue({ issue: payment })] });
        expect(await gate(deps)).toEqual({ allowed: false, reason: 'payment_issue' });
    });

    it('delinquent Cloudflare uses the active Free allowance, including its earlier monthly usage', async () => {
        const admit = vi.spyOn(admissionV3, 'admitStart');
        const { deps } = fixture({ config: enforced(), subs: [subscription({ status: 'past_due' })], grants: [grant()],
            epochs: [epoch('2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z')] });
        expect(await gate(deps, { kind: 'cloudflare', instanceType: null })).toEqual({ allowed: true });
        expect(admit).toHaveBeenLastCalledWith(expect.objectContaining({ sku: 'free_v3', planActive: true, legacyFree: true,
            paymentIssue: false, usedSeconds: 14400 }));
    });

    it('a paid user with a pre-existing Cloudflare computer is admitted as std-2', async () => {
        const admit = vi.spyOn(rating, 'admitStart');
        const { deps } = fixture({ config: enforced(), subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()], sizePreference: 'cmp-8' });
        expect(await gate(deps, { kind: 'cloudflare', instanceType: null })).toEqual({ allowed: true });
        expect(admit).toHaveBeenCalledWith(expect.objectContaining({ size: 'std-2', planSku: 'compute_monthly_v2', paymentIssue: false }));
    });

    it.each(['m6i.large', 'm6i.xlarge', null])('AWS type %s gates the entitled size before resizing', async instanceType => {
        const admit = vi.spyOn(rating, 'admitStart');
        const { deps } = fixture({ config: enforced(), subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()], sizePreference: 'cmp-8' });
        expect(await gate(deps, { instanceType })).toEqual({ allowed: true });
        expect(admit).toHaveBeenCalledWith(expect.objectContaining({ size: 'cmp-8' }));
    });

    it('a downgraded Standard plan admits the next open at std-2 despite its old cmp-4 placement', async () => {
        const { deps } = fixture({ config: enforced(), subs: [subscription()], grants: [grant()] });
        expect(await gate(deps, { instanceType: 'm6i.xlarge' })).toEqual({ allowed: true });
    });

    it('a successful shadow decision is logged once and allowed', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const { deps } = fixture({ subs: [subscription()], grants: [grant()] });
        expect(await gate(deps)).toMatchObject({ allowed: true, shadow: { admit: true, size: 'std-2' } });
        expect(info).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])('state read failure with enforcement %s', async enforcement => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { deps } = fixture({ config: readBillingConfig({ BILLING_TAB_ENABLED: '1', BILLING_ENFORCEMENT: enforcement ? '1' : '0' }) });
        deps.store.subscriptionsFor = async () => { throw new Error('unavailable'); };
        expect(await gate(deps)).toEqual(enforcement ? { allowed: false, reason: 'billing_unavailable' } : { allowed: true });
        expect(warn).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])('open-epoch read failure with enforcement %s', async enforcement => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { deps } = fixture({ config: readBillingConfig({ BILLING_TAB_ENABLED: '1', BILLING_ENFORCEMENT: enforcement ? '1' : '0' }) });
        deps.store.openEpochFor = async () => { throw new Error('unavailable'); };
        expect(await gate(deps)).toEqual(enforcement ? { allowed: false, reason: 'billing_unavailable' } : { allowed: true });
    });
});

describe('openComputeEpochAtReady', () => {
    it('metering off makes zero store calls', async () => {
        const { deps, calls } = fixture({ config: readBillingConfig({}) });
        expect(await open(deps)).toBe('inactive');
        expect(calls).toEqual([]);
    });

    it('2,000 standard seconds at cmp-4 stores a 1,000-second deadline measured from readiness', async () => {
        const realAdmit = rating.admitStart;
        vi.spyOn(rating, 'admitStart').mockImplementation(input => {
            const result = realAdmit(input);
            return result.admit ? { ...result, deadline: START } : result;
        });
        const { deps, calls } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant({ amount: BigInt(2000) })] });
        expect(await open(deps)).toMatchObject({ status: 'opened', deadlineAt: '2026-10-18T13:16:40Z',
            decision: { admit: true, maxRunSeconds: 1000 } });
        expect(calls.find(call => call.name === 'openEpoch')?.args).toEqual([{
            userId: USER, computerId: COMPUTER, subscriptionId: 'sub_a', size: 'cmp-4', readyAt: READY,
            deadlineAt: new Date('2026-10-18T13:16:40Z'), overheadSeconds: 12,
        }]);
    });

    it('large allowance is capped at 21,600 actual seconds', async () => {
        const { deps } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()] });
        expect(await open(deps)).toMatchObject({ deadlineAt: '2026-10-18T19:00:00Z', decision: { admit: true, maxRunSeconds: 21600 } });
    });

    it('a refused start is recorded due immediately at readyAt', async () => {
        const { deps, calls } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })] });
        expect(await open(deps)).toEqual({ status: 'opened', deadlineAt: '2026-10-18T13:00:00Z',
            decision: { admit: false, reason: 'allowance_exhausted' } });
        expect(calls.find(call => call.name === 'openEpoch')?.args[0]).toMatchObject({ deadlineAt: READY });
    });

    it('excludes this computer from running count and leaves an existing deadline and overhead untouched', async () => {
        const admit = vi.spyOn(rating, 'admitStart');
        const existing = { ...running(), deadlineAt: '2026-10-18T14:00:00Z', overheadSeconds: 3 };
        const { deps, input } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()], epochs: [existing] });
        expect(await open(deps)).toMatchObject({ status: 'exists', deadlineAt: existing.deadlineAt, decision: { admit: true } });
        expect(admit).toHaveBeenCalledWith(expect.objectContaining({ runningComputers: 0 }));
        expect(input.epochs).toEqual([existing]);
    });

    it('passes through and logs concurrency without opening another epoch', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const existing = running('computer_b');
        const { deps, input } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()], epochs: [existing] });
        expect(await open(deps)).toMatchObject({ status: 'concurrent', decision: { admit: false, reason: 'concurrent_limit' } });
        expect(input.epochs).toEqual([existing]);
        expect(info).toHaveBeenCalledWith('[billing.epoch] concurrent', { userId: USER, computerId: COMPUTER, runningComputerId: 'computer_b' });
    });

    it('payment issues apply to AWS sizes, while delinquent Cloudflare can use Free', async () => {
        const make = () => fixture({ subs: [subscription({ status: 'past_due' })] }).deps;
        expect(await open(make(), { size: 'std-2' })).toMatchObject({ decision: { admit: false, reason: 'payment_issue' } });
        expect(await open(make(), { size: 'free-cf' })).toMatchObject({ decision: { admit: true } });
    });

    it.each(['subscriptionsFor', 'openEpoch'] as const)('%s failure is logged and never fails readiness', async method => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { deps } = fixture();
        deps.store[method] = async () => { throw new Error('unavailable'); };
        expect(await open(deps)).toBe('error');
        expect(warn).toHaveBeenCalledTimes(1);
    });
});

describe('v3 compute enforcement', () => {
    it.each(['std-2', 'cmp-4', 'cmp-8'] as const)('flows selected %s through entitlement and resize admission, then ignores it after downgrade', async size => {
        const { deps, input } = fixture({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }),
            subs: [subscription({ sku: 'premium_monthly_v3' })], grants: [grant({ amount: BigInt(1800000) })], sizePreference: size });
        const reader = billingV2EntitlementReader(() => deps);
        expect(await reader.read(USER)).toMatchObject({ size, provider: 'aws', status: 'active' });
        const spy = vi.spyOn(admissionV3, 'admitStart');
        expect(await gateComputerStart({ deps, userId: USER, computerId: 'new', kind: 'aws-ec2', instanceType: 'm6i.large', now: NOW })).toEqual({ allowed: true });
        expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ size }));
        input.subs = [subscription({ sku: 'standard_monthly_v3' })];
        expect(await reader.read(USER)).toMatchObject({ size: 'std-2', provider: 'aws' });
        expect(await gateComputerStart({ deps, userId: USER, computerId: 'new', kind: 'aws-ec2', instanceType: 'm6i.2xlarge', now: NOW })).toEqual({ allowed: true });
        expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ size: 'std-2' }));
    });
    it.each([239, 240])('cmp-8 requires 240 standard-seconds to start (remaining=%s)', async remaining => {
        const { deps } = fixture({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }),
            subs: [subscription({ sku: 'premium_monthly_v3' })], sizePreference: 'cmp-8',
            epochs: [epoch(START, '2026-10-10T01:00:00Z')], grants: [grant({ amount: BigInt(14400 + remaining) })] });
        expect(await gateComputerStart({ deps, userId: USER, computerId: 'new', kind: 'aws-ec2', instanceType: null, now: NOW }))
            .toEqual(remaining === 240 ? { allowed: true } : { allowed: false, reason: 'fair_use_paused' });
        expect(await openComputeEpochAtReady({ deps, userId: USER, computerId: 'new', size: 'cmp-8', readyAt: NOW, overheadSeconds: 0 }))
            .toMatchObject({ decision: remaining === 240 ? { admit: true, maxRunSeconds: 60 } : { admit: false, reason: 'fair_use_paused' } });
    });
    it('rates an existing paid Cloudflare machine at weight one despite a cmp-8 preference', async () => {
        const { deps } = fixture({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }),
            subs: [subscription({ sku: 'premium_monthly_v3' })], sizePreference: 'cmp-8', grants: [grant({ amount: BigInt(60) })] });
        expect(await gateComputerStart({ deps, userId: USER, computerId: 'new', kind: 'cloudflare', instanceType: null, now: NOW })).toEqual({ allowed: true });
        expect(await openComputeEpochAtReady({ deps, userId: USER, computerId: 'new', size: 'free-cf', readyAt: NOW, overheadSeconds: 0 }))
            .toMatchObject({ decision: { admit: true, maxRunSeconds: 60 } });
    });

    it.each([
        ['standard_monthly_v3', 'std-2', 144000, 129600],
        ['premium_monthly_v3', 'cmp-8', 1800000, 446400],
    ] as const)('%s uses weighted standard-seconds and its session limit', async (sku, size, allowance, maxRunSeconds) => {
        const { deps, calls } = fixture({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }),
            subs: [subscription({ sku })], grants: [grant({ amount: BigInt(allowance) })],
            epochs: [epoch(START, '2026-10-10T01:00:00Z')], sizePreference: 'cmp-8' });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject({ planSku: sku, entitledSize: size, sessionMaxSeconds: null,
            usedStdSeconds: 14400, allowanceStdSeconds: allowance, overage: null });
        const readyAt = new Date('2026-10-18T13:00:00Z');
        expect(await openComputeEpochAtReady({ deps, userId: USER, computerId: 'new', size, readyAt, overheadSeconds: 0 }))
            .toMatchObject({ status: 'opened', decision: { admit: true, maxRunSeconds },
                deadlineAt: isoSeconds(epochSeconds(readyAt) + maxRunSeconds) });
        expect(calls.find(call => call.name === 'epochsFor')?.args).toEqual([USER, new Date(START)]);
    });
    it('Free creates a one-hour deadline and refuses the next session with 59 seconds left', async () => {
        const { deps, input } = fixture({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }) });
        expect(await openComputeEpochAtReady({ deps, userId: USER, computerId: 'new', size: 'free-cf', readyAt: NOW, overheadSeconds: 0 }))
            .toMatchObject({ decision: { admit: true, maxRunSeconds: 3600 } });
        input.epochs = Array.from({ length: 8 }, (_, i) => ({ ...epoch(`2026-10-10T0${i}:00:00Z`, `2026-10-10T0${i}:59:${i === 7 ? '01' : '59'}Z`), size: 'free-cf' as const, weight: 1 as const }));
        input.epochs[0]!.endedAt = '2026-10-10T01:00:00Z';
        for (let i = 1; i < 7; i++) input.epochs[i]!.endedAt = `2026-10-10T0${i + 1}:00:00Z`;
        expect(await gateComputerStart({ deps, userId: USER, computerId: 'new', kind: 'cloudflare', instanceType: null, now: NOW }))
            .toEqual({ allowed: false, reason: 'fair_use_paused' });
    });
    it('paid cancellation at period end keeps access only through the paid period', async () => {
        const {deps,input}=fixture({config:readBillingConfig({BILLING_ENFORCEMENT:'1'}),
            subs:[subscription({sku:'premium_monthly_v3',cancelAtPeriodEnd:true})], grants:[grant()]});
        const reader=billingV2EntitlementReader(()=>deps);
        expect(await reader.read(USER)).toMatchObject({provider:'aws',status:'active'});
        input.subs=[subscription({sku:'premium_monthly_v3',cancelAtPeriodEnd:true,currentPeriodEnd:NOW})];
        expect(await reader.read(USER)).toMatchObject({provider:'cloudflare',planId:'free_v3'});
        input.subs=[subscription({sku:'premium_monthly_v3',status:'canceled'})];
        expect(await reader.read(USER)).toMatchObject({provider:'cloudflare',planId:'free_v3'});
    });
    it('requires a paid-period receipt, and rejects revoked or foreign grants', async () => {
        const { deps, input } = fixture({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }), subs: [subscription({ sku: 'standard_monthly_v3' })] });
        const gate = () => gateComputerStart({ deps, userId: USER, computerId: 'new', kind: 'aws-ec2', instanceType: null, now: NOW });
        expect(await gate()).toEqual({ allowed: false, reason: 'fair_use_paused' });
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toMatchObject({status:'expired'});
        input.grants = [grant({ amount: BigInt(144000), subscriptionId: 'foreign' })];
        expect(await gate()).toEqual({ allowed: false, reason: 'fair_use_paused' });
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toMatchObject({status:'expired'});
        input.grants = [grant({ amount: BigInt(144000) })];
        expect(await gate()).toEqual({ allowed: true });
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toMatchObject({status:'active'});
        input.grants = [...input.grants, grant({ kind: 'revoke', amount: BigInt(-144000) })];
        expect(await gate()).toEqual({ allowed: false, reason: 'fair_use_paused' });
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toMatchObject({status:'expired'});
    });
    it('retains paid Standard while an upgrade requires payment and blocks a second computer', async () => {
        const { deps, input } = fixture({ config: readBillingConfig({ BILLING_ENFORCEMENT: '1' }),
            subs: [subscription({ sku: 'standard_monthly_v3' })], grants: [grant({ amount: BigInt(144000) })],
            paymentIssues: [issue({ invoiceKind: 'upgrade', issue: 'requires_action' })] });
        const gate = () => gateComputerStart({ deps, userId: USER, computerId: 'new', kind: 'aws-ec2', instanceType: null, now: NOW });
        expect(await gate()).toEqual({ allowed: true });
        input.epochs = [{ ...epoch('2026-10-18T11:00:00Z', '2026-10-18T12:00:00Z'), endedAt: null }];
        expect(await gate()).toEqual({ allowed: false, reason: 'concurrent_limit' });
        input.epochs = [];
        // Round 4 D17: a fresh subscription issue is grace (paid computer usable); 7 days on it is Free, and a
        // Free start with no placement type (a canary) is still refused.
        input.paymentIssues = [issue()];
        expect(await gate()).toEqual({ allowed: true });
        input.paymentIssues = [issue({ stripeEventCreated: new Date(NOW.getTime() - 7 * 86_400_000) })];
        expect(await gate()).toEqual({ allowed: false, reason: 'size_not_allowed' });
    });
});

describe('round 4: grace (D17), dropped plans (D18) and the Free hold on AWS (D16)', () => {
    const DAY = 86_400_000;
    const ago = (ms: number) => new Date(NOW.getTime() - ms);
    // A failed renewal: the period has moved on, its invoice is unpaid, so the period has no receipt yet.
    const renewal = (over: Partial<SubscriptionRow> = {}) => subscription({ sku: 'standard_monthly_v3', status: 'past_due',
        currentPeriodStart: ago(2 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 28 * DAY), ...over });
    const canceled = () => [subscription({ sku: 'premium_monthly_v3', status: 'canceled', stripeSubscriptionId: 'sub_p' }),
        subscription({ sku: 'standard_monthly_v3', status: 'canceled' })];
    const shadow = () => readBillingConfig({ BILLING_TAB_ENABLED: '1' });

    it('v3 past_due inside grace opens AWS at the paid size through the full gate, and the Billing summary still says so', async () => {
        const { deps } = fixture({ config: enforced(), subs: [renewal()], paymentIssues: [issue({ stripeEventCreated: ago(2 * DAY) })] });
        expect(await gate(deps)).toEqual({ allowed: true });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject({ planSku: 'standard_monthly_v3', planActive: true, delinquent: true, paymentIssue: false,
            provider: 'aws', entitledSize: 'std-2', allowanceStdSeconds: 40 * 3600 });
        expect(state.summary.version === 3 && state.summary.plan).toMatchObject({ status: 'past_due', paymentIssue: 'payment_failed' });
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toMatchObject({ status: 'active', provider: 'aws', size: 'std-2', paymentIssue: false });
        // Premium in grace keeps its chosen configuration; a refund reversal for the period still wins (D19).
        const premium = fixture({ config: enforced(), subs: [renewal({ sku: 'premium_monthly_v3' })], sizePreference: 'cmp-8',
            paymentIssues: [issue({ stripeEventCreated: ago(DAY) })] });
        expect(await gate(premium.deps, { instanceType: 'm6i.2xlarge' })).toEqual({ allowed: true });
        premium.input.grants = [grant({ periodStart: ago(2 * DAY), periodEnd: new Date(NOW.getTime() + 28 * DAY), amount: BigInt(0) })];
        expect(await gate(premium.deps, { instanceType: 'm6i.2xlarge' })).toEqual({ allowed: false, reason: 'fair_use_paused' });
    });

    it.each([
        ['day 6 (6 d 23 h 59 m)', 7 * DAY - 60_000, true],
        ['day 7 (exactly 7 d)', 7 * DAY, false],
    ] as const)('grace on %s', async (_label, age, inGrace) => {
        const { deps } = fixture({ config: shadow(), subs: [renewal({ currentPeriodStart: ago(8 * DAY) })],
            paymentIssues: [issue({ stripeEventCreated: ago(age) })] });
        const state = await loadComputeBillingState(deps, USER, NOW);
        expect(state).toMatchObject(inGrace ? { planSku: 'standard_monthly_v3', provider: 'aws', paymentIssue: false }
            : { planSku: 'free_v3', provider: 'cloudflare', paymentIssue: false, planActive: true, entitledSize: 'free-cf', window: MONTH, sessionMaxSeconds: 3600 });
        const decision = await gate(deps);
        expect(decision).toMatchObject({ allowed: true, shadow: inGrace ? { admit: true, size: 'std-2' } : { admit: true, size: 'std-2', maxRunSeconds: 3600, hold: true } });
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toMatchObject(inGrace
            ? { status: 'active', provider: 'aws' } : { status: 'active', provider: 'cloudflare', planId: 'free_v3' });
    });

    it.each(['unpaid', 'incomplete'])('%s drops to Free at once (no grace)', async status => {
        const { deps } = fixture({ config: enforced(), subs: [renewal({ status })], paymentIssues: [issue()] });
        expect(await loadComputeBillingState(deps, USER, NOW)).toMatchObject({ planSku: 'free_v3', provider: 'cloudflare', paymentIssue: false });
        expect(await gate(deps, { instanceType: 'm6i.xlarge' })).toEqual({ allowed: false, reason: 'files_on_aws' });
        expect(await gate(deps, { kind: 'cloudflare', instanceType: null })).toEqual({ allowed: true });
    });

    it('D16: an immediate cancel holds the AWS computer at std-2 under Free limits; cmp-4/cmp-8 and a typeless canary are refused', async () => {
        const admit = vi.spyOn(admissionV3, 'admitStart');
        const { deps } = fixture({ config: enforced(), subs: canceled(), epochs: [epoch('2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z')] });
        expect(await gate(deps)).toEqual({ allowed: true });
        expect(admit).toHaveLastReturnedWith({ admit: true, size: 'std-2', maxRunSeconds: 3600, fromPool: false, poolPriority: 0, hold: true,
            deadline: isoSeconds(epochSeconds(NOW) + 3600) });
        expect(admit).toHaveBeenLastCalledWith(expect.objectContaining({ sku: 'free_v3', size: 'std-2', hold: true, usedSeconds: 4 * 3600 }));
        expect(await gate(deps, { instanceType: 'm6i.xlarge' })).toEqual({ allowed: false, reason: 'files_on_aws' });
        expect(await gate(deps, { instanceType: 'm6i.2xlarge' })).toEqual({ allowed: false, reason: 'files_on_aws' });
        expect(await gate(deps, { instanceType: null })).toEqual({ allowed: false, reason: 'size_not_allowed' });
        expect(await gate(deps, { kind: 'cloudflare', instanceType: null })).toEqual({ allowed: true });
        // Free fair use still applies to the hold.
        // Legacy Free (no creation date): 8 h; two one-hour cmp-8 sessions are 8 standard-hours.
        const spent = fixture({ config: enforced(), subs: canceled(), epochs: [epoch('2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z'),
            epoch('2026-10-03T00:00:00Z', '2026-10-03T01:00:00Z')] });
        expect(await gate(spent.deps)).toEqual({ allowed: false, reason: 'fair_use_paused' });
    });

    it('ready-epoch trap: decideStart at readiness keeps the hold (deadline = ready + Free remaining, not ready)', async () => {
        const { deps } = fixture({ config: enforced(), subs: canceled(),
            // 4 h + 3 h 50 m of the legacy Free 8 h: 600 seconds left.
            epochs: [epoch('2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z'), epoch('2026-10-03T00:00:00Z', '2026-10-03T00:57:30Z')] });
        const result = await open(deps, { size: 'std-2' });
        expect(result).toMatchObject({ status: 'opened', deadlineAt: isoSeconds(epochSeconds(READY) + 600), decision: { admit: true, hold: true, size: 'std-2' } });
        const fresh = fixture({ config: enforced(), subs: canceled() });
        expect(await open(fresh.deps, { size: 'std-2' })).toMatchObject({ status: 'opened', deadlineAt: isoSeconds(epochSeconds(READY) + 3600),
            decision: { hold: true } });
        // A larger AWS type at readiness is not held: it is recorded due at once.
        const big = fixture({ config: enforced(), subs: canceled() });
        expect(await open(big.deps, { size: 'cmp-8' })).toMatchObject({ deadlineAt: isoSeconds(epochSeconds(READY)), decision: { admit: false } });
    });

    it('cancel at period end keeps the paid computer until the end (plan_ending), then holds it', async () => {
        const { deps, input } = fixture({ config: enforced(), subs: [subscription({ sku: 'premium_monthly_v3', cancelAtPeriodEnd: true })],
            grants: [grant({ amount: BigInt(1_800_000) })], sizePreference: 'cmp-8' });
        expect(await gate(deps, { instanceType: 'm6i.2xlarge' })).toEqual({ allowed: true });
        input.subs = [subscription({ sku: 'premium_monthly_v3', cancelAtPeriodEnd: true, currentPeriodEnd: NOW })];
        expect(await gate(deps, { instanceType: 'm6i.2xlarge' })).toEqual({ allowed: false, reason: 'files_on_aws' });
        expect(await gate(deps, { instanceType: 'm6i.large' })).toEqual({ allowed: true });
    });
});

// Round 6 R2-3: Stripe reports a new paid period active before its invoice receipt (the compute grant) is processed.
// The open in between was refused as fair use used up (or, unenforced, cold-booted as the Free hold).
describe('round 6 R2-3: a paid period whose compute grant has not landed yet', () => {
    const enforced = () => readBillingConfig({ BILLING_ENFORCEMENT: '1' });
    const started = (secondsAgo: number) => subscription({ sku: 'standard_monthly_v3',
        currentPeriodStart: new Date(NOW.getTime() - secondsAgo * 1000), currentPeriodEnd: new Date(NOW.getTime() + 30 * 86_400_000) });
    const gate = (deps: BillingDeps, kind: 'aws-ec2' | 'cloudflare' = 'aws-ec2') =>
        gateComputerStart({ deps, userId: USER, computerId: 'computer_a', kind, instanceType: kind === 'aws-ec2' ? 'm6i.large' : null, now: NOW });

    it.each([[0, true], [120, true], [599, true], [600, false], [8 * 86_400, false]])('%i s after the period start, pending = %s', async (ago, pending) => {
        const { deps } = fixture({ config: enforced(), subs: [started(ago)] });
        expect((await loadComputeBillingState(deps, USER, NOW)).grantPending).toBe(pending);
        expect(await computeGrantPending(USER, () => deps)).toBe(pending);
    });

    it('an AWS open passes the gate to ensure() (which waits) instead of a fair_use_paused refusal; the grant then admits it', async () => {
        const { deps, input } = fixture({ config: enforced(), subs: [started(120)] });
        expect(await gate(deps)).toEqual({ allowed: true });
        // The Cloudflare path has no wait of its own: unchanged.
        expect(await gate(deps, 'cloudflare')).toEqual({ allowed: false, reason: 'fair_use_paused' });
        // The entitlement stays unpaid until the grant lands (ensure() reads it as Free, so it must wait).
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toMatchObject({ status: 'expired' });
        input.grants = [grant({ amount: BigInt(144000), periodStart: new Date(NOW.getTime() - 120_000), periodEnd: new Date(NOW.getTime() + 30 * 86_400_000) })];
        expect((await loadComputeBillingState(deps, USER, NOW)).grantPending).toBe(false);
        expect(await gate(deps)).toEqual({ allowed: true });
        expect(await billingV2EntitlementReader(() => deps).read(USER)).toMatchObject({ status: 'active', provider: 'aws', size: 'std-2' });
    });

    it.each<[string, Partial<Input>]>([
        ['a revoked grant for the period', { grants: [grant({ kind: 'revoke', amount: BigInt(-144000), periodStart: new Date(NOW.getTime() - 120_000), periodEnd: new Date(NOW.getTime() + 86_400_000) })] }],
        ['a canceled plan (Free)', { subs: [{ ...started(120), status: 'canceled' }] }],
        ['a payment issue (grace has its own allowance)', { paymentIssues: [issue()] }],
        ['Free', { subs: [] }],
    ])('is not pending with %s', async (_name, over) => {
        const { deps } = fixture({ config: enforced(), subs: [started(120)], ...over });
        expect((await loadComputeBillingState(deps, USER, NOW)).grantPending).toBe(false);
    });

    it('metering off or an unreadable state is never pending', async () => {
        const off = fixture({ config: readBillingConfig({}), subs: [started(120)] });
        expect(await computeGrantPending(USER, () => off.deps)).toBe(false);
        expect(off.calls).toEqual([]);
        const broken = fixture({ config: enforced(), subs: [started(120)] });
        broken.deps.store.subscriptionsFor = async () => { throw new Error('db down'); };
        await expect(computeGrantPending(USER, () => broken.deps)).rejects.toThrow('db down');
    });
});
