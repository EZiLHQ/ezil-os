// OpenCodeClient over `@opencode/client` 2.x (`opencode serve` v2 HTTP API).
// Only this file knows the SDK; keep the surface in `adapter.ts`.
import { OpenCode } from '@opencode/client';
import type {
    AgentSummary, ChatEvent, ChatMessage, FileDiff, ModelId, ModelSummary, OpenCodeClient, PermissionDecision,
    PermissionRequest, PromptOptions, PromptPart, ProviderSummary, QuestionAnswer, ServerHealth, SessionSummary,
} from './adapter';
import { basicAuthHeader } from './auth';
import * as normalize from './normalize';

export { basicAuthHeader };

export interface V2ClientOptions {
    baseUrl: string;
    /** Workspace folder the server runs sessions in; every request is scoped to it. */
    directory: string;
    password?: string;
    username?: string;
    fetch?: typeof globalThis.fetch;
}

/** `file:///abs/path?start=3&end=9`, the URI shape OpenCode's own web UI sends for mentions. */
export function fileMentionUri(directory: string, part: Extract<PromptPart, { type: 'file' }>): string {
    const absolute = part.path.startsWith('/') ? part.path : `${directory.replace(/\/+$/, '')}/${part.path.replace(/^\.?\//, '')}`;
    const encoded = absolute.split('/').map(segment => encodeURIComponent(segment)).join('/');
    const query = part.start !== undefined ? `?start=${part.start}&end=${part.end ?? part.start}` : '';
    return `file://${encoded}${query}`;
}

export class V2Client implements OpenCodeClient {
    private readonly client: ReturnType<typeof OpenCode.make>;
    private readonly directory: string;

    constructor(options: V2ClientOptions) {
        const headers: Record<string, string> = {};
        if (options.password) headers.authorization = basicAuthHeader(options.username ?? 'opencode', options.password);
        const init: Parameters<typeof OpenCode.make>[0] = { baseUrl: options.baseUrl, headers };
        if (options.fetch) (init as { fetch?: typeof globalThis.fetch }).fetch = options.fetch;
        this.client = OpenCode.make(init);
        this.directory = options.directory;
    }

    private get location(): { directory: string } { return { directory: this.directory }; }

    async health(): Promise<ServerHealth> {
        const info = await this.client.server.info();
        return { version: info.version, pid: info.pid };
    }

    async createSession(options: { title?: string; agent?: string; model?: ModelId } = {}): Promise<SessionSummary> {
        const created = await this.client.session.create({
            location: this.location,
            title: options.title ?? null,
            agent: options.agent ?? null,
            model: options.model ? toRef(options.model) : null,
        });
        return normalize.session(created);
    }

    async listSessions(limit = 50): Promise<SessionSummary[]> {
        const response = await this.client.session.list({ directory: this.directory, limit, order: 'desc' });
        return response.data.filter(info => !info.parentID).map(normalize.session);
    }

    async getSession(sessionId: string): Promise<SessionSummary> {
        return normalize.session(await this.client.session.get({ sessionID: sessionId }));
    }

    async prompt(sessionId: string, parts: PromptPart[], options: PromptOptions = {}): Promise<{ messageId: string }> {
        // v2 keeps model and agent as session state, so switch first, then send text.
        if (options.model) await this.setModel(sessionId, options.model);
        if (options.agent) await this.setAgent(sessionId, options.agent);
        const text = parts.filter((part): part is Extract<PromptPart, { type: 'text' }> => part.type === 'text').map(part => part.text).join('');
        const files = parts.filter((part): part is Extract<PromptPart, { type: 'file' }> => part.type === 'file').map(part => {
            const file: { uri: string; name?: string; mention?: { start: number; end: number; text: string } } = { uri: fileMentionUri(this.directory, part) };
            file.name = part.name ?? part.path.split('/').pop() ?? part.path;
            if (part.mention) file.mention = part.mention;
            return file;
        });
        const agents = parts.filter((part): part is Extract<PromptPart, { type: 'agent' }> => part.type === 'agent').map(part => ({ name: part.name }));
        const accepted = await this.client.session.prompt({ sessionID: sessionId, text, files: files.length ? files : undefined, agents: agents.length ? agents : undefined });
        return { messageId: accepted.id };
    }

    async setModel(sessionId: string, model: ModelId): Promise<void> {
        await this.client.session.switchModel({ sessionID: sessionId, model: toRef(model) });
    }

    async setAgent(sessionId: string, agent: string): Promise<void> {
        await this.client.session.switchAgent({ sessionID: sessionId, agent });
    }

    async abort(sessionId: string): Promise<boolean> {
        const result = await this.client.session.interrupt({ sessionID: sessionId });
        return result.interrupted;
    }

    async *events(signal?: AbortSignal): AsyncIterable<ChatEvent> {
        const options = signal ? { signal } : {};
        for await (const raw of this.client.event.subscribe(options)) {
            for (const event of normalize.event(raw)) yield event;
        }
    }

    async replyPermission(sessionId: string, requestId: string, decision: PermissionDecision, message?: string): Promise<void> {
        const input: { sessionID: string; requestID: string; decision: PermissionDecision; message?: string } = { sessionID: sessionId, requestID: requestId, decision };
        if (message) input.message = message;
        await this.client.permission.reply(input);
    }

    async replyQuestion(sessionId: string, questionId: string, answer: QuestionAnswer): Promise<void> {
        await this.client.session.form.reply({ sessionID: sessionId, formID: questionId, answer });
    }

    async listPendingPermissions(sessionId: string): Promise<PermissionRequest[]> {
        const pending = await this.client.permission.list({ sessionID: sessionId });
        return pending.map(normalize.permission);
    }

    async listProviders(): Promise<ProviderSummary[]> {
        return (await this.client.provider.list({ location: this.location })).data.map(normalize.provider);
    }

    async listModels(): Promise<ModelSummary[]> {
        return (await this.client.model.list({ location: this.location })).data.map(normalize.model);
    }

    async defaultModel(): Promise<ModelId | undefined> {
        const result = await this.client.model.default({ location: this.location });
        return result.data ? { providerID: result.data.providerID, modelID: result.data.id } : undefined;
    }

    async listAgents(): Promise<AgentSummary[]> {
        return (await this.client.agent.list({ location: this.location })).data.map(normalize.agent);
    }

    async getSessionMessages(sessionId: string): Promise<ChatMessage[]> {
        const response = await this.client.message.list({ sessionID: sessionId, order: 'asc', limit: 200 });
        const messages: ChatMessage[] = [];
        for (const info of response.data) {
            const message = normalize.message(info, sessionId);
            if (message) messages.push(message);
        }
        return messages.sort((a, b) => a.created - b.created);
    }

    async getDiff(sessionId: string): Promise<FileDiff[]> {
        return (await this.client.session.diff({ sessionID: sessionId })).map(normalize.fileDiff);
    }

    async findFiles(query: string, limit = 20): Promise<string[]> {
        const result = await this.client.file.find({ location: this.location, query, type: 'file', limit });
        return result.data.map(entry => entry.path);
    }
}

function toRef(model: ModelId): { id: string; providerID: string; variant?: string } {
    return model.variant ? { id: model.modelID, providerID: model.providerID, variant: model.variant } : { id: model.modelID, providerID: model.providerID };
}
