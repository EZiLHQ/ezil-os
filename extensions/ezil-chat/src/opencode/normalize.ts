// Pure mapping from `@opencode/client` v2 wire shapes to the adapter's
// normalized types. No I/O here so the unit tests can feed literal events.
import type {
    AgentInfo, FileDiffInfo, FormInfo, ModelInfo, OpenCodeEvent, PermissionRequest as V2PermissionRequest,
    ProviderInfo, SessionInfo, SessionMessageInfo, TokenUsageInfo,
} from '@opencode/client';
import type {
    AgentSummary, ChatEvent, ChatMessage, FileDiff, MessagePart, ModelId, ModelSummary, PermissionRequest,
    ProviderSummary, Question, QuestionField, SessionSummary, TokenUsage, ToolCall,
} from './adapter';
import { emptyUsage } from './adapter';

type ToolContent = { type: 'text'; text: string } | { type: 'file'; uri: string; mime: string; name?: string | null | undefined };

export function usage(tokens: TokenUsageInfo | undefined): TokenUsage {
    if (!tokens) return emptyUsage();
    return { input: tokens.input, output: tokens.output, reasoning: tokens.reasoning, cacheRead: tokens.cache.read, cacheWrite: tokens.cache.write };
}

export function modelRef(ref: { id: string; providerID: string; variant?: string } | undefined): ModelId | undefined {
    if (!ref) return undefined;
    return ref.variant ? { providerID: ref.providerID, modelID: ref.id, variant: ref.variant } : { providerID: ref.providerID, modelID: ref.id };
}

export function session(info: SessionInfo): SessionSummary {
    const summary: SessionSummary = {
        id: info.id, title: info.title ?? 'Untitled session', directory: info.location.directory,
        created: info.time.created, updated: info.time.updated, tokens: usage(info.tokens), cost: info.cost,
    };
    if (info.parentID) summary.parentId = info.parentID;
    if (info.agent) summary.agent = info.agent;
    const model = modelRef(info.model);
    if (model) summary.model = model;
    return summary;
}

export function provider(info: ProviderInfo): ProviderSummary {
    return { id: info.id, name: info.name, enabled: info.activation !== 'disabled' };
}

export function model(info: ModelInfo): ModelSummary {
    return {
        providerID: info.providerID, modelID: info.id, name: info.name, enabled: info.enabled, status: info.status,
        variants: info.variants.map(variant => variant.id), contextLimit: info.limit.context,
    };
}

export function agent(info: AgentInfo): AgentSummary {
    const summary: AgentSummary = { id: info.id, name: info.name, mode: info.mode, hidden: info.hidden };
    if (info.description) summary.description = info.description;
    const ref = modelRef(info.model);
    if (ref) summary.model = ref;
    return summary;
}

export function fileDiff(info: FileDiffInfo): FileDiff {
    return { file: info.file, patch: info.patch, additions: info.additions, deletions: info.deletions, status: info.status };
}

function isFileDiff(value: unknown): value is FileDiffInfo {
    return typeof value === 'object' && value !== null && typeof (value as FileDiffInfo).file === 'string' && typeof (value as FileDiffInfo).patch === 'string';
}

/** Edit/write/patch tools report their changes as `metadata.files`. */
export function filesFromMetadata(metadata: Record<string, unknown> | undefined): FileDiff[] | undefined {
    const files = metadata?.files;
    if (!Array.isArray(files)) return undefined;
    const diffs = files.filter(isFileDiff).map(fileDiff);
    return diffs.length ? diffs : undefined;
}

export function toolOutput(content: ReadonlyArray<ToolContent> | undefined): string {
    if (!content) return '';
    return content.map(item => item.type === 'text' ? item.text : `[file ${item.name ?? item.uri}]`).join('\n');
}

export function permission(request: V2PermissionRequest | { id: string; sessionID: string; action: string; resources: Array<string>; save?: Array<string>; metadata?: Record<string, unknown>; message?: string }): PermissionRequest {
    const out: PermissionRequest = { id: request.id, sessionId: request.sessionID, action: request.action, resources: [...request.resources] };
    if (request.save) out.save = [...request.save];
    if (request.message) out.message = request.message;
    if (request.metadata) {
        out.metadata = request.metadata as Record<string, unknown>;
        const files = filesFromMetadata(out.metadata);
        if (files) out.files = files;
    }
    return out;
}

export function question(form: FormInfo | { id: string; sessionID: string; title: string; fields: ReadonlyArray<unknown> }): Question {
    const fields: QuestionField[] = [];
    for (const raw of form.fields) {
        const field = raw as { key: string; type: QuestionField['type']; title?: string; description?: string; required?: boolean; options?: Array<{ value: string; label: string; description?: string }>; custom?: boolean; default?: unknown };
        const out: QuestionField = { key: field.key, type: field.type };
        if (field.title) out.title = field.title;
        if (field.description) out.description = field.description;
        if (field.required !== undefined) out.required = field.required;
        if (field.options) out.options = field.options.map(option => option.description ? { value: option.value, label: option.label, description: option.description } : { value: option.value, label: option.label });
        if (field.custom !== undefined) out.custom = field.custom;
        if (field.default !== undefined) out.defaultValue = field.default as QuestionField['defaultValue'];
        fields.push(out);
    }
    return { id: form.id, sessionId: form.sessionID, title: form.title, fields };
}

/** Text and reasoning parts are keyed by ordinal, tools by their tool id. */
export const textKey = (ordinal: number): string => `text:${ordinal}`;
export const reasoningKey = (ordinal: number): string => `reasoning:${ordinal}`;

export function message(info: SessionMessageInfo, sessionId: string): ChatMessage | undefined {
    if (info.type === 'user') {
        const parts: MessagePart[] = [{ type: 'text', key: textKey(0), text: info.text }];
        return { id: info.id, sessionId, role: 'user', created: info.time.created, parts, streaming: false };
    }
    if (info.type === 'assistant') {
        const parts: MessagePart[] = [];
        info.content.forEach((part, index) => {
            if (part.type === 'text') parts.push({ type: 'text', key: textKey(index), text: part.text });
            else if (part.type === 'reasoning') parts.push({ type: 'reasoning', key: reasoningKey(index), text: part.text });
            else parts.push({ type: 'tool', key: part.id, tool: toolFromMessage(part) });
        });
        const out: ChatMessage = {
            id: info.id, sessionId, role: 'assistant', created: info.time.created, parts, agent: info.agent,
            streaming: info.time.completed === undefined && info.finish === undefined && !info.error,
        };
        const ref = modelRef(info.model);
        if (ref) out.model = ref;
        if (info.tokens) out.tokens = usage(info.tokens);
        if (info.cost !== undefined) out.cost = info.cost;
        if (info.finish) out.finish = info.finish;
        if (info.error) out.error = info.error.message;
        return out;
    }
    if (info.type === 'system') {
        return { id: info.id, sessionId, role: 'system', created: info.time.created, parts: [{ type: 'text', key: textKey(0), text: info.text }], streaming: false };
    }
    return undefined;
}

function toolFromMessage(part: Extract<Extract<SessionMessageInfo, { type: 'assistant' }>['content'][number], { type: 'tool' }>): ToolCall {
    const state = part.state;
    const tool: ToolCall = { id: part.id, name: part.name, status: 'pending', input: undefined };
    if (state.status === 'streaming') { tool.status = 'pending'; tool.input = state.input; return tool; }
    tool.input = state.input;
    if (state.status === 'running') { tool.status = 'running'; return tool; }
    if (state.metadata) {
        tool.metadata = state.metadata as Record<string, unknown>;
        const files = filesFromMetadata(tool.metadata);
        if (files) tool.files = files;
    }
    if (state.status === 'completed') { tool.status = 'completed'; tool.output = toolOutput(state.content); return tool; }
    tool.status = 'error'; tool.error = state.error.message;
    if (state.content) tool.output = toolOutput(state.content);
    return tool;
}

/** Map one v2 event to zero or more normalized events. Unknown events are dropped. */
export function event(raw: OpenCodeEvent): ChatEvent[] {
    switch (raw.type) {
        case 'server.connected': return [{ type: 'server.connected' }];
        case 'provider.updated':
        case 'model.updated':
        case 'agent.updated': return [{ type: 'catalog.changed' }];
        case 'session.created': {
            const d = raw.data;
            const summary: SessionSummary = {
                id: d.sessionID, title: d.title ?? 'Untitled session', directory: d.location.directory,
                created: raw.created, updated: raw.created, tokens: emptyUsage(), cost: 0,
            };
            if (d.parentID) summary.parentId = d.parentID;
            if (d.agent) summary.agent = d.agent;
            const ref = modelRef(d.model);
            if (ref) summary.model = ref;
            return [{ type: 'session.created', session: summary }];
        }
        case 'session.renamed': return [{ type: 'session.updated', sessionId: raw.data.sessionID, title: raw.data.title }];
        case 'session.model.selected': {
            const ref = modelRef(raw.data.model);
            return ref ? [{ type: 'session.updated', sessionId: raw.data.sessionID, model: ref }] : [];
        }
        case 'session.agent.selected': return [{ type: 'session.updated', sessionId: raw.data.sessionID, agent: raw.data.agent }];
        case 'session.deleted': return [{ type: 'session.deleted', sessionId: raw.data.sessionID }];
        case 'session.execution.started': return [{ type: 'session.busy', sessionId: raw.data.sessionID }];
        case 'session.execution.succeeded': return [{ type: 'session.idle', sessionId: raw.data.sessionID, reason: 'succeeded' }];
        case 'session.execution.interrupted': return [{ type: 'session.idle', sessionId: raw.data.sessionID, reason: 'interrupted' }];
        case 'session.execution.failed': return [
            { type: 'turn.failed', sessionId: raw.data.sessionID, error: raw.data.error },
            { type: 'session.idle', sessionId: raw.data.sessionID, reason: 'failed' },
        ];
        case 'session.idle': return [{ type: 'session.idle', sessionId: raw.data.sessionID, reason: 'idle' }];
        case 'session.step.started': {
            const ref = modelRef(raw.data.model) ?? { providerID: '', modelID: '' };
            return [{ type: 'turn.started', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, agent: raw.data.agent, model: ref, created: raw.data.started }];
        }
        case 'session.step.ended': return [{
            type: 'turn.ended', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID,
            finish: raw.data.finish, tokens: usage(raw.data.tokens), cost: raw.data.cost,
        }];
        case 'session.step.failed': return [{ type: 'turn.failed', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, error: raw.data.error }];
        case 'session.text.delta': return [{ type: 'text.delta', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, key: textKey(raw.data.ordinal), delta: raw.data.delta }];
        case 'session.text.ended': return [{ type: 'text.ended', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, key: textKey(raw.data.ordinal), text: raw.data.text }];
        case 'session.reasoning.delta': return [{ type: 'reasoning.delta', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, key: reasoningKey(raw.data.ordinal), delta: raw.data.delta }];
        case 'session.tool.input.started': return [{ type: 'tool.started', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, toolId: raw.data.id, name: raw.data.name }];
        case 'session.tool.called': return [{ type: 'tool.called', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, toolId: raw.data.id, input: raw.data.input }];
        case 'session.tool.success': {
            const metadata = raw.data.metadata as Record<string, unknown> | undefined;
            const files = filesFromMetadata(metadata);
            const done: ChatEvent = { type: 'tool.completed', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, toolId: raw.data.id, output: toolOutput(raw.data.content) };
            if (metadata) done.metadata = metadata;
            if (files) done.files = files;
            const out: ChatEvent[] = [done];
            if (files) out.push({ type: 'file.edited', sessionId: raw.data.sessionID, files });
            return out;
        }
        case 'session.tool.failed': {
            const failed: ChatEvent = { type: 'tool.failed', sessionId: raw.data.sessionID, messageId: raw.data.assistantMessageID, toolId: raw.data.id, error: raw.data.error };
            if (raw.data.content) failed.output = toolOutput(raw.data.content);
            return [failed];
        }
        case 'session.usage.updated': return [{ type: 'session.usage', sessionId: raw.data.sessionID, tokens: usage(raw.data.tokens), cost: raw.data.cost }];
        case 'permission.asked': return [{ type: 'permission.asked', request: permission(raw.data) }];
        case 'permission.replied': return [{ type: 'permission.replied', sessionId: raw.data.sessionID, requestId: raw.data.requestID, decision: raw.data.reply }];
        case 'form.created': return [{ type: 'question.asked', question: question(raw.data.form) }];
        case 'form.replied': return [{ type: 'question.replied', sessionId: raw.data.sessionID, questionId: raw.data.id }];
        case 'form.cancelled': {
            const d = raw.data as { id: string; sessionID: string };
            return [{ type: 'question.replied', sessionId: d.sessionID, questionId: d.id }];
        }
        default: return [];
    }
}
