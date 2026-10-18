import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { BillingDeps, BillingStore, StripeApi } from '../ports';
import { handleStripeWebhook } from './stripe-webhook';

const wiring = vi.hoisted(() => ({ getDeps: vi.fn(), process: vi.fn() }));
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
        config: readBillingConfig({ STRIPE_WEBHOOK_SECRET: secret }),
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

    it.each(['secret', 'stripe'])('returns 503 without %s before reading or writing', async missing => {
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
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, 'failed: temporary failure retry');
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
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, 'failed: temporary failure');
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

    it.each(['applied', 'ignored', 'review:no_base_line', 'unattributed:customer'])('acknowledges ordinary outcome %s', async outcome => {
        const f = fixture();
        f.process.mockResolvedValue(outcome);
        expect((await handleStripeWebhook(request(), f.deps, f.process)).status).toBe(200);
        expect(f.store.markEventProcessed).toHaveBeenCalledWith(event.id, outcome);
    });
});
