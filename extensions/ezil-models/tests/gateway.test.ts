import { afterEach, describe, expect, test } from 'bun:test';
import { chat } from '../src/client';
import { creditState, describeGatewayError, forgetGatewayModels, GatewayError, isSessionRefusal, parseErrorBody, readCredits } from '../src/gateway';
import { resolveEndpoint } from '../src/endpoints';
import type { ChatRequest, StreamEvent } from '../src/types';
import { frame, model } from './fixtures/load';

const BASE = 'https://8443-guac-a-b-code.ezil.org/ai/v1';
const PROXY_TOKEN = 'p'.repeat(64);
const gw = () => model({ id: 'ezil-code', model: 'ezil-code', family: 'gpt', maxInputTokens: 16_384, maxOutputTokens: 4096, capabilities: { toolCalling: true, imageInput: false }, cache: { enabled: false, ttl: '5m' } },
    { name: 'ezil', type: 'ezil-gateway', baseUrl: BASE, apiKey: PROXY_TOKEN });
const REQUEST: ChatRequest = { messages: [{ role: 'system', parts: [{ type: 'text', value: 'Be brief.' }] }, { role: 'user', parts: [{ type: 'text', value: 'hi' }] }], tools: [], toolMode: 'auto', modelOptions: {} };

const MODELS = { object: 'list', killswitch: false, pause: null, data: [{ id: 'ezil-code', enabled: true, max_input_tokens: 16384, max_output_tokens: 2048 }, { id: 'ezil-fast', enabled: true, max_input_tokens: 32768, max_output_tokens: 8192 }] };
const SSE_OK = [
    frame('response.created', { type: 'response.created', response: { id: 'resp_1' } }),
    frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'hello' }),
    frame('response.completed', { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } } }),
].join('');

type Call = { url: string; method: string; headers: Record<string, string>; body?: Uint8Array };

function server(responder: (call: Call, index: number) => Response | Promise<Response> | 'throw'): { fetch: typeof fetch; calls: Call[]; posts: () => Call[] } {
    const calls: Call[] = [];
    const doFetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const headers: Record<string, string> = {};
        new Headers(init?.headers).forEach((value, key) => { headers[key] = value; });
        const call: Call = { url: String(input), method: init?.method ?? 'GET', headers, body: init?.body instanceof Uint8Array ? init.body : undefined };
        calls.push(call);
        const out = await responder(call, calls.length - 1);
        if (out === 'throw') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        return out;
    }) as typeof fetch;
    return { fetch: doFetch, calls, posts: () => calls.filter(call => call.method === 'POST') };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const sse = (text = SSE_OK, headers: Record<string, string> = {}) => new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream; charset=utf-8', 'x-ezil-request-id': 'req-ok', ...headers } });

async function run(doFetch: typeof fetch, request = REQUEST, keys = ['turn-key-0001']): Promise<{ events: StreamEvent[]; logs: string[] }> {
    const events: StreamEvent[] = [];
    const logs: string[] = [];
    let k = 0;
    for await (const event of chat(gw(), request, {
        signal: new AbortController().signal,
        fetch: doFetch,
        log: line => logs.push(line),
        gateway: { newIdempotencyKey: () => keys[k++] ?? `extra-key-${k}`, sleep: async () => undefined },
    })) events.push(event);
    return { events, logs };
}

afterEach(() => forgetGatewayModels());

describe('ezil-gateway transport', () => {
    test('posts <baseUrl>/responses with the proxy token, one Idempotency-Key and no provider key', async () => {
        const s = server(call => call.url.endsWith('/models') ? json(200, MODELS) : sse());
        const { events } = await run(s.fetch);
        expect(events.map(event => event.type)).toEqual(['text', 'usage', 'stop']);
        const [post] = s.posts();
        expect(post!.url).toBe(`${BASE}/responses`);
        expect(post!.headers.authorization).toBe(`Bearer ${PROXY_TOKEN}`);
        expect(post!.headers['idempotency-key']).toBe('turn-key-0001');
        expect(post!.headers['content-type']).toBe('application/json');
        expect(Object.keys(post!.headers).sort()).toEqual(['accept', 'authorization', 'content-type', 'idempotency-key']);
        const body = JSON.parse(new TextDecoder().decode(post!.body));
        expect(body.max_output_tokens).toBe(2048); // clamped to the /v1/models cap
        expect(resolveEndpoint(gw().provider).url).toBe(`${BASE}/responses`);
    });

    test('mints a fresh UUID per turn by default', async () => {
        const s = server(call => call.url.endsWith('/models') ? json(200, MODELS) : sse());
        for (let i = 0; i < 2; i += 1) for await (const _ of chat(gw(), REQUEST, { signal: new AbortController().signal, fetch: s.fetch })) { /* drain */ }
        const keys = s.posts().map(post => post.headers['idempotency-key']);
        expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
        expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
        expect(keys[0]).not.toBe(keys[1]);
    });

    test('a transport failure before any response is retried ONCE with the same key and the same bytes', async () => {
        const s = server((call, i) => call.url.endsWith('/models') ? json(200, MODELS) : s.posts().length === 1 ? 'throw' : sse());
        await run(s.fetch);
        const posts = s.posts();
        expect(posts).toHaveLength(2);
        expect(posts[0]!.headers['idempotency-key']).toBe(posts[1]!.headers['idempotency-key']);
        expect(Buffer.from(posts[0]!.body!).equals(Buffer.from(posts[1]!.body!))).toBe(true);
    });

    test('two transport failures give up after the one retry', async () => {
        const s = server(call => call.url.endsWith('/models') ? json(200, MODELS) : 'throw');
        await expect(run(s.fetch)).rejects.toThrow('cannot reach EZiL AI');
        expect(s.posts()).toHaveLength(2);
    });

    test('after the retry a reservation that did commit answers 409: "already processed", no third attempt', async () => {
        const s = server(call => call.url.endsWith('/models') ? json(200, MODELS)
            : s.posts().length === 1 ? 'throw'
                : json(409, { error: { code: 'idempotency_replay', message: 'm', request_id: 'req-orig', status: 'reserved' } }, { 'x-ezil-request-id': 'req-this' }));
        await expect(run(s.fetch)).rejects.toThrow('already processed (request req-orig)');
        expect(s.posts()).toHaveLength(2);
    });

    test('a 5xx, a 402 or a 429 is never retried', async () => {
        for (const [status, code] of [[502, 'upstream_error'], [402, 'insufficient_credits'], [429, 'rate_limited'], [503, 'killswitch']] as const) {
            forgetGatewayModels();
            const s = server(call => call.url.endsWith('/models') ? json(200, MODELS) : call.url.endsWith('/me/balance') ? json(500, {}) : json(status, { error: { code, message: 'm', request_id: 'r' } }));
            await expect(run(s.fetch)).rejects.toBeInstanceOf(GatewayError);
            expect(s.posts()).toHaveLength(1);
        }
    });

    test('a session refusal waits for the next push, then retries ONCE with the same key and bytes', async () => {
        let session = false;
        const s = server(call => {
            if (call.url.endsWith('/models')) {
                if (s.calls.filter(c => c.url.endsWith('/models')).length >= 3) session = true; // the push lands during the wait
                return session ? json(200, MODELS) : json(401, { error: { code: 'os_session_missing', message: 'm' } });
            }
            return session ? sse() : json(401, { error: { code: 'os_session_missing', message: 'm', source: 'ezil-os-proxy' } });
        });
        const { events } = await run(s.fetch);
        expect(events.at(-1)).toEqual({ type: 'stop', reason: 'stop' });
        const posts = s.posts();
        expect(posts).toHaveLength(2);
        expect(posts[0]!.headers['idempotency-key']).toBe(posts[1]!.headers['idempotency-key']);
        expect(Buffer.from(posts[0]!.body!).equals(Buffer.from(posts[1]!.body!))).toBe(true);
    });

    test('a session that never comes back gives up with a re-auth message after one wait', async () => {
        const s = server(call => json(401, { error: { code: 'unauthorized', message: 'm', request_id: 'r' } }));
        await expect(run(s.fetch)).rejects.toThrow('session expired');
        expect(s.posts()).toHaveLength(1);
    });

    test('no_ezil_role is not waited for: the account needs setting up', async () => {
        const s = server(call => call.url.endsWith('/models') ? json(200, MODELS) : json(401, { error: { code: 'unauthorized', reason: 'no_ezil_role', message: 'm' } }));
        await expect(run(s.fetch)).rejects.toThrow('not set up for this account');
        expect(s.calls.filter(call => call.url.endsWith('/models'))).toHaveLength(1);
    });

    test('a 200 that is not an event stream, or a stream ending early, is an error (no retry under a new key)', async () => {
        const plain = server(call => call.url.endsWith('/models') ? json(200, MODELS) : json(200, { id: 'resp' }));
        await expect(run(plain.fetch)).rejects.toThrow('expected an event stream');
        const cut = server(call => call.url.endsWith('/models') ? json(200, MODELS) : sse(frame('response.output_text.delta', { type: 'response.output_text.delta', delta: 'x' })));
        await expect(run(cut.fetch)).rejects.toThrow('interrupted');
        expect(cut.posts()).toHaveLength(1);
    });

    test('logs carry request ids and keys, never the proxy token or the prompt', async () => {
        const s = server(call => call.url.endsWith('/models') ? json(200, MODELS) : sse());
        const { logs } = await run(s.fetch, { ...REQUEST, messages: [{ role: 'user', parts: [{ type: 'text', value: 'my secret prompt' }] }] });
        const text = logs.join('\n');
        expect(text).toContain('key=turn-key-0001');
        expect(text).toContain('request=req-ok');
        expect(text).toContain('response.id=resp_1');
        expect(text).not.toContain(PROXY_TOKEN);
        expect(text).not.toContain('my secret prompt');
    });

    test('works without /v1/models (falls back to the configured caps)', async () => {
        const s = server(call => call.url.endsWith('/models') ? json(503, {}) : sse());
        await run(s.fetch);
        expect(JSON.parse(new TextDecoder().decode(s.posts()[0]!.body)).max_output_tokens).toBe(4096);
    });
});

describe('error mapping by error.code (contract §8)', () => {
    const map = (status: number, error: Record<string, unknown>, retryAfter: string | null = null, balance?: Parameters<typeof describeGatewayError>[5]) =>
        describeGatewayError('ezil-code', status, retryAfter, parseErrorBody(JSON.stringify({ error })), 'req-h', balance);

    test('credits', () => {
        expect(map(402, { code: 'insufficient_credits', no_live_grant: true, available_micro: 0 }).message).toContain('no credits');
        expect(map(402, { code: 'insufficient_credits', no_live_grant: false, available_micro: 2_000_000, hold_micro: 9_000_000 }).message).toContain('not enough credits for this request');
        expect(map(402, { code: 'insufficient_credits' }, null, { available_micro: 0, held_micro: 0, grants: [] }).message).toBe('EZiL AI: no credits. AI credits are not included for this account.');
        expect(map(402, { code: 'insufficient_credits' }, null, { available_micro: 0, held_micro: 0, grants: [{ remaining_micro: 0, live: true }] }).message).toContain('You have used your included AI credits.');
        expect(map(402, { code: 'insufficient_credits' }, null, { available_micro: 0, held_micro: 5, grants: [{ remaining_micro: 0, live: true }] }).message).toContain('held by requests in progress');
    });

    test('pauses name their source', () => {
        expect(map(503, { code: 'killswitch', pause: 'reconciliation' }).message).toContain('AI paused (reconciliation)');
        expect(map(503, { code: 'killswitch', pause: 'operations' }).message).toContain('AI paused (operations)');
        expect(map(503, { code: 'killswitch' }).message).toContain('AI paused (operations)');
        expect(map(503, { code: 'global_cap_reached' }).message).toContain('AI paused');
    });

    test('limits carry Retry-After', () => {
        const rate = map(429, { code: 'rate_limited', limit: 30, window_seconds: 60 }, '60');
        expect(rate.message).toContain('try again in 60 s');
        expect(rate.retryAfterSeconds).toBe(60);
        const busy = map(429, { code: 'concurrency_limit', limit: 2 }, '5');
        expect(busy.message).toContain('wait for the current response');
        expect(busy.retryAfterSeconds).toBe(5);
    });

    test('size, auth, membership, replay and provider codes', () => {
        expect(map(413, { code: 'input_too_large', input_bound_tokens: 20000, max_input_tokens: 16384 }).message).toContain('prompt too large for ezil-code (20000 of 16384 allowed)');
        expect(map(413, { code: 'body_too_large' }).message).toContain('prompt too large');
        expect(map(401, { code: 'unauthorized', reason: 'expired' }).message).toContain('session expired');
        expect(map(401, { code: 'os_session_missing' }).message).toContain('session expired');
        expect(map(403, { code: 'not_a_member' }).message).toContain('not enabled for this account');
        expect(map(409, { code: 'idempotency_replay', request_id: 'req-orig' }).message).toContain('already processed (request req-orig)');
        expect(map(502, { code: 'upstream_error', request_id: 'req-p', status: 'pending' }).message).toContain('model provider unavailable (request req-p)');
        expect(map(400, { code: 'unsupported_parameter', param: 'body.metadata' }).message).toContain('EZiL Models bug');
        expect(map(418, { code: 'something_new' }).message).toContain('HTTP 418');
        expect(map(503, { code: 'brand_new_code' }).message).toContain('temporarily unavailable');
        // The request id falls back to the header when the body has none.
        expect(map(502, { code: 'upstream_error' }).requestId).toBe('req-h');
    });

    test('which refusals are worth waiting for a session push', () => {
        expect(isSessionRefusal(401, { code: 'unauthorized' })).toBe(true);
        expect(isSessionRefusal(401, { code: 'os_session_missing' })).toBe(true);
        expect(isSessionRefusal(403, { code: 'role_mismatch' })).toBe(true);
        expect(isSessionRefusal(401, { code: 'unauthorized', reason: 'no_ezil_role' })).toBe(false);
        expect(isSessionRefusal(401, { code: 'os_proxy_unauthorized' })).toBe(false);
        expect(isSessionRefusal(403, { code: 'not_a_member' })).toBe(false);
    });
});

describe('credit states (contract §7)', () => {
    const models = (over: Record<string, unknown> = {}) => ({ killswitch: false, pause: null, data: [{ id: 'ezil-code', enabled: true, max_input_tokens: 16384, max_output_tokens: 4096 }], ...over }) as Parameters<typeof creditState>[0];
    test('evaluated top to bottom', () => {
        expect(creditState(models({ killswitch: true, pause: 'reconciliation' }), undefined, 'ezil-code').state).toBe('paused_reconciliation');
        expect(creditState(models({ killswitch: true, pause: 'operations' }), { available_micro: 5e6, held_micro: 0, grants: [] }, 'ezil-code').state).toBe('paused_operations');
        expect(creditState(models({ data: [{ id: 'ezil-code', enabled: false, max_input_tokens: 1, max_output_tokens: 16 }] }), undefined, 'ezil-code').state).toBe('model_disabled');
        expect(creditState(models(), { available_micro: 0, held_micro: 0, grants: [{ remaining_micro: 0, live: true }] }, 'ezil-code').state).toBe('used');
        expect(creditState(models(), { available_micro: 0, held_micro: 0, grants: [{ remaining_micro: 7, live: false }] }, 'ezil-code').state).toBe('expired');
        expect(creditState(models(), { available_micro: 0, held_micro: 0, grants: [] }, 'ezil-code').state).toBe('not_included');
        expect(creditState(models(), { available_micro: 0, held_micro: 9, grants: [{ remaining_micro: 0, live: true }] }, 'ezil-code').state).toBe('held');
        expect(creditState(models(), { available_micro: 742_000_000, held_micro: 0, grants: [] }, 'ezil-code')).toEqual({ state: 'ok', text: 'AI credits: 742 remaining', credits: 742 });
    });

    test('readCredits reads /models (fresh) and /me/balance through the proxy', async () => {
        const s = server(call => call.url.endsWith('/models') ? json(200, MODELS) : json(200, { state: 'ok', available_micro: 3_500_000, held_micro: 0, grants: [{ remaining_micro: 3_500_000, live: true }] }));
        const credits = await readCredits(gw().provider, 'ezil-code', s.fetch);
        expect(credits.text).toBe('AI credits: 3 remaining');
        expect(s.calls.map(call => call.url).sort()).toEqual([`${BASE}/me/balance`, `${BASE}/models`]);
        for (const call of s.calls) expect(call.headers.authorization).toBe(`Bearer ${PROXY_TOKEN}`);
    });
});
