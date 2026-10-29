import { describe, expect, it } from 'vitest';
import type { SubscriptionRow } from '../meters';
import { deriveStanding, PAYMENT_GRACE_SECONDS, paidAccess, type StandingIssue } from './standing';

const start = new Date('2026-10-10T00:00:00Z'), end = new Date('2026-11-10T00:00:00Z');
const now = new Date('2026-10-19T12:00:00Z');
const sub = (overrides: Partial<SubscriptionRow> = {}): SubscriptionRow => ({ stripeSubscriptionId: 'sub', status: 'active',
    sku: 'standard_monthly_v3', currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false, ...overrides });
const issue = (eventCreated: Date, overrides: Partial<StandingIssue> = {}): StandingIssue => ({ subscriptionId: 'sub',
    invoiceKind: 'subscription', issue: 'payment_failed', resolvedAt: null, stripeEventCreated: eventCreated, ...overrides });
const daysBefore = (days: number, seconds = 0) => new Date(now.getTime() - days * 86_400_000 - seconds * 1000);
const standing = (subscriptions: SubscriptionRow[], paymentIssues: StandingIssue[] = [], placementProvider: 'aws-ec2' | 'cloudflare' | null = 'aws-ec2', at = now) =>
    deriveStanding({ subscriptions, paymentIssues, placementProvider, now: at });

describe('deriveStanding (D16-D19)', () => {
    it('paid: a current period with no issue', () => {
        expect(standing([sub()])).toEqual({ standing: 'paid', graceEndsAt: null, planEndsAt: null, filesOn: 'aws', heldSince: null });
        expect(standing([sub({ sku: 'premium_monthly_v3', status: 'trialing' })], [], 'cloudflare')).toMatchObject({ standing: 'paid', filesOn: 'cloudflare' });
    });

    it('free / files_on_aws with no subscription follows the placement', () => {
        expect(standing([], [], null)).toEqual({ standing: 'free', graceEndsAt: null, planEndsAt: null, filesOn: 'cloudflare', heldSince: null });
        expect(standing([], [], 'cloudflare')).toMatchObject({ standing: 'free', filesOn: 'cloudflare' });
        expect(standing([], [], 'aws-ec2')).toMatchObject({ standing: 'files_on_aws', filesOn: 'aws', heldSince: null });
    });

    it('D18: an immediate cancel (canceled, period end still in the future) drops to Free now; heldSince is not recorded', () => {
        // The founder's rows: three canceled subs, cancel_at_period_end=false, periods ending 11-26/11-27.
        const founder = [sub({ status: 'canceled', sku: 'premium_monthly_v3', stripeSubscriptionId: 'a' }),
            sub({ status: 'canceled', stripeSubscriptionId: 'b' }), sub({ status: 'canceled', stripeSubscriptionId: 'c' })];
        expect(standing(founder)).toEqual({ standing: 'files_on_aws', graceEndsAt: null, planEndsAt: null, filesOn: 'aws', heldSince: null });
        expect(standing(founder, [], 'cloudflare').standing).toBe('free');
    });

    it('D18: a dunning cancel (raw unpaid) drops at once, even with a fresh issue row', () => {
        expect(standing([sub({ status: 'unpaid' })], [issue(daysBefore(1))])).toMatchObject({ standing: 'files_on_aws', graceEndsAt: null });
        expect(standing([sub({ status: 'unpaid' })], [], 'cloudflare').standing).toBe('free');
    });

    it('D18: cancel_at_period_end stays paid until the period end (plan_ending), then Free from that end', () => {
        expect(standing([sub({ cancelAtPeriodEnd: true })])).toEqual({ standing: 'plan_ending', graceEndsAt: null,
            planEndsAt: '2026-11-10T00:00:00Z', filesOn: 'aws', heldSince: null });
        const after = new Date('2026-11-10T00:00:00Z');
        expect(standing([sub({ cancelAtPeriodEnd: true })], [], 'aws-ec2', after)).toMatchObject({ standing: 'files_on_aws', heldSince: '2026-11-10T00:00:00Z' });
        expect(standing([sub({ cancelAtPeriodEnd: true })], [], 'cloudflare', after)).toMatchObject({ standing: 'free', heldSince: null });
        // canceled with a past period end: Free since that end.
        expect(standing([sub({ status: 'canceled' })], [], 'aws-ec2', after)).toMatchObject({ standing: 'files_on_aws', heldSince: '2026-11-10T00:00:00Z' });
    });

    it('D17: past_due is grace for 7 days from the first unresolved issue (day 6 in, day 7 out)', () => {
        const first = daysBefore(6, 23 * 3600 + 59 * 60);
        const issues = [issue(first), issue(daysBefore(2))];
        const ends = new Date(first.getTime() + PAYMENT_GRACE_SECONDS * 1000).toISOString().replace('.000Z', 'Z');
        expect(standing([sub({ status: 'past_due' })], issues)).toEqual({ standing: 'grace', graceEndsAt: ends, planEndsAt: null, filesOn: 'aws', heldSince: null });
        // Exactly 7 days after the first issue: over.
        expect(standing([sub({ status: 'past_due' })], [issue(daysBefore(7))])).toMatchObject({ standing: 'files_on_aws', heldSince: '2026-10-19T12:00:00Z' });
        expect(standing([sub({ status: 'past_due' })], [issue(daysBefore(8))], 'cloudflare')).toMatchObject({ standing: 'free', heldSince: null });
    });

    it('D17: an unresolved issue on an active subscription is grace too; requires_action counts', () => {
        expect(standing([sub()], [issue(daysBefore(1), { issue: 'requires_action' })])).toMatchObject({ standing: 'grace' });
        expect(standing([sub()], [issue(daysBefore(7, 1))])).toMatchObject({ standing: 'files_on_aws' });
    });

    it('D17: ignores resolved, voided, upgrade, overage and other-subscription issues', () => {
        for (const ignored of [issue(daysBefore(9), { resolvedAt: daysBefore(8) }), issue(daysBefore(9), { issue: 'voided' }),
            issue(daysBefore(9), { invoiceKind: 'upgrade' }), issue(daysBefore(9), { invoiceKind: 'overage' }), issue(daysBefore(9), { subscriptionId: 'other' })]) {
            expect(standing([sub()], [ignored]).standing).toBe('paid');
        }
    });

    it("D17: Stripe's final action (an uncollectible invoice) ends grace early", () => {
        expect(standing([sub({ status: 'past_due' })], [issue(daysBefore(3)), issue(daysBefore(1), { issue: 'uncollectible' })]))
            .toMatchObject({ standing: 'files_on_aws', heldSince: daysBefore(1).toISOString().replace('.000Z', 'Z') });
        const later = new Date(now.getTime() + 3600_000);
        expect(standing([sub({ status: 'past_due' })], [issue(daysBefore(3)), issue(later, { issue: 'uncollectible' })]))
            .toMatchObject({ standing: 'grace', graceEndsAt: later.toISOString().replace('.000Z', 'Z') });
    });

    it('D17: past_due with no issue row anchors on the period start', () => {
        expect(standing([sub({ status: 'past_due', currentPeriodStart: daysBefore(2) })])).toMatchObject({ standing: 'grace' });
        expect(standing([sub({ status: 'past_due', currentPeriodStart: daysBefore(7) })])).toMatchObject({ standing: 'files_on_aws' });
        expect(standing([sub({ status: 'past_due', currentPeriodStart: null })])).toMatchObject({ standing: 'files_on_aws', heldSince: null });
    });

    it('grace keeps the cancel date of a cancel_at_period_end subscription', () => {
        expect(standing([sub({ status: 'past_due', cancelAtPeriodEnd: true })], [issue(daysBefore(1))]))
            .toMatchObject({ standing: 'grace', planEndsAt: '2026-11-10T00:00:00Z' });
    });

    it('incomplete (never paid) gets no grace', () => {
        expect(standing([sub({ status: 'incomplete' })], [issue(daysBefore(0))]).standing).toBe('files_on_aws');
        expect(standing([sub({ status: 'incomplete' })], [], null).standing).toBe('free');
    });

    it('a current paid period beats a stale delinquent or canceled row', () => {
        expect(standing([sub({ stripeSubscriptionId: 'old', status: 'unpaid', currentPeriodEnd: new Date('2026-12-01T00:00:00Z') }),
            sub({ stripeSubscriptionId: 'sub' })]).standing).toBe('paid');
        expect(standing([sub({ stripeSubscriptionId: 'old', status: 'canceled' }), sub()]).standing).toBe('paid');
    });

    it('D19: a refund is a grant reversal, not a status; the standing stays paid', () => {
        expect(standing([sub()], []).standing).toBe('paid');
    });

    it('paidAccess covers paid, grace and plan_ending only', () => {
        expect((['paid', 'grace', 'plan_ending', 'files_on_aws', 'free'] as const).map(paidAccess)).toEqual([true, true, true, false, false]);
    });
});
