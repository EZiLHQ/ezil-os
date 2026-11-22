// The in-computer CLI socket: gate, relay request, size limits, error mapping, token hygiene and the root-only
// permissions (docs/STAGING-COMPUTER-TOOLS-MCP.md section 7). Everything runs against fakes; nothing leaves the host.

import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

import { fakeVscode } from './fixtures/fake-vscode';

mock.module('vscode', () => fakeVscode);
const { FORWARD_TIMEOUT_MS, MAX_REQUEST_BYTES, MAX_UPSTREAM_BYTES, cliUrlFrom, registerCodeCli, startCliServer } = await import('../src/code-cli-endpoint');

const TOKEN = 'ab12'.repeat(16);
const BASE = 'https://8443-guac-a-b-code.ezil.work/ai/v1';
const CLI_URL = 'https://8443-guac-a-b-code.ezil.work/editor-bridge/v1/cli';
const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// A short path: unix socket paths are limited to ~100 bytes. World-traversable so the uid test is about the socket.
const root = fs.mkdtempSync(path.join('/tmp', 'ezil-cli-'));
fs.chmodSync(root, 0o755);
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
const freshDir = () => path.join(root, `d${counter++}`);
/** The real client is node; resolve it from PATH (CI's setup-node installs it outside /usr/bin). */
const NODE = (process.env.PATH ?? '').split(path.delimiter).map((dir) => path.join(dir, 'node'))
    .find((candidate) => { try { fs.accessSync(candidate, fs.constants.X_OK); return true; } catch { return false; } }) ?? '/usr/bin/node';
/** What a crashed server leaves behind: a socket file nobody listens on (a clean close() unlinks it on newer Bun). */
function leaveStaleSocket(socketPath: string): Promise<void> {
    const script = `require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))`;
    return new Promise((resolve, reject) => {
        const child = spawn(NODE, ['-e', script, socketPath], { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', () => resolve());
    });
}

type Captured = { url: string; init: RequestInit };
const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const cleanups: (() => void)[] = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function serve(fetch: (url: string, init: RequestInit) => Promise<Response>, extra: { timeoutMs?: number; idleMs?: number } = {}) {
    const logs: string[] = [];
    const dir = freshDir();
    const served = startCliServer({ socketDir: dir, cliUrl: CLI_URL, token: TOKEN, fetch, log: (line) => logs.push(line), ...extra });
    cleanups.push(() => served.dispose());
    return { served, logs, dir };
}

/** One connection: write `payload`, optionally half-close, return everything the endpoint answered. */
async function exchange(socketPath: string, payload: string | Buffer, end = false): Promise<string> {
    for (let waited = 0; waited < 500 && !fs.existsSync(socketPath); waited += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    return new Promise((resolve, reject) => {
        const socket = net.connect(socketPath);
        let data = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => { data += chunk; });
        socket.on('close', () => resolve(data));
        socket.on('error', (error) => { if ((error as NodeJS.ErrnoException).code === 'EPIPE' || (error as NodeJS.ErrnoException).code === 'ECONNRESET') resolve(data); else reject(error); });
        socket.on('connect', () => { if (end) socket.end(payload); else socket.write(payload); });
    });
}

const ask = async (socketPath: string, request: unknown) => JSON.parse(await exchange(socketPath, `${JSON.stringify(request)}\n`)) as Record<string, any>;

describe('the gate', () => {
    const context = () => ({ subscriptions: [] as { dispose(): void }[] });
    const setBridge = (enabled: unknown) => {
        (fakeVscode.workspace as any).getConfiguration = () => ({ get: (key: string) => key === 'chatBridge.enabled' ? enabled : undefined });
    };
    afterEach(() => { (fakeVscode.workspace as any).getConfiguration = () => ({ get: () => undefined }); });
    const env = { EZIL_EDITOR_BRIDGE_TOKEN: TOKEN, EZIL_AI_BASE_URL: BASE };

    test('serves only with the setting on, a valid 64-hex token and a code origin; each refusal is one log line and no socket', () => {
        const cases: [string, unknown, Record<string, string | undefined>][] = [
            ['setting unset', undefined, env],
            ['setting false', false, env],
            ['setting not boolean', 'true', env],
            ['token missing', true, { EZIL_AI_BASE_URL: BASE }],
            ['token short', true, { ...env, EZIL_EDITOR_BRIDGE_TOKEN: 'ab12' }],
            ['token uppercase', true, { ...env, EZIL_EDITOR_BRIDGE_TOKEN: TOKEN.toUpperCase() }],
            ['token not hex', true, { ...env, EZIL_EDITOR_BRIDGE_TOKEN: 'z'.repeat(64) }],
            ['base url missing', true, { EZIL_EDITOR_BRIDGE_TOKEN: TOKEN }],
            ['base url http non-local', true, { ...env, EZIL_AI_BASE_URL: 'http://evil.example/ai/v1' }],
            ['base url junk', true, { ...env, EZIL_AI_BASE_URL: 'not a url' }],
        ];
        for (const [label, enabled, e] of cases) {
            setBridge(enabled);
            const dir = freshDir();
            const ctx = context();
            const logs: string[] = [];
            registerCodeCli(ctx as never, (line) => logs.push(line), { env: e, socketDir: dir });
            expect([label, logs.length, ctx.subscriptions.length, fs.existsSync(dir)]).toEqual([label, 1, 0, false]);
            expect(logs[0]).toStartWith('[code-cli] off:');
            expect(logs[0]).not.toContain(TOKEN);
        }
    });

    test('with everything present it serves, and disposing with the extension removes the socket', async () => {
        setBridge(true);
        const dir = freshDir();
        const ctx = context();
        const logs: string[] = [];
        registerCodeCli(ctx as never, (line) => logs.push(line), { env, socketDir: dir, fetch: async () => jsonResponse({ ok: true, result: { sessions: [] } }) });
        expect(ctx.subscriptions).toHaveLength(1);
        const socketPath = path.join(dir, 'ezil.sock');
        expect(await ask(socketPath, { v: 1, op: 'chat.list', args: {} })).toEqual({ v: 1, ok: true, result: { sessions: [] } });
        ctx.subscriptions[0]!.dispose();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fs.existsSync(socketPath)).toBe(false);
        await expect(exchange(socketPath, 'x\n')).rejects.toThrow();
        expect(logs.join('\n')).not.toContain(TOKEN);
    });

    test('turning the setting off at runtime stops relaying (cli_unavailable) and turning it on resumes', async () => {
        setBridge(true);
        const dir = freshDir();
        const ctx = context();
        let fetched = 0;
        registerCodeCli(ctx as never, () => {}, { env, socketDir: dir, fetch: async () => { fetched++; return jsonResponse({ ok: true, result: { sessions: [] } }); } });
        cleanups.push(() => ctx.subscriptions.forEach((d) => d.dispose()));
        const socketPath = path.join(dir, 'ezil.sock');
        expect((await ask(socketPath, { v: 1, op: 'chat.list', args: {} })).ok).toBe(true);
        setBridge(false);
        expect(await ask(socketPath, { v: 1, op: 'chat.list', args: {} })).toEqual({ v: 1, ok: false, error: { code: 'cli_unavailable', message: expect.any(String) } });
        expect(fetched).toBe(1);
        setBridge(true);
        expect((await ask(socketPath, { v: 1, op: 'chat.list', args: {} })).ok).toBe(true);
        expect(fetched).toBe(2);
    });

    test('the code origin comes from the sync derivation (https, or http for localhost)', () => {
        expect(cliUrlFrom(BASE)).toBe(CLI_URL);
        expect(cliUrlFrom('http://8443-x.localhost:8787/ai/v1')).toBe('http://8443-x.localhost:8787/editor-bridge/v1/cli');
        for (const bad of [undefined, '', 'nope', 'http://evil.example/x', 'file:///etc/passwd']) expect(cliUrlFrom(bad)).toBeNull();
    });

    test('a directory that is a symlink is refused rather than served through', () => {
        setBridge(true);
        const target = freshDir();
        fs.mkdirSync(target);
        const link = freshDir();
        fs.symlinkSync(target, link);
        const logs: string[] = [];
        registerCodeCli(context() as never, (line) => logs.push(line), { env, socketDir: link });
        expect(logs).toHaveLength(1);
        expect(logs[0]).toStartWith('[code-cli] off:');
        expect(fs.readdirSync(target)).toEqual([]);
    });
});

describe('socket creation', () => {
    test('directory 0700 and socket 0600, owned by this user; a stale file and a loose directory are fixed', async () => {
        const dir = freshDir();
        fs.mkdirSync(dir, { mode: 0o755 });
        fs.chmodSync(dir, 0o755);
        fs.writeFileSync(path.join(dir, 'ezil.sock'), 'stale');
        const served = startCliServer({ socketDir: dir, cliUrl: CLI_URL, token: TOKEN, fetch: async () => jsonResponse({ ok: true, result: {} }), log: () => {} });
        cleanups.push(() => served.dispose());
        await new Promise((resolve) => served.server.once('listening', resolve));
        await new Promise((resolve) => setTimeout(resolve, 20));
        for (const [target, mode] of [[dir, 0o700], [served.socketPath, 0o600]] as const) {
            const stat = fs.statSync(target);
            expect([target, stat.mode & 0o777]).toEqual([target, mode]);
            expect(stat.uid).toBe(process.getuid!());
        }
        expect(fs.statSync(served.socketPath).isSocket()).toBe(true);
    });

    test('a socket left by an earlier run does not stop a new one from serving', async () => {
        const dir = freshDir();
        const first = startCliServer({ socketDir: dir, cliUrl: CLI_URL, token: TOKEN, fetch: async () => jsonResponse({ ok: true, result: { n: 1 } }), log: () => {} });
        await new Promise((resolve) => first.server.once('listening', resolve));
        // The old process died without cleaning up: its socket file stays, nobody listens on it.
        first.server.close();
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (!fs.existsSync(first.socketPath)) await leaveStaleSocket(first.socketPath);
        expect(fs.existsSync(first.socketPath)).toBe(true);
        const second = startCliServer({ socketDir: dir, cliUrl: CLI_URL, token: TOKEN, fetch: async () => jsonResponse({ ok: true, result: { n: 2 } }), log: () => {} });
        cleanups.push(() => second.dispose());
        expect((await ask(second.socketPath, { v: 1, op: 'chat.list', args: {} })).result).toEqual({ n: 2 });
    });
});

describe('relay', () => {
    test('each request becomes one POST with the bearer, a fresh v4 requestId, redirect error and the 25 s timeout', async () => {
        const seen: Captured[] = [];
        const { served } = serve(async (url, init) => { seen.push({ url, init }); return jsonResponse({ ok: true, result: { sessionId: 's1', operationId: 'o1', status: 'queued' } }); });
        const one = await ask(served.socketPath, { v: 1, op: 'chat.new', args: { model: 'm', effort: 'high' } });
        const two = await ask(served.socketPath, { v: 1, op: 'chat.new', args: {} });
        expect(one).toEqual({ v: 1, ok: true, result: { sessionId: 's1', operationId: 'o1', status: 'queued' } });
        expect(two.ok).toBe(true);
        expect(seen).toHaveLength(2);
        const [first, second] = seen as [Captured, Captured];
        expect(first.url).toBe(CLI_URL);
        expect(first.init.method).toBe('POST');
        expect(first.init.redirect).toBe('error');
        expect(first.init.headers).toEqual({ authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
        expect(first.init.signal).toBeInstanceOf(AbortSignal);
        expect(FORWARD_TIMEOUT_MS).toBe(25_000);
        const body = JSON.parse(first.init.body as string);
        expect(Object.keys(body).sort()).toEqual(['args', 'op', 'requestId']);
        expect(body).toMatchObject({ op: 'chat.new', args: { model: 'm', effort: 'high' } });
        expect(body.requestId).toMatch(V4);
        expect(JSON.parse(second.init.body as string).requestId).not.toBe(body.requestId);
    });

    test('all four ops are forwarded; a v4 requestId in args becomes the body requestId, anything else is refused', async () => {
        const bodies: any[] = [];
        const { served } = serve(async (_url, init) => { bodies.push(JSON.parse(init.body as string)); return jsonResponse({ ok: true, result: {} }); });
        for (const op of ['chat.new', 'chat.list', 'chat.send', 'chat.read']) await ask(served.socketPath, { v: 1, op, args: {} });
        expect(bodies.map((b) => b.op)).toEqual(['chat.new', 'chat.list', 'chat.send', 'chat.read']);
        const id = '11111111-2222-4333-8444-555555555555';
        await ask(served.socketPath, { v: 1, op: 'chat.send', args: { sessionId: 's', text: 't', requestId: id } });
        expect(bodies[4]).toEqual({ op: 'chat.send', args: { sessionId: 's', text: 't' }, requestId: id });
        const refused = await ask(served.socketPath, { v: 1, op: 'chat.send', args: { requestId: 'not-a-uuid' } });
        expect(refused).toEqual({ v: 1, ok: false, error: { code: 'cli_invalid_request', message: expect.any(String) } });
        expect(bodies).toHaveLength(5);
    });

    test('args may be omitted (treated as empty)', async () => {
        const bodies: any[] = [];
        const { served } = serve(async (_url, init) => { bodies.push(JSON.parse(init.body as string)); return jsonResponse({ ok: true, result: { sessions: [] } }); });
        await ask(served.socketPath, { v: 1, op: 'chat.list' });
        expect(bodies[0].args).toEqual({});
    });

    test('concurrent connections each get their own reply', async () => {
        const { served } = serve(async (_url, init) => {
            const body = JSON.parse(init.body as string);
            await new Promise((resolve) => setTimeout(resolve, body.args.delay));
            return jsonResponse({ ok: true, result: { tag: body.args.tag } });
        });
        const replies = await Promise.all([
            ask(served.socketPath, { v: 1, op: 'chat.list', args: { tag: 'slow', delay: 60 } }),
            ask(served.socketPath, { v: 1, op: 'chat.list', args: { tag: 'fast', delay: 0 } }),
        ]);
        expect(replies.map((r) => r.result.tag)).toEqual(['slow', 'fast']);
    });

    test('a reply may carry its fields beside ok instead of under result', async () => {
        const { served } = serve(async () => jsonResponse({ ok: true, sessionId: 's', events: [], cursor: 'c' }));
        expect(await ask(served.socketPath, { v: 1, op: 'chat.read', args: { sessionId: 's' } })).toEqual({ v: 1, ok: true, result: { sessionId: 's', events: [], cursor: 'c' } });
    });
});

describe('request validation and size limits', () => {
    const never = async () => { throw new Error('must not be called'); };

    test('malformed requests are refused without calling the code host', async () => {
        const { served } = serve(never);
        const bad = [
            'not json\n', '[]\n', 'null\n', '"x"\n', '{}\n',
            JSON.stringify({ v: 2, op: 'chat.new', args: {} }) + '\n',
            JSON.stringify({ op: 'chat.new', args: {} }) + '\n',
            JSON.stringify({ v: 1, op: 'chat.delete', args: {} }) + '\n',
            JSON.stringify({ v: 1, op: 'chat.new', args: [] }) + '\n',
            JSON.stringify({ v: 1, op: 'chat.new', args: 'x' }) + '\n',
            JSON.stringify({ v: 1, op: 7, args: {} }) + '\n',
            '\n',
        ];
        for (const line of bad) {
            const answer = JSON.parse(await exchange(served.socketPath, line));
            expect([line, answer.v, answer.ok, answer.error.code]).toEqual([line, 1, false, 'cli_invalid_request']);
        }
    });

    test('a request without its newline is refused when the client half-closes', async () => {
        const { served } = serve(never);
        // A node child: bun's own sockets cannot half-close, and the real client is node.
        const script = `const s=require('net').connect(process.argv[1]);let d='';s.on('data',c=>d+=c);s.on('close',()=>console.log(d));s.on('connect',()=>s.end(JSON.stringify({v:1,op:'chat.list',args:{}})))`;
        const out = await new Promise<string>((resolve, reject) => {
            const child = spawn(NODE, ['-e', script, served.socketPath], { stdio: ['ignore', 'pipe', 'inherit'] });
            let text = '';
            child.stdout.on('data', (chunk) => { text += chunk; });
            child.on('error', reject);
            child.on('close', () => resolve(text));
        });
        expect(JSON.parse(out).error.code).toBe('cli_invalid_request');
    });

    test('a client that never finishes its line is cut off after the idle time', async () => {
        const { served } = serve(never, { idleMs: 60 });
        const answer = JSON.parse(await exchange(served.socketPath, '{"v":1,'));
        expect(answer.error).toEqual({ code: 'cli_invalid_request', message: 'request timed out' });
    });

    test('only the first line counts; a second request on the same connection is never run', async () => {
        const bodies: unknown[] = [];
        const { served } = serve(async (_url, init) => { bodies.push(init.body); return jsonResponse({ ok: true, result: {} }); });
        const line = JSON.stringify({ v: 1, op: 'chat.list', args: {} });
        const out = await exchange(served.socketPath, `${line}\n${line}\n`);
        expect(out.trim().split('\n')).toHaveLength(1);
        expect(bodies).toHaveLength(1);
    });

    const padded = (bytes: number) => {
        const head = '{"v":1,"op":"chat.send","args":{"sessionId":"s","text":"';
        const tail = '"}}';
        return head + 'x'.repeat(bytes - head.length - tail.length) + tail;
    };

    test('a line over 32,768 bytes is refused as too large and never forwarded', async () => {
        const { served, logs } = serve(never);
        for (const size of [MAX_REQUEST_BYTES + 1, MAX_REQUEST_BYTES * 3]) {
            const answer = JSON.parse(await exchange(served.socketPath, padded(size) + '\n'));
            expect(answer.error.code).toBe('request_too_large');
        }
        // Without any newline at all too.
        expect(JSON.parse(await exchange(served.socketPath, 'x'.repeat(MAX_REQUEST_BYTES + 10))).error.code).toBe('request_too_large');
        expect(logs.join('\n')).toContain('request_too_large');
    });

    test('the POST body (request plus requestId) is capped at 32,768 bytes too', async () => {
        const bodies: string[] = [];
        const { served } = serve(async (_url, init) => { bodies.push(init.body as string); return jsonResponse({ ok: true, result: {} }); });
        // Leaves room for `,"requestId":"<36>"` (~62 bytes): forwarded and within the cap.
        const fits = JSON.parse(await exchange(served.socketPath, padded(MAX_REQUEST_BYTES - 100) + '\n'));
        expect(fits.ok).toBe(true);
        expect(Buffer.byteLength(bodies[0]!)).toBeLessThanOrEqual(MAX_REQUEST_BYTES);
        // A line that is itself within the limit but whose body would not be.
        const tooBig = JSON.parse(await exchange(served.socketPath, padded(MAX_REQUEST_BYTES - 10) + '\n'));
        expect(tooBig.error.code).toBe('request_too_large');
        expect(bodies).toHaveLength(1);
    });

    test('an upstream reply over 65,536 bytes is refused', async () => {
        const { served } = serve(async () => jsonResponse({ ok: true, result: { events: 'x'.repeat(MAX_UPSTREAM_BYTES) } }));
        expect((await ask(served.socketPath, { v: 1, op: 'chat.read', args: { sessionId: 's' } })).error.code).toBe('bridge_bad_reply');
    });
});

describe('error mapping', () => {
    const upstream = async (respond: () => Promise<Response>, request: Record<string, unknown> = { v: 1, op: 'chat.send', args: { sessionId: 's', text: 't' } }) => {
        const { served } = serve(respond);
        return ask(served.socketPath, request);
    };

    test('OS errors keep their code and message: string, object, and with or without ok:false', async () => {
        expect(await upstream(async () => jsonResponse({ ok: false, error: 'session_not_found' }, 404))).toEqual({ v: 1, ok: false, error: { code: 'session_not_found', message: 'session_not_found' } });
        expect(await upstream(async () => jsonResponse({ ok: false, error: { code: 'editor_disconnected', message: 'No editor is open' } }, 409)))
            .toEqual({ v: 1, ok: false, error: { code: 'editor_disconnected', message: 'No editor is open' } });
        expect((await upstream(async () => jsonResponse({ error: { code: 'cli_invalid_request' } }, 400))).error).toEqual({ code: 'cli_invalid_request', message: 'cli_invalid_request' });
        // Not a code shape: replaced by a fixed one rather than echoed as a code.
        expect((await upstream(async () => jsonResponse({ ok: false, error: { code: 'Not A Code!', message: 'm' } }, 409))).error.code).toBe('bridge_bad_reply');
        expect((await upstream(async () => jsonResponse({ ok: false, error: 'ABC def' }, 500))).error.code).toBe('bridge_error');
    });

    test('HTTP failures without an error body map to a fixed code', async () => {
        const status = async (code: number, body: BodyInit = 'nope') => (await upstream(async () => new Response(body, { status: code }))).error.code;
        expect(await status(401)).toBe('cli_unauthorized');
        expect(await status(403)).toBe('cli_unauthorized');
        expect(await status(404)).toBe('cli_unavailable');
        expect(await status(502)).toBe('bridge_bad_reply');
        expect(await status(500, '{"x":1}')).toBe('bridge_bad_reply');
        expect(await status(200, 'not json')).toBe('bridge_bad_reply');
        expect(await status(200, '{"hello":1}')).toBe('bridge_bad_reply');
    });

    test('an unreachable code host, a refused redirect and a timeout are bridge errors', async () => {
        expect((await upstream(async () => { throw new TypeError('fetch failed'); })).error.code).toBe('bridge_unreachable');
        expect((await upstream(async () => { throw new TypeError('redirect mode is set to error'); })).error.code).toBe('bridge_unreachable');
        const { served } = serve((_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason))), { timeoutMs: 40 });
        expect((await ask(served.socketPath, { v: 1, op: 'chat.list', args: {} })).error.code).toBe('bridge_timeout');
    });

    test('the log carries the op and a code only', async () => {
        const { served, logs } = serve(async () => jsonResponse({ ok: true, result: { text: 'secret chat text' } }));
        await ask(served.socketPath, { v: 1, op: 'chat.send', args: { sessionId: 's', text: 'private words' } });
        expect(logs).toEqual(['[code-cli] chat.send: ok']);
    });
});

describe('the bridge token never leaves', () => {
    test('not in a reply, a log line or an error, even when the code host or the stack repeats it', async () => {
        const logs: string[] = [];
        const dir = freshDir();
        const behaviours = [
            async () => jsonResponse({ ok: false, error: { code: 'cli_unauthorized', message: `bad bearer ${TOKEN}` } }, 401),
            async () => jsonResponse({ ok: false, error: `x${TOKEN}` }, 400),
            async () => { throw new Error(`connect failed with Bearer ${TOKEN}`); },
            async () => jsonResponse({ ok: true, result: { echoed: TOKEN } }),
            async () => new Response(`Bearer ${TOKEN}`, { status: 500 }),
        ];
        let call = 0;
        const served = startCliServer({ socketDir: dir, cliUrl: CLI_URL, token: TOKEN, fetch: () => behaviours[call++ % behaviours.length]!(), log: (line) => logs.push(line) });
        cleanups.push(() => served.dispose());
        const replies: string[] = [];
        for (let i = 0; i < behaviours.length; i++) replies.push(await exchange(served.socketPath, JSON.stringify({ v: 1, op: 'chat.list', args: {} }) + '\n'));
        replies.push(await exchange(served.socketPath, `garbage ${TOKEN}\n`));
        for (const text of [...replies, ...logs]) expect(text).not.toContain(TOKEN);
        expect(replies.every((text) => JSON.parse(text).v === 1)).toBe(true);
        expect(JSON.parse(replies[3]!).result.echoed).toBe('[redacted]');
    });
});

describe('only root can use the socket', () => {
    const root0 = process.getuid?.() === 0;
    const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n');
    const nobody = Number(passwd.find((entry) => entry.startsWith('nobody:'))?.split(':')[2] ?? 65534);
    const user = passwd.some((entry) => entry.split(':')[2] === '7001') ? 7001 : nobody;

    // Bun's child_process ignores `uid`, so drop privileges with setpriv (util-linux); the child reports the uid it
    // really ran as, and the test fails unless that is the target, so a no-op drop can never read as a pass.
    const connectAs = (target: number, socketPath: string) => new Promise<string>((resolve, reject) => {
        const script = `const s=require('net').connect(process.argv[1]);const u=process.getuid();s.on('connect',()=>{console.log(u+' CONNECTED');s.destroy()});s.on('error',e=>{console.log(u+' '+e.code)})`;
        const child = spawn('/usr/bin/setpriv', [`--reuid=${target}`, `--regid=${target}`, '--clear-groups', NODE, '-e', script, socketPath], { env: { PATH: '/usr/bin:/bin' }, stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        child.stdout.on('data', (chunk) => { out += chunk; });
        child.on('error', reject);
        child.on('close', () => resolve(out.trim()));
    });

    const reason = 'host is not root: a different uid cannot be spawned, so EACCES for a non-root uid is not exercised here';
    (root0 ? test : test.skip)(`${root0 ? 'uid ' + user + ' gets EACCES' : reason}; the same uid connects when the modes are loosened (control)`, async () => {
        const dir = freshDir();
        const served = startCliServer({ socketDir: dir, cliUrl: CLI_URL, token: TOKEN, fetch: async () => jsonResponse({ ok: true, result: {} }), log: () => {} });
        cleanups.push(() => served.dispose());
        await new Promise((resolve) => served.server.once('listening', resolve));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(served.socketPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(dir).uid).toBe(0);
        expect(fs.statSync(served.socketPath).uid).toBe(0);
        expect(await connectAs(user, served.socketPath)).toBe(`${user} EACCES`);
        // Control: with the directory and socket opened up the same child connects, so the refusal above is the modes.
        fs.chmodSync(dir, 0o755);
        fs.chmodSync(served.socketPath, 0o666);
        expect(await connectAs(user, served.socketPath)).toBe(`${user} CONNECTED`);
        fs.chmodSync(dir, 0o700);
        fs.chmodSync(served.socketPath, 0o600);
        expect(await connectAs(user, served.socketPath)).toBe(`${user} EACCES`);
    });
});
