// Owner-granted workspace MCP attach, default zero.
//
// One packaged, read-only tool (`workspace_info`) can be attached to Code's MCP provider for the
// single trusted local workspace folder, and only after the owner grants it in this window. The
// grant is in memory only: nothing is persisted, so every window and restart starts at zero.
// Repository configuration (`.vscode/mcp.json` and the like) is never read and no workspace
// program is ever executed; the ordinary terminal is untouched.
//
// The grant is enforced at call time, not at definition time. While granted, the extension owns
// a private Unix socket (owner-only directory, 0600 socket) serving the MCP protocol; the packaged
// stdio adapter (`workspace-mcp-server.ts`) only relays lines between Code and that socket. Every
// `tools/call` re-checks the grant and the folder's identity (same device and inode, still a real
// directory owned by this uid). Revoke, dispose or a restart closes the socket and removes its
// directory, so a definition Code still has cached cannot serve anything afterwards.
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

export const SOCKET_NAME = 'workspace-mcp.sock';
export const ENTRY_LIMIT = 64;
const supportedVersions = ['2024-11-05', '2025-03-26', '2025-06-18'];

export const workspaceInfoTool = {
    name: 'workspace_info',
    description: 'Read-only facts about the EZiL workspace folder the owner attached in this Code window: its name, path and top-level entry names. No file contents.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export interface WorkspaceIdentity { root: string; dev: number; ino: number; uid: number }

function object(value: unknown): Record<string, unknown> | undefined {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

/** The folder as a real, uid-owned directory with no symlink components, or undefined. */
export function identify(root: string, uid: number | undefined = process.getuid?.()): WorkspaceIdentity | undefined {
    if (!path.isAbsolute(root) || root.includes('\0')) return undefined;
    try {
        for (let cursor = root; ; cursor = path.dirname(cursor)) {
            if (fs.lstatSync(cursor).isSymbolicLink()) return undefined;
            if (path.dirname(cursor) === cursor) break;
        }
        const stat = fs.lstatSync(root);
        if (!stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) return undefined;
        return { root, dev: stat.dev, ino: stat.ino, uid: stat.uid };
    } catch { return undefined; }
}

/** In-memory, per-window grant for exactly one folder. */
export class WorkspaceMcpGrant {
    private identity: WorkspaceIdentity | undefined;
    constructor(private readonly uid: number | undefined = process.getuid?.()) {}

    /** Records the grant for `root` as it exists now. False when the folder is not an owned real directory. */
    grant(root: string): boolean {
        const identity = identify(root, this.uid);
        if (!identity) return false;
        this.identity = identity;
        return true;
    }

    revoke(): void { this.identity = undefined; }

    /** The granted folder only while it still is the same directory (device, inode, owner); otherwise revokes and returns undefined. */
    live(): WorkspaceIdentity | undefined {
        if (!this.identity) return undefined;
        const current = identify(this.identity.root, this.uid);
        if (!current || current.dev !== this.identity.dev || current.ino !== this.identity.ino || current.uid !== this.identity.uid) {
            this.identity = undefined;
            return undefined;
        }
        return this.identity;
    }
}

export function workspaceInfo(identity: WorkspaceIdentity): { name: string; path: string; entries: { name: string; kind: 'directory' | 'file' | 'other' }[]; truncated: boolean } {
    let names: fs.Dirent[] = [];
    try { names = fs.readdirSync(identity.root, { withFileTypes: true }); } catch { /* unreadable: no entries */ }
    const visible = names.filter(entry => !entry.name.startsWith('.') && !/[\u0000-\u001f\u007f]/u.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
    return {
        name: path.basename(identity.root), path: identity.root,
        entries: visible.slice(0, ENTRY_LIMIT).map(entry => ({ name: entry.name.slice(0, 255), kind: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other' })),
        truncated: visible.length > ENTRY_LIMIT,
    };
}

/** Serves the MCP line protocol for one connection; every tool call re-checks the live grant. */
export function serveWorkspaceMcp(input: Readable, output: Writable, grant: Pick<WorkspaceMcpGrant, 'live'>): void {
    const lines = createInterface({ input, crlfDelay: Infinity });
    let initialized = false;
    const write = (value: object) => { if (output.writable) output.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); };
    const error = (id: string | number | null, code: number, message: string) => write({ id, error: { code, message } });
    lines.on('line', line => {
        if (line.length > 16384) return error(null, -32600, 'Invalid request');
        let call: Record<string, unknown> | undefined;
        try { call = object(JSON.parse(line)); } catch { return error(null, -32700, 'Parse error'); }
        if (call?.jsonrpc !== '2.0' || typeof call.method !== 'string') return error(null, -32600, 'Invalid request');
        const { id, method } = call;
        const params = object(call.params);
        if (id === undefined) return; // notifications: nothing is cancellable here
        if (typeof id !== 'number' && typeof id !== 'string') return error(null, -32600, 'Invalid request ID');
        if (method === 'initialize') {
            if (initialized || typeof params?.protocolVersion !== 'string') return error(id, -32602, 'Invalid initialization');
            initialized = true;
            const protocolVersion = supportedVersions.includes(params.protocolVersion) ? params.protocolVersion : '2025-06-18';
            return write({ id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ezil-workspace', version: '1.0.0' } } });
        }
        if (method === 'ping') return write({ id, result: {} });
        if (!initialized) return error(id, -32600, 'Initialize first');
        if (method === 'tools/list') return write({ id, result: { tools: [workspaceInfoTool] } });
        if (method !== 'tools/call') return error(id, -32601, 'Method not found');
        const args = params?.arguments === undefined ? {} : object(params.arguments);
        if (params?.name !== workspaceInfoTool.name || !args || Object.keys(args).length) return error(id, -32602, 'Invalid workspace tool arguments');
        const identity = grant.live();
        if (!identity) return write({ id, result: { content: [{ type: 'text', text: 'The workspace attach was revoked or the folder changed. Grant it again in Code.' }], isError: true } });
        const info = workspaceInfo(identity);
        return write({ id, result: { content: [{ type: 'text', text: JSON.stringify(info) }], structuredContent: info, isError: false } });
    });
}

/** The extension-owned local endpoint: a 0600 Unix socket in a fresh 0700 directory, gone after `close()`. */
export class WorkspaceMcpEndpoint {
    private readonly directory: string;
    readonly socketPath: string;
    private readonly server: net.Server;
    private readonly connections = new Set<net.Socket>();

    private constructor(directory: string, server: net.Server) {
        this.directory = directory; this.socketPath = path.join(directory, SOCKET_NAME); this.server = server;
    }

    static async open(grant: Pick<WorkspaceMcpGrant, 'live'>, tmpdir = os.tmpdir()): Promise<WorkspaceMcpEndpoint> {
        const directory = fs.mkdtempSync(path.join(tmpdir, `ezil-mcp-${randomBytes(4).toString('hex')}-`));
        fs.chmodSync(directory, 0o700);
        const server = net.createServer();
        const endpoint = new WorkspaceMcpEndpoint(directory, server);
        server.on('connection', socket => {
            endpoint.connections.add(socket);
            socket.on('close', () => endpoint.connections.delete(socket));
            socket.on('error', () => socket.destroy());
            serveWorkspaceMcp(socket, socket, grant);
        });
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(endpoint.socketPath, () => { server.off('error', reject); resolve(); });
        });
        fs.chmodSync(endpoint.socketPath, 0o600);
        return endpoint;
    }

    get open(): boolean { return this.server.listening; }

    /** Stops accepting, drops every live adapter connection and removes the socket directory. */
    async close(): Promise<void> {
        for (const socket of this.connections) socket.destroy();
        this.connections.clear();
        await new Promise<void>(resolve => this.server.close(() => resolve()));
        fs.rmSync(this.directory, { recursive: true, force: true });
    }
}

/** Relays one stdio MCP client to the endpoint socket; exits when the socket is gone (revoked, disposed, restarted). */
export function relayWorkspaceMcp(socketPath: string, stdin: Readable, stdout: Writable, stderr: Writable, exit: (code: number) => void): void {
    const socket = net.connect(socketPath);
    socket.on('connect', () => { stdin.pipe(socket); socket.pipe(stdout); });
    socket.on('error', () => { stderr.write('EZiL workspace MCP is not attached in this Code window.\n'); exit(1); });
    socket.on('close', () => exit(0));
    stdin.on('end', () => socket.end());
}
