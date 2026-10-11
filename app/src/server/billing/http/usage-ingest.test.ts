import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { BillingDeps, BillingStore, UsageEvent } from '../ports';
import { handleUsageIngest } from './usage-ingest';

const wiring = vi.hoisted(() => ({ getDeps: vi.fn(), ingest: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: wiring.getDeps }));
vi.mock('@/server/billing/processor', () => ({ ingestUsageEvents: wiring.ingest }));

import { POST, runtime, dynamic } from '@/app/api/billing/usage/route';

const timestamp = 1_800_000_000;
const secret = 'fixture-only-usage-secret';
const event: UsageEvent = { type: 'start', computerId: '11111111-1111-4111-8111-111111111111', at: '2027-01-15T08:00:00Z' };
const rawBody = JSON.stringify({ events: [event] });

function request(body = rawBody, time: number | string = timestamp, key = secret): Request {
    const signature = createHmac('sha256', key).update(`${time}.${body}`).digest('hex');
    return new Request('https://app.example/api/billing/usage', {
        method: 'POST', body, headers: { 'x-ezil-timestamp': String(time), 'x-ezil-signature': `v1=${signature}` },
    });
}

function fixture() {
    const deps: BillingDeps = {
        config: readBillingConfig({ BILLING_USAGE_HMAC_SECRET: secret }),
        store: {} as BillingStore, stripe: null, now: () => new Date(timestamp * 1000),
    };
    const ingest = vi.fn<Parameters<typeof handleUsageIngest>[2]>().mockResolvedValue({ accepted: 1, rejected: 0 });
    return { deps, ingest };
}

async function positiveControl() {
    const f = fixture();
    const response = await handleUsageIngest(request(), f.deps, f.ingest);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ accepted: 1, rejected: 0 });
    expect(f.ingest).toHaveBeenCalledWith([event], { store: f.deps.store, now: f.deps.now });
    return f;
}

describe('usage ingest HTTP handler', () => {
    it('wires the Node POST route through the configured ports and processor', async () => {
        const f = fixture();
        wiring.getDeps.mockReturnValue(f.deps);
        wiring.ingest.mockResolvedValue({ accepted: 1, rejected: 0 });
        expect(runtime).toBe('nodejs');
        expect(dynamic).toBe('force-dynamic');
        const response = await POST(request());
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ accepted: 1, rejected: 0 });
        expect(wiring.ingest).toHaveBeenCalledWith([event], { store: f.deps.store, now: f.deps.now });
        expect(wiring.ingest).toHaveBeenCalledTimes(1);
        f.deps.config.usageHmacSecret = undefined;
        expect((await POST(request())).status).toBe(503);
        expect(wiring.ingest).toHaveBeenCalledTimes(1);
    });

    it('accepts a valid independently signed batch', async () => {
        await positiveControl();
    });

    it('returns 503 without a configured secret', async () => {
        await positiveControl();
        const f = fixture();
        f.deps.config.usageHmacSecret = undefined;
        const response = await handleUsageIngest(request(), f.deps, f.ingest);
        expect(response.status).toBe(503);
        expect(await response.json()).toEqual({ error: 'billing_not_configured' });
        expect(f.ingest).toHaveBeenCalledTimes(0);
    });

    it.each(['x-ezil-timestamp', 'x-ezil-signature'])('requires %s', async header => {
        await positiveControl();
        const f = fixture();
        const req = request();
        req.headers.delete(header);
        expect((await handleUsageIngest(req, f.deps, f.ingest)).status).toBe(401);
        expect(f.ingest).toHaveBeenCalledTimes(0);
    });

    it.each([-1, 1])('allows 300 seconds of skew but not 301 in direction %i', async direction => {
        const f = fixture();
        expect((await handleUsageIngest(request(rawBody, timestamp + direction * 300), f.deps, f.ingest)).status).toBe(200);
        expect(f.ingest).toHaveBeenCalledTimes(1);
        expect((await handleUsageIngest(request(rawBody, timestamp + direction * 301), f.deps, f.ingest)).status).toBe(401);
        expect(f.ingest).toHaveBeenCalledTimes(1);
    });

    it.each(['NaN', 'Infinity', '1800000000.5', '1.8e9', '9007199254740992'])('rejects malformed timestamps %s', async time => {
        await positiveControl();
        const f = fixture();
        expect((await handleUsageIngest(request(rawBody, time), f.deps, f.ingest)).status).toBe(401);
        expect(f.ingest).toHaveBeenCalledTimes(0);
    });

    it.each(['v1=00', 'v1=zz', `v2=${'00'.repeat(32)}`, `v1=${'00'.repeat(32)}`])('rejects malformed or incorrect MAC %#', async signature => {
        await positiveControl();
        const f = fixture();
        const req = request();
        req.headers.set('x-ezil-signature', signature);
        const response = await handleUsageIngest(req, f.deps, f.ingest);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'invalid_signature' });
        expect(f.ingest).toHaveBeenCalledTimes(0);
    });

    it('rejects a different signing key or changed body', async () => {
        await positiveControl();
        const f = fixture();
        expect((await handleUsageIngest(request(rawBody, timestamp, 'wrong-fixture-key'), f.deps, f.ingest)).status).toBe(401);
        const original = request();
        const changed = new Request(original.url, { method: 'POST', headers: original.headers, body: `${rawBody} ` });
        expect((await handleUsageIngest(changed, f.deps, f.ingest)).status).toBe(401);
        expect(f.ingest).toHaveBeenCalledTimes(0);
    });

    it('accepts 500 events and rejects 501', async () => {
        const f = fixture();
        const batch = (count: number) => JSON.stringify({ events: Array.from({ length: count }, () => event) });
        f.ingest.mockResolvedValue({ accepted: 499, rejected: 1 });
        const response = await handleUsageIngest(request(batch(500)), f.deps, f.ingest);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ accepted: 499, rejected: 1 });
        expect(f.ingest).toHaveBeenCalledTimes(1);
        expect((await handleUsageIngest(request(batch(501)), f.deps, f.ingest)).status).toBe(400);
        expect(f.ingest).toHaveBeenCalledTimes(1);
    });

    it('accepts 256 KiB and refuses the next byte', async () => {
        const f = fixture();
        const body = rawBody.padEnd(256 * 1024, ' ');
        expect((await handleUsageIngest(request(body), f.deps, f.ingest)).status).toBe(200);
        expect(f.ingest).toHaveBeenCalledTimes(1);
        expect((await handleUsageIngest(request(`${body}é`), f.deps, f.ingest)).status).toBe(413);
        expect(f.ingest).toHaveBeenCalledTimes(1);
    });

    it.each(['{', 'null', '{}', '{"events":{}}', '{"events":[{"type":"unknown"}]}'])('rejects malformed signed batches %#', async body => {
        await positiveControl();
        const f = fixture();
        expect((await handleUsageIngest(request(body), f.deps, f.ingest)).status).toBe(400);
        expect(f.ingest).toHaveBeenCalledTimes(0);
    });

    it('passes all four event kinds and decimal storage bytes to the processor', async () => {
        const f = fixture();
        const events: UsageEvent[] = [event, { ...event, type: 'stop', reason: 'sleep' }, { ...event, type: 'heartbeat' }, {
            type: 'storage', computerId: event.computerId, at: event.at, bytes: '9007199254740993',
        }];
        expect((await handleUsageIngest(request(JSON.stringify({ events })), f.deps, f.ingest)).status).toBe(200);
        expect(f.ingest).toHaveBeenCalledWith(events, { store: f.deps.store, now: f.deps.now });
    });

    it('returns 500 on a transient ingest failure', async () => {
        await positiveControl();
        const f = fixture();
        f.ingest.mockRejectedValue(new Error('temporary failure'));
        const response = await handleUsageIngest(request(), f.deps, f.ingest);
        expect(response.status).toBe(500);
        expect(await response.json()).toEqual({ error: 'ingest_failed' });
    });
});
