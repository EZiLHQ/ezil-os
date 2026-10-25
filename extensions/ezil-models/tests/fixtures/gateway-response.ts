import { frame } from './load';
export const finalUsage = { input_tokens: 100, output_tokens: 8, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 };
export function frames(reason = 'tool_use'): string[] {
    return [
        frame('message_start', { type: 'message_start', message: { role: 'assistant', usage: { input_tokens: 0, output_tokens: 0 } } }),
        frame('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'A' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } }),
        frame('content_block_stop', { type: 'content_block_stop', index: 0 }),
        frame('content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } }),
        frame('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"a.ts"}' } }),
        frame('content_block_stop', { type: 'content_block_stop', index: 1 }),
        frame('message_delta', { type: 'message_delta', delta: { stop_reason: reason }, usage: finalUsage }),
        frame('message_stop', { type: 'message_stop' }),
    ];
}
export const messageJson = (reason = 'end_turn') => ({ type: 'message', role: 'assistant', content: [
    { type: 'text', text: 'first' }, { type: 'thinking', thinking: 'reasoning', signature: '' },
    { type: 'tool_use', id: 'call_1', name: 'read_file', input: { path: 'a.ts' } }, { type: 'text', text: 'last' },
], stop_reason: reason, usage: finalUsage });
