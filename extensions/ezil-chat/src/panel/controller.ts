// Host-side brain of the panel: owns the OpenCode client, the current
// session and the event pump, and translates webview requests into client
// calls. Everything VS Code-specific is injected through `ControllerHost`
// so the relay can be unit-tested with a fake client.
import { errorMessage } from '../errors';
import type { ChatEvent, ChatMessage, FileDiff, ModelId, OpenCodeClient, PermissionRequest, PromptPart } from '../opencode/adapter';
import { modelKey } from '../opencode/adapter';
import type { Catalog, HostToWebview, Mention, ServerStatus, WebviewToHost } from '../protocol';
import type { ServerEndpoint, ServerState } from '../server/manager';
import { isWebviewToHost } from './validate';

export interface ControllerHost {
    post(message: HostToWebview): void;
    /** Fallback file search (editor index) used when no server is connected or the query is empty. */
    searchFiles(query: string, limit: number): Promise<string[]>;
    openFile(path: string, line?: number): Promise<void>;
    showDiff(file: string, patch: string): Promise<void>;
    /** Called after an edit tool finishes so the host can open a review diff. Must not block the event pump. */
    filesEdited(sessionId: string, files: FileDiff[]): Promise<void>;
    log(line: string): void;
    defaults(): { agent?: string; model?: ModelId };
}

export interface ServerLike {
    readonly state: ServerState;
    start(): Promise<ServerEndpoint>;
    restart(): Promise<ServerEndpoint>;
    onDidChangeState(listener: (state: ServerState) => void): { dispose(): void };
}

export function toServerStatus(state: ServerState): ServerStatus {
    switch (state.status) {
        case 'ready': return { status: 'ready', version: state.endpoint.version, baseUrl: state.endpoint.baseUrl };
        case 'starting': return { status: 'starting', attempt: state.attempt };
        case 'error': return { status: 'error', message: state.message };
        default: return { status: 'stopped' };
    }
}

/** Build prompt parts: the text plus one file part per mention, with offsets when the text names it. */
export function buildPromptParts(text: string, mentions: Mention[]): PromptPart[] {
    const parts: PromptPart[] = [{ type: 'text', text }];
    for (const mention of mentions) {
        const part: Extract<PromptPart, { type: 'file' }> = { type: 'file', path: mention.path, name: mention.label };
        if (mention.start !== undefined) { part.start = mention.start; part.end = mention.end ?? mention.start; }
        const token = `@${mention.path}`;
        const at = text.indexOf(token);
        if (at !== -1) part.mention = { start: at, end: at + token.length, text: token };
        parts.push(part);
    }
    return parts;
}

const MAX_PARENT_DEPTH = 8;

export class ChatController {
    private client: OpenCodeClient | undefined;
    private endpointKey = '';
    /** False until the first `server.connected` of the current client; a later one means the SSE stream reconnected. */
    private streamSeen = false;
    private currentSessionId: string | undefined;
    private pendingModel: ModelId | undefined;
    private pendingAgent: string | undefined;
    private catalog: Catalog = { models: [], providers: [], agents: [] };
    /** Subagent session id -> root session id, so their permission cards land on the transcript they block. */
    private readonly roots = new Map<string, string>();
    private pump: AbortController | undefined;
    private catalogTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly subscription: { dispose(): void };
    private disposed = false;

    constructor(
        private readonly host: ControllerHost,
        private readonly server: ServerLike,
        private readonly connect: (endpoint: ServerEndpoint) => OpenCodeClient,
    ) {
        this.subscription = server.onDidChangeState(state => { void this.onServerState(state); });
    }

    get sessionId(): string | undefined { return this.currentSessionId; }
    get models(): Catalog['models'] { return this.catalog.models; }

    dispose(): void {
        this.disposed = true;
        this.subscription.dispose();
        this.pump?.abort();
        this.pump = undefined;
        if (this.catalogTimer) { clearTimeout(this.catalogTimer); this.catalogTimer = undefined; }
    }

    /** Start the server if needed and connect; safe to call repeatedly. */
    async ensureClient(): Promise<OpenCodeClient> {
        const endpoint = await this.server.start();
        return this.attach(endpoint).client;
    }

    /** Connect to `endpoint`, reusing the client when it is the same server. */
    private attach(endpoint: ServerEndpoint): { client: OpenCodeClient; changed: boolean } {
        const key = `${endpoint.baseUrl}|${endpoint.password ?? ''}`;
        if (this.client && this.endpointKey === key) return { client: this.client, changed: false };
        this.pump?.abort();
        this.client = this.connect(endpoint);
        this.endpointKey = key;
        this.streamSeen = false;
        this.roots.clear();
        this.startPump(this.client);
        return { client: this.client, changed: true };
    }

    private async onServerState(state: ServerState): Promise<void> {
        this.host.post({ type: 'server', server: toServerStatus(state) });
        if (state.status === 'ready') {
            try {
                if (!this.attach(state.endpoint).changed) return;
                await this.loadCatalog();
                await this.refreshSessions();
                if (this.currentSessionId) await this.openSession(this.currentSessionId);
            } catch (error) { this.fail(error); }
        } else if (state.status !== 'starting') {
            this.pump?.abort();
            this.pump = undefined;
            this.client = undefined;
            this.endpointKey = '';
        }
    }

    private startPump(client: OpenCodeClient): void {
        const controller = new AbortController();
        this.pump = controller;
        void (async () => {
            try {
                for await (const event of client.events(controller.signal)) {
                    if (controller.signal.aborted) break;
                    await this.onEvent(event);
                }
            } catch (error) {
                if (!controller.signal.aborted) this.host.log(`event stream ended: ${errorMessage(error)}`);
            }
            if (this.pump !== controller || controller.signal.aborted || this.disposed) return;
            // The stream dropped while the server is still considered up: reconnect once it answers.
            this.pump = undefined;
            setTimeout(() => {
                if (this.disposed || this.pump || this.server.state.status !== 'ready' || this.client !== client) return;
                this.startPump(client);
            }, 1000);
        })();
    }

    private async onEvent(event: ChatEvent): Promise<void> {
        if (event.type === 'server.connected') {
            if (!this.streamSeen) { this.streamSeen = true; return; }
            // A reconnect after a drop: anything emitted in between is gone, so rebuild from the server.
            this.host.log('event stream reconnected; re-syncing sessions and transcript');
            await this.resync().catch(error => this.host.log(`re-sync failed: ${errorMessage(error)}`));
            return;
        }
        if (event.type === 'catalog.changed') {
            // A freshly spawned server reports agents/models a moment after /api/info answers; coalesce the burst.
            if (this.catalogTimer) clearTimeout(this.catalogTimer);
            this.catalogTimer = setTimeout(() => {
                this.catalogTimer = undefined;
                if (!this.disposed) void this.loadCatalog().catch(error => this.host.log(`catalog reload failed: ${errorMessage(error)}`));
            }, 300);
            return;
        }
        if (event.type === 'permission.asked' || event.type === 'question.asked') event = await this.tagRoot(event);
        this.host.post({ type: 'event', event });
        if (event.type === 'file.edited') {
            // Fire and forget: the reviewer may keep a diff editor open for a while and must not stall deltas.
            void this.host.filesEdited(event.sessionId, event.files).catch(error => this.host.log(`diff review failed: ${errorMessage(error)}`));
        }
    }

    private async resync(): Promise<void> {
        await this.loadCatalog();
        await this.refreshSessions();
        if (this.currentSessionId) await this.openSession(this.currentSessionId);
    }

    /** Attach `rootSessionId` to cards raised by subagent sessions so the webview shows them on the parent. */
    private async tagRoot<E extends Extract<ChatEvent, { type: 'permission.asked' | 'question.asked' }>>(event: E): Promise<E> {
        const sessionId = event.type === 'permission.asked' ? event.request.sessionId : event.question.sessionId;
        if (!this.client || sessionId === this.currentSessionId) return event;
        const root = await this.rootOf(this.client, sessionId).catch(() => sessionId);
        if (root === sessionId) return event;
        return event.type === 'permission.asked'
            ? { ...event, request: { ...event.request, rootSessionId: root } }
            : { ...event, question: { ...event.question, rootSessionId: root } };
    }

    private async rootOf(client: OpenCodeClient, sessionId: string): Promise<string> {
        const cached = this.roots.get(sessionId);
        if (cached) return cached;
        let id = sessionId;
        for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
            const parent = (await client.getSession(id)).parentId;
            if (!parent || parent === id) break;
            id = parent;
        }
        this.roots.set(sessionId, id);
        return id;
    }

    private async loadCatalog(): Promise<void> {
        const client = this.client;
        if (!client) return;
        const [models, providers, agents] = await Promise.all([client.listModels(), client.listProviders(), client.listAgents()]);
        this.catalog = { models, providers, agents };
        this.host.post({ type: 'catalog', catalog: this.catalog });
        const defaults = this.host.defaults();
        if (!this.pendingModel) {
            this.pendingModel = defaults.model && models.some(model => modelKey(model) === modelKey(defaults.model)) ? defaults.model : await client.defaultModel();
        }
        if (!this.pendingAgent) {
            // Validate the configured agent against the catalog; until the server has reported agents, trust the setting.
            const selectable = agents.filter(agent => agent.mode !== 'subagent' && !agent.hidden);
            const configured = defaults.agent;
            this.pendingAgent = !selectable.length || (configured && selectable.some(agent => agent.id === configured)) ? configured : selectable[0]?.id;
        }
        this.postSelection();
    }

    private postSelection(): void {
        const message: HostToWebview = { type: 'selection' };
        if (this.currentSessionId !== undefined) message.sessionId = this.currentSessionId;
        if (this.pendingModel) message.model = this.pendingModel;
        if (this.pendingAgent) message.agent = this.pendingAgent;
        this.host.post(message);
    }

    private async refreshSessions(): Promise<void> {
        const client = this.client;
        if (!client) return;
        const sessions = await client.listSessions();
        const message: HostToWebview = { type: 'sessions', sessions };
        if (this.currentSessionId !== undefined) message.currentSessionId = this.currentSessionId;
        this.host.post(message);
    }

    /** Pending permissions of the session and of its subagents (tagged with the root so they render). */
    private async pendingPermissions(client: OpenCodeClient, sessionId: string): Promise<PermissionRequest[]> {
        const own = client.listPendingPermissions(sessionId);
        const children = await client.listChildSessions(sessionId).catch(error => { this.host.log(`child sessions unavailable: ${errorMessage(error)}`); return []; });
        const nested = await Promise.all(children.map(async child => {
            this.roots.set(child.id, sessionId);
            const requests = await client.listPendingPermissions(child.id).catch(() => []);
            return requests.map(request => ({ ...request, rootSessionId: sessionId }));
        }));
        return [...await own, ...nested.flat()];
    }

    private async openSession(sessionId: string): Promise<void> {
        const client = await this.ensureClient();
        this.currentSessionId = sessionId;
        const [session, messages, permissions] = await Promise.all([client.getSession(sessionId), client.getSessionMessages(sessionId), this.pendingPermissions(client, sessionId)]);
        if (session.model) this.pendingModel = session.model;
        if (session.agent) this.pendingAgent = session.agent;
        this.postSelection();
        this.host.post({ type: 'messages', sessionId, messages, permissions, questions: [] });
    }

    async newSession(): Promise<string> {
        const client = await this.ensureClient();
        const options: { agent?: string; model?: ModelId } = {};
        if (this.pendingAgent) options.agent = this.pendingAgent;
        if (this.pendingModel) options.model = this.pendingModel;
        const session = await client.createSession(options);
        this.currentSessionId = session.id;
        await this.refreshSessions();
        this.postSelection();
        this.host.post({ type: 'messages', sessionId: session.id, messages: [], permissions: [], questions: [] });
        return session.id;
    }

    async setModel(model: ModelId): Promise<void> {
        this.pendingModel = model;
        if (this.currentSessionId) await (await this.ensureClient()).setModel(this.currentSessionId, model);
        this.postSelection();
    }

    async setAgent(agent: string): Promise<void> {
        this.pendingAgent = agent;
        if (this.currentSessionId) await (await this.ensureClient()).setAgent(this.currentSessionId, agent);
        this.postSelection();
    }

    addMention(mention: Mention): void { this.host.post({ type: 'mention', mention }); }

    async send(text: string, mentions: Mention[]): Promise<void> {
        const client = await this.ensureClient();
        const sessionId = this.currentSessionId ?? await this.newSession();
        const parts = buildPromptParts(text, mentions);
        const accepted = await client.prompt(sessionId, parts);
        const message: ChatMessage = {
            id: accepted.messageId, sessionId, role: 'user', created: Date.now(), streaming: false,
            parts: [{ type: 'text', key: 'text:0', text: mentions.length ? `${text}\n${mentions.map(mention => `📎 ${mention.label}`).join('\n')}`.trim() : text }],
        };
        this.host.post({ type: 'event', event: { type: 'message.user', message } });
    }

    private async searchFiles(query: string, limit: number): Promise<string[]> {
        // The server's ripgrep-backed fuzzy find respects .gitignore; the editor index answers the bare "@" and outages.
        if (this.client && query) {
            try { return await this.client.findFiles(query, limit); } catch (error) { this.host.log(`server file search failed: ${errorMessage(error)}`); }
        }
        return this.host.searchFiles(query, limit);
    }

    /** Entry point for raw webview messages: anything malformed is dropped before it can reach a client call. */
    async handle(raw: unknown): Promise<void> {
        if (!isWebviewToHost(raw)) {
            this.host.log(`ignored malformed webview message: ${describeShape(raw)}`);
            return;
        }
        const message: WebviewToHost = raw;
        // Every branch awaits (no `return promise`) so the catch below sees rejections.
        try {
            switch (message.type) {
                case 'ready': {
                    this.host.post({ type: 'server', server: toServerStatus(this.server.state) });
                    if (this.server.state.status === 'ready' && this.client) {
                        this.host.post({ type: 'catalog', catalog: this.catalog });
                        await this.refreshSessions();
                        this.postSelection();
                        if (this.currentSessionId) await this.openSession(this.currentSessionId);
                    } else if (this.server.state.status !== 'starting') {
                        await this.ensureClient();
                    }
                    return;
                }
                case 'send': await this.send(message.text, message.mentions); return;
                case 'stop': {
                    if (this.currentSessionId) await (await this.ensureClient()).abort(this.currentSessionId);
                    return;
                }
                case 'newSession': { await this.newSession(); return; }
                case 'selectSession': await this.openSession(message.sessionId); return;
                case 'refreshSessions': await this.refreshSessions(); return;
                case 'setModel': await this.setModel(message.model); return;
                case 'setAgent': await this.setAgent(message.agent); return;
                case 'permission': await (await this.ensureClient()).replyPermission(message.sessionId, message.requestId, message.decision); return;
                case 'question': await (await this.ensureClient()).replyQuestion(message.sessionId, message.questionId, message.answer); return;
                case 'searchFiles': {
                    const files = await this.searchFiles(message.query, 20);
                    this.host.post({ type: 'fileResults', requestId: message.requestId, files });
                    return;
                }
                case 'openFile': await this.host.openFile(message.path, message.line); return;
                case 'showDiff': await this.host.showDiff(message.file, message.patch); return;
                case 'restartServer': { await this.server.restart(); return; }
                default: return;
            }
        } catch (error) { this.fail(error); }
    }

    private fail(error: unknown): void {
        const text = errorMessage(error);
        this.host.log(`error: ${text}`);
        this.host.post({ type: 'error', message: text });
    }
}

function describeShape(value: unknown): string {
    if (typeof value !== 'object' || value === null) return typeof value;
    const type = (value as { type?: unknown }).type;
    return typeof type === 'string' ? `type=${type.slice(0, 40)}` : 'no type';
}
