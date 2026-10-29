/**
 * Stripe deliveries describe work to reconcile, not trusted ownership or
 * balances. Re-read provider state and use the customer mapping before every
 * effect; stable ledger/outbox keys let a retry finish an interrupted delivery.
 */
import { schedulePaidMigration } from '../lib/compute/provider-migrate-orchestrator';
import { CUSTOM_TOPUP_SKU, customTopupPack, findPack, PRO_PLAN } from './catalog';
import type { BillingStore, ProcessorDeps, StripeInvoice, StripeSubscription, UsageEvent } from './ports';
import { stripePackCredits, stripePackSku } from './stripe/packs';
import { planStripeEvent, type BillingAction, type StripeEventLike } from './stripe/events';
import { billingOfferBySku as offerBySku, paidBillingOffers, upgradeGrantSeconds } from './v3/catalog';
import { CATALOG_V3 } from './v3/contract';
import { aiCreditEntitlement, aiCreditOutboxItem, aiTopupOutboxItem, aiUpgradeEntitlement, hasAiTopupReceipts, hasAiReversals } from './ai-credits';
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

/** Share eligibility and the selected upgrade line with missing-grant retries. */
function invoiceGrantKind(invoice: StripeInvoice):
    | { kind: 'period' | 'overage' | 'none' }
    | { kind: 'upgrade'; compute: StripeInvoice['lines'][number] } {
    if (invoice.metadataKind === 'overage') return { kind: 'overage' };
    if (invoice.status !== 'paid' || invoice.subscriptionId === null) return { kind: 'none' };
    if (PERIOD_GRANT_BILLING_REASONS.some(reason => reason === invoice.billingReason)) return { kind: 'period' };
    if (invoice.billingReason === UPGRADE_GRANT_BILLING_REASON) {
        const ownedLines = invoice.lines.filter(line => line.subscriptionId === invoice.subscriptionId || line.subscriptionId === null);
        const compute = ownedLines.find(line => (line.lookupKey === CATALOG_V2.compute_monthly_v2.stripeLookupKey
            || line.lookupKey === CATALOG_V3.premium_monthly_v3.stripeLookupKey)
            && line.amount > 0 && validPeriod(line.periodStart, line.periodEnd));
        const creditKey = compute?.lookupKey === CATALOG_V3.premium_monthly_v3.stripeLookupKey
            ? CATALOG_V3.standard_monthly_v3.stripeLookupKey : CATALOG_V2.standard_monthly_v2.stripeLookupKey;
        const credit = ownedLines.find(line => line.lookupKey === creditKey);
        if (compute && credit) return { kind: 'upgrade', compute };
    }
    return { kind: 'none' };
}

async function applyAction(action: BillingAction, event: StripeEventLike, deps: ProcessorDeps): Promise<string> {
    const { store, stripe } = deps;
    const paidGrant = async (input: Parameters<BillingStore['insertGrant']>[0], sku: string) => {
        await store.insertGrant(input);
        schedulePaidMigration(input.userId, sku, event.type);
    };
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
            const grant = invoiceGrantKind(invoice);
            const eventCreated = new Date(event.created * 1000);
            if (grant.kind === 'overage') {
                const result = await store.setOverageInvoiceStatus(invoice.id, 'paid');
                await store.resolvePaymentIssue(invoice.id, eventCreated);
                return result === 'updated' ? 'applied' : 'ignored';
            }
            if (invoice.billingReason === null || invoice.billingReason === 'manual' || invoice.subscriptionId === null) {
                await store.resolvePaymentIssue(invoice.id, eventCreated);
                return 'ignored';
            }
            const subscription = await stripe.retrieveSubscription(invoice.subscriptionId);
            if (subscription.customer !== invoice.customer) return 'review:customer_mismatch';
            const userId = await store.userForStripeCustomer(invoice.customer);
            if (userId === null) return 'unattributed:customer';
            const offer = subscription.sku === null ? undefined : offerBySku(subscription.sku);
            if (!offer) return 'review:unknown_sku';

            if (grant.kind === 'period') {
                if (offer.sku === PRO_PLAN.sku) {
                    const { periodStart, periodEnd } = invoice;
                    if (!validPeriod(periodStart, periodEnd)) return 'review:invalid_period';
                    const result = await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
                    if (result === 'conflict') return 'review:customer_mismatch';
                    await store.resolvePaymentIssue(invoice.id, eventCreated);
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
                    // Delayed invoices retain the offer sold for their own period,
                    // even when the subscription has since changed its price.
                    const bases = paidBillingOffers().flatMap(candidate => {
                        const base = invoice.lines.find(line => candidate.stripeLookupKey !== null
                            && line.lookupKey === candidate.stripeLookupKey
                            && (line.subscriptionId === subscription.id || line.subscriptionId === null)
                            && validPeriod(line.periodStart, line.periodEnd));
                        return base ? [{ base, offer: candidate }] : [];
                    });
                    if (bases.length === 0) return 'review:no_base_line';
                    if (bases.length > 1) return 'review:ambiguous_base_line';
                    const { base, offer: invoicedOffer } = bases[0];
                    const result = await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
                    if (result === 'conflict') return 'review:customer_mismatch';
                    await store.resolvePaymentIssue(invoice.id, eventCreated);
                    await paidGrant({
                        userId, subscriptionId: subscription.id, meter: GRANT_METER_COMPUTE, kind: 'plan_period',
                        amount: BigInt(invoicedOffer.allowanceStdSeconds), periodStart: base.periodStart, periodEnd: base.periodEnd,
                        sourceType: 'invoice', sourceId: invoice.id,
                    }, invoicedOffer.sku);
                    if (invoicedOffer.sku === 'standard_monthly_v3' || invoicedOffer.sku === 'premium_monthly_v3') {
                        await store.enqueueOutbox(aiCreditOutboxItem(userId, aiCreditEntitlement({
                            userId, sku: invoicedOffer.sku, subscriptionId: subscription.id,
                            periodStart: base.periodStart!, periodEnd: base.periodEnd, invoiceId: invoice.id,
                        }), 'grant', invoice.id));
                    }
                }
                return 'applied';
            }
            if (grant.kind === 'upgrade') {
                const { compute } = grant;
                const { currentPeriodStart: periodStart, currentPeriodEnd } = subscription;
                if (!validPeriod(periodStart, currentPeriodEnd)) return 'review:invalid_period';
                const effectiveAt = compute.periodStart!;
                const periodEnd = compute.periodEnd!;
                // A late upgrade invoice must not grant against a later renewal.
                if (Math.floor(periodEnd.getTime() / 1000) !== Math.floor(currentPeriodEnd!.getTime() / 1000)
                    || effectiveAt < periodStart! || effectiveAt >= periodEnd) return 'review:upgrade_period_mismatch';
                const amount = compute.lookupKey === CATALOG_V3.premium_monthly_v3.stripeLookupKey ? upgradeGrantSeconds({
                    periodStart: periodStart!.toISOString(), periodEnd: periodEnd.toISOString(), effectiveAt: effectiveAt.toISOString(),
                }) : upgradeGrantStdSeconds({
                    fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2',
                    periodStart: periodStart!.toISOString(), periodEnd: periodEnd.toISOString(), effectiveAt: effectiveAt.toISOString(),
                });
                // Round 3 D1: v3 Premium upgrades also add prorated AI credits; v2 Compute upgrades grant none.
                let aiUpgrade: ReturnType<typeof aiUpgradeEntitlement> | null = null;
                if (compute.lookupKey === CATALOG_V3.premium_monthly_v3.stripeLookupKey) {
                    try {
                        aiUpgrade = aiUpgradeEntitlement({ userId, subscriptionId: subscription.id, periodStart: periodStart!, periodEnd, effectiveAt });
                    } catch { return 'review:invalid_ai_upgrade'; }
                }
                const result = await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
                if (result === 'conflict') return 'review:customer_mismatch';
                await store.resolvePaymentIssue(invoice.id, eventCreated);
                await paidGrant({
                    userId, subscriptionId: subscription.id, meter: GRANT_METER_COMPUTE, kind: 'upgrade_prorated',
                    amount: BigInt(amount), periodStart, periodEnd, sourceType: 'invoice', sourceId: invoice.id,
                }, compute.lookupKey === CATALOG_V3.premium_monthly_v3.stripeLookupKey ? 'premium_monthly_v3' : 'compute_monthly_v2');
                // Queued after the compute grant, on replay too; the event key keeps it to one row.
                if (aiUpgrade && aiUpgrade.credits > 0) await store.enqueueOutbox(aiCreditOutboxItem(userId, aiUpgrade, 'grant', invoice.id));
                else if (aiUpgrade) logLine({ event: 'ai-upgrade-grant', outcome: 'skipped_zero', invoiceId: invoice.id });
                await store.setPlanChangeState({ userId, subscriptionId: subscription.id, kind: 'upgrade', state: 'applied', effectiveAt });
                return 'applied';
            }
            await store.resolvePaymentIssue(invoice.id, eventCreated);
            return 'ignored';
        }
        case 'sync_subscription':
        case 'plan_change': {
            const subscription = await stripe.retrieveSubscription(action.subscriptionId);
            if (subscription.sku === null || !offerBySku(subscription.sku)) return 'review:unknown_sku';
            const userId = await store.userForStripeCustomer(subscription.customer);
            if (userId === null) return 'unattributed:customer';
            const result = await store.upsertSubscription(subscriptionRow(subscription, userId, event.created));
            if (result === 'conflict') return 'review:customer_mismatch';
            if (result === 'applied') {
                const changes = await store.openPlanChanges(userId);
                const downgrade = changes.find(change => change.subscriptionId === subscription.id
                    && change.kind === 'downgrade' && change.state === 'scheduled' && change.toSku === subscription.sku);
                if (downgrade) await store.setPlanChangeState({
                    userId, subscriptionId: subscription.id, kind: 'downgrade', state: 'applied',
                    effectiveAt: subscription.currentPeriodStart,
                });
            }
            if (action.type === 'plan_change') {
                await store.setPlanChangeState({ userId, subscriptionId: subscription.id, kind: 'upgrade', state: action.outcome });
            } else if (action.invoiceIssue) {
                return applyAction({ type: 'invoice_issue', ...action.invoiceIssue, eventCreated: action.eventCreated }, event, deps);
            }
            return 'applied';
        }
        case 'invoice_issue': {
            const invoice = await stripe.retrieveInvoice(action.invoiceId);
            if (invoice.metadataKind !== 'overage' && invoice.subscriptionId === null) return 'ignored';
            let issue = action.issue;
            if (issue === 'payment_failed' || issue === 'requires_action') {
                if (invoice.status === 'paid') return 'ignored';
                const state = await stripe.retrieveInvoicePaymentState(invoice.id);
                if (state === 'paid' || state === 'processing') return 'ignored';
                // Same-second failed/action-required deliveries must converge on
                // the provider's current state, regardless of their write order.
                issue = state === 'requires_action' ? 'requires_action' : 'payment_failed';
            }
            const userId = await store.userForStripeCustomer(invoice.customer);
            if (userId === null) return 'unattributed:customer';
            const invoiceKind = invoice.metadataKind === 'overage' ? 'overage'
                : invoice.billingReason === UPGRADE_GRANT_BILLING_REASON ? 'upgrade' : 'subscription';
            const overage = invoiceKind === 'overage' ? await store.overageInvoiceByStripeId(invoice.id) : null;
            if (invoiceKind === 'overage' && overage === null) return 'review:unknown_overage_invoice';
            if (overage && overage.userId !== userId) return 'review:customer_mismatch';
            const subscriptionId = overage?.subscriptionId ?? invoice.subscriptionId;
            await store.recordPaymentIssue({
                stripeInvoiceId: invoice.id, userId, subscriptionId, invoiceKind, issue,
                hostedInvoiceUrl: invoice.hostedInvoiceUrl, eventCreated: action.eventCreated,
            });
            if (invoiceKind === 'overage') {
                await store.setOverageInvoiceStatus(invoice.id, issue === 'voided' ? 'void' : issue);
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
                    userId, subscriptionId, kind: 'upgrade', stripeInvoiceId: invoice.id,
                    state: issue === 'requires_action' ? 'requires_action' : 'payment_failed',
                });
            }
            return 'applied';
        }
        case 'topup_paid': {
            const session = await stripe.retrieveCheckoutSession(action.sessionId);
            if (session.mode !== 'payment' || session.paymentStatus !== 'paid') return 'ignored';
            const custom = session.sku === CUSTOM_TOPUP_SKU;
            let pack = custom ? customTopupPack(session.amountTotal ?? NaN)
                : session.sku === null ? undefined : findPack(session.sku);
            if (custom && (!pack || session.currency !== 'usd')) return 'review:invalid_custom_amount';
            if (custom && session.metadataCredits !== String(pack!.aiCredits)) return 'review:custom_credits_mismatch';
            if (session.customer === null) return 'unattributed:customer';
            const userId = await store.userForStripeCustomer(session.customer);
            if (userId === null) return 'unattributed:customer';
            if (session.paymentIntentId === null) return 'review:missing_payment_intent';
            if (!hasAiTopupReceipts(store)) return 'failed:ai_topup_receipts_unavailable';
            // The original policy and expiry win even if the catalog changes before a replay.
            if (await store.aiTopupReceipt(userId, session.paymentIntentId)) return 'applied';
            if (!custom && !pack && session.sku?.startsWith('ai_pack_')) {
                const lines = await stripe.retrieveCheckoutLineItems(session.id);
                const line = lines[0];
                if (lines.length !== 1 || line?.quantity !== 1 || !line.price?.productId) return 'review:invalid_pack_line';
                const product = await stripe.retrieveProduct(line.price.productId);
                const credits = stripePackCredits(product);
                if (credits === null || session.metadataCredits !== String(credits)) return 'review:pack_credits_mismatch';
                if (stripePackSku(product.id) !== session.sku) return 'review:unknown_sku';
                const face = credits * 10;
                if (line.price.type !== 'one_time' || line.price.currency !== 'usd' || line.price.unitAmount !== face)
                    return 'review:invalid_pack_price';
                if (session.currency !== 'usd' || !Number.isSafeInteger(session.amountTotal)
                    || session.amountTotal! < 0 || session.amountTotal! > face) return 'review:invalid_pack_amount';
                pack = { sku: session.sku, aiCredits: credits, creditCents: face, discountPercent: 0,
                    serviceFeeCents: 0, totalCents: session.amountTotal! };
            }
            if (!pack) return 'review:unknown_sku';
            const amount = BigInt(pack.creditCents) * BigInt(10_000);
            const period = purchasedPeriod(event.created);
            const receipt = aiTopupOutboxItem(userId, pack, session.paymentIntentId, period.end);
            if (!receipt) return 'review:pack_credits_unset';
            return store.recordAiTopup({
                userId, meter: 'ai_usd_micro', kind: 'topup', amount,
                periodStart: period.start, periodEnd: period.end,
                sourceType: 'payment_intent', sourceId: session.paymentIntentId,
            }, receipt);
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
                if (charge.invoiceId !== null) {
                    const invoice = await stripe.retrieveInvoice(charge.invoiceId);
                    const { kind } = invoiceGrantKind(invoice);
                    if (kind === 'overage') {
                        return action.type === 'revoke' ? 'review:refund_on_overage_invoice' : 'review:dispute_on_overage_invoice';
                    }
                    if (kind !== 'period' && kind !== 'upgrade') return 'ignored';
                } else if (charge.paymentIntentId === null) {
                    return 'ignored';
                }
                return action.type === 'revoke' ? 'failed:no_grant_for_refund' : 'failed:no_grant_for_dispute';
            }
            if (originals.some(grant => grant.userId !== userId)) return 'review:customer_mismatch';
            const topupReceipt = charge.invoiceId === null && charge.paymentIntentId !== null && hasAiTopupReceipts(store)
                ? await store.aiTopupReceipt(userId, charge.paymentIntentId) : null;
            const receipts = topupReceipt ? [topupReceipt]
                : charge.invoiceId !== null ? await store.aiCreditGrantsByInvoice?.(userId, charge.invoiceId) ?? [] : [];
            // A missing subscription outbox receipt can be reconstructed only for a reversal,
            // from the sold line and immutable local grant. Never reconstruct restore evidence.
            if (receipts.length === 0 && action.type !== 'restore' && charge.invoiceId !== null
                && originals.some(grant => grant.kind === 'plan_period' || grant.kind === 'upgrade_prorated')) {
                const invoice = await stripe.retrieveInvoice(charge.invoiceId);
                if (invoice.customer !== charge.customer) return 'review:customer_mismatch';
                // The upgrade root's instant is the sold Premium line's start, never the grant row's period start.
                const upgrade = invoiceGrantKind(invoice);
                for (const original of originals.filter(grant => grant.kind === 'upgrade_prorated')) {
                    if (upgrade.kind !== 'upgrade' || upgrade.compute.lookupKey !== CATALOG_V3.premium_monthly_v3.stripeLookupKey
                        || !original.subscriptionId || !original.periodStart || !original.periodEnd
                        || upgrade.compute.periodEnd?.getTime() !== original.periodEnd.getTime()) continue;
                    try {
                        const entitlement = aiUpgradeEntitlement({ userId, subscriptionId: original.subscriptionId,
                            periodStart: original.periodStart, periodEnd: original.periodEnd, effectiveAt: upgrade.compute.periodStart! });
                        if (entitlement.credits > 0) receipts.push(aiCreditOutboxItem(userId, entitlement, 'grant', invoice.id));
                    } catch { /* An invalid root never reconstructs a receipt. */ }
                }
                for (const original of originals.filter(grant => grant.kind === 'plan_period')) {
                    for (const sku of ['standard_monthly_v3', 'premium_monthly_v3'] as const) {
                        const line = invoice.lines.find(line => line.lookupKey === CATALOG_V3[sku].stripeLookupKey
                            && (line.subscriptionId === original.subscriptionId || line.subscriptionId === null)
                            && line.periodStart?.getTime() === original.periodStart?.getTime()
                            && line.periodEnd?.getTime() === original.periodEnd?.getTime());
                        if (line && original.subscriptionId && original.periodStart && original.periodEnd) {
                            receipts.push(aiCreditOutboxItem(userId, aiCreditEntitlement({
                                userId, sku, subscriptionId: original.subscriptionId, periodStart: original.periodStart,
                                periodEnd: original.periodEnd, invoiceId: invoice.id,
                            }), 'grant', invoice.id));
                        }
                    }
                }
            }
            if (action.type === 'restore' && charge.refunded) return 'review:restore_refused_terminal';
            if (receipts.length > 0) {
                if (!hasAiReversals(store)) return 'failed:ai_reversal_receipts_unavailable';
                return store.recordAiReversal({ action: action.type,
                    causeId: action.type === 'revoke' ? action.refundId : action.disputeId,
                    chargeId: charge.id, customerId: charge.customer, userId, originals, receipts });
            }
            // Legacy monetary rows have no canonical dispute/payer receipt. They cannot
            // justify a positive correction or a replay of a v1 grant as a restore.
            if (action.type === 'restore') return 'review:restore_receipt_missing';
            const sourceType = action.type === 'revoke' ? 'refund' : 'dispute';
            const sourceId = action.type === 'revoke' ? action.refundId : action.disputeId;
            for (const original of originals) {
                await store.insertGrant({
                    userId, subscriptionId: original.subscriptionId, meter: original.meter, kind: action.type,
                    amount: -original.amount,
                    periodStart: original.periodStart, periodEnd: original.periodEnd,
                    sourceType, sourceId,
                });
            }
            // Pro's included AI lives only in the outbox, so its workspace
            // grant is also the receipt for reversing the included credit.
            const aiOriginal = originals.find(grant => grant.meter === 'ai_usd_micro')
                ?? originals.find(grant => grant.kind === 'pro_period');
            if (aiOriginal !== undefined && !topupReceipt) {
                const amount = aiOriginal.meter === 'ai_usd_micro' ? aiOriginal.amount : PRO_PLAN.aiIncludedMicro;
                await store.enqueueOutbox({
                    eventKey: `${sourceType}:${sourceId}:ai_${action.type}`,
                    userId, kind: 'ai_revoke',
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

/** One structured JSON line per outcome; never payload values beyond ids and codes. */
function logLine(fields: Record<string, unknown>): void {
    console.info(JSON.stringify(fields));
}

/** Permanent payload defects are acknowledged; provider/store failures retry. */
export async function processStripeEvent(event: StripeEventLike, deps: ProcessorDeps): Promise<string> {
    const type = typeof event?.type === 'string' ? event.type : null;
    const eventId = typeof event?.id === 'string' ? event.id : null;
    let outcome: string;
    try {
        outcome = await processPlannedEvent(event, deps);
    } catch (error) {
        logLine({ event: 'billing-webhook', type, outcome: 'error', eventId });
        throw error;
    }
    logLine({ event: 'billing-webhook', type, outcome, eventId });
    return outcome;
}

async function processPlannedEvent(event: StripeEventLike, deps: ProcessorDeps): Promise<string> {
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
                // AWS lifecycle receipts own an AWS computer's epoch closes; a Worker stop may describe another generation.
                if (await store.placementProvider?.(event.computerId) === 'aws-ec2') {
                    console.info(JSON.stringify({ event: 'billing-usage-stop-ignored', computerId: event.computerId, at: event.at, provider: 'aws-ec2' }));
                    accepted++;
                    continue;
                }
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
        if (event.type === 'start') {
            await store.openEpoch({ userId, computerId: event.computerId, subscriptionId: null,
                size: 'free-cf', readyAt: at, overheadSeconds: 0 });
        } else if (event.type === 'heartbeat') {
            await store.touchEpoch(event.computerId, at);
        } else if (event.type === 'stop') {
            await store.closeEpoch({ computerId: event.computerId, readyBy: at, endedAt: at,
                reason: event.reason === 'idle' ? 'idle_sleep' : 'provider_stop' });
        }
        accepted++;
    }
    return { accepted, rejected };
}
