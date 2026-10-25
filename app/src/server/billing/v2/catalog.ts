import type { SubscriptionRow } from '../meters';
import {
    CATALOG_V2,
    FREE_V2_EFFECTIVE_AT,
    type PlanFamily,
    type PlanOffer,
    type PlanSku,
    type PlanStatusV2,
    type SellableSku,
    type Window,
} from './contract';
import { epochSeconds, isoSeconds } from './time';

export function offerBySku(sku: string): PlanOffer | undefined {
    return Object.prototype.hasOwnProperty.call(CATALOG_V2, sku) ? CATALOG_V2[sku as PlanSku] : undefined;
}

export function offerByLookupKey(lookupKey: string): PlanOffer | undefined {
    return Object.values(CATALOG_V2).find(offer => offer.stripeLookupKey === lookupKey);
}

export function freeSkuFor(
    userCreatedAt: Date | string | null,
    effectiveAt: string | null = FREE_V2_EFFECTIVE_AT,
): 'free_v2' | 'free_v1_legacy' {
    if (effectiveAt === null || userCreatedAt === null) return 'free_v1_legacy';
    const created = userCreatedAt instanceof Date ? userCreatedAt.getTime() : Date.parse(userCreatedAt);
    const effective = Date.parse(effectiveAt);
    return Number.isFinite(created) && Number.isFinite(effective) && created >= effective
        ? 'free_v2' : 'free_v1_legacy';
}

/** null denotes a subscription status that cannot supply a current plan. */
export function planStatusFromStripe(status: string, cancelAtPeriodEnd = false): PlanStatusV2 | null {
    switch (status) {
        case 'active':
        case 'trialing':
            return cancelAtPeriodEnd ? 'cancels' : 'active';
        case 'past_due':
        case 'unpaid':
            return 'past_due';
        case 'incomplete':
            return 'incomplete';
        default:
            return null;
    }
}

function freeWindow(now: Date): Window {
    const start = new Date(now);
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setUTCMonth(end.getUTCMonth() + 1);
    return { start: isoSeconds(epochSeconds(start)), end: isoSeconds(epochSeconds(end)) };
}

export function planFromSubscriptions(input: {
    subs: SubscriptionRow[];
    now: Date;
    userCreatedAt: Date | string | null;
    pendingUpgrade?: { toSku: SellableSku; expiresAt: string; hostedInvoiceUrl: string | null } | null;
    freeEffectiveAt?: string | null;
}): {
    sku: PlanSku;
    offer: PlanOffer;
    family: PlanFamily;
    status: PlanStatusV2;
    planActive: boolean;
    subscriptionId: string | null;
    window: Window;
    renewsAt: string | null;
    cancelsAt: string | null;
} {
    type Candidate = { sub: SubscriptionRow; offer: PlanOffer; status: PlanStatusV2; end: number };
    let current: Candidate | undefined;
    let delinquent: Candidate | undefined;
    const now = input.now.getTime();
    // Match the pool SQL's selection before funding is evaluated: latest period
    // end, latest start, then subscription ID. Input/query order is not authority.
    const preferred = (a: Candidate, b: Candidate) => a.end > b.end || (a.end === b.end
        && ((a.sub.currentPeriodStart?.getTime() ?? -Infinity) > (b.sub.currentPeriodStart?.getTime() ?? -Infinity)
            || (a.sub.currentPeriodStart?.getTime() === b.sub.currentPeriodStart?.getTime()
                && a.sub.stripeSubscriptionId < b.sub.stripeSubscriptionId)));


    for (const sub of input.subs) {
        const offer = offerBySku(sub.sku);
        const status = planStatusFromStripe(sub.status, sub.cancelAtPeriodEnd);
        if (!offer || offer.family === 'free' || status === null) continue;
        const start = sub.currentPeriodStart?.getTime() ?? NaN;
        const end = sub.currentPeriodEnd?.getTime() ?? NaN;
        const candidate = { sub, offer, status, end: Number.isFinite(end) ? end : -Infinity };
        if ((status === 'active' || status === 'cancels') && start <= now && now < end) {
            if (!current || preferred(candidate,current)) current = candidate;
        } else if (status === 'past_due' || status === 'incomplete') {
            if (!delinquent || preferred(candidate,delinquent)) delinquent = candidate;
        }
    }

    // A current paid period always wins over delinquent rows, regardless of recency.
    const selected = current ?? delinquent;
    if (selected) {
        const { sub, offer, status } = selected;
        const start = sub.currentPeriodStart;
        const end = sub.currentPeriodEnd;
        const periodEnd = end !== null && Number.isFinite(end.getTime()) ? isoSeconds(epochSeconds(end)) : null;
        // Incomplete subscriptions may not have period dates yet. This fallback
        // supplies a display window only; planActive stays false and grants nothing.
        const window = start !== null && Number.isFinite(start.getTime()) && periodEnd !== null
            ? { start: isoSeconds(epochSeconds(start)), end: periodEnd }
            : freeWindow(input.now);
        return {
            sku: offer.sku,
            offer,
            family: offer.family,
            status: current && input.pendingUpgrade ? 'upgrade_pending' : status,
            planActive: current !== undefined,
            subscriptionId: sub.stripeSubscriptionId,
            window,
            renewsAt: sub.cancelAtPeriodEnd ? null : periodEnd,
            cancelsAt: sub.cancelAtPeriodEnd ? periodEnd : null,
        };
    }

    const sku = freeSkuFor(input.userCreatedAt, input.freeEffectiveAt);
    const offer = CATALOG_V2[sku];
    return {
        sku,
        offer,
        family: offer.family,
        status: 'free',
        planActive: true,
        subscriptionId: null,
        window: freeWindow(input.now),
        renewsAt: null,
        cancelsAt: null,
    };
}
