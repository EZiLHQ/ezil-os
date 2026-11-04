// The picker as the Gateway catalog fills it (founder request 920, journey-920-20261104-editor-eligible-model-catalog-v1):
// the models configured in the image's models.json, plus each row the Gateway marks `available` for this caller over a
// protocol this client speaks (Gateway docs/CATALOG-CONSUMER-CONTRACT.md §2, `ezil.gateway.models.v1`). Zero inference:
// every response is a fixture, and the `synthetic-*` aliases name no real model or route.
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseModelsConfig, type ResolvedConfig } from '../src/config';
import { CATALOG_STALE_MS, forgetGatewayModels, gatewayModels } from '../src/gateway';
import { KIMI, QWEN } from '../src/gateway-messages';
import { readAIStatus, statusView } from '../src/status-data';
import { fakeVscode, TextPart, ThinkingPart, ToolCallPart, ToolResultPart } from './fixtures/fake-vscode';

mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider } = await import('../src/provider');
const { frames, messageJson } = await import('./fixtures/gateway-response');

const BASE = 'https://computer.test/ai/v1';
const load = (token = 'synthetic-proxy-token') => parseModelsConfig(readFileSync(`${import.meta.dir}/../../../worker/ezil-models/models.json`, 'utf8'),
    { env: { EZIL_AI_BASE_URL: BASE, EZIL_AI_PROXY_TOKEN: token } });

type Row = Record<string, unknown>;
// Shaped like live e9a3e2d rows (`...models_list()` spread with per-caller `protocols`), plus the v1 fields when given.
const row = (id: string, state?: string, extra: Row = {}): Row => ({ id, object: 'model', owned_by: 'ezil', alias: id,
    upstream_model: 'synthetic-upstream', enabled: true, max_input_tokens: 100_000, max_output_tokens: 32_000,
    pricing: { pricing_id: 'synthetic-pricing' }, protocols: ['anthropic-messages'],
    ...state ? { availability: { state, reasons: [] } } : {}, ...extra });
const unavailable = (id: string, ...reasons: string[]) => row(id, 'unavailable', { availability: { state: 'unavailable', reasons } });
const v1 = (data: Row[], over: Row = {}) => ({ object: 'list', contract: 'ezil.gateway.models.v1', catalog_ttl_seconds: 10, killswitch: false, pause: null, data, ...over });
const legacy = (data: Row[]) => ({ object: 'list', killswitch: false, pause: null, data });

type Sent = { url: string; accept: string | null; body: Record<string, unknown> };
function gateway(config: ResolvedConfig, catalog: (token: string) => Response, answer: (body: Record<string, unknown>) => Response = defaultAnswer) {
    const posts: Sent[] = []; const gets: string[] = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        init.signal?.throwIfAborted();
        const headers = new Headers(init.headers);
        const token = headers.get('authorization')?.replace('Bearer ', '') ?? '';
        if (String(input).endsWith('/models')) { gets.push(token); return catalog(token); }
        const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
        posts.push({ url: String(input), accept: headers.get('accept'), body });
        return answer(body);
    }) as typeof globalThis.fetch;
    const host = { models: () => config.models, configError: () => undefined, secrets: () => config.secrets, logRequests: () => false,
        log: () => {}, recordUsage: () => {}, fetch, requestFinished: () => {} };
    const provider = new EZiLModelsProvider(host);
    let changes = 0;
    provider.onDidChangeLanguageModelChatInformation(() => { changes++; });
    host.requestFinished = () => provider.refreshIfCatalogChanged(); // as extension.ts wires it
    return { provider, posts, gets, fetch, changes: () => changes };
}
function defaultAnswer(body: Record<string, unknown>): Response {
    return body.stream ? new Response(frames('end_turn').join(''), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(messageJson());
}
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
const list = (provider: InstanceType<typeof EZiLModelsProvider>) => provider.provideLanguageModelChatInformation({} as never, token() as never);
const message = (role: number, content: unknown[]) => ({ role, content });
const READ_FILE = { name: 'read_file', description: 'Read a file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } };
function send(provider: InstanceType<typeof EZiLModelsProvider>, info: { id: string }, messages: unknown[] = [message(1, [new TextPart('q')])], tools: unknown[] = []) {
    return provider.provideLanguageModelChatResponse(info as never, messages as never, { tools, modelOptions: {} } as never, { report: () => {} }, token() as never);
}
const ids = (infos: { id: string }[]) => infos.map(info => info.id);

beforeEach(() => forgetGatewayModels());

describe('the picker lists what the Gateway says this caller can use', () => {
    test('the deployed e9a3e2d shape (no availability) lists exactly the two configured models, as before', async () => {
        const g = gateway(load(), () => Response.json(legacy([row(QWEN), row(KIMI), row('synthetic-chat-a'), row('ezil-code', undefined, { enabled: false, protocols: [] })])));
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI]);
    });

    test('a v1 catalog adds each available row once, by alias; configured models keep their own settings', async () => {
        const g = gateway(load(), () => Response.json(v1([
            row(QWEN, 'available'), row(KIMI, 'available'),
            row('synthetic-chat-a', 'available', { name: '  Synthetic Chat A ' }), row('synthetic-chat-b', 'available'),
            unavailable('synthetic-off', 'model_disabled'), unavailable('synthetic-unpriced', 'no_active_pricing'),
            unavailable('synthetic-key-excluded', 'not_allowed_for_caller'), row('synthetic-unknown', 'unknown'),
            row('synthetic-future', 'available', { protocols: ['openai-chat-v9'] }), row('synthetic-flag-off', 'available', { enabled: false }),
            row('Synthetic Bad Alias', 'available'), row('synthetic-new-state', 'available-soon'), row('synthetic-no-protocols', 'available', { protocols: undefined }),
        ])));
        const infos = await list(g.provider);
        expect(ids(infos)).toEqual([QWEN, KIMI, 'synthetic-chat-a', 'synthetic-chat-b']);
        expect(infos[0]).toMatchObject({ name: 'Qwen3 Coder Next', isDefault: true, capabilities: { toolCalling: true, imageInput: false } });
        expect(infos[1]).toMatchObject({ name: 'Kimi K3 (no streaming)', isDefault: false });
        expect(infos[2]).toEqual(expect.objectContaining({ id: 'synthetic-chat-a', name: 'Synthetic Chat A', family: 'synthetic-chat-a', isDefault: false,
            isUserSelectable: true, maxInputTokens: 100_000 - 1056 - 1536 - 8000, maxOutputTokens: 16_384, capabilities: { toolCalling: false, imageInput: false } }));
        expect(infos[3]!.name).toBe('synthetic-chat-b');
        // Prices and upstream ids are not contract and never reach the picker.
        expect(JSON.stringify(infos)).not.toMatch(/synthetic-upstream|synthetic-pricing/);
    });

    test('a display name with control or direction-override characters is not shown; the alias is', async () => {
        const g = gateway(load(), () => Response.json(v1([row('synthetic-chat-a', 'available', { name: 'Evil‮A' }), row('synthetic-chat-b', 'available', { name: 'x'.repeat(65) })])));
        expect((await list(g.provider)).slice(2).map(info => info.name)).toEqual(['synthetic-chat-a', 'synthetic-chat-b']);
    });

    test('a Responses-only available row is listed and sent over Responses, as JSON', async () => {
        const g = gateway(load(), () => Response.json(v1([row('synthetic-responses', 'available', { protocols: ['openai-responses'] })])), () => Response.json({
            object: 'response', id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
            output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] }] }));
        const infos = await list(g.provider);
        expect(ids(infos)).toEqual([QWEN, KIMI, 'synthetic-responses']);
        await send(g.provider, infos[2]!);
        expect(g.posts.map(post => [new URL(post.url).pathname, post.body.model, post.body.stream])).toEqual([['/ai/v1/responses', 'synthetic-responses', false]]);
    });
});

describe('capabilities: never more than the row says', () => {
    test('no capabilities: no tools, no images, no streaming; JSON from the first send, one request', async () => {
        const g = gateway(load(), () => Response.json(v1([row('synthetic-chat-a', 'available')])));
        const info = (await list(g.provider))[2]!;
        await send(g.provider, info);
        expect(g.posts).toHaveLength(1);
        expect(g.posts[0]).toMatchObject({ accept: 'application/json', body: { model: 'synthetic-chat-a', stream: false } });
        expect(g.posts[0]!.body.tools).toBeUndefined();
    });

    test('capabilities turn tools and streaming on for a catalog-only row (images never); Kimi stays JSON whatever its row says', async () => {
        const g = gateway(load(), () => Response.json(v1([row(KIMI, 'available', { capabilities: { streaming: true } }),
            row('synthetic-chat-a', 'available', { capabilities: { tool_calling: true, streaming: true, image_input: true, unknown_flag: true } })])));
        const infos = await list(g.provider);
        expect(infos[2]!.capabilities).toEqual({ toolCalling: true, imageInput: false });
        await send(g.provider, infos[2]!, undefined, [READ_FILE]);
        await send(g.provider, infos[1]!);
        expect(g.posts.map(post => [post.body.model, post.body.stream, post.accept])).toEqual([
            ['synthetic-chat-a', true, 'text/event-stream'], [KIMI, false, 'application/json']]);
        expect((g.posts[0]!.body.tools as { name: string }[]).map(tool => tool.name)).toEqual(['read_file']);
    });

    test('the catalog lowers a configured model: Qwen without streaming goes as JSON, and a tools request without tool calling is refused unsent', async () => {
        const config = load();
        const g = gateway(config, () => Response.json(v1([row(QWEN, 'available', { capabilities: { streaming: false, tool_calling: false } })])));
        const infos = await list(g.provider);
        expect(infos[0]).toMatchObject({ id: QWEN, capabilities: { toolCalling: false, imageInput: false } });
        await send(g.provider, infos[0]!);
        expect(g.posts.map(post => [post.body.model, post.body.stream, post.accept])).toEqual([[QWEN, false, 'application/json']]);
        await expect(send(g.provider, infos[0]!, undefined, [READ_FILE])).rejects.toThrow('cannot use tools, so it cannot run this request. Pick a model with tool support. Nothing was sent or charged.');
        expect(g.posts).toHaveLength(1);
        expect(g.changes()).toBe(1); // the picker hears it again
        expect(config.models.find(model => model.model === QWEN)).toMatchObject({ stream: true, capabilities: { toolCalling: true } }); // config untouched
    });

    test('a catalog cannot raise a configured model: Kimi stays JSON and caps stay at the image\'s values', async () => {
        const g = gateway(load(), () => Response.json(v1([row(KIMI, 'available', { max_output_tokens: 64_000, max_input_tokens: 1_000_000, capabilities: { streaming: true, image_input: true } })])));
        const kimi = (await list(g.provider))[1]!;
        expect(kimi).toMatchObject({ maxOutputTokens: 4096, capabilities: { imageInput: false } });
        await send(g.provider, kimi);
        expect(g.posts[0]!.body).toMatchObject({ model: KIMI, stream: false, max_tokens: 4096 });
    });
});

describe('refresh and model switching', () => {
    test('a still-available selection keeps its id; a refusal that removes it re-lists, and nothing else is sent in its place', async () => {
        let catalog = v1([row('synthetic-chat-a', 'available'), row('synthetic-chat-b', 'available')]);
        const g = gateway(load(), () => Response.json(catalog), body => body.model === 'synthetic-chat-a'
            ? Response.json({ error: { code: 'model_disabled', message: 'synthetic' } }, { status: 503 }) : defaultAnswer(body));
        const first = await list(g.provider);
        const selected = first.find(info => info.id === 'synthetic-chat-a')!;
        expect((await list(g.provider)).find(info => info.id === selected.id)).toEqual(selected);
        catalog = v1([unavailable('synthetic-chat-a', 'model_disabled'), row('synthetic-chat-b', 'available')]);
        await expect(send(g.provider, selected)).rejects.toThrow();
        expect(g.changes()).toBe(1);
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'synthetic-chat-b']);
        // VS Code may still hold the old entry: refused before sending, and never another model instead.
        await expect(send(g.provider, selected)).rejects.toThrow('EZiL Models: EZiL AI: This model is not available right now. Pick another model. Nothing was sent or charged.');
        expect(g.changes()).toBe(2);
        expect(g.posts.map(post => post.body.model)).toEqual(['synthetic-chat-a']);
    });

    test('switching models keeps the history: thinking is left out and tool pairs stay paired, the same for a catalog row and Qwen', async () => {
        const g = gateway(load(), () => Response.json(v1([row('synthetic-chat-a', 'available', { capabilities: { tool_calling: true, streaming: true } })])));
        const infos = await list(g.provider);
        const history = [
            message(1, [new TextPart('Read a.ts')]),
            message(2, [new ThinkingPart('private prior reasoning', 'th_1', { signature: 'sig' }), new TextPart('Reading it.'), new ToolCallPart('call_1', 'read_file', { path: 'a.ts' })]),
            message(1, [new ToolResultPart('call_1', [new TextPart('export const a = 1;')])]),
            message(2, [new TextPart('a is 1.')]),
            message(1, [new TextPart('And now?')]),
        ];
        await send(g.provider, infos[2]!, history, [READ_FILE]); // Qwen-era history, catalog model
        await send(g.provider, infos[0]!, history, [READ_FILE]); // and back to Qwen
        const [catalogBody, qwenBody] = g.posts.map(post => post.body);
        expect([catalogBody!.model, qwenBody!.model]).toEqual(['synthetic-chat-a', QWEN]);
        expect(catalogBody!.messages).toEqual(qwenBody!.messages);
        expect(JSON.stringify(catalogBody!.messages)).not.toContain('private prior reasoning');
        const turns = catalogBody!.messages as { role: string; content: { type: string; id?: string; tool_use_id?: string }[] }[];
        expect(turns[1]!.content.map(block => block.type)).toEqual(['text', 'tool_use']);
        expect(turns[2]!.content).toEqual([expect.objectContaining({ type: 'tool_result', tool_use_id: 'call_1' })]);
    });

    test('opening Show AI Status reads the list now: a failed read keeps the last one, a changed one re-lists', async () => {
        const config = load();
        let catalog: unknown = v1([row('synthetic-chat-a', 'available')]);
        const g = gateway(config, () => catalog === undefined ? Response.json({}, { status: 500 }) : Response.json(catalog));
        const opened = () => gatewayModels(config.models[0]!.provider, g.fetch, Date.now(), undefined, true).then(() => g.provider.refreshIfCatalogChanged());
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'synthetic-chat-a']);
        catalog = undefined;
        await opened();
        expect([g.gets.length, g.changes()]).toEqual([2, 0]);
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'synthetic-chat-a']);
        catalog = v1([row('synthetic-chat-a', 'available'), row('synthetic-chat-b', 'available')]);
        await opened();
        expect([g.gets.length, g.changes()]).toEqual([3, 1]);
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'synthetic-chat-a', 'synthetic-chat-b']);
    });

    test('a changed catalog read after a request re-lists once; an unchanged one does not', async () => {
        const now = spyOn(Date, 'now').mockReturnValue(1_000_000);
        try {
            let catalog = v1([row('synthetic-chat-a', 'available')]);
            const g = gateway(load(), () => Response.json(catalog));
            const qwen = (await list(g.provider))[0]!;
            await send(g.provider, qwen);
            expect([g.gets.length, g.changes()]).toEqual([1, 0]);
            catalog = v1([row('synthetic-chat-a', 'available'), row('synthetic-chat-b', 'available')]);
            now.mockReturnValue(1_000_000 + 5 * 60_000); // the five-minute cache has expired: the next turn reads it
            await send(g.provider, qwen);
            expect([g.gets.length, g.changes()]).toEqual([2, 1]);
            expect(ids(await list(g.provider))).toContain('synthetic-chat-b');
            await send(g.provider, qwen);
            expect(g.changes()).toBe(1);
        } finally { now.mockRestore(); }
    });
});

describe('catalog failure: unknown, never unavailable', () => {
    for (const failure of ['500', '403', 'network', 'not json'] as const) {
        test(`unreadable from the start (${failure}): configured models stay listed; a catalog row cannot be checked and nothing is sent`, async () => {
            const g = gateway(load(), () => {
                if (failure === 'network') throw new TypeError('fetch failed');
                return failure === 'not json' ? new Response('<html>', { status: 200 }) : Response.json({ error: { code: 'forbidden' } }, { status: Number(failure) });
            });
            expect(ids(await list(g.provider))).toEqual([QWEN, KIMI]);
            await expect(send(g.provider, { id: 'synthetic-chat-a' })).rejects.toThrow('Could not load the model list, so this model cannot be checked right now. Nothing was sent or charged.');
            expect(g.posts).toHaveLength(0);
        });
    }

    test('a failed re-read keeps the rows last listed for this token for 30 minutes, and the request decides', async () => {
        const now = spyOn(Date, 'now').mockReturnValue(2_000_000);
        try {
            let readable = true;
            const g = gateway(load(), () => readable ? Response.json(v1([row('synthetic-chat-a', 'available')])) : Response.json({}, { status: 500 }));
            const selected = (await list(g.provider))[2]!;
            readable = false;
            now.mockReturnValue(2_000_000 + 6 * 60_000);
            expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'synthetic-chat-a']);
            await send(g.provider, selected);
            expect(g.posts.map(post => [post.body.model, post.body.stream])).toEqual([['synthetic-chat-a', false]]);
            expect(g.changes()).toBe(0); // an outage does not re-list (and re-read) after every request
            now.mockReturnValue(2_000_000 + CATALOG_STALE_MS);
            expect(ids(await list(g.provider))).toEqual([QWEN, KIMI]);
            await expect(send(g.provider, selected)).rejects.toThrow('Could not load the model list');
            expect(g.posts).toHaveLength(1);
        } finally { now.mockRestore(); }
    });
});

describe('isolation: each token reads and keeps its own catalog', () => {
    test('two tokens on one base URL never see each other\'s rows, even from the stale fallback', async () => {
        const now = spyOn(Date, 'now').mockReturnValue(3_000_000);
        try {
            let readable = true;
            const catalog = (token: string) => !readable ? Response.json({}, { status: 500 })
                : Response.json(v1([row(token === 'token-a' ? 'synthetic-a-only' : 'synthetic-b-only', 'available')]));
            const a = gateway(load('token-a'), catalog);
            const b = gateway(load('token-b'), catalog);
            expect(ids(await list(a.provider))).toEqual([QWEN, KIMI, 'synthetic-a-only']);
            expect(ids(await list(b.provider))).toEqual([QWEN, KIMI, 'synthetic-b-only']);
            expect([a.gets, b.gets]).toEqual([['token-a'], ['token-b']]);
            readable = false;
            now.mockReturnValue(3_000_000 + 6 * 60_000);
            expect(ids(await list(b.provider))).toEqual([QWEN, KIMI, 'synthetic-b-only']);
            // B's own last catalog answers for B: A's row is not in it, so it is not available to B.
            await expect(send(b.provider, { id: 'synthetic-a-only' })).rejects.toThrow('This model is not available right now');
            expect([...a.posts, ...b.posts]).toHaveLength(0);
            expect([a.gets, b.gets]).toEqual([['token-a'], ['token-b', 'token-b', 'token-b']]);
        } finally { now.mockRestore(); }
    });
});

describe('Show AI Status: each row\'s availability, in the contract\'s words', () => {
    const status = (models: unknown) => readAIStatus(load().models[0]!.provider, (async (url: string) => {
        const path = new URL(url).pathname;
        if (path.endsWith('/me/balance')) return Response.json({ available_micro: 5_000_000, held_micro: 0 });
        if (path.endsWith('/me/usage')) return Response.json({ data: [] });
        if (path.endsWith('/me/limits')) return Response.json({ error: { code: 'forbidden' } }, { status: 403 });
        return Response.json(models);
    }) as unknown as typeof fetch).then(statusView);
    afterEach(() => forgetGatewayModels());

    test('available, not enabled, not included, unknown and unsupported rows each say so; prices and upstream ids never appear', async () => {
        const view = await status(v1([row('synthetic-chat-a', 'available', { name: 'Synthetic Chat A' }), unavailable('synthetic-off', 'model_disabled', 'no_active_pricing'),
            unavailable('synthetic-key-excluded', 'not_allowed_for_caller', 'future_reason'), unavailable('synthetic-no-route'), row('synthetic-unknown', 'unknown'),
            row('synthetic-future', 'available', { protocols: ['openai-chat-v9'] }), row(QWEN)]));
        const at = view.lines.indexOf('Models (the request still decides)');
        expect(view.lines.slice(at, at + 7)).toEqual(['Models (the request still decides)', 'Synthetic Chat A: Available', 'synthetic-off: Not enabled on this Gateway.',
            'synthetic-key-excluded: Not included for this access.', 'synthetic-no-route: Not available right now.',
            'synthetic-unknown: Availability unknown — retry.', 'synthetic-future: Not supported in this editor.']);
        expect(view.lines.join('\n')).not.toMatch(/synthetic-upstream|synthetic-pricing/);
    });

    test('the deployed shape states no per-row availability, so no model lines are shown', async () => {
        const view = await status(legacy([row(QWEN), row(KIMI)]));
        expect(view.lines.some(line => line.startsWith('Models'))).toBe(false);
        expect(view.lines).toContain('Global AI pause: none reported.');
    });
});
