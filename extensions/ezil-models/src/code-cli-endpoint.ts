// Root-only socket for the in-computer `ezil` CLI (docs/STAGING-COMPUTER-TOOLS-MCP.md section 7).
//
// `ezil chat new|list|send|read` writes one newline-terminated JSON request `{v:1, op, args}` to
// /run/ezil-cli/ezil.sock; this endpoint relays it as `POST <code origin>/editor-bridge/v1/cli` with this boot's
// EZIL_EDITOR_BRIDGE_TOKEN (the same bearer the sync client uses) and answers `{v:1, ok:true, result}` or
// `{v:1, ok:false, error:{code, message}}`. The directory is 0700 and the socket 0600, owned by the user running the
// extension host (root), so the job user `ezil-run` cannot connect. Served only while ezil.chatBridge.enabled is
// true, a valid bridge token is present and the code origin derives from EZIL_AI_BASE_URL. The token is never
// logged, never replied and never part of an error: every outgoing string is scrubbed of it.

import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { syncUrlFrom } from './chat-bridge-client';

export const SOCKET_DIR = '/run/ezil-cli';
export const SOCKET_NAME = 'ezil.sock';
export const CLI_PATH = '/editor-bridge/v1/cli';
export const OPS = ['chat.new', 'chat.list', 'chat.send', 'chat.read'] as const;
export type CliOp = (typeof OPS)[number];
/** One request line (without its newline), and the POST body built from it. */
export const MAX_REQUEST_BYTES = 32_768;
/** The Worker relays at most this many reply bytes. */
export const MAX_UPSTREAM_BYTES = 65_536;
export const FORWARD_TIMEOUT_MS = 25_000;
const IDLE_MS = 10_000;
const MAX_CONNECTIONS = 16;
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const TOKEN = /^[0-9a-f]{64}$/;

export interface CliServerDeps {
    socketDir: string;
    /** `<code origin>/editor-bridge/v1/cli`. */
    cliUrl: string;
    token: string;
    fetch: (url: string, init: RequestInit) => Promise<Response>;
    log: (line: string) => void;
    timeoutMs?: number;
    idleMs?: number;
}

export interface CodeCliDeps {
    socketDir?: string;
    env?: Record<string, string | undefined>;
    fetch?: CliServerDeps['fetch'];
    timeoutMs?: number;
    idleMs?: number;
}

/** The code host's CLI route, from EZIL_AI_BASE_URL (same derivation and scheme rules as the sync URL), or null. */
export function cliUrlFrom(aiBaseUrl: string | undefined): string | null {
    const sync = syncUrlFrom(aiBaseUrl);
    return sync ? `${new URL(sync).origin}${CLI_PATH}` : null;
}

type Failure = { code: string; message: string };
type Parsed = { ok: true; op: CliOp; args: Record<string, unknown>; requestId: string } | { ok: false; error: Failure };

const isObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parseRequest(line: string): Parsed {
    const bad = (message: string): Parsed => ({ ok: false, error: { code: 'cli_invalid_request', message } });
    let request: unknown;
    try {
        request = JSON.parse(line);
    } catch {
        return bad('request is not JSON');
    }
    if (!isObject(request) || request.v !== 1) return bad('request must be an object with v:1');
    const op = request.op;
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return bad('unknown op');
    if (request.args !== undefined && !isObject(request.args)) return bad('args must be an object');
    const args = { ...(request.args ?? {}) } as Record<string, unknown>;
    let requestId: string = randomUUID();
    if ('requestId' in args) {
        if (typeof args.requestId !== 'string' || !V4.test(args.requestId)) return bad('requestId must be a v4 UUID');
        requestId = args.requestId;
        delete args.requestId;
    }
    return { ok: true, op: op as CliOp, args, requestId };
}

/** Never let the bearer leave through a message, however it got there. */
const scrub = (text: string, token: string) => text.split(token).join('[redacted]');

const safeCode = (value: unknown, fallback: string) => typeof value === 'string' && CODE.test(value) ? value : fallback;

async function readCapped(response: Response, limit: number): Promise<string | null> {
    const reader = response.body?.getReader();
    if (!reader) return '';
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) {
            await reader.cancel().catch(() => undefined);
            return null;
        }
        chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
}

const httpFailure = (status: number): Failure =>
    status === 401 || status === 403 ? { code: 'cli_unauthorized', message: 'the code host refused the bridge token' }
        : status === 404 ? { code: 'cli_unavailable', message: 'the chat CLI is not available on this computer' }
            : { code: 'bridge_bad_reply', message: `the code host answered HTTP ${status}` };

type Outcome = { ok: true; result: unknown } | { ok: false; error: Failure };

/** What OS answered, as the CLI's reply: `{ok:true, result}` or `{ok:false, error:{code, message}}`. */
function outcomeOf(status: number, text: string): Outcome {
    let body: unknown;
    try {
        body = JSON.parse(text);
    } catch {
        return { ok: false, error: status >= 200 && status < 300 ? { code: 'bridge_bad_reply', message: 'the code host reply was not JSON' } : httpFailure(status) };
    }
    if (isObject(body) && body.ok === true && status >= 200 && status < 300) {
        if (isObject(body.result)) return { ok: true, result: body.result };
        const { ok: _ok, ...rest } = body;
        return { ok: true, result: rest };
    }
    if (isObject(body) && (body.ok === false || 'error' in body)) {
        const raw = body.error;
        if (typeof raw === 'string') return { ok: false, error: { code: safeCode(raw, 'bridge_error'), message: raw.slice(0, 200) } };
        if (isObject(raw)) {
            const code = safeCode(raw.code, httpFailure(status).code);
            const message = typeof raw.message === 'string' && raw.message ? raw.message.slice(0, 500) : code;
            return { ok: false, error: { code, message } };
        }
    }
    return { ok: false, error: status >= 200 && status < 300 ? { code: 'bridge_bad_reply', message: 'the code host reply had an unexpected shape' } : httpFailure(status) };
}

async function forward(deps: CliServerDeps, parsed: Extract<Parsed, { ok: true }>): Promise<Outcome> {
    const body = JSON.stringify({ op: parsed.op, args: parsed.args, requestId: parsed.requestId });
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
        return { ok: false, error: { code: 'request_too_large', message: `request exceeds ${MAX_REQUEST_BYTES} bytes` } };
    }
    let response: Response;
    try {
        response = await deps.fetch(deps.cliUrl, {
            method: 'POST',
            headers: { authorization: `Bearer ${deps.token}`, 'content-type': 'application/json' },
            body,
            redirect: 'error',
            signal: AbortSignal.timeout(deps.timeoutMs ?? FORWARD_TIMEOUT_MS),
        });
    } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return { ok: false, error: timedOut
            ? { code: 'bridge_timeout', message: 'the code host did not answer in time' }
            : { code: 'bridge_unreachable', message: 'the code host is unreachable' } };
    }
    let text: string | null;
    try {
        text = await readCapped(response, MAX_UPSTREAM_BYTES);
    } catch (error) {
        const timedOut = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
        return { ok: false, error: { code: timedOut ? 'bridge_timeout' : 'bridge_unreachable', message: 'the code host reply was cut off' } };
    }
    if (text === null) return { ok: false, error: { code: 'bridge_bad_reply', message: `the code host reply exceeds ${MAX_UPSTREAM_BYTES} bytes` } };
    return outcomeOf(response.status, text);
}

function reply(socket: net.Socket, token: string, outcome: Outcome): void {
    const payload = outcome.ok
        ? { v: 1, ok: true, result: outcome.result }
        : { v: 1, ok: false, error: { code: outcome.error.code, message: outcome.error.message } };
    const line = scrub(JSON.stringify(payload), token) + '\n';
    if (socket.destroyed) return;
    socket.end(line);
}

function handle(deps: CliServerDeps, socket: net.Socket): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let accepted = false;
    let settled = false;
    socket.setTimeout(deps.idleMs ?? IDLE_MS);
    const finish = (outcome: Outcome, op?: string) => {
        if (settled) return;
        settled = true;
        deps.log(scrub(`[code-cli] ${op ?? 'rejected'}: ${outcome.ok ? 'ok' : outcome.error.code}`, deps.token));
        reply(socket, deps.token, outcome);
    };
    const refuse = (code: string, message: string) => finish({ ok: false, error: { code, message } });
    // Bytes after the request line (or after a refusal) are read and dropped, so the reply is never lost to a reset.
    socket.on('data', (chunk: Buffer) => {
        if (settled || accepted) return;
        const newline = chunk.indexOf(0x0a);
        size += newline === -1 ? chunk.length : newline;
        if (size > MAX_REQUEST_BYTES) return refuse('request_too_large', `request exceeds ${MAX_REQUEST_BYTES} bytes`);
        chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
        if (newline === -1) return;
        accepted = true;
        socket.setTimeout(0);
        const parsed = parseRequest(Buffer.concat(chunks).toString('utf8'));
        if (!parsed.ok) return finish(parsed);
        void forward(deps, parsed).then((outcome) => finish(outcome, parsed.op));
    });
    socket.on('end', () => { if (!accepted) refuse('cli_invalid_request', 'request must end with a newline'); });
    socket.on('timeout', () => { if (!accepted) refuse('cli_invalid_request', 'request timed out'); });
    socket.on('error', () => { settled = true; socket.destroy(); });
}

export interface CliServer { server: net.Server; socketPath: string; dispose(): void }

/**
 * Create the socket directory (0700, owned by this user, never a symlink) and serve on `<dir>/ezil.sock` (0600).
 * Throws when the directory cannot be made safe. A stale socket left by an earlier run is removed first.
 */
export function startCliServer(deps: CliServerDeps): CliServer {
    const dir = deps.socketDir;
    const socketPath = path.join(dir, SOCKET_NAME);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('socket directory is not a plain directory');
    if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('socket directory belongs to another user');
    fs.chmodSync(dir, 0o700);
    fs.rmSync(socketPath, { force: true });
    const server = net.createServer({ allowHalfOpen: true }, (socket) => handle(deps, socket));
    server.maxConnections = MAX_CONNECTIONS;
    server.on('error', (error: NodeJS.ErrnoException) => deps.log(`[code-cli] server error: ${error.code ?? 'error'}`));
    server.listen(socketPath, () => {
        try {
            fs.chmodSync(socketPath, 0o600);
        } catch (error) {
            deps.log(`[code-cli] chmod failed: ${(error as NodeJS.ErrnoException).code ?? 'error'}`);
        }
    });
    return {
        server,
        socketPath,
        dispose: () => {
            server.close();
            fs.rmSync(socketPath, { force: true });
        },
    };
}

/**
 * Serve the CLI socket for this extension host, only while the chat bridge is on, this computer has a valid bridge
 * token and the code origin derives from EZIL_AI_BASE_URL; otherwise serve nothing and say why in one line.
 */
export function registerCodeCli(context: vscode.ExtensionContext, log: (line: string) => void, overrides: CodeCliDeps = {}): void {
    const env = overrides.env ?? process.env;
    const token = env.EZIL_EDITOR_BRIDGE_TOKEN ?? '';
    const cliUrl = cliUrlFrom(env.EZIL_AI_BASE_URL);
    const enabled = vscode.workspace.getConfiguration('ezil').get('chatBridge.enabled') === true;
    const missing = [enabled ? '' : 'ezil.chatBridge.enabled', TOKEN.test(token) ? '' : 'bridge token', cliUrl ? '' : 'code origin'].filter(Boolean);
    if (missing.length || !cliUrl) {
        log(`[code-cli] off: ${missing.join(', ')}`);
        return;
    }
    try {
        const served = startCliServer({
            socketDir: overrides.socketDir ?? SOCKET_DIR,
            cliUrl,
            token,
            fetch: overrides.fetch ?? ((url, init) => fetch(url, init)),
            log,
            timeoutMs: overrides.timeoutMs,
            idleMs: overrides.idleMs,
        });
        context.subscriptions.push({ dispose: () => served.dispose() });
        log(`[code-cli] serving ${served.socketPath}`);
    } catch (error) {
        log(`[code-cli] off: ${scrub(error instanceof Error ? error.message : 'start failed', token)}`);
    }
}
