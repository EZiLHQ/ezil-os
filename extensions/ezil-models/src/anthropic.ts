// VS Code chat request -> Anthropic Messages API body, and Messages SSE stream -> neutral events.
// Mirrors Copilot Chat's own anthropicMessageConverter.ts for cache markers / thinking replay so that
// history produced by this provider round-trips unchanged.

import type { ResolvedModel } from './config';
import type { SseEvent } from './sse';
import { base64, emptyUsage, IMAGE_MIME_TYPES, isCacheMarker, isStatefulMarker, type ChatRequest, type Message, type Part, type StreamEvent, type Usage } from './types';

type CacheControl = { type: 'ephemeral'; ttl?: '1h' };
type Block = Record<string, unknown> & { type: string; cache_control?: CacheControl };
type AnthropicMessage = { role: 'user' | 'assistant'; content: Block[] };

export const MAX_CACHE_BREAKPOINTS = 4;

function supportsCacheControl(block: Block): boolean {
    return block.type !== 'thinking' && block.type !== 'redacted_thinking';
}

function markCache(blocks: Block[]): void {
    const previous = blocks.at(-1);
    if (previous && supportsCacheControl(previous)) previous.cache_control = { type: 'ephemeral' };
    else blocks.push({ type: 'text', text: ' ', cache_control: { type: 'ephemeral' } });
}

function dataBlock(part: Extract<Part, { type: 'data' }>): Block | undefined {
    if (IMAGE_MIME_TYPES.has(part.mimeType)) return { type: 'image', source: { type: 'base64', media_type: part.mimeType, data: base64(part.data) } };
    if (part.mimeType === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64(part.data) } };
    if (part.mimeType.startsWith('text/')) return { type: 'text', text: Buffer.from(part.data).toString('utf8') };
    return undefined;
}

function convertParts(parts: readonly Part[]): Block[] {
    const blocks: Block[] = [];
    for (const part of parts) {
        switch (part.type) {
            case 'text':
                if (part.value !== '') blocks.push({ type: 'text', text: part.value });
                break;
            case 'thinking': {
                const meta = part.metadata ?? {};
                if (typeof meta.redactedData === 'string') blocks.push({ type: 'redacted_thinking', data: meta.redactedData });
                else if (typeof meta._completeThinking === 'string') blocks.push({ type: 'thinking', thinking: meta._completeThinking, signature: typeof meta.signature === 'string' ? meta.signature : '' });
                // incremental thinking deltas are not replayed
                break;
            }
            case 'tool_call':
                blocks.push({ type: 'tool_use', id: part.callId, name: part.name, input: typeof part.input === 'object' && part.input !== null ? part.input : {} });
                break;
            case 'tool_result': {
                const content: Block[] = [];
                for (const inner of part.content) {
                    if (inner.type === 'text') { if (inner.value !== '') content.push({ type: 'text', text: inner.value }); }
                    else if (isCacheMarker(inner)) markCache(content);
                    else if (inner.type === 'data') { const block = dataBlock(inner); if (block) content.push(block); }
                }
                const block: Block = { type: 'tool_result', tool_use_id: part.callId };
                if (content.length) block.content = content;
                if (part.isError) block.is_error = true;
                blocks.push(block);
                break;
            }
            case 'data':
                if (isCacheMarker(part)) markCache(blocks);
                else if (!isStatefulMarker(part)) { const block = dataBlock(part); if (block) blocks.push(block); }
                break;
        }
    }
    return blocks;
}

export function convertMessages(messages: readonly Message[]): { system: Block[]; messages: AnthropicMessage[] } {
    const system: Block[] = [];
    const merged: AnthropicMessage[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            let text = '';
            let cached = false;
            for (const part of message.parts) {
                if (part.type === 'text') text += part.value;
                else if (isCacheMarker(part)) cached = true;
            }
            if (text) { const block: Block = { type: 'text', text }; if (cached) block.cache_control = { type: 'ephemeral' }; system.push(block); }
            else if (cached && system.length) system.at(-1)!.cache_control = { type: 'ephemeral' };
            continue;
        }
        const content = convertParts(message.parts);
        if (!content.length) continue;
        const previous = merged.at(-1);
        if (previous && previous.role === message.role) previous.content.push(...content);
        else merged.push({ role: message.role, content });
    }
    return { system, messages: merged };
}

/**
 * Cache breakpoints, at most 4 per request, render order tools -> system -> messages:
 *  - keep the markers Copilot placed itself (`cache_control` data parts),
 *  - add automatic ones while budget remains, in priority order: last system block (covers tools + system),
 *    last user turn (incremental hits as the conversation grows), last tool (only pays off when the system
 *    prompt changes but the tool list does not),
 *  - if still over budget, drop the earliest markers (later breakpoints still cover the whole prefix).
 */
export function applyCacheBreakpoints(body: { system?: Block[]; tools?: Block[]; messages: AnthropicMessage[] }, ttl: '5m' | '1h'): number {
    const ordered: Block[] = [...(body.tools ?? []), ...(body.system ?? []), ...body.messages.flatMap(message => message.content)];
    const marked = () => ordered.filter(block => block.cache_control);
    const candidates: (Block | undefined)[] = [
        body.system?.at(-1),
        body.messages.filter(message => message.role === 'user').at(-1)?.content.filter(supportsCacheControl).at(-1),
        body.tools?.at(-1),
    ];
    for (const candidate of candidates) {
        if (!candidate || candidate.cache_control) continue;
        if (marked().length >= MAX_CACHE_BREAKPOINTS) break;
        candidate.cache_control = { type: 'ephemeral' };
    }
    let current = marked();
    while (current.length > MAX_CACHE_BREAKPOINTS) { delete current[0]!.cache_control; current = marked(); }
    for (const block of current) block.cache_control = ttl === '1h' ? { type: 'ephemeral', ttl: '1h' } : { type: 'ephemeral' };
    return current.length;
}

export function stripCacheControl(body: { system?: Block[]; tools?: Block[]; messages: AnthropicMessage[] }): void {
    for (const block of [...(body.tools ?? []), ...(body.system ?? []), ...body.messages.flatMap(message => message.content)]) delete block.cache_control;
}

export function buildAnthropicBody(model: ResolvedModel, request: ChatRequest): Record<string, unknown> {
    const { system, messages } = convertMessages(request.messages);
    const body: Record<string, unknown> & { system?: Block[]; tools?: Block[]; messages: AnthropicMessage[] } = {
        model: model.model,
        max_tokens: model.maxOutputTokens,
        stream: true,
        messages,
    };
    if (system.length) body.system = system;
    if (request.tools.length) {
        body.tools = request.tools.map(tool => {
            // Client tools carry no `type`; the Block type's `type` field is only used for content blocks.
            const block = { name: tool.name, input_schema: tool.inputSchema ?? { type: 'object', properties: {} } } as unknown as Block;
            if (tool.description) block.description = tool.description;
            return block;
        });
        if (request.toolMode === 'required' && model.forcedToolChoice) body.tool_choice = { type: 'any' };
    }
    const requested = request.modelOptions.maxTokens ?? request.modelOptions.max_tokens;
    if (typeof requested === 'number' && Number.isInteger(requested) && requested > 0) body.max_tokens = Math.min(requested, model.maxOutputTokens);
    if (model.thinking) {
        if (model.thinking.type === 'adaptive') {
            body.thinking = { type: 'adaptive', display: model.thinking.display ?? 'summarized' };
        } else if (model.thinking.type === 'enabled') {
            const budget = model.thinking.budgetTokens ?? 4096;
            body.thinking = { type: 'enabled', budget_tokens: budget };
            if ((body.max_tokens as number) <= budget) body.max_tokens = Math.min(budget + 1024, Math.max(model.maxOutputTokens, budget + 1024));
        } else {
            body.thinking = { type: 'disabled' };
        }
        if (model.thinking.effort) body.output_config = { effort: model.thinking.effort };
    }
    if (model.temperature !== undefined && (!model.thinking || model.thinking.type === 'disabled')) body.temperature = model.temperature;
    if (model.cache.enabled) applyCacheBreakpoints(body, model.cache.ttl);
    else stripCacheControl(body);
    return body;
}

type PendingBlock =
    | { kind: 'text' }
    | { kind: 'thinking'; thinking: string; signature: string }
    | { kind: 'redacted' }
    | { kind: 'tool_use'; id: string; name: string; json: string };

function usageFrom(raw: unknown, into: Usage): void {
    if (typeof raw !== 'object' || raw === null) return;
    const usage = raw as Record<string, unknown>;
    if (typeof usage.input_tokens === 'number') into.inputTokens = usage.input_tokens;
    if (typeof usage.output_tokens === 'number') into.outputTokens = usage.output_tokens;
    if (typeof usage.cache_read_input_tokens === 'number') into.cacheReadTokens = usage.cache_read_input_tokens;
    if (typeof usage.cache_creation_input_tokens === 'number') into.cacheWriteTokens = usage.cache_creation_input_tokens;
}

/** Translate a Messages API SSE stream into neutral events (text, thinking, tool_call, usage, stop). */
export async function* anthropicStream(events: AsyncIterable<SseEvent>): AsyncGenerator<StreamEvent> {
    const blocks = new Map<number, PendingBlock>();
    const usage = emptyUsage();
    let stopReason: string | undefined;
    let stopDetails: unknown;
    let finished = false;
    for await (const { data } of events) {
        const trimmed = data.trim();
        if (!trimmed) continue;
        let event: Record<string, unknown>;
        try { event = JSON.parse(trimmed); } catch { throw new Error(`Anthropic sent a malformed stream event: ${trimmed.slice(0, 200)}`); }
        switch (event.type) {
            case 'message_start':
                usageFrom((event.message as Record<string, unknown> | undefined)?.usage, usage);
                break;
            case 'content_block_start': {
                const index = event.index as number;
                const block = event.content_block as Record<string, unknown>;
                if (block.type === 'text') { blocks.set(index, { kind: 'text' }); if (typeof block.text === 'string' && block.text) yield { type: 'text', value: block.text }; }
                else if (block.type === 'thinking') blocks.set(index, { kind: 'thinking', thinking: typeof block.thinking === 'string' ? block.thinking : '', signature: '' });
                else if (block.type === 'redacted_thinking') { blocks.set(index, { kind: 'redacted' }); yield { type: 'thinking', value: '', metadata: { redactedData: block.data } }; }
                else if (block.type === 'tool_use') blocks.set(index, { kind: 'tool_use', id: String(block.id), name: String(block.name), json: '' });
                break;
            }
            case 'content_block_delta': {
                const pending = blocks.get(event.index as number);
                const delta = event.delta as Record<string, unknown>;
                if (!pending) break;
                if (delta.type === 'text_delta' && pending.kind === 'text') { if (typeof delta.text === 'string' && delta.text) yield { type: 'text', value: delta.text }; }
                else if (delta.type === 'thinking_delta' && pending.kind === 'thinking') { const text = typeof delta.thinking === 'string' ? delta.thinking : ''; pending.thinking += text; if (text) yield { type: 'thinking', value: text }; }
                else if (delta.type === 'signature_delta' && pending.kind === 'thinking') pending.signature += typeof delta.signature === 'string' ? delta.signature : '';
                else if (delta.type === 'input_json_delta' && pending.kind === 'tool_use') pending.json += typeof delta.partial_json === 'string' ? delta.partial_json : '';
                break;
            }
            case 'content_block_stop': {
                const index = event.index as number;
                const pending = blocks.get(index);
                blocks.delete(index);
                if (!pending) break;
                if (pending.kind === 'tool_use') {
                    let input: unknown = {};
                    if (pending.json.trim()) {
                        try { input = JSON.parse(pending.json); } catch { throw new Error(`The model returned invalid JSON for tool call ${pending.name}.`); }
                    }
                    yield { type: 'tool_call', callId: pending.id, name: pending.name, input };
                } else if (pending.kind === 'thinking') {
                    // Final part carries the complete thinking + signature so the history can be replayed (same shape Copilot uses).
                    yield { type: 'thinking', value: '', metadata: { signature: pending.signature, _completeThinking: pending.thinking } };
                }
                break;
            }
            case 'message_delta':
                usageFrom(event.usage, usage);
                { const delta = event.delta as Record<string, unknown> | undefined; if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason; if (delta?.stop_details) stopDetails = delta.stop_details; }
                break;
            case 'message_stop':
                finished = true;
                break;
            case 'error': {
                const error = event.error as Record<string, unknown> | undefined;
                throw new Error(`Anthropic stream error (${String(error?.type ?? 'unknown')}): ${String(error?.message ?? '')}`);
            }
            default:
                break; // ping and unknown events
        }
        if (finished) break;
    }
    if (!finished && stopReason === undefined) throw new Error('The model stream ended before a message was completed.');
    yield { type: 'usage', usage };
    yield { type: 'stop', reason: stopReason, details: stopDetails };
}
