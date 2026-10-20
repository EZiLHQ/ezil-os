// The Bedrock Converse subset of Anthropic Messages. Construct envelopes from an allowlist;
// never forward Copilot's provider-specific options, cache markers or previous reasoning.
import type { ResolvedModel } from './config';
import { isCacheMarker, isStatefulMarker, type ChatRequest, type Message, type Part, type Tool } from './types';

export const QWEN = 'qwen.qwen3-coder-next';
export const KIMI = 'us.moonshotai.kimi-k3';
export const GATEWAY_INPUT_TOKENS = 131_072;
export const INPUT_FRAMING = 1056;
export const ENVELOPE_RESERVE = 1536;
// Copilot 0.69 counts its tool definitions (38 tools, 54,221 bytes in Agent mode, image e2e
// 2026-10-20) against maxInputTokens itself: a 60 KB reserve double-counted them and forced history
// summarisation on a near-empty conversation. Keep only a margin for counting differences; the
// byte bound in buildGatewayBody still refuses anything over the gateway limit before sending.
export const DEFAULT_TOOL_RESERVE = 8_000;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
type ObjectValue = Record<string, unknown>;
export type TextBlock = { type: 'text'; text: string };
export type ToolUse = { type: 'tool_use'; id: string; name: string; input: ObjectValue };
export type ToolResult = { type: 'tool_result'; tool_use_id: string; content: TextBlock[]; is_error?: boolean };
export type Block = TextBlock | ToolUse | ToolResult;
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

export function gatewayTools(tools: readonly Tool[], log: (line: string) => void = () => {}): GatewayTool[] {
    const names = new Set<string>();
    const dropped = new Set<string>();
    const result: GatewayTool[] = [];
    for (const tool of tools) {
        const schema = tool.inputSchema ?? { type: 'object', properties: {} };
        if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name) || names.has(tool.name) || result.length >= 64 || !isObject(schema) || schema.type !== 'object' || !jsonValue(schema)) {
            dropped.add(String(tool.name));
            continue;
        }
        names.add(tool.name);
        result.push({ name: tool.name, input_schema: schema, ...(typeof tool.description === 'string' && tool.description.trim() ? { description: tool.description } : {}) });
    }
    if (dropped.size) log(`[gateway] dropped tools: ${JSON.stringify([...dropped])}`);
    return result;
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

/** One message before conversation pairing, also used for byte counting. No synthetic history here. */
export function gatewayMessage(message: Message): { role: Message['role']; content: Block[] } {
    const content: Block[] = [];
    for (const part of message.parts) {
        if (message.role === 'assistant' && part.type === 'tool_call') {
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
    return { role: message.role, content: content.length ? content : [text('(empty)')] };
}

/** Adapted from #160's pairing repair. Merge roles first; preserve orphan output as plain text and
 * synthesize explicit failed results for cancelled calls. Never invent a successful tool result. */
export function gatewayConversation(messages: readonly Message[], tools: readonly GatewayTool[]): { system: TextBlock[]; messages: GatewayMessage[] } {
    const system: TextBlock[] = [];
    const turns: GatewayMessage[] = [];
    const names = new Set(tools.map(tool => tool.name));
    const seen = new Set<string>();
    for (const message of messages) {
        if (message.role === 'system') {
            for (const part of message.parts) { const value = partText(part); if (value) system.push(text(value)); }
            continue;
        }
        const converted = gatewayMessage(message);
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
    const tools = gatewayTools(request.tools, log);
    const conversation = gatewayConversation(request.messages, tools);
    const body: GatewayBody = {
        model: model.model, messages: conversation.messages, max_tokens: gatewayOutputTokens(model),
        stream: model.model !== KIMI && model.stream !== false,
    };
    if (conversation.system.length) body.system = conversation.system;
    if (tools.length) { body.tools = tools; body.tool_choice = { type: 'auto' }; }
    if (request.toolMode === 'required') log?.('[gateway] required tool choice mapped to auto');
    for (const [key, configured] of [['temperature', model.temperature], ['top_p', model.topP]] as const) {
        const value = request.modelOptions[key] ?? configured;
        if (typeof value === 'number' && Number.isFinite(value)) body[key] = Math.max(0, Math.min(1, value));
    }
    if (body.messages.length > 1024 || body.messages.some(message => message.content.length > 1024)) throw new Error('Conversation too large — start a new chat');
    const bytes = new TextEncoder().encode(JSON.stringify(body));
    if (bytes.byteLength + INPUT_FRAMING > Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens)) throw new Error('Conversation too large — start a new chat');
    return { body, bytes };
}

/** Copilot does not count tool definitions. Their configurable reserve is subtracted from advertised input. */
export function gatewayTokenCount(value: string | Message): number {
    if (typeof value === 'string') return Buffer.byteLength(JSON.stringify(text(value)), 'utf8');
    if (value.role === 'system') {
        const blocks = value.parts.map(partText).filter(Boolean).map(text);
        return blocks.length ? Buffer.byteLength(JSON.stringify(blocks), 'utf8') : 0;
    }
    return Buffer.byteLength(JSON.stringify(gatewayMessage(value)), 'utf8');
}
