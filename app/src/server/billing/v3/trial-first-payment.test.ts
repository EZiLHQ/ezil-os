import { describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from '../config';
import type { SubscriptionRow } from '../meters';
import type { BillingDeps, BillingStore, GrantRow, PaymentIssueRow } from '../ports';
import { planFromSubscriptions } from './catalog';
import { deriveStanding } from './standing';
import { renewalGrantPending } from './funding';
import { CATALOG_V3 } from './contract';
import { loadComputeBillingState, paidComputeUnmeteredState } from '../v2/compute-access';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject QA billing deps'); }) }));

const trialStart = new Date('2026-11-05T10:00:00Z');
const trialEnd = new Date('2026-12-05T10:00:00Z');
const nextEnd = new Date('2027-01-05T10:00:00Z');
function subscription(at: Date, firstPaidAt: Date | null = null): SubscriptionRow {
    const inTrial = at < trialEnd;
    return { stripeSubscriptionId: 'sub_trial_qa', sku: 'standard_monthly_v3', status: inTrial ? 'trialing' : 'active',
        currentPeriodStart: inTrial ? trialStart : trialEnd, currentPeriodEnd: inTrial ? trialEnd : nextEnd,
        cancelAtPeriodEnd: false, trialStart, trialEnd, firstPaidAt };
}
function pending(sub: SubscriptionRow, now: Date): boolean {
    const subs = [sub];
    const plan = planFromSubscriptions({ subs, now, userCreatedAt: null });
    const { standing } = deriveStanding({ subscriptions: subs, paymentIssues: [], placementProvider: 'aws-ec2', now });
    return renewalGrantPending(plan, standing, [], now);
}
async function billingState(sub: SubscriptionRow, now: Date, grants: GrantRow[] = [], issues: PaymentIssueRow[] = []) {
    const store = {
        subscriptionsFor: async () => [sub], operatorEntitlementsFor: async () => [], userCreatedAt: async () => null,
        openPlanChanges: async () => [], epochsFor: async () => [],
        grantsForPeriod: async (_user: string, window: { start: Date; end: Date }) => grants.filter(g =>
            g.periodStart !== null && g.periodEnd !== null && g.periodStart < window.end && g.periodEnd > window.start),
        openPaymentIssues: async () => issues, sizePreference: async () => null,
    } as unknown as BillingStore;
    const deps: BillingDeps = { config: readBillingConfig({ BILLING_TAB_ENABLED: '1' }), store,
        stripe: null, usage: null, now: () => now };
    return loadComputeBillingState(deps, 'qa_user', now);
}
const priorPaid = (now: Date): SubscriptionRow => ({ ...subscription(now, new Date('2026-11-05T10:00:00Z')),
    trialStart: new Date('2026-10-05T10:00:00Z'), trialEnd: new Date('2026-11-05T10:00:00Z') });

describe('first paid period after a Standard trial requires payment proof', () => {
    it.each([0, 1, 599, 600])('ends never-paid trial access at trial end + %s seconds without waiting for a failure webhook', async seconds => {
        const now = new Date(trialEnd.getTime() + seconds * 1000);
        const sub = subscription(now);
        expect(deriveStanding({ subscriptions: [sub], paymentIssues: [], placementProvider: 'aws-ec2', now }))
            .toMatchObject({ standing: 'files_on_aws', heldSince: trialEnd.toISOString().replace('.000Z', 'Z') });
        expect(pending(sub, now)).toBe(false);
        const state = await billingState(sub, now);
        expect(state).toMatchObject({ planSku: 'free_v3', provider: 'cloudflare', grantPending: false });
        expect(paidComputeUnmeteredState(state)).toBe(false);
    });
    it('keeps a funded trial usable through its last second without calling it a paid renewal', async () => {
        const now = new Date(trialEnd.getTime() - 1000);
        const sub = subscription(now);
        const trialGrant: GrantRow = { id: 'trial_qa', userId: 'qa_user', subscriptionId: sub.stripeSubscriptionId,
            meter: 'compute_std_seconds', kind: 'trial_period', amount: BigInt(CATALOG_V3.standard_monthly_v3.fairUseSeconds),
            periodStart: trialStart, periodEnd: trialEnd, sourceType: 'trial', sourceId: sub.stripeSubscriptionId, createdAt: trialStart };
        expect(pending(sub, now)).toBe(false);
        const state = await billingState(sub, now, [trialGrant]);
        expect(state).toMatchObject({ planSku: 'standard_monthly_v3', provider: 'aws', grantPending: false });
        expect(paidComputeUnmeteredState(state)).toBe(true);
    });
    it('does not lend paid renewal pending access to an unfunded trial at its start', async () => {
        const now = new Date(trialStart.getTime() + 1000);
        const sub = subscription(now);
        expect(pending(sub, now)).toBe(false);
        expect(paidComputeUnmeteredState(await billingState(sub, now))).toBe(false);
    });
    it.each([0, 1, 599])('preserves genuine previously-paid renewal pending access at +%s seconds', async seconds => {
        const now = new Date(trialEnd.getTime() + seconds * 1000);
        const sub = priorPaid(now);
        expect(pending(sub, now)).toBe(true);
        expect(paidComputeUnmeteredState(await billingState(sub, now))).toBe(true);
    });
    it('preserves the existing 600-second renewal-pending bound for previously paid subscriptions', async () => {
        const now = new Date(trialEnd.getTime() + 600_000);
        const sub = priorPaid(now);
        expect(pending(sub, now)).toBe(false);
        expect(paidComputeUnmeteredState(await billingState(sub, now))).toBe(false);
    });
    it('preserves seven-day renewal grace for a previously paid subscription', async () => {
        const now = new Date(trialEnd.getTime() + 1000);
        const sub = { ...priorPaid(now), status: 'past_due' };
        const issue: PaymentIssueRow = { stripeInvoiceId: 'in_failed_renewal', userId: 'qa_user', subscriptionId: sub.stripeSubscriptionId,
            invoiceKind: 'subscription', issue: 'payment_failed', hostedInvoiceUrl: null, stripeEventCreated: trialEnd,
            resolvedAt: null, updatedAt: now };
        expect(deriveStanding({ subscriptions: [sub], paymentIssues: [issue], placementProvider: 'aws-ec2', now }))
            .toMatchObject({ standing: 'grace', graceEndsAt: '2026-12-12T10:00:00Z' });
        const state = await billingState(sub, now, [], [issue]);
        expect(state.grantPending).toBe(false);
        expect(paidComputeUnmeteredState(state)).toBe(true);
    });
});
