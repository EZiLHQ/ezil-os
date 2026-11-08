import type { SseEvent } from './sse';
import type { StreamEvent, Usage } from './types';
import { isObject } from './gateway-messages';
import { GatewayError } from './gateway-error';

const STOP_REASONS = new Set(['end_turn', 'tool_use', 'max_tokens', 'stop_sequence', 'refusal']);
export const RESPONSE_FAILURE_REASONS = ['stream_error_event', 'stream_truncated', 'stream_malformed', 'connection_reset', 'invalid_response'] as const;
export type GatewayResponseReason = typeof RESPONSE_FAILURE_REASONS[number];
/** The codes an SSE error event may name that triage keeps (docs/CHAT-FAILURE-CAPTURE-CONTRACT.md §2 `upstreamCode`): the Gateway's
 * own stream error codes (EZiL AI Gateway src/app.ts streamErrorEvent) and the provider's Anthropic error types. Nothing else. */
const UPSTREAM_CODES = ['stream_interrupted', 'upstream_timeout', 'settlement_pending', 'upstream_error', 'overloaded_error', 'api_error',
    'rate_limit_error', 'timeout_error'] as const;
export type UpstreamCode = typeof UPSTREAM_CODES[number];
export function sanitizeUpstreamType(value: unknown): UpstreamCode | undefined {
    return typeof value === 'string' && (UPSTREAM_CODES as readonly string[]).includes(value) ? value as UpstreamCode : undefined;
}

export class GatewayResponseError extends Error {
    /** A reply arrived (or started to) but was not usable; see GatewayErrorOrigin in gateway.ts. */
    public readonly origin = 'response' as const;
    public readonly upstreamType?: UpstreamCode;
    constructor(public readonly requestId?: string, public readonly code = 'stream_interrupted',
        public readonly reason: GatewayResponseReason = code === 'invalid_response' ? 'invalid_response' : 'stream_malformed', upstreamType?: unknown) {
        super(`EZiL AI: interrupted (request ${requestId ?? 'unknown'})`);
        this.upstreamType = sanitizeUpstreamType(upstreamType);
    }
}

/** Keep only a closed error type; neither the parsed payload nor its message escapes. */
export function streamErrorEvent(data: string, requestId?: string): GatewayResponseError {
    let upstreamType: UpstreamCode | undefined;
    try {
        const raw: unknown = JSON.parse(data);
        if (isObject(raw)) {
            const error = isObject(raw.error) ? raw.error : {};
            upstreamType = sanitizeUpstreamType(raw.code) ?? sanitizeUpstreamType(error.code) ?? sanitizeUpstreamType(error.type);
        }
    } catch { /* An explicit error event remains an error event even with malformed data. */ }
    return new GatewayResponseError(requestId, 'stream_interrupted', 'stream_error_event', upstreamType);
}

/** Preserve typed deadlines and cancellation at both the body and event-validation boundaries. */
export function responseFailure(error: unknown, requestId: string | undefined, reason: GatewayResponseReason): unknown {
    if (error instanceof GatewayError || error instanceof GatewayResponseError || (error instanceof Error && error.name === 'AbortError')) return error;
    return new GatewayResponseError(requestId, 'stream_interrupted', reason);
}

/** Only iterator rejections reach this catch; consumer JSON/shape validation runs outside it. */
export async function* gatewayBodyEvents(events: AsyncIterable<SseEvent>, requestId?: string): AsyncGenerator<SseEvent> {
    try { yield* events; }
    catch (error) { throw responseFailure(error, requestId, 'connection_reset'); }
}

/** A JSON reply's usage: all four counters, each a safe non-negative integer. */
function usage(value: unknown): Usage {
    const c = counters(value);
    if (c.input_tokens === undefined || c.output_tokens === undefined || c.cache_read_input_tokens === undefined || c.cache_creation_input_tokens === undefined) throw new Error('Invalid usage');
    return { inputTokens: c.input_tokens, outputTokens: c.output_tokens, cacheReadTokens: c.cache_read_input_tokens, cacheWriteTokens: c.cache_creation_input_tokens };
}

const COUNTERS = ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens'] as const;
type Counters = Partial<Record<typeof COUNTERS[number], number>>;
/** The counters an event carries; every one present must be a safe non-negative integer. Absent ones stay absent. */
function counters(value: unknown): Counters {
    if (!isObject(value)) throw new Error('Invalid usage');
    const out: Counters = {};
    for (const key of COUNTERS) {
        if (!(key in value)) continue;
        const n = value[key];
        if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0) throw new Error('Invalid usage');
        out[key] = n;
    }
    return out;
}

/**
 * A stream's final usage, with the authority rules of the Gateway's own usage tap (EZiL AI Gateway
 * src/protocols/anthropic/sse.ts). The final message_delta must carry the cumulative output count, never below
 * message_start's preliminary one, which is never used. Input and cache counters come from the final delta (the
 * Converse route reports them only there, all three together), else from message_start (the native route); a native
 * delta that repeats one must repeat it unchanged. A counter neither event carries fails the stream: nothing is zero-filled.
 */
function streamUsage(start: Counters, final: unknown): Usage {
    const f = counters(final);
    if (f.output_tokens === undefined || (start.output_tokens !== undefined && f.output_tokens < start.output_tokens)) throw new Error('Invalid usage');
    const allInputs = f.input_tokens !== undefined && f.cache_read_input_tokens !== undefined && f.cache_creation_input_tokens !== undefined;
    const input = (key: 'input_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens'): number => {
        const final = f[key], initial = start[key];
        if (final !== undefined) {
            if (!allInputs && initial !== undefined && initial !== final) throw new Error('Invalid usage');
            return final;
        }
        if (initial === undefined) throw new Error('Invalid usage');
        return initial;
    };
    return { inputTokens: input('input_tokens'), outputTokens: f.output_tokens, cacheReadTokens: input('cache_read_input_tokens'),
        cacheWriteTokens: input('cache_creation_input_tokens') };
}

type ThinkingBlock = { kind: 'thinking'; thinking: string; signature: string };
function thinkingBlock(block: Record<string, unknown>): ThinkingBlock {
    if (typeof block.thinking !== 'string' || ('signature' in block && typeof block.signature !== 'string')) throw new Error('Invalid thinking');
    return { kind: 'thinking', thinking: block.thinking, signature: typeof block.signature === 'string' ? block.signature : '' };
}

function redactedEvent(block: Record<string, unknown>): StreamEvent {
    if (typeof block.data !== 'string' || !block.data) throw new Error('Invalid redacted thinking');
    return { type: 'thinking', value: '', metadata: { redactedData: block.data } };
}

function completeThinking(block: ThinkingBlock): StreamEvent {
    return { type: 'thinking', value: '', metadata: { signature: block.signature, _completeThinking: block.thinking } };
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
            else if (block.type === 'thinking') {
                const thinking = thinkingBlock(block);
                if (thinking.thinking) events.push({ type: 'thinking', value: thinking.thinking });
                if (thinking.signature) events.push(completeThinking(thinking));
            } else if (block.type === 'tool_use') events.push(toolEvent(block));
            else if (block.type === 'redacted_thinking') events.push(redactedEvent(block));
            else throw new Error('Invalid block');
        }
        events.push({ type: 'usage', usage: usage(value.usage) }, { type: 'stop', reason: value.stop_reason, details: { requestId } });
        return events;
    } catch { throw new GatewayResponseError(requestId, 'invalid_response', 'invalid_response'); }
}

type PendingBlock = ThinkingBlock | { kind: 'text' | 'redacted_thinking' }
    | { kind: 'tool_use'; block: Record<string, unknown>; json: string };

/** Anthropic events, including the gateway's final-input usage (message_start counts are provisional).
 * A terminal message_stop is required. Partial text may already be visible when a stream interrupts. */
export async function* gatewayStream(events: AsyncIterable<SseEvent>, requestId?: string): AsyncGenerator<StreamEvent> {
    let started = false;
    let stopped = false;
    let startCounters: Counters = {};
    let finalUsage: Usage | undefined;
    let stopReason: string | undefined;
    const blocks = new Map<number, PendingBlock>();
    const seen = new Set<number>();
    try {
        for await (const event of gatewayBodyEvents(events, requestId)) {
            if (event.event === 'error') throw streamErrorEvent(event.data, requestId);
            const raw: unknown = JSON.parse(event.data);
            if (!isObject(raw)) throw new Error('Invalid event');
            const type = event.event ?? raw.type;
            if (type === 'error') throw streamErrorEvent(event.data, requestId);
            if (type === 'ping') continue;
            if (stopped || (raw.type !== undefined && raw.type !== type)) throw new Error('Invalid order');
            if (type === 'message_start') {
                if (started || !isObject(raw.message) || raw.message.role !== 'assistant') throw new Error('Invalid start');
                if (raw.message.usage !== undefined) startCounters = counters(raw.message.usage);
                started = true;
                continue;
            }
            if (!started) throw new Error('Missing start');
            if (type === 'message_delta') {
                if (blocks.size || finalUsage || !isObject(raw.delta) || typeof raw.delta.stop_reason !== 'string' || !STOP_REASONS.has(raw.delta.stop_reason)) throw new Error('Invalid final delta');
                finalUsage = streamUsage(startCounters, raw.usage);
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
                seen.add(index);
                if (block.type === 'text') {
                    if (typeof block.text !== 'string') throw new Error('Invalid text');
                    blocks.set(index, { kind: 'text' });
                    if (block.text) yield { type: 'text', value: block.text };
                } else if (block.type === 'thinking') blocks.set(index, thinkingBlock(block));
                else if (block.type === 'redacted_thinking') {
                    blocks.set(index, { kind: 'redacted_thinking' });
                    yield redactedEvent(block);
                } else if (block.type === 'tool_use') blocks.set(index, { kind: 'tool_use', block, json: '' });
                else throw new Error('Invalid block type');
            } else if (type === 'content_block_delta') {
                const current = blocks.get(index);
                if (!current || !isObject(raw.delta)) throw new Error('Invalid delta');
                const delta = raw.delta;
                if (current.kind === 'text' && delta.type === 'text_delta' && typeof delta.text === 'string') yield { type: 'text', value: delta.text };
                else if (current.kind === 'thinking' && delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                    current.thinking += delta.thinking;
                    if (delta.thinking) yield { type: 'thinking', value: delta.thinking };
                } else if (current.kind === 'thinking' && delta.type === 'signature_delta' && typeof delta.signature === 'string') current.signature += delta.signature;
                else if (current.kind === 'tool_use' && delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') current.json += delta.partial_json;
                else throw new Error('Invalid delta');
            } else if (type === 'content_block_stop') {
                const current = blocks.get(index);
                if (!current) throw new Error('Invalid block stop');
                if (current.kind === 'tool_use') yield toolEvent({ ...current.block, input: current.json ? JSON.parse(current.json) : current.block.input });
                else if (current.kind === 'thinking' && current.signature) yield completeThinking(current);
                blocks.delete(index);
            } else throw new Error('Unknown event');
        }
        if (!stopped) throw new GatewayResponseError(requestId, 'stream_interrupted', 'stream_truncated');
        yield { type: 'usage', usage: finalUsage! };
        yield { type: 'stop', reason: stopReason, details: { requestId } };
    } catch (error) {
        throw responseFailure(error, requestId, 'stream_malformed');
    }
}
