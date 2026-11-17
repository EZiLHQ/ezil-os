import { estimateTextTokens, estimateMessageTokens } from './tokens';
// The Bedrock Converse subset of Anthropic Messages. Construct envelopes from an allowlist;
// never forward Copilot's provider-specific options, cache markers or unsigned thinking.
import { applyCacheBreakpoints } from './anthropic';
import type { GatewayProtocol, ResolvedModel } from './config';
import { GatewayError } from './gateway-error';
import { isCacheMarker, isStatefulMarker, type ChatRequest, type Message, type Part, type Tool } from './types';

export type LocalRequestCode = 'local_input_too_large' | 'local_too_many_messages' | 'local_too_many_blocks';
/** Sizes only, never payload text. `bodyBytes` is the size checked against `limitBytes`. */
export type LocalRequestCounts = {
    bodyBytes: number; limitBytes: number; messages: number; maxBlocks: number; tools: number; toolBytes: number;
};

/**
 * A request this computer refused before sending anything: nothing reached EZiL OS or EZiL AI. `afterCompaction`: the
 * counts are those of the most compacted form, which still did not fit (compact.ts).
 */
export class LocalRequestError extends Error {
    constructor(public readonly code: LocalRequestCode, public readonly counts: LocalRequestCounts, public readonly afterCompaction = false) {
        super(`EZiL Models: request refused before sending (${code})`);
        this.name = 'LocalRequestError';
    }
}

/** JSON text with every non-ASCII UTF-16 unit written as `\uXXXX`, as the Gateway's Responses bound counts it. */
export function escapeNonAscii(json: string): string {
    return json.replace(/[\u0080-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export const QWEN = 'qwen.qwen3-coder-next';
export const KIMI = 'us.moonshotai.kimi-k3';
/**
 * Gateway aliases that refuse `temperature`/`top_p` (EZiL AI Gateway src/providers/gemini-request.ts): Google ignores
 * sampling on gemini-3.8-flash and gemini-4-carbon, and gemini-4-argon's handling is unverified, so the Gateway refuses the request rather
 * than drop or forward them. They are never sent for these aliases, whatever Copilot or the config pass.
 */
export const SAMPLING_REFUSED: ReadonlySet<string> = new Set(['gemini-3.8-flash', 'gemini-4-argon', 'gemini-4-carbon']);
export function samplingRefused(alias: string): boolean { return SAMPLING_REFUSED.has(alias.trim().toLowerCase()); }
/** Conservative HTTP fallback for servers without the transport contract. */
export const GATEWAY_INPUT_BYTES = 131_072;
export const INPUT_FRAMING = 1056;
export const TRANSPORT_CONTRACT = 'ezil.gateway.transport.v1';
export const ENDPOINT_MAX_BYTES = { '/v1/messages': 4_194_304, '/v1/responses': 262_144 } as const;
export type GatewayTransport = { contract: typeof TRANSPORT_CONTRACT; max_request_bytes: Record<keyof typeof ENDPOINT_MAX_BYTES, number>;
    input_bound_method: 'utf8_json_plus_framing'; token_limits_unit: 'tokens' };
/** Unknown/malformed contracts never relax the fallback; advertised limits can only lower verified hard caps. */
export function parseGatewayTransport(value: unknown): GatewayTransport | undefined {
    if (!isObject(value) || value.contract !== TRANSPORT_CONTRACT || value.input_bound_method !== 'utf8_json_plus_framing'
        || value.token_limits_unit !== 'tokens' || !isObject(value.max_request_bytes)) return undefined;
    const caps = {} as GatewayTransport['max_request_bytes'];
    for (const path of Object.keys(ENDPOINT_MAX_BYTES) as (keyof typeof ENDPOINT_MAX_BYTES)[]) {
        const cap = value.max_request_bytes[path];
        if (!Number.isSafeInteger(cap) || (cap as number) <= 0) return undefined;
        caps[path] = Math.min(cap as number, ENDPOINT_MAX_BYTES[path]);
    }
    return { contract: TRANSPORT_CONTRACT, max_request_bytes: caps, input_bound_method: 'utf8_json_plus_framing', token_limits_unit: 'tokens' };
}
export function gatewayRequestBytes(model: Pick<ResolvedModel, 'gatewayProtocol' | 'gatewayMaxRequestBytes'>): number {
    const hard = ENDPOINT_MAX_BYTES[model.gatewayProtocol === 'openai-responses' ? '/v1/responses' : '/v1/messages'];
    const cap = model.gatewayMaxRequestBytes;
    return Number.isSafeInteger(cap) && cap! > 0 ? Math.min(hard, cap!) : GATEWAY_INPUT_BYTES;
}
// Margin in model tokens for uncounted tool framing/schema, after counting the actual definitions.
export const DEFAULT_TOOL_RESERVE = 8_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
type ObjectValue = Record<string, unknown>;
export type TextBlock = { type: 'text'; text: string };
export type ToolUse = { type: 'tool_use'; id: string; name: string; input: ObjectValue };
export type ToolResult = { type: 'tool_result'; tool_use_id: string; content: TextBlock[]; is_error?: boolean };
export type ThinkingBlock = { type: 'thinking'; thinking: string; signature: string } | { type: 'redacted_thinking'; data: string };
export type Block = TextBlock | ToolUse | ToolResult | ThinkingBlock;
export type GatewayMessage = { role: 'user' | 'assistant'; content: Block[] };
export type GatewayTool = { name: string; input_schema: ObjectValue; description?: string };
export type GatewayBody = {
    model: string; messages: GatewayMessage[]; system?: TextBlock[]; max_tokens: number; stream: boolean;
    tools?: GatewayTool[]; tool_choice?: { type: 'auto' }; temperature?: number; top_p?: number;
};

export function isObject(value: unknown): value is ObjectValue {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Reject lossy/cyclic/non-JSON tool schemas and arguments instead of silently changing them.
function jsonValue(value: unknown, seen = new Set<unknown>(), depth = 0): boolean {
    if (depth > 240) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (!isObject(value) && !Array.isArray(value)) return false;
    if (seen.has(value) || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) return false;
    seen.add(value);
    const valid = Object.values(value).every(item => jsonValue(item, seen, depth + 1));
    seen.delete(value);
    return valid;
}

const text = (value: string): TextBlock => ({ type: 'text', text: value });

export function gatewayTools(tools: readonly Tool[], log: (line: string) => void = () => {}, gemini = false): GatewayTool[] {
    const names = new Set<string>();
    const dropped = new Set<string>();
    const restated = new Set<string>();
    const result: GatewayTool[] = [];
    for (const tool of tools) {
        let schema: unknown = tool.inputSchema ?? { type: 'object', properties: {} };
        if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || names.has(tool.name) || result.length >= 64 || !isObject(schema) || schema.type !== 'object' || !jsonValue(schema)) {
            dropped.add(String(tool.name));
            continue;
        }
        if (gemini) {
            const keywords = new Set<string>();
            schema = geminiToolSchema(schema, keywords);
            if (!isObject(schema)) { dropped.add(tool.name); continue; }
            if (keywords.size) restated.add(tool.name);
        }
        names.add(tool.name);
        result.push({ name: tool.name, input_schema: schema as ObjectValue, ...(typeof tool.description === 'string' && tool.description.trim() ? { description: tool.description } : {}) });
    }
    if (dropped.size) log(`[gateway] dropped tools: ${JSON.stringify([...dropped])}`);
    if (restated.size) log(`[gateway] tool schema keywords Gemini refuses restated in descriptions: ${JSON.stringify([...restated])}`);
    return result;
}

/**
 * Gateway aliases served by its Gemini adapter (EZiL AI Gateway src/providers/gemini-request.ts, GEMINI_MODELS). Its tool
 * schema check accepts only the JSON Schema keywords Google honors and refuses the whole request on any other keyword
 * (400 unsupported_gemini_request, before admission), rather than let Google silently drop a constraint. Copilot's own
 * tools carry three such keywords (maxLength, pattern, enumDescriptions; 0.69, Agent and Ask mode), so every Gemini turn
 * that offered tools was refused.
 */
export const GEMINI_ALIASES: ReadonlySet<string> = new Set(['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-4-carbon']);
export function geminiRoute(alias: string): boolean { return GEMINI_ALIASES.has(alias.trim().toLowerCase()); }
/** The Gateway's GEMINI_SCHEMA_KEYWORDS, exactly. */
export const GEMINI_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
    'type', 'properties', 'required', 'additionalProperties', 'enum', 'format', 'minimum', 'maximum',
    'items', 'prefixItems', 'minItems', 'maxItems', 'anyOf', '$ref', '$defs', 'title', 'description',
    '$schema', '$id', '$comment', 'default', 'examples',
]);
const SCHEMA_TYPES: ReadonlySet<string> = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
/** Keywords whose value holds schemas: one the Gateway refuses changes the shape, so it cannot be restated as text. */
const SUBSCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
    'oneOf', 'allOf', 'not', 'if', 'then', 'else', 'contains', 'patternProperties', 'propertyNames', 'dependentSchemas',
    'dependencies', 'definitions', 'additionalItems', 'unevaluatedProperties', 'unevaluatedItems', 'contentSchema',
    '$dynamicRef', '$recursiveRef',
]);
const GEMINI_SCHEMA_MAX_DEPTH = 64;
/** An own property, also for a key such as `__proto__` from a JSON-parsed schema (plain assignment would hit the setter). */
function own(target: ObjectValue, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The tool schema sent on a Gemini route, a new object (Copilot's inputSchema is never changed). Accepted keywords pass
 * unchanged under the Gateway's own value checks. `const` becomes the equivalent one-value `enum`. Any other keyword that
 * holds no schema (maxLength, pattern, enumDescriptions, …) is moved, with its exact value, into that node's description,
 * so the model still reads it; the constraint stays enforced because Copilot validates every tool call's input against
 * the original schema before running the tool, and answers a violation with an error result. `undefined` when the
 * schema cannot be expressed (a schema-holding keyword, or a value the Gateway refuses): the caller drops that tool.
 */
export function geminiToolSchema(value: unknown, restated: Set<string> = new Set(), depth = 0): unknown {
    // The Gateway's order: the depth bound applies to boolean schemas too.
    if (depth > GEMINI_SCHEMA_MAX_DEPTH) return undefined;
    if (typeof value === 'boolean') return value;
    if (!isObject(value)) return undefined;
    const node: ObjectValue = {};
    const moved: ObjectValue = {};
    const root = depth === 0;
    const schemas = (member: unknown): unknown[] | undefined => {
        if (!Array.isArray(member) || !member.length) return undefined;
        const out = member.map(child => geminiToolSchema(child, restated, depth + 1));
        return out.includes(undefined) ? undefined : out;
    };
    for (const [key, member] of Object.entries(value)) {
        if (key === 'const' && !Object.hasOwn(value, 'enum')) { node.enum = [member]; continue; }
        if (SUBSCHEMA_KEYWORDS.has(key)) return undefined;
        if (!GEMINI_SCHEMA_KEYWORDS.has(key)) { own(moved, key, member); restated.add(key); continue; }
        let kept: unknown = member;
        switch (key) {
            case 'type': {
                const types = Array.isArray(member) ? member : [member];
                if (!types.length || types.some(t => typeof t !== 'string' || !SCHEMA_TYPES.has(t))) return undefined;
                break;
            }
            case 'properties': case '$defs': {
                if (!isObject(member)) return undefined;
                const children: ObjectValue = {};
                for (const [name, child] of Object.entries(member)) {
                    const projected = geminiToolSchema(child, restated, depth + 1);
                    if (projected === undefined) return undefined;
                    own(children, name, projected);
                }
                kept = children;
                break;
            }
            case 'items': case 'additionalProperties':
                kept = geminiToolSchema(member, restated, depth + 1);
                if (kept === undefined) return undefined;
                break;
            case 'prefixItems': case 'anyOf':
                kept = schemas(member);
                if (kept === undefined) return undefined;
                break;
            case 'required': if (!Array.isArray(member) || member.some(item => typeof item !== 'string')) return undefined; break;
            case 'enum': if (!Array.isArray(member) || !member.length) return undefined; break;
            case 'minimum': case 'maximum': if (typeof member !== 'number') return undefined; break;
            case 'minItems': case 'maxItems': if (typeof member !== 'number' || !Number.isSafeInteger(member) || member < 0) return undefined; break;
            case 'format': case 'title': case 'description': case '$ref': case '$schema': case '$id': case '$comment':
                if (typeof member !== 'string') return undefined;
                break;
            default: break; // default, examples: annotations with any JSON value
        }
        node[key] = kept;
    }
    if (Object.keys(moved).length) {
        const constraints = `JSON Schema constraints: ${JSON.stringify(moved)}`;
        node.description = typeof node.description === 'string' && node.description ? `${node.description}\n${constraints}` : constraints;
    }
    // Fail closed: every $ref must still name a schema position of the root, so a reference to an anchor, into a
    // container that moved into a description, to a value that is not a schema, external, or inside a nested
    // $id / draft-04 id (a new base) drops the tool. Checked on the original, whose schema positions the projection keeps.
    if (root && !geminiRefsResolve(value)) return undefined;
    return node;
}

/**
 * True when every `$ref` in a schema is `#` or a JSON pointer (RFC 6901, read as a URI fragment: percent-decoded, then
 * split, then `~1` and `~0` unescaped) to one of the root's own schema positions, the ones the Gateway walks. A reference
 * inside a subschema with its own `$id` or draft-04 `id` resolves against that base instead, so it is not accepted.
 */
function geminiRefsResolve(schema: ObjectValue): boolean {
    const positions = new Set<string>();
    const refs: { ref: string; rebased: boolean }[] = [];
    const walk = (value: unknown, path: readonly string[], rebased: boolean): void => {
        positions.add(JSON.stringify(path));
        if (!isObject(value)) return;
        const base = rebased || (path.length > 0 && (typeof value.$id === 'string' || typeof value.id === 'string'));
        if (typeof value.$ref === 'string') refs.push({ ref: value.$ref, rebased: base });
        for (const key of ['properties', '$defs'] as const) if (isObject(value[key])) for (const [name, child] of Object.entries(value[key])) walk(child, [...path, key, name], base);
        for (const key of ['items', 'additionalProperties'] as const) if (Object.hasOwn(value, key)) walk(value[key], [...path, key], base);
        for (const key of ['prefixItems', 'anyOf'] as const) if (Array.isArray(value[key])) value[key].forEach((child, index) => walk(child, [...path, key, String(index)], base));
    };
    walk(schema, [], false);
    return refs.every(({ ref, rebased }) => {
        if (rebased || !ref.startsWith('#')) return false;
        let pointer: string;
        try { pointer = decodeURIComponent(ref.slice(1)); } catch { return false; }
        if (pointer === '') return true;
        if (!pointer.startsWith('/')) return false;
        return positions.has(JSON.stringify(pointer.slice(1).split('/').map(token => token.replace(/~1/g, '/').replace(/~0/g, '~'))));
    });
}

function partText(part: Part): string {
    if (part.type === 'text') return part.value;
    if (part.type === 'thinking' || isCacheMarker(part) || isStatefulMarker(part)) return '';
    if (part.type === 'data') {
        if (part.mimeType.startsWith('text/')) return Buffer.from(part.data).toString('utf8');
        return `[${part.mimeType.startsWith('image/') ? 'image' : 'document'} omitted: not supported by this model]`;
    }
    if (part.type === 'tool_result') return part.content.map(partText).filter(Boolean).join('\n');
    return '[tool call omitted]';
}

/** Native Claude routes replay their provider thinking. Exact Gemini aliases use
 * ordered empty signature envelopes instead; all other routes discard thinking. */
const NATIVE_ANTHROPIC_MODEL = /^(?:(?:[a-z]{2,6}\.)?anthropic\.)?claude-[a-z0-9.:-]+$/;
export function replaysThinking(model: string): boolean {
    return NATIVE_ANTHROPIC_MODEL.test(model) || geminiRoute(model);
}

export function geminiSignedPart(part: Part): boolean {
    return part.type === 'thinking' && part.value === '' && part.metadata?._completeThinking === ''
        && typeof part.metadata?.signature === 'string' && /^ezil-gemini-v1:[A-Za-z0-9+/=_-]{1,1048576}$/.test(part.metadata.signature)
        && part.metadata.redactedData === undefined;
}

/** One message before conversation pairing, also used for byte counting (conservatively, with thinking). No synthetic history here. */
export function gatewayMessage(message: Message, replayThinking: boolean | 'gemini' = true): { role: Message['role']; content: Block[] } {
    const content: Block[] = [];
    const thinking: ThinkingBlock[] = [];
    if (replayThinking === 'gemini') {
        // A signature belongs only to its immediate next original part. Never let a
        // dropped/invalid part move it to another call. Logical turns merge before this conversion.
        for (let i = 0; i < message.parts.length; i++) {
            const part = message.parts[i]!;
            if (part.type === 'thinking') continue;
            const converted = gatewayMessage({ ...message, parts: [part] }, false).content;
            const prior = message.parts[i - 1];
            const validTarget = (part.type === 'text' && part.value !== '')
                || (part.type === 'tool_call' && converted[0]?.type === 'tool_use');
            if (message.role === 'assistant' && prior?.type === 'thinking' && geminiSignedPart(prior) && validTarget) {
                content.push({ type: 'thinking', thinking: '', signature: prior.metadata!.signature as string });
            }
            if ((part.type === 'text' && !part.value) || isCacheMarker(part) || isStatefulMarker(part)) continue;
            content.push(...converted);
        }
        return { role: message.role, content: content.length ? content : [text('(empty)')] };
    }
    for (const part of message.parts) {
        if (part.type === 'thinking') {
            if (message.role !== 'assistant' || !replayThinking) continue;
            const meta = part.metadata ?? {};
            if (typeof meta.signature === 'string' && meta.signature.startsWith('ezil-gemini-v1:')) continue;
            if (typeof meta.redactedData === 'string') thinking.push({ type: 'redacted_thinking', data: meta.redactedData });
            else if (typeof meta._completeThinking === 'string' && typeof meta.signature === 'string' && meta.signature) {
                thinking.push({ type: 'thinking', thinking: meta._completeThinking, signature: meta.signature });
            }
        } else if (message.role === 'assistant' && part.type === 'tool_call') {
            if (typeof part.callId === 'string' && typeof part.name === 'string' && TOOL_NAME.test(part.callId) && TOOL_NAME.test(part.name) && isObject(part.input) && jsonValue(part.input)) {
                content.push({ type: 'tool_use', id: part.callId, name: part.name, input: part.input });
            } else content.push(text('[tool call omitted: invalid arguments or identifier]'));
        } else if (message.role === 'user' && part.type === 'tool_result') {
            content.push({ type: 'tool_result', tool_use_id: part.callId, content: [text(partText(part) || '(no output)')],
                ...(typeof part.isError === 'boolean' ? { is_error: part.isError } : {}) });
        } else {
            const value = partText(part);
            if (value) content.push(text(value));
        }
    }
    return { role: message.role, content: thinking.length || content.length ? [...thinking, ...content] : [text('(empty)')] };
}

/** Adapted from #160's pairing repair. Merge roles first; preserve orphan output as plain text and
 * synthesize explicit failed results for cancelled calls. Never invent a successful tool result. */
export function gatewayConversation(messages: readonly Message[], tools: readonly GatewayTool[], replayThinking: boolean | 'gemini' = false): { system: TextBlock[]; messages: GatewayMessage[] } {
    const system: TextBlock[] = [];
    const turns: GatewayMessage[] = [];
    const names = new Set(tools.map(tool => tool.name));
    const seen = new Set<string>();
    const source: Message[] = [];
    if (replayThinking === 'gemini') {
        source.push(...messages.filter(message => message.role === 'system'));
        for (const message of messages.filter(message => message.role !== 'system')) {
            const prior = source.at(-1);
            if (prior?.role === message.role) prior.parts.push(...message.parts);
            else source.push({ ...message, parts: [...message.parts] });
        }
    } else source.push(...messages);
    for (const message of source) {
        if (message.role === 'system') {
            for (const part of message.parts) { const value = partText(part); if (value) system.push(text(value)); }
            continue;
        }
        const converted = gatewayMessage(message, replayThinking);
        const content = converted.content.map(block => {
            if (block.type !== 'tool_use') return block;
            if (!names.has(block.name) || seen.has(block.id)) return text('[tool call omitted: unavailable tool or duplicate identifier]');
            seen.add(block.id);
            return block;
        });
        if (replayThinking === 'gemini') for (let i = content.length - 2; i >= 0; i--) {
            if (content[i]?.type === 'thinking' && converted.content[i + 1]?.type === 'tool_use' && content[i + 1]?.type !== 'tool_use') content.splice(i, 1);
        }
        const previous = turns.at(-1);
        if (previous?.role === message.role) previous.content.push(...content);
        else turns.push({ role: message.role, content });
    }
    if (!turns.length || turns[0]!.role !== 'user') turns.unshift({ role: 'user', content: [text('(conversation history)')] });
    // An explicit user continuation avoids unsupported assistant prefill and gives trailing calls a result turn.
    if (turns.at(-1)!.role === 'assistant') turns.push({ role: 'user', content: [text('Continue.')] });
    let pending = new Set<string>();
    for (const turn of turns) {
        if (turn.role === 'assistant') {
            // Merging adjacent assistant messages must also keep signed/redacted thinking before ordinary content.
            const isThinking = (block: Block) => block.type === 'thinking' || block.type === 'redacted_thinking';
            if (replayThinking !== 'gemini') turn.content = [...turn.content.filter(isThinking), ...turn.content.filter(block => !isThinking(block))];
            pending = new Set(turn.content.filter((block): block is ToolUse => block.type === 'tool_use').map(block => block.id));
            continue;
        }
        turn.content = turn.content.map(block => {
            if (block.type !== 'tool_result') return block;
            if (pending.delete(block.tool_use_id)) return block;
            return text(`[Earlier tool output]\n${block.content.map(part => part.text).join('\n')}`);
        });
        turn.content.unshift(...[...pending].map((id): ToolResult => ({ type: 'tool_result', tool_use_id: id, is_error: true,
            content: [text('No result was recorded for this tool call.')] })));
        pending.clear();
    }
    return { system, messages: turns };
}

export function gatewayOutputTokens(model: Pick<ResolvedModel, 'model' | 'maxOutputTokens'>): number {
    const fallback = model.model === KIMI ? 4096 : 8192;
    return Math.max(16, Math.min(16_384, Math.floor(Number.isFinite(model.maxOutputTokens) ? model.maxOutputTokens : fallback)));
}

/** Both protocols' smallest output budget (Messages `max_tokens`, Responses `max_output_tokens`). */
export const MIN_OUTPUT_TOKENS = 16;
/** This request's output budget. A caller's own (`maxTokens`, else `max_tokens`, read as the direct providers read them)
 * can only lower the model's: a larger one is held to the model's limit, and one that is not a safe integer of at least 16
 * is refused here, before anything is sent or held, rather than silently replaced. None (or null) means the model's. */
export function gatewayRequestOutputTokens(model: Pick<ResolvedModel, 'model' | 'maxOutputTokens'>, modelOptions: Record<string, unknown>): number {
    const limit = gatewayOutputTokens(model);
    const requested = modelOptions.maxTokens ?? modelOptions.max_tokens;
    if (requested === undefined || requested === null) return limit;
    if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested < MIN_OUTPUT_TOKENS) {
        throw new GatewayError(`EZiL Models: this request's output token limit must be a whole number of at least ${MIN_OUTPUT_TOKENS}. `
            + 'Nothing was sent or charged', undefined, 'local_output_budget_invalid', undefined, undefined, 'local');
    }
    return Math.min(requested, limit);
}

/** Safe history budget in MODEL TOKENS, independent of the legacy HTTP byte bound.
 * System/tool contents are counted by Copilot; these reserves cover uncounted framing/schema and summary growth. */
export const SUMMARY_RESERVE_TOKENS = 8192;
export const SYSTEM_RESERVE_TOKENS = 2048;
export function gatewayInputTokens(model: Pick<ResolvedModel, 'maxInputTokens' | 'toolReserve'> & Partial<Pick<ResolvedModel, 'contextWindowTokens' | 'maxOutputTokens' | 'model' | 'gatewayMaxRequestBytes'>>): number {
    const output = gatewayOutputTokens({ model: model.model ?? '', maxOutputTokens: model.maxOutputTokens ?? 8192 });
    // All quantities here are TOKENS. Explicit local capacity can only tighten the input allowance.
    // Legacy metadata has no combined context capacity: use a conservative local budget estimate.
    const available = model.contextWindowTokens !== undefined ? Math.min(model.maxInputTokens, model.contextWindowTokens - output)
        : model.gatewayMaxRequestBytes !== undefined ? model.maxInputTokens : Math.min(131_072, model.maxInputTokens) - output;
    return Math.max(1, available - SUMMARY_RESERVE_TOKENS - SYSTEM_RESERVE_TOKENS - (model.toolReserve ?? DEFAULT_TOOL_RESERVE));
}

export function buildGatewayBody(model: ResolvedModel, request: ChatRequest, log?: (line: string) => void): { body: GatewayBody; bytes: Uint8Array<ArrayBuffer> } {
    const tools = gatewayTools(request.tools, log, geminiRoute(model.model));
    // Never a silent chat without its tools: when Copilot offered tools and none of them can be sent to this model,
    // refuse here (nothing sent, nothing charged) with what to do, rather than answer as if no tools existed.
    if (request.tools.length && !tools.length) {
        throw new GatewayError(`EZiL Models: none of this chat's ${request.tools.length} tools can be sent to ${model.model} (their input schemas use `
            + 'features this model cannot take, or they are invalid; see the EZiL Models log). Nothing was sent or charged. Pick another model, '
            + 'or turn those tools off with Configure Tools', undefined, 'local_tools_unsupported', undefined, undefined, 'local');
    }
    const conversation = gatewayConversation(request.messages, tools, geminiRoute(model.model) ? 'gemini' : replaysThinking(model.model));
    const body: GatewayBody = {
        model: model.model, messages: conversation.messages, max_tokens: gatewayRequestOutputTokens(model, request.modelOptions),
        stream: model.model !== KIMI && model.stream !== false,
    };
    if (conversation.system.length) body.system = conversation.system;
    if (tools.length) { body.tools = tools; body.tool_choice = { type: 'auto' }; }
    if (request.toolMode === 'required') log?.('[gateway] required tool choice mapped to auto');
    if (samplingRefused(model.model)) {
        if (['temperature', 'top_p'].some(key => request.modelOptions[key] !== undefined) || model.temperature !== undefined || model.topP !== undefined) log?.(`[gateway] temperature/top_p not sent: ${model.model} refuses sampling options`);
    } else for (const [key, configured] of [['temperature', model.temperature], ['top_p', model.topP]] as const) {
        const value = request.modelOptions[key] ?? configured;
        if (typeof value === 'number' && Number.isFinite(value)) body[key] = Math.max(0, Math.min(1, value));
    }
    // Prompt-cache breakpoints only for a catalog row advertising prompt_cache (Claude routes); a configured cache flag never
    // adds them. Never on a Gemini body:
    // the Gateway's Gemini adapter refuses cache_control on any block. Placed before the byte bound so it counts them.
    if (model.gatewayPromptCache === true && !geminiRoute(model.model)) applyCacheBreakpoints(body as unknown as Parameters<typeof applyCacheBreakpoints>[0], '5m');
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    // The Gateway's limits: 1024 messages, 1024 blocks in one message, body + framing within the input allowance.
    const counts = (): LocalRequestCounts => ({
        bodyBytes: bytes.byteLength, limitBytes: Math.min(gatewayRequestBytes(model) - (model.gatewayMaxRequestBytes === undefined ? INPUT_FRAMING : 0), model.maxInputTokens - INPUT_FRAMING),
        messages: body.messages.length, maxBlocks: body.messages.reduce((most, message) => Math.max(most, message.content.length), 0),
        tools: tools.length, toolBytes: tools.length ? Buffer.byteLength(JSON.stringify(tools), 'utf8') : 0,
    });
    if (body.messages.length > 1024) throw new LocalRequestError('local_too_many_messages', counts());
    if (body.messages.some(message => message.content.length > 1024)) throw new LocalRequestError('local_too_many_blocks', counts());
    if (bytes.byteLength > gatewayRequestBytes(model) || bytes.byteLength + INPUT_FRAMING > model.maxInputTokens
        || (model.gatewayMaxRequestBytes === undefined && bytes.byteLength + INPUT_FRAMING > GATEWAY_INPUT_BYTES)) throw new LocalRequestError('local_input_too_large', counts());
    return { body, bytes };
}

/** Cheap local token estimate. Transport limits are checked on the serialized body before dispatch;
 * JSON punctuation/escaping is never deliberately inflated to provoke a paid background summary. */
export function gatewayTokenCount(value: string | Message, _protocol: GatewayProtocol = 'anthropic-messages'): number {
    return typeof value === 'string' ? estimateTextTokens(value) : estimateMessageTokens(value);
}
