// Gateway's stateless, text/function-only Responses subset. No direct provider URLs or state IDs.
import type { ResolvedModel } from './config';
import { GATEWAY_INPUT_TOKENS, gatewayOutputTokens, isObject } from './gateway-messages';
import { GatewayResponseError } from './gateway-response';
import type { SseEvent } from './sse';
import { isCacheMarker, isStatefulMarker, type ChatRequest, type Part, type StreamEvent, type Usage } from './types';

type ObjectValue = Record<string, unknown>;
type Input = { type: 'message'; role: 'user' | 'system' | 'assistant'; content: string }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string };
type FunctionTool = { type: 'function'; name: string; description?: string; parameters: ObjectValue };
export type GatewayResponsesBody = { model: string; input: Input[]; max_output_tokens: number; stream: boolean; store: false;
    tools?: FunctionTool[]; tool_choice?: 'auto'; temperature?: number; top_p?: number };
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const REFERENCES = new Set(['$ref', '$defs', 'definitions', '$dynamicRef', '$recursiveRef', '$anchor']);

/** Refuse lossy JSON and schema references before serialization, including deep or cyclic schemas. */
function jsonSafe(value: unknown, schema = false, seen = new Set<unknown>(), depth = 0): void {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if ((!isObject(value) && !Array.isArray(value)) || seen.has(value) || depth >= 64
        || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error('Invalid JSON');
    seen.add(value);
    for (const [key, child] of Object.entries(value)) {
        if (schema && REFERENCES.has(key)) throw new Error('Inline tool schemas are required');
        jsonSafe(child, schema, seen, depth + 1);
    }
    seen.delete(value);
}

function identifier(value: unknown, max = 256): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > max) throw new Error('Invalid identifier');
    return value;
}

function textPart(part: Part): string {
    if (part.type === 'text' && typeof part.value === 'string') return part.value;
    if (part.type === 'thinking' || isCacheMarker(part) || isStatefulMarker(part)) return '';
    // Even tool results must be text. Do not silently send an image/file/audio as a successful result.
    throw new Error('Responses supports text and function tools only; images, files and audio are not supported');
}

export function buildGatewayResponsesBody(model: ResolvedModel, request: ChatRequest, log?: (line: string) => void): { body: GatewayResponsesBody; bytes: Uint8Array<ArrayBuffer> } {
    const names = new Set<string>();
    if (request.tools.length > 64) throw new Error('Too many tools');
    const tools: FunctionTool[] = request.tools.map(tool => {
        const suppliedType = (tool as unknown as ObjectValue).type;
        if ((suppliedType !== undefined && suppliedType !== 'function') || typeof tool.name !== 'string' || !NAME.test(tool.name) || names.has(tool.name)) throw new Error('Only named function tools are supported');
        names.add(tool.name);
        const parameters = tool.inputSchema ?? { type: 'object', properties: {} };
        if (!isObject(parameters)) throw new Error('Invalid tool schema');
        jsonSafe(parameters, true);
        if (tool.description !== undefined && (typeof tool.description !== 'string' || tool.description.length > 8192)) throw new Error('Invalid tool description');
        return { type: 'function', name: tool.name, parameters, ...(tool.description === undefined ? {} : { description: tool.description }) };
    });
    const input: Input[] = [];
    const calls = new Set<string>();
    const pending = new Set<string>();
    for (const message of request.messages) {
        let content = '';
        const flush = () => { if (content) input.push({ type: 'message', role: message.role, content }); content = ''; };
        for (const part of message.parts) {
            if (part.type === 'tool_call') {
                flush();
                const id = identifier(part.callId);
                if (message.role !== 'assistant' || typeof part.name !== 'string' || !NAME.test(part.name) || calls.has(id) || !isObject(part.input)) throw new Error('Invalid function call');
                jsonSafe(part.input);
                calls.add(id); pending.add(id);
                input.push({ type: 'function_call', call_id: id, name: part.name, arguments: JSON.stringify(part.input) });
            } else if (part.type === 'tool_result') {
                flush();
                if (message.role !== 'user') throw new Error('Invalid function output role');
                const id = identifier(part.callId);
                const output = part.content.map(textPart).join('\n') || '(no output)';
                if (pending.delete(id)) input.push({ type: 'function_call_output', call_id: id, output });
                else input.push({ type: 'message', role: 'user', content: `[Earlier tool output]\n${output}` });
            } else content += textPart(part);
        }
        flush();
    }
    // Cancelled history has no recorded result. Never invent a successful result for such calls.
    for (const id of pending) input.push({ type: 'function_call_output', call_id: id, output: 'No result was recorded for this tool call.' });
    if (!input.length || input.length > 512) throw new Error('Invalid conversation length');
    const body: GatewayResponsesBody = { model: model.model, input, max_output_tokens: gatewayOutputTokens(model), stream: model.stream !== false, store: false };
    if (tools.length) { body.tools = tools; body.tool_choice = 'auto'; }
    if (request.toolMode === 'required') log?.('[gateway] required tool choice mapped to auto');
    for (const [key, configured] of [['temperature', model.temperature], ['top_p', model.topP]] as const) {
        const value = request.modelOptions[key] ?? configured;
        if (typeof value === 'number' && Number.isFinite(value)) body[key] = Math.max(0, Math.min(key === 'temperature' ? 2 : 1, value));
    }
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    // Conservative mirror of the Gateway's byte bound, counting the whole envelope and escaped schemas.
    const definitions = JSON.stringify(tools);
    const escaped = definitions.replace(/[\u0080-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
    const bound = bytes.byteLength + Buffer.byteLength(escaped) - Buffer.byteLength(definitions) + 1024 + 32 * input.length + 128 * tools.length;
    if (bytes.byteLength > 256 * 1024 || bound > Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens)) throw new Error('Conversation too large — start a new chat');
    return { body, bytes };
}

function count(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid usage');
    return value;
}

function responseUsage(raw: unknown): Usage {
    if (!isObject(raw) || !isObject(raw.input_tokens_details)) throw new Error('Missing usage');
    const inputTokens = count(raw.input_tokens), outputTokens = count(raw.output_tokens);
    const cacheReadTokens = count(raw.input_tokens_details.cached_tokens);
    // Responses reports no cache writes on native OpenAI. These counters are display-only, never cost.
    const cacheWriteTokens = raw.input_tokens_details.cache_write_tokens === undefined ? 0 : count(raw.input_tokens_details.cache_write_tokens);
    if (cacheReadTokens + cacheWriteTokens > inputTokens || (raw.total_tokens !== undefined && count(raw.total_tokens) !== inputTokens + outputTokens)) throw new Error('Invalid usage');
    if (raw.output_tokens_details !== undefined && raw.output_tokens_details !== null) {
        if (!isObject(raw.output_tokens_details) || (raw.output_tokens_details.reasoning_tokens !== undefined && count(raw.output_tokens_details.reasoning_tokens) > outputTokens)) throw new Error('Invalid usage');
    }
    return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

type Output = { id: string; type: string; status?: string; texts: { type: string; value: string }[]; callId?: string; name?: string; arguments?: string; tool?: StreamEvent };
type Terminal = { id: string; output: Output[]; usage: Usage; reason: string };

function argumentsObject(value: unknown): ObjectValue {
    if (typeof value !== 'string') throw new Error('Invalid arguments');
    const parsed: unknown = JSON.parse(value);
    if (!isObject(parsed)) throw new Error('Invalid arguments');
    jsonSafe(parsed);
    return parsed;
}

function terminalResponse(value: unknown): Terminal {
    if (!isObject(value) || value.object !== 'response' || !['completed', 'incomplete', 'failed'].includes(String(value.status)) || !Array.isArray(value.output)) throw new Error('Invalid response');
    const id = identifier(value.id, 200);
    if (value.status === 'completed' && value.error != null) throw new Error('Unexpected response error');
    const used = responseUsage(value.usage);
    const itemIds = new Set<string>(), callIds = new Set<string>();
    let refusal = false;
    const output: Output[] = value.output.map(item => {
        if (!isObject(item)) throw new Error('Invalid output');
        if (value.status === 'completed' && item.status !== undefined && item.status !== 'completed') throw new Error('Incomplete output');
        const id = identifier(item.id);
        if (itemIds.has(id)) throw new Error('Duplicate output');
        itemIds.add(id);
        const out: Output = { id, type: String(item.type), status: typeof item.status === 'string' ? item.status : undefined, texts: [] };
        if (item.type === 'message') {
            if (item.role !== 'assistant' || !Array.isArray(item.content)) throw new Error('Invalid message');
            for (const part of item.content) {
                if (!isObject(part)) throw new Error('Invalid content');
                if (part.type === 'output_text' && typeof part.text === 'string') out.texts.push({ type: part.type, value: part.text });
                else if (part.type === 'refusal' && typeof part.refusal === 'string') { refusal = true; out.texts.push({ type: part.type, value: part.refusal }); }
                else throw new Error('Unsupported output content');
            }
        } else if (item.type === 'function_call') {
            out.callId = identifier(item.call_id);
            if (typeof item.name !== 'string' || !NAME.test(item.name) || callIds.has(out.callId) || typeof item.arguments !== 'string') throw new Error('Invalid function call');
            callIds.add(out.callId); out.name = item.name; out.arguments = item.arguments;
            if (value.status === 'completed' || item.status === 'completed') {
                const input = argumentsObject(item.arguments);
                if (value.status === 'completed') out.tool = { type: 'tool_call', callId: out.callId, name: item.name, input };
            }
        } else if (item.type !== 'reasoning') throw new Error('Unsupported output item');
        return out;
    });
    const reason = value.status === 'incomplete' ? isObject(value.incomplete_details) && value.incomplete_details.reason === 'max_output_tokens' ? 'max_tokens' : 'incomplete'
        : value.status === 'failed' ? 'failed' : refusal ? 'refusal' : output.some(item => item.tool) ? 'tool_use' : 'end_turn';
    return { id, output, usage: used, reason };
}

function finalEvents(terminal: Terminal, requestId?: string): StreamEvent[] {
    return [...terminal.output.flatMap(item => item.tool ? [item.tool] : []),
        { type: 'usage', usage: terminal.usage }, { type: 'stop', reason: terminal.reason, details: { requestId } }];
}

export function gatewayResponsesJson(value: unknown, requestId?: string): StreamEvent[] {
    try {
        const terminal = terminalResponse(value);
        const output: StreamEvent[] = terminal.output.flatMap(item => [
            ...item.texts.map(part => ({ type: 'text' as const, value: part.value })), ...(item.tool ? [item.tool] : []),
        ]);
        return [...output, { type: 'usage', usage: terminal.usage }, { type: 'stop', reason: terminal.reason, details: { requestId } }];
    } catch { throw new GatewayResponseError(requestId, 'invalid_response'); }
}

type ItemState = { id: string; index: number; type?: string; callId?: string; name?: string; arguments: string; argumentsDone: boolean;
    texts: Map<number, { type: string; value: string; done: boolean }>; added: boolean; done: boolean; finalStatus?: string };
const REASONING_EVENTS = new Set(['response.reasoning_summary_part.added', 'response.reasoning_summary_part.done',
    'response.reasoning_summary_text.delta', 'response.reasoning_summary_text.done', 'response.reasoning_text.delta', 'response.reasoning_text.done']);

/** Unlike the legacy SSE reader, never dispatch an unterminated event at EOF. */
async function* responseEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
    const reader = body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '', event: string | undefined, data: string[] = [], size = 0, finished = false;
    try {
        while (true) {
            const next = await reader.read();
            finished = next.done;
            buffer += decoder.decode(next.value, { stream: !next.done });
            let newline: number;
            while ((newline = buffer.search(/[\r\n]/)) >= 0) {
                if (!next.done && newline === buffer.length - 1 && buffer[newline] === '\r') break;
                const line = buffer.slice(0, newline);
                buffer = buffer.slice(newline + (buffer.startsWith('\r\n', newline) ? 2 : 1));
                size += line.length;
                if (size > 4 * 1024 * 1024) throw new Error('Oversized SSE event');
                if (line === '') {
                    if (data.length) yield { event, data: data.join('\n') };
                    event = undefined; data = []; size = 0;
                } else if (!line.startsWith(':')) {
                    const colon = line.indexOf(':');
                    const field = colon < 0 ? line : line.slice(0, colon);
                    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
                    if (field === 'event') event = value;
                    else if (field === 'data') data.push(value);
                }
            }
            if (buffer.length + size > 4 * 1024 * 1024) throw new Error('Oversized SSE event');
            if (next.done) break;
        }
        if (buffer || data.length || event !== undefined) throw new Error('Truncated SSE event');
    } finally {
        if (!finished) await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
}

/** Text is progressive; tools and usage are released only after a validated terminal and clean EOF. */
export async function* gatewayResponsesStream(source: AsyncIterable<SseEvent> | ReadableStream<Uint8Array>, requestId?: string): AsyncGenerator<StreamEvent> {
    const events = 'getReader' in source ? responseEvents(source) : source;
    const items = new Map<string, ItemState>(), indexes = new Map<number, string>();
    let responseId: string | undefined, terminal: Terminal | undefined, created = false;
    const itemState = (id: unknown, index: unknown): ItemState => {
        const key = identifier(id), position = count(index);
        const previous = indexes.get(position);
        let item = items.get(key);
        if ((previous !== undefined && previous !== key) || (item && item.index !== position)) throw new Error('Mismatched output item');
        if (!item) { item = { id: key, index: position, arguments: '', argumentsDone: false, texts: new Map(), added: false, done: false }; items.set(key, item); indexes.set(position, key); }
        return item;
    };
    const metadata = (state: ItemState, item: ObjectValue) => {
        if (!['message', 'function_call', 'reasoning'].includes(String(item.type)) || (state.type !== undefined && state.type !== item.type)) throw new Error('Invalid output item');
        state.type = String(item.type);
        if (item.type === 'function_call') {
            const callId = identifier(item.call_id), name = identifier(item.name, 64);
            if (!NAME.test(name) || (state.callId !== undefined && state.callId !== callId) || (state.name !== undefined && state.name !== name)) throw new Error('Mismatched function call');
            state.callId = callId; state.name = name;
        }
    };
    const finishArguments = (state: ItemState, value: unknown, complete = true) => {
        if (typeof value !== 'string' || !value.startsWith(state.arguments) || ((state.argumentsDone || state.done) && value !== state.arguments)) throw new Error('Mismatched arguments');
        if (complete) argumentsObject(value);
        state.arguments = value; state.argumentsDone = complete;
    };
    const text = (state: ItemState, index: unknown, type: string, value: unknown, delta: boolean, done: boolean): StreamEvent[] => {
        if (state.type !== undefined && state.type !== 'message') throw new Error('Invalid text item');
        state.type = 'message';
        const key = count(index), previous = state.texts.get(key);
        if (typeof value !== 'string' || (previous && previous.type !== type) || (delta && previous?.done)) throw new Error('Invalid text');
        const before = previous?.value ?? '';
        const full = delta ? before + value : value;
        if (!full.startsWith(before) || ((previous?.done || state.done) && full !== before)) throw new Error('Mismatched text');
        state.texts.set(key, { type, value: full, done: done || previous?.done === true });
        return full.length > before.length ? [{ type: 'text', value: full.slice(before.length) }] : [];
    };
    const content = (state: ItemState, index: unknown, part: unknown, done: boolean): StreamEvent[] => {
        if (!isObject(part)) throw new Error('Invalid content');
        if (part.type === 'output_text') return text(state, index, part.type, part.text, false, done);
        if (part.type === 'refusal') return text(state, index, part.type, part.refusal, false, done);
        throw new Error('Unsupported content');
    };
    try {
        for await (const event of events) {
            if (event.data.trim() === '[DONE]') { if (!terminal) throw new Error('Missing terminal'); continue; }
            const raw: unknown = JSON.parse(event.data);
            if (!isObject(raw)) throw new Error('Invalid event');
            const type = event.event ?? raw.type;
            if (typeof type !== 'string' || (raw.type !== undefined && raw.type !== type) || terminal || type === 'error') throw new Error('Invalid event order');
            if (['response.completed', 'response.incomplete', 'response.failed'].includes(type)) {
                const result = terminalResponse(raw.response);
                if (type !== `response.${(raw.response as ObjectValue).status}` || (responseId !== undefined && result.id !== responseId)) throw new Error('Mismatched terminal');
                for (const state of items.values()) {
                    if (result.output[state.index]?.id !== state.id) throw new Error('Missing output item');
                }
                // Validate all final output before emitting any previously unseen text or tool calls.
                const remaining: StreamEvent[] = [];
                result.output.forEach((output, index) => {
                    const state = itemState(output.id, index);
                    if (state.type !== undefined && state.type !== output.type) throw new Error('Mismatched output type');
                    if (state.done && (state.finalStatus !== undefined && state.finalStatus !== output.status
                        || output.texts.length !== state.texts.size)) throw new Error('Changed completed output');
                    if (state.texts.size && [...state.texts.keys()].some(key => output.texts[key] === undefined)) throw new Error('Missing text');
                    output.texts.forEach((part, i) => remaining.push(...text(state, i, part.type, part.value, false, true)));
                    if (output.type === 'function_call') {
                        if ((state.callId !== undefined && state.callId !== output.callId) || (state.name !== undefined && state.name !== output.name)) throw new Error('Mismatched function call');
                        finishArguments(state, output.arguments, !!output.tool);
                    }
                });
                terminal = result;
                yield* remaining;
            } else if (['response.created', 'response.in_progress', 'response.queued'].includes(type)) {
                if (!isObject(raw.response) || raw.response.object !== 'response' || raw.response.error != null) throw new Error('Invalid response');
                if (type === 'response.created') {
                    if (created || items.size || !['in_progress', 'queued'].includes(String(raw.response.status))) throw new Error('Invalid response start');
                    created = true;
                } else if (type !== `response.${raw.response.status}`) throw new Error('Invalid lifecycle status');
                const id = identifier(raw.response.id, 200);
                if (responseId !== undefined && responseId !== id) throw new Error('Mismatched response');
                responseId = id;
            } else if (type === 'response.output_item.added' || type === 'response.output_item.done') {
                if (!isObject(raw.item)) throw new Error('Invalid item');
                const state = itemState(raw.item.id, raw.output_index);
                if (state.done) throw new Error('Output already complete');
                if (type.endsWith('.added')) {
                    if (state.added || state.texts.size || state.arguments) throw new Error('Duplicate output start');
                    state.added = true;
                }
                metadata(state, raw.item);
                const done = type.endsWith('.done');
                if (raw.item.type === 'message') {
                    if (raw.item.role !== 'assistant' || !Array.isArray(raw.item.content)) throw new Error('Invalid message');
                    const parts = raw.item.content;
                    if (done && [...state.texts.keys()].some(index => parts[index] === undefined)) throw new Error('Missing completed text');
                    for (const [index, part] of parts.entries()) yield* content(state, index, part, done);
                } else if (raw.item.type === 'function_call') {
                    if (done) finishArguments(state, raw.item.arguments, raw.item.status !== 'incomplete');
                    else if (typeof raw.item.arguments !== 'string' || state.arguments) throw new Error('Invalid arguments start');
                    else state.arguments = raw.item.arguments;
                }
                state.done = done;
                if (done) state.finalStatus = typeof raw.item.status === 'string' ? raw.item.status : undefined;
            } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
                const state = itemState(raw.item_id, raw.output_index);
                if ((state.type !== undefined && state.type !== 'function_call') || state.done || state.argumentsDone) throw new Error('Invalid arguments event');
                state.type = 'function_call';
                if (raw.call_id !== undefined) {
                    const id = identifier(raw.call_id);
                    if (state.callId !== undefined && state.callId !== id) throw new Error('Mismatched call ID');
                    state.callId = id;
                }
                if (type.endsWith('.delta')) { if (typeof raw.delta !== 'string') throw new Error('Invalid delta'); state.arguments += raw.delta; }
                else finishArguments(state, raw.arguments);
            } else if (type === 'response.content_part.added' || type === 'response.content_part.done') {
                const state = itemState(raw.item_id, raw.output_index);
                if (state.done) throw new Error('Output already complete');
                if (type.endsWith('.added') && state.texts.has(count(raw.content_index))) throw new Error('Duplicate content start');
                yield* content(state, raw.content_index, raw.part, type.endsWith('.done'));
            } else if (['response.output_text.delta', 'response.output_text.done', 'response.refusal.delta', 'response.refusal.done'].includes(type)) {
                const state = itemState(raw.item_id, raw.output_index);
                if (state.done) throw new Error('Output already complete');
                const delta = type.endsWith('.delta'), refusal = type.startsWith('response.refusal.');
                yield* text(state, raw.content_index, refusal ? 'refusal' : 'output_text', delta ? raw.delta : refusal ? raw.refusal : raw.text, delta, !delta);
            } else if (!REASONING_EVENTS.has(type) && type !== 'response.output_text.annotation.added') throw new Error('Unsupported event');
        }
        if (!terminal) throw new Error('Missing terminal response');
        yield* finalEvents(terminal, requestId);
    } catch { throw new GatewayResponseError(requestId); }
}
