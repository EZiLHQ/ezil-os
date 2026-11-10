// The model list after a failed read (staging 2026-11-10: after the first replies, Code's picker kept only the
// configured models and "availability unknown" while other status reads still answered). Zero inference: every
// response is a fixture and the `synthetic-*` aliases name no real model or route.
//   - one `/v1/models` read at a time per base URL + token, however many callers wait on it;
//   - a token count never makes a request (Copilot counts every prompt part, often at once);
//   - a picker filled without a readable list is filled again once the list reads.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseModelsConfig } from '../src/config';
import { forgetGatewayModels, gatewayModels, INCLUDED_MODELS_HEADER } from '../src/gateway';
import { gatewayTokenCount, KIMI, QWEN } from '../src/gateway-messages';
import { fakeVscode } from './fixtures/fake-vscode';

mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider } = await import('../src/provider');

const BASE = 'https://computer.test/ai/v1';
const config = parseModelsConfig(readFileSync(`${import.meta.dir}/../../../worker/ezil-models/models.json`, 'utf8'),
    { env: { EZIL_AI_BASE_URL: BASE, EZIL_AI_PROXY_TOKEN: 'synthetic-proxy-token' } });
const gatewayProvider = config.models[0]!.provider;
const FLASH = 'gemini-3.8-flash', PRO = 'synthetic-pro';
const row = (id: string, protocols = ['anthropic-messages']) => ({ id, object: 'model', enabled: true, max_input_tokens: 100_000, max_output_tokens: 32_000,
    protocols, availability: { state: 'available', reasons: [] }, capabilities: { tool_calling: true, streaming: true } });
const catalog = () => ({ object: 'list', contract: 'ezil.gateway.models.v1', killswitch: false, pause: null, default_model: FLASH,
    data: [row(QWEN), row(KIMI), row(FLASH), row(PRO, ['openai-responses'])] });

type Answer = 'ok' | 'fail' | 'hang';
/** The OS proxy's `/models`: Free adds the plan header. `hang` answers only when released or the request is aborted. */
function harness(plan: 'free' | 'paid') {
    const state = { answer: 'ok' as Answer, gets: 0, inFlight: 0, maxInFlight: 0, release: [] as (() => void)[] };
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        if (!String(input).endsWith('/models')) throw new Error(`unexpected request ${String(input)}`);
        state.gets++;
        state.inFlight++;
        state.maxInFlight = Math.max(state.maxInFlight, state.inFlight);
        try {
            const answer = state.answer;
            if (answer === 'hang') await new Promise<void>((resolve, reject) => {
                state.release.push(resolve);
                init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
            });
            else await new Promise(resolve => setTimeout(resolve, 5));
            if (answer === 'fail') return Response.json({ error: { code: 'os_ai_unavailable', source: 'ezil-os-proxy' } }, { status: 504 });
            return Response.json(catalog(), { headers: plan === 'free' ? { [INCLUDED_MODELS_HEADER]: FLASH } : {} });
        } finally { state.inFlight--; }
    }) as typeof globalThis.fetch;
    const host = { models: () => config.models, configError: () => undefined, secrets: () => config.secrets, logRequests: () => false,
        log: () => {}, recordUsage: () => {}, fetch, requestFinished: () => {} };
    const provider = new EZiLModelsProvider(host);
    let changes = 0;
    provider.onDidChangeLanguageModelChatInformation(() => { changes++; });
    return { provider, state, fetch, changes: () => changes };
}
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
type Info = { id: string; isDefault?: boolean; isUserSelectable?: boolean };
const list = async (provider: InstanceType<typeof EZiLModelsProvider>) => await provider.provideLanguageModelChatInformation({} as never, token() as never) as Info[];
const count = (provider: InstanceType<typeof EZiLModelsProvider>, info: Info, text: string) => provider.provideTokenCount(info as never, text, token() as never);

beforeEach(() => forgetGatewayModels());

describe('one /v1/models read at a time', () => {
    test('concurrent callers share one read; a caller that gives up does not end it for the others', async () => {
        const g = harness('paid');
        g.state.answer = 'hang';
        const leaving = new AbortController();
        const waits = Array.from({ length: 40 }, () => gatewayModels(gatewayProvider, g.fetch));
        const leaver = gatewayModels(gatewayProvider, g.fetch, Date.now(), leaving.signal);
        const listing = list(g.provider);
        await Bun.sleep(5);
        leaving.abort();
        expect(await leaver).toBeUndefined();
        expect(g.state.gets).toBe(1);
        g.state.release.splice(0).forEach(resolve => resolve());
        const read = await Promise.all(waits);
        expect(read.every(models => models?.data.some(entry => entry.id === FLASH))).toBe(true);
        expect((await listing).map(info => info.id)).toContain(`ezil/${FLASH}`);
        expect(g.state.gets).toBe(1);
    });

    test('a failed shared read is not reused: the next caller reads again, and a refusal starts a new read', async () => {
        const g = harness('paid');
        g.state.answer = 'fail';
        expect(await Promise.all(Array.from({ length: 10 }, () => gatewayModels(gatewayProvider, g.fetch)))).toEqual(Array(10).fill(undefined));
        expect(g.state.gets).toBe(1);
        g.state.answer = 'hang';
        const before = gatewayModels(gatewayProvider, g.fetch);
        await Bun.sleep(1);
        forgetGatewayModels(BASE);
        g.state.answer = 'ok';
        const after = await gatewayModels(gatewayProvider, g.fetch);
        expect(after?.data.map(entry => entry.id)).toContain(FLASH);
        expect(g.state.gets).toBe(3);
        g.state.release.splice(0).forEach(resolve => resolve());
        await before;
    });
});

describe('a read under way when the list is forgotten changes nothing and answers nothing of its own', () => {
    /** Each `/models` request waits for its own answer: Free (the plan header) or paid (none). */
    function deferred() {
        const answers: ((plan: 'free' | 'paid') => void)[] = [];
        const fetch = (async () => {
            const plan = await new Promise<'free' | 'paid'>(resolve => answers.push(resolve));
            return Response.json(catalog(), { headers: plan === 'free' ? { [INCLUDED_MODELS_HEADER]: FLASH } : {} });
        }) as unknown as typeof globalThis.fetch;
        return { fetch, answers };
    }
    const host = (fetch: typeof globalThis.fetch) => new EZiLModelsProvider({ models: () => config.models, configError: () => undefined, secrets: () => config.secrets,
        logRequests: () => false, log: () => {}, recordUsage: () => {}, fetch, requestFinished: () => {} });
    const unlocked = async (fetch: typeof globalThis.fetch) => (await list(host(fetch))).filter(info => info.isUserSelectable !== false).map(info => info.id).sort();

    for (const [old, now] of [['paid', 'free'], ['free', 'paid']] as const) {
        test(`old ${old} read, forgotten, new ${now} read: the late old answer neither lands nor is returned`, async () => {
            const d = deferred();
            const a = gatewayModels(gatewayProvider, d.fetch);
            await Bun.sleep(1);
            forgetGatewayModels(BASE); // a refusal
            const b = gatewayModels(gatewayProvider, d.fetch);
            await Bun.sleep(1);
            expect(d.answers.length).toBe(2);
            d.answers[1]!(now);
            expect((await b)?.included).toEqual(now === 'free' ? [FLASH] : undefined);
            d.answers[0]!(old);
            expect((await a)?.included).toEqual(now === 'free' ? [FLASH] : undefined);
            // What the picker lists from the cache and the plan's limit is the new answer's alone.
            expect(await unlocked(d.fetch)).toEqual(now === 'free' ? [`ezil/${FLASH}`] : [`ezil/${FLASH}`, `ezil/${PRO}`, KIMI, QWEN].sort());
        });
    }

    test('forgotten by a reload with no newer read: the late answer returns nothing and leaves no plan limit or cache', async () => {
        const d = deferred();
        const a = gatewayModels(gatewayProvider, d.fetch);
        await Bun.sleep(1);
        forgetGatewayModels();
        d.answers[0]!('free');
        expect(await a).toBeUndefined();
        const g = harness('paid');
        g.state.answer = 'fail';
        expect((await list(g.provider)).map(info => info.id)).toEqual([QWEN, KIMI]);
    });
});

describe('token counts never request the model list', () => {
    for (const plan of ['paid', 'free'] as const) {
        test(`${plan}: 200 counts at once after the list was forgotten make no request, and none fails`, async () => {
            const g = harness(plan);
            const infos = await list(g.provider);
            const flash = infos.find(info => info.id === `ezil/${FLASH}`)!, pro = infos.find(info => info.id === `ezil/${PRO}`)!;
            forgetGatewayModels(BASE); // as after a catalog refusal: the cache is gone
            g.state.answer = 'hang';
            const gets = g.state.gets;
            const counts = await Promise.all(Array.from({ length: 200 }, (_, i) => count(g.provider, i % 2 ? flash : pro, `part ${i} ü`)));
            expect(g.state.gets).toBe(gets);
            // A model the known list cannot place is never counted below either Gateway protocol (the Responses one escapes
            // non-ASCII); Free's remembered plan still places Flash, on its own protocol.
            for (const [i, n] of counts.entries()) {
                const text = `part ${i} ü`;
                expect(n).toBe(i % 2 && plan === 'free' ? gatewayTokenCount(text, 'anthropic-messages')
                    : Math.max(gatewayTokenCount(text, 'anthropic-messages'), gatewayTokenCount(text, 'openai-responses')));
            }
        });
    }

    test('a known catalog still counts with the model\'s own protocol', async () => {
        const g = harness('paid');
        const infos = await list(g.provider);
        const pro = infos.find(info => info.id === `ezil/${PRO}`)!;
        expect(await count(g.provider, pro, 'ü')).toBe(gatewayTokenCount('ü', 'openai-responses'));
    });
});

describe('a picker filled without a readable list recovers', () => {
    test('Free: the configured fallback is replaced by the plan\'s list, Flash default and locks, once the list reads', async () => {
        const g = harness('free');
        g.state.answer = 'fail';
        const first = await list(g.provider);
        expect(first.map(info => info.id)).toEqual([QWEN, KIMI]);
        await g.provider.recoverCatalog(); // still failing: no change announced
        expect(g.changes()).toBe(0);
        g.state.answer = 'ok';
        await g.provider.recoverCatalog();
        expect(g.changes()).toBe(1);
        const after = await list(g.provider);
        expect(after.filter(info => info.isDefault).map(info => info.id)).toEqual([`ezil/${FLASH}`]);
        expect(after.filter(info => info.isUserSelectable !== false).map(info => info.id)).toEqual([`ezil/${FLASH}`]);
        const gets = g.state.gets;
        await g.provider.recoverCatalog(); // listed from a read: nothing to recover, no request
        expect(g.state.gets).toBe(gets);
        expect(g.changes()).toBe(1);
    });

    test('a recovery that reads ends recovering, even when the list read equals the one listed', async () => {
        const g = harness('free');
        await list(g.provider); // Free: listed and remembered (plan limit)
        forgetGatewayModels(BASE);
        g.state.answer = 'fail';
        await list(g.provider); // listed from the remembered limit: unread
        g.state.answer = 'ok';
        await g.provider.recoverCatalog();
        const gets = g.state.gets;
        forgetGatewayModels(BASE); // no cache to answer from: a further recovery would have to request
        await g.provider.recoverCatalog();
        expect(g.state.gets).toBe(gets);
    });

    test('a connection no longer configured is never polled with its old credential', async () => {
        const models = [...config.models];
        const changed = parseModelsConfig(readFileSync(`${import.meta.dir}/../../../worker/ezil-models/models.json`, 'utf8'),
            { env: { EZIL_AI_BASE_URL: BASE, EZIL_AI_PROXY_TOKEN: 'synthetic-rotated-token' } });
        const tokens: string[] = [];
        const fetch = (async (_input: string, init: RequestInit = {}) => {
            tokens.push(new Headers(init.headers).get('authorization') ?? '');
            return Response.json({ error: { code: 'os_ai_unavailable' } }, { status: 504 });
        }) as unknown as typeof globalThis.fetch;
        let current = models;
        const provider = new EZiLModelsProvider({ models: () => current, configError: () => undefined, secrets: () => config.secrets, logRequests: () => false,
            log: () => {}, recordUsage: () => {}, fetch, requestFinished: () => {} });
        await provider.provideLanguageModelChatInformation({} as never, token() as never);
        current = changed.models;
        tokens.length = 0;
        await provider.recoverCatalog();
        expect(tokens).toEqual([]);
    });

    test('paid: a healthy listing never triggers a recovery read', async () => {
        const g = harness('paid');
        await list(g.provider);
        const gets = g.state.gets;
        for (let i = 0; i < 5; i++) await g.provider.recoverCatalog();
        expect(g.state.gets).toBe(gets);
        expect(g.changes()).toBe(0);
    });
});
