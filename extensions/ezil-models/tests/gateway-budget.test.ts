// Counting and local refusals against the real serialized bodies. Numbers are pinned from the lane's scratch
// measurement (budget-model.ts / fill-model.ts) with the same formulas; Copilot 0.69's tool count is transcribed
// from its dist/extension.js (countToolTokens / _countObjectTokens / _textTokenLength).
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseModelsConfig, type ResolvedModel } from '../src/config';
import { buildGatewayBody, escapeNonAscii, gatewayConversation, gatewayTokenCount, gatewayTools, KIMI, LocalRequestError, QWEN } from '../src/gateway-messages';
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

describe('model token estimates are independent of wire bytes', () => {
    test('short text has no repeated JSON-block tax; protocols share token units', () => {
        for (const protocol of ['anthropic-messages', 'openai-responses'] as const) {
            expect(gatewayTokenCount('hello world', protocol)).toBe(4);
            expect(gatewayTokenCount('x'.repeat(3400), protocol)).toBe(1000);
            expect(gatewayTokenCount(user('x'.repeat(3400)), protocol)).toBe(1004);
        }
    });
    test('39 and 64 real tools leave room for history instead of consuming most of the model', () => {
        // Budget estimates may differ from real tokenizers. They must not be inflated to cover HTTP bytes.
        for (const [tools, bytes] of [[tools39, 53535], [tools64, 83921]] as const) {
            expect(messagesToolBytes(qwen, tools)).toBe(bytes);
            const tokens = copilotToolTokens(tools, gatewayTokenCount);
            expect(tokens).toBeLessThan(30000);
            expect(tokens).toBeGreaterThan(10000);
        }
        expect(responsesToolBound(tools39)).toBe(59199);
    });
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
