// Integration: the VS Code-facing provider against in-process mock Anthropic / OpenAI servers, with a
// fake `vscode` module. Exercises the full Agent-mode tool-call round trip both ways.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { parseModelsConfig, type ResolvedConfig, type ResolvedModel } from '../src/config';
import type { Usage } from '../src/types';
import { startMockAnthropic, type MockServer as AnthropicMock } from './fixtures/mock-anthropic';
import { startMockOpenAI, type MockServer as OpenAIMock } from './fixtures/mock-openai';

class TextPart { constructor(public value: string) {} }
class ToolCallPart { constructor(public callId: string, public name: string, public input: object) {} }
class ToolResultPart { constructor(public callId: string, public content: unknown[]) {} }
class DataPart { constructor(public data: Uint8Array, public mimeType: string) {} static text(value: string, mime = 'text/plain') { return new DataPart(new TextEncoder().encode(value), mime); } }
class ThinkingPart { constructor(public value: string | string[], public id?: string, public metadata?: Record<string, unknown>) {} }
class EventEmitter<T> { private listeners: ((value: T) => void)[] = []; event = (listener: (value: T) => void) => { this.listeners.push(listener); return { dispose: () => {} }; }; fire(value: T) { for (const listener of this.listeners) listener(value); } dispose() {} }

const fakeVscode: Record<string, unknown> = {
    LanguageModelTextPart: TextPart,
    LanguageModelToolCallPart: ToolCallPart,
    LanguageModelToolResultPart: ToolResultPart,
    LanguageModelDataPart: DataPart,
    LanguageModelThinkingPart: ThinkingPart,
    LanguageModelChatMessageRole: { User: 1, Assistant: 2, System: 3 },
    LanguageModelChatToolMode: { Auto: 1, Required: 2 },
    EventEmitter,
};
mock.module('vscode', () => fakeVscode);

const providerModule = await import('../src/provider');
const { EZiLModelsProvider, toNeutralMessage, toInformation, requestForLog } = providerModule;

type Token = { isCancellationRequested: boolean; onCancellationRequested: (cb: () => void) => { dispose(): void }; cancel(): void };
function token(): Token {
    const listeners: (() => void)[] = [];
    const value: Token = { isCancellationRequested: false, onCancellationRequested: cb => { listeners.push(cb); return { dispose() {} }; }, cancel() { value.isCancellationRequested = true; for (const cb of listeners) cb(); } };
    return value;
}
const message = (role: number, content: unknown[], name?: string) => ({ role, content, name });
const CREATE_FILE = { name: 'create_file', description: 'Create a file', inputSchema: { type: 'object', properties: { filePath: { type: 'string' }, content: { type: 'string' } }, required: ['filePath', 'content'] } };
const KEY = 'sk-test-secret-key-000111222';

let anthropic: AnthropicMock;
let openai: OpenAIMock;
let config: ResolvedConfig;
let logs: string[];
let usages: { model: string; usage: Usage }[];
let logRequests = false;
let provider: InstanceType<typeof EZiLModelsProvider>;

beforeAll(async () => {
    anthropic = await startMockAnthropic({ apiKey: KEY });
    openai = await startMockOpenAI({ apiKey: KEY });
    config = parseModelsConfig(JSON.stringify({
        providers: {
            anthropic: { type: 'anthropic', apiKey: '{env:TEST_KEY}', baseUrl: anthropic.url },
            foundry: { type: 'anthropic-foundry', apiKey: KEY, baseUrl: `${anthropic.url}/anthropic` },
            compat: { type: 'openai-compatible', apiKey: KEY, baseUrl: `${openai.url}/v1` },
            azure: { type: 'azure-openai', apiKey: KEY, baseUrl: `${openai.url}/openai/v1`, apiVersion: 'preview' },
            unreachable: { type: 'openai-compatible', baseUrl: 'http://127.0.0.1:9/v1' },
        },
        models: [
            { id: 'claude', provider: 'anthropic', model: 'claude-sonnet-5', thinking: { type: 'adaptive', effort: 'high' }, default: true, roles: ['default'] },
            { id: 'claude-foundry', provider: 'foundry', model: 'my-deployment', cache: { ttl: '1h' } },
            { id: 'gpt', provider: 'compat', model: 'gpt-mock' },
            { id: 'gpt-azure', provider: 'azure', model: 'gpt-deployment' },
            { id: 'bad-key', provider: 'anthropic', model: 'mock-401' },
            { id: 'echo-key', provider: 'anthropic', model: 'mock-401-echo' },
            { id: 'limited', provider: 'anthropic', model: 'mock-429' },
            { id: 'refuses', provider: 'anthropic', model: 'mock-refusal' },
            { id: 'nowhere', provider: 'unreachable', model: 'x' },
        ],
    }), { env: { TEST_KEY: KEY } });
    logs = []; usages = [];
    provider = new EZiLModelsProvider(host);
});
const host = {
    models: () => config.models,
    configError: () => undefined,
    secrets: () => config.secrets,
    logRequests: () => logRequests,
    log: (line: string) => logs.push(line),
    recordUsage: (model: ResolvedModel, usage: Usage) => usages.push({ model: model.id, usage }),
};
afterAll(async () => { await anthropic.close(); await openai.close(); });

async function run(modelId: string, messages: unknown[], tools: unknown[] = [CREATE_FILE], toolMode = 1, cancel?: Token) {
    const info = toInformation(config.models.find(model => model.id === modelId)!);
    const parts: unknown[] = [];
    await provider.provideLanguageModelChatResponse(info as never, messages as never, { tools, toolMode, modelOptions: { _enableThinking: true, requestInitiator: 'github.copilot-chat' } } as never, { report: (part: unknown) => parts.push(part) }, (cancel ?? token()) as never);
    return parts;
}

describe('VS Code bridge', () => {
    test('maps every part class and the System role (3) to neutral messages', () => {
        const neutral = toNeutralMessage(message(3, [new TextPart('sys'), DataPart.text('ephemeral', 'cache_control')]) as never);
        expect(neutral).toEqual({ role: 'system', parts: [{ type: 'text', value: 'sys' }, { type: 'data', mimeType: 'cache_control', data: new TextEncoder().encode('ephemeral') }] });
        const assistant = toNeutralMessage(message(2, [new ThinkingPart('', undefined, { signature: 's', _completeThinking: 't' }), new TextPart('hi'), new ToolCallPart('c1', 'create_file', { a: 1 })]) as never);
        expect(assistant.parts).toEqual([{ type: 'thinking', value: '', id: undefined, metadata: { signature: 's', _completeThinking: 't' } }, { type: 'text', value: 'hi' }, { type: 'tool_call', callId: 'c1', name: 'create_file', input: { a: 1 } }]);
        const user = toNeutralMessage(message(1, [new ToolResultPart('c1', [new TextPart('ok'), new DataPart(new Uint8Array([1, 2]), 'image/png')])], 'tool') as never);
        expect(user).toEqual({ role: 'user', name: 'tool', parts: [{ type: 'tool_result', callId: 'c1', content: [{ type: 'text', value: 'ok' }, { type: 'data', mimeType: 'image/png', data: new Uint8Array([1, 2]) }], isError: false }] });
    });

    test('model information carries capabilities, limits and the default flag', async () => {
        const infos = await provider.provideLanguageModelChatInformation({ silent: true } as never, token() as never);
        expect(infos.map(info => info.id)).toEqual(config.models.map(model => model.id));
        expect(infos[0]).toEqual(expect.objectContaining({ id: 'claude', name: 'claude', family: 'claude', version: '1', maxInputTokens: 200_000, maxOutputTokens: 64_000, capabilities: { toolCalling: true, imageInput: true }, isDefault: true, isUserSelectable: true }));
        expect((infos[1] as { isDefault?: boolean }).isDefault).toBe(false);
        expect(await provider.provideTokenCount(infos[0]!, 'hello world', token() as never)).toBeGreaterThan(0);
        expect(await provider.provideTokenCount(infos[0]!, message(1, [new TextPart('hello world'), new DataPart(new Uint8Array(3), 'image/png')]) as never, token() as never)).toBeGreaterThan(1600);
    });
});

describe('Anthropic round trip through the provider', () => {
    test('turn 1 streams text + tool call; turn 2 with the tool result reads the cache', async () => {
        anthropic.requests.length = 0; usages.length = 0;
        const system = message(3, [new TextPart(`You are an expert AI programming assistant. ${'Follow the rules. '.repeat(120)}`)]);
        const turn1 = await run('claude', [system, message(1, [new TextPart('create hello.txt containing hi')])]);
        expect(turn1.filter(part => part instanceof TextPart).map(part => (part as TextPart).value).join('')).toBe('I will create hello.txt now.');
        const call = turn1.find(part => part instanceof ToolCallPart) as ToolCallPart;
        expect(call.name).toBe('create_file');
        expect(call.input).toEqual({ filePath: '/home/coder/project/hello.txt', content: 'hi\n' });
        const request1 = anthropic.requests[0]!;
        expect(request1.url).toBe('/v1/messages');
        expect(request1.headers['x-api-key']).toBe(KEY);
        expect(request1.headers['anthropic-version']).toBe('2023-06-01');
        expect(request1.headers.authorization).toBeUndefined();
        expect(request1.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
        expect(request1.body.output_config).toEqual({ effort: 'high' });
        expect((request1.body.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral' });
        expect((request1.body.tools as { name: string; cache_control?: unknown }[])[0]).toEqual(expect.objectContaining({ name: 'create_file', cache_control: { type: 'ephemeral' } }));
        expect(usages[0]!.usage.cacheWriteTokens).toBeGreaterThan(0);
        expect(usages[0]!.usage.cacheReadTokens).toBe(0);

        const turn2 = await run('claude', [
            system,
            message(1, [new TextPart('create hello.txt containing hi')]),
            message(2, [new TextPart('I will create hello.txt now.'), new ToolCallPart(call.callId, call.name, call.input)]),
            message(1, [new ToolResultPart(call.callId, [new TextPart('The following files were successfully edited:\n/home/coder/project/hello.txt\n')])], 'tool'),
        ]);
        expect(turn2.map(part => (part as TextPart).value).join('')).toBe('Done. I created the file as requested.');
        const request2 = anthropic.requests[1]!;
        const messages = request2.body.messages as { role: string; content: Record<string, unknown>[] }[];
        expect(messages.map(entry => entry.role)).toEqual(['user', 'assistant', 'user']);
        expect(messages[1]!.content[1]).toEqual({ type: 'tool_use', id: call.callId, name: 'create_file', input: call.input });
        expect(messages[2]!.content[0]).toEqual({ type: 'tool_result', tool_use_id: call.callId, content: [{ type: 'text', text: expect.stringContaining('successfully edited') }], cache_control: { type: 'ephemeral' } });
        expect(usages[1]!.usage.cacheReadTokens).toBeGreaterThan(0);
        expect(logs.some(line => line.includes('[request] claude ->'))).toBe(true);
        for (const line of logs) expect(line).not.toContain(KEY);
    });

    test('Foundry provider posts to <base>/anthropic/v1/messages with x-api-key and 1h cache ttl', async () => {
        anthropic.requests.length = 0;
        await run('claude-foundry', [message(3, [new TextPart('sys')]), message(1, [new TextPart('hello')])], []);
        const request = anthropic.requests[0]!;
        expect(request.url).toBe('/anthropic/v1/messages');
        expect(request.headers['x-api-key']).toBe(KEY);
        expect(request.body.model).toBe('my-deployment');
        expect((request.body.system as { cache_control: unknown }[])[0]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
        expect(request.body.tools).toBeUndefined();
    });

    test('thinking parts are reported when the proposed class exists and dropped otherwise; logRequests prints a redacted body', async () => {
        anthropic.next([{ type: 'thinking', thinking: 'pondering', signature: 'SIG' }, { type: 'text', text: 'answer' }]);
        logRequests = true; logs.length = 0;
        const withThinking = await run('claude', [message(3, [new TextPart(`secret in prompt ${KEY}`)]), message(1, [new TextPart('q')])], []);
        logRequests = false;
        expect(withThinking.filter(part => part instanceof ThinkingPart)).toHaveLength(3);
        expect((withThinking.at(-2) as ThinkingPart).metadata).toEqual({ signature: 'SIG', _completeThinking: 'pondering' });
        expect((withThinking.at(-1) as TextPart).value).toBe('answer');
        const dump = logs.find(line => line.includes('"messages"'))!;
        expect(dump).toContain('"system"');
        expect(dump).toContain('[redacted]');
        expect(dump).not.toContain(KEY);
        // Without the proposed class (stable VS Code without the proposal): thinking is dropped, text still flows.
        mock.module('vscode', () => ({ ...fakeVscode, LanguageModelThinkingPart: undefined }));
        try {
            // A query string makes bun evaluate a second copy of provider.ts against the re-mocked `vscode`.
            const freshCopy: string = '../src/provider?nothinking';
            const { EZiLModelsProvider: Without } = await import(freshCopy) as typeof providerModule;
            const bare = new Without(host);
            anthropic.next([{ type: 'thinking', thinking: 'pondering', signature: 'SIG' }, { type: 'text', text: 'answer' }]);
            const parts: unknown[] = [];
            await bare.provideLanguageModelChatResponse(toInformation(config.models[0]!) as never, [message(1, [new TextPart('q')])] as never, { tools: [], toolMode: 1, modelOptions: {} } as never, { report: (part: unknown) => parts.push(part) }, token() as never);
            expect(parts).toEqual([new TextPart('answer')]);
        } finally { mock.module('vscode', () => fakeVscode); }
    });

    test('errors are readable and never leak keys; refusal becomes an error; cancellation is silent', async () => {
        await expect(run('bad-key', [message(1, [new TextPart('q')])], [])).rejects.toThrow(/rejected the API key \(401\).*providers\.anthropic\.apiKey/);
        const echoed = await run('echo-key', [message(1, [new TextPart('q')])], []).then(() => undefined, (error: Error) => error);
        expect(echoed).toBeInstanceOf(Error);
        expect(echoed!.message).toMatch(/Upstream said: authentication_error: invalid x-api-key \[redacted\]/);
        expect(echoed!.message).not.toContain(KEY);
        await expect(run('limited', [message(1, [new TextPart('q')])], [])).rejects.toThrow(/rate limiting \(429\); retry after 7s/);
        anthropic.next([]); // refusal before any text -> error; with text already streamed the note is appended instead
        await expect(run('refuses', [message(1, [new TextPart('q')])], [])).rejects.toThrow(/declined this request \(cyber\)/);
        const partial = await run('refuses', [message(1, [new TextPart('q')])], []);
        expect(partial.map(part => (part as TextPart).value).join('')).toMatch(/Mock Claude reply.*_The model declined this request \(cyber\)/s);
        await expect(run('nowhere', [message(1, [new TextPart('q')])], [])).rejects.toThrow(/cannot reach unreachable at 127\.0\.0\.1:9/);
        const cancel = token(); cancel.cancel();
        anthropic.requests.length = 0;
        expect(await run('claude', [message(1, [new TextPart('q')])], [], 1, cancel)).toEqual([]);
        expect(anthropic.requests).toHaveLength(0);
        for (const line of logs) expect(line).not.toContain(KEY);
    });
});

describe('OpenAI-compatible round trip through the provider', () => {
    test('tool call and tool result flow through chat completions with Bearer auth', async () => {
        openai.requests.length = 0;
        const turn1 = await run('gpt', [message(3, [new TextPart('You are helpful.')]), message(1, [new TextPart('create hello.txt containing hi')])], [CREATE_FILE], 2);
        const call = turn1.find(part => part instanceof ToolCallPart) as ToolCallPart;
        expect(call.name).toBe('create_file');
        expect(call.input).toEqual({ filePath: '/home/coder/project/hello.txt', content: 'hi\n' });
        const request1 = openai.requests[0]!;
        expect(request1.url).toBe('/v1/chat/completions');
        expect(request1.headers.authorization).toBe(`Bearer ${KEY}`);
        expect(request1.body.tool_choice).toBe('required');
        expect(request1.body.max_tokens).toBe(32_768);
        expect((request1.body.messages as { role: string }[]).map(entry => entry.role)).toEqual(['system', 'user']);

        const turn2 = await run('gpt', [
            message(3, [new TextPart('You are helpful.')]),
            message(1, [new TextPart('create hello.txt containing hi')]),
            message(2, [new TextPart('I will create hello.txt now.'), new ToolCallPart(call.callId, call.name, call.input)]),
            message(1, [new ToolResultPart(call.callId, [new TextPart('ok')])]),
        ]);
        expect(turn2.map(part => (part as TextPart).value).join('')).toBe('Done. I created the file as requested.');
        const messages = openai.requests[1]!.body.messages as Record<string, unknown>[];
        expect(messages.map(entry => entry.role)).toEqual(['system', 'user', 'assistant', 'tool']);
        expect(messages[2]!.tool_calls).toEqual([{ id: call.callId, type: 'function', function: { name: 'create_file', arguments: JSON.stringify(call.input) } }]);
        expect(messages[3]).toEqual({ role: 'tool', tool_call_id: call.callId, content: 'ok' });
        expect(usages.at(-1)!.usage.inputTokens).toBeGreaterThan(0);
    });

    test('Azure OpenAI uses the api-key header and the openai/v1 path with api-version', async () => {
        openai.requests.length = 0;
        await run('gpt-azure', [message(1, [new TextPart('hello')])], []);
        const request = openai.requests[0]!;
        expect(request.url).toBe('/openai/v1/chat/completions?api-version=preview');
        expect(request.headers['api-key']).toBe(KEY);
        expect(request.headers.authorization).toBeUndefined();
        expect(request.body.max_completion_tokens).toBe(32_768);
    });
});

test('requestForLog shortens base64 payloads', () => {
    const body = { messages: [{ content: [{ type: 'image', source: { data: 'A'.repeat(500) } }, { type: 'image_url', image_url: { url: `data:image/png;base64,${'B'.repeat(500)}` } }] }] };
    const text = requestForLog(body, ['nothing']);
    expect(text).toContain('<500 base64 chars>');
    expect(text).toContain('data:image/png;base64,<omitted>');
    expect(text.length).toBeLessThan(400);
});

describe('ezil-gateway through the VS Code bridge (mock EZiL AI proxy)', () => {
    const PROXY = 'q'.repeat(64);
    const seen: { path: string; auth: string | null; key: string | null; body?: Record<string, unknown> }[] = [];
    let server: ReturnType<typeof Bun.serve>;
    let gatewayConfig: ResolvedConfig;
    let gatewayProvider: InstanceType<typeof EZiLModelsProvider>;
    const gatewayLogs: string[] = [];
    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            async fetch(request) {
                const url = new URL(request.url);
                const entry: (typeof seen)[number] = { path: url.pathname, auth: request.headers.get('authorization'), key: request.headers.get('idempotency-key') };
                seen.push(entry);
                if (url.pathname === '/ai/v1/models') return Response.json({ object: 'list', killswitch: false, pause: null, data: [{ id: 'ezil-code', enabled: true, max_input_tokens: 16384, max_output_tokens: 4096 }] });
                entry.body = await request.json() as Record<string, unknown>;
                const input = entry.body.input as { type?: string }[];
                const answered = input.some(item => item.type === 'function_call_output');
                const events = answered
                    ? [{ type: 'response.output_text.delta', delta: 'Done.' }, { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 9, output_tokens: 2 } } }]
                    : [
                        { type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'create_file', arguments: '' } },
                        { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"filePath":"/w/hello.txt","content":"hi\\n"}' },
                        { type: 'response.output_item.done', output_index: 0, item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'create_file', arguments: '{"filePath":"/w/hello.txt","content":"hi\\n"}' } },
                        { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 7, output_tokens: 5 } } },
                    ];
                return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': 'req-mock' } });
            },
        });
        gatewayConfig = parseModelsConfig(JSON.stringify({
            providers: { ezil: { type: 'ezil-gateway', baseUrl: '{env:EZIL_AI_BASE_URL}', apiKey: '{env:EZIL_AI_PROXY_TOKEN}' } },
            models: [{ id: 'ezil-code', provider: 'ezil', model: 'ezil-code', default: true }],
        }), { env: { EZIL_AI_BASE_URL: `http://127.0.0.1:${server.port}/ai/v1`, EZIL_AI_PROXY_TOKEN: PROXY } });
        gatewayProvider = new EZiLModelsProvider({ ...host, models: () => gatewayConfig.models, secrets: () => gatewayConfig.secrets, log: line => gatewayLogs.push(line) });
    });
    afterAll(() => server.stop(true));

    test('advertises the allowance minus the framing reserve, text only', () => {
        const info = toInformation(gatewayConfig.models[0]!);
        expect(info.maxInputTokens).toBe(16384 - 1536);
        expect(info.maxOutputTokens).toBe(4096);
        expect(info.capabilities).toEqual({ toolCalling: true, imageInput: false });
    });

    test('counts tokens as the gateway bound does (UTF-8 bytes of the item + 32)', async () => {
        const info = toInformation(gatewayConfig.models[0]!);
        expect(await gatewayProvider.provideTokenCount(info as never, 'héllo', token() as never)).toBe(Buffer.byteLength('"héllo"'));
        expect(await gatewayProvider.provideTokenCount(info as never, message(1, [new TextPart('hi')]) as never, token() as never)).toBe(Buffer.byteLength('{"role":"user","content":"hi"}') + 1 + 32);
    });

    test('an Agent-mode tool round trip: one key per turn, proxy token only, tool call then text', async () => {
        const info = toInformation(gatewayConfig.models[0]!);
        const first: unknown[] = [];
        await gatewayProvider.provideLanguageModelChatResponse(info as never, [message(3, [new TextPart('sys')]), message(1, [new TextPart('make hello.txt')])] as never, { tools: [CREATE_FILE], toolMode: 1, modelOptions: {} } as never, { report: (part: unknown) => first.push(part) }, token() as never);
        expect(first).toEqual([new ToolCallPart('call_1', 'create_file', { filePath: '/w/hello.txt', content: 'hi\n' })]);
        const second: unknown[] = [];
        await gatewayProvider.provideLanguageModelChatResponse(info as never, [
            message(3, [new TextPart('sys')]), message(1, [new TextPart('make hello.txt')]),
            message(2, [new ToolCallPart('call_1', 'create_file', { filePath: '/w/hello.txt', content: 'hi\n' })]),
            message(1, [new ToolResultPart('call_1', [new TextPart('created')])]),
        ] as never, { tools: [CREATE_FILE], toolMode: 1, modelOptions: {} } as never, { report: (part: unknown) => second.push(part) }, token() as never);
        expect(second).toEqual([new TextPart('Done.')]);
        const posts = seen.filter(entry => entry.path === '/ai/v1/responses');
        expect(posts).toHaveLength(2);
        expect(posts[0]!.key).not.toBe(posts[1]!.key);
        for (const post of posts) expect(post.auth).toBe(`Bearer ${PROXY}`);
        expect(posts[1]!.body!.input).toEqual([
            { role: 'user', content: 'make hello.txt' },
            { type: 'function_call', call_id: 'call_1', name: 'create_file', arguments: '{"filePath":"/w/hello.txt","content":"hi\\n"}' },
            { type: 'function_call_output', call_id: 'call_1', output: 'created' },
        ]);
        expect(gatewayLogs.join('\n')).not.toContain(PROXY);
        expect(gatewayLogs.some(line => line.includes('request=req-mock'))).toBe(true);
    });
});
