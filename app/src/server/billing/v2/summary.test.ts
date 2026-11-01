import { describe, expect, it } from 'vitest';

import { readBillingConfig } from '../config';
import type { SubscriptionRow } from '../meters';
import type { GrantRow, OverageConsentRow, PaymentIssueRow, PlanChangeRow } from '../ports';
import { OVERAGE_TERMS_VERSION, type ComputeEpoch, type SizeCode } from './contract';
import { buildSummaryV2, summaryMeters } from './summary';

const START = '2026-10-01T00:00:00Z';
const END = '2026-11-01T00:00:00Z';
const NOW = new Date('2026-10-18T12:00:00.789Z');
type Input = Parameters<typeof buildSummaryV2>[0];

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
    return {
        stripeSubscriptionId: 'sub_a', sku: 'standard_monthly_v2', status: 'active',
        currentPeriodStart: new Date(START), currentPeriodEnd: new Date(END), cancelAtPeriodEnd: false, ...overrides,
    };
}

function grant(amount: bigint | number, overrides: Partial<GrantRow> = {}): GrantRow {
    return {
        id: 'grant_a', userId: 'user_a', subscriptionId: 'sub_a', meter: 'compute_std_seconds', kind: 'plan_period',
        amount: BigInt(amount), periodStart: new Date(START), periodEnd: new Date(END),
        sourceType: 'invoice', sourceId: 'in_a', createdAt: NOW, ...overrides,
    };
}

function epoch(seconds: number, overrides: Partial<ComputeEpoch> = {}): ComputeEpoch {
    return {
        id: 'epoch_a', userId: 'user_a', computerId: 'computer_a', size: 'std-2', weight: 1,
        readyAt: START, endedAt: new Date(Date.parse(START) + seconds * 1000).toISOString(),
        endReason: 'user_stop', overheadSeconds: 0, ...overrides,
    };
}

function consent(overrides: Partial<OverageConsentRow> = {}): OverageConsentRow {
    return {
        id: BigInt(1), userId: 'user_a', subscriptionId: 'sub_a', enabled: true, capCents: 2500,
        termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: 2, rateCentsPerStdHour: 25,
        actor: 'user', acceptedAt: NOW, ...overrides,
    };
}

function change(overrides: Partial<PlanChangeRow> = {}): PlanChangeRow {
    return {
        id: 'change_a', userId: 'user_a', subscriptionId: 'sub_a', kind: 'upgrade', state: 'pending',
        fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2', stripeInvoiceId: 'in_upgrade',
        stripeScheduleId: null, hostedInvoiceUrl: 'https://invoice.example/upgrade',
        effectiveAt: null, expiresAt: null, createdAt: NOW, updatedAt: NOW, ...overrides,
    };
}

function issue(overrides: Partial<PaymentIssueRow> = {}): PaymentIssueRow {
    return {
        stripeInvoiceId: 'in_issue', userId: 'user_a', subscriptionId: 'sub_a', invoiceKind: 'subscription',
        issue: 'payment_failed', hostedInvoiceUrl: null, stripeEventCreated: NOW, updatedAt: NOW,
        resolvedAt: null, ...overrides,
    };
}

function input(overrides: Partial<Input> = {}): Input {
    return {
        config: readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' }),
        now: NOW, userCreatedAt: null, subs: [], epochs: [], grants: [], consent: null,
        planChanges: [], paymentIssues: [], storage: [], sizePreference: null, hasCustomer: false, ...overrides,
    };
}

function compute(overrides: Partial<Input> = {}): Input {
    return input({ subs: [subscription({ sku: 'compute_monthly_v2' })], grants: [grant(1000)], ...overrides });
}

describe('buildSummaryV2', () => {
    it.each([null, new Date('2020-01-01T00:00:00Z'), new Date('2099-01-01T00:00:00Z')])(
        'keeps legacy Free at eight hours while the effective date is pinned null (created %s)', userCreatedAt => {
            const result = buildSummaryV2(input({ userCreatedAt, epochs: [epoch(3600, { size: 'free-cf' })], grants: [grant(999999)] }));
            expect(result.plan).toEqual({
                sku: 'free_v1_legacy', family: 'free', status: 'free', periodStart: START, periodEnd: END,
                renewsAt: null, cancelsAt: null, pendingUpgrade: null, scheduledChange: null, paymentIssue: null,
            });
            expect(result.compute).toEqual({
                allowanceStdSeconds: 28800, usedStdSeconds: 3600, remainingStdSeconds: 25200,
                resetsAt: END, state: 'ok', remainingActualSecondsBySize: { 'free-cf': 25200 },
                allowedSizes: ['free-cf'], selectedSize: 'free-cf',
                session: { maxSeconds: 21600, warnSeconds: [900, 300], idleSleepSeconds: 600, activeDeadline: null },
            });
            expect(result.overage).toBeNull();
            expect(result.estimate).toEqual({ nextChargeAt: null, subscriptionCents: null, accruedOverageCents: 0,
                worstCaseOverageCents: 0, currency: 'usd', taxNote: 'before_tax' });
        },
    );

    it('sums overlapping grants and reversals, excluding other meters and touching or missing periods', () => {
        const result = buildSummaryV2(input({ subs: [subscription()], grants: [
            grant(216000), grant(-16000, { kind: 'revoke', sourceType: 'refund' }),
            grant(1000, { periodStart: new Date('2026-09-30T00:00:00Z'), periodEnd: new Date('2026-10-02T00:00:00Z') }),
            grant(999, { meter: 'ai_usd_micro' }), grant(999, { meter: 'workspace_seconds' }),
            grant(999, { periodEnd: new Date(START) }), grant(999, { periodStart: new Date(END) }),
            grant(999, { periodStart: null }), grant(999, { periodEnd: null }),
        ] }));
        expect(result.compute.allowanceStdSeconds).toBe(201000);
        expect(result.overage).toBeNull();
    });

    it('honours legacy workspace grants including suspend, restore and revoke rows', () => {
        const result = buildSummaryV2(input({ subs: [subscription({ sku: 'pro_monthly_v1' })], grants: [
            grant(72000, { meter: 'workspace_seconds', kind: 'pro_period', subscriptionId: null }),
            grant(-72000, { meter: 'workspace_seconds', kind: 'suspend' }),
            grant(72000, { meter: 'workspace_seconds', kind: 'restore' }),
            grant(-1000, { meter: 'workspace_seconds', kind: 'revoke' }), grant(500),
        ] }));
        expect(result.plan.family).toBe('pro_legacy');
        expect(result.compute.allowanceStdSeconds).toBe(71500);
        expect(summaryMeters('pro_legacy')).toEqual(['compute_std_seconds', 'workspace_seconds']);
        expect(summaryMeters('standard')).toEqual(['compute_std_seconds']);
        expect(summaryMeters('compute')).toEqual(['compute_std_seconds']);
        expect(summaryMeters('free')).toEqual([]);
    });

    it('counts only current subscription compute grants after cancellation and resubscription, including revokes', () => {
        const result = buildSummaryV2(input({
            subs: [subscription({ stripeSubscriptionId: 'sub_old', status: 'canceled' }), subscription()],
            grants: [
                grant(216000, { subscriptionId: 'sub_old' }),
                grant(-1000, { subscriptionId: 'sub_old', kind: 'revoke', sourceType: 'refund' }),
                grant(216000), grant(-16000, { kind: 'revoke', sourceType: 'refund' }),
                grant(999, { subscriptionId: null }),
            ],
        }));
        expect(result.plan).toMatchObject({ status: 'active', family: 'standard' });
        expect(result.compute.allowanceStdSeconds).toBe(200000);
    });

    it('adds the paid upgrade grant mid-period while usage carries over', () => {
        const before = buildSummaryV2(input({ subs: [subscription()], grants: [grant(216000)], epochs: [epoch(3600)] }));
        const after = buildSummaryV2(compute({ grants: [grant(216000), grant(792000, { kind: 'upgrade_prorated' })], epochs: [epoch(3600)] }));
        expect(after.compute.allowanceStdSeconds).toBe(1008000);
        expect(after.compute.usedStdSeconds).toBe(before.compute.usedStdSeconds);
        expect(after.compute.remainingStdSeconds).toBe(1004400);
    });

    it.each(['active', 'past_due', 'incomplete'])('an unpaid renewal has zero allowance for %s', status => {
        const result = buildSummaryV2(input({
            subs: [subscription({ status })], grants: [grant(216000, {
                periodStart: new Date('2026-09-01T00:00:00Z'), periodEnd: new Date(START),
            })],
        }));
        expect(result.plan.family).toBe('standard');
        expect(result.compute).toMatchObject({ allowanceStdSeconds: 0, remainingStdSeconds: 0, state: 'exhausted' });
        expect(result.plan.paymentIssue).toBe(status === 'active' ? null : 'payment_failed');
    });

    it('clamps negative allowance and sums with BigInt before checking the final safe integer', () => {
        expect(buildSummaryV2(compute({ grants: [grant(100), grant(-101)] })).compute.allowanceStdSeconds).toBe(0);
        const large = BigInt('9007199254740993');
        expect(buildSummaryV2(compute({ grants: [grant(large), grant(-large + BigInt(100))] })).compute.allowanceStdSeconds).toBe(100);
        expect(() => buildSummaryV2(compute({ grants: [grant(large)] }))).toThrow(RangeError);
    });

    it.each([
        { used: 799, state: 'ok' }, { used: 800, state: 'low' }, { used: 1000, state: 'exhausted' },
    ])('uses integer thresholds at $used standard-seconds', ({ used, state }) => {
        expect(buildSummaryV2(compute({ epochs: [epoch(used)] })).compute.state).toBe(state);
    });

    it.each([null, false, true])('bills overage only with enabled consent: %s', decision => {
        const accepted = decision === null ? null : consent({ enabled: decision });
        const result = buildSummaryV2(compute({ consent: accepted, epochs: [epoch(1441, { size: 'cmp-4', weight: 2 })] }));
        const enabled = accepted?.enabled === true;
        expect(result.compute).toMatchObject({ usedStdSeconds: 2882, remainingStdSeconds: 0, state: 'exhausted' });
        expect(result.overage).toEqual({
            available: true, enabled, centsPerStdHour: 25, capCents: 2500, defaultCapCents: 2500, maxCapCents: 10000,
            accruedCents: enabled ? 13 : 0, termsVersion: OVERAGE_TERMS_VERSION,
            acceptedVersion: accepted?.termsVersion ?? null, acceptedAt: accepted ? '2026-10-18T12:00:00Z' : null,
            pausedReason: null,
        });
        expect(result.estimate).toEqual({ nextChargeAt: END, subscriptionCents: 10000, accruedOverageCents: enabled ? 13 : 0,
            worstCaseOverageCents: enabled ? 2500 : 0, currency: 'usd', taxNote: 'before_tax' });
    });

    it.each([{ termsVersion: 'overage-v1' }, { rateCentsPerStdHour: 30 }])('disables stale consent but preserves its acceptance details: %o', stale => {
        const accepted = consent(stale);
        const result = buildSummaryV2(compute({ consent: accepted, epochs: [epoch(2000)] }));
        expect(result.overage).toMatchObject({ enabled: false, accruedCents: 0, acceptedVersion: accepted.termsVersion,
            acceptedAt: '2026-10-18T12:00:00Z' });
        expect(result.estimate).toMatchObject({ accruedOverageCents: 0, worstCaseOverageCents: 0 });
    });

    it.each(['open', 'payment_failed', 'requires_action', 'uncollectible'] as const)('disables later consent for a %s invoice without an issue row', status => {
        const invoice = { id: 'overage_previous', userId: 'user_a', subscriptionId: 'sub_a', periodStart: new Date('2026-09-01T00:00:00Z'),
            periodEnd: new Date(START), ratingVersion: 1, stdSecondsOver: BigInt(14400), cents: 100, stripeInvoiceId: 'in_previous',
            status, createdAt: new Date(START), updatedAt: new Date(START) };
        const result = buildSummaryV2(compute({ consent: consent(), overageInvoices: [invoice], epochs: [epoch(2000)] }));
        expect(result.overage).toMatchObject({ enabled: false, available: false, pausedReason: 'payment_failed', accruedCents: 0 });
        expect(result.estimate.worstCaseOverageCents).toBe(0);
        for (const resolved of [{ ...invoice, status: 'paid' as const }, { ...invoice, status: 'void' as const },
            { ...invoice, subscriptionId: 'sub_other' }]) {
            expect(buildSummaryV2(compute({ consent: consent(), overageInvoices: [resolved] })).overage?.enabled).toBe(true);
        }
    });

    it.each([0, 2])('reports cap reached at cap %i, with billed overage bounded by it', capCents => {
        const result = buildSummaryV2(compute({ consent: consent({ capCents }), epochs: [epoch(1432)] }));
        expect(result.compute.state).toBe('over_cap');
        expect(result.overage).toMatchObject({ accruedCents: capCents, pausedReason: 'cap_reached' });
        expect(result.estimate.accruedOverageCents).toBe(capCents);
    });

    it('turns overage off for an open overage issue without losing acceptance details', () => {
        const result = buildSummaryV2(compute({ consent: consent(), epochs: [epoch(2000)],
            paymentIssues: [issue({ invoiceKind: 'overage', issue: 'requires_action' })] }));
        expect(result.plan.paymentIssue).toBe('overage_unpaid');
        expect(result.compute.state).toBe('exhausted');
        expect(result.overage).toMatchObject({ available: false, enabled: false, accruedCents: 0,
            acceptedVersion: OVERAGE_TERMS_VERSION, pausedReason: 'payment_failed' });
        expect(result.estimate.worstCaseOverageCents).toBe(0);
    });

    it('prioritizes subscription action, other subscription failures, then overage, ignoring resolved issues', () => {
        const overage = issue({ invoiceKind: 'overage' });
        const failed = issue({ invoiceKind: 'upgrade', issue: 'uncollectible' });
        const action = issue({ issue: 'requires_action' });
        expect(buildSummaryV2(compute({ paymentIssues: [overage, failed, action] })).plan.paymentIssue).toBe('requires_action');
        expect(buildSummaryV2(compute({ paymentIssues: [overage, failed] })).plan.paymentIssue).toBe('payment_failed');
        expect(buildSummaryV2(compute({ paymentIssues: [overage, { ...action, resolvedAt: NOW }] })).plan.paymentIssue).toBe('overage_unpaid');
        expect(buildSummaryV2(compute({ paymentIssues: [{ ...overage, resolvedAt: NOW }] })).plan.paymentIssue).toBeNull();
    });

    it.each(['subscription', 'upgrade', 'overage'] as const)('ignores an old subscription payment issue of kind %s', invoiceKind => {
        const result = buildSummaryV2(compute({
            subs: [subscription({ stripeSubscriptionId: 'sub_old', status: 'canceled' }), subscription({ sku: 'compute_monthly_v2' })],
            consent: consent(), paymentIssues: [issue({ subscriptionId: 'sub_old', invoiceKind })],
        }));
        expect(result.plan.paymentIssue).toBeNull();
        expect(result.overage).toMatchObject({ available: true, enabled: true, pausedReason: null });
    });

    it('ignores a voided subscription invoice issue', () => {
        const result = buildSummaryV2(input({ subs: [subscription()], paymentIssues: [issue({ issue: 'voided' })] }));
        expect(result.plan.paymentIssue).toBeNull();
        expect(result.actions.upgrade).toBe(true);
    });

    it('allows overage to be re-enabled after its invoice is voided', () => {
        const result = buildSummaryV2(compute({ consent: consent({ enabled: false }),
            paymentIssues: [issue({ invoiceKind: 'overage', issue: 'voided' })] }));
        expect(result.plan.paymentIssue).toBeNull();
        expect(result.overage).toMatchObject({ available: true, enabled: false, pausedReason: null });
    });

    it.each(['past_due', 'incomplete'])('ignores an unrelated lingering %s row when an active plan wins', status => {
        const subs = [subscription(), subscription({ stripeSubscriptionId: 'sub_delinquent', status, sku: 'compute_monthly_v2' })];
        const result = buildSummaryV2(input({ subs }));
        expect(result.plan).toMatchObject({ family: 'standard', status: 'active', paymentIssue: null });
        expect(result.actions.upgrade).toBe(true);
        expect(buildSummaryV2(input({ subs: [subscription({ sku: 'unknown', status: 'past_due' })] })).plan.paymentIssue).toBeNull();
    });

    it.each(['pending', 'requires_action', 'payment_failed'] as const)('shows a %s upgrade and disables another upgrade', state => {
        const result = buildSummaryV2(input({ subs: [subscription()], planChanges: [change({ state })] }));
        expect(result.plan).toMatchObject({ status: 'upgrade_pending', pendingUpgrade: {
            toSku: 'compute_monthly_v2', expiresAt: END, hostedInvoiceUrl: 'https://invoice.example/upgrade',
        } });
        expect(result.actions.upgrade).toBe(false);
    });

    it('ignores closed changes, invalid target SKUs and changes for other subscriptions', () => {
        const result = buildSummaryV2(input({ subs: [subscription()], planChanges: [
            change({ state: 'applied' }), change({ subscriptionId: 'sub_other' }), change({ toSku: 'unknown' }),
        ] }));
        expect(result.plan.pendingUpgrade).toBeNull();
        expect(result.plan.status).toBe('active');
        expect(result.actions.upgrade).toBe(true);
    });

    it('estimates the scheduled downgrade target and omits a cancelling subscription charge', () => {
        const planChanges = [change({ kind: 'downgrade', state: 'scheduled', fromSku: 'compute_monthly_v2',
            toSku: 'standard_monthly_v2', effectiveAt: new Date(END) })];
        const result = buildSummaryV2(compute({ planChanges }));
        expect(result.plan.scheduledChange).toEqual({ toSku: 'standard_monthly_v2', effectiveAt: END });
        expect(result.estimate.subscriptionCents).toBe(2000);
        expect(result.actions.downgrade).toBe(false);
        const cancel = buildSummaryV2(compute({ subs: [subscription({ sku: 'compute_monthly_v2', cancelAtPeriodEnd: true })], planChanges }));
        expect(cancel.plan).toMatchObject({ status: 'cancels', cancelsAt: END, renewsAt: null });
        expect(cancel.estimate).toMatchObject({ nextChargeAt: null, subscriptionCents: null });
        expect(cancel.actions.downgrade).toBe(false);
    });

    it.each(['std-2', 'cmp-4', 'cmp-8', 'free-cf'] as SizeCode[])('honours only an allowed size preference %s', sizePreference => {
        const result = buildSummaryV2(compute({ sizePreference, grants: [grant(1003)] }));
        expect(result.compute.selectedSize).toBe(sizePreference === 'free-cf' ? 'std-2' : sizePreference);
        expect(result.compute.remainingActualSecondsBySize).toEqual({ 'std-2': 1003, 'cmp-4': 501, 'cmp-8': 250 });
        expect(buildSummaryV2(input({ sizePreference })).compute.selectedSize).toBe('free-cf');
    });

    it('uses ready plus six hours for the latest open epoch even after its deadline', () => {
        const result = buildSummaryV2(compute({ epochs: [
            epoch(1, { readyAt: '2026-10-02T00:00:00Z', endedAt: null }),
            epoch(1, { readyAt: '2026-10-04T00:00:00Z', endedAt: '2026-10-04T01:00:00Z' }),
            epoch(1, { readyAt: '2026-10-03T00:00:00.001Z', endedAt: null }),
        ] }));
        expect(result.compute.session.activeDeadline).toBe('2026-10-03T06:00:01Z');
        expect(result.compute.usedStdSeconds).toBe(21600 * 2 + 3600);
    });

    it('the newest open epoch uses its stored deadline even when an older epoch has a later deadline', () => {
        const result = buildSummaryV2(compute({ epochs: [
            { ...epoch(0, { readyAt: '2026-10-03T00:00:00Z', endedAt: null }), deadlineAt: '2026-10-03T00:16:40Z' },
            { ...epoch(0, { readyAt: '2026-10-02T23:00:00Z', endedAt: null }), deadlineAt: '2026-10-03T05:00:00Z' },
            { ...epoch(1, { readyAt: '2026-10-04T00:00:00Z', endedAt: '2026-10-04T01:00:00Z' }), deadlineAt: '2026-10-04T06:00:00Z' },
        ] }));
        expect(result.compute.session.activeDeadline).toBe('2026-10-03T00:16:40Z');
    });

    it.each([null, undefined])('legacy newest open epoch with deadline %s falls back to its own ready time', deadlineAt => {
        const result = buildSummaryV2(compute({ epochs: [
            { ...epoch(0, { readyAt: '2026-10-03T00:00:00Z', endedAt: null }), deadlineAt },
            { ...epoch(0, { readyAt: '2026-10-02T00:00:00Z', endedAt: null }), deadlineAt: '2026-10-02T00:01:00Z' },
        ] }));
        expect(result.compute.session.activeDeadline).toBe('2026-10-03T06:00:00Z');
    });

    it.each([
        ['stored deadline wins', '2026-10-18T12:01:00Z', 1000, '2026-10-18T12:01:00Z'],
        ['headroom wins', '2026-10-18T13:00:00Z', 1000, '2026-10-18T12:03:10Z'],
        ['no stored deadline', null, 1000, '2026-10-18T12:03:10Z'],
        ['missing stored deadline', undefined, 1000, '2026-10-18T12:03:10Z'],
        ['exhausted', null, 240, '2026-10-18T12:00:00Z'],
        ['stored beyond session maximum', '2026-10-19T00:00:00Z', 1000000, '2026-10-18T17:59:00Z'],
    ])('%s bounds the weighted running session', (_label, deadlineAt, allowance, expected) => {
        const result = buildSummaryV2(compute({ grants: [grant(allowance)], epochs: [
            { ...epoch(0, { readyAt: '2026-10-18T11:59:00Z', endedAt: null, size: 'cmp-8', weight: 4 }), deadlineAt },
        ] }));
        expect(result.compute.usedStdSeconds).toBe(240);
        expect(result.compute.session.activeDeadline).toBe(expected);
    });

    it.each([true, false])('includes the cap in session headroom only with overage enabled=%s', enabled => {
        const result = buildSummaryV2(compute({ grants: [grant(0)], consent: consent({ enabled, capCents: 25 }), epochs: [
            epoch(0, { readyAt: '2026-10-18T11:59:00Z', endedAt: null, size: 'cmp-4', weight: 2 }),
        ] }));
        expect(result.compute.session.activeDeadline).toBe(enabled ? '2026-10-18T12:29:00Z' : '2026-10-18T12:00:00Z');
    });

    it('closed epochs with stored deadlines do not supply an active deadline', () => {
        expect(buildSummaryV2(compute({ epochs: [{ ...epoch(60), deadlineAt: '2026-10-01T06:00:00Z' }] }))
            .compute.session.activeDeadline).toBeNull();
    });

    it('selects the newest legacy ready timestamp before rounding to whole seconds', () => {
        const result = buildSummaryV2(compute({ epochs: [
            { ...epoch(0, { readyAt: '2026-10-03T00:00:00.001Z', endedAt: null }), deadlineAt: '2026-10-03T00:01:00Z' },
            { ...epoch(0, { readyAt: '2026-10-03T00:00:00.999Z', endedAt: null }), deadlineAt: '2026-10-03T00:02:00Z' },
        ] }));
        expect(result.compute.session.activeDeadline).toBe('2026-10-03T00:02:00Z');
    });

    it('preserves v1 storage sampling, caps and unavailable AI', () => {
        const storage = [
            { computerId: 'a', bytes: BigInt(9000000000), measuredAt: new Date(START) },
            { computerId: 'a', bytes: BigInt(1700000000), measuredAt: NOW },
            { computerId: 'b', bytes: BigInt(100000000), measuredAt: NOW },
        ];
        const result = buildSummaryV2(compute({ storage }));
        // 1.8e9 bytes of the 2 GiB (2,147,483,648-byte) cap is 83.8%: low.
        expect(result.storage).toEqual({ usedBytes: '1800000000', capBytes: '2147483648', state: 'low', measuredAt: '2026-10-18T12:00:00Z' });
        expect(result.ai).toEqual({ state: 'unavailable', trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null });
        const config = { ...input().config, largeStorageEnabled: true };
        expect(buildSummaryV2(compute({ config, storage })).storage.capBytes).toBe('21474836480');
        expect(buildSummaryV2(input({ config, storage })).storage.capBytes).toBe('2147483648');
        // No sample: null and unavailable, never a measured-looking '0' of 2 GB.
        expect(buildSummaryV2(input()).storage).toEqual({ usedBytes: null, capBytes: '2147483648', state: 'unavailable', measuredAt: null });
    });

    it('gates actions by family, active entitlement, customer and checkout configuration', () => {
        expect(buildSummaryV2(input({ hasCustomer: true })).actions).toEqual({ checkout: true, portal: false, upgrade: false,
            downgrade: false, cancel: false, overage: false, selectSize: false });
        expect(buildSummaryV2(compute({ hasCustomer: true })).actions).toEqual({ checkout: false, portal: true, upgrade: false,
            downgrade: true, cancel: true, overage: true, selectSize: true });
        expect(buildSummaryV2(compute({ subs: [subscription({ sku: 'compute_monthly_v2', status: 'past_due' })], hasCustomer: true })).actions)
            .toEqual({ checkout: false, portal: true, upgrade: false, downgrade: false, cancel: false, overage: false, selectSize: false });
        expect(buildSummaryV2(compute({ config: readBillingConfig({}) })).actions).toEqual({ checkout: false, portal: false,
            upgrade: false, downgrade: false, cancel: false, overage: true, selectSize: true });
        expect(buildSummaryV2(input({ subs: [subscription()], paymentIssues: [issue()] })).actions.upgrade).toBe(false);
        expect(buildSummaryV2(compute()).actions.portal).toBe(false);
    });

    it('emits exactly the contract keys, whole-second instants and safe integer quantities', () => {
        const result = buildSummaryV2(compute({
            consent: consent(), planChanges: [change({ expiresAt: NOW }), change({ kind: 'downgrade', state: 'scheduled',
                toSku: 'standard_monthly_v2', effectiveAt: NOW })],
            epochs: [epoch(1, { readyAt: NOW.toISOString(), endedAt: null })],
            storage: [{ computerId: 'a', bytes: BigInt(1), measuredAt: NOW }],
        }));
        const keys = (value: unknown, expected: string) => expect(Object.keys(value as object).sort()).toEqual(expected.split(' ').sort());
        keys(result, 'enabled version plan compute overage estimate storage ai actions catalog');
        keys(result.plan, 'sku family status periodStart periodEnd renewsAt cancelsAt scheduledChange pendingUpgrade paymentIssue');
        keys(result.plan.pendingUpgrade, 'toSku expiresAt hostedInvoiceUrl');
        keys(result.plan.scheduledChange, 'toSku effectiveAt');
        keys(result.compute, 'allowanceStdSeconds usedStdSeconds remainingStdSeconds resetsAt state remainingActualSecondsBySize allowedSizes selectedSize session');
        keys(result.compute.session, 'maxSeconds warnSeconds idleSleepSeconds activeDeadline');
        keys(result.overage, 'available enabled centsPerStdHour capCents defaultCapCents maxCapCents accruedCents termsVersion acceptedVersion acceptedAt pausedReason');
        keys(result.estimate, 'nextChargeAt subscriptionCents accruedOverageCents worstCaseOverageCents currency taxNote');
        keys(result.storage, 'usedBytes capBytes state measuredAt');
        keys(result.ai, 'state trialMicro includedMicro purchasedMicro includedExpiresAt');
        keys(result.actions, 'checkout portal upgrade downgrade cancel overage selectSize');
        keys(result.catalog, 'version offers sizes');
        expect(result.catalog.offers.map(offer => offer.sku)).toEqual(['standard_monthly_v2', 'compute_monthly_v2']);
        for (const offer of result.catalog.offers) {
            keys(offer, 'sku family priceCents currency interval allowanceStdSeconds sizes overage');
            if (offer.overage) keys(offer.overage, 'centsPerStdHour defaultCapCents maxCapCents');
        }
        expect(result.catalog.sizes).toHaveLength(4);
        for (const size of result.catalog.sizes) keys(size, 'code vcpu memoryGiB weight');
        function check(value: unknown) {
            if (typeof value === 'number') expect(Number.isSafeInteger(value)).toBe(true);
            if (typeof value === 'string' && /^\d{4}-/.test(value)) expect(value).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
            if (value !== null && typeof value === 'object') Object.values(value).forEach(check);
        }
        check(result);
        expect(() => JSON.stringify(result)).not.toThrow();
    });
});
