import { storageCapBytes } from '../catalog';
import { checkoutAvailable } from '../config';
import { storageState } from '../meters';
import type { GrantRow } from '../ports';
import { SIZES, type ComputeEpoch, type Window } from '../v2/contract';
import { buildSummaryV2 } from '../v2/summary';
import { epochSeconds, isoSeconds } from '../v2/time';
import { fairUseStatusOf } from './admission';
import { planFromSubscriptions, publicOffers, type ResolvedPlanV3 } from './catalog';
import { CATALOG_V3_VERSION, type BillingSummaryV3, type SellableSkuV3 } from './contract';

const iso = (date: Date) => isoSeconds(epochSeconds(date));
const sellable = (sku: string | null): sku is SellableSkuV3 => sku === 'standard_monthly_v3' || sku === 'premium_monthly_v3';

/** Wall-clock seconds, clipped to the allowance window; size weights never multiply v3 usage. */
export function usedSecondsInWindow(epochs: readonly (ComputeEpoch & { deadlineAt?: string | null })[], window: Window, now: Date): number {
    return epochs.reduce((total, epoch) => {
        const start = Math.max(epochSeconds(epoch.readyAt, 'ceil'), epochSeconds(window.start));
        const end = Math.min(epochSeconds(epoch.endedAt ?? iso(now)), epochSeconds(now), epochSeconds(window.end),
            epoch.deadlineAt == null ? Infinity : epochSeconds(epoch.deadlineAt));
        return total + Math.max(0, end - start);
    }, 0);
}

/** Paid receipts and reversals keep the same subscription/period isolation as v2. */
export function fairUseAllowance(plan: ResolvedPlanV3, grants: readonly GrantRow[]): number {
    if (plan.sku === 'legacy') throw new TypeError('Legacy allowances use v2 rating');
    if (plan.sku === 'free_v3') return plan.legacyFree ? plan.offer.legacyFairUseSeconds! : plan.offer.fairUseSeconds;
    const start = new Date(plan.window.start), end = new Date(plan.window.end);
    const amount = grants.filter(grant => grant.meter === 'compute_std_seconds' && grant.subscriptionId === plan.subscriptionId
        && grant.periodStart !== null && grant.periodEnd !== null && grant.periodStart < end && grant.periodEnd > start)
        .reduce((sum, grant) => sum + grant.amount, BigInt(0));
    return Number(amount < BigInt(0) ? BigInt(0) : amount > BigInt(plan.offer.fairUseSeconds) ? BigInt(plan.offer.fairUseSeconds) : amount);
}

export function buildSummaryV3(input: Parameters<typeof buildSummaryV2>[0] & {
    /** Next invoice preview for this subscription, including discounts/tax/credits. Null when unavailable. */
    renewal?: BillingSummaryV3['plan']['renewal'];
}): BillingSummaryV3 {
    const plan = planFromSubscriptions(input);
    const legacy = plan.sku === 'legacy' ? buildSummaryV2(input) : null;
    const changes = input.planChanges.filter(change => change.subscriptionId === plan.subscriptionId);
    const upgrade = changes.find(change => change.kind === 'upgrade' && sellable(change.toSku)
        && ['pending', 'requires_action', 'payment_failed'].includes(change.state));
    const downgrade = changes.find(change => change.kind === 'downgrade' && sellable(change.toSku) && change.state === 'scheduled');
    const pendingUpgrade = upgrade && sellable(upgrade.toSku) ? { toSku: upgrade.toSku,
        expiresAt: upgrade.expiresAt ? iso(upgrade.expiresAt) : plan.window.end, hostedInvoiceUrl: upgrade.hostedInvoiceUrl } : null;
    const scheduledChange = downgrade && sellable(downgrade.toSku) ? { toSku: downgrade.toSku,
        effectiveAt: downgrade.effectiveAt ? iso(downgrade.effectiveAt) : plan.window.end } : null;
    // A failed pending upgrade leaves the already-paid Standard period usable.
    const issues = input.paymentIssues.filter(issue => issue.subscriptionId === plan.subscriptionId
        && issue.resolvedAt === null && issue.issue !== 'voided' && issue.invoiceKind === 'subscription');
    const paymentIssue = issues.some(issue => issue.issue === 'requires_action') ? 'requires_action'
        : issues.length || plan.status === 'past_due' || plan.status === 'incomplete' ? 'payment_failed' : null;
    const usedSeconds = legacy?.compute.usedStdSeconds ?? usedSecondsInWindow(input.epochs, plan.window, input.now);
    const allowance = legacy?.compute.allowanceStdSeconds ?? fairUseAllowance(plan, input.grants);
    const size = legacy ? SIZES[legacy.compute.selectedSize] : plan.sku === 'legacy' ? SIZES[plan.offer.defaultSize] : plan.offer;
    const latest = input.epochs.filter(epoch => epoch.endedAt === null && epochSeconds(epoch.readyAt) <= epochSeconds(input.now))
        .sort((a, b) => Date.parse(b.readyAt) - Date.parse(a.readyAt))[0];
    const activeDeadline = legacy ? legacy.compute.session.activeDeadline : latest ? isoSeconds(Math.min(
        epochSeconds(latest.readyAt, 'ceil') + plan.sessionMaxSeconds,
        latest.deadlineAt == null ? Infinity : epochSeconds(latest.deadlineAt),
        epochSeconds(input.now) + Math.max(0, allowance - usedSeconds),
    )) : null;
    const newest = new Map<string, typeof input.storage[number]>();
    for (const sample of input.storage) {
        if (!newest.has(sample.computerId) || newest.get(sample.computerId)!.measuredAt < sample.measuredAt) newest.set(sample.computerId, sample);
    }
    const usedBytes = [...newest.values()].reduce((sum, sample) => sum + sample.bytes, BigInt(0));
    const capBytes = storageCapBytes(plan.family === 'free' ? 'free' : 'pro', input.config.largeStorageEnabled);
    const storage = storageState(usedBytes, capBytes);
    const enabled = checkoutAvailable(input.config);
    return {
        enabled: true, version: 3,
        plan: { sku: plan.sku, name: plan.sku === 'legacy' ? plan.offer.family === 'pro_legacy' ? 'Pro (legacy)'
            : plan.offer.family === 'compute' ? 'Compute (legacy)' : 'Standard (legacy)' : plan.offer.name,
        status: pendingUpgrade && plan.planActive ? 'upgrade_pending' : plan.status,
        renewal: plan.renewsAt !== null ? input.renewal ?? null : null, cancelsAt: plan.cancelsAt,
        scheduledChange, pendingUpgrade, paymentIssue },
        computer: { size: size.code, vcpu: size.vcpu, memoryGiB: size.memoryGiB, sessionMaxSeconds: plan.sessionMaxSeconds,
            opening: plan.sku === 'legacy' ? 'standard' : plan.offer.opening, activeDeadline,
            machineChoice: (plan.sku === 'legacy' ? [size.code] : plan.offer.machineChoice).map(code => ({
                size: code, vcpu: SIZES[code].vcpu, memoryGiB: SIZES[code].memoryGiB, weight: SIZES[code].weight, arch: 'x86_64' as const })) },
        fairUse: { status: fairUseStatusOf({ usedSeconds, fairUseSeconds: allowance }), resetsAt: plan.window.end },
        storage: { usedBytes: usedBytes.toString(), capBytes: capBytes.toString(), state: storage === 'over_cap' ? 'exhausted' : storage },
        actions: { checkout: enabled && plan.family === 'free',
            upgrade: enabled && plan.sku === 'standard_monthly_v3' && plan.status === 'active' && !pendingUpgrade && !scheduledChange && !paymentIssue,
            downgrade: enabled && plan.sku === 'premium_monthly_v3' && plan.status === 'active' && !pendingUpgrade && !scheduledChange && !paymentIssue,
            cancel: enabled && plan.subscriptionId !== null && plan.planActive && !pendingUpgrade,
            portal: enabled && input.hasCustomer },
        catalog: { version: CATALOG_V3_VERSION, offers: publicOffers() },
    };
}
