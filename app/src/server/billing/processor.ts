/**
 * Stripe deliveries describe work to reconcile, not trusted ownership or
 * balances. Re-read provider state and use the customer mapping before every
 * effect; stable ledger/outbox keys let a retry finish an interrupted delivery.
 */
import { findPack, PRO_PLAN } from './catalog';
import type { BillingStore, ProcessorDeps, StripeSubscription, UsageEvent } from './ports';
import { planStripeEvent, type BillingAction, type StripeEventLike } from './stripe/events';

function subscriptionRow(subscription: StripeSubscription, userId: string, created: number) {
    return {
        stripeSubscriptionId: subscription.id,
        userId,
        status: subscription.status,
        sku: subscription.sku!,
        currentPeriodStart: subscription.currentPeriodStart,
        currentPeriodEnd: subscription.currentPeriodEnd,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
        stripeEventCreated: new Date(created * 1000),
    };
}

/** Keep expiry stable across retries, including deliveries delayed for days. */
function purchasedPeriod(created: number) {
    const start = new Date(created * 1000);
    const end = new Date(start);
    end.setUTCFullYear(end.getUTCFullYear() + 1);
    // February 29 expires on February 28, rather than spilling into March.
    if (end.getUTCMonth() !== start.getUTCMonth()) end.setUTCDate(0);
    return { start, end };
}

async function applyAction(action: BillingAction, event: StripeEventLike, deps: ProcessorDeps): Promise<string> {
    const { store, stripe } = deps;
    switch (action.type) {
        case 'link_customer': {
            const sessionId = event.data.object.id;
            if (typeof sessionId !== 'string' || sessionId.trim() === '') return 'review:invalid_session';
            const session = await stripe.retrieveCheckoutSession(sessionId);
            if (session.sku === null) return 'review:unknown_sku';
            if (session.clientReferenceId !== action.clientReferenceId) return 'review:client_reference_mismatch';
            if (session.customer === null) return 'unattributed:customer';
            const result = await store.linkCustomer(action.clientReferenceId, session.customer);
            return result === 'conflict' ? 'review:customer_conflict' : 'applied';
        }
        case 'grant_period': {
            const invoice = await stripe.retrieveInvoice(action.invoiceId);
            if (invoice.status !== 'paid' || invoice.subscriptionId === null) return 'ignored';
            const subscription = await stripe.retrieveSubscription(invoice.subscriptionId);
            if (subscription.sku !== PRO_PLAN.sku) return 'review:unknown_sku';
            if (subscription.customer !== invoice.customer) return 'review:customer_mismatch';
            const userId = await store.userForStripeCustomer(invoice.customer);
            if (userId === null) return 'unattributed:customer';
            const { periodStart, periodEnd } = invoice;
            if (periodStart === null || periodEnd === null
                || !Number.isFinite(periodStart.getTime()) || !Number.isFinite(periodEnd.getTime())
                || periodEnd <= periodStart) return 'review:invalid_period';
            await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
            await store.insertGrant({
                userId, meter: 'workspace_seconds', kind: 'pro_period',
                amount: BigInt(PRO_PLAN.workspaceSeconds), periodStart, periodEnd,
                sourceType: 'invoice', sourceId: invoice.id,
            });
            // Queue even when the grant already exists: a prior attempt may
            // have failed between the ledger write and the outbox write.
            await store.enqueueOutbox({
                eventKey: `invoice:${invoice.id}:ai_included`, userId, kind: 'ai_grant',
                payload: {
                    amountUsdMicro: PRO_PLAN.aiIncludedMicro.toString(), bucket: 'included',
                    periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(),
                    provider: 'stripe', providerObjectId: invoice.id,
                },
            });
            return 'applied';
        }
        case 'sync_subscription': {
            const subscription = await stripe.retrieveSubscription(action.subscriptionId);
            if (subscription.sku !== PRO_PLAN.sku) return 'review:unknown_sku';
            const userId = await store.userForStripeCustomer(subscription.customer);
            if (userId === null) return 'unattributed:customer';
            await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
            return 'applied';
        }
        case 'topup_paid': {
            const session = await stripe.retrieveCheckoutSession(action.sessionId);
            if (session.mode !== 'payment' || session.paymentStatus !== 'paid') return 'ignored';
            const pack = session.sku === null ? undefined : findPack(session.sku);
            if (pack === undefined) return 'review:unknown_sku';
            if (session.customer === null) return 'unattributed:customer';
            const userId = await store.userForStripeCustomer(session.customer);
            if (userId === null) return 'unattributed:customer';
            if (session.paymentIntentId === null) return 'review:missing_payment_intent';
            const amount = BigInt(pack.creditCents) * BigInt(10_000);
            const period = purchasedPeriod(event.created);
            await store.insertGrant({
                userId, meter: 'ai_usd_micro', kind: 'topup', amount,
                periodStart: period.start, periodEnd: period.end,
                sourceType: 'payment_intent', sourceId: session.paymentIntentId,
            });
            await store.enqueueOutbox({
                eventKey: `payment_intent:${session.paymentIntentId}:ai_topup`, userId, kind: 'ai_grant',
                payload: {
                    amountUsdMicro: amount.toString(), bucket: 'purchased', expiresAt: period.end.toISOString(),
                    provider: 'stripe', providerObjectId: session.paymentIntentId,
                },
            });
            return 'applied';
        }
        case 'revoke':
        case 'suspend':
        case 'restore': {
            const charge = await stripe.retrieveCharge(action.chargeId);
            if (action.type === 'revoke' && charge.refunded !== true) return 'review:partial_refund';
            if (charge.customer === null) return 'unattributed:customer';
            const userId = await store.userForStripeCustomer(charge.customer);
            if (userId === null) return 'unattributed:customer';
            const originals = charge.invoiceId !== null
                ? await store.grantsBySource('invoice', charge.invoiceId)
                : charge.paymentIntentId !== null
                    ? await store.grantsBySource('payment_intent', charge.paymentIntentId)
                    : [];
            if (originals.length === 0) {
                return action.type === 'revoke' ? 'review:no_grant_for_refund' : 'review:no_grant_for_dispute';
            }
            if (originals.some(grant => grant.userId !== userId)) return 'review:customer_mismatch';
            const sourceType = action.type === 'revoke' ? 'refund' : 'dispute';
            const sourceId = action.type === 'revoke' ? action.refundId : action.disputeId;
            for (const original of originals) {
                await store.insertGrant({
                    userId, meter: original.meter, kind: action.type,
                    amount: action.type === 'restore' ? original.amount : -original.amount,
                    periodStart: original.periodStart, periodEnd: original.periodEnd,
                    sourceType, sourceId,
                });
            }
            // Pro's included AI lives only in the outbox, so its workspace
            // grant is also the receipt for reversing the included credit.
            const aiOriginal = originals.find(grant => grant.meter === 'ai_usd_micro')
                ?? originals.find(grant => grant.kind === 'pro_period');
            if (aiOriginal !== undefined) {
                const amount = aiOriginal.meter === 'ai_usd_micro' ? aiOriginal.amount : PRO_PLAN.aiIncludedMicro;
                await store.enqueueOutbox({
                    eventKey: `${sourceType}:${sourceId}:ai_${action.type}`,
                    userId, kind: action.type === 'restore' ? 'ai_grant' : 'ai_revoke',
                    payload: {
                        amountUsdMicro: amount.toString(),
                        bucket: aiOriginal.kind === 'pro_period' ? 'included' : 'purchased',
                        periodStart: aiOriginal.periodStart?.toISOString() ?? null,
                        periodEnd: aiOriginal.periodEnd?.toISOString() ?? null,
                        expiresAt: aiOriginal.periodEnd?.toISOString() ?? null,
                        provider: 'stripe', providerObjectId: sourceId,
                    },
                });
            }
            return 'applied';
        }
    }
}

/** Permanent payload defects are acknowledged; provider/store failures retry. */
export async function processStripeEvent(event: StripeEventLike, deps: ProcessorDeps): Promise<string> {
    let actions: BillingAction[];
    try {
        actions = planStripeEvent(event);
    } catch (error) {
        if (error instanceof TypeError) return 'review:invalid_event';
        throw error;
    }
    if (actions.length === 0) return 'ignored';
    let outcome = 'applied';
    for (const action of actions) {
        const result = await applyAction(action, event, deps);
        if (outcome === 'applied' && result !== 'applied') outcome = result;
    }
    return outcome;
}

/** Worker events may measure a computer, but cannot choose its billed owner. */
export async function ingestUsageEvents(events: UsageEvent[], deps: { store: BillingStore }): Promise<{ accepted: number; rejected: number }> {
    const { store } = deps;
    const latestAllowed = Date.now() + 5 * 60 * 1000;
    let accepted = 0;
    let rejected = 0;
    for (const event of events) {
        const userId = await store.computerOwner(event.computerId);
        const at = new Date(event.at);
        if (userId === null || !Number.isFinite(at.getTime()) || at.getTime() > latestAllowed) {
            rejected++;
            continue;
        }
        switch (event.type) {
            case 'start':
            case 'heartbeat':
                await store.openInterval(userId, event.computerId, at, event.type);
                await store.touchInterval(event.computerId, at);
                break;
            case 'stop':
                await store.closeInterval(event.computerId, at, event.reason ?? 'stop');
                break;
            case 'storage':
                if (typeof event.bytes !== 'string' || event.bytes === '' || /\D/.test(event.bytes)) {
                    rejected++;
                    continue;
                }
                await store.insertStorageSample(userId, {
                    computerId: event.computerId, bytes: BigInt(event.bytes), measuredAt: at, source: 'worker',
                });
                break;
            default:
                rejected++;
                continue;
        }
        accepted++;
    }
    return { accepted, rejected };
}
