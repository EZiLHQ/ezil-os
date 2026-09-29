// Owns the `opencode serve` child process: random loopback port, random
// password, health check, restart with backoff, and a hard kill on dispose.
// No `vscode` import so it runs under `bun test` with a fake binary.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { errorMessage } from '../errors';
import { basicAuthHeader } from '../opencode/auth';

export interface ServerEndpoint {
    baseUrl: string;
    username: string;
    password?: string;
    /** True when this manager spawned the process (and will kill it). */
    managed: boolean;
    version: string;
    /** Pid of the spawned process (its process-group leader); absent for external servers. */
    pid?: number;
}

export type ServerState =
    | { status: 'stopped' }
    | { status: 'starting'; attempt: number }
    | { status: 'ready'; endpoint: ServerEndpoint }
    | { status: 'error'; message: string };

export interface ServerManagerOptions {
    /** Binary to run, e.g. `opencode` or an absolute path. */
    command: string;
    /** Arguments placed before `serve` (lets tests run `node fake.mjs serve ...`). */
    commandArgs?: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    /** Written to `OPENCODE_CONFIG` for the child. */
    configPath?: string;
    /** Attach to this server instead of spawning one. */
    externalUrl?: string;
    externalPassword?: string;
    externalUsername?: string;
    /** Warn (do not fail) when the server reports a different version. */
    expectedVersion?: string;
    log?: (line: string) => void;
    spawn?: (command: string, args: string[], options: SpawnOptions) => ChildProcess;
    fetch?: typeof globalThis.fetch;
    /** Consecutive crash restarts before giving up. */
    maxRestarts?: number;
    /** Milliseconds to wait for `/api/info` after spawn. */
    readyTimeoutMs?: number;
    healthIntervalMs?: number;
}

/** What the host persists so a server orphaned by an extension-host crash can be reaped on the next activation. */
export interface SpawnRecord { pid: number; baseUrl: string; password: string }

type Listener = (state: ServerState) => void;

/** Thrown when the server answers 401: retrying will not help. */
export class ServerAuthError extends Error {
    constructor() { super('opencode rejected the server password'); this.name = 'ServerAuthError'; }
}

export async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            const port = typeof address === 'object' && address ? address.port : 0;
            server.close(() => port ? resolve(port) : reject(new Error('no port')));
        });
    });
}

export function backoffMs(attempt: number, base = 1000, cap = 30_000): number {
    return Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
}

/** Spawned children lead their own process group so bash tools and MCP servers die with them. */
const useProcessGroups = process.platform !== 'win32';

export function processAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

/** Signal the whole process group when `pid` leads one, else just the process. */
export function killProcessGroup(pid: number, signal: NodeJS.Signals): void {
    if (useProcessGroups) {
        try { process.kill(-pid, signal); return; } catch { /* not a group leader (or already gone): fall through */ }
    }
    try { process.kill(pid, signal); } catch { /* already gone */ }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!processAlive(pid)) return true;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    return !processAlive(pid);
}

/**
 * Kill a server left behind by a previous extension host, but only when the pid still
 * belongs to it: either `/api/info` answers with that pid, or (server already wedged)
 * the process command line is an `opencode serve`. Returns true when something was killed.
 */
export async function reapOrphan(record: SpawnRecord, options: { fetch?: typeof globalThis.fetch; log?: (line: string) => void } = {}): Promise<boolean> {
    if (!Number.isInteger(record.pid) || record.pid <= 1 || !processAlive(record.pid)) return false;
    let ours = false;
    try {
        const response = await (options.fetch ?? globalThis.fetch)(`${record.baseUrl}/api/info`, { headers: { authorization: basicAuthHeader('opencode', record.password) }, signal: AbortSignal.timeout(1500) });
        if (response.status === 200) ours = (await response.json() as { pid?: number }).pid === record.pid;
    } catch { /* not answering: check the command line instead */ }
    if (!ours) {
        try {
            const cmdline = readFileSync(`/proc/${record.pid}/cmdline`, 'utf8').split('\0');
            ours = cmdline.some(part => part.includes('opencode')) && cmdline.includes('serve');
        } catch { /* no procfs or pid gone */ }
    }
    if (!ours) return false;
    options.log?.(`killing orphaned opencode serve (pid ${record.pid}) from a previous session`);
    killProcessGroup(record.pid, 'SIGTERM');
    if (!(await waitForExit(record.pid, 3000))) killProcessGroup(record.pid, 'SIGKILL');
    return true;
}

export class ServerManager {
    private child: ChildProcess | undefined;
    private current: ServerState = { status: 'stopped' };
    private readonly listeners = new Set<Listener>();
    private disposed = false;
    private restarts = 0;
    private readyAt = 0;
    private restartTimer: ReturnType<typeof setTimeout> | undefined;
    private starting: Promise<ServerEndpoint> | undefined;
    private readonly options: ServerManagerOptions;

    constructor(options: ServerManagerOptions) { this.options = options; }

    get state(): ServerState { return this.current; }

    onDidChangeState(listener: Listener): { dispose(): void } {
        this.listeners.add(listener);
        return { dispose: () => { this.listeners.delete(listener); } };
    }

    private set(state: ServerState): void {
        this.current = state;
        for (const listener of this.listeners) listener(state);
    }

    private log(line: string): void { this.options.log?.(line); }

    /** Start (or attach) and resolve once `/api/info` answers. Concurrent calls share one attempt. */
    start(): Promise<ServerEndpoint> {
        if (this.disposed) return Promise.reject(new Error('ServerManager disposed'));
        if (this.current.status === 'ready') return Promise.resolve(this.current.endpoint);
        if (!this.starting) {
            this.starting = this.launch().finally(() => { this.starting = undefined; });
        }
        return this.starting;
    }

    async restart(): Promise<ServerEndpoint> {
        this.restarts = 0;
        this.clearRestartTimer();
        await this.stopChild();
        this.set({ status: 'stopped' });
        return this.start();
    }

    async dispose(): Promise<void> {
        this.disposed = true;
        this.clearRestartTimer();
        await this.stopChild();
        this.set({ status: 'stopped' });
        this.listeners.clear();
    }

    private clearRestartTimer(): void {
        if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = undefined; }
    }

    private async launch(): Promise<ServerEndpoint> {
        this.set({ status: 'starting', attempt: this.restarts + 1 });
        try {
            const endpoint = this.options.externalUrl ? await this.attach() : await this.spawnChild();
            if (this.options.expectedVersion && endpoint.version !== this.options.expectedVersion) {
                this.log(`warning: opencode ${endpoint.version} differs from pinned ${this.options.expectedVersion}`);
            }
            this.readyAt = Date.now();
            this.set({ status: 'ready', endpoint });
            return endpoint;
        } catch (error) {
            // Health timeout or dispose mid-launch: the child may still be running; never leak it.
            if (!this.options.externalUrl) await this.stopChild();
            this.set({ status: 'error', message: errorMessage(error) });
            throw error;
        }
    }

    private async attach(): Promise<ServerEndpoint> {
        const baseUrl = String(this.options.externalUrl).replace(/\/+$/, '');
        const username = this.options.externalUsername ?? 'opencode';
        const version = await this.waitHealthy(baseUrl, username, this.options.externalPassword, () => undefined);
        const endpoint: ServerEndpoint = { baseUrl, username, managed: false, version };
        if (this.options.externalPassword) endpoint.password = this.options.externalPassword;
        return endpoint;
    }

    private async spawnChild(): Promise<ServerEndpoint> {
        const port = await freePort();
        if (this.disposed) throw new Error('ServerManager disposed');
        const password = randomBytes(24).toString('base64url');
        const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, OPENCODE_SERVER_PASSWORD: password };
        if (this.options.configPath) env.OPENCODE_CONFIG = this.options.configPath;
        const args = [...(this.options.commandArgs ?? []), 'serve', '--hostname', '127.0.0.1', '--port', String(port)];
        const spawn = this.options.spawn ?? nodeSpawn;
        this.log(`spawning ${this.options.command} ${args.join(' ')} in ${this.options.cwd}`);
        const child = spawn(this.options.command, args, { cwd: this.options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: useProcessGroups });
        this.child = child;
        let gaveUp: string | undefined;
        child.stdout?.on('data', (chunk: Buffer) => { this.log(chunk.toString().trimEnd()); });
        child.stderr?.on('data', (chunk: Buffer) => { this.log(chunk.toString().trimEnd()); });
        child.once('error', error => {
            // A failed spawn (ENOENT, EACCES) never emits `exit`; treat the child as gone right away.
            gaveUp = `could not run ${this.options.command}: ${error.message}`;
            this.log(gaveUp);
            if (this.child === child) this.child = undefined;
        });
        child.once('exit', (code, signal) => {
            gaveUp ??= 'opencode exited before it became healthy';
            this.log(`opencode exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
            // `stopChild()` detaches the child first, so only an unexpected exit reaches the restart logic.
            if (this.child !== child) return;
            this.child = undefined;
            this.onChildExit();
        });
        const baseUrl = `http://127.0.0.1:${port}`;
        const version = await this.waitHealthy(baseUrl, 'opencode', password, () => gaveUp);
        const endpoint: ServerEndpoint = { baseUrl, username: 'opencode', password, managed: true, version };
        if (child.pid !== undefined) endpoint.pid = child.pid;
        return endpoint;
    }

    private async waitHealthy(baseUrl: string, username: string, password: string | undefined, gaveUp: () => string | undefined): Promise<string> {
        const fetchImpl = this.options.fetch ?? globalThis.fetch;
        const headers: Record<string, string> = {};
        if (password) headers.authorization = basicAuthHeader(username, password);
        const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
        const interval = this.options.healthIntervalMs ?? 250;
        let lastError = 'no response';
        while (Date.now() < deadline) {
            if (this.disposed) throw new Error('ServerManager disposed');
            const reason = gaveUp();
            if (reason) throw new Error(reason);
            try {
                const response = await fetchImpl(`${baseUrl}/api/info`, { headers, signal: AbortSignal.timeout(2000) });
                if (response.status === 200) {
                    const info = await response.json() as { version?: string };
                    return info.version ?? 'unknown';
                }
                lastError = `HTTP ${response.status}`;
                if (response.status === 401) throw new ServerAuthError();
            } catch (error) {
                if (error instanceof ServerAuthError) throw error;
                lastError = errorMessage(error);
            }
            await new Promise(resolve => setTimeout(resolve, interval));
        }
        throw new Error(`opencode did not become healthy at ${baseUrl}: ${lastError}`);
    }

    private onChildExit(): void {
        if (this.disposed || this.starting) return;
        if (this.current.status !== 'ready') return;
        // A server that stayed up for a minute earns a fresh restart budget.
        if (Date.now() - this.readyAt > 60_000) this.restarts = 0;
        this.restarts += 1;
        const max = this.options.maxRestarts ?? 5;
        if (this.restarts > max) {
            this.set({ status: 'error', message: `opencode crashed ${max} times in a row; use "EZiL Chat: Restart OpenCode Server"` });
            return;
        }
        const delay = backoffMs(this.restarts);
        this.log(`restarting opencode in ${delay}ms (attempt ${this.restarts}/${max})`);
        this.set({ status: 'starting', attempt: this.restarts });
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (this.disposed || this.child !== undefined) return;
            this.start().catch(error => { this.log(`restart failed: ${errorMessage(error)}`); });
        }, delay);
    }

    /** Detach the current child and terminate its whole process group (SIGTERM, then SIGKILL after 3 s). */
    private async stopChild(): Promise<void> {
        const child = this.child;
        this.child = undefined;
        if (!child || child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
        const pid = child.pid;
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => { killProcessGroup(pid, 'SIGKILL'); }, 3000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            killProcessGroup(pid, 'SIGTERM');
        });
        // The leader has exited; grandchildren that ignored SIGTERM go with it.
        killProcessGroup(pid, 'SIGKILL');
    }
}
