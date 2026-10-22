import { expect, test } from 'bun:test';
import { gatewayJson, gatewayStream } from '../src/gateway-response';
import { sseEvents } from '../src/sse';
import type { StreamEvent } from '../src/types';
import { frame, sseBody } from './fixtures/load';

import { finalUsage, frames, messageJson } from './fixtures/gateway-response';
async function collect(input: string[]): Promise<StreamEvent[]> {
    const output: StreamEvent[] = [];
    for await (const event of gatewayStream(sseEvents(sseBody(input, 1)), 'req-stream')) output.push(event);
    return output;
}

test('SSE text deltas, tool JSON fragments and authoritative final usage', async () => {
    const events = await collect(frames());
    expect(events).toEqual([
        { type: 'text', value: 'A' }, { type: 'text', value: '你好' },
        { type: 'tool_call', callId: 'call_1', name: 'read_file', input: { path: 'a.ts' } },
        { type: 'usage', usage: { inputTokens: 100, outputTokens: 8, cacheReadTokens: 3, cacheWriteTokens: 4 } },
        { type: 'stop', reason: 'tool_use', details: { requestId: 'req-stream' } },
    ]);
});
test('SSE error event is interrupted and never exposes provider payload', async () => {
    const input = [...frames().slice(0, 3), frame('error', { error: { message: 'secret upstream payload' } })];
    await expect(collect(input)).rejects.toThrow('interrupted (request req-stream)');
});
test('EOF without message_stop is interrupted, including after final usage delta', async () => {
    await expect(collect(frames().slice(0, -1))).rejects.toThrow('interrupted');
});
test('malformed tool JSON, missing block stop, and bad event order fail closed', async () => {
    const input = frames(); input[6] = frame('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: 'not json' } });
    await expect(collect(input)).rejects.toThrow('interrupted');
    await expect(collect(frames().filter((_, i) => i !== 7))).rejects.toThrow('interrupted');
    await expect(collect(frames().slice(1))).rejects.toThrow('interrupted');
});
test('terminal event without full usage and trailing errors cannot succeed', async () => {
    const input = frames(); input[8] = frame('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } });
    await expect(collect(input)).rejects.toThrow('interrupted');
    await expect(collect([...frames(), frame('error', {})])).rejects.toThrow('interrupted');
});
test('JSON path emits thinking, text and tools in original order after validation', () => {
    const events = gatewayJson(messageJson(), 'req-json');
    expect(events.map(e => e.type)).toEqual(['text', 'thinking', 'tool_call', 'text', 'usage', 'stop']);
    expect(events[1]).toMatchObject({ value: 'reasoning' });
    expect(() => gatewayJson({ ...messageJson(), usage: {} }, 'req-json')).toThrow('request req-json');
});
test('max_tokens and refusal stop reasons are retained', async () => {
    expect((await collect(frames('max_tokens'))).at(-1)).toMatchObject({ reason: 'max_tokens' });
    expect(gatewayJson(messageJson('refusal')).at(-1)).toMatchObject({ reason: 'refusal' });
});
