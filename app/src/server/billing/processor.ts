/**
 * Stripe deliveries describe work to reconcile, not trusted ownership or
 * balances. Re-read provider state and use the customer mapping before every
 * effect; stable ledger/outbox keys let a retry finish an interrupted delivery.
 */
import { findPack, PRO_PLAN } from './catalog';
import type { BillingStore, ProcessorDeps, StripeSubscription, UsageEvent } from './ports';
import { planStripeEvent, type BillingAction, type StripeEventLike } from './stripe/events';
import { offerBySku } from './v2/catalog';
import { CATALOG_V2, GRANT_METER_COMPUTE, PERIOD_GRANT_BILLING_REASONS, UPGRADE_GRANT_BILLING_REASON } from './v2/contract';
import { upgradeGrantStdSeconds } from './v2/rating';

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

function validPeriod(start: Date | null, end: Date | null): boolean {
    return start !== null && end !== null && Number.isFinite(start.getTime())
        && Number.isFinite(end.getTime()) && end > start;
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
            if (invoice.status !== 'paid') return 'ignored';
            const eventCreated = new Date(event.created * 1000);
            if (invoice.metadataKind === 'overage') {
                const result = await store.setOverageInvoiceStatus(invoice.id, 'paid');
                await store.resolvePaymentIssue(invoice.id, eventCreated);
                return result === 'updated' ? 'applied' : 'ignored';
            }
            await store.resolvePaymentIssue(invoice.id, eventCreated);
            if (invoice.billingReason === null || invoice.billingReason === 'manual' || invoice.subscriptionId === null) return 'ignored';
            const subscription = await stripe.retrieveSubscription(invoice.subscriptionId);
            if (subscription.customer !== invoice.customer) return 'review:customer_mismatch';
            const userId = await store.userForStripeCustomer(invoice.customer);
            if (userId === null) return 'unattributed:customer';
            const offer = subscription.sku === null ? undefined : offerBySku(subscription.sku);
            if (!offer) return 'review:unknown_sku';

            if (PERIOD_GRANT_BILLING_REASONS.some(reason => reason === invoice.billingReason)) {
                if (offer.sku === PRO_PLAN.sku) {
                    const { periodStart, periodEnd } = invoice;
                    if (!validPeriod(periodStart, periodEnd)) return 'review:invalid_period';
                    await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
                    await store.insertGrant({
                        userId, meter: 'workspace_seconds', kind: 'pro_period',
                        amount: BigInt(PRO_PLAN.workspaceSeconds), periodStart, periodEnd,
                        sourceType: 'invoice', sourceId: invoice.id,
                    });
                    // Queue on replay too: a prior attempt may have stopped after the ledger write.
                    await store.enqueueOutbox({
                        eventKey: `invoice:${invoice.id}:ai_included`, userId, kind: 'ai_grant',
                        payload: {
                            amountUsdMicro: PRO_PLAN.aiIncludedMicro.toString(), bucket: 'included',
                            periodStart: periodStart!.toISOString(), periodEnd: periodEnd!.toISOString(),
                            provider: 'stripe', providerObjectId: invoice.id,
                        },
                    });
                } else {
                    const base = invoice.lines.find(line => offer.stripeLookupKey !== null
                        && line.lookupKey === offer.stripeLookupKey
                        && (line.subscriptionId === subscription.id || line.subscriptionId === null)
                        && validPeriod(line.periodStart, line.periodEnd));
                    if (!base) return 'review:no_base_line';
                    await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
                    await store.insertGrant({
                        userId, subscriptionId: subscription.id, meter: GRANT_METER_COMPUTE, kind: 'plan_period',
                        amount: BigInt(offer.allowanceStdSeconds), periodStart: base.periodStart, periodEnd: base.periodEnd,
                        sourceType: 'invoice', sourceId: invoice.id,
                    });
                }
                return 'applied';
            }
            if (invoice.billingReason === UPGRADE_GRANT_BILLING_REASON) {
                const ownedLines = invoice.lines.filter(line => line.subscriptionId === subscription.id || line.subscriptionId === null);
                const compute = ownedLines.find(line => line.lookupKey === CATALOG_V2.compute_monthly_v2.stripeLookupKey
                    && line.amount > 0 && validPeriod(line.periodStart, line.periodEnd));
                const credit = ownedLines.find(line => line.lookupKey === CATALOG_V2.standard_monthly_v2.stripeLookupKey);
                if (!compute || !credit) return 'ignored';
                const { currentPeriodStart: periodStart, currentPeriodEnd: periodEnd } = subscription;
                if (!validPeriod(periodStart, periodEnd)) return 'review:invalid_period';
                const effectiveAt = compute.periodStart!;
                const amount = upgradeGrantStdSeconds({
                    fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2',
                    periodStart: periodStart!.toISOString(), periodEnd: periodEnd!.toISOString(), effectiveAt: effectiveAt.toISOString(),
                });
                await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
                await store.insertGrant({
                    userId, subscriptionId: subscription.id, meter: GRANT_METER_COMPUTE, kind: 'upgrade_prorated',
                    amount: BigInt(amount), periodStart, periodEnd, sourceType: 'invoice', sourceId: invoice.id,
                });
                await store.setPlanChangeState({ subscriptionId: subscription.id, kind: 'upgrade', state: 'applied', effectiveAt });
                return 'applied';
            }
            return 'ignored';
        }
        case 'sync_subscription':
        case 'plan_change': {
            const subscription = await stripe.retrieveSubscription(action.subscriptionId);
            if (subscription.sku === null || !offerBySku(subscription.sku)) return 'review:unknown_sku';
            const userId = await store.userForStripeCustomer(subscription.customer);
            if (userId === null) return 'unattributed:customer';
            await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
            if (action.type === 'plan_change') {
                await store.setPlanChangeState({ subscriptionId: subscription.id, kind: 'upgrade', state: action.outcome });
            } else if (action.invoiceIssue) {
                return applyAction({ type: 'invoice_issue', ...action.invoiceIssue, eventCreated: action.eventCreated }, event, deps);
            }
            return 'applied';
        }
        case 'invoice_issue': {
            const invoice = await stripe.retrieveInvoice(action.invoiceId);
            const userId = await store.userForStripeCustomer(invoice.customer);
            if (userId === null) return 'unattributed:customer';
            const invoiceKind = invoice.metadataKind === 'overage' ? 'overage'
                : invoice.billingReason === UPGRADE_GRANT_BILLING_REASON ? 'upgrade' : 'subscription';
            const overage = invoiceKind === 'overage' ? await store.overageInvoiceByStripeId(invoice.id) : null;
            if (overage && overage.userId !== userId) return 'review:customer_mismatch';
            const subscriptionId = overage?.subscriptionId ?? invoice.subscriptionId;
            await store.recordPaymentIssue({
                stripeInvoiceId: invoice.id, userId, subscriptionId, invoiceKind, issue: action.issue,
                hostedInvoiceUrl: invoice.hostedInvoiceUrl, eventCreated: action.eventCreated,
            });
            if (invoiceKind === 'overage') {
                await store.setOverageInvoiceStatus(invoice.id, action.issue === 'voided' ? 'void' : action.issue);
                const consent = subscriptionId === null ? null : await store.latestConsent(userId, subscriptionId);
                if (consent?.enabled) {
                    await store.recordConsent({
                        userId, subscriptionId: consent.subscriptionId, enabled: false, capCents: consent.capCents,
                        termsVersion: consent.termsVersion, catalogVersion: consent.catalogVersion,
                        rateCentsPerStdHour: consent.rateCentsPerStdHour,
                        actor: 'system:overage_payment_issue', acceptedAt: action.eventCreated,
                    });
                }
            } else if (invoiceKind === 'upgrade' && subscriptionId !== null) {
                await store.setPlanChangeState({
                    subscriptionId, kind: 'upgrade', stripeInvoiceId: invoice.id,
                    state: action.issue === 'requires_action' ? 'requires_action' : 'payment_failed',
                });
            }
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
                return action.type === 'revoke' ? 'failed:no_grant_for_refund' : 'failed:no_grant_for_dispute';
            }
            if (originals.some(grant => grant.userId !== userId)) return 'review:customer_mismatch';
            const sourceType = action.type === 'revoke' ? 'refund' : 'dispute';
            const sourceId = action.type === 'revoke' ? action.refundId : action.disputeId;
            for (const original of originals) {
                await store.insertGrant({
                    userId, subscriptionId: original.subscriptionId, meter: original.meter, kind: action.type,
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
        if (result.startsWith('failed:') || (outcome === 'applied' && result !== 'applied')) outcome = result;
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
                if (event.type === 'heartbeat') {
                    const latest = await store.latestIntervalFor(event.computerId);
                    if (latest && latest.endedAt !== null) break;
                }
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
