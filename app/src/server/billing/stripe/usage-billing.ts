import type { OverageInvoiceResult, UsageBillingPort } from '../ports';
import { OVERAGE_PRICE_LOOKUP_KEY } from '../v2/contract';
import { overageEligibility, overageIdempotencyKey } from '../v2/usage-billing';
import { createStripeClient, createStripeRequest, type InvoiceResponse, type StripeClientOptions } from './client';

function invoiced(invoice: InvoiceResponse): OverageInvoiceResult {
    return {
        status: 'invoiced', invoiceId: invoice.id, invoiceStatus: invoice.status,
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    };
}

/** Separate usage invoices never attach themselves to the subscription's invoice cycle. */
export function createStripeUsageBilling(opts: Pick<StripeClientOptions, 'secretKey' | 'fetch'>): UsageBillingPort {
    const request = createStripeRequest(opts);
    const stripe = createStripeClient(opts);

    return {
        async invoiceOverage(input, hooks) {
            const reason = overageEligibility(input);
            if (reason) return { status: 'skipped', reason };
            const key = overageIdempotencyKey(input.subscriptionId, input.periodStart, input.ratingVersion);
            let invoice: InvoiceResponse;
            if (input.existingInvoiceId) {
                invoice = await request<InvoiceResponse>(`/invoices/${encodeURIComponent(input.existingInvoiceId)}`);
                if (invoice.status !== 'draft') return invoiced(invoice);
            } else {
                const subscription = await stripe.retrieveSubscription(input.subscriptionId);
                invoice = await request<InvoiceResponse>('/invoices', {
                    customer: input.customerId,
                    pending_invoice_items_behavior: 'exclude',
                    collection_method: 'charge_automatically',
                    auto_advance: true,
                    default_payment_method: subscription.defaultPaymentMethod ?? undefined,
                    metadata: {
                        kind: 'overage', subscription: input.subscriptionId,
                        period_start: Math.floor(input.periodStart.getTime() / 1000),
                        period_end: Math.floor(input.periodEnd.getTime() / 1000),
                        rating_version: input.ratingVersion,
                    },
                }, `${key}:invoice`);
                // Persist this identity before line creation or finalization can produce webhooks.
                await hooks?.onDraftCreated?.(invoice.id);
                // An idempotent replay can return an invoice that has since been finalized.
                if (invoice.status !== 'draft') return invoiced(invoice);
            }

            const linePrices = (invoice.lines?.data ?? []).map(line => line.pricing?.price_details?.price ?? line.price);
            const hasOverageKey = linePrices.some(price => typeof price === 'object' && price?.lookup_key === OVERAGE_PRICE_LOOKUP_KEY);
            if (!hasOverageKey) {
                const price = await stripe.resolvePrice(OVERAGE_PRICE_LOOKUP_KEY);
                const hasOveragePrice = linePrices.some(value => (typeof value === 'string' ? value : value?.id) === price.id);
                if (!hasOveragePrice) {
                    await request('/invoiceitems', {
                        customer: input.customerId, invoice: invoice.id,
                        pricing: { price: price.id }, quantity: input.cents, metadata: { kind: 'overage' },
                    }, `${key}:item`);
                }
            }
            return invoiced(await request<InvoiceResponse>(`/invoices/${encodeURIComponent(invoice.id)}/finalize`, {
                auto_advance: true,
            }, `${key}:finalize`));
        },
    };
}
