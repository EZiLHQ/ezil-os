// ServerManager against the fake `opencode serve` fixture.
import { expect, test } from 'bun:test';
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { backoffMs, freePort, processAlive, reapOrphan, ServerManager, type ServerManagerOptions, type ServerState } from '../src/server/manager';

const fixture = join(import.meta.dir, 'fixtures', 'fake-opencode.mjs');
const base = (extra: Partial<ServerManagerOptions> = {}): ServerManagerOptions => ({
    command: process.execPath, commandArgs: [fixture], cwd: import.meta.dir, readyTimeoutMs: 8000, healthIntervalMs: 50, ...extra,
});

async function info(baseUrl: string, password: string | undefined): Promise<Record<string, unknown>> {
    const response = await fetch(`${baseUrl}/api/info`, { headers: { authorization: `Basic ${Buffer.from(`opencode:${password ?? ''}`).toString('base64')}` } });
    return response.json() as Promise<Record<string, unknown>>;
}

/** Records every spawned child so tests can assert on leaks and double spawns. */
function recordingSpawn(): { spawn: ServerManagerOptions['spawn']; children: ChildProcess[] } {
    const children: ChildProcess[] = [];
    return { children, spawn: (command, args, options) => { const child = nodeSpawn(command, args, options); children.push(child); return child; } };
}

async function untilDead(pid: number, timeoutMs = 3000): Promise<boolean> {
    for (let waited = 0; waited < timeoutMs / 25 && processAlive(pid); waited++) await Bun.sleep(25);
    return !processAlive(pid);
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

test('dispose during launch and a health timeout both kill the child instead of leaking it', async () => {
    const slow = recordingSpawn();
    const manager = new ServerManager(base({ env: { FAKE_OPENCODE_DELAY_MS: '5000' }, spawn: slow.spawn }));
    const pending = manager.start().then(() => undefined, (error: Error) => error);
    await Bun.sleep(150);
    await manager.dispose();
    expect((await pending)?.message).toMatch(/disposed/);
    expect(slow.children).toHaveLength(1);
    expect(await untilDead(slow.children[0]!.pid!)).toBe(true);

    const timeout = recordingSpawn();
    const impatient = new ServerManager(base({ env: { FAKE_OPENCODE_DELAY_MS: '5000' }, spawn: timeout.spawn, readyTimeoutMs: 400 }));
    await expect(impatient.start()).rejects.toThrow(/did not become healthy/);
    expect(impatient.state.status).toBe('error');
    expect(await untilDead(timeout.children[0]!.pid!)).toBe(true);
    await impatient.dispose();
}, 15_000);

test('a binary that cannot be spawned fails fast with the spawn error, not after the health timeout', async () => {
    const manager = new ServerManager({ command: '/nonexistent/ezil-chat-no-such-binary', cwd: import.meta.dir, readyTimeoutMs: 10_000, healthIntervalMs: 50 });
    const started = Date.now();
    await expect(manager.start()).rejects.toThrow(/could not run .*no-such-binary.*ENOENT/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(manager.state).toMatchObject({ status: 'error', message: expect.stringContaining('ENOENT') });
    await manager.dispose(); // must not hang on a child that never existed
}, 10_000);

test('an intentional stop (restart/dispose) never schedules a crash restart', async () => {
    const recording = recordingSpawn();
    const manager = new ServerManager(base({ spawn: recording.spawn }));
    const states: ServerState[] = [];
    manager.onDidChangeState(state => states.push(state));
    const first = await manager.start();
    const second = await manager.restart();
    expect(second.baseUrl).not.toBe(first.baseUrl);
    await Bun.sleep(1300); // longer than backoffMs(1)
    expect(recording.children).toHaveLength(2);
    expect(states.map(state => state.status)).toEqual(['starting', 'ready', 'stopped', 'starting', 'ready']);
    await manager.dispose();
    await Bun.sleep(1300);
    expect(recording.children).toHaveLength(2);
    expect(manager.state.status).toBe('stopped');
}, 15_000);

test('dispose kills the whole process group, including the server\'s own children', async () => {
    const manager = new ServerManager(base({ env: { FAKE_OPENCODE_SPAWN_CHILD: '1' } }));
    const endpoint = await manager.start();
    const body = await info(endpoint.baseUrl, endpoint.password);
    const grandchild = body.childPid as number;
    expect(endpoint.pid).toBe(body.pid as number);
    expect(processAlive(grandchild)).toBe(true);
    await manager.dispose();
    expect(await untilDead(grandchild)).toBe(true);
}, 15_000);

test('reapOrphan kills a recorded opencode serve that is still answering, and nothing else', async () => {
    const port = await freePort();
    const orphan = nodeSpawn(process.execPath, [fixture, 'serve', '--hostname', '127.0.0.1', '--port', String(port)], { env: { ...process.env, OPENCODE_SERVER_PASSWORD: 'orphan' }, stdio: 'ignore', detached: true });
    orphan.unref();
    const baseUrl = `http://127.0.0.1:${port}`;
    for (let waited = 0; waited < 100; waited++) { try { await info(baseUrl, 'orphan'); break; } catch { await Bun.sleep(25); } }
    try {
        const logs: string[] = [];
        // Our own pid: alive, but neither answering at that URL nor an `opencode serve` command line.
        expect(await reapOrphan({ pid: process.pid, baseUrl, password: 'orphan' }, { log: line => logs.push(line) })).toBe(false);
        expect(await reapOrphan({ pid: orphan.pid!, baseUrl, password: 'orphan' }, { log: line => logs.push(line) })).toBe(true);
        expect(await untilDead(orphan.pid!)).toBe(true);
        expect(logs).toHaveLength(1);
        expect(await reapOrphan({ pid: orphan.pid!, baseUrl, password: 'orphan' })).toBe(false); // already gone
    } finally { try { process.kill(-orphan.pid!, 'SIGKILL'); } catch { /* gone */ } }
}, 15_000);

test('backoff doubles and caps', () => {
    expect([1, 2, 3, 6, 10].map(attempt => backoffMs(attempt))).toEqual([1000, 2000, 4000, 30_000, 30_000]);
});
