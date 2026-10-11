/**
 * Stripe event meaning, isolated from delivery and persistence (contract §5.1).
 * Actions carry provider facts, not entitlements or a user chosen from metadata.
 * The processor must re-read Stripe and resolve ownership through the customer
 * table before applying them. Invalid facts fail instead of becoming grants.
 */

export type StripeEventLike = {
    id: string;
    type: string;
    created: number;
    livemode: boolean;
    data: { object: Record<string, unknown> };
};

export type BillingAction =
    | { type: 'link_customer'; customerId: string; clientReferenceId: string; eventId: string }
    | { type: 'topup_paid'; paymentIntentId: string; customerId: string; sessionId: string; eventId: string }
    | {
        type: 'grant_period';
        invoiceId: string;
        subscriptionId: string;
        customerId: string;
        periodStart: Date;
        periodEnd: Date;
        eventId: string;
    }
    | { type: 'sync_subscription'; subscriptionId: string; eventId: string; eventCreated: Date }
    | { type: 'revoke'; chargeId: string; refundId: string; eventId: string }
    | { type: 'suspend' | 'restore'; chargeId: string; disputeId: string; eventId: string };

function object(value: unknown, path: string): Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError(`${path} must be an object`);
    }
    return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new TypeError(`${path} must be a non-empty string`);
    }
    return value;
}

/** Stripe references may be expanded; expansion must not change an action. */
function stripeId(value: unknown, path: string): string {
    if (typeof value === 'string') return text(value, path);
    return text(object(value, path).id, `${path}.id`);
}

function date(value: unknown, path: string): Date {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new TypeError(`${path} must be a non-negative Unix timestamp in seconds`);
    }
    const result = new Date(value * 1000);
    if (!Number.isFinite(result.getTime())) throw new TypeError(`${path} is outside the Date range`);
    return result;
}

function list(value: unknown, path: string): unknown[] {
    if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
    return value;
}

/** The 2025 API moved invoice ownership underneath parent.subscription_details. */
function invoiceSubscription(invoice: Record<string, unknown>): string | null {
    if (invoice.subscription != null) return stripeId(invoice.subscription, 'invoice.subscription');
    if (invoice.parent == null) return null;
    const parent = object(invoice.parent, 'invoice.parent');
    if (parent.subscription_details == null) return null;
    const details = object(parent.subscription_details, 'invoice.parent.subscription_details');
    return details.subscription == null
        ? null
        : stripeId(details.subscription, 'invoice.parent.subscription_details.subscription');
}

function lineSubscription(line: Record<string, unknown>, path: string): string | null {
    if (line.subscription != null) return stripeId(line.subscription, `${path}.subscription`);
    if (line.parent == null) return null;
    const parent = object(line.parent, `${path}.parent`);
    if (parent.subscription_item_details == null) return null;
    const details = object(parent.subscription_item_details, `${path}.parent.subscription_item_details`);
    return details.subscription == null
        ? null
        : stripeId(details.subscription, `${path}.parent.subscription_item_details.subscription`);
}

function topup(session: Record<string, unknown>, eventId: string): BillingAction {
    return {
        type: 'topup_paid',
        paymentIntentId: stripeId(session.payment_intent, 'checkout.session.payment_intent'),
        customerId: stripeId(session.customer, 'checkout.session.customer'),
        sessionId: text(session.id, 'checkout.session.id'),
        eventId,
    };
}

export function planStripeEvent(event: StripeEventLike): BillingAction[] {
    const envelope = object(event, 'event');
    const eventId = text(envelope.id, 'event.id');
    const eventType = text(envelope.type, 'event.type');
    const eventCreated = date(envelope.created, 'event.created');
    if (typeof envelope.livemode !== 'boolean') throw new TypeError('event.livemode must be a boolean');
    const payload = object(object(envelope.data, 'event.data').object, 'event.data.object');

    switch (eventType) {
        case 'checkout.session.completed': {
            const mode = text(payload.mode, 'checkout.session.mode');
            const paymentStatus = text(payload.payment_status, 'checkout.session.payment_status');
            // Only a session our own server created carries client_reference_id.
            // One without it (a Payment Link, a dashboard checkout) links
            // nothing: throwing would make Stripe retry it forever, and a
            // user is never chosen from metadata instead.
            const actions: BillingAction[] = [];
            const reference = payload.client_reference_id;
            if (typeof reference === 'string' && reference.trim() !== '' && payload.customer !== null && payload.customer !== undefined) {
                actions.push({
                    type: 'link_customer',
                    customerId: stripeId(payload.customer, 'checkout.session.customer'),
                    clientReferenceId: reference,
                    eventId,
                });
            }
            if (mode === 'payment' && paymentStatus === 'paid') actions.push(topup(payload, eventId));
            return actions;
        }
        case 'checkout.session.async_payment_succeeded':
            return [topup(payload, eventId)];
        case 'invoice.paid': {
            const subscriptionId = invoiceSubscription(payload);
            if (subscriptionId === null) return [];
            const lines = list(object(payload.lines, 'invoice.lines').data, 'invoice.lines.data');
            if (lines.length === 0) throw new TypeError('invoice.lines.data must contain a billing period');
            const records = lines.map((line, index) => object(line, `invoice.lines.data[${index}]`));
            const index = records.findIndex((line, index) => (
                lineSubscription(line, `invoice.lines.data[${index}]`) === subscriptionId
            ));
            // Some older payloads omit line ownership. The first line's period
            // remains the contract fallback, never the invoice's own period.
            const selectedIndex = index < 0 ? 0 : index;
            const path = `invoice.lines.data[${selectedIndex}].period`;
            const period = object(records[selectedIndex].period, path);
            const periodStart = date(period.start, `${path}.start`);
            const periodEnd = date(period.end, `${path}.end`);
            if (periodEnd <= periodStart) throw new TypeError(`${path}.end must be after its start`);
            return [{
                type: 'grant_period',
                invoiceId: text(payload.id, 'invoice.id'),
                subscriptionId,
                customerId: stripeId(payload.customer, 'invoice.customer'),
                periodStart,
                periodEnd,
                eventId,
            }];
        }
        case 'invoice.payment_failed': {
            const subscriptionId = invoiceSubscription(payload);
            return subscriptionId === null ? [] : [{ type: 'sync_subscription', subscriptionId, eventId, eventCreated }];
        }
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
            return [{
                type: 'sync_subscription',
                subscriptionId: text(payload.id, 'subscription.id'),
                eventId,
                eventCreated,
            }];
        case 'charge.refunded': {
            const refunds = list(object(payload.refunds, 'charge.refunds').data, 'charge.refunds.data');
            if (refunds.length === 0) throw new TypeError('charge.refunds.data must contain a refund');
            // One revoke per refund: the grant ledger is keyed by refund id, so a
            // second partial refund on the same charge is its own entry.
            const chargeId = text(payload.id, 'charge.id');
            return refunds.map((refund, index) => ({
                type: 'revoke' as const,
                chargeId,
                refundId: text(object(refund, `charge.refunds.data[${index}]`).id, `charge.refunds.data[${index}].id`),
                eventId,
            }));
        }
        case 'charge.dispute.created':
        case 'charge.dispute.closed': {
            const chargeId = stripeId(payload.charge, 'dispute.charge');
            const disputeId = text(payload.id, 'dispute.id');
            if (eventType === 'charge.dispute.closed' && text(payload.status, 'dispute.status') !== 'won') return [];
            return [{ type: eventType === 'charge.dispute.created' ? 'suspend' : 'restore', chargeId, disputeId, eventId }];
        }
        default:
            return [];
    }
}
