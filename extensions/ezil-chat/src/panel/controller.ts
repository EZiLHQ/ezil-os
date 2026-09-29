// Host-side brain of the panel: owns the OpenCode client, the current
// session and the event pump, and translates webview requests into client
// calls. Everything VS Code-specific is injected through `ControllerHost`
// so the relay can be unit-tested with a fake client.
import type { ChatEvent, ChatMessage, FileDiff, ModelId, OpenCodeClient, PromptPart } from '../opencode/adapter';
import { modelKey } from '../opencode/adapter';
import type { Catalog, HostToWebview, Mention, ServerStatus, WebviewToHost } from '../protocol';
import type { ServerEndpoint, ServerState } from '../server/manager';

export interface ControllerHost {
    post(message: HostToWebview): void;
    searchFiles(query: string, limit: number): Promise<string[]>;
    openFile(path: string, line?: number): Promise<void>;
    showDiff(file: string, patch: string): Promise<void>;
    /** Called after an edit tool finishes so the host can open a review diff. */
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

export class ChatController {
    private client: OpenCodeClient | undefined;
    private endpointKey = '';
    private currentSessionId: string | undefined;
    private pendingModel: ModelId | undefined;
    private pendingAgent: string | undefined;
    private catalog: Catalog = { models: [], providers: [], agents: [] };
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
                if (!controller.signal.aborted) this.host.log(`event stream ended: ${describe(error)}`);
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
        if (event.type === 'catalog.changed') {
            // A freshly spawned server reports agents/models a moment after /api/info answers; coalesce the burst.
            if (this.catalogTimer) clearTimeout(this.catalogTimer);
            this.catalogTimer = setTimeout(() => {
                this.catalogTimer = undefined;
                if (!this.disposed) void this.loadCatalog().catch(error => this.host.log(`catalog reload failed: ${describe(error)}`));
            }, 300);
            return;
        }
        this.host.post({ type: 'event', event });
        if (event.type === 'file.edited') {
            await this.host.filesEdited(event.sessionId, event.files).catch(error => this.host.log(`diff review failed: ${describe(error)}`));
        }
    }

    private async loadCatalog(): Promise<void> {
        const client = this.client;
        if (!client) return;
        const [models, providers, agents] = await Promise.all([client.listModels(), client.listProviders(), client.listAgents()]);
        this.catalog = { models, providers, agents };
        this.host.post({ type: 'catalog', catalog: this.catalog });
        if (!this.pendingModel) {
            const configured = this.host.defaults().model;
            this.pendingModel = configured && models.some(model => modelKey(model) === modelKey(configured)) ? configured : await client.defaultModel();
        }
        if (!this.pendingAgent) this.pendingAgent = this.host.defaults().agent ?? agents.find(agent => agent.mode !== 'subagent' && !agent.hidden)?.id;
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

    private async openSession(sessionId: string): Promise<void> {
        const client = await this.ensureClient();
        this.currentSessionId = sessionId;
        const [session, messages, permissions] = await Promise.all([client.getSession(sessionId), client.getSessionMessages(sessionId), client.listPendingPermissions(sessionId)]);
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

    async handle(message: WebviewToHost): Promise<void> {
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
                    const files = await this.host.searchFiles(message.query, 20);
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
        const text = describe(error);
        this.host.log(`error: ${text}`);
        this.host.post({ type: 'error', message: text });
    }
}

function describe(error: unknown): string {
    if (error instanceof Error) return error.message;
    if (typeof error === 'object' && error && 'message' in error) return String((error as { message: unknown }).message);
    return String(error);
}
