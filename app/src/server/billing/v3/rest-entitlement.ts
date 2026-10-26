import 'server-only';

import { aiMicroBalanceState } from '../ai-balance';
import { creditNumber } from '../ai-read';
import {
    readDelegatedAccountConfig, verifiedDelegatedAccount,
    type DelegatedAccountDeps, type VerifiedDelegatedAccount,
} from '../delegated-account';
import type { SubscriptionRow } from '../meters';
import type { BillingStore } from '../ports';
import { offerBySku, planFromSubscriptions } from './catalog';
import type { PlanSkuV3, PlanTierV3 } from './contract';

export interface RestEntitlement {
    plan: { sku: PlanSkuV3; tier: PlanTierV3; team: null };
    /** No canonical REST compute projection has been approved. */
    compute: null;
    ai: { balance: number; state: 'ok' | 'warning' | 'exhausted' } | null;
}

type PlanReader = {
    store: Pick<BillingStore, 'subscriptionsFor'>;
    now: () => Date;
};

export interface RestEntitlementDeps {
    delegation: DelegatedAccountDeps;
    /** Called only after Gateway verification, including the local issuer match. */
    billing: () => PlanReader | Promise<PlanReader>;
}

/** No summary, grant, Stripe, user provisioning, or compute reads. */
export function projectRestEntitlement(
    account: VerifiedDelegatedAccount, subs: SubscriptionRow[], now: Date,
): RestEntitlement | null {
    if (!Number.isFinite(now.getTime())) return null;
    const plan = planFromSubscriptions({ subs, now, userCreatedAt: null });
    // The catalog synthesizes Free when there is no selected subscription. A
    // delegated REST read must not claim that fallback is a persisted local plan.
    if (plan.subscriptionId === null || plan.sku === 'legacy' || plan.sku === 'free_v3') return null;
    const offer = offerBySku(plan.sku);
    if (!offer) return null;
    const wallet = account.wallet;
    let ai: RestEntitlement['ai'] = null;
    if (wallet.state === 'ok' || wallet.state === 'exhausted') {
        const balance = creditNumber(wallet.available_micro);
        const state = aiMicroBalanceState(wallet.available_micro, offer.aiCredits.amount);
        // Inconsistent or unrepresentable snapshots stay unknown. The exact C6
        // micro classifier decides exhaustion; a positive fraction is never zero.
        if (balance !== null && state !== 'unavailable'
            && (wallet.state === 'exhausted') === (state === 'exhausted')) {
            ai = { balance, state: state === 'low' ? 'warning' : state };
        }
    }
    return { plan: { sku: offer.sku, tier: offer.tier, team: null }, compute: null, ai };
}

function json(body: unknown, status: number): Response {
    return Response.json(body, { status, headers: { 'Cache-Control': 'no-store', Vary: 'Authorization' } });
}

function defaultDelegation(): DelegatedAccountDeps {
    return { config: readDelegatedAccountConfig() };
}

async function billingReader(): Promise<PlanReader> {
    // Even constructing the existing composition root is deferred until auth.
    const { getBillingDeps } = await import('../deps');
    return getBillingDeps();
}

export async function restEntitlement(
    request: Request,
    deps: RestEntitlementDeps = { delegation: defaultDelegation(), billing: billingReader },
): Promise<Response> {
    try {
        const verified = await verifiedDelegatedAccount(request, deps.delegation);
        if (!verified.ok) return json({ error: verified.error }, verified.status);
        if (request.signal.aborted) return json({ error: 'billing_entitlement_unavailable' }, 503);
        // This is a self-only endpoint. No query selector can choose another user.
        if (new URL(request.url).search) return json({ error: 'billing_entitlement_invalid_input' }, 400);
        const { store, now } = await deps.billing();
        if (request.signal.aborted) return json({ error: 'billing_entitlement_unavailable' }, 503);
        const subs = await store.subscriptionsFor(verified.account.identity.subject);
        if (request.signal.aborted) return json({ error: 'billing_entitlement_unavailable' }, 503);
        const projected = projectRestEntitlement(verified.account, subs, now());
        return projected ? json(projected, 200) : json({ error: 'billing_entitlement_unknown' }, 503);
    } catch {
        // Dependency exceptions can contain credentials or database details.
        return json({ error: 'billing_entitlement_unavailable' }, 503);
    }
}

/** Both team contracts are unapproved. Authenticate before reporting that fact. */
export async function teamBillingUnavailable(
    request: Request, deps: Pick<RestEntitlementDeps, 'delegation'> = { delegation: defaultDelegation() },
): Promise<Response> {
    try {
        const verified = await verifiedDelegatedAccount(request, deps.delegation);
        if (!verified.ok) return json({ error: verified.error }, verified.status);
        if (request.signal.aborted) return json({ error: 'delegated_account_unavailable' }, 503);
        return json({ error: 'team_billing_unavailable' }, 501);
    } catch {
        return json({ error: 'delegated_account_unavailable' }, 503);
    }
}
