import { describe, expect, it } from 'vitest';
import type { SubscriptionRow } from '../meters';
import { planFromSubscriptions } from './catalog';
import { accessOverrideInEffect, effectiveAccess, type AccessRow } from './effective-access';
import { deriveStanding, effectiveAccessFor, operatorAccessFor, type StandingIssue } from './standing';

// Explicit access overrides: one precedence for every reader. Isolated fixtures (no source-lane store): an override is an
// operator row with `accessOverride: true`; an ordinary grant has none.
const DAY = 86_400_000;
const now = new Date('2026-11-25T12:00:00Z');
const sub = (over: Partial<SubscriptionRow> = {}): SubscriptionRow => ({ stripeSubscriptionId: 'sub_paid', status: 'active', sku: 'premium_monthly_v3',
    currentPeriodStart: new Date('2026-11-10T00:00:00Z'), currentPeriodEnd: new Date('2026-12-10T00:00:00Z'), cancelAtPeriodEnd: false, ...over });
const row = (over: Partial<AccessRow> = {}): AccessRow => ({ ref: 'osg-00000000-0000-4000-8000-0000000000aa', revision: 1, userId: 'user_a',
    accountPublicId: '10000000-0000-4000-8000-0000000000a1', sku: 'standard_monthly_v3', startsAt: new Date(now.getTime() - DAY),
    endsAt: new Date(now.getTime() + 30 * DAY), endedAt: null, ...over });
const override = (over: Partial<AccessRow> = {}) => row({ ref: 'osg-00000000-0000-4000-8000-0000000000bb', accessOverride: true, ...over });
const issue = (daysAgo: number): StandingIssue => ({ subscriptionId: 'sub_paid', invoiceKind: 'subscription', issue: 'payment_failed',
    resolvedAt: null, stripeEventCreated: new Date(now.getTime() - daysAgo * DAY) });
const access = (subscriptions: SubscriptionRow[], grants: AccessRow[], paymentIssues: StandingIssue[] = []) =>
    effectiveAccessFor({ subscriptions, paymentIssues, grants, now });

describe('explicit access override: precedence (override > Stripe paid > ordinary grant > Free)', () => {
    it.each([
        ['Free', 'free_v3'], ['Standard', 'standard_monthly_v3'], ['Premium', 'premium_monthly_v3'],
    ] as const)('a live %s override decides over Stripe paid, Stripe grace, an ordinary grant and nothing', (_name, sku) => {
        const o = override({ sku });
        expect(access([sub()], [o])).toEqual({ source: 'override', row: o });
        expect(access([sub({ status: 'past_due' })], [o], [issue(1)])).toEqual({ source: 'override', row: o });
        expect(access([sub({ cancelAtPeriodEnd: true })], [o, row({ sku: 'premium_monthly_v3' })])).toEqual({ source: 'override', row: o });
        expect(access([], [row(), o])).toEqual({ source: 'override', row: o });
        expect(access([], [o])).toEqual({ source: 'override', row: o });
    });

    it('positive controls: without a live override, Stripe paid access wins over a grant, then the grant, then Free', () => {
        const grant = row({ sku: 'premium_monthly_v3' });
        expect(access([sub()], [grant])).toEqual({ source: 'stripe', row: null });
        expect(access([sub({ status: 'past_due' })], [grant], [issue(1)])).toEqual({ source: 'stripe', row: null });
        expect(access([sub({ status: 'past_due' })], [grant], [issue(8)])).toEqual({ source: 'grant', row: grant });
        expect(access([], [grant])).toEqual({ source: 'grant', row: grant });
        expect(access([], [])).toEqual({ source: 'free', row: null });
        expect(access([sub()], [])).toEqual({ source: 'stripe', row: null });
    });

    it.each([
        ['ended by an operator', { endedAt: new Date(now.getTime() - 1000) }],
        ['past its end', { endsAt: new Date(now.getTime() - 1000) }],
        ['ending exactly now', { endsAt: now }],
        ['not started yet', { startsAt: new Date(now.getTime() + 60_000) }],
    ])('an override %s gives nothing: the paid fallback returns (Stripe, else the grant, else Free)', (_name, over) => {
        const o = override({ sku: 'free_v3', ...over });
        const grant = row({ sku: 'standard_monthly_v3' });
        expect(access([sub()], [o, grant])).toEqual({ source: 'stripe', row: null });
        expect(access([], [o, grant])).toEqual({ source: 'grant', row: grant });
        expect(access([], [o])).toEqual({ source: 'free', row: null });
    });

    it('until revoked is a live override with no end; newest start wins between overrides', () => {
        const older = override({ sku: 'premium_monthly_v3', startsAt: new Date(now.getTime() - 3 * DAY), endsAt: null });
        const newer = override({ ref: 'osg-00000000-0000-4000-8000-0000000000cc', sku: 'free_v3', startsAt: new Date(now.getTime() - DAY), endsAt: null });
        expect(accessOverrideInEffect([older], now)).toBe(older);
        expect(accessOverrideInEffect([older, newer], now)).toBe(newer);
        expect(accessOverrideInEffect([newer, older], now)).toBe(newer);
    });

    it('an override row never decides through the ordinary grant rule (it is not a grant), and an ordinary row is never an override', () => {
        // The source lane narrows operatorGrantInEffect the same way; here the filter is effective-access.ts's own.
        const expired = override({ sku: 'premium_monthly_v3', endsAt: new Date(now.getTime() - 1000) });
        expect(effectiveAccess({ grants: [expired], now, stripePaidAccess: false })).toEqual({ source: 'free', row: null });
        expect(accessOverrideInEffect([row({ accessOverride: false }), row()], now)).toBeNull();
        expect(operatorAccessFor({ subscriptions: [], paymentIssues: [], grants: [], now })).toBeNull();
    });
});

describe('explicit access override: standing and plan', () => {
    it('a Free override is Free over a paying Stripe subscriber: files_on_aws on AWS (held since its start), free on Cloudflare', () => {
        const o = override({ sku: 'free_v3' });
        expect(deriveStanding({ subscriptions: [sub()], paymentIssues: [], placementProvider: 'aws-ec2', now, operator: o }))
            .toEqual({ standing: 'files_on_aws', graceEndsAt: null, planEndsAt: null, filesOn: 'aws', heldSince: '2026-11-24T12:00:00Z' });
        expect(deriveStanding({ subscriptions: [sub()], paymentIssues: [], placementProvider: 'cloudflare', now, operator: o }))
            .toEqual({ standing: 'free', graceEndsAt: null, planEndsAt: null, filesOn: 'cloudflare', heldSince: null });
        // Positive control: the same Stripe row without the override is paid.
        expect(deriveStanding({ subscriptions: [sub()], paymentIssues: [], placementProvider: 'aws-ec2', now }).standing).toBe('paid');
    });

    it('a paid override is paid standing even with no Stripe row or past grace', () => {
        expect(deriveStanding({ subscriptions: [sub({ status: 'unpaid' })], paymentIssues: [], placementProvider: 'aws-ec2', now,
            operator: override({ sku: 'standard_monthly_v3' }) })).toEqual({ standing: 'paid', graceEndsAt: null, planEndsAt: null, filesOn: 'aws', heldSince: null });
    });

    it('the plan follows the override: Free is the Free plan (tagged), never operatorPlan’s paid one; paid overrides take their offer', () => {
        const free = planFromSubscriptions({ subs: [sub()], now, userCreatedAt: null, operator: override({ sku: 'free_v3' }) });
        expect(free).toMatchObject({ sku: 'free_v3', family: 'free', subscriptionId: null, renewsAt: null, offer: { provider: 'cloudflare' },
            operator: { accessOverride: true, sku: 'free_v3' } });
        expect(free.window).toEqual(planFromSubscriptions({ subs: [], now, userCreatedAt: null }).window);
        const standard = planFromSubscriptions({ subs: [sub()], now, userCreatedAt: null, operator: override({ sku: 'standard_monthly_v3' }) });
        expect(standard).toMatchObject({ sku: 'standard_monthly_v3', family: 'standard', status: 'active', subscriptionId: null, offer: { provider: 'aws' } });
        const premium = planFromSubscriptions({ subs: [], now, userCreatedAt: null, operator: override({ sku: 'premium_monthly_v3' }) });
        expect(premium).toMatchObject({ sku: 'premium_monthly_v3', family: 'compute', status: 'active' });
        // Positive control: the Stripe-only plan of the same account.
        expect(planFromSubscriptions({ subs: [sub()], now, userCreatedAt: null })).toMatchObject({ sku: 'premium_monthly_v3', subscriptionId: 'sub_paid' });
    });
});
