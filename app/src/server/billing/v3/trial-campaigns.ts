/**
 * Stripe-controlled Standard trial campaigns (`?coupon=<promoter>`). The Standard monthly v3 Product's metadata key
 * `ezil_standard_trial_campaigns` decides which trial offers exist, so operators change them in Stripe without a
 * redeploy:
 *
 *   {"version":1,"publicEnabled":true,"promoters":{"midhun":{"enabled":true,"expiresAt":"2026-12-31T00:00:00.000Z"}}}
 *
 * A campaign only UNLOCKS the existing trial (v3/trial.ts: $0 today, one calendar month as Stripe's trial end, then
 * $20/month, one per person for life, the same AI credits). It never carries money: no Stripe coupon, discount or
 * promotion code is read or attached. The provider read must show exactly one active Standard price (USD 2000 cents,
 * monthly, interval count 1) on an active Product; anything else offers nothing.
 *
 * Without a coupon the public offer applies only while `publicEnabled`. A coupon selects exactly that promoter, enabled and
 * unexpired; otherwise it fails closed (never a public or full-price fallback). Malformed metadata offers nothing. An
 * absent key keeps the pre-campaign behaviour (public, no promoters).
 *
 * The selection's fingerprint covers the verified Product, Price, amount, currency, interval, public state, coupon and
 * expiry. It is returned with the quote and re-checked at checkout against a fresh read, so a disabled, expired or
 * repriced offer cannot open a session for terms the person was not shown.
 */
import { createHash } from 'node:crypto';
import { CATALOG_V3 } from './contract';
import { TRIAL_POLICY_VERSION, TRIAL_SKU } from './trial';

export const TRIAL_CAMPAIGNS_METADATA_KEY = 'ezil_standard_trial_campaigns' as const;
/** Stripe's limit for one metadata value, in UTF-8 bytes. */
const MAX_METADATA_BYTES = 500;
export const PROMOTER_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/;
const CANONICAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export interface TrialCampaigns {
    publicEnabled: boolean;
    promoters: Readonly<Record<string, { enabled: boolean; expiresAt: string | null }>>;
}
/** The provider facts the reader returns: every active price for the Standard lookup key (product expanded). */
export interface TrialPriceRead {
    prices: readonly { id: string; active: boolean; unitAmount: number | null; currency: string | null; interval: string | null;
        intervalCount: number | null; product: { id: string; active: boolean; metadata: Readonly<Record<string, string>> } | null }[];
    hasMore: boolean;
}
export interface TrialProductTerms {
    productId: string;
    priceId: string;
    unitAmount: number;
    currency: 'usd';
    interval: 'month';
    intervalCount: 1;
    campaigns: TrialCampaigns | null;
}
export interface TrialOfferSelection {
    coupon: string | null;
    expiresAt: string | null;
    priceId: string;
    fingerprint: string;
}
export type TrialOfferRefusal = 'trial_offer_invalid' | 'trial_offer_unavailable';

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const onlyKeys = (value: Record<string, unknown>, allowed: readonly string[]) => Object.keys(value).every(key => allowed.includes(key));
const canonicalIso = (value: string) => {
    if (!CANONICAL_ISO.test(value)) return false;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && date.toISOString() === value;
};

/** null = malformed (no trial offer); null/undefined input (no key) = the default public offer. Never throws. */
export function parseTrialCampaigns(raw: string | null | undefined): TrialCampaigns | null {
    if (raw === undefined || raw === null) return { publicEnabled: true, promoters: {} };
    if (Buffer.byteLength(raw, 'utf8') > MAX_METADATA_BYTES) return null;
    let value: unknown;
    try { value = JSON.parse(raw); } catch { return null; }
    if (!isRecord(value) || !onlyKeys(value, ['version', 'publicEnabled', 'promoters']) || value.version !== 1
        || typeof value.publicEnabled !== 'boolean' || !isRecord(value.promoters)) return null;
    const promoters: Record<string, { enabled: boolean; expiresAt: string | null }> = {};
    for (const [code, entry] of Object.entries(value.promoters)) {
        if (!PROMOTER_CODE_PATTERN.test(code) || !isRecord(entry) || !onlyKeys(entry, ['enabled', 'expiresAt']) || typeof entry.enabled !== 'boolean') return null;
        const expiresAt = entry.expiresAt;
        if (expiresAt !== undefined && (typeof expiresAt !== 'string' || !canonicalIso(expiresAt))) return null;
        promoters[code] = { enabled: entry.enabled, expiresAt: typeof expiresAt === 'string' ? expiresAt : null };
    }
    return { publicEnabled: value.publicEnabled, promoters };
}

/** Exactly one active, complete Standard price (USD 2000, month, count 1) on an active Product, or null. */
export function trialProductTerms(read: TrialPriceRead): TrialProductTerms | null {
    if (read.hasMore || read.prices.length !== 1) return null;
    const price = read.prices[0]!, product = price.product;
    if (!price.active || !/^price_[A-Za-z0-9]+$/.test(price.id) || !product || !product.active || !/^prod_[A-Za-z0-9]+$/.test(product.id)
        || price.unitAmount !== CATALOG_V3[TRIAL_SKU].priceCents || price.currency !== 'usd' || price.interval !== 'month' || price.intervalCount !== 1) return null;
    return { productId: product.id, priceId: price.id, unitAmount: price.unitAmount, currency: 'usd', interval: 'month', intervalCount: 1,
        campaigns: parseTrialCampaigns(Object.hasOwn(product.metadata, TRIAL_CAMPAIGNS_METADATA_KEY) ? product.metadata[TRIAL_CAMPAIGNS_METADATA_KEY] : null) };
}

/** The canonical promoter code of a raw `?coupon=` value; null for anything that is not one. */
export function normalizePromoterCode(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const code = raw.trim().toLowerCase();
    return PROMOTER_CODE_PATTERN.test(code) ? code : null;
}

/** sha256 of the canonical selected terms. */
export function trialOfferFingerprint(terms: Pick<TrialProductTerms, 'productId' | 'priceId'>, publicEnabled: boolean,
    coupon: string | null, expiresAt: string | null): string {
    return createHash('sha256').update(JSON.stringify({ v: 1, policy: TRIAL_POLICY_VERSION, sku: TRIAL_SKU, productId: terms.productId,
        priceId: terms.priceId, unitAmount: CATALOG_V3[TRIAL_SKU].priceCents, currency: 'usd', interval: 'month', intervalCount: 1,
        publicEnabled, coupon, expiresAt })).digest('hex');
}

/**
 * The offer for `coupon` (null = none) at `now`. `trial_offer_invalid`: a malformed or unknown coupon.
 * `trial_offer_unavailable`: bad price/product terms, malformed metadata, the public offer off, or a promoter disabled or
 * expired. Never the public offer in place of a coupon.
 */
export function selectTrialOffer(read: TrialPriceRead, coupon: unknown, now: Date):
    { ok: true; offer: TrialOfferSelection } | { ok: false; code: TrialOfferRefusal } {
    const hasCoupon = coupon !== null && coupon !== undefined;
    const code = hasCoupon ? normalizePromoterCode(coupon) : null;
    if (hasCoupon && code === null) return { ok: false, code: 'trial_offer_invalid' };
    const terms = trialProductTerms(read);
    if (!terms || !terms.campaigns) return { ok: false, code: 'trial_offer_unavailable' };
    const campaigns = terms.campaigns;
    if (code === null) {
        if (!campaigns.publicEnabled) return { ok: false, code: 'trial_offer_unavailable' };
        return { ok: true, offer: { coupon: null, expiresAt: null, priceId: terms.priceId, fingerprint: trialOfferFingerprint(terms, true, null, null) } };
    }
    if (!Object.hasOwn(campaigns.promoters, code)) return { ok: false, code: 'trial_offer_invalid' };
    const promoter = campaigns.promoters[code]!;
    if (!promoter.enabled || (promoter.expiresAt !== null && !(Date.parse(promoter.expiresAt) > now.getTime()))) return { ok: false, code: 'trial_offer_unavailable' };
    return { ok: true, offer: { coupon: code, expiresAt: promoter.expiresAt, priceId: terms.priceId,
        fingerprint: trialOfferFingerprint(terms, campaigns.publicEnabled, code, promoter.expiresAt) } };
}
