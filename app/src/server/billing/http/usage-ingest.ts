import { z } from 'zod';

import type { BillingDeps, UsageEvent } from '../ports';
import { readBillingBody } from './stripe-webhook';

const eventFields = {
    computerId: z.string().min(1),
    at: z.string().datetime({ offset: true }),
};
const payload = z.object({
    events: z.array(z.union([
        z.object({ ...eventFields, type: z.enum(['start', 'stop', 'heartbeat']), reason: z.string().optional() }),
        z.object({ ...eventFields, type: z.literal('storage'), bytes: z.string().regex(/^\d+$/) }),
    ])).max(500),
});

type Ingest = (events: UsageEvent[], deps: Pick<BillingDeps, 'store' | 'now'>) => Promise<{ accepted: number; rejected: number }>;

/** WebCrypto verifies the MAC without a data-dependent JavaScript comparison. */
export async function handleUsageIngest(request: Request, deps: BillingDeps, ingest: Ingest): Promise<Response> {
    const secret = deps.config.usageHmacSecret;
    if (!secret) return Response.json({ error: 'billing_not_configured' }, { status: 503 });
    const timestamp = request.headers.get('x-ezil-timestamp');
    const signature = request.headers.get('x-ezil-signature');
    if (!timestamp || !/^\d+$/.test(timestamp) || !Number.isSafeInteger(Number(timestamp))
        || !Number.isFinite(deps.now().getTime())
        || Math.abs(deps.now().getTime() / 1000 - Number(timestamp)) > 300
        || !signature || !/^v1=[0-9a-fA-F]{64}$/.test(signature)) {
        return Response.json({ error: 'invalid_signature' }, { status: 401 });
    }
    let rawBody: string | null;
    try {
        rawBody = await readBillingBody(request);
    } catch {
        return Response.json({ error: 'invalid_body' }, { status: 400 });
    }
    if (rawBody === null) return Response.json({ error: 'body_too_large' }, { status: 413 });
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
    const mac = new Uint8Array(signature.slice(3).match(/../g)!.map(byte => Number.parseInt(byte, 16)));
    if (!await crypto.subtle.verify('HMAC', key, mac, encoder.encode(`${timestamp}.${rawBody}`))) {
        return Response.json({ error: 'invalid_signature' }, { status: 401 });
    }
    let events: UsageEvent[];
    try {
        events = payload.parse(JSON.parse(rawBody)).events;
    } catch {
        return Response.json({ error: 'invalid_events' }, { status: 400 });
    }
    try {
        return Response.json(await ingest(events, { store: deps.store, now: deps.now }));
    } catch {
        return Response.json({ error: 'ingest_failed' }, { status: 500 });
    }
}

export default async function usageIngest(request: Request, deps: BillingDeps): Promise<Response> {
    return handleUsageIngest(request, deps, async (events, processorDeps) => {
        const { ingestUsageEvents } = await import('@/server/billing/processor');
        return ingestUsageEvents(events, processorDeps);
    });
}
