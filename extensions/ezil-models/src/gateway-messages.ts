// The Bedrock Converse subset of Anthropic Messages. Construct envelopes from an allowlist;
// never forward Copilot's provider-specific options, cache markers or unsigned thinking.
import type { GatewayProtocol, ResolvedModel } from './config';
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
 * sampling on gemini-3.8-flash, and gemini-4-argon's handling is unverified, so the Gateway refuses the request rather
 * than drop or forward them. They are never sent for these aliases, whatever Copilot or the config pass.
 */
export const SAMPLING_REFUSED: ReadonlySet<string> = new Set(['gemini-3.8-flash', 'gemini-4-argon']);
export function samplingRefused(alias: string): boolean { return SAMPLING_REFUSED.has(alias.trim().toLowerCase()); }
export const GATEWAY_INPUT_TOKENS = 131_072;
export const INPUT_FRAMING = 1056;
export const ENVELOPE_RESERVE = 1536;
// Copilot 0.69 counts its tool definitions (38 tools, 54,221 bytes in Agent mode, image e2e
// 2026-10-20) against maxInputTokens itself: a 60 KB reserve double-counted them and forced history
// summarisation on a near-empty conversation. Keep only a margin for counting differences (Copilot
// never counts schema numbers, booleans or punctuation); the byte bound in buildGatewayBody still
// refuses anything over the gateway limit before sending (LocalRequestError, nothing sent).
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
export const GEMINI_ALIASES: ReadonlySet<string> = new Set(['gemini-3.8-flash', 'gemini-3.1-pro-preview', 'gemini-4-argon']);
export function geminiRoute(alias: string): boolean { return GEMINI_ALIASES.has(alias.trim().toLowerCase()); }
/** The Gateway's GEMINI_SCHEMA_KEYWORDS, exactly. */
const GEMINI_SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
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
    return node;
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

/**
 * The native-route boundary for replaying signed thinking: only the Gateway's native Anthropic routes (Claude through
 * the Anthropic API, `claude-…`, or Bedrock InvokeModel, `[geo.]anthropic.claude-…`: both forward the provider's own SSE
 * and accept its own signed thinking back) get prior
 * thinking blocks. Every other route drops them as before: Bedrock Converse (Kimi) rejects prior thinking blocks, and
 * other providers never issued a signature. Decided by the explicit Claude model id, never by `family` (it defaults
 * to `gpt`) or by the protocol (Converse models speak anthropic-messages too).
 */
const NATIVE_ANTHROPIC_MODEL = /^(?:(?:[a-z]{2,6}\.)?anthropic\.)?claude-[a-z0-9.:-]+$/;
export function replaysThinking(model: string): boolean {
    return NATIVE_ANTHROPIC_MODEL.test(model);
}

/** One message before conversation pairing, also used for byte counting (conservatively, with thinking). No synthetic history here. */
export function gatewayMessage(message: Message, replayThinking = true): { role: Message['role']; content: Block[] } {
    const content: Block[] = [];
    const thinking: ThinkingBlock[] = [];
    for (const part of message.parts) {
        if (part.type === 'thinking') {
            if (message.role !== 'assistant' || !replayThinking) continue;
            const meta = part.metadata ?? {};
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
export function gatewayConversation(messages: readonly Message[], tools: readonly GatewayTool[], replayThinking = false): { system: TextBlock[]; messages: GatewayMessage[] } {
    const system: TextBlock[] = [];
    const turns: GatewayMessage[] = [];
    const names = new Set(tools.map(tool => tool.name));
    const seen = new Set<string>();
    for (const message of messages) {
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
            turn.content = [...turn.content.filter(isThinking), ...turn.content.filter(block => !isThinking(block))];
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

export function gatewayInputTokens(model: Pick<ResolvedModel, 'maxInputTokens' | 'toolReserve'>): number {
    return Math.max(1, Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens) - INPUT_FRAMING - ENVELOPE_RESERVE - (model.toolReserve ?? DEFAULT_TOOL_RESERVE));
}

export function buildGatewayBody(model: ResolvedModel, request: ChatRequest, log?: (line: string) => void): { body: GatewayBody; bytes: Uint8Array<ArrayBuffer> } {
    const tools = gatewayTools(request.tools, log, geminiRoute(model.model));
    const conversation = gatewayConversation(request.messages, tools, replaysThinking(model.model));
    const body: GatewayBody = {
        model: model.model, messages: conversation.messages, max_tokens: gatewayOutputTokens(model),
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
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    // The Gateway's limits: 1024 messages, 1024 blocks in one message, body + framing within the input allowance.
    const counts = (): LocalRequestCounts => ({
        bodyBytes: bytes.byteLength, limitBytes: Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens) - INPUT_FRAMING,
        messages: body.messages.length, maxBlocks: body.messages.reduce((most, message) => Math.max(most, message.content.length), 0),
        tools: tools.length, toolBytes: tools.length ? Buffer.byteLength(JSON.stringify(tools), 'utf8') : 0,
    });
    if (body.messages.length > 1024) throw new LocalRequestError('local_too_many_messages', counts());
    if (body.messages.some(message => message.content.length > 1024)) throw new LocalRequestError('local_too_many_blocks', counts());
    if (bytes.byteLength + INPUT_FRAMING > Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens)) throw new LocalRequestError('local_input_too_large', counts());
    return { body, bytes };
}

/**
 * Copilot 0.69 calls this for its own tool definitions against maxInputTokens (countToolTokens: one
 * countTokens(string) per schema key and string value; numbers, booleans and falsy entries are not passed; plus 8
 * per tool, 16, and 10%), for its tool budget arithmetic and for its text tool-result cap. Its prompt renderer
 * counts message text with its own o200k_base tokenizer, not this call. A string counts as the text block it would be
 * sent as, 23 bytes over its JSON literal for ASCII. Keep that: Copilot starts background compaction when message
 * plus tool tokens reach 0.78-0.82 of the advertised input, and this heavier tool count starts it while its summary
 * request still fits the byte bound. Measured with a mock on the image (38 agent tools, 53,066 wire bytes; Qwen, 10
 * turns of about 8.5 KB; 3 Nov 2026): this count (about 87,400) compacted and completed all 10 turns; bare literals
 * (about 57,100) delayed compaction until the summary itself was over the bound, and every chat was refused from its
 * 7th turn. 64 tools count over the advertised input (unmeasured). The Responses bound also escapes non-ASCII tool
 * text and adds 128 bytes per tool and 32 per item, so Responses strings count escaped. Messages count as their
 * serialized wire message.
 */
export function gatewayTokenCount(value: string | Message, protocol: GatewayProtocol = 'anthropic-messages'): number {
    if (typeof value === 'string') {
        const block = JSON.stringify(text(value));
        return protocol === 'openai-responses' ? escapeNonAscii(block).length : Buffer.byteLength(block, 'utf8');
    }
    if (value.role === 'system') {
        const blocks = value.parts.map(partText).filter(Boolean).map(text);
        return blocks.length ? Buffer.byteLength(JSON.stringify(blocks), 'utf8') : 0;
    }
    return Buffer.byteLength(JSON.stringify(gatewayMessage(value)), 'utf8');
}
