import { z } from 'zod';

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

/** The inbox distinguishes a completed delivery from a retry whose effects still need applying. */
export async function handleStripeWebhook(request: Request, deps: BillingDeps, process: Process): Promise<Response> {
    if (!deps.config.stripeWebhookSecret || !deps.stripe) {
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
    try {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(rawBody));
        const payloadSha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
        const recorded = await deps.store.recordEvent({
            eventId: event.id, type: event.type, livemode: event.livemode, payloadSha256,
        });
        if (recorded === 'processed') return Response.json({ received: true, duplicate: true });
        const outcome = await process(event, { store: deps.store, stripe: deps.stripe, now: deps.now });
        await deps.store.markEventProcessed(event.id, outcome);
        return Response.json({ received: true });
    } catch (error) {
        const message = (error instanceof Error ? error.message : 'processing failed').replace(/[\r\n\t]/g, ' ').slice(0, 160);
        try {
            await deps.store.markEventProcessed(event.id, `failed: ${message}`);
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
