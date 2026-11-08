import { frame } from '../../tests/fixtures/load';
import type { StreamEvent } from '../../src/types';

export const CLIENT_ID = 'abcdef12-3456-4789-abcd-0123456789ab';
export const PREVIOUS_ID = '12345678-abcd-4123-abcd-0123456789ab';
export const GATEWAY_ID = '87654321-abcd-4123-abcd-0123456789ab';
export const SENTINEL = 'PRIVATE payload /path secret message';
export const responseStart = () => frame('response.created', { type: 'response.created',
    response: { id: 'resp_1', object: 'response', status: 'in_progress' } });
export const responseText = () => frame('response.output_text.delta', { type: 'response.output_text.delta',
    item_id: 'msg_1', output_index: 0, content_index: 0, delta: 'A' });
export const responseFinish = () => frame('response.completed', { type: 'response.completed', response: {
    id: 'resp_1', object: 'response', status: 'completed',
    output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'A' }] }],
    usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
} });
export async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const output: StreamEvent[] = [];
    for await (const event of events) output.push(event);
    return output;
}
export async function failureOf(events: AsyncIterable<StreamEvent>): Promise<unknown> {
    try { await collect(events); } catch (error) { return error; }
    throw new Error('Expected failure');
}
