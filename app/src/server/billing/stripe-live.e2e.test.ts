/**
 * Live Stripe TEST-MODE round trip through the real billing code:
 * customer → Checkout session → a paid subscription → the signed webhook
 * handler (twice: the replay must change nothing) → full refund → cancel at
 * period end, against a real Postgres with migrations 0000–0003 applied.
 *
 * Opt-in only. It runs when all three are set, and refuses a live key:
 *   STRIPE_E2E_SECRET          an `sk_test_` key
 *   BILLING_TEST_DATABASE_URL  a disposable database (it inserts rows)
 *   STRIPE_E2E=1
 * It creates test-mode objects in that Stripe account (a customer, a price,
 * a subscription, a refund) and leaves them there, labelled
 * `ezil-os billing e2e`.
 */
import { createHmac, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { computers } from '@/server/db/schema';

import { readBillingConfig } from './config';
import { handleStripeWebhook } from './http/stripe-webhook';
import { buildSummary } from './meters';
import type { BillingDeps } from './ports';
import { processStripeEvent } from './processor';
import { createBillingStore } from './store';
import { createStripeClient } from './stripe/client';
import type { StripeEventLike } from './stripe/events';

const secret = process.env.STRIPE_E2E_SECRET ?? '';
const databaseUrl = process.env.BILLING_TEST_DATABASE_URL ?? '';
const enabled = process.env.STRIPE_E2E === '1' && secret.startsWith('sk_test_') && databaseUrl !== '';

const API = 'https://api.stripe.com/v1';
const WEBHOOK_SECRET = `whsec_e2e_${randomUUID()}`;

interface InvoicePayments {
    payments?: { data?: { payment?: { payment_intent?: string | { id: string } | null } }[] };
}

async function stripe<T = { id: string }>(method: 'GET' | 'POST', path: string, body?: Record<string, string>): Promise<T> {
    const response = await fetch(`${API}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${secret}`,
            'Content-Type': 'application/x-www-form-urlencoded',
            'Stripe-Version': '2026-03-25.dahlia',
        },
        body: body ? new URLSearchParams(body).toString() : undefined,
    });
    if (!response.ok) throw new Error(`Stripe ${method} ${path}: HTTP ${response.status}`);
    return response.json() as Promise<T>;
}

/** Poll Stripe's event list for the first event of `type` about `objectId`. */
async function eventFor(type: string, match: (object: Record<string, unknown>) => boolean): Promise<StripeEventLike> {
    for (let attempt = 0; attempt < 30; attempt += 1) {
        const page = await stripe<{ data: StripeEventLike[] }>('GET', `/events?type=${encodeURIComponent(type)}&limit=20`);
        const found = page.data.find(e => match(e.data.object));
        if (found) return found;
        await new Promise(resolve => setTimeout(resolve, 2000));
    }
    throw new Error(`no ${type} event arrived`);
}

function eventObjectId(event: StripeEventLike): string {
    const id = event.data.object.id;
    if (typeof id !== 'string' || id === '') throw new Error('Stripe event is missing its object id');
    return id;
}

function signed(event: StripeEventLike): Request {
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${body}`).digest('hex');
    return new Request('http://localhost/api/billing/stripe/webhook', {
        method: 'POST', body, headers: { 'stripe-signature': `t=${t},v1=${v1}` },
    });
}

describe.skipIf(!enabled)('Stripe test-mode round trip (live, opt-in)', () => {
    const sql = postgres(databaseUrl, { max: 2 });
    const db = drizzle(sql);
    const store = createBillingStore(db as never);
    const client = createStripeClient({ secretKey: secret });
    const userId = randomUUID();
    const deps: BillingDeps = {
        config: { ...readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1' }), stripeSecret: secret, stripeWebhookSecret: WEBHOOK_SECRET },
        store,
        stripe: client,
        now: () => new Date(),
    };
    let customerId = '';
    let subscriptionId = '';
    let invoiceId = '';

    afterAll(async () => { await sql.end(); });

    it('creates and links a customer, and Stripe accepts our Checkout parameters', async () => {
        await sql`insert into auth.users (id) values (${userId})`;
        await db.insert(computers).values({ userId, slot: 1 });
        const customer = await client.createCustomer({ userId, email: null, idempotencyKey: `customer:${userId}` });
        customerId = customer.id;
        expect(await store.linkCustomer(userId, customerId)).toBe('linked');
        const session = await client.createCheckoutSession({
            customerId, userId, sku: 'pro_monthly_v1',
            uiMode: 'hosted', automaticTax: false,
            returnUrl: 'https://os.ezil.org/billing/return?session_id={CHECKOUT_SESSION_ID}',
            successUrl: 'https://os.ezil.org/billing/return?session_id={CHECKOUT_SESSION_ID}',
            cancelUrl: 'https://os.ezil.org/os', idempotencyKey: `checkout:${randomUUID()}`,
        });
        expect(session.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    });

    it('grants exactly one Pro period from a real invoice.paid, even when delivered twice', async () => {
        const product = await stripe('POST', '/products', { name: 'ezil-os billing e2e' });
        const price = await stripe('POST', '/prices', {
            product: product.id, currency: 'usd', unit_amount: '2000', 'recurring[interval]': 'month',
        });
        const pm = await stripe('POST', '/payment_methods/pm_card_visa/attach', { customer: customerId });
        const subscription = await stripe('POST', '/subscriptions', {
            customer: customerId, 'items[0][price]': price.id, default_payment_method: pm.id,
            'metadata[sku]': 'pro_monthly_v1', description: 'ezil-os billing e2e',
        });
        subscriptionId = subscription.id;

        const paid = await eventFor('invoice.paid', o => o.customer === customerId);
        invoiceId = eventObjectId(paid);
        const process = (event: StripeEventLike, d: { store: typeof store; stripe: typeof client; now: () => Date }) => processStripeEvent(event, d);

        const first = await handleStripeWebhook(signed(paid), deps, process);
        expect(first.status).toBe(200);
        const replay = await handleStripeWebhook(signed(paid), deps, process);
        expect(replay.status).toBe(200);

        const grants = await store.grantsBySource('invoice', invoiceId);
        expect(grants).toHaveLength(1);
        expect(grants[0]).toMatchObject({ userId, meter: 'workspace_seconds', kind: 'pro_period', amount: BigInt(72_000) });
        const outbox = await sql`select kind, payload from ezil_billing_outbox where event_key = ${`invoice:${invoiceId}:ai_included`}`;
        expect(outbox).toHaveLength(1);

        const summary = buildSummary({
            config: deps.config, now: new Date(),
            subs: await store.subscriptionsFor(userId),
            intervals: await store.intervalsFor(userId, new Date(0)),
            storage: await store.latestStorageFor(userId),
        });
        expect(summary.plan).toMatchObject({ id: 'pro', status: 'active' });
        expect(summary.meters.workspace.allowanceSeconds).toBe(72_000);
        expect(summary.actions.portal).toBe(true);
    }, 120_000);

    it('a bad signature is refused before anything is recorded', async () => {
        const paid = await eventFor('invoice.paid', o => o.id === invoiceId);
        const forged = new Request('http://localhost/api/billing/stripe/webhook', {
            method: 'POST', body: JSON.stringify(paid), headers: { 'stripe-signature': `t=${Math.floor(Date.now() / 1000)},v1=${'0'.repeat(64)}` },
        });
        expect((await handleStripeWebhook(forged, deps, processStripeEvent)).status).toBe(400);
    }, 60_000);

    it('a full refund revokes the period grant once', async () => {
        const invoice = await stripe<InvoicePayments>('GET', `/invoices/${invoiceId}?expand[]=payments`);
        const payment = invoice.payments?.data?.[0]?.payment;
        const paymentIntent = typeof payment?.payment_intent === 'string' ? payment.payment_intent : payment?.payment_intent?.id;
        expect(paymentIntent).toBeTruthy();
        if (!paymentIntent) throw new Error('Paid invoice is missing its payment intent');
        await stripe('POST', '/refunds', { payment_intent: paymentIntent });
        const refunded = await eventFor('refund.created', o => Boolean(o.charge) && o.status === 'succeeded' && o.payment_intent === paymentIntent);
        expect((await handleStripeWebhook(signed(refunded), deps, processStripeEvent)).status).toBe(200);
        const refundId = eventObjectId(refunded);
        const revokes = await store.grantsBySource('refund', refundId);
        expect(revokes.map(g => g.amount)).toEqual([BigInt(-72_000)]);
    }, 120_000);

    it('cancel at period end turns the plan into "cancels"', async () => {
        await stripe('POST', `/subscriptions/${subscriptionId}`, { cancel_at_period_end: 'true' });
        const updated = await eventFor('customer.subscription.updated', o => o.id === subscriptionId && o.cancel_at_period_end === true);
        expect((await handleStripeWebhook(signed(updated), deps, processStripeEvent)).status).toBe(200);
        const summary = buildSummary({
            config: deps.config, now: new Date(),
            subs: await store.subscriptionsFor(userId), intervals: [], storage: [],
        });
        expect(summary.plan.status).toBe('cancels');
        expect(summary.plan.cancelsAt).not.toBeNull();
    }, 120_000);
});
