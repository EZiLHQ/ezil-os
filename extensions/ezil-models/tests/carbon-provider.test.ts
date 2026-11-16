import { afterEach, describe, expect, mock, test } from 'bun:test';
import { fakeVscode, TextPart, ThinkingPart, ToolCallPart, ToolResultPart, DataPart } from './fixtures/fake-vscode';
import { gw } from './fixtures/gateway';
import { forgetGatewayModels } from '../src/gateway';
import type { InferenceDiagnostic } from '../src/inference-diagnostics';
mock.module('vscode', () => fakeVscode);
const { EZiLModelsProvider, toInformation } = await import('../src/provider');
const carbon = 'gemini-4-carbon';
const message = (role: number, content: unknown[]) => ({ role, content });
const initial = [message(3, [new TextPart('system')]), message(1, [new TextPart('read two files')])];
const tools = ['read_file', 'replace_string_in_file'].map(name => ({ name, inputSchema: { type: 'object', properties: {} } }));
function token() { const callbacks: (() => void)[] = []; return { isCancellationRequested: false, onCancellationRequested(cb: () => void) { callbacks.push(cb); return { dispose() {} }; }, cancel() { this.isCancellationRequested = true; callbacks.forEach(cb => cb()); } }; }
const content = [
    { type: 'thinking', thinking: '', signature: 'ezil-gemini-v1:TextSig' }, { type: 'text', text: 'Reading.' },
    { type: 'thinking', thinking: '', signature: 'ezil-gemini-v1:ReadSigA' }, { type: 'tool_use', id: 'a', name: 'read_file', input: { path: 'a.ts' } },
    { type: 'thinking', thinking: '', signature: 'ezil-gemini-v1:ReadSigB' }, { type: 'tool_use', id: 'b', name: 'read_file', input: { path: 'b.ts' } },
    { type: 'thinking', thinking: '', signature: 'ezil-gemini-v1:TrailingSig' }, { type: 'text', text: '' },
];
function fixture(throwObserver = false) {
    forgetGatewayModels(); const model = { ...gw(carbon), stream: false }; const bodies: any[] = []; const records: InferenceDiagnostic[] = [];
    let fail = false;
    const host = { models: () => [model], secrets: () => [], logRequests: () => false, log() {}, configError: () => undefined, recordUsage() {},
        inferenceDiagnostic(record: InferenceDiagnostic) { records.push(record); if (throwObserver) throw new Error('optional observer'); },
        fetch: (async (url: unknown, init?: RequestInit) => {
            if (String(url).endsWith('/models')) return Response.json({ data: [{ id: model.model, enabled: true, max_input_tokens: 983040, max_output_tokens: 8192 }] });
            bodies.push(JSON.parse(new TextDecoder().decode(init!.body as Uint8Array)));
            if (fail) return Response.json({ error: { code: 'unsupported_gemini_request' } }, { status: 400 });
            return Response.json({ type: 'message', role: 'assistant', content: bodies.length === 1 ? content : [{ type: 'text', text: 'Done' }], stop_reason: bodies.length === 1 ? 'tool_use' : 'end_turn', usage: { input_tokens: 100, output_tokens: 10 } }, { headers: { 'x-ezil-request-id': `gw-${bodies.length}` } });
        }) as typeof fetch };
    const provider = new EZiLModelsProvider(host);
    async function send(messages: unknown[], session: string | null = 'session-a', cancellation = token(), onPart?: (part: unknown) => void) {
        const parts: unknown[] = [];
        await provider.provideLanguageModelChatResponse(toInformation(model), messages as never,
            { tools, modelOptions: session === null ? {} : { _conversationId: session } } as never,
            { report(part: unknown) { if (!(part instanceof DataPart)) parts.push(part); onPart?.(part); } }, cancellation as never);
        return parts;
    }
    return { model, bodies, records, provider, send, setFailure() { fail = true; } };
}
afterEach(() => { fakeVscode.LanguageModelThinkingPart = ThinkingPart; mock.module('vscode', () => fakeVscode); forgetGatewayModels(); });
describe('Carbon provider ordered replay', () => {
    for (const api of [true, false]) test(`exact ordered continuation with parallel calls, split messages and trailing empty text; ThinkingPart=${api}`, async () => {
        if (!api) mock.module('vscode', () => ({ ...fakeVscode, LanguageModelThinkingPart: undefined }));
        const f = fixture(); const parts = await f.send(initial);
        expect(parts.some(part => part instanceof ThinkingPart)).toBe(api);
        const continuation = [...initial, ...parts.map(part => message(2, [part])), message(1, [new ToolResultPart('b', [new TextPart('b')]), new ToolResultPart('a', [new TextPart('a')])])];
        await f.send(continuation);
        expect(f.bodies[1].messages[1].content).toEqual(content.slice(0, -2).filter(p => api || p.type !== 'thinking'));
        expect(f.records).toHaveLength(2); expect(f.records[1]!.thought_signature_replayed).toBe(api);
        expect(f.records[1]!.results).toMatchObject({ matched: 2, unknown: 2, reportedSuccess: 0 });
        expect(f.records[0]!.outcome).toBe('completed'); expect(f.records[0]!.requested.read).toBe(2);
        expect(JSON.stringify(f.records)).not.toMatch(/Reading|a\.ts|ReadSig|session-a/);
    });
    for (const change of ['model', 'provider', 'session', 'cancel', 'input', 'text', 'order', 'history', 'instance'] as const) test(`never reuses Gemini signatures after ${change} change`, async () => {
        const f = fixture(); const parts = await f.send(initial);
        let history = initial;
        if (change === 'model') f.model.model = 'gemini-4-argon';
        if (change === 'provider') f.model.provider = { ...f.model.provider, baseUrl: 'https://changed.invalid/ai/v1' };
        if (change === 'input') (parts.find(p => p instanceof ToolCallPart) as ToolCallPart).input = { path: 'different.ts' };
        if (change === 'text') (parts.find(p => p instanceof TextPart) as TextPart).value = 'Changed';
        if (change === 'order') parts.reverse();
        if (change === 'history') history = [message(1, [new TextPart('another request')])];
        if (change === 'cancel') { const c = token(); c.cancel(); await f.send(initial, 'session-a', c); }
        const active = change === 'instance' ? fixture() : f;
        await active.send([...history, message(2, parts), message(1, [new ToolResultPart('a', []), new ToolResultPart('b', [])])], change === 'session' ? 'session-b' : 'session-a');
        const body = active.bodies.at(-1);
        expect(body.messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.content).some((p: any) => p.type === 'thinking')).toBe(false);
    });
    test('missing API and missing session identity fails closed; native metadata proves the source turn', async () => {
        const f = fixture(); const parts = await f.send(initial, null);
        await f.send([...initial, message(2, parts), message(1, [new ToolResultPart('a', []), new ToolResultPart('b', [])])], null);
        expect(f.records[1]!.thought_signature_replayed).toBe(true);
        mock.module('vscode', () => ({ ...fakeVscode, LanguageModelThinkingPart: undefined }));
        const g = fixture(); const visible = await g.send(initial, null);
        await g.send([...initial, message(2, visible), message(1, [new ToolResultPart('a', []), new ToolResultPart('b', [])])], null);
        expect(g.records[1]!.thought_signature_replayed).toBe(false);
    });
    for (const session of [null, 'shared-faked-conversation']) test(`identical history/call IDs cannot replay without the returned token: ${session}`, async () => {
        const f = fixture(); const parts = await f.send(initial, session);
        for (const part of parts) if (part instanceof ThinkingPart) delete part.metadata?._ezilGeminiTurn;
        await f.send([...initial, message(2, parts), message(1, [new ToolResultPart('a', []), new ToolResultPart('b', [])])], session);
        expect(f.records[1]!.thought_signature_replayed).toBe(false);
        expect(f.bodies[1].messages.filter((m: any) => m.role === 'assistant').flatMap((m: any) => m.content).some((p: any) => p.type === 'thinking')).toBe(false);
    });
    test('throwing diagnostic observer preserves a completed response and local ring', async () => {
        const f = fixture(true); const parts = await f.send(initial);
        expect(parts.some(p => p instanceof ToolCallPart)).toBe(true);
        expect(f.records[0]!.outcome).toBe('completed');
        expect(f.provider.inferenceTrace.snapshot()[0]!.requestId).toBe(f.records[0]!.requestId);
    });
    test('cancelled partial reply is never stored, and every failed/cancelled request records diagnostics', async () => {
        const f = fixture(); const c = token();
        const parts = await f.send(initial, 'session-a', c, () => c.cancel());
        await f.send([...initial, message(2, parts), message(1, [new TextPart('continue')])]);
        expect(f.records[0]!.outcome).toBe('cancelled'); expect(f.records[1]!.thought_signature_replayed).toBe(false);
        f.setFailure(); await expect(f.send(initial)).rejects.toThrow();
        expect(f.records.at(-1)!.outcome).toBe('failed'); expect(f.provider.inferenceTrace.snapshot()).toHaveLength(3);
    });
});
