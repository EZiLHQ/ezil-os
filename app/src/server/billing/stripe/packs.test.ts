import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StripePackApi } from '../ports';
import { readStripePacks, resetStripePackCachesForTests } from './packs';
import { offeredPack, packCoupon, packPrice, packProduct } from './packs.test-support';

beforeEach(() => { resetStripePackCachesForTests(); vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function fixture() {
    return {
        listProducts: vi.fn<StripePackApi['listProducts']>().mockResolvedValue([structuredClone(packProduct)]),
        retrieveProduct: vi.fn<StripePackApi['retrieveProduct']>(),
        retrievePackPrice: vi.fn<StripePackApi['retrievePackPrice']>().mockResolvedValue({ ...packPrice }),
        retrieveCoupon: vi.fn<StripePackApi['retrieveCoupon']>().mockResolvedValue({ ...packCoupon }),
        retrieveCheckoutLineItems: vi.fn<StripePackApi['retrieveCheckoutLineItems']>(),
    };
}

describe('Stripe AI pack catalog', () => {
    it('reads dashboard prices and discounts and orders packs by ezil_order', async () => {
        const stripe = fixture();
        stripe.listProducts.mockResolvedValue([
            { ...packProduct, id: 'prod_later', metadata: { ...packProduct.metadata, ezil_order: '2' } }, packProduct,
        ]);
        stripe.retrievePackPrice.mockResolvedValueOnce({ ...packPrice, productId: 'prod_later' }).mockResolvedValueOnce(packPrice);
        expect(await readStripePacks(stripe)).toEqual([offeredPack, { ...offeredPack, sku: 'ai_pack_later', order: 2 }]);
        expect(stripe.retrieveCoupon).toHaveBeenCalledWith('coupon_pack');
    });
    it.each([{ unitAmount: 8000 }, { currency: 'eur' }, { type: 'recurring' }, { active: false }, { productId: 'prod_other' }])(
        'skips mismatched default prices %j and logs once across refreshes', async change => {
            vi.useFakeTimers();
            const stripe = fixture(); stripe.retrievePackPrice.mockResolvedValue({ ...packPrice, ...change });
            expect(await readStripePacks(stripe)).toEqual([]);
            vi.advanceTimersByTime(300000);
            expect(await readStripePacks(stripe)).toEqual([]);
            expect(console.warn).toHaveBeenCalledTimes(1);
        });
    it.each(['0', '-1', '1.5', '10001', '20000', '1000x', '', 'Infinity'])('skips invalid or over-$1,000 credits %s', async credits => {
        const stripe = fixture();
        stripe.listProducts.mockResolvedValue([{ ...packProduct, metadata: { ...packProduct.metadata, ezil_credits: credits } }]);
        expect(await readStripePacks(stripe)).toEqual([]);
        expect(stripe.retrievePackPrice).not.toHaveBeenCalled();
    });
    it.each([{ active: false }, { id: 'prod_bad-id' }, { defaultPrice: null }, { metadata: { ezil_kind: 'other' } }])(
        'ignores inactive or ineligible products %j', async change => {
            const stripe = fixture(); stripe.listProducts.mockResolvedValue([{ ...packProduct, ...change }]);
            expect(await readStripePacks(stripe)).toEqual([]);
        });
    it.each([null, { ...packCoupon, valid: false }, { ...packCoupon, percentOff: null, amountOff: 100 },
        { ...packCoupon, percentOff: 31 }, { ...packCoupon, percentOff: 0 }])('ignores unusable coupon %j', async coupon => {
        const stripe = fixture(); stripe.retrieveCoupon.mockResolvedValue(coupon);
        expect(await readStripePacks(stripe)).toEqual([{ ...offeredPack, couponId: null, discountPercent: 0, totalCents: 10000 }]);
        if (coupon?.percentOff === 31) expect(console.warn).toHaveBeenCalledWith('[billing.packs]', { id: packProduct.id, reason: 'discount_above_30' });
    });
    it('accepts the 30% boundary and offers full-price packs without a coupon', async () => {
        const stripe = fixture(); stripe.retrieveCoupon.mockResolvedValue({ ...packCoupon, percentOff: 30 });
        expect((await readStripePacks(stripe))[0]).toMatchObject({ discountPercent: 30, totalCents: 7000 });
        resetStripePackCachesForTests();
        stripe.listProducts.mockResolvedValue([{ ...packProduct, metadata: { ezil_kind: 'ai_pack', ezil_credits: '1000' } }]);
        stripe.retrieveCoupon.mockClear();
        expect((await readStripePacks(stripe))[0]).toMatchObject({ discountPercent: 0, couponId: null, totalCents: 10000, order: 0 });
        expect(stripe.retrieveCoupon).not.toHaveBeenCalled();
    });
    it('shares in-flight reads and five-minute account caches across adapter instances', async () => {
        vi.useFakeTimers();
        const stripe = { ...fixture(), packCacheKey: 'account-a' };
        expect(await Promise.all([readStripePacks(stripe), readStripePacks(stripe)])).toEqual([[offeredPack], [offeredPack]]);
        const second = { ...fixture(), packCacheKey: 'account-a' };
        vi.advanceTimersByTime(299999);
        expect(await readStripePacks(second)).toEqual([offeredPack]);
        expect(second.listProducts).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        second.listProducts.mockResolvedValue([]);
        expect(await readStripePacks(second)).toEqual([]);
        expect(stripe.listProducts).toHaveBeenCalledTimes(1);
        expect(second.listProducts).toHaveBeenCalledTimes(1);
        expect(await readStripePacks({ ...fixture(), packCacheKey: 'account-b' })).toEqual([offeredPack]);
    });
    it.each(['listProducts', 'retrievePackPrice', 'retrieveCoupon'] as const)('retains the complete last good catalog on %s failure', async method => {
        vi.useFakeTimers();
        const stripe = fixture();
        expect(await readStripePacks(stripe)).toEqual([offeredPack]);
        vi.advanceTimersByTime(300000);
        stripe[method].mockRejectedValue(new Error('secret must not be logged'));
        expect(await readStripePacks(stripe)).toEqual([offeredPack]);
        expect(console.warn).toHaveBeenCalledWith('[billing.packs]', { id: 'catalog', reason: 'stripe_unavailable' });
        stripe[method].mockReset();
    });
    it('returns no packs without Stripe or any prior successful read', async () => {
        const stripe = fixture(); stripe.listProducts.mockRejectedValue(new Error('unavailable'));
        expect(await readStripePacks(null)).toEqual([]);
        expect(await readStripePacks(stripe)).toEqual([]);
    });
});
