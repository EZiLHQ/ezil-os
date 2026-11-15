import { expect, expectTypeOf, it, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { InferenceTrace } from '../../../../extensions/ezil-models/src/inference-diagnostics';
import type { ChatRequest, Part } from '../../../../extensions/ezil-models/src/types';
import { prepareInferenceTrace, publishInferenceTrace } from '../../../../extensions/ezil-models/src/trace-publisher';
import { codeDiagBridgeScript } from '../../../../worker/src/code-diag-bridge';
import { create_ai_trace_collector } from '../../../../shell/ezil/ui/ai-traces.js';
import { aiTraceCommandSnippet } from '../../../../docs/ai-traces-command-snippet.mjs';
import { INFERENCE_VALIDATOR_SOURCE, validateInferenceTrace } from './contract.js';
import { parseBatch } from './schema';
import { queryTraces } from './admin';
import { TraceTable } from '../../app/admin/ai-traces/view';
const mocks = vi.hoisted(() => ({ context: vi.fn(), after: vi.fn<(work: () => Promise<void>) => void>() }));
vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@/server/api/trpc', () => ({ createTRPCContext: mocks.context }));
import { POST } from '../../app/api/shell/ai-traces/route';
const patch = readFileSync(new URL('../../../../worker/copilot-chat/patch-copilot-chat.sh', import.meta.url), 'utf8');
const registrationSource = patch.match(/^R_AI_REQUEST_TRACE='(.*)'$/m)![1]!;
const user = '30000000-0000-4000-8000-000000000001';
const nonce = 'AAAAAAAAAAAAAAAAAAAAAA';
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });

function produced(measured: boolean, count: number) {
    const calls: Part[] = Array.from({ length: count }, (_, i) => ({ type: 'tool_call', callId: `private-call-${i}`, name: 'read_file', input: { path: '/PRIVATE/file' } }));
    const results: Part[] = Array.from({ length: count }, (_, i) => ({ type: 'tool_result', callId: `private-call-${i}`, content: [{ type: 'text', value: 'PRIVATE result' }] }));
    const request: ChatRequest = { messages: [{ role: 'assistant', parts: calls }, { role: 'user', parts: [...results, { type: 'text', value: 'PRIVATE prompt' }] }], tools: [], toolMode: 'auto', modelOptions: {} };
    const trace = new InferenceTrace('gemini-4-carbon', request);
    for (let i = 0; i < count; i++) trace.event({ type: 'tool_call', callId: `private-next-${i}`, name: 'read_file', input: { path: '/PRIVATE/file' } });
    if (measured) trace.event({ type: 'usage', usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } });
    trace.transport({ clientRequestId: trace.record.requestId, gatewayRequestId: trace.record.turnId, offered: { read: 1, search: 0, write: 1, other: 0 }, attempts: 1, wireBytes: 123, totalWireBytes: 123, replayed: false });
    return trace.finish(false, false);
}

it('checked source parity connects publisher, production command, injected Worker and shared consumers', () => {
    expectTypeOf<import('./types').InferenceTrace>().toEqualTypeOf<import('../../../../extensions/ezil-models/src/inference-diagnostics').InferenceDiagnostic>();
    const source = readFileSync(new URL('../../../../extensions/ezil-models/src/trace-validator.js', import.meta.url), 'utf8').split('export ')[1]!.trim();
    expect(INFERENCE_VALIDATOR_SOURCE).toBe(source);
    expect(aiTraceCommandSnippet()).toBe(registrationSource);
    const flattened = source.split('\n').filter(line => !line.trim().startsWith('//')).map(line => line.trim()).join(' ').trim();
    expect(registrationSource).toContain('const validate=' + flattened + ';');
});

it.each([[false, 1], [true, 1], [false, 128], [true, 129]] as const)('actual producer → production command → Worker → nonce → shell POST → authenticated route → native ingest/query → admin (zero=%s count=%s)', async (measured, count) => {
    vi.useFakeTimers();
    const record = produced(measured, count), clean = prepareInferenceTrace(record)!;
    expect(clean).not.toBeNull(); expect(Object.keys(clean)).toHaveLength(30);
    expect(clean.requested.read).toBe(count); expect(clean.results).toEqual({ matched: count, error: 0, reportedSuccess: 0, unknown: count, unmatched: 0 });
    expect(clean.totalWireBytes).toBe(123); expect(clean.usage).toEqual(measured ? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } : null);
    if (count >= 128) { expect(record.toolCalls).toHaveLength(128); expect(record.toolResults).toHaveLength(128); expect(clean.observationsTruncated).toBe(true); expect(clean.toolCalls.length).toBeLessThan(128); }
    type Event = { type: string; detail?: string; source?: unknown; origin?: string; data?: unknown };
    type Listener = (event: Event) => void;
    const callbacks = new Map<string, (accessor: unknown, record: unknown) => void>();
    const shellListeners = new Map<string, Listener>(), childListeners = new Map<string, Listener>();
    const shell = { addEventListener: (k: string, fn: Listener) => shellListeners.set(k, fn), removeEventListener: (k: string) => shellListeners.delete(k) };
    const posted: unknown[] = [], events: Event[] = [];
    const child = { parent: { postMessage: (data: unknown) => { if ((data as { type?: string }).type === 'ezil.code.aiTrace') posted.push(data); shellListeners.get('message')?.({ type: 'message', data, source: child, origin: 'https://code.test' }); } }, addEventListener: (k: string, fn: Listener) => childListeners.set(k, fn), dispatchEvent: (event: Event) => { events.push(event); childListeners.get(event.type)?.(event); } };
    const iframe = { src: 'https://code.test/editor', contentWindow: child, isConnected: true, ownerDocument: { defaultView: shell } };
    // Execute the real parameterized ingest and query; only the database driver is a test double.
    let persisted: unknown[] = [];
    const db = { execute: vi.fn(async (query: SQL) => {
        const q = new PgDialect().sqlToQuery(query);
        if (q.sql.includes('INSERT INTO ezil_ai_request_traces')) {
            expect(q.params).toContain(user); expect(q.sql).not.toMatch(/billing|computer_id/);
            const payload = q.params.find(p => typeof p === 'string' && p.startsWith('[{'));
            expect(typeof payload).toBe('string'); persisted = JSON.parse(String(payload)); return [];
        }
        return persisted.map(metadata => ({ user_id: user, received_at: '2026-11-15T12:00:00Z', metadata }));
    }) };
    mocks.context.mockResolvedValue({ user: { id: user }, db });
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
        expect(init.credentials).toBe('same-origin');
        return POST(new Request('https://os.test/api/shell/ai-traces', init));
    });
    // Real timer signature, virtual clock; no incomplete typeof setTimeout mock.
    const collector = create_ai_trace_collector({ fetchImpl });
    const registration = collector.register(iframe, { origin: 'https://code.test' }); registration.bindNonce(nonce);
    const context = { window: child, TextEncoder, Date, CustomEvent: class { detail: string; constructor(public type: string, options: { detail: string }) { this.detail = options.detail; } }, qe: { registerCommand: (name: string, cb: (accessor: unknown, value: unknown) => void) => callbacks.set(name, cb) } };
    runInNewContext(codeDiagBridgeScript(['https://os.test']), context);
    runInNewContext(registrationSource, context);
    childListeners.get('message')?.({ type: 'message', source: child.parent, origin: 'https://os.test', data: { type: 'ezil.code.diag.hello', v: 1, nonce } });
    const dispatch = (value: unknown) => callbacks.get('_ezil.aiRequestTrace')!(null, value);
    const bad = { ...clean, prompt: 'PRIVATE' };
    expect(prepareInferenceTrace(bad)).toBeNull(); expect(validateInferenceTrace(bad)).toBeNull(); expect(parseBatch({ v: 1, traces: [bad] })).toBeNull();
    dispatch(bad); expect(events).toHaveLength(0);
    child.dispatchEvent({ type: 'ezil-ai-request-trace', detail: JSON.stringify(bad) }); expect(posted).toHaveLength(0);
    shellListeners.get('message')?.({ type: 'message', source: child, origin: 'https://code.test', data: { type: 'ezil.code.aiTrace', v: 1, nonce, trace: bad } });
    await collector.flush(); expect(fetchImpl).not.toHaveBeenCalled();
    await POST(new Request('https://os.test/api/shell/ai-traces', { method: 'POST', body: JSON.stringify({ v: 1, traces: [bad] }) })); expect(mocks.after).not.toHaveBeenCalled();
    publishInferenceTrace(record, (command, value) => { expect(command).toBe('_ezil.aiRequestTrace'); dispatch(value); });
    expect(posted).toHaveLength(1); expect(posted[0]).toEqual({ type: 'ezil.code.aiTrace', v: 1, nonce, trace: clean });
    expect(new TextEncoder().encode(JSON.stringify(posted[0])).byteLength).toBeLessThanOrEqual(4096);
    expect(JSON.stringify(posted[0])).not.toMatch(/PRIVATE|private-call|private-next/);
    await collector.flush(); expect(fetchImpl).toHaveBeenCalledTimes(1); expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.context.mock.calls.at(-1)![0].headers.get('x-trpc-source')).toBe('shell-http');
    await mocks.after.mock.calls[0]![0](); expect(persisted).toEqual([clean]);
    const result = await queryTraces(db, { email: 'founder', allowList: 'founder' }); expect(result.rows[0]?.trace).toEqual(clean);
    const html = renderToStaticMarkup(createElement(TraceTable, { rows: result.rows }));
    expect(html).toContain(record.requestId); expect(html).toContain(measured ? '0 / 0' : 'unknown / unknown'); expect(html).toContain('Verified file change: unknown');
    registration.dispose();
});

it('unsupported older commands and throwing observers cannot affect a completed producer record', async () => {
    const record = produced(false, 1), before = structuredClone(record);
    expect(() => publishInferenceTrace(record, () => { throw Error('unsupported command'); })).not.toThrow();
    publishInferenceTrace(record, () => Promise.reject(Error('unsupported command')));
    const commands = new Map<string, (accessor: unknown, value: unknown) => void>();
    runInNewContext(registrationSource, { TextEncoder, window: { dispatchEvent() { throw Error('observer'); } }, CustomEvent: class {}, qe: { registerCommand: (name: string, cb: (accessor: unknown, value: unknown) => void) => commands.set(name, cb) } });
    expect(() => publishInferenceTrace(record, (_command, clean) => commands.get('_ezil.aiRequestTrace')!(null, clean))).not.toThrow();
    await Promise.resolve(); await Promise.resolve(); expect(record).toEqual(before);
});
