import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { gatewayChat, forgetGatewayModels, gatewayModels, type GatewayOptions } from '../src/gateway';
import type { ResolvedModel } from '../src/config';
import type { ChatRequest, StreamEvent } from '../src/types';
import { ask, gw } from './fixtures/gateway';
import { frames as messagesFrames } from './fixtures/gateway-response';

const responsesModel = (): ResolvedModel => ({ ...gw('reviewed-azure'), gatewayProtocol: 'openai-responses' });
const catalog = (maxInput = 131072, maxOutput = 4096) => ({ data: [
    { id: 'reviewed-azure', enabled: true, max_input_tokens: maxInput, max_output_tokens: maxOutput, protocols: ['openai-responses'] },
] });
const output = { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text: 'Visible answer', annotations: [] }] };
const usage = { input_tokens: 123, output_tokens: 17, input_tokens_details: { cached_tokens: 11 } };
const completed = () => ({ object: 'response', id: 'resp_1', status: 'completed', output: [output], usage });
const frame = (type: string, fields: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
const finish = () => frame('response.completed', { response: completed() });
const partial = () => frame('response.output_item.added', { output_index: 0, item: { ...output, status: 'in_progress', content: [] } })
    + frame('response.output_text.delta', { item_id: output.id, output_index: 0, content_index: 0, delta: 'Visible answer' });
const success = (wire = finish()) => new Response(wire, { headers: {
    'content-type': 'text/event-stream', 'x-ezil-request-id': 'responses-request', 'x-ezil-hold-micro': '420000',
} });
type Call = { url: string; init: RequestInit };
function server(reply: (call: Call, index: number) => Response | Promise<Response>, catalogValue: unknown = catalog()) {
    const reads: Call[] = []; const posts: Call[] = [];
    return { reads, posts, fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const call = { url: String(input), init };
        init.signal?.throwIfAborted();
        if (call.url.endsWith('/models')) { reads.push(call); return Response.json(catalogValue); }
        posts.push(call); return reply(call, posts.length - 1);
    }) as typeof fetch };
}
async function run(fetch: typeof globalThis.fetch, options: Partial<GatewayOptions> = {}, model = responsesModel(), request: ChatRequest = ask()) {
    const events: StreamEvent[] = [];
    for await (const event of gatewayChat(model, request, {
        signal: new AbortController().signal, newIdempotencyKey: () => 'one-operation', now: () => 0,
        sleep: async () => { throw new Error('Unexpected retry wait'); }, fetch, ...options,
    })) events.push(event);
    return events;
}
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
// Other suites share this synthetic provider identity; always read this test's catalog.
beforeEach(() => forgetGatewayModels());
afterEach(() => forgetGatewayModels());

describe('Responses transport contract', () => {
    for (const stream of [true, false]) test(`clamped Responses ${stream ? 'SSE' : 'JSON'} logs only the reply limit notice`, async () => {
        const s = server(() => {
            const response = stream ? success() : Response.json(completed());
            response.headers.set('x-ezil-output-limit-clamped', '512');
            response.headers.set('x-ezil-output-limit-requested', '4096');
            return response;
        });
        const logs: string[] = [];
        const events = await run(s.fetch, { log: line => logs.push(line) }, { ...responsesModel(), stream });
        expect(logs).toHaveLength(2);
        expect(logs[0]).toBe('Reply limited to 512 tokens to fit your credit balance');
        expect(JSON.parse(logs[1]!).error_code).toBeNull();
        expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', value: 'Visible answer' }]);
        expect(s.posts).toHaveLength(1);
    });
    for (const catalogValue of [{}, { data: [] }, { data: [{ ...catalog().data[0], protocols: undefined }] },
        { data: [{ ...catalog().data[0], protocols: ['anthropic-messages'] }] },
        { data: [{ ...catalog().data[0], enabled: false }] }, { ...catalog(), killswitch: true },
    ]) test(`direct invocation refuses unadvertised or disabled Responses: ${JSON.stringify(catalogValue)}`, async () => {
        const s = server(() => success(), catalogValue);
        await expect(run(s.fetch)).rejects.toThrow('available Responses route');
        expect(s.reads).toHaveLength(1); expect(s.posts).toHaveLength(0);
        expect(new Headers(s.reads[0]!.init.headers).get('authorization')).toBe('Bearer synthetic-proxy-token');
    });

    test('direct invocation uses catalog caps, configured proxy URL, exact headers and metadata-only logging', async () => {
        const s = server(() => success(), catalog(32768, 2048));
        const model = responsesModel();
        model.provider = { ...model.provider, headers: { 'x-api-key': 'ignored-key', 'anthropic-beta': 'ignored-beta' }, betas: ['ignored-beta'] };
        const logs: string[] = [];
        const events = await run(s.fetch, { log: line => logs.push(line) }, model);
        expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', value: 'Visible answer' }]);
        expect(s.posts).toHaveLength(1);
        const call = s.posts[0]!;
        expect(call.url).toBe('https://proxy.invalid/ai/v1/responses');
        expect(call.init.method).toBe('POST'); expect(call.init.redirect).toBe('error');
        expect(Object.fromEntries(new Headers(call.init.headers))).toEqual({
            authorization: 'Bearer synthetic-proxy-token', 'content-type': 'application/json', accept: 'text/event-stream', 'idempotency-key': 'one-operation',
        });
        expect(JSON.parse(new TextDecoder().decode(call.init.body as Uint8Array))).toMatchObject({ model: 'reviewed-azure', store: false, max_output_tokens: 2048 });
        expect(model.maxOutputTokens).toBe(8192);
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]!)).toEqual({ request_id: 'responses-request', model: 'reviewed-azure', stream: true, hold: '420000',
            http_status: 200, latency_ms: 0, usage: { input: 123, output: 17, cache_read: 11, cache_write: 0 }, stop_reason: 'end_turn', error_code: null });
        expect(logs.join()).not.toMatch(/Hello|Visible answer|synthetic-proxy-token|ignored-key|ignored-beta/);
        expect(new Headers(s.reads[0]!.init.headers).get('authorization')).toBe('Bearer synthetic-proxy-token');
        await expect(run(s.fetch, {}, model, ask([{ role: 'user', parts: [{ type: 'text', value: '字'.repeat(11000) }] }]))).rejects.toThrow('Conversation too large');
        expect(s.posts).toHaveLength(1);
    });

    for (const succeeds of [true, false]) test(`pre-header failure retries identical bytes/key once (${succeeds ? 'success' : 'two failures'})`, async () => {
        const s = server((_call, index) => { if (index === 0 || !succeeds) throw new TypeError('private transport detail'); return success(); });
        const logs: string[] = [];
        const result = run(s.fetch, { log: line => logs.push(line) });
        if (succeeds) await result; else await expect(result).rejects.toThrow('cannot reach');
        expect(s.posts).toHaveLength(2); expect(s.reads).toHaveLength(1);
        expect(s.posts[1]!.init.body).toBe(s.posts[0]!.init.body);
        expect(new Headers(s.posts[1]!.init.headers).get('idempotency-key')).toBe('one-operation');
        expect(new Headers(s.posts[0]!.init.headers).get('idempotency-key')).toBe('one-operation');
        expect(logs).toHaveLength(1); expect(logs.join()).not.toContain('private transport detail');
    });

    for (const failure of ['json-body', 'sse-body', 'error-body', 'eof', 'malformed', 'missing-usage', 'unterminated'] as const) test(`${failure} after headers is never retried`, async () => {
        const s = server(() => {
            if (failure.endsWith('body')) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('private body failure')); } }), {
                status: failure === 'error-body' ? 401 : 200, headers: { 'content-type': failure === 'sse-body' ? 'text/event-stream' : 'application/json', 'x-ezil-request-id': 'broken-body' },
            });
            const tail = failure === 'malformed' ? 'event: response.completed\ndata: {\n\n'
                : failure === 'unterminated' ? finish().slice(0, -1)
                : failure === 'missing-usage' ? frame('response.completed', { response: { ...completed(), usage: null } }) : '';
            return success(partial() + tail);
        });
        const logs: string[] = []; const events: StreamEvent[] = [];
        const model = { ...responsesModel(), stream: failure !== 'json-body' };
        let error: unknown;
        try { for await (const event of gatewayChat(model, ask(), { fetch: s.fetch, signal: new AbortController().signal, log: line => logs.push(line) })) events.push(event); }
        catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error); expect(s.posts).toHaveLength(1);
        expect(events.filter(event => event.type === 'usage' || event.type === 'stop')).toEqual([]);
        if (['eof', 'malformed', 'missing-usage', 'unterminated'].includes(failure)) expect(events).toEqual([{ type: 'text', value: 'Visible answer' }]);
        expect(logs).toHaveLength(1); expect(logs.join()).not.toContain('private body failure');
    });

    test('invalid UTF-8 inside an otherwise completed JSON response fails without output or retry', async () => {
        const encoded = new TextEncoder().encode(JSON.stringify(completed()));
        const marker = new TextEncoder().encode('Visible answer');
        const offset = encoded.findIndex((_byte, index) => marker.every((byte, inner) => encoded[index + inner] === byte));
        expect(offset).toBeGreaterThan(0);
        encoded[offset] = 0xff; // JSON syntax stays valid if a decoder silently replaces malformed UTF-8.
        const s = server(() => new Response(encoded, { headers: { 'content-type': 'application/json', 'x-ezil-request-id': 'invalid-utf8' } }));
        const events: StreamEvent[] = []; const logs: string[] = []; let error: unknown;
        try {
            for await (const event of gatewayChat({ ...responsesModel(), stream: false }, ask(), {
                fetch: s.fetch, signal: new AbortController().signal, log: line => logs.push(line),
            })) events.push(event);
        } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error); expect(events).toEqual([]); expect(s.posts).toHaveLength(1);
        expect(logs).toHaveLength(1); expect(JSON.parse(logs[0]!).error_code).not.toBeNull();
    });

    for (const [status, reason, expectedCode] of [['incomplete', 'max_output_tokens', 'max_tokens'], ['incomplete', 'content_filter', 'response_incomplete'], ['failed', undefined, 'response_failed']] as const) {
        test(`terminal ${status}/${reason ?? 'error'} records authoritative usage and fails without retry`, async () => {
            const terminal = { ...completed(), status, ...(reason ? { incomplete_details: { reason } } : { error: { code: 'provider_error', message: 'private failure detail' } }) };
            const s = server(() => success(partial() + frame(`response.${status}`, { response: terminal })));
            const logs: string[] = []; const events: StreamEvent[] = [];
            let error: unknown;
            try { for await (const event of gatewayChat(responsesModel(), ask(), { fetch: s.fetch, signal: new AbortController().signal, log: line => logs.push(line) })) events.push(event); }
            catch (caught) { error = caught; }
            expect(error).toMatchObject({ code: expectedCode }); expect(s.posts).toHaveLength(1);
            expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', value: 'Visible answer' }]);
            expect(events.filter(event => event.type === 'usage')).toEqual([{ type: 'usage', usage: { inputTokens: 123, outputTokens: 17, cacheReadTokens: 11, cacheWriteTokens: 0 } }]);
            expect(JSON.parse(logs[0]!)).toMatchObject({ usage: { input: 123, output: 17, cache_read: 11, cache_write: 0 }, error_code: expectedCode });
            expect(logs.join()).not.toContain('private failure detail');
        });
    }

    test('unterminated terminal SSE never releases a completed function call', async () => {
        const tool = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}', status: 'completed' };
        const wire = frame('response.completed', { response: { ...completed(), output: [tool] } }).slice(0, -1);
        const s = server(() => success(wire)); const events: StreamEvent[] = [];
        let error: unknown;
        try {
            for await (const event of gatewayChat(responsesModel(), { ...ask(), tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] }, {
                fetch: s.fetch, signal: new AbortController().signal,
            })) events.push(event);
        } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error); expect(events).toEqual([]); expect(s.posts).toHaveLength(1);
    });

    for (const stream of [true, false]) test(`unsolicited function calls are rejected before VS Code receives them (${stream ? 'SSE' : 'JSON'})`, async () => {
        const value = { ...completed(), output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'unexpected_tool', arguments: '{}', status: 'completed' }] };
        const s = server(() => stream ? success(frame('response.completed', { response: value })) : Response.json(value));
        const events: StreamEvent[] = []; let error: unknown;
        try {
            for await (const event of gatewayChat({ ...responsesModel(), stream }, ask(), { fetch: s.fetch, signal: new AbortController().signal })) events.push(event);
        } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error); expect(events).toEqual([]); expect(s.posts).toHaveLength(1);
    });

    for (const code of ['rate_limited', 'concurrency_limit']) test(`cancellation during ${code} backoff sends no second operation`, async () => {
        const abort = new AbortController(); const logs: string[] = [];
        const s = server(() => Response.json({ error: { code } }, { status: 429, headers: { 'retry-after': '2' } }));
        let enter!: () => void; let resume!: () => void;
        const sleeping = new Promise<void>(resolve => { enter = resolve; });
        const resumed = new Promise<void>(resolve => { resume = resolve; });
        const pending = run(s.fetch, { signal: abort.signal, log: line => logs.push(line), sleep: async () => { enter(); await resumed; } });
        await sleeping; expect(s.posts).toHaveLength(1);
        abort.abort(); resume();
        expect(await pending).toEqual([]); expect(s.posts).toHaveLength(1);
        expect(JSON.parse(logs[0]!)).toMatchObject({ error_code: 'cancelled' });
    });
});

/** The body, rather than receipt of headers, holds a slot across both protocols. */
function heldServer() {
    let active = 0; let peak = 0;
    const calls: string[] = []; const cancelled: string[] = [];
    const bodies = new Map<string, { controller: ReadableStreamDefaultController<Uint8Array>; responses: boolean; settle(): void }>();
    const s = server(call => {
        const key = new Headers(call.init.headers).get('idempotency-key')!;
        calls.push(key); active++; peak = Math.max(peak, active);
        let settled = false;
        const settle = () => { if (!settled) { settled = true; active--; } };
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) { bodies.set(key, { controller, responses: call.url.endsWith('/responses'), settle }); },
            cancel() { cancelled.push(key); settle(); },
        }), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': key } });
    });
    return { ...s, calls, cancelled, active: () => active, peak: () => peak,
        finish(key: string) {
            const body = bodies.get(key)!;
            body.controller.enqueue(new TextEncoder().encode(body.responses ? finish() : messagesFrames().join('')));
            body.controller.close(); body.settle();
        },
    };
}

describe('Responses shares Gateway admission and cancellation', () => {
    test('Messages and Responses bodies share two slots for the same credential, across equivalent provider objects', async () => {
        const s = heldServer(); const response = responsesModel(); const messages = gw();
        response.provider = { ...messages.provider, name: 'another-display-name', headers: { 'ignored-header': 'ignored-value' } };
        await gatewayModels(response.provider, s.fetch, 0);
        const first = run(s.fetch, { newIdempotencyKey: () => 'messages-1' }, messages);
        const second = run(s.fetch, { newIdempotencyKey: () => 'responses-1' }, response);
        await flush(); expect(s.calls).toEqual(['messages-1', 'responses-1']);
        const third = run(s.fetch, { newIdempotencyKey: () => 'responses-2' }, response);
        const fourth = run(s.fetch, { newIdempotencyKey: () => 'messages-2' }, messages);
        await flush(); expect(s.calls).toHaveLength(2); expect(s.active()).toBe(2);
        s.finish('messages-1'); await flush(); expect(s.calls).toHaveLength(3); expect(s.active()).toBe(2);
        s.finish('responses-1'); await flush(); expect(s.calls).toHaveLength(4); expect(s.active()).toBe(2);
        s.finish('responses-2'); s.finish('messages-2');
        const results = await Promise.all([first, second, third, fourth]);
        expect(results.every(events => events.some(event => event.type === 'stop'))).toBe(true);
        expect(s.peak()).toBe(2); expect(s.active()).toBe(0); expect(s.posts).toHaveLength(4);
    });

    test('queued Responses cancellation removes the waiter without sending inference', async () => {
        const s = heldServer(); const response = responsesModel(); const abort = new AbortController();
        await gatewayModels(response.provider, s.fetch, 0);
        const first = run(s.fetch, { newIdempotencyKey: () => 'messages' }, gw());
        const second = run(s.fetch, { newIdempotencyKey: () => 'responses' }, response);
        await flush();
        const cancelled = run(s.fetch, { newIdempotencyKey: () => 'cancelled', signal: abort.signal }, response);
        const next = run(s.fetch, { newIdempotencyKey: () => 'next' }, response);
        await flush(); expect(s.calls).toEqual(['messages', 'responses']);
        abort.abort(); expect(await cancelled).toEqual([]);
        s.finish('messages'); await flush(); expect(s.calls).toEqual(['messages', 'responses', 'next']);
        s.finish('responses'); s.finish('next'); await Promise.all([first, second, next]);
        expect(s.peak()).toBe(2); expect(s.active()).toBe(0);
    });

    test('in-progress Responses cancellation aborts its body and admits a waiting Messages request once', async () => {
        const s = heldServer(); const response = responsesModel(); const abort = new AbortController(); const logs: string[] = [];
        await gatewayModels(response.provider, s.fetch, 0);
        const cancelled = run(s.fetch, { newIdempotencyKey: () => 'cancelled', signal: abort.signal, log: line => logs.push(line) }, response);
        const second = run(s.fetch, { newIdempotencyKey: () => 'responses' }, response);
        await flush();
        const next = run(s.fetch, { newIdempotencyKey: () => 'messages' }, gw());
        await flush(); expect(s.calls).toEqual(['cancelled', 'responses']);
        abort.abort(); expect(await cancelled).toEqual([]);
        await flush(); expect(s.calls).toEqual(['cancelled', 'responses', 'messages']);
        expect(s.cancelled).toEqual(['cancelled']);
        s.finish('responses'); s.finish('messages'); await Promise.all([second, next]);
        expect(s.peak()).toBe(2); expect(s.active()).toBe(0);
        expect(JSON.parse(logs[0]!)).toMatchObject({ error_code: 'cancelled', notice: 'cancelled; may still be charged (request cancelled)' });
    });
});

describe('Responses validates the complete tool batch before releasing any calls', () => {
    const requestedTools = [{ name: 'read_file', inputSchema: { type: 'object' } }, { name: 'list_files', inputSchema: { type: 'object' } }];
    const toolOutput = (name: string, id: string, args = '{}') => ({
        type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: args, status: 'completed',
    });
    const expectedCalls: Extract<StreamEvent, { type: 'tool_call' }>[] = [
        { type: 'tool_call', callId: 'call_read', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'tool_call', callId: 'call_list', name: 'list_files', input: { directory: 'src' } },
    ];
    const validOutput = () => [output, toolOutput('read_file', 'read', '{"path":"a.ts"}'), toolOutput('list_files', 'list', '{"directory":"src"}')];

    for (const stream of [true, false]) {
        for (const fault of ['allowed-then-unrequested', 'unrequested-then-allowed', 'late-invalid-arguments', 'invalid-terminal', 'invalid-usage'] as const) {
            test(`${stream ? 'SSE' : 'JSON'} ${fault} releases zero tool calls and never retries`, async () => {
                const value: Record<string, unknown> = { ...completed(), output: validOutput() };
                if (fault === 'allowed-then-unrequested') value.output = [output, toolOutput('read_file', 'read'), toolOutput('unrequested_tool', 'other')];
                if (fault === 'unrequested-then-allowed') value.output = [output, toolOutput('unrequested_tool', 'other'), toolOutput('read_file', 'read')];
                if (fault === 'late-invalid-arguments') value.output = [output, toolOutput('read_file', 'read'), toolOutput('list_files', 'list', '{')];
                if (fault === 'invalid-terminal') value.status = 'in_progress';
                if (fault === 'invalid-usage') value.usage = { ...usage, output_tokens: -1 };
                const s = server(() => stream ? success(partial() + frame('response.completed', { response: value })) : Response.json(value));
                const events: StreamEvent[] = []; let error: unknown; let mintedKeys = 0; let waits = 0;
                try {
                    for await (const event of gatewayChat({ ...responsesModel(), stream }, { ...ask(), tools: requestedTools }, {
                        fetch: s.fetch, signal: new AbortController().signal,
                        newIdempotencyKey: () => { mintedKeys++; return 'batch-operation'; }, sleep: async () => { waits++; },
                    })) events.push(event);
                } catch (caught) { error = caught; }
                expect(error).toBeInstanceOf(Error);
                if (fault === 'allowed-then-unrequested' || fault === 'unrequested-then-allowed') expect(error).toMatchObject({ code: 'invalid_response' });
                expect(events.filter(event => event.type === 'tool_call')).toEqual([]);
                expect(events.filter(event => event.type === 'usage' || event.type === 'stop')).toEqual([]);
                if (stream) expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', value: 'Visible answer' }]);
                expect(s.posts).toHaveLength(1); expect(mintedKeys).toBe(1); expect(waits).toBe(0);
                expect(new Headers(s.posts[0]!.init.headers).get('idempotency-key')).toBe('batch-operation');
            });
        }

        test(`${stream ? 'SSE' : 'JSON'} valid multiple requested tools are each released exactly once`, async () => {
            const value = { ...completed(), output: validOutput() };
            const s = server(() => stream ? success(partial() + frame('response.completed', { response: value })) : Response.json(value));
            let mintedKeys = 0; let waits = 0;
            const events = await run(s.fetch, { newIdempotencyKey: () => { mintedKeys++; return 'valid-batch-operation'; }, sleep: async () => { waits++; } },
                { ...responsesModel(), stream }, { ...ask(), tools: requestedTools });
            expect(events.filter(event => event.type === 'tool_call')).toEqual(expectedCalls);
            expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', value: 'Visible answer' }]);
            expect(events.filter(event => event.type === 'usage')).toHaveLength(1);
            expect(events.filter(event => event.type === 'stop')).toHaveLength(1);
            expect(s.posts).toHaveLength(1); expect(mintedKeys).toBe(1); expect(waits).toBe(0);
            expect(new Headers(s.posts[0]!.init.headers).get('idempotency-key')).toBe('valid-batch-operation');
        });

        test(`${stream ? 'SSE' : 'JSON'} mutating request tools after serialization cannot authorize an unoffered tool`, async () => {
            const request = { ...ask(), tools: [{ name: 'read_file', inputSchema: { type: 'object' } }] };
            const value = { ...completed(), output: [toolOutput('read_file', 'read'), toolOutput('unrequested_tool', 'other')] };
            const s = server(() => stream ? success(frame('response.completed', { response: value })) : Response.json(value));
            const events: StreamEvent[] = []; let error: unknown; let callbacks = 0; let mintedKeys = 0; let waits = 0;
            try {
                for await (const event of gatewayChat({ ...responsesModel(), stream }, request, {
                    fetch: s.fetch, signal: new AbortController().signal,
                    newIdempotencyKey: () => { mintedKeys++; return 'mutated-batch-operation'; }, sleep: async () => { waits++; },
                    onRequest: () => { callbacks++; request.tools.push({ name: 'unrequested_tool', inputSchema: { type: 'object' } }); },
                })) events.push(event);
            } catch (caught) { error = caught; }
            expect(error).toBeInstanceOf(Error); expect(events).toEqual([]);
            expect(callbacks).toBe(1); expect(request.tools.map(tool => tool.name)).toEqual(['read_file', 'unrequested_tool']);
            expect(JSON.parse(new TextDecoder().decode(s.posts[0]!.init.body as Uint8Array)).tools.map((tool: { name: string }) => tool.name)).toEqual(['read_file']);
            expect(s.posts).toHaveLength(1); expect(mintedKeys).toBe(1); expect(waits).toBe(0);
            expect(new Headers(s.posts[0]!.init.headers).get('idempotency-key')).toBe('mutated-batch-operation');
        });
    }

    test('JSON preserves text interleaved with a valid batch of requested tools', async () => {
        const textItem = (id: string, text: string) => ({ ...output, id, content: [{ type: 'output_text', text, annotations: [] }] });
        const value = { ...completed(), output: [output, toolOutput('read_file', 'read', '{"path":"a.ts"}'),
            textItem('msg_2', 'Between calls'), toolOutput('list_files', 'list', '{"directory":"src"}'), textItem('msg_3', 'After calls')] };
        const s = server(() => Response.json(value));
        const events = await run(s.fetch, {}, { ...responsesModel(), stream: false }, { ...ask(), tools: requestedTools });
        expect(events.slice(0, 5)).toEqual([{ type: 'text', value: 'Visible answer' }, expectedCalls[0]!,
            { type: 'text', value: 'Between calls' }, expectedCalls[1]!, { type: 'text', value: 'After calls' }]);
        expect(events.map(event => event.type)).toEqual(['text', 'tool_call', 'text', 'tool_call', 'text', 'usage', 'stop']);
        expect(s.posts).toHaveLength(1); expect(new Headers(s.posts[0]!.init.headers).get('idempotency-key')).toBe('one-operation');
    });

    test('SSE partial text remains progressive while the full tool batch waits for clean EOF', async () => {
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        const s = server(() => new Response(new ReadableStream<Uint8Array>({ start(value) {
            controller = value;
            controller.enqueue(new TextEncoder().encode(partial() + frame('response.completed', { response: { ...completed(), output: validOutput() } })));
        } }), { headers: { 'content-type': 'text/event-stream' } }));
        const events: StreamEvent[] = []; let mintedKeys = 0; let waits = 0;
        const pending = (async () => {
            for await (const event of gatewayChat(responsesModel(), { ...ask(), tools: requestedTools }, {
                fetch: s.fetch, signal: new AbortController().signal,
                newIdempotencyKey: () => { mintedKeys++; return 'eof-batch-operation'; }, sleep: async () => { waits++; },
            })) events.push(event);
        })();
        await flush();
        expect(events).toEqual([{ type: 'text', value: 'Visible answer' }]);
        controller.close(); await pending;
        expect(events.filter(event => event.type === 'tool_call')).toEqual(expectedCalls);
        expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', value: 'Visible answer' }]);
        expect(s.posts).toHaveLength(1); expect(mintedKeys).toBe(1); expect(waits).toBe(0);
        expect(new Headers(s.posts[0]!.init.headers).get('idempotency-key')).toBe('eof-batch-operation');
    });

    test('SSE malformed data after a valid terminal suppresses the complete tool batch', async () => {
        const s = server(() => success(partial() + frame('response.completed', { response: { ...completed(), output: validOutput() } })
            + 'event: response.completed\ndata: {\n\n'));
        const events: StreamEvent[] = []; let error: unknown; let mintedKeys = 0; let waits = 0;
        try {
            for await (const event of gatewayChat(responsesModel(), { ...ask(), tools: requestedTools }, {
                fetch: s.fetch, signal: new AbortController().signal,
                newIdempotencyKey: () => { mintedKeys++; return 'malformed-batch-operation'; }, sleep: async () => { waits++; },
            })) events.push(event);
        } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(Error); expect(events).toEqual([{ type: 'text', value: 'Visible answer' }]);
        expect(s.posts).toHaveLength(1); expect(mintedKeys).toBe(1); expect(waits).toBe(0);
        expect(new Headers(s.posts[0]!.init.headers).get('idempotency-key')).toBe('malformed-batch-operation');
    });
});
