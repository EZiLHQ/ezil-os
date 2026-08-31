/**
 * The server, driven over a REAL MCP transport by a REAL MCP client.
 *
 * initialize → tools/list → tools/call, through the actual protocol
 * implementation, the actual tool registrations, the actual SDK and the actual
 * tRPC wire encoding. The ONLY thing stubbed is the socket: `fetch` is replaced
 * by a small fake EZiL-OS that answers tRPC envelopes.
 *
 * This exists because the unit tests in `tools.test.ts` call the handlers
 * directly, which proves the handlers work and proves nothing about whether
 * they are correctly registered, whether their schemas survive serialization,
 * or whether a client can actually reach them. That gap is exactly where a
 * green suite stops meaning anything.
 */
import { describe, expect, it } from 'bun:test';
import superjson from 'superjson';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from './server';

const COMPUTER = {
    id: '11111111-1111-4111-8111-111111111111',
    userId: 'u1',
    name: 'Studio',
    slot: 1,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    lastOpenedAt: null,
    deletedAt: null,
    metadata: null,
};

/** A fake EZiL-OS: speaks the tRPC envelope, records what it was asked. */
const fakeEzil = () => {
    const seen: { path: string; method: string; auth: string | null }[] = [];
    const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
        const u = new URL(String(url));
        const path = u.pathname.replace('/api/trpc/', '');
        const headers = (init.headers ?? {}) as Record<string, string>;
        seen.push({ path, method: init.method ?? 'GET', auth: headers.authorization ?? null });

        const reply = (data: unknown) =>
            new Response(JSON.stringify({ result: { data: superjson.serialize(data) } }), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });

        if (path === 'computer.list') return reply([COMPUTER]);
        if (path === 'cloudflareGuacamole.previewUrl') {
            return reply({ ok: true, url: 'https://desktop.example/c?token=short-lived' });
        }
        if (path === 'computer.get') {
            return new Response(
                JSON.stringify({ error: { json: { message: 'not found', code: 'NOT_FOUND', data: { code: 'NOT_FOUND', httpStatus: 404 } } } }),
                { status: 404, headers: { 'content-type': 'application/json' } },
            );
        }
        return reply({ ok: true });
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, seen };
};

const connect = async () => {
    const { fetchImpl, seen } = fakeEzil();
    const server = createServer({ baseUrl: 'https://ezil.example', token: 'tok', timeoutMs: 5000 }, fetchImpl);
    const client = new Client({ name: 'test-harness', version: '0.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server, seen };
};

describe('the MCP server, over a real transport', () => {
    it('completes initialize and advertises tool support', async () => {
        const { client, server } = await connect();
        expect(client.getServerCapabilities()?.tools).toBeDefined();
        expect(client.getServerVersion()?.name).toBe('ezil-os');
        await server.close();
    });

    it('answers tools/list with every tool, each carrying a description', async () => {
        const { client, server } = await connect();
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name).sort();
        expect(names).toContain('list_computers');
        expect(names).toContain('open_desktop');
        expect(names).toContain('delete_computer');
        expect(tools.length).toBe(10);
        for (const t of tools) expect((t.description ?? '').length).toBeGreaterThan(20);
        await server.close();
    });

    it('publishes input schemas that survive the wire', async () => {
        const { client, server } = await connect();
        const { tools } = await client.listTools();
        const get = tools.find((t) => t.name === 'get_computer')!;
        expect(get.inputSchema.type).toBe('object');
        expect(Object.keys(get.inputSchema.properties ?? {})).toContain('computerId');
        await server.close();
    });

    // 🔴 The whole round trip: client → protocol → tool → SDK → tRPC wire.
    it('calls a tool end to end and returns real data', async () => {
        const { client, server, seen } = await connect();
        const res = await client.callTool({ name: 'list_computers', arguments: {} });
        const content = res.content as { type: string; text: string }[];
        const parsed = JSON.parse(content[0]!.text) as { id: string; name: string }[];
        expect(parsed[0]!.name).toBe('Studio');
        // and it really went out over the wire, authenticated
        expect(seen[0]!.path).toBe('computer.list');
        expect(seen[0]!.auth).toBe('Bearer tok');
        await server.close();
    });

    it('sends mutations as POST, not GET', async () => {
        const { client, server, seen } = await connect();
        await client.callTool({ name: 'open_desktop', arguments: { computerId: COMPUTER.id } });
        expect(seen[0]).toEqual({ path: 'cloudflareGuacamole.previewUrl', method: 'POST', auth: 'Bearer tok' });
        await server.close();
    });

    it('rejects a call whose arguments fail the schema, without reaching the network', async () => {
        const { client, server, seen } = await connect();
        const res = await client.callTool({ name: 'get_computer', arguments: { computerId: 'not-a-uuid' } });
        expect(res.isError).toBe(true);
        expect(seen).toEqual([]);
        await server.close();
    });

    // 🔴 A server error must come back as an isError RESULT, not as a thrown
    // protocol error — a thrown one can take the whole session down.
    it('surfaces a server-side failure as an isError result, not a transport crash', async () => {
        const { client, server } = await connect();
        const res = await client.callTool({ name: 'get_computer', arguments: { computerId: COMPUTER.id } });
        expect(res.isError).toBe(true);
        const content = res.content as { text: string }[];
        expect(content[0]!.text).toContain('list_computers');
        await server.close();
    });

    it('refuses delete_computer without confirm, over the real protocol', async () => {
        const { client, server, seen } = await connect();
        const res = await client.callTool({ name: 'delete_computer', arguments: { computerId: COMPUTER.id } });
        expect(res.isError).toBe(true);
        expect(seen).toEqual([]); // never even asked the server
        await server.close();
    });
});
