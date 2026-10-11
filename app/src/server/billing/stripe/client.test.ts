import { describe, expect, it, vi } from 'vitest';

import type { CheckoutRequest } from '../ports';
import { createStripeClient, StripeRequestError } from './client';

const secretKey = 'sk_test_client_fixture';
const start = 1_799_000_000;
const end = 1_801_000_000;
const checkoutResult = { id: 'cs_fixture', url: 'https://checkout.stripe.com/fixture' };
const checkoutRequest: CheckoutRequest = {
    customerId: 'cus_fixture',
    userId: 'user_fixture',
    sku: 'pro_monthly_v1',
    successUrl: 'https://example.com/billing/return?session_id={CHECKOUT_SESSION_ID}&source=billing',
    cancelUrl: 'https://example.com/settings?tab=billing',
    idempotencyKey: 'checkout_fixture',
};
const customerRequest = { userId: 'user_fixture', email: 'billing+test@example.com', idempotencyKey: 'customer_fixture' };

function fixture(payload: unknown, opts: { priceProMonthly?: string; apiVersion?: string } = {}) {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(payload));
    const client = createStripeClient({ secretKey, fetch: fetcher, ...opts });
    return { client, fetcher };
}

function inspect(fetcher: ReturnType<typeof fixture>['fetcher'], index = 0) {
    const [url, init] = fetcher.mock.calls[index];
    const body = new URLSearchParams(String(init?.body ?? ''));
    return { url, init, headers: new Headers(init?.headers), body: Object.fromEntries(body), size: body.size };
}

function commonCheckout(sku = checkoutRequest.sku) {
    return {
        customer: checkoutRequest.customerId,
        client_reference_id: checkoutRequest.userId,
        'metadata[sku]': sku,
        'automatic_tax[enabled]': 'true',
        'customer_update[address]': 'auto',
        billing_address_collection: 'required',
        success_url: checkoutRequest.successUrl,
        cancel_url: checkoutRequest.cancelUrl,
        allow_promotion_codes: 'false',
    };
}

function inlinePro() {
    return {
        ...commonCheckout(),
        mode: 'subscription',
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': '2000',
        'line_items[0][price_data][recurring][interval]': 'month',
        'line_items[0][price_data][tax_behavior]': 'exclusive',
        'line_items[0][price_data][product_data][name]': 'EZiL Pro',
        'subscription_data[metadata][sku]': 'pro_monthly_v1',
    };
}

const subscription = {
    id: 'sub_fixture', customer: 'cus_fixture', status: 'active', cancel_at_period_end: true,
    metadata: { sku: 'pro_monthly_v1', user_id: 'untrusted_user' },
};
const expectedSubscription = {
    id: 'sub_fixture', customer: 'cus_fixture', status: 'active', cancelAtPeriodEnd: true,
    currentPeriodStart: new Date(start * 1000), currentPeriodEnd: new Date(end * 1000), sku: 'pro_monthly_v1',
};
const invoice = { id: 'in_fixture', customer: 'cus_fixture', status: 'paid', period_start: 10, period_end: 20 };
const expectedInvoice = {
    id: 'in_fixture', customer: 'cus_fixture', status: 'paid', subscriptionId: 'sub_fixture',
    periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000),
};
const session = {
    id: 'cs_fixture', customer: 'cus_fixture', client_reference_id: 'user_fixture',
    mode: 'payment', status: 'complete', payment_status: 'paid', payment_intent: 'pi_fixture',
    metadata: { sku: 'ai_pack_10_v1', user_id: 'untrusted_user' },
};
const expectedSession = {
    id: 'cs_fixture', customer: 'cus_fixture', clientReferenceId: 'user_fixture',
    mode: 'payment', status: 'complete', paymentStatus: 'paid', paymentIntentId: 'pi_fixture', sku: 'ai_pack_10_v1',
};
const charge = {
    id: 'ch_fixture', customer: 'cus_fixture', invoice: 'in_fixture', payment_intent: 'pi_fixture',
    amount: 1084, amount_refunded: 500, refunded: false,
};
const expectedCharge = {
    id: 'ch_fixture', customer: 'cus_fixture', invoiceId: 'in_fixture', paymentIntentId: 'pi_fixture',
    amount: 1084, amountRefunded: 500, refunded: false,
};

describe('createStripeClient requests', () => {
    it('creates a customer with informational metadata and an optional email', async () => {
        const { client, fetcher } = fixture({ id: 'cus_fixture', metadata: { user_id: 'untrusted_user' } });
        expect(await client.createCustomer(customerRequest)).toEqual({ id: 'cus_fixture' });
        const sent = inspect(fetcher);
        expect(sent.url).toBe('https://api.stripe.com/v1/customers');
        expect(sent.init?.method).toBe('POST');
        expect(sent.headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        expect(sent.headers.get('Stripe-Version')).toBe('2025-09-30.clover');
        expect(sent.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
        expect(sent.headers.get('Idempotency-Key')).toBe(customerRequest.idempotencyKey);
        expect(sent.body).toEqual({ 'metadata[user_id]': 'user_fixture', email: customerRequest.email });

        expect(await client.createCustomer({ ...customerRequest, email: null })).toEqual({ id: 'cus_fixture' });
        expect(inspect(fetcher, 1).body).toEqual({ 'metadata[user_id]': 'user_fixture' });
    });

    it('encodes the complete inline Pro checkout form', async () => {
        const { client, fetcher } = fixture(checkoutResult);
        expect(await client.createCheckoutSession(checkoutRequest)).toEqual(checkoutResult);
        const sent = inspect(fetcher);
        expect(sent.url).toBe('https://api.stripe.com/v1/checkout/sessions');
        expect(sent.init?.method).toBe('POST');
        expect(sent.headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        expect(sent.headers.get('Stripe-Version')).toBe('2025-09-30.clover');
        expect(sent.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
        expect(sent.headers.get('Idempotency-Key')).toBe(checkoutRequest.idempotencyKey);
        expect(sent.body).toEqual(inlinePro());
        expect(sent.size).toBe(Object.keys(inlinePro()).length);
    });

    it.each([
        { sku: 'ai_pack_10_v1', credit: '1000', fee: '84' },
        { sku: 'ai_pack_25_v1', credit: '2500', fee: '161' },
    ])('encodes separate credits and service fee items for $sku', async ({ sku, credit, fee }) => {
        const { client, fetcher } = fixture(checkoutResult, { priceProMonthly: 'price_pro_fixture' });
        expect(await client.createCheckoutSession({ ...checkoutRequest, sku })).toEqual(checkoutResult);
        const expected = {
            ...commonCheckout(sku),
            mode: 'payment',
            'line_items[0][quantity]': '1',
            'line_items[0][price_data][currency]': 'usd',
            'line_items[0][price_data][unit_amount]': credit,
            'line_items[0][price_data][tax_behavior]': 'exclusive',
            'line_items[0][price_data][product_data][name]': 'AI credits',
            'line_items[1][quantity]': '1',
            'line_items[1][price_data][currency]': 'usd',
            'line_items[1][price_data][unit_amount]': fee,
            'line_items[1][price_data][tax_behavior]': 'exclusive',
            'line_items[1][price_data][product_data][name]': 'Service fee',
            'payment_intent_data[metadata][sku]': sku,
        };
        const sent = inspect(fetcher);
        expect(sent.url).toBe('https://api.stripe.com/v1/checkout/sessions');
        expect(sent.init?.method).toBe('POST');
        expect(sent.body).toEqual(expected);
        expect(sent.size).toBe(Object.keys(expected).length);
        expect(sent.headers.get('Idempotency-Key')).toBe(checkoutRequest.idempotencyKey);
        expect(sent.headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
    });

    it('uses a configured Pro price in place of inline price data', async () => {
        const inline = fixture(checkoutResult);
        expect(await inline.client.createCheckoutSession(checkoutRequest)).toEqual(checkoutResult);
        expect(inspect(inline.fetcher).body).toEqual(inlinePro());

        const { client, fetcher } = fixture(checkoutResult, { priceProMonthly: 'price_pro_fixture' });
        expect(await client.createCheckoutSession(checkoutRequest)).toEqual(checkoutResult);
        expect(inspect(fetcher).body).toEqual({
            ...commonCheckout(), mode: 'subscription',
            'line_items[0][quantity]': '1', 'line_items[0][price]': 'price_pro_fixture',
            'subscription_data[metadata][sku]': 'pro_monthly_v1',
        });
    });

    it.each(['unknown_sku', 'free_v1', '', 'PRO_MONTHLY_V1'])('rejects SKU %s before making a request', async sku => {
        const { client, fetcher } = fixture(checkoutResult);
        expect(await client.createCheckoutSession(checkoutRequest)).toEqual(checkoutResult);
        expect(fetcher).toHaveBeenCalledTimes(1);
        fetcher.mockClear();
        await expect(client.createCheckoutSession({ ...checkoutRequest, sku })).rejects.toThrow('Unknown billing SKU');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('creates a portal session with its return URL and an explicit version override', async () => {
        const { client, fetcher } = fixture({ id: 'bps_fixture', url: 'https://billing.stripe.com/fixture' }, { apiVersion: '2024-06-20' });
        expect(await client.createPortalSession({ customerId: 'cus_fixture', returnUrl: checkoutRequest.cancelUrl }))
            .toEqual({ url: 'https://billing.stripe.com/fixture' });
        const sent = inspect(fetcher);
        expect(sent.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
        expect(sent.init?.method).toBe('POST');
        expect(sent.body).toEqual({ customer: 'cus_fixture', return_url: checkoutRequest.cancelUrl });
        expect(sent.headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        expect(sent.headers.get('Stripe-Version')).toBe('2024-06-20');
    });
});

describe('Stripe response mapping', () => {
    it.each([
        { name: 'legacy', current_period_start: start, current_period_end: end },
        { name: 'modern', items: { data: [{ current_period_start: start, current_period_end: end }] } },
        { name: 'null legacy', current_period_start: null, current_period_end: null, items: { data: [{ current_period_start: start, current_period_end: end }] } },
        { name: 'legacy precedence', current_period_start: start, current_period_end: end, items: { data: [{ current_period_start: 10, current_period_end: 20 }] } },
    ])('maps $name subscription periods', async shape => {
        const { client, fetcher } = fixture({ ...subscription, ...shape, customer: { id: 'cus_fixture' } });
        expect(await client.retrieveSubscription('sub_fixture')).toEqual(expectedSubscription);
        const sent = inspect(fetcher);
        expect(sent.url).toBe('https://api.stripe.com/v1/subscriptions/sub_fixture');
        expect(sent.init?.method).toBe('GET');
        expect(sent.headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        expect(sent.headers.get('Stripe-Version')).toBe('2025-09-30.clover');
        expect(sent.init?.body).toBeUndefined();
    });

    it('preserves epoch dates and leaves absent subscription periods and SKU null', async () => {
        const { client, fetcher } = fixture({ ...subscription, current_period_start: 0, current_period_end: end });
        expect(await client.retrieveSubscription('sub_fixture')).toEqual({ ...expectedSubscription, currentPeriodStart: new Date(0) });
        fetcher.mockResolvedValueOnce(Response.json({ ...subscription, metadata: null, items: { data: [] } }));
        expect(await client.retrieveSubscription('sub_fixture')).toEqual({
            ...expectedSubscription, currentPeriodStart: null, currentPeriodEnd: null, sku: null,
        });
    });

    it.each([
        { name: 'legacy', ownership: { subscription: 'sub_fixture' }, line: { subscription: 'sub_fixture' } },
        {
            name: 'modern',
            ownership: { subscription: null, parent: { subscription_details: { subscription: { id: 'sub_fixture' } } } },
            line: { parent: { type: 'subscription_item_details', subscription_item_details: { subscription: { id: 'sub_fixture' } } } },
        },
        { name: 'legacy line type', ownership: { subscription: { id: 'sub_fixture' } }, line: { type: 'subscription' } },
        {
            name: 'modern line type', ownership: { parent: { subscription_details: { subscription: 'sub_fixture' } } },
            line: { parent: { type: 'subscription_item_details' } },
        },
    ])('maps the $name invoice subscription line instead of a leading adjustment', async ({ ownership, line }) => {
        const { client, fetcher } = fixture({
            ...invoice, ...ownership, customer: { id: 'cus_fixture' },
            lines: { data: [
                { type: 'invoiceitem', period: { start: 30, end: 40 } },
                { type: 'subscription', subscription: 'sub_other', period: { start: 50, end: 60 } },
                { ...line, period: { start, end } },
            ] },
        });
        expect(await client.retrieveInvoice('in_fixture')).toEqual(expectedInvoice);
        expect(inspect(fetcher).url).toBe('https://api.stripe.com/v1/invoices/in_fixture');
        expect(inspect(fetcher).init?.method).toBe('GET');
    });

    it.each([
        { subscription: null, lines: { data: [{ type: 'invoiceitem', period: { start, end } }] } },
        { subscription: 'sub_fixture', lines: { data: [{ subscription: 'sub_other', period: { start, end } }] } },
        { subscription: 'sub_fixture', lines: { data: [] } },
        { subscription: 'sub_fixture' },
    ])('leaves invoice periods null without a subscription line %#', async shape => {
        const { client, fetcher } = fixture({
            ...invoice, subscription: 'sub_fixture', lines: { data: [{ subscription: 'sub_fixture', period: { start, end } }] },
        });
        expect(await client.retrieveInvoice('in_fixture')).toEqual(expectedInvoice);
        fetcher.mockResolvedValueOnce(Response.json({ ...invoice, ...shape }));
        expect(await client.retrieveInvoice('in_fixture')).toEqual({
            ...expectedInvoice, subscriptionId: shape.subscription, periodStart: null, periodEnd: null,
        });
    });

    it.each([false, true])('maps checkout references with expansion=%s', async expanded => {
        const { client, fetcher } = fixture({
            ...session, customer: expanded ? { id: 'cus_fixture' } : 'cus_fixture',
            payment_intent: expanded ? { id: 'pi_fixture' } : 'pi_fixture',
        });
        expect(await client.retrieveCheckoutSession('cs_fixture')).toEqual(expectedSession);
        expect(inspect(fetcher).url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_fixture');
        expect(inspect(fetcher).init?.method).toBe('GET');
    });

    it('never substitutes metadata for the checkout client reference', async () => {
        const { client, fetcher } = fixture(session);
        expect(await client.retrieveCheckoutSession('cs_fixture')).toEqual(expectedSession);
        fetcher.mockResolvedValueOnce(Response.json({
            ...session, customer: null, client_reference_id: null, payment_intent: null,
            metadata: { user_id: 'untrusted_user' },
        }));
        expect(await client.retrieveCheckoutSession('cs_fixture')).toEqual({
            ...expectedSession, customer: null, clientReferenceId: null, paymentIntentId: null, sku: null,
        });
    });

    it.each([false, true])('maps charge references and refund amounts with expansion=%s', async expanded => {
        const { client, fetcher } = fixture({
            ...charge, customer: expanded ? { id: 'cus_fixture' } : 'cus_fixture',
            invoice: expanded ? { id: 'in_fixture' } : 'in_fixture',
            payment_intent: expanded ? { id: 'pi_fixture' } : 'pi_fixture',
        });
        expect(await client.retrieveCharge('ch_fixture')).toEqual(expectedCharge);
        expect(inspect(fetcher).url).toBe('https://api.stripe.com/v1/charges/ch_fixture');
        expect(inspect(fetcher).init?.method).toBe('GET');
        fetcher.mockResolvedValueOnce(Response.json({ ...charge, customer: null, invoice: null, payment_intent: null, amount_refunded: 1084, refunded: true }));
        expect(await client.retrieveCharge('ch_fixture')).toEqual({
            ...expectedCharge, customer: null, invoiceId: null, paymentIntentId: null, amountRefunded: 1084, refunded: true,
        });
    });

    it('finds the invoice of a charge through Invoice Payments when the charge no longer names it', async () => {
        const { client, fetcher } = fixture(charge);
        fetcher.mockReset();
        fetcher.mockResolvedValueOnce(Response.json({ ...charge, invoice: undefined, payment_intent: 'pi_fixture' }));
        fetcher.mockResolvedValueOnce(Response.json({ data: [{ invoice: 'in_from_payments' }] }));
        expect(await client.retrieveCharge('ch_fixture')).toEqual({ ...expectedCharge, invoiceId: 'in_from_payments' });
        const second = fetcher.mock.calls[1][0] as string;
        expect(second).toBe('https://api.stripe.com/v1/invoice_payments?payment[type]=payment_intent&payment[payment_intent]=pi_fixture&limit=1');
        // Positive control: a charge that still names its invoice makes no second request.
        fetcher.mockReset();
        fetcher.mockResolvedValueOnce(Response.json(charge));
        await client.retrieveCharge('ch_fixture');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('encodes resource ids as a single path segment', async () => {
        const { client, fetcher } = fixture(charge);
        expect(await client.retrieveCharge('ch_fixture/other?expand[]=customer')).toEqual(expectedCharge);
        expect(inspect(fetcher).url).toBe('https://api.stripe.com/v1/charges/ch_fixture%2Fother%3Fexpand%5B%5D%3Dcustomer');
    });

    it('rejects missing required customers while accepting expanded customers', async () => {
        const { client, fetcher } = fixture({ ...subscription, customer: { id: 'cus_fixture' }, current_period_start: start, current_period_end: end });
        expect(await client.retrieveSubscription('sub_fixture')).toEqual(expectedSubscription);
        fetcher.mockResolvedValueOnce(Response.json({ ...subscription, customer: null }));
        await expect(client.retrieveSubscription('sub_fixture')).rejects.toThrow('Stripe response is missing its customer');
    });
});

describe('Stripe request failures', () => {
    it.each([
        { status: 402, code: 'card_declined', type: 'card_error' },
        { status: 400, code: 'parameter_missing', type: 'invalid_request_error' },
    ])('maps HTTP $status without echoing credentials', async ({ status, code, type }) => {
        const { client, fetcher } = fixture({ id: 'cus_fixture' });
        expect(await client.createCustomer(customerRequest)).toEqual({ id: 'cus_fixture' });
        fetcher.mockResolvedValueOnce(Response.json({ error: {
            code, type, message: `Authorization: Bearer ${secretKey}`,
        } }, { status, statusText: `Authorization: Bearer ${secretKey}` }));
        const error: unknown = await client.createCustomer(customerRequest).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(StripeRequestError);
        expect(error).toMatchObject({ name: 'StripeRequestError', status, code, type, message: `Stripe request failed (HTTP ${status})` });
        expect(inspect(fetcher, 1).headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        expect(String(error)).not.toContain(secretKey);
        expect(String(error)).not.toContain('Authorization');
        expect(String(error)).not.toContain('Bearer');
    });

    it.each(['not json', '{}', '{"error":{"code":42,"type":false}}', 'null'])('maps malformed HTTP errors to null codes: %s', async body => {
        const { client, fetcher } = fixture(charge);
        expect(await client.retrieveCharge('ch_fixture')).toEqual(expectedCharge);
        fetcher.mockResolvedValueOnce(new Response(body, { status: 500 }));
        await expect(client.retrieveCharge('ch_fixture')).rejects.toMatchObject({
            name: 'StripeRequestError', status: 500, code: null, type: null,
        });
    });

    it('propagates a network error unchanged', async () => {
        const { client, fetcher } = fixture(charge);
        expect(await client.retrieveCharge('ch_fixture')).toEqual(expectedCharge);
        const failure = new TypeError('fixture network failure');
        fetcher.mockRejectedValueOnce(failure);
        await expect(client.retrieveCharge('ch_fixture')).rejects.toBe(failure);
    });
});
