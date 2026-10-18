import { describe, expect, it } from 'vitest';

import type { SubscriptionRow } from '../meters';
import { freeSkuFor, offerByLookupKey, offerBySku, planFromSubscriptions, planStatusFromStripe } from './catalog';
import { CATALOG_V2, FREE_V2_EFFECTIVE_AT, type PlanSku } from './contract';

const NOW = new Date('2026-11-10T09:00:00.789Z');
const START = '2026-11-03T12:00:00Z';
const END = '2026-12-03T12:00:00Z';
const MONTH = { start: '2026-11-01T00:00:00Z', end: '2026-12-01T00:00:00Z' };

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
    return {
        stripeSubscriptionId: 'sub-standard', status: 'active', sku: 'standard_monthly_v2',
        currentPeriodStart: new Date(START), currentPeriodEnd: new Date(END), cancelAtPeriodEnd: false,
        ...overrides,
    };
}

function resolve(subs: SubscriptionRow[], options: Partial<Parameters<typeof planFromSubscriptions>[0]> = {}) {
    return planFromSubscriptions({ subs, now: NOW, userCreatedAt: null, ...options });
}

function expectedFree(sku: PlanSku = 'free_v1_legacy') {
    return {
        sku, offer: CATALOG_V2[sku], family: 'free', status: 'free', planActive: true,
        subscriptionId: null, window: MONTH, renewsAt: null, cancelsAt: null,
    };
}

describe('v2 catalog lookups', () => {
    it.each(Object.values(CATALOG_V2))('looks up $sku without changing the offer', offer => {
        expect(offerBySku(offer.sku)).toBe(offer);
        if (offer.stripeLookupKey !== null) expect(offerByLookupKey(offer.stripeLookupKey)).toBe(offer);
    });

    it.each(['unknown', '', 'pro', 'toString', '__proto__', 'constructor'])('ignores unknown SKU %s', sku => {
        expect(offerBySku(sku)).toBeUndefined();
    });

    it.each(['unknown', '', 'ezil_compute_overage_v2', 'pro_monthly_v1', 'null', 'standard_monthly_v2'])(
        'does not resolve non-offer lookup key %s', key => {
            expect(offerByLookupKey(key)).toBeUndefined();
        },
    );
});

describe('Free release policy', () => {
    it('keeps everyone on legacy Free while the pinned effective date is null', () => {
        expect(FREE_V2_EFFECTIVE_AT).toBeNull();
        for (const created of [null, '2020-01-01T00:00:00Z', '2099-01-01T00:00:00Z', NOW, 'invalid']) {
            expect(freeSkuFor(created)).toBe('free_v1_legacy');
            expect(freeSkuFor(created, null)).toBe('free_v1_legacy');
        }
    });

    const effective = '2026-11-01T00:00:00Z';
    it.each([
        { created: '2026-10-31T23:59:59.999Z', expected: 'free_v1_legacy' },
        { created: effective, expected: 'free_v2' },
        { created: '2026-11-01T00:00:00.001Z', expected: 'free_v2' },
        { created: new Date(effective), expected: 'free_v2' },
        { created: '2026-10-31T20:00:00-04:00', expected: 'free_v2' },
        { created: null, expected: 'free_v1_legacy' },
        { created: '', expected: 'free_v1_legacy' },
        { created: 'invalid', expected: 'free_v1_legacy' },
        { created: new Date(NaN), expected: 'free_v1_legacy' },
    ])('created=$created selects $expected at an explicit effective date', ({ created, expected }) => {
        expect(freeSkuFor(created, effective)).toBe(expected);
    });

    it('does not activate the new policy with an invalid effective date', () => {
        expect(freeSkuFor(NOW, 'invalid')).toBe('free_v1_legacy');
    });
});

describe('Stripe status mapping', () => {
    it.each(['active', 'trialing'])('maps %s and cancellation independently', status => {
        expect(planStatusFromStripe(status)).toBe('active');
        expect(planStatusFromStripe(status, true)).toBe('cancels');
    });

    it.each([
        ['past_due', 'past_due'], ['unpaid', 'past_due'], ['incomplete', 'incomplete'],
        ['canceled', null], ['incomplete_expired', null], ['paused', null], ['unknown', null], ['', null],
    ])('maps %s to %s', (status, expected) => {
        expect(planStatusFromStripe(status!)).toBe(expected);
        expect(planStatusFromStripe(status!, true)).toBe(expected);
    });
});

describe('planFromSubscriptions', () => {
    it('returns legacy Free and a whole-second UTC calendar window without subscriptions', () => {
        expect(resolve([])).toEqual(expectedFree());
    });

    it.each([
        ['2026-12-31T23:59:59.999Z', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'],
        ['2028-02-29T18:00:00Z', '2028-02-01T00:00:00Z', '2028-03-01T00:00:00Z'],
        ['2026-11-30T23:30:00-02:00', '2026-12-01T00:00:00Z', '2027-01-01T00:00:00Z'],
    ])('uses the UTC month containing %s', (now, start, end) => {
        expect(resolve([], { now: new Date(now) }).window).toEqual({ start, end });
    });

    it('uses the explicit Free release date only for known eligible accounts', () => {
        const options = { freeEffectiveAt: '2026-11-01T00:00:00Z', userCreatedAt: NOW };
        expect(resolve([], options)).toEqual(expectedFree('free_v2'));
        expect(resolve([], { ...options, userCreatedAt: null })).toEqual(expectedFree());
    });

    it.each(['active', 'trialing'])('resolves a current %s Standard subscription', status => {
        expect(resolve([subscription({ status })])).toEqual({
            sku: 'standard_monthly_v2', offer: CATALOG_V2.standard_monthly_v2,
            family: 'standard', status: 'active', planActive: true, subscriptionId: 'sub-standard',
            window: { start: START, end: END }, renewsAt: END, cancelsAt: null,
        });
    });

    it('preserves Compute until its cancellation at period end', () => {
        expect(resolve([subscription({ sku: 'compute_monthly_v2', cancelAtPeriodEnd: true })])).toEqual({
            sku: 'compute_monthly_v2', offer: CATALOG_V2.compute_monthly_v2,
            family: 'compute', status: 'cancels', planActive: true, subscriptionId: 'sub-standard',
            window: { start: START, end: END }, renewsAt: null, cancelsAt: END,
        });
    });

    it('honours the sold legacy Pro SKU without treating it as a v2 plan', () => {
        expect(resolve([subscription({ sku: 'pro_monthly_v1' })])).toEqual({
            sku: 'pro_monthly_v1', offer: CATALOG_V2.pro_monthly_v1,
            family: 'pro_legacy', status: 'active', planActive: true, subscriptionId: 'sub-standard',
            window: { start: START, end: END }, renewsAt: END, cancelsAt: null,
        });
    });

    it.each(['unknown', 'pro', '__proto__', 'free_v2'])('ignores non-paid or unknown subscription SKU %s', sku => {
        expect(resolve([subscription({ sku })])).toEqual(expectedFree());
    });

    it.each([
        { status: 'past_due', expected: 'past_due' },
        { status: 'unpaid', expected: 'past_due' },
        { status: 'incomplete', expected: 'incomplete' },
    ])('keeps the paid family for $status while refusing paid compute', ({ status, expected }) => {
        expect(resolve([subscription({ sku: 'compute_monthly_v2', status })])).toEqual({
            sku: 'compute_monthly_v2', offer: CATALOG_V2.compute_monthly_v2,
            family: 'compute', status: expected, planActive: false, subscriptionId: 'sub-standard',
            window: { start: START, end: END }, renewsAt: END, cancelsAt: null,
        });
    });

    it('keeps an incomplete paid identity when Stripe has not supplied period dates', () => {
        expect(resolve([subscription({ status: 'incomplete', currentPeriodStart: null, currentPeriodEnd: null })]))
            .toEqual({
                sku: 'standard_monthly_v2', offer: CATALOG_V2.standard_monthly_v2,
                family: 'standard', status: 'incomplete', planActive: false, subscriptionId: 'sub-standard',
                window: MONTH, renewsAt: null, cancelsAt: null,
            });
    });

    it.each(['canceled', 'incomplete_expired', 'paused', 'unknown'])('ignores non-current status %s', status => {
        expect(resolve([subscription({ status })])).toEqual(expectedFree());
    });

    it('uses a half-open paid period, ignoring expired and future active periods', () => {
        const subs = [subscription()];
        expect(resolve(subs, { now: new Date(START) }).planActive).toBe(true);
        expect(resolve(subs, { now: new Date(Date.parse(END) - 1) }).sku).toBe('standard_monthly_v2');
        expect(resolve(subs, { now: new Date(END) }).sku).toBe('free_v1_legacy');
        expect(resolve(subs, { now: new Date(Date.parse(START) - 1) }).sku).toBe('free_v1_legacy');
        expect(resolve([subscription({ currentPeriodEnd: new Date('2026-11-09T00:00:00Z') })]))
            .toEqual(expectedFree());
    });

    it('ignores active rows without usable period boundaries', () => {
        for (const overrides of [
            { currentPeriodStart: null }, { currentPeriodEnd: null },
            { currentPeriodStart: new Date(NaN) }, { currentPeriodEnd: new Date(NaN) },
        ]) expect(resolve([subscription(overrides)])).toEqual(expectedFree());
    });

    it('picks the latest current period end without reordering or mutating subscription rows', () => {
        const earlier = Object.freeze(subscription());
        const later = Object.freeze(subscription({
            sku: 'compute_monthly_v2', stripeSubscriptionId: 'sub-compute',
            currentPeriodEnd: new Date('2026-12-05T00:00:00Z'),
        }));
        const subs = [later, earlier];
        Object.freeze(subs);
        expect(resolve(subs).subscriptionId).toBe('sub-compute');
        expect(resolve([earlier, later]).subscriptionId).toBe('sub-compute');
        expect(subs).toEqual([later, earlier]);
    });

    it('prefers a current subscription over a delinquent row with a later end', () => {
        const current = subscription();
        const delinquent = subscription({
            sku: 'compute_monthly_v2', status: 'past_due', currentPeriodEnd: new Date('2026-12-20T00:00:00Z'),
        });
        expect(resolve([current, delinquent])).toEqual(resolve([current]));
        expect(resolve([delinquent, current])).toEqual(resolve([current]));
    });

    it('picks the latest period end among delinquent subscriptions when none is current', () => {
        const earlier = subscription({ status: 'unpaid' });
        const later = subscription({
            sku: 'compute_monthly_v2', status: 'incomplete', currentPeriodEnd: new Date('2026-12-20T00:00:00Z'),
        });
        expect(resolve([earlier, later])).toEqual(resolve([later]));
        expect(resolve([later, earlier])).toEqual(resolve([later]));
    });

    it('marks a current upgrade pending without resetting its offer, period or active allowance', () => {
        const pendingUpgrade = {
            toSku: 'compute_monthly_v2' as const, expiresAt: '2026-11-11T00:00:00Z', hostedInvoiceUrl: null,
        };
        const subs = [subscription()];
        expect(resolve(subs, { pendingUpgrade })).toEqual({ ...resolve(subs), status: 'upgrade_pending' });
        const cancelling = [subscription({ cancelAtPeriodEnd: true })];
        expect(resolve(cancelling, { pendingUpgrade })).toEqual({ ...resolve(cancelling), status: 'upgrade_pending' });
        const delinquent = [subscription({ status: 'past_due' })];
        expect(resolve(delinquent, { pendingUpgrade })).toEqual(resolve(delinquent));
        expect(resolve([], { pendingUpgrade })).toEqual(expectedFree());
    });

    it('emits every period, renewal and cancellation instant without milliseconds', () => {
        const sub = subscription({
            currentPeriodStart: new Date('2026-11-03T12:00:00.123Z'),
            currentPeriodEnd: new Date('2026-12-03T12:00:00.999Z'),
        });
        const active = resolve([sub]);
        expect(active.window).toEqual({ start: START, end: END });
        expect(active.renewsAt).toBe(END);
        expect(resolve([{ ...sub, cancelAtPeriodEnd: true }]).cancelsAt).toBe(END);
    });
});
