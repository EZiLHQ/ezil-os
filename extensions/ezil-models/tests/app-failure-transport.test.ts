import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { fakeVscode, TextPart } from './fixtures/fake-vscode';
import { gw } from './fixtures/gateway';
import { frames } from './fixtures/gateway-response';
import { forgetGatewayModels } from '../src/gateway';
import { isAppFailure, type AppFailure } from '../src/failure';
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
