import { afterEach, describe, expect, test, spyOn } from 'bun:test';
import { readFileSync } from 'node:fs';
import { gatewayChat, GATEWAY_COMPLETION_TIMEOUT_MS, GATEWAY_FIRST_BYTE_TIMEOUT_MS, GATEWAY_IDLE_TIMEOUT_MS } from '../src/gateway';
import { KIMI } from '../src/gateway-messages';
import type { StreamEvent } from '../src/types';
import { ask, gw } from './fixtures/gateway';
import { frames, messageJson } from './fixtures/gateway-response';

// Deterministic timers without sleeping or relying on AbortSignal.timeout's native clock.
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

async function drain(fetchImpl: typeof fetch, signal = new AbortController().signal, stream = true) {
    for await (const _ of gatewayChat({ ...gw(), stream }, ask(), { fetch: fetchImpl, signal })) { /* drain */ }
}

describe('bounded gateway waits', () => {
    test('re-queueing after a concurrency refusal cannot extend the 60-second budget', async () => fakeClock(async (advance, now) => {
        const model = gw(); const signal = new AbortController().signal;
        let calls = 0; let finished = false;
        const fetch = (async () => {
            calls++;
            return calls === 1
                ? new Response(JSON.stringify({ error: { code: 'concurrency_limit' } }), { status: 429 })
                : new Response(frames().join(''), { headers: { 'content-type': 'text/event-stream' } });
        }) as unknown as typeof globalThis.fetch;
        const retry = (async () => {
            try { for await (const _ of gatewayChat(model, ask(), { signal, fetch, now })) { /* drain */ } }
            catch (error) { return error as Error; }
            finally { finished = true; }
        })();
        await advance(0);
        // Pause consumers after their first part, so two healthy responses hold slots across the deadline.
        const holders = [0, 1].map(() => gatewayChat(model, ask(), { signal, fetch, now }));
        try {
            await Promise.all(holders.map(g => g.next()));
            await advance(2000); expect(calls).toBe(3);
            await advance(57_999); expect(finished).toBe(false);
            await advance(1);
            expect((await retry)?.message).toBe('EZiL AI: Wait for the current response to finish');
            expect(calls).toBe(3); expect(finished).toBe(true);
        } finally { await Promise.all(holders.map(g => g.return(undefined))); }
    }));

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

describe('non-stream completion deadline (paired with the OS proxy)', () => {
    const kimiJson = () => new Response(JSON.stringify(messageJson()), { headers: { 'content-type': 'application/json', 'x-ezil-request-id': 'kimi-json' } });
    async function collect(model: ReturnType<typeof gw>, fetchImpl: typeof fetch, logs: string[] = [], signal = new AbortController().signal) {
        const events: StreamEvent[] = [];
        for await (const event of gatewayChat(model, ask(), { fetch: fetchImpl, signal, log: line => logs.push(line) })) events.push(event);
        return events;
    }
    test('one constant in both places, strictly below the Gateway 180 s upstream headers deadline', () => {
        const proxy = readFileSync(`${import.meta.dir}/../../../worker/src/ai-proxy.ts`, 'utf8');
        const value = /export const AI_PROXY_COMPLETION_TIMEOUT_MS = ([\d_]+);/.exec(proxy)?.[1];
        expect(Number(value?.replaceAll('_', ''))).toBe(GATEWAY_COMPLETION_TIMEOUT_MS);
        expect(GATEWAY_COMPLETION_TIMEOUT_MS).toBe(165_000);
        expect(GATEWAY_COMPLETION_TIMEOUT_MS).toBeLessThan(180_000);
        expect(GATEWAY_FIRST_BYTE_TIMEOUT_MS).toBe(30_000);
    });
    test('a Kimi JSON reply arriving at 45 s succeeds, once', async () => fakeClock(async advance => {
        let reply!: (response: Response) => void; let calls = 0;
        const result = collect({ ...gw(KIMI), stream: true }, (() => { calls++; return new Promise<Response>(resolve => { reply = resolve; }); }) as unknown as typeof fetch);
        await advance(45_000);
        reply(kimiJson());
        await advance(0);
        expect((await result).map(event => event.type)).toEqual(['text', 'thinking', 'tool_call', 'text', 'usage', 'stop']);
        expect(calls).toBe(1);
    }));
    test('no complete JSON reply within the bound fails with completion_timeout, aborts and never retries', async () => fakeClock(async advance => {
        let calls = 0; let signal: AbortSignal | undefined; const logs: string[] = [];
        const result = collect(gw(KIMI), (async (_url, init) => { calls++; signal = init?.signal ?? undefined; return new Promise<Response>(() => {}); }) as typeof fetch, logs).catch(error => error);
        await advance(GATEWAY_FIRST_BYTE_TIMEOUT_MS);
        expect(signal?.aborted).toBe(false);
        await advance(GATEWAY_COMPLETION_TIMEOUT_MS - GATEWAY_FIRST_BYTE_TIMEOUT_MS - 1);
        expect(signal?.aborted).toBe(false);
        await advance(1);
        const error = await result;
        expect([error.code, error.origin]).toEqual(['completion_timeout', 'transport']);
        expect(error.message).toBe('EZiL AI: no complete reply within 165 seconds, so EZiL Models stopped waiting (this model sends its reply only when it is complete). '
            + 'The request may still be charged if the model finished, never more than EZiL AI settles for it. You can retry or switch to a streaming model');
        expect(signal?.aborted).toBe(true); expect(calls).toBe(1);
        expect(JSON.parse(logs[0]!)).toMatchObject({ error_code: 'completion_timeout', origin: 'transport', stream: false });
    }));
    test('a JSON body that starts late must still finish by the same deadline', async () => fakeClock(async advance => {
        let cancelled = false;
        const result = collect(gw(KIMI), (async () => { await new Promise(resolve => setTimeout(resolve, 140_000)); return new Response(new ReadableStream({
            start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }), { headers: { 'content-type': 'application/json' } }); }) as unknown as typeof fetch).catch(error => error);
        await advance(140_000);
        await advance(GATEWAY_COMPLETION_TIMEOUT_MS - 140_000);
        expect((await result).code).toBe('completion_timeout'); expect(cancelled).toBe(true);
    }));
    describe('a transport resend shares the JSON deadline', () => {
        type Post = { at: number; key: string | null; body: unknown };
        // Each test's calls end with it, even when an assertion fails first, so none keeps an admission slot.
        let turn = new AbortController();
        afterEach(() => { turn.abort(); turn = new AbortController(); });
        // Transport failure (TypeError) of the first POST at `failAt`; later POSTs follow `then`.
        function failingThen(failAt: number, now: () => number, then: () => Promise<Response>) {
            const posts: Post[] = [];
            const fetch = (async (_url: string, init: RequestInit) => {
                posts.push({ at: now(), key: new Headers(init.headers).get('idempotency-key'), body: init.body });
                if (posts.length === 1) { await new Promise(resolve => setTimeout(resolve, failAt)); throw new TypeError('socket reset'); }
                return then();
            }) as unknown as typeof globalThis.fetch;
            return { posts, fetch };
        }
        // Read a result only once the fake clock has settled it, so a deadline that runs too long fails instead of hanging.
        function track<T>(promise: Promise<T>) {
            const state: { done: boolean; value?: T } = { done: false };
            void promise.then(value => { state.done = true; state.value = value; });
            return () => { expect(state.done).toBe(true); return state.value as T; };
        }
        const connectionLost = 'EZiL AI: the connection was lost while waiting for the complete reply (this model sends its reply only when it is complete), '
            + 'and EZiL AI may already have been running the request, so EZiL Models did not send it again. '
            + 'The request may still be charged if the model finished, never more than EZiL AI settles for it. You can retry or switch to a streaming model';

        test('a reject at 149 s is not resent: connection_lost at 149 s, one POST, no Retry wording', async () => fakeClock(async (advance, now) => {
            let at = -1; const logs: string[] = [];
            const s = failingThen(149_000, now, () => new Promise<Response>(() => {}));
            const result = track(collect(gw(KIMI), s.fetch, logs, turn.signal).catch(error => { at = now(); return error; }));
            await advance(149_000);
            const error = result();
            expect([error.code, error.origin, error.status, at]).toEqual(['connection_lost', 'transport', undefined, 149_000]);
            expect(error.message).toBe(connectionLost); expect(error.message).not.toContain('Retry the request');
            expect(s.posts).toHaveLength(1);
            expect(JSON.parse(logs[0]!)).toMatchObject({ error_code: 'connection_lost', origin: 'transport', stream: false, http_status: null });
            await advance(GATEWAY_COMPLETION_TIMEOUT_MS); expect(s.posts).toHaveLength(1);
        }));
        test('just past 30 s is not resent either; at 30 s it still is', async () => fakeClock(async (advance, now) => {
            const late = failingThen(GATEWAY_FIRST_BYTE_TIMEOUT_MS + 1, now, () => Promise.resolve(kimiJson()));
            const lost = track(collect(gw(KIMI), late.fetch, [], turn.signal).catch(error => error));
            await advance(GATEWAY_FIRST_BYTE_TIMEOUT_MS + 1);
            expect(lost().code).toBe('connection_lost'); expect(late.posts).toHaveLength(1);
            const edge = failingThen(GATEWAY_FIRST_BYTE_TIMEOUT_MS, now, () => Promise.resolve(kimiJson()));
            const resent = track(collect(gw(KIMI), edge.fetch, [], turn.signal).catch(error => error));
            await advance(GATEWAY_FIRST_BYTE_TIMEOUT_MS);
            expect(resent().at(-1)?.type).toBe('stop'); expect(edge.posts).toHaveLength(2);
        }));
        test('a reject at 10 s is resent once, with the same key and bytes, and the resend gets only what is left of 165 s', async () => fakeClock(async (advance, now) => {
            let signal: AbortSignal | undefined;
            const s = failingThen(10_000, now, () => new Promise<Response>(() => {}));
            const fetch = (async (url: string, init: RequestInit) => { signal = init.signal ?? undefined; return s.fetch(url, init); }) as unknown as typeof globalThis.fetch;
            let at = -1;
            const result = track(collect(gw(KIMI), fetch, [], turn.signal).catch(error => { at = now(); return error; }));
            await advance(10_000);
            expect(s.posts.map(post => post.at)).toEqual([0, 10_000]);
            expect(s.posts[1]!.key).toBe(s.posts[0]!.key); expect(s.posts[1]!.body).toBe(s.posts[0]!.body);
            await advance(GATEWAY_COMPLETION_TIMEOUT_MS - 10_000 - 1);
            expect(signal?.aborted).toBe(false);
            await advance(1);
            const error = result();
            expect([error.code, error.origin, at]).toEqual(['completion_timeout', 'transport', GATEWAY_COMPLETION_TIMEOUT_MS]);
            expect(signal?.aborted).toBe(true); expect(s.posts).toHaveLength(2);
        }));
        test('a resend whose headers arrive at 145 s must still finish its body by 165 s', async () => fakeClock(async (advance, now) => {
            let cancelled = false; let at = -1;
            const s = failingThen(10_000, now, async () => {
                await new Promise(resolve => setTimeout(resolve, 135_000));
                return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{')); }, cancel() { cancelled = true; } }),
                    { headers: { 'content-type': 'application/json', 'x-ezil-request-id': 'late-body' } });
            });
            const result = track(collect(gw(KIMI), s.fetch, [], turn.signal).catch(error => { at = now(); return error; }));
            await advance(145_000);
            await advance(GATEWAY_COMPLETION_TIMEOUT_MS - 145_000);
            const error = result();
            expect([error.code, error.requestId, at]).toEqual(['completion_timeout', 'late-body', GATEWAY_COMPLETION_TIMEOUT_MS]);
            expect(cancelled).toBe(true); expect(s.posts).toHaveLength(2);
        }));
        test('a resend still waiting for an admission slot at 165 s fails there and is never sent', async () => fakeClock(async (advance, now) => {
            const s = failingThen(10_000, now, () => new Promise<Response>(() => {}));
            let holderCalls = 0;
            const holderFetch = (async () => { holderCalls++; return new Response(frames().join(''), { headers: { 'content-type': 'text/event-stream' } }); }) as unknown as typeof fetch;
            let at = -1;
            const result = track(collect(gw(KIMI), s.fetch, [], turn.signal).catch(error => { at = now(); return error; }));
            await advance(0);
            // Two healthy streams paused after their first part: one takes the free slot, one queues and takes the
            // slot the failed send releases, so the resend has to queue behind them.
            const holders = [0, 1].map(() => gatewayChat(gw(), ask(), { signal: turn.signal, fetch: holderFetch }));
            try {
                const first = holders[0]!.next();
                await advance(0); await first;
                const second = holders[1]!.next();
                await advance(10_000); await second;
                expect(holderCalls).toBe(2);
                await advance(GATEWAY_COMPLETION_TIMEOUT_MS - 10_000);
                const error = result();
                expect([error.code, error.origin, at]).toEqual(['completion_timeout', 'transport', GATEWAY_COMPLETION_TIMEOUT_MS]);
                expect(s.posts).toHaveLength(1);
            } finally { await Promise.all(holders.map(g => g.return(undefined))); }
        }));
        test('a 429 refusal of the resend means nothing ran, so the attempt after it gets its own 165 s', async () => fakeClock(async (advance, now) => {
            let at = -1;
            const s = failingThen(10_000, now, async () => s.posts.length === 2
                ? new Response(JSON.stringify({ error: { code: 'concurrency_limit' } }), { status: 429, headers: { 'retry-after': '1' } })
                : new Promise<Response>(() => {}));
            const result = track(collect(gw(KIMI), s.fetch, [], turn.signal).catch(error => { at = now(); return error; }));
            await advance(11_000);
            expect(s.posts.map(post => post.at)).toEqual([0, 10_000, 11_000]);
            await advance(GATEWAY_COMPLETION_TIMEOUT_MS);
            const error = result();
            expect([error.code, at]).toEqual(['completion_timeout', 11_000 + GATEWAY_COMPLETION_TIMEOUT_MS]); expect(s.posts).toHaveLength(3);
        }));
        test('streams keep a fresh 30 s first-byte deadline per attempt', async () => fakeClock(async (advance, now) => {
            let at = -1;
            const s = failingThen(20_000, now, () => new Promise<Response>(() => {}));
            const result = track(collect(gw(), s.fetch, [], turn.signal).catch(error => { at = now(); return error; }));
            await advance(20_000 + GATEWAY_FIRST_BYTE_TIMEOUT_MS);
            const error = result();
            expect([error.code, at]).toEqual(['first_byte_timeout', 20_000 + GATEWAY_FIRST_BYTE_TIMEOUT_MS]); expect(s.posts).toHaveLength(2);
        }));
    });
    test('streaming still fails at 30 s without a first byte', async () => fakeClock(async advance => {
        let calls = 0;
        const result = collect(gw(), (async () => { calls++; return new Promise<Response>(() => {}); }) as unknown as typeof fetch).catch(error => error);
        await advance(GATEWAY_FIRST_BYTE_TIMEOUT_MS);
        const error = await result;
        expect([error.code, error.origin, error.message]).toEqual(['first_byte_timeout', 'transport', 'EZiL AI: did not answer within 30 seconds. Retry the request']);
        expect(calls).toBe(1);
    }));
});
