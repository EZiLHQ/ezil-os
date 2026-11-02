// Counting and local refusals against the real serialized bodies. Numbers are pinned from the lane's scratch
// measurement (budget-model.ts / fill-model.ts) with the same formulas; Copilot 0.69's tool count is transcribed
// from its dist/extension.js (countToolTokens / _countObjectTokens / _textTokenLength).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseModelsConfig, type ResolvedModel } from '../src/config';
import { buildGatewayBody, escapeNonAscii, gatewayConversation, gatewayInputTokens, gatewayTokenCount, gatewayTools, KIMI, LocalRequestError, QWEN } from '../src/gateway-messages';
import { buildGatewayResponsesBody } from '../src/gateway-responses';
import type { ChatRequest, Message, Part, Tool } from '../src/types';
import { FIXTURES, loadFixture } from './fixtures/load';

const config = parseModelsConfig(readFileSync(`${import.meta.dir}/../../../worker/ezil-models/models.json`, 'utf8'),
    { env: { EZIL_AI_BASE_URL: 'https://proxy.invalid/ai/v1', EZIL_AI_PROXY_TOKEN: 'synthetic-proxy-token' } });
const kimi = config.models.find(model => model.model === KIMI)!;
const qwen = config.models.find(model => model.model === QWEN)!;
const responses: ResolvedModel = { ...qwen, id: 'responses', model: 'reviewed-azure', gatewayProtocol: 'openai-responses' };
const fixture = loadFixture(FIXTURES.toolRoundTrip);
const tools39 = fixture.tools;
const tools64 = [...tools39, ...tools39.slice(0, 25).map(tool => ({ ...tool, name: `mcp_${tool.name}`.slice(0, 64) }))];
const SENTINEL = 'PAYLOAD-SENTINEL-7f3a';

/** Copilot 0.69 countToolTokens: 16 + Σ(8 + leaves of {name, description, parameters}), floored × 1.1. */
function copilotToolTokens(tools: readonly Tool[], count: (text: string) => number): number {
    const leaf = (text: string) => (text ? count(text) : 0);
    const object = (value: Record<string, unknown>): number => {
        let n = 0;
        for (const [key, child] of Object.entries(value)) if (child) {
            n += leaf(key);
            if (typeof child === 'string') n += leaf(child);
            else if (typeof child === 'object') n += object(child as Record<string, unknown>);
        }
        return n;
    };
    let total = tools.length ? 16 : 0;
    for (const tool of tools) total += 8 + object({ name: tool.name, description: tool.description, parameters: tool.inputSchema });
    return Math.floor(total * 1.1);
}
const copilotMessages = (messages: readonly Message[]) => 3 + messages.reduce((sum, message) => sum + 3 + gatewayTokenCount(message), 0);
const request = (messages: Message[], tools: readonly Tool[] = []): ChatRequest => ({ messages, tools: [...tools], toolMode: 'auto', modelOptions: {} });
const user = (text: string): Message => ({ role: 'user', parts: [{ type: 'text', value: text }] });
const messagesToolBytes = (model: ResolvedModel, tools: readonly Tool[]) =>
    buildGatewayBody(model, request([user('x')], tools)).bytes.byteLength - buildGatewayBody(model, request([user('x')])).bytes.byteLength;
/** What the tools add to the Responses bound: body bytes, escaping, and 128 per tool. */
function responsesToolBound(tools: readonly Tool[]) {
    const bound = (list: readonly Tool[]) => {
        const built = buildGatewayResponsesBody(responses, request([user('x')], list));
        const definitions = JSON.stringify(built.body.tools ?? []);
        return built.bytes.byteLength + Buffer.byteLength(escapeNonAscii(definitions)) - Buffer.byteLength(definitions) + 128 * (built.body.tools?.length ?? 0);
    };
    return bound(tools) - bound([]);
}
function refusal(run: () => unknown): LocalRequestError {
    try { run(); } catch (error) { if (error instanceof LocalRequestError) return error; throw error; }
    throw new Error('expected a local refusal');
}

describe('string counting never under-counts a string in any protocol', () => {
    const corpus = ['你好', 'a', 'name', 'quote"backslash\\', 'line\nbreak\ttab', '\u0001ctrl', '🌍', 'é', '\ud800', 'x'.repeat(100), '中文 and ascii', '</script>', ''];
    test('Messages: the exact bytes of the JSON string literal, quotes and escapes included', () => {
        // Measured: '你好' adds 8 bytes to a Messages body ("你好" with its quotes); content-only counting (6) would under-count.
        expect(gatewayTokenCount('你好')).toBe(8);
        expect(gatewayTokenCount('a"b\\c\n')).toBe(Buffer.byteLength('"a\\"b\\\\c\\n"'));
        for (const text of corpus) expect(gatewayTokenCount(text)).toBe(Buffer.byteLength(JSON.stringify({ k: text })) - Buffer.byteLength('{"k":}'));
    });
    test('Responses: escaped non-ASCII as the Gateway bound counts it, plus the text-block margin', () => {
        expect(gatewayTokenCount('你好', 'openai-responses')).toBe('{"type":"text","text":"\\u4f60\\u597d"}'.length);
        for (const text of corpus) {
            const inBound = escapeNonAscii(JSON.stringify(text)).length;
            expect(gatewayTokenCount(text, 'openai-responses')).toBe(inBound + '{"type":"text","text":}'.length);
            expect(gatewayTokenCount(text, 'openai-responses')).toBeGreaterThanOrEqual(gatewayTokenCount(text));
        }
    });
    test('message-level counts are unchanged: the serialized wire message, whatever the protocol', () => {
        const message = user('你好 🌍\n"');
        expect(gatewayTokenCount(message, 'openai-responses')).toBe(gatewayTokenCount(message));
    });
});

describe('Copilot tool counting against real tool bytes (measured)', () => {
    test('Messages, 39 and 64 agent tools: Copilot counts at least the real bytes, at most 1.1x', () => {
        for (const [tools, real, counted] of [[tools39, 53_535, 57_539], [tools64, 83_921, 90_142]] as const) {
            for (const model of [kimi, qwen]) expect(messagesToolBytes(model, tools)).toBe(real);
            const p = copilotToolTokens(tools, text => gatewayTokenCount(text));
            expect(p).toBe(counted);
            expect(p).toBeGreaterThanOrEqual(real);
            expect(p).toBeLessThanOrEqual(Math.floor(real * 1.1));
        }
    });
    test('Responses, 39 and 64 agent tools: the kept margin covers the bound (escaping and 128 per tool)', () => {
        for (const [tools, bound, counted] of [[tools39, 59_199, 88_316], [tools64, 93_206, 139_968]] as const) {
            expect(responsesToolBound(tools)).toBe(bound);
            const p = copilotToolTokens(tools, text => gatewayTokenCount(text, 'openai-responses'));
            expect(p).toBe(counted);
            expect(p).toBeGreaterThanOrEqual(bound);
        }
    });
    test('the old text-block count over-counted 39 Messages tools 1.65x', () => {
        expect(copilotToolTokens(tools39, text => Buffer.byteLength(JSON.stringify({ type: 'text', text })))).toBe(88_254);
    });
});

describe('the normal agent render fits the local bound', () => {
    const text = (n: number, seed: number) => { let s = ''; for (let i = seed; Buffer.byteLength(s) < n; i++) s += `${i} export const v${i} = { ok: true, "note": "请检查 ${i}" };\n`; return s; };
    function rounds(count: number, size: number, parallel: number): Message[] {
        const out: Message[] = [];
        for (let i = 0; i < count; i++) {
            const ids = Array.from({ length: parallel }, (_, j) => `toolu_${i}_${j}`);
            out.push({ role: 'assistant', parts: [{ type: 'text', value: 'Reading.' }, ...ids.map((id): Part => ({ type: 'tool_call', callId: id, name: 'read_file', input: { filePath: `/workspace/${id}.ts`, startLine: 1, endLine: 400 } }))] });
            for (const id of ids) out.push({ role: 'user', parts: [{ type: 'tool_result', callId: id, content: [{ type: 'text', value: text(size, i) }] }] });
        }
        return out;
    }
    const system = fixture.messages.find(message => message.role === 'system')!;
    const context = fixture.messages.filter(message => message.role === 'user').slice(0, 2);
    for (const model of [kimi, qwen]) for (const [tools, name] of [[tools39, '39'], [tools64, '64']] as const) for (const [size, parallel] of [[300, 1], [4000, 1], [12000, 1], [1500, 4]] as const) {
        test(`${model.model}, ${name} tools, ${parallel}x${size} B results: history pruned to Copilot's budget builds`, () => {
            // Agent intent endpoint I: floor((maxInputTokens - toolTokens) * 0.9), newest history kept.
            const budget = Math.max(1, Math.floor((gatewayInputTokens(model) - copilotToolTokens(tools, value => gatewayTokenCount(value))) * 0.9));
            const all = rounds(300, size, parallel);
            const render = (kept: number) => [system, ...context, ...all.slice(all.length - kept * (parallel + 1)), user('Continue.')];
            let kept = 0;
            while (kept < 300 && copilotMessages(render(kept + 1)) <= budget) kept++;
            expect(() => buildGatewayBody(model, request(render(kept), tools))).not.toThrow();
        });
    }
});

describe('local refusals carry sizes only and send nothing', () => {
    test('over the byte bound: local_input_too_large with body, limit and tool bytes', () => {
        const small = buildGatewayBody(kimi, request([user('x')], tools39)).bytes.byteLength;
        const big = `${SENTINEL}${'字'.repeat(30_000)}`;
        const error = refusal(() => buildGatewayBody(kimi, request([user(big)], tools39)));
        expect(error.code).toBe('local_input_too_large');
        expect(error.counts).toEqual({
            bodyBytes: small - Buffer.byteLength('"x"') + Buffer.byteLength(JSON.stringify(big)), limitBytes: 131_072 - 1056,
            messages: 1, maxBlocks: 1, tools: 39, toolBytes: Buffer.byteLength(JSON.stringify(gatewayTools(tools39))),
        });
        expect(error.counts.toolBytes).toBe(53_535 - Buffer.byteLength(',"tools":,"tool_choice":{"type":"auto"}'));
        for (const text of [error.message, JSON.stringify(error), String(error.stack)]) expect(text).not.toContain(SENTINEL);
    });
    test('more than 1024 wire messages: local_too_many_messages', () => {
        const messages = Array.from({ length: 1025 }, (_, i): Message => ({ role: i % 2 ? 'assistant' : 'user', parts: [{ type: 'text', value: `${SENTINEL} ${i}` }] }));
        const error = refusal(() => buildGatewayBody(qwen, request(messages)));
        expect(error.code).toBe('local_too_many_messages');
        expect(error.counts.messages).toBe(1025);
        expect(JSON.stringify(error)).not.toContain(SENTINEL);
    });
    test('more than 1024 blocks in one message (1025 parallel results): local_too_many_blocks', () => {
        const ids = Array.from({ length: 1025 }, (_, i) => `call_${i}`);
        const messages: Message[] = [user('go'),
            { role: 'assistant', parts: ids.map((id): Part => ({ type: 'tool_call', callId: id, name: tools39[0]!.name, input: {} })) },
            { role: 'user', parts: ids.map((id): Part => ({ type: 'tool_result', callId: id, content: [{ type: 'text', value: SENTINEL }] })) }];
        const error = refusal(() => buildGatewayBody(qwen, request(messages, tools39)));
        expect(error.code).toBe('local_too_many_blocks');
        expect(error.counts).toMatchObject({ messages: 3, maxBlocks: 1025, tools: 39 });
        expect(JSON.stringify(error)).not.toContain(SENTINEL);
    });
});

describe('model-switch history keeps complete tool groups', () => {
    test('thinking, markers, an orphan result and a cancelled call become a valid pairing without thinking', () => {
        const marker = (mimeType: string): Part => ({ type: 'data', mimeType, data: new TextEncoder().encode('x') });
        const name = tools39[0]!.name;
        const history: Message[] = [
            { role: 'system', parts: [{ type: 'text', value: 'rules' }, marker('cache_control')] },
            user('start'),
            { role: 'assistant', parts: [{ type: 'thinking', value: 'prior model reasoning', metadata: { signature: 'sig' } }, marker('stateful_marker'),
                { type: 'tool_call', callId: 'done', name, input: {} }, { type: 'tool_call', callId: 'cancelled', name, input: {} }] },
            { role: 'user', parts: [{ type: 'tool_result', callId: 'done', content: [{ type: 'text', value: 'ok' }] }, { type: 'tool_result', callId: 'orphan', content: [{ type: 'text', value: 'late' }] }] },
            user('switched model; continue'),
        ];
        const body = buildGatewayBody(kimi, request(history, tools39)).body;
        expect(JSON.stringify(body)).not.toMatch(/thinking|prior model reasoning|signature|stateful_marker|cache_control/);
        const conversation = gatewayConversation(history, gatewayTools(tools39));
        expect(conversation.messages).toEqual(body.messages);
        for (let i = 0; i < body.messages.length; i++) {
            const message = body.messages[i]!;
            if (message.role !== 'assistant') continue;
            const calls = message.content.flatMap(block => block.type === 'tool_use' ? [block.id] : []);
            const next = body.messages[i + 1]!;
            const results = next.content.flatMap(block => block.type === 'tool_result' ? [block.tool_use_id] : []);
            expect(next.role).toBe('user');
            expect(results.sort()).toEqual(calls.sort());
        }
        const results = body.messages.flatMap(message => message.content.filter(block => block.type === 'tool_result'));
        expect(results).toContainEqual(expect.objectContaining({ tool_use_id: 'cancelled', is_error: true }));
        expect(JSON.stringify(body)).toContain('[Earlier tool output]\\nlate');
    });
});
