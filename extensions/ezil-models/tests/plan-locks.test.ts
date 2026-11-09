// Free includes Gemini 3.8 Flash only (founder decision 2026-11-09). The EZiL OS proxy names the plan's models in
// `x-ezil-os-included-models` on every /models answer (worker/src/ai-proxy.ts) and refuses any other model itself; this
// client lists the other models locked, never sends them, and asks the OS window for billing only on an exact credit
// refusal or a locked model chosen in the picker. Zero inference: every response is a fixture.
import { afterAll, beforeEach, describe, expect, mock, setSystemTime, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { parseModelsConfig, type ResolvedConfig } from '../src/config';
import { forgetGatewayModels, INCLUDED_MODELS_HEADER, parseIncludedModels } from '../src/gateway';
import { KIMI, QWEN } from '../src/gateway-messages';
import type { AppFailure } from '../src/failure';
import { fakeVscode, TextPart } from './fixtures/fake-vscode';

mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider, LOCKED_MODEL_INFO_KEY } = await import('../src/provider');
const { sendBillingIntent } = await import('../src/extension');
const { frames, messageJson } = await import('./fixtures/gateway-response');

const BASE = 'https://computer.test/ai/v1';
const FLASH = 'gemini-3.8-flash', PRO = 'synthetic-pro';
const REQUEST = '6f1d3a52-9b0e-4c1d-8a7b-2e5f4d3c2b1a';
const load = (proxyToken: string): ResolvedConfig => parseModelsConfig(readFileSync(`${import.meta.dir}/../../../worker/ezil-models/models.json`, 'utf8'),
    { env: { EZIL_AI_BASE_URL: BASE, EZIL_AI_PROXY_TOKEN: proxyToken } });

type Row = Record<string, unknown>;
const tools = { capabilities: { tool_calling: true, image_input: false, streaming: true } };
const row = (id: string, state = 'available', extra: Row = {}): Row => ({ id, object: 'model', owned_by: 'ezil', alias: id, enabled: true,
    max_input_tokens: 100_000, max_output_tokens: 32_000, protocols: ['anthropic-messages'], availability: { state, reasons: [] }, ...tools, ...extra });
const catalog = (data: Row[], over: Row = {}) => ({ object: 'list', contract: 'ezil.gateway.models.v1', catalog_ttl_seconds: 10, killswitch: false,
    pause: null, default_model: FLASH, data, ...over });
const ROWS = [row(QWEN), row(KIMI), row(FLASH, 'available', { name: 'Gemini 3.8 Flash' }), row(PRO, 'available', { name: 'Synthetic Pro' })];
const free = (data = ROWS, header = FLASH) => () => Response.json(catalog(data), { headers: { [INCLUDED_MODELS_HEADER]: header } });
const paid = (data = ROWS) => () => Response.json(catalog(data));

type Sent = { url: string; body: Record<string, unknown> };
function gateway(models: () => Response, answer: (body: Record<string, unknown>) => Response = ok, ask: (intent: unknown) => Promise<boolean> = async () => true,
    proxyToken = 'synthetic-proxy-token') {
    const config = load(proxyToken);
    const posts: Sent[] = []; let gets = 0;
    const intents: unknown[] = []; const failures: AppFailure[] = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
        init.signal?.throwIfAborted();
        if (String(input).endsWith('/models')) { gets++; return models(); }
        const body = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
        posts.push({ url: String(input), body });
        return answer(body);
    }) as typeof globalThis.fetch;
    const provider = new EZiLModelsProvider({ models: () => config.models, configError: () => undefined, secrets: () => config.secrets,
        logRequests: () => false, log: () => {}, recordUsage: () => {}, fetch, appFailure: record => { failures.push(record); },
        billingIntent: async intent => { intents.push(intent); return ask(intent); } });
    let changes = 0;
    provider.onDidChangeLanguageModelChatInformation(() => { changes++; });
    return { provider, posts, intents, failures, gets: () => gets, changes: () => changes };
}
function ok(body: Record<string, unknown>): Response {
    return body.stream ? new Response(frames('end_turn').join(''), { headers: { 'content-type': 'text/event-stream' } }) : Response.json(messageJson());
}
const refusal = (status: number, code?: string, extra: Row = {}) => () =>
    Response.json({ error: { ...code ? { code } : {}, request_id: REQUEST, ...extra } }, { status, headers: { 'x-ezil-request-id': REQUEST } });
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
type Info = { id: string; isDefault?: boolean; isUserSelectable?: boolean; statusIcon?: { id: string }; infoText?: Record<string, string> };
const list = async (provider: InstanceType<typeof EZiLModelsProvider>) =>
    await provider.provideLanguageModelChatInformation({} as never, token() as never) as unknown as Info[];
const send = (provider: InstanceType<typeof EZiLModelsProvider>, id: string, modelOptions: Row = {}) =>
    provider.provideLanguageModelChatResponse({ id } as never, [{ role: 1, content: [new TextPart('q')] }] as never,
        { tools: [], modelOptions } as never, { report: () => {} }, token() as never);
const locked = (infos: Info[]) => infos.filter(info => info.isUserSelectable === false).map(info => info.id);
const defaults = (infos: Info[]) => infos.filter(info => info.isDefault).map(info => info.id);

const warnings = mock(async (..._args: unknown[]): Promise<string | undefined> => undefined);
const notices = mock(async (..._args: unknown[]): Promise<string | undefined> => undefined);
const errors = mock(async (..._args: unknown[]): Promise<string | undefined> => undefined);
const opened: string[] = [];
(fakeVscode.window as Record<string, unknown>).showWarningMessage = warnings;
(fakeVscode.window as Record<string, unknown>).showInformationMessage = notices;
(fakeVscode.env as Record<string, unknown>).openExternal = async (uri: URL) => { opened.push(String(uri)); return true; };

// The OS links come from the computer's own EZIL_AI_BASE_URL (provider.ts osBillingLink), as in the image.
const savedBase = process.env.EZIL_AI_BASE_URL;
beforeEach(() => {
    forgetGatewayModels(); warnings.mockClear(); notices.mockClear(); errors.mockClear(); opened.length = 0; process.env.EZIL_AI_BASE_URL = BASE;
    (fakeVscode.window as Record<string, unknown>).showErrorMessage = errors;
});
afterAll(() => { setSystemTime(); if (savedBase === undefined) delete process.env.EZIL_AI_BASE_URL; else process.env.EZIL_AI_BASE_URL = savedBase; });

describe('the picker on Free: Flash selectable, every other model listed but locked', () => {
    test('other models are locked (not selectable, lock icon, marker text); Flash is the one default', async () => {
        const infos = await list(gateway(free()).provider);
        expect(infos.map(info => info.id)).toEqual([QWEN, KIMI, `ezil/${FLASH}`, `ezil/${PRO}`]);
        expect(locked(infos)).toEqual([QWEN, KIMI, `ezil/${PRO}`]);
        expect(defaults(infos)).toEqual([`ezil/${FLASH}`]);
        for (const info of infos.filter(info => info.isUserSelectable === false)) {
            expect(info.statusIcon?.id).toBe('lock');
            expect(Object.keys(info.infoText ?? {})).toEqual([LOCKED_MODEL_INFO_KEY]);
            expect(info.isDefault).toBe(false);
        }
        expect(infos.find(info => info.id === `ezil/${FLASH}`)).toMatchObject({ isUserSelectable: true, isDefault: true });
    });

    test('Flash is the default on Free and on a paid plan whatever the Gateway suggests: another model, none, or one unavailable', async () => {
        for (const over of [{ default_model: QWEN }, { default_model: null }, { default_model: 'synthetic-gone' }, { default_model: PRO }]) {
            for (const plan of [free, paid]) {
                forgetGatewayModels();
                const data = [...ROWS, row('synthetic-gone', 'unavailable')];
                const g = gateway(plan === free ? () => Response.json(catalog(data, over), { headers: { [INCLUDED_MODELS_HEADER]: FLASH } }) : () => Response.json(catalog(data, over)));
                expect(defaults(await list(g.provider))).toEqual([`ezil/${FLASH}`]);
            }
        }
    });

    test('a plan that includes another model starts on it, never on the preferred model it locks', async () => {
        const g = gateway(free(ROWS, PRO));
        const infos = await list(g.provider);
        expect(locked(infos)).toEqual([QWEN, KIMI, `ezil/${FLASH}`]);
        expect(defaults(infos)).toEqual([`ezil/${PRO}`]);
    });

    test('Flash unavailable on Free: no default and nothing selectable (unavailable, never an upgrade in its place)', async () => {
        for (const data of [[row(QWEN), row(FLASH, 'unavailable')], [row(QWEN)], [row(QWEN), row(FLASH, 'available', { enabled: false })]]) {
            forgetGatewayModels();
            const infos = await list(gateway(free(data)).provider);
            expect(defaults(infos)).toEqual([]);
            expect(infos.filter(info => info.isUserSelectable !== false)).toEqual([]);
        }
    });

    test('a paid plan (no header) lists every model selectable, as before; a malformed header locks nothing', async () => {
        expect(locked(await list(gateway(paid()).provider))).toEqual([]);
        for (const header of ['', 'Gemini-3.8-Flash', `${FLASH},${FLASH}`, `${FLASH}, ${QWEN}`]) {
            forgetGatewayModels();
            expect(parseIncludedModels(header)).toBeUndefined();
            expect(locked(await list(gateway(free(ROWS, header)).provider))).toEqual([]);
        }
        expect(parseIncludedModels(`${FLASH},${QWEN}`)).toEqual([FLASH, QWEN]);
    });
});

describe('a locked model is never sent', () => {
    test('a configured or catalog-only locked model is refused here: no POST, no billing ask, model_not_entitled', async () => {
        const g = gateway(free());
        await list(g.provider);
        for (const id of [QWEN, `ezil/${PRO}`]) {
            await expect(send(g.provider, id)).rejects.toThrow(/is not included in your plan\. Nothing was sent or charged\. Pick Gemini 3\.8 Flash, or upgrade in Settings → Billing\./);
        }
        expect(g.posts).toHaveLength(0);
        expect(g.intents).toEqual([]);
        expect(warnings).not.toHaveBeenCalled();
        expect(g.failures.map(record => [record.code, record.category, record.stage])).toEqual([
            ['model_not_entitled', 'entitlement', 'admission'], ['model_not_entitled', 'entitlement', 'admission']]);
        // Positive control: Flash goes.
        await send(g.provider, `ezil/${FLASH}`);
        expect(g.posts.map(post => post.body.model)).toEqual([FLASH]);
    });

    test('a title or summary request stays on the selected Flash on Free, and goes to Qwen on a paid plan', async () => {
        const f = gateway(free());
        await list(f.provider);
        await send(f.provider, `ezil/${FLASH}`, { requestInitiator: 'title' });
        // A marked title naming Qwen (the extension's own utility default; the image pins Flash): on Free it goes to Flash.
        await send(f.provider, QWEN, { requestInitiator: 'title' });
        await send(f.provider, QWEN, { role: 'utilitySmall' });
        expect(f.posts.map(post => post.body.model)).toEqual([FLASH, FLASH, FLASH]);
        // A turn (not a utility request) naming locked Qwen is still refused.
        await expect(send(f.provider, QWEN)).rejects.toThrow(/is not included in your plan/);
        expect(f.posts).toHaveLength(3);
        forgetGatewayModels();
        const p = gateway(paid());
        await list(p.provider);
        await send(p.provider, `ezil/${FLASH}`, { requestInitiator: 'title' });
        expect(p.posts.map(post => post.body.model)).toEqual([QWEN]);
    });

    test('the proxy refusal itself (a stale list) asks nothing and re-lists from a fresh catalog', async () => {
        const g = gateway(paid(), refusal(403, 'os_model_not_included'));
        await list(g.provider);
        await expect(send(g.provider, `ezil/${PRO}`)).rejects.toThrow(/is not included in your plan/);
        expect(g.intents).toEqual([]);
        expect(g.changes()).toBeGreaterThan(0);
    });
});

describe('billing asks: exactly two credit codes, once a minute', () => {
    test('insufficient_credits and no_live_grant ask the OS once, with the request id; the OS took it, so no notice', async () => {
        for (const code of ['insufficient_credits', 'no_live_grant']) {
            const g = gateway(free(), refusal(402, code, { available_micro: 0, hold_micro: 1200 }));
            await list(g.provider);
            await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
            await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
            await Bun.sleep(0);
            expect(g.intents).toEqual([{ reason: 'credits_exhausted', requestId: REQUEST }]);
            expect(g.posts).toHaveLength(2);
        }
        expect(warnings).not.toHaveBeenCalled();
    });

    test('outside an OS window (not taken), the notice with its Add credits link stays', async () => {
        const g = gateway(paid(), refusal(402, 'insufficient_credits'), async () => false);
        await list(g.provider);
        warnings.mockImplementationOnce(async () => 'Add credits');
        await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
        await Bun.sleep(0); await Bun.sleep(0);
        expect(g.intents).toHaveLength(1);
        expect(warnings).toHaveBeenCalledTimes(1);
        expect(opened).toEqual(['https://computer.test/os?settings=billing&section=ai-credits&reason=insufficient_credits']);
    });

    test.each([
        ['window budget', 429, 'window_budget_reached'], ['daily budget', 429, 'daily_budget_reached'], ['no entitlement (402)', 402, 'no_entitlement'],
        ['a 402 without a code', 402, undefined], ['validation', 400, 'invalid_request'], ['Gemini refusal', 400, 'unsupported_gemini_request'],
        ['provider error', 502, 'upstream_error'], ['provider unavailable', 503, 'upstream_unavailable'], ['session missing', 401, 'os_session_missing'],
        ['proxy unavailable', 502, 'os_ai_unavailable'], ['plan refusal', 403, 'os_model_not_included'], ['membership', 403, 'not_a_member'],
    ] as const)('%s never asks for billing', async (_name, status, code) => {
        const g = gateway(paid(), refusal(status, code));
        await list(g.provider);
        await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
        await Bun.sleep(0);
        expect(g.intents).toEqual([]);
        expect(warnings).not.toHaveBeenCalled();
    });

    test('a network failure never asks for billing', async () => {
        const g = gateway(paid(), () => { throw new TypeError('fetch failed'); });
        await list(g.provider);
        await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
        expect(g.intents).toEqual([]);
    });

    test('an unknown plan (503 os_plan_unavailable) offers Retry at most once a minute, and never billing', async () => {
        let code = 'os_plan_unavailable';
        const g = gateway(free(), () => refusal(code === 'os_plan_unavailable' ? 503 : 502, code)());
        await list(g.provider);
        const start = Date.now();
        try {
            setSystemTime(new Date(start));
            // A new chat's title, two progress messages and the turn are all refused alike: one notice.
            for (let i = 0; i < 4; i++) await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
            await Bun.sleep(0);
            expect(errors).toHaveBeenCalledTimes(1);
            expect(errors.mock.calls[0]?.slice(1)).toEqual(['Retry']);
            // The limit is the plan notice's own: another temporary failure in the same minute still offers Retry.
            code = 'os_ai_unavailable';
            await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
            await Bun.sleep(0);
            expect(errors).toHaveBeenCalledTimes(2);
            code = 'os_plan_unavailable';
            setSystemTime(new Date(start + 61_000));
            await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
            await Bun.sleep(0);
            expect(errors).toHaveBeenCalledTimes(3);
        } finally { setSystemTime(); }
        expect(g.posts).toHaveLength(6);
        expect(g.intents).toEqual([]);
        expect(warnings).not.toHaveBeenCalled();
    });
});

describe('a locked model chosen in the picker', () => {
    test('reads the plan again, then asks the OS for the upgrade; nothing is sent', async () => {
        const g = gateway(free());
        await list(g.provider);
        const before = g.gets();
        expect(await g.provider.lockedModelChosen(`ezil/${PRO}`)).toBe('asked');
        expect(await g.provider.lockedModelChosen(QWEN)).toBe('asked');
        expect(g.gets()).toBe(before + 2);
        expect(g.intents).toEqual([{ reason: 'model_locked', model: PRO }, { reason: 'model_locked', model: QWEN }]);
        expect(g.posts).toHaveLength(0);
        expect(notices).not.toHaveBeenCalled();
    });

    test('just upgraded (the fresh read includes it): the picker lists it again and nothing opens', async () => {
        let upgraded = false;
        const g = gateway(() => upgraded ? paid()() : free()());
        await list(g.provider);
        upgraded = true;
        const changes = g.changes();
        expect(await g.provider.lockedModelChosen(`ezil/${PRO}`)).toBe('listed');
        expect(g.changes()).toBe(changes + 1);
        expect(g.intents).toEqual([]);
        expect(locked(await list(g.provider))).toEqual([]);
    });

    test('outside an OS window, a notice offers the Standard link; anything not a model is ignored', async () => {
        const g = gateway(free(), ok, async () => false);
        await list(g.provider);
        notices.mockImplementationOnce(async () => 'Upgrade');
        expect(await g.provider.lockedModelChosen(`ezil/${PRO}`)).toBe('asked');
        await Bun.sleep(0); await Bun.sleep(0);
        expect(notices.mock.calls[0]?.slice(0, 2)).toEqual(['Synthetic Pro is not included in your plan.', 'Upgrade']);
        expect(opened).toEqual(['https://computer.test/os?settings=billing&upgrade=standard']);
        for (const id of [undefined, 42, 'nope', 'other/model']) expect(await g.provider.lockedModelChosen(id)).toBe('ignored');
    });
});

describe('sendBillingIntent: what crosses into the workbench', () => {
    test('a closed record, true only when the OS window took it, false on any failure', async () => {
        const calls: unknown[][] = [];
        let result: unknown = true;
        (fakeVscode.commands as Record<string, unknown>).executeCommand = async (...args: unknown[]) => {
            calls.push(args);
            if (result instanceof Error) throw result;
            return result;
        };
        expect(await sendBillingIntent({ reason: 'credits_exhausted', requestId: REQUEST })).toBe(true);
        expect(await sendBillingIntent({ reason: 'model_locked', model: FLASH, requestId: 'not-a-uuid' })).toBe(true);
        expect(await sendBillingIntent({ reason: 'model_locked', model: 'Bad Alias' })).toBe(true);
        expect(calls).toEqual([['_ezil.billingIntent', { reason: 'credits_exhausted', requestId: REQUEST }],
            ['_ezil.billingIntent', { reason: 'model_locked', model: FLASH }], ['_ezil.billingIntent', { reason: 'model_locked' }]]);
        expect(await sendBillingIntent({ reason: 'topup' } as never)).toBe(false);
        expect(calls).toHaveLength(3);
        for (const answer of [undefined, 'true', 1, new Error('command not found')]) {
            result = answer;
            expect(await sendBillingIntent({ reason: 'credits_exhausted' })).toBe(false);
        }
        (fakeVscode.commands as Record<string, unknown>).executeCommand = async () => undefined;
    });
});

// The plan's limit is not availability: it outlives the five-minute cache and the 30 minutes a failed read still lists
// rows (CATALOG_STALE_MS), so a Free account keeps its locks and Flash default while /models cannot be read, and never
// gets a model its plan refuses. The clock is the system clock; every response is a fixture.
describe('the plan limit outlives the catalog', () => {
    const MIN = 60_000;
    type Mode = 'free' | 'paid' | 'down' | 'unreadable';
    const account = (mode: Mode = 'free') => {
        const state = { mode };
        const models = () => state.mode === 'free' ? free()() : state.mode === 'paid' ? paid()()
            : state.mode === 'unreadable' ? Response.json(catalog(ROWS), { headers: { [INCLUDED_MODELS_HEADER]: 'not an alias' } })
            : new Response('', { status: 503 });
        return { state, models };
    };
    const at = (start: number, minutes: number) => setSystemTime(new Date(start + minutes * MIN));
    const sent = (g: ReturnType<typeof gateway>) => g.posts.map(post => post.body.model);

    test('Free, 31 minutes on with the refresh failing: the locks and the Flash default stay, Qwen never returns', async () => {
        const a = account(); const g = gateway(a.models); const start = Date.now();
        try {
            expect(defaults(await list(g.provider))).toEqual([`ezil/${FLASH}`]);
            at(start, 10); a.state.mode = 'down';
            expect(locked(await list(g.provider))).toEqual([QWEN, KIMI, `ezil/${PRO}`]);
            at(start, 31);
            const infos = await list(g.provider);
            expect(infos.map(info => info.id)).toEqual([QWEN, KIMI, `ezil/${FLASH}`]);
            expect(locked(infos)).toEqual([QWEN, KIMI]);
            expect(defaults(infos)).toEqual([`ezil/${FLASH}`]);
            expect(infos.find(info => info.id === `ezil/${FLASH}`)).toMatchObject({ isUserSelectable: true, isDefault: true });
            at(start, 24 * 60);
            expect(defaults(await list(g.provider))).toEqual([`ezil/${FLASH}`]);
        } finally { setSystemTime(); }
        expect(g.posts).toHaveLength(0);
    });

    test('a refusal or the panel forgetting the catalog (forgetGatewayModels(baseUrl)) keeps the limit; a reload clears it', async () => {
        const a = account(); const g = gateway(a.models);
        await list(g.provider);
        a.state.mode = 'down';
        forgetGatewayModels(BASE);
        expect(locked(await list(g.provider))).toEqual([QWEN, KIMI]);
        forgetGatewayModels();
        expect(locked(await list(g.provider))).toEqual([]);
    });

    test('nothing is sent unchecked: past the expiry a locked model is refused here, a catalog-only Flash needs a read that succeeds now', async () => {
        const a = account(); const g = gateway(a.models); const start = Date.now();
        try {
            await list(g.provider);
            at(start, 31); a.state.mode = 'down';
            await expect(send(g.provider, QWEN)).rejects.toThrow(/is not included in your plan/);
            await expect(send(g.provider, KIMI)).rejects.toThrow(/is not included in your plan/);
            // Titles and summaries do not slip to Qwen on the strength of a catalog nobody can read.
            await expect(send(g.provider, QWEN, { requestInitiator: 'title' })).rejects.toThrow(/is not included in your plan/);
            await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow(/Could not load the model list/);
            a.state.mode = 'free';
            await send(g.provider, `ezil/${FLASH}`);
        } finally { setSystemTime(); }
        expect(sent(g)).toEqual([FLASH]);
        expect(g.intents).toEqual([]);
    });

    test('Flash unavailable at the last verified read: no default and no Flash row after the expiry, never another model', async () => {
        const a = { mode: 'free' as Mode };
        const g = gateway(() => a.mode === 'down' ? new Response('', { status: 503 })
            : free([row(QWEN), row(KIMI), row(FLASH, 'unavailable'), row(PRO)])());
        const start = Date.now();
        try {
            await list(g.provider);
            at(start, 31); a.mode = 'down';
            const infos = await list(g.provider);
            expect(infos.map(info => info.id)).toEqual([QWEN, KIMI]);
            expect(locked(infos)).toEqual([QWEN, KIMI]);
            expect(defaults(infos)).toEqual([]);
        } finally { setSystemTime(); }
    });

    test('a verified paid read (no header) clears the limit: nothing stays locked, and a saved paid choice is sent', async () => {
        const a = account(); const g = gateway(a.models); const start = Date.now();
        try {
            await list(g.provider);
            at(start, 31); a.state.mode = 'down';
            expect(locked(await list(g.provider))).toEqual([QWEN, KIMI]);
            at(start, 32); a.state.mode = 'paid';
            const infos = await list(g.provider);
            expect(locked(infos)).toEqual([]);
            expect(defaults(infos)).toEqual([`ezil/${FLASH}`]);
            await send(g.provider, QWEN);
            // The paid plan is not taken back by the next outage.
            at(start, 70); a.state.mode = 'down';
            expect(locked(await list(g.provider))).toEqual([]);
            await send(g.provider, KIMI);
        } finally { setSystemTime(); }
        expect(sent(g)).toEqual([QWEN, KIMI]);
    });

    test('a header that cannot be read is not a paid plan: the last verified limit stays; with none, nothing is inferred', async () => {
        const a = account(); const g = gateway(a.models);
        await list(g.provider);
        a.state.mode = 'unreadable';
        forgetGatewayModels(BASE);
        expect(locked(await list(g.provider))).toEqual([QWEN, KIMI, `ezil/${PRO}`]);
        forgetGatewayModels();
        expect(locked(await list(g.provider))).toEqual([]);
    });

    test('the limit belongs to one sign-in: another token starts without it, and never inherits Free\'s locks', async () => {
        const a = account(); const g = gateway(a.models); const start = Date.now();
        try {
            await list(g.provider);
            at(start, 31); a.state.mode = 'down';
            const other = gateway(a.models, ok, async () => true, 'synthetic-other-token');
            const infos = await list(other.provider);
            expect(locked(infos)).toEqual([]);
            expect(infos.map(info => info.id)).toEqual([QWEN, KIMI]);
            expect(locked(await list(g.provider))).toEqual([QWEN, KIMI]);
        } finally { setSystemTime(); }
    });

    test('choosing a locked model with the limit remembered and the re-read failing asks the OS with model_locked only', async () => {
        const a = account(); const g = gateway(a.models); const start = Date.now();
        try {
            await list(g.provider);
            at(start, 31); a.state.mode = 'down';
            const before = g.gets();
            expect(await g.provider.lockedModelChosen(QWEN)).toBe('asked');
            expect(g.gets()).toBe(before + 1);
        } finally { setSystemTime(); }
        expect(g.intents).toEqual([{ reason: 'model_locked', model: QWEN }]);
        expect(g.posts).toHaveLength(0);
    });

    test('a request-time read that shows the plan changed re-lists the picker, though no row changed', async () => {
        const a = account(); const g = gateway(a.models); const start = Date.now();
        try {
            await list(g.provider);
            const changes = g.changes();
            at(start, 6); a.state.mode = 'paid';
            await send(g.provider, `ezil/${FLASH}`);
            g.provider.refreshIfCatalogChanged(); // as extension.ts requestFinished wires it
            expect(g.changes()).toBeGreaterThan(changes);
            expect(locked(await list(g.provider))).toEqual([]);
        } finally { setSystemTime(); }
    });
});
