// Owner-granted workspace MCP attach: default zero, in-memory grant, call-time enforcement over the
// extension-owned socket, identity pinning, and the packaged stdio adapter as the one benign tool proof.
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';

import { fakeVscode } from './fixtures/fake-vscode';
import { WorkspaceMcpEndpoint, WorkspaceMcpGrant, identify, relayWorkspaceMcp, serveWorkspaceMcp, workspaceInfoTool, SOCKET_NAME } from '../src/workspace-mcp';

mock.module('vscode', () => fakeVscode);
const { GRANT_CHOICE, GRANT_COMMAND, REVOKE_COMMAND, registerCodeMcp } = await import('../src/code-mcp');

/** The provider test's fake window: mutated in place, restored by `restoreWindow`. */
function fakeWindow(root: string, choice: () => string | undefined | Promise<string>) {
    const workspace = fakeVscode.workspace as Record<string, unknown>;
    const window = fakeVscode.window as Record<string, unknown>;
    const commands = fakeVscode.commands as Record<string, unknown>;
    const lm = fakeVscode.lm as Record<string, unknown>;
    const saved = { workspace: { ...workspace }, window: { ...window }, commands: { ...commands }, lm: { ...lm } };
    const previousEnv = { on: process.env.EZIL_CODE_BROWSER_MCP, token: process.env.EZIL_CODE_BROWSER_MCP_TOKEN };
    delete process.env.EZIL_CODE_BROWSER_MCP; delete process.env.EZIL_CODE_BROWSER_MCP_TOKEN;
    type Definition = { label: string; command: string; args: string[]; env?: unknown; version?: string };
    const providers = new Map<string, { onDidChangeMcpServerDefinitions: { (listener: () => void): unknown }; provideMcpServerDefinitions(): Definition[] }>();
    const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const notifications: string[] = [];
    const state = { modal: undefined as Record<string, unknown> | undefined, foldersChanged: undefined as (() => void) | undefined };
    Object.assign(workspace, { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: root } }],
        onDidChangeWorkspaceFolders: (listener: () => void) => { state.foldersChanged = listener; return { dispose() {} }; } });
    Object.assign(window, {
        showInformationMessage: async (text: string) => { notifications.push(text); },
        showWarningMessage: async (text: string, options: Record<string, unknown>) => { notifications.push(text); state.modal = options; return choice(); },
    });
    Object.assign(commands, { registerCommand: (name: string, callback: (...args: unknown[]) => Promise<unknown>) => { registered.set(name, callback); return { dispose() {} }; } });
    Object.assign(lm, { registerMcpServerDefinitionProvider: (id: string, provider: never) => { providers.set(id, provider); return { dispose() {} }; } });
    const restore = () => {
        for (const [name, object] of Object.entries(saved) as [keyof typeof saved, Record<string, unknown>][]) {
            const target = fakeVscode[name] as Record<string, unknown>;
            for (const key of Object.keys(target)) delete target[key];
            Object.assign(target, object);
        }
        if (previousEnv.on !== undefined) process.env.EZIL_CODE_BROWSER_MCP = previousEnv.on;
        if (previousEnv.token !== undefined) process.env.EZIL_CODE_BROWSER_MCP_TOKEN = previousEnv.token;
    };
    return { workspace, providers, registered, notifications, state, restore };
}

const roots: string[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
    for (const child of children.splice(0)) child.kill('SIGKILL');
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function folder(): string {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-ws-')));
    roots.push(root);
    fs.mkdirSync(path.join(root, 'src'));
    fs.mkdirSync(path.join(root, '.git'));
    fs.writeFileSync(path.join(root, 'README.md'), 'PRIVATE-README-BODY');
    return root;
}

type Message = { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string } };
function client(input: PassThrough | NodeJS.WritableStream, output: NodeJS.ReadableStream) {
    const lines = createInterface({ input: output });
    const responses = lines[Symbol.asyncIterator]();
    return {
        send: (message: object) => { input.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n'); },
        receive: async (): Promise<Message> => {
            const next = await responses.next();
            if (next.done) throw new Error('closed');
            return JSON.parse(next.value);
        },
        close: () => lines.close(),
    };
}
async function handshake(mcp: ReturnType<typeof client>) {
    mcp.send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    expect((await mcp.receive()).result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'ezil-workspace' } });
    mcp.send({ method: 'notifications/initialized' });
}
function callInfo(mcp: ReturnType<typeof client>, id = 3, args?: object) {
    mcp.send({ id, method: 'tools/call', params: { name: 'workspace_info', ...(args === undefined ? {} : { arguments: args }) } });
}

describe('workspace grant', () => {
    test('starts at zero, pins the folder identity and revokes when the directory is replaced', () => {
        const root = folder();
        const grant = new WorkspaceMcpGrant();
        expect(grant.live()).toBeUndefined();
        expect(grant.grant(path.join(root, 'README.md'))).toBe(false);
        expect(grant.grant('relative/path')).toBe(false);
        expect(grant.grant(path.join(root, 'missing'))).toBe(false);
        const link = path.join(root, 'link'); fs.symlinkSync(root, link);
        expect(grant.grant(link)).toBe(false);
        expect(grant.live()).toBeUndefined();
        expect(grant.grant(root)).toBe(true);
        expect(grant.live()).toMatchObject({ root, uid: process.getuid!() });
        // Same path, different directory: the recorded inode no longer matches.
        const aside = root + '-aside'; roots.push(aside);
        fs.renameSync(root, aside); fs.mkdirSync(root);
        expect(grant.live()).toBeUndefined();
        expect(grant.live()).toBeUndefined(); // stays revoked even though a directory exists there again
        expect(grant.grant(root)).toBe(true);
        grant.revoke();
        expect(grant.live()).toBeUndefined();
    });

    test('refuses a folder owned by another uid', () => {
        const root = folder();
        expect(identify(root, process.getuid!() + 1)).toBeUndefined();
        expect(new WorkspaceMcpGrant(process.getuid!() + 1).grant(root)).toBe(false);
        expect(new WorkspaceMcpGrant(process.getuid!()).grant(root)).toBe(true);
    });

    test('a new grant object knows nothing: no persistence across restarts', () => {
        const root = folder();
        const first = new WorkspaceMcpGrant();
        expect(first.grant(root)).toBe(true);
        expect(new WorkspaceMcpGrant().live()).toBeUndefined();
    });
});

describe('workspace MCP protocol', () => {
    test('lists one read-only tool, reports top-level names only, and refuses every call once revoked', async () => {
        const root = folder();
        const grant = new WorkspaceMcpGrant();
        const input = new PassThrough(), output = new PassThrough();
        serveWorkspaceMcp(input, output, grant);
        const mcp = client(input, output);
        try {
            callInfo(mcp, 2);
            expect((await mcp.receive()).error?.message).toBe('Initialize first');
            await handshake(mcp);
            mcp.send({ id: 2, method: 'tools/list' });
            const tools = (await mcp.receive()).result!.tools as typeof workspaceInfoTool[];
            expect(tools.map(tool => tool.name)).toEqual(['workspace_info']);
            expect(tools[0]!.annotations.readOnlyHint).toBe(true);
            // Default zero: declared, but nothing granted yet.
            callInfo(mcp);
            expect((await mcp.receive()).result).toMatchObject({ isError: true });
            expect(grant.grant(root)).toBe(true);
            callInfo(mcp, 4);
            const info = (await mcp.receive()).result!;
            expect(info.isError).toBe(false);
            expect(info.structuredContent).toEqual({ name: path.basename(root), path: root, truncated: false,
                entries: [{ name: 'README.md', kind: 'file' }, { name: 'src', kind: 'directory' }] });
            expect(JSON.stringify(info)).not.toContain('PRIVATE-README-BODY');
            expect(JSON.stringify(info)).not.toContain('.git');
            for (const [id, params] of [[5, { name: 'workspace_info', arguments: { path: '..' } }], [6, { name: 'read_file', arguments: {} }]] as const) {
                mcp.send({ id, method: 'tools/call', params });
                expect((await mcp.receive()).error?.code).toBe(-32602);
            }
            mcp.send({ id: 7, method: 'resources/list' });
            expect((await mcp.receive()).error?.code).toBe(-32601);
            grant.revoke();
            callInfo(mcp, 8);
            expect((await mcp.receive()).result).toMatchObject({ isError: true });
            expect(grant.grant(root)).toBe(true);
            fs.rmSync(root, { recursive: true, force: true }); // the folder is gone: the live check fails at call time
            callInfo(mcp, 9);
            expect((await mcp.receive()).result).toMatchObject({ isError: true });
        } finally { mcp.close(); input.end(); output.end(); }
    });
});

describe('workspace MCP endpoint and packaged adapter', () => {
    const adapter = path.join(import.meta.dir, '..', 'src', 'workspace-mcp-server.ts');
    function spawnAdapter(socketPath: string) {
        const child = spawn(process.execPath, ['run', adapter, socketPath], { stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, EZIL_CODE_BROWSER_MCP_TOKEN: 'PRIVATE-FIXTURE-TOKEN' } });
        children.push(child);
        let stderr = '';
        child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
        const exit = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
        return { child, stderr: () => stderr, exit, mcp: client(child.stdin!, child.stdout!) };
    }

    test('proof: the stdio adapter reaches the granted tool over the private socket, and revoke ends it', async () => {
        const root = folder();
        const grant = new WorkspaceMcpGrant();
        expect(grant.grant(root)).toBe(true);
        const endpoint = await WorkspaceMcpEndpoint.open(grant);
        try {
            const directory = path.dirname(endpoint.socketPath);
            expect(path.basename(endpoint.socketPath)).toBe(SOCKET_NAME);
            expect(fs.lstatSync(directory).mode & 0o777).toBe(0o700);
            expect(fs.lstatSync(endpoint.socketPath).mode & 0o077).toBe(0);
            const run = spawnAdapter(endpoint.socketPath);
            await handshake(run.mcp);
            callInfo(run.mcp);
            const info = (await run.mcp.receive()).result!;
            expect(info.isError).toBe(false);
            expect(info.structuredContent).toMatchObject({ name: path.basename(root), path: root });
            expect(JSON.stringify(info)).not.toContain('PRIVATE');
            // Revoke while the adapter is connected: the endpoint closes, the adapter exits, the socket is gone.
            grant.revoke();
            await endpoint.close();
            expect(await run.exit).toBe(0);
            expect(fs.existsSync(directory)).toBe(false);
            expect(endpoint.open).toBe(false);
            // A cached definition still naming that socket cannot serve anything afterwards.
            const stale = spawnAdapter(endpoint.socketPath);
            expect(await stale.exit).toBe(1);
            expect(stale.stderr()).toContain('not attached');
            expect(stale.stderr()).not.toContain('PRIVATE');
        } finally { await endpoint.close().catch(() => {}); }
    });

    test('a live adapter is refused at call time after the grant is revoked, before the endpoint closes', async () => {
        const root = folder();
        const grant = new WorkspaceMcpGrant();
        expect(grant.grant(root)).toBe(true);
        const endpoint = await WorkspaceMcpEndpoint.open(grant);
        try {
            const run = spawnAdapter(endpoint.socketPath);
            await handshake(run.mcp);
            grant.revoke();
            callInfo(run.mcp);
            expect((await run.mcp.receive()).result).toMatchObject({ isError: true });
        } finally { await endpoint.close(); }
    });

    test('the adapter relays only to its socket argument and refuses anything else', async () => {
        const run = spawnAdapter(path.join(os.tmpdir(), 'ezil-ws-missing', SOCKET_NAME));
        expect(await run.exit).toBe(1);
        const none = spawn(process.execPath, ['run', adapter], { stdio: 'pipe' }); children.push(none);
        expect(await new Promise<number | null>(resolve => none.on('exit', code => resolve(code)))).toBe(1);
        const relative = spawn(process.execPath, ['run', adapter, 'relative.sock'], { stdio: 'pipe' }); children.push(relative);
        expect(await new Promise<number | null>(resolve => relative.on('exit', code => resolve(code)))).toBe(1);
    });

    test('relay reports a closed endpoint without echoing the path', async () => {
        const stderr = new PassThrough(); let text = ''; stderr.on('data', chunk => { text += chunk; });
        const code = await new Promise<number>(resolve => relayWorkspaceMcp(path.join(os.tmpdir(), 'ezil-ws-none', SOCKET_NAME), new PassThrough(), new PassThrough(), stderr, resolve));
        expect(code).toBe(1);
        expect(text).toBe('EZiL workspace MCP is not attached in this Code window.\n');
    });

    test('socket connections are plain MCP: a second client sees the same grant state', async () => {
        const root = folder();
        const grant = new WorkspaceMcpGrant();
        const endpoint = await WorkspaceMcpEndpoint.open(grant);
        try {
            const socket = net.connect(endpoint.socketPath);
            await new Promise(resolve => socket.on('connect', resolve));
            const mcp = client(socket, socket);
            await handshake(mcp);
            callInfo(mcp);
            expect((await mcp.receive()).result).toMatchObject({ isError: true }); // default zero
            expect(grant.grant(root)).toBe(true);
            callInfo(mcp, 4);
            expect((await mcp.receive()).result).toMatchObject({ isError: false });
            socket.destroy();
        } finally { await endpoint.close(); }
    });
});

describe('Code MCP provider', () => {
    test('serves the workspace definition only between an owner grant and revoke, and never persists it', async () => {
        const root = folder();
        const workspace = fakeVscode.workspace as Record<string, unknown>;
        const window = fakeVscode.window as Record<string, unknown>;
        const commands = fakeVscode.commands as Record<string, unknown>;
        const lm = fakeVscode.lm as Record<string, unknown>;
        const saved = { workspace: { ...workspace }, window: { ...window }, commands: { ...commands }, lm: { ...lm } };
        const previousEnv = { on: process.env.EZIL_CODE_BROWSER_MCP, token: process.env.EZIL_CODE_BROWSER_MCP_TOKEN };
        delete process.env.EZIL_CODE_BROWSER_MCP; delete process.env.EZIL_CODE_BROWSER_MCP_TOKEN;
        type Definition = { label: string; command: string; args: string[]; env?: unknown; version?: string };
        const providers = new Map<string, { onDidChangeMcpServerDefinitions: { (listener: () => void): unknown }; provideMcpServerDefinitions(): Definition[] }>();
        const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>();
        const notifications: string[] = [];
        let choice: string | undefined = GRANT_CHOICE;
        let modal: Record<string, unknown> | undefined;
        let foldersChanged: (() => void) | undefined;
        Object.assign(workspace, { isTrusted: true, workspaceFolders: [{ uri: { scheme: 'file', authority: '', fsPath: root } }],
            onDidChangeWorkspaceFolders: (listener: () => void) => { foldersChanged = listener; return { dispose() {} }; } });
        Object.assign(window, {
            showInformationMessage: async (text: string) => { notifications.push(text); },
            showWarningMessage: async (text: string, options: Record<string, unknown>) => { notifications.push(text); modal = options; return choice; },
        });
        Object.assign(commands, { registerCommand: (name: string, callback: (...args: unknown[]) => Promise<unknown>) => { registered.set(name, callback); return { dispose() {} }; } });
        Object.assign(lm, { registerMcpServerDefinitionProvider: (id: string, provider: never) => { providers.set(id, provider); return { dispose() {} }; } });
        const context = { subscriptions: [] as { dispose(): void }[], extensionPath: '/ext' };
        try {
            registerCodeMcp(context as never);
            const provider = providers.get('ezil-browser')!;
            let changes = 0; provider.onDidChangeMcpServerDefinitions(() => { changes++; });
            expect(provider.provideMcpServerDefinitions()).toEqual([]); // default zero, browser capability absent
            expect(await registered.get(REVOKE_COMMAND)!()).toBe(false);
            choice = undefined;
            expect(await registered.get(GRANT_COMMAND)!()).toBe(false); // the owner dismissed the modal
            expect(provider.provideMcpServerDefinitions()).toEqual([]);
            choice = GRANT_CHOICE;
            expect(await registered.get(GRANT_COMMAND)!()).toBe(true);
            expect(modal).toMatchObject({ modal: true });
            expect(notifications.some(text => text.includes(root))).toBe(true);
            const [definition] = provider.provideMcpServerDefinitions();
            expect(definition).toMatchObject({ label: 'EZiL Workspace', command: process.execPath, env: undefined });
            expect(definition!.args[0]).toBe('/ext/dist/workspace-mcp-server.js');
            const socketPath = definition!.args[1]!;
            expect(path.basename(socketPath)).toBe(SOCKET_NAME);
            expect(fs.existsSync(socketPath)).toBe(true);
            expect(definition!.args).toHaveLength(2);
            expect(changes).toBe(1);
            // The served endpoint is a real MCP server bound to the granted folder.
            const socket = net.connect(socketPath);
            await new Promise(resolve => socket.on('connect', resolve));
            const mcp = client(socket, socket);
            await handshake(mcp);
            callInfo(mcp);
            expect((await mcp.receive()).result).toMatchObject({ isError: false, structuredContent: { path: root } });
            expect(await registered.get(REVOKE_COMMAND)!()).toBe(true);
            expect(provider.provideMcpServerDefinitions()).toEqual([]);
            expect(fs.existsSync(path.dirname(socketPath))).toBe(false);
            expect(changes).toBe(2);
            await expect(mcp.receive()).rejects.toThrow('closed');
            socket.destroy();
            // A changed folder set detaches on its own; an untrusted or multi-root window cannot grant.
            expect(await registered.get(GRANT_COMMAND)!()).toBe(true);
            foldersChanged!();
            for (let count = 0; count < 50 && provider.provideMcpServerDefinitions().length; count++) await Bun.sleep(5);
            expect(provider.provideMcpServerDefinitions()).toEqual([]);
            workspace.isTrusted = false;
            expect(await registered.get(GRANT_COMMAND)!()).toBe(false);
            workspace.isTrusted = true;
            workspace.workspaceFolders = [{ uri: { scheme: 'file', authority: '', fsPath: root } }, { uri: { scheme: 'file', authority: '', fsPath: os.tmpdir() } }];
            expect(await registered.get(GRANT_COMMAND)!()).toBe(false);
            workspace.workspaceFolders = [{ uri: { scheme: 'vscode-remote', authority: 'ssh-remote+host', fsPath: root } }];
            expect(await registered.get(GRANT_COMMAND)!()).toBe(false);
            expect(provider.provideMcpServerDefinitions()).toEqual([]);
            // Disposal (window close) detaches too; a fresh registration starts at zero again.
            workspace.workspaceFolders = [{ uri: { scheme: 'file', authority: '', fsPath: root } }];
            expect(await registered.get(GRANT_COMMAND)!()).toBe(true);
            const [granted] = provider.provideMcpServerDefinitions();
            for (const subscription of context.subscriptions.splice(0)) subscription.dispose();
            for (let count = 0; count < 50 && fs.existsSync(path.dirname(granted!.args[1]!)); count++) await Bun.sleep(5);
            expect(fs.existsSync(path.dirname(granted!.args[1]!))).toBe(false);
            registerCodeMcp(context as never);
            expect(providers.get('ezil-browser')!.provideMcpServerDefinitions()).toEqual([]);
            expect(JSON.stringify(notifications)).not.toContain('PRIVATE');
        } finally {
            for (const subscription of context.subscriptions) subscription.dispose();
            for (const [name, object] of Object.entries(saved) as [keyof typeof saved, Record<string, unknown>][]) {
                const target = fakeVscode[name] as Record<string, unknown>;
                for (const key of Object.keys(target)) delete target[key];
                Object.assign(target, object);
            }
            if (previousEnv.on !== undefined) process.env.EZIL_CODE_BROWSER_MCP = previousEnv.on;
            if (previousEnv.token !== undefined) process.env.EZIL_CODE_BROWSER_MCP_TOKEN = previousEnv.token;
        }
    });

    test('a detached window or a replaced directory invalidates an open confirmation', async () => {
        const root = folder();
        let choose!: (answer: string) => void;
        const fake = fakeWindow(root, () => new Promise<string>(resolve => { choose = resolve; }));
        const context = { subscriptions: [] as { dispose(): void }[], extensionPath: '/ext' };
        try {
            registerCodeMcp(context as never);
            const approve = fake.registered.get(GRANT_COMMAND)!;
            const first = approve();
            await fake.registered.get(REVOKE_COMMAND)!();
            choose(GRANT_CHOICE);
            expect(await first).toBe(false);
            const second = approve();
            fs.renameSync(root, root + '-old');
            roots.push(root + '-old');
            fs.mkdirSync(root);
            choose(GRANT_CHOICE);
            expect(await second).toBe(false);
            expect(fake.providers.get('ezil-browser')!.provideMcpServerDefinitions()).toEqual([]);
        } finally {
            for (const subscription of context.subscriptions) subscription.dispose();
            fake.restore();
        }
    });

    test('a revoke during endpoint opening wins: the late endpoint closes and a later grant uses a fresh one', async () => {
        const root = folder();
        const fake = fakeWindow(root, () => GRANT_CHOICE);
        const context = { subscriptions: [] as { dispose(): void }[], extensionPath: '/ext' };
        let release: (() => void) | undefined;
        const opened: WorkspaceMcpEndpoint[] = [];
        const open = async (grant: WorkspaceMcpGrant) => {
            const endpoint = await WorkspaceMcpEndpoint.open(grant);
            opened.push(endpoint);
            if (release === undefined) await new Promise<void>(resolve => { release = resolve; });
            return endpoint;
        };
        try {
            registerCodeMcp(context as never, open);
            const provider = fake.providers.get('ezil-browser')!;
            const granting = fake.registered.get(GRANT_COMMAND)!();
            for (let count = 0; count < 50 && !opened.length; count++) await Bun.sleep(5);
            expect(opened).toHaveLength(1);
            const firstSocket = opened[0]!.socketPath;
            // The owner revokes while the first endpoint is still opening (nothing is active yet, so revoke reports false).
            expect(await fake.registered.get(REVOKE_COMMAND)!()).toBe(false);
            release!();
            expect(await granting).toBe(false);
            expect(provider.provideMcpServerDefinitions()).toEqual([]);
            expect(opened[0]!.open).toBe(false);
            expect(fs.existsSync(path.dirname(firstSocket))).toBe(false);
            // A later grant gets its own grant object and endpoint; the first one never serves it.
            release = () => {};
            expect(await fake.registered.get(GRANT_COMMAND)!()).toBe(true);
            const [definition] = provider.provideMcpServerDefinitions();
            expect(definition!.args[1]).toBe(opened[1]!.socketPath);
            expect(definition!.args[1]).not.toBe(firstSocket);
            const stale = spawn(process.execPath, ['run', path.join(import.meta.dir, '..', 'src', 'workspace-mcp-server.ts'), firstSocket], { stdio: 'pipe' }); children.push(stale);
            expect(await new Promise<number | null>(resolve => stale.on('exit', code => resolve(code)))).toBe(1);
            // Two overlapping grants: only the last one stays active and the other endpoint is closed.
            const first = fake.registered.get(GRANT_COMMAND)!();
            const second = fake.registered.get(GRANT_COMMAND)!();
            expect([await first, await second]).toEqual([false, true]);
            expect(opened.filter(endpoint => endpoint.open)).toHaveLength(1);
            expect(provider.provideMcpServerDefinitions()[0]!.args[1]).toBe(opened.find(endpoint => endpoint.open)!.socketPath);
            expect(await fake.registered.get(REVOKE_COMMAND)!()).toBe(true);
            expect(opened.every(endpoint => !endpoint.open)).toBe(true);
        } finally {
            for (const subscription of context.subscriptions) subscription.dispose();
            for (const endpoint of opened) await endpoint.close().catch(() => {});
            fake.restore();
        }
    });
});
