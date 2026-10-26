// Integration: the VS Code-facing provider against in-process mock Anthropic / OpenAI servers, with a
// fake `vscode` module. Exercises the full Agent-mode tool-call round trip both ways.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { parseModelsConfig, type ResolvedConfig, type ResolvedModel } from '../src/config';
import { forgetGatewayModels } from '../src/gateway';
import type { Usage } from '../src/types';
import { startMockAnthropic, type MockServer as AnthropicMock } from './fixtures/mock-anthropic';
import { startMockOpenAI, type MockServer as OpenAIMock } from './fixtures/mock-openai';

import { TextPart, ToolCallPart, ToolResultPart, DataPart, ThinkingPart, EventEmitter, fakeVscode } from './fixtures/fake-vscode';

const showRetryError = mock(async (_message: string, ..._actions: string[]): Promise<string | undefined> => undefined);
const retryCommand = mock(async (_command: string) => undefined);
(fakeVscode.window as Record<string, unknown>).showErrorMessage = showRetryError;
(fakeVscode.commands as Record<string, unknown>).executeCommand = retryCommand;

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
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        if (String(input).startsWith(anthropic.url)) return anthropic.fetch(input, init);
        if (String(input).startsWith(openai.url)) return openai.fetch(input, init);
        throw new TypeError('fetch failed');
    }) as typeof fetch,
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

// Gateway bridge coverage uses the same VS Code mock and entirely injected transports.
const { gw } = await import('./fixtures/gateway');
const { frames, messageJson } = await import('./fixtures/gateway-response');
const { gatewayTokenCount, KIMI } = await import('../src/gateway-messages');

describe('EZiL gateway VS Code bridge', () => {
    // Fixtures reuse the same URL/auth identity but provide independent catalogs in each test.
    beforeEach(() => forgetGatewayModels());

    function catalog(maxInputTokens = 131072, maxOutputTokens = 8192) {
        return { data: [gw(), gw(KIMI)].map(model => ({ id: model.model, alias: model.model, upstream_model: 'upstream', enabled: true,
            max_input_tokens: maxInputTokens, max_output_tokens: maxOutputTokens })) };
    }
    function gatewayHost(doFetch: typeof fetch, getCatalog: () => Response = () => Response.json(catalog())) {
        const models = [gw(), gw(KIMI)];
        models[1]!.provider = models[0]!.provider;
        models[0]!.default = true; models[1]!.default = false;
        const lines: string[] = []; const usage: Usage[] = [];
        const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
            init?.signal?.throwIfAborted();
            return String(input).endsWith('/models') ? getCatalog() : doFetch(input, init);
        }) as typeof globalThis.fetch;
        return { models: () => models, configError: () => undefined, secrets: () => ['synthetic-proxy-token'], logRequests: () => true,
            log: (s: string) => lines.push(s), recordUsage: (_m: ResolvedModel, u: Usage) => usage.push(u), fetch, lines, usage };
    }
    test('advertises reserved input and per-model output; hides disabled models and caches catalog', async () => {
        let gets = 0;
        const host = gatewayHost((async () => { throw new Error('unexpected POST'); }) as unknown as typeof fetch, () => {
            gets++; const models = catalog(); models.data[1]!.enabled = false; return Response.json(models);
        });
        const provider = new EZiLModelsProvider(host);
        const info = await provider.provideLanguageModelChatInformation({} as never, token() as never);
        expect(info).toHaveLength(1); expect(info[0]).toMatchObject({ maxInputTokens: 104480, maxOutputTokens: 8192, capabilities: { imageInput: false }, isDefault: true });
        const calls = gets;
        await provider.provideLanguageModelChatInformation({} as never, token() as never);
        expect(gets).toBe(calls);
        const value = message(1, [new TextPart('你好 🌍')]);
        expect(await provider.provideTokenCount(info[0]!, value as never, token() as never)).toBe(gatewayTokenCount(toNeutralMessage(value as never)));
        expect(toInformation(host.models()[1]!)).toMatchObject({ maxOutputTokens: 4096 });
    });
    for (const [configured, advertised, effective] of [[8192, 4096, 4096], [1024, 8192, 1024], [65536, 65536, 16384], [1, 4096, 16]] as const) {
        test(`output config=${configured} catalog=${advertised} advertises and sends ${effective}`, async () => {
            let gets = 0;
            const bodies: Record<string, unknown>[] = [];
            const host = gatewayHost((async (_url: unknown, init?: RequestInit) => {
                bodies.push(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)));
                return new Response(frames().join(''), { headers: { 'content-type': 'text/event-stream' } });
            }) as unknown as typeof fetch, () => { gets++; return Response.json(catalog(131072, advertised)); });
            host.models()[0]!.maxOutputTokens = configured;
            host.models()[0]!.id = 'configured-picker-id'; // Catalog lookup uses the wire model, not the picker ID.
            const provider = new EZiLModelsProvider(host);
            // A response must load limits even when VS Code has not requested model information yet.
            await provider.provideLanguageModelChatResponse(toInformation(host.models()[0]!), [message(1, [new TextPart('q')])] as never,
                { tools: [], modelOptions: { max_tokens: 16384 } } as never, { report: () => {} }, token() as never);
            const infos = await provider.provideLanguageModelChatInformation({} as never, token() as never);
            expect(infos[0]!.maxOutputTokens).toBe(effective);
            expect(bodies).toHaveLength(1); expect(bodies[0]!.max_tokens).toBe(effective);
            expect(gets).toBe(1); expect(host.models()[0]!.maxOutputTokens).toBe(configured);
        });
    }
    for (const [configured, advertised] of [[131072, 32768], [32768, 65536]] as const) {
        test(`input config=${configured} catalog=${advertised} reserves space and bounds UTF-8 bytes`, async () => {
            const bodies: Uint8Array[] = [];
            const host = gatewayHost((async (_url: unknown, init?: RequestInit) => {
                bodies.push(init!.body as Uint8Array);
                return new Response(frames().join(''), { headers: { 'content-type': 'text/event-stream' } });
            }) as unknown as typeof fetch, () => Response.json(catalog(advertised)));
            host.models()[0]!.maxInputTokens = configured;
            const provider = new EZiLModelsProvider(host);
            const infos = await provider.provideLanguageModelChatInformation({} as never, token() as never);
            expect(infos[0]!.maxInputTokens).toBe(32768 - 1056 - 1536 - 24000);
            const send = (text: string) => provider.provideLanguageModelChatResponse(infos[0]!, [message(1, [new TextPart(text)])] as never,
                { tools: [], modelOptions: {} } as never, { report: () => {} }, token() as never);
            await send('字'.repeat(10000));
            expect(bodies[0]!.byteLength + 1056).toBeLessThanOrEqual(32768);
            await expect(send('字'.repeat(11000))).rejects.toThrow('Conversation too large');
            expect(bodies).toHaveLength(1); expect(host.models()[0]!.maxInputTokens).toBe(configured);
        });
    }
    for (const [status, code] of [[400, 'max_output_tokens_invalid'], [413, 'input_too_large']] as const) {
        test(`${status} ${code} clears cached limits for the next call without retrying`, async () => {
            let gets = 0;
            const bodies: Record<string, unknown>[] = [];
            const host = gatewayHost((async (_url: unknown, init?: RequestInit) => {
                bodies.push(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)));
                if (bodies.length === 1) return Response.json({ error: { code } }, { status });
                return new Response(frames().join(''), { headers: { 'content-type': 'text/event-stream' } });
            }) as unknown as typeof fetch, () => { gets++; return Response.json(gets === 1 ? catalog() : catalog(32768, 4096)); });
            const provider = new EZiLModelsProvider(host);
            const infos = await provider.provideLanguageModelChatInformation({} as never, token() as never);
            expect(infos[0]).toMatchObject({ maxInputTokens: 104480, maxOutputTokens: 8192 });
            const send = (text = 'q') => provider.provideLanguageModelChatResponse(infos[0]!, [message(1, [new TextPart(text)])] as never,
                { tools: [], modelOptions: {} } as never, { report: () => {} }, token() as never);
            await expect(send()).rejects.toThrow(code === 'input_too_large' ? 'Conversation too large' : code);
            expect(bodies).toHaveLength(1); expect(gets).toBe(1);
            await send(); // Still passes the old VS Code information object.
            expect(bodies.map(body => body.max_tokens)).toEqual([8192, 4096]); expect(gets).toBe(2);
            const refreshed = await provider.provideLanguageModelChatInformation({} as never, token() as never);
            expect(refreshed[0]).toMatchObject({ maxInputTokens: 6176, maxOutputTokens: 4096 });
            await expect(send('字'.repeat(11000))).rejects.toThrow('Conversation too large');
            expect(bodies).toHaveLength(2); expect(gets).toBe(2);
        });
    }
    test('recoverable gateway failure ends the turn and Retry resubmits only on user action', async () => {
        showRetryError.mockClear(); retryCommand.mockClear();
        showRetryError.mockImplementationOnce(async () => 'Retry');
        let posts = 0;
        const host = gatewayHost((async () => { posts++; return Response.json({ error: { code: 'os_ai_unavailable' } }, { status: 504 }); }) as unknown as typeof fetch);
        const provider = new EZiLModelsProvider(host);
        await expect(provider.provideLanguageModelChatResponse(toInformation(host.models()[0]!), [message(1, [new TextPart('q')])] as never,
            { tools: [], modelOptions: {} } as never, { report: () => {} }, token() as never)).rejects.toThrow('Retry');
        for (let i = 0; i < 10; i++) await Promise.resolve();
        expect(showRetryError).toHaveBeenCalledWith(expect.stringContaining('could not reach'), 'Retry');
        expect(retryCommand).toHaveBeenCalledWith('workbench.action.chat.retry');
        expect(posts).toBe(1);
    });
    test('gateway issuer refusal terminates without refresh polling or a retry notification', async () => {
        showRetryError.mockClear();
        let posts = 0;
        const host = gatewayHost((async () => { posts++; return Response.json({ error: { code: 'unauthorized', reason: 'wrong_issuer' } }, { status: 401 }); }) as unknown as typeof fetch);
        const provider = new EZiLModelsProvider(host);
        await expect(provider.provideLanguageModelChatResponse(toInformation(host.models()[0]!), [message(1, [new TextPart('q')])] as never,
            { tools: [], modelOptions: {} } as never, { report: () => {} }, token() as never)).rejects.toThrow('this OS environment is not connected');
        expect(posts).toBe(1); expect(showRetryError).not.toHaveBeenCalled();
    });
    test('exhausted window reaches chat without retry action and refreshes status after refusal', async () => {
        showRetryError.mockClear(); retryCommand.mockClear();
        let posts = 0;
        const host = gatewayHost((async () => { posts++; return Response.json({ error: { code: 'window_budget_reached' } },
            { status: 429, headers: { 'retry-after': '7200' } }); }) as unknown as typeof fetch);
        const requestFinished = mock((_model: ResolvedModel) => {});
        const provider = new EZiLModelsProvider({ ...host, requestFinished });
        await expect(provider.provideLanguageModelChatResponse(toInformation(host.models()[0]!), [message(1, [new TextPart('q')])] as never,
            { tools: [], modelOptions: {} } as never, { report: () => {} }, token() as never)).rejects.toThrow("This window's EZiL AI credits are used up. Resets at");
        expect(posts).toBe(1);
        expect(showRetryError).not.toHaveBeenCalled();
        expect(retryCommand).not.toHaveBeenCalled();
        expect(host.usage).toHaveLength(0);
        expect(requestFinished).toHaveBeenCalledTimes(1);
        expect(requestFinished.mock.calls[0]![0].provider.type).toBe('ezil-gateway');
    });
    for (const mode of ['stream', 'json', 'interrupted', 'cancelled'] as const) test(`refresh hook runs once after ${mode} chat finishes`, async () => {
        const host = gatewayHost((async () => mode === 'json' ? Response.json(messageJson())
            : new Response((mode === 'interrupted' ? frames().slice(0, -1) : frames()).join(''), { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch);
        const requestFinished = mock((_model: ResolvedModel) => {});
        const provider = new EZiLModelsProvider({ ...host, recordUsage: (model, usage) => {
            expect(requestFinished).not.toHaveBeenCalled(); host.recordUsage(model, usage);
        }, requestFinished });
        const cancel = token();
        const send = provider.provideLanguageModelChatResponse(toInformation(host.models()[mode === 'json' ? 1 : 0]!),
            [message(1, [new TextPart('q')])] as never, { tools: [], modelOptions: {} } as never,
            { report: () => { expect(requestFinished).not.toHaveBeenCalled(); if (mode === 'cancelled') cancel.cancel(); } }, cancel as never);
        if (mode === 'interrupted') await expect(send).rejects.toThrow('interrupted');
        else await send;
        expect(requestFinished).toHaveBeenCalledTimes(1);
        expect(host.usage).toHaveLength(mode === 'cancelled' || mode === 'interrupted' ? 0 : 1);
    });
    test('Kimi reports JSON parts in order and never logs bodies even with logRequests enabled', async () => {
        const host = gatewayHost((async () => Response.json(messageJson(), { headers: { 'x-ezil-request-id': 'bridge-json' } })) as unknown as typeof fetch);
        const provider = new EZiLModelsProvider(host); const parts: unknown[] = [];
        await provider.provideLanguageModelChatResponse(toInformation(host.models()[1]!), [message(1, [new TextPart('private question')])] as never,
            { tools: [], modelOptions: {} } as never, { report: p => parts.push(p) }, token() as never);
        expect(parts.map(p => (p as object).constructor)).toEqual([TextPart, ThinkingPart, ToolCallPart, TextPart]);
        expect(host.lines).toHaveLength(1); expect(host.lines[0]).not.toMatch(/private question|reasoning|synthetic-proxy-token/);
        expect(host.usage).toHaveLength(1);
    });
    test('Qwen serves explicit title/summary/progress utility roles even with Kimi selected', async () => {
        const bodies: Record<string, unknown>[] = [];
        const host = gatewayHost((async (_url: unknown, init?: RequestInit) => {
            bodies.push(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)));
            return new Response(frames().join(''), { headers: { 'content-type': 'text/event-stream' } });
        }) as unknown as typeof fetch, () => Response.json(catalog(131072, 2048)));
        const provider = new EZiLModelsProvider(host);
        for (const requestInitiator of ['title', 'copilot.summary', 'progress', 'utilitySmall']) {
            await provider.provideLanguageModelChatResponse(toInformation(host.models()[1]!), [message(1, [new TextPart('q')])] as never,
                { tools: [], modelOptions: { requestInitiator } } as never, { report: () => {} }, token() as never);
        }
        expect(bodies.every(b => b.model === gw().model && b.stream === true)).toBe(true);
        expect(bodies.map(b => b.max_tokens)).toEqual([2048, 2048, 2048, 2048]);
    });
    test('cancellation before catalog lookup makes no requests', async () => {
        let gets = 0; let posts = 0;
        const host = gatewayHost((async () => { posts++; throw new Error('unexpected POST'); }) as unknown as typeof fetch,
            () => { gets++; return Response.json(catalog()); });
        const provider = new EZiLModelsProvider(host);
        const cancel = token(); cancel.cancel();
        await provider.provideLanguageModelChatResponse(toInformation(host.models()[0]!), [message(1, [new TextPart('q')])] as never,
            { tools: [], modelOptions: {} } as never, { report: () => { throw new Error('unexpected response'); } }, cancel as never);
        expect(gets).toBe(0); expect(posts).toBe(0);
    });
    test('cancellation after first streamed text suppresses all further parts and usage', async () => {
        const cancel = token(); let wireCancelled = false;
        const host = gatewayHost((async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(frames().slice(0, 3).join(''))); }, cancel() { wireCancelled = true; } }),
            { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': 'cancel-mid' } })) as unknown as typeof fetch);
        const provider = new EZiLModelsProvider(host); const parts: unknown[] = [];
        await provider.provideLanguageModelChatResponse(toInformation(host.models()[0]!), [message(1, [new TextPart('q')])] as never,
            { tools: [], modelOptions: {} } as never, { report: p => { parts.push(p); cancel.cancel(); } }, cancel as never);
        expect(parts).toHaveLength(1); expect(host.usage).toHaveLength(0); expect(wireCancelled).toBe(true);
        expect(host.lines.join()).toContain('cancelled; may still be charged (request cancel-mid)');
    });
    test('Kimi thinking is skipped if the proposed API is absent', async () => {
        mock.module('vscode', () => ({ ...fakeVscode, LanguageModelThinkingPart: undefined }));
        try {
            const path = '../src/provider?gateway-no-thinking';
            const { EZiLModelsProvider: Without } = await import(path) as typeof providerModule;
            const host = gatewayHost((async () => Response.json(messageJson())) as unknown as typeof fetch);
            const provider = new Without(host); const parts: unknown[] = [];
            await provider.provideLanguageModelChatResponse(toInformation(host.models()[1]!), [message(1, [new TextPart('q')])] as never,
                { tools: [], modelOptions: {} } as never, { report: p => parts.push(p) }, token() as never);
            expect(parts.map(p => (p as object).constructor)).toEqual([TextPart, ToolCallPart, TextPart]);
        } finally { mock.module('vscode', () => fakeVscode); }
    });
});

describe('Gateway Responses VS Code bridge', () => {
    beforeEach(() => { forgetGatewayModels(); showRetryError.mockClear(); retryCommand.mockClear(); });

    const textOutput = (text: string) => ({ type: 'message' as const, id: 'msg_1', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }] });
    const callOutput = (args = '{"filePath":"hello.txt","content":"hi"}') => ({ type: 'function_call' as const, id: 'fc_1',
        call_id: 'call_1', name: 'create_file', arguments: args, status: 'completed' });
    const completed = (output: unknown[]) => ({ object: 'response', id: 'resp_1', status: 'completed', output,
        usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 7 }, output_tokens_details: { reasoning_tokens: 0 } } });
    const frame = (type: string, fields: Record<string, unknown>) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
    function streamFrames(output: ReturnType<typeof textOutput> | ReturnType<typeof callOutput>) {
        const initial = output.type === 'message' ? { ...output, status: 'in_progress', content: [] }
            : { ...output, status: 'in_progress', arguments: '' };
        return [frame('response.created', { response: { object: 'response', id: 'resp_1', status: 'in_progress', output: [] } }),
            frame('response.output_item.added', { output_index: 0, item: initial }),
            ...(output.type === 'message' ? [
                frame('response.content_part.added', { item_id: output.id, output_index: 0, content_index: 0,
                    part: { type: 'output_text', text: '', annotations: [] } }),
                frame('response.output_text.delta', { item_id: output.id, output_index: 0, content_index: 0, delta: output.content[0]!.text }),
                frame('response.output_text.done', { item_id: output.id, output_index: 0, content_index: 0, text: output.content[0]!.text }),
                frame('response.content_part.done', { item_id: output.id, output_index: 0, content_index: 0, part: output.content[0] }),
            ] : [
                frame('response.function_call_arguments.delta', { item_id: output.id, output_index: 0, delta: output.arguments.slice(0, 12) }),
                frame('response.function_call_arguments.delta', { item_id: output.id, output_index: 0, delta: output.arguments.slice(12) }),
                frame('response.function_call_arguments.done', { item_id: output.id, output_index: 0, arguments: output.arguments }),
            ]),
            frame('response.output_item.done', { output_index: 0, item: output }),
            frame('response.completed', { response: completed([output]) })];
    }
    function responsesHost(reply: (body: Record<string, unknown>, index: number) => Response, stream = true,
        catalogValue: unknown = { data: [{ id: 'reviewed-azure', enabled: true, max_input_tokens: 131072, max_output_tokens: 4096, protocols: ['openai-responses'] }] }) {
        const model = { ...gw('reviewed-azure'), gatewayProtocol: 'openai-responses' as const, stream };
        const models: ResolvedModel[] = [model];
        const requests: { url: string; init: RequestInit; body: Record<string, unknown> }[] = [];
        const reads: { url: string; init: RequestInit }[] = [];
        const lines: string[] = []; const usage: Usage[] = [];
        const requestFinished = mock((_model: ResolvedModel) => {});
        return { models: () => models, configError: () => undefined, secrets: () => ['synthetic-proxy-token'], logRequests: () => true,
            log: (line: string) => lines.push(line), recordUsage: (_model: ResolvedModel, value: Usage) => usage.push(value), requestFinished,
            fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
                init.signal?.throwIfAborted();
                const url = String(input);
                if (url.endsWith('/models')) { reads.push({ url, init }); return Response.json(catalogValue); }
                const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
                requests.push({ url, init, body });
                return reply(body, requests.length - 1);
            }) as typeof fetch,
            requests, reads, lines, usage };
    }
    const streamResponse = (wire: string[]) => new Response(wire.join(''), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': 'response-request' } });
    async function sendResponses(host: ReturnType<typeof responsesHost>, messages: unknown[], tools: unknown[] = [],
        report: (part: unknown) => void = () => {}, cancellation = token(), modelOptions = {}) {
        const provider = new EZiLModelsProvider(host);
        await provider.provideLanguageModelChatResponse(toInformation(host.models()[0]!), messages as never,
            { tools, modelOptions } as never, { report }, cancellation as never);
    }

    for (const catalogValue of [undefined, {}, { data: [] },
        { data: [{ id: 'reviewed-azure', enabled: true, max_input_tokens: 131072, max_output_tokens: 4096 }] },
        { data: [{ id: 'reviewed-azure', enabled: true, max_input_tokens: 131072, max_output_tokens: 4096, protocols: ['anthropic-messages'] }] },
        { data: [{ id: 'reviewed-azure', enabled: false, max_input_tokens: 131072, max_output_tokens: 4096, protocols: ['openai-responses'] }] },
    ]) test(`Responses model requires enabled advertised protocol: ${JSON.stringify(catalogValue)}`, async () => {
        const host = responsesHost(() => { throw new Error('unexpected inference'); }, true, catalogValue ?? null);
        const provider = new EZiLModelsProvider(host);
        expect(await provider.provideLanguageModelChatInformation({} as never, token() as never)).toEqual([]);
        await expect(sendResponses(host, [message(1, [new TextPart('q')])])).rejects.toThrow('not available');
        expect(host.requests).toHaveLength(0);
        expect(host.requestFinished).toHaveBeenCalledTimes(1);
    });

    test('protocol is not inferred from an Azure alias or a Responses-only catalog advertisement', async () => {
        const host = responsesHost(() => { throw new Error('unexpected inference'); });
        delete host.models()[0]!.gatewayProtocol;
        const provider = new EZiLModelsProvider(host);
        expect(await provider.provideLanguageModelChatInformation({} as never, token() as never)).toEqual([]);
        await expect(sendResponses(host, [message(1, [new TextPart('q')])])).rejects.toThrow('not available');
        expect(host.requests).toHaveLength(0);
    });

    for (const stream of [false, true]) test(`${stream ? 'SSE' : 'JSON'} tool-call round trip uses flat function tools and one operation per turn`, async () => {
        const host = responsesHost((_body, index) => stream ? streamResponse(streamFrames(index ? textOutput('Created hello.txt.') : callOutput()))
            : Response.json(completed([index ? textOutput('Created hello.txt.') : callOutput()])), stream);
        const provider = new EZiLModelsProvider(host);
        const infos = await provider.provideLanguageModelChatInformation({} as never, token() as never);
        expect(infos[0]).toMatchObject({ id: 'reviewed-azure', maxOutputTokens: 4096, capabilities: { imageInput: false } });
        const parts: unknown[] = [];
        const first = message(1, [new TextPart('Create hello.txt containing hi')]);
        await sendResponses(host, [message(3, [new TextPart('You write files.')]), first], [CREATE_FILE], part => parts.push(part));
        expect(parts).toEqual([new ToolCallPart('call_1', 'create_file', { filePath: 'hello.txt', content: 'hi' })]);
        const call = parts[0] as ToolCallPart;
        parts.length = 0;
        await sendResponses(host, [first, message(2, [call]), message(1, [new ToolResultPart(call.callId, [new TextPart('File created')])])],
            [CREATE_FILE], part => parts.push(part));
        expect(parts).toEqual([new TextPart('Created hello.txt.')]);
        expect(host.requests).toHaveLength(2);
        const [request1, request2] = host.requests;
        expect(request1!.url).toBe('https://proxy.invalid/ai/v1/responses');
        expect(request1!.body).toMatchObject({ model: 'reviewed-azure', stream, store: false, max_output_tokens: 4096,
            tools: [{ type: 'function', name: CREATE_FILE.name, description: CREATE_FILE.description, parameters: CREATE_FILE.inputSchema }] });
        expect(request2!.body.input).toEqual(expect.arrayContaining([
            { type: 'function_call', call_id: call.callId, name: call.name, arguments: JSON.stringify(call.input) },
            { type: 'function_call_output', call_id: call.callId, output: 'File created' },
        ]));
        expect(new Headers(request1!.init.headers).get('authorization')).toBe('Bearer synthetic-proxy-token');
        expect(new Headers(request1!.init.headers).get('idempotency-key')).not.toBe(new Headers(request2!.init.headers).get('idempotency-key'));
        expect(host.reads).toHaveLength(1);
        expect(new Headers(host.reads[0]!.init.headers).get('authorization')).toBe('Bearer synthetic-proxy-token');
        expect(host.usage).toEqual(Array(2).fill({ inputTokens: 100, outputTokens: 12, cacheReadTokens: 7, cacheWriteTokens: 0 }));
        expect(host.requestFinished).toHaveBeenCalledTimes(2);
        expect(host.lines.join()).not.toMatch(/Create hello|File created|synthetic-proxy-token/);
    });

    test('text without tools is emitted once; explicit Responses utility stays on its selected model', async () => {
        const host = responsesHost(() => streamResponse(streamFrames(textOutput('A title'))));
        host.models().push({ ...gw(), provider: host.models()[0]!.provider });
        const parts: unknown[] = [];
        await sendResponses(host, [message(1, [new TextPart('Summarize this')])], [], part => parts.push(part), token(), { requestInitiator: 'title' });
        expect(parts).toEqual([new TextPart('A title')]);
        expect(host.requests).toHaveLength(1);
        expect(host.requests[0]!.body.model).toBe('reviewed-azure');
        expect(host.requests[0]!.body.tools).toBeUndefined();
        expect(host.requests[0]!.body).not.toHaveProperty('messages');
    });

    for (const mimeType of ['image/png', 'application/pdf', 'audio/wav']) test(`refuses ${mimeType} before sending a Responses operation`, async () => {
        const host = responsesHost(() => { throw new Error('unexpected inference'); });
        await expect(sendResponses(host, [message(1, [new TextPart('Inspect this'), new DataPart(new Uint8Array([1, 2]), mimeType)])])).rejects.toThrow();
        expect(host.requests).toHaveLength(0); expect(host.usage).toHaveLength(0);
    });

    test('terminal incomplete preserves partial output and usage while ending as truncation without retry', async () => {
        const output = textOutput('Partial answer');
        const wire = streamFrames(output);
        wire[wire.length - 1] = frame('response.incomplete', { response: { ...completed([output]), status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } });
        const host = responsesHost(() => streamResponse(wire)); const parts: unknown[] = [];
        await expect(sendResponses(host, [message(1, [new TextPart('q')])], [], part => parts.push(part))).rejects.toThrow('truncated');
        expect(parts).toEqual([new TextPart('Partial answer')]);
        expect(host.usage).toHaveLength(1); expect(host.requests).toHaveLength(1);
        expect(host.requestFinished).toHaveBeenCalledTimes(1); expect(retryCommand).not.toHaveBeenCalled();
    });

    for (const ending of ['eof', 'missing-usage', 'failed', 'malformed'] as const) test(`${ending} never turns partial output into success or retries inference`, async () => {
        const output = textOutput('Partial answer');
        const wire = streamFrames(output);
        wire.pop();
        if (ending === 'missing-usage') wire.push(frame('response.completed', { response: { ...completed([output]), usage: null } }));
        if (ending === 'failed') wire.push(frame('response.failed', { response: { ...completed([output]), status: 'failed', error: { code: 'server_error', message: 'never display provider detail' } } }));
        if (ending === 'malformed') wire.push('event: response.completed\ndata: {\n\n');
        const host = responsesHost(() => streamResponse(wire)); const parts: unknown[] = [];
        const failure = await sendResponses(host, [message(1, [new TextPart('q')])], [], part => parts.push(part)).then(() => undefined, error => error as Error);
        expect(failure).toBeInstanceOf(Error); expect(failure!.message).not.toContain('never display provider detail');
        expect(parts).toEqual([new TextPart('Partial answer')]);
        expect(host.usage).toHaveLength(ending === 'failed' ? 1 : 0); expect(host.requests).toHaveLength(1);
        expect(host.requestFinished).toHaveBeenCalledTimes(1); expect(retryCommand).not.toHaveBeenCalled();
    });

    test('cancelling after the first text aborts the body and reports no later usage or tool call', async () => {
        const cancellation = token(); let wireCancelled = false;
        const wire = streamFrames(textOutput('Partial answer'));
        const host = responsesHost(() => new Response(new ReadableStream({
            start(controller) { controller.enqueue(new TextEncoder().encode(wire.slice(0, 4).join(''))); },
            cancel() { wireCancelled = true; },
        }), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': 'cancel-responses' } }));
        const parts: unknown[] = [];
        await sendResponses(host, [message(1, [new TextPart('q')])], [], part => { parts.push(part); cancellation.cancel(); }, cancellation);
        expect(parts).toEqual([new TextPart('Partial answer')]);
        expect(wireCancelled).toBe(true); expect(host.usage).toHaveLength(0); expect(host.requests).toHaveLength(1);
        expect(host.requestFinished).toHaveBeenCalledTimes(1); expect(host.lines.join()).toContain('cancelled; may still be charged');
    });
});
