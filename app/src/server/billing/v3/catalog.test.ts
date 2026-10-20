import { describe, expect, it } from 'vitest';
import type { SubscriptionRow } from '../meters';
import { offerByLookupKey, offerBySku, planFromSubscriptions, publicOffers, upgradeGrantSeconds } from './catalog';

const now = new Date('2026-10-19T12:00:00Z');
const sub = (sku: string, status = 'active'): SubscriptionRow => ({ sku, status, stripeSubscriptionId: sku,
    currentPeriodStart: new Date('2026-10-10Z'), currentPeriodEnd: new Date('2026-11-10Z'), cancelAtPeriodEnd: false });

describe('v3 catalog', () => {
    it.each([['2026-10-01T00:00:00Z', 1656000], ['2026-10-11T00:00:00Z', 828000],
        ['2026-10-21T00:00:00Z', 0], ['2026-10-22T00:00:00Z', 0], ['2026-09-30T00:00:00Z', 1656000]])(
        'prorates only the 460-hour difference at %s', (effectiveAt, expected) => {
            expect(upgradeGrantSeconds({ periodStart: '2026-10-01T00:00:00Z', periodEnd: '2026-10-21T00:00:00Z', effectiveAt })).toBe(expected);
        });

    it('publishes only Free, Standard $20, Premium $100 with machine choice', () => {
        expect(publicOffers().map(({ name, priceCents }) => [name, priceCents])).toEqual([['Free', 0], ['Standard', 2000], ['Premium', 10000]]);
        expect(publicOffers()[2]).toMatchObject({ highlighted: true, badge: null, fairUseHours: 500, machineChoice: ['std-2', 'cmp-4', 'cmp-8'], vcpu: 2, memoryGiB: 8 });
        expect(offerByLookupKey('ezil_standard_monthly_v3')?.sku).toBe('standard_monthly_v3');
        expect(offerByLookupKey('ezil_premium_monthly_v3')?.sku).toBe('premium_monthly_v3');
        for (const key of ['toString', '__proto__', 'compute_monthly_v2', 'unknown']) expect(offerBySku(key)).toBeUndefined();
        expect(offerByLookupKey('ezil_compute_monthly_v2')).toBeUndefined();
    });
    it.each(['standard_monthly_v3', 'premium_monthly_v3'])('resolves paid %s with its period', sku => {
        expect(planFromSubscriptions({ subs: [sub(sku)], now, userCreatedAt: null })).toMatchObject({ sku, planActive: true,
            window: { start: '2026-10-10T00:00:00Z', end: '2026-11-10T00:00:00Z' } });
    });
    it.each([['standard_monthly_v2', 216000], ['compute_monthly_v2', 1800000], ['pro_monthly_v1', 72000]])
    ('keeps %s legacy terms', (sku, allowanceStdSeconds) => {
        expect(planFromSubscriptions({ subs: [sub(String(sku))], now, userCreatedAt: null })).toMatchObject({ sku: 'legacy',
            offer: { sku, allowanceStdSeconds }, sessionMaxSeconds: 21600 });
    });
    it('current legacy paid periods win over delinquent v3 and expired v3 falls back to Free', () => {
        expect(planFromSubscriptions({ subs: [sub('standard_monthly_v2'), sub('premium_monthly_v3', 'past_due')], now, userCreatedAt: null }).sku).toBe('legacy');
        expect(planFromSubscriptions({ subs: [sub('premium_monthly_v3', 'canceled')], now, userCreatedAt: null })).toMatchObject({ sku: 'free_v3', legacyFree: true,
            window: { start: '2026-10-01T00:00:00Z', end: '2026-11-01T00:00:00Z' } });
    });
    it.each([[null, true], ['2026-10-20T00:00:00Z', true], ['2026-10-19T12:00:00Z', false]])
    ('applies Free effective date %s', (freeEffectiveAt, legacyFree) => {
        expect(planFromSubscriptions({ subs: [], now, userCreatedAt: now, freeEffectiveAt }).legacyFree).toBe(legacyFree);
    });
});
