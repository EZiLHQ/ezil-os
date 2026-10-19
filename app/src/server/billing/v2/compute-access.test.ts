import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { SubscriptionRow } from '../meters';
import type { BillingDeps, BillingStore, GrantRow, PaymentIssueRow, StoredComputeEpoch } from '../ports';
import { freeSkuFor } from './catalog';
import { CATALOG_V2, SIZES, type ComputeEpoch } from './contract';
import { billingMeteringActive, billingV2EntitlementReader, loadComputeBillingState, gateComputerStart, openComputeEpochAtReady } from './compute-access';
import { buildSummaryV2 } from './summary';
import * as rating from './rating';
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
                deadlineAt: data.deadlineAt == null ? null : isoSeconds(Math.max(ready, Math.min(ready + 21600, epochSeconds(data.deadlineAt)))) });
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

    it.each(['subscription', 'upgrade'] as const)('an unresolved %s payment issue on an active plan uses Free', async invoiceKind => {
        const { deps } = fixture({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant()],
            sizePreference: 'cmp-8', paymentIssues: [issue({ invoiceKind })] });
        expect(await loadComputeBillingState(deps, USER, NOW)).toMatchObject({ planSku: freeSkuFor(null), planActive: true,
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
        const admit = vi.spyOn(rating, 'admitStart');
        const { deps } = fixture({ config: enforced(), subs: [subscription({ status: 'past_due' })], grants: [grant()],
            epochs: [epoch('2026-10-02T00:00:00Z', '2026-10-02T01:00:00Z')] });
        expect(await gate(deps, { kind: 'cloudflare', instanceType: null })).toEqual({ allowed: true });
        expect(admit).toHaveBeenLastCalledWith(expect.objectContaining({ planSku: freeSkuFor(null), planActive: true,
            paymentIssue: false, size: 'free-cf', usedStdSeconds: 14400, allowanceStdSeconds: CATALOG_V2[freeSkuFor(null)].allowanceStdSeconds }));
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
