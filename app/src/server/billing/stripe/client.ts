import { findPack, PRO_PLAN } from '../catalog';
import type { StripeApi, StripeCheckoutSession } from '../ports';

const STRIPE_BASE_URL = 'https://api.stripe.com/v1';
/** Pin the response schema independently of the Stripe account's default version. */
const STRIPE_API_VERSION = '2025-09-30.clover';

type FormValue = string | number | boolean | undefined | FormValue[] | { [key: string]: FormValue };
type FormFields = { [key: string]: FormValue };
type StripeReference = string | { id: string } | null;
type Metadata = { sku?: string };

interface SubscriptionResponse {
    id: string;
    customer: StripeReference;
    status: string;
    cancel_at_period_end: boolean;
    current_period_start?: number | null;
    current_period_end?: number | null;
    items?: { data: { current_period_start?: number | null; current_period_end?: number | null }[] };
    metadata?: Metadata | null;
}

interface InvoiceLine {
    type?: string;
    subscription?: StripeReference;
    parent?: {
        type?: string;
        subscription_item_details?: { subscription?: StripeReference } | null;
    } | null;
    period?: { start?: number | null; end?: number | null } | null;
}

interface InvoiceResponse {
    id: string;
    customer: StripeReference;
    status: string;
    subscription?: StripeReference;
    parent?: { subscription_details?: { subscription?: StripeReference } | null } | null;
    lines?: { data: InvoiceLine[] };
}

interface CheckoutResponse {
    id: string;
    customer?: StripeReference;
    client_reference_id?: string | null;
    mode: StripeCheckoutSession['mode'];
    status: StripeCheckoutSession['status'];
    payment_status: StripeCheckoutSession['paymentStatus'];
    payment_intent?: StripeReference;
    metadata?: Metadata | null;
}

interface ChargeResponse {
    id: string;
    customer?: StripeReference;
    invoice?: StripeReference;
    payment_intent?: StripeReference;
    amount: number;
    amount_refunded: number;
    refunded: boolean;
}

/** Stripe messages can echo request data; expose status and machine codes instead. */
export class StripeRequestError extends Error {
    constructor(public status: number, public code: string | null, public type: string | null) {
        super(`Stripe request failed (HTTP ${status})`);
        this.name = 'StripeRequestError';
    }
}

/** Bracket notation preserves nested Stripe parameters, including indexed line items. */
function formBody(fields: FormFields): URLSearchParams {
    const body = new URLSearchParams();
    function append(key: string, value: FormValue): void {
        if (value === undefined) return;
        if (Array.isArray(value)) {
            value.forEach((item, index) => append(`${key}[${index}]`, item));
        } else if (typeof value === 'object') {
            for (const [name, item] of Object.entries(value)) append(`${key}[${name}]`, item);
        } else {
            body.append(key, String(value));
        }
    }
    for (const [key, value] of Object.entries(fields)) append(key, value);
    return body;
}

function referenceId(value: StripeReference | undefined): string | null {
    return typeof value === 'string' ? value : value?.id ?? null;
}

function requiredCustomer(value: StripeReference): string {
    const id = referenceId(value);
    if (id === null) throw new TypeError('Stripe response is missing its customer');
    return id;
}

function date(value: number | null | undefined): Date | null {
    return value == null ? null : new Date(value * 1000);
}

function record(value: unknown): Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
}

function lineSubscription(line: InvoiceLine): string | null {
    return referenceId(line.subscription ?? line.parent?.subscription_item_details?.subscription);
}

export function createStripeClient(opts: {
    secretKey: string;
    fetch?: typeof fetch;
    priceProMonthly?: string;
    apiVersion?: string;
}): StripeApi {
    const fetcher = opts.fetch ?? globalThis.fetch;

    async function request<T>(path: string, fields?: FormFields, idempotencyKey?: string): Promise<T> {
        const headers = new Headers({
            Authorization: `Bearer ${opts.secretKey}`,
            'Stripe-Version': opts.apiVersion ?? STRIPE_API_VERSION,
        });
        if (fields !== undefined) headers.set('Content-Type', 'application/x-www-form-urlencoded');
        if (idempotencyKey !== undefined) headers.set('Idempotency-Key', idempotencyKey);
        const response = await fetcher(`${STRIPE_BASE_URL}${path}`, {
            method: fields === undefined ? 'GET' : 'POST',
            headers,
            body: fields === undefined ? undefined : formBody(fields),
        });
        if (!response.ok) {
            // A non-JSON upstream failure still has a useful HTTP status. Never
            // include its body, status text or request headers in the message.
            const payload: unknown = await response.json().catch(() => null);
            const error = record(record(payload).error);
            throw new StripeRequestError(
                response.status,
                typeof error.code === 'string' ? error.code : null,
                typeof error.type === 'string' ? error.type : null,
            );
        }
        return response.json() as Promise<T>;
    }

    return {
        async createCustomer(input) {
            const customer = await request<{ id: string }>('/customers', {
                // Informational only: ownership is resolved through the local customer table.
                metadata: { user_id: input.userId },
                email: input.email ?? undefined,
            }, input.idempotencyKey);
            return { id: customer.id };
        },

        async createCheckoutSession(input) {
            const pack = findPack(input.sku);
            if (input.sku !== PRO_PLAN.sku && pack === undefined) throw new Error('Unknown billing SKU');

            const fields: FormFields = {
                customer: input.customerId,
                client_reference_id: input.userId,
                metadata: { sku: input.sku },
                automatic_tax: { enabled: true },
                customer_update: { address: 'auto' },
                billing_address_collection: 'required',
                success_url: input.successUrl,
                cancel_url: input.cancelUrl,
                allow_promotion_codes: false,
            };
            if (input.sku === PRO_PLAN.sku) {
                fields.mode = 'subscription';
                fields.line_items = [{
                    quantity: 1,
                    ...(opts.priceProMonthly !== undefined ? { price: opts.priceProMonthly } : {
                        price_data: {
                            currency: PRO_PLAN.currency,
                            unit_amount: PRO_PLAN.unitAmountCents,
                            recurring: { interval: PRO_PLAN.interval },
                            tax_behavior: 'exclusive',
                            product_data: { name: 'EZiL Pro' },
                        },
                    }),
                }];
                fields.subscription_data = { metadata: { sku: PRO_PLAN.sku } };
            } else if (pack !== undefined) {
                fields.mode = 'payment';
                fields.line_items = [
                    { name: 'AI credits', amount: pack.creditCents },
                    { name: 'Service fee', amount: pack.serviceFeeCents },
                ].map(item => ({
                    quantity: 1,
                    price_data: {
                        currency: 'usd',
                        unit_amount: item.amount,
                        tax_behavior: 'exclusive',
                        product_data: { name: item.name },
                    },
                }));
                fields.payment_intent_data = { metadata: { sku: pack.sku } };
            }
            const session = await request<{ id: string; url: string }>('/checkout/sessions', fields, input.idempotencyKey);
            return { id: session.id, url: session.url };
        },

        async createPortalSession(input) {
            // The portal port has no retry key: each call creates a new short-lived session.
            const session = await request<{ url: string }>('/billing_portal/sessions', {
                customer: input.customerId,
                return_url: input.returnUrl,
            });
            return { url: session.url };
        },

        async retrieveSubscription(id) {
            const subscription = await request<SubscriptionResponse>(`/subscriptions/${encodeURIComponent(id)}`);
            const item = subscription.items?.data[0];
            return {
                id: subscription.id,
                customer: requiredCustomer(subscription.customer),
                status: subscription.status,
                cancelAtPeriodEnd: subscription.cancel_at_period_end,
                currentPeriodStart: date(subscription.current_period_start ?? item?.current_period_start),
                currentPeriodEnd: date(subscription.current_period_end ?? item?.current_period_end),
                sku: subscription.metadata?.sku ?? null,
            };
        },

        async retrieveInvoice(id) {
            const invoice = await request<InvoiceResponse>(`/invoices/${encodeURIComponent(id)}`);
            const subscriptionId = referenceId(invoice.subscription ?? invoice.parent?.subscription_details?.subscription);
            const lines = invoice.lines?.data ?? [];
            // An invoice can start with a fee or adjustment. Only its subscription
            // line describes the entitlement window, never invoice.period_start/end.
            const line = subscriptionId === null ? undefined : (
                lines.find(item => lineSubscription(item) === subscriptionId)
                ?? lines.find(item => lineSubscription(item) === null && (
                    item.type === 'subscription' || item.parent?.type === 'subscription_item_details'
                ))
            );
            return {
                id: invoice.id,
                customer: requiredCustomer(invoice.customer),
                status: invoice.status,
                subscriptionId,
                periodStart: date(line?.period?.start),
                periodEnd: date(line?.period?.end),
            };
        },

        async retrieveCheckoutSession(id) {
            const session = await request<CheckoutResponse>(`/checkout/sessions/${encodeURIComponent(id)}`);
            return {
                id: session.id,
                customer: referenceId(session.customer),
                clientReferenceId: session.client_reference_id ?? null,
                mode: session.mode,
                status: session.status,
                paymentStatus: session.payment_status,
                paymentIntentId: referenceId(session.payment_intent),
                sku: session.metadata?.sku ?? null,
            };
        },

        async retrieveCharge(id) {
            const charge = await request<ChargeResponse>(`/charges/${encodeURIComponent(id)}`);
            return {
                id: charge.id,
                customer: referenceId(charge.customer),
                invoiceId: referenceId(charge.invoice),
                paymentIntentId: referenceId(charge.payment_intent),
                amount: charge.amount,
                amountRefunded: charge.amount_refunded,
                refunded: charge.refunded,
            };
        },
    };
}
