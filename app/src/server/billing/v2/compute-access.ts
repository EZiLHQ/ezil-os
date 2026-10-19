import type { EntitlementReader } from '../../lib/compute/tier';
import type { BillingConfig } from '../config';
import { getBillingDeps } from '../deps';
import type { BillingDeps } from '../ports';
import { freeSkuFor, planFromSubscriptions } from './catalog';
import { CATALOG_V2, type BillingSummaryV2, type PlanFamily, type PlanSku, type SizeCode, type Window } from './contract';
import { rateWindow } from './rating';
import { buildSummaryV2, summaryMeters } from './summary';
import { epochSeconds, isoSeconds } from './time';

export interface ComputeBillingState {
    planSku: PlanSku;
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
    const paymentIssue = summary.plan.paymentIssue !== null;
    const paid = plan.family !== 'free' && plan.planActive && !paymentIssue;
    const state: ComputeBillingState = {
        planSku: summary.plan.sku, family: plan.family, planActive: plan.planActive,
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
