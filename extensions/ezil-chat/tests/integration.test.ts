// Spawns a real `opencode serve` (v2) through ServerManager and drives it with
// V2Client. No model provider is configured, so nothing leaves the machine.
// Skipped when no opencode binary is available; point EZIL_OPENCODE_BIN at one.
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OpenCode } from '@opencode/client';
import { PINNED_OPENCODE_VERSION } from '../src/opencode/version';
import type { ChatEvent } from '../src/opencode/adapter';
import { basicAuthHeader, V2Client } from '../src/opencode/v2';
import { ServerManager } from '../src/server/manager';

function locateBinary(): string | undefined {
    const candidates = [
        process.env.EZIL_OPENCODE_BIN,
        '/workspace/opencode-ext-tools/node_modules/@opencode/cli-linux-x64/bin/opencode',
        join(import.meta.dir, '..', 'node_modules', '.bin', 'opencode'),
    ];
    for (const candidate of candidates) if (candidate && existsSync(candidate)) return candidate;
    const found = Bun.which('opencode');
    return found ?? undefined;
}

const binary = locateBinary();
const run = binary ? test : test.skip;

run('opencode serve v2: health, catalog, session lifecycle, event stream and permission reply', async () => {
    const root = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'ezil-chat-it-'));
    const home = join(root, 'home'), workspace = join(root, 'workspace'), configPath = join(root, 'opencode.json');
    mkdirSync(home); mkdirSync(workspace);
    writeFileSync(join(workspace, 'README.md'), '# fixture\n');
    writeFileSync(join(workspace, 'notes.txt'), 'hello\n');
    // Disable the free Zen provider and force every action to ask, so no network call and predictable permissions.
    writeFileSync(configPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json', update: 'disable', providers: { opencode: { disabled: true } }, permissions: [{ action: '*', resource: '*', effect: 'ask' }] }));
    const logs: string[] = [];
    const manager = new ServerManager({
        command: binary!, cwd: workspace, configPath, expectedVersion: PINNED_OPENCODE_VERSION, readyTimeoutMs: 60_000,
        env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local', 'share'), XDG_CACHE_HOME: join(home, '.cache'), XDG_STATE_HOME: join(home, '.local', 'state'), OPENCODE_DISABLE_AUTOUPDATE: '1' },
        log: line => logs.push(line),
    });
    try {
        const endpoint = await manager.start();
        expect(endpoint.managed).toBe(true);
        expect(endpoint.version).toBe(PINNED_OPENCODE_VERSION);
        const client = new V2Client({ baseUrl: endpoint.baseUrl, directory: workspace, password: endpoint.password!, username: endpoint.username });
        expect((await client.health()).version).toBe(PINNED_OPENCODE_VERSION);

        const stop = new AbortController();
        const events: ChatEvent[] = [];
        const pump = (async () => { try { for await (const event of client.events(stop.signal)) events.push(event); } catch { /* aborted */ } })();
        for (let waited = 0; waited < 200 && !events.some(event => event.type === 'server.connected'); waited++) await Bun.sleep(25);
        expect(events[0]?.type).toBe('server.connected');

        // Catalog without any provider credentials: no models, built-in agents present.
        expect(await client.listModels()).toEqual([]);
        // The catalog fills in shortly after /api/info answers (the server emits agent.updated); poll like the controller does.
        let agents = await client.listAgents();
        for (let waited = 0; waited < 400 && agents.length === 0; waited++) { await Bun.sleep(25); agents = await client.listAgents(); }
        for (let waited = 0; waited < 200 && !events.some(event => event.type === 'catalog.changed'); waited++) await Bun.sleep(25);
        expect(events.some(event => event.type === 'catalog.changed')).toBe(true);
        expect(agents.filter(agent => !agent.hidden && agent.mode !== 'subagent').map(agent => agent.id).sort()).toEqual(['build', 'plan']);
        expect(agents.find(agent => agent.id === 'title')?.hidden).toBe(true);
        expect(await client.findFiles('README', 5)).toEqual(['README.md']);

        // Session lifecycle and session-scoped model/agent state.
        const session = await client.createSession({ title: 'integration', agent: 'plan' });
        expect(session.directory).toBe(workspace);
        expect((await client.listSessions()).map(item => item.id)).toContain(session.id);
        await client.setModel(session.id, { providerID: 'azure', modelID: 'claude-sonnet-4-5', variant: 'high' });
        await client.setAgent(session.id, 'build');
        const reloaded = await client.getSession(session.id);
        expect(reloaded.model).toEqual({ providerID: 'azure', modelID: 'claude-sonnet-4-5', variant: 'high' });
        expect(reloaded.agent).toBe('build');
        for (let waited = 0; waited < 100 && !events.some(event => event.type === 'session.updated' && event.agent === 'build'); waited++) await Bun.sleep(25);
        expect(events.some(event => event.type === 'session.created' && event.session.id === session.id)).toBe(true);
        expect(events.some(event => event.type === 'session.updated' && event.sessionId === session.id && event.model?.modelID === 'claude-sonnet-4-5')).toBe(true);
        expect(await client.getDiff(session.id)).toEqual([]);
        expect(await client.getSessionMessages(session.id)).toEqual([]);
        expect(await client.abort(session.id)).toBe(false); // nothing running: interrupt is a no-op, not an error

        // Permission round trip: ask through the raw SDK (as a tool would), answer through the adapter.
        const raw = OpenCode.make({ baseUrl: endpoint.baseUrl, headers: { authorization: basicAuthHeader(endpoint.username, endpoint.password!) } });
        const pending = raw.permission.create({ sessionID: session.id, action: 'edit', resources: [join(workspace, 'notes.txt')], save: ['*'] });
        let asked: Extract<ChatEvent, { type: 'permission.asked' }> | undefined;
        for (let waited = 0; waited < 200 && !asked; waited++) {
            asked = events.find((event): event is Extract<ChatEvent, { type: 'permission.asked' }> => event.type === 'permission.asked');
            if (!asked) await Bun.sleep(25);
        }
        expect(asked?.request).toMatchObject({ sessionId: session.id, action: 'edit', resources: [join(workspace, 'notes.txt')], save: ['*'] });
        expect((await client.listPendingPermissions(session.id)).map(request => request.id)).toEqual([asked!.request.id]);
        await client.replyPermission(session.id, asked!.request.id, 'once');
        await pending;
        for (let waited = 0; waited < 100 && !events.some(event => event.type === 'permission.replied'); waited++) await Bun.sleep(25);
        expect(events.find(event => event.type === 'permission.replied')).toEqual({ type: 'permission.replied', sessionId: session.id, requestId: asked!.request.id, decision: 'once' });
        expect(await client.listPendingPermissions(session.id)).toEqual([]);

        stop.abort();
        await pump;
    } finally {
        await manager.dispose();
        rmSync(root, { recursive: true, force: true });
        if (process.env.EZIL_CHAT_IT_VERBOSE) console.log(logs.join('\n'));
    }
}, 120_000);
