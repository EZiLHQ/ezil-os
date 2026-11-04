import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { compactRequest, COMPACT_TARGET, shorten, type CompactionInfo } from '../src/compact';
import { forgetGatewayModels, gatewayChat, GatewayError, type GatewayOptions } from '../src/gateway';
import { buildGatewayBody, INPUT_FRAMING, KIMI, LocalRequestError, type GatewayBody } from '../src/gateway-messages';
import { buildGatewayResponsesBody, type GatewayResponsesBody } from '../src/gateway-responses';
import type { ResolvedModel } from '../src/config';
import type { ChatRequest, Message, StreamEvent } from '../src/types';
import { ask, call, gw, msg, result, tool, txt } from './fixtures/gateway';
import { frames, messageJson } from './fixtures/gateway-response';

const LIMIT = 131_072;
const SYSTEM = 'You are EZiL Chat. Follow the user requirements exactly.';
const responsesModel = (): ResolvedModel => ({ ...gw('reviewed-azure'), gatewayProtocol: 'openai-responses' });
const responsesCatalog = { data: [{ id: 'reviewed-azure', enabled: true, max_input_tokens: LIMIT, max_output_tokens: 4096, protocols: ['openai-responses'] }] };
const sse = () => new Response(frames('end_turn').join(''), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': 'req-ok' } });
const kimiJson = () => Response.json(messageJson(), { headers: { 'x-ezil-request-id': 'req-kimi' } });
const responsesDone = () => new Response(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { object: 'response', id: 'r', status: 'completed',
    output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'ok', annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
const refusal = (status: number, error: Record<string, unknown>) => Response.json({ error }, { status, headers: { 'x-ezil-request-id': 'req-refused' } });

type Post = { url: string; key: string | null; bytes: number; body: unknown };
function server(reply: (index: number) => Response) {
    const posts: Post[] = [];
    return { posts, fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        init.signal?.throwIfAborted();
        if (String(input).endsWith('/models')) return Response.json(responsesCatalog);
        const raw = init.body as Uint8Array;
        posts.push({ url: String(input), key: new Headers(init.headers).get('idempotency-key'), bytes: raw.byteLength, body: JSON.parse(new TextDecoder().decode(raw)) });
        return reply(posts.length - 1);
    }) as typeof fetch };
}
async function run(model: ResolvedModel, request: ChatRequest, fetch: typeof globalThis.fetch, options: Partial<GatewayOptions> = {}) {
    const events: StreamEvent[] = []; const compacted: CompactionInfo[] = []; const logs: string[] = [];
    let keys = 0;
    for await (const event of gatewayChat(model, request, { signal: new AbortController().signal, fetch, now: () => 0, log: line => logs.push(line),
        newIdempotencyKey: () => `key-${++keys}`, sleep: async () => {}, onCompact: info => compacted.push(info), ...options })) events.push(event);
    return { events, compacted, logs };
}
async function failure(promise: Promise<unknown>): Promise<GatewayError> {
    try { await promise; } catch (error) { return error as GatewayError; }
    throw new Error('expected a failure');
}

/** A chat in Ask mode: short user requirements, long replies, then the current question. */
function longChat(turns: number, reply: number, fill = 'a'): Message[] {
    return [msg('system', txt(SYSTEM)), ...Array.from({ length: turns }, (_, i) => [
        msg('user', txt(`Requirement ${i}: keep rule ${i} in mind.`)), msg('assistant', txt(`Answer ${i} ${fill.repeat(reply)}`)),
    ]).flat(), msg('user', txt('FINAL QUESTION: what are all my requirements?'))];
}
/** An agent task: one request, then `rounds` read_file calls each with its result. */
function toolRounds(rounds: number, output: number, fill = 'L'): Message[] {
    return [msg('system', txt(SYSTEM)), msg('user', txt('Fix the failing build.')), ...Array.from({ length: rounds }, (_, i) => [
        msg('assistant', txt(`Reading file ${i}.`), call(`call_${i}`, 'read_file', { path: `src/f${i}.ts` })), msg('user', result(`call_${i}`, [txt(`file ${i}: ${fill.repeat(output)}`)])),
    ]).flat()];
}
const wire = (body: unknown) => JSON.stringify(body);

/** Every tool_use is answered by a tool_result in the next message, and nothing was turned into orphan text. */
function expectPairedMessages(body: GatewayBody) {
    body.messages.forEach((message, index) => {
        const uses = message.content.filter(block => block.type === 'tool_use').map(block => (block as { id: string }).id);
        if (!uses.length) return;
        const next = body.messages[index + 1]!;
        expect(next.role).toBe('user');
        expect(next.content.filter(block => block.type === 'tool_result').map(block => (block as { tool_use_id: string }).tool_use_id)).toEqual(uses);
    });
    expect(wire(body)).not.toMatch(/\[Earlier tool output\]|No result was recorded/);
}

beforeEach(() => forgetGatewayModels());
afterEach(() => forgetGatewayModels());

describe('automatic compaction before sending', () => {
    test('Kimi, Ask mode: a long chat over the byte bound is compacted and sent once instead of refused', async () => {
        const request = ask(longChat(60, 3000));
        const before = structuredClone(request);
        expect(() => buildGatewayBody(gw(KIMI), request)).toThrow(LocalRequestError);
        const s = server(() => kimiJson());
        const { events, compacted, logs } = await run(gw(KIMI), request, s.fetch);
        expect(s.posts).toHaveLength(1);
        expect(events.map(event => event.type)).toContain('text');
        const body = s.posts[0]!.body as GatewayBody;
        expect(body.stream).toBe(false);
        expect(s.posts[0]!.bytes + INPUT_FRAMING).toBeLessThanOrEqual(Math.floor(LIMIT * COMPACT_TARGET));
        // System text, the current question and every earlier requirement are kept; the cut is marked.
        expect(body.system).toEqual([{ type: 'text', text: SYSTEM }]);
        expect(wire(body.messages.at(-1))).toContain('FINAL QUESTION: what are all my requirements?');
        for (let i = 0; i < 60; i++) expect(wire(body)).toContain(`Requirement ${i}: keep rule ${i} in mind.`);
        expect(wire(body)).toContain('The full conversation is still saved in this chat');
        expect(compacted).toHaveLength(1);
        expect(compacted[0]).toMatchObject({ cause: 'local_input_too_large', limitBytes: LIMIT - INPUT_FRAMING, toBytes: s.posts[0]!.bytes });
        expect(compacted[0]!.folded).toBeGreaterThan(0);
        expect(JSON.parse(logs.at(-1)!).compacted).toMatchObject({ cause: 'local_input_too_large', to_bytes: s.posts[0]!.bytes });
        expect(logs.join()).not.toContain('Requirement');
        // The saved conversation (Copilot's request) is not changed.
        expect(request).toEqual(before);
    });

    test('an oversized tool result in the current step is shortened with a marker; its call and result stay paired', async () => {
        const request = { ...ask(toolRounds(1, 300_000)), tools: [tool] };
        const s = server(() => sse());
        await run(gw(), request, s.fetch);
        expect(s.posts).toHaveLength(1);
        const body = s.posts[0]!.body as GatewayBody;
        expectPairedMessages(body);
        const last = body.messages.at(-1)!.content.find(block => block.type === 'tool_result') as { tool_use_id: string; content: { text: string }[] };
        expect(last.tool_use_id).toBe('call_0');
        expect(last.content[0]!.text).toMatch(/^file 0: L+\n\[… \d+ characters left out by EZiL to fit the model's input limit …\]\nL+$/);
        expect(last.content[0]!.text.length).toBeLessThan(33_000);
        expect(wire(body)).toContain('Fix the failing build.');
    });

    test('Messages: folding many tool rounds keeps every remaining call with its result, and records the folded ones', async () => {
        const request = { ...ask([...toolRounds(80, 3000), msg('user', txt('Now run the tests.'))]), tools: [tool] };
        expect(() => buildGatewayBody(gw(), request)).toThrow(LocalRequestError);
        const s = server(() => sse());
        const { compacted } = await run(gw(), request, s.fetch);
        expect(s.posts).toHaveLength(1);
        const body = s.posts[0]!.body as GatewayBody;
        expectPairedMessages(body);
        expect(wire(body)).toContain('Tool read_file {\\"path\\":\\"src/f0.ts\\"} →');
        expect(wire(body)).toContain('Fix the failing build.');
        expect(wire(body.messages.at(-1))).toContain('Now run the tests.');
        expect(compacted[0]!.folded).toBeGreaterThan(0);
    });

    test('Responses (GPT-shaped row): a multilingual history fits the escaped bound; calls and outputs stay paired', async () => {
        const request = { ...ask([...longChat(30, 1500, '字'), ...toolRounds(6, 2000, '界').slice(1)]), tools: [tool] };
        expect(() => buildGatewayResponsesBody(responsesModel(), request)).toThrow(LocalRequestError);
        const s = server(() => responsesDone());
        const { compacted } = await run(responsesModel(), request, s.fetch);
        expect(s.posts).toHaveLength(1);
        expect(s.posts[0]!.url).toEndWith('/responses');
        const body = s.posts[0]!.body as GatewayResponsesBody;
        const calls = body.input.filter(item => item.type === 'function_call').map(item => (item as { call_id: string }).call_id);
        const outputs = body.input.filter(item => item.type === 'function_call_output').map(item => (item as { call_id: string }).call_id);
        expect(outputs).toEqual(calls);
        expect(wire(body)).not.toMatch(/\[Earlier tool output\]|No result was recorded/);
        expect(compacted).toHaveLength(1);
        expect(wire(body)).toContain('Fix the failing build.');
    });

    test('model switch: the same saved conversation is compacted for a 32K model and sent whole to a 131K model', async () => {
        const request = { ...ask(longChat(12, 3500)), tools: [] };
        const before = structuredClone(request);
        const small = server(() => kimiJson());
        const first = await run({ ...gw(KIMI), maxInputTokens: 32_768 }, request, small.fetch);
        expect(small.posts).toHaveLength(1);
        expect(small.posts[0]!.bytes + INPUT_FRAMING).toBeLessThanOrEqual(Math.floor(32_768 * COMPACT_TARGET));
        expect(first.compacted).toHaveLength(1);
        const large = server(() => sse());
        const second = await run(gw(), request, large.fetch);
        expect(second.compacted).toHaveLength(0);
        for (let i = 0; i < 12; i++) expect(wire(large.posts[0]!.body)).toContain(`Answer ${i} ${'a'.repeat(3500)}`);
        expect(request).toEqual(before);
    });

    test('cancelled while compacting: nothing is sent and nothing is thrown', async () => {
        const controller = new AbortController();
        const s = server(() => kimiJson());
        const { events } = await run(gw(KIMI), ask(longChat(60, 3000)), s.fetch, { signal: controller.signal, onCompact: () => controller.abort() });
        expect(s.posts).toHaveLength(0); expect(events).toHaveLength(0);
    });

    test('more messages than EZiL AI accepts: the oldest are folded under the limit', async () => {
        const request = ask([...Array.from({ length: 700 }, (_, i) => [msg('user', txt(`q${i}`)), msg('assistant', txt(`a${i}`))]).flat(), msg('user', txt('last'))]);
        expect(() => buildGatewayBody(gw(), request)).toThrow(LocalRequestError);
        const s = server(() => sse());
        await run(gw(), request, s.fetch);
        expect(s.posts).toHaveLength(1);
        expect((s.posts[0]!.body as GatewayBody).messages.length).toBeLessThanOrEqual(1024);
        expect(wire(s.posts[0]!.body)).toContain('User: q0');
    });
});

describe('one bounded compact-and-retry after a definitive size refusal', () => {
    const fitsLocally = () => ask(longChat(24, 4000));
    test('EZiL AI 413 input_too_large with its limit: recompacted under it, sent once more under a new key, then answered', async () => {
        expect(buildGatewayBody(gw(), fitsLocally()).bytes.byteLength).toBeLessThan(LIMIT - INPUT_FRAMING);
        const s = server(index => index === 0 ? refusal(413, { code: 'input_too_large', input_bound_tokens: 99_000, max_input_tokens: 65_536 }) : sse());
        const { events, compacted } = await run(gw(), fitsLocally(), s.fetch);
        expect(s.posts).toHaveLength(2);
        expect(s.posts.map(post => post.key)).toEqual(['key-1', 'key-2']);
        expect(s.posts[1]!.bytes + INPUT_FRAMING).toBeLessThanOrEqual(Math.floor(65_536 * COMPACT_TARGET));
        expect(compacted).toEqual([expect.objectContaining({ cause: 'remote', fromBytes: 99_000, limitBytes: 65_536 })]);
        expect(events.map(event => event.type)).toContain('stop');
    });
    test('a second size refusal is final: exactly two requests, no loop', async () => {
        const s = server(() => refusal(413, { code: 'input_too_large', max_input_tokens: 65_536 }));
        const error = await failure(run(gw(), fitsLocally(), s.fetch));
        expect(s.posts).toHaveLength(2);
        expect([error.code, error.origin]).toEqual(['input_too_large', 'gateway']);
        expect(error.message).toContain('Shorten your last message');
    });
    test('EZiL OS 413 body_too_large: one recompacted retry', async () => {
        const s = server(index => index === 0 ? refusal(413, { code: 'body_too_large', source: 'ezil-os-proxy' }) : sse());
        await run(gw(), fitsLocally(), s.fetch);
        expect(s.posts).toHaveLength(2);
        expect(s.posts[1]!.bytes).toBeLessThan(s.posts[0]!.bytes);
    });
    test('nothing left to compact: the refusal is final after one request', async () => {
        const s = server(() => refusal(413, { code: 'input_too_large', max_input_tokens: 65_536 }));
        const error = await failure(run(gw(), ask(), s.fetch));
        expect(s.posts).toHaveLength(1); expect(error.code).toBe('input_too_large');
    });
    test('never after a timeout, an unrelated refusal or a partly streamed answer', async () => {
        for (const reply of [() => refusal(504, { code: 'upstream_timeout' }), () => refusal(400, { code: 'invalid_request' }),
            () => new Response(frames().slice(0, 3).join('') + 'event: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"x"}}\n\n', { headers: { 'content-type': 'text/event-stream' } })]) {
            const s = server(reply);
            await failure(run(gw(), fitsLocally(), s.fetch));
            expect(s.posts).toHaveLength(1);
        }
    });
});

describe('compactRequest', () => {
    const build = (model: ResolvedModel) => (request: ChatRequest, scale: number) => buildGatewayBody({ ...model, maxInputTokens: Math.floor(model.maxInputTokens * scale) }, request);
    const first = (request: ChatRequest, model = gw()) => { try { buildGatewayBody(model, request); } catch (error) { return error as LocalRequestError; } throw new Error('fits'); };
    test('deterministic: the same conversation compacts to the same bytes', () => {
        const request = ask(longChat(60, 3000));
        const one = compactRequest(request, first(request), build(gw()));
        const two = compactRequest(structuredClone(request), first(request), build(gw()));
        expect(Buffer.from(one.built.bytes).equals(Buffer.from(two.built.bytes))).toBe(true);
    });
    test('shortening never splits a surrogate pair and says how much was left out', () => {
        const text = '😀'.repeat(50);
        const short = shorten(text, 21);
        expect(short).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
        expect(short).toMatch(/\[… \d+ characters left out by EZiL/);
        expect(shorten('short', 10)).toBe('short');
    });
    test('a folded user message keeps what the user asked before its attached context', () => {
        const asked = (i: number) => msg('user', txt(`<context>${'c'.repeat(20_000)}</context><userRequest>Please do task ${i}</userRequest>`));
        const request = ask([...Array.from({ length: 8 }, (_, i) => [asked(i), msg('assistant', txt('done'))]).flat(), msg('user', txt('next'))]);
        const { built } = compactRequest(request, first(request), build(gw()));
        for (let i = 0; i < 8; i++) expect(new TextDecoder().decode(built.bytes)).toContain(`Please do task ${i}`);
    });
    test('a cut never separates a call from a result that shares its message with new text', () => {
        const request = { ...ask([msg('system', txt(SYSTEM)), ...Array.from({ length: 30 }, (_, i) => [
            msg('assistant', call(`c${i}`)), msg('user', result(`c${i}`, [txt('x'.repeat(6000))]), txt(`and now step ${i}`)),
        ]).flat()]), tools: [tool] };
        const { built } = compactRequest(request, first(request), build(gw()));
        expectPairedMessages(built.body);
    });
    test('the current request alone too large: refused, marked as after compaction, with the most compacted sizes', () => {
        const request = ask([...longChat(4, 100), msg('user', txt('字'.repeat(50_000)))]);
        let error: unknown;
        try { compactRequest(request, first(request), build(gw())); } catch (caught) { error = caught; }
        expect(error).toBeInstanceOf(LocalRequestError);
        expect((error as LocalRequestError).afterCompaction).toBe(true);
        expect((error as LocalRequestError).counts.limitBytes).toBe(LIMIT - INPUT_FRAMING);
    });
});
