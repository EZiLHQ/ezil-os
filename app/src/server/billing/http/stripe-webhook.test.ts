import { createHash, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { BillingDeps, BillingStore, StripeApi } from '../ports';
import { handleStripeWebhook, paidTopupIntent } from './stripe-webhook';

const wiring = vi.hoisted(() => ({ getDeps: vi.fn(), process: vi.fn() }));
// The scoped delivery itself is proven against Postgres (ai-credit-outbox.pg.test.ts); here only when the handler asks for it.
const topupDelivery = vi.hoisted(() => ({ deliver: vi.fn<typeof import('../ai-topup-delivery').deliverPaidTopup>(async () => 'skipped') }));
vi.mock('../ai-topup-delivery', () => ({ deliverPaidTopup: topupDelivery.deliver }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: wiring.getDeps }));
vi.mock('@/server/billing/processor', () => ({ processStripeEvent: wiring.process }));

import { POST, runtime, dynamic } from '@/app/api/billing/stripe/webhook/route';

const timestamp = 1_800_000_000;
const secret = 'fixture-only-webhook-secret';
const event = { id: 'evt_fixture', type: 'invoice.paid', created: timestamp, livemode: false, data: { object: { id: 'in_fixture' } } };
const rawBody = JSON.stringify(event);

function request(body = rawBody, signature?: string): Request {
    const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    return new Request('https://app.example/api/billing/stripe/webhook', {
        method: 'POST', body, headers: { 'stripe-signature': signature ?? `t=${timestamp},v1=${digest}` },
    });
}

function fixture() {
    const store = {
        recordEvent: vi.fn<BillingStore['recordEvent']>().mockResolvedValue('new'),
        markEventProcessed: vi.fn<BillingStore['markEventProcessed']>().mockResolvedValue(undefined),
    };
    const deps: BillingDeps = {
        usage: null,
        config: readBillingConfig({ STRIPE_SECRET: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: secret }),
        store: store as unknown as BillingStore, stripe: {} as StripeApi,
        now: () => new Date(timestamp * 1000),
    };
    const process = vi.fn<Parameters<typeof handleStripeWebhook>[2]>().mockResolvedValue('applied');
    return { deps, store, process };
}

async function positiveControl() {
    const f = fixture();
    const response = await handleStripeWebhook(request(), f.deps, f.process);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true });
    expect(f.process).toHaveBeenCalledTimes(1);
    expect(f.store.recordEvent).toHaveBeenCalledTimes(1);
    expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, 'applied');
    return f;
}

describe('Stripe webhook HTTP handler', () => {
    afterEach(() => vi.restoreAllMocks());

    it('wires the Node POST route through the configured ports and processor', async () => {
        const f = fixture();
        wiring.getDeps.mockReturnValue(f.deps);
        wiring.process.mockResolvedValue('applied');
        expect(runtime).toBe('nodejs');
        expect(dynamic).toBe('force-dynamic');
        expect((await POST(request())).status).toBe(200);
        expect(wiring.process).toHaveBeenCalledWith(event, { store: f.deps.store, stripe: f.deps.stripe, now: f.deps.now });
        expect(wiring.process).toHaveBeenCalledTimes(1);
        f.deps.config.stripeWebhookSecret = undefined;
        expect((await POST(request())).status).toBe(503);
        expect(wiring.process).toHaveBeenCalledTimes(1);
    });

    it('verifies the original body, hashes it and passes only processor ports', async () => {
        const f = await positiveControl();
        expect(f.process).toHaveBeenCalledWith(event, { store: f.deps.store, stripe: f.deps.stripe, now: f.deps.now });
        expect(f.store.recordEvent).toHaveBeenCalledWith({
            eventId: event.id, type: event.type, livemode: false,
            payloadSha256: createHash('sha256').update(rawBody).digest('hex'),
        });
    });

    it.each(['secret', 'stripe'])('returns 503 without %s before writing', async missing => {
        await positiveControl();
        const f = fixture();
        if (missing === 'secret') f.deps.config.stripeWebhookSecret = undefined;
        else f.deps.stripe = null;
        const response = await handleStripeWebhook(request(), f.deps, f.process);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'billing_not_configured' });
        expect(f.store.recordEvent).toHaveBeenCalledTimes(0);
        expect(f.process).toHaveBeenCalledTimes(0);
    });

    it.each(['sk_test_', 'rk_test_', 'sk_live_', 'rk_live_'])('processes matching livemode for %s', async prefix => {
        const f = fixture();
        f.deps.config.stripeSecret = `${prefix}fixture`;
        const matching = { ...event, livemode: prefix.includes('_live_') };
        const response = await handleStripeWebhook(request(JSON.stringify(matching)), f.deps, f.process);
        expect(response.status).toBe(200);
        expect(f.store.recordEvent).toHaveBeenCalledTimes(1);
        expect(f.process).toHaveBeenCalledWith(matching, { store: f.deps.store, stripe: f.deps.stripe, now: f.deps.now });
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, 'applied');
    });

    it.each(['sk_test_', 'rk_test_', 'sk_live_', 'rk_live_'])('rejects mismatched livemode for %s before any inbox access', async prefix => {
        const f = fixture();
        f.deps.config.stripeSecret = `${prefix}fixture`;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const mismatched = { ...event, livemode: !prefix.includes('_live_') };
        const response = await handleStripeWebhook(request(JSON.stringify(mismatched)), f.deps, f.process);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'livemode_mismatch' });
        expect(f.store.recordEvent).not.toHaveBeenCalled();
        expect(f.store.markEventProcessed).not.toHaveBeenCalled();
        expect(f.process).not.toHaveBeenCalled();
        expect(warn.mock.calls).toEqual([['[billing.webhook] livemode mismatch', { id: event.id, type: event.type }]]);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(f.deps.config.stripeSecret);
        expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    });

    it.each(['absent', 'mixed', 'unrecognized', 'invalid_publishable'].flatMap(reason =>
        [false, true].flatMap(livemode => [false, true].map(noClient => ({ reason, livemode, noClient }))),
    ))('rejects no mode ($reason, live=$livemode, noClient=$noClient)', async ({ reason, livemode, noClient }) => {
        const f = fixture();
        if (reason === 'absent') f.deps.config.stripeSecret = undefined;
        if (reason === 'mixed') f.deps.config.stripePublishableKey = 'pk_live_fixture';
        if (reason === 'unrecognized') f.deps.config.stripeSecret = 'fixture-only';
        if (reason === 'invalid_publishable') f.deps.config.stripePublishableKeyInvalid = true;
        if (noClient) f.deps.stripe = null;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const response = await handleStripeWebhook(request(JSON.stringify({ ...event, livemode })), f.deps, f.process);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'livemode_mismatch' });
        expect(f.store.recordEvent).not.toHaveBeenCalled();
        expect(f.store.markEventProcessed).not.toHaveBeenCalled();
        expect(f.process).not.toHaveBeenCalled();
        expect(warn.mock.calls).toEqual([['[billing.webhook] livemode mismatch', { id: event.id, type: event.type }]]);
    });

    it('checks signatures before diagnosing a mode mismatch', async () => {
        const f = fixture();
        f.deps.config.stripeSecret = undefined;
        f.deps.stripe = null;
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const response = await handleStripeWebhook(request(rawBody, 'invalid'), f.deps, f.process);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_signature' });
        expect(warn).not.toHaveBeenCalled();
        expect(f.store.recordEvent).not.toHaveBeenCalled();
        expect(f.process).not.toHaveBeenCalled();
    });

    it('accepts 256 KiB and refuses the next byte regardless of Content-Length', async () => {
        const f = fixture();
        const body = rawBody.padEnd(256 * 1024, ' ');
        expect((await handleStripeWebhook(request(body), f.deps, f.process)).status).toBe(200);
        expect(f.process).toHaveBeenCalledTimes(1);
        const oversized = request(`${body}é`);
        oversized.headers.set('content-length', '1');
        expect((await handleStripeWebhook(oversized, f.deps, f.process)).status).toBe(413);
        expect(f.process).toHaveBeenCalledTimes(1);
    });

    it.each(['', `t=${timestamp},v1=${'00'.repeat(32)}`, `t=${timestamp - 301},v1=${'00'.repeat(32)}`])('rejects bad signature %# without details or writes', async signature => {
        await positiveControl();
        const f = fixture();
        const response = await handleStripeWebhook(request(rawBody, signature), f.deps, f.process);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_signature' });
        expect(f.store.recordEvent).toHaveBeenCalledTimes(0);
        expect(f.process).toHaveBeenCalledTimes(0);
    });

    it.each(['{', 'null', '{}', JSON.stringify({ ...event, id: 123 })])('rejects signed malformed JSON/envelopes %#', async body => {
        await positiveControl();
        const f = fixture();
        expect((await handleStripeWebhook(request(body), f.deps, f.process)).status).toBe(400);
        expect(f.store.recordEvent).toHaveBeenCalledTimes(0);
        expect(f.process).toHaveBeenCalledTimes(0);
    });

    it('acknowledges a processed duplicate but reprocesses an unfinished delivery', async () => {
        const f = fixture();
        f.store.recordEvent.mockResolvedValueOnce('processed').mockResolvedValueOnce('unprocessed');
        const duplicate = await handleStripeWebhook(request(), f.deps, f.process);
        expect(duplicate.status).toBe(200);
        expect(await duplicate.json()).toEqual({ received: true, duplicate: true });
        expect(f.process).toHaveBeenCalledTimes(0);
        expect(f.store.markEventProcessed).toHaveBeenCalledTimes(0);
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(200);
        expect(f.process).toHaveBeenCalledTimes(1);
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, 'applied');
    });

    it('marks failed processing and returns 500 so Stripe retries', async () => {
        await positiveControl();
        const f = fixture();
        f.process.mockRejectedValueOnce(new Error('temporary failure\nretry'));
        const response = await handleStripeWebhook(request(), f.deps, f.process);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'processing_failed' });
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, 'failed:processing_unavailable');
        f.store.recordEvent.mockResolvedValue('unprocessed');
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(200);
        expect(f.process).toHaveBeenCalledTimes(2);
        expect(f.store.markEventProcessed).toHaveBeenLastCalledWith(event.id, 'applied');
    });

    it('still returns 500 when recording the failure also fails', async () => {
        await positiveControl();
        const f = fixture();
        f.process.mockRejectedValue(new Error('temporary failure'));
        f.store.markEventProcessed.mockRejectedValue(new Error('store unavailable'));
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(500);
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, 'failed:processing_unavailable');
    });

    it.each([`${rawBody}\n`, JSON.stringify({ ...event, type: 'invoice.updated' }),
        JSON.stringify({ ...event, data: { object: { id: 'different_invoice' } } })])('refuses a changed signed event without replacing its receipt: %s', async changedBody => {
        const f = fixture();
        let original: Parameters<BillingStore['recordEvent']>[0] | undefined;
        f.store.recordEvent.mockImplementation(async receipt => {
            if (!original) { original = receipt; return 'new'; }
            return receipt.payloadSha256 === original.payloadSha256 && receipt.type === original.type
                && receipt.livemode === original.livemode ? 'processed' : 'conflict';
        });
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(200);
        const preserved = { ...original };
        const conflict = await handleStripeWebhook(request(changedBody), f.deps, f.process);
        expect(conflict.status).toBe(409);
        expect(await conflict.json()).toEqual({ error: 'event_conflict' });
        expect(original).toEqual(preserved);
        expect(f.process).toHaveBeenCalledTimes(1);
        expect(f.store.markEventProcessed).toHaveBeenCalledTimes(1);
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(200);
        expect(f.process).toHaveBeenCalledTimes(1);
    });
    it('never marks a receipt when recording it failed before acceptance', async () => {
        const f = fixture();
        f.store.recordEvent.mockRejectedValue(new Error('private database credential'));
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(500);
        expect(f.store.markEventProcessed).not.toHaveBeenCalled();
        expect(f.process).not.toHaveBeenCalled();
    });
});

describe('retryable processor outcomes', () => {
    it.each(['failed:no_grant_for_refund', 'failed:no_grant_for_dispute'])('keeps %s retryable until the later delivery applies', async outcome => {
        const f = fixture();
        let recorded: string | null = null;
        f.store.recordEvent.mockImplementation(async () => recorded === null ? 'new' : recorded.startsWith('failed') ? 'unprocessed' : 'processed');
        f.store.markEventProcessed.mockImplementation(async (_id, value) => { recorded = value; });
        f.process.mockResolvedValueOnce(outcome).mockResolvedValue('applied');
        const response = await handleStripeWebhook(request(), f.deps, f.process);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'processing_failed' });
        expect(recorded).toBe(outcome);
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, outcome);
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(200);
        expect(recorded).toBe('applied');
        expect(await (await handleStripeWebhook(request(), f.deps, f.process)).json()).toEqual({ received: true, duplicate: true });
        expect(f.process).toHaveBeenCalledTimes(2);
    });

    it.each(['applied', 'ignored', 'review:no_base_line', 'review:pack_credits_unset', 'review:ai_restore_unresolved', 'unattributed:customer'])('acknowledges ordinary outcome %s', async outcome => {
        const f = fixture();
        f.process.mockResolvedValue(outcome);
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(200);
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, outcome);
    });
});

describe('a paid top-up is delivered from its own verified webhook (no sweep needed)', () => {
    const paid = (overrides: Record<string, unknown> = {}, type = 'checkout.session.completed') => ({ id: 'evt_topup', type, created: timestamp, livemode: false,
        data: { object: { id: 'cs_fixture', mode: 'payment', payment_status: 'paid', payment_intent: 'pi_fixture', customer: 'cus_fixture', ...overrides } } });
    const send = (f: ReturnType<typeof fixture>, value: unknown) => handleStripeWebhook(request(JSON.stringify(value)), f.deps, f.process);
    const reset = (outcome: 'delivered' | 'queued' | 'review' | 'skipped' = 'delivered') => topupDelivery.deliver.mockReset().mockResolvedValue(outcome);

    it('names the payment a verified event itself reports paid, and nothing else', () => {
        expect(paidTopupIntent(paid())).toBe('pi_fixture');
        expect(paidTopupIntent(paid({}, 'checkout.session.async_payment_succeeded'))).toBe('pi_fixture');
        expect(paidTopupIntent(paid({ payment_intent: { id: 'pi_expanded', amount: 5000 } }))).toBe('pi_expanded');
        // A completed checkout whose bank payment is still pending, or with no payment state at all, is not paid.
        for (const payment_status of ['unpaid', 'no_payment_required', undefined, null, 'PAID']) expect(paidTopupIntent(paid({ payment_status }))).toBeNull();
        expect(paidTopupIntent(paid({ mode: 'subscription' }))).toBeNull();
        expect(paidTopupIntent(paid({ mode: 'setup' }))).toBeNull();
        for (const payment_intent of [null, undefined, '', 'cs_fixture', 'pi_bad id', { id: 7 }, 42]) expect(paidTopupIntent(paid({ payment_intent }))).toBeNull();
        for (const type of ['checkout.session.expired', 'checkout.session.async_payment_failed', 'payment_intent.succeeded', 'invoice.paid', 'charge.refunded']) {
            expect(paidTopupIntent(paid({}, type))).toBeNull();
        }
    });

    it.each([
        ['delivered', 200, { received: true }],
        // Nothing a redelivery could change: nothing deliverable, or a terminal refusal already alerted for an operator.
        ['skipped', 200, { received: true }],
        ['review', 200, { received: true }],
        // Committed but not funded, and no browser may be polling: ask Stripe for this same signed event again.
        ['queued', 503, { error: 'delivery_pending' }],
    ] as const)('after the receipt is committed and the event marked processed, one attempt for exactly that payment: %s answers %i', async (outcome, status, body) => {
        reset(outcome);
        const f = fixture();
        const order: string[] = [];
        f.store.markEventProcessed.mockImplementation(async () => { order.push('marked'); });
        topupDelivery.deliver.mockImplementation(async () => { order.push('delivery'); return outcome; });
        const response = await send(f, paid());
        expect(response.status).toBe(status);
        expect(await response.json()).toEqual(body);
        expect(order).toEqual(['marked', 'delivery']);
        expect(f.store.markEventProcessed).toHaveBeenCalledTimes(1);
        expect(f.store.markEventProcessed).toHaveBeenCalledWith('evt_topup', 'applied');
        expect(topupDelivery.deliver).toHaveBeenCalledTimes(1);
        // The payment only: the owner is the stored receipt's, never taken from the event.
        expect(topupDelivery.deliver).toHaveBeenCalledWith(f.deps, { paymentIntentId: 'pi_fixture' });
    });

    it.each(['ignored', 'review:invalid_custom_amount', 'review:customer_mismatch', 'unattributed:customer', 'failed:ai_topup_receipts_unavailable'])(
        'a first delivery the processor did not apply (%s) attempts nothing', async outcome => {
            reset();
            const f = fixture();
            f.process.mockResolvedValue(outcome);
            await send(f, paid());
            expect(topupDelivery.deliver).not.toHaveBeenCalled();
        });

    it('an applied event that is not a paid top-up attempts nothing: unpaid checkout, subscription, invoice', async () => {
        reset();
        for (const value of [paid({ payment_status: 'unpaid' }), paid({ mode: 'subscription', payment_intent: null }), event]) {
            const f = fixture();
            expect((await send(f, value)).status).toBe(200);
            expect(f.process).toHaveBeenCalledTimes(1);
        }
        expect(topupDelivery.deliver).not.toHaveBeenCalled();
    });

    it('a verified redelivery of the processed event retries only the receipt: 503 while it is pending, then a final 2xx; the charge and ledger are never rerun', async () => {
        reset('queued');
        const f = fixture();
        f.store.recordEvent.mockResolvedValue('processed');
        const pending = await send(f, paid());
        expect(pending.status).toBe(503);
        expect(await pending.json()).toEqual({ error: 'delivery_pending' });
        for (const outcome of ['delivered', 'skipped', 'review'] as const) {
            topupDelivery.deliver.mockResolvedValueOnce(outcome);
            const done = await send(f, paid());
            expect(done.status).toBe(200);
            expect(await done.json()).toEqual({ received: true, duplicate: true });
        }
        expect(f.process).not.toHaveBeenCalled();
        expect(f.store.markEventProcessed).not.toHaveBeenCalled();
        expect(topupDelivery.deliver).toHaveBeenCalledTimes(4);
        expect(topupDelivery.deliver).toHaveBeenLastCalledWith(f.deps, { paymentIntentId: 'pi_fixture' });
    });

    it('every other acknowledgement is unchanged while a top-up is pending: unpaid, subscription and invoice replays and first deliveries stay 2xx with no attempt', async () => {
        reset('queued');
        const f = fixture();
        for (const value of [paid({ payment_status: 'unpaid' }), paid({ mode: 'subscription', payment_intent: null }), event]) {
            f.store.recordEvent.mockResolvedValueOnce('new');
            const first = await send(f, value);
            expect([first.status, await first.json()]).toEqual([200, { received: true }]);
            f.store.recordEvent.mockResolvedValueOnce('processed');
            const replay = await send(f, value);
            expect([replay.status, await replay.json()]).toEqual([200, { received: true, duplicate: true }]);
        }
        expect(topupDelivery.deliver).not.toHaveBeenCalled();
    });

    it('nothing unverified, mismatched or conflicting reaches delivery: bad signature, live event on test keys, payload conflict, store failure', async () => {
        reset();
        const f = fixture();
        const body = JSON.stringify(paid());
        expect((await handleStripeWebhook(request(body, `t=${timestamp},v1=${'0'.repeat(64)}`), f.deps, f.process)).status).toBe(400);
        expect((await send(f, { ...paid(), livemode: true })).status).toBe(400);
        f.store.recordEvent.mockResolvedValueOnce('conflict');
        expect((await send(f, paid())).status).toBe(409);
        f.store.recordEvent.mockRejectedValueOnce(new Error('db down'));
        expect((await send(f, paid())).status).toBe(500);
        f.store.markEventProcessed.mockRejectedValueOnce(new Error('db down'));
        expect((await send(f, paid())).status).toBe(500);
        expect(topupDelivery.deliver).not.toHaveBeenCalled();
    });
});
