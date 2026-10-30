// VS Code chat request -> OpenAI chat-completions body (OpenAI, Azure OpenAI / Foundry openai/v1,
// any OpenAI-compatible server), and chat-completions SSE chunks -> neutral events.

import type { ResolvedModel } from './config';
import type { SseEvent } from './sse';
import { base64, emptyUsage, IMAGE_MIME_TYPES, isCacheMarker, isStatefulMarker, type ChatRequest, type Message, type Part, type StreamEvent, type Usage } from './types';

type ContentPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
type OpenAIMessage =
    | { role: 'system' | 'user'; content: string | ContentPart[] }
    | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
    | { role: 'tool'; tool_call_id: string; content: string };

function userContent(parts: readonly Part[]): ContentPart[] {
    const out: ContentPart[] = [];
    for (const part of parts) {
        if (part.type === 'text') { if (part.value !== '') out.push({ type: 'text', text: part.value }); }
        else if (part.type === 'data' && !isCacheMarker(part) && !isStatefulMarker(part)) {
            if (IMAGE_MIME_TYPES.has(part.mimeType)) out.push({ type: 'image_url', image_url: { url: `data:${part.mimeType};base64,${base64(part.data)}` } });
            else if (part.mimeType.startsWith('text/')) out.push({ type: 'text', text: Buffer.from(part.data).toString('utf8') });
        }
    }
    return out;
}

function collapse(parts: ContentPart[]): string | ContentPart[] {
    return parts.every(part => part.type === 'text') ? parts.map(part => (part as { text: string }).text).join('') : parts;
}

export function convertMessages(messages: readonly Message[]): OpenAIMessage[] {
    const out: OpenAIMessage[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            const text = message.parts.filter(part => part.type === 'text').map(part => (part as { value: string }).value).join('');
            if (text) out.push({ role: 'system', content: text });
        } else if (message.role === 'assistant') {
            let text = '';
            const toolCalls: NonNullable<Extract<OpenAIMessage, { role: 'assistant' }>['tool_calls']> = [];
            for (const part of message.parts) {
                if (part.type === 'text') text += part.value;
                else if (part.type === 'tool_call') toolCalls.push({ id: part.callId, type: 'function', function: { name: part.name, arguments: JSON.stringify(part.input ?? {}) } });
            }
            if (!text && !toolCalls.length) continue;
            const entry: Extract<OpenAIMessage, { role: 'assistant' }> = { role: 'assistant', content: text || null };
            if (toolCalls.length) entry.tool_calls = toolCalls;
            out.push(entry);
        } else {
            // Tool results become `tool` messages and must directly follow the assistant tool_calls; any
            // other user content in the same VS Code message goes after them.
            const rest: Part[] = [];
            for (const part of message.parts) {
                if (part.type === 'tool_result') {
                    const text = part.content.map(inner => inner.type === 'text' ? inner.value : inner.type === 'data' && inner.mimeType.startsWith('text/') ? Buffer.from(inner.data).toString('utf8') : inner.type === 'data' && IMAGE_MIME_TYPES.has(inner.mimeType) ? '[image attached to tool result omitted]' : '').join('');
                    out.push({ role: 'tool', tool_call_id: part.callId, content: text });
                } else rest.push(part);
            }
            const content = userContent(rest);
            if (content.length) out.push({ role: 'user', content: collapse(content) });
        }
    }
    return out;
}

const EFFORT_TO_OPENAI: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' };

export function buildOpenAIBody(model: ResolvedModel, request: ChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
        model: model.model,
        messages: convertMessages(request.messages),
        stream: true,
    };
    if (model.provider.includeUsage) body.stream_options = { include_usage: true };
    const field = model.provider.maxTokensField ?? (model.provider.type === 'openai-compatible' ? 'max_tokens' : 'max_completion_tokens');
    let maxTokens = model.maxOutputTokens;
    const requested = request.modelOptions.maxTokens ?? request.modelOptions.max_tokens;
    if (typeof requested === 'number' && Number.isInteger(requested) && requested > 0) maxTokens = Math.min(requested, model.maxOutputTokens);
    body[field] = maxTokens;
    if (request.tools.length) {
        body.tools = request.tools.map(tool => ({
            type: 'function',
            function: { name: tool.name, description: tool.description ?? '', parameters: tool.inputSchema ?? { type: 'object', properties: {} } },
        }));
        body.tool_choice = request.toolMode === 'required' ? 'required' : 'auto';
    }
    if (model.thinking && model.thinking.type !== 'disabled' && model.thinking.effort && model.provider.type !== 'openai-compatible') body.reasoning_effort = EFFORT_TO_OPENAI[model.thinking.effort];
    if (model.temperature !== undefined && !body.reasoning_effort) body.temperature = model.temperature;
    return body;
}

type PendingCall = { id: string; name: string; arguments: string };

function usageFrom(raw: unknown, into: Usage): void {
    if (typeof raw !== 'object' || raw === null) return;
    const usage = raw as Record<string, unknown>;
    if (typeof usage.prompt_tokens === 'number') into.inputTokens = usage.prompt_tokens;
    if (typeof usage.completion_tokens === 'number') into.outputTokens = usage.completion_tokens;
    const details = usage.prompt_tokens_details as Record<string, unknown> | undefined;
    if (typeof details?.cached_tokens === 'number') into.cacheReadTokens = details.cached_tokens;
}

/** Translate a chat-completions SSE stream into neutral events. */
export async function* openaiStream(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
    const calls = new Map<number, PendingCall>();
    const usage = emptyUsage();
    let finishReason: string | undefined;
    let sawChunk = false;
    const flushCalls = function* (): Generator<StreamEvent> {
        for (const [index, call] of [...calls.entries()].sort((a, b) => a[0] - b[0])) {
            let input: unknown = {};
            if (call.arguments.trim()) {
                try { input = JSON.parse(call.arguments); } catch { throw new Error(`The model returned invalid JSON for tool call ${call.name}.`); }
            }
            yield { type: 'tool_call', callId: call.id || `call_${index}_${Date.now()}`, name: call.name, input };
        }
        calls.clear();
    };
    // Servers that omit `index` (some OpenAI-compatible ones): a chunk naming an id continues that call, an
    // anonymous chunk continues the most recent call, anything else starts a new one.
    const indexFor = (id: unknown): number => {
        if (typeof id === 'string' && id) { for (const [index, call] of calls) if (call.id === id) return index; return calls.size; }
        return calls.size ? Math.max(...calls.keys()) : 0;
    };
    for await (const { data } of events) {
        const trimmed = data.trim();
        if (!trimmed) continue;
        if (trimmed === '[DONE]') break;
        let chunk: Record<string, unknown>;
        try { chunk = JSON.parse(trimmed); } catch { throw new Error(`Provider sent a malformed stream event: ${trimmed.slice(0, 200)}`); }
        if (chunk.error) {
            const error = chunk.error as Record<string, unknown>;
            throw new Error(`Provider stream error: ${String(error.message ?? JSON.stringify(error))}`);
        }
        sawChunk = true;
        if (chunk.usage) usageFrom(chunk.usage, usage);
        const choices = Array.isArray(chunk.choices) ? chunk.choices as Record<string, unknown>[] : [];
        for (const choice of choices) {
            const delta = (choice.delta ?? {}) as Record<string, unknown>;
            if (typeof delta.content === 'string' && delta.content) yield { type: 'text', value: delta.content };
            const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : typeof delta.reasoning === 'string' ? delta.reasoning : '';
            if (reasoning) yield { type: 'thinking', value: reasoning };
            if (Array.isArray(delta.tool_calls)) {
                for (const raw of delta.tool_calls as Record<string, unknown>[]) {
                    const fn = (raw.function ?? {}) as Record<string, unknown>;
                    const index = typeof raw.index === 'number' ? raw.index : indexFor(raw.id);
                    const call = calls.get(index) ?? { id: '', name: '', arguments: '' };
                    if (typeof raw.id === 'string' && raw.id) call.id = raw.id;
                    if (typeof fn.name === 'string' && fn.name) call.name += fn.name;
                    if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
                    calls.set(index, call);
                }
            }
            if (typeof choice.finish_reason === 'string' && choice.finish_reason) {
                finishReason = choice.finish_reason;
                yield* flushCalls();
            }
        }
    }
    if (!sawChunk) throw new Error('The model stream ended before any response was received.');
    yield* flushCalls();
    yield { type: 'usage', usage };
    yield { type: 'stop', reason: finishReason };
}
