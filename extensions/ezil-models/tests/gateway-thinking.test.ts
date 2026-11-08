import { describe, expect, test } from 'bun:test';
import { anthropicStream } from '../src/anthropic';
import { COMPACT_TARGET, type CompactionInfo } from '../src/compact';
import { buildGatewayBody, gatewayMessage, gatewayTokenCount, INPUT_FRAMING, LocalRequestError } from '../src/gateway-messages';
import { gatewayJson, gatewayStream, GatewayResponseError } from '../src/gateway-response';
import { sseEvents } from '../src/sse';
import type { ChatRequest, Part, StreamEvent } from '../src/types';
import { ask, call, gw, msg, result, tool, txt } from './fixtures/gateway';
import { finalUsage, frames, messageJson } from './fixtures/gateway-response';
import { blockStart, blockStop, delta, finish, normalizedUsage, signature, sonnet, sonnetFrames, start, startUsage, stop, thought, thoughtPieces } from './fixtures/gateway-thinking';
import { frame, sseBody } from './fixtures/load';

const requestId = 'req-sonnet-thinking';
async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const output: StreamEvent[] = [];
    for await (const event of events) output.push(event);
    return output;
}
const parse = (input: string[], chunkSize = 1) => collect(gatewayStream(sseEvents(sseBody(input, chunkSize)), requestId));
const signed = (thinking = thought, sig = signature): Part => ({ type: 'thinking', value: '', metadata: { _completeThinking: thinking, signature: sig } });
const redacted: Part = { type: 'thinking', value: '', metadata: { redactedData: 'opaque-redacted-data' } };
const expected: StreamEvent[] = [
    ...thoughtPieces.map(value => ({ type: 'thinking' as const, value })),
    signed() as Extract<StreamEvent, { type: 'thinking' }>,
    { type: 'text', value: 'I will read a.ts.' },
    { type: 'tool_call', callId: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
    { type: 'usage', usage: normalizedUsage },
    { type: 'stop', reason: 'tool_use', details: { requestId } },
];

async function malformed(input: string[], reason = 'stream_malformed'): Promise<void> {
    let failure: unknown;
    try { await parse(input); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(GatewayResponseError);
    expect(failure).toMatchObject({ reason, code: 'stream_interrupted', requestId });
    expect((failure as Error).message).toBe(`EZiL AI: interrupted (request ${requestId})`);
}

function transport(input = sonnetFrames()) {
    const logs: string[] = [];
    const posts: Uint8Array[] = [];
    const compactions: CompactionInfo[] = [];
    const fetch = (async (url: string | URL | Request, init: RequestInit = {}) => {
        expect(String(url)).toBe('https://proxy.invalid/ai/v1/messages');
        expect(init.method).toBe('POST');
        posts.push(init.body as Uint8Array);
        return new Response(sseBody(input, 7), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': requestId } });
    }) as typeof globalThis.fetch;
    return { logs, posts, compactions, run: async (request: ChatRequest = { ...ask(), tools: [tool] }) => {
        const { gatewayChat } = await import('../src/gateway');
        return collect(gatewayChat(gw(sonnet), request, {
            signal: new AbortController().signal, fetch, log: line => logs.push(line), now: () => 0, onCompact: info => compactions.push(info),
        }));
    } };
}

describe('Gateway extended thinking', () => {
    for (const chunkSize of [1, 7, 101]) test(`Sonnet thinking + text + tool_use survives ${chunkSize}-byte chunks with partial final usage`, async () => {
        expect(await parse(sonnetFrames(), chunkSize)).toEqual(expected);
        const direct = await collect(anthropicStream(sseEvents(sseBody(sonnetFrames(), chunkSize))));
        expect(direct.slice(0, -1)).toEqual(expected.slice(0, -1));
    });

    test('gatewayChat completes once and signed thinking replays before text and tool_use on the next turn', async () => {
        const chat = transport();
        const events = await chat.run();
        expect(events).toEqual(expected);
        expect(chat.posts).toHaveLength(1);
        const parts = events.filter((event): event is Extract<StreamEvent, { type: 'thinking' | 'text' | 'tool_call' }> =>
            event.type === 'thinking' || event.type === 'text' || event.type === 'tool_call');
        const request = { ...ask([msg('user', txt('Read a.ts')), msg('assistant', ...parts), msg('user', result('call_1'))]), tools: [tool] };
        const built = buildGatewayBody(gw(sonnet), request);
        expect(built.body.messages[1]!.content).toEqual([
            { type: 'thinking', thinking: thought, signature }, { type: 'text', text: 'I will read a.ts.' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        ]);
        expect(built.body.messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'ok' }] }]);
        const next = transport(frames('end_turn'));
        await next.run(request);
        expect(next.posts).toHaveLength(1);
        expect(next.posts[0]).toEqual(built.bytes);
        for (const logs of [chat.logs, next.logs]) {
            expect(logs.length).toBeGreaterThan(0);
            for (const line of logs) for (const secret of [...thoughtPieces, thought, signature]) expect(line).not.toContain(secret);
            expect(JSON.parse(logs.at(-1)!)).toMatchObject({ http_status: 200, error_code: null });
        }
    });

    test('redacted thinking is emitted once, including through gatewayChat, and never logged', async () => {
        const input = [start(), blockStart(0, { type: 'redacted_thinking', data: 'opaque-redacted-data' }), blockStop(0), finish(), stop()];
        expect((await parse(input)).slice(0, -2)).toEqual([redacted]);
        const chat = transport(input);
        expect((await chat.run()).slice(0, -2)).toEqual([redacted]);
        expect(chat.logs.join('\n')).not.toContain('opaque-redacted-data');
    });

    test('initial thinking and split signatures are preserved, with empty deltas suppressed', async () => {
        const events = await parse([start(), blockStart(0, { type: 'thinking', thinking: 'initial ', signature: 'sig-' }),
            delta(0, { type: 'thinking_delta', thinking: '' }), delta(0, { type: 'thinking_delta', thinking: 'rest' }),
            delta(0, { type: 'signature_delta', signature: 'part-' }), delta(0, { type: 'signature_delta', signature: 'end' }),
            blockStop(0), finish(), stop()]);
        expect(events.slice(0, -2)).toEqual([{ type: 'thinking', value: 'rest' }, signed('initial rest', 'sig-part-end')]);
    });

    test('unsigned thinking emits deltas but no replay metadata or request bytes', async () => {
        for (const sig of [undefined, '']) {
            const events = await parse([start(), blockStart(0, { type: 'thinking', thinking: '', ...(sig === undefined ? {} : { signature: sig }) }),
                delta(0, { type: 'thinking_delta', thinking: thought }), blockStop(0), finish(), stop()]);
            expect(events.slice(0, -2)).toEqual([{ type: 'thinking', value: thought }]);
            const { bytes } = buildGatewayBody(gw(sonnet), { ...ask([msg('user', txt('read')), msg('assistant',
                { type: 'thinking', value: thought }, { type: 'thinking', value: '', metadata: { _completeThinking: thought, signature: sig } },
                call('call_1')), msg('user', result('call_1'))]), tools: [tool] });
            expect(new TextDecoder().decode(bytes)).not.toContain(thought);
        }
    });

    test('thinking goes first in stable order, including merged assistant messages, and never enters user/system/tool-result text', () => {
        const request = { ...ask([msg('system', signed(), redacted, txt('rules')), msg('user', signed(), redacted, txt('read')),
            msg('assistant', txt('answer'), signed()), msg('assistant', call('call_1'), redacted, signed('second', 'sig2')),
            msg('user', signed(), redacted, result('call_1', [signed(), redacted, txt('ok')]))]), tools: [tool] };
        const { body } = buildGatewayBody(gw(sonnet), request);
        expect(body.messages[1]!.content).toEqual([
            { type: 'thinking', thinking: thought, signature }, { type: 'redacted_thinking', data: 'opaque-redacted-data' },
            { type: 'thinking', thinking: 'second', signature: 'sig2' }, { type: 'text', text: 'answer' },
            { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} },
        ]);
        expect(body.system).toEqual([{ type: 'text', text: 'rules' }]);
        expect(body.messages[0]!.content).toEqual([{ type: 'text', text: 'read' }]);
        expect(body.messages[2]!.content).toEqual([{ type: 'tool_result', tool_use_id: 'call_1', content: [{ type: 'text', text: 'ok' }] }]);
        expect(gatewayMessage(msg('assistant', { ...redacted, metadata: { ...redacted.metadata, _completeThinking: thought, signature } }))).toEqual({
            role: 'assistant', content: [{ type: 'redacted_thinking', data: 'opaque-redacted-data' }],
        });
    });

    test('thinking bytes and blocks count toward limits; oversized historical thinking uses existing compaction', async () => {
        const assistant = msg('assistant', signed(), redacted, txt('answer'));
        expect(gatewayTokenCount(assistant)).toBe(Buffer.byteLength(JSON.stringify(gatewayMessage(assistant))));
        expect(gatewayTokenCount(assistant)).toBeGreaterThan(Buffer.byteLength(thought + signature + 'opaque-redacted-data'));
        expect(() => buildGatewayBody(gw(sonnet), ask([msg('user', txt('q')), msg('assistant', ...Array.from({ length: 1025 }, () => signed()))])))
            .toThrow(expect.objectContaining({ code: 'local_too_many_blocks' }));
        for (const part of [signed('字'.repeat(44_000)), { type: 'thinking', value: '', metadata: { redactedData: '字'.repeat(44_000) } } as Part]) {
            expect(() => buildGatewayBody(gw(sonnet), ask([msg('user', txt('q')), msg('assistant', part)]))).toThrow(LocalRequestError);
        }
        const request = ask([msg('user', txt('old question')), msg('assistant', signed(thought + '字'.repeat(44_000))), msg('user', txt('current question'))]);
        const before = structuredClone(request);
        const chat = transport(frames('end_turn'));
        await chat.run(request);
        expect(chat.compactions).toHaveLength(1);
        expect(chat.compactions[0]).toMatchObject({ cause: 'local_input_too_large' });
        expect(chat.compactions[0]!.folded).toBeGreaterThan(0);
        expect(chat.posts[0]!.byteLength + INPUT_FRAMING).toBeLessThanOrEqual(Math.floor(131_072 * COMPACT_TARGET));
        expect(new TextDecoder().decode(chat.posts[0])).not.toContain(thought);
        expect(chat.logs.join('\n')).not.toContain(thought);
        expect(request).toEqual(before);
    });
});

describe('Gateway thinking validation', () => {
    const invalidBlocks = [
        { type: 'thinking' }, { type: 'thinking', thinking: 123 }, { type: 'thinking', thinking: null },
        { type: 'thinking', thinking: '', signature: 123 }, { type: 'thinking', thinking: '', signature: null },
        { type: 'redacted_thinking' }, { type: 'redacted_thinking', data: '' }, { type: 'redacted_thinking', data: 123 },
        { type: 'server_tool_use', id: 'call_1', name: 'read_file', input: {} },
    ];
    for (const block of invalidBlocks) test(`rejects invalid block ${JSON.stringify(block)} in SSE and JSON`, async () => {
        await malformed([start(), blockStart(0, block)]);
        expect(() => gatewayJson({ ...messageJson(), content: [block] }, requestId))
            .toThrow(expect.objectContaining({ reason: 'invalid_response', requestId }));
    });

    for (const [block, change] of [
        [{ type: 'text', text: '' }, { type: 'thinking_delta', thinking: thought }],
        [{ type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }, { type: 'signature_delta', signature }],
        [{ type: 'redacted_thinking', data: 'opaque' }, { type: 'thinking_delta', thinking: thought }],
        [{ type: 'thinking', thinking: '' }, { type: 'text_delta', text: thought }],
        [{ type: 'thinking', thinking: '' }, { type: 'input_json_delta', partial_json: '{}' }],
        [{ type: 'thinking', thinking: '' }, { type: 'thinking_delta', thinking: 123 }],
        [{ type: 'thinking', thinking: '' }, { type: 'signature_delta', signature: null }],
    ]) test(`rejects ${change!.type} on ${block!.type} with invalid kind or field`, async () => {
        await malformed([start(), blockStart(0, block), delta(0, change)]);
    });

    test('duplicate indices, wrong event order and events after message_stop still fail closed', async () => {
        const thinking = blockStart(0, { type: 'thinking', thinking: thought });
        for (const input of [
            [thinking], [start(), start()], [start(), thinking, thinking], [start(), thinking, blockStop(0), thinking],
            [start(), delta(0, { type: 'thinking_delta', thinking: thought })], [start(), blockStop(0)],
            [start(), thinking, blockStop(0), delta(0, { type: 'signature_delta', signature })],
            [start(), thinking, finish()], [start(), thinking, stop()], [start(), stop()],
            [start(), finish(), finish()], [start(), finish(), thinking],
            [...sonnetFrames(), thinking], [...sonnetFrames(), stop()],
        ]) await malformed(input);
        await malformed(sonnetFrames().slice(0, -1), 'stream_truncated');
        // A keep-alive ping stays harmless anywhere, as before thinking support.
        expect(await parse([...sonnetFrames(), frame('ping', { type: 'ping' })])).toEqual(await parse(sonnetFrames()));
        await malformed([...sonnetFrames(), frame('error', { type: 'error' })], 'stream_error_event');
    });

    test('gatewayChat malformed-stream logs do not include thinking text or signature', async () => {
        const chat = transport([start(), blockStart(0, { type: 'thinking', thinking: thought, signature }),
            delta(0, { type: 'text_delta', text: thought })]);
        await expect(chat.run()).rejects.toMatchObject({ reason: 'stream_malformed' });
        expect(chat.posts).toHaveLength(1);
        expect(chat.logs.length).toBeGreaterThan(0);
        for (const line of chat.logs) for (const secret of [...thoughtPieces, thought, signature]) expect(line).not.toContain(secret);
    });
});

describe('Gateway usage normalization', () => {
    const usageOf = async (input: string[]) => (await parse(input)).at(-2);
    test('native: input and cache counters from message_start, cumulative output from the final delta', async () => {
        expect(await usageOf([start(), finish({ output_tokens: 22 }), stop()])).toEqual({ type: 'usage', usage: normalizedUsage });
        // A native delta may repeat input counters, unchanged.
        expect(await usageOf([start(), finish({ output_tokens: 22, input_tokens: 120 }), stop()])).toEqual({ type: 'usage', usage: normalizedUsage });
        expect(await usageOf([start(), finish({ ...startUsage, output_tokens: 22 }), stop()])).toEqual({ type: 'usage', usage: normalizedUsage });
    });
    test('Converse: all three input counters in the final delta are authoritative over message_start zeros', async () => {
        const zeros = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
        expect(await usageOf([start(zeros), finish({ ...startUsage, output_tokens: 22 }), stop()])).toEqual({ type: 'usage', usage: normalizedUsage });
    });
    test('missing authority is never zero-filled', async () => {
        // No input authority anywhere: message_start without counters, or without usage at all.
        await malformed([start({}), finish({ output_tokens: 22 }), stop()]);
        await malformed([frame('message_start', { type: 'message_start', message: { role: 'assistant' } }), finish({ output_tokens: 22 }), stop()]);
        await malformed([start({ input_tokens: 120, output_tokens: 1 }), finish({ output_tokens: 22 }), stop()]);
        // Empty final usage, with or without start usage.
        await malformed([start(), finish({}), stop()]);
        await malformed([frame('message_start', { type: 'message_start', message: { role: 'assistant' } }), finish({}), stop()]);
        // A preliminary output count is never kept when the final one is missing, nor may the final one go below it.
        await malformed([start(), finish({ input_tokens: 120 }), stop()]);
        await malformed([start({ ...startUsage, output_tokens: 30 }), finish({ output_tokens: 22 }), stop()]);
        // A native delta that changes one input counter without restating all three is inconsistent.
        await malformed([start(), finish({ output_tokens: 22, input_tokens: 121 }), stop()]);
    });

    for (const phase of ['start', 'delta']) for (const field of Object.keys(finalUsage)) test(`validates every present ${phase} usage counter: ${field}`, async () => {
        for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null, true]) {
            await malformed([start(phase === 'start' ? { ...startUsage, [field]: value } : startUsage), finish(phase === 'delta' ? { output_tokens: 22, [field]: value } : { output_tokens: 22 }), stop()]);
        }
    });
    test('non-object usage and missing final usage remain malformed', async () => {
        for (const value of [null, [], 'usage']) {
            await malformed([start(value), finish(), stop()]);
            await malformed([start(), finish(value), stop()]);
        }
        await malformed([start(), frame('message_delta', { delta: { stop_reason: 'tool_use' } }), stop()]);
    });
});

test('Gateway JSON emits incremental thinking plus replay metadata and redacted thinking after strict validation', () => {
    const json = { ...messageJson(), content: [
        { type: 'thinking', thinking: thought, signature }, { type: 'redacted_thinking', data: 'opaque-redacted-data' },
        { type: 'text', text: 'answer' }, { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} },
    ] };
    expect(gatewayJson(json, requestId).slice(0, -2)).toEqual([
        { type: 'thinking', value: thought }, signed(), redacted, { type: 'text', value: 'answer' },
        { type: 'tool_call', callId: 'call_1', name: 'read_file', input: {} },
    ]);
    for (const sig of [undefined, '']) expect(gatewayJson({ ...json, content: [{ type: 'thinking', thinking: thought,
        ...(sig === undefined ? {} : { signature: sig }) }] }).slice(0, -2)).toEqual([{ type: 'thinking', value: thought }]);
    expect(gatewayJson({ ...json, content: [{ type: 'thinking', thinking: '', signature }] }).slice(0, -2)).toEqual([signed('')]);
    expect(() => gatewayJson({ ...json, usage: { output_tokens: 22 } })).toThrow(expect.objectContaining({ reason: 'invalid_response' }));
});
