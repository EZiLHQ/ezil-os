import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { productResponse, priceResponse, couponResponse } from './packs.test-support';
import { MANAGED_PAYMENTS_TAX_CODE } from '../catalog';
import * as catalog from '../catalog';
import type { CheckoutRequest } from '../ports';
import { BillingProviderError, createStripeClient, resetStripeCachesForTests, StripeRequestError, UPGRADE_PREVIEW_MAX_AGE_SECONDS } from './client';

beforeEach(resetStripeCachesForTests);
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('Stripe pack reads', () => {
    it('paginates products and checkout line items and maps server product facts', async () => {
        const { client, fetcher } = fixture(null);
        fetcher.mockResolvedValueOnce(Response.json({ data: [productResponse], has_more: true }))
            .mockResolvedValueOnce(Response.json({ data: [{ ...productResponse, id: 'prod_second' }], has_more: false }))
            .mockResolvedValueOnce(Response.json(productResponse))
            .mockResolvedValueOnce(Response.json({ data: [{ id: 'li_one', quantity: 1, price: priceResponse }], has_more: true }))
            .mockResolvedValueOnce(Response.json({ data: [{ id: 'li_two', quantity: 2, price: null }], has_more: false }));
        expect((await client.listProducts()).map(product => product.id)).toEqual(['prod_fixture', 'prod_second']);
        expect(String(fetcher.mock.calls[1]![0])).toContain('starting_after=prod_fixture');
        expect(await client.retrieveProduct('prod_fixture')).toMatchObject({ defaultPrice: 'price_pack', metadata: { ezil_credits: '1000' } });
        expect(await client.retrieveCheckoutLineItems('cs_fixture')).toEqual([
            { quantity: 1, price: { id: 'price_pack', active: true, productId: 'prod_fixture', type: 'one_time', currency: 'usd', unitAmount: 10000 } },
            { quantity: 2, price: null },
        ]);
        expect(String(fetcher.mock.calls[4]![0])).toContain('starting_after=li_one');
    });
    it('maps missing coupons to null and propagates transient provider errors', async () => {
        const { client, fetcher } = fixture(null);
        fetcher.mockResolvedValueOnce(Response.json({ error: {} }, { status: 404 }))
            .mockResolvedValueOnce(Response.json({ error: {} }, { status: 503 }));
        expect(await client.retrieveCoupon('missing')).toBeNull();
        await expect(client.retrieveCoupon('unavailable')).rejects.toMatchObject({ status: 503 });
    });
    it('reads pack ezil_credits without trusting the older custom metadata field', async () => {
        const { client } = fixture({ ...session, metadata: { sku: 'ai_pack_fixture', ezil_credits: '1000', credits: '9999' } });
        expect(await client.retrieveCheckoutSession('cs_fixture')).toMatchObject({ sku: 'ai_pack_fixture', metadataCredits: '1000' });
    });
});

const secretKey = 'sk_test_client_fixture';
const start = 1_799_000_000;
const end = 1_801_000_000;
const checkoutResult = { id: 'cs_fixture', url: 'https://checkout.stripe.com/fixture', clientSecret: null };
const checkoutRequest: CheckoutRequest = {
    customerId: 'cus_fixture',
    userId: 'user_fixture',
    sku: 'pro_monthly_v1',
    uiMode: 'hosted',
    automaticTax: true,
    returnUrl: 'https://example.com/billing/return?session_id={CHECKOUT_SESSION_ID}',
    successUrl: 'https://example.com/billing/return?session_id={CHECKOUT_SESSION_ID}&source=billing',
    cancelUrl: 'https://example.com/settings?tab=billing',
    idempotencyKey: 'checkout_fixture',
};
const customerRequest = { userId: 'user_fixture', email: 'billing+test@example.com', idempotencyKey: 'customer_fixture' };

function fixture(payload: unknown, opts: { priceProMonthly?: string } = {}) {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async url => Response.json(String(url).includes('/invoice_payments?') ? { data: [{ invoice: 'in_fixture' }] } : payload));
    const client = createStripeClient({ secretKey, fetch: fetcher, ...opts });
    return { client, fetcher };
}

/** Historical synthetic policy; never mutates the catalog. */
function configurePackForTest(sku: string) {
    const findPack = catalog.findPack;
    const pack = findPack(sku);
    if (!pack) throw new Error('Unknown fixture pack');
    vi.spyOn(catalog, 'findPack').mockImplementation(value => value === sku
        ? { ...pack, aiCredits: 1234 } : findPack(value));
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
        'customer_update[name]': 'auto',
        billing_address_collection: 'auto',
        'adaptive_pricing[enabled]': 'false',
        'saved_payment_method_options[payment_method_save]': 'enabled',
        success_url: checkoutRequest.successUrl,
        cancel_url: checkoutRequest.cancelUrl,
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
    pendingUpdateExpiresAt: null, defaultPaymentMethod: null, scheduleId: null, latestInvoiceId: null,
};
const invoice = { id: 'in_fixture', customer: 'cus_fixture', status: 'paid', period_start: 10, period_end: 20 };
const expectedInvoice = {
    id: 'in_fixture', customer: 'cus_fixture', status: 'paid', subscriptionId: 'sub_fixture',
    billingReason: null, metadataKind: null, hostedInvoiceUrl: null,
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
    amountTotal: null, currency: null, metadataCredits: null,
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
        expect(sent.headers.get('Stripe-Version')).toBe('2026-09-30.endive');
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
        expect(sent.headers.get('Stripe-Version')).toBe('2026-09-30.endive');
        expect(sent.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
        expect(sent.headers.get('Idempotency-Key')).toBe(checkoutRequest.idempotencyKey);
        expect(sent.body).toEqual(inlinePro());
        expect(sent.size).toBe(Object.keys(inlinePro()).length);
    });

    it('keeps embedded and hosted redirect parameters mutually exclusive', async () => {
        const { client, fetcher } = fixture({ id: 'cs_embedded', client_secret: 'cs_embedded_secret_fixture' });
        expect(await client.createCheckoutSession({ ...checkoutRequest, uiMode: 'embedded' })).toEqual({
            id: 'cs_embedded', url: null, clientSecret: 'cs_embedded_secret_fixture',
        });
        const embedded = inspect(fetcher);
        const { success_url, cancel_url, ...shared } = inlinePro();
        expect(embedded.body).toEqual({
            ...shared, ui_mode: 'embedded_page', return_url: checkoutRequest.returnUrl, redirect_on_completion: 'if_required',
        });
        expect(embedded.headers.get('Idempotency-Key')).toBe(checkoutRequest.idempotencyKey);
        expect(embedded.body).not.toHaveProperty('success_url');
        expect(embedded.body).not.toHaveProperty('cancel_url');

        fetcher.mockResolvedValueOnce(Response.json(checkoutResult));
        expect(await client.createCheckoutSession(checkoutRequest)).toEqual(checkoutResult);
        const hosted = inspect(fetcher, 1).body;
        expect(hosted).toEqual(inlinePro());
        expect(hosted).toMatchObject({ success_url, cancel_url });
        for (const key of ['ui_mode', 'return_url', 'redirect_on_completion']) {
            expect(embedded.body).toHaveProperty(key);
            expect(hosted).not.toHaveProperty(key);
        }
        for (const body of [embedded.body, hosted]) {
            expect(body).toHaveProperty('saved_payment_method_options[payment_method_save]', 'enabled');
            expect(body).not.toHaveProperty('allow_promotion_codes');
        }
    });

    it('normalizes missing checkout fields to null while preserving provided fields', async () => {
        const { client, fetcher } = fixture({ id: 'cs_fixture' });
        expect(await client.createCheckoutSession(checkoutRequest)).toEqual({ id: 'cs_fixture', url: null, clientSecret: null });
        fetcher.mockResolvedValueOnce(Response.json({ id: 'cs_fixture', url: checkoutResult.url, client_secret: 'secret_fixture' }));
        expect(await client.createCheckoutSession(checkoutRequest)).toEqual({ ...checkoutResult, clientSecret: 'secret_fixture' });
    });

    it('lists invoices for one encoded customer and maps descriptions and nullable fields', async () => {
        const base = { ...invoice, amount_paid: 2000, amount_due: 2200, currency: 'usd', created: start };
        const { client, fetcher } = fixture({ data: [
            { ...base, number: 'INV-1', hosted_invoice_url: 'https://invoice.stripe.com/fixture', description: 'Invoice description', lines: { data: [{ description: 'Line description' }] } },
            { ...base, id: 'in_line', number: null, hosted_invoice_url: null, description: null, lines: { data: [{ description: 'EZiL Pro' }] } },
            { ...base, id: 'in_empty', status: 'draft', amount_paid: 0, lines: { data: [] } },
            { ...base, id: 'in_no_lines' },
        ] });
        const mapped = { id: base.id, number: null, status: 'paid', amountPaidCents: 2000, amountDueCents: 2200, metadataKind: null, billingReason: null, currency: 'usd', created: new Date(start * 1000), hostedInvoiceUrl: null, description: null };
        expect(await client.listInvoices('cus_fixture&limit=99', 12)).toEqual([
            { ...mapped, number: 'INV-1', hostedInvoiceUrl: 'https://invoice.stripe.com/fixture', description: 'Invoice description' },
            { ...mapped, id: 'in_line', description: 'EZiL Pro' },
            { ...mapped, id: 'in_empty', status: 'draft', amountPaidCents: 0 },
            { ...mapped, id: 'in_no_lines' },
        ]);
        const sent = inspect(fetcher);
        expect(sent.url).toBe('https://api.stripe.com/v1/invoices?customer=cus_fixture%26limit%3D99&limit=12');
        expect(sent.init?.method).toBe('GET');
        expect(sent.body).toEqual({});
        fetcher.mockResolvedValueOnce(Response.json({ data: [] }));
        expect(await client.listInvoices('cus_fixture', 12)).toEqual([]);
    });

    it.each(['ai_pack_10_v1', 'ai_pack_25_v1'].map(sku => catalog.findPack(sku)!).flatMap(pack => (['hosted', 'embedded'] as const).flatMap(uiMode =>
        [false, true].map(managedPayments => ({ sku: pack.sku, uiMode, managedPayments })))))(
        'refuses null-policy $sku before any Stripe request (mode=$uiMode, managed=$managedPayments)', async input => {
            const { client, fetcher } = fixture(checkoutResult);
            expect(catalog.findPack(input.sku)?.aiCredits).toBeNull();
            await expect(client.createCheckoutSession({ ...checkoutRequest, ...input })).rejects.toMatchObject({
                name: 'TRPCError', code: 'PRECONDITION_FAILED', message: 'pack_credits_unset',
            });
            expect(fetcher).not.toHaveBeenCalled();
        },
    );

    it.each([
        { sku: 'ai_pack_10_v1', credit: '1000', fee: '84' },
        { sku: 'ai_pack_25_v1', credit: '2500', fee: '161' },
    ])('encodes separate credits and service fee items for explicitly configured $sku', async ({ sku, credit, fee }) => {
        configurePackForTest(sku);
        const { client, fetcher } = fixture(checkoutResult, { priceProMonthly: 'price_pro_fixture' });
        expect(await client.createCheckoutSession({ ...checkoutRequest, sku })).toEqual(checkoutResult);
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(catalog.AI_PACKS.every(pack => pack.aiCredits !== null)).toBe(true);
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

    it.each([true, false])('uses the dashboard default price and optional coupon (%s)', async discounted => {
        const { client, fetcher } = fixture({ id: 'cs_pack', client_secret: 'secret_fixture' });
        fetcher.mockResolvedValueOnce(Response.json({ data: [{ ...productResponse,
            metadata: { ezil_kind: 'ai_pack', ezil_credits: '1000', ...(discounted ? { ezil_coupon: 'coupon_pack' } : {}) } }], has_more: false }))
            .mockResolvedValueOnce(Response.json(priceResponse));
        if (discounted) fetcher.mockResolvedValueOnce(Response.json(couponResponse));
        await client.createCheckoutSession({ ...checkoutRequest, sku: 'ai_pack_fixture', uiMode: 'embedded' });
        const sent = inspect(fetcher, fetcher.mock.calls.length - 1).body;
        expect(sent).toMatchObject({ mode: 'payment', ui_mode: 'embedded_page', 'line_items[0][price]': 'price_pack',
            'line_items[0][quantity]': '1', 'metadata[sku]': 'ai_pack_fixture', 'metadata[ezil_credits]': '1000',
            'payment_intent_data[metadata][ezil_credits]': '1000' });
        expect(sent).not.toHaveProperty('line_items[0][price_data][unit_amount]');
        expect(sent).not.toHaveProperty('allow_promotion_codes');
        if (discounted) expect(sent['discounts[0][coupon]']).toBe('coupon_pack');
        else expect(sent).not.toHaveProperty('discounts[0][coupon]');
    });

    it('stores custom credits on the session and payment intent and reads verified payment facts', async () => {
        const { client, fetcher } = fixture({ ...session, amount_total: 2500, currency: 'usd',
            metadata: { sku: 'ai_custom_v2', credits: '250' } });
        await client.createCheckoutSession({ ...checkoutRequest, sku: 'ai_custom_v2', customAmountCents: 2500 });
        expect(inspect(fetcher).body).toMatchObject({ mode: 'payment',
            'metadata[sku]': 'ai_custom_v2', 'metadata[credits]': '250',
            'payment_intent_data[metadata][sku]': 'ai_custom_v2', 'payment_intent_data[metadata][credits]': '250',
            'line_items[0][price_data][unit_amount]': '2500' });
        expect(await client.retrieveCheckoutSession('cs_fixture')).toMatchObject({
            sku: 'ai_custom_v2', amountTotal: 2500, currency: 'usd', metadataCredits: '250' });
    });

    it.each([undefined, 999, 1001, 1000001])('refuses custom checkout with invalid amount %s before Stripe', async customAmountCents => {
        const { client, fetcher } = fixture(checkoutResult);
        await expect(client.createCheckoutSession({ ...checkoutRequest, sku: 'ai_custom_v2', customAmountCents })).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
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

    it('lists every subscription of one encoded customer across pages, any status', async () => {
        const { client, fetcher } = fixture(null);
        fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: 'sub_live', status: 'active', customer: 'cus_fixture' }], has_more: true }))
            .mockResolvedValueOnce(Response.json({ data: [{ id: 'sub_old', status: 'canceled' }], has_more: false }));
        expect(await client.listCustomerSubscriptions('cus_fixture&status=active')).toEqual([
            { id: 'sub_live', status: 'active' }, { id: 'sub_old', status: 'canceled' },
        ]);
        const first = inspect(fetcher), second = inspect(fetcher, 1);
        expect(first.url).toBe('https://api.stripe.com/v1/subscriptions?customer=cus_fixture%26status%3Dactive&status=all&limit=100');
        expect(first.init?.method).toBe('GET');
        expect(first.headers.get('Stripe-Version')).toBe('2026-09-30.endive');
        expect(second.url).toBe('https://api.stripe.com/v1/subscriptions?customer=cus_fixture%26status%3Dactive&status=all&limit=100&starting_after=sub_live');
        fetcher.mockResolvedValueOnce(Response.json({ error: { type: 'api_error' } }, { status: 500 }));
        await expect(client.listCustomerSubscriptions('cus_fixture')).rejects.toMatchObject({ name: 'StripeRequestError', status: 500 });
    });

    it('lists one customer\'s open Checkout Sessions with their mode and expires one by POST', async () => {
        const { client, fetcher } = fixture(null);
        fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: 'cs_sub', mode: 'subscription', status: 'open' }, { id: 'cs_pack', mode: 'payment', status: 'open' }], has_more: false }))
            .mockResolvedValueOnce(Response.json({ id: 'cs_sub', status: 'expired' }));
        expect(await client.listOpenCheckoutSessions('cus_fixture')).toEqual([{ id: 'cs_sub', mode: 'subscription' }, { id: 'cs_pack', mode: 'payment' }]);
        const listed = inspect(fetcher);
        expect(listed.url).toBe('https://api.stripe.com/v1/checkout/sessions?customer=cus_fixture&status=open&limit=100');
        expect(listed.init?.method).toBe('GET');
        await expect(client.expireCheckoutSession('cs_sub/../x')).resolves.toBeUndefined();
        const expired = inspect(fetcher, 1);
        expect(expired.url).toBe('https://api.stripe.com/v1/checkout/sessions/cs_sub%2F..%2Fx/expire');
        expect(expired.init?.method).toBe('POST');
        expect(expired.size).toBe(0);
        expect(expired.headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        // Stripe refuses to expire a session that is no longer open; the caller must see that failure.
        fetcher.mockResolvedValueOnce(Response.json({ error: { type: 'invalid_request_error' } }, { status: 400 }));
        await expect(client.expireCheckoutSession('cs_done')).rejects.toMatchObject({ name: 'StripeRequestError', status: 400 });
    });

    it('creates a portal session with its return URL and the pinned version', async () => {
        const { client, fetcher } = fixture({ id: 'bps_fixture', url: 'https://billing.stripe.com/fixture' });
        fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: 'bpc_v2', metadata: { ezil_portal: 'v2' }, features: { subscription_update: { enabled: false } } }] }));
        expect(await client.createPortalSession({ customerId: 'cus_fixture', returnUrl: checkoutRequest.cancelUrl }))
            .toEqual({ url: 'https://billing.stripe.com/fixture' });
        const sent = inspect(fetcher, 1);
        expect(sent.url).toBe('https://api.stripe.com/v1/billing_portal/sessions');
        expect(sent.init?.method).toBe('POST');
        expect(sent.body).toEqual({ customer: 'cus_fixture', return_url: checkoutRequest.cancelUrl, configuration: 'bpc_v2' });
        expect(sent.headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        expect(sent.headers.get('Stripe-Version')).toBe('2026-09-30.endive');
    });
});

describe('Stripe response mapping', () => {
    it.each([
        { name: 'legacy', current_period_start: start, current_period_end: end },
        { name: 'modern', items: { data: [{ current_period_start: start, current_period_end: end }] } },
        { name: 'null legacy', current_period_start: null, current_period_end: null, items: { data: [{ current_period_start: start, current_period_end: end }] } },
        { name: 'item precedence', current_period_start: 10, current_period_end: 20, items: { data: [{ current_period_start: start, current_period_end: end }] } },
    ])('maps $name subscription periods', async shape => {
        const { client, fetcher } = fixture({ ...subscription, ...shape, customer: { id: 'cus_fixture' } });
        expect(await client.retrieveSubscription('sub_fixture')).toMatchObject(expectedSubscription);
        const sent = inspect(fetcher);
        expect(sent.url).toBe('https://api.stripe.com/v1/subscriptions/sub_fixture');
        expect(sent.init?.method).toBe('GET');
        expect(sent.headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        expect(sent.headers.get('Stripe-Version')).toBe('2026-09-30.endive');
        expect(sent.init?.body).toBeUndefined();
    });

    // Round 6 (R4-04): a cancel scheduled as a DATE (Dashboard "cancel on a custom date", portal or API cancel_at)
    // arrives with cancel_at_period_end false. At or before the period end it ends the plan, so it reads as a
    // cancel at period end (plan_ending), never "Active / renews" followed by a silent drop to Free.
    it.each([
        { name: 'cancel_at at the period end', shape: { cancel_at: end }, expected: true },
        { name: 'cancel_at before the period end', shape: { cancel_at: end - 86_400 }, expected: true },
        { name: 'cancel_at on the item period end (modern shape)', shape: { cancel_at: end, current_period_end: null,
            items: { data: [{ current_period_start: start, current_period_end: end }] } }, expected: true },
        { name: 'cancel_at after the period end (a later renewal still bills)', shape: { cancel_at: end + 86_400 }, expected: false },
        { name: 'no cancel_at', shape: { cancel_at: null }, expected: false },
        { name: 'cancel_at with no known period end', shape: { cancel_at: end, current_period_end: null }, expected: false },
    ])('maps $name to cancelAtPeriodEnd=$expected', async ({ shape, expected }) => {
        const { client } = fixture({ ...subscription, cancel_at_period_end: false, current_period_start: start, current_period_end: end, ...shape });
        expect((await client.retrieveSubscription('sub_fixture')).cancelAtPeriodEnd).toBe(expected);
    });
    it('keeps cancel_at_period_end true whatever cancel_at says', async () => {
        const { client } = fixture({ ...subscription, cancel_at_period_end: true, cancel_at: null, current_period_start: start, current_period_end: end });
        expect((await client.retrieveSubscription('sub_fixture')).cancelAtPeriodEnd).toBe(true);
    });

    it('preserves epoch dates and leaves absent subscription periods and SKU null', async () => {
        const { client, fetcher } = fixture({ ...subscription, current_period_start: 0, current_period_end: end });
        expect(await client.retrieveSubscription('sub_fixture')).toMatchObject({ ...expectedSubscription, currentPeriodStart: new Date(0) });
        fetcher.mockResolvedValueOnce(Response.json({ ...subscription, metadata: null, items: { data: [] } }));
        expect(await client.retrieveSubscription('sub_fixture')).toMatchObject({
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
        expect(await client.retrieveInvoice('in_fixture')).toMatchObject(expectedInvoice);
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
        expect(await client.retrieveInvoice('in_fixture')).toMatchObject(expectedInvoice);
        fetcher.mockResolvedValueOnce(Response.json({ ...invoice, ...shape }));
        expect(await client.retrieveInvoice('in_fixture')).toMatchObject({
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
        // A charge without a PaymentIntent cannot have an Invoice Payment lookup.
        fetcher.mockReset();
        fetcher.mockResolvedValueOnce(Response.json({ ...charge, payment_intent: null }));
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
        expect(await client.retrieveSubscription('sub_fixture')).toMatchObject(expectedSubscription);
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
        expect(error).toMatchObject({ name: 'StripeRequestError', status, code, type });
        // Error messages contain only the HTTP status.
        expect((error as Error).message).toMatch(new RegExp(`^Stripe request failed \\(HTTP ${status}\\)`));
        expect(inspect(fetcher, 1).headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        expect(String(error)).not.toContain(secretKey);
        expect(String(error)).not.toContain('Authorization');
        expect(String(error)).not.toContain('Bearer');
    });

    it('keeps Stripe\'s parameter and message for diagnosis (positive control for the scrubbing above)', async () => {
        const { client, fetcher } = fixture({ id: 'cus_fixture' });
        fetcher.mockResolvedValueOnce(Response.json({ error: {
            type: 'invalid_request_error', param: 'ui_mode', message: 'Invalid ui_mode: embedded_page.',
        } }, { status: 400 }));
        const error = await client.createCustomer(customerRequest).catch((e: unknown) => e) as StripeRequestError;
        expect(error.param).toBe('ui_mode');
        expect(error.message).toBe('Stripe request failed (HTTP 400)');
        expect(error.detail).toBe('Invalid ui_mode: embedded_page.');
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

describe.each(['hosted', 'embedded'] as const)('Managed Payments in %s checkout', uiMode => {
    it.each([
        { sku: 'pro_monthly_v1', mode: 'subscription', amounts: ['2000'], names: ['EZiL Pro'] },
        { sku: 'ai_pack_10_v1', mode: 'payment', amounts: ['1000', '84'], names: ['AI credits', 'Service fee'] },
        { sku: 'ai_pack_25_v1', mode: 'payment', amounts: ['2500', '161'], names: ['AI credits', 'Service fee'] },
    ])('sets eligible tax codes and excludes every incompatible field for $sku', async ({ sku, mode, amounts, names }) => {
        if (sku.startsWith('ai_pack_')) configurePackForTest(sku);
        const { client, fetcher } = fixture(checkoutResult);
        const input = { ...checkoutRequest, sku, uiMode, automaticTax: true, adaptivePricing: true };
        await client.createCheckoutSession({ ...input, managedPayments: false });
        await client.createCheckoutSession({ ...input, managedPayments: true });
        const ordinary = inspect(fetcher).body;
        const sent = inspect(fetcher, 1);
        expect(ordinary).toMatchObject({
            'automatic_tax[enabled]': 'true',
            'adaptive_pricing[enabled]': 'true',
            'customer_update[name]': 'auto',
            'customer_update[address]': 'auto',
        });
        expect(sent.body).toMatchObject({
            'managed_payments[enabled]': 'true', mode,
            customer: input.customerId, client_reference_id: input.userId,
            'metadata[sku]': sku, billing_address_collection: 'auto',
            'saved_payment_method_options[payment_method_save]': 'enabled',
            [mode === 'subscription' ? 'subscription_data[metadata][sku]' : 'payment_intent_data[metadata][sku]']: sku,
            ...(uiMode === 'embedded' ? {
                ui_mode: 'embedded_page', return_url: input.returnUrl, redirect_on_completion: 'if_required',
            } : { success_url: input.successUrl, cancel_url: input.cancelUrl }),
        });
        expect(sent.headers.get('Stripe-Version')).toBe('2026-09-30.endive');
        expect(sent.headers.get('Idempotency-Key')).toBe(input.idempotencyKey);
        expect(ordinary).not.toHaveProperty('managed_payments[enabled]');
        expect(MANAGED_PAYMENTS_TAX_CODE).toBe('txcd_10103000');
        amounts.forEach((amount, index) => {
            const prefix = `line_items[${index}][price_data]`;
            expect(sent.body).toHaveProperty(`${prefix}[unit_amount]`, amount);
            expect(sent.body).toHaveProperty(`${prefix}[product_data][name]`, names[index]);
            expect(sent.body).toHaveProperty(`${prefix}[product_data][tax_code]`, MANAGED_PAYMENTS_TAX_CODE);
            expect(ordinary).not.toHaveProperty(`${prefix}[product_data][tax_code]`);
        });
        expect(Object.keys(sent.body).filter(key => key.endsWith('[tax_code]'))).toHaveLength(amounts.length);

        for (const forbidden of [
            'adaptive_pricing',
            'automatic_tax',
            'tax_id_collection',
            'payment_method_types',
            'payment_method_configuration',
            'customer_update[name]',
            'customer_update[address]',
            'invoice_creation',
            'subscription_data[invoice_settings]',
            'payment_intent_data[statement_descriptor]',
            'payment_intent_data[statement_descriptor_suffix]',
            'payment_intent_data[receipt_email]',
        ]) {
            const matches = (body: Record<string, string>) => Object.keys(body)
                .filter(key => key === forbidden || key.startsWith(`${forbidden}[`));
            // Some forbidden fields have never been emitted by this client.
            // A contaminated form proves each check detects its named field.
            const key = forbidden.endsWith(']') ? forbidden : `${forbidden}[enabled]`;
            expect(matches({ ...sent.body, [key]: 'fixture' }), forbidden).toEqual([key]);
            expect(matches(sent.body), forbidden).toEqual([]);
        }
    });

    it('leaves a dashboard Pro Product responsible for its own tax code', async () => {
        const input = { ...checkoutRequest, uiMode, managedPayments: true };
        const inline = fixture(checkoutResult);
        await inline.client.createCheckoutSession(input);
        expect(inspect(inline.fetcher).body).toHaveProperty('line_items[0][price_data][product_data][tax_code]', MANAGED_PAYMENTS_TAX_CODE);

        const { client, fetcher } = fixture(checkoutResult, { priceProMonthly: 'price_pro_fixture' });
        await client.createCheckoutSession(input);
        const body = inspect(fetcher).body;
        expect(body).toMatchObject({
            'managed_payments[enabled]': 'true', mode: 'subscription',
            'line_items[0][quantity]': '1', 'line_items[0][price]': 'price_pro_fixture',
        });
        expect(Object.keys(body).filter(key => key.startsWith('line_items[0][price_data]'))).toEqual([]);
    });
});

describe('automatic tax is opt-in', () => {
    it('omits Stripe Tax and address saving when automaticTax is false (positive control: true sends both)', async () => {
        const bodies: URLSearchParams[] = [];
        const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
            bodies.push(new URLSearchParams(String(init?.body ?? '')));
            return Response.json({ id: 'cs_fixture', url: null, client_secret: 'cs_secret' });
        });
        const client = createStripeClient({ secretKey, fetch: fetcher as unknown as typeof fetch });
        await client.createCheckoutSession({ ...checkoutRequest, uiMode: 'embedded', automaticTax: false });
        await client.createCheckoutSession({ ...checkoutRequest, uiMode: 'embedded', automaticTax: true });
        expect(bodies[0].has('automatic_tax[enabled]')).toBe(false);
        expect(bodies[0].has('customer_update[address]')).toBe(false);
        expect(bodies[0].get('billing_address_collection')).toBe('auto');
        expect(bodies[1].get('automatic_tax[enabled]')).toBe('true');
        expect(bodies[1].get('customer_update[address]')).toBe('auto');
    });

    it('turns Adaptive Pricing off unless asked (positive control: on when adaptivePricing is true)', async () => {
        const bodies: URLSearchParams[] = [];
        const fetcher = vi.fn(async (_url: string, init?: RequestInit) => {
            bodies.push(new URLSearchParams(String(init?.body ?? '')));
            return Response.json({ id: 'cs_fixture', url: null, client_secret: 'cs_secret' });
        });
        const client = createStripeClient({ secretKey, fetch: fetcher as unknown as typeof fetch });
        await client.createCheckoutSession({ ...checkoutRequest, uiMode: 'embedded', automaticTax: false });
        await client.createCheckoutSession({ ...checkoutRequest, uiMode: 'embedded', automaticTax: false, adaptivePricing: true });
        expect(bodies[0].get('adaptive_pricing[enabled]')).toBe('false');
        expect(bodies[1].get('adaptive_pricing[enabled]')).toBe('true');
    });
});

describe('v2 Stripe response mapping and checkout', () => {
    const standardKey = 'ezil_standard_monthly_v2';
    const computeKey = 'ezil_compute_monthly_v2';
    const line = (id: string, price: unknown) => ({ id, amount: 2000, pricing: { price_details: { price } },
        parent: { type: 'subscription_item_details', subscription_item_details: { subscription: 'sub_fixture', proration: true } },
        period: { start, end } });

    it('caches each distinct endive Price id across invoice reads and maps every line', async () => {
        const data = [line('il_first', 'price_fee'), line('il_base', 'price_standard'), line('il_credit', 'price_standard')];
        const { client, fetcher } = fixture(null);
        fetcher.mockImplementation(async url => {
            const path = new URL(String(url)).pathname;
            if (path === '/v1/prices/price_fee') return Response.json({ id: 'price_fee', lookup_key: 'fee' });
            if (path === '/v1/prices/price_standard') return Response.json({ id: 'price_standard', lookup_key: standardKey });
            return Response.json({ ...invoice, billing_reason: 'subscription_cycle', metadata: { kind: 'subscription' },
                hosted_invoice_url: 'https://invoice.stripe.com/fixture',
                parent: { subscription_details: { subscription: 'sub_fixture' } }, lines: { data } });
        });
        const mapped = await client.retrieveInvoice('in_fixture');
        expect(mapped).toEqual({ ...expectedInvoice, billingReason: 'subscription_cycle', metadataKind: 'subscription',
            hostedInvoiceUrl: 'https://invoice.stripe.com/fixture', lines: data.map((item, index) => ({
                id: item.id, amount: 2000, lookupKey: index === 0 ? 'fee' : standardKey, subscriptionId: 'sub_fixture',
                proration: true, periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000),
            })) });
        expect(fetcher).toHaveBeenCalledTimes(3);
        expect(fetcher.mock.calls.filter(([url]) => String(url).endsWith('/prices/price_standard'))).toHaveLength(1);
        await client.retrieveInvoice('in_fixture');
        expect(fetcher).toHaveBeenCalledTimes(4); // Price ids persist across retrievals.
    });

    it('uses expanded modern and legacy Price lookup keys without extra fetches', async () => {
        const { client, fetcher } = fixture({ ...invoice, subscription: 'sub_fixture', lines: { data: [
            line('il_modern', { id: 'price_standard', lookup_key: standardKey }),
            { id: 'il_legacy', price: { id: 'price_compute', lookup_key: computeKey },
                subscription: 'sub_fixture', proration: true, amount: -1000, period: { start, end } },
            line('il_repeated_id', 'price_standard'),
            line('il_without_key', { id: 'price_without_key', lookup_key: null }),
        ] } });
        const result = await client.retrieveInvoice('in_fixture');
        expect(result.lines.map(item => item.lookupKey)).toEqual([standardKey, computeKey, standardKey, null]);
        expect(result.lines[1]).toMatchObject({ amount: -1000, proration: true, subscriptionId: 'sub_fixture' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('retrieves unexpanded Price objects and preserves null keys and invalid periods defensively', async () => {
        const { client, fetcher } = fixture(null);
        fetcher.mockResolvedValueOnce(Response.json({ ...invoice, subscription: 'sub_fixture', lines: { data: [
            { ...line('il_base', { id: 'price_base' }), period: { start: 'bad', end: -1 } },
        ] } })).mockResolvedValueOnce(Response.json({ id: 'price_base', lookup_key: null }));
        expect((await client.retrieveInvoice('in_fixture')).lines).toEqual([{
            id: 'il_base', amount: 2000, subscriptionId: 'sub_fixture', lookupKey: null, proration: true,
            periodStart: null, periodEnd: null,
        }]);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([undefined, { sku: 'unknown_sku' }, { sku: 'standard_monthly_v2' }])('infers SKU from the first recognized subscription item with metadata %j', async metadata => {
        const { client, fetcher } = fixture({ ...subscription, metadata, pending_update: { expires_at: end }, items: { data: [
            { price: { id: 'price_unrelated', lookup_key: 'unrelated' }, current_period_start: 10, current_period_end: 20 },
            { price: { id: 'price_compute', lookup_key: computeKey }, current_period_start: start, current_period_end: end },
            { price: { id: 'price_standard', lookup_key: standardKey } },
        ] } });
        expect(await client.retrieveSubscription('sub_fixture')).toEqual({ ...expectedSubscription, sku: 'compute_monthly_v2',
            pendingUpdateExpiresAt: new Date(end * 1000), items: [
                { id: null, priceId: 'price_unrelated', lookupKey: 'unrelated' },
                { id: null, priceId: 'price_compute', lookupKey: computeKey }, { id: null, priceId: 'price_standard', lookupKey: standardKey },
            ] });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('prefers the item SKU over known metadata and falls back to metadata for inline prices', async () => {
        const { client, fetcher } = fixture({ ...subscription, current_period_start: start, current_period_end: end,
            pending_update: null, items: { data: [{ price: { id: 'price_compute', lookup_key: computeKey } }] } });
        expect(await client.retrieveSubscription('sub_fixture')).toEqual({ ...expectedSubscription, sku: 'compute_monthly_v2',
            items: [{ id: null, priceId: 'price_compute', lookupKey: computeKey }] });
        fetcher.mockResolvedValueOnce(Response.json({ ...subscription, current_period_start: start, current_period_end: end,
            items: { data: [{ price: { id: 'price_inline', lookup_key: null } }] } }));
        expect(await client.retrieveSubscription('sub_fixture')).toEqual({ ...expectedSubscription,
            items: [{ id: null, priceId: 'price_inline', lookupKey: null }] });
        fetcher.mockResolvedValueOnce(Response.json({ ...subscription, metadata: { sku: 'toString' }, pending_update: null,
            items: { data: [{ price: { id: 'price_unknown', lookup_key: 'unknown' } }, {}] } }));
        expect(await client.retrieveSubscription('sub_fixture')).toMatchObject({ sku: null, pendingUpdateExpiresAt: null,
            items: [{ id: null, priceId: 'price_unknown', lookupKey: 'unknown' }, { id: null, priceId: null, lookupKey: null }] });
    });

    it.each(['standard_monthly_v2', 'compute_monthly_v2'])('resolves the active Price by lookup key for %s checkout', async sku => {
        const lookupKey = `ezil_${sku}`;
        const { client, fetcher } = fixture(null);
        fetcher.mockResolvedValueOnce(Response.json({ data: [{ id: 'price_v2', active: true, lookup_key: lookupKey }] }))
            .mockResolvedValueOnce(Response.json({ id: 'cs_fixture', url: checkoutResult.url }));
        expect(await client.createCheckoutSession({ ...checkoutRequest, sku })).toEqual(checkoutResult);
        const lookup = inspect(fetcher);
        const url = new URL(String(lookup.url));
        expect(url.pathname).toBe('/v1/prices');
        expect(Object.fromEntries(url.searchParams)).toEqual({ 'lookup_keys[]': lookupKey, active: 'true', limit: '1' });
        expect(lookup.init?.method).toBe('GET');
        expect(inspect(fetcher, 1).body).toMatchObject({ mode: 'subscription', 'line_items[0][price]': 'price_v2',
            'line_items[0][quantity]': '1', 'subscription_data[metadata][sku]': sku, 'subscription_data[metadata][ezil_catalog]': 'v2' });
        expect(inspect(fetcher, 1).headers.get('Stripe-Version')).toBe('2026-09-30.endive');
        expect(inspect(fetcher, 1).body).not.toHaveProperty('line_items[0][price_data][unit_amount]');
    });

    it.each([[], [{ id: 'price_disabled', active: false, lookup_key: standardKey }],
        [{ id: 'price_wrong', active: true, lookup_key: computeKey }]])('rejects missing or inactive matching Prices %#', async (...data) => {
        const { client, fetcher } = fixture({ data });
        await expect(client.createCheckoutSession({ ...checkoutRequest, sku: 'standard_monthly_v2' }))
            .rejects.toMatchObject({ code: 'price_not_found' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it.each(['free_v2', 'free_v1_legacy', 'unknown'])('rejects unsellable or unknown SKU %s before requesting Stripe', async sku => {
        const { client, fetcher } = fixture(null);
        await expect(client.createCheckoutSession({ ...checkoutRequest, sku })).rejects.toThrow('Unknown billing SKU');
        expect(fetcher).not.toHaveBeenCalled();
    });
});

const standardPrice = { id: 'price_standard', lookup_key: 'ezil_standard_monthly_v2', active: true, unit_amount: 2000, currency: 'usd', recurring: { interval: 'month' } };
const computePrice = { ...standardPrice, id: 'price_compute', lookup_key: 'ezil_compute_monthly_v2', unit_amount: 10000 };
const planSubscription = {
    ...subscription, schedule: null, billing_cycle_anchor: { day_of_month: 1 },
    items: { data: [{ id: 'si_standard', price: standardPrice, current_period_start: start, current_period_end: end }] },
};
const portalConfig = { id: 'bpc_v2', active: true, metadata: { ezil_portal: 'v2' }, features: { subscription_update: { enabled: false } } };

/** Every request in these fixtures must use endive, and Checkout must use dynamic payment methods. */
function sequence(...responses: unknown[]) {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        expect(new Headers(init?.headers).get('Stripe-Version')).toBe('2026-09-30.endive');
        expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${secretKey}`);
        if (String(url).includes('/checkout/sessions')) expect(String(init?.body)).not.toContain('payment_method_types');
        if (responses.length === 0) throw new Error(`Unexpected request: ${String(url)}`);
        const result = responses.shift();
        return result instanceof Response ? result : Response.json(result);
    });
    return { fetcher, client: createStripeClient({ secretKey, fetch: fetcher }) };
}

function expectRequest(fetcher: ReturnType<typeof fixture>['fetcher'], index: number, path: string, body?: Record<string, string>, key?: string) {
    const sent = inspect(fetcher, index);
    expect(sent.url).toBe(`https://api.stripe.com/v1${path}`);
    expect(sent.init?.method).toBe(body === undefined ? 'GET' : 'POST');
    expect(sent.body).toEqual(body ?? {});
    expect(sent.headers.get('Idempotency-Key')).toBe(key ?? null);
    if (body !== undefined) expect(sent.headers.get('Content-Type')).toBe('application/x-www-form-urlencoded');
}

describe('shared Stripe caches', () => {
    it('reuses lookup Prices across clients, scopes by secret, expires at ten minutes and resets', async () => {
        vi.useFakeTimers();
        const { client, fetcher } = fixture({ data: [standardPrice] });
        const second = createStripeClient({ secretKey, fetch: fetcher });
        const expected = { id: 'price_standard', lookupKey: standardPrice.lookup_key, unitAmount: 2000, currency: 'usd', recurring: true };
        expect(await client.resolvePrice(standardPrice.lookup_key)).toEqual(expected);
        expectRequest(fetcher, 0, '/prices?lookup_keys%5B%5D=ezil_standard_monthly_v2&active=true&limit=1');
        expect(await second.resolvePrice(standardPrice.lookup_key)).toEqual(expected);
        expect(fetcher).toHaveBeenCalledTimes(1);
        await createStripeClient({ secretKey: 'sk_test_another_fixture', fetch: fetcher }).resolvePrice(standardPrice.lookup_key);
        expect(fetcher).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(599_999);
        await second.resolvePrice(standardPrice.lookup_key);
        expect(fetcher).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(1);
        await second.resolvePrice(standardPrice.lookup_key);
        expect(fetcher).toHaveBeenCalledTimes(3);
        resetStripeCachesForTests();
        await second.resolvePrice(standardPrice.lookup_key);
        expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it.each([[], [{ ...standardPrice, active: false }], [computePrice]])('does not cache missing or mismatched prices %#', async (...data) => {
        const { client, fetcher } = sequence({ data }, { data: [standardPrice] });
        await expect(client.resolvePrice(standardPrice.lookup_key)).rejects.toBeInstanceOf(BillingProviderError);
        expect(await createStripeClient({ secretKey, fetch: fetcher }).resolvePrice(standardPrice.lookup_key)).toMatchObject({ id: standardPrice.id });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('does not cache HTTP failures and maps nullable nonrecurring prices', async () => {
        const { client, fetcher } = sequence(new Response('{}', { status: 503 }), { data: [{ ...standardPrice, unit_amount: null, recurring: null, currency: 'eur' }] });
        await expect(client.resolvePrice(standardPrice.lookup_key)).rejects.toMatchObject({ status: 503 });
        expect(await client.resolvePrice(standardPrice.lookup_key)).toMatchObject({ unitAmount: null, recurring: false, currency: 'eur' });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('seeds the invoice Price map from resolvePrice, caches fallback reads across clients and expires both', async () => {
        vi.useFakeTimers();
        const invoiceWithPrice = { ...invoice, lines: { data: [{ id: 'il_1', pricing: { price_details: { price: standardPrice.id } } }] } };
        const { client, fetcher } = sequence({ data: [standardPrice] }, invoiceWithPrice, invoiceWithPrice, standardPrice, invoiceWithPrice);
        await client.resolvePrice(standardPrice.lookup_key);
        expect((await createStripeClient({ secretKey, fetch: fetcher }).retrieveInvoice(invoice.id)).lines[0].lookupKey).toBe(standardPrice.lookup_key);
        expect(fetcher).toHaveBeenCalledTimes(2);
        vi.advanceTimersByTime(600_000);
        await client.retrieveInvoice(invoice.id);
        expectRequest(fetcher, 3, '/prices/price_standard');
        await createStripeClient({ secretKey, fetch: fetcher }).retrieveInvoice(invoice.id);
        expect(fetcher).toHaveBeenCalledTimes(5);
        expectRequest(fetcher, 4, '/invoices/in_fixture'); // No unverified line expansion.
    });

    it('retries failed invoice Price lookups without caching them', async () => {
        const data = { ...invoice, lines: { data: [{ id: 'il_1', pricing: { price_details: { price: standardPrice.id } } }] } };
        const { client, fetcher } = sequence(data, new Response('{}', { status: 500 }), data, standardPrice);
        await expect(client.retrieveInvoice(invoice.id)).rejects.toMatchObject({ status: 500 });
        expect((await client.retrieveInvoice(invoice.id)).lines[0].lookupKey).toBe(standardPrice.lookup_key);
        expect(fetcher).toHaveBeenCalledTimes(4);
    });

    it('reuses the safe v2 portal configuration across client instances and resets it', async () => {
        const session = { url: 'https://billing.stripe.com/session' };
        const { client, fetcher } = sequence({ data: [{ ...portalConfig, id: 'inactive', active: false }, { ...portalConfig, metadata: {} }, portalConfig] }, session, session,
            { data: [portalConfig] }, session);
        const input = { customerId: 'cus_fixture', returnUrl: checkoutRequest.cancelUrl };
        await client.createPortalSession(input);
        await createStripeClient({ secretKey, fetch: fetcher }).createPortalSession(input);
        expect(fetcher).toHaveBeenCalledTimes(3);
        expectRequest(fetcher, 0, '/billing_portal/configurations?limit=100');
        for (const index of [1, 2]) expectRequest(fetcher, index, '/billing_portal/sessions', {
            customer: input.customerId, return_url: input.returnUrl, configuration: 'bpc_v2',
        });
        resetStripeCachesForTests();
        await client.createPortalSession(input);
        expect(fetcher).toHaveBeenCalledTimes(5);
    });

    it.each([[], [{ ...portalConfig, active: false }], [{ ...portalConfig, features: { subscription_update: { enabled: true } } }]])('fails closed without caching unsafe portal configuration %#', async (...data) => {
        const { client, fetcher } = sequence({ data }, { data: [portalConfig] }, { url: 'portal' });
        const input = { customerId: 'cus_fixture', returnUrl: 'https://example.com' };
        await expect(client.createPortalSession(input)).rejects.toMatchObject({ code: 'portal_configuration_missing' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        await createStripeClient({ secretKey, fetch: fetcher }).createPortalSession(input);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('expires portal configurations after ten minutes and isolates accounts', async () => {
        vi.useFakeTimers();
        const { client, fetcher } = fixture(null);
        fetcher.mockImplementation(async url => Response.json(String(url).includes('/configurations?') ? { data: [portalConfig] } : { url: 'portal' }));
        const input = { customerId: 'cus_fixture', returnUrl: 'https://example.com' };
        await client.createPortalSession(input);
        await createStripeClient({ secretKey: 'sk_test_other_fixture', fetch: fetcher }).createPortalSession(input);
        expect(fetcher).toHaveBeenCalledTimes(4);
        vi.advanceTimersByTime(600_000);
        await client.createPortalSession(input);
        expect(fetcher).toHaveBeenCalledTimes(6);
    });
});

describe('invoice payment state', () => {
    it.each([
        ['requires_action', 'requires_action'], ['requires_confirmation', 'requires_action'],
        ['succeeded', 'paid'], ['processing', 'processing'],
        ['requires_payment_method', 'failed'], ['canceled', 'failed'],
    ] as const)('maps PaymentIntent %s to %s for expanded and string references', async (status, state) => {
        for (const expanded of [true, false]) {
            const intent = { id: 'pi_invoice/payment', status };
            const responses: unknown[] = [{ data: [{ payment: { payment_intent: expanded ? intent : intent.id } }] }];
            if (!expanded) responses.push(intent);
            const { client, fetcher } = sequence(...responses);
            expect(await client.retrieveInvoicePaymentState('in_fixture')).toBe(state);
            expectRequest(fetcher, 0, '/invoice_payments?invoice=in_fixture&expand%5B%5D=data.payment.payment_intent');
            if (!expanded) expectRequest(fetcher, 1, '/payment_intents/pi_invoice%2Fpayment');
            expect(fetcher).toHaveBeenCalledTimes(expanded ? 1 : 2);
        }
    });

    it.each([{}, { data: [] }, { data: [{ payment: null }, { payment: { payment_intent: null } }] }])(
        'returns none without a PaymentIntent (%j)', async payload => {
            const { client } = sequence(payload);
            expect(await client.retrieveInvoicePaymentState('in_fixture')).toBe('none');
        },
    );

    it('re-reads payment state on every call and propagates provider failures', async () => {
        const { client, fetcher } = sequence(
            { data: [{ payment: { payment_intent: { id: 'pi_fixture', status: 'requires_action' } } }] },
            { data: [{ payment: { payment_intent: { id: 'pi_fixture', status: 'succeeded' } } }] },
            new Response('{}', { status: 503 }),
        );
        expect(await client.retrieveInvoicePaymentState('in_fixture')).toBe('requires_action');
        expect(await client.retrieveInvoicePaymentState('in_fixture')).toBe('paid');
        await expect(client.retrieveInvoicePaymentState('in_fixture')).rejects.toMatchObject({ status: 503 });
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
});

describe('endive plan changes', () => {
    const previewInput = { subscriptionId: subscription.id, toSku: 'compute_monthly_v2' as const, prorationDate: start + 500 };
    const confirmInput = { ...previewInput, now: new Date((start + 600) * 1000), idempotencyKey: 'upgrade_fixture' };
    const openInvoice = { ...invoice, status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/upgrade' };
    const updated = { ...planSubscription, pending_update: { expires_at: end }, latest_invoice: openInvoice };
    const updateBody = {
        'items[0][id]': 'si_standard', 'items[0][price]': computePrice.id,
        payment_behavior: 'pending_if_incomplete', proration_behavior: 'always_invoice',
        proration_date: String(previewInput.prorationDate), 'expand[]': 'latest_invoice',
    };

    it('previews only net proration lines using the subscription item period', async () => {
        const { client, fetcher } = sequence(planSubscription, { data: [computePrice] }, {
            amount_due: 14000, currency: 'usd', lines: { data: [
                { description: 'Unused Standard', amount: -1000, parent: { subscription_item_details: { proration: true } } },
                { description: 'Remaining Compute', amount: 5000, proration: true },
                { description: 'Next month', amount: 10000 },
            ] },
        });
        expect(await client.previewUpgrade(previewInput)).toEqual({
            prorationDate: previewInput.prorationDate, amountDueCents: 4000, currency: 'usd',
            lines: [{ description: 'Unused Standard', amountCents: -1000 }, { description: 'Remaining Compute', amountCents: 5000 }],
            periodStart: new Date(start * 1000), periodEnd: new Date(end * 1000),
        });
        expectRequest(fetcher, 0, '/subscriptions/sub_fixture');
        expectRequest(fetcher, 2, '/invoices/create_preview', {
            subscription: subscription.id, 'subscription_details[items][0][id]': 'si_standard',
            'subscription_details[items][0][price]': computePrice.id,
            'subscription_details[proration_date]': String(previewInput.prorationDate),
            'subscription_details[proration_behavior]': 'always_invoice',
        });
    });

    it.each([false, true])('clamps negative preview totals with proration=%s', async proration => {
        const { client } = sequence(planSubscription, { data: [computePrice] }, { amount_due: -80, lines: { data: [{ amount: -100, proration }] } });
        expect((await client.previewUpgrade(previewInput)).amountDueCents).toBe(0);
    });

    it('uses amount_due and all lines when no line has a proration flag', async () => {
        const { client } = sequence(planSubscription, { data: [computePrice] }, { amount_due: 1234, currency: 'usd', lines: { data: [{ amount: 1000, description: 'Compute' }] } });
        expect(await client.previewUpgrade(previewInput)).toMatchObject({ amountDueCents: 1234, lines: [{ description: 'Compute', amountCents: 1000 }] });
    });

    it.each([[], [{ id: 'si_compute', price: computePrice }], [planSubscription.items.data[0], planSubscription.items.data[0]], [{ price: standardPrice }]])('refuses invalid source items for preview and confirmation %#', async (...data) => {
        const { client, fetcher } = fixture({ ...planSubscription, items: { data } });
        await expect(client.previewUpgrade(previewInput)).rejects.toMatchObject({ code: 'invalid_subscription_state' });
        await expect(client.confirmUpgrade(confirmInput)).rejects.toMatchObject({ code: 'invalid_subscription_state' });
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls.every(([, init]) => init?.method === 'GET')).toBe(true);
    });

    it.each([901, -61])('rejects a preview age of %s seconds before requesting Stripe', async age => {
        expect(UPGRADE_PREVIEW_MAX_AGE_SECONDS).toBe(900);
        const { client, fetcher } = sequence();
        await expect(client.confirmUpgrade({ ...confirmInput, now: new Date((previewInput.prorationDate + age) * 1000) })).rejects.toMatchObject({ code: 'preview_expired' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([900, -60])('accepts the preview time boundary at age %s', async age => {
        const { client } = sequence(planSubscription, { data: [computePrice] }, { ...planSubscription, latest_invoice: invoice });
        expect((await client.confirmUpgrade({ ...confirmInput, now: new Date((previewInput.prorationDate + age) * 1000) })).status).toBe('applied');
    });

    it('applies only a paid invoice without a pending update and sends the exact mutation', async () => {
        const { client, fetcher } = sequence(planSubscription, { data: [computePrice] }, { ...planSubscription, latest_invoice: invoice });
        expect(await client.confirmUpgrade(confirmInput)).toEqual({ status: 'applied', invoiceId: invoice.id, hostedInvoiceUrl: null, expiresAt: null });
        expectRequest(fetcher, 2, '/subscriptions/sub_fixture', updateBody, confirmInput.idempotencyKey);
        expect(String(fetcher.mock.calls[2][1]?.body)).not.toContain('metadata');
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it.each([
        ['requires_action', false, 'requires_action'], ['requires_confirmation', true, 'requires_action'],
        ['requires_payment_method', true, 'payment_failed'], ['processing', false, 'payment_failed'], ['succeeded', false, 'payment_failed'],
    ] as const)('maps payment intent %s with string reference=%s', async (piStatus, stringReference, status) => {
        const intent = { id: 'pi_upgrade', status: piStatus };
        const responses: unknown[] = [planSubscription, { data: [computePrice] }, updated,
            { data: [{ payment: { payment_intent: stringReference ? intent.id : intent } }] }];
        if (stringReference) responses.push(intent);
        const { client, fetcher } = sequence(...responses);
        expect(await client.confirmUpgrade(confirmInput)).toEqual({ status, invoiceId: invoice.id, hostedInvoiceUrl: openInvoice.hosted_invoice_url, expiresAt: new Date(end * 1000) });
        expectRequest(fetcher, 2, '/subscriptions/sub_fixture', updateBody, confirmInput.idempotencyKey);
        expectRequest(fetcher, 3, '/invoice_payments?invoice=in_fixture&expand%5B%5D=data.payment.payment_intent');
        if (stringReference) expectRequest(fetcher, 4, '/payment_intents/pi_upgrade');
    });

    it.each(['applied', 'requires_action', 'payment_failed'] as const)('recovers HTTP 402 into %s by re-reading the expanded subscription', async status => {
        const result = status === 'applied' ? { ...planSubscription, latest_invoice: invoice } : updated;
        const responses: unknown[] = [planSubscription, { data: [computePrice] }, new Response('{}', { status: 402 }), result];
        if (status !== 'applied') responses.push({ data: [{ payment: { payment_intent: { id: 'pi_upgrade', status: status === 'requires_action' ? 'requires_action' : 'requires_payment_method' } } }] });
        const { client, fetcher } = sequence(...responses);
        expect((await client.confirmUpgrade(confirmInput)).status).toBe(status);
        expectRequest(fetcher, 3, '/subscriptions/sub_fixture?expand[]=latest_invoice');
    });

    it('accepts HTTP 402 with an open invoice even without a pending update', async () => {
        const { client } = sequence(planSubscription, { data: [computePrice] }, new Response('{}', { status: 402 }),
            { ...planSubscription, latest_invoice: openInvoice }, { data: [] });
        expect((await client.confirmUpgrade(confirmInput)).status).toBe('payment_failed');
    });

    it('does not treat paid invoices with pending updates as applied', async () => {
        const { client } = sequence(planSubscription, { data: [computePrice] }, { ...updated, latest_invoice: invoice }, { data: [] });
        expect((await client.confirmUpgrade(confirmInput)).status).toBe('payment_failed');
    });

    it('retrieves a string latest_invoice before classifying the result', async () => {
        const { client, fetcher } = sequence(planSubscription, { data: [computePrice] }, { ...planSubscription, latest_invoice: invoice.id }, invoice);
        expect((await client.confirmUpgrade(confirmInput)).status).toBe('applied');
        expectRequest(fetcher, 3, '/invoices/in_fixture');
    });

    it.each([402, 500])('rethrows HTTP %s when there is no recoverable update', async status => {
        const responses: unknown[] = [planSubscription, { data: [computePrice] }, new Response('{}', { status })];
        if (status === 402) responses.push({ ...planSubscription, latest_invoice: { ...invoice, status: 'void' } });
        const { client } = sequence(...responses);
        await expect(client.confirmUpgrade(confirmInput)).rejects.toMatchObject({ name: 'StripeRequestError', status });
    });

    const computeSubscription = { ...planSubscription, items: { data: [{ ...planSubscription.items.data[0], id: 'si_compute', price: computePrice }] } };
    const downgradeInput = { subscriptionId: subscription.id, toSku: 'standard_monthly_v2' as const, idempotencyKey: 'downgrade_fixture' };

    it('creates and configures a downgrade schedule with separate idempotency keys', async () => {
        const { client, fetcher } = sequence(computeSubscription, { data: [standardPrice] },
            { id: 'sub_sched', current_phase: { start_date: start + 10, end_date: end + 10 } }, { id: 'sub_sched' });
        expect(await client.scheduleDowngrade(downgradeInput)).toEqual({ scheduleId: 'sub_sched', effectiveAt: new Date((end + 10) * 1000) });
        expectRequest(fetcher, 2, '/subscription_schedules', { from_subscription: subscription.id }, 'downgrade_fixture:create');
        expectRequest(fetcher, 3, '/subscription_schedules/sub_sched', {
            end_behavior: 'release', 'metadata[ezil_change]': 'downgrade', 'metadata[to_sku]': 'standard_monthly_v2',
            'phases[0][start_date]': String(start + 10), 'phases[0][end_date]': String(end + 10),
            'phases[0][items][0][price]': computePrice.id, 'phases[0][items][0][quantity]': '1',
            'phases[1][items][0][price]': standardPrice.id, 'phases[1][items][0][quantity]': '1',
            'phases[1][proration_behavior]': 'none', 'phases[1][duration][interval]': 'month', 'phases[1][duration][interval_count]': '1',
        }, 'downgrade_fixture:phases');
    });

    it.each(['sub_sched', { id: 'sub_sched' }])('refuses an existing schedule %j', async schedule => {
        const { client, fetcher } = sequence({ ...computeSubscription, schedule });
        await expect(client.scheduleDowngrade(downgradeInput)).rejects.toMatchObject({ code: 'invalid_subscription_state' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('refuses a downgrade from a Standard subscription', async () => {
        const { client, fetcher } = sequence(planSubscription);
        await expect(client.scheduleDowngrade(downgradeInput)).rejects.toMatchObject({ code: 'invalid_subscription_state' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('releases the encoded schedule id', async () => {
        const { client, fetcher } = sequence({ id: 'sub_sched' });
        await client.cancelScheduledChange({ scheduleId: 'sub_sched/other' });
        expectRequest(fetcher, 0, '/subscription_schedules/sub_sched%2Fother/release', {});
    });

    it.each([
        { cancel: true, cancelAt: end + 10, expected: end + 10 },
        { cancel: true, cancelAt: null, expected: end },
        { cancel: false, cancelAt: null, expected: null },
    ])('sets cancellation=$cancel with cancel_at=$cancelAt', async ({ cancel, cancelAt, expected }) => {
        const { client, fetcher } = sequence({ ...planSubscription, cancel_at: cancelAt });
        expect(await client.setCancelAtPeriodEnd({ subscriptionId: subscription.id, cancel, idempotencyKey: 'cancel_fixture' }))
            .toEqual({ cancelsAt: expected === null ? null : new Date(expected * 1000) });
        expectRequest(fetcher, 0, '/subscriptions/sub_fixture', { cancel_at_period_end: String(cancel) }, 'cancel_fixture');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    // Round 6 review (R4-04): a dated cancel (Dashboard custom date) reads as plan_ending, so Billing offers Resume.
    it('resume unsets a dated cancel_at the flag alone leaves, under its own idempotency key', async () => {
        const dated = { ...planSubscription, cancel_at_period_end: false, cancel_at: end - 86_400 * 10 };
        const { client, fetcher } = sequence(dated, { ...dated, cancel_at: null });
        expect(await client.setCancelAtPeriodEnd({ subscriptionId: subscription.id, cancel: false, idempotencyKey: 'resume_fixture' }))
            .toEqual({ cancelsAt: null });
        // The first request is the in-app resume, byte for byte; the second only unsets cancel_at (Stripe's empty-string unset).
        expectRequest(fetcher, 0, '/subscriptions/sub_fixture', { cancel_at_period_end: 'false' }, 'resume_fixture');
        expectRequest(fetcher, 1, '/subscriptions/sub_fixture', { cancel_at: '' }, 'resume_fixture:cancel_at');
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('a resume that leaves a cancel_at is refused, never reported as resumed', async () => {
        const dated = { ...planSubscription, cancel_at_period_end: false, cancel_at: end - 86_400 * 10 };
        const { client } = sequence(dated, dated);
        await expect(client.setCancelAtPeriodEnd({ subscriptionId: subscription.id, cancel: false, idempotencyKey: 'resume_fixture' }))
            .rejects.toMatchObject({ name: 'BillingProviderError' });
    });
});

describe('additional endive mappings', () => {
    it.each([false, true])('maps item ids, payment method, schedule and latest invoice with expanded=%s', async expanded => {
        const reference = (id: string) => expanded ? { id } : id;
        const { client } = sequence({ ...planSubscription, default_payment_method: reference('pm_default'), schedule: reference('sub_sched'), latest_invoice: reference('in_latest') });
        expect(await client.retrieveSubscription(subscription.id)).toMatchObject({
            items: [{ id: 'si_standard', priceId: 'price_standard', lookupKey: standardPrice.lookup_key }],
            defaultPaymentMethod: 'pm_default', scheduleId: 'sub_sched', latestInvoiceId: 'in_latest',
            currentPeriodStart: new Date(start * 1000), currentPeriodEnd: new Date(end * 1000),
        });
    });

    it('maps overage kind, amount due and billing reason in invoice history', async () => {
        const { client } = sequence({ data: [{ ...invoice, amount_due: 2500, amount_paid: 0, created: start, currency: 'usd', metadata: { kind: 'overage' }, billing_reason: 'manual' }] });
        expect((await client.listInvoices('cus_fixture', 10))[0]).toMatchObject({ amountDueCents: 2500, amountPaidCents: 0, metadataKind: 'overage', billingReason: 'manual' });
    });

    it.each(['standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1', 'ai_pack_10_v1', 'ai_pack_25_v1'])('never sends payment_method_types for %s with either merchant mode', async sku => {
        if (sku.startsWith('ai_pack_')) configurePackForTest(sku);
        const isV2 = sku.endsWith('_v2');
        const price = sku === 'standard_monthly_v2' ? standardPrice : computePrice;
        const { client, fetcher } = sequence(...(isV2 ? [{ data: [price] }] : []), checkoutResult, checkoutResult);
        for (const managedPayments of [false, true]) await client.createCheckoutSession({ ...checkoutRequest, sku, managedPayments, uiMode: 'embedded' });
        for (const [url, init] of fetcher.mock.calls) {
            if (!String(url).endsWith('/checkout/sessions')) continue;
            const body = new URLSearchParams(String(init?.body));
            expect(body.get('ui_mode')).toBe('embedded_page');
            expect([...body.keys()].some(key => key.startsWith('payment_method_types'))).toBe(false);
            if (isV2) expect(body.get('subscription_data[metadata][ezil_catalog]')).toBe('v2');
        }
    });

    it('does not echo request values or credentials in HTTP error messages', async () => {
        const { client } = sequence(Response.json({ error: { param: secretKey, message: `email=${customerRequest.email} ${secretKey}` } }, { status: 400 }));
        await expect(client.createCustomer(customerRequest)).rejects.toThrow('Stripe request failed (HTTP 400)');
    });
});

describe('v3 Stripe prices and pending updates', () => {
    const start = 1790812800, end = 1793491200;
    const subscription = (lookupKey = 'ezil_standard_monthly_v3') => ({ id: 'sub_v3', customer: 'cus_fixture', status: 'active',
        cancel_at_period_end: false, schedule: null, metadata: { sku: 'standard_monthly_v3' },
        items: { data: [{ id: 'si_v3', price: { id: 'price_old', lookup_key: lookupKey }, current_period_start: start, current_period_end: end }] } });
    function v3Client() {
        const fetcher = vi.fn<typeof fetch>(async (url, init) => {
            const path = new URL(String(url));
            if (path.pathname.endsWith('/prices')) return Response.json({ data: [{ id: 'price_v3', lookup_key: path.searchParams.get('lookup_keys[]'),
                active: true, unit_amount: 4000, currency: 'usd', recurring: { interval: 'month' } }] });
            if (path.pathname.endsWith('/checkout/sessions')) return Response.json({ id: 'cs_v3', url: 'https://checkout.example' });
            if (path.pathname.endsWith('/invoices/create_preview')) return Response.json({ id: 'in_preview', amount_due: 1734, period_end: end, currency: 'usd', lines: { data: [] } });
            if (init?.method === 'POST') return Response.json({ ...subscription(), pending_update: { expires_at: end },
                latest_invoice: { id: 'in_upgrade', status: 'open', hosted_invoice_url: 'https://invoice.example' } });
            return Response.json(subscription());
        });
        return { fetcher, client: createStripeClient({ secretKey: 'fixture_v3', fetch: fetcher }) };
    }
    it.each(['standard_monthly_v3', 'premium_monthly_v3'])('checkout resolves %s by its v3 lookup key', async sku => {
        const { client, fetcher } = v3Client();
        await client.createCheckoutSession({ ...checkoutRequest, sku });
        expect(String(fetcher.mock.calls[0]![0])).toContain(encodeURIComponent(`ezil_${sku}`));
        const checkout = fetcher.mock.calls.find(([url]) => String(url).includes('/checkout/sessions'))!;
        const body = new URLSearchParams(String(checkout[1]!.body));
        expect(body.get('line_items[0][price]')).toBe('price_v3');
        expect(body.get('subscription_data[metadata][ezil_catalog]')).toBe('v3');
    });
    it('previews the next invoice without changing a subscription', async () => {
        const { client, fetcher } = v3Client();
        expect(await client.previewRenewal!('sub_v3')).toEqual({ at: new Date(end * 1000), amountCents: 1734 });
        expect(new URLSearchParams(String(fetcher.mock.calls[0]![1]!.body)).get('subscription')).toBe('sub_v3');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('confirms Premium with pending_if_incomplete and keeps the proration date', async () => {
        const { client, fetcher } = v3Client();
        const now = new Date((start + 100) * 1000);
        await client.confirmUpgrade({ subscriptionId: 'sub_v3', toSku: 'premium_monthly_v3', prorationDate: start + 100, now, idempotencyKey: 'v3-upgrade' });
        const write = fetcher.mock.calls.find(([url, init]) => String(url).endsWith('/subscriptions/sub_v3') && init?.method === 'POST')!;
        const body = new URLSearchParams(String(write[1]!.body));
        expect(body.get('payment_behavior')).toBe('pending_if_incomplete');
        expect(body.get('proration_behavior')).toBe('always_invoice');
        expect(body.get('proration_date')).toBe(String(start + 100));
        expect(body.get('items[0][price]')).toBe('price_v3');
    });
    it('refuses a v3 upgrade from a v2 line before any write', async () => {
        const { client, fetcher } = v3Client();
        fetcher.mockResolvedValueOnce(Response.json(subscription('ezil_standard_monthly_v2')));
        await expect(client.previewUpgrade({ subscriptionId: 'sub_v3', toSku: 'premium_monthly_v3', prorationDate: start }))
            .rejects.toMatchObject({ code: 'invalid_subscription_state' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});


it('never infers a v3 subscription from metadata without a v3 line', async () => {
    const { client } = fixture({ id: 'sub_v3', customer: 'cus_fixture', status: 'active', cancel_at_period_end: false,
        metadata: { sku: 'premium_monthly_v3' }, items: { data: [{ price: { id: 'price_unknown', lookup_key: 'unknown' } }] } });
    expect((await client.retrieveSubscription('sub_v3')).sku).toBeNull();
});
