// Owns the `opencode serve` child process: random loopback port, random
// password, health check, restart with backoff, and a hard kill on dispose.
// No `vscode` import so it runs under `bun test` with a fake binary.
import { spawn as nodeSpawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';

export interface ServerEndpoint {
    baseUrl: string;
    username: string;
    password?: string;
    /** True when this manager spawned the process (and will kill it). */
    managed: boolean;
    version: string;
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

type Listener = (state: ServerState) => void;

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
            const message = error instanceof Error ? error.message : String(error);
            this.set({ status: 'error', message });
            throw error;
        }
    }

    private async attach(): Promise<ServerEndpoint> {
        const baseUrl = String(this.options.externalUrl).replace(/\/+$/, '');
        const username = this.options.externalUsername ?? 'opencode';
        const version = await this.waitHealthy(baseUrl, username, this.options.externalPassword, () => false);
        const endpoint: ServerEndpoint = { baseUrl, username, managed: false, version };
        if (this.options.externalPassword) endpoint.password = this.options.externalPassword;
        return endpoint;
    }

    private async spawnChild(): Promise<ServerEndpoint> {
        const port = await freePort();
        const password = randomBytes(24).toString('base64url');
        const env: NodeJS.ProcessEnv = { ...process.env, ...this.options.env, OPENCODE_SERVER_PASSWORD: password, OPENCODE_SERVER_USERNAME: 'opencode' };
        if (this.options.configPath) env.OPENCODE_CONFIG = this.options.configPath;
        const args = [...(this.options.commandArgs ?? []), 'serve', '--hostname', '127.0.0.1', '--port', String(port)];
        const spawn = this.options.spawn ?? nodeSpawn;
        this.log(`spawning ${this.options.command} ${args.join(' ')} in ${this.options.cwd}`);
        const child = spawn(this.options.command, args, { cwd: this.options.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
        this.child = child;
        let exited = false;
        child.stdout?.on('data', (chunk: Buffer) => { this.log(chunk.toString().trimEnd()); });
        child.stderr?.on('data', (chunk: Buffer) => { this.log(chunk.toString().trimEnd()); });
        child.once('error', error => { this.log(`spawn error: ${error.message}`); });
        child.once('exit', (code, signal) => {
            exited = true;
            if (this.child === child) this.child = undefined;
            this.log(`opencode exited (code ${code ?? 'null'}, signal ${signal ?? 'none'})`);
            this.onChildExit(child);
        });
        const baseUrl = `http://127.0.0.1:${port}`;
        const version = await this.waitHealthy(baseUrl, 'opencode', password, () => exited);
        return { baseUrl, username: 'opencode', password, managed: true, version };
    }

    private async waitHealthy(baseUrl: string, username: string, password: string | undefined, gaveUp: () => boolean): Promise<string> {
        const fetchImpl = this.options.fetch ?? globalThis.fetch;
        const headers: Record<string, string> = {};
        if (password) headers.authorization = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
        const deadline = Date.now() + (this.options.readyTimeoutMs ?? 30_000);
        const interval = this.options.healthIntervalMs ?? 250;
        let lastError = 'no response';
        while (Date.now() < deadline) {
            if (gaveUp()) throw new Error('opencode exited before it became healthy');
            if (this.disposed) throw new Error('ServerManager disposed');
            try {
                const response = await fetchImpl(`${baseUrl}/api/info`, { headers, signal: AbortSignal.timeout(2000) });
                if (response.status === 200) {
                    const info = await response.json() as { version?: string };
                    return info.version ?? 'unknown';
                }
                lastError = `HTTP ${response.status}`;
                if (response.status === 401) throw new Error('opencode rejected the server password');
            } catch (error) {
                if (error instanceof Error && error.message.includes('password')) throw error;
                lastError = error instanceof Error ? error.message : String(error);
            }
            await new Promise(resolve => setTimeout(resolve, interval));
        }
        throw new Error(`opencode did not become healthy at ${baseUrl}: ${lastError}`);
    }

    private onChildExit(_child: ChildProcess): void {
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
            this.start().catch(error => { this.log(`restart failed: ${error instanceof Error ? error.message : String(error)}`); });
        }, delay);
    }

    private async stopChild(): Promise<void> {
        const child = this.child;
        this.child = undefined;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise<void>(resolve => {
            const timer = setTimeout(() => { child.kill('SIGKILL'); }, 3000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
            child.kill('SIGTERM');
        });
    }
}
