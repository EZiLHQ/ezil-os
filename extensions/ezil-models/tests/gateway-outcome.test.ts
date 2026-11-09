import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetGatewayModels, gatewayChat, GATEWAY_MAX_IN_FLIGHT, type GatewayOptions } from '../src/gateway';
import { isAppFailure, type AppFailure } from '../src/failure';
import { ask, gw, msg, txt } from '../tests/fixtures/gateway';
import { frames } from '../tests/fixtures/gateway-response';
import { frame } from '../tests/fixtures/load';
import { CLIENT_ID, collect, failureOf, GATEWAY_ID, PREVIOUS_ID, responseFinish, responseStart, responseText, SENTINEL } from './fixtures/failure';

const OTHER_GATEWAY_ID = '11111111-abcd-4123-abcd-0123456789ab';
const headers = (id = GATEWAY_ID) => ({ 'content-type': 'text/event-stream', 'x-ezil-request-id': id });
const errorEvent = () => frame('error', { type: 'error', error: { type: 'overloaded_error', message: SENTINEL } });
const refusal = (status: number, code: string, id: string) => Response.json({ error: { code, message: SENTINEL }, request_id: id },
    { status, headers: { 'x-ezil-request-id': id, 'retry-after': '1' } });
beforeEach(() => forgetGatewayModels());
afterEach(() => forgetGatewayModels());

for (const protocol of ['Messages', 'Responses'] as const) describe(`${protocol} app-failure records`, () => {
    const model = () => protocol === 'Messages' ? gw() : { ...gw('reviewed-azure'), gatewayProtocol: 'openai-responses' as const };
    const partialFrames = () => protocol === 'Messages' ? frames().slice(0, 2).join('') : responseStart() + responseText();
    const success = (id = GATEWAY_ID) => new Response(protocol === 'Messages' ? frames('end_turn').join('') : responseStart() + responseText() + responseFinish(), { headers: headers(id) });
    function server(reply: (index: number) => Response) {
        const keys: (string | null)[] = [];
        return { keys, fetch: (async (url: string | URL | Request, init: RequestInit = {}) => {
            if (String(url).endsWith('/models')) return Response.json({ data: [{ id: model().model, enabled: true, max_input_tokens: 131072,
                max_output_tokens: 4096, protocols: ['openai-responses'] }] });
            keys.push(new Headers(init.headers).get('idempotency-key'));
            return reply(keys.length - 1);
        }) as typeof fetch };
    }
    function turn(fetch: typeof globalThis.fetch, options: Partial<GatewayOptions> = {}, request = ask()) {
        return gatewayChat(model(), request, { signal: new AbortController().signal, fetch, newIdempotencyKey: () => CLIENT_ID,
            sleep: async () => {}, now: () => 0, ...options });
    }
    const valid = (records: AppFailure[]) => { for (const record of records) {
        expect(isAppFailure(record)).toBe(true);
        expect(record).not.toHaveProperty('vscodeRequestId');
    } };

    test('a Gateway error event mid-stream: one failed provider record with both IDs; log keeps the reason; no text anywhere', async () => {
        const logs: string[] = [], records: AppFailure[] = [];
        const error = await failureOf(turn(server(() => new Response(partialFrames() + errorEvent(), { headers: headers() })).fetch,
            { log: line => logs.push(line), onOutcome: record => records.push(record) }));
        expect(error).toMatchObject({ reason: 'stream_error_event' });
        expect(JSON.parse(logs[0]!)).toMatchObject({ client_request_id: CLIENT_ID, attempts: 1, partial: true, request_id: GATEWAY_ID,
            reason: 'stream_error_event', upstream_type: 'overloaded_error', error_code: 'stream_interrupted', origin: 'response' });
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ source: 'ezil_chat', operation: 'chat_request', category: 'provider', code: 'provider_overloaded', stage: 'stream',
            outcome: 'failed', clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID, attempt: 1, retryable: true });
        valid(records);
        expect(JSON.stringify(records)).not.toContain('PRIVATE'); expect(logs.join()).not.toContain('PRIVATE');
    });
    test('a stream that ends without its terminal: interrupted / missing_terminal', async () => {
        const records: AppFailure[] = [];
        await failureOf(turn(server(() => new Response(partialFrames(), { headers: headers() })).fetch, { onOutcome: record => records.push(record) }));
        expect(records).toEqual([expect.objectContaining({ category: 'interrupted', code: 'stream_interrupted', stage: 'stream', streamReason: 'missing_terminal' })]);
        valid(records);
    });
    test('a body connection reset: interrupted / eof', async () => {
        const records: AppFailure[] = [];
        const s = server(() => new Response(new ReadableStream({ pull(c) { c.error(new TypeError(SENTINEL)); } }), { headers: headers() }));
        expect(await failureOf(turn(s.fetch, { onOutcome: record => records.push(record) }))).toMatchObject({ reason: 'connection_reset' });
        expect(records).toEqual([expect.objectContaining({ category: 'interrupted', streamReason: 'eof', stage: 'stream' })]);
    });
    test('a rate-limit retry then success: retrying (attempt 1, its own Gateway ID) then recovered (attempt 2, the new ID); same client key', async () => {
        const records: AppFailure[] = [];
        const s = server(index => index === 0 ? refusal(429, 'rate_limited', OTHER_GATEWAY_ID) : success());
        await collect(turn(s.fetch, { onOutcome: record => records.push(record) }));
        expect(s.keys).toEqual([CLIENT_ID, CLIENT_ID]);
        expect(records).toHaveLength(2);
        expect(records[0]).toMatchObject({ outcome: 'retrying', category: 'rate_limit', code: 'rate_limited', stage: 'headers', httpStatus: 429,
            attempt: 1, clientRequestId: CLIENT_ID, gatewayRequestId: OTHER_GATEWAY_ID, retryable: true });
        expect(records[1]).toMatchObject({ outcome: 'recovered', code: 'rate_limited', attempt: 2, clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID });
        // The 429 belongs to attempt 1; it is never paired with attempt 2's Gateway ID.
        expect(records[1]).not.toHaveProperty('httpStatus');
        expect(records[0]!.eventId).not.toBe(records[1]!.eventId);
        valid(records);
    });
    test('retrying precedes every automatic resend; recovery uses the last refusal and current Gateway ID', async () => {
        const records: AppFailure[] = [];
        const s = server(index => {
            if (index > 0) expect(records.at(-1)).toMatchObject({ outcome: 'retrying', attempt: index });
            if (index === 0) throw new TypeError(SENTINEL);
            return index === 1 ? refusal(429, 'concurrency_limit', OTHER_GATEWAY_ID) : success();
        });
        await collect(turn(s.fetch, { onOutcome: record => records.push(record) }));
        expect(s.keys).toEqual([CLIENT_ID, CLIENT_ID, CLIENT_ID]);
        expect(records.map(r => [r.outcome, r.code])).toEqual([
            ['retrying', 'network_failed'], ['retrying', 'rate_limited'], ['recovered', 'rate_limited'],
        ]);
        expect(records[2]).toMatchObject({ attempt: 3, gatewayRequestId: GATEWAY_ID });
        expect(records[2]).not.toHaveProperty('httpStatus');
        valid(records);
    });
    test('per-attempt metadata never carries over: a 429 Gateway ID is gone when the next attempt fails before any response', async () => {
        const records: AppFailure[] = [], logs: string[] = [];
        const s = server(index => { if (index === 0) return refusal(429, 'rate_limited', OTHER_GATEWAY_ID); throw new TypeError(SENTINEL); });
        await failureOf(turn(s.fetch, { onOutcome: record => records.push(record), log: line => logs.push(line) }));
        expect(records.map(r => r.outcome)).toEqual(['retrying', 'failed']);
        expect(records[1]).toMatchObject({ category: 'network', code: 'network_failed', stage: 'request', attempt: 2 });
        expect(records[1]).not.toHaveProperty('gatewayRequestId'); expect(records[1]).not.toHaveProperty('httpStatus');
        expect(JSON.parse(logs[0]!)).toMatchObject({ request_id: null, http_status: null, attempts: 2 });
        valid(records);
    });
    test('a same-key transport resend: retrying (network, request) then the final failure, both on the same client key', async () => {
        const records: AppFailure[] = [];
        const s = server(index => { if (index === 0) throw new TypeError(SENTINEL); return new Response(errorEvent(), { headers: headers() }); });
        await failureOf(turn(s.fetch, { onOutcome: record => records.push(record) }));
        expect(s.keys).toEqual([CLIENT_ID, CLIENT_ID]);
        expect(records.map(r => [r.outcome, r.code, r.stage, r.attempt])).toEqual([['retrying', 'network_failed', 'request', 1], ['failed', 'provider_overloaded', 'stream', 2]]);
        valid(records);
    });
    const large = () => ask([...Array.from({ length: 24 }, (_, i) => [msg('user', txt(`Question ${i}`)), msg('assistant', txt(`Answer ${i} ${'a'.repeat(4000)}`))]).flat(), msg('user', txt('Last question'))]);
    const compactionTurn = (reply: (index: number) => Response) => {
        const logs: string[] = [], records: AppFailure[] = [];
        const s = server(reply);
        let minted = 0;
        const run = turn(s.fetch, { newIdempotencyKey: () => minted++ === 0 ? PREVIOUS_ID : CLIENT_ID,
            log: line => logs.push(line), onOutcome: record => records.push(record) }, large());
        return { s, logs, records, run };
    };
    const retried413 = { outcome: 'retrying', code: 'unexpected_error', category: 'provider', stage: 'headers', httpStatus: 413, attempt: 1,
        clientRequestId: PREVIOUS_ID, gatewayRequestId: OTHER_GATEWAY_ID };
    test('413 compaction resend then a stream failure: retrying under the old key, then failed under the new key and its own Gateway ID', async () => {
        const t = compactionTurn(index => index === 0 ? refusal(413, 'input_too_large', OTHER_GATEWAY_ID) : new Response(errorEvent(), { headers: headers() }));
        await failureOf(t.run);
        expect(t.s.keys).toEqual([PREVIOUS_ID, CLIENT_ID]);
        expect(JSON.parse(t.logs.at(-1)!)).toMatchObject({ client_request_id: CLIENT_ID, previous_client_request_id: PREVIOUS_ID, attempts: 2 });
        expect(t.records).toEqual([expect.objectContaining(retried413),
            expect.objectContaining({ outcome: 'failed', clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID, attempt: 2 })]);
        for (const record of t.records) expect(record).not.toHaveProperty('retryOfClientRequestId');
        valid(t.records);
    });
    test('413 compaction resend then success: the key rotation keeps the chain (retrying, then recovered under the new key)', async () => {
        const t = compactionTurn(index => index === 0 ? refusal(413, 'input_too_large', OTHER_GATEWAY_ID) : success());
        await collect(t.run);
        expect(t.s.keys).toEqual([PREVIOUS_ID, CLIENT_ID]);
        expect(t.records).toEqual([expect.objectContaining(retried413),
            expect.objectContaining({ outcome: 'recovered', code: 'unexpected_error', attempt: 2, clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID })]);
        expect(t.records[1]).not.toHaveProperty('httpStatus');
        for (const record of t.records) expect(record).not.toHaveProperty('retryOfClientRequestId');
        valid(t.records);
    });
    test('413 compaction resend then headerless failures: nothing of the 413 attempt carries over to the new key', async () => {
        const t = compactionTurn(index => { if (index === 0) return refusal(413, 'input_too_large', OTHER_GATEWAY_ID); throw new TypeError(SENTINEL); });
        await failureOf(t.run);
        expect(t.s.keys).toEqual([PREVIOUS_ID, CLIENT_ID, CLIENT_ID]);
        expect(t.records.map(r => [r.outcome, r.code, r.clientRequestId, r.attempt])).toEqual([
            ['retrying', 'unexpected_error', PREVIOUS_ID, 1], ['retrying', 'network_failed', CLIENT_ID, 2], ['failed', 'network_failed', CLIENT_ID, 3]]);
        for (const record of t.records.slice(1)) { expect(record).not.toHaveProperty('gatewayRequestId'); expect(record).not.toHaveProperty('httpStatus'); }
        valid(t.records);
    });
    // A cancellation after the 413 but before the compacted resend is sent names the 413 attempt (its key, Gateway ID and
    // status), never the unsent new key paired with the old attempt's Gateway ID.
    const cancelledBeforeResend = (t: ReturnType<typeof compactionTurn>, sent: string[]) => {
        expect(t.s.keys).toEqual([PREVIOUS_ID]);
        expect(sent).toEqual([PREVIOUS_ID]);
        expect(t.records).toEqual([expect.objectContaining(retried413),
            expect.objectContaining({ outcome: 'cancelled', clientRequestId: PREVIOUS_ID, gatewayRequestId: OTHER_GATEWAY_ID, attempt: 1 })]);
        expect(JSON.stringify(t.records)).not.toContain(CLIENT_ID);
        const log = JSON.parse(t.logs.at(-1)!);
        expect(log).toMatchObject({ client_request_id: PREVIOUS_ID, request_id: OTHER_GATEWAY_ID, http_status: 413, attempts: 1, error_code: 'cancelled' });
        expect(log).not.toHaveProperty('previous_client_request_id');
        valid(t.records);
    };
    test('413 then the caller cancels inside the retrying callback: the cancellation names the 413 attempt, never the unsent key', async () => {
        const controller = new AbortController(), logs: string[] = [], records: AppFailure[] = [], sent: string[] = [];
        let minted = 0;
        const s = server(index => index === 0 ? refusal(413, 'input_too_large', OTHER_GATEWAY_ID) : success());
        const run = turn(s.fetch, { signal: controller.signal, newIdempotencyKey: () => minted++ === 0 ? PREVIOUS_ID : CLIENT_ID, log: line => logs.push(line),
            onRequest: (_url, _built, key) => sent.push(key),
            onOutcome: record => { records.push(record); if (record.outcome === 'retrying') controller.abort(); } }, large());
        await collect(run);
        cancelledBeforeResend({ s, logs, records, run }, sent);
    });
    test('413 then the caller cancels while the resend waits for an admission slot: the cancellation names the 413 attempt', async () => {
        const controller = new AbortController(), holders = new AbortController(), logs: string[] = [], records: AppFailure[] = [], sent: string[] = [];
        let minted = 0;
        const s = server(index => index === 0 ? refusal(413, 'input_too_large', OTHER_GATEWAY_ID) : success());
        // Other turns on the same connection hold every admission slot until they are cancelled.
        let entered = 0;
        const hanging = (async (url: string | URL | Request, init: RequestInit = {}) => {
            if (String(url).endsWith('/models')) return s.fetch(url, init);
            entered++;
            return new Promise<Response>((_, reject) => init.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true }));
        }) as typeof fetch;
        const held: Promise<unknown>[] = [];
        const run = turn(s.fetch, { signal: controller.signal, newIdempotencyKey: () => minted++ === 0 ? PREVIOUS_ID : CLIENT_ID, log: line => logs.push(line),
            onRequest: (_url, _built, key) => sent.push(key), onOutcome: record => records.push(record),
            sleep: async () => {
                for (let i = 0; i < GATEWAY_MAX_IN_FLIGHT; i++) held.push(collect(turn(hanging, { signal: holders.signal, newIdempotencyKey: () => `h${i}` })).catch(() => {}));
                while (entered < GATEWAY_MAX_IN_FLIGHT) await new Promise(resolve => setTimeout(resolve, 1));
                setTimeout(() => controller.abort(), 5);
            } }, large());
        await collect(run);
        holders.abort();
        await Promise.all(held);
        cancelledBeforeResend({ s, logs, records, run }, sent);
    });
    test('the caller cancelling mid-stream: no throw, exactly one neutral cancellation record (caller), never a failure', async () => {
        const controller = new AbortController(), records: AppFailure[] = [], logs: string[] = [];
        let released = false;
        const s = server(() => new Response(new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(new TextEncoder().encode(partialFrames())); }, cancel() { released = true; },
        }), { headers: headers() }));
        const iterator = turn(s.fetch, { signal: controller.signal, onOutcome: record => records.push(record), log: line => logs.push(line) });
        expect((await iterator.next()).value).toMatchObject({ type: 'text' });
        const pending = iterator.next();
        controller.abort();
        expect((await pending).done).toBe(true);
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ category: 'cancellation', code: 'request_cancelled', outcome: 'cancelled', cancellationSource: 'caller',
            stage: 'stream', attempt: 1, clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID });
        expect(records[0]).not.toHaveProperty('retryable');
        expect(JSON.parse(logs[0]!)).toMatchObject({ error_code: 'cancelled', origin: null, notice: `cancelled; may still be charged (request ${GATEWAY_ID})` });
        expect(released).toBe(true);
        valid(records);
    });
    test('a cancellation before any send: admission stage, no attempt; a throwing observer changes nothing', async () => {
        const controller = new AbortController(); controller.abort();
        const s = server(() => success()), records: AppFailure[] = [];
        expect(await collect(turn(s.fetch, { signal: controller.signal, onOutcome: record => { records.push(record); throw new Error(SENTINEL); } }))).toEqual([]);
        expect(s.keys).toHaveLength(0);
        expect(records).toEqual([expect.objectContaining({ outcome: 'cancelled', stage: 'admission' })]);
        expect(records[0]).not.toHaveProperty('attempt');
    });
    test('a first-time success emits nothing (the attempt controller cleanup abort is never a cancellation)', async () => {
        const records: AppFailure[] = [], logs: string[] = [];
        await collect(turn(server(() => success()).fetch, { onOutcome: record => records.push(record), log: line => logs.push(line) }));
        expect(records).toEqual([]);
        expect(JSON.parse(logs[0]!)).toMatchObject({ client_request_id: CLIENT_ID, attempts: 1, error_code: null, origin: null });
    });
    test('a throwing observer cannot replace a failure or suppress its log', async () => {
        let calls = 0; const logs: string[] = [];
        const error = await failureOf(turn(server(() => new Response(errorEvent(), { headers: headers() })).fetch,
            { log: line => logs.push(line), onOutcome: () => { calls++; throw new Error(SENTINEL); } }));
        expect(error).toMatchObject({ reason: 'stream_error_event' }); expect(calls).toBe(1); expect(logs).toHaveLength(1);
    });
});

test('gatewayChat generic post-send fallback distinguishes TypeError/network errors from malformed data', async () => {
    for (const [error, reason] of [[new TypeError(SENTINEL), 'connection_reset'], [Object.assign(new Error(SENTINEL), { code: 'ECONNRESET' }), 'connection_reset'],
        [new Error(SENTINEL), 'stream_malformed'], [new SyntaxError(SENTINEL), 'stream_malformed']] as const) {
        const fetch: typeof globalThis.fetch = Object.assign(async (_input: string | URL | Request, _init?: RequestInit) =>
            new Response(new ReadableStream({ pull(c) { c.error(error); } }), { status: 401 }), { preconnect: globalThis.fetch.preconnect });
        expect(await failureOf(gatewayChat(gw(), ask(), { fetch, signal: new AbortController().signal }))).toMatchObject({ reason });
    }
});
