/**
 * The Worker HTTP transport (`./spool-drain-transport.ts`) — the half of the
 * drain that talks to `POST /telemetry/drain` and `POST /telemetry/ack`.
 *
 * `fetch` is injected rather than the transport being mocked: what is under
 * test here IS the request the transport builds and the way it maps a
 * response, and both are exactly the details that killed this pipeline once
 * already (a missing `limit` turning one page into 200 sequential R2 gets
 * against a 20 s abort).
 */
import { describe, expect, it, vi } from 'vitest';

import { DRAIN_PAGE_LIMIT, createDrainTransport, createDrainTransportFromEnv } from './spool-drain-transport';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function transportWith(fetchImpl: typeof fetch, workerUrl: string | undefined = 'https://worker.test') {
    return createDrainTransport({ workerUrl, mintToken: () => 'tok-1', fetchImpl });
}

describe('createDrainTransport — drainPage', () => {
    it('🔴 always sends an explicit limit; omitting it is what stalls the first run against the backlog', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, objects: [], truncated: false }));
        await transportWith(fetchImpl as unknown as typeof fetch).drainPage(undefined);

        const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(JSON.parse(String(init.body))).toEqual({ limit: DRAIN_PAGE_LIMIT });
        expect(DRAIN_PAGE_LIMIT).toBeLessThan(200); // the Worker-side default this exists to override
    });

    it('carries the cursor and the bearer envelope, and posts to /telemetry/drain', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, objects: [], truncated: false }));
        await transportWith(fetchImpl as unknown as typeof fetch).drainPage('v1/dt=2026-08-19/x.ndjson');

        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://worker.test/telemetry/drain');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok-1');
        expect(JSON.parse(String(init.body)).cursor).toBe('v1/dt=2026-08-19/x.ndjson');
        expect(init.signal).toBeInstanceOf(AbortSignal); // one page can never eat the invocation
    });

    it('strips a trailing slash from the configured Worker URL rather than double-slashing the path', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, objects: [], truncated: false }));
        await transportWith(fetchImpl as unknown as typeof fetch, 'https://worker.test/').drainPage(undefined);
        expect((fetchImpl.mock.calls[0] as [string])[0]).toBe('https://worker.test/telemetry/drain');
    });

    it('returns the page verbatim on success', async () => {
        const objects = [{ key: 'v1/a.ndjson', body: '{"x":1}' }];
        const fetchImpl = vi
            .fn()
            .mockResolvedValue(jsonResponse({ ok: true, objects, cursor: 'v1/a.ndjson', truncated: true }));
        const page = await transportWith(fetchImpl as unknown as typeof fetch).drainPage(undefined);
        expect(page).toEqual({ ok: true, objects, cursor: 'v1/a.ndjson', truncated: true });
    });

    it.each([
        ['an unconfigured Worker URL', undefined, undefined],
        ['a non-2xx response', () => jsonResponse({ ok: true, objects: [] }, 502), 'https://worker.test'],
        ['a Worker-level {ok:false}', () => jsonResponse({ ok: false, error: 'nope' }), 'https://worker.test'],
        ['unparseable JSON', () => new Response('<html>'), 'https://worker.test'],
        [
            'a network error / abort',
            () => {
                throw new Error('fetch failed');
            },
            'https://worker.test',
        ],
    ])('collapses %s to {ok:false} — one uniform stop, never a throw', async (_label, make, workerUrl) => {
        const fetchImpl = vi.fn().mockImplementation(() => (make ? make() : undefined));
        const page = await transportWith(fetchImpl as unknown as typeof fetch, workerUrl).drainPage(undefined);
        expect(page).toEqual({ ok: false });
    });
});

describe('createDrainTransport — ack', () => {
    it('posts the keys to /telemetry/ack and reports the Worker`s own verdict', async () => {
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true }));
        const ok = await transportWith(fetchImpl as unknown as typeof fetch).ack(['v1/a.ndjson', 'v1/b.ndjson']);

        const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://worker.test/telemetry/ack');
        expect(JSON.parse(String(init.body))).toEqual({ keys: ['v1/a.ndjson', 'v1/b.ndjson'] });
        expect(ok).toBe(true);
    });

    it('never makes a round trip for an empty key list', async () => {
        const fetchImpl = vi.fn();
        expect(await transportWith(fetchImpl as unknown as typeof fetch).ack([])).toBe(true);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('returns false — never throws — when the Worker refuses or is unreachable', async () => {
        const refuse = vi.fn().mockResolvedValue(jsonResponse({ ok: false }));
        expect(await transportWith(refuse as unknown as typeof fetch).ack(['k'])).toBe(false);

        const blow = vi.fn().mockRejectedValue(new Error('boom'));
        expect(await transportWith(blow as unknown as typeof fetch).ack(['k'])).toBe(false);

        const unconfigured = createDrainTransport({ workerUrl: '', mintToken: () => 't', fetchImpl: vi.fn() });
        expect(await unconfigured.ack(['k'])).toBe(false);
    });
});

describe('createDrainTransportFromEnv', () => {
    it('mints the token from the configured HMAC secret, once per request', async () => {
        const mint = vi.fn().mockReturnValue('t=1,v1=deadbeef');
        const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ ok: true, objects: [], truncated: false }));
        vi.stubGlobal('fetch', fetchImpl);

        const transport = createDrainTransportFromEnv(
            { CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://worker.test', CLOUDFLARE_GUACAMOLE_HMAC_SECRET: 'secret' },
            mint,
        );
        await transport.drainPage(undefined);
        await transport.ack(['k']);

        expect(mint).toHaveBeenCalledTimes(2);
        expect(mint).toHaveBeenCalledWith('secret');
        vi.unstubAllGlobals();
    });

    it('passes an empty secret through rather than inventing one — the minter decides what that means', async () => {
        const mint = vi.fn().mockReturnValue('local-dev');
        createDrainTransportFromEnv({ CLOUDFLARE_GUACAMOLE_WORKER_URL: 'https://w.test' }, mint);
        // No call yet: the token is minted per request, not per transport, so a
        // long-lived transport can never ship an expired timestamp.
        expect(mint).not.toHaveBeenCalled();
    });
});
