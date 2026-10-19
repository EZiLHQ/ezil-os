import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { OverageInvoiceRequest } from '../ports';
import { OVERAGE_PRICE_LOOKUP_KEY } from '../v2/contract';
import { createStripeClient, resetStripeCachesForTests } from './client';
import { createStripeUsageBilling } from './usage-billing';

beforeEach(resetStripeCachesForTests);
const secretKey = 'sk_test_usage_fixture';
const periodStart = new Date('2026-09-01T00:00:00Z');
const periodEnd = new Date('2026-10-01T00:00:00Z');
const input: OverageInvoiceRequest = {
    customerId: 'cus_usage', subscriptionId: 'sub_usage', periodStart, periodEnd,
    ratingVersion: 1, cents: 2500, overageEnabled: true, now: new Date('2026-10-01T01:00:00Z'),
};
const price = { id: 'price_overage', lookup_key: OVERAGE_PRICE_LOOKUP_KEY, active: true, unit_amount: 1, currency: 'usd', recurring: null };
const subscription = { id: input.subscriptionId, customer: input.customerId, status: 'active', items: { data: [] }, default_payment_method: 'pm_usage' };
const draft = { id: 'in_usage', customer: input.customerId, status: 'draft', lines: { data: [] } };
const finalized = { ...draft, status: 'open', hosted_invoice_url: 'https://invoice.stripe.com/usage' };
const result = { status: 'invoiced', invoiceId: 'in_usage', invoiceStatus: 'open', hostedInvoiceUrl: finalized.hosted_invoice_url };
const baseKey = `overage:sub_usage:${Math.floor(periodStart.getTime() / 1000)}:1`;

function fixture(...responses: unknown[]) {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
        const headers = new Headers(init?.headers);
        expect(headers.get('Stripe-Version')).toBe('2026-09-30.endive');
        expect(headers.get('Authorization')).toBe(`Bearer ${secretKey}`);
        if (responses.length === 0) throw new Error(`Unexpected request: ${String(url)}`);
        const next = responses.shift();
        return next instanceof Response ? next : Response.json(next);
    });
    return { fetcher, usage: createStripeUsageBilling({ secretKey, fetch: fetcher }) };
}

function expectRequest(fetcher: ReturnType<typeof fixture>['fetcher'], index: number, path: string, body?: Record<string, string>, key?: string) {
    const [url, init] = fetcher.mock.calls[index];
    expect(url).toBe(`https://api.stripe.com/v1${path}`);
    expect(init?.method).toBe(body === undefined ? 'GET' : 'POST');
    expect(Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))).toEqual(body ?? {});
    expect(new Headers(init?.headers).get('Idempotency-Key')).toBe(key ?? null);
    if (body !== undefined) expect(new Headers(init?.headers).get('Content-Type')).toBe('application/x-www-form-urlencoded');
}

const itemBody = { customer: input.customerId, invoice: draft.id, 'pricing[price]': price.id, quantity: '2500', 'metadata[kind]': 'overage' };

describe('Stripe overage invoice adapter', () => {
    it.each([
        { change: { overageEnabled: false }, reason: 'overage_disabled' },
        { change: { cents: 0 }, reason: 'nothing_to_bill' },
        { change: { now: periodEnd }, reason: 'period_not_closed' },
    ])('skips $reason with zero requests', async ({ change, reason }) => {
        const { usage, fetcher } = fixture();
        const onDraftCreated = vi.fn();
        expect(await usage.invoiceOverage({ ...input, ...change, existingInvoiceId: draft.id }, { onDraftCreated })).toEqual({ status: 'skipped', reason });
        expect(fetcher).not.toHaveBeenCalled();
        expect(onDraftCreated).not.toHaveBeenCalled();
    });

    it('creates a separate invoice, persists its identity, adds cents as quantity and finalizes with distinct keys', async () => {
        const { usage, fetcher } = fixture(subscription, draft, { data: [price] }, { id: 'ii_usage' }, finalized);
        let resume: () => void = () => {};
        const persisted = new Promise<void>(resolve => { resume = resolve; });
        let entered: () => void = () => {};
        const hookEntered = new Promise<void>(resolve => { entered = resolve; });
        const onDraftCreated = vi.fn(async (id: string) => {
            expect(id).toBe(draft.id);
            expect(fetcher).toHaveBeenCalledTimes(2);
            entered();
            await persisted;
        });
        const pending = usage.invoiceOverage(input, { onDraftCreated });
        await hookEntered;
        expect(fetcher).toHaveBeenCalledTimes(2);
        resume();
        expect(await pending).toEqual(result);
        expectRequest(fetcher, 0, '/subscriptions/sub_usage');
        expectRequest(fetcher, 1, '/invoices', {
            customer: input.customerId, pending_invoice_items_behavior: 'exclude', collection_method: 'charge_automatically', auto_advance: 'true',
            default_payment_method: 'pm_usage', 'metadata[kind]': 'overage', 'metadata[subscription]': input.subscriptionId,
            'metadata[period_start]': String(Math.floor(periodStart.getTime() / 1000)),
            'metadata[period_end]': String(Math.floor(periodEnd.getTime() / 1000)), 'metadata[rating_version]': '1',
        }, `${baseKey}:invoice`);
        expect(new URLSearchParams(String(fetcher.mock.calls[1][1]?.body)).has('subscription')).toBe(false);
        expectRequest(fetcher, 2, '/prices?lookup_keys%5B%5D=ezil_compute_overage_v2&active=true&limit=1');
        expectRequest(fetcher, 3, '/invoiceitems', itemBody, `${baseKey}:item`);
        expectRequest(fetcher, 4, '/invoices/in_usage/finalize', { auto_advance: 'true' }, `${baseKey}:finalize`);
        expect(onDraftCreated).toHaveBeenCalledTimes(1);
    });

    it.each([null, { id: 'pm_expanded' }])('handles subscription default payment method %j', async default_payment_method => {
        const { usage, fetcher } = fixture({ ...subscription, default_payment_method }, draft, { data: [price] }, {}, finalized);
        await usage.invoiceOverage(input);
        expect(new URLSearchParams(String(fetcher.mock.calls[1][1]?.body)).get('default_payment_method')).toBe(default_payment_method?.id ?? null);
    });

    it('stops after the draft when persistence fails', async () => {
        const { usage, fetcher } = fixture(subscription, draft);
        const failure = new Error('Persistence failed');
        await expect(usage.invoiceOverage(input, { onDraftCreated: async () => { throw failure; } })).rejects.toBe(failure);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it.each(['paid', 'open', 'void', 'uncollectible'])('resumes a %s invoice with no writes', async status => {
        const { usage, fetcher } = fixture({ ...finalized, status });
        const onDraftCreated = vi.fn();
        expect(await usage.invoiceOverage({ ...input, existingInvoiceId: draft.id }, { onDraftCreated })).toEqual({ ...result, invoiceStatus: status });
        expectRequest(fetcher, 0, '/invoices/in_usage');
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(onDraftCreated).not.toHaveBeenCalled();
    });

    it('resumes a draft without an overage line by adding it and finalizing', async () => {
        const { usage, fetcher } = fixture(draft, { data: [price] }, {}, finalized);
        const onDraftCreated = vi.fn();
        expect(await usage.invoiceOverage({ ...input, existingInvoiceId: draft.id }, { onDraftCreated })).toEqual(result);
        expectRequest(fetcher, 0, '/invoices/in_usage');
        expectRequest(fetcher, 2, '/invoiceitems', itemBody, `${baseKey}:item`);
        expectRequest(fetcher, 3, '/invoices/in_usage/finalize', { auto_advance: 'true' }, `${baseKey}:finalize`);
        expect(onDraftCreated).not.toHaveBeenCalled();
    });

    it('resumes a draft with an expanded overage price by finalizing only', async () => {
        const { usage, fetcher } = fixture({ ...draft, lines: { data: [{ pricing: { price_details: { price } } }] } }, finalized);
        expect(await usage.invoiceOverage({ ...input, existingInvoiceId: draft.id })).toEqual(result);
        expectRequest(fetcher, 1, '/invoices/in_usage/finalize', { auto_advance: 'true' }, `${baseKey}:finalize`);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('uses the shared Price cache to recognize an unexpanded overage line on resume', async () => {
        const { usage, fetcher } = fixture({ data: [price] }, { ...draft, lines: { data: [{ pricing: { price_details: { price: price.id } } }] } }, finalized);
        await createStripeClient({ secretKey, fetch: fetcher }).resolvePrice(OVERAGE_PRICE_LOOKUP_KEY);
        expect(await usage.invoiceOverage({ ...input, existingInvoiceId: draft.id })).toEqual(result);
        expectRequest(fetcher, 2, '/invoices/in_usage/finalize', { auto_advance: 'true' }, `${baseKey}:finalize`);
        expect(fetcher).toHaveBeenCalledTimes(3);
    });

    it('recognizes unexpanded overage prices after a fresh lookup on resume', async () => {
        const { usage, fetcher } = fixture({ ...draft, lines: { data: [{ pricing: { price_details: { price: price.id } } }] } }, { data: [price] }, finalized);
        expect(await usage.invoiceOverage({ ...input, existingInvoiceId: draft.id })).toEqual(result);
        expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
    });

    it('propagates item failures and resumes the persisted invoice with the same item key', async () => {
        const { usage, fetcher } = fixture(subscription, draft, { data: [price] }, new Response('{}', { status: 500 }), draft, {}, finalized);
        const onDraftCreated = vi.fn(async () => {});
        await expect(usage.invoiceOverage(input, { onDraftCreated })).rejects.toMatchObject({ name: 'StripeRequestError', status: 500 });
        expect(await usage.invoiceOverage({ ...input, existingInvoiceId: draft.id })).toEqual(result);
        expectRequest(fetcher, 3, '/invoiceitems', itemBody, `${baseKey}:item`);
        expectRequest(fetcher, 5, '/invoiceitems', itemBody, `${baseKey}:item`);
        expect(onDraftCreated).toHaveBeenCalledTimes(1);
    });

    it('persists but does not modify an already finalized idempotent creation replay', async () => {
        const { usage, fetcher } = fixture(subscription, finalized);
        const onDraftCreated = vi.fn(async () => {});
        expect(await usage.invoiceOverage(input, { onDraftCreated })).toEqual(result);
        expect(onDraftCreated).toHaveBeenCalledWith(finalized.id);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });
});
