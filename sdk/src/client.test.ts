/**
 * The client, against a stub `fetch`. No network, no server.
 *
 * These pin the wire shape, because the wire is the thing this package owns
 * outright (see `transport.ts` for why `@trpc/client` is not a dependency). If
 * tRPC's HTTP contract or the superjson transformer changes under us, these are
 * what notice.
 */
import { describe, expect, it } from 'bun:test';
import superjson from 'superjson';

import { createEzilClient } from './client';
import { EzilError } from './errors';

/** A `fetch` that records what it was asked and replies with a canned body. */
const stub = (reply: { status?: number; body: unknown }) => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
        seen.push({ url: String(url), init });
        return new Response(JSON.stringify(reply.body), {
            status: reply.status ?? 200,
            headers: { 'content-type': 'application/json' },
        });
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, seen };
};

const ok = (data: unknown) => ({ result: { data: superjson.serialize(data) } });
const fail = (code: string, message: string, httpStatus: number) => ({
    error: { json: { message, code, data: { code, httpStatus } } },
});

const client = (fetchImpl: typeof globalThis.fetch, token: unknown = 'tok') =>
    createEzilClient({ baseUrl: 'https://example.test', token: token as string, fetch: fetchImpl });

describe('createEzilClient', () => {
    it('refuses to construct without a baseUrl or a token', () => {
        expect(() => createEzilClient({ baseUrl: '', token: 't' })).toThrow(EzilError);
        expect(() => createEzilClient({ baseUrl: 'https://x.test', token: '' })).toThrow(EzilError);
    });

    it('sends the token as a bearer on every call', async () => {
        const { fetchImpl, seen } = stub({ body: ok([]) });
        await client(fetchImpl).computers.list();
        expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
    });

    it('accepts a token function, so an expiring token can be refreshed', async () => {
        const { fetchImpl, seen } = stub({ body: ok([]) });
        let calls = 0;
        const c = createEzilClient({
            baseUrl: 'https://example.test',
            token: () => `fresh-${++calls}`,
            fetch: fetchImpl,
        });
        await c.computers.list();
        await c.computers.list();
        expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer fresh-1');
        expect((seen[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer fresh-2');
    });

    it('sends queries as GET with a superjson-encoded input', async () => {
        const { fetchImpl, seen } = stub({ body: ok({ id: 'c1' }) });
        await client(fetchImpl).computers.get('c1');
        const url = new URL(seen[0]!.url);
        expect(seen[0]!.init.method).toBe('GET');
        expect(url.pathname).toBe('/api/trpc/computer.get');
        expect(JSON.parse(url.searchParams.get('input')!)).toEqual({ json: { id: 'c1' } });
    });

    it('sends mutations as POST with the input in the body', async () => {
        const { fetchImpl, seen } = stub({ body: ok({ id: 'c2' }) });
        await client(fetchImpl).computers.rename('c2', 'Studio');
        expect(seen[0]!.init.method).toBe('POST');
        expect(new URL(seen[0]!.url).pathname).toBe('/api/trpc/computer.rename');
        expect(JSON.parse(seen[0]!.init.body as string)).toEqual({ json: { id: 'c2', name: 'Studio' } });
    });

    it('omits `input` entirely for a no-argument query', async () => {
        const { fetchImpl, seen } = stub({ body: ok([]) });
        await client(fetchImpl).computers.list();
        expect(new URL(seen[0]!.url).searchParams.has('input')).toBe(false);
    });

    it('tolerates a baseUrl with a trailing slash or a path prefix', async () => {
        const a = stub({ body: ok([]) });
        await createEzilClient({ baseUrl: 'https://x.test/', token: 't', fetch: a.fetchImpl }).computers.list();
        expect(new URL(a.seen[0]!.url).pathname).toBe('/api/trpc/computer.list');

        const b = stub({ body: ok([]) });
        await createEzilClient({ baseUrl: 'https://x.test/ezil', token: 't', fetch: b.fetchImpl }).computers.list();
        expect(new URL(b.seen[0]!.url).pathname).toBe('/ezil/api/trpc/computer.list');
    });

    // 🔴 The reason superjson is a dependency at all. Without deserialization
    // `createdAt` is a string that merely looks like a Date, and every date
    // comparison a caller writes is silently wrong.
    it('revives Dates rather than handing back strings', async () => {
        const when = new Date('2026-08-19T12:00:00.000Z');
        const { fetchImpl } = stub({
            body: ok([{ id: 'c1', name: 'Computer', slot: 1, createdAt: when, lastOpenedAt: null }]),
        });
        const [computer] = await client(fetchImpl).computers.list();
        expect(computer!.createdAt).toBeInstanceOf(Date);
        expect(computer!.createdAt.toISOString()).toBe(when.toISOString());
        expect(computer!.lastOpenedAt).toBeNull();
    });

    it('turns a tRPC error into an EzilError carrying the code and status', async () => {
        const { fetchImpl } = stub({ status: 401, body: fail('UNAUTHORIZED', 'no session', 401) });
        const err = await client(fetchImpl).computers.list().catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EzilError);
        const e = err as EzilError;
        expect(e.code).toBe('UNAUTHORIZED');
        expect(e.status).toBe(401);
        expect(e.path).toBe('computer.list');
        expect(e.isUnauthorized).toBe(true);
        expect(e.isNotFound).toBe(false);
    });

    it('flags a missing or someone-else\'s computer as not-found', async () => {
        const { fetchImpl } = stub({ status: 404, body: fail('NOT_FOUND', 'no such computer', 404) });
        const e = (await client(fetchImpl).computers.get('nope').catch((x: unknown) => x)) as EzilError;
        expect(e.isNotFound).toBe(true);
    });

    it('reports a non-JSON response as a transport error rather than crashing', async () => {
        const fetchImpl = (async () =>
            new Response('<html>502 Bad Gateway</html>', { status: 502 })) as unknown as typeof globalThis.fetch;
        const e = (await client(fetchImpl).computers.list().catch((x: unknown) => x)) as EzilError;
        expect(e).toBeInstanceOf(EzilError);
        expect(e.status).toBe(502);
        expect(e.message).toContain('non-JSON');
    });

    it('reports an unreachable host without leaking the raw fetch error', async () => {
        const fetchImpl = (async () => {
            throw new TypeError('fetch failed');
        }) as unknown as typeof globalThis.fetch;
        const e = (await client(fetchImpl).computers.list().catch((x: unknown) => x)) as EzilError;
        expect(e).toBeInstanceOf(EzilError);
        expect(e.message).toContain('could not reach');
    });

    // 🔴 Without a timeout, a cold boot that never answers hangs the caller
    // forever — which in an MCP server or a CLI is indistinguishable from a crash.
    it('times out rather than hanging forever', async () => {
        const fetchImpl = ((_url: string, init: RequestInit = {}) =>
            new Promise((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            })) as unknown as typeof globalThis.fetch;
        const c = createEzilClient({ baseUrl: 'https://x.test', token: 't', fetch: fetchImpl, timeoutMs: 30 });
        const e = (await c.computers.list().catch((x: unknown) => x)) as EzilError;
        expect(e).toBeInstanceOf(EzilError);
        expect(e.message).toContain('timed out');
    });

    it('treats a success envelope with no data as an error, not as undefined', async () => {
        const { fetchImpl } = stub({ body: { result: {} } });
        const e = (await client(fetchImpl).computers.list().catch((x: unknown) => x)) as EzilError;
        expect(e).toBeInstanceOf(EzilError);
        expect(e.message).toContain('no result');
    });
});
