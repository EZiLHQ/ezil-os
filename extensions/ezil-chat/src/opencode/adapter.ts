// Transport-neutral view of an OpenCode server. The webview, the reducer and
// the controller only ever see these shapes; `v2.ts` maps `@opencode/client`
// onto them so a future v1 (or v3) client is a second file, not a rewrite.
// This module must stay free of `vscode` and `node:*` imports: the webview
// bundle type-checks against it too.

export interface ModelId { providerID: string; modelID: string; variant?: string }

export interface TokenUsage { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number }

export interface SessionSummary {
    id: string;
    title: string;
    directory: string;
    agent?: string;
    model?: ModelId;
    created: number;
    updated: number;
    tokens: TokenUsage;
    cost: number;
}

export interface ProviderSummary { id: string; name: string; enabled: boolean }

export interface ModelSummary {
    providerID: string;
    modelID: string;
    name: string;
    variants: string[];
    enabled: boolean;
    contextLimit: number;
    status: 'alpha' | 'beta' | 'deprecated' | 'active';
}

export interface AgentSummary {
    id: string;
    name: string;
    description?: string;
    mode: 'primary' | 'subagent' | 'all';
    hidden: boolean;
    model?: ModelId;
}

/** A user prompt is text plus the files (optionally a line range) it mentions. */
export type PromptPart =
    | { type: 'text'; text: string }
    | { type: 'file'; path: string; start?: number; end?: number; name?: string; mention?: { start: number; end: number; text: string } }
    | { type: 'agent'; name: string };

export interface PromptOptions { model?: ModelId; agent?: string }

export type PermissionDecision = 'once' | 'always' | 'reject';

export interface FileDiff { file: string; patch: string; additions: number; deletions: number; status: 'added' | 'deleted' | 'modified' }

export interface PermissionRequest {
    id: string;
    sessionId: string;
    action: string;
    resources: string[];
    save?: string[];
    message?: string;
    /** Edit/write tools attach a preview diff so the card can show it before approval. */
    files?: FileDiff[];
    metadata?: Record<string, unknown>;
}

export interface QuestionOption { value: string; label: string; description?: string }
export interface QuestionField {
    key: string;
    type: 'string' | 'number' | 'integer' | 'boolean' | 'multiselect' | 'external';
    title?: string;
    description?: string;
    required?: boolean;
    options?: QuestionOption[];
    custom?: boolean;
    defaultValue?: string | number | boolean | string[];
}
/** OpenCode v2 calls these "forms"; the question tool creates one per question. */
export interface Question { id: string; sessionId: string; title: string; fields: QuestionField[] }
export type QuestionAnswer = Record<string, string | number | boolean | string[]>;

export type ToolStatus = 'pending' | 'running' | 'completed' | 'error';
export interface ToolCall {
    id: string;
    name: string;
    status: ToolStatus;
    input: unknown;
    output?: string;
    error?: string;
    files?: FileDiff[];
    metadata?: Record<string, unknown>;
}

export type MessagePart =
    | { type: 'text'; key: string; text: string }
    | { type: 'reasoning'; key: string; text: string }
    | { type: 'tool'; key: string; tool: ToolCall };

export interface ChatMessage {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'system';
    created: number;
    parts: MessagePart[];
    agent?: string;
    model?: ModelId;
    tokens?: TokenUsage;
    cost?: number;
    finish?: string;
    error?: string;
    streaming: boolean;
}

export interface ChatError { type: string; message: string; status?: number }

/** Normalized server events. Every event carries the session it belongs to when it has one. */
export type ChatEvent =
    | { type: 'server.connected' }
    /** Providers, models or agents changed server-side (also fires while a fresh server finishes loading). */
    | { type: 'catalog.changed' }
    | { type: 'session.created'; session: SessionSummary }
    | { type: 'session.updated'; sessionId: string; title?: string; model?: ModelId; agent?: string }
    | { type: 'session.deleted'; sessionId: string }
    /** Emitted by the controller once the server accepted a prompt (v2 has no wire event for it). */
    | { type: 'message.user'; message: ChatMessage }
    | { type: 'turn.started'; sessionId: string; messageId: string; agent: string; model: ModelId; created: number }
    | { type: 'text.delta'; sessionId: string; messageId: string; key: string; delta: string }
    | { type: 'text.ended'; sessionId: string; messageId: string; key: string; text: string }
    | { type: 'reasoning.delta'; sessionId: string; messageId: string; key: string; delta: string }
    | { type: 'tool.started'; sessionId: string; messageId: string; toolId: string; name: string }
    | { type: 'tool.called'; sessionId: string; messageId: string; toolId: string; input: unknown }
    | { type: 'tool.completed'; sessionId: string; messageId: string; toolId: string; output: string; files?: FileDiff[]; metadata?: Record<string, unknown> }
    | { type: 'tool.failed'; sessionId: string; messageId: string; toolId: string; error: ChatError; output?: string }
    | { type: 'turn.ended'; sessionId: string; messageId: string; finish: string; tokens: TokenUsage; cost: number }
    | { type: 'turn.failed'; sessionId: string; messageId?: string; error: ChatError }
    | { type: 'session.busy'; sessionId: string }
    | { type: 'session.idle'; sessionId: string; reason: 'succeeded' | 'failed' | 'interrupted' | 'idle' }
    | { type: 'session.usage'; sessionId: string; tokens: TokenUsage; cost: number }
    | { type: 'permission.asked'; request: PermissionRequest }
    | { type: 'permission.replied'; sessionId: string; requestId: string; decision: PermissionDecision }
    | { type: 'question.asked'; question: Question }
    | { type: 'question.replied'; sessionId: string; questionId: string }
    | { type: 'file.edited'; sessionId: string; files: FileDiff[] };

export interface ServerHealth { version: string; pid?: number }

/**
 * Everything the extension needs from an OpenCode server. Implementations own
 * the transport (HTTP + SSE for v2) and the shape mapping; callers never see
 * SDK types.
 */
export interface OpenCodeClient {
    health(): Promise<ServerHealth>;
    createSession(options?: { title?: string; agent?: string; model?: ModelId }): Promise<SessionSummary>;
    listSessions(limit?: number): Promise<SessionSummary[]>;
    getSession(sessionId: string): Promise<SessionSummary>;
    /** Enqueue a prompt; the turn streams back through {@link events}. Resolves with the user message id. */
    prompt(sessionId: string, parts: PromptPart[], options?: PromptOptions): Promise<{ messageId: string }>;
    setModel(sessionId: string, model: ModelId): Promise<void>;
    setAgent(sessionId: string, agent: string): Promise<void>;
    abort(sessionId: string): Promise<boolean>;
    /** Live event stream; ends when `signal` aborts or the connection drops. */
    events(signal?: AbortSignal): AsyncIterable<ChatEvent>;
    replyPermission(sessionId: string, requestId: string, decision: PermissionDecision, message?: string): Promise<void>;
    replyQuestion(sessionId: string, questionId: string, answer: QuestionAnswer): Promise<void>;
    listPendingPermissions(sessionId: string): Promise<PermissionRequest[]>;
    listProviders(): Promise<ProviderSummary[]>;
    listModels(): Promise<ModelSummary[]>;
    defaultModel(): Promise<ModelId | undefined>;
    listAgents(): Promise<AgentSummary[]>;
    getSessionMessages(sessionId: string): Promise<ChatMessage[]>;
    getDiff(sessionId: string): Promise<FileDiff[]>;
    findFiles(query: string, limit?: number): Promise<string[]>;
}

export const emptyUsage = (): TokenUsage => ({ input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 });

export function modelKey(model: ModelId | undefined): string {
    return model ? `${model.providerID}/${model.modelID}` : '';
}

export function parseModelKey(key: string): ModelId | undefined {
    const slash = key.indexOf('/');
    if (slash <= 0 || slash === key.length - 1) return undefined;
    const [modelID, variant] = key.slice(slash + 1).split('#', 2);
    if (!modelID) return undefined;
    return variant ? { providerID: key.slice(0, slash), modelID, variant } : { providerID: key.slice(0, slash), modelID };
}
