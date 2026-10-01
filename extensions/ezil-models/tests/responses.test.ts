import { describe, expect, test } from 'bun:test';
import { buildResponsesBody, clampOutputTokens, convertInput, convertTools, inlineSchema, inputBound, messageBound, RequestTooLargeError, responsesStream, StreamInterruptedError, ResponseFailedError, StructuredOutputError } from '../src/responses';
import { sseEvents } from '../src/sse';
import type { ChatRequest, StreamEvent } from '../src/types';
import { FIXTURES, frame, loadFixture, model, sseBody } from './fixtures/load';

const gateway = (overrides = {}) => model({ model: 'ezil-code', family: 'gpt', maxInputTokens: 16_384, maxOutputTokens: 4096, capabilities: { toolCalling: true, imageInput: false }, cache: { enabled: false, ttl: '5m' }, forcedToolChoice: true, ...overrides }, { type: 'ezil-gateway', baseUrl: 'https://8443-guac-a-b-code.ezil.org/ai/v1', apiKey: 'p'.repeat(64) });
const LIMITS = { maxInputTokens: 16_384, maxOutputTokens: 4096 };
const BIG = { maxInputTokens: 10_000_000, maxOutputTokens: 4096 };

/** The gateway's own bound (ezil-ai-gateway src/validate.ts), re-implemented independently from the request JSON. */
function gatewayBound(body: Record<string, unknown>): number {
    const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');
    const surplus = (v: unknown) => { if (v === undefined) return 0; const s = JSON.stringify(v); let n = 0; for (const ch of s) n += ch.length === 1 && ch.charCodeAt(0) < 0x80 ? 1 : 6 * ch.length; return n - utf8(s); };
    const prompt = JSON.stringify({ instructions: body.instructions, input: body.input, tools: body.tools, tool_choice: body.tool_choice, text: body.text, reasoning: body.reasoning });
    const items = Array.isArray(body.input) ? body.input.length : 1;
    const tools = Array.isArray(body.tools) ? body.tools.length : 0;
    return utf8(prompt) + surplus(body.tools) + surplus(body.tool_choice) + surplus(body.text) + 1024 + 32 * items + 128 * tools;
}

const GATEWAY_TOP_LEVEL = new Set(['model', 'input', 'instructions', 'tools', 'tool_choice', 'parallel_tool_calls', 'max_output_tokens', 'temperature', 'top_p', 'stream', 'store', 'text', 'reasoning']);
const REFERENCE_KEYS = ['$ref', '$defs', 'definitions', '$dynamicRef', '$recursiveRef', '$anchor'];

function keysDeep(value: unknown, out = new Set<string>()): Set<string> {
    if (Array.isArray(value)) value.forEach(child => keysDeep(child, out));
    else if (typeof value === 'object' && value !== null) for (const [key, child] of Object.entries(value)) { out.add(key); keysDeep(child, out); }
    return out;
}

async function collect(frames: string[], chunkSize = 0, requestId = 'req-1'): Promise<StreamEvent[]> {
    const out: StreamEvent[] = [];
    for await (const event of responsesStream(sseEvents(sseBody(frames, chunkSize)), requestId)) out.push(event);
    return out;
}

describe('Responses body from real Copilot Chat captures', () => {
    const fixture = loadFixture(FIXTURES.toolRoundTrip);

    test('only gateway-allowed fields: system -> instructions, user/assistant text, function_call and function_call_output items', () => {
        const { body } = buildResponsesBody(gateway(), fixture, BIG);
        for (const key of Object.keys(body)) expect(GATEWAY_TOP_LEVEL.has(key)).toBe(true);
        expect(body.model).toBe('ezil-code');
        expect(body.store).toBe(false);
        expect(body.stream).toBe(true);
        expect(body.max_output_tokens).toBe(4096);
        expect(body.instructions).toStartWith('You are an expert AI programming assistant');
        expect(body.input.map(item => 'type' in item ? item.type : item.role)).toEqual(['user', 'user', 'assistant', 'function_call', 'function_call_output']);
        expect(body.input[3]).toEqual({ type: 'function_call', call_id: 'call_mock_1790681308771', name: 'create_file', arguments: JSON.stringify({ filePath: '/home/coder/project/hello.txt', content: 'hi\n' }) });
        expect(body.input[4]).toEqual({ type: 'function_call_output', call_id: 'call_mock_1790681308771', output: 'The following files were successfully edited:\n/home/coder/project/hello.txt\n' });
        expect(body.tools).toHaveLength(39);
        expect(body.tools!.find(tool => tool.name === 'create_directory')).toEqual({ type: 'function', name: 'create_directory', description: expect.stringContaining('Create a new directory'), parameters: expect.objectContaining({ type: 'object' }) });
        // Core tools lead the list, so trimming keeps them first.
        expect(body.tools![0]!.name).toBe('read_file');
        expect(body.tool_choice).toBe('auto');
        // Never sent: Chat Completions fields, reasoning items, ids, metadata.
        const all = JSON.stringify(body);
        for (const banned of ['"messages"', '"max_tokens"', '"stream_options"', '"previous_response_id"', '"metadata"', '"include"', '"user":']) expect(all).not.toContain(banned);
        for (const key of REFERENCE_KEYS) expect(keysDeep(body.tools).has(key)).toBe(false);
    });

    test('the bound equals the gateway\'s own formula, byte for byte', () => {
        const built = buildResponsesBody(gateway(), fixture, BIG);
        expect(built.bound).toBe(gatewayBound(JSON.parse(new TextDecoder().decode(built.bytes))));
        expect(inputBound(built.body)).toBe(built.bound);
    });

    test('the bound counts non-ASCII tool text as \\uXXXX escapes but message text as UTF-8', () => {
        const request: ChatRequest = { messages: [{ role: 'user', parts: [{ type: 'text', value: 'héllo 🙂' }] }], tools: [{ name: 't', description: 'résumé 🙂', inputSchema: { type: 'object', properties: {} } }], toolMode: 'auto', modelOptions: {} };
        const built = buildResponsesBody(gateway(), request, BIG);
        expect(built.bound).toBe(gatewayBound(built.body as unknown as Record<string, unknown>));
    });

    test('images and Copilot marker parts are dropped (the gateway is text only)', () => {
        const { body } = buildResponsesBody(gateway(), loadFixture(FIXTURES.image), BIG);
        expect(JSON.stringify(body.input)).not.toContain('input_image');
        expect(JSON.stringify(body.input)).not.toContain('base64');
    });

    test('a default Agent-mode turn is about 4.5x ezil-code\'s allowance; trimming keeps the core tools that fit', () => {
        const full = buildResponsesBody(gateway(), fixture, BIG);
        expect(full.bound).toBeGreaterThan(70_000); // measured 73,107 with Copilot Chat 0.67's 39 tools and 10.5 KB system prompt
        const trimmed = buildResponsesBody(gateway(), fixture, LIMITS);
        expect(trimmed.bound).toBeLessThanOrEqual(16_384);
        expect(trimmed.bound).toBe(gatewayBound(JSON.parse(new TextDecoder().decode(trimmed.bytes))));
        expect(trimmed.body.tools!.map(tool => tool.name)).toContain('read_file');
        expect(trimmed.body.tools!.length + trimmed.droppedTools.length).toBe(39);
    });

    test('a prompt that cannot fit even without tools is refused client-side', () => {
        const request: ChatRequest = { messages: [{ role: 'user', parts: [{ type: 'text', value: 'x'.repeat(20_000) }] }], tools: [], toolMode: 'auto', modelOptions: {} };
        expect(() => buildResponsesBody(gateway(), request, LIMITS)).toThrow(RequestTooLargeError);
    });

    test('utility calls (no tools) send neither tools nor tool_choice', () => {
        const { body } = buildResponsesBody(gateway(), loadFixture(FIXTURES.utility), LIMITS);
        expect(body.tools).toBeUndefined();
        expect(body.tool_choice).toBeUndefined();
    });

    test('required tool mode maps to tool_choice "required"', () => {
        const request: ChatRequest = { messages: [{ role: 'user', parts: [{ type: 'text', value: 'go' }] }], tools: [{ name: 'a', inputSchema: { type: 'object' } }], toolMode: 'required', modelOptions: {} };
        expect(buildResponsesBody(gateway(), request, LIMITS).body.tool_choice).toBe('required');
        expect(buildResponsesBody(gateway({ forcedToolChoice: false }), request, LIMITS).body.tool_choice).toBe('auto');
    });

    test('max_output_tokens is always explicit and clamped to 16..cap', () => {
        expect(clampOutputTokens(undefined, 4096)).toBe(4096);
        expect(clampOutputTokens(100_000, 4096)).toBe(4096);
        expect(clampOutputTokens(1, 4096)).toBe(16);
        expect(clampOutputTokens(512, 4096)).toBe(512);
        expect(clampOutputTokens(1.5, 4096)).toBe(4096);
        const request: ChatRequest = { messages: [{ role: 'user', parts: [{ type: 'text', value: 'go' }] }], tools: [], toolMode: 'auto', modelOptions: { maxTokens: 9999 } };
        expect(buildResponsesBody(gateway(), request, { maxInputTokens: 16_384, maxOutputTokens: 2048 }).body.max_output_tokens).toBe(2048);
    });

    test('reasoning and temperature are only sent when the model is configured for them', () => {
        const request: ChatRequest = { messages: [{ role: 'user', parts: [{ type: 'text', value: 'go' }] }], tools: [], toolMode: 'auto', modelOptions: {} };
        expect(buildResponsesBody(gateway(), request, LIMITS).body.reasoning).toBeUndefined();
        expect(buildResponsesBody(gateway({ thinking: { type: 'adaptive', effort: 'xhigh', display: 'omitted' } }), request, LIMITS).body.reasoning).toEqual({ effort: 'high' });
        expect(buildResponsesBody(gateway({ temperature: 0.2 }), request, LIMITS).body.temperature).toBe(0.2);
    });

    test('the bytes are the one serialization of the body', () => {
        const built = buildResponsesBody(gateway(), fixture, BIG);
        expect(new TextDecoder().decode(built.bytes)).toBe(JSON.stringify(built.body));
    });
});

describe('schemas without $ref/$defs', () => {
    test('local references are inlined and definition blocks removed', () => {
        const schema = { type: 'object', $defs: { pos: { type: 'object', properties: { line: { type: 'integer' } } } }, properties: { start: { $ref: '#/$defs/pos' }, end: { $ref: '#/$defs/pos', description: 'end' } } };
        expect(inlineSchema(schema)).toEqual({ type: 'object', properties: { start: { type: 'object', properties: { line: { type: 'integer' } } }, end: { type: 'object', properties: { line: { type: 'integer' } }, description: 'end' } } });
    });

    test('recursive, remote and unresolvable references, and properties named like keywords, cannot be sent', () => {
        expect(inlineSchema({ $defs: { n: { properties: { next: { $ref: '#/$defs/n' } } } }, $ref: '#/$defs/n' })).toBeUndefined();
        expect(inlineSchema({ properties: { a: { $ref: 'https://example.com/s.json' } } })).toBeUndefined();
        expect(inlineSchema({ properties: { definitions: { type: 'string' } } })).toBeUndefined();
        expect(inlineSchema({ properties: { a: { $anchor: 'x' } } })).toBeUndefined();
    });

    test('a tool whose schema cannot be inlined, or whose name the gateway refuses, is dropped and named', () => {
        const { tools, dropped } = convertTools([
            { name: 'ok', inputSchema: { type: 'object' } },
            { name: 'bad name!', inputSchema: { type: 'object' } },
            { name: 'recursive', inputSchema: { $defs: { n: { properties: { n: { $ref: '#/$defs/n' } } } }, $ref: '#/$defs/n' } },
            { name: 'ok', inputSchema: { type: 'object' } },
            { name: 'noschema' },
        ]);
        expect(tools.map(tool => tool.name)).toEqual(['ok', 'noschema']);
        expect(dropped).toEqual(['bad name!', 'recursive', 'ok']);
        expect(tools[1]!.parameters).toEqual({ type: 'object', properties: {} });
    });

    test('text.format json_schema is sent inline, never with $ref/$defs', () => {
        const request: ChatRequest = { messages: [{ role: 'user', parts: [{ type: 'text', value: 'go' }] }], tools: [], toolMode: 'auto', modelOptions: { response_format: { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: { type: 'object', $defs: { s: { type: 'string' } }, properties: { a: { $ref: '#/$defs/s' } } } } } } };
        const { body } = buildResponsesBody(gateway(), request, LIMITS);
        expect(body.text).toEqual({ format: { type: 'json_schema', name: 'answer', strict: true, schema: { type: 'object', properties: { a: { type: 'string' } } } } });
        const recursive: ChatRequest = { ...request, modelOptions: { response_format: { type: 'json_schema', json_schema: { name: 'x', schema: { $defs: { n: { properties: { n: { $ref: '#/$defs/n' } } } }, $ref: '#/$defs/n' } } } } };
        expect(() => buildResponsesBody(gateway(), recursive, LIMITS)).toThrow(StructuredOutputError);
    });
});

describe('tool call pairing', () => {
    test('an orphan output is dropped and a call without an output gets a placeholder after its group', () => {
        const { input } = convertInput([
            { role: 'user', parts: [{ type: 'tool_result', callId: 'ghost', content: [{ type: 'text', value: 'x' }] }, { type: 'text', value: 'hi' }] },
            { role: 'assistant', parts: [{ type: 'tool_call', callId: 'a', name: 'read_file', input: {} }, { type: 'tool_call', callId: 'b', name: 'list_dir', input: {} }] },
            { role: 'user', parts: [{ type: 'tool_result', callId: 'b', content: [{ type: 'text', value: 'ok' }] }] },
            { role: 'user', parts: [{ type: 'text', value: 'next' }] },
        ]);
        expect(input).toEqual([
            { role: 'user', content: 'hi' },
            { type: 'function_call', call_id: 'a', name: 'read_file', arguments: '{}' },
            { type: 'function_call', call_id: 'b', name: 'list_dir', arguments: '{}' },
            { type: 'function_call_output', call_id: 'b', output: 'ok' },
            { type: 'function_call_output', call_id: 'a', output: '[no result: the tool call was cancelled]' },
            { role: 'user', content: 'next' },
        ]);
    });
});

describe('token counting tracks the gateway bound', () => {
    test('a message counts its UTF-8 item bytes plus 32 per item', () => {
        const message = { role: 'user' as const, parts: [{ type: 'text' as const, value: 'héllo' }] };
        const [item] = convertInput([message]).input;
        expect(messageBound(message)).toBe(Buffer.byteLength(JSON.stringify(item)) + 1 + 32);
    });
});

describe('Responses SSE stream', () => {
    test('text deltas, a streamed function call, usage and stop on response.completed', async () => {
        const events = await collect([
            frame('response.created', { type: 'response.created', response: { id: 'resp_1', status: 'in_progress' } }),
            frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'Hel' }),
            frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'lo' }),
            frame('response.output_item.added', { type: 'response.output_item.added', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'create_file', arguments: '' } }),
            frame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"filePath":"/a",' }),
            frame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"content":"hi"}' }),
            frame('response.function_call_arguments.done', { type: 'response.function_call_arguments.done', item_id: 'fc_1', arguments: '{"filePath":"/a","content":"hi"}' }),
            frame('response.output_item.done', { type: 'response.output_item.done', output_index: 1, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'create_file', arguments: '{"filePath":"/a","content":"hi"}', status: 'completed' } }),
            frame('response.completed', { type: 'response.completed', response: { id: 'resp_1', status: 'completed', usage: { input_tokens: 100, output_tokens: 20, input_tokens_details: { cached_tokens: 64 } }, output: [{ type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'create_file', arguments: '{"filePath":"/a","content":"hi"}' }] } }),
        ], 7);
        expect(events).toEqual([
            { type: 'text', value: 'Hel' },
            { type: 'text', value: 'lo' },
            { type: 'tool_call', callId: 'call_1', name: 'create_file', input: { filePath: '/a', content: 'hi' } },
            { type: 'usage', usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 64, cacheWriteTokens: 0 } },
            { type: 'stop', reason: 'stop' },
        ]);
    });

    test('a function call completed only by the terminal output is still emitted once', async () => {
        const events = await collect([
            frame('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'read_file', arguments: '' } }),
            frame('response.function_call_arguments.delta', { type: 'response.function_call_arguments.delta', item_id: 'fc_9', delta: '{"filePath":"/b"}' }),
            frame('response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'function_call', id: 'fc_9', call_id: 'call_9', name: 'read_file', arguments: '{"filePath":"/b"}' }] } }),
        ]);
        expect(events.filter(event => event.type === 'tool_call')).toEqual([{ type: 'tool_call', callId: 'call_9', name: 'read_file', input: { filePath: '/b' } }]);
    });

    test('response.incomplete keeps the partial output and stops as truncated', async () => {
        const events = await collect([
            frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'partial' }),
            frame('response.incomplete', { type: 'response.incomplete', response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, usage: { input_tokens: 5, output_tokens: 16 } } }),
        ]);
        expect(events[0]).toEqual({ type: 'text', value: 'partial' });
        expect(events.at(-1)).toEqual({ type: 'stop', reason: 'max_tokens', details: 'max_output_tokens' });
    });

    test('response.failed is an error', async () => {
        await expect(collect([frame('response.failed', { type: 'response.failed', response: { status: 'failed', error: { code: 'server_error' } } })])).rejects.toThrow(ResponseFailedError);
    });

    test('the gateway\'s final error event is "interrupted" with its request id', async () => {
        const run = collect([
            frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'x' }),
            frame('error', { type: 'error', code: 'stream_interrupted', message: 'm', request_id: 'req-gw' }),
        ]);
        await expect(run).rejects.toThrow(StreamInterruptedError);
        await expect(run).rejects.toThrow('request req-gw');
    });

    test('EOF without a terminal event is "interrupted", never a silent success', async () => {
        await expect(collect([frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'x' })])).rejects.toThrow('ended early');
        await expect(collect([])).rejects.toThrow(StreamInterruptedError);
    });

    test('unknown events are ignored; event name is taken from data.type when present', async () => {
        const events = await collect([
            frame('response.in_progress', { type: 'response.in_progress' }),
            frame('response.content_part.added', { type: 'response.content_part.added' }),
            frame(undefined, { type: 'response.output_text.delta', delta: 'ok' }),
            frame('response.completed', { type: 'response.completed', response: { status: 'completed', usage: {} } }),
        ]);
        expect(events[0]).toEqual({ type: 'text', value: 'ok' });
        expect(events.at(-1)).toEqual({ type: 'stop', reason: 'stop' });
    });
});
