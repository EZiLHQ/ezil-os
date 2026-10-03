// postMessage contract between the extension host and the webview. The
// webview never talks to OpenCode; everything crosses this boundary.
import type {
    AgentSummary, ChatEvent, ChatMessage, ModelId, ModelSummary, PermissionDecision, PermissionRequest,
    ProviderSummary, Question, QuestionAnswer, SessionSummary,
} from './opencode/adapter';

/** A file (optionally a line range) attached to the next prompt. */
export interface Mention { path: string; start?: number; end?: number; label: string }

export type ServerStatus =
    | { status: 'stopped' }
    | { status: 'starting'; attempt: number }
    | { status: 'ready'; version: string; baseUrl: string }
    | { status: 'error'; message: string };

export interface Catalog { models: ModelSummary[]; providers: ProviderSummary[]; agents: AgentSummary[] }

export type WebviewToHost =
    | { type: 'ready' }
    | { type: 'send'; text: string; mentions: Mention[] }
    | { type: 'stop' }
    | { type: 'newSession' }
    | { type: 'selectSession'; sessionId: string }
    | { type: 'refreshSessions' }
    | { type: 'setModel'; model: ModelId }
    | { type: 'setAgent'; agent: string }
    | { type: 'permission'; sessionId: string; requestId: string; decision: PermissionDecision }
    | { type: 'question'; sessionId: string; questionId: string; answer: QuestionAnswer }
    | { type: 'searchFiles'; requestId: number; query: string }
    | { type: 'openFile'; path: string; line?: number }
    | { type: 'showDiff'; file: string; patch: string }
    | { type: 'restartServer' };

export type HostToWebview =
    | { type: 'server'; server: ServerStatus }
    | { type: 'catalog'; catalog: Catalog }
    | { type: 'sessions'; sessions: SessionSummary[]; currentSessionId?: string }
    | { type: 'messages'; sessionId: string; messages: ChatMessage[]; permissions: PermissionRequest[]; questions: Question[] }
    | { type: 'selection'; sessionId?: string; model?: ModelId; agent?: string }
    | { type: 'event'; event: ChatEvent }
    | { type: 'mention'; mention: Mention }
    | { type: 'fileResults'; requestId: number; files: string[] }
    | { type: 'error'; message: string };
