// Pure UI state + reducer for the webview. Rendering lives in main.ts; this
// file has no DOM access so `bun test` can drive it with host messages.
import type {
    AgentSummary, ChatEvent, ChatMessage, MessagePart, ModelId, ModelSummary, PermissionRequest, ProviderSummary,
    Question, SessionSummary, TokenUsage, ToolCall,
} from '../opencode/adapter';
import type { HostToWebview, ServerStatus } from '../protocol';

export interface UiState {
    server: ServerStatus;
    sessions: SessionSummary[];
    currentSessionId?: string;
    messages: ChatMessage[];
    permissions: PermissionRequest[];
    questions: Question[];
    models: ModelSummary[];
    providers: ProviderSummary[];
    agents: AgentSummary[];
    selectedModel?: ModelId;
    selectedAgent?: string;
    /** True between the user's send and the session going idle. */
    busy: boolean;
    error?: string;
}

export function initialState(): UiState {
    return { server: { status: 'stopped' }, sessions: [], messages: [], permissions: [], questions: [], models: [], providers: [], agents: [], busy: false };
}

export function reduce(state: UiState, message: HostToWebview): UiState {
    switch (message.type) {
        case 'server': return { ...state, server: message.server, error: message.server.status === 'error' ? message.server.message : state.error };
        case 'catalog': return { ...state, models: message.catalog.models, providers: message.catalog.providers, agents: message.catalog.agents };
        case 'sessions': {
            const next: UiState = { ...state, sessions: message.sessions };
            if (message.currentSessionId !== undefined) next.currentSessionId = message.currentSessionId;
            return next;
        }
        case 'messages': {
            if (state.currentSessionId !== undefined && message.sessionId !== state.currentSessionId) return state;
            return {
                ...state, currentSessionId: message.sessionId, messages: message.messages, permissions: message.permissions,
                questions: message.questions, busy: message.messages.some(item => item.streaming), error: undefined,
            };
        }
        case 'selection': {
            const next: UiState = { ...state };
            if (message.sessionId !== undefined) {
                next.currentSessionId = message.sessionId;
                if (message.sessionId !== state.currentSessionId) { next.messages = []; next.permissions = []; next.questions = []; next.busy = false; }
            }
            if (message.model !== undefined) next.selectedModel = message.model;
            if (message.agent !== undefined) next.selectedAgent = message.agent;
            return next;
        }
        case 'event': return applyEvent(state, message.event);
        // Composer-only messages: main.ts consumes them before they reach the reducer.
        case 'mention':
        case 'fileResults': return state;
        case 'error': return { ...state, error: message.message, busy: false };
        default: return state;
    }
}

function inCurrent(state: UiState, sessionId: string): boolean { return state.currentSessionId === sessionId; }

function updateSession(state: UiState, sessionId: string, patch: Partial<SessionSummary>): SessionSummary[] {
    return state.sessions.map(session => session.id === sessionId ? { ...session, ...patch } : session);
}

function upsertMessage(messages: ChatMessage[], id: string, create: () => ChatMessage, update: (message: ChatMessage) => ChatMessage): ChatMessage[] {
    const index = messages.findIndex(message => message.id === id);
    if (index === -1) return [...messages, update(create())];
    const existing = messages[index];
    if (!existing) return messages;
    const next = [...messages];
    next[index] = update(existing);
    return next;
}

function upsertPart(parts: MessagePart[], key: string, create: () => MessagePart, update: (part: MessagePart) => MessagePart): MessagePart[] {
    const index = parts.findIndex(part => part.key === key);
    if (index === -1) return [...parts, update(create())];
    const existing = parts[index];
    if (!existing) return parts;
    const next = [...parts];
    next[index] = update(existing);
    return next;
}

function appendText(part: MessagePart, delta: string): MessagePart {
    if (part.type === 'tool') return part;
    return { ...part, text: part.text + delta };
}

function updateTool(part: MessagePart, patch: Partial<ToolCall>): MessagePart {
    if (part.type !== 'tool') return part;
    return { ...part, tool: { ...part.tool, ...patch } };
}

const assistantShell = (event: { sessionId: string; messageId: string }, created = Date.now()): ChatMessage =>
    ({ id: event.messageId, sessionId: event.sessionId, role: 'assistant', created, parts: [], streaming: true });

export function applyEvent(state: UiState, event: ChatEvent): UiState {
    switch (event.type) {
        case 'server.connected': return state;
        case 'session.created': {
            if (state.sessions.some(session => session.id === event.session.id)) return state;
            return { ...state, sessions: [event.session, ...state.sessions] };
        }
        case 'session.updated': {
            const patch: Partial<SessionSummary> = {};
            if (event.title !== undefined) patch.title = event.title;
            if (event.model !== undefined) patch.model = event.model;
            if (event.agent !== undefined) patch.agent = event.agent;
            const next: UiState = { ...state, sessions: updateSession(state, event.sessionId, patch) };
            if (inCurrent(state, event.sessionId)) {
                if (event.model) next.selectedModel = event.model;
                if (event.agent) next.selectedAgent = event.agent;
            }
            return next;
        }
        case 'session.deleted': {
            const next: UiState = { ...state, sessions: state.sessions.filter(session => session.id !== event.sessionId) };
            if (inCurrent(state, event.sessionId)) { next.currentSessionId = undefined; next.messages = []; next.permissions = []; next.questions = []; next.busy = false; }
            return next;
        }
        case 'message.user': {
            if (!inCurrent(state, event.message.sessionId)) return state;
            if (state.messages.some(message => message.id === event.message.id)) return state;
            return { ...state, messages: [...state.messages, event.message], busy: true, error: undefined };
        }
        case 'session.busy': return inCurrent(state, event.sessionId) ? { ...state, busy: true } : state;
        case 'session.idle': {
            if (!inCurrent(state, event.sessionId)) return state;
            return { ...state, busy: false, messages: state.messages.map(message => message.streaming ? { ...message, streaming: false } : message) };
        }
        case 'session.usage': return { ...state, sessions: updateSession(state, event.sessionId, { tokens: event.tokens, cost: event.cost }) };
        case 'turn.started': {
            if (!inCurrent(state, event.sessionId)) return state;
            const messages = upsertMessage(state.messages, event.messageId, () => assistantShell(event, event.created),
                message => ({ ...message, agent: event.agent, model: event.model, streaming: true }));
            return { ...state, messages, busy: true, error: undefined };
        }
        case 'text.delta':
        case 'reasoning.delta': {
            if (!inCurrent(state, event.sessionId)) return state;
            const partType = event.type === 'text.delta' ? 'text' : 'reasoning';
            const messages = upsertMessage(state.messages, event.messageId, () => assistantShell(event), message => ({
                ...message, streaming: true,
                parts: upsertPart(message.parts, event.key, () => ({ type: partType, key: event.key, text: '' }), part => appendText(part, event.delta)),
            }));
            return { ...state, messages, busy: true };
        }
        case 'text.ended': {
            if (!inCurrent(state, event.sessionId)) return state;
            const messages = upsertMessage(state.messages, event.messageId, () => assistantShell(event), message => ({
                ...message,
                parts: upsertPart(message.parts, event.key, () => ({ type: 'text', key: event.key, text: '' }), part => part.type === 'tool' ? part : { ...part, text: event.text }),
            }));
            return { ...state, messages };
        }
        case 'tool.started': {
            if (!inCurrent(state, event.sessionId)) return state;
            const tool: ToolCall = { id: event.toolId, name: event.name, status: 'pending', input: undefined };
            const messages = upsertMessage(state.messages, event.messageId, () => assistantShell(event), message => ({
                ...message, streaming: true,
                parts: upsertPart(message.parts, event.toolId, () => ({ type: 'tool', key: event.toolId, tool }), part => part),
            }));
            return { ...state, messages, busy: true };
        }
        case 'tool.called': {
            if (!inCurrent(state, event.sessionId)) return state;
            const messages = upsertMessage(state.messages, event.messageId, () => assistantShell(event), message => ({
                ...message,
                parts: upsertPart(message.parts, event.toolId,
                    () => ({ type: 'tool', key: event.toolId, tool: { id: event.toolId, name: 'tool', status: 'running', input: event.input } }),
                    part => updateTool(part, { status: 'running', input: event.input })),
            }));
            return { ...state, messages };
        }
        case 'tool.completed':
        case 'tool.failed': {
            if (!inCurrent(state, event.sessionId)) return state;
            const patch: Partial<ToolCall> = event.type === 'tool.completed'
                ? { status: 'completed', output: event.output, ...(event.files ? { files: event.files } : {}), ...(event.metadata ? { metadata: event.metadata } : {}) }
                : { status: 'error', error: event.error.message, ...(event.output !== undefined ? { output: event.output } : {}) };
            const messages = upsertMessage(state.messages, event.messageId, () => assistantShell(event), message => ({
                ...message,
                parts: upsertPart(message.parts, event.toolId,
                    () => ({ type: 'tool', key: event.toolId, tool: { id: event.toolId, name: 'tool', status: 'pending', input: undefined } }),
                    part => updateTool(part, patch)),
            }));
            return { ...state, messages };
        }
        case 'turn.ended': {
            if (!inCurrent(state, event.sessionId)) return state;
            const messages = upsertMessage(state.messages, event.messageId, () => assistantShell(event),
                message => ({ ...message, streaming: false, finish: event.finish, tokens: event.tokens, cost: event.cost }));
            return { ...state, messages };
        }
        case 'turn.failed': {
            if (!inCurrent(state, event.sessionId)) return state;
            const text = `${event.error.type}: ${event.error.message}`;
            if (event.messageId) {
                const messageId = event.messageId;
                const messages = upsertMessage(state.messages, messageId, () => assistantShell({ sessionId: event.sessionId, messageId }),
                    message => ({ ...message, streaming: false, error: text }));
                return { ...state, messages, busy: false };
            }
            return { ...state, busy: false, error: text };
        }
        case 'permission.asked': {
            // Subagent requests carry the root session they block; show them on the parent's transcript.
            if (!inCurrent(state, event.request.rootSessionId ?? event.request.sessionId)) return state;
            if (state.permissions.some(request => request.id === event.request.id)) return state;
            return { ...state, permissions: [...state.permissions, event.request] };
        }
        case 'permission.replied': return { ...state, permissions: state.permissions.filter(request => request.id !== event.requestId) };
        case 'question.asked': {
            if (!inCurrent(state, event.question.rootSessionId ?? event.question.sessionId)) return state;
            if (state.questions.some(question => question.id === event.question.id)) return state;
            return { ...state, questions: [...state.questions, event.question] };
        }
        case 'question.replied': return { ...state, questions: state.questions.filter(question => question.id !== event.questionId) };
        case 'file.edited': return state;
        default: return state;
    }
}

/** Token readout for the most recent completed assistant turn. */
export function lastUsage(state: UiState): { tokens: TokenUsage; cost: number } | undefined {
    for (let index = state.messages.length - 1; index >= 0; index--) {
        const message = state.messages[index];
        if (message?.role === 'assistant' && message.tokens) return { tokens: message.tokens, cost: message.cost ?? 0 };
    }
    return undefined;
}

/** Models grouped by provider for the picker, only enabled ones. */
export function groupModels(models: ModelSummary[], providers: ProviderSummary[]): Array<{ providerID: string; name: string; models: ModelSummary[] }> {
    const names = new Map(providers.map(provider => [provider.id, provider.name]));
    const groups = new Map<string, ModelSummary[]>();
    for (const model of models) {
        if (!model.enabled) continue;
        const list = groups.get(model.providerID) ?? [];
        list.push(model);
        groups.set(model.providerID, list);
    }
    return [...groups.entries()]
        .map(([providerID, list]) => ({ providerID, name: names.get(providerID) ?? providerID, models: list.sort((a, b) => a.name.localeCompare(b.name)) }))
        .sort((a, b) => a.name.localeCompare(b.name));
}
