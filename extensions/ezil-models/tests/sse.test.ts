import { describe, expect, test } from 'bun:test';
import { jsonEvents, sseEvents } from '../src/sse';
import { sseBody } from './fixtures/load';

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const item of iterable) out.push(item);
    return out;
}

describe('sse parser', () => {
    test('parses events, multi-line data, comments and CRLF, regardless of chunk boundaries', async () => {
        const raw = 'event: message_start\r\ndata: {"a":1}\r\n\r\n: keep-alive\n\ndata: line1\ndata: line2\n\nevent: ping\ndata:{"type":"ping"}\n\ndata: tail';
        for (const chunkSize of [0, 1, 3, 17]) {
            const events = await collect(sseEvents(sseBody([raw], chunkSize)));
            expect(events).toEqual([
                { event: 'message_start', data: '{"a":1}' },
                { data: 'line1\nline2' },
                { event: 'ping', data: '{"type":"ping"}' },
                { data: 'tail' },
            ]);
        }
    });

    test('jsonEvents parses payloads and flags [DONE]', async () => {
        const events = await collect(jsonEvents(sseBody(['data: {"x":1}\n\ndata: [DONE]\n\n'])));
        expect(events.map(event => event.json ?? event.done)).toEqual([{ x: 1 }, true]);
        await expect(collect(jsonEvents(sseBody(['data: {not json\n\n'])))).rejects.toThrow('malformed stream event');
    });
});
