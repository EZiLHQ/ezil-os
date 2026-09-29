// Message relay between the webview protocol and the adapter, with a fake client.
import { expect, test } from 'bun:test';
import type { ChatEvent, OpenCodeClient, SessionSummary } from '../src/opencode/adapter';
import type { HostToWebview } from '../src/protocol';
import { buildPromptParts, ChatController, toServerStatus, type ControllerHost, type ServerLike } from '../src/panel/controller';
import type { ServerEndpoint, ServerState } from '../src/server/manager';

const endpoint: ServerEndpoint = { baseUrl: 'http://127.0.0.1:1', username: 'opencode', password: 'pw', managed: true, version: '2.0.19' };
const summary = (id: string): SessionSummary => ({ id, title: id, directory: '/ws', created: 1, updated: 1, tokens: { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0, agent: 'build', model: { providerID: 'azure', modelID: 'm1' } });

function fakeServer(): ServerLike & { emit(state: ServerState): void; restarts: number } {
    const listeners = new Set<(state: ServerState) => void>();
    const server = {
        state: { status: 'stopped' } as ServerState,
        restarts: 0,
        async start() { server.emit({ status: 'ready', endpoint }); return endpoint; },
        async restart() { server.restarts += 1; return endpoint; },
        onDidChangeState(listener: (state: ServerState) => void) { listeners.add(listener); return { dispose: () => listeners.delete(listener) }; },
        emit(state: ServerState) { server.state = state; for (const listener of listeners) listener(state); },
    };
    return server;
}

function fakeClient() {
    const calls: Array<[string, ...unknown[]]> = [];
    let push: ((event: ChatEvent) => void) | undefined;
    const sessions = new Map<string, SessionSummary>([['ses_1', summary('ses_1')]]);
    const client: OpenCodeClient = {
        async health() { return { version: '2.0.19' }; },
        async createSession(options) { calls.push(['createSession', options]); const created = summary('ses_new'); if (options?.agent) created.agent = options.agent; if (options?.model) created.model = options.model; sessions.set(created.id, created); return created; },
        async listSessions() { return [...sessions.values()].filter(session => !session.parentId); },
        async listChildSessions(parentId) { calls.push(['listChildSessions', parentId]); return [...sessions.values()].filter(session => session.parentId === parentId); },
        async getSession(id) { calls.push(['getSession', id]); return sessions.get(id) ?? summary(id); },
        async prompt(id, parts, options) { calls.push(['prompt', id, parts, options]); return { messageId: 'msg_u' }; },
        async setModel(id, model) { calls.push(['setModel', id, model]); },
        async setAgent(id, agent) { calls.push(['setAgent', id, agent]); },
        async abort(id) { calls.push(['abort', id]); return true; },
        events(signal) {
            return {
                async *[Symbol.asyncIterator]() {
                    const queue: ChatEvent[] = [];
                    let wake: (() => void) | undefined;
                    push = event => { queue.push(event); wake?.(); };
                    while (!signal?.aborted) {
                        if (queue.length) { yield queue.shift()!; continue; }
                        await new Promise<void>(resolve => { wake = resolve; signal?.addEventListener('abort', () => resolve(), { once: true }); });
                    }
                },
            };
        },
        async replyPermission(id, requestId, decision) { calls.push(['replyPermission', id, requestId, decision]); },
        async replyQuestion(id, questionId, answer) { calls.push(['replyQuestion', id, questionId, answer]); },
        async listPendingPermissions(id) { return id === 'ses_1' ? [{ id: 'per_1', sessionId: 'ses_1', action: 'edit', resources: ['a'] }] : id === 'ses_child' ? [{ id: 'per_c', sessionId: 'ses_child', action: 'bash', resources: ['ls'] }] : []; },
        async listProviders() { return [{ id: 'azure', name: 'Azure', enabled: true }]; },
        async listModels() { return [{ providerID: 'azure', modelID: 'm1', name: 'M1', variants: [], enabled: true, contextLimit: 1, status: 'active' as const }, { providerID: 'azure', modelID: 'm2', name: 'M2', variants: ['high'], enabled: true, contextLimit: 1, status: 'active' as const }]; },
        async defaultModel() { return { providerID: 'azure', modelID: 'm1' }; },
        async listAgents() { return [{ id: 'build', name: 'Build', mode: 'primary' as const, hidden: false }, { id: 'plan', name: 'Plan', mode: 'primary' as const, hidden: false }]; },
        async getSessionMessages(id) { calls.push(['getSessionMessages', id]); return [{ id: 'm1', sessionId: id, role: 'user' as const, created: 1, parts: [], streaming: false }]; },
        async findFiles(query) { calls.push(['findFiles', query]); return [`server/${query}.ts`]; },
    };
    return { client, calls, sessions, emit: (event: ChatEvent) => push?.(event) };
}

function harness(defaults: ReturnType<ControllerHost['defaults']> = { agent: 'plan', model: { providerID: 'azure', modelID: 'm2' } }) {
    const posted: HostToWebview[] = [];
    const edited: string[] = [];
    const logs: string[] = [];
    const host: ControllerHost = {
        post: message => posted.push(message),
        async searchFiles(query) { return [`${query}.ts`]; },
        async openFile() {},
        async showDiff() {},
        async filesEdited(_sessionId, files) { edited.push(...files.map(file => file.file)); },
        log: line => logs.push(line),
        defaults: () => defaults,
    };
    const server = fakeServer();
    const fake = fakeClient();
    const controller = new ChatController(host, server, () => fake.client);
    return { controller, posted, edited, logs, server, fake, types: () => posted.map(message => message.type) };
}

test('ready boots the server, then publishes status, catalog, sessions and configured defaults', async () => {
    const { controller, posted, types } = harness();
    await controller.handle({ type: 'ready' });
    await Bun.sleep(20);
    expect(types().slice(0, 2)).toEqual(['server', 'server']);
    expect(types()).toContain('catalog');
    expect(types()).toContain('sessions');
    const selection = posted.filter(message => message.type === 'selection').at(-1);
    expect(selection).toEqual({ type: 'selection', model: { providerID: 'azure', modelID: 'm2' }, agent: 'plan' });
    controller.dispose();
});

test('send without a session creates one with the pending agent/model and relays the user message', async () => {
    const { controller, posted, fake } = harness();
    await controller.handle({ type: 'ready' });
    await controller.handle({ type: 'send', text: 'Fix @src/a.ts now', mentions: [{ path: 'src/a.ts', label: 'src/a.ts' }, { path: 'src/b.ts', start: 2, end: 4, label: 'src/b.ts:2-4' }] });
    expect(fake.calls[0]).toEqual(['createSession', { agent: 'plan', model: { providerID: 'azure', modelID: 'm2' } }]);
    const prompt = fake.calls.find(call => call[0] === 'prompt');
    expect(prompt?.[1]).toBe('ses_new');
    expect(prompt?.[2]).toEqual([
        { type: 'text', text: 'Fix @src/a.ts now' },
        { type: 'file', path: 'src/a.ts', name: 'src/a.ts', mention: { start: 4, end: 13, text: '@src/a.ts' } },
        { type: 'file', path: 'src/b.ts', name: 'src/b.ts:2-4', start: 2, end: 4 },
    ]);
    const userEvent = posted.find(message => message.type === 'event' && message.event.type === 'message.user');
    expect(userEvent).toMatchObject({ type: 'event', event: { type: 'message.user', message: { id: 'msg_u', sessionId: 'ses_new', role: 'user' } } });
    // bun 1.3's toMatchObject spins forever on `messages: []`, so compare the fields directly.
    const opened = posted.filter(message => message.type === 'messages').at(-1);
    expect(opened?.type === 'messages' ? [opened.sessionId, opened.messages.length] : undefined).toEqual(['ses_new', 0]);
    controller.dispose();
});

test('selecting a session loads history and pending permissions; model/agent changes hit the session', async () => {
    const { controller, posted, fake } = harness();
    await controller.handle({ type: 'ready' });
    await controller.handle({ type: 'selectSession', sessionId: 'ses_1' });
    const loaded = posted.filter(message => message.type === 'messages').at(-1);
    expect(loaded).toMatchObject({ sessionId: 'ses_1', permissions: [{ id: 'per_1' }] });
    expect(loaded?.type === 'messages' && loaded.messages).toHaveLength(1);
    expect(posted.filter(message => message.type === 'selection').at(-1)).toMatchObject({ sessionId: 'ses_1', model: { modelID: 'm1' }, agent: 'build' });
    await controller.handle({ type: 'setModel', model: { providerID: 'azure', modelID: 'm2', variant: 'high' } });
    await controller.handle({ type: 'setAgent', agent: 'plan' });
    await controller.handle({ type: 'stop' });
    await controller.handle({ type: 'permission', sessionId: 'ses_1', requestId: 'per_1', decision: 'once' });
    await controller.handle({ type: 'question', sessionId: 'ses_1', questionId: 'frm_1', answer: { k: 'v' } });
    expect(fake.calls.filter(call => !['getSession', 'getSessionMessages', 'listChildSessions'].includes(call[0]))).toEqual([
        ['setModel', 'ses_1', { providerID: 'azure', modelID: 'm2', variant: 'high' }],
        ['setAgent', 'ses_1', 'plan'],
        ['abort', 'ses_1'],
        ['replyPermission', 'ses_1', 'per_1', 'once'],
        ['replyQuestion', 'ses_1', 'frm_1', { k: 'v' }],
    ]);
    controller.dispose();
});

test('server events are relayed to the webview and edits trigger the diff reviewer', async () => {
    const { controller, posted, fake, edited } = harness();
    await controller.handle({ type: 'ready' });
    await Bun.sleep(5);
    fake.emit({ type: 'text.delta', sessionId: 'ses_1', messageId: 'a1', key: 'text:0', delta: 'x' });
    fake.emit({ type: 'file.edited', sessionId: 'ses_1', files: [{ file: 'a.ts', patch: '', additions: 1, deletions: 0, status: 'modified' }] });
    await Bun.sleep(20);
    const relayed = posted.filter(message => message.type === 'event').map(message => message.type === 'event' ? message.event.type : '');
    expect(relayed).toEqual(['text.delta', 'file.edited']);
    expect(edited).toEqual(['a.ts']);
    controller.dispose();
});

test('file search uses the editor index before connecting and the server afterwards; restart and failures flow through the protocol', async () => {
    const { controller, posted, server, fake } = harness();
    await controller.handle({ type: 'searchFiles', requestId: 7, query: 'foo' });
    expect(posted.at(-1)).toEqual({ type: 'fileResults', requestId: 7, files: ['foo.ts'] });
    await controller.handle({ type: 'ready' });
    await controller.handle({ type: 'searchFiles', requestId: 8, query: 'bar' });
    expect(posted.at(-1)).toEqual({ type: 'fileResults', requestId: 8, files: ['server/bar.ts'] });
    await controller.handle({ type: 'searchFiles', requestId: 9, query: '' });
    expect(posted.at(-1)).toEqual({ type: 'fileResults', requestId: 9, files: ['.ts'] }); // bare "@": editor index lists files
    expect(fake.calls.filter(call => call[0] === 'findFiles')).toEqual([['findFiles', 'bar']]);
    await controller.handle({ type: 'restartServer' });
    expect(server.restarts).toBe(1);
    const brokenHost: ControllerHost = {
        post: message => posted.push(message), async searchFiles() { return []; }, async openFile() {}, async showDiff() {}, async filesEdited() {}, log() {}, defaults: () => ({}),
    };
    const broken = new ChatController(brokenHost, { ...server, start: async () => { throw new Error('spawn ENOENT'); } }, () => { throw new Error('unreachable'); });
    await broken.handle({ type: 'send', text: 'hi', mentions: [] });
    expect(posted.at(-1)).toEqual({ type: 'error', message: 'spawn ENOENT' });
    controller.dispose(); broken.dispose();
});

test('a reconnected event stream re-syncs sessions and the open transcript', async () => {
    const { controller, posted, fake } = harness();
    await controller.handle({ type: 'ready' });
    await controller.handle({ type: 'selectSession', sessionId: 'ses_1' });
    const messagesBefore = posted.filter(message => message.type === 'messages').length;
    const historyBefore = fake.calls.filter(call => call[0] === 'getSessionMessages').length;
    fake.emit({ type: 'server.connected' }); // first connect of this client: nothing to catch up on
    await Bun.sleep(20);
    expect(posted.filter(message => message.type === 'messages')).toHaveLength(messagesBefore);
    fake.emit({ type: 'server.connected' }); // stream dropped and came back: events in between are lost
    await Bun.sleep(20);
    expect(fake.calls.filter(call => call[0] === 'getSessionMessages')).toHaveLength(historyBefore + 1);
    const resynced = posted.filter(message => message.type === 'messages').at(-1);
    expect(resynced?.type === 'messages' ? [resynced.sessionId, resynced.messages.length] : undefined).toEqual(['ses_1', 1]);
    expect(posted.filter(message => message.type === 'sessions').length).toBeGreaterThan(1);
    controller.dispose();
});

test('malformed or oversized webview messages are dropped before reaching the client', async () => {
    const { controller, posted, fake, logs } = harness();
    await controller.handle({ type: 'ready' });
    const before = fake.calls.length;
    for (const bad of [
        null, 'send', 42, { type: 'nope' }, { type: 'send' }, { type: 'send', text: 5, mentions: [] },
        { type: 'send', text: 'x'.repeat(200_001), mentions: [] }, { type: 'send', text: 'hi', mentions: [{ path: 'a' }] },
        { type: 'permission', sessionId: 'ses_1', requestId: 'per_1', decision: 'yes' }, { type: 'question', sessionId: 'ses_1', questionId: 'q', answer: { k: { nested: true } } },
        { type: 'setModel', model: { providerID: 'p' } }, { type: 'openFile', path: 7 }, { type: 'showDiff', file: 'a', patch: 4 }, { type: 'searchFiles', requestId: 'x', query: 'q' },
    ]) await controller.handle(bad);
    expect(fake.calls.length).toBe(before);
    expect(posted.filter(message => message.type === 'error')).toHaveLength(0);
    expect(logs.filter(line => line.startsWith('ignored malformed webview message')).length).toBe(14);
    controller.dispose();
});

test('permission cards from subagent sessions are tagged with the root session, live and on open', async () => {
    const { controller, posted, fake } = harness();
    fake.sessions.set('ses_child', { ...summary('ses_child'), parentId: 'ses_1' });
    fake.sessions.set('ses_grandchild', { ...summary('ses_grandchild'), parentId: 'ses_child' });
    await controller.handle({ type: 'ready' });
    await controller.handle({ type: 'selectSession', sessionId: 'ses_1' });
    const opened = posted.filter(message => message.type === 'messages').at(-1);
    expect(opened?.type === 'messages' ? opened.permissions : []).toEqual([
        { id: 'per_1', sessionId: 'ses_1', action: 'edit', resources: ['a'] },
        { id: 'per_c', sessionId: 'ses_child', action: 'bash', resources: ['ls'], rootSessionId: 'ses_1' },
    ]);
    fake.emit({ type: 'permission.asked', request: { id: 'per_g', sessionId: 'ses_grandchild', action: 'bash', resources: ['rm'] } });
    fake.emit({ type: 'question.asked', question: { id: 'frm_g', sessionId: 'ses_grandchild', title: 'Which?', fields: [] } });
    fake.emit({ type: 'permission.asked', request: { id: 'per_other', sessionId: 'ses_other', action: 'bash', resources: ['ls'] } });
    await Bun.sleep(20);
    const events = posted.filter(message => message.type === 'event').map(message => message.type === 'event' ? message.event : undefined);
    expect(events.find(event => event?.type === 'permission.asked' && event.request.id === 'per_g')).toMatchObject({ request: { sessionId: 'ses_grandchild', rootSessionId: 'ses_1' } });
    expect(events.find(event => event?.type === 'question.asked')).toMatchObject({ question: { sessionId: 'ses_grandchild', rootSessionId: 'ses_1' } });
    const other = events.find(event => event?.type === 'permission.asked' && event.request.id === 'per_other');
    expect(other?.type === 'permission.asked' ? other.request.rootSessionId : 'tagged').toBeUndefined(); // a root session of its own
    controller.dispose();
});

test('helpers: prompt parts and server status mapping', () => {
    expect(buildPromptParts('hello', [])).toEqual([{ type: 'text', text: 'hello' }]);
    expect(toServerStatus({ status: 'starting', attempt: 2 })).toEqual({ status: 'starting', attempt: 2 });
    expect(toServerStatus({ status: 'ready', endpoint })).toEqual({ status: 'ready', version: '2.0.19', baseUrl: 'http://127.0.0.1:1' });
    expect(toServerStatus({ status: 'error', message: 'x' })).toEqual({ status: 'error', message: 'x' });
});
