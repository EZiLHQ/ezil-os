import { describe, expect, test } from 'bun:test';
import { gatewayChat, GATEWAY_MAX_IN_FLIGHT, type GatewayOptions } from '../src/gateway';
import type { StreamEvent } from '../src/types';
import { ask, gw } from './fixtures/gateway';
import { frames, messageJson } from './fixtures/gateway-response';

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const refusal = (headers: HeadersInit = {}, code = 'concurrency_limit') => new Response(JSON.stringify({
    error: { code, message: 'private prompt and token must never appear' },
}), { status: 429, headers: { 'content-type': 'application/json', 'x-ezil-request-id': 'refused', ...headers } });
const success = () => new Response(frames().join(''), { headers: { 'content-type': 'text/event-stream' } });

async function drain(model: ReturnType<typeof gw>, fetch: typeof globalThis.fetch, key: string, options: Partial<GatewayOptions> = {}) {
    const events: StreamEvent[] = [];
    for await (const event of gatewayChat(model, ask(), {
        signal: new AbortController().signal, fetch, newIdempotencyKey: () => key,
        sleep: async () => { throw new Error('unexpected retry'); }, ...options,
    })) events.push(event);
    return events;
}

/** Headers arrive immediately, but each body stays in flight until explicitly finished/failed. */
function heldServer(stream = true, cap = GATEWAY_MAX_IN_FLIGHT) {
    let active = 0;
    let peak = 0;
    let refused = 0;
    const calls: string[] = [];
    const bodies = new Map<string, { controller: ReadableStreamDefaultController<Uint8Array>; settle: () => void }>();
    const fetch = (async (_url: unknown, init: RequestInit) => {
        const key = new Headers(init.headers).get('idempotency-key')!;
        calls.push(key);
        if (active >= cap) { refused++; return refusal(); }
        active++;
        peak = Math.max(peak, active);
        let settled = false;
        const settle = () => { if (!settled) { settled = true; active--; } };
        return new Response(new ReadableStream<Uint8Array>({
            start(controller) { bodies.set(key, { controller, settle }); },
            cancel() { settle(); },
        }), { headers: { 'content-type': stream ? 'text/event-stream' : 'application/json' } });
    }) as typeof globalThis.fetch;
    return {
        fetch, calls, active: () => active, peak: () => peak, refused: () => refused,
        finish(key: string) {
            const body = bodies.get(key)!;
            body.controller.enqueue(new TextEncoder().encode(stream ? frames().join('') : JSON.stringify(messageJson())));
            body.controller.close(); body.settle();
        },
        fail(key: string) { const body = bodies.get(key)!; body.controller.error(new Error('stream failed')); body.settle(); },
    };
}

describe('gateway FIFO admission', () => {
    for (const stream of [true, false]) test(`six parallel ${stream ? 'SSE' : 'JSON'} calls never exceed two, including body reads`, async () => {
        expect(GATEWAY_MAX_IN_FLIGHT).toBe(2);
        const s = heldServer(stream);
        const model = { ...gw(), stream };
        // Separate model/provider objects with identical wire identity must share a gate.
        const pending = Array.from({ length: 6 }, (_, i) => drain({ ...model, provider: { ...model.provider } }, s.fetch, String(i)));
        await flush(); expect(s.calls).toEqual(['0', '1']); expect(s.active()).toBe(2);
        for (let i = 0; i < 4; i++) {
            s.finish(String(i)); await flush();
            expect(s.calls).toEqual(Array.from({ length: i + 3 }, (_, n) => String(n)));
            expect(s.active()).toBe(2);
        }
        s.finish('4'); s.finish('5');
        const results = await Promise.all(pending);
        expect(results.every(events => events.some(e => e.type === 'stop'))).toBe(true);
        expect(s.peak()).toBe(2); expect(s.refused()).toBe(0); expect(s.active()).toBe(0);
    });

    test('queued abort resolves immediately, makes no fetch, and lets the next waiter proceed', async () => {
        const s = heldServer(); const model = gw(); const abort = new AbortController();
        const pending = ['0', '1'].map(key => drain(model, s.fetch, key));
        const cancelled = drain(model, s.fetch, 'cancelled', { signal: abort.signal });
        pending.push(drain(model, s.fetch, 'next'));
        await flush(); expect(s.calls).toEqual(['0', '1']);
        abort.abort(); expect(await cancelled).toEqual([]); expect(s.active()).toBe(2);
        s.finish('0'); await flush(); expect(s.calls).toEqual(['0', '1', 'next']);
        s.finish('1'); s.finish('next'); await Promise.all(pending);
        expect(s.peak()).toBe(2); expect(s.refused()).toBe(0);
    });

    test('abort after being granted a slot but before fetch releases the slot', async () => {
        const s = heldServer(); const model = gw(); const abort = new AbortController();
        const cancelled = drain(model, s.fetch, 'cancelled', { signal: abort.signal });
        abort.abort(); expect(await cancelled).toEqual([]);
        const pending = ['0', '1', '2'].map(key => drain(model, s.fetch, key));
        await flush(); expect(s.calls).toEqual(['0', '1']);
        s.finish('0'); await flush(); expect(s.calls).toEqual(['0', '1', '2']);
        s.finish('1'); s.finish('2'); await Promise.all(pending);
    });

    for (const mode of ['error', 'abort'] as const) test(`an active stream ${mode} releases its slot exactly once`, async () => {
        const s = heldServer(); const model = gw(); const abort = new AbortController();
        const first = drain(model, s.fetch, '0', { signal: abort.signal }).catch(error => error);
        const pending = ['1', '2', '3'].map(key => drain(model, s.fetch, key));
        await flush(); expect(s.calls).toEqual(['0', '1']);
        if (mode === 'error') s.fail('0'); else abort.abort();
        const result = await first;
        if (mode === 'error') expect(result.code).toBe('stream_interrupted'); else expect(result).toEqual([]);
        await flush(); expect(s.calls).toEqual(['0', '1', '2']); expect(s.active()).toBe(2);
        s.finish('1'); await flush(); expect(s.calls).toEqual(['0', '1', '2', '3']);
        s.finish('2'); s.finish('3'); await Promise.all(pending);
        expect(s.peak()).toBe(2); expect(s.refused()).toBe(0);
    });

    for (const different of ['baseUrl', 'apiKey'] as const) test(`different ${different} contexts have independent gates`, async () => {
        const s = heldServer(true, 4); const model = gw();
        const other = { ...model, provider: { ...model.provider, [different]: different === 'baseUrl' ? 'https://other.invalid/ai/v1' : 'other-synthetic-auth' } };
        const pending = [drain(model, s.fetch, '0'), drain(model, s.fetch, '1'), drain(other, s.fetch, '2'), drain(other, s.fetch, '3')];
        await flush(); expect(s.calls).toEqual(['0', '1', '2', '3']); expect(s.active()).toBe(4);
        for (const key of s.calls) s.finish(key);
        await Promise.all(pending); expect(s.refused()).toBe(0);
    });
});

describe('gateway concurrency refusal retries', () => {
    for (const succeed of [true, false]) test(`idle client ${succeed ? 'succeeds on the final retry' : 'exhausts 60 seconds with the existing error'}`, async () => {
        let now = 0; const waits: number[] = []; const calls: RequestInit[] = []; const logs: string[] = [];
        const fetch = (async (_url: unknown, init: RequestInit) => {
            calls.push(init);
            return succeed && now === 60_000 ? success() : refusal();
        }) as typeof globalThis.fetch;
        const result = drain(gw(), fetch, 'one-turn-key', {
            now: () => now, sleep: async ms => { waits.push(ms); now += ms; }, log: line => logs.push(line),
        });
        if (succeed) expect((await result).some(e => e.type === 'stop')).toBe(true);
        else await expect(result).rejects.toThrow('EZiL AI: Wait for the current response to finish (request refused)');
        expect(waits).toEqual([2000, 4000, 8000, 15000, 15000, 15000, 1000]);
        expect(now).toBe(60_000); expect(calls).toHaveLength(8);
        expect(calls.every(c => c.body === calls[0]!.body && new Headers(c.headers).get('idempotency-key') === 'one-turn-key')).toBe(true);
        expect(logs).toHaveLength(1); expect(logs.join()).not.toMatch(/Hello|synthetic-proxy-token|private prompt/);
        expect(JSON.parse(logs[0]!).error_code).toBe(succeed ? null : 'concurrency_limit');
    });

    for (const [hint, expected] of [['5', 5000], ['0', 1000], ['0.25', 1000], ['90', 15000], ['invalid', 2000],
        ['Thu, 22 Oct 2026 12:00:09 GMT', 9000], ['Thu, 22 Oct 2026 11:59:00 GMT', 1000]] as const) {
        test(`Retry-After ${hint} waits ${expected}ms then succeeds`, async () => {
            let calls = 0; let now = Date.parse('2026-10-22T12:00:00Z'); const waits: number[] = [];
            const fetch = (async () => ++calls === 1 ? refusal({ 'retry-after': hint }) : success()) as unknown as typeof globalThis.fetch;
            await drain(gw(), fetch, 'hint', { now: () => now, sleep: async ms => { waits.push(ms); now += ms; } });
            expect(waits).toEqual([expected]); expect(calls).toBe(2);
        });
    }

    test('clamped Retry-After exhausts the budget even with a stationary injected clock', async () => {
        let calls = 0; const waits: number[] = [];
        const fetch = (async () => { calls++; return refusal({ 'retry-after': '90' }); }) as unknown as typeof globalThis.fetch;
        await expect(drain(gw(), fetch, 'exhaust', { now: () => 0, sleep: async ms => { waits.push(ms); } })).rejects.toThrow('Wait for the current response to finish');
        expect(waits).toEqual([15000, 15000, 15000, 15000]); expect(calls).toBe(5);
    });

    test('retry releases its slot during sleep and rejoins behind existing waiters', async () => {
        const s = heldServer(); const model = gw(); let retries = 0; let resume!: () => void;
        let sleeping = false;
        const fetch = (async (url: unknown, init: RequestInit) => {
            if (new Headers(init.headers).get('idempotency-key') === 'retry' && retries++ === 0) return refusal();
            return s.fetch(url as string, init);
        }) as typeof globalThis.fetch;
        const retry = drain(model, fetch, 'retry', { sleep: async () => { sleeping = true; await new Promise<void>(r => { resume = r; }); } });
        const pending = ['0', '1', '2'].map(key => drain(model, fetch, key));
        await flush(); expect(sleeping).toBe(true); expect(s.calls).toEqual(['0', '1']);
        resume(); await flush(); expect(s.calls).toEqual(['0', '1']);
        s.finish('0'); await flush(); expect(s.calls).toEqual(['0', '1', '2']);
        s.finish('1'); await flush(); expect(s.calls).toEqual(['0', '1', '2', 'retry']);
        s.finish('2'); s.finish('retry'); await Promise.all([...pending, retry]);
        expect(s.peak()).toBe(2); expect(retries).toBe(2);
    });

    test('aborting a concurrency retry sleep never sends another request', async () => {
        const abort = new AbortController(); let calls = 0;
        const fetch = (async () => { calls++; return refusal(); }) as unknown as typeof globalThis.fetch;
        expect(await drain(gw(), fetch, 'abort-retry', { signal: abort.signal, sleep: async () => { abort.abort(); } })).toEqual([]);
        expect(calls).toBe(1);
    });

    test('rate_limited still retries once when the second attempt succeeds', async () => {
        let calls = 0; const waits: number[] = [];
        const fetch = (async () => ++calls === 1 ? refusal({}, 'rate_limited') : success()) as unknown as typeof globalThis.fetch;
        await drain(gw(), fetch, 'rate', { sleep: async ms => { waits.push(ms); } });
        expect(calls).toBe(2); expect(waits).toEqual([60000]);
    });

    test('late wakeup never retries beyond the admission deadline', async () => {
        let now = 0; let calls = 0;
        const fetch = (async () => { calls++; return refusal(); }) as unknown as typeof globalThis.fetch;
        await expect(drain(gw(), fetch, 'late', { now: () => now, sleep: async () => { now = 60_001; } })).rejects.toThrow('Wait for the current response to finish');
        expect(calls).toBe(1);
    });
});
