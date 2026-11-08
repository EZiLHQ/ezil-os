import { frame } from './load';

export const sonnet = 'claude-sonnet-5';
export const thoughtPieces = ['PRIVATE-THINKING: inspect ', 'the file before editing. 🧠'];
export const thought = thoughtPieces.join('');
export const signature = 'synthetic-thinking-signature==';
export const startUsage = { input_tokens: 120, output_tokens: 1, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
export const normalizedUsage = { inputTokens: 120, outputTokens: 22, cacheReadTokens: 30, cacheWriteTokens: 40 };
export const start = (usage: unknown = startUsage) => frame('message_start', {
    type: 'message_start', message: { id: 'msg_sonnet', type: 'message', role: 'assistant', model: sonnet, content: [], stop_reason: null, usage },
});
export const blockStart = (index: number, content_block: unknown) => frame('content_block_start', { type: 'content_block_start', index, content_block });
export const delta = (index: number, delta: unknown) => frame('content_block_delta', { type: 'content_block_delta', index, delta });
export const blockStop = (index: number) => frame('content_block_stop', { type: 'content_block_stop', index });
export const finish = (usage: unknown = { output_tokens: 22 }) => frame('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage });
export const stop = () => frame('message_stop', { type: 'message_stop' });

export function sonnetFrames(): string[] {
    return [start(),
        blockStart(0, { type: 'thinking', thinking: '' }),
        ...thoughtPieces.map(thinking => delta(0, { type: 'thinking_delta', thinking })),
        delta(0, { type: 'signature_delta', signature }), blockStop(0),
        blockStart(1, { type: 'text', text: '' }), delta(1, { type: 'text_delta', text: 'I will read a.ts.' }), blockStop(1),
        blockStart(2, { type: 'tool_use', id: 'call_1', name: 'read_file', input: {} }),
        delta(2, { type: 'input_json_delta', partial_json: '{"path":' }),
        delta(2, { type: 'input_json_delta', partial_json: '"a.ts"}' }), blockStop(2),
        finish(), stop(),
    ];
}
