import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { fakeVscode, TextPart } from './fixtures/fake-vscode';
import { gw } from './fixtures/gateway';
import { frames } from './fixtures/gateway-response';
import { CATALOG_CONTRACT, forgetGatewayModels, GatewayError } from '../src/gateway';
import { isAppFailure, type AppFailure } from '../src/failure';
import { GATEWAY_ID, SENTINEL } from './fixtures/failure';
import type { ResolvedProvider } from '../src/config';
import { GatewayResponseError } from '../src/gateway-response';
import type { ProviderHost } from '../src/provider';

mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider } = await import('../src/provider');
const { sendAppFailure } = await import('../src/extension');

const commands = fakeVscode.commands as { executeCommand: (...args: unknown[]) => Promise<unknown> };
let previous: typeof commands.executeCommand;
let sent: unknown[][];
beforeEach(() => {
    forgetGatewayModels(); sent = []; previous = commands.executeCommand;
    commands.executeCommand = async (...args) => { sent.push(args); };
});
afterEach(() => { commands.executeCommand = previous; forgetGatewayModels(); });

function token() {
    const listeners = new Set<() => void>();
    return { isCancellationRequested: false,
        onCancellationRequested(fn: () => void) { listeners.add(fn); return { dispose() { listeners.delete(fn); } }; },
        cancel() { this.isCancellationRequested = true; for (const fn of listeners) fn(); },
    };
}
const complete = () => new Response(frames('end_turn').filter((_, i) => i < 4 || i > 7).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
const failed = () => Response.json({ error: { code: 'unauthorized', message: 'synthetic refusal' } }, { status: 401 });

function setup(answer: (init: RequestInit) => Response | Promise<Response>, sink: ProviderHost['appFailure'] = sendAppFailure, direct = false) {
    const model = gw();
    if (direct) model.provider = { ...model.provider, type: 'openai-compatible' };
    const cancellation = token();
    const progress: unknown[] = [], logs: string[] = [];
    let finished = 0;
    const provider = new EZiLModelsProvider({
        models: () => [model], configError: () => undefined, secrets: () => [], logRequests: () => false,
        log: line => logs.push(line), recordUsage() {}, requestFinished() { finished++; }, appFailure: sink,
        fetch: (async (url: unknown, init: RequestInit) => {
            if (String(url).endsWith('/models')) return Response.json({ object: 'list', data: [
                { id: model.model, enabled: true, protocols: ['anthropic-messages'] },
            ] });
            return answer(init);
        }) as typeof fetch,
    });
    const turn = () => provider.provideLanguageModelChatResponse({ id: model.id } as never,
        [{ role: 1, content: [new TextPart('synthetic prompt')] }] as never, { tools: [], modelOptions: {} } as never,
        { report: part => progress.push(part) }, cancellation as never);
    return { turn, cancellation, progress, logs, finished: () => finished };
}

describe('gateway outcome -> provider -> extension host command', () => {
    test('a failed turn sends exactly one canonical record', async () => {
        const b = setup(failed);
        await expect(b.turn()).rejects.toThrow();
        expect(sent).toHaveLength(1);
        expect(sent[0]![0]).toBe('_ezil.appFailure');
        expect(sent[0]).toHaveLength(2);
        expect(isAppFailure(sent[0]![1])).toBe(true);
        expect(sent[0]![1]).toMatchObject({ category: 'auth', outcome: 'failed' });
        expect(b.finished()).toBe(1);
        expect(JSON.stringify(sent)).not.toContain('synthetic prompt');
        expect(JSON.stringify(sent)).not.toContain('synthetic refusal');
    });
    test('a success sends nothing and retains its response', async () => {
        const b = setup(complete); await b.turn();
        expect(sent).toEqual([]); expect(b.progress.length).toBeGreaterThan(0); expect(b.finished()).toBe(1);
    });
    test('a Gateway stream failure is forwarded once, with the Gateway record and no outer duplicate', async () => {
        const b = setup(() => new Response(frames().slice(0, 2).join(''), {
            headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': GATEWAY_ID },
        }));
        await expect(b.turn()).rejects.toThrow();
        expect(sent).toHaveLength(1);
        expect(sent[0]![1]).toMatchObject({ category: 'interrupted', code: 'stream_interrupted', stage: 'stream',
            outcome: 'failed', gatewayRequestId: GATEWAY_ID, attempt: 1 });
        expect(isAppFailure(sent[0]![1])).toBe(true);
    });
    test('caller cancellation sends a neutral cancellation and does not reject the turn', async () => {
        let entered!: () => void;
        const pending = new Promise<void>(resolve => { entered = resolve; });
        const b = setup(init => new Promise<Response>((_, reject) => {
            init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true }); entered();
        }));
        const turn = b.turn(); await pending; b.cancellation.cancel(); await turn;
        expect(sent).toHaveLength(1); expect(isAppFailure(sent[0]![1])).toBe(true);
        expect(sent[0]![1]).toMatchObject({ category: 'cancellation', code: 'request_cancelled', outcome: 'cancelled', cancellationSource: 'caller' });
    });
    test('a rejected executeCommand changes neither the failed turn nor its logs', async () => {
        const normal = setup(failed);
        const normalError = await normal.turn().catch(error => error.message);
        commands.executeCommand = async (...args) => { sent.push(args); throw new Error('older editor has no command'); };
        const b = setup(failed);
        expect(await b.turn().catch(error => error.message)).toBe(normalError);
        await Promise.resolve();
        expect(sent).toHaveLength(2); expect(b.finished()).toBe(1);
        expect(b.logs.join('\n')).not.toContain('older editor');
    });
    test('a pending command is never awaited and a synchronous command throw is swallowed', async () => {
        commands.executeCommand = (...args) => { sent.push(args); return new Promise(() => {}); };
        await expect(setup(failed).turn()).rejects.toThrow();
        commands.executeCommand = () => { throw new Error('unavailable'); };
        await expect(setup(failed).turn()).rejects.toThrow();
        expect(sent).toHaveLength(1);
    });
    test('a throwing host sink cannot change the turn', async () => {
        const normal = await setup(failed).turn().catch(error => error.message);
        let calls = 0;
        const b = setup(failed, () => { calls++; throw new Error('sink failed'); });
        expect(await b.turn().catch(error => error.message)).toBe(normal); expect(calls).toBe(1);
    });
    test('legacy direct providers do not emit gateway outcomes', async () => {
        let calls = 0;
        const b = setup(failed, () => { calls++; }, true);
        await expect(b.turn()).rejects.toThrow(); expect(sent).toEqual([]); expect(calls).toBe(0);
    });
    test('the extension sink drops invalid records before executing a command', () => {
        const record: AppFailure = { eventId: 'a0000000-0000-4000-8000-000000000001', source: 'ezil_chat', operation: 'chat_request',
            category: 'network', code: 'network_failed', stage: 'request', outcome: 'failed' };
        for (const invalid of [undefined, null, {}, { ...record, extra: true }, { ...record, eventId: 'bad' }]) sendAppFailure(invalid);
        expect(sent).toEqual([]); sendAppFailure(record); expect(sent).toEqual([['_ezil.appFailure', record]]);
    });
});

describe('Gateway admission boundary', () => {
    function setupAdmission(type: ResolvedProvider['type'] = 'ezil-gateway', key = 'qwen.qwen3-coder-next') {
        const model = gw(key);
        model.provider = { ...model.provider, type };
        const state = { models: [model], configError: undefined as string | undefined, readError: undefined as Error | undefined,
            catalog: { contract: CATALOG_CONTRACT, data: [{ id: key, enabled: true, max_input_tokens: 131072, max_output_tokens: 8192,
                protocols: ['anthropic-messages'], availability: { state: 'available' } }] } as unknown };
        const cancellation = token();
        let posts = 0;
        const host: ProviderHost = {
            models: () => { if (state.readError) throw state.readError; return state.models; },
            configError: () => state.configError, secrets: () => [], logRequests: () => false,
            log() {}, recordUsage() {}, appFailure: sendAppFailure,
            fetch: (async (url: unknown) => {
                if (String(url).endsWith('/models')) return Response.json(state.catalog);
                posts++; return complete();
            }) as typeof fetch,
        };
        const provider = new EZiLModelsProvider(host);
        const info = { id: model.id };
        const list = () => provider.provideLanguageModelChatInformation({} as never, token() as never);
        const turn = (messages: unknown[] = [{ role: 1, content: [new TextPart(SENTINEL)] }], modelOptions = {}) =>
            provider.provideLanguageModelChatResponse(info as never, messages as never, { tools: [], modelOptions } as never,
                { report() {} }, cancellation as never);
        return { model, state, cancellation, host, provider, info, list, turn, posts: () => posts };
    }
    function admission(code = 'unexpected_error', cancelled = false) {
        expect(sent).toHaveLength(1);
        expect(sent[0]![0]).toBe('_ezil.appFailure');
        const record = sent[0]![1] as AppFailure;
        expect(isAppFailure(record)).toBe(true);
        expect(record).toMatchObject({ source: 'ezil_chat', operation: 'chat_request', stage: 'admission',
            outcome: cancelled ? 'cancelled' : 'failed', category: cancelled ? 'cancellation' : 'provider', code });
        for (const field of ['clientRequestId', 'gatewayRequestId', 'vscodeRequestId', 'attempt', 'message', 'path']) {
            expect(record).not.toHaveProperty(field);
        }
        expect(JSON.stringify(record)).not.toContain('PRIVATE');
        expect(JSON.stringify(record)).not.toContain('/config/');
        return record;
    }
    for (const failure of ['config load', 'removed model', 'unexpected config read'] as const) {
        test(`${failure} on a previously listed Gateway selection emits one admission record`, async () => {
            const b = setupAdmission();
            await b.list();
            b.state.models = [];
            if (failure === 'config load') b.state.configError = `${SENTINEL} /config/PRIVATE/models.json`;
            if (failure === 'unexpected config read') b.state.readError = new Error(`${SENTINEL} /config/PRIVATE/models.json`);
            await expect(b.turn()).rejects.toThrow();
            expect(admission().modelKey).toBe(b.model.model);
            expect(b.posts()).toBe(0);
        });
    }
    for (const unavailable of ['catalog', 'model'] as const) {
        test(`catalog-only selection: unavailable ${unavailable} maps to provider/model_unavailable`, async () => {
            const b = setupAdmission();
            b.info.id = 'ezil/anthropic.claude-sonnet-4-5';
            b.state.catalog = unavailable === 'catalog' ? null : { data: [] };
            await expect(b.turn()).rejects.toThrow();
            expect(admission('model_unavailable').modelKey).toBe('anthropic.claude-sonnet-4-5');
            expect(b.posts()).toBe(0);
        });
    }
    test('per-turn disabled catalog entry emits one model_unavailable admission record', async () => {
        const b = setupAdmission();
        b.state.catalog = { data: [{ id: b.model.model, enabled: false, max_input_tokens: 131072, max_output_tokens: 8192 }] };
        await expect(b.turn()).rejects.toThrow();
        admission('model_unavailable'); expect(b.posts()).toBe(0);
    });
    for (const code of ['catalog_unavailable', 'model_unavailable', 'model_disabled']) {
        test(`typed ${code} before resolution reads only the error code, never its text or request ID`, async () => {
            const b = setupAdmission(); await b.list();
            b.state.readError = new GatewayError(SENTINEL, undefined, code, GATEWAY_ID, undefined, 'local');
            await expect(b.turn()).rejects.toThrow();
            admission('model_unavailable'); expect(b.posts()).toBe(0);
        });
    }
    test('unexpected request conversion throw stays inside the admission boundary', async () => {
        const b = setupAdmission();
        await expect(b.turn([{ role: 1, get content() { throw new Error(SENTINEL); } }])).rejects.toThrow();
        admission(); expect(b.posts()).toBe(0);
    });
    test('a non-GatewayError before chat is always an unexpected provider admission failure', async () => {
        const b = setupAdmission(); await b.list();
        b.state.readError = new GatewayResponseError(GATEWAY_ID, 'stream_interrupted', 'stream_truncated');
        await expect(b.turn()).rejects.toThrow();
        admission(); expect(b.posts()).toBe(0);
    });
    test('unexpected utility model lookup throw stays inside the admission boundary', async () => {
        const b = setupAdmission(); let reads = 0;
        b.host.models = () => { if (++reads > 1) throw new Error(SENTINEL); return [b.model]; };
        await expect(b.turn(undefined, { requestInitiator: 'utility' })).rejects.toThrow();
        admission(); expect(b.posts()).toBe(0);
    });
    test('unsafe model key is omitted from an admission failure without dropping the record', async () => {
        const b = setupAdmission('ezil-gateway', 'us.unknownvendor.model-1'); await b.list();
        b.state.configError = SENTINEL; b.state.models = [];
        await expect(b.turn()).rejects.toThrow();
        expect(admission()).not.toHaveProperty('modelKey');
    });
    test('already cancelled caller emits one admission cancellation, no request or rejection', async () => {
        const b = setupAdmission(); b.cancellation.cancel(); await b.turn();
        expect(admission('request_cancelled', true).cancellationSource).toBe('caller');
        expect(b.posts()).toBe(0);
    });
    test('caller cancellation during the catalog read emits one admission cancellation', async () => {
        const b = setupAdmission(); let entered!: () => void;
        const pending = new Promise<void>(resolve => { entered = resolve; });
        b.host.fetch = (async (_url: unknown, init: RequestInit) => new Promise<Response>((_, reject) => {
            init.signal!.addEventListener('abort', () => reject(new Error(SENTINEL)), { once: true }); entered();
        })) as typeof fetch;
        const turn = b.turn(); await pending; b.cancellation.cancel(); await turn;
        expect(admission('request_cancelled', true).cancellationSource).toBe('caller');
        expect(b.posts()).toBe(0);
    });
    test('cancellation wins over a simultaneous config resolution failure', async () => {
        const b = setupAdmission(); await b.list();
        b.state.readError = new Error(SENTINEL); b.cancellation.cancel(); await b.turn();
        admission('request_cancelled', true);
    });
    test('an admission observer throwing still runs exactly once and preserves the original error', async () => {
        const b = setupAdmission(); await b.list(); b.state.readError = new Error(SENTINEL);
        let calls = 0;
        b.host.appFailure = record => { calls++; sendAppFailure(record); throw new Error('observer failed'); };
        await expect(b.turn()).rejects.toThrow(SENTINEL);
        expect(calls).toBe(1); admission();
    });
    for (const type of ['anthropic', 'openai-compatible'] as const) {
        for (const failure of ['config', 'conversion', 'cancellation'] as const) {
            test(`direct ${type} ${failure} emits nothing`, async () => {
                const b = setupAdmission(type); await b.list();
                if (failure === 'config') { b.state.models = []; b.state.configError = SENTINEL; }
                if (failure === 'cancellation') { b.cancellation.cancel(); await b.turn(); }
                else await expect(b.turn(failure === 'conversion' ? [{ get content() { throw new Error(SENTINEL); } }] : undefined)).rejects.toThrow();
                expect(sent).toEqual([]); expect(b.posts()).toBe(0);
            });
        }
    }
});
