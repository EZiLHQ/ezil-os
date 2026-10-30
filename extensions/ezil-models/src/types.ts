// Provider-neutral request/response shapes. Everything that talks to a model provider
// (anthropic.ts, openai.ts) works on these, so the converters are testable without the
// `vscode` module; provider.ts bridges VS Code's LanguageModel* classes to and from them.

export type Role = 'system' | 'user' | 'assistant';

export type TextPart = { type: 'text'; value: string };
export type ToolCallPart = { type: 'tool_call'; callId: string; name: string; input: unknown };
export type ToolResultPart = { type: 'tool_result'; callId: string; content: Part[]; isError?: boolean };
/** Binary data (images, PDFs) or one of Copilot's marker parts (`cache_control`, `stateful_marker`). */
export type DataPart = { type: 'data'; mimeType: string; data: Uint8Array };
export type ThinkingPart = { type: 'thinking'; value: string; id?: string; metadata?: Record<string, unknown> };
export type Part = TextPart | ToolCallPart | ToolResultPart | DataPart | ThinkingPart;

export type Message = { role: Role; name?: string; parts: Part[] };

export type Tool = { name: string; description?: string; inputSchema?: unknown };

export type ToolMode = 'auto' | 'required';

export type ChatRequest = {
    messages: Message[];
    tools: Tool[];
    toolMode: ToolMode;
    /** Copilot passes `modelOptions` through; only a few keys are honoured (see anthropic.ts / openai.ts). */
    modelOptions: Record<string, unknown>;
};

/** Mime types Copilot uses for non-content data parts (endpointTypes.ts `CustomDataPartMimeTypes`). */
export const CACHE_CONTROL_MIME = 'cache_control';
export const STATEFUL_MARKER_MIME = 'stateful_marker';

export type Usage = {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
};

export type StreamEvent =
    | { type: 'text'; value: string }
    | { type: 'thinking'; value: string; id?: string; metadata?: Record<string, unknown> }
    | { type: 'tool_call'; callId: string; name: string; input: unknown }
    | { type: 'usage'; usage: Usage }
    | { type: 'stop'; reason: string | undefined; details?: unknown };

export function emptyUsage(): Usage {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function textOf(parts: readonly Part[]): string {
    let out = '';
    for (const part of parts) if (part.type === 'text') out += part.value;
    return out;
}

export function base64(data: Uint8Array): string {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
}

// Plain booleans on purpose: a type predicate would narrow the else-branch away from DataPart.
export function isCacheMarker(part: Part): boolean {
    return part.type === 'data' && part.mimeType === CACHE_CONTROL_MIME;
}

export function isStatefulMarker(part: Part): boolean {
    return part.type === 'data' && part.mimeType === STATEFUL_MARKER_MIME;
}

export const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
