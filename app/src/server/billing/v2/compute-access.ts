import type { EntitlementReader } from '../../lib/compute/tier';
import { meteredSizeForInstanceType } from '../../lib/compute/aws-config';
import type { BillingConfig } from '../config';
import { getBillingDeps } from '../deps';
import type { BillingDeps } from '../ports';
import { freeSkuFor, planFromSubscriptions } from './catalog';
import { planFromSubscriptions as planV3 } from '../v3/catalog';
import { admitStart as admitStartV3, HOLD_SIZE } from '../v3/admission';
import { deriveStanding, paidAccess } from '../v3/standing';
import { buildSummaryV3, fairUseAllowance, usedSecondsInWindow } from '../v3/summary';
import { CATALOG_V3, type PlanSkuV3, type BillingSummaryV3, type AdmitDecisionV3, type AdmitRefusalV3 } from '../v3/contract';
import { CATALOG_V2, SESSION_MAX_SECONDS, type ComputeEpoch, type AdmitDecision, type AdmitRefusal, type BillingSummaryV2, type PlanFamily, type PlanSku, type SizeCode, type Window } from './contract';
import { admitStart } from './rating';
import { buildSummaryV2, summaryMeters } from './summary';
import { epochSeconds, isoSeconds } from './time';

export interface ComputeBillingState {
    planSku: PlanSku | PlanSkuV3;
    sessionMaxSeconds: number | null;
    v3?: { sku: PlanSkuV3; legacyFree: boolean };
    subscriptionId: string | null;
    openEpochs: readonly ComputeEpoch[];
    /** Subscription facts; the effective allowance below may fall back to Free. */
    family: PlanFamily;
    planActive: boolean;
    delinquent: boolean;
    paymentIssue: boolean;
    upgradePending: boolean;
    entitledSize: SizeCode;
    provider: 'cloudflare' | 'aws';
    window: Window;
    /** Standard seconds (actual running seconds multiplied by the epoch weight). */
    usedStdSeconds: number;
    allowanceStdSeconds: number;
    overage: { enabled: boolean; capCents: number } | null;
    summary: BillingSummaryV2 | BillingSummaryV3;
    /**
     * Round 6 R1-04 (v3 only): when Free began (a paid period or payment grace that ended); null while paid, or
     * when no time is recorded (an immediate cancel). A paid-era session still open on Free ends here.
     */
    freeSince?: string | null;
}

export function billingMeteringActive(config: Pick<BillingConfig, 'tabEnabled' | 'enforcementEnabled'>): boolean {
    return config.tabEnabled || config.enforcementEnabled;
}

/** The Billing tab's reads and arithmetic, without its storage/customer reads. */
export async function loadComputeBillingState(deps: BillingDeps, userId: string, now: Date): Promise<ComputeBillingState> {
    const [subs, userCreatedAt, planChanges] = await Promise.all([
        deps.store.subscriptionsFor(userId),
        deps.store.userCreatedAt(userId),
        deps.store.openPlanChanges(userId),
    ]);
    const resolved = planV3({ subs, now, userCreatedAt });
    if (resolved.sku !== 'legacy') {
        const [epochs, grants, paymentIssues, sizePreference] = await Promise.all([
            deps.store.epochsFor(userId, new Date(resolved.window.start)),
            deps.store.grantsForPeriod(userId, { start: new Date(resolved.window.start), end: new Date(resolved.window.end) }, summaryMeters(resolved.family)),
            deps.store.openPaymentIssues(userId),
            deps.store.sizePreference(userId),
        ]);
        const summary = buildSummaryV3({ config: deps.config, now, userCreatedAt, subs, epochs, grants, planChanges,
            paymentIssues, consent: null, storage: [], sizePreference, hasCustomer: false });
        // Round 4 D17: in grace the paid computer stays usable (the gate's payment refusal runs before
        // decideStart, so the state itself carries no payment issue); the Billing summary still reports it.
        const { standing } = deriveStanding({ subscriptions: subs, paymentIssues, placementProvider: null, now });
        const allowance = fairUseAllowance(resolved, grants, { grace: standing === 'grace' });
        const state: ComputeBillingState = {
            planSku: resolved.sku, v3: { sku: resolved.sku, legacyFree: resolved.legacyFree },
            sessionMaxSeconds: resolved.sessionMaxSeconds, subscriptionId: resolved.subscriptionId,
            openEpochs: epochs.filter(epoch => epoch.endedAt === null), family: resolved.family,
            planActive: resolved.planActive || standing === 'grace', delinquent: resolved.status === 'past_due' || resolved.status === 'incomplete',
            paymentIssue: standing !== 'grace' && summary.plan.paymentIssue !== null, upgradePending: summary.plan.pendingUpgrade !== null,
            entitledSize: summary.computer.size, provider: resolved.offer.provider, window: resolved.window,
            usedStdSeconds: usedSecondsInWindow(epochs, resolved.window, now, { sessionMaxSeconds: resolved.sessionMaxSeconds, allowanceStdSeconds: allowance }),
            allowanceStdSeconds: allowance, overage: null, summary,
            // deriveStanding reports the drop time (heldSince) only with files on AWS; it is the same for any placement.
            freeSince: paidAccess(standing) ? null
                : deriveStanding({ subscriptions: subs, paymentIssues, placementProvider: 'aws-ec2', now }).heldSince,
        };
        if (resolved.sku !== 'free_v3' && !paidAccess(standing)) {
            // D17/D18: grace over, raw unpaid or never paid (incomplete): Free now, with Free's window and limits
            // (mirrors the legacy fallback below). Free has no payment issue, so the D16 hold can still open.
            const free = CATALOG_V3.free_v3;
            const freeWindow = planV3({ subs: [], now, userCreatedAt }).window;
            const freeEpochs = new Date(freeWindow.start) < new Date(resolved.window.start)
                ? await deps.store.epochsFor(userId, new Date(freeWindow.start)) : epochs;
            const freeAllowance = resolved.legacyFree ? free.legacyFairUseSeconds ?? free.fairUseSeconds : free.fairUseSeconds;
            Object.assign(state, { planSku: 'free_v3', v3: { sku: 'free_v3', legacyFree: resolved.legacyFree },
                sessionMaxSeconds: free.sessionMaxSeconds, planActive: true, paymentIssue: false, entitledSize: free.size,
                provider: free.provider, window: freeWindow, allowanceStdSeconds: freeAllowance,
                usedStdSeconds: usedSecondsInWindow(freeEpochs, freeWindow, now, { sessionMaxSeconds: free.sessionMaxSeconds, allowanceStdSeconds: freeAllowance }),
            } satisfies Partial<ComputeBillingState>);
        }
        return state;
    }
    const plan = planFromSubscriptions({ subs, now, userCreatedAt });
    const window = { start: new Date(plan.window.start), end: new Date(plan.window.end) };
    const [epochs, grants, consent, paymentIssues, sizePreference] = await Promise.all([
        deps.store.epochsFor(userId, window.start),
        deps.store.grantsForPeriod(userId, window, summaryMeters(plan.family)),
        plan.subscriptionId === null ? null : deps.store.latestConsent(userId, plan.subscriptionId),
        deps.store.openPaymentIssues(userId),
        deps.store.sizePreference(userId),
    ]);
    const summary = buildSummaryV2({
        config: deps.config, now, userCreatedAt, subs, epochs, grants, consent, planChanges, paymentIssues,
        storage: [], sizePreference, hasCustomer: false,
    });
    const delinquent = plan.status === 'past_due' || plan.status === 'incomplete';
    // An unpaid overage invoice disables overage, not the paid subscription.
    const paymentIssue = delinquent || summary.plan.paymentIssue === 'payment_failed'
        || summary.plan.paymentIssue === 'requires_action';
    const paid = plan.family !== 'free' && plan.planActive && !paymentIssue;
    const state: ComputeBillingState = {
        sessionMaxSeconds: SESSION_MAX_SECONDS, planSku: summary.plan.sku, family: plan.family, planActive: plan.planActive,
        subscriptionId: plan.subscriptionId, openEpochs: epochs.filter(epoch => epoch.endedAt === null),
        delinquent, paymentIssue, upgradePending: summary.plan.pendingUpgrade !== null,
        entitledSize: paid ? summary.compute.selectedSize : 'free-cf',
        provider: paid ? 'aws' : 'cloudflare', window: plan.window,
        usedStdSeconds: summary.compute.usedStdSeconds, allowanceStdSeconds: summary.compute.allowanceStdSeconds,
        overage: summary.overage ? { enabled: summary.overage.enabled, capCents: summary.overage.capCents } : null,
        summary,
    };
    if (plan.family !== 'free' && paymentIssue) {
        const freeSku = freeSkuFor(userCreatedAt);
        const freeWindow = planFromSubscriptions({ subs: [], now, userCreatedAt }).window;
        // A paid period can start mid-month. Include the earlier month's usage in
        // the fallback without changing the paid-period summary shown in Billing.
        const freeEpochs = new Date(freeWindow.start) < window.start
            ? await deps.store.epochsFor(userId, new Date(freeWindow.start)) : epochs;
        state.planSku = 'free_v3';
        state.v3 = { sku: 'free_v3', legacyFree: freeSku === 'free_v1_legacy' };
        state.sessionMaxSeconds = CATALOG_V3.free_v3.sessionMaxSeconds;
        state.window = freeWindow;
        state.usedStdSeconds = usedSecondsInWindow(freeEpochs, freeWindow, now);
        state.allowanceStdSeconds = CATALOG_V2[freeSku].allowanceStdSeconds;
        state.overage = null;
    }
    return state;
}

function decideStart(state: ComputeBillingState, computerId: string, size: SizeCode, now: Date): AdmitDecision | AdmitDecisionV3 {
    if (state.v3) {
        const offer = CATALOG_V3[state.v3.sku];
        if (size !== 'free-cf' && state.paymentIssue) return { admit: false, reason: 'payment_issue' };
        const ceiling = state.v3.legacyFree ? offer.legacyFairUseSeconds ?? offer.fairUseSeconds : offer.fairUseSeconds;
        // Round 4 D16: on Free only an existing AWS computer rates std-2 (Cloudflare rates free-cf), so this is the
        // hold. Deciding it here keeps it for the second decideStart at readiness (openComputeEpochAtReady).
        const hold = state.v3.sku === 'free_v3' && size === HOLD_SIZE;
        return admitStartV3({ sku: state.v3.sku, legacyFree: state.v3.legacyFree, hold,
            // An existing Cloudflare machine consumes weight one on a paid plan.
            size: size === 'free-cf' && state.provider === 'aws' ? 'std-2' : size,
            planActive: state.v3.sku === 'free_v3' || state.planActive,
            paymentIssue: state.v3.sku === 'free_v3' ? size !== 'free-cf' && state.paymentIssue : state.paymentIssue,
            // Prorated receipts/reversals reserve the ungranted portion of the guardrail.
            usedSeconds: state.usedStdSeconds + Math.max(0, ceiling - state.allowanceStdSeconds),
            runningComputers: state.openEpochs.filter(epoch => epoch.computerId !== computerId).length,
            poolHostAvailable: false, now: isoSeconds(epochSeconds(now)) });
    }
    return admitStart({
        planSku: state.planSku as PlanSku,
        // A delinquent subscription retains its status in state, but its Free
        // fallback is an active allowance for Cloudflare use.
        planActive: CATALOG_V2[state.planSku as PlanSku].family === 'free' || state.planActive,
        paymentIssue: size !== 'free-cf' && state.paymentIssue,
        upgradePending: state.upgradePending, size,
        usedStdSeconds: state.usedStdSeconds, allowanceStdSeconds: state.allowanceStdSeconds, overage: state.overage,
        runningComputers: state.openEpochs.filter(epoch => epoch.computerId !== computerId).length,
        now: isoSeconds(epochSeconds(now)),
    });
}

/** Billing can record an immediately due epoch, but must never fail readiness. */
export async function openComputeEpochAtReady({ deps, userId, computerId, size, readyAt, overheadSeconds }: {
    deps: BillingDeps; userId: string; computerId: string; size: SizeCode; readyAt: Date; overheadSeconds: number;
}): Promise<'inactive' | 'error' | { status: 'opened' | 'exists' | 'concurrent'; deadlineAt: string | null; decision: AdmitDecision | AdmitDecisionV3 }> {
    if (!billingMeteringActive(deps.config)) return 'inactive';
    try {
        const state = await loadComputeBillingState(deps, userId, readyAt);
        const decision = decideStart(state, computerId, size, readyAt);
        // Anchor to readiness, not a preview request or a copied admission deadline.
        const deadlineAt = new Date(readyAt.getTime() + (decision.admit ? decision.maxRunSeconds : 0) * 1000);
        const opened = await deps.store.openEpoch({
            userId, computerId, subscriptionId: state.subscriptionId, size, readyAt, deadlineAt, overheadSeconds,
            ...(state.sessionMaxSeconds === null ? { sessionMaxSeconds: null } : {}),
        });
        if (opened.status === 'concurrent') console.info('[billing.epoch] concurrent', {
            userId, computerId, runningComputerId: opened.epoch.computerId,
        });
        return { status: opened.status, deadlineAt: opened.epoch.deadlineAt, decision };
    } catch (error) {
        console.warn('[billing.epoch] open failed', { userId, computerId, error });
        return 'error';
    }
}

export async function gateComputerStart({ deps, userId, computerId, kind, instanceType, now }: {
    deps: BillingDeps; userId: string; computerId: string; kind: 'cloudflare' | 'aws-ec2'; instanceType: string | null; now: Date;
}): Promise<{ allowed: true; shadow?: AdmitDecision | AdmitDecisionV3 } | { allowed: false; reason: AdmitRefusal | AdmitRefusalV3 | 'billing_unavailable' }> {
    if (!billingMeteringActive(deps.config)) return { allowed: true };
    try {
        // Preview URLs are polled. An existing running session is never re-gated.
        if (await deps.store.openEpochFor(computerId)) return { allowed: true };
        const state = await loadComputeBillingState(deps, userId, now);
        // AWS opens resize to the entitled size: gating the old type would reject
        // a downgrade before the replacement can run, or under-rate an upgrade.
        // A paid user's pre-existing Cloudflare computer uses the paid allowance:
        // billing rates its actual weight as std-2.
        const meteredSize = meteredSizeForInstanceType(instanceType);
        // Null means no machine selected yet. An explicitly unlisted type must
        // not borrow the entitlement's size, even when a resize is planned.
        const size = kind === 'aws-ec2'
            ? instanceType !== null && meteredSize === null ? null
                : state.provider === 'aws' ? state.entitledSize : instanceType !== null ? meteredSize : state.entitledSize
            : state.provider === 'aws' ? 'std-2' : 'free-cf';
        // Round 4 D16 (C8 hold): a Free user's existing AWS computer opens as std-2 under Free limits, never
        // resized; a larger one stays closed (files_on_aws). With no placement type (a Free canary) it is refused.
        const held = kind === 'aws-ec2' && !!state.v3 && state.provider !== 'aws' && instanceType !== null;
        const decision: AdmitDecision | AdmitDecisionV3 = size === null
            ? { admit: false, reason: 'size_not_allowed' }
            : kind === 'aws-ec2' && state.paymentIssue
            ? { admit: false, reason: 'payment_issue' }
            : held ? size === HOLD_SIZE ? decideStart(state, computerId, size, now) : { admit: false, reason: 'files_on_aws' }
            : kind === 'aws-ec2' && state.v3 && state.provider !== 'aws' ? { admit: false, reason: 'size_not_allowed' }
            : decideStart(state, computerId, size, now);
        if (!deps.config.enforcementEnabled) {
            console.info('[billing.gate] shadow', { userId, computerId, decision });
            return { allowed: true, shadow: decision };
        }
        return decision.admit ? { allowed: true } : { allowed: false, reason: decision.reason };
    } catch (error) {
        console.warn('[billing.gate] read failed', { userId, computerId, error });
        return deps.config.enforcementEnabled ? { allowed: false, reason: 'billing_unavailable' } : { allowed: true };
    }
}

export function billingV2EntitlementReader(getDeps: () => BillingDeps = getBillingDeps): EntitlementReader {
    return {
        async read(userId) {
            const deps = getDeps();
            // These tables are not installed in production while both flags are off.
            if (!billingMeteringActive(deps.config)) return null;
            const state = await loadComputeBillingState(deps, userId, deps.now());
            return {
                source: 'billing_v2', planId: state.planSku,
                // A provider-active subscription alone is not a paid compute entitlement.
                // Reuse the period-isolated grant/reversal calculation used for admission.
                status: state.paymentIssue ? 'past_due' : state.planActive && (state.provider !== 'aws' || state.allowanceStdSeconds > 0) ? 'active' : 'expired',
                size: state.entitledSize, provider: state.provider, paymentIssue: state.paymentIssue,
            };
        },
    };
}
