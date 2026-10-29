import type { SubscriptionRow } from '../meters';
import { freeSkuFor, offerByLookupKey as legacyByLookupKey, offerBySku as legacyBySku, planFromSubscriptions as legacyPlan } from '../v2/catalog';
import { CATALOG_V2, SESSION_MAX_SECONDS, type PlanOffer } from '../v2/contract';
import { epochSeconds } from '../v2/time';
import { CATALOG_V3, type PlanOfferV3, type PlanSkuV3, type PublicOfferV3 } from './contract';

export function offerBySku(sku: string): PlanOfferV3 | undefined {
    return Object.prototype.hasOwnProperty.call(CATALOG_V3, sku) ? CATALOG_V3[sku as PlanSkuV3] : undefined;
}

export function offerByLookupKey(key: string): PlanOfferV3 | undefined {
    return Object.values(CATALOG_V3).find(offer => offer.stripeLookupKey === key);
}

export function publicOffers(): PublicOfferV3[] {
    return Object.values(CATALOG_V3).map(offer => ({
        sku: offer.sku, name: offer.name, tagline: offer.tagline, priceCents: offer.priceCents,
        vcpu: offer.vcpu, memoryGiB: offer.memoryGiB, sessionMaxSeconds: offer.sessionMaxSeconds,
        opening: offer.opening, fairUseHours: offer.fairUseSeconds / 3600, highlighted: offer.highlighted,
        badge: offer.badge, machineChoice: [...offer.machineChoice], aiCredits: { ...offer.aiCredits }, bullets: [...offer.bullets],
        storageGiB: offer.storageGiB,
    }));
}

/** The existing invoice processor's terms, extended without changing sold v2 offers. */
export function billingOfferBySku(sku: string) {
    const offer = offerBySku(sku);
    return offer ? { ...offer, sellable: offer.stripeLookupKey !== null, allowanceStdSeconds: offer.fairUseSeconds }
        : legacyBySku(sku);
}

export function billingOfferByLookupKey(key: string) {
    const offer = offerByLookupKey(key);
    return offer ? billingOfferBySku(offer.sku) : legacyByLookupKey(key);
}

type LegacyPlan = ReturnType<typeof legacyPlan>;
type CommonPlan = Omit<LegacyPlan, 'sku' | 'offer'> & { legacyFree: boolean; sessionMaxSeconds: number | null };
export type ResolvedPlanV3 = CommonPlan & (
    | { sku: PlanSkuV3; offer: PlanOfferV3; legacy: null }
    | { sku: 'legacy'; offer: PlanOffer; legacy: LegacyPlan }
);

/** Stored SKUs were resolved from Stripe line lookup keys, which beat checkout metadata. */
export function planFromSubscriptions(input: {
    subs: SubscriptionRow[]; now: Date; userCreatedAt: Date | string | null; freeEffectiveAt?: string | null;
}): ResolvedPlanV3 {
    // Reuse v2's active-period precedence and delinquent/expired handling.
    const selected = legacyPlan({ ...input, subs: input.subs.map(sub => ({ ...sub,
        sku: sub.sku === 'standard_monthly_v3' ? 'standard_monthly_v2'
            : sub.sku === 'premium_monthly_v3' ? 'compute_monthly_v2' : sub.sku,
    })) });
    const sub = input.subs.find(sub => sub.stripeSubscriptionId === selected.subscriptionId);
    const offer = sub ? offerBySku(sub.sku) : CATALOG_V3.free_v3;
    const legacyFree = freeSkuFor(input.userCreatedAt, input.freeEffectiveAt) === 'free_v1_legacy';
    if (offer) return { ...selected, sku: offer.sku, offer, legacy: null, legacyFree, sessionMaxSeconds: offer.sessionMaxSeconds };
    return { ...selected, sku: 'legacy', legacy: selected, legacyFree, sessionMaxSeconds: SESSION_MAX_SECONDS };
}

/** Same integer, period-prorated grant rule used by v2 upgrades. */
export function upgradeGrantSeconds(input: { periodStart: string; periodEnd: string; effectiveAt: string }): number {
    const delta = CATALOG_V3.premium_monthly_v3.fairUseSeconds - CATALOG_V3.standard_monthly_v3.fairUseSeconds;
    const end = epochSeconds(input.periodEnd);
    const duration = end - epochSeconds(input.periodStart);
    if (duration <= 0) return 0;
    const remaining = Math.min(duration, Math.max(0, end - epochSeconds(input.effectiveAt)));
    return Number(BigInt(delta) * BigInt(remaining) / BigInt(duration));
}

export const paidBillingOffers = () => [
    ...Object.values(CATALOG_V2).filter(offer => offer.sellable),
    ...Object.values(CATALOG_V3).filter(offer => offer.stripeLookupKey !== null).map(offer => ({
        ...offer, allowanceStdSeconds: offer.fairUseSeconds,
    })),
];
