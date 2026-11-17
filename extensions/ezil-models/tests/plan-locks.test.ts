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
// The OS proxy's answer to /models while the plan is unknown (worker/src/ai-proxy.ts).
const unknownPlan = () => Response.json({ error: { code: 'os_plan_unavailable', source: 'ezil-os-proxy' } }, { status: 503 });

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
        ['daily budget', 429, 'daily_budget_reached'], ['no entitlement (402)', 402, 'no_entitlement'],
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

    test('a used-up credit window never asks for credits (window_limit below)', async () => {
        const g = gateway(paid(), refusal(429, 'window_budget_reached', { budget_micro: '5000000', used_micro: '5000000', hold_micro: '400000', resets_at: null }));
        await list(g.provider);
        await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
        await Bun.sleep(0);
        expect(g.intents.some(intent => (intent as { reason?: string }).reason === 'credits_exhausted')).toBe(false);
        expect(warnings.mock.calls.flat()).not.toContain('Add credits');
    });
});

// A used-up EZiL AI credit window (`window_budget_reached`, the Gateway's docs/credit-window.md): a plan allowance apart
// from the wallet that no purchase lifts today. Never a credit refusal: Code asks the OS for `window_limit`, which opens
// no purchase. The 429 names budget, use and hold as decimal strings, and the reset (null when no window has started).
describe('a used-up credit window: window_limit, never a credit refusal', () => {
    const resetsAt = () => new Date(Date.now() + 90 * 60_000).toISOString();
    const windowRefusal = (fields: Row) => refusal(429, 'window_budget_reached', { retry_after_seconds: 5400, ...fields });

    test('on Free and on a paid plan: one window_limit with the reset, never credits_exhausted, at most once a minute', async () => {
        for (const plan of [free(), paid()]) {
            forgetGatewayModels();
            const reset = resetsAt();
            const g = gateway(plan, windowRefusal({ budget_micro: '5000000', used_micro: '4800000', hold_micro: '400000', resets_at: reset }));
            await list(g.provider);
            await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow(
                /used up\. Resets at .*Buying credits or changing plan does not lift this window right now\. A new chat or a smaller model uses fewer credits\. \(request/);   // 0.2 credits left floors to 0: no "0 credits are left" beside "used up"
            await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
            await Bun.sleep(0);
            expect(g.posts).toHaveLength(2);
            expect(g.intents).toEqual([{ reason: 'window_limit', requestId: REQUEST, resetsAt: reset }]);
            expect(warnings).not.toHaveBeenCalled();
        }
    });

    test('credits left in the window are whole and floored, and only named once at least one whole credit is left', async () => {
        forgetGatewayModels();
        const g = gateway(paid(), windowRefusal({ budget_micro: '5000000', used_micro: '2600000', hold_micro: '3000000', resets_at: resetsAt() }));
        await list(g.provider);
        await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow(/uses fewer credits; 2 credits are left in this window\./);
    });

    test('the reset as the OS proxy relays it (the Gateway database form) reaches the OS in toISOString form', async () => {
        // worker/src/ai-proxy.ts safeGatewayError relays the Gateway's own resets_at, e.g. 2026-11-09T21:05:33.123456+00:00.
        const at = Math.floor(Date.now() / 1000) * 1000 + 90 * 60_000 + 123;
        const database = new Date(at).toISOString().replace(/\.(\d{3})Z$/, '.$1456+00:00');
        const g = gateway(free(), windowRefusal({ budget_micro: '5000000', used_micro: '4800000', hold_micro: '400000', resets_at: database }));
        await list(g.provider);
        await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow(/Resets at /);
        await Bun.sleep(0);
        expect(g.intents).toEqual([{ reason: 'window_limit', requestId: REQUEST, resetsAt: new Date(at).toISOString() }]);
    });

    test('a request larger than the whole window, or one before any window started: no reset, and waiting is not offered', async () => {
        for (const fields of [{ budget_micro: '5000000', used_micro: '1000000', hold_micro: '6000000', resets_at: resetsAt() },
            { budget_micro: '5000000', used_micro: '0', hold_micro: '6000000', resets_at: null }, { resets_at: null }]) {
            forgetGatewayModels();
            const g = gateway(free(), windowRefusal(fields));
            await list(g.provider);
            const error = await send(g.provider, `ezil/${FLASH}`).then(() => undefined, (e: Error) => e);
            expect(error?.message).toContain('needs more EZiL AI credits than this window allows, so waiting will not make it fit. Buying credits or changing plan does not lift this window right now. A new chat or a smaller model uses fewer credits.');
            expect(error?.message).not.toContain('Resets at');
            await Bun.sleep(0);
            expect(g.intents).toEqual([{ reason: 'window_limit', requestId: REQUEST }]);
        }
    });

    test('nothing left in the window: the reset, and no smaller-request advice', async () => {
        const g = gateway(free(), windowRefusal({ budget_micro: '5000000', used_micro: '5000000', hold_micro: '400000', resets_at: resetsAt() }));
        await list(g.provider);
        const error = await send(g.provider, `ezil/${FLASH}`).then(() => undefined, (e: Error) => e);
        expect(error?.message).toMatch(/used up\. Resets at .*does not lift this window right now\.( \(request|$)/);
        expect(error?.message).not.toContain('smaller model');
    });

    test('outside an OS window, Code says the same itself, with no purchase or upgrade action', async () => {
        const g = gateway(free(), windowRefusal({ budget_micro: '5000000', used_micro: '4800000', hold_micro: '400000', resets_at: resetsAt() }), async () => false);
        await list(g.provider);
        await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow();
        await Bun.sleep(0); await Bun.sleep(0);
        expect(g.intents).toHaveLength(1);
        expect(warnings).toHaveBeenCalledTimes(1);
        expect(warnings.mock.calls[0]).toHaveLength(1);
        expect(String(warnings.mock.calls[0]![0])).toContain('does not lift this window right now');
        expect(opened).toEqual([]);
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

    test('the shared records (billing-intent-vectors.json): it sends each accepted one as the shell keeps it, and never one the shell refuses', async () => {
        const vectors = JSON.parse(readFileSync(`${import.meta.dir}/../../../worker/copilot-chat/billing-intent-vectors.json`, 'utf8')) as
            { accept: Array<{ record: Record<string, unknown>; expect: Record<string, unknown> }>; reject: Array<Record<string, unknown>> };
        // The shell's own receiver (plain JavaScript, no declarations).
        const receiver = new URL('../../../shell/ezil/ui/Settings/billing-recovery.js', import.meta.url).href;
        const { validate_billing_request } = await import(receiver) as { validate_billing_request: (value: unknown) => unknown };
        const calls: unknown[][] = [];
        (fakeVscode.commands as Record<string, unknown>).executeCommand = async (...args: unknown[]) => { calls.push(args); return true; };
        try {
            for (const { record, expect: kept } of vectors.accept) {
                calls.length = 0;
                expect(await sendBillingIntent(record as never)).toBe(true);
                expect(calls).toEqual([['_ezil.billingIntent', kept]]);
            }
            // A refused record is dropped or narrowed to what the shell accepts; what goes out always passes the shell.
            for (const record of vectors.reject) {
                calls.length = 0;
                await sendBillingIntent(record as never);
                for (const [, sent] of calls) {
                    expect(sent).not.toEqual(record);
                    expect(validate_billing_request(sent)).toEqual(sent);
                }
            }
        } finally { (fakeVscode.commands as Record<string, unknown>).executeCommand = async () => undefined; }
    });
});

// The plan's limit is not availability: it outlives the five-minute cache and the 30 minutes a failed read still lists
// rows (CATALOG_STALE_MS), so a Free account keeps its locks and Flash default while /models cannot be read, and never
// gets a model its plan refuses. The clock is the system clock; every response is a fixture.
describe('the plan limit outlives the catalog', () => {
    const MIN = 60_000;
    type Mode = 'free' | 'paid' | 'down' | 'unreadable' | 'unknown';
    const account = (mode: Mode = 'free') => {
        const state = { mode };
        const models = () => state.mode === 'free' ? free()() : state.mode === 'paid' ? paid()()
            : state.mode === 'unreadable' ? Response.json(catalog(ROWS), { headers: { [INCLUDED_MODELS_HEADER]: 'not an alias' } })
            : state.mode === 'unknown' ? unknownPlan() : new Response('', { status: 503 });
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

    test('choosing a locked model with the limit remembered and the re-read failing (an outage) asks nothing: the limit may predate an upgrade', async () => {
        const a = account(); const g = gateway(a.models); const start = Date.now();
        try {
            await list(g.provider);
            at(start, 31); a.state.mode = 'down';
            const before = g.gets();
            expect(await g.provider.lockedModelChosen(QWEN)).toBe('unconfirmed');
            expect(g.gets()).toBe(before + 1);
            expect(g.intents).toEqual([]);
            expect(notices.mock.calls.map(call => call.length)).toEqual([1]);
            expect(String(notices.mock.calls[0]![0])).toContain('could not confirm which models your plan includes');
            // A plain outage is not the proxy's unknown: the remembered locks stay listed as they were.
            expect(locked(await list(g.provider))).toEqual([QWEN, KIMI]);
            // Positive control: once a read succeeds and still excludes it, the upgrade is asked for.
            a.state.mode = 'free';
            expect(await g.provider.lockedModelChosen(QWEN)).toBe('asked');
        } finally { setSystemTime(); }
        expect(g.intents).toEqual([{ reason: 'model_locked', model: QWEN }]);
        expect(opened).toEqual([]);
        expect(g.posts).toHaveLength(0);
    });

    test('choosing a locked model while the proxy says the plan is unknown asks for no billing: a notice only, nothing selectable', async () => {
        const a = account(); const g = gateway(a.models); const start = Date.now();
        try {
            await list(g.provider);
            at(start, 31); a.state.mode = 'unknown';
            const before = g.gets();
            expect(await g.provider.lockedModelChosen(QWEN)).toBe('unconfirmed');
            expect(g.gets()).toBe(before + 1);
            // Neither an upgrade nor an unlock: the remembered limit's rows are listed, none selectable.
            expect(locked(await list(g.provider))).toEqual([QWEN, KIMI, `ezil/${FLASH}`]);
        } finally { setSystemTime(); }
        expect(g.intents).toEqual([]);
        expect(notices.mock.calls.map(call => call.length)).toEqual([1]);
        expect(String(notices.mock.calls[0]![0])).toContain('could not confirm which models your plan includes');
        expect(opened).toEqual([]);
        expect(g.posts).toHaveLength(0);
    });

    // The OS proxy answers /models 503 os_plan_unavailable while the plan is unknown (worker/src/ai-proxy.ts), never a
    // 200 without the header, which is a verified every-model plan.
    test('unknown after a verified Free read lists exactly the authoritative aliases, none selectable, nothing sent or asked', async () => {
        let plan: 'free' | 'unknown' | 'paid' = 'free';
        const g = gateway(() => plan === 'free' ? free(ROWS, `${FLASH},${QWEN},${KIMI}`)() : plan === 'unknown' ? unknownPlan() : paid()());
        let infos = await list(g.provider);
        expect(locked(infos)).toEqual([`ezil/${PRO}`]);
        expect(defaults(infos)).toEqual([`ezil/${FLASH}`]);
        plan = 'unknown';
        forgetGatewayModels(BASE);
        infos = await list(g.provider);
        // The retained limit decides only which rows are listed (exactly its aliases; the paid row not even as an
        // upgrade). The plan is unconfirmed now, so none is selectable or the default.
        expect(infos.map(info => info.id)).toEqual([QWEN, KIMI, `ezil/${FLASH}`]);
        expect(locked(infos)).toEqual([QWEN, KIMI, `ezil/${FLASH}`]);
        expect(defaults(infos)).toEqual([]);
        expect(infos.every(info => info.statusIcon?.id === 'question')).toBe(true);
        await expect(send(g.provider, QWEN)).rejects.toThrow(/could not confirm which models your plan includes/);
        await expect(send(g.provider, KIMI, { requestInitiator: 'title' })).rejects.toThrow(/could not confirm which models your plan includes/);
        await expect(send(g.provider, `ezil/${FLASH}`)).rejects.toThrow(/Could not load the model list/);
        for (const id of [QWEN, `ezil/${FLASH}`, `ezil/${PRO}`]) expect(await g.provider.lockedModelChosen(id)).toBe('unconfirmed');
        await Bun.sleep(0);
        expect(g.posts).toHaveLength(0);
        expect(g.intents).toEqual([]);
        expect(opened).toEqual([]);
        // A verified Free read restores the exact locks; a verified paid read clears them.
        plan = 'free';
        await g.provider.recoverCatalog();
        infos = await list(g.provider);
        expect(locked(infos)).toEqual([`ezil/${PRO}`]);
        expect(defaults(infos)).toEqual([`ezil/${FLASH}`]);
        plan = 'paid';
        forgetGatewayModels(BASE);
        expect(locked(await list(g.provider))).toEqual([]);
        expect(g.intents).toEqual([]);
        expect(g.posts).toHaveLength(0);
    });

    test('a first-ever unknown: configured models listed unconfirmed (nothing selectable, no default, no paid row), nothing sent or asked', async () => {
        let plan: 'unknown' | 'free' = 'unknown';
        const g = gateway(() => plan === 'unknown' ? unknownPlan() : free()());
        const infos = await list(g.provider);
        expect(infos.map(info => info.id)).toEqual([QWEN, KIMI]);
        expect(locked(infos)).toEqual([QWEN, KIMI]);
        expect(defaults(infos)).toEqual([]);
        for (const info of infos) {
            expect(info.statusIcon?.id).toBe('question');
            expect(info.infoText).toEqual({ [LOCKED_MODEL_INFO_KEY]: 'Your plan could not be confirmed yet. Choose it to check again.' });
        }
        // A saved pick, a title or a catalog-only id is refused here as unknown: no POST, retryable, never billing.
        await expect(send(g.provider, QWEN)).rejects.toThrow(/could not confirm which models your plan includes/);
        await expect(send(g.provider, KIMI, { requestInitiator: 'title' })).rejects.toThrow(/could not confirm which models your plan includes/);
        await expect(send(g.provider, `ezil/${PRO}`)).rejects.toThrow(/Could not load the model list/);
        // Choosing one re-reads the plan: still unknown, a notice only.
        expect(await g.provider.lockedModelChosen(QWEN)).toBe('unconfirmed');
        await Bun.sleep(0);
        expect(g.posts).toHaveLength(0);
        expect(g.intents).toEqual([]);
        expect(warnings).not.toHaveBeenCalled();
        expect(opened).toEqual([]);
        // Recoverable: the periodic re-read (recoverCatalog) of a verified Free plan re-lists with its real locks.
        plan = 'free';
        const changes = g.changes();
        await g.provider.recoverCatalog();
        expect(g.changes()).toBeGreaterThan(changes);
        const known = await list(g.provider);
        expect(locked(known)).toEqual([QWEN, KIMI, `ezil/${PRO}`]);
        expect(defaults(known)).toEqual([`ezil/${FLASH}`]);
        expect(known.every(info => info.statusIcon?.id !== 'question')).toBe(true);
    });

    test('unconfirmed is the proxy\'s word only: a plain outage or a direct Gateway error with no prior read keeps the configured models selectable', async () => {
        for (const models of [() => new Response('', { status: 503 }), refusal(503, 'upstream_unavailable'),
            () => Response.json({ error: { code: 'os_plan_unavailable' } }, { status: 503 })]) {
            forgetGatewayModels();
            const infos = await list(gateway(models).provider);
            expect(infos.map(info => info.id)).toEqual([QWEN, KIMI]);
            expect(locked(infos)).toEqual([]);
        }
    });

    test('a verified paid read after an unconfirmed one unlocks everything; unknown again is never inferred paid from the last catalog', async () => {
        const a = account('unknown'); const g = gateway(a.models); const start = Date.now();
        try {
            expect(locked(await list(g.provider))).toEqual([QWEN, KIMI]);
            a.state.mode = 'paid';
            expect(locked(await list(g.provider))).toEqual([]);
            await send(g.provider, QWEN);
            // Unknown drops the last paid catalog (a paid plan leaves no remembered limit): only the config is listed, none selectable.
            at(start, 6); a.state.mode = 'unknown';
            const infos = await list(g.provider);
            expect(infos.map(info => info.id)).toEqual([QWEN, KIMI]);
            expect(locked(infos)).toEqual([QWEN, KIMI]);
            await expect(send(g.provider, KIMI)).rejects.toThrow(/could not confirm which models your plan includes/);
        } finally { setSystemTime(); }
        expect(g.posts.map(post => post.body.model)).toEqual([QWEN]);
        expect(g.intents).toEqual([]);
    });

    test('an unknown /models read within the five minutes drops that token\'s cached paid catalog: the next plain read never answers paid', async () => {
        const a = account('paid'); const g = gateway(a.models);
        expect(locked(await list(g.provider))).toEqual([]);
        a.state.mode = 'unknown';
        // A fresh read (as the picker's re-check or the panel does) finds the plan unknown.
        expect(await g.provider.lockedModelChosen(QWEN)).toBe('unconfirmed');
        const gets = g.gets();
        const infos = await list(g.provider);
        expect(g.gets()).toBe(gets + 1);
        expect(infos.map(info => info.id)).toEqual([QWEN, KIMI]);
        expect(locked(infos)).toEqual([QWEN, KIMI]);
        await expect(send(g.provider, QWEN)).rejects.toThrow(/could not confirm which models your plan includes/);
        expect(g.posts).toHaveLength(0);
        expect(g.intents).toEqual([]);
    });

    test('a proxy os_plan_unavailable refusal after a cached paid read makes that token unconfirmed and re-lists; another token is untouched', async () => {
        const a = account('paid'); const g = gateway(a.models, refusal(503, 'os_plan_unavailable'));
        const other = gateway(paid(), ok, async () => true, 'synthetic-other-token');
        expect(locked(await list(g.provider))).toEqual([]);
        expect(locked(await list(other.provider))).toEqual([]);
        a.state.mode = 'unknown';
        const changes = g.changes();
        await expect(send(g.provider, QWEN)).rejects.toThrow(/could not confirm which models your plan includes/);
        expect(g.changes()).toBeGreaterThan(changes);
        // Nothing more is sent: the cached paid catalog no longer counts.
        await expect(send(g.provider, KIMI)).rejects.toThrow(/could not confirm which models your plan includes/);
        expect(g.posts.map(post => post.body.model)).toEqual([QWEN]);
        expect(locked(await list(g.provider))).toEqual([QWEN, KIMI]);
        expect(locked(await list(other.provider))).toEqual([]);
        await send(other.provider, QWEN);
        expect(other.posts.map(post => post.body.model)).toEqual([QWEN]);
        await Bun.sleep(0);
        expect(g.intents).toEqual([]);
        expect(warnings).not.toHaveBeenCalled();
    });

    test.each([
        ['a credit refusal', refusal(402, 'insufficient_credits', { available_micro: 0, hold_micro: 1200 }), { reason: 'credits_exhausted', requestId: REQUEST }],
        ['a used-up window', refusal(429, 'window_budget_reached', { budget_micro: '5000000', used_micro: '5000000', hold_micro: '400000', resets_at: null }),
            { reason: 'window_limit', requestId: REQUEST }],
    ] as const)('%s for a request begun while confirmed, answered after a fresh read found the same account unknown: a notice, no billing ask', async (_name, answer, intent) => {
        let release!: () => void;
        const held = new Promise<void>(resolve => { release = resolve; });
        const a = account('paid');
        const g = gateway(a.models, (() => held.then(() => answer())) as unknown as () => Response);
        const other = gateway(paid(), answer, async () => true, 'synthetic-other-token');
        await list(g.provider); await list(other.provider);
        const pending = send(g.provider, QWEN).then(() => undefined, (e: Error) => e);
        for (let i = 0; i < 100 && !g.posts.length; i++) await Bun.sleep(1);
        expect(g.posts).toHaveLength(1);
        // Meanwhile a fresh read (here the picker's re-check) finds this account's plan unknown.
        a.state.mode = 'unknown';
        expect(await g.provider.lockedModelChosen(QWEN)).toBe('unconfirmed');
        release();
        expect(await pending).toBeInstanceOf(Error);
        await Bun.sleep(0); await Bun.sleep(0);
        expect(g.intents).toEqual([]);
        // The refusal's own words still show, with no purchase action.
        expect(warnings).toHaveBeenCalledTimes(1);
        expect(warnings.mock.calls[0]).toHaveLength(1);
        expect(opened).toEqual([]);
        // Another account (another token) is confirmed: its refusal asks as before.
        await expect(send(other.provider, QWEN)).rejects.toThrow();
        await Bun.sleep(0);
        expect(other.intents).toEqual([intent]);
        // Positive control: confirmed again (a verified paid read), the same account's refusal asks, within the same minute.
        a.state.mode = 'paid';
        await expect(send(g.provider, QWEN)).rejects.toThrow();
        await Bun.sleep(0);
        expect(g.intents).toEqual([intent]);
        expect(g.posts).toHaveLength(2);
    });

    test('unknown to confirmed re-lists even when the confirmed catalog is byte-identical to what the picker listed', async () => {
        const exact = [row(QWEN), row(KIMI), row(FLASH, 'available', { name: 'Gemini 3.8 Flash' })];
        let plan: 'free' | 'unknown' = 'free';
        const g = gateway(() => plan === 'free'
            ? Response.json(catalog(exact, { default_model: null }), { headers: { [INCLUDED_MODELS_HEADER]: `${FLASH},${QWEN},${KIMI}` } }) : unknownPlan());
        expect(locked(await list(g.provider))).toEqual([]);
        plan = 'unknown';
        forgetGatewayModels(BASE);
        // Listed from the remembered limit, whose rows are exactly the catalog's: only the confirmation differs.
        expect(locked(await list(g.provider))).toEqual([QWEN, KIMI, `ezil/${FLASH}`]);
        plan = 'free';
        const changes = g.changes();
        await g.provider.recoverCatalog();
        expect(g.changes()).toBe(changes + 1);
        const infos = await list(g.provider);
        expect(locked(infos)).toEqual([]);
        expect(defaults(infos)).toEqual([`ezil/${FLASH}`]);
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
