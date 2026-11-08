import { describe, expect, test } from 'bun:test';
import { GatewayError } from '../src/gateway';
import { gatewayJson, gatewayStream, GatewayResponseError } from '../src/gateway-response';
import { gatewayResponsesJson, gatewayResponsesStream } from '../src/gateway-responses';
import { classifyChatFailure } from '../src/failure';
import { sseEvents, type SseEvent } from '../src/sse';
import { frames } from '../tests/fixtures/gateway-response';
import { frame, sseBody } from '../tests/fixtures/load';
import { failureOf, GATEWAY_ID, responseStart, SENTINEL } from './fixtures/failure';

for (const protocol of ['Messages', 'Responses'] as const) describe(`${protocol} failure reasons`, () => {
    const stream = (events: AsyncIterable<SseEvent>) => protocol === 'Messages' ? gatewayStream(events, GATEWAY_ID) : gatewayResponsesStream(events, GATEWAY_ID);
    const read = (input: string[]) => stream(sseEvents(sseBody(input, 1)));
    const start = () => protocol === 'Messages' ? frames().slice(0, 1) : [responseStart()];

    test('SSE error event keeps only an allowlisted upstream type', async () => {
        const error = await failureOf(read([frame('error', { type: 'error', error: { type: 'overloaded_error', message: SENTINEL }, secret: SENTINEL })]));
        expect(error).toBeInstanceOf(GatewayResponseError);
        expect(error).toMatchObject({ code: 'stream_interrupted', reason: 'stream_error_event', upstreamType: 'overloaded_error',
            message: `EZiL AI: interrupted (request ${GATEWAY_ID})` });
        expect(JSON.stringify(error)).not.toContain(SENTINEL);
        const record = classifyChatFailure({ error, cancelled: false, model: 'qwen', attempts: 1, partial: false, at: 0, latencyMs: 0 });
        expect(record).toMatchObject({ kind: 'interrupted', upstreamType: 'overloaded_error' });
        expect(JSON.stringify(record)).not.toContain(SENTINEL);
    });
    test('unknown upstream type and arbitrary error text are discarded', async () => {
        const error = await failureOf(read([frame('error', { type: 'error', code: SENTINEL, error: { type: SENTINEL, message: SENTINEL } })]));
        expect(error).toMatchObject({ reason: 'stream_error_event', upstreamType: undefined });
        expect(JSON.stringify(error)).not.toContain(SENTINEL);
        expect(Object.keys(error as object).sort()).toEqual(['code', 'origin', 'reason', 'requestId', 'upstreamType']);
        expect((error as Error).cause).toBeUndefined();
    });
    test('malformed error event data is still stream_error_event', async () => {
        expect(await failureOf(read([`event: error\ndata: ${SENTINEL}\n\n`]))).toMatchObject({ reason: 'stream_error_event', upstreamType: undefined });
    });
    test('data-only error events and Gateway codes are allowlisted', async () => {
        for (const data of [{ type: 'error', code: 'upstream_timeout' }, { type: 'error', error: { type: 'unknown', code: 'upstream_timeout' } }]) {
            expect(await failureOf(read([`data: ${JSON.stringify(data)}\n\n`]))).toMatchObject({ reason: 'stream_error_event', upstreamType: 'upstream_timeout' });
        }
    });
    test('EOF without a terminal event is stream_truncated', async () => {
        expect(await failureOf(read(protocol === 'Messages' ? frames().slice(0, -1) : start()))).toMatchObject({ reason: 'stream_truncated' });
    });
    test('malformed event JSON is stream_malformed', async () => {
        expect(await failureOf(read([...start(), 'data: {broken\n\n']))).toMatchObject({ reason: 'stream_malformed' });
    });
    test('unsupported content block is stream_malformed', async () => {
        const event = protocol === 'Messages'
            ? frame('content_block_start', { index: 0, content_block: { type: 'server_tool_use', input: SENTINEL } })
            : frame('response.content_part.added', { item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'thinking', thinking: SENTINEL } });
        expect(await failureOf(read([...start(), event]))).toMatchObject({ reason: 'stream_malformed' });
    });
    test('body reader TypeError is connection_reset', async () => {
        const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(new TypeError(SENTINEL)); } });
        const error = await failureOf(protocol === 'Messages' ? gatewayStream(sseEvents(body), GATEWAY_ID) : gatewayResponsesStream(body, GATEWAY_ID));
        expect(error).toMatchObject({ reason: 'connection_reset' });
        expect(JSON.stringify(error)).not.toContain(SENTINEL);
    });
    test('non-TypeError iterator rejection is connection_reset', async () => {
        const events: AsyncIterable<SseEvent> = { [Symbol.asyncIterator]() { return { next: async () => { throw new Error(SENTINEL); } }; } };
        expect(await failureOf(stream(events))).toMatchObject({ reason: 'connection_reset' });
    });
    test('typed timeouts, response errors and aborts retain identity', async () => {
        for (const error of [new GatewayError(SENTINEL, undefined, 'stream_idle_timeout', GATEWAY_ID, undefined, 'transport'),
            new GatewayResponseError(GATEWAY_ID, 'stream_interrupted', 'stream_truncated'), new DOMException(SENTINEL, 'AbortError')]) {
            const body = new ReadableStream<Uint8Array>({ pull(c) { c.error(error); } });
            expect(await failureOf(protocol === 'Messages' ? gatewayStream(sseEvents(body), GATEWAY_ID) : gatewayResponsesStream(body, GATEWAY_ID))).toBe(error);
        }
    });
    test('invalid complete JSON is invalid_response with unchanged message', () => {
        let error: unknown;
        try { (protocol === 'Messages' ? gatewayJson : gatewayResponsesJson)({}, GATEWAY_ID); } catch (caught) { error = caught; }
        expect(error).toMatchObject({ code: 'invalid_response', reason: 'invalid_response', message: `EZiL AI: interrupted (request ${GATEWAY_ID})` });
    });
});

test('Responses malformed UTF-8 is stream_malformed rather than a connection reset', async () => {
    const body = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array([0xff])); c.close(); } });
    expect(await failureOf(gatewayResponsesStream(body))).toMatchObject({ reason: 'stream_malformed' });
});
test('Responses unterminated SSE frame and premature DONE are stream_truncated', async () => {
    for (const input of ['data: {}', 'data: [DONE]\n\n']) {
        expect(await failureOf(gatewayResponsesStream(sseBody([input], 1)))).toMatchObject({ reason: 'stream_truncated' });
    }
});
