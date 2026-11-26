import { z } from 'zod';

import { deliverPaidTopup } from '../ai-topup-delivery';
import { stripeMode } from '../config';
import type { BillingDeps, ProcessorDeps } from '../ports';
import type { StripeEventLike } from '../stripe/events';
import { verifyStripeSignature, WebhookNotVerified } from '../stripe/verify';

const MAX_BODY_BYTES = 256 * 1024;
const envelope = z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    created: z.number().int().nonnegative(),
    livemode: z.boolean(),
    data: z.object({ object: z.record(z.unknown()) }),
});

/** Count streamed bytes, since Content-Length may be missing or untrusted. */
export async function readBillingBody(request: Request): Promise<string | null> {
    if (!request.body) return '';
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0;
    let body = '';
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) return body + decoder.decode();
            bytes += value.byteLength;
            if (bytes > MAX_BODY_BYTES) {
                await reader.cancel();
                return null;
            }
            body += decoder.decode(value, { stream: true });
        }
    } finally {
        reader.releaseLock();
    }
}

type Process = (event: StripeEventLike, deps: ProcessorDeps) => Promise<string>;

/**
 * The payment intent of a top-up checkout this verified event itself reports paid, or null: the two event types the
 * processor funds (`planStripeEvent`), a payment-mode session, and `payment_status` exactly `paid` (a completed
 * checkout whose bank payment is still pending is not). It only names which stored receipt to deliver: whether one
 * exists, its owner, amount and credits are the receipt's (`topupScope`), written after the processor's own re-read.
 */
export function paidTopupIntent(event: StripeEventLike): string | null {
    if (event.type !== 'checkout.session.completed' && event.type !== 'checkout.session.async_payment_succeeded') return null;
    const session = event.data.object;
    if (session.mode !== 'payment' || session.payment_status !== 'paid') return null;
    const intent = session.payment_intent;
    const id = typeof intent === 'string' ? intent : (intent as { id?: unknown } | null | undefined)?.id;
    return typeof id === 'string' && /^pi_[A-Za-z0-9_]+$/.test(id) ? id : null;
}

/**
 * One bounded delivery attempt for the paid top-up this event names; true only while its committed receipt is still
 * genuinely pending (a failed or timed-out send, its backoff, another worker's lease, an unreadable store, or the
 * funding URL or key missing while a deliverable receipt exists). Delivered, nothing deliverable (no receipt, already
 * delivered, reversed) and a terminal refusal (`review`: an operator's, already alerted) are all false: nothing a
 * redelivery could change, so Stripe is not asked to send it again.
 */
async function topupDeliveryPending(event: StripeEventLike, deps: BillingDeps): Promise<boolean> {
    const paymentIntentId = paidTopupIntent(event);
    return paymentIntentId !== null && await deliverPaidTopup(deps, { paymentIntentId }) === 'queued';
}

/**
 * The receipt is committed but not funded yet, and the payer may have closed every tab: ask Stripe to send this same
 * signed event again. The inbox already holds it as processed, so a redelivery only retries the receipt's delivery
 * (the same `eventId`, applied once), and ends 2xx once it is delivered or can no longer be. Top-up events only:
 * every other acknowledgement is unchanged.
 */
const deliveryPending = () => Response.json({ error: 'delivery_pending' }, { status: 503 });

/** The inbox distinguishes a completed delivery from a retry whose effects still need applying. */
export async function handleStripeWebhook(request: Request, deps: BillingDeps, process: Process): Promise<Response> {
    if (!deps.config.stripeWebhookSecret) {
        return Response.json({ error: 'billing_not_configured' }, { status: 503 });
    }
    let rawBody: string | null;
    try {
        rawBody = await readBillingBody(request);
    } catch {
        return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    if (rawBody === null) return Response.json({ error: 'body_too_large' }, { status: 413 });
    try {
        await verifyStripeSignature({
            rawBody,
            header: request.headers.get('stripe-signature'),
            secret: deps.config.stripeWebhookSecret,
            nowMs: deps.now().getTime(),
        });
    } catch (error) {
        return Response.json({ error: error instanceof WebhookNotVerified ? 'invalid_signature' : 'verification_failed' }, {
            status: error instanceof WebhookNotVerified ? 400 : 500,
        });
    }
    let event: StripeEventLike;
    try {
        event = envelope.parse(JSON.parse(rawBody));
    } catch {
        return Response.json({ error: 'invalid_event' }, { status: 400 });
    }
    const mode = stripeMode(deps.config).mode;
    if (mode === null || event.livemode !== (mode === 'live')) {
        console.warn('[billing.webhook] livemode mismatch', { id: event.id, type: event.type });
        return Response.json({ error: 'livemode_mismatch' }, { status: 400 });
    }
    if (!deps.stripe) {
        return Response.json({ error: 'billing_not_configured' }, { status: 503 });
    }
    let acceptedReceipt = false;
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
        const payloadSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const recorded = await deps.store.recordEvent({
            eventId: event.id, type: event.type, livemode: event.livemode, payloadSha256,
        });
        if (recorded === 'conflict') return Response.json({ error: 'event_conflict' }, { status: 409 });
        if (recorded === 'processed') {
            // A verified replay of a processed event reruns no charge and no ledger; it retries that payment's pending receipt.
            if (await topupDeliveryPending(event, deps)) return deliveryPending();
            return Response.json({ received: true, duplicate: true });
        }
        acceptedReceipt = true;
        const outcome = await process(event, { store: deps.store, stripe: deps.stripe, now: deps.now });
        await deps.store.markEventProcessed(event.id, outcome);
        if (outcome.startsWith('failed:')) {
            return Response.json({ error: 'processing_failed' }, { status: 500 });
        }
        // The receipt is committed and the event marked processed; one bounded attempt to fund it now changes neither.
        if (outcome === 'applied' && await topupDeliveryPending(event, deps)) return deliveryPending();
        return Response.json({ received: true });
    } catch {
        try {
            // An unaccepted or conflicting delivery must never change another receipt.
            if (acceptedReceipt) await deps.store.markEventProcessed(event.id, 'failed:processing_unavailable');
        } catch {
            // A failed inbox write must also ask Stripe to retry.
        }
        return Response.json({ error: 'processing_failed' }, { status: 500 });
    }
}

export default async function stripeWebhook(request: Request, deps: BillingDeps): Promise<Response> {
    return handleStripeWebhook(request, deps, async (event, processorDeps) => {
        const { processStripeEvent } = await import('@/server/billing/processor');
        return processStripeEvent(event, processorDeps);
    });
}
