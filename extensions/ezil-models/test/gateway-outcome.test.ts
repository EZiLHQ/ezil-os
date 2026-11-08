import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { forgetGatewayModels, gatewayChat, type GatewayOptions } from '../src/gateway';
import type { ChatFailure } from '../src/failure';
import { ask, gw, msg, txt } from '../tests/fixtures/gateway';
import { frames } from '../tests/fixtures/gateway-response';
import { frame } from '../tests/fixtures/load';
import { CLIENT_ID, collect, failureOf, GATEWAY_ID, PREVIOUS_ID, responseFinish, responseStart, responseText, SENTINEL } from './fixtures/failure';

const headers = { 'content-type': 'text/event-stream', 'x-ezil-request-id': GATEWAY_ID };
const errorEvent = () => frame('error', { type: 'error', error: { type: 'overloaded_error', message: SENTINEL } });
beforeEach(() => forgetGatewayModels());
afterEach(() => forgetGatewayModels());

for (const protocol of ['Messages', 'Responses'] as const) describe(`${protocol} outcome telemetry`, () => {
    const model = () => protocol === 'Messages' ? gw() : { ...gw('reviewed-azure'), gatewayProtocol: 'openai-responses' as const };
    const partialFrames = () => protocol === 'Messages' ? frames().slice(0, 2).join('') : responseStart() + responseText();
    const success = () => new Response(protocol === 'Messages' ? frames('end_turn').join('') : responseStart() + responseText() + responseFinish(), { headers });
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

    test('failed stream logs UUID, attempts, reason, upstream type and partial; outcome is sanitized once', async () => {
        const logs: string[] = [], outcomes: ChatFailure[] = [];
        const s = server(() => new Response(partialFrames() + errorEvent(), { headers }));
        const error = await failureOf(turn(s.fetch, { log: line => logs.push(line), onOutcome: record => outcomes.push(record) }));
        expect(error).toMatchObject({ reason: 'stream_error_event' });
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]!)).toMatchObject({ client_request_id: CLIENT_ID, attempts: 1, partial: true, request_id: GATEWAY_ID,
            reason: 'stream_error_event', upstream_type: 'overloaded_error', error_code: 'stream_interrupted', origin: 'response' });
        expect(JSON.parse(logs[0]!)).not.toHaveProperty('previous_client_request_id');
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({ outcome: 'failed', kind: 'interrupted', reason: 'stream_error_event', upstreamType: 'overloaded_error',
            attempts: 1, partial: true, clientRequestId: CLIENT_ID, gatewayRequestId: GATEWAY_ID });
        expect(JSON.stringify(outcomes)).not.toContain(SENTINEL); expect(logs.join()).not.toContain(SENTINEL);
    });
    test('failure before any text or tool event logs partial false', async () => {
        const logs: string[] = [];
        await failureOf(turn(server(() => new Response(errorEvent(), { headers })).fetch, { log: line => logs.push(line) }));
        expect(JSON.parse(logs[0]!)).toMatchObject({ partial: false, attempts: 1 });
    });
    test('413 compaction retry records both UUIDs and the total send count', async () => {
        const logs: string[] = [], outcomes: ChatFailure[] = [];
        const s = server(index => index === 0 ? Response.json({ error: { code: 'input_too_large', max_input_tokens: 65536 } }, { status: 413 })
            : new Response(errorEvent(), { headers }));
        const request = ask([...Array.from({ length: 24 }, (_, i) => [msg('user', txt(`Question ${i}`)), msg('assistant', txt(`Answer ${i} ${'a'.repeat(4000)}`))]).flat(), msg('user', txt('Last question'))]);
        let minted = 0;
        await failureOf(turn(s.fetch, { newIdempotencyKey: () => minted++ === 0 ? PREVIOUS_ID : CLIENT_ID,
            log: line => logs.push(line), onOutcome: record => outcomes.push(record) }, request));
        expect(s.keys).toEqual([PREVIOUS_ID, CLIENT_ID]);
        expect(JSON.parse(logs.at(-1)!)).toMatchObject({ client_request_id: CLIENT_ID, previous_client_request_id: PREVIOUS_ID, attempts: 2, partial: false });
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({ clientRequestId: CLIENT_ID, previousClientRequestId: PREVIOUS_ID, attempts: 2 });
    });
    test('same-key transport resend increments attempts without a previous UUID', async () => {
        const outcomes: ChatFailure[] = [], logs: string[] = [];
        const s = server(index => { if (index === 0) throw new TypeError(SENTINEL); return new Response(errorEvent(), { headers }); });
        await failureOf(turn(s.fetch, { onOutcome: record => outcomes.push(record), log: line => logs.push(line) }));
        expect(s.keys).toEqual([CLIENT_ID, CLIENT_ID]);
        expect(outcomes[0]).toMatchObject({ attempts: 2, clientRequestId: CLIENT_ID });
        expect(outcomes[0]).not.toHaveProperty('previousClientRequestId');
        expect(JSON.parse(logs[0]!)).not.toHaveProperty('previous_client_request_id');
    });
    test('user cancellation mid-stream does not throw and emits only a cancelled outcome', async () => {
        const controller = new AbortController(), outcomes: ChatFailure[] = [], logs: string[] = [];
        let released = false;
        const s = server(() => new Response(new ReadableStream<Uint8Array>({
            start(c) { c.enqueue(new TextEncoder().encode(partialFrames())); }, cancel() { released = true; },
        }), { headers }));
        const iterator = turn(s.fetch, { signal: controller.signal, onOutcome: record => outcomes.push(record), log: line => logs.push(line) });
        expect((await iterator.next()).value).toMatchObject({ type: 'text' });
        // Resume into a body read before cancellation, matching an idle stream in Copilot.
        const pending = iterator.next();
        controller.abort();
        expect((await pending).done).toBe(true);
        expect(outcomes).toHaveLength(1);
        expect(outcomes[0]).toMatchObject({ outcome: 'cancelled', kind: 'cancelled', code: 'cancelled', origin: null, partial: true, attempts: 1 });
        expect(outcomes.some(record => record.outcome === 'failed')).toBe(false);
        expect(JSON.parse(logs[0]!)).toMatchObject({ error_code: 'cancelled', origin: null, partial: true,
            notice: `cancelled; may still be charged (request ${GATEWAY_ID})` });
        expect(JSON.parse(logs[0]!)).not.toHaveProperty('reason');
        expect(released).toBe(true);
    });
    test('pre-send cancellation records zero attempts and a throwing observer cannot change it', async () => {
        const controller = new AbortController(); controller.abort();
        const s = server(success), outcomes: ChatFailure[] = [];
        expect(await collect(turn(s.fetch, { signal: controller.signal, onOutcome: record => { outcomes.push(record); throw new Error(SENTINEL); } }))).toEqual([]);
        expect(s.keys).toHaveLength(0);
        expect(outcomes).toHaveLength(1); expect(outcomes[0]).toMatchObject({ outcome: 'cancelled', attempts: 0, partial: false });
    });
    test('success never calls onOutcome and retains correlation metadata in the log', async () => {
        const outcomes: ChatFailure[] = [], logs: string[] = [];
        await collect(turn(server(success).fetch, { onOutcome: record => outcomes.push(record), log: line => logs.push(line) }));
        expect(outcomes).toEqual([]);
        expect(JSON.parse(logs[0]!)).toMatchObject({ client_request_id: CLIENT_ID, attempts: 1, error_code: null, origin: null, partial: false });
        expect(JSON.parse(logs[0]!)).not.toHaveProperty('reason'); expect(JSON.parse(logs[0]!)).not.toHaveProperty('upstream_type');
    });
    test('a throwing outcome observer cannot replace a failure or suppress its log', async () => {
        let calls = 0; const logs: string[] = [];
        const error = await failureOf(turn(server(() => new Response(errorEvent(), { headers })).fetch,
            { log: line => logs.push(line), onOutcome: () => { calls++; throw new Error(SENTINEL); } }));
        expect(error).toMatchObject({ reason: 'stream_error_event' }); expect(calls).toBe(1); expect(logs).toHaveLength(1);
    });
    test('body connection reset is network in onOutcome', async () => {
        const outcomes: ChatFailure[] = [];
        const s = server(() => new Response(new ReadableStream({ pull(c) { c.error(new TypeError(SENTINEL)); } }), { headers }));
        expect(await failureOf(turn(s.fetch, { onOutcome: record => outcomes.push(record) }))).toMatchObject({ reason: 'connection_reset' });
        expect(outcomes[0]).toMatchObject({ kind: 'network', reason: 'connection_reset' });
    });
});

test('gatewayChat generic post-send fallback distinguishes TypeError/network errors from malformed data', async () => {
    for (const [error, reason] of [[new TypeError(SENTINEL), 'connection_reset'], [Object.assign(new Error(SENTINEL), { code: 'ECONNRESET' }), 'connection_reset'],
        [new Error(SENTINEL), 'stream_malformed'], [new SyntaxError(SENTINEL), 'stream_malformed']] as const) {
        const fetch = (async () => new Response(new ReadableStream({ pull(c) { c.error(error); } }), { status: 401 })) as typeof globalThis.fetch;
        expect(await failureOf(gatewayChat(gw(), ask(), { fetch, signal: new AbortController().signal }))).toMatchObject({ reason });
    }
});

test('yielded tool calls also mark a later failure partial', async () => {
    const logs: string[] = [];
    const wire = [...frames().filter((_, index) => index === 0 || (index >= 4 && index <= 7)), errorEvent()].join('');
    const fetch = (async () => new Response(wire, { headers })) as typeof globalThis.fetch;
    await failureOf(gatewayChat(gw(), ask(), { fetch, signal: new AbortController().signal, log: line => logs.push(line) }));
    expect(JSON.parse(logs[0]!)).toMatchObject({ partial: true });
});
