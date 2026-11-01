import { afterEach, describe, expect, test } from 'bun:test';
import { chat } from '../src/client';
import { creditState, describeGatewayError, forgetGatewayModels, gatewayChat, gatewayModels, parseErrorBody, readCredits } from '../src/gateway';
import { credits, creditsFloor2 } from '../src/credits-format';
import { KIMI } from '../src/gateway-messages';
import type { StreamEvent } from '../src/types';
import { ask, gw } from './fixtures/gateway';
import { frames, messageJson } from './fixtures/gateway-response';
import { localResetTime } from '../src/status-data';

const catalog = { data: [{ id: gw().id, enabled: true, max_input_tokens: 131072, max_output_tokens: 8192 }] };
const json = (value: unknown, status = 200, headers = {}) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'x-ezil-request-id': 'req-head', ...headers } });
const ok = (reason = 'end_turn') => new Response(frames(reason).join(''), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': 'req-ok', 'x-ezil-hold-micro': '1000' } });
const error = (status: number, code: string, extra = {}, headers = {}) => json({ type: 'error', error: { type: 'error', message: 'never log this prompt or token', code, ...extra } }, status, headers);
type Call = { url: string; init: RequestInit };
function server(reply: (call: Call, index: number) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[]; posts(): Call[] } {
    const calls: Call[] = [];
    return { calls, posts: () => calls.filter(c => c.init.method === 'POST'), fetch: (async (input: string | URL | Request, init: RequestInit = {}) => {
        const call = { url: String(input), init }; calls.push(call); return reply(call, calls.length - 1);
    }) as typeof fetch };
}
async function run(fetch: typeof globalThis.fetch, overrides: { model?: ReturnType<typeof gw>; sleep?: (ms: number, signal: AbortSignal) => Promise<void>; signal?: AbortSignal; logs?: string[] } = {}) {
    const events: StreamEvent[] = [];
    for await (const e of chat(overrides.model ?? gw(), ask(), { fetch, signal: overrides.signal ?? new AbortController().signal, log: s => overrides.logs?.push(s),
        gateway: { sleep: overrides.sleep ?? (async () => {}), newIdempotencyKey: () => 'fixed-key', now: () => 0 } })) events.push(e);
    return events;
}
function sameAttempt(calls: Call[]) {
    expect(calls).toHaveLength(2);
    expect(calls[0]!.init.body).toBe(calls[1]!.init.body);
    expect(new Headers(calls[0]!.init.headers).get('idempotency-key')).toBe(new Headers(calls[1]!.init.headers).get('idempotency-key'));
}
afterEach(() => forgetGatewayModels());

describe('gateway transport', () => {
    test('Messages endpoint, Bearer, exact safe headers; one metadata-only JSON log', async () => {
        const s = server(() => ok()); const logs: string[] = [];
        await run(s.fetch, { logs, model: { ...gw(), provider: { ...gw().provider, headers: { 'anthropic-beta': 'forbidden', 'x-api-key': 'forbidden' }, betas: ['forbidden'] } } });
        expect(s.calls).toHaveLength(1); expect(s.calls[0]!.url).toBe('https://proxy.invalid/ai/v1/messages');
        const headers = Object.fromEntries(new Headers(s.calls[0]!.init.headers));
        expect(headers).toEqual({ authorization: 'Bearer synthetic-proxy-token', 'content-type': 'application/json', accept: 'text/event-stream', 'idempotency-key': 'fixed-key' });
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]!)).toEqual({ request_id: 'req-ok', model: gw().id, stream: true, hold: '1000', http_status: 200, latency_ms: 0,
            usage: { input: 100, output: 8, cache_read: 3, cache_write: 4 }, stop_reason: 'end_turn', error_code: null });
        expect(logs.join()).not.toMatch(/Hello|synthetic-proxy-token|never log/);
    });
    test('Kimi always requests JSON and emits only after completion', async () => {
        const s = server(() => json(messageJson()));
        const events = await run(s.fetch, { model: { ...gw(KIMI), stream: true } });
        expect(JSON.parse(new TextDecoder().decode(s.posts()[0]!.init.body as Uint8Array)).stream).toBe(false);
        expect(new Headers(s.posts()[0]!.init.headers).get('accept')).toBe('application/json');
        expect(events.map(e => e.type)).toEqual(['text', 'thinking', 'tool_call', 'text', 'usage', 'stop']);
    });
    for (const stream of [true, false]) test(`clamped ${stream ? 'SSE' : 'JSON'} output logs one balance notice without changing events`, async () => {
        const s = server(() => {
            const response = stream ? ok() : json(messageJson());
            response.headers.set('x-ezil-output-limit-clamped', '512');
            response.headers.set('x-ezil-output-limit-requested', '8192');
            return response;
        });
        const logs: string[] = [];
        const events = await run(s.fetch, { logs, model: { ...gw(), stream } });
        expect(logs).toHaveLength(2);
        expect(logs[0]).toBe('Reply limited to 512 tokens to fit your credit balance');
        expect(JSON.parse(logs[1]!).error_code).toBeNull();
        expect(events).toEqual(await run(server(() => stream ? ok() : json(messageJson())).fetch, { model: { ...gw(), stream } }));
    });
    for (const [clamped, requested] of [[null, null], ['512', null], [null, '8192'], ['8192', '8192'], ['8193', '8192'],
        ['invalid', '8192'], ['512', 'invalid'], ['0', '8192'], ['-1', '8192'], ['1.5', '8192'], ['512', '8192.5'],
        ['512', 'Infinity'], ['9007199254740992', '9007199254740994']] as const) {
        test(`no clamp notice for headers ${clamped}/${requested}`, async () => {
            const s = server(() => {
                const response = ok();
                if (clamped !== null) response.headers.set('x-ezil-output-limit-clamped', clamped);
                if (requested !== null) response.headers.set('x-ezil-output-limit-requested', requested);
                return response;
            });
            const logs: string[] = [];
            await run(s.fetch, { logs });
            expect(logs).toHaveLength(1); expect(JSON.parse(logs[0]!).error_code).toBeNull();
        });
    }
    test('refusal headers do not report a clamped reply', async () => {
        const logs: string[] = [];
        const s = server(() => error(402, 'insufficient_credits', {}, { 'x-ezil-output-limit-clamped': '512', 'x-ezil-output-limit-requested': '8192' }));
        await expect(run(s.fetch, { logs })).rejects.toThrow('Not enough AI credits');
        expect(logs).toHaveLength(1); expect(JSON.parse(logs[0]!).error_code).toBe('insufficient_credits');
    });
    test('one fresh UUID per provider call', async () => {
        const s = server(() => ok());
        for (let i = 0; i < 2; i++) for await (const _ of gatewayChat(gw(), ask(), { signal: new AbortController().signal, fetch: s.fetch })) { /* drain */ }
        const keys = s.posts().map(c => new Headers(c.init.headers).get('idempotency-key'));
        expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/); expect(keys[0]).not.toBe(keys[1]);
    });
    test('transport failure before headers retries once with identical key and bytes', async () => {
        const s = server((_, i) => { if (i === 0) throw new Error('transport secret'); return ok(); });
        await run(s.fetch); sameAttempt(s.posts());
    });
    test('two pre-header failures stop; committed retry can return replay', async () => {
        const failed = server(() => { throw new Error('transport'); });
        await expect(run(failed.fetch)).rejects.toThrow('cannot reach'); expect(failed.posts()).toHaveLength(2);
        const replay = server((_, i) => { if (i === 0) throw new Error('transport'); return error(409, 'idempotency_replay', { request_id: 'original' }); });
        await expect(run(replay.fetch)).rejects.toThrow('already processed (request original)'); sameAttempt(replay.posts());
    });
    for (const status of [401, 403]) for (const code of ['unauthorized', 'os_session_missing', 'os_proxy_unauthorized', 'no_ezil_role']) {
        test(`${status} ${code} fails immediately without polling or retry`, async () => {
            const waits: number[] = [];
            const s = server(() => error(status, code, { reason: 'wrong_issuer' }));
            await expect(run(s.fetch, { sleep: async ms => { waits.push(ms); } })).rejects.toThrow();
            expect(s.calls).toHaveLength(1);
            expect(waits).toEqual([]);
        });
    }
    for (const extra of [{ code: 'no_ezil_role' }, { code: 'unauthorized', reason: 'no_ezil_role' }, { code: 'os_session_missing', status: 'pending' }, { code: 'unknown_auth' }]) test(`no session retry for ${JSON.stringify(extra)}`, async () => {
        const s = server(() => error(401, extra.code, extra)); await expect(run(s.fetch)).rejects.toThrow(); expect(s.posts()).toHaveLength(1);
    });
    test('401 with hold is never retried', async () => {
        const s = server(() => error(401, 'os_session_missing', {}, { 'x-ezil-hold-micro': '1' }));
        await expect(run(s.fetch)).rejects.toThrow(); expect(s.posts()).toHaveLength(1);
    });
    test('429 rate_limited one capped wait and same-key retry', async () => {
        const waits: number[] = []; const s = server(() => error(429, 'rate_limited', {}, { 'retry-after': '90' }));
        await expect(run(s.fetch, { sleep: async ms => { waits.push(ms); } })).rejects.toThrow();
        sameAttempt(s.posts()); expect(waits).toEqual([60000]);
    });
    for (const model of [gw(), gw(KIMI)]) test(`429 window_budget_reached ends ${model.id} without waiting or retrying`, async () => {
        const waits: number[] = [];
        const s = server(() => error(429, 'window_budget_reached', {}, { 'retry-after': '7200' }));
        await expect(run(s.fetch, { model, sleep: async ms => { waits.push(ms); } })).rejects.toThrow(
            `This window's EZiL AI credits are used up. Resets at ${localResetTime(new Date(7200000))}`);
        expect(s.calls).toHaveLength(1);
        expect(waits).toEqual([]);
    });
    for (const [status, code] of [[409, 'idempotency_replay'], [504, 'upstream_timeout'], [500, 'internal_error'], [503, 'no_provider_route'], [429, 'tpm_limited'], [429, 'daily_budget_reached']] as const) test(`no retry ${status} ${code}`, async () => {
        const s = server(() => error(status, code)); await expect(run(s.fetch)).rejects.toThrow(); expect(s.posts()).toHaveLength(1);
    });
    test('mixed failures cannot stack retries', async () => {
        const s = server((_, i) => { if (i === 0) throw new Error('transport'); return error(429, 'rate_limited'); });
        await expect(run(s.fetch)).rejects.toThrow(); sameAttempt(s.posts());
    });
    test('error-body failure after headers is not a pre-header retry', async () => {
        const s = server(() => new Response(new ReadableStream({ start(c) { c.error(new Error('body broke')); } }), { status: 401, headers: { 'x-ezil-request-id': 'body-fail' } }));
        await expect(run(s.fetch)).rejects.toThrow('request body-fail'); expect(s.posts()).toHaveLength(1);
    });
    test('interrupted SSE is never retried', async () => {
        const s = server(() => new Response(frames().slice(0, -1).join(''), { headers: { 'content-type': 'text/event-stream', 'x-ezil-request-id': 'partial' } }));
        await expect(run(s.fetch)).rejects.toThrow('interrupted (request partial)'); expect(s.posts()).toHaveLength(1);
    });
    test('truncation surfaces notice and preserves usage without continuation', async () => {
        const logs: string[] = []; const s = server(() => ok('max_tokens'));
        await expect(run(s.fetch, { logs })).rejects.toThrow('Response truncated (request req-ok)');
        expect(s.posts()).toHaveLength(1); expect(JSON.parse(logs[0]!).stop_reason).toBe('max_tokens');
        const kimi = server(() => json(messageJson('max_tokens')));
        await expect(run(kimi.fetch, { model: gw(KIMI) })).rejects.toThrow('Response truncated');
    });
    test('cancellation before fetch and during retry reports no output and logs charge notice', async () => {
        const cancelled = new AbortController(); cancelled.abort(); const logs: string[] = [];
        const s = server(() => ok()); expect(await run(s.fetch, { signal: cancelled.signal, logs })).toEqual([]); expect(s.calls).toHaveLength(0);
        expect(JSON.parse(logs[0]!).notice).toContain('cancelled; may still be charged');
        const c = new AbortController(); const waiting = server(() => error(429, 'rate_limited'));
        expect(await run(waiting.fetch, { signal: c.signal, sleep: async () => { c.abort(); }, logs })).toEqual([]);
        expect(waiting.posts()).toHaveLength(1);
    });
});

describe('gateway errors and credits', () => {
    test('window exhaustion uses the full Retry-After seconds or HTTP date in local time', () => {
        const now = Date.parse('2026-10-22T12:05:00Z');
        const reset = new Date(now + 7200000);
        for (const header of ['7200', reset.toUTCString()]) {
            const error = describeGatewayError('qwen', 429, header, { code: 'window_budget_reached', request_id: 'window-id' }, null, undefined, now);
            expect(error.message).toContain(`Resets at ${localResetTime(reset)} (local time)`);
            expect(error.message).toContain('(request window-id)');
            expect(error.retryAfterSeconds).toBe(7200);
            expect(error.status).toBe(429);
            expect(error.code).toBe('window_budget_reached');
        }
    });
    test('missing or invalid window Retry-After does not invent a deadline or retry', () => {
        for (const header of [null, 'invalid', '9'.repeat(400)]) {
            const error = describeGatewayError('qwen', 429, header, { code: 'window_budget_reached', message: 'private body' }, null);
            expect(error.message).toContain("This window's EZiL AI credits are used up.");
            expect(error.message).toContain('Check EZiL AI status for the reset time.');
            expect(error.message).not.toMatch(/Resets at|private body|retry/i);
            expect(error.retryAfterSeconds).toBeUndefined();
        }
    });
    test('zero Retry-After refers to now without imposing a default wait', () => {
        const now = Date.parse('2026-10-22T14:05:00Z');
        const error = describeGatewayError('qwen', 429, '0', { code: 'window_budget_reached' }, null, undefined, now);
        expect(error.message).toContain(`Resets at ${localResetTime(new Date(now))}`);
        expect(error.retryAfterSeconds).toBe(0);
    });
    for (const [status, code, text] of [
        [402, 'insufficient_credits', 'credits'], [402, 'no_live_grant', 'no AI credits left'], [401, 'no_ezil_role', 'Your EZiL account has no AI access yet'],
        [401, 'os_session_missing', 'this account has no EZiL AI access, or this computer has not received your sign-in'], [401, 'os_proxy_unauthorized', 'EZiL OS refused this computer'],
        [403, 'not_a_member', 'membership'], [403, 'account_suspended', 'suspended'], [413, 'input_too_large', 'Conversation too large — start a new chat'],
        [400, 'unsupported_bedrock_converse_request', 'Internal EZiL Models bug (unsupported_bedrock_converse_request)'],
        [503, 'killswitch', 'paused'], [503, 'paused', 'paused'], [503, 'no_provider_route', 'temporarily unavailable'], [504, 'upstream_timeout', 'did not answer'], [409, 'idempotency_replay', 'already processed'],
    ] as const) test(`maps ${code}, always preserving request ID`, () => {
        const e = describeGatewayError('qwen', status, null, { code, request_id: 'body-id' }, 'header-id');
        expect(e.message).toContain(text); expect(e.message).toContain('(request body-id)');
    });
    test('auth refusals distinguish issuer, signature, membership, missing and expired credentials', () => {
        const messages = ['wrong_issuer', 'bad_signature', 'no_ezil_role', 'expired', 'token_expired'].map(reason =>
            describeGatewayError('', 401, null, { code: 'unauthorized', reason }, null).message);
        expect(messages[0]).toContain('this OS environment is not connected');
        expect(messages[1]).toContain('signature');
        expect(messages[2]).toContain('no AI access');
        expect(messages[3]).toContain('expired');
        expect(messages[4]).toContain('expired');
        for (const text of messages.slice(0, 3)) expect(text).not.toContain('Reopen Code');
        expect(describeGatewayError('', 401, null, { code: 'unknown' }, null).message).not.toContain('Reopen Code');
        expect(describeGatewayError('', 401, null, { code: 'os_session_expired' }, null).message).toContain('expired');
    });
    test('available credits and nested auth reason; raw messages never shown', () => {
        const e = describeGatewayError('qwen', 402, null, parseErrorBody('{"type":"error","error":{"code":"insufficient_credits","available_micro":1500000,"message":"secret"}}'), 'req');
        expect(e.message).toContain('Available credits: 1.50.'); expect(e.message).not.toContain('secret');
        expect(describeGatewayError('', 401, null, { code: 'unauthorized', reason: 'no_ezil_role' }, 'req').message).toContain('no AI access yet');
    });
    for (const tokens of [undefined, null, 0, 512]) test(`credit refusal explains the full hold with affordable output ${tokens}`, () => {
        const body = parseErrorBody(JSON.stringify({ error: { code: 'insufficient_credits', available_micro: 63_092_750,
            hold_micro: 80_126_789, floor_hold_micro: 64_000_000, max_affordable_output_tokens: tokens, no_live_grant: false } }));
        const e = describeGatewayError('qwen', 402, null, body, 'req');
        expect(e.message).toBe('EZiL AI: This request needs up to 80.13 credits, and you have 63.09. Add credits, or start a new chat or pick a smaller model to use less.'
            + (tokens ? ' A shorter reply would fit; try again or reduce the conversation.' : '') + ' (request req)');
        expect(e.message).not.toContain('63.09275');
    });
    for (const body of [{ code: 'no_live_grant' }, { code: 'insufficient_credits', no_live_grant: true }]) {
        test(`no live grant gives the add-credits message for ${body.code}`, () => {
            const e = describeGatewayError('qwen', 402, null, { ...body, available_micro: 0, hold_micro: 80_000_000 }, null,
                { available_micro: 0, held_micro: 0, grants: [] });
            expect(e.message).toBe('EZiL AI: You have no AI credits left. Add credits to continue.');
        });
    }
    test('legacy refusal uses the measured balance and displays exactly two decimals', () => {
        const e = describeGatewayError('qwen', 402, null, { code: 'insufficient_credits' }, null,
            { available_micro: 63_092_750, held_micro: 0, grants: [] });
        expect(e.message).toBe('EZiL AI: Not enough AI credits for this request. Available credits: 63.09. Add credits, or start a new chat or pick a smaller model to use less.');
        expect(describeGatewayError('qwen', 402, null, { code: 'insufficient_credits', available_micro: 0, hold_micro: 1_000_000 }, null).message)
            .toContain('up to 1.00 credits, and you have 0.00.');
    });
    test('missing or null credit measurements are not invented', () => {
        for (const available_micro of [undefined, null]) {
            const body = parseErrorBody(JSON.stringify({ error: { code: 'insufficient_credits', available_micro, hold_micro: null } }));
            expect(describeGatewayError('qwen', 402, null, body, null).message)
                .toBe('EZiL AI: Not enough AI credits for this request. Available credits: Not measured. Add credits, or start a new chat or pick a smaller model to use less.');
        }
    });
    test('model catalog cached for five minutes and scoped by provider identity', async () => {
        const s = server(() => json(catalog)); const provider = gw().provider;
        await gatewayModels(provider, s.fetch, 0); await gatewayModels(provider, s.fetch, 10); expect(s.calls).toHaveLength(1);
        await gatewayModels(provider, s.fetch, 300001); expect(s.calls).toHaveLength(2);
        await gatewayModels({ ...provider }, s.fetch, 300002); expect(s.calls).toHaveLength(2);
        await gatewayModels({ ...provider, apiKey: 'different-synthetic-auth' }, s.fetch, 300002); expect(s.calls).toHaveLength(3);
        await gatewayModels({ ...provider, baseUrl: 'https://other.invalid/ai/v1' }, s.fetch, 300002); expect(s.calls).toHaveLength(4);
        forgetGatewayModels(provider.baseUrl);
        await gatewayModels(provider, s.fetch, 300003); expect(s.calls).toHaveLength(5);
        await gatewayModels({ ...provider, baseUrl: 'https://other.invalid/ai/v1' }, s.fetch, 300003); expect(s.calls).toHaveLength(5);
    });
    for (const field of ['max_input_tokens', 'max_output_tokens']) {
        for (const value of [undefined, null, '4096', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
            test(`rejects and does not cache catalog ${field}=${String(value)}`, async () => {
                const s = server((_, i) => json(i === 0 ? { data: [{ ...catalog.data[0], [field]: value }] } : catalog));
                const provider = gw().provider;
                expect(await gatewayModels(provider, s.fetch, 0)).toBeUndefined();
                expect((await gatewayModels(provider, s.fetch, 1))?.data).toEqual(catalog.data);
                await gatewayModels(provider, s.fetch, 2);
                expect(s.calls).toHaveLength(2);
            });
        }
    }
    test('catalog accepts positive safe integer boundaries', async () => {
        const data = [{ ...catalog.data[0]!, max_input_tokens: Number.MAX_SAFE_INTEGER, max_output_tokens: 1 }];
        const s = server(() => json({ data }));
        expect((await gatewayModels(gw().provider, s.fetch, 0))?.data).toEqual(data);
    });
    test('credit states and command only use allowed GET endpoints', async () => {
        const balance = { available_micro: 0, held_micro: 0, grants: [] };
        expect(creditState(undefined, undefined, '').state).toBe('unknown');
        expect(creditState(undefined, balance, '').state).toBe('not_included');
        expect(creditState(undefined, { ...balance, grants: [{ remaining_micro: 0, live: false }] }, '').state).toBe('expired');
        expect(creditState(undefined, { ...balance, grants: [{ remaining_micro: 0, live: true }] }, '').state).toBe('used');
        expect(creditState(undefined, { ...balance, held_micro: 1 }, '').state).toBe('held');
        const s = server(c => json(c.url.endsWith('/models') ? catalog : { ...balance, available_micro: 1250000 }));
        expect((await readCredits(gw().provider, gw().id, s.fetch)).text).toContain('1.25');
        expect(s.calls.map(c => c.url.split('/ai/v1')[1]).sort()).toEqual(['/me/balance', '/models']);
        expect(s.posts()).toHaveLength(0);
    });
    test('"Show AI credits" prints the exact decimal from integer microcredits, never a float rendering', () => {
        const ok = (available_micro: number) => creditState(undefined, { available_micro, held_micro: 0, grants: [{ remaining_micro: available_micro, live: true }] }, '');
        for (const [micro, text] of [[1_246_750_000, '1,246.75'], [996_250_000, '996.25'], [1, '0.000001'], [1_000_000_000, '1,000'],
            [300_000, '0.3'], [9_007_199_254_740_991, '9,007,199,254.740991']] as const) {
            expect(ok(micro).text).toBe(`AI credits: ${text} remaining`);
        }
        // The float rendering was "1246.75" (no grouping, a Number's shortest text); the `credits` number field is unchanged.
        expect(ok(1_246_750_000).text).not.toContain('1246.75');
        expect(ok(300_000).credits).toBe(0.3);
    });
    test('an available balance in an error is floored, never rounded up (the hold, a requirement, keeps two places)', () => {
        const message = (available_micro: number) => describeGatewayError('qwen', 402, null, { code: 'insufficient_credits', available_micro }, null).message;
        expect(message(999_999)).toContain('Available credits: 0.99.');
        expect(message(1_234_567_891)).toContain('Available credits: 1,234.56.');
        expect(message(1_500_000)).toContain('Available credits: 1.50.');
        for (const odd of [-1, 1.5, Number.NaN]) expect(message(odd)).toContain('Available credits: Not measured.');
    });
});
test('credits-format: the shared vectors (the OS shell pins the same ones for creditsDecimal)', () => {
    for (const [micro, full, floor2] of [['0', '0', '0.00'], ['1', '0.000001', '0.00'], ['500000', '0.5', '0.50'], ['252750000', '252.75', '252.75'],
        ['1246759999', '1,246.759999', '1,246.75'], ['1500000000', '1,500', '1,500.00'], ['9007199254740993123456', '9,007,199,254,740,993.123456', '9,007,199,254,740,993.12']] as const) {
        expect(credits(micro)).toBe(full);
        expect(creditsFloor2(micro)).toBe(floor2);
    }
});
