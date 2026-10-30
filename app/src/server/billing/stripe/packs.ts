import { CUSTOM_TOPUP } from '../catalog';
import type { StripePackApi, StripeProduct } from '../ports';
import type { CatalogPack } from '../types';

export interface StripeAiPack extends CatalogPack {
    aiCredits: number;
    priceId: string;
    couponId: string | null;
    order: number;
}

const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { value: StripeAiPack[]; expiresAt: number; pending?: Promise<StripeAiPack[]>; warned: Set<string> };
const catalogs = new Map<string | StripePackApi, CacheEntry>();

export function resetStripePackCachesForTests(): void { catalogs.clear(); }

export function stripePackSku(productId: string): string | null {
    return /^prod_[A-Za-z0-9_]+$/.test(productId) ? `ai_pack_${productId.slice(5)}` : null;
}

export function stripePackCredits(product: StripeProduct): number | null {
    const raw = product.metadata.ezil_credits;
    const credits = Number(raw);
    return product.metadata.ezil_kind === 'ai_pack' && /^[1-9][0-9]*$/.test(raw ?? '')
        && Number.isSafeInteger(credits) && credits <= 10_000 ? credits : null;
}

/** An incomplete refresh never replaces the last complete catalog. */
export async function readStripePacks(stripe: StripePackApi | null): Promise<StripeAiPack[]> {
    if (!stripe) return [];
    const key = stripe.packCacheKey ?? stripe;
    let entry = catalogs.get(key);
    if (!entry) {
        entry = { value: [], expiresAt: 0, warned: new Set() };
        catalogs.set(key, entry);
    }
    const cache = entry;
    if (cache.pending) return cache.pending;
    if (cache.expiresAt > Date.now()) return cache.value;
    const warn = (id: string, reason: string) => {
        const warning = `${id}:${reason}`;
        if (cache.warned.has(warning)) return;
        cache.warned.add(warning);
        console.warn('[billing.packs]', { id, reason });
    };
    cache.pending = (async () => {
        try {
            const packs: StripeAiPack[] = [];
            for (const product of await stripe.listProducts()) {
                if (!product.active || product.metadata.ezil_kind !== 'ai_pack') continue;
                const sku = stripePackSku(product.id);
                const aiCredits = stripePackCredits(product);
                if (!sku || aiCredits === null || !product.defaultPrice) {
                    warn(product.id, 'invalid_pack');
                    continue;
                }
                const price = await stripe.retrievePackPrice(product.defaultPrice);
                const creditCents = aiCredits * CUSTOM_TOPUP.centsPerCredit;
                if (!price.active || price.type !== 'one_time' || price.currency !== 'usd'
                    || price.productId !== product.id || price.unitAmount !== creditCents) {
                    warn(product.id, 'invalid_price');
                    continue;
                }
                let discountPercent = 0, couponId: string | null = null;
                if (product.metadata.ezil_coupon) {
                    const coupon = await stripe.retrieveCoupon(product.metadata.ezil_coupon);
                    if (coupon?.valid && coupon.amountOff === null && coupon.percentOff !== null
                        && Number.isFinite(coupon.percentOff) && coupon.percentOff > 0) {
                        if (coupon.percentOff > 30) warn(product.id, 'discount_above_30');
                        else { discountPercent = coupon.percentOff; couponId = coupon.id; }
                    }
                }
                const order = Number(product.metadata.ezil_order ?? 0);
                packs.push({ sku, aiCredits, creditCents, discountPercent, serviceFeeCents: 0,
                    totalCents: creditCents - Math.round(creditCents * discountPercent / 100),
                    priceId: price.id, couponId, order: Number.isSafeInteger(order) ? order : 0 });
            }
            cache.value = packs.sort((a, b) => a.order - b.order || a.sku.localeCompare(b.sku));
        } catch {
            warn('catalog', 'stripe_unavailable');
        } finally {
            cache.expiresAt = Date.now() + CACHE_TTL_MS;
            cache.pending = undefined;
        }
        return cache.value;
    })();
    return cache.pending;
}
