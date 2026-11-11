// Real provider list/options/transport flow; all HTTP responses are synthetic.
import { afterEach, beforeEach, expect, mock, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseModelsConfig } from '../src/config';
import { forgetGatewayModels, gatewayModels } from '../src/gateway';
import { QWEN, KIMI } from '../src/gateway-messages';
import { fakeVscode, TextPart } from './fixtures/fake-vscode';
mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider } = await import('../src/provider');
type Row = Record<string, unknown>;
type Protocol = 'anthropic-messages' | 'openai-responses';
const capability = (protocol: Protocol, values = ['low', 'high'], defaultValue: string | null = null) =>
    ({ protocol, values, default: defaultValue });
const row = (id: string, protocol: Protocol, effort: unknown = capability(protocol)): Row => ({
    id, enabled: true, max_input_tokens: 100_000, max_output_tokens: 8192,
    protocols: [protocol], availability: { state: 'available', reasons: [] },
    capabilities: { streaming: false, tool_calling: true, image_input: false }, effort: effort === null ? undefined : effort,
});
function fixture(initial: Row[]) {
    const config = parseModelsConfig(readFileSync(new URL('../../../worker/ezil-models/models.json', import.meta.url), 'utf8'),
        { env: { EZIL_AI_BASE_URL: 'https://synthetic.test/ai/v1', EZIL_AI_PROXY_TOKEN: 'synthetic-only' } });
    const posts: { url: string; body: Row }[] = [];
    let data = initial, fail = false, gets = 0;
    const fetcher = (async (input: string | URL | Request, init: RequestInit = {}) => {
        if (String(input).endsWith('/models')) {
            gets++;
            if (fail) throw new Error('synthetic catalog offline');
            return Response.json({ contract: 'ezil.gateway.models.v1', killswitch: false, pause: null, data });
        }
        const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array)) as Row;
        posts.push({ url: String(input), body });
        return String(input).endsWith('/responses') ? Response.json({
            object: 'response', id: 'resp_synthetic', status: 'completed', output: [],
            usage: { input_tokens: 10, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
        }) : Response.json({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'synthetic output' }],
            stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });
    }) as typeof fetch;
    const provider = new EZiLModelsProvider({ models: () => config.models, configError: () => undefined,
        secrets: () => config.secrets, logRequests: () => false, log: () => {}, recordUsage: () => {}, fetch: fetcher });
    const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    const list = () => provider.provideLanguageModelChatInformation({} as never, token() as never);
    const send = (id: string, modelConfiguration?: unknown, modelOptions: Row = {}) =>
        provider.provideLanguageModelChatResponse({ id } as never, [{ role: 1, content: [new TextPart('synthetic input')] }] as never,
            { tools: [], modelConfiguration, modelOptions } as never, { report: () => {} }, token() as never);
    return { list, send, posts, config, gets: () => gets,
        onChange: (listener: () => void) => provider.onDidChangeLanguageModelChatInformation(listener),
        refresh: async () => {
            await gatewayModels(config.models[0]!.provider, fetcher);
            provider.refreshIfCatalogChanged();
        },
        replace: (rows: Row[]) => { data = rows; forgetGatewayModels(); }, offline: () => { fail = true; } };
}
beforeEach(() => forgetGatewayModels());
afterEach(() => { forgetGatewayModels(); setSystemTime(); });

test.each(['anthropic-messages', 'openai-responses'] as const)('list -> native options -> %s JSON stays session isolated', async protocol => {
    const f = fixture([row('synthetic-parent', protocol)]);
    const before = JSON.stringify(f.config.models);
    const info = (await f.list()).find(m => m.id === 'ezil/synthetic-parent')! as unknown as Row;
    expect(info.configurationSchema).toEqual({ properties: { reasoningEffort: { type: 'string', enum: ['low', 'high'] } } });
    const field = protocol === 'openai-responses' ? 'reasoning' : 'output_config';
    await Promise.all([f.send(String(info.id), { reasoningEffort: 'low' }),
        f.send(String(info.id), { reasoningEffort: 'high' })]);
    await f.send(String(info.id));
    expect(f.posts.map(p => p.body[field])).toEqual([{ effort: 'low' }, { effort: 'high' }, undefined]);
    expect(f.posts.map(p => new URL(p.url).pathname)).toEqual(Array(3).fill('/ai/v1/' + (protocol === 'openai-responses' ? 'responses' : 'messages')));
    expect(f.posts.every(p => p.body[protocol === 'openai-responses' ? 'output_config' : 'reasoning'] === undefined)).toBe(true);
    expect(JSON.stringify(f.config.models)).toBe(before);
});

test('only validated capability adds schema/default; missing/mismatched/malformed refuses override', async () => {
    const f = fixture([row('synthetic-default', 'openai-responses', capability('openai-responses', ['low', 'high'], 'low')),
        row('synthetic-missing', 'openai-responses', null),
        row('synthetic-mismatch', 'openai-responses', capability('anthropic-messages')),
        row('synthetic-invalid', 'openai-responses', capability('openai-responses', ['low', 'low']))]);
    const infos = await f.list();
    expect(infos.find(m => m.id === 'ezil/synthetic-default')).toHaveProperty('configurationSchema.properties.reasoningEffort.default', 'low');
    for (const id of ['missing', 'mismatch', 'invalid']) {
        expect(infos.find(m => m.id === 'ezil/synthetic-' + id)).not.toHaveProperty('configurationSchema');
        await expect(f.send('ezil/synthetic-' + id, { reasoningEffort: 'high' })).rejects.toThrow('Requested session effort is unavailable');
    }
    expect(f.posts).toHaveLength(0);
    await f.send('ezil/synthetic-default');
    expect(f.posts[0]?.body.reasoning).toBeUndefined(); // advertised default is not an implicit override
});

test('final fresh revocation refuses old picker configuration before dispatch', async () => {
    const f = fixture([row('synthetic-parent', 'openai-responses')]);
    await f.list();
    f.replace([row('synthetic-parent', 'openai-responses', capability('openai-responses', ['low']))]);
    await expect(f.send('ezil/synthetic-parent', { reasoningEffort: 'high' })).rejects.toThrow('Requested session effort is unavailable');
    expect(f.posts).toHaveLength(0);
    await f.send('ezil/synthetic-parent', { reasoningEffort: 'low' });
    expect(f.posts[0]?.body.reasoning).toEqual({ effort: 'low' });
});

test('expired cache and failed refresh cannot authorize effort', async () => {
    setSystemTime(new Date('2026-11-11T00:00:00Z'));
    const f = fixture([row(QWEN, 'anthropic-messages')]);
    await f.list();
    const gets = f.gets();
    f.offline();
    setSystemTime(new Date('2026-11-11T00:06:00Z'));
    await expect(f.send(QWEN, { reasoningEffort: 'high' })).rejects.toThrow('Requested session effort is unavailable');
    expect(f.gets()).toBeGreaterThan(gets);
    expect(f.posts).toHaveLength(0);
});

test('utility validates its own capability; child/no override cannot inherit parent effort', async () => {
    const f = fixture([row('synthetic-parent', 'anthropic-messages'),
        row(QWEN, 'anthropic-messages', capability('anthropic-messages', ['low'])), row(KIMI, 'anthropic-messages', null)]);
    await f.list();
    await f.send('ezil/synthetic-parent', { reasoningEffort: 'high' });
    await f.send('ezil/synthetic-parent', undefined, { requestInitiator: 'title' });
    expect(f.posts[1]?.body.model).toBe(QWEN);
    expect(f.posts[1]?.body.output_config).toBeUndefined();
    await expect(f.send('ezil/synthetic-parent', { reasoningEffort: 'high' }, { requestInitiator: 'title' }))
        .rejects.toThrow('Requested session effort is unavailable');
    await f.send(KIMI, undefined, { requestInitiator: 'child' });
    expect(f.posts[2]?.body.output_config).toBeUndefined();
    await f.send('ezil/synthetic-parent', undefined, { reasoningEffort: 'high' });
    expect(f.posts[3]?.body.output_config).toBeUndefined();
    await expect(f.send('ezil/synthetic-parent', { reasoningEffort: 'invalid' })).rejects.toThrow('Requested session effort is unavailable');
    expect(f.posts).toHaveLength(4);
});

test('configured default Messages cannot borrow Responses-first catalog effort', async () => {
    const f = fixture([{ ...row(QWEN, 'openai-responses'), protocols: ['openai-responses', 'anthropic-messages'] }]);
    const info = (await f.list()).find(m => m.id === QWEN);
    expect(info).not.toHaveProperty('configurationSchema');
    await expect(f.send(QWEN, { reasoningEffort: 'high' })).rejects.toThrow('Requested session effort is unavailable');
    expect(f.posts).toHaveLength(0);
    await f.send(QWEN);
    expect(new URL(f.posts[0]!.url).pathname).toBe('/ai/v1/messages');
    expect(f.posts[0]?.body.reasoning).toBeUndefined();
    expect(f.posts[0]?.body.output_config).toBeUndefined();
});

// Exercise the real cache -> change event -> Code re-list -> request path, not the signature helper.
for (const change of [
    { name: 'capability addition', before: null, after: capability('openai-responses', ['low']), value: 'low' },
    { name: 'enum expansion', before: capability('openai-responses', ['low']), after: capability('openai-responses'), value: 'high' },
    { name: 'enum revocation', before: capability('openai-responses'), after: capability('openai-responses', ['low']), refused: 'high' },
    { name: 'capability removal', before: capability('openai-responses'), after: null, refused: 'low' },
    { name: 'default change', before: capability('openai-responses', ['low', 'high'], 'low'),
        after: capability('openai-responses', ['low', 'high'], 'high') },
]) test(`effort-only ${change.name} refreshes picker schema without mutating request defaults`, async () => {
    const f = fixture([row('synthetic-refresh', 'openai-responses', change.before)]);
    const beforeConfig = JSON.stringify(f.config.models);
    const initial = (await f.list()).find(m => m.id === 'ezil/synthetic-refresh')!;
    let events = 0;
    const subscription = f.onChange(() => { events++; });
    f.replace([row('synthetic-refresh', 'openai-responses', change.after)]);
    await f.refresh();
    expect(events).toBe(1);
    const updated = (await f.list()).find(m => m.id === initial.id)!;
    if (change.after) expect(updated).toHaveProperty('configurationSchema', { properties: { reasoningEffort: {
        type: 'string', enum: change.after.values, ...(change.after.default !== null ? { default: change.after.default } : {}),
    } } });
    else expect(updated).not.toHaveProperty('configurationSchema');
    expect(updated).not.toEqual(initial);
    await f.refresh();
    expect(events).toBe(1); // re-listed metadata is now current
    if (change.refused) {
        await expect(f.send(initial.id, { reasoningEffort: change.refused })).rejects.toThrow('Requested session effort is unavailable');
        expect(f.posts).toHaveLength(0);
    }
    if (change.value) {
        await f.send(initial.id, { reasoningEffort: change.value });
        expect(f.posts.at(-1)?.body.reasoning).toEqual({ effort: change.value });
    }
    await f.send(initial.id);
    expect(f.posts.at(-1)?.body.reasoning).toBeUndefined(); // metadata default never becomes an implicit override
    expect(JSON.stringify(f.config.models)).toBe(beforeConfig);
    subscription.dispose();
});

test('equivalent freshly parsed effort metadata emits no redundant picker event', async () => {
    const f = fixture([row('synthetic-refresh', 'openai-responses')]);
    const initial = await f.list();
    let events = 0;
    const subscription = f.onChange(() => { events++; });
    const gets = f.gets();
    f.replace([row('synthetic-refresh', 'openai-responses')]);
    await f.refresh();
    expect(f.gets()).toBeGreaterThan(gets); // independent read, not just cache identity
    expect(events).toBe(0);
    expect(await f.list()).toEqual(initial);
    subscription.dispose();
});
