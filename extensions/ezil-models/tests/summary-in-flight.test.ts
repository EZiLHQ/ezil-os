// Copilot's background compaction sends a summary request to the active model while the person keeps chatting.
// For Kimi that summary is JSON and took 45-90 s in the image mock A/B (lead scratch round3/round4 repro); the base
// build abandoned it at 30 s, so compaction never landed and the chat failed with "Conversation too large or invalid".
// These pin the transport side of that recovery, with no network and no model: a slow or fast summary in flight next
// to main turns, the bodies sent exactly as built (no silent truncation, tool calls and results still paired), and
// each of the three caches on its own (catalog, provider prompt cache, response cache).
import { describe, expect, spyOn, test } from 'bun:test';
import { forgetGatewayModels, gatewayChat, gatewayModels, GATEWAY_COMPLETION_TIMEOUT_MS, GATEWAY_MAX_IN_FLIGHT } from '../src/gateway';
import { buildGatewayBody, KIMI } from '../src/gateway-messages';
import type { ChatRequest, StreamEvent } from '../src/types';
import { ask, call, gw, marker, msg, result, tool, txt } from './fixtures/gateway';
import { finalUsage } from './fixtures/gateway-response';

// The same deterministic clock as gateway-timeouts.test.ts.
async function fakeClock(check: (advance: (ms: number) => Promise<void>, now: () => number) => Promise<void>) {
    let now = 0;
    let id = 0;
    const timers = new Map<number, { at: number; run: () => void }>();
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((run: () => void, ms = 0) => {
        const key = ++id; timers.set(key, { at: now + ms, run }); return key;
    }) as typeof setTimeout);
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation(((key: number) => { timers.delete(key); }) as typeof clearTimeout);
    const clock = spyOn(performance, 'now').mockImplementation(() => now);
    const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
    try {
        await check(async ms => {
            await flush();
            const until = now + ms;
            for (;;) {
                const next = [...timers].filter(([, timer]) => timer.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                now = next[1].at; timers.delete(next[0]); next[1].run(); await flush();
            }
            now = until; await flush();
        }, () => now);
        expect(timers.size).toBe(0);
    } finally { timeout.mockRestore(); clear.mockRestore(); clock.mockRestore(); }
}

const kimi = () => gw(KIMI); // JSON (Kimi is never streamed)
const SUMMARY = 'Summarize the conversation history so far, paying special attention to the most recent agent commands.';
const summaryAsk = (): ChatRequest => ask([msg('user', txt('Read a.ts')), msg('assistant', txt('It exports f.')), msg('user', txt(SUMMARY))]);
const reply = (text: string, usage: Record<string, number> = finalUsage) => new Response(JSON.stringify({ type: 'message', role: 'assistant',
    content: [{ type: 'text', text }], stop_reason: 'end_turn', usage }), { headers: { 'content-type': 'application/json', 'x-ezil-request-id': `r-${text}` } });

type Sent = { at: number; summary: boolean; key: string | null; body: string };
/** A Gateway stand-in: summaries answer after `summaryMs`, main turns after `mainMs`; it records every send and the peak in flight. */
function gateway(now: () => number, { summaryMs, mainMs = 3_000 }: { summaryMs: number; mainMs?: number }) {
    const sent: Sent[] = [];
    let inFlight = 0; let peak = 0;
    const fetch = (async (_url: string, init: RequestInit) => {
        const body = new TextDecoder().decode(init.body as Uint8Array);
        const summary = body.includes(SUMMARY);
        sent.push({ at: now(), summary, key: new Headers(init.headers).get('idempotency-key'), body });
        inFlight++; peak = Math.max(peak, inFlight);
        const ms = summary ? summaryMs : mainMs;
        if (!Number.isFinite(ms)) {
            return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => { inFlight--; reject(new DOMException('aborted', 'AbortError')); }));
        }
        await new Promise(resolve => setTimeout(resolve, ms));
        inFlight--;
        return reply(summary ? 'SUMMARY-OK' : `main-${sent.length}`);
    }) as unknown as typeof globalThis.fetch;
    return { fetch, sent, peak: () => peak };
}
async function run(model: ReturnType<typeof gw>, request: ChatRequest, fetch: typeof globalThis.fetch, extra: Omit<Parameters<typeof gatewayChat>[2], 'fetch' | 'signal'> = {}) {
    const events: StreamEvent[] = [];
    try {
        for await (const event of gatewayChat(model, request, { ...extra, fetch, signal: new AbortController().signal })) events.push(event);
        return { events, error: undefined as (Error & { code?: string; message: string }) | undefined };
    } catch (error) { return { events, error: error as Error & { code?: string } }; }
}
const texts = (events: StreamEvent[]) => events.filter(e => e.type === 'text').map(e => (e as { value: string }).value).join('');

describe('a summary in flight next to main turns (zero cost, mocked Gateway)', () => {
    for (const [label, summaryMs] of [['slow (90 s)', 90_000], ['slower than the old 30 s deadline (45 s)', 45_000], ['fast (2 s)', 2_000]] as const) {
        test(`${label}: the summary lands, main turns keep going beside it, never more than ${GATEWAY_MAX_IN_FLIGHT} in flight`, async () => fakeClock(async (advance, now) => {
            const g = gateway(now, { summaryMs });
            const summary = run(kimi(), summaryAsk(), g.fetch);
            await advance(1_000);
            const main1 = run(kimi(), ask([msg('user', txt('Read b.ts'))]), g.fetch);
            await advance(5_000);
            const main2 = run(kimi(), ask([msg('user', txt('Read c.ts'))]), g.fetch);
            await advance(Math.max(summaryMs, 10_000));
            const [s, m1, m2] = await Promise.all([summary, main1, main2]);
            expect(s.error).toBeUndefined();
            expect(texts(s.events)).toBe('SUMMARY-OK');
            expect(s.events.at(-1)?.type).toBe('stop');
            expect([m1.error, m2.error]).toEqual([undefined, undefined]);
            expect(g.sent.map(x => x.summary)).toEqual([true, false, false]); // each sent once: no resend, no retry
            expect(g.peak()).toBeLessThanOrEqual(GATEWAY_MAX_IN_FLIGHT);
        }));
    }

    test('a third call waits for a slot while a slow summary and a main turn hold both, then goes; nothing is dropped', async () => fakeClock(async (advance, now) => {
        const g = gateway(now, { summaryMs: 90_000, mainMs: 60_000 });
        const summary = run(kimi(), summaryAsk(), g.fetch);
        const main1 = run(kimi(), ask([msg('user', txt('Read b.ts'))]), g.fetch);
        await advance(1_000);
        const main2 = run(kimi(), ask([msg('user', txt('Read c.ts'))]), g.fetch);
        await advance(58_999);
        expect(g.sent.length).toBe(2); // main2 is queued, not sent
        await advance(1);
        expect(g.sent.map(x => [x.summary, x.at])).toEqual([[true, 0], [false, 0], [false, 60_000]]);
        await advance(90_000);
        const results = await Promise.all([summary, main1, main2]);
        expect(results.map(r => r.error)).toEqual([undefined, undefined, undefined]);
    }));

    test(`a summary slower than ${GATEWAY_COMPLETION_TIMEOUT_MS / 1000} s fails honestly (may still be charged), is never resent, and frees its slot`, async () => fakeClock(async (advance, now) => {
        const g = gateway(now, { summaryMs: Number.POSITIVE_INFINITY });
        const summary = run(kimi(), summaryAsk(), g.fetch);
        await advance(GATEWAY_COMPLETION_TIMEOUT_MS - 1);
        const before = await Promise.race([summary.then(() => 'settled'), Promise.resolve('pending')]);
        expect(before).toBe('pending');
        await advance(1);
        const s = await summary;
        expect(s.error?.code).toBe('completion_timeout');
        expect(s.error?.message).toContain('may still be charged');
        expect(g.sent.length).toBe(1);
        const main = run(kimi(), ask([msg('user', txt('Read d.ts'))]), g.fetch); // the slot is free again
        await advance(3_000);
        expect((await main).error).toBeUndefined();
        expect(g.sent.map(x => x.at)).toEqual([0, GATEWAY_COMPLETION_TIMEOUT_MS]);
    }));

    test('every body on the wire is exactly the request as built: no silent truncation, every tool call still has its result', async () => fakeClock(async (advance, now) => {
        const g = gateway(now, { summaryMs: 2_000 });
        const long = 'x'.repeat(40_000); // a large tool result, sent whole
        const agent: ChatRequest = { ...ask([msg('user', txt('Read three files.')),
            ...[1, 2, 3].flatMap(i => [msg('assistant', call(`call_${i}`, 'read_file', { path: `f${i}.ts` })), msg('user', result(`call_${i}`, [txt(i === 2 ? long : `file ${i}`)]))])]), tools: [tool] };
        const built: string[] = [];
        const onRequest = (_url: string, b: { bytes: Uint8Array }) => { built.push(new TextDecoder().decode(b.bytes)); };
        const summary = run(kimi(), summaryAsk(), g.fetch, { onRequest });
        const main = run(kimi(), agent, g.fetch, { onRequest });
        await advance(5_000);
        await Promise.all([summary, main]);
        expect(g.sent.map(x => x.body)).toEqual(built); // the wire carries the built bytes, unchanged
        expect(g.sent[1]!.body).toBe(new TextDecoder().decode(buildGatewayBody(kimi(), agent).bytes));
        const wire = JSON.parse(g.sent[1]!.body) as { messages: { role: string; content: { type: string; id?: string; tool_use_id?: string; content?: { text: string }[] }[] }[] };
        const uses = wire.messages.flatMap(m => m.content.filter(c => c.type === 'tool_use').map(c => c.id));
        const results = wire.messages.flatMap(m => m.content.filter(c => c.type === 'tool_result').map(c => c.tool_use_id));
        expect(uses).toEqual(['call_1', 'call_2', 'call_3']);
        expect(results).toEqual(uses);
        expect(g.sent[1]!.body).toContain(long);
    }));
});

describe('the three caches, one at a time', () => {
    test('1. catalog: one GET /models for a burst of turns within its TTL; a model_disabled refusal clears it for the next read', async () => {
        forgetGatewayModels();
        const provider = kimi().provider;
        let reads = 0;
        const catalog = { killswitch: false, pause: null, data: [{ id: KIMI, enabled: true, max_input_tokens: 131072, max_output_tokens: 4096 }] };
        const doFetch = (async (url: string) => {
            if (url.endsWith('/models')) { reads++; return new Response(JSON.stringify(catalog), { headers: { 'content-type': 'application/json' } }); }
            return new Response(JSON.stringify({ error: { code: 'model_disabled', message: 'disabled' } }), { status: 503, headers: { 'content-type': 'application/json' } });
        }) as unknown as typeof globalThis.fetch;
        for (const at of [0, 1_000, 90_000, 299_999]) await gatewayModels(provider, doFetch, at);
        expect(reads).toBe(1);
        const refused = await run(kimi(), summaryAsk(), doFetch);
        expect(refused.error?.code).toBe('model_disabled');
        await gatewayModels(provider, doFetch, 300_000 - 1);
        expect(reads).toBe(2); // cleared by the refusal, read again inside the old TTL
        forgetGatewayModels();
    });

    test('2. provider prompt cache: no cache marker reaches the wire, and a reply must carry both cache counters', async () => fakeClock(async (advance, now) => {
        const sent: string[] = [];
        let usage: Record<string, number> = finalUsage;
        const doFetch = (async (_url: string, init: RequestInit) => {
            sent.push(new TextDecoder().decode(init.body as Uint8Array));
            return reply('ok', usage);
        }) as unknown as typeof globalThis.fetch;
        const withMarker = ask([msg('user', txt('Hello'), marker), msg('assistant', txt('Hi'), marker), msg('user', txt(SUMMARY))]);
        const good = run(kimi(), withMarker, doFetch);
        await advance(0);
        const { events } = await good;
        expect(sent[0]).not.toContain('cache_control');
        expect(events.find(e => e.type === 'usage')).toMatchObject({ usage: { cacheReadTokens: finalUsage.cache_read_input_tokens, cacheWriteTokens: finalUsage.cache_creation_input_tokens } });
        usage = { input_tokens: 100, output_tokens: 8, cache_read_input_tokens: 3 }; // the write counter is missing
        const bad = run(kimi(), withMarker, doFetch);
        await advance(0);
        expect((await bad).error?.code).toBe('invalid_response');
        expect(now()).toBe(0);
    }));

    test('3. response cache: none. Two identical calls in flight get different idempotency keys and each gets its own reply', async () => fakeClock(async advance => {
        const keys: string[] = [];
        const doFetch = (async (_url: string, init: RequestInit) => {
            const key = new Headers(init.headers).get('idempotency-key') ?? '';
            keys.push(key);
            await new Promise(resolve => setTimeout(resolve, 2_000));
            return reply(`for-${key}`);
        }) as unknown as typeof globalThis.fetch;
        const a = run(kimi(), summaryAsk(), doFetch);
        const b = run(kimi(), summaryAsk(), doFetch);
        await advance(2_000);
        const [ra, rb] = await Promise.all([a, b]);
        expect(new Set(keys).size).toBe(2);
        expect([texts(ra.events), texts(rb.events)].sort()).toEqual(keys.map(k => `for-${k}`).sort());
    }));
});
