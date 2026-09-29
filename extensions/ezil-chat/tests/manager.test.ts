// ServerManager against the fake `opencode serve` fixture.
import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { backoffMs, freePort, ServerManager, type ServerManagerOptions, type ServerState } from '../src/server/manager';

const fixture = join(import.meta.dir, 'fixtures', 'fake-opencode.mjs');
const base = (extra: Partial<ServerManagerOptions> = {}): ServerManagerOptions => ({
    command: process.execPath, commandArgs: [fixture], cwd: import.meta.dir, readyTimeoutMs: 8000, healthIntervalMs: 50, ...extra,
});

async function info(baseUrl: string, password: string | undefined): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}/api/info`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password ?? ''}`).toString('base64')}` } });
    return response.json() as Promise<Record<string, unknown>>;
}

test('spawns on a free loopback port with a random password and passes OPENCODE_CONFIG', async () => {
    const logs: string[] = [];
    const manager = new ServerManager(base({ configPath: '/etc/opencode/opencode.json', log: line => logs.push(line), expectedVersion: '2.0.19' }));
    const states: ServerState['status'][] = [];
    manager.onDidChangeState(state => states.push(state.status));
    const endpoint = await manager.start();
    expect(endpoint.managed).toBe(true);
    expect(endpoint.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(endpoint.password).toHaveLength(32);
    expect(endpoint.version).toBe('2.0.19');
    const body = await info(endpoint.baseUrl, endpoint.password);
    expect(body.config).toBe('/etc/opencode/opencode.json');
    expect(body.cwd).toBe(import.meta.dir);
    expect(states).toEqual(['starting', 'ready']);
    expect(logs.some(line => line.includes('serve --hostname 127.0.0.1 --port'))).toBe(true);
    expect(await manager.start()).toBe(endpoint); // idempotent while ready
    await manager.dispose();
    expect(manager.state.status).toBe('stopped');
    await expect(fetch(`${endpoint.baseUrl}/api/info`)).rejects.toBeDefined();
}, 15_000);

test('restarts with backoff after a crash and fails fast when the binary exits at once', async () => {
    const manager = new ServerManager(base({ maxRestarts: 2 }));
    const states: ServerState[] = [];
    manager.onDidChangeState(state => states.push(state));
    const first = await manager.start();
    await fetch(`${first.baseUrl}/crash`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${first.password}`).toString('base64')}` } });
    for (let waited = 0; waited < 200 && !(manager.state.status === 'ready' && manager.state.endpoint !== first); waited++) await Bun.sleep(25);
    expect(manager.state.status).toBe('ready');
    const second = manager.state.status === 'ready' ? manager.state.endpoint : undefined;
    expect(second?.baseUrl).not.toBe(first.baseUrl);
    expect(states.some(state => state.status === 'starting' && state.attempt === 1)).toBe(true);
    await manager.dispose();

    const dead = new ServerManager(base({ env: { FAKE_OPENCODE_EXIT_IMMEDIATELY: '1' }, readyTimeoutMs: 3000 }));
    await expect(dead.start()).rejects.toThrow(/exited before it became healthy/);
    expect(dead.state.status).toBe('error');
    await dead.dispose();
}, 20_000);

test('attaches to an external server and warns on version drift', async () => {
    const port = await freePort();
    const external = Bun.spawn([process.execPath, fixture, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { env: { ...process.env, OPENCODE_SERVER_PASSWORD: 'ext', FAKE_OPENCODE_VERSION: '2.0.18' }, stdout: 'ignore', stderr: 'ignore' });
    try {
        const logs: string[] = [];
        const manager = new ServerManager({ command: 'unused', cwd: '/', externalUrl: `http://127.0.0.1:${port}/`, externalPassword: 'ext', expectedVersion: '2.0.19', log: line => logs.push(line), healthIntervalMs: 50 });
        const endpoint = await manager.start();
        expect(endpoint).toEqual({ baseUrl: `http://127.0.0.1:${port}`, username: 'opencode', password: 'ext', managed: false, version: '2.0.18' });
        expect(logs.some(line => line.includes('differs from pinned'))).toBe(true);
        await manager.dispose();
        expect((await info(endpoint.baseUrl, 'ext')).version).toBe('2.0.18'); // not ours to kill
        const wrong = new ServerManager({ command: 'unused', cwd: '/', externalUrl: `http://127.0.0.1:${port}`, externalPassword: 'nope', readyTimeoutMs: 2000, healthIntervalMs: 50 });
        await expect(wrong.start()).rejects.toThrow(/password/);
    } finally { external.kill(); }
}, 15_000);

test('backoff doubles and caps', () => {
    expect([1, 2, 3, 6, 10].map(attempt => backoffMs(attempt))).toEqual([1000, 2000, 4000, 30_000, 30_000]);
});
