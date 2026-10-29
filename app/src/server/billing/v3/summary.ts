import type { StripeAiPack } from '../stripe/packs';
import { aiPackCheckoutEligible, CUSTOM_TOPUP, storageCapBytes } from '../catalog';
import { checkoutAvailable } from '../config';
import { storageState } from '../meters';
import type { GrantRow } from '../ports';
import { SIZES, type ComputeEpoch, type SizeCode, type Window } from '../v2/contract';
import { AWS_TIER_DATA_GIB, AWS_TIERS, type AwsTier } from '../../lib/compute/aws-config';
import { buildSummaryV2 } from '../v2/summary';
import { rateWindow } from '../v2/rating';
import { epochSeconds, isoSeconds } from '../v2/time';
import { fairUseStatusOf, HOLD_SIZE } from './admission';
import { planFromSubscriptions, publicOffers, type ResolvedPlanV3 } from './catalog';
import { CATALOG_V3_VERSION, type BillingSummaryV3, type SellableSkuV3 } from './contract';
import { deriveStanding } from './standing';
import { parseAiUpgradeEntitlement } from '../ai-credits';
import { aiMicroBalanceState, type AiGatewayGrant } from '../ai-balance';
import type { AiCreditReceipt } from '../ai-credit-outbox';
import { creditNumber } from '../ai-read';

const iso = (date: Date) => isoSeconds(epochSeconds(date));
const sellable = (sku: string | null): sku is SellableSkuV3 => sku === 'standard_monthly_v3' || sku === 'premium_monthly_v3';

/** Standard seconds, using v2's validated epoch weights and session bounds. */
export function usedSecondsInWindow(epochs: readonly (ComputeEpoch & { deadlineAt?: string | null })[], window: Window, now: Date,
    bounds: { sessionMaxSeconds?: number | null; allowanceStdSeconds?: number } = {}): number {
    return rateWindow({ ...bounds, epochs: epochs.map(epoch => ({ ...epoch,
        endedAt: isoSeconds(Math.min(epochSeconds(epoch.endedAt ?? iso(now)), epochSeconds(now),
            bounds.sessionMaxSeconds === null || epoch.deadlineAt == null ? Infinity : epochSeconds(epoch.deadlineAt))),
    })), window, now: iso(now) }).stdSeconds;
}

/** Paid receipts and reversals keep the same subscription/period isolation as v2. */
export function fairUseAllowance(plan: ResolvedPlanV3, grants: readonly GrantRow[], options: { grace?: boolean } = {}): number {
    if (plan.sku === 'legacy') throw new TypeError('Legacy allowances use v2 rating');
    if (plan.sku === 'free_v3') return plan.legacyFree ? plan.offer.legacyFairUseSeconds! : plan.offer.fairUseSeconds;
    const start = new Date(plan.window.start), end = new Date(plan.window.end);
    const rows = grants.filter(grant => grant.meter === 'compute_std_seconds' && grant.subscriptionId === plan.subscriptionId
        && grant.periodStart !== null && grant.periodEnd !== null && grant.periodStart < end && grant.periodEnd > start);
    // Round 4 D17: an unpaid renewal has no receipt yet. In grace the paid computer stays usable on the plan's
    // fair use; any receipt or reversal (a refund, D19) for the period still wins.
    if (options.grace && rows.length === 0) return plan.offer.fairUseSeconds;
    const amount = rows.reduce((sum, grant) => sum + grant.amount, BigInt(0));
    return Number(amount < BigInt(0) ? BigInt(0) : amount > BigInt(plan.offer.fairUseSeconds) ? BigInt(plan.offer.fairUseSeconds) : amount);
}

type AiBucket = 'included' | 'previous' | 'purchased' | 'starter';
const PERIOD_ROOT = /^ezil-os:v1:(standard_monthly_v3|premium_monthly_v3):([^:]+):(\d{4}-\d{2}-\d{2}T[\d:.]+Z)$/;
const MICRO = BigInt(1_000_000);

/** Which bucket a stored receipt funds, relative to the plan's current paid period. */
function receiptBucket(entitlementId: string, plan: ResolvedPlanV3): { bucket: AiBucket; planPeriodSku?: string } {
    if (entitlementId.startsWith('ezil-os:v1:free-once:')) return { bucket: 'starter' };
    if (entitlementId.startsWith('ezil-os:v1:topup:')) return { bucket: 'purchased' };
    const start = Date.parse(plan.window.start), end = Date.parse(plan.window.end);
    const inWindow = (at: number) => plan.subscriptionId !== null && at >= start && at < end;
    const upgrade = parseAiUpgradeEntitlement(entitlementId);
    if (upgrade) return { bucket: upgrade.subscriptionId === plan.subscriptionId && inWindow(upgrade.effectiveAt.getTime()) ? 'included' : 'previous' };
    const period = PERIOD_ROOT.exec(entitlementId);
    return period && period[2] === plan.subscriptionId && inWindow(Date.parse(period[3]!))
        ? { bucket: 'included', planPeriodSku: period[1] } : { bucket: 'previous' };
}

const credits = (micro: bigint) => creditNumber(micro.toString());

/**
 * Round 3 D2/D4: split the Gateway balance into the plan's credits for THIS period,
 * purchased and starter credits. The Gateway `grants[]` carries no entitlement id, so a
 * live grant is matched to the stored receipt with the same expiry and amount; an
 * unmatched grant (earlier periods still inside their 3-day tail, legacy or manual
 * grants) counts in `balance` only. The low/exhausted state never mixes buckets.
 */
export function aiCreditBuckets(input: { plan: ResolvedPlanV3; receipts: readonly AiCreditReceipt[] | null;
    gatewayGrants: readonly AiGatewayGrant[] | null; balanceMicro: string | null }): Pick<BillingSummaryV3['ai'],
    'state' | 'included' | 'purchased' | 'starter' | 'pendingFromRenewal'> {
    const { plan } = input;
    const paid = plan.sku === 'standard_monthly_v3' || plan.sku === 'premium_monthly_v3';
    const receipts = (input.receipts ?? []).map(receipt => ({ ...receipt, ...receiptBucket(receipt.entitlementId, plan) }));
    const matched = new Map<AiBucket, AiGatewayGrant[]>();
    const unused = [...receipts];
    for (const grant of input.gatewayGrants ?? []) {
        if (!grant.live) continue;
        const i = unused.findIndex(r => Date.parse(r.expiresAt) === Date.parse(grant.expiresAt) && BigInt(r.credits) * MICRO === BigInt(grant.creditsMicro));
        if (i < 0) continue;
        const [receipt] = unused.splice(i, 1);
        matched.set(receipt!.bucket, [...matched.get(receipt!.bucket) ?? [], grant]);
    }
    const sum = (grants: readonly AiGatewayGrant[] | undefined, field: 'creditsMicro' | 'remainingMicro') =>
        (grants ?? []).reduce((total, g) => total + BigInt(g[field]), BigInt(0));
    const current = receipts.filter(r => r.bucket === 'included');
    // Matching assumes the Gateway stores credits × 10^6 and the sent expiry. If delivered receipts
    // match nothing (a unit change, or the plan's grant missing), report unknown, never "0 of 0".
    const delivered = (list: typeof receipts) => list.some(r => r.deliveredAt !== null);
    const known = input.gatewayGrants !== null && !(delivered(receipts) && matched.size === 0)
        && !(delivered(current) && !matched.has('included'));
    const includedGrantedMicro = known ? sum(matched.get('included'), 'creditsMicro')
        : current.filter(r => r.deliveredAt !== null).reduce((total, r) => total + BigInt(r.credits) * MICRO, BigInt(0));
    const included = paid ? { granted: credits(includedGrantedMicro) ?? 0,
        remaining: known ? credits(sum(matched.get('included'), 'remainingMicro')) : null, periodEnd: plan.window.end } : null;
    const live = (bucket: AiBucket) => (matched.get(bucket) ?? []).filter(g => BigInt(g.remainingMicro) > BigInt(0));
    const purchased = known && live('purchased').length ? { remaining: credits(sum(live('purchased'), 'remainingMicro')) ?? 0,
        expiresAt: live('purchased').map(g => g.expiresAt).sort()[0]! } : null;
    const starter = known && live('starter').length ? { remaining: credits(sum(live('starter'), 'remainingMicro')) ?? 0 } : null;
    const pendingFromRenewal = paid && input.receipts !== null && plan.renewsAt !== null
        && !current.some(r => r.planPeriodSku === plan.sku) ? { credits: plan.offer.aiCredits.amount, at: plan.renewsAt } : null;
    // Paid plans judge THIS period's credits; Free judges its starter grant. Unknown → v1 total-vs-catalog rule.
    const basis = paid ? matched.get('included') : plan.sku === 'free_v3' ? matched.get('starter') : undefined;
    const basisGranted = sum(basis, 'creditsMicro');
    let state: BillingSummaryV3['ai']['state'];
    if (input.balanceMicro === null) state = 'unavailable';
    else if (BigInt(input.balanceMicro) === BigInt(0)) state = 'exhausted';
    else if (known && basisGranted > BigInt(0)) state = sum(basis, 'remainingMicro') * BigInt(10) <= basisGranted ? 'low' : 'ok';
    else state = aiMicroBalanceState(input.balanceMicro, includedGrantedMicro > BigInt(0) ? Number(includedGrantedMicro / MICRO)
        : plan.sku === 'legacy' ? 0 : plan.offer.aiCredits.amount);
    return { state, included, purchased, starter, pendingFromRenewal };
}

const GIB = BigInt(1024) ** BigInt(3);

/**
 * Round 3 D10: the real disk. AWS plans have one data volume per computer (`AWS_TIER_DATA_GIB`,
 * 50 GiB on every paid size today) and the cap is that volume; Free/Cloudflare has no provisioned
 * figure, so no cap is invented. Only legacy v1/v2 plans keep the v1 constant.
 */
export function storageDisk(plan: ResolvedPlanV3, size: SizeCode, storage: readonly { computerId: string; bytes: bigint; measuredAt: Date }[],
    largeStorageEnabled: boolean): { provisionedGiB: number | null; usedBytes: bigint | null; capBytes: bigint | null; state: BillingSummaryV3['storage']['state'] } {
    const newest = new Map<string, typeof storage[number]>();
    for (const sample of storage) {
        if (!newest.has(sample.computerId) || newest.get(sample.computerId)!.measuredAt < sample.measuredAt) newest.set(sample.computerId, sample);
    }
    const usedBytes = newest.size ? [...newest.values()].reduce((sum, sample) => sum + sample.bytes, BigInt(0)) : null;
    const meter = (cap: bigint) => {
        const state = storageState(usedBytes ?? BigInt(0), cap);
        return state === 'over_cap' ? 'exhausted' as const : state;
    };
    if (plan.sku === 'legacy') {
        const cap = storageCapBytes(plan.family === 'free' ? 'free' : 'pro', largeStorageEnabled);
        return { provisionedGiB: null, usedBytes, capBytes: cap, state: meter(cap) };
    }
    const tier = SIZES[size].provider === 'aws'
        ? (Object.keys(AWS_TIERS) as AwsTier[]).find(t => t !== 'free' && AWS_TIERS[t][0] === SIZES[size].machine) : undefined;
    const provisionedGiB = tier ? AWS_TIER_DATA_GIB[tier] : null;
    const capBytes = provisionedGiB === null ? null : BigInt(provisionedGiB) * GIB;
    return { provisionedGiB, usedBytes, capBytes, state: capBytes === null || usedBytes === null ? 'unavailable' : meter(capBytes) };
}

export function buildSummaryV3(input: Parameters<typeof buildSummaryV2>[0] & {
    /** Next invoice preview for this subscription, including discounts/tax/credits. Null when unavailable. */
    renewal?: BillingSummaryV3['plan']['renewal'];
    packs?: readonly StripeAiPack[];
    stripeAvailable?: boolean;
    /** Round 3: the Gateway balance and stored receipts; omitted = balance filled by the caller (v1 shape). */
    ai?: { receipts: readonly AiCreditReceipt[] | null; gatewayGrants: readonly AiGatewayGrant[] | null; balanceMicro: string | null };
    /** Round 4: any aws-ec2 placement among the user's live computers; null/omitted = none or unreadable. */
    placementProvider?: 'aws-ec2' | 'cloudflare' | null;
}): BillingSummaryV3 {
    const plan = planFromSubscriptions(input);
    const standing = deriveStanding({ subscriptions: input.subs, paymentIssues: input.paymentIssues,
        placementProvider: input.placementProvider ?? null, now: input.now });
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
    const allowance = legacy?.compute.allowanceStdSeconds ?? fairUseAllowance(plan, input.grants, { grace: standing.standing === 'grace' });
    const bounds = { sessionMaxSeconds: plan.sessionMaxSeconds, allowanceStdSeconds: allowance };
    const usedSeconds = legacy?.compute.usedStdSeconds ?? usedSecondsInWindow(input.epochs, plan.window, input.now, bounds);
    // Round 4 D16: under the hold the computer that opens is the held AWS computer at HOLD_SIZE, not the
    // Free offer's Cloudflare size, so Billing agrees with the Computer and System tabs (2 vCPU / 8 GB).
    const size = legacy ? SIZES[legacy.compute.selectedSize] : plan.sku === 'legacy' ? SIZES[plan.offer.defaultSize]
        : standing.standing === 'files_on_aws' ? SIZES[HOLD_SIZE]
        : SIZES[input.sizePreference !== null && plan.offer.machineChoice.includes(input.sizePreference)
            ? input.sizePreference : plan.offer.size];
    const latest = input.epochs.filter(epoch => epoch.endedAt === null && epochSeconds(epoch.readyAt) <= epochSeconds(input.now))
        .sort((a, b) => Date.parse(b.readyAt) - Date.parse(a.readyAt))[0];
    // Recompute uncapped deadlines from period usage before this epoch. Old paid
    // epochs may still carry a 2/6-hour session deadline; it is no longer a limit.
    const priorUsage = latest && plan.sessionMaxSeconds === null ? usedSecondsInWindow(
        input.epochs.filter(epoch => epoch.id !== latest.id), plan.window, new Date(latest.readyAt), bounds) : 0;
    const fairDeadline = latest && plan.sessionMaxSeconds === null
        ? allowance <= priorUsage ? epochSeconds(input.now)
            : Math.max(epochSeconds(latest.readyAt, 'ceil'), epochSeconds(plan.window.start))
                + Math.floor((allowance - priorUsage) / latest.weight)
        : latest ? epochSeconds(input.now) + Math.floor(Math.max(0, allowance - usedSeconds) / latest.weight) : Infinity;
    const activeDeadline = legacy ? legacy.compute.session.activeDeadline : latest ? isoSeconds(Math.min(
        epochSeconds(latest.readyAt, 'ceil') + (plan.sessionMaxSeconds ?? Infinity),
        plan.sessionMaxSeconds === null || latest.deadlineAt == null ? Infinity : epochSeconds(latest.deadlineAt),
        fairDeadline,
    )) : null;
    const disk = storageDisk(plan, size.code, input.storage, input.config.largeStorageEnabled);
    const enabled = checkoutAvailable(input.config) && input.stripeAvailable !== false;
    return {
        enabled: true, version: 3,
        plan: { sku: plan.sku, name: plan.sku === 'legacy' ? plan.offer.family === 'pro_legacy' ? 'Pro (legacy)'
            : plan.offer.family === 'compute' ? 'Compute (legacy)' : 'Standard (legacy)' : plan.offer.name,
        status: pendingUpgrade && plan.planActive ? 'upgrade_pending' : plan.status,
        renewal: plan.renewsAt !== null ? input.renewal ?? null : null, cancelsAt: plan.cancelsAt,
        scheduledChange, pendingUpgrade, paymentIssue, graceEndsAt: standing.graceEndsAt, planEndsAt: standing.planEndsAt },
        computer: { size: size.code, vcpu: size.vcpu, memoryGiB: size.memoryGiB, sessionMaxSeconds: plan.sessionMaxSeconds,
            opening: plan.sku === 'legacy' ? 'standard' : plan.offer.opening, activeDeadline,
            machineChoice: (plan.sku === 'legacy' ? [size.code] : plan.offer.machineChoice).map(code => ({
                size: code, vcpu: SIZES[code].vcpu, memoryGiB: SIZES[code].memoryGiB, weight: SIZES[code].weight, arch: 'x86_64' as const,
                diskGiB: null })),
            disk: { provisionedGiB: disk.provisionedGiB, usedBytes: disk.usedBytes?.toString() ?? null, growsOnSwitch: false },
            standing: standing.standing, filesOn: standing.filesOn, heldSince: standing.heldSince, move: null },
        // Balance is filled from the AI Gateway by the caller; legacy plans grant nothing new.
        ai: { grant: plan.sku === 'legacy' ? { amount: 0, per: 'period' } : { ...plan.offer.aiCredits }, balance: null, state: 'unavailable',
            enrollment: 'enrolled', waiting: null,
            ...(input.ai ? { ...aiCreditBuckets({ plan, ...input.ai }), balance: creditNumber(input.ai.balanceMicro) } : {}) },
        fairUse: { status: fairUseStatusOf({ usedSeconds, fairUseSeconds: allowance }), resetsAt: plan.window.end },
        // Free has no provisioned disk: capBytes '0' with 'unavailable' (the pinned wire type is a string).
        storage: { usedBytes: (disk.usedBytes ?? BigInt(0)).toString(), capBytes: (disk.capBytes ?? BigInt(0)).toString(), state: disk.state },
        actions: { checkout: enabled && plan.family === 'free', topup: enabled,
            upgrade: enabled && plan.sku === 'standard_monthly_v3' && plan.status === 'active' && !pendingUpgrade && !scheduledChange && !paymentIssue,
            downgrade: enabled && plan.sku === 'premium_monthly_v3' && plan.status === 'active' && !pendingUpgrade && !scheduledChange && !paymentIssue,
            cancel: enabled && plan.subscriptionId !== null && plan.planActive && !pendingUpgrade,
            portal: enabled && input.hasCustomer, ezilId: null },
        catalog: { version: CATALOG_V3_VERSION, offers: publicOffers(),
            packs: (input.packs ?? []).filter(aiPackCheckoutEligible).map(({ sku, aiCredits, creditCents, discountPercent, totalCents }) => ({
                sku, aiCredits, creditCents, discountPercent, totalCents, currency: 'usd' })),
            customTopup: { ...CUSTOM_TOPUP } },
    };
}
