// V2Client against a mock HTTP server that speaks the v2 wire shapes.
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileMentionUri, V2Client } from '../src/opencode/v2';

interface Recorded { method: string; path: string; query: URLSearchParams; body: unknown; auth: string | undefined }
const calls: Recorded[] = [];
let server: Server;
let baseUrl = '';
let sseClients: ServerResponse[] = [];

const sessionInfo = (id: string, title = 'Test') => ({
    id, projectID: 'proj', title, agent: 'build', model: { id: 'claude-sonnet-4-5', providerID: 'azure' }, cost: 0.5,
    tokens: { input: 1, output: 2, reasoning: 3, cache: { read: 4, write: 5 } }, time: { created: 10, updated: 20 }, location: { directory: '/ws' },
});

function readBody(request: IncomingMessage): Promise<unknown> {
    return new Promise(resolve => {
        let raw = '';
        request.on('data', chunk => { raw += chunk; });
        request.on('end', () => { resolve(raw ? JSON.parse(raw) : undefined); });
    });
}

function json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
}

export function sseEvent(payload: unknown): string { return `data: ${JSON.stringify(payload)}\n\n`; }

beforeAll(async () => {
    server = createServer(async (request, response) => {
        const url = new URL(request.url ?? '/', 'http://127.0.0.1');
        const body = await readBody(request);
        calls.push({ method: request.method ?? '', path: url.pathname, query: url.searchParams, body, auth: request.headers.authorization });
        if (request.headers.authorization !== `Basic ${Buffer.from('opencode:secret').toString('base64')}`) return json(response, 401, { type: 'Unauthorized', message: 'Authentication required' });
        const route = `${request.method} ${url.pathname}`;
        if (route === 'GET /api/info') return json(response, 200, { version: '2.0.19', pid: 1, urls: [baseUrl], paths: { tmp: '/tmp' } });
        if (route === 'POST /api/session') return json(response, 200, { data: sessionInfo('ses_new', (body as { title?: string }).title ?? 'Untitled session') });
        if (route === 'GET /api/session') return json(response, 200, { data: [sessionInfo('ses_1'), { ...sessionInfo('ses_child'), parentID: 'ses_1' }], cursor: {} });
        if (route === 'GET /api/session/ses_1') return json(response, 200, { data: sessionInfo('ses_1') });
        if (route === 'POST /api/session/ses_1/model' || route === 'POST /api/session/ses_1/agent') { response.writeHead(204); return response.end(); }
        if (route === 'POST /api/session/ses_1/prompt') return json(response, 200, { data: { id: 'msg_u1', sessionID: 'ses_1', time: { created: 1 }, type: 'user', payload: body, delivery: 'steer' } });
        if (route === 'POST /api/session/ses_1/interrupt') return json(response, 200, { interrupted: true });
        if (route === 'POST /api/session/ses_1/permission/per_1/reply') { response.writeHead(204); return response.end(); }
        if (route === 'POST /api/session/ses_1/form/frm_1/reply') { response.writeHead(204); return response.end(); }
        if (route === 'GET /api/session/ses_1/permission') return json(response, 200, { data: [{ id: 'per_1', sessionID: 'ses_1', action: 'edit', resources: ['/ws/a.ts'] }] });
        if (route === 'GET /api/session/ses_1/diff') return json(response, 200, { data: [{ file: 'a.ts', patch: '@@', additions: 1, deletions: 0, status: 'modified' }] });
        if (route === 'GET /api/session/ses_1/message') return json(response, 200, { data: [
            { id: 'm2', time: { created: 2, completed: 3 }, type: 'assistant', agent: 'build', model: { id: 'x', providerID: 'p' }, content: [{ type: 'text', text: 'hello' }], finish: 'stop' },
            { id: 'm1', time: { created: 1 }, type: 'user', text: 'hi' },
        ], cursor: {} });
        if (route === 'GET /api/model') return json(response, 200, { location: { directory: '/ws' }, data: [
            { id: 'claude-sonnet-4-5', modelID: 'claude-sonnet-4-5', providerID: 'azure', name: 'Claude Sonnet 4.5', capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [{ id: 'high' }], time: { released: 0 }, cost: [], status: 'active', enabled: true, limit: { context: 200000, output: 64000 } },
            { id: 'off', modelID: 'off', providerID: 'opencode', name: 'Off', capabilities: { tools: true, input: ['text'], output: ['text'] }, variants: [], time: { released: 0 }, cost: [], status: 'active', enabled: false, limit: { context: 1, output: 1 } },
        ] });
        if (route === 'GET /api/model/default') return json(response, 200, { location: { directory: '/ws' }, data: { id: 'claude-sonnet-4-5', providerID: 'azure' } });
        if (route === 'GET /api/provider') return json(response, 200, { location: { directory: '/ws' }, data: [{ id: 'azure', name: 'Azure', activation: 'enabled', package: 'x' }, { id: 'opencode', name: 'OpenCode Zen', activation: 'disabled', package: 'x' }] });
        if (route === 'GET /api/agent') return json(response, 200, { location: { directory: '/ws' }, data: [
            { id: 'build', name: 'Build', mode: 'primary', hidden: false, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
            { id: 'title', name: 'Title', mode: 'primary', hidden: true, request: { settings: {}, headers: {}, body: {} }, permissions: [] },
        ] });
        if (route === 'GET /api/fs/find') return json(response, 200, { location: { directory: '/ws' }, data: [{ path: 'src/a.ts', type: 'file' }] });
        if (route === 'GET /api/event') {
            response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
            response.write(sseEvent({ id: 'evt_0', type: 'server.connected', data: {} }));
            sseClients.push(response);
            request.on('close', () => { sseClients = sseClients.filter(client => client !== response); });
            return;
        }
        json(response, 404, { type: 'NotFound', message: route });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterAll(() => { for (const client of sseClients) client.end(); server.close(); });

const client = () => new V2Client({ baseUrl, directory: '/ws', password: 'secret' });
const last = () => calls[calls.length - 1]!;

test('sends basic auth and scopes list calls to the workspace directory', async () => {
    const c = client();
    expect(await c.health()).toEqual({ version: '2.0.19', pid: 1 });
    expect(last().auth).toBe(`Basic ${Buffer.from('opencode:secret').toString('base64')}`);
    const unauthenticated = new V2Client({ baseUrl, directory: '/ws' });
    await expect(unauthenticated.health()).rejects.toMatchObject({ message: 'Authentication required' });
    await c.listModels();
    expect(last().path).toBe('/api/model');
    expect(last().query.get('location[directory]')).toBe('/ws');
});

test('sessions: create with location, list drops subagent children, get normalizes tokens', async () => {
    const c = client();
    const created = await c.createSession({ title: 'Hello', agent: 'plan', model: { providerID: 'azure', modelID: 'gpt-5', variant: 'high' } });
    expect(last()).toMatchObject({ method: 'POST', path: '/api/session', body: { title: 'Hello', agent: 'plan', model: { id: 'gpt-5', providerID: 'azure', variant: 'high' }, location: { directory: '/ws' } } });
    expect(created).toMatchObject({ id: 'ses_new', title: 'Hello', directory: '/ws', agent: 'build', model: { providerID: 'azure', modelID: 'claude-sonnet-4-5' } });
    const sessions = await c.listSessions(10);
    expect(last().query.get('directory')).toBe('/ws');
    expect(last().query.get('limit')).toBe('10');
    expect(sessions.map(session => session.id)).toEqual(['ses_1']);
    expect(sessions[0]?.tokens).toEqual({ input: 1, output: 2, reasoning: 3, cacheRead: 4, cacheWrite: 5 });
    expect((await c.getSession('ses_1')).cost).toBe(0.5);
});

test('prompt switches model/agent first, then posts text with file mentions as file:// URIs', async () => {
    const c = client();
    const before = calls.length;
    const result = await c.prompt('ses_1', [
        { type: 'text', text: 'Look at @src/a.ts please' },
        { type: 'file', path: 'src/a.ts', name: 'a.ts', mention: { start: 8, end: 17, text: '@src/a.ts' } },
        { type: 'file', path: 'src/b.ts', start: 3, end: 9 },
        { type: 'agent', name: 'explore' },
    ], { model: { providerID: 'azure', modelID: 'gpt-5' }, agent: 'plan' });
    const sequence = calls.slice(before);
    expect(sequence.map(call => `${call.method} ${call.path}`)).toEqual([
        'POST /api/session/ses_1/model', 'POST /api/session/ses_1/agent', 'POST /api/session/ses_1/prompt',
    ]);
    expect(sequence[0]?.body).toEqual({ model: { id: 'gpt-5', providerID: 'azure' } });
    expect(sequence[1]?.body).toEqual({ agent: 'plan' });
    expect(sequence[2]?.body).toMatchObject({
        text: 'Look at @src/a.ts please',
        files: [
            { uri: 'file:///ws/src/a.ts', name: 'a.ts', mention: { start: 8, end: 17, text: '@src/a.ts' } },
            { uri: 'file:///ws/src/b.ts?start=3&end=9', name: 'b.ts' },
        ],
        agents: [{ name: 'explore' }],
    });
    expect(result).toEqual({ messageId: 'msg_u1' });
    expect(fileMentionUri('/ws', { type: 'file', path: '/abs/with space.ts' })).toBe('file:///abs/with%20space.ts');
});

test('permission, question, abort, diff, messages, catalog and file search map to v2 routes', async () => {
    const c = client();
    await c.replyPermission('ses_1', 'per_1', 'always');
    expect(last()).toMatchObject({ method: 'POST', path: '/api/session/ses_1/permission/per_1/reply', body: { decision: 'always' } });
    await c.replyQuestion('ses_1', 'frm_1', { choice: 'a', many: ['x', 'y'] });
    expect(last()).toMatchObject({ path: '/api/session/ses_1/form/frm_1/reply', body: { answer: { choice: 'a', many: ['x', 'y'] } } });
    expect(await c.abort('ses_1')).toBe(true);
    expect(await c.getDiff('ses_1')).toEqual([{ file: 'a.ts', patch: '@@', additions: 1, deletions: 0, status: 'modified' }]);
    expect(await c.listPendingPermissions('ses_1')).toEqual([{ id: 'per_1', sessionId: 'ses_1', action: 'edit', resources: ['/ws/a.ts'] }]);
    const messages = await c.getSessionMessages('ses_1');
    expect(messages.map(message => [message.role, message.id])).toEqual([['user', 'm1'], ['assistant', 'm2']]);
    expect(await c.listProviders()).toEqual([{ id: 'azure', name: 'Azure', enabled: true }, { id: 'opencode', name: 'OpenCode Zen', enabled: false }]);
    const models = await c.listModels();
    expect(models[0]).toEqual({ providerID: 'azure', modelID: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', variants: ['high'], enabled: true, contextLimit: 200000, status: 'active' });
    expect(await c.defaultModel()).toEqual({ providerID: 'azure', modelID: 'claude-sonnet-4-5' });
    expect((await c.listAgents()).map(agent => [agent.id, agent.hidden])).toEqual([['build', false], ['title', true]]);
    expect(await c.findFiles('a', 5)).toEqual(['src/a.ts']);
    expect(last().query.get('limit')).toBe('5');
});

test('event stream yields normalized events and stops on abort', async () => {
    const c = client();
    const controller = new AbortController();
    const received: string[] = [];
    const done = (async () => {
        for await (const event of c.events(controller.signal)) {
            received.push(event.type);
            if (event.type === 'permission.asked') break;
        }
    })();
    for (let waited = 0; waited < 100 && sseClients.length === 0; waited++) await Bun.sleep(10);
    const stream = sseClients[0]!;
    stream.write(sseEvent({ id: 'e1', created: 1, type: 'session.step.started', durable: { aggregateID: 'ses_1', seq: 1, version: 1 }, data: { sessionID: 'ses_1', assistantMessageID: 'a1', agent: 'build', model: { id: 'm', providerID: 'p' }, started: 1 } }));
    stream.write(': keepalive\n\n');
    stream.write(sseEvent({ id: 'e2', created: 2, type: 'session.text.delta', data: { sessionID: 'ses_1', assistantMessageID: 'a1', ordinal: 0, delta: 'Hi' } }));
    stream.write(sseEvent({ id: 'e3', created: 3, type: 'models-dev.refreshed', data: {} }));
    stream.write(sseEvent({ id: 'e4', created: 4, type: 'permission.asked', data: { id: 'per_9', sessionID: 'ses_1', action: 'bash', resources: ['ls'] } }));
    await done;
    controller.abort();
    expect(received).toEqual(['server.connected', 'turn.started', 'text.delta', 'permission.asked']);
});
