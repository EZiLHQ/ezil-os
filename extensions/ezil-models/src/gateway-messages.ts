// The Bedrock Converse subset of Anthropic Messages. Construct envelopes from an allowlist;
// never forward Copilot's provider-specific options, cache markers or previous reasoning.
import type { GatewayProtocol, ResolvedModel } from './config';
import { base64, isCacheMarker, isStatefulMarker, type ChatRequest, type DataPart, type Message, type Part, type Tool } from './types';

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
export const GATEWAY_INPUT_TOKENS = 131_072;
export const INPUT_FRAMING = 1056;
export const ENVELOPE_RESERVE = 1536;
// Copilot 0.69 counts its tool definitions (38 tools, 54,221 bytes in Agent mode, image e2e
// 2026-10-20) against maxInputTokens itself: a 60 KB reserve double-counted them and forced history
// summarisation on a near-empty conversation. Keep only a margin for counting differences (Copilot
// never counts schema numbers, booleans or punctuation); the byte bound in buildGatewayBody still
// refuses anything over the gateway limit before sending (LocalRequestError, nothing sent).
export const DEFAULT_TOOL_RESERVE = 8_000;
// User images, as the Gateway's default-off Claude image candidate accepts them (EZiL AI Gateway
// src/protocols/anthropic/validate.ts at 8e28cfe4, feat/gw-claude-image-20261106): base64 PNG blocks in user messages only, at most 4 per request,
// each at most 1 MiB decoded and 1-8000 px a side. Its input bound counts each image as CLAUDE_IMAGE_TOKENS in place of
// its base64 bytes. The Gateway validates every chunk and CRC; this checks only what it can say clearly before sending.
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const MAX_IMAGE_DIMENSION = 8000;
export const MAX_REQUEST_IMAGES = 4;
export const CLAUDE_IMAGE_TOKENS = 4784;
/** The code host's `/ai/v1` request cap (worker/src/ai-proxy.ts AI_PROXY_MAX_BODY_BYTES): a larger body is refused there. */
export const AI_PROXY_MAX_BODY_BYTES = 160 * 1024;
const TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
type ObjectValue = Record<string, unknown>;
export type TextBlock = { type: 'text'; text: string };
export type ToolUse = { type: 'tool_use'; id: string; name: string; input: ObjectValue };
export type ToolResult = { type: 'tool_result'; tool_use_id: string; content: TextBlock[]; is_error?: boolean };
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: 'image/png'; data: string } };
export type Block = TextBlock | ImageBlock | ToolUse | ToolResult;
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

/** An image the user attached: a data part directly in a user message (not inside a tool result, not a marker). */
export function isImagePart(part: Part): part is DataPart {
    return part.type === 'data' && part.mimeType.startsWith('image/');
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DEPTHS: Record<number, readonly number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let bit = 0; bit < 8; bit++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
});
function crc32(data: Uint8Array, start: number, end: number): number {
    let crc = 0xffffffff;
    for (let index = start; index < end; index++) crc = (CRC_TABLE[(crc ^ data[index]!) & 255]! ^ (crc >>> 8)) >>> 0;
    return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The Gateway candidate's PNG structure rules (validPng), so an image it would refuse fails here, before sending, and is
 * never picked again from history: signature; IHDR first with valid size, depth and color; every chunk's CRC; no APNG
 * chunks; PLTE before IDAT; contiguous IDAT; no unknown critical chunk; IEND last and at the end; at most 4096 chunks.
 */
function pngProblem(data: Uint8Array): string | undefined {
    const invalid = 'the image is not a valid PNG';
    if (data.byteLength < 8 || !PNG_SIGNATURE.every((byte, index) => data[index] === byte)) return invalid;
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let pos = 8, chunks = 0, header = false, idat = false, afterIdat = false, idatBytes = 0, color = -1, palette = false;
    while (pos + 12 <= data.byteLength && ++chunks <= 4096) {
        const size = view.getUint32(pos), end = pos + 12 + size;
        if (end > data.byteLength) return invalid;
        const type = String.fromCharCode(...data.subarray(pos + 4, pos + 8));
        if (!/^[A-Za-z]{4}$/.test(type) || crc32(data, pos + 4, pos + 8 + size) !== view.getUint32(pos + 8 + size)) return invalid;
        if (!header) {
            if (type !== 'IHDR' || size !== 13) return invalid;
            const width = view.getUint32(pos + 8), height = view.getUint32(pos + 12);
            if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) return `the image is ${width}×${height} px; each side must be 1 to ${MAX_IMAGE_DIMENSION}`;
            color = data[pos + 17]!;
            if (!PNG_DEPTHS[color]?.includes(data[pos + 16]!) || data[pos + 18] !== 0 || data[pos + 19] !== 0 || data[pos + 20]! > 1) return invalid;
            header = true;
        } else if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') {
            return 'animated PNGs are not supported';
        } else if (type === 'IHDR') {
            return invalid;
        } else if (type === 'PLTE') {
            if (palette || idat || size === 0 || size > 768 || size % 3 !== 0) return invalid;
            palette = true;
        } else if (type === 'IDAT') {
            if (afterIdat || (color === 3 && !palette)) return invalid;
            idat = true;
            idatBytes += size;
        } else if (type === 'IEND') {
            return size === 0 && idat && idatBytes > 0 && end === data.byteLength ? undefined : invalid;
        } else {
            if (idat) afterIdat = true;
            if (data[pos + 4]! < 97) return invalid; // an unknown critical chunk
        }
        pos = end;
    }
    return invalid;
}

/** Why EZiL AI would refuse this image, or undefined. Never logs the bytes. */
export function imageProblem(part: DataPart): string | undefined {
    if (part.mimeType !== 'image/png') return `${part.mimeType} images are not supported; only PNG is`;
    if (part.data.byteLength > MAX_IMAGE_BYTES) return 'the image is larger than 1 MiB';
    return pngProblem(part.data);
}

/**
 * The request's current user message, as compaction keeps it (compact.ts `typed`): the last user message with typed text
 * or an attachment, not only tool results; else the last user message.
 */
export function currentUserIndex(messages: readonly Message[]): number {
    let fallback = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]!;
        if (message.role !== 'user') continue;
        if (fallback < 0) fallback = index;
        if (message.parts.some(part => (part.type === 'text' && part.value.trim() !== '') || (part.type === 'data' && !isCacheMarker(part) && !isStatefulMarker(part)))) return index;
    }
    return fallback;
}

/**
 * The images sent as image blocks: valid user images, newest first, up to MAX_REQUEST_IMAGES (Copilot resends the
 * whole chat each turn, and the Gateway counts every image in it). Every other image goes as a marked text note.
 */
export function sendableImages(messages: readonly Message[], imageInput: boolean, from = 0): Set<Part> {
    const chosen = new Set<Part>();
    if (!imageInput) return chosen;
    for (let index = messages.length - 1; index >= from && chosen.size < MAX_REQUEST_IMAGES; index--) {
        if (messages[index]!.role !== 'user') continue;
        const images = messages[index]!.parts.filter(isImagePart).filter(part => !imageProblem(part));
        for (let at = images.length - 1; at >= 0 && chosen.size < MAX_REQUEST_IMAGES; at--) chosen.add(images[at]!);
    }
    return chosen;
}

function imageBlock(part: DataPart): ImageBlock {
    return { type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64(part.data) } };
}

const RECENT_NOTE = `only the ${MAX_REQUEST_IMAGES} most recent images are sent`;
const SIZE_NOTE = "earlier images are left out to fit EZiL AI's request size limit";

function omittedImage(part: DataPart, imageInput: boolean, note = RECENT_NOTE): string {
    if (!imageInput) return '[image omitted: not supported by this model]';
    return `[image omitted: ${imageProblem(part) ?? note}]`;
}

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

/**
 * One message before conversation pairing, also used for byte counting. No synthetic history here. `images` are the
 * user image parts sent as image blocks (sendableImages); any other user image is a marked note, never dropped silently.
 */
export function gatewayMessage(message: Message, images: ReadonlySet<Part> = new Set(), imageInput = false, note?: string): { role: Message['role']; content: Block[] } {
    const content: Block[] = [];
    for (const part of message.parts) {
        if (message.role === 'user' && isImagePart(part)) {
            content.push(images.has(part) ? imageBlock(part) : text(omittedImage(part, imageInput, note)));
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
    return { role: message.role, content: content.length ? content : [text('(empty)')] };
}

/** Adapted from #160's pairing repair. Merge roles first; preserve orphan output as plain text and
 * synthesize explicit failed results for cancelled calls. Never invent a successful tool result. */
export function gatewayConversation(messages: readonly Message[], tools: readonly GatewayTool[], imageInput = false, currentImagesOnly = false): { system: TextBlock[]; messages: GatewayMessage[] } {
    const images = sendableImages(messages, imageInput, currentImagesOnly ? Math.max(0, currentUserIndex(messages)) : 0);
    const note = currentImagesOnly ? SIZE_NOTE : undefined;
    const system: TextBlock[] = [];
    const turns: GatewayMessage[] = [];
    const names = new Set(tools.map(tool => tool.name));
    const seen = new Set<string>();
    for (const message of messages) {
        if (message.role === 'system') {
            for (const part of message.parts) { const value = partText(part); if (value) system.push(text(value)); }
            continue;
        }
        const converted = gatewayMessage(message, images, imageInput, note);
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
    const imageInput = model.capabilities.imageInput && (model.gatewayProtocol ?? 'anthropic-messages') === 'anthropic-messages';
    const serialize = (currentImagesOnly: boolean) => {
        const conversation = gatewayConversation(request.messages, tools, imageInput, currentImagesOnly);
        const body: GatewayBody = {
            model: model.model, messages: conversation.messages, max_tokens: gatewayOutputTokens(model),
            stream: model.model !== KIMI && model.stream !== false,
        };
        if (conversation.system.length) body.system = conversation.system;
        if (tools.length) { body.tools = tools; body.tool_choice = { type: 'auto' }; }
        for (const [key, configured] of [['temperature', model.temperature], ['top_p', model.topP]] as const) {
            const value = request.modelOptions[key] ?? configured;
            if (typeof value === 'number' && Number.isFinite(value)) body[key] = Math.max(0, Math.min(1, value));
        }
        return { body, bytes: new TextEncoder().encode(JSON.stringify(body)) };
    };
    let { body, bytes } = serialize(false);
    // Over the code host's cap with images: earlier messages' images go as notes first, before compaction folds any text.
    if (imageInput && bytes.byteLength > AI_PROXY_MAX_BODY_BYTES) ({ body, bytes } = serialize(true));
    if (request.toolMode === 'required') log?.('[gateway] required tool choice mapped to auto');
    // The Gateway counts each image as CLAUDE_IMAGE_TOKENS in place of its base64 (ASCII, so one byte a character).
    let imageCount = 0, imageBytes = 0;
    for (const message of body.messages) for (const block of message.content) if (block.type === 'image') { imageCount++; imageBytes += block.source.data.length; }
    const bound = bytes.byteLength - imageBytes + imageCount * CLAUDE_IMAGE_TOKENS;
    // The Gateway's limits: 1024 messages, 1024 blocks in one message, body + framing within the input allowance.
    const counts = (raw = false): LocalRequestCounts => ({
        bodyBytes: raw ? bytes.byteLength : bound, limitBytes: raw ? AI_PROXY_MAX_BODY_BYTES : Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens) - INPUT_FRAMING,
        messages: body.messages.length, maxBlocks: body.messages.reduce((most, message) => Math.max(most, message.content.length), 0),
        tools: tools.length, toolBytes: tools.length ? Buffer.byteLength(JSON.stringify(tools), 'utf8') : 0,
    });
    if (body.messages.length > 1024) throw new LocalRequestError('local_too_many_messages', counts());
    if (body.messages.some(message => message.content.length > 1024)) throw new LocalRequestError('local_too_many_blocks', counts());
    if (bound + INPUT_FRAMING > Math.min(GATEWAY_INPUT_TOKENS, model.maxInputTokens)) throw new LocalRequestError('local_input_too_large', counts());
    // Without images the bound above is stricter; with them, the code host's raw cap can be the one that refuses.
    if (bytes.byteLength > AI_PROXY_MAX_BODY_BYTES) throw new LocalRequestError('local_input_too_large', counts(true));
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
export function gatewayTokenCount(value: string | Message, protocol: GatewayProtocol = 'anthropic-messages', imageInput = false): number {
    if (typeof value === 'string') {
        const block = JSON.stringify(text(value));
        return protocol === 'openai-responses' ? escapeNonAscii(block).length : Buffer.byteLength(block, 'utf8');
    }
    if (value.role === 'system') {
        const blocks = value.parts.map(partText).filter(Boolean).map(text);
        return blocks.length ? Buffer.byteLength(JSON.stringify(blocks), 'utf8') : 0;
    }
    // An image the model takes counts as the Gateway counts it (plus its short note's bytes), not as its base64.
    const takes = imageInput && protocol === 'anthropic-messages';
    const images = value.role === 'user' ? sendableImages([value], takes).size : 0;
    return Buffer.byteLength(JSON.stringify(gatewayMessage(value, new Set(), takes)), 'utf8') + images * CLAUDE_IMAGE_TOKENS;
}
