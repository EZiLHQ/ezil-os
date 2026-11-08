// The reported long-chat failure ("EZiL Models: Conversation too large or invalid — start a new chat", extension.js:3156:13)
// fingerprints to the committed VSIX that main still ships (git blob 3ca59df0): its body builder refused an oversized
// saved conversation before any send, and gatewayChat turned that refusal into the generic text. This file replays one
// realistic saved Agent-mode conversation (38 tools, long TypeScript/CJK/JSON tool output, a final requirement) through
// gatewayChat with a mocked Gateway, so the same file runs unchanged against main (red, with that text) and this tree.
// It uses only gatewayChat options both builds accept; onCompact is ignored by builds without compaction.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetGatewayModels, gatewayChat } from '../src/gateway';
import { INPUT_FRAMING, KIMI, QWEN } from '../src/gateway-messages';
import type { ChatRequest, Message, StreamEvent, Tool } from '../src/types';
import { call, gw, msg, result, txt } from './fixtures/gateway';
import { frames, messageJson } from './fixtures/gateway-response';

const LIMIT = 131_072;
const OLD_TEXT = 'Conversation too large or invalid';
const SYSTEM = 'You are EZiL Chat in Agent mode for the SportsWeb Prototype C workspace. Keep the fixtures page accessible.';
const CURRENT = 'CURRENT REQUIREMENT: add the fixtures page with a filter by league; keep 中文 team names and the dark theme.';

/** The tool list Copilot attaches in Agent mode: 38 tools with realistic schemas (about 1.3 KB each). */
const tools: Tool[] = Array.from({ length: 38 }, (_, i) => ({
    name: `tool_${i}`,
    description: `Tool ${i}: ${'Reads, edits or runs something in the workspace and reports what happened. '.repeat(8)}`,
    inputSchema: { type: 'object', properties: Object.fromEntries(['path', 'query', 'command', 'explanation', 'startLine', 'endLine'].map(key =>
        [key, { type: key.endsWith('Line') ? 'number' : 'string', description: `The ${key} for tool ${i}, as the workspace reports it.` }])) },
}));

/** Tool output the way a long session accumulates it: TypeScript, CJK prose with emoji (🏟 is outside the BMP), and JSON. */
function output(round: number): string {
    const ts = Array.from({ length: 40 }, (_, line) => `export const team${round}_${line} = { id: ${line}, name: 'Team ${line}', score: ${round * line} };`).join('\n');
    const cjk = Array.from({ length: 30 }, (_, line) => `第${line}行：球队「上海申花」对阵「北京国安」，比分 ${line}:${round}。⚽️🏟 備考：日本語テキストも含む。`).join('\n');
    const json = JSON.stringify({ round, passed: 40 - (round % 3), failed: round % 3, cases: Array.from({ length: 20 }, (_, n) => ({ name: `fixture ${n}`, ms: n * 7 })) });
    return `${ts}\n${cjk}\n${json}`;
}

/** A saved conversation: requirements, then `rounds` complete tool call/result groups with answers, then the current ask. */
function savedChat(rounds: number): Message[] {
    return [
        msg('system', txt(SYSTEM)),
        msg('user', txt('REQUIREMENT 1: every page must pass the accessibility audit.')),
        ...Array.from({ length: rounds }, (_, i) => [
            msg('assistant', txt(`Checking step ${i}.`), call(`call_${i}`, `tool_${i % 38}`, { path: `src/pages/p${i}.ts` })),
            msg('user', result(`call_${i}`, [txt(output(i))])),
            msg('assistant', txt(`Step ${i} done: the page renders and its tests pass.`)),
            msg('user', txt(i === rounds - 1 ? CURRENT : `Continue with step ${i + 1}.`)),
        ]).flat(),
    ];
}
const agent = (rounds: number): ChatRequest => ({ messages: savedChat(rounds), tools, toolMode: 'auto', modelOptions: {} });

type Post = { key: string | null; bytes: number; raw: Uint8Array; body: { system?: unknown; messages: { role: string; content: { type: string; id?: string; tool_use_id?: string }[] }[] } };
const tooLarge = (bound: number) => Response.json({ error: { type: 'invalid_request_error', code: 'input_too_large', max_input_tokens: bound, message: 'too large' } }, { status: 413 });
/** A Gateway stand-in that applies its own input bound (body bytes plus framing) before answering. */
function gateway(reply: (post: Post, index: number) => Response, bound = LIMIT) {
    const posts: Post[] = [];
    const fetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
        init.signal?.throwIfAborted();
        const raw = init.body as Uint8Array;
        const text = new TextDecoder().decode(raw);
        // A shortened tool output must not cut 🏟 in half (TextEncoder would send a lone surrogate as U+FFFD).
        expect(text).not.toContain('�');
        const post = { key: new Headers(init.headers).get('idempotency-key'), bytes: raw.byteLength, raw, body: JSON.parse(text) };
        posts.push(post);
        if (raw.byteLength + INPUT_FRAMING > bound) return tooLarge(bound);
        return reply(post, posts.length - 1);
    }) as typeof globalThis.fetch;
    return { posts, fetch };
}
const answer = () => Response.json(messageJson(), { headers: { 'x-ezil-request-id': 'req-ok' } });

async function run(request: ChatRequest, fetch: typeof globalThis.fetch, signal = new AbortController().signal, model = gw(KIMI)) {
    const events: StreamEvent[] = []; const compacted: unknown[] = [];
    let keys = 0;
    try {
        for await (const event of gatewayChat(model, request, { signal, fetch, now: () => 0, sleep: async () => {}, log: () => {},
            newIdempotencyKey: () => `key-${++keys}`, onCompact: (info: unknown) => compacted.push(info) } as Parameters<typeof gatewayChat>[2])) events.push(event);
        return { events, compacted, error: undefined };
    } catch (error) { return { events, compacted, error: error as Error & { code?: string } }; }
}
/** Every tool_use is answered in the next (user) message by results for exactly its ids, and every result has its call. */
function expectPaired(body: Post['body']) {
    let pairs = 0;
    body.messages.forEach((message, index) => {
        const uses = message.content.filter(block => block.type === 'tool_use').map(block => block.id);
        const answered = index ? body.messages[index - 1]!.content.filter(block => block.type === 'tool_use').map(block => block.id) : [];
        expect(message.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id)).toEqual(message.role === 'user' ? answered : []);
        if (!uses.length) return;
        const next = body.messages[index + 1]!;
        expect(next.role).toBe('user');
        expect(next.content.filter(block => block.type === 'tool_result').map(block => block.tool_use_id)).toEqual(uses);
        pairs += uses.length;
    });
    // The latest complete call/result group always survives compaction.
    expect(pairs).toBeGreaterThan(0);
}
const userFacing = (error: Error) => {
    expect(error.message).not.toContain(OLD_TEXT);
    expect(error.message).not.toMatch(/\n\s+at |extension\.js|\/usr\/lib\//);
};

beforeEach(() => forgetGatewayModels());
afterEach(() => forgetGatewayModels());

describe('a long saved Agent-mode chat continues (incident a255a2b2 replay, mocked Gateway, zero cost)', () => {
    test('Kimi: the saved conversation is over the bound, yet the same chat is answered from one compacted send', async () => {
        const request = agent(40);
        const before = structuredClone(request);
        const g = gateway(answer);
        const { events, compacted, error } = await run(request, g.fetch);
        expect(error?.message).toBeUndefined(); // main: "EZiL Models: Conversation too large or invalid — start a new chat", 0 sends
        expect(g.posts).toHaveLength(1);
        expect(events.some(event => event.type === 'text')).toBe(true);
        expect(compacted).toHaveLength(1);
        const sent = g.posts[0]!;
        expect(sent.bytes + INPUT_FRAMING).toBeLessThanOrEqual(LIMIT);
        // Current instructions survive verbatim: system text, the first requirement and the current ask.
        const wire = new TextDecoder().decode(sent.raw);
        expect(wire).toContain(SYSTEM);
        expect(wire).toContain('REQUIREMENT 1: every page must pass the accessibility audit.');
        expect(JSON.stringify(sent.body.messages.at(-1))).toContain(CURRENT);
        expectPaired(sent.body);
        // The saved transcript is the caller's and stays whole.
        expect(request).toEqual(before);
    });

    test('Qwen (streamed) on the same saved chat: compacted once, answered, transcript unchanged', async () => {
        const request = agent(40);
        const before = structuredClone(request);
        const g = gateway(() => new Response(frames('end_turn').join(''), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': 'req-ok' } }));
        const { events, compacted, error } = await run(request, g.fetch, undefined, gw(QWEN));
        expect(error?.message).toBeUndefined();
        expect(g.posts).toHaveLength(1);
        expect(compacted).toHaveLength(1);
        expect(g.posts[0]!.bytes + INPUT_FRAMING).toBeLessThanOrEqual(LIMIT);
        expect(events.some(event => event.type === 'text')).toBe(true);
        expectPaired(g.posts[0]!.body);
        expect(request).toEqual(before);
    });

    test('a tighter Gateway bound (413 input_too_large): one recompacted resend under a new key, then answered', async () => {
        const g = gateway(answer, 90_000);
        const { compacted, error } = await run(agent(40), g.fetch);
        expect(error?.message).toBeUndefined();
        expect(g.posts).toHaveLength(2);
        expect(compacted).toHaveLength(2);
        expect(compacted[1]).toMatchObject({ cause: 'remote' });
        expect(g.posts[0]!.key).not.toBe(g.posts[1]!.key);
        expect(g.posts[1]!.bytes + INPUT_FRAMING).toBeLessThanOrEqual(90_000);
        expectPaired(g.posts[1]!.body);
    });

    test('a second size refusal is final: exactly two sends, then an honest error', async () => {
        const g = gateway(() => tooLarge(90_000), 90_000);
        const { error } = await run(agent(40), g.fetch);
        expect(g.posts).toHaveLength(2);
        expect(error?.code).toBe('input_too_large');
        userFacing(error!);
    });

    test('a generic 400 invalid_request or a provider 502 is sent once and never compacted and resent', async () => {
        for (const [status, code] of [[400, 'invalid_request'], [502, 'upstream_error']] as const) {
            const g = gateway(() => Response.json({ error: { type: 'api_error', code, message: 'no' } }, { status }));
            const { compacted, error } = await run(agent(40), g.fetch);
            expect(g.posts).toHaveLength(1);
            expect(compacted).toHaveLength(1); // the local compaction before the send, nothing after the refusal
            expect(error?.code).toBe(code);
            userFacing(error!);
        }
    });

    test('cancelled while the compacted request is in flight: one send, no replay, nothing thrown', async () => {
        const controller = new AbortController();
        const posts: number[] = [];
        const fetch = (async (_input: string, init: RequestInit) => {
            posts.push((init.body as Uint8Array).byteLength);
            return new Promise<Response>((_, reject) => {
                init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                queueMicrotask(() => controller.abort());
            });
        }) as typeof globalThis.fetch;
        const { error } = await run(agent(40), fetch, controller.signal);
        expect(error).toBeUndefined();
        expect(posts).toHaveLength(1);
        expect(posts[0]! + INPUT_FRAMING).toBeLessThanOrEqual(LIMIT); // it was the compacted request that was in flight
    });

    test('an irreducible current message: an honest sized refusal, nothing sent, no stack, the chat kept', async () => {
        const request = agent(4);
        request.messages.push(msg('user', txt(`Paste: ${'球队数据'.repeat(40_000)}`)));
        const before = structuredClone(request);
        const g = gateway(answer);
        const { error } = await run(request, g.fetch);
        expect(g.posts).toHaveLength(0);
        expect(error).toBeDefined();
        userFacing(error!);
        expect(error!.message).toContain('Nothing was sent or charged, and the conversation is kept.');
        expect(error!.code).toBe('local_input_too_large');
        expect(request).toEqual(before);
    });
});
