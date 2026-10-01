// VS Code chat request -> EZiL AI gateway `POST /v1/responses` body (the OpenAI Responses subset in
// ezil-ai-gateway docs/OS-INTEGRATION-CONTRACT.md §4), the gateway's input bound (§4) so requests that
// cannot fit are refused or trimmed here instead of with a 413, and the Responses SSE stream (§5) ->
// neutral events.
//
// Only fields the gateway allows are ever sent, and only the ones a model is configured for: a request
// the gateway accepts but the provider refuses (say, `reasoning` for a non-reasoning deployment) goes
// `pending` at the gateway and can pause AI for every member (contract §11), so this file never adds an
// optional field on its own initiative.

import type { ResolvedModel } from './config';
import type { SseEvent } from './sse';
import { emptyUsage, isCacheMarker, isStatefulMarker, textOf, type ChatRequest, type Message, type Part, type StreamEvent, type Tool } from './types';

/** Gateway framing (validate.ts): 1024 + 32 per input item + 128 per tool, on top of the prompt bytes. */
export const FRAMING_BASE = 1024;
export const FRAMING_PER_ITEM = 32;
export const FRAMING_PER_TOOL = 128;
export const MAX_TOOLS = 64;
export const MIN_OUTPUT_TOKENS = 16;
const MAX_ITEMS = 512;
const MAX_TOOL_DESCRIPTION = 8192;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** Schema keywords the gateway refuses anywhere under `tools` and `text` (contract §4). */
const REFERENCE_KEYS = new Set(['$ref', '$defs', 'definitions', '$dynamicRef', '$recursiveRef', '$anchor']);
const MAX_SCHEMA_DEPTH = 60;

export type InputItem =
    | { role: 'user' | 'assistant'; content: string }
    | { type: 'function_call'; call_id: string; name: string; arguments: string }
    | { type: 'function_call_output'; call_id: string; output: string };

export type FunctionTool = { type: 'function'; name: string; description?: string; parameters: Record<string, unknown> };

export type ResponsesBody = {
    model: string;
    input: InputItem[];
    instructions?: string;
    tools?: FunctionTool[];
    tool_choice?: 'auto' | 'required';
    max_output_tokens: number;
    store: false;
    stream: true;
    text?: { format: { type: 'json_schema'; name: string; schema: Record<string, unknown>; strict?: boolean } };
    reasoning?: { effort: 'minimal' | 'low' | 'medium' | 'high'; summary?: 'auto' };
    temperature?: number;
};

// ── conversion ────────────────────────────────────────────────────────────────

/** Text of a part that becomes prompt text; images, files and Copilot's marker parts are dropped (not supported by the gateway). */
function partText(part: Part): string {
    if (part.type === 'text') return part.value;
    if (part.type === 'data' && !isCacheMarker(part) && !isStatefulMarker(part) && part.mimeType.startsWith('text/')) {
        return Buffer.from(part.data).toString('utf8');
    }
    return '';
}

function toolResultText(part: Extract<Part, { type: 'tool_result' }>): string {
    const text = part.content.map(inner => inner.type === 'data' && inner.mimeType.startsWith('image/') ? '[image omitted]' : partText(inner)).join('');
    return part.isError ? `Error: ${text}` : text;
}

export function convertInput(messages: readonly Message[]): { instructions?: string; input: InputItem[] } {
    const system: string[] = [];
    const input: InputItem[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            const text = textOf(message.parts);
            if (text) system.push(text);
            continue;
        }
        if (message.role === 'assistant') {
            // Thinking parts are not replayed: the gateway refuses reasoning items (contract §4).
            const text = message.parts.map(partText).join('');
            if (text) input.push({ role: 'assistant', content: text });
            for (const part of message.parts) {
                if (part.type === 'tool_call') {
                    input.push({ type: 'function_call', call_id: part.callId, name: part.name, arguments: JSON.stringify(part.input ?? {}) });
                }
            }
            continue;
        }
        // Tool outputs must directly follow the function calls they answer; other user content goes after them.
        let text = '';
        for (const part of message.parts) {
            if (part.type === 'tool_result') input.push({ type: 'function_call_output', call_id: part.callId, output: toolResultText(part) });
            else text += partText(part);
        }
        if (text) input.push({ role: 'user', content: text });
    }
    const out: { instructions?: string; input: InputItem[] } = { input: pairToolItems(input) };
    if (system.length) out.instructions = system.join('\n\n');
    return out;
}

/** Output text for a function call whose result is missing from the history (a cancelled or skipped tool). */
export const MISSING_TOOL_OUTPUT = '[no result: the tool call was cancelled]';

/**
 * Keep function calls and their outputs paired. The provider refuses an output without its call, and a
 * call without an output, with a 400 for a body the gateway accepted, which makes the request `pending`
 * and can pause AI for every member (contract §11). So an orphan output is dropped and a call that never
 * got one is answered with MISSING_TOOL_OUTPUT right after its group of calls.
 */
export function pairToolItems(items: readonly InputItem[]): InputItem[] {
    const calls = new Set<string>();
    const outputs = new Set<string>();
    for (const item of items) {
        if ('type' in item && item.type === 'function_call') calls.add(item.call_id);
        if ('type' in item && item.type === 'function_call_output') outputs.add(item.call_id);
    }
    const out: InputItem[] = [];
    let pending: string[] = [];
    const settle = () => {
        for (const callId of pending) out.push({ type: 'function_call_output', call_id: callId, output: MISSING_TOOL_OUTPUT });
        pending = [];
    };
    for (const item of items) {
        const kind = 'type' in item ? item.type : 'message';
        if (kind !== 'function_call' && kind !== 'function_call_output') settle();
        if (kind === 'function_call_output' && !calls.has((item as { call_id: string }).call_id)) continue;
        if (kind === 'function_call' && !outputs.has((item as { call_id: string }).call_id)) pending.push((item as { call_id: string }).call_id);
        out.push(item);
    }
    settle();
    return out;
}

/**
 * Inline local `#/$defs/...` / `#/definitions/...` references and drop the definition blocks, so the
 * schema carries none of the keywords the gateway refuses. Returns `undefined` when that is impossible
 * (a recursive or non-local reference, a property literally named like a reference keyword, or nesting
 * deeper than the gateway accepts): the caller then drops the tool or refuses the format.
 */
export function inlineSchema(schema: unknown): Record<string, unknown> | undefined {
    if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return undefined;
    const root = schema as Record<string, unknown>;
    const defs: Record<string, unknown> = {};
    for (const key of ['$defs', 'definitions'] as const) {
        const block = root[key];
        if (typeof block === 'object' && block !== null && !Array.isArray(block)) for (const [name, value] of Object.entries(block)) defs[`#/${key}/${name}`] = value;
    }
    let failed = false;
    const walk = (node: unknown, depth: number, resolving: ReadonlySet<string>, inProperties: boolean): unknown => {
        if (failed) return undefined;
        if (depth > MAX_SCHEMA_DEPTH) { failed = true; return undefined; }
        if (Array.isArray(node)) return node.map(child => walk(child, depth + 1, resolving, false));
        if (typeof node !== 'object' || node === null) return node;
        const record = node as Record<string, unknown>;
        if (!inProperties && typeof record.$ref === 'string') {
            const target = record.$ref;
            if (!(target in defs) || resolving.has(target)) { failed = true; return undefined; }
            const { $ref: _ref, ...siblings } = record;
            const resolved = walk(defs[target], depth + 1, new Set([...resolving, target]), false) as Record<string, unknown>;
            return Object.keys(siblings).length ? { ...resolved, ...(walk(siblings, depth + 1, resolving, false) as Record<string, unknown>) } : resolved;
        }
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            if (REFERENCE_KEYS.has(key)) {
                // Inside a `properties` map these are property names, which cannot be renamed safely.
                if (inProperties) { failed = true; return undefined; }
                if (key === '$defs' || key === 'definitions') continue;
                failed = true;
                return undefined;
            }
            out[key] = walk(value, depth + 1, resolving, !inProperties && (key === 'properties' || key === 'patternProperties'));
        }
        return out;
    };
    const result = walk(root, 0, new Set(), false);
    return failed ? undefined : (result as Record<string, unknown>);
}

export type ToolConversion = { tools: FunctionTool[]; dropped: string[] };

/** Flat Responses function tools; a tool the gateway would refuse (bad name, unresolvable schema) is dropped and named. */
export function convertTools(tools: readonly Tool[]): ToolConversion {
    const out: FunctionTool[] = [];
    const dropped: string[] = [];
    const seen = new Set<string>();
    for (const tool of tools) {
        if (!TOOL_NAME.test(tool.name) || seen.has(tool.name)) { dropped.push(tool.name); continue; }
        const parameters = tool.inputSchema === undefined ? { type: 'object', properties: {} } : inlineSchema(tool.inputSchema);
        if (!parameters) { dropped.push(tool.name); continue; }
        seen.add(tool.name);
        const entry: FunctionTool = { type: 'function', name: tool.name, parameters };
        if (tool.description) entry.description = tool.description.length > MAX_TOOL_DESCRIPTION ? tool.description.slice(0, MAX_TOOL_DESCRIPTION) : tool.description;
        out.push(entry);
    }
    return { tools: out, dropped };
}

// ── input bound (mirrors ezil-ai-gateway src/validate.ts) ─────────────────────

export function utf8Length(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

function escapedSurplus(value: unknown): number {
    if (value === undefined) return 0;
    const json = JSON.stringify(value);
    let escaped = 0;
    for (let i = 0; i < json.length; i += 1) escaped += json.charCodeAt(i) < 0x80 ? 1 : 6;
    return escaped - utf8Length(json);
}

/**
 * The gateway's input bound for `body`: UTF-8 bytes of JSON{instructions, input, tools, tool_choice, text,
 * reasoning} + 1024 + 32 per item + 128 per tool, with `tools`, `tool_choice` and `text` counted
 * ASCII-escaped. The request is refused (413 `input_too_large`) when this exceeds the alias's
 * `max_input_tokens`.
 */
export function inputBound(body: Pick<ResponsesBody, 'instructions' | 'input' | 'tools' | 'tool_choice' | 'text' | 'reasoning'>): number {
    const promptBearing = JSON.stringify({
        instructions: body.instructions, input: body.input, tools: body.tools, tool_choice: body.tool_choice,
        text: body.text, reasoning: body.reasoning,
    });
    const items = Array.isArray(body.input) ? body.input.length : 1;
    const tools = body.tools?.length ?? 0;
    return utf8Length(promptBearing) + escapedSurplus(body.tools) + escapedSurplus(body.tool_choice) + escapedSurplus(body.text)
        + FRAMING_BASE + FRAMING_PER_ITEM * items + FRAMING_PER_TOOL * tools;
}

/** Bound contribution of one message, for `provideTokenCount` (bytes of its items plus their framing). */
export function messageBound(message: Message): number {
    if (message.role === 'system') return utf8Length(JSON.stringify(textOf(message.parts)));
    const { input } = convertInput([message]);
    return input.reduce((sum, item) => sum + utf8Length(JSON.stringify(item)) + 1 + FRAMING_PER_ITEM, 0);
}

/** Bound contribution of a bare string (VS Code also counts loose strings). */
export function textBound(text: string): number {
    return utf8Length(JSON.stringify(text));
}

// ── tool trimming ─────────────────────────────────────────────────────────────

/**
 * Tools kept first when the full set does not fit an alias's allowance: the core edit/read/search/run
 * loop of Copilot's Agent mode. Everything else is dropped before any of these.
 */
export const CORE_TOOLS = [
    'read_file', 'replace_string_in_file', 'create_file', 'apply_patch', 'insert_edit_into_file',
    'file_search', 'grep_search', 'list_dir', 'run_in_terminal', 'get_terminal_output', 'get_errors',
    'manage_todo_list',
] as const;

function toolPriority(name: string): number {
    const bare = name.replace(/^copilot_/, '');
    const index = (CORE_TOOLS as readonly string[]).indexOf(bare);
    return index === -1 ? CORE_TOOLS.length : index;
}

// ── body ──────────────────────────────────────────────────────────────────────

const EFFORT: Record<string, 'low' | 'medium' | 'high'> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

export class RequestTooLargeError extends Error {
    constructor(public readonly bound: number, public readonly allowance: number, public readonly alias: string) {
        super(Number.isFinite(bound)
            ? `EZiL AI: this prompt is too large for ${alias} (about ${bound} of ${allowance} allowed). Start a new chat or attach less context.`
            : `EZiL AI: this conversation has too many messages for ${alias} (at most ${MAX_ITEMS}). Start a new chat.`);
        this.name = 'RequestTooLargeError';
    }
}

export class StructuredOutputError extends Error {
    constructor() {
        super('EZiL AI: the requested response schema uses $ref/$defs that cannot be inlined; the gateway only accepts inline JSON schemas.');
        this.name = 'StructuredOutputError';
    }
}

export type BuiltResponsesBody = {
    body: ResponsesBody;
    /** The exact bytes to send; serialized once and reused on the single transport retry. */
    bytes: Uint8Array<ArrayBuffer>;
    bound: number;
    /** Tools removed to fit the allowance, or because the gateway would refuse them. */
    droppedTools: string[];
};

export type GatewayLimits = { maxInputTokens: number; maxOutputTokens: number };

/** `text.format` from Copilot/OpenAI-style model options (`response_format` / `text_format`), refs inlined. */
function textFormat(options: Record<string, unknown>): ResponsesBody['text'] | undefined {
    const raw = (options.text_format ?? options.response_format) as Record<string, unknown> | undefined;
    if (typeof raw !== 'object' || raw === null || raw.type !== 'json_schema') return undefined;
    const spec = (typeof raw.json_schema === 'object' && raw.json_schema !== null ? raw.json_schema : raw) as Record<string, unknown>;
    const schema = inlineSchema(spec.schema);
    if (!schema) throw new StructuredOutputError();
    const name = typeof spec.name === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(spec.name) ? spec.name : 'response';
    const format: NonNullable<ResponsesBody['text']>['format'] = { type: 'json_schema', name, schema };
    if (typeof spec.strict === 'boolean') format.strict = spec.strict;
    return { format };
}

export function clampOutputTokens(requested: unknown, cap: number): number {
    const upper = Math.max(MIN_OUTPUT_TOKENS, cap);
    const value = typeof requested === 'number' && Number.isInteger(requested) && requested > 0 ? requested : upper;
    return Math.min(upper, Math.max(MIN_OUTPUT_TOKENS, value));
}

/**
 * Build the body, serialize it ONCE, and make it fit `limits.maxInputTokens`: tools beyond 64 and tools the
 * gateway would refuse are dropped; if the bound is still over the allowance, tools are kept greedily in
 * priority order (CORE_TOOLS first, then Copilot's order) while they fit. If the prompt does not fit even
 * with no tools, `RequestTooLargeError`.
 */
export function buildResponsesBody(model: ResolvedModel, request: ChatRequest, limits: GatewayLimits): BuiltResponsesBody {
    const { instructions, input } = convertInput(request.messages);
    if (!input.length) input.push({ role: 'user', content: '.' });
    if (input.length > MAX_ITEMS) throw new RequestTooLargeError(Number.POSITIVE_INFINITY, limits.maxInputTokens, model.model);
    const converted = convertTools(request.tools);
    const droppedTools = [...converted.dropped];
    let tools = converted.tools
        .map((tool, index) => ({ tool, index }))
        .sort((a, b) => toolPriority(a.tool.name) - toolPriority(b.tool.name) || a.index - b.index)
        .map(entry => entry.tool);
    if (tools.length > MAX_TOOLS) { droppedTools.push(...tools.slice(MAX_TOOLS).map(tool => tool.name)); tools = tools.slice(0, MAX_TOOLS); }

    const base: Omit<ResponsesBody, 'tools' | 'tool_choice'> = {
        model: model.model,
        input,
        max_output_tokens: clampOutputTokens(request.modelOptions.maxTokens ?? request.modelOptions.max_tokens ?? request.modelOptions.max_output_tokens, Math.min(model.maxOutputTokens, limits.maxOutputTokens)),
        store: false,
        stream: true,
    };
    if (instructions) base.instructions = instructions;
    const text = textFormat(request.modelOptions);
    if (text) base.text = text;
    if (model.thinking && model.thinking.type !== 'disabled' && model.thinking.effort) {
        base.reasoning = { effort: EFFORT[model.thinking.effort] ?? 'medium' };
        if (model.thinking.display && model.thinking.display !== 'omitted') base.reasoning.summary = 'auto';
    }
    if (model.temperature !== undefined && !base.reasoning) base.temperature = model.temperature;

    const assemble = (kept: FunctionTool[]): ResponsesBody => {
        const body: ResponsesBody = { ...base };
        if (kept.length) {
            body.tools = kept;
            body.tool_choice = request.toolMode === 'required' && model.forcedToolChoice ? 'required' : 'auto';
        }
        return body;
    };
    let body = assemble(tools);
    let bound = inputBound(body);
    if (bound > limits.maxInputTokens) {
        // Greedy in priority order: keep each tool that still fits, so small core tools survive a large one.
        const kept: FunctionTool[] = [];
        body = assemble(kept);
        bound = inputBound(body);
        for (const tool of tools) {
            const candidate = assemble([...kept, tool]);
            const candidateBound = inputBound(candidate);
            if (candidateBound <= limits.maxInputTokens) { kept.push(tool); body = candidate; bound = candidateBound; }
            else droppedTools.push(tool.name);
        }
        tools = kept;
    }
    if (bound > limits.maxInputTokens) throw new RequestTooLargeError(bound, limits.maxInputTokens, model.model);
    return { body, bytes: new TextEncoder().encode(JSON.stringify(body)), bound, droppedTools };
}

// ── stream ────────────────────────────────────────────────────────────────────

/** A stream that ended without a usable terminal event: shown as "interrupted", never retried with a new key. */
export class StreamInterruptedError extends Error {
    constructor(public readonly requestId: string | undefined, public readonly code: string | undefined, detail?: string) {
        super(`EZiL AI: the response was interrupted${detail ? ` (${detail})` : ''}${requestId ? ` (request ${requestId})` : ''}. Your credits are only charged for what was generated; try again.`);
        this.name = 'StreamInterruptedError';
    }
}

export class ResponseFailedError extends Error {
    constructor(public readonly requestId: string | undefined, detail?: string) {
        super(`EZiL AI: the model provider failed this response${detail ? ` (${detail})` : ''}${requestId ? ` (request ${requestId})` : ''}.`);
        this.name = 'ResponseFailedError';
    }
}

type PendingCall = { callId: string; name: string; arguments: string; emitted: boolean };

function record(value: unknown): Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Translate a gateway Responses SSE stream into neutral events. `requestId` is the `x-ezil-request-id`
 * header, used in interruption messages. Unknown events are ignored.
 */
export async function* responsesStream(events: AsyncIterable<SseEvent>, requestId?: string, onResponseId?: (id: string) => void): AsyncGenerator<StreamEvent> {
    const calls = new Map<string, PendingCall>();
    const order: string[] = [];
    const callFor = (key: string, init?: Partial<PendingCall>): PendingCall => {
        let call = calls.get(key);
        if (!call) {
            call = { callId: '', name: '', arguments: '', emitted: false };
            calls.set(key, call);
            order.push(key);
        }
        if (init?.callId) call.callId = init.callId;
        if (init?.name) call.name = init.name;
        if (init?.arguments !== undefined && init.arguments !== '') call.arguments = init.arguments;
        return call;
    };
    const emit = function* (key: string): Generator<StreamEvent> {
        const call = calls.get(key);
        if (!call || call.emitted || !call.name) return;
        call.emitted = true;
        let input: unknown = {};
        if (call.arguments.trim()) {
            try { input = JSON.parse(call.arguments); } catch { throw new Error(`EZiL AI: the model returned invalid JSON arguments for tool ${call.name}.`); }
        }
        yield { type: 'tool_call', callId: call.callId || key, name: call.name, input };
    };
    const flush = function* (): Generator<StreamEvent> { for (const key of order) yield* emit(key); };
    const keyOf = (data: Record<string, unknown>, item?: Record<string, unknown>): string =>
        String(item?.id ?? data.item_id ?? (data.output_index !== undefined ? `#${String(data.output_index)}` : 'call'));
    const usageOf = (response: Record<string, unknown>) => {
        const raw = record(response.usage);
        const usage = emptyUsage();
        if (typeof raw.input_tokens === 'number') usage.inputTokens = raw.input_tokens;
        if (typeof raw.output_tokens === 'number') usage.outputTokens = raw.output_tokens;
        const details = record(raw.input_tokens_details);
        if (typeof details.cached_tokens === 'number') usage.cacheReadTokens = details.cached_tokens;
        return usage;
    };
    const outputCalls = function* (response: Record<string, unknown>): Generator<StreamEvent> {
        // A terminal response lists its output items; any function call not yet emitted is completed from there.
        const output = Array.isArray(response.output) ? response.output as unknown[] : [];
        for (const raw of output) {
            const item = record(raw);
            if (item.type !== 'function_call') continue;
            const key = String(item.id ?? item.call_id ?? `#${order.length}`);
            callFor(key, { callId: item.call_id as string, name: item.name as string, arguments: item.arguments as string });
        }
        yield* flush();
    };

    for await (const event of events) {
        const raw = event.data.trim();
        if (!raw || raw === '[DONE]') continue;
        let data: Record<string, unknown>;
        try { data = record(JSON.parse(raw)); } catch { throw new StreamInterruptedError(requestId, undefined, 'malformed event'); }
        const type = typeof data.type === 'string' ? data.type : event.event;
        switch (type) {
            case 'response.created': {
                const id = record(data.response).id;
                if (typeof id === 'string') onResponseId?.(id);
                break;
            }
            case 'response.output_text.delta':
                if (typeof data.delta === 'string' && data.delta) yield { type: 'text', value: data.delta };
                break;
            case 'response.reasoning_summary_text.delta':
                if (typeof data.delta === 'string' && data.delta) yield { type: 'thinking', value: data.delta };
                break;
            case 'response.output_item.added': {
                const item = record(data.item);
                if (item.type === 'function_call') callFor(keyOf(data, item), { callId: item.call_id as string, name: item.name as string, arguments: item.arguments as string });
                break;
            }
            case 'response.function_call_arguments.delta': {
                const call = callFor(keyOf(data));
                if (typeof data.delta === 'string') call.arguments += data.delta;
                break;
            }
            case 'response.function_call_arguments.done':
                callFor(keyOf(data), { arguments: typeof data.arguments === 'string' ? data.arguments : undefined });
                break;
            case 'response.output_item.done': {
                const item = record(data.item);
                if (item.type !== 'function_call') break;
                const key = keyOf(data, item);
                callFor(key, { callId: item.call_id as string, name: item.name as string, arguments: item.arguments as string });
                yield* emit(key);
                break;
            }
            case 'response.completed': {
                const response = record(data.response);
                yield* outputCalls(response);
                yield { type: 'usage', usage: usageOf(response) };
                yield { type: 'stop', reason: 'stop' };
                return;
            }
            case 'response.incomplete': {
                const response = record(data.response);
                yield* outputCalls(response);
                yield { type: 'usage', usage: usageOf(response) };
                const reason = record(response.incomplete_details).reason;
                yield { type: 'stop', reason: reason === 'max_output_tokens' ? 'max_tokens' : 'incomplete', details: reason };
                return;
            }
            case 'response.failed': {
                const error = record(record(data.response).error);
                throw new ResponseFailedError(requestId, typeof error.code === 'string' ? error.code : undefined);
            }
            case 'error': {
                // The gateway's own final event (`code`, `request_id`) or a provider error event passed through.
                const code = typeof data.code === 'string' ? data.code : typeof record(data.error).code === 'string' ? record(data.error).code as string : undefined;
                throw new StreamInterruptedError(typeof data.request_id === 'string' ? data.request_id : requestId, code, code);
            }
            default:
                break; // unknown events are ignored (contract §5)
        }
    }
    // EOF without a terminal event (for example an evicted Worker): the same as an interruption.
    throw new StreamInterruptedError(requestId, undefined, 'the stream ended early');
}
