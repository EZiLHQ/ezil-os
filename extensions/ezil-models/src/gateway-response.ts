import type { SseEvent } from './sse';
import type { StreamEvent, Usage } from './types';
import { isObject } from './gateway-messages';

const STOP_REASONS = new Set(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal']);
export class GatewayResponseError extends Error {
    constructor(public readonly requestId?: string, public readonly code = 'stream_interrupted') {
        super(`EZiL AI: interrupted (request ${requestId ?? 'unknown'})`);
    }
}

function usage(value: unknown): Usage {
    if (!isObject(value)) throw new Error('Invalid usage');
    const count = (key: string) => {
        const n = value[key];
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Invalid usage');
        return n;
    };
    return { inputTokens: count('input_tokens'), outputTokens: count('output_tokens'),
        cacheReadTokens: count('cache_read_input_tokens'), cacheWriteTokens: count('cache_creation_input_tokens') };
}

function toolEvent(block: Record<string, unknown>): StreamEvent {
    if (typeof block.id !== 'string' || typeof block.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(block.id)
        || !/^[a-zA-Z0-9_-]{1,64}$/.test(block.name) || !isObject(block.input)) throw new Error('Invalid tool');
    return { type: 'tool_call', callId: block.id, name: block.name, input: block.input };
}

/** Kimi is delivered only after the entire JSON message has been read and validated. */
export function gatewayJson(value: unknown, requestId?: string): StreamEvent[] {
    try {
        if (!isObject(value) || value.type !== 'message' || value.role !== 'assistant' || !Array.isArray(value.content)
            || typeof value.stop_reason !== 'string' || !STOP_REASONS.has(value.stop_reason)) throw new Error('Invalid message');
        const events: StreamEvent[] = [];
        for (const block of value.content) {
            if (!isObject(block)) throw new Error('Invalid block');
            if (block.type === 'text' && typeof block.text === 'string') events.push({ type: 'text', value: block.text });
            else if (block.type === 'thinking' && typeof block.thinking === 'string') {
                events.push({ type: 'thinking', value: block.thinking, metadata: { signature: block.signature } });
            } else if (block.type === 'tool_use') events.push(toolEvent(block));
            else if (block.type !== 'redacted_thinking') throw new Error('Invalid block');
        }
        events.push({ type: 'usage', usage: usage(value.usage) }, { type: 'stop', reason: value.stop_reason, details: { requestId } });
        return events;
    } catch { throw new GatewayResponseError(requestId, 'invalid_response'); }
}

/** Anthropic events, including the gateway's final-input usage (message_start counts are provisional).
 * A terminal message_stop is required. Partial text may already be visible when a stream interrupts. */
export async function* gatewayStream(events: AsyncIterable<SseEvent>, requestId?: string): AsyncGenerator<StreamEvent> {
    let started = false;
    let stopped = false;
    let finalUsage: Usage | undefined;
    let stopReason: string | undefined;
    const blocks = new Map<number, { block: Record<string, unknown>; json: string }>();
    const seen = new Set<number>();
    try {
        for await (const event of events) {
            if (event.event === 'error') throw new GatewayResponseError(requestId);
            const raw: unknown = JSON.parse(event.data);
            if (!isObject(raw)) throw new Error('Invalid event');
            const type = event.event ?? raw.type;
            if (type === 'error') throw new GatewayResponseError(requestId);
            if (type === 'ping') continue;
            if (stopped || (raw.type !== undefined && raw.type !== type)) throw new Error('Invalid order');
            if (type === 'message_start') {
                if (started || !isObject(raw.message) || raw.message.role !== 'assistant') throw new Error('Invalid start');
                started = true;
                continue;
            }
            if (!started) throw new Error('Missing start');
            if (type === 'message_delta') {
                if (blocks.size || finalUsage || !isObject(raw.delta) || typeof raw.delta.stop_reason !== 'string' || !STOP_REASONS.has(raw.delta.stop_reason)) throw new Error('Invalid final delta');
                finalUsage = usage(raw.usage);
                stopReason = raw.delta.stop_reason;
                continue;
            }
            if (type === 'message_stop') {
                if (!finalUsage || !stopReason || blocks.size) throw new Error('Missing completion');
                stopped = true;
                continue;
            }
            if (finalUsage || typeof raw.index !== 'number' || !Number.isSafeInteger(raw.index) || raw.index < 0) throw new Error('Invalid index');
            const index = raw.index;
            if (type === 'content_block_start') {
                if (seen.has(index) || !isObject(raw.content_block)) throw new Error('Invalid block start');
                const block = raw.content_block;
                if (block.type !== 'text' && block.type !== 'tool_use') throw new Error('Invalid block type');
                seen.add(index);
                blocks.set(index, { block, json: '' });
                if (block.type === 'text') {
                    if (typeof block.text !== 'string') throw new Error('Invalid text');
                    if (block.text) yield { type: 'text', value: block.text };
                }
            } else if (type === 'content_block_delta') {
                const current = blocks.get(index);
                if (!current || !isObject(raw.delta)) throw new Error('Invalid delta');
                const delta = raw.delta;
                if (current.block.type === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') yield { type: 'text', value: delta.text };
                else if (current.block.type === 'tool_use' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') current.json += delta.partial_json;
                else throw new Error('Invalid delta');
            } else if (type === 'content_block_stop') {
                const current = blocks.get(index);
                if (!current) throw new Error('Invalid block stop');
                if (current.block.type === 'tool_use') yield toolEvent({ ...current.block, input: current.json ? JSON.parse(current.json) : current.block.input });
                blocks.delete(index);
            } else throw new Error('Unknown event');
        }
        if (!stopped) throw new GatewayResponseError(requestId);
        yield { type: 'usage', usage: finalUsage! };
        yield { type: 'stop', reason: stopReason, details: { requestId } };
    } catch (error) {
        if (error instanceof GatewayResponseError) throw error;
        throw new GatewayResponseError(requestId);
    }
}
