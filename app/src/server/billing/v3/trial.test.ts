import { describe, expect, it } from 'vitest';

import {
    addCalendarMonthUtc, authSubjectFor, normalizeEmail, parseTrialEntitlement, quoteFresh, trialEligibility, trialEntitlement,
    trialTerms, TRIAL_QUOTE_TTL_SECONDS, type TrialFacts, type TrialRow,
} from './trial';

const at = (iso: string) => new Date(iso);

describe('one calendar month (UTC, month-end clamped, whole seconds)', () => {
    it.each([
        ['2026-11-05T10:00:00.000Z', '2026-12-05T10:00:00.000Z'],
        ['2026-01-31T23:59:59.000Z', '2026-02-28T23:59:59.000Z'],
        ['2028-01-31T08:00:00.000Z', '2028-02-29T08:00:00.000Z'],
        ['2028-02-29T08:00:00.000Z', '2028-03-29T08:00:00.000Z'],
        ['2026-03-31T00:00:00.000Z', '2026-04-30T00:00:00.000Z'],
        ['2026-12-31T12:34:56.000Z', '2027-01-31T12:34:56.000Z'],
        ['2026-08-31T21:30:00.000Z', '2026-09-30T21:30:00.000Z'],
    ])('%s ends %s', (start, end) => {
        expect(addCalendarMonthUtc(at(start)).toISOString()).toBe(end);
    });

    it('drops milliseconds before the arithmetic, so the end is a Stripe second', () => {
        expect(addCalendarMonthUtc(at('2026-11-05T10:00:00.999Z')).toISOString()).toBe('2026-12-05T10:00:00.000Z');
    });

    it('is the same instant whatever the process time zone (the arithmetic never reads local fields)', () => {
        const original = process.env.TZ;
        try {
            for (const zone of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles', 'Pacific/Kiritimati']) {
                process.env.TZ = zone;
                expect(addCalendarMonthUtc(at('2026-01-31T20:00:00.000Z')).toISOString()).toBe('2026-02-28T20:00:00.000Z');
            }
        } finally {
            process.env.TZ = original;
        }
    });

    it('quotes $0 today and the Standard price at the end', () => {
        expect(trialTerms(at('2026-11-04T21:08:25.400Z'))).toEqual({ quotedAt: at('2026-11-04T21:08:25.000Z'),
            trialEnd: at('2026-12-04T21:08:25.000Z'), amountCents: 2000, currency: 'usd' });
    });

    it('a quote opens checkout for 30 minutes only, never from the future', () => {
        const row = { quotedAt: at('2026-11-05T10:00:00Z') };
        expect(quoteFresh(row, at('2026-11-05T10:00:00Z'))).toBe(true);
        expect(quoteFresh(row, new Date(row.quotedAt.getTime() + TRIAL_QUOTE_TTL_SECONDS * 1000))).toBe(true);
        expect(quoteFresh(row, new Date(row.quotedAt.getTime() + TRIAL_QUOTE_TTL_SECONDS * 1000 + 1))).toBe(false);
        expect(quoteFresh(row, at('2026-11-05T09:59:59Z'))).toBe(false);
    });
});

describe('the person key', () => {
    it.each([
        ['  Alice@Example.COM ', 'alice@example.com'],
        ['alice+trial2@example.com', 'alice@example.com'],
        ['A.l.i.c.e+x@gmail.com', 'alice@gmail.com'],
        ['alice@googlemail.com', 'alice@gmail.com'],
        ['a.lice@example.com', 'a.lice@example.com'],
    ])('%s → %s', (email, key) => expect(normalizeEmail(email)).toBe(key));

    it.each([null, undefined, '', 'nobody', 'a@b', 'a b@example.com', '+tag@example.com', 'two@@example.com'])('refuses %s', email => {
        expect(normalizeEmail(email as string | null)).toBeNull();
    });

    it('prefers the linked Auth0 subject, else the Supabase account', () => {
        expect(authSubjectFor('u1', 'auth0|abc')).toBe('auth0:auth0|abc');
        expect(authSubjectFor('u1', '  ')).toBe('supabase:u1');
        expect(authSubjectFor('u1', null)).toBe('supabase:u1');
    });
});

describe('the trial AI root', () => {
    const trialStart = at('2026-11-05T10:00:00.000Z');
    const trialEnd = at('2026-12-05T10:00:00.000Z');

    it('is distinct from the paid period root, carries the Standard credits and expires at the trial end exactly', () => {
        const root = trialEntitlement({ subscriptionId: 'sub_T1', trialStart, trialEnd });
        expect(root).toEqual({ entitlementId: 'ezil-os:v1:standard_monthly_v3:sub_T1:2026-11-05T10:00:00.000Z:trial',
            credits: 200, expiresAt: '2026-12-05T10:00:00.000Z' });
        expect(root.entitlementId).not.toBe(`ezil-os:v1:standard_monthly_v3:sub_T1:${trialStart.toISOString()}`);
        expect(parseTrialEntitlement(root.entitlementId)).toEqual({ subscriptionId: 'sub_T1', trialStart });
    });

    it.each([
        ['ezil-os:v1:standard_monthly_v3:sub_T1:2026-11-05T10:00:00.000Z'],
        ['ezil-os:v1:premium_monthly_v3:sub_T1:2026-11-05T10:00:00.000Z:trial'],
        ['ezil-os:v1:standard_monthly_v3:sub_T1:2026-02-30T10:00:00.000Z:trial'],
    ])('parses nothing else: %s', id => expect(parseTrialEntitlement(id)).toBeNull());

    it('refuses invalid inputs', () => {
        expect(() => trialEntitlement({ subscriptionId: 'cus_x', trialStart, trialEnd })).toThrow();
        expect(() => trialEntitlement({ subscriptionId: 'sub_x', trialStart: trialEnd, trialEnd: trialStart })).toThrow();
    });
});

describe('eligibility from server facts', () => {
    const own = (status: TrialRow['status']): TrialRow => ({ id: 't1', userId: 'u1', authSubject: 'supabase:u1', emailNormalized: 'a@x.io',
        sku: 'standard_monthly_v3', policyVersion: 1, status, quotedAt: at('2026-11-05T10:00:00Z'), trialEnd: at('2026-12-05T10:00:00Z'),
        checkoutSessionId: null, stripeCustomerId: null, stripeSubscriptionId: status === 'quoted' || status === 'checkout' ? null : 'sub_1', trialStart: null });
    const facts = (patch: Partial<TrialFacts> = {}): TrialFacts => ({ emailNormalized: 'a@x.io', emailVerified: true, authSubject: 'supabase:u1',
        own: null, claimedElsewhere: false, paidBefore: false, ...patch });
    const decide = (patch: Partial<TrialFacts> = {}, planFamily = 'free', operatorPlan = false) =>
        trialEligibility({ facts: facts(patch), planFamily, operatorPlan });

    it('a verified Free person with no history is eligible; an abandoned own quote or checkout stays eligible', () => {
        expect(decide()).toEqual({ eligible: true });
        expect(decide({ own: own('quoted') })).toEqual({ eligible: true });
        expect(decide({ own: own('checkout') })).toEqual({ eligible: true });
    });

    it.each([
        [{}, 'standard', false, 'not_free'],
        [{}, 'free', true, 'operator_plan'],
        [{ emailNormalized: null }, 'free', false, 'no_email'],
        [{ emailVerified: false }, 'free', false, 'email_unverified'],
        [{ own: own('trialing') }, 'free', false, 'trial_used'],
        [{ own: own('canceled') }, 'free', false, 'trial_used'],
        [{ own: own('ended') }, 'free', false, 'trial_used'],
        [{ own: own('payment_failed') }, 'free', false, 'trial_used'],
        [{ own: own('converted') }, 'free', false, 'trial_used'],
        [{ claimedElsewhere: true }, 'free', false, 'trial_used'],
        [{ paidBefore: true }, 'free', false, 'paid_before'],
    ] as const)('refuses %o on %s (operator %s) as %s', (patch, family, operatorPlan, reason) => {
        expect(decide(patch as Partial<TrialFacts>, family, operatorPlan)).toEqual({ eligible: false, reason });
    });
});
