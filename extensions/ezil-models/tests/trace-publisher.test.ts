import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { InferenceTrace, InferenceRing } from '../src/inference-diagnostics';
import { prepareInferenceTrace, publishInferenceTrace, validateInferenceTrace } from '../src/trace-publisher';
import { ask, msg, txt } from './fixtures/gateway';
const sample = () => new InferenceTrace('gemini-4-carbon', ask([msg('user', txt('PRIVATE prompt /file'))])).finish(false, false);
const patch = readFileSync(new URL('../../../worker/copilot-chat/patch-copilot-chat.sh', import.meta.url), 'utf8');
const registration = patch.match(/^R_AI_REQUEST_TRACE='(.*)'$/m)![1]!;
function renderer() {
    const events: { type: string; detail: string }[] = []; const commands = new Map<string, Function>();
    const window = { dispatchEvent: (e: any) => { events.push(e); } };
    runInNewContext(registration, { TextEncoder, window, CustomEvent: class { constructor(public type: string, public options: any) { Object.assign(this, options); } }, qe: { registerCommand: (id: string, f: Function) => commands.set(id, f) } });
    return { events, window, dispatch: (r: unknown) => commands.get('_ezil.aiRequestTrace')!({}, r) };
}
test('real terminal Carbon record publishes through the exact workbench command and retains correlation', () => {
    const r = sample(); const bridge = renderer();
    r.clientRequestId = r.requestId; r.gatewayRequestId = r.turnId; r.conversationId = 'a'.repeat(64);
    publishInferenceTrace(r, (command, clean) => { expect(command).toBe('_ezil.aiRequestTrace'); bridge.dispatch(clean); });
    expect(bridge.events).toHaveLength(1); expect(bridge.events[0]!.type).toBe('ezil-ai-request-trace');
    expect(JSON.parse(bridge.events[0]!.detail)).toEqual(r);
    expect(bridge.events[0]!.detail).not.toMatch(/PRIVATE|prompt|\/file/);
});
test('closed validator rejects malformed, private, extra, bad enum/bounds/UUID/nullable usage records at both boundaries', () => {
    const good = sample(); const bridge = renderer();
    const invalid = [null, [], {}, { ...good, toolCalls: new Array(2) }, ...['prompt','path','toolName','args','result','signature','secret','error','v'].map(k => ({ ...good, [k]: 'PRIVATE' })),
        { ...good, contract: 'ezil.inference.v2' }, { ...good, requestId: 'bad' }, { ...good, conversationId: 'raw-session' },
        { ...good, modelAlias: 'secret-key' }, { ...good, outcome: 'stalled' }, { ...good, finishReason: 'error text' },
        { ...good, durationMs: -1 }, { ...good, attempts: 0.5 }, { ...good, totalWireBytes: Infinity },
        { ...good, verifiedFileChange: true }, { ...good, usageSource: 'estimated' },
        { ...good, usage: { inputTokens: 0, outputTokens: 0 } }, { ...good, usageSource: 'provider_reported', usage: { inputTokens: null, outputTokens: 0 } },
        { ...good, requested: { ...good.requested, path: 'PRIVATE' } }, { ...good, compaction: { trigger: 'bad', count: 0, folded: 0, shortened: 0 } },
        { ...good, toolCalls: [{ call: 'a'.repeat(64), category: 'execute' }] },
        { ...good, toolResults: [{ call: 'a'.repeat(64), category: 'read', state: 'success' }] }];
    for (const r of invalid) { expect(validateInferenceTrace(r)).toBeNull(); bridge.dispatch(r); }
    expect(bridge.events).toHaveLength(0);
});
test('unknown usage/session/read counts are not fabricated as zero; measured zero stays zero', () => {
    const r = sample(); expect(validateInferenceTrace(r)?.usage).toBeNull(); expect(validateInferenceTrace(r)?.conversationId).toBeNull();
    const zero = { ...r, usageSource: 'provider_reported', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } };
    expect(validateInferenceTrace(zero)?.usage).toEqual(zero.usage); expect(validateInferenceTrace(zero)?.usage?.cacheWriteTokens).toBeUndefined();
});
test('large observations trim to the full nonce envelope budget without changing local ring or aggregate counts', () => {
    const t = new InferenceTrace('gemini-4-carbon', ask());
    for (let i = 0; i < 128; i++) t.event({ type: 'tool_call', callId: String(i), name: 'read_file', input: {} });
    const r = t.finish(false, false), ring = new InferenceRing(); ring.add(r);
    expect(validateInferenceTrace(r)).toBeNull(); const clean = prepareInferenceTrace(r)!;
    expect(clean.observationsTruncated).toBe(true); expect(clean.requested.read).toBe(128);
    expect(new TextEncoder().encode(JSON.stringify({ type: 'ezil.code.aiTrace', v: 1, nonce: 'a'.repeat(22), trace: clean })).byteLength).toBeLessThanOrEqual(4096);
    expect(ring.snapshot()[0]!.toolCalls).toHaveLength(128); const bridge = renderer(); bridge.dispatch(clean); expect(bridge.events).toHaveLength(1);
});
test('old command rejection, throws, hostile getters and throwing event observers are isolated', async () => {
    const r = sample(); let read = 0; const hostile = { ...r, get modelAlias() { read++; throw Error('private'); } };
    expect(validateInferenceTrace(hostile)).toBeNull(); expect(read).toBe(0);
    const bridge = renderer(); bridge.dispatch(hostile); expect(read).toBe(0);
    bridge.window.dispatchEvent = () => { throw Error('observer'); };
    expect(() => bridge.dispatch(r)).not.toThrow();
    expect(() => publishInferenceTrace(r, () => { throw Error('old command'); })).not.toThrow();
    publishInferenceTrace(r, () => Promise.reject(Error('old command'))); await Promise.resolve(); await Promise.resolve();
    const inherited = Object.assign(Object.create({ toJSON() { read++; throw Error('private'); } }), r);
    expect(validateInferenceTrace(inherited)).toEqual(r); expect(read).toBe(0);
});
test('renderer embeds the exact pure validator source', () => {
    const js = readFileSync(new URL('../src/trace-validator.js', import.meta.url), 'utf8').split('export ')[1]!;
    const flattened = js.split('\n').filter(line => !line.trim().startsWith('//')).map(line => line.trim()).join(' ').trim();
    expect(registration).toContain('const validate=' + flattened + ';');
});
