/** Stripe-controlled trial campaigns: strict metadata, exact provider terms, fail-closed selection and a full-terms fingerprint. */
import { describe, expect, it } from 'vitest';
import { normalizePromoterCode, parseTrialCampaigns, selectTrialOffer, trialOfferFingerprint, trialProductTerms } from './trial-campaigns';
import { CAMPAIGNS_ON, STANDARD_PRICE_ID, STANDARD_PRODUCT_ID, standardTrialRead } from './trial-campaigns.test-support';

const NOW = new Date('2026-11-14T12:00:00.000Z');
const ids = { productId: STANDARD_PRODUCT_ID, priceId: STANDARD_PRICE_ID };
const campaigns = (value: unknown) => JSON.stringify(value);

describe('parseTrialCampaigns', () => {
    it('reads the reviewed shape, and an absent key is the legacy public offer', () => {
        expect(parseTrialCampaigns(CAMPAIGNS_ON)).toEqual({ publicEnabled: true, promoters: { midhun: { enabled: true, expiresAt: null } } });
        expect(parseTrialCampaigns(campaigns({ version: 1, publicEnabled: false, promoters: { midhun: { enabled: true, expiresAt: '2026-12-31T00:00:00.000Z' } } })))
            .toEqual({ publicEnabled: false, promoters: { midhun: { enabled: true, expiresAt: '2026-12-31T00:00:00.000Z' } } });
        expect(parseTrialCampaigns(undefined)).toEqual({ publicEnabled: true, promoters: {} });
        expect(parseTrialCampaigns(null)).toEqual({ publicEnabled: true, promoters: {} });
    });

    it.each([
        ['not JSON', '{"version":1'],
        ['an array', '[]'],
        ['version 2', campaigns({ version: 2, publicEnabled: true, promoters: {} })],
        ['a string publicEnabled', campaigns({ version: 1, publicEnabled: 'true', promoters: {} })],
        ['no promoters', campaigns({ version: 1, publicEnabled: true })],
        ['an unknown top-level field', campaigns({ version: 1, publicEnabled: true, promoters: {}, discountPercent: 100 })],
        ['an unknown promoter field', campaigns({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: true, percentOff: 100 } } })],
        ['an upper-case promoter code', campaigns({ version: 1, publicEnabled: true, promoters: { Midhun: { enabled: true } } })],
        ['a non-boolean enabled', campaigns({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: 1 } } })],
        ['a non-canonical expiry', campaigns({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: true, expiresAt: '2026-12-31' } } })],
        ['month 13 (never throws)', campaigns({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: true, expiresAt: '2026-13-01T00:00:00.000Z' } } })],
        ['31 February', campaigns({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: true, expiresAt: '2026-02-31T00:00:00.000Z' } } })],
        ['over 500 UTF-8 bytes', campaigns({ version: 1, publicEnabled: true, promoters: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`promoter-${i}`, { enabled: true }])) })],
    ])('treats %s as malformed (null)', (_name, raw) => {
        expect(() => parseTrialCampaigns(raw)).not.toThrow();
        expect(parseTrialCampaigns(raw)).toBeNull();
    });

    it('accepts exactly 500 UTF-8 bytes and refuses 501', () => {
        const pad = (bytes: number) => CAMPAIGNS_ON.replace(/}$/, ' '.repeat(bytes - Buffer.byteLength(CAMPAIGNS_ON)) + '}');
        expect(Buffer.byteLength(pad(500))).toBe(500);
        expect(parseTrialCampaigns(pad(500))).toMatchObject({ publicEnabled: true });
        expect(parseTrialCampaigns(pad(501))).toBeNull();
    });
});

describe('trialProductTerms', () => {
    it('accepts exactly one active USD 2000 monthly price on an active Product', () => {
        expect(trialProductTerms(standardTrialRead(CAMPAIGNS_ON))).toMatchObject({ ...ids, unitAmount: 2000, currency: 'usd', interval: 'month', intervalCount: 1 });
    });
    it.each([
        ['no price', { hasMore: false, prices: [] }],
        ['two prices', { hasMore: false, prices: [...standardTrialRead().prices, { ...standardTrialRead().prices[0]!, id: 'price_Second' }] }],
        ['a further page', { ...standardTrialRead(), hasMore: true }],
        ['an inactive price', standardTrialRead(undefined, { active: false })],
        ['no product (unexpanded)', standardTrialRead(undefined, { product: null })],
        ['an inactive product', standardTrialRead(undefined, {}, { active: false })],
        ['another amount', standardTrialRead(undefined, { unitAmount: 2100 })],
        ['no amount', standardTrialRead(undefined, { unitAmount: null })],
        ['another currency', standardTrialRead(undefined, { currency: 'eur' })],
        ['a weekly interval', standardTrialRead(undefined, { interval: 'week' })],
        ['interval count 3', standardTrialRead(undefined, { intervalCount: 3 })],
        ['a malformed price id', standardTrialRead(undefined, { id: 'plan_x' })],
    ])('refuses %s', (_name, read) => {
        expect(trialProductTerms(read)).toBeNull();
    });
});

describe('selectTrialOffer', () => {
    it('selects the public offer or exactly the named promoter, with a fingerprint over the full terms', () => {
        expect(selectTrialOffer(standardTrialRead(CAMPAIGNS_ON), null, NOW)).toEqual({ ok: true,
            offer: { coupon: null, expiresAt: null, priceId: STANDARD_PRICE_ID, fingerprint: trialOfferFingerprint(ids, true, null, null) } });
        expect(selectTrialOffer(standardTrialRead(CAMPAIGNS_ON), ' MIDHUN ', NOW)).toEqual({ ok: true,
            offer: { coupon: 'midhun', expiresAt: null, priceId: STANDARD_PRICE_ID, fingerprint: trialOfferFingerprint(ids, true, 'midhun', null) } });
        expect(selectTrialOffer(standardTrialRead(), null, NOW)).toMatchObject({ ok: true, offer: { coupon: null } });
    });

    it('a promoter works with the public offer off; the public offer does not', () => {
        const read = standardTrialRead(campaigns({ version: 1, publicEnabled: false, promoters: { midhun: { enabled: true, expiresAt: '2026-11-15T00:00:00.000Z' } } }));
        expect(selectTrialOffer(read, null, NOW)).toEqual({ ok: false, code: 'trial_offer_unavailable' });
        expect(selectTrialOffer(read, 'midhun', NOW)).toMatchObject({ ok: true, offer: { coupon: 'midhun', expiresAt: '2026-11-15T00:00:00.000Z' } });
    });

    it.each([
        ['a malformed coupon', CAMPAIGNS_ON, 'mid hun', 'trial_offer_invalid'],
        ['a non-string coupon', CAMPAIGNS_ON, 42, 'trial_offer_invalid'],
        ['an unknown coupon', CAMPAIGNS_ON, 'someone', 'trial_offer_invalid'],
        ['an inherited name', CAMPAIGNS_ON, 'constructor', 'trial_offer_invalid'],
        ['an absent key with a coupon', undefined, 'midhun', 'trial_offer_invalid'],
        ['a disabled promoter', campaigns({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: false } } }), 'midhun', 'trial_offer_unavailable'],
        ['an expiry at now', campaigns({ version: 1, publicEnabled: true, promoters: { midhun: { enabled: true, expiresAt: NOW.toISOString() } } }), 'midhun', 'trial_offer_unavailable'],
        ['malformed metadata', '{', 'midhun', 'trial_offer_unavailable'],
        ['malformed metadata without a coupon', '{', null, 'trial_offer_unavailable'],
    ])('refuses %s', (_name, raw, coupon, code) => {
        expect(selectTrialOffer(standardTrialRead(raw as string | undefined), coupon, NOW)).toEqual({ ok: false, code });
    });

    it('never answers the public offer in place of a coupon, and bad terms refuse every offer', () => {
        expect(selectTrialOffer(standardTrialRead(CAMPAIGNS_ON), 'someone', NOW)).toEqual({ ok: false, code: 'trial_offer_invalid' });
        expect(selectTrialOffer(standardTrialRead(CAMPAIGNS_ON, { unitAmount: 0 }), 'midhun', NOW)).toEqual({ ok: false, code: 'trial_offer_unavailable' });
    });
});

describe('trialOfferFingerprint', () => {
    it('changes with every bound term and is 64 hex', () => {
        const base = trialOfferFingerprint(ids, true, 'midhun', null);
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        for (const other of [trialOfferFingerprint({ ...ids, productId: 'prod_Other' }, true, 'midhun', null),
            trialOfferFingerprint({ ...ids, priceId: 'price_Other' }, true, 'midhun', null), trialOfferFingerprint(ids, false, 'midhun', null),
            trialOfferFingerprint(ids, true, null, null), trialOfferFingerprint(ids, true, 'midhun', '2026-12-31T00:00:00.000Z')]) expect(other).not.toBe(base);
    });
    it('normalizes only plain codes', () => {
        expect(normalizePromoterCode(' Midhun ')).toBe('midhun');
        expect(normalizePromoterCode('m')).toBeNull();
        expect(normalizePromoterCode('a'.repeat(33))).toBeNull();
    });
});
