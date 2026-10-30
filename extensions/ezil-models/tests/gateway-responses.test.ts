import { describe, expect, test } from 'bun:test';
import { buildGatewayResponsesBody, gatewayResponsesJson, gatewayResponsesStream } from '../src/gateway-responses';
import { sseEvents } from '../src/sse';
import type { ChatRequest, StreamEvent, Tool } from '../src/types';
import { ask, call, gw, image, marker, msg, result, thinking, tool, txt } from './fixtures/gateway';
import { frame, sseBody } from './fixtures/load';

const model = () => ({ ...gw('reviewed-azure'), gatewayProtocol: 'openai-responses' as const });
const build = (request: ChatRequest = ask()) => buildGatewayResponsesBody(model(), request);
const usage = { input_tokens: 100, output_tokens: 12, total_tokens: 112, input_tokens_details: { cached_tokens: 25 }, output_tokens_details: { reasoning_tokens: 4 } };
const message = (id = 'msg_1', text = 'Hello') => ({ id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const functionCall = (id = 'fc_1', callId = 'call_1', args = '{"path":"a.ts"}') => ({ id, type: 'function_call', status: 'completed', call_id: callId, name: 'read_file', arguments: args });
const response = (output: unknown[] = [message()], extra: Record<string, unknown> = {}) => ({ id: 'resp_1', object: 'response', status: 'completed', output, usage, ...extra });
const event = (type: string, payload: Record<string, unknown> = {}) => frame(type, { type, ...payload });
const terminal = (value = response()) => event(`response.${value.status}`, { response: value });
const created = () => event('response.created', { response: { id: 'resp_1', object: 'response', status: 'in_progress', usage: null } });
const textDelta = (delta: string, extra: Record<string, unknown> = {}) => event('response.output_text.delta', { item_id: 'msg_1', output_index: 0, content_index: 0, delta, ...extra });
async function collect(frames: string[], output: StreamEvent[] = []): Promise<StreamEvent[]> {
    for await (const value of gatewayResponsesStream(sseEvents(sseBody(frames, 1)), 'req-responses')) output.push(value);
    return output;
}
async function collectBody(body: ReadableStream<Uint8Array>, output: StreamEvent[] = []): Promise<StreamEvent[]> {
    for await (const value of gatewayResponsesStream(body, 'req-raw')) output.push(value);
    return output;
}

describe('Responses request subset', () => {
    test('serializes a text and function round trip with flat tools and no persisted state', () => {
        const request = { ...ask([
            msg('system', txt('Read files carefully.'), marker),
            msg('user', txt('Read a.ts')),
            msg('assistant', txt('Opening the file.'), call('call/1', 'read_file', { path: 'a.ts' }), thinking),
            msg('user', result('call/1', [txt('export const a = 1;')]), txt('Explain it.')),
        ]), tools: [tool], toolMode: 'required' as const };
        const logs: string[] = [];
        const built = buildGatewayResponsesBody(model(), request, line => logs.push(line));
        expect(JSON.parse(new TextDecoder().decode(built.bytes))).toEqual({
            model: 'reviewed-azure', max_output_tokens: 8192, stream: true, store: false,
            input: [
                { type: 'message', role: 'system', content: 'Read files carefully.' },
                { type: 'message', role: 'user', content: 'Read a.ts' },
                { type: 'message', role: 'assistant', content: 'Opening the file.' },
                { type: 'function_call', call_id: 'call/1', name: 'read_file', arguments: '{"path":"a.ts"}' },
                { type: 'function_call_output', call_id: 'call/1', output: 'export const a = 1;' },
                { type: 'message', role: 'user', content: 'Explain it.' },
            ],
            tools: [{ type: 'function', name: 'read_file', description: 'Read a file', parameters: tool.inputSchema }], tool_choice: 'auto',
        });
        expect(logs).toEqual(['[gateway] required tool choice mapped to auto']);
        expect(new TextDecoder().decode(built.bytes)).not.toContain('private prior reasoning');
    });

    test('no-tool requests omit tool controls and ignore caller attempts to add hosted/stateful options', () => {
        const built = build({ ...ask(), modelOptions: {
            store: true, previous_response_id: 'resp-secret', conversation: 'conv-secret', background: true,
            tools: [{ type: 'web_search' }], metadata: { secret: 'hidden' }, stream: false, max_output_tokens: 1,
            temperature: 5, top_p: -1, reasoning: { effort: 'high' }, include: ['reasoning.encrypted_content'],
        } });
        expect(built.body).toEqual({ model: 'reviewed-azure', input: [{ type: 'message', role: 'user', content: 'Hello' }], max_output_tokens: 8192, stream: true, store: false, temperature: 2, top_p: 0 });
        expect(buildGatewayResponsesBody({ ...model(), stream: false }, ask()).body.stream).toBe(false);
    });

    for (const mimeType of ['image/png', 'application/pdf', 'audio/wav', 'text/plain']) test(`refuses ${mimeType} in messages and nested tool results`, () => {
        const data = { ...image, mimeType };
        expect(() => build(ask([msg('user', txt('Inspect this'), data)]))).toThrow('text and function tools only');
        expect(() => build(ask([msg('assistant', call('call_1')), msg('user', result('call_1', [txt('Result:'), data]))]))).toThrow('text and function tools only');
    });

    test('hosted tools and duplicate function names are refused before serialization', () => {
        for (const type of ['web_search', 'file_search', 'code_interpreter', 'mcp']) {
            expect(() => build({ ...ask(), tools: [{ ...tool, type } as Tool] })).toThrow('function tools');
        }
        expect(() => build({ ...ask(), tools: [tool, tool] })).toThrow('function tools');
    });

    test('schema references, cycles and non-JSON inputs are refused', () => {
        for (const key of ['$ref', '$defs', 'definitions', '$dynamicRef', '$recursiveRef', '$anchor']) {
            expect(() => build({ ...ask(), tools: [{ ...tool, inputSchema: { type: 'object', properties: { nested: { [key]: 'target' } } } }] })).toThrow('Inline tool schemas');
        }
        const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
        expect(() => build({ ...ask(), tools: [{ ...tool, inputSchema: cyclic }] })).toThrow('Invalid JSON');
        for (const input of [{ n: Infinity }, { missing: undefined }, { time: new Date(0) }, cyclic]) {
            expect(() => build(ask([msg('assistant', call('call_1', 'read_file', input))]))).toThrow('Invalid JSON');
        }
    });

    test('duplicate call IDs cannot create ambiguous function results', () => {
        expect(() => build(ask([msg('assistant', call('same'), call('same'))]))).toThrow('Invalid function call');
        const body = build(ask([msg('user', result('old', [txt('Earlier result')])), msg('assistant', call('unanswered'))])).body;
        expect(body.input[0]).toEqual({ type: 'message', role: 'user', content: '[Earlier tool output]\nEarlier result' });
        expect(body.input.at(-1)).toEqual({ type: 'function_call_output', call_id: 'unanswered', output: 'No result was recorded for this tool call.' });
    });

    test('request allowance accounts for each message and escaped tool schema bytes', () => {
        expect(() => buildGatewayResponsesBody({ ...model(), maxInputTokens: 1500 }, { ...ask(), tools: [{ ...tool, inputSchema: { description: '界'.repeat(150) } }] })).toThrow('Conversation too large');
        expect(() => build(ask(Array.from({ length: 513 }, () => msg('user', txt('x')))))).toThrow('conversation length');
    });
});

describe('Responses completion parsing', () => {
    test('duplicate created/item-added events cannot be followed by a successful terminal', async () => {
        const item = { ...message(), content: [] };
        const added = event('response.output_item.added', { output_index: 0, item });
        for (const frames of [[created(), created(), terminal(response([]))], [created(), added, added, terminal(response([item]))]]) {
            const seen: StreamEvent[] = [];
            await expect(collect(frames, seen)).rejects.toThrow('interrupted');
            expect(seen).toEqual([]);
        }
    });

    test('lifecycle events validate object, status and errors without rejecting queued transitions', async () => {
        for (const [type, value] of [
            ['response.created', { id: 'resp_1', status: 'in_progress' }],
            ['response.created', { id: 'resp_1', object: 'response', status: 'failed' }],
            ['response.created', { id: 'resp_1', object: 'response', status: 'in_progress', error: { code: 'failed' } }],
            ['response.in_progress', { id: 'resp_1', object: 'response', status: 'queued' }],
            ['response.queued', { id: 'resp_1', object: 'response', status: 'in_progress' }],
        ] as const) await expect(collect([event(type, { response: value }), terminal(response([]))])).rejects.toThrow('interrupted');
        const events = await collect([
            event('response.queued', { response: { id: 'resp_1', object: 'response', status: 'queued' } }),
            event('response.created', { response: { id: 'resp_1', object: 'response', status: 'queued' } }),
            event('response.in_progress', { response: { id: 'resp_1', object: 'response', status: 'in_progress' } }), terminal(response([])),
        ]);
        expect(events.at(-1)).toMatchObject({ reason: 'end_turn' });
    });

    test('terminal output cannot add content or complete arguments after an item-done snapshot', async () => {
        const snapshots = [
            [{ ...message(), content: [] }, message()],
            [{ ...functionCall('fc_1', 'call_1', '{"path":'), status: 'incomplete' }, functionCall()],
            [{ ...message(), status: 'incomplete' }, message()],
        ] as const;
        for (const [snapshot, output] of snapshots) {
            const seen: StreamEvent[] = [];
            await expect(collect([created(), event('response.output_item.done', { output_index: 0, item: snapshot }), terminal(response([output]))], seen)).rejects.toThrow('interrupted');
            expect(seen.some(event => event.type === 'tool_call' || event.type === 'usage' || event.type === 'stop')).toBe(false);
        }
    });

    test('item-done cannot omit streamed text even when the terminal repeats that text', async () => {
        for (const finalText of ['Hello', 'Hello world']) {
            const seen: StreamEvent[] = [];
            await expect(collect([
                created(), textDelta('Hello'),
                event('response.output_item.done', { output_index: 0, item: { ...message(), content: [] } }),
                terminal(response([message('msg_1', finalText)])),
            ], seen)).rejects.toThrow('interrupted');
            expect(seen).toEqual([{ type: 'text', value: 'Hello' }]);
        }
    });

    test('raw SSE body supports arbitrary UTF-8 and CRLF byte boundaries', async () => {
        const frames = [created(), textDelta('你好'), terminal(response([message('msg_1', '你好')]))].map(value => value.replace(/\n/g, '\r\n'));
        const events = await collectBody(sseBody(frames, 1));
        expect(events.filter(value => value.type === 'text')).toEqual([{ type: 'text', value: '你好' }]);
        expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'end_turn' });
    });

    test('raw EOF without a full terminal event boundary cannot succeed', async () => {
        for (const tail of [terminal().slice(0, -1), terminal().slice(0, -2)]) {
            const seen: StreamEvent[] = [];
            await expect(collectBody(sseBody([created(), textDelta('Hello'), tail], 1), seen)).rejects.toThrow('interrupted (request req-raw)');
            expect(seen).toEqual([{ type: 'text', value: 'Hello' }]);
        }
    });

    test('malformed UTF-8 cancels the raw reader and retains only earlier partial text', async () => {
        let cancelled = false, pulls = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(created() + textDelta('Partial')));
                else controller.enqueue(new Uint8Array([0xc3, 0x28]));
            },
            cancel() { cancelled = true; },
        });
        const seen: StreamEvent[] = [];
        await expect(collectBody(body, seen)).rejects.toThrow('interrupted');
        expect(seen).toEqual([{ type: 'text', value: 'Partial' }]);
        expect(cancelled).toBe(true);
    });

    test('body read failure after terminal output withholds tools, usage and completion', async () => {
        let pulls = 0;
        const body = new ReadableStream<Uint8Array>({
            pull(controller) {
                if (pulls++ === 0) controller.enqueue(new TextEncoder().encode(terminal(response([message(), functionCall()]))));
                else controller.error(new Error('connection reset'));
            },
        });
        const seen: StreamEvent[] = [];
        await expect(collectBody(body, seen)).rejects.toThrow('interrupted');
        expect(seen).toEqual([{ type: 'text', value: 'Hello' }]);
    });

    test('a consumer cancelling after text releases the raw HTTP reader', async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            start(controller) { controller.enqueue(new TextEncoder().encode(created() + textDelta('Partial'))); },
            cancel() { cancelled = true; },
        });
        const iterator = gatewayResponsesStream(body, 'req-cancel');
        expect((await iterator.next()).value).toEqual({ type: 'text', value: 'Partial' });
        await iterator.return(undefined);
        expect(cancelled).toBe(true);
        expect(body.locked).toBe(false);
    });

    test('one-byte SSE chunks preserve Unicode and deduplicate text from done/item/terminal events', async () => {
        const output = message('msg_1', 'Hello 你好');
        const events = await collect([
            created(), event('response.output_item.added', { output_index: 0, item: { ...output, content: [] } }),
            event('response.content_part.added', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }),
            textDelta('Hello '), textDelta('你好'),
            event('response.output_text.done', { item_id: 'msg_1', output_index: 0, content_index: 0, text: 'Hello 你好' }),
            event('response.content_part.done', { item_id: 'msg_1', output_index: 0, content_index: 0, part: output.content[0] }),
            event('response.output_item.done', { output_index: 0, item: output }), terminal(response([output])), frame(undefined, '[DONE]'),
        ]);
        expect(events).toEqual([
            { type: 'text', value: 'Hello ' }, { type: 'text', value: '你好' },
            { type: 'usage', usage: { inputTokens: 100, outputTokens: 12, cacheReadTokens: 25, cacheWriteTokens: 0 } },
            { type: 'stop', reason: 'end_turn', details: { requestId: 'req-responses' } },
        ]);
    });

    test('interleaved argument deltas assemble by item and call ID, emitting each complete tool once', async () => {
        const a = functionCall('fc_a', 'call/a', '{"path":"a.ts"}');
        const b = functionCall('fc_b', 'call/b', '{"path":"b.ts"}');
        const args = (type: 'delta' | 'done', index: number, id: string, callId: string, value: string) => event(`response.function_call_arguments.${type}`, { item_id: id, output_index: index, call_id: callId, [type === 'delta' ? 'delta' : 'arguments']: value });
        const events = await collect([
            created(), event('response.output_item.added', { output_index: 0, item: { ...a, arguments: '', status: 'in_progress' } }),
            event('response.output_item.added', { output_index: 1, item: { ...b, arguments: '', status: 'in_progress' } }),
            args('delta', 0, 'fc_a', 'call/a', '{"path":'), args('delta', 1, 'fc_b', 'call/b', '{"path":"b'),
            args('delta', 0, 'fc_a', 'call/a', '"a.ts"}'), args('delta', 1, 'fc_b', 'call/b', '.ts"}'),
            args('done', 1, 'fc_b', 'call/b', b.arguments), args('done', 0, 'fc_a', 'call/a', a.arguments),
            event('response.output_item.done', { output_index: 1, item: b }), event('response.output_item.done', { output_index: 0, item: a }),
            terminal(response([a, b])),
        ]);
        expect(events.filter(value => value.type === 'tool_call')).toEqual([
            { type: 'tool_call', callId: 'call/a', name: 'read_file', input: { path: 'a.ts' } },
            { type: 'tool_call', callId: 'call/b', name: 'read_file', input: { path: 'b.ts' } },
        ]);
        expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'tool_use' });
    });

    test('final output supplies only text not already streamed and accepts terminal-only completed responses', async () => {
        const events = await collect([created(), textDelta('Hello'), terminal(response([message('msg_1', 'Hello world')]))]);
        expect(events.filter(value => value.type === 'text')).toEqual([{ type: 'text', value: 'Hello' }, { type: 'text', value: ' world' }]);
        expect((await collect([terminal(response([functionCall()]))])).filter(value => value.type === 'tool_call')).toHaveLength(1);
    });

    test('JSON preserves the order of output text and tool calls', () => {
        const events = gatewayResponsesJson(response([message('msg_before', 'Before'), functionCall(), message('msg_after', 'After')]), 'req-json');
        expect(events.slice(0, 3)).toEqual([
            { type: 'text', value: 'Before' },
            { type: 'tool_call', callId: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
            { type: 'text', value: 'After' },
        ]);
        expect(events.at(-1)).toMatchObject({ type: 'stop', reason: 'tool_use', details: { requestId: 'req-json' } });
    });

    for (const args of ['{"path":', 'null', '[]', '"text"', '{"n":1e400}']) test(`completed function arguments must be a finite JSON object: ${args}`, async () => {
        expect(() => gatewayResponsesJson(response([functionCall('fc_1', 'call_1', args)]))).toThrow();
        await expect(collect([terminal(response([functionCall('fc_1', 'call_1', args)]))])).rejects.toThrow('interrupted');
    });

    test('mismatched call IDs, item positions and final argument bytes are rejected', async () => {
        const start = event('response.output_item.added', { output_index: 0, item: { ...functionCall(), arguments: '' } });
        for (const delta of [
            { item_id: 'fc_1', output_index: 0, call_id: 'other_call', delta: '{}' },
            { item_id: 'fc_1', output_index: 1, delta: '{}' },
            { item_id: 'other_item', output_index: 0, delta: '{}' },
            { item_id: 'fc_1', output_index: 0, delta: '{"path":"different' },
        ]) await expect(collect([created(), start, event('response.function_call_arguments.delta', delta), terminal(response([functionCall()]))])).rejects.toThrow('interrupted');
        expect(() => gatewayResponsesJson(response([functionCall('fc_a'), functionCall('fc_b')]))).toThrow();
    });

    test('only terminal authoritative usage is published; missing or inconsistent counters fail closed', async () => {
        for (const bad of [undefined, null, {}, { input_tokens: 100, output_tokens: 12 }, { ...usage, output_tokens: -1 }, { ...usage, input_tokens: 1.5 }, { ...usage, input_tokens_details: { cached_tokens: 101 } }, { ...usage, total_tokens: 99 }]) {
            const value = response([message()], { usage: bad });
            expect(() => gatewayResponsesJson(value)).toThrow();
            const seen: StreamEvent[] = [];
            await expect(collect([created(), textDelta('Hello'), terminal(value)], seen)).rejects.toThrow('interrupted');
            expect(seen).toEqual([{ type: 'text', value: 'Hello' }]);
        }
    });

    test('delta-to-EOF, malformed events and provider errors preserve partial text without success', async () => {
        for (const tail of [[], [frame(undefined, '[DONE]')], [frame('response.completed', '{broken')], [event('error', { error: { message: 'private provider failure' } })], [terminal().slice(0, -20)]]) {
            const seen: StreamEvent[] = [];
            const failure = await collect([created(), textDelta('Partial answer'), ...tail], seen).then(() => undefined, error => error as Error);
            expect(failure?.message).toBe('EZiL AI: interrupted (request req-responses)');
            expect(seen).toEqual([{ type: 'text', value: 'Partial answer' }]);
        }
    });

    test('errors after a terminal event cannot release tools, usage or a success stop', async () => {
        const seen: StreamEvent[] = [];
        await expect(collect([created(), terminal(response([message(), functionCall()])), event('error', { message: 'late failure' })], seen)).rejects.toThrow('interrupted');
        expect(seen).toEqual([{ type: 'text', value: 'Hello' }]);
    });

    for (const [status, reason] of [['incomplete', 'max_tokens'], ['failed', 'failed']] as const) test(`${status} preserves text and usage but never releases partial tools or a successful stop`, async () => {
        const value = response([message('msg_1', 'Partial'), { ...functionCall('fc_1', 'call_1', '{"path":'), status: 'incomplete' }], {
            status, incomplete_details: { reason: 'max_output_tokens' }, error: { code: 'upstream', message: 'private provider failure' },
        });
        for (const events of [gatewayResponsesJson(value), await collect([created(), textDelta('Partial'), terminal(value)])]) {
            expect(events.filter(event => event.type === 'text')).toEqual([{ type: 'text', value: 'Partial' }]);
            expect(events.filter(event => event.type === 'tool_call')).toEqual([]);
            expect(events.at(-2)).toMatchObject({ type: 'usage', usage: { inputTokens: 100, outputTokens: 12 } });
            expect(events.at(-1)).toMatchObject({ type: 'stop', reason });
            expect(JSON.stringify(events)).not.toContain('private provider failure');
        }
    });

    test('a refusal is readable and nonterminal JSON is rejected', async () => {
        const refusal = response([{ ...message(), content: [{ type: 'refusal', refusal: 'Cannot help with that.' }] }]);
        expect(gatewayResponsesJson(refusal).at(-1)).toMatchObject({ reason: 'refusal' });
        expect((await collect([terminal(refusal)]))[0]).toEqual({ type: 'text', value: 'Cannot help with that.' });
        expect(() => gatewayResponsesJson(response([], { status: 'in_progress' }))).toThrow();
        expect(() => gatewayResponsesJson(response([{ ...message(), status: 'incomplete' }]))).toThrow();
        expect(() => gatewayResponsesJson(response([message()], { error: { code: 'failure' } }))).toThrow();
    });
});
