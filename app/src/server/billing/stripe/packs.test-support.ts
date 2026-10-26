import type { StripeCoupon, StripePackPrice, StripeProduct } from '../ports';
import type { StripeAiPack } from './packs';

export const packProduct: StripeProduct = { id: 'prod_fixture', active: true, defaultPrice: 'price_pack',
    metadata: { ezil_kind: 'ai_pack', ezil_credits: '1000', ezil_order: '1', ezil_coupon: 'coupon_pack' } };
export const packPrice: StripePackPrice = { id: 'price_pack', active: true, productId: 'prod_fixture',
    type: 'one_time', currency: 'usd', unitAmount: 10000 };
export const packCoupon: StripeCoupon = { id: 'coupon_pack', valid: true, percentOff: 20, amountOff: null };
export const offeredPack: StripeAiPack = { sku: 'ai_pack_fixture', aiCredits: 1000, creditCents: 10000,
    discountPercent: 20, serviceFeeCents: 0, totalCents: 8000, priceId: 'price_pack', couponId: 'coupon_pack', order: 1 };
export const productResponse = { id: 'prod_fixture', active: true, default_price: 'price_pack', metadata: packProduct.metadata };
export const priceResponse = { id: 'price_pack', active: true, product: 'prod_fixture', type: 'one_time', currency: 'usd', unit_amount: 10000 };
export const couponResponse = { id: 'coupon_pack', valid: true, percent_off: 20, amount_off: null };
