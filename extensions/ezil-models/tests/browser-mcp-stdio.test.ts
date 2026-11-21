import { describe, expect, test } from 'bun:test';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import { hasBrowserCapability, serveBrowserMcp, type BrowserRequest } from '../src/browser-mcp-stdio';

const cap = 'a'.repeat(43);

function session(request: BrowserRequest) {
    const input = new PassThrough();
    const output = new PassThrough();
    const lines = createInterface({ input: output });
    const responses = lines[Symbol.asyncIterator]();
    serveBrowserMcp(input, output, cap, request);
    const send = (message: object) => input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
    return {
        send,
        receive: async () => JSON.parse((await responses.next()).value),
        close: () => { input.end(); lines.close(); output.end(); },
    };
}

async function initialize(mcp: ReturnType<typeof session>) {
    mcp.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect((await mcp.receive()).result).toMatchObject({
        protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ezil-browser' },
    });
    mcp.send({ method: 'notifications/initialized' });
}

function open(mcp: ReturnType<typeof session>, args: object, id = 3) {
    mcp.send({ id, method: 'tools/call', params: { name: 'browser_open_url', arguments: args } });
}

describe('Code Browser MCP', () => {
    test('requires the trusted launch gate and capability', () => {
        expect(hasBrowserCapability({})).toBe(false);
        expect(hasBrowserCapability({ EZIL_CODE_BROWSER_MCP_TOKEN: cap })).toBe(false);
        expect(hasBrowserCapability({ EZIL_CODE_BROWSER_MCP: 'on', EZIL_CODE_BROWSER_MCP_TOKEN: cap + '\n' })).toBe(false);
        expect(hasBrowserCapability({ EZIL_CODE_BROWSER_MCP: 'on', EZIL_CODE_BROWSER_MCP_TOKEN: cap })).toBe(true);
    });

    test('lists a URL-only tool and calls the fixed localhost operation with the boot token', async () => {
        let requestId: string | undefined;
        const mcp = session((async (url, init) => {
            expect(url).toBe('http://127.0.0.1:9223/internal/code/browser/open-url');
            expect(init?.redirect).toBe('error');
            expect(init?.method).toBe('POST');
            expect(new Headers(init?.headers).get('authorization')).toBe('Bearer ' + cap);
            expect(new Headers(init?.headers).has('origin')).toBe(false);
            const body = JSON.parse(String(init?.body));
            requestId = body.requestId;
            expect(Object.keys(body).sort()).toEqual(['requestId', 'timeoutMs', 'url']);
            expect(body.url).toBe('http://127.0.0.1:3032/fixture');
            expect(body.timeoutMs).toBe(15000);
            return Response.json({
                ok: true, runId: requestId, finalUrl: body.url, title: 'Project Fixture', httpStatus: 404, elapsedMs: 4,
                debug: cap,
            });
        }));
        try {
            await initialize(mcp);
            mcp.send({ id: 2, method: 'tools/list' });
            const list = await mcp.receive();
            expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['browser_open_url']);
            expect(Object.keys(list.result.tools[0].inputSchema.properties).sort()).toEqual(['timeoutMs', 'url']);
            open(mcp, { url: 'http://127.0.0.1:3032/fixture' });
            const { result } = await mcp.receive();
            expect(requestId).toMatch(/^[a-f0-9-]{36}$/);
            expect(result.isError).toBe(false);
            expect(result.structuredContent).toEqual({
                ok: true, runId: requestId, finalUrl: 'http://127.0.0.1:3032/fixture',
                title: 'Project Fixture', httpStatus: 404, elapsedMs: 4,
            });
            expect(JSON.stringify(result)).not.toContain(cap);
        } finally { mcp.close(); }
    });

    test('refuses a computer selector, an invalid scheme and out-of-range timeout before dispatch', async () => {
        let calls = 0;
        const mcp = session((async () => { calls++; return Response.error(); }));
        try {
            await initialize(mcp);
            for (const args of [
                { url: 'https://example.test/', computerId: 'other-computer' },
                { url: 'file:///etc/hosts' },
                { url: 'https://user:pass@example.test' },
                { url: 'https://example.test/', timeoutMs: 30001 },
            ]) {
                open(mcp, args);
                expect((await mcp.receive()).error.code).toBe(-32602);
            }
            expect(calls).toBe(0);
        } finally { mcp.close(); }
    });

    test('preserves a scoped failure receipt and withholds unexpected data on transport failure', async () => {
        let calls = 0;
        const mcp = session((async (_url, init) => {
            if (++calls === 2) return Response.json({ message: cap }, { status: 401 });
            return Response.json({
                ok: false, runId: JSON.parse(String(init?.body)).requestId,
                error: 'destination_denied', stage: 'destination', retryable: false,
            });
        }));
        try {
            await initialize(mcp);
            open(mcp, { url: 'https://example.test/' });
            const failure = (await mcp.receive()).result;
            expect(failure.isError).toBe(true);
            expect(failure.structuredContent).toMatchObject({ error: 'destination_denied', stage: 'destination' });
            open(mcp, { url: 'https://example.test/' }, 4);
            const transport = (await mcp.receive()).result;
            expect(transport.structuredContent).toMatchObject({ error: 'browser_unavailable', retryable: false });
            expect(JSON.stringify(transport)).not.toContain(cap);
        } finally { mcp.close(); }
    });

    test('withholds a cross-origin receipt and preserves a canonical busy failure', async () => {
        let calls = 0;
        const mcp = session(async (_url, init) => {
            const runId = JSON.parse(String(init.body)).requestId;
            if (++calls === 1) return Response.json({
                ok: true, runId, finalUrl: 'https://other.test/fixture', title: 'Other',
                httpStatus: 200, elapsedMs: 12,
            });
            return Response.json({ ok: false, runId, error: 'browser_busy', stage: 'runtime', retryable: true });
        });
        try {
            await initialize(mcp);
            open(mcp, { url: 'https://example.test/' });
            const denied = (await mcp.receive()).result;
            expect(denied.structuredContent.error).toBe('browser_unavailable');
            expect(JSON.stringify(denied)).not.toContain('other.test');
            open(mcp, { url: 'https://example.test/' }, 4);
            expect((await mcp.receive()).result.structuredContent)
                .toMatchObject({ error: 'browser_busy', stage: 'runtime', retryable: true });
        } finally { mcp.close(); }
    });

    test('cancels the local request when the MCP client cancels and keeps the connection usable', async () => {
        const aborted = Promise.withResolvers<void>();
        const mcp = session((async (_url, init) => new Promise<Response>((resolve) => {
            init?.signal?.addEventListener('abort', () => { aborted.resolve(); resolve(Response.error()); }, { once: true });
        })));
        try {
            await initialize(mcp);
            open(mcp, { url: 'https://example.test/' });
            mcp.send({ method: 'notifications/cancelled', params: { requestId: 3 } });
            await aborted.promise;
            mcp.send({ id: 4, method: 'ping' });
            expect(await mcp.receive()).toEqual({ jsonrpc: '2.0', id: 4, result: {} });
        } finally { mcp.close(); }
    });
});
