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

type Sent = { url: string; accept: string | null; token: string; body: Record<string, unknown> };
function gateway(config: ResolvedConfig, catalog: (token: string) => Response, answer: (body: Record<string, unknown>) => Response = defaultAnswer) {
    const posts: Sent[] = []; const gets: string[] = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        init.signal?.throwIfAborted();
        const headers = new Headers(init.headers);
        const token = headers.get('authorization')?.replace('Bearer ', '') ?? '';
        if (String(input).endsWith('/models')) { gets.push(token); return catalog(token); }
        const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
        posts.push({ url: String(input), accept: headers.get('accept'), token, body });
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
function send(provider: InstanceType<typeof EZiLModelsProvider>, info: { id: string; capabilities?: object }, messages: unknown[] = [message(1, [new TextPart('q')])], tools: unknown[] = [], modelOptions = {}) {
    return provider.provideLanguageModelChatResponse(info as never, messages as never, { tools, modelOptions } as never, { report: () => {} }, token() as never);
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
        expect(ids(infos)).toEqual([QWEN, KIMI, 'ezil/synthetic-chat-a', 'ezil/synthetic-chat-b']);
        expect(infos[0]).toMatchObject({ name: 'Qwen3 Coder Next', isDefault: true, capabilities: { toolCalling: true, imageInput: false } });
        expect(infos[1]).toMatchObject({ name: 'Kimi K3 (no streaming)', isDefault: false });
        expect(infos[2]).toEqual(expect.objectContaining({ id: 'ezil/synthetic-chat-a', name: 'Synthetic Chat A', family: 'synthetic-chat-a', isDefault: false,
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
        expect(ids(infos)).toEqual([QWEN, KIMI, 'ezil/synthetic-responses']);
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

    test('the catalog lowers a configured model: Qwen without streaming goes as JSON, and without tool calling never gets tools', async () => {
        const config = load();
        const g = gateway(config, () => Response.json(v1([row(QWEN, 'available', { capabilities: { streaming: false, tool_calling: false } })])));
        const infos = await list(g.provider);
        expect(infos[0]).toMatchObject({ id: QWEN, capabilities: { toolCalling: false, imageInput: false } });
        await send(g.provider, infos[0]!);
        expect(g.posts.map(post => [post.body.model, post.body.stream, post.accept])).toEqual([[QWEN, false, 'application/json']]);
        // Tools offered anyway (Ask mode, or an entry from before the change) are left out, as Copilot does for its own
        // endpoints without tool calls; an earlier tool call goes as text, its result too.
        const history = [message(1, [new TextPart('Read a.ts')]), message(2, [new ToolCallPart('call_1', 'read_file', { path: 'a.ts' })]),
            message(1, [new ToolResultPart('call_1', [new TextPart('export const a = 1;')])])];
        await send(g.provider, infos[0]!, history, [READ_FILE]);
        expect(g.posts[1]!.body.tools).toBeUndefined();
        expect(JSON.stringify(g.posts[1]!.body.messages)).not.toMatch(/"tool_use"|"tool_result"/);
        expect(JSON.stringify(g.posts[1]!.body.messages)).toContain('export const a = 1;');
        expect(g.changes()).toBe(0); // the picker already says so
        await send(g.provider, { ...infos[0]!, capabilities: { toolCalling: true, imageInput: false } }, undefined, [READ_FILE]);
        expect([g.posts.length, g.posts[2]!.body.tools, g.changes()]).toEqual([3, undefined, 1]); // an outdated entry is listed again
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
        const selected = first.find(info => info.id === 'ezil/synthetic-chat-a')!;
        expect((await list(g.provider)).find(info => info.id === selected.id)).toEqual(selected);
        catalog = v1([unavailable('synthetic-chat-a', 'model_disabled'), row('synthetic-chat-b', 'available')]);
        await expect(send(g.provider, selected)).rejects.toThrow();
        expect(g.changes()).toBe(1);
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'ezil/synthetic-chat-b']);
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
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'ezil/synthetic-chat-a']);
        catalog = undefined;
        await opened();
        expect([g.gets.length, g.changes()]).toEqual([2, 0]);
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'ezil/synthetic-chat-a']);
        catalog = v1([row('synthetic-chat-a', 'available'), row('synthetic-chat-b', 'available')]);
        await opened();
        expect([g.gets.length, g.changes()]).toEqual([3, 1]);
        expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'ezil/synthetic-chat-a', 'ezil/synthetic-chat-b']);
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
            expect(ids(await list(g.provider))).toContain('ezil/synthetic-chat-b');
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
            await expect(send(g.provider, { id: 'ezil/synthetic-chat-a' })).rejects.toThrow('Could not load the model list, so this model cannot be checked right now. Nothing was sent or charged.');
            expect(g.posts).toHaveLength(0);
        });
    }

    test('a failed re-read keeps listing the rows last read for this token for 30 minutes, but none is sent unchecked; configured models still go', async () => {
        const now = spyOn(Date, 'now').mockReturnValue(2_000_000);
        try {
            let readable = true;
            const g = gateway(load(), () => readable ? Response.json(v1([row('synthetic-chat-a', 'available')])) : Response.json({}, { status: 500 }));
            const [qwen, , selected] = await list(g.provider);
            readable = false;
            now.mockReturnValue(2_000_000 + 6 * 60_000);
            expect(ids(await list(g.provider))).toEqual([QWEN, KIMI, 'ezil/synthetic-chat-a']);
            // Contract §4: the last catalog lists only. The row cannot be checked, so it is not sent; Qwen goes and the request decides.
            await expect(send(g.provider, selected!)).rejects.toThrow('Could not load the model list, so this model cannot be checked right now. Nothing was sent or charged.');
            await send(g.provider, qwen!);
            expect(g.posts.map(post => post.body.model)).toEqual([QWEN]);
            expect(g.changes()).toBe(0); // an outage does not re-list (and re-read) after every request
            now.mockReturnValue(2_000_000 + CATALOG_STALE_MS);
            expect(ids(await list(g.provider))).toEqual([QWEN, KIMI]);
            readable = true; // once a read checks it again, it is sent
            await send(g.provider, selected!);
            expect(g.posts.map(post => [post.body.model, post.body.stream])).toEqual([[QWEN, true], ['synthetic-chat-a', false]]);
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
            expect(ids(await list(a.provider))).toEqual([QWEN, KIMI, 'ezil/synthetic-a-only']);
            expect(ids(await list(b.provider))).toEqual([QWEN, KIMI, 'ezil/synthetic-b-only']);
            expect([a.gets, b.gets]).toEqual([['token-a'], ['token-b']]);
            // B's own catalog answers for B: A's row is not in it, so it is not available to B.
            await expect(send(b.provider, { id: 'ezil/synthetic-a-only' })).rejects.toThrow('This model is not available right now');
            readable = false;
            now.mockReturnValue(3_000_000 + 6 * 60_000);
            expect(ids(await list(b.provider))).toEqual([QWEN, KIMI, 'ezil/synthetic-b-only']);
            // Nor from any last catalog: nothing unchecked is sent.
            await expect(send(b.provider, { id: 'ezil/synthetic-a-only' })).rejects.toThrow('Could not load the model list');
            expect([...a.posts, ...b.posts]).toHaveLength(0);
            expect([a.gets, b.gets]).toEqual([['token-a'], ['token-b', 'token-b', 'token-b']]);
        } finally { now.mockRestore(); }
    });
});

describe('two Gateway accounts in one config: a catalog row is always sent with its own account', () => {
    // Root review of 6be5138a: one provider object, two configured Gateway credentials, the same dynamic alias.
    const providers = { 'gw-a': { type: 'ezil-gateway', baseUrl: 'https://a.test/ai/v1', apiKey: 'synthetic-a' },
        'gw-b': { type: 'ezil-gateway', baseUrl: 'https://b.test/ai/v1', apiKey: 'synthetic-b' } };
    function accounts(order: 'a-first' | 'b-first', extra: Row[] = [], qwenB = true) {
        const models: Row[] = [{ id: 'qwen-a', provider: 'gw-a', model: QWEN, default: true },
            qwenB ? { id: 'qwen-b', provider: 'gw-b', model: QWEN } : { id: 'kimi-b', provider: 'gw-b', model: KIMI }, ...extra];
        return parseModelsConfig(JSON.stringify(order === 'a-first' ? { providers, models }
            : { providers: { 'gw-b': providers['gw-b'], 'gw-a': providers['gw-a'] }, models: [...models].reverse() }));
    }
    const host = (post: Sent) => new URL(post.url).host;
    const shared = () => Response.json(v1([row('synthetic-shared', 'available')]));

    for (const order of ['a-first', 'b-first'] as const) {
        test(`the same alias from both accounts gets two picker ids, and B's is sent only to B (${order})`, async () => {
            const g = gateway(accounts(order), shared);
            const infos = await list(g.provider);
            expect(new Set(ids(infos)).size).toBe(infos.length);
            const a = infos.find(info => info.id === 'gw-a/synthetic-shared')!;
            const b = infos.find(info => info.id === 'gw-b/synthetic-shared')!;
            expect([a.detail, b.detail]).toEqual(['gw-a', 'gw-b']);
            await send(g.provider, b);
            expect(g.posts.map(post => [host(post), post.token, post.body.model])).toEqual([['b.test', 'synthetic-b', 'synthetic-shared']]);
            await send(g.provider, a);
            expect(g.posts.map(post => [host(post), post.token])).toEqual([['b.test', 'synthetic-b'], ['a.test', 'synthetic-a']]);
        });
    }

    test('B\'s row removed, or B\'s catalog unreadable: B\'s entry fails closed and A\'s same alias never answers for it', async () => {
        let bCatalog: () => Response = shared;
        const g = gateway(accounts('a-first'), token => token === 'synthetic-b' ? bCatalog() : shared());
        const b = (await list(g.provider)).find(info => info.id === 'gw-b/synthetic-shared')!;
        bCatalog = () => Response.json(v1([unavailable('synthetic-shared', 'model_disabled')]));
        forgetGatewayModels(); // the five minutes are up
        await expect(send(g.provider, b)).rejects.toThrow('This model is not available right now. Pick another model. Nothing was sent or charged.');
        bCatalog = () => Response.json({}, { status: 500 });
        forgetGatewayModels(); // and no last catalog for B either
        await expect(send(g.provider, b)).rejects.toThrow('Could not load the model list');
        expect(g.posts).toHaveLength(0);
        expect(ids(await list(g.provider))).toEqual(['qwen-a', 'qwen-b', 'gw-a/synthetic-shared']);
    });

    test('a model A configures with that alias hides only A\'s row; B\'s row stays B\'s', async () => {
        const g = gateway(accounts('a-first', [{ id: 'shared-a', provider: 'gw-a', model: 'synthetic-shared' }]), shared);
        expect(ids(await list(g.provider))).toEqual(['qwen-a', 'qwen-b', 'shared-a', 'gw-b/synthetic-shared']);
        await send(g.provider, { id: 'gw-b/synthetic-shared' });
        await send(g.provider, { id: 'shared-a' });
        expect(g.posts.map(post => [host(post), post.token, post.body.model])).toEqual([
            ['b.test', 'synthetic-b', 'synthetic-shared'], ['a.test', 'synthetic-a', 'synthetic-shared']]);
    });

    for (const id of ['synthetic-shared', 'gw-c/synthetic-shared', 'gw-b/synthetic-shared/x', '/synthetic-shared', 'gw-b/Synthetic Shared']) {
        test(`an id that does not name exactly one configured account fails closed, with no request: ${id}`, async () => {
            const g = gateway(accounts('a-first'), shared);
            await list(g.provider);
            await expect(send(g.provider, { id })).rejects.toThrow(`EZiL Models: model "${id}" is no longer in the config file. Pick another model.`);
            expect(g.posts).toHaveLength(0);
        });
    }

    test('a utility request on B\'s row goes to B\'s Qwen, or stays on B\'s row without one; never to A', async () => {
        for (const qwenB of [true, false]) {
            forgetGatewayModels();
            const g = gateway(accounts('a-first', [], qwenB), shared);
            await list(g.provider);
            await send(g.provider, { id: 'gw-b/synthetic-shared' }, undefined, [], { requestInitiator: 'title' });
            expect(g.posts.map(post => [host(post), post.token, post.body.model])).toEqual([['b.test', 'synthetic-b', qwenB ? QWEN : 'synthetic-shared']]);
        }
    });
});

describe('the frozen v1 contract as the Gateway serves it (CATALOG-3 1af1db9)', () => {
    // c3's five served responses (EZiL-AI-Gateway.handoffs/920-catalog-v1/models-responses.json, sha256 816cb92d…), verbatim.
    const SERVED = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/gateway-catalog-v1-served.json`, 'utf8')) as Record<string, Row>;
    const ROUTED = ['ezil/claude-haiku-5-5', 'ezil/claude-sonnet-5-5', 'ezil/ezil-code', 'ezil/ezil-fast'];
    const expected: Record<string, string[]> = { member_no_paywall: [QWEN, KIMI, ...ROUTED], member_paywall_no_plan: [],
        member_paywall_with_plan: [QWEN, KIMI, ...ROUTED], operator: [QWEN, KIMI, ...ROUTED], member_allowed_models_qwen_only: [QWEN] };
    const withoutContract = (body: Row, contract?: string) => { const { contract: _, ...rest } = body; return contract ? { ...rest, contract } : rest; };

    test('each caller view lists exactly the rows it marks available; names only from the row, prices never', async () => {
        expect(Object.keys(SERVED).sort()).toEqual(Object.keys(expected).sort());
        for (const [view, body] of Object.entries(SERVED)) {
            forgetGatewayModels();
            const infos = await list(gateway(load(), () => Response.json(body)).provider);
            expect([view, ids(infos)]).toEqual([view, expected[view]!]);
            expect(JSON.stringify(infos)).not.toMatch(/pricing|markup|usd_micro|upstream/);
        }
        forgetGatewayModels();
        const infos = await list(gateway(load(), () => Response.json(SERVED.member_no_paywall)).provider);
        expect(infos.slice(2).map(info => [info.name, info.capabilities.toolCalling])).toEqual([
            ['claude-haiku-5-5', true], ['Claude Sonnet 5.5', true], ['ezil-code', true], ['ezil-fast', true]]);
    });

    test('served rows: Sonnet streams with tools over Messages; Kimi goes as JSON; no images anywhere', async () => {
        const g = gateway(load(), () => Response.json(SERVED.member_no_paywall));
        const infos = await list(g.provider);
        expect(infos.every(info => info.capabilities.imageInput === false)).toBe(true);
        await send(g.provider, infos.find(info => info.id === 'ezil/claude-sonnet-5-5')!, undefined, [READ_FILE]);
        await send(g.provider, infos.find(info => info.id === KIMI)!, undefined, [READ_FILE]);
        expect(g.posts.map(post => [new URL(post.url).pathname, post.body.model, post.body.stream, (post.body.tools as unknown[] | undefined)?.length])).toEqual([
            ['/ai/v1/messages', 'claude-sonnet-5-5', true, 1], ['/ai/v1/messages', KIMI, false, 1]]);
    });

    test('without the v1 contract (absent or another value) the same rows are the legacy shape: availability, capabilities and names are ignored', async () => {
        for (const contract of [undefined, 'ezil.gateway.models.v2']) {
            forgetGatewayModels();
            expect(ids(await list(gateway(load(), () => Response.json(withoutContract(SERVED.member_no_paywall!, contract))).provider))).toEqual([QWEN, KIMI]);
            forgetGatewayModels();
            expect(ids(await list(gateway(load(), () => Response.json(withoutContract(SERVED.member_paywall_no_plan!, contract))).provider))).toEqual([QWEN, KIMI]);
            forgetGatewayModels();
            const g = gateway(load(), () => Response.json(withoutContract(v1([row(QWEN, 'available', { capabilities: { streaming: false, tool_calling: false } })]), contract)));
            const qwen = (await list(g.provider))[0]!;
            expect(qwen.capabilities.toolCalling).toBe(true);
            await send(g.provider, qwen);
            expect(g.posts.map(post => post.body.stream)).toEqual([true]);
        }
    });

    for (const [code, status, says] of [['no_entitlement', 402, 'AI access is not included for this account: it needs an active plan'],
        ['model_not_allowed', 403, 'This model is not included for your access. Pick another model']] as const) {
        test(`a ${code} refusal says so (not credits, not membership), re-reads the catalog at once and re-lists; another refusal does not`, async () => {
            let refusal: [string, number] = [code, status];
            const g = gateway(load(), () => Response.json(v1([row('synthetic-chat-a', 'available')])),
                () => Response.json({ error: { code: refusal[0], message: 'synthetic', request_id: 'req_synthetic' } }, { status: refusal[1] }));
            const selected = (await list(g.provider))[2]!;
            await expect(send(g.provider, selected)).rejects.toThrow(`EZiL Models: EZiL AI: ${says} (request req_synthetic)`);
            expect(g.changes()).toBe(1);
            await list(g.provider);
            expect(g.gets).toHaveLength(2); // within the five minutes: the refusal forgot the cache
            refusal = ['invalid_request', 400];
            await expect(send(g.provider, selected)).rejects.toThrow();
            await list(g.provider);
            expect([g.changes(), g.gets.length]).toEqual([1, 2]);
        });
    }

    test('when every routed attempt fails, the last attempt\'s code says what happened; one request, no fallback of our own', async () => {
        for (const [code, status, says] of [['upstream_error', 502, 'The model provider returned an error'], ['upstream_unavailable', 502, 'The model provider could not be reached'],
            ['upstream_timeout', 504, 'The model provider did not answer in time'], ['model_unavailable', 503, 'This model is temporarily unavailable']] as const) {
            forgetGatewayModels();
            const g = gateway(load(), () => Response.json(v1([row('synthetic-chat-a', 'available')])),
                () => Response.json({ error: { code, message: 'synthetic', request_id: 'req_synthetic', details: { attempts: 2 } } }, { status }));
            await expect(send(g.provider, (await list(g.provider))[2]!)).rejects.toThrow(`EZiL Models: EZiL AI: ${says} (request req_synthetic)`);
            expect(g.posts.map(post => post.body.model)).toEqual(['synthetic-chat-a']);
        }
    });

    test('a GPT-shaped row (Responses only, tools and streaming; c3 Q1) streams over Responses, returns its tool call, and keeps tool pairs across a switch from Qwen', async () => {
        const call = { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'read_file', arguments: '{"path":"b.ts"}', status: 'completed' };
        const frame = (type: string, fields: Row) => `event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`;
        const wire = [frame('response.created', { response: { object: 'response', id: 'resp_1', status: 'in_progress', output: [] } }),
            frame('response.output_item.added', { output_index: 0, item: { ...call, status: 'in_progress', arguments: '' } }),
            frame('response.function_call_arguments.delta', { item_id: 'fc_1', output_index: 0, delta: call.arguments }),
            frame('response.function_call_arguments.done', { item_id: 'fc_1', output_index: 0, arguments: call.arguments }),
            frame('response.output_item.done', { output_index: 0, item: call }),
            frame('response.completed', { response: { object: 'response', id: 'resp_1', status: 'completed', output: [call],
                usage: { input_tokens: 100, output_tokens: 12, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } })].join('');
        const g = gateway(load(), () => Response.json(v1([row('synthetic-gpt-shaped', 'available', { protocols: ['openai-responses'],
            capabilities: { tool_calling: true, image_input: false, streaming: true }, name: 'Synthetic GPT Shaped' })])),
            body => body.input ? new Response(wire, { headers: { 'content-type': 'text/event-stream' } }) : defaultAnswer(body));
        const infos = await list(g.provider);
        const gpt = infos.find(info => info.id === 'ezil/synthetic-gpt-shaped')!;
        expect([gpt.name, gpt.capabilities]).toEqual(['Synthetic GPT Shaped', { toolCalling: true, imageInput: false }]);
        const history = [
            message(1, [new TextPart('Read a.ts')]),
            message(2, [new ThinkingPart('private prior reasoning', 'th_1', { signature: 'sig' }), new TextPart('Reading it.'), new ToolCallPart('call_1', 'read_file', { path: 'a.ts' })]),
            message(1, [new ToolResultPart('call_1', [new TextPart('export const a = 1;')])]),
            message(1, [new TextPart('Now b.ts')]),
        ];
        const parts: unknown[] = [];
        await g.provider.provideLanguageModelChatResponse(gpt as never, history as never, { tools: [READ_FILE], modelOptions: {} } as never,
            { report: part => parts.push(part) }, token() as never);
        expect(parts).toEqual([new ToolCallPart('call_9', 'read_file', { path: 'b.ts' })]);
        await send(g.provider, infos[0]!, history, [READ_FILE]); // and back to Qwen
        const [gptPost, qwenPost] = g.posts;
        expect([new URL(gptPost!.url).pathname, gptPost!.body.model, gptPost!.body.stream, gptPost!.accept]).toEqual(['/ai/v1/responses', 'synthetic-gpt-shaped', true, 'text/event-stream']);
        expect((gptPost!.body.tools as { name: string }[]).map(tool => tool.name)).toEqual(['read_file']);
        const input = gptPost!.body.input as { type?: string; call_id?: string }[];
        expect(input.filter(item => item.type === 'function_call' || item.type === 'function_call_output').map(item => [item.type, item.call_id]))
            .toEqual([['function_call', 'call_1'], ['function_call_output', 'call_1']]);
        expect(JSON.stringify(gptPost!.body)).not.toContain('private prior reasoning');
        const turns = qwenPost!.body.messages as { content: { type: string; tool_use_id?: string }[] }[];
        expect([qwenPost!.body.model, turns[1]!.content.map(block => block.type), turns[2]!.content[0]!.tool_use_id]).toEqual([QWEN, ['text', 'tool_use'], 'call_1']);
    });

    test('a row is sent over its FIRST protocol, with that route\'s capabilities; an unspoken first protocol leaves it none', async () => {
        const g = gateway(load(), () => Response.json(v1([
            row('synthetic-responses-first', 'available', { protocols: ['openai-responses', 'anthropic-messages'], capabilities: { tool_calling: false, streaming: false } }),
            row('synthetic-messages-first', 'available', { protocols: ['anthropic-messages', 'openai-responses'], capabilities: { tool_calling: true, streaming: true } }),
            row('synthetic-future-first', 'available', { protocols: ['openai-chat-v9', 'anthropic-messages'], capabilities: { tool_calling: true, streaming: true } }),
        ])), body => body.input ? Response.json({
            object: 'response', id: 'resp_1', status: 'completed', usage: { input_tokens: 10, output_tokens: 2, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
            output: [{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hi', annotations: [] }] }] }) : defaultAnswer(body));
        const infos = (await list(g.provider)).slice(2);
        expect(infos.map(info => [info.id, info.capabilities.toolCalling])).toEqual([
            ['ezil/synthetic-responses-first', false], ['ezil/synthetic-messages-first', true], ['ezil/synthetic-future-first', false]]);
        for (const info of infos) await send(g.provider, info);
        expect(g.posts.map(post => [new URL(post.url).pathname, post.body.model, post.body.stream])).toEqual([
            ['/ai/v1/responses', 'synthetic-responses-first', false], ['/ai/v1/messages', 'synthetic-messages-first', true],
            ['/ai/v1/messages', 'synthetic-future-first', false]]);
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

    test('a paywall without a plan reads "Needs an active plan." on every row; without the contract the same rows show no model lines', async () => {
        const served = JSON.parse(readFileSync(`${import.meta.dir}/fixtures/gateway-catalog-v1-served.json`, 'utf8')).member_paywall_no_plan as Row;
        const view = await status(served);
        const at = view.lines.indexOf('Models (the request still decides)');
        expect(view.lines.slice(at + 1, at + 7)).toEqual(['claude-haiku-5-5', 'Claude Sonnet 5.5', 'ezil-code', 'ezil-fast', 'Qwen3 Coder Next', 'Kimi K3']
            .map(label => `${label}: Needs an active plan.`));
        forgetGatewayModels();
        const { contract: _, ...legacyShape } = served;
        expect((await status(legacyShape)).lines.some(line => line.startsWith('Models'))).toBe(false);
    });

    test('the deployed shape states no per-row availability, so no model lines are shown', async () => {
        const view = await status(legacy([row(QWEN), row(KIMI)]));
        expect(view.lines.some(line => line.startsWith('Models'))).toBe(false);
        expect(view.lines).toContain('Global AI pause: none reported.');
    });
});

// Founder request 2026-11-08: Gemini 3.8 Flash as the first model when the Gateway names it (`default_model`, contract §2
// rule 8) and this caller can use it in an Agent session; a picked model still wins (VS Code persists only picks).
describe('the Gateway\'s suggested default model', () => {
    const FLASH = 'gemini-3.8-flash';
    const flash = (state = 'available', extra: Row = {}) => row(FLASH, state, { name: 'Gemini 3.8 Flash', capabilities: { tool_calling: true, image_input: false, streaming: true }, ...extra });
    const defaults = (infos: { id: string }[]) => infos.filter(info => (info as { isDefault?: boolean }).isDefault).map(info => info.id);

    test('an available Flash row with tool calling becomes the declared default in place of Qwen', async () => {
        const g = gateway(load(), () => Response.json(v1([row(QWEN, 'available'), row(KIMI, 'available'), flash()], { default_model: FLASH })));
        const infos = await list(g.provider);
        expect(ids(infos)).toEqual([QWEN, KIMI, `ezil/${FLASH}`]);
        expect(defaults(infos)).toEqual([`ezil/${FLASH}`]);
    });

    test('otherwise the configured default (Qwen) stays: no hint, null, legacy, unavailable, no tools, unknown protocol, missing row', async () => {
        const cases: unknown[] = [
            v1([row(QWEN, 'available'), flash()]),
            v1([row(QWEN, 'available'), flash()], { default_model: null }),
            { ...legacy([row(QWEN), flash()]), default_model: FLASH },
            v1([row(QWEN, 'available'), flash('unavailable', { availability: { state: 'unavailable', reasons: ['not_allowed_for_caller'] } })], { default_model: FLASH }),
            v1([row(QWEN, 'available'), flash('available', { capabilities: { tool_calling: false, image_input: false, streaming: true } })], { default_model: FLASH }),
            v1([row(QWEN, 'available'), flash('available', { capabilities: undefined })], { default_model: FLASH }),
            v1([row(QWEN, 'available'), flash('available', { protocols: ['openai-chat-v9'] })], { default_model: FLASH }),
            v1([row(QWEN, 'available'), flash('available', { enabled: false })], { default_model: FLASH }),
            v1([row(QWEN, 'available')], { default_model: FLASH }),
            v1([row(QWEN, 'available'), flash()], { default_model: 'Gemini 3.8 Flash' }),
        ];
        for (const catalog of cases) {
            forgetGatewayModels();
            const g = gateway(load(), () => Response.json(catalog));
            expect(defaults(await list(g.provider))).toEqual([QWEN]);
        }
    });

    test('an unreadable catalog keeps the configured default even while the last rows stay listed', async () => {
        let up = true;
        const g = gateway(load(), () => up ? Response.json(v1([row(QWEN, 'available'), flash()], { default_model: FLASH })) : new Response('down', { status: 503 }));
        expect(defaults(await list(g.provider))).toEqual([`ezil/${FLASH}`]);
        up = false;
        const later = Date.now() + 6 * 60_000;
        const now = spyOn(Date, 'now').mockReturnValue(later);
        try {
            const infos = await list(g.provider);
            expect(ids(infos)).toContain(`ezil/${FLASH}`);
            expect(defaults(infos)).toEqual([QWEN]);
        } finally { now.mockRestore(); }
    });

    test('a request on the Flash default names gemini-3.8-flash and carries no temperature/top_p; Qwen keeps them', async () => {
        const g = gateway(load(), () => Response.json(v1([row(QWEN, 'available'), row(KIMI, 'available'), flash()], { default_model: FLASH })));
        const infos = await list(g.provider);
        const first = infos.find(info => (info as { isDefault?: boolean }).isDefault)!;
        await send(g.provider, first, undefined, [READ_FILE], { temperature: 0.2, top_p: 0.9 });
        await send(g.provider, infos.find(info => info.id === QWEN)!, undefined, [READ_FILE], { temperature: 0.2, top_p: 0.9 });
        expect(g.posts.map(post => [post.body.model, post.body.temperature, post.body.top_p, (post.body.tools as unknown[] | undefined)?.length])).toEqual([
            [FLASH, undefined, undefined, 1], [QWEN, 0.2, 0.9, 1]]);
    });

    test('a change of the suggested default alone re-lists the models', async () => {
        let catalog = v1([row(QWEN, 'available'), flash()]);
        const g = gateway(load(), () => Response.json(catalog));
        expect(defaults(await list(g.provider))).toEqual([QWEN]);
        catalog = v1([row(QWEN, 'available'), flash()], { default_model: FLASH });
        forgetGatewayModels();
        await send(g.provider, { id: QWEN });
        expect(g.changes()).toBe(1);
        expect(defaults(await list(g.provider))).toEqual([`ezil/${FLASH}`]);
    });
});
