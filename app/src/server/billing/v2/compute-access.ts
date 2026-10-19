import type { EntitlementReader } from '../../lib/compute/tier';
import { sizeForInstanceType } from '../../lib/compute/aws-config';
import type { BillingConfig } from '../config';
import { getBillingDeps } from '../deps';
import type { BillingDeps } from '../ports';
import { freeSkuFor, planFromSubscriptions } from './catalog';
import { CATALOG_V2, type ComputeEpoch, type AdmitDecision, type AdmitRefusal, type BillingSummaryV2, type PlanFamily, type PlanSku, type SizeCode, type Window } from './contract';
import { admitStart, rateWindow } from './rating';
import { buildSummaryV2, summaryMeters } from './summary';
import { epochSeconds, isoSeconds } from './time';

export interface ComputeBillingState {
    planSku: PlanSku;
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
    usedStdSeconds: number;
    allowanceStdSeconds: number;
    overage: { enabled: boolean; capCents: number } | null;
    summary: BillingSummaryV2;
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
        planSku: summary.plan.sku, family: plan.family, planActive: plan.planActive,
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
        state.planSku = freeSku;
        state.window = freeWindow;
        state.usedStdSeconds = rateWindow({ epochs: freeEpochs, window: freeWindow, now: isoSeconds(epochSeconds(now)) }).stdSeconds;
        state.allowanceStdSeconds = CATALOG_V2[freeSku].allowanceStdSeconds;
        state.overage = null;
    }
    return state;
}

function decideStart(state: ComputeBillingState, computerId: string, size: SizeCode, now: Date): AdmitDecision {
    return admitStart({
        planSku: state.planSku,
        // A delinquent subscription retains its status in state, but its Free
        // fallback is an active allowance for Cloudflare use.
        planActive: CATALOG_V2[state.planSku].family === 'free' || state.planActive,
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
}): Promise<'inactive' | 'error' | { status: 'opened' | 'exists' | 'concurrent'; deadlineAt: string | null; decision: AdmitDecision }> {
    if (!billingMeteringActive(deps.config)) return 'inactive';
    try {
        const state = await loadComputeBillingState(deps, userId, readyAt);
        const decision = decideStart(state, computerId, size, readyAt);
        // Anchor to readiness, not a preview request or a copied admission deadline.
        const deadlineAt = new Date(readyAt.getTime() + (decision.admit ? decision.maxRunSeconds : 0) * 1000);
        const opened = await deps.store.openEpoch({
            userId, computerId, subscriptionId: state.subscriptionId, size, readyAt, deadlineAt, overheadSeconds,
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
}): Promise<{ allowed: true; shadow?: AdmitDecision } | { allowed: false; reason: AdmitRefusal | 'billing_unavailable' }> {
    if (!billingMeteringActive(deps.config)) return { allowed: true };
    try {
        // Preview URLs are polled. An existing running session is never re-gated.
        if (await deps.store.openEpochFor(computerId)) return { allowed: true };
        const state = await loadComputeBillingState(deps, userId, now);
        // AWS opens resize to the entitled size: gating the old type would reject
        // a downgrade before the replacement can run, or under-rate an upgrade.
        // Paid plans omit free-cf. A paid user's pre-existing Cloudflare computer
        // uses std-2 for admission, with the same weight (1) and paid allowance.
        const size = kind === 'aws-ec2'
            ? state.provider === 'aws' ? state.entitledSize : instanceType !== null ? sizeForInstanceType(instanceType) : state.entitledSize
            : state.provider === 'aws' ? 'std-2' : 'free-cf';
        const decision: AdmitDecision = kind === 'aws-ec2' && state.paymentIssue
            ? { admit: false, reason: 'payment_issue' }
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
                status: state.paymentIssue ? 'past_due' : state.planActive ? 'active' : 'expired',
                size: state.entitledSize, provider: state.provider, paymentIssue: state.paymentIssue,
            };
        },
    };
}
