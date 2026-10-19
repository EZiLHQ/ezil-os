import { storageCapBytes } from '../catalog';
import { checkoutAvailable, type BillingConfig } from '../config';
import { storageState, type SubscriptionRow } from '../meters';
import type { GrantMeter, GrantRow, OverageConsentRow, PaymentIssueRow, PlanChangeRow } from '../ports';
import { offerBySku, planFromSubscriptions } from './catalog';
import {
    CATALOG_V2, CATALOG_V2_VERSION, GRANT_METER_COMPUTE, IDLE_SLEEP_SECONDS,
    OVERAGE_DEFAULT_CAP_CENTS, OVERAGE_TERMS_VERSION, SESSION_MAX_SECONDS, SESSION_WARN_SECONDS, SIZES, STD_SECONDS_PER_OVERAGE_CENT,
    type BillingSummaryV2, type ComputeEpoch, type OfferDTO, type PlanFamily, type SellableSku, type SizeCode,
} from './contract';
import { ratePeriod, rateWindow } from './rating';
import { epochSeconds, isoSeconds } from './time';

/** Include already-sold v1 grants and their reversals only for legacy Pro. */
export function summaryMeters(family: PlanFamily): GrantMeter[] {
    if (family === 'free') return [];
    return family === 'pro_legacy' ? [GRANT_METER_COMPUTE, 'workspace_seconds'] : [GRANT_METER_COMPUTE];
}

const iso = (date: Date) => isoSeconds(epochSeconds(date));
const sellable = (sku: string | null): sku is SellableSku => sku !== null && offerBySku(sku)?.sellable === true;

export function buildSummaryV2(input: {
    config: BillingConfig; now: Date; userCreatedAt: Date | null;
    subs: SubscriptionRow[]; epochs: readonly (ComputeEpoch & { deadlineAt?: string | null })[]; grants: readonly GrantRow[];
    consent: OverageConsentRow | null; planChanges: readonly PlanChangeRow[]; paymentIssues: readonly PaymentIssueRow[];
    storage: { computerId: string; bytes: bigint; measuredAt: Date }[]; sizePreference: SizeCode | null; hasCustomer: boolean;
}): BillingSummaryV2 {
    const { config, now, subs, userCreatedAt, epochs, grants, consent, storage } = input;
    const initialPlan = planFromSubscriptions({ subs, now, userCreatedAt });
    const changes = input.planChanges.filter(change => change.subscriptionId === initialPlan.subscriptionId);
    const upgrade = changes.find(change => change.kind === 'upgrade'
        && ['pending', 'requires_action', 'payment_failed'].includes(change.state) && sellable(change.toSku));
    const pendingUpgrade = upgrade && sellable(upgrade.toSku) ? {
        toSku: upgrade.toSku,
        expiresAt: upgrade.expiresAt === null ? initialPlan.window.end : iso(upgrade.expiresAt),
        hostedInvoiceUrl: upgrade.hostedInvoiceUrl,
    } : null;
    const plan = planFromSubscriptions({ subs, now, userCreatedAt, pendingUpgrade });
    const { offer, family, planActive, window } = plan;
    const downgrade = changes.find(change => change.kind === 'downgrade'
        && change.state === 'scheduled' && sellable(change.toSku));
    const scheduledChange = downgrade && sellable(downgrade.toSku) ? {
        toSku: downgrade.toSku,
        effectiveAt: downgrade.effectiveAt === null ? window.end : iso(downgrade.effectiveAt),
    } : null;

    const issues = input.paymentIssues.filter(issue => issue.resolvedAt === null && issue.issue !== 'voided'
        && issue.subscriptionId === plan.subscriptionId);
    const subscriptionIssues = issues.filter(issue => issue.invoiceKind !== 'overage');
    const overageIssue = issues.some(issue => issue.invoiceKind === 'overage');
    const delinquent = plan.status === 'past_due' || plan.status === 'incomplete';
    const paymentIssue = subscriptionIssues.some(issue => issue.issue === 'requires_action') ? 'requires_action'
        : subscriptionIssues.length > 0 || delinquent ? 'payment_failed'
            : overageIssue ? 'overage_unpaid' : null;

    let allowanceStdSeconds = family === 'free' ? offer.allowanceStdSeconds : 0;
    if (family !== 'free') {
        const meters = summaryMeters(family);
        const start = new Date(window.start);
        const end = new Date(window.end);
        let allowance = BigInt(0);
        for (const grant of grants) {
            if (grant.meter === GRANT_METER_COMPUTE && grant.subscriptionId !== plan.subscriptionId) continue;
            if (meters.includes(grant.meter) && grant.periodStart !== null && grant.periodEnd !== null
                && grant.periodStart < end && grant.periodEnd > start) allowance += grant.amount;
        }
        allowanceStdSeconds = Number(allowance < BigInt(0) ? BigInt(0) : allowance);
        if (!Number.isSafeInteger(allowanceStdSeconds)) throw new RangeError('Compute allowance exceeds safe integer range');
    }
    const overageOn = consent?.enabled === true && !overageIssue;
    const capCents = consent?.capCents ?? OVERAGE_DEFAULT_CAP_CENTS;
    const usage = rateWindow({ epochs, window, now: iso(now) });
    const rating = ratePeriod({
        usedStdSeconds: usage.stdSeconds, allowanceStdSeconds,
        overage: offer.overage ? { enabled: overageOn, capCents } : null,
    });
    const { remainingStdSeconds, billableOverageCents } = rating;
    const allowedSizes = [...offer.sizes];
    const remainingActualSecondsBySize: Partial<Record<SizeCode, number>> = {};
    for (const size of allowedSizes) remainingActualSecondsBySize[size] = Math.floor(remainingStdSeconds / SIZES[size].weight);
    let latestReadyAt: number | null = null;
    let activeDeadline: string | null = null;
    for (const epoch of epochs) {
        if (epoch.endedAt !== null) continue;
        const ready = epochSeconds(epoch.readyAt, 'ceil');
        const readyAt = Date.parse(epoch.readyAt);
        if (latestReadyAt === null || readyAt > latestReadyAt) {
            latestReadyAt = readyAt;
            const headroomNow = Math.max(0, allowanceStdSeconds
                + (offer.overage && overageOn ? capCents * STD_SECONDS_PER_OVERAGE_CENT : 0) - rating.usedStdSeconds);
            const sessionMax = ready + SESSION_MAX_SECONDS;
            activeDeadline = isoSeconds(Math.min(
                epoch.deadlineAt == null ? sessionMax : epochSeconds(epoch.deadlineAt),
                sessionMax, epochSeconds(now) + Math.floor(headroomNow / epoch.weight),
            ));
        }
    }

    // Storage is a level: retain only the newest sample for each computer.
    const newest = new Map<string, { bytes: bigint; measuredAt: Date }>();
    for (const sample of storage) {
        const seen = newest.get(sample.computerId);
        if (!seen || sample.measuredAt > seen.measuredAt) newest.set(sample.computerId, sample);
    }
    let usedBytes = BigInt(0);
    let measuredAt: Date | null = null;
    for (const sample of newest.values()) {
        usedBytes += sample.bytes;
        if (measuredAt === null || sample.measuredAt > measuredAt) measuredAt = sample.measuredAt;
    }
    const capBytes = storageCapBytes(family === 'free' ? 'free' : 'pro', config.largeStorageEnabled);
    const ca = checkoutAvailable(config);
    const offers: OfferDTO[] = [];
    for (const entry of Object.values(CATALOG_V2)) {
        if (!entry.sellable || !sellable(entry.sku)
            || (entry.family !== 'standard' && entry.family !== 'compute') || entry.interval !== 'month') continue;
        offers.push({
            sku: entry.sku, family: entry.family, priceCents: entry.priceCents, currency: entry.currency,
            interval: entry.interval, allowanceStdSeconds: entry.allowanceStdSeconds, sizes: [...entry.sizes],
            overage: entry.overage ? {
                centsPerStdHour: entry.overage.centsPerStdHour,
                defaultCapCents: entry.overage.defaultCapCents, maxCapCents: entry.overage.maxCapCents,
            } : null,
        });
    }

    return {
        enabled: true,
        version: CATALOG_V2_VERSION,
        plan: {
            sku: plan.sku, family, status: plan.status, periodStart: window.start, periodEnd: window.end,
            renewsAt: plan.renewsAt, cancelsAt: plan.cancelsAt, scheduledChange, pendingUpgrade, paymentIssue,
        },
        compute: {
            allowanceStdSeconds, usedStdSeconds: rating.usedStdSeconds, remainingStdSeconds,
            resetsAt: window.end,
            state: overageOn && rating.overageCents >= capCents ? 'over_cap'
                : remainingStdSeconds === 0 ? 'exhausted'
                    : BigInt(remainingStdSeconds) * BigInt(5) <= BigInt(allowanceStdSeconds) ? 'low' : 'ok',
            remainingActualSecondsBySize, allowedSizes,
            selectedSize: input.sizePreference !== null && allowedSizes.includes(input.sizePreference)
                ? input.sizePreference : offer.defaultSize,
            session: {
                maxSeconds: SESSION_MAX_SECONDS, warnSeconds: [...SESSION_WARN_SECONDS], idleSleepSeconds: IDLE_SLEEP_SECONDS,
                activeDeadline,
            },
        },
        overage: offer.overage ? {
            available: planActive && !overageIssue, enabled: overageOn, capCents,
            defaultCapCents: offer.overage.defaultCapCents, maxCapCents: offer.overage.maxCapCents,
            centsPerStdHour: offer.overage.centsPerStdHour, accruedCents: billableOverageCents,
            termsVersion: OVERAGE_TERMS_VERSION, acceptedVersion: consent?.termsVersion ?? null,
            acceptedAt: consent ? iso(consent.acceptedAt) : null,
            pausedReason: overageIssue ? 'payment_failed'
                : overageOn && billableOverageCents >= capCents ? 'cap_reached' : null,
        } : null,
        estimate: {
            nextChargeAt: plan.renewsAt,
            subscriptionCents: family === 'free' || plan.cancelsAt !== null ? null
                : scheduledChange ? offerBySku(scheduledChange.toSku)!.priceCents : offer.priceCents,
            accruedOverageCents: billableOverageCents, worstCaseOverageCents: overageOn ? capCents : 0,
            currency: 'usd', taxNote: 'before_tax',
        },
        storage: {
            usedBytes: usedBytes.toString(), capBytes: capBytes.toString(), state: storageState(usedBytes, capBytes),
            measuredAt: measuredAt === null ? null : iso(measuredAt),
        },
        ai: { state: 'unavailable', trialMicro: '0', includedMicro: '0', purchasedMicro: '0', includedExpiresAt: null },
        actions: {
            checkout: ca && family === 'free', portal: ca && input.hasCustomer && family !== 'free',
            upgrade: ca && family === 'standard' && planActive && !pendingUpgrade && !paymentIssue,
            downgrade: ca && family === 'compute' && planActive && !scheduledChange && plan.status !== 'cancels',
            cancel: ca && (family === 'standard' || family === 'compute') && planActive,
            overage: family === 'compute' && planActive, selectSize: planActive && allowedSizes.length > 1,
        },
        catalog: {
            version: CATALOG_V2_VERSION, offers,
            sizes: Object.values(SIZES).map(({ code, vcpu, memoryGiB, weight }) => ({ code, vcpu, memoryGiB, weight })),
        },
    };
}
