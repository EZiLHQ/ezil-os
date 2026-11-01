import type { StripeAiPack } from '../stripe/packs';
import { aiPackCheckoutEligible, CUSTOM_TOPUP, storageCapBytes } from '../catalog';
import { checkoutAvailable } from '../config';
import { latestStorageTotal, storageState } from '../meters';
import type { GrantRow } from '../ports';
import { SIZES, type ComputeEpoch, type SizeCode, type Window } from '../v2/contract';
import { buildSummaryV2 } from '../v2/summary';
import { rateWindow } from '../v2/rating';
import { epochSeconds, isoSeconds } from '../v2/time';
import { fairUseStatusOf, HOLD_SIZE } from './admission';
import { planFromSubscriptions, publicOffers, type ResolvedPlanV3 } from './catalog';
import { CATALOG_V3_VERSION, type BillingSummaryV3, type ComputerReverseMoveV3, type ComputeStandingV3, type SellableSkuV3 } from './contract';
import { deriveStanding, paidAccess } from './standing';
import {
    reverseHoldOpenable, reverseMoveView, reverseMoveVisible, reverseTryAgainForbidden, type ReverseMovePlacementView,
} from '../../lib/compute/provider-reverse';
import { REVERSE_MOVE_HOLDING, type ComputeReverseMove } from '../../lib/compute/provider-reverse-store';
import { parseAiUpgradeEntitlement } from '../ai-credits';
import { aiMicroBalanceState, type AiGatewayGrant } from '../ai-balance';
import type { AiCreditReceipt } from '../ai-credit-outbox';
import { creditNumber } from '../ai-read';

const iso = (date: Date) => isoSeconds(epochSeconds(date));

/**
 * Round 5 D1: whole credits granted to an account that is not enrolled yet: stored grant receipts the
 * Gateway has not acknowledged, that have not expired and whose delivery has not failed terminally.
 * null when nothing waits or receipts are unreadable.
 */
function waitingCredits(receipts: readonly AiCreditReceipt[] | null, now: Date): { credits: number } | null {
    const credits = (receipts ?? []).reduce((sum, receipt) => receipt.deliveredAt === null && !receipt.failed
        && Date.parse(receipt.expiresAt) > now.getTime() ? sum + receipt.credits : sum, 0);
    return credits > 0 ? { credits } : null;
}
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

/**
 * Round 6 review (dunning into the hold): the plan the COMPUTER runs under. A paid subscription without paid
 * access (grace over, raw unpaid, never paid; STANDING-CONTRACT) runs the computer as Free, with Free's
 * calendar month, session cap and allowance, exactly as the start gate does (compute-access.ts
 * loadComputeBillingState). The plan block still names the subscription and its payment issue.
 */
export function computePlanV3(plan: ResolvedPlanV3, standing: ComputeStandingV3,
    input: Parameters<typeof planFromSubscriptions>[0]): ResolvedPlanV3 {
    if (plan.sku !== 'standard_monthly_v3' && plan.sku !== 'premium_monthly_v3') return plan;
    return paidAccess(standing) ? plan : planFromSubscriptions({ ...input, subs: [] });
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
    'state' | 'included' | 'purchased' | 'starter' | 'previous' | 'pendingFromRenewal'> {
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
    // Round 6 (R1-10/R4-05): an earlier period's or plan's grants (kept after a cancel until they expire), named
    // so "763 left" on Free can say where 663 of them came from and when they go. Earliest expiry, like purchased.
    const earlier = live('previous').sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt));
    const previous = known && earlier.length ? { remaining: credits(sum(earlier, 'remainingMicro')) ?? 0, expiresAt: earlier[0]!.expiresAt } : null;
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
    return { state, included, purchased, starter, previous, pendingFromRenewal };
}

const GIB = BigInt(1024) ** BigInt(3);

/** A live computer and its provider, as the router's placement read lists it (billing.ts `UserPlacement.computers`). */
export interface DiskComputer { computerId: string; provider: string | null }

/**
 * Round 5 D3: the disk shown when the computer's volume cannot be read (no AWS placement yet, AWS off,
 * a read error or timeout): the smallest paid new-volume size, so the figure never overclaims.
 */
export const DISK_FALLBACK_GIB = 50;

/** A volume size the summary may show: a whole, positive EBS size (the intent schema's bound); anything else is unreadable. */
function readableVolumeGiB(volumeGiB: number | null | undefined): number | null {
    return typeof volumeGiB === 'number' && Number.isInteger(volumeGiB) && volumeGiB >= 1 && volumeGiB <= 16384 ? volumeGiB : null;
}

/**
 * Round 5 D3: used space in GiB (bytes / 1024^3, one decimal), the unit of the GiB cap, so a full
 * 50 GiB disk reads 50 rather than 53.7 decimal GB. null when there is no valid measurement.
 */
export function usedGiBOf(usedBytes: bigint | string | null | undefined): number | null {
    let bytes: bigint;
    try {
        if (usedBytes === null || usedBytes === undefined || usedBytes === '') return null;
        bytes = typeof usedBytes === 'bigint' ? usedBytes : BigInt(usedBytes);
    } catch {
        return null;
    }
    if (bytes < BigInt(0)) return null;
    // Tenths of a GiB in integer math first: exact for any size, then one rounding step.
    const tenths = (bytes * BigInt(10) * BigInt(2) + GIB) / (GIB * BigInt(2));
    return Number(tenths) / 10;
}

/**
 * The real disk (round 3 D10, round 5 D3). AWS plans have one data volume per computer and a switch
 * keeps it, so the cap is that volume's REAL size (`volumeGiB`, read by the caller from EC2), never a
 * per-configuration table; unreadable falls back to `DISK_FALLBACK_GIB`. Free/Cloudflare has no
 * provisioned figure, so no cap is invented. Only legacy v1/v2 plans keep the v1 constant.
 *
 * The legacy meter is the per-user "Saved storage" allowance: every computer's latest sample, deleted
 * ones included until purged (CONTRACT.md §3.2). A v3 disk is one computer's disk, so it counts only
 * what can be on it: the samples of the user's LIVE computers (`liveComputers`, the router's placement
 * read) of the disk's kind, aws-ec2 ones on an AWS volume and the others (Cloudflare, or no placement
 * row yet) on a Cloudflare disk. A deleted computer's retained volume is on no disk the user can reach,
 * so it never fills this one. Omitted `liveComputers` (callers that read no placement) counts every sample.
 */
export function storageDisk(plan: ResolvedPlanV3, size: SizeCode, storage: readonly { computerId: string; bytes: bigint; measuredAt: Date }[],
    largeStorageEnabled: boolean, volumeGiB?: number | null, liveComputers?: readonly DiskComputer[]):
    { provisionedGiB: number | null; usedBytes: bigint | null; capBytes: bigint | null; state: BillingSummaryV3['storage']['state'] } {
    // Unmeasured is `unavailable` ("not measured yet"), never the `ok` of a zero nobody measured.
    const meter = (usedBytes: bigint | null, cap: bigint) => {
        if (usedBytes === null) return 'unavailable' as const;
        const state = storageState(usedBytes, cap);
        return state === 'over_cap' ? 'exhausted' as const : state;
    };
    if (plan.sku === 'legacy') {
        const { usedBytes } = latestStorageTotal(storage);
        const cap = storageCapBytes(plan.family === 'free' ? 'free' : 'pro', largeStorageEnabled);
        return { provisionedGiB: null, usedBytes, capBytes: cap, state: meter(usedBytes, cap) };
    }
    const aws = SIZES[size].provider === 'aws';
    const onDisk = liveComputers === undefined ? null : new Set(liveComputers
        .filter(computer => (computer.provider === 'aws-ec2') === aws).map(computer => computer.computerId.toLowerCase()));
    const { usedBytes } = latestStorageTotal(onDisk === null ? storage : storage.filter(sample => onDisk.has(sample.computerId.toLowerCase())));
    const provisionedGiB = aws ? readableVolumeGiB(volumeGiB) ?? DISK_FALLBACK_GIB : null;
    const capBytes = provisionedGiB === null ? null : BigInt(provisionedGiB) * GIB;
    return { provisionedGiB, usedBytes, capBytes, state: capBytes === null ? 'unavailable' : meter(usedBytes, capBytes) };
}

/**
 * Phase B (docs/compute/REVERSE-MOVE-CONTRACT.md §6.1.1): the move computer's reads, made by the router (billing.ts). Pure
 * here: no store, no placement query and no clock (visibility is the row's DB-clock age).
 */
export interface ReverseMoveSummaryInput {
    /** `reverseMovesTablePresent`: false (production today) → no move, no action. */
    tablePresent: boolean;
    /** The move computer's newest row (null: none). */
    row: ComputeReverseMove | null;
    /** The move computer's placement (instanceType: for `holdOpenable`). */
    placement: ReverseMovePlacementView | null;
    /** aws-config.ts: AWS computers enabled, and the admission kill switch (as `computer.move.start` reads them). */
    awsEnabled: boolean;
    killSwitchOn: boolean;
    /** §5.9.1: never an open-triggered move. */
    founderOwned: boolean;
}

/**
 * §6.1 / §6.1.1 derived fields. Omitted input → no key at all (today's output). `move` stays null for old shells.
 * - `reverseMove`: the newest row while it holds, or for 24 h on the DB clock after it ended.
 * - `moveOnOpen`: held here (files_on_aws on this aws-ec2 placement), **[r7 fixer]** the D16 hold can open it (`holdOpenable`:
 *   the trigger never fires for a held-closed computer), no row holds, the newest row is not a failure, not founder-owned, AWS
 *   on and the kill switch off. It picks the pre-move card's copy only; the trigger re-checks.
 * - `moveAvailable`: held here, AWS on, the kill switch off, and the newest row's failure does not forbid Try again.
 */
export function reverseMoveFields(input: ReverseMoveSummaryInput | undefined, standing: ComputeStandingV3):
    { reverseMove?: ComputerReverseMoveV3 | null; moveOnOpen?: boolean; moveAvailable?: boolean } {
    if (!input) return {};
    if (!input.tablePresent) return { reverseMove: null, moveOnOpen: false, moveAvailable: false };
    const { row, placement } = input;
    const held = standing === 'files_on_aws' && placement?.provider === 'aws-ec2';
    const live = input.awsEnabled && !input.killSwitchOn;
    const holding = !!row && REVERSE_MOVE_HOLDING.includes(row.state);
    const failed = row?.state === 'failed_reopened' || row?.state === 'failed_needs_operator';
    return {
        reverseMove: row && reverseMoveVisible(row) ? reverseMoveView(row, placement) : null,
        moveOnOpen: held && reverseHoldOpenable(placement) === true && live && !holding && !failed && !input.founderOwned,
        moveAvailable: held && live && !reverseTryAgainForbidden(row, placement),
    };
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
    /**
     * Round 5 D1: whether the account can receive AI credits (from the Works member lookup and the
     * stored EZiL ID subject, never the Gateway) and the EZiL ID sign-in link (null when EZiL ID
     * sign-in is off). Omitted = `enrolled`, no link (the W0 default).
     */
    enrollment?: { state: BillingSummaryV3['ai']['enrollment']; ezilIdUrl: string | null };
    /** Round 5 D3: the computer's real data-volume size in GiB (EC2 describeVolume); null/omitted = unreadable (fallback 50). */
    volumeGiB?: number | null;
    /** Round 6 (R4-02): the metered size of the user's AWS computer as placed; null/omitted = none, unreadable or mixed. */
    awsSize?: SizeCode | null;
    /** The user's live computers (`storageDisk`): the disk meter counts only their samples; omitted = every sample. */
    liveComputers?: readonly DiskComputer[];
    /** Phase B (§6.1.1): the move computer's reverse row and placement; omitted = today's output exactly (no new key). */
    reverseMove?: ReverseMoveSummaryInput;
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
    // Round 6 review: after a dunning cancel the computer runs as Free (window, session cap, allowance).
    const rated = computePlanV3(plan, standing.standing, input);
    const allowance = legacy?.compute.allowanceStdSeconds ?? fairUseAllowance(rated, input.grants, { grace: standing.standing === 'grace' });
    const bounds = { sessionMaxSeconds: rated.sessionMaxSeconds, allowanceStdSeconds: allowance };
    const usedSeconds = legacy?.compute.usedStdSeconds ?? usedSecondsInWindow(input.epochs, rated.window, input.now, bounds);
    // Round 4 D16: under the hold the computer that opens is the held AWS computer at HOLD_SIZE, not the
    // Free offer's Cloudflare size, so Billing agrees with the Computer and System tabs (2 vCPU / 8 GB).
    const size = legacy ? SIZES[legacy.compute.selectedSize] : rated.sku === 'legacy' ? SIZES[rated.offer.defaultSize]
        : standing.standing === 'files_on_aws' ? SIZES[HOLD_SIZE]
        : SIZES[input.sizePreference !== null && rated.offer.machineChoice.includes(input.sizePreference)
            ? input.sizePreference : rated.offer.size];
    const latest = input.epochs.filter(epoch => epoch.endedAt === null && epochSeconds(epoch.readyAt) <= epochSeconds(input.now))
        .sort((a, b) => Date.parse(b.readyAt) - Date.parse(a.readyAt))[0];
    // Recompute uncapped deadlines from period usage before this epoch. Old paid
    // epochs may still carry a 2/6-hour session deadline; it is no longer a limit.
    const priorUsage = latest && rated.sessionMaxSeconds === null ? usedSecondsInWindow(
        input.epochs.filter(epoch => epoch.id !== latest.id), rated.window, new Date(latest.readyAt), bounds) : 0;
    const fairDeadline = latest && rated.sessionMaxSeconds === null
        ? allowance <= priorUsage ? epochSeconds(input.now)
            : Math.max(epochSeconds(latest.readyAt, 'ceil'), epochSeconds(rated.window.start))
                + Math.floor((allowance - priorUsage) / latest.weight)
        : latest ? epochSeconds(input.now) + Math.floor(Math.max(0, allowance - usedSeconds) / latest.weight) : Infinity;
    const activeDeadline = legacy ? legacy.compute.session.activeDeadline : latest ? isoSeconds(Math.min(
        epochSeconds(latest.readyAt, 'ceil') + (rated.sessionMaxSeconds ?? Infinity),
        rated.sessionMaxSeconds === null || latest.deadlineAt == null ? Infinity : epochSeconds(latest.deadlineAt),
        fairDeadline,
    )) : null;
    const disk = storageDisk(rated, size.code, input.storage, input.config.largeStorageEnabled, input.volumeGiB, input.liveComputers);
    const enabled = checkoutAvailable(input.config) && input.stripeAvailable !== false;
    const enrollment = input.enrollment?.state ?? 'enrolled';
    return {
        enabled: true, version: 3,
        plan: { sku: plan.sku, name: plan.sku === 'legacy' ? plan.offer.family === 'pro_legacy' ? 'Pro (legacy)'
            : plan.offer.family === 'compute' ? 'Compute (legacy)' : 'Standard (legacy)' : plan.offer.name,
        status: pendingUpgrade && plan.planActive ? 'upgrade_pending' : plan.status,
        renewal: plan.renewsAt !== null ? input.renewal ?? null : null, cancelsAt: plan.cancelsAt,
        scheduledChange, pendingUpgrade, paymentIssue, graceEndsAt: standing.graceEndsAt, planEndsAt: standing.planEndsAt },
        computer: { size: size.code, vcpu: size.vcpu, memoryGiB: size.memoryGiB, sessionMaxSeconds: rated.sessionMaxSeconds,
            opening: rated.sku === 'legacy' ? 'standard' : rated.offer.opening, activeDeadline,
            machineChoice: (rated.sku === 'legacy' ? [size.code] : rated.offer.machineChoice).map(code => ({
                size: code, vcpu: SIZES[code].vcpu, memoryGiB: SIZES[code].memoryGiB, weight: SIZES[code].weight, arch: 'x86_64' as const,
                // D3 + the W0 pin: no per-configuration disk figure until a grow path exists (a switch keeps
                // the computer's volume); the plan disk is on the plan card (offer storageGiB) only.
                diskGiB: null })),
            disk: { provisionedGiB: disk.provisionedGiB, usedBytes: disk.usedBytes?.toString() ?? null, growsOnSwitch: false },
            standing: standing.standing, filesOn: standing.filesOn, heldSince: standing.heldSince, move: null,
            // Round 6 (R4-02): the placed AWS size, so Billing and Usage can say a held 4/8 vCPU computer stays closed.
            awsSize: input.awsSize && SIZES[input.awsSize]?.provider === 'aws'
                ? { size: input.awsSize, vcpu: SIZES[input.awsSize].vcpu, memoryGiB: SIZES[input.awsSize].memoryGiB } : null,
            // Phase B (§6.1): the move rides its own key; `move` above stays null so an old shell never renders it.
            ...reverseMoveFields(input.reverseMove, standing.standing) },
        // Balance is filled from the AI Gateway by the caller; legacy plans grant nothing new.
        ai: { grant: plan.sku === 'legacy' ? { amount: 0, per: 'period' } : { ...plan.offer.aiCredits }, balance: null, state: 'unavailable',
            enrollment, waiting: enrollment === 'enrolled' ? null : waitingCredits(input.ai?.receipts ?? null, input.now),
            ...(input.ai ? { ...aiCreditBuckets({ plan, ...input.ai }), balance: creditNumber(input.ai.balanceMicro) } : {}) },
        fairUse: { status: fairUseStatusOf({ usedSeconds, fairUseSeconds: allowance }), resetsAt: rated.window.end },
        // Free has no provisioned disk: capBytes '0' with 'unavailable' (the pinned wire type is a string).
        // No sample yet: usedBytes null with 'unavailable', never a measured-looking '0'.
        storage: { usedBytes: disk.usedBytes?.toString() ?? null, capBytes: (disk.capBytes ?? BigInt(0)).toString(), state: disk.state },
        // Round 5 D1: credits bought before enrollment would only wait, so top-up needs a Gateway member.
        actions: { checkout: enabled && plan.family === 'free', topup: enabled && enrollment === 'enrolled',
            upgrade: enabled && plan.sku === 'standard_monthly_v3' && plan.status === 'active' && !pendingUpgrade && !scheduledChange && !paymentIssue,
            downgrade: enabled && plan.sku === 'premium_monthly_v3' && plan.status === 'active' && !pendingUpgrade && !scheduledChange && !paymentIssue,
            cancel: enabled && plan.subscriptionId !== null && plan.planActive && !pendingUpgrade,
            portal: enabled && input.hasCustomer,
            ezilId: enrollment === 'needs_ezil_id' ? input.enrollment?.ezilIdUrl ?? null : null },
        // Round 6 (R1-06): the Free offer says the hours this account gets on Free (legacy 8 h today).
        catalog: { version: CATALOG_V3_VERSION, offers: publicOffers({ legacyFree: plan.legacyFree }),
            packs: (input.packs ?? []).filter(aiPackCheckoutEligible).map(({ sku, aiCredits, creditCents, discountPercent, totalCents }) => ({
                sku, aiCredits, creditCents, discountPercent, totalCents, currency: 'usd' })),
            customTopup: { ...CUSTOM_TOPUP } },
    };
}
