import { describe, expect, test, spyOn } from 'bun:test';
import { gatewayChat, GATEWAY_FIRST_BYTE_TIMEOUT_MS, GATEWAY_IDLE_TIMEOUT_MS } from '../src/gateway';
import { ask, gw } from './fixtures/gateway';
import { frames } from './fixtures/gateway-response';

// Deterministic timers without sleeping or relying on AbortSignal.timeout's native clock.
async function fakeClock(check: (advance: (ms: number) => Promise<void>) => Promise<void>) {
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
        });
        expect(timers.size).toBe(0);
    } finally { timeout.mockRestore(); clear.mockRestore(); clock.mockRestore(); }
}

async function drain(fetchImpl: typeof fetch, signal = new AbortController().signal, stream = true) {
    for await (const _ of gatewayChat({ ...gw(), stream }, ask(), { fetch: fetchImpl, signal })) { /* drain */ }
}

describe('bounded gateway waits', () => {
    test('stalled headers time out at 30s, abort transport, and never retry', async () => fakeClock(async advance => {
        let calls = 0; let signal: AbortSignal | undefined;
        const result = drain((async (_url, init) => { calls++; signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); }) as typeof fetch).catch(error => error);
        await advance(GATEWAY_FIRST_BYTE_TIMEOUT_MS - 1);
        expect(signal?.aborted).toBe(false);
        await advance(1);
        expect((await result).code).toBe('first_byte_timeout');
        expect(signal?.aborted).toBe(true); expect(calls).toBe(1);
    }));
    for (const status of [200, 401]) test(`stalled ${status} first body byte uses remaining connect budget`, async () => fakeClock(async advance => {
        let reply!: (response: Response) => void;
        let cancelled = false;
        const result = drain((() => new Promise<Response>(resolve => { reply = resolve; })) as unknown as typeof fetch).catch(error => error);
        await advance(20_000);
        reply(new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { 'content-type': 'text/event-stream' } }));
        await advance(10_000);
        expect((await result).code).toBe('first_byte_timeout'); expect(cancelled).toBe(true);
    }));
    for (const stream of [true, false]) test(`${stream ? 'SSE' : 'JSON'} body idle timeout cancels after partial output`, async () => fakeClock(async advance => {
        let cancelled = false; let calls = 0;
        const result = drain((async () => {
            calls++;
            return new Response(new ReadableStream({
                start(c) { c.enqueue(new TextEncoder().encode(stream ? frames().slice(0, 3).join('') : '{')); },
                cancel() { cancelled = true; },
            }), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json', 'x-ezil-request-id': 'idle-test' } });
        }) as unknown as typeof fetch, undefined, stream).catch(error => error);
        await advance(GATEWAY_IDLE_TIMEOUT_MS);
        const error = await result;
        expect(error.code).toBe('stream_idle_timeout'); expect(error.message).toContain('Retry');
        expect(error.requestId).toBe('idle-test'); expect(cancelled).toBe(true); expect(calls).toBe(1);
    }));
    test('each arriving chunk resets stream idle budget', async () => fakeClock(async advance => {
        let push!: (text: string) => void;
        const result = drain((async () => new Response(new ReadableStream({ start(c) { push = text => c.enqueue(new TextEncoder().encode(text)); } }),
            { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch).catch(error => error);
        await advance(20_000); push(': heartbeat\n\n');
        await advance(20_000); push(': heartbeat\n\n');
        await advance(GATEWAY_IDLE_TIMEOUT_MS);
        expect((await result).code).toBe('stream_idle_timeout');
    }));
    test('caller cancellation interrupts a stalled read and clears timers', async () => fakeClock(async advance => {
        const abort = new AbortController();
        let cancelled = false;
        const result = drain((async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }),
            { headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof fetch, abort.signal);
        await advance(1); abort.abort(); await advance(0);
        await result; expect(cancelled).toBe(true);
    }));
});
