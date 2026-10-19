/**
 * QA: the Stripe overage sidecar (CONTRACT-v2 §4 Invoicing) with a recording fake fetch.
 * No network: every request is answered locally.
 */
import { describe, expect, it } from 'vitest';

import { createStripeUsageBilling } from '../../stripe/usage-billing';
import { OVERAGE_PRICE_LOOKUP_KEY } from '../contract';

type Call = { method: string; path: string; key: string | null; body: string };

function fakeFetch(draft: { status: string } = { status: 'draft' }) {
    const calls: Call[] = [];
    let invoiceStatus = draft.status;
    const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
    const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const path = url.pathname.replace(/^\/v1/, '') + url.search;
        const headers = new Headers(init?.headers);
        calls.push({ method: init?.method ?? 'GET', path, key: headers.get('Idempotency-Key'), body: String(init?.body ?? '') });
        if (path.startsWith('/subscriptions/')) return json({ id: 'sub_1', customer: 'cus_1', status: 'active', cancel_at_period_end: false, items: { data: [] }, default_payment_method: 'pm_1' });
        if (path === '/invoices' && init?.method === 'POST') return json({ id: 'in_new', status: invoiceStatus, lines: { data: [] } });
        if (path.startsWith('/invoices/') && path.endsWith('/finalize')) { invoiceStatus = 'open'; return json({ id: path.split('/')[2], status: 'open' }); }
        if (path.startsWith('/invoices/')) return json({ id: path.split('/')[2], status: invoiceStatus, lines: { data: [] } });
        if (path.startsWith('/prices')) return json({ data: [{ id: 'price_over', lookup_key: OVERAGE_PRICE_LOOKUP_KEY, active: true, unit_amount: 1, currency: 'usd' }] });
        if (path === '/invoiceitems') return json({ id: 'ii_1' });
        throw new Error(`unexpected ${path}`);
    };
    return { fetch: fetch as typeof globalThis.fetch, calls };
}

const periodStart = new Date('2026-10-01T00:00:00Z');
const periodEnd = new Date('2026-11-01T00:00:00Z');
const req = (over: Partial<Parameters<ReturnType<typeof createStripeUsageBilling>['invoiceOverage']>[0]> = {}) => ({
    customerId: 'cus_1', subscriptionId: 'sub_1', periodStart, periodEnd, ratingVersion: 1, cents: 700,
    overageEnabled: true, now: new Date(periodEnd.getTime() + 2 * 3600_000), ...over,
});

describe('qa overage sidecar', () => {
    it('creates one separate charge_automatically invoice, one line of the overage Price with quantity = cents, idempotent keys', async () => {
        const f = fakeFetch();
        const drafts: string[] = [];
        const res = await createStripeUsageBilling({ secretKey: 'sk_test_fixture', fetch: f.fetch }).invoiceOverage(req(), { onDraftCreated: async id => { drafts.push(id); } });
        expect(res).toMatchObject({ status: 'invoiced', invoiceId: 'in_new' });
        expect(drafts).toEqual(['in_new']);
        const create = f.calls.find(c => c.method === 'POST' && c.path === '/invoices')!;
        const body = new URLSearchParams(create.body);
        expect(body.get('collection_method')).toBe('charge_automatically');
        expect(body.get('pending_invoice_items_behavior')).toBe('exclude');
        expect(body.get('metadata[kind]')).toBe('overage');
        expect(body.has('subscription')).toBe(false);
        expect(create.key).toBe(`overage:sub_1:${periodStart.getTime() / 1000}:1:invoice`);
        const item = f.calls.find(c => c.path === '/invoiceitems')!;
        const itemBody = new URLSearchParams(item.body);
        expect(itemBody.get('quantity')).toBe('700');
        expect(itemBody.get('pricing[price]')).toBe('price_over');
        expect(itemBody.get('invoice')).toBe('in_new');
        expect([...itemBody.keys()].some(k => /amount/.test(k))).toBe(false);
        expect(item.key).toBe(`overage:sub_1:${periodStart.getTime() / 1000}:1:item`);
    });

    it.each([
        ['overage disabled', { overageEnabled: false }, 'overage_disabled'],
        ['zero cents', { cents: 0 }, 'nothing_to_bill'],
        ['negative cents', { cents: -5 }, 'nothing_to_bill'],
        ['fractional cents', { cents: 1.5 }, 'nothing_to_bill'],
        ['period not closed + grace', { now: new Date(periodEnd.getTime() + 60_000) }, 'period_not_closed'],
    ])('makes no provider call when %s', async (_l, over, reason) => {
        const f = fakeFetch();
        expect(await createStripeUsageBilling({ secretKey: 'sk_test_fixture', fetch: f.fetch }).invoiceOverage(req(over))).toEqual({ status: 'skipped', reason });
        expect(f.calls).toEqual([]);
    });

    it('resuming with an existing draft never POSTs a new invoice', async () => {
        const f = fakeFetch();
        await createStripeUsageBilling({ secretKey: 'sk_test_fixture', fetch: f.fetch }).invoiceOverage(req({ existingInvoiceId: 'in_old' }));
        expect(f.calls.filter(c => c.method === 'POST' && c.path === '/invoices')).toEqual([]);
        expect(f.calls.find(c => c.path.endsWith('/finalize'))?.path).toBe('/invoices/in_old/finalize');
    });

    it('resuming with an already finalized invoice adds no line and does not finalize again', async () => {
        const f = fakeFetch({ status: 'open' });
        const res = await createStripeUsageBilling({ secretKey: 'sk_test_fixture', fetch: f.fetch }).invoiceOverage(req({ existingInvoiceId: 'in_old' }));
        expect(res).toMatchObject({ status: 'invoiced', invoiceId: 'in_old' });
        expect(f.calls.map(c => `${c.method} ${c.path}`)).toEqual(['GET /invoices/in_old']);
    });
});
