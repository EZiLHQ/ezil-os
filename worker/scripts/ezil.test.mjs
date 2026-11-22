// Runs worker/scripts/ezil as a real child process against an in-process fake socket server.
// node --test worker/scripts/ezil.test.mjs   (also runnable with: bun test worker/scripts/ezil.test.mjs)

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('./ezil', import.meta.url));
// The script targets node whichever runner is used (bun's child sockets differ); PATH lookup under bun.
const NODE = process.versions.bun ? 'node' : process.execPath;
const root = fs.mkdtempSync(path.join('/tmp', 'ezil-t-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
let counter = 0;
const freshPath = (name) => path.join(root, `${name}${counter++}`);

/** A fake bridge: records each request and answers with `respond(request)` (an object, a raw string, or null to hang up). */
async function fakeBridge(respond) {
    const requests = [];
    const socketPath = freshPath('s');
    const server = net.createServer((socket) => {
        let data = '';
        socket.setEncoding('utf8');
        socket.on('data', (chunk) => {
            data += chunk;
            const newline = data.indexOf('\n');
            if (newline === -1) return;
            const request = JSON.parse(data.slice(0, newline));
            requests.push(request);
            const answer = respond(request, requests.length);
            if (answer === null) socket.destroy();
            else socket.end(typeof answer === 'string' ? answer : `${JSON.stringify(answer)}\n`);
        });
        socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    return { requests, socketPath, close: () => new Promise((resolve) => server.close(resolve)) };
}

const ok = (result) => ({ v: 1, ok: true, result });
const err = (code, message = code) => ({ v: 1, ok: false, error: { code, message } });

function run(args, { env = {}, stdin } = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(NODE, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(stdin ?? '');
    });
}

async function withBridge(respond, body) {
    const bridge = await fakeBridge(respond);
    try {
        return await body(bridge, (args, options = {}) => run(args, { ...options, env: { EZIL_CLI_SOCKET: bridge.socketPath, ...options.env } }));
    } finally {
        await bridge.close();
    }
}

const ACK = { sessionId: 'sess-1', operationId: 'op-1', status: 'queued' };

test('--help prints usage and exits 0, anywhere on the line', async () => {
    for (const args of [['--help'], ['-h'], ['chat', '--help'], ['chat', 'send', '--help'], ['tool', 'validate', '-h']]) {
        const { code, stdout, stderr } = await run(args);
        assert.equal(code, 0, args.join(' '));
        assert.match(stdout, /Usage: ezil/);
        assert.match(stdout, /chat new/);
        assert.equal(stderr, '');
    }
});

test('chat new --json: a non-empty sessionId string, exactly {sessionId, operationId, status}', async () => {
    await withBridge(() => ok({ ...ACK, extra: 'dropped' }), async (bridge, ezil) => {
        const { code, stdout, stderr } = await ezil(['chat', 'new', '--json']);
        assert.equal(code, 0);
        assert.equal(stderr, '');
        assert.ok(stdout.endsWith('\n') && stdout.trim().split('\n').length === 1);
        const out = JSON.parse(stdout);
        assert.deepEqual(out, ACK);
        assert.equal(typeof out.sessionId, 'string');
        assert.ok(out.sessionId.length > 0);
        assert.deepEqual(bridge.requests, [{ v: 1, op: 'chat.new', args: {} }]);
        // The real jq, when this host has it: -e exits 0 only for a non-null, non-false value.
        const jq = spawnSync('jq', ['-e', '.sessionId'], { input: stdout });
        if (jq.error?.code !== 'ENOENT') assert.equal(jq.status, 0);
    });
});

test('chat new passes --model and --effort, in either flag form', async () => {
    await withBridge(() => ok(ACK), async (bridge, ezil) => {
        await ezil(['chat', 'new', '--model', 'kimi-k2', '--effort=high']);
        await ezil(['--json', 'chat', 'new', '--effort', 'low']);
        assert.deepEqual(bridge.requests.map((r) => r.args), [{ model: 'kimi-k2', effort: 'high' }, { effort: 'low' }]);
    });
});

test('chat new --message chains chat.new then chat.send and prints the send acknowledgement', async () => {
    await withBridge((request) => request.op === 'chat.new' ? ok({ sessionId: 'sess-9', operationId: 'op-new', status: 'created' }) : ok({ sessionId: 'sess-9', operationId: 'op-send', status: 'queued' }), async (bridge, ezil) => {
        const { code, stdout } = await ezil(['chat', 'new', '--model', 'm', '--message', 'build it', '--json']);
        assert.equal(code, 0);
        assert.deepEqual(JSON.parse(stdout), { sessionId: 'sess-9', operationId: 'op-send', status: 'queued' });
        assert.deepEqual(bridge.requests, [
            { v: 1, op: 'chat.new', args: { model: 'm' } },
            { v: 1, op: 'chat.send', args: { sessionId: 'sess-9', text: 'build it' } },
        ]);
    });
});

test('chat new --message - reads the message from stdin', async () => {
    await withBridge(() => ok(ACK), async (bridge, ezil) => {
        const { code } = await ezil(['chat', 'new', '--message', '-'], { stdin: 'from stdin\n' });
        assert.equal(code, 0);
        assert.equal(bridge.requests[1].args.text, 'from stdin');
    });
});

test('a failed send after chat new names the created session and exits with the send error', async () => {
    await withBridge((request) => request.op === 'chat.new' ? ok(ACK) : err('editor_disconnected', 'No editor is open'), async (bridge, ezil) => {
        const { code, stdout, stderr } = await ezil(['chat', 'new', '--message', 'hi']);
        assert.equal(code, 69);
        assert.equal(stdout, '');
        assert.match(stderr, /No editor is open/);
        assert.match(stderr, /sess-1 was created/);
        assert.equal(bridge.requests.length, 2);
    });
});

test('chat list --json prints {sessions}; the human form lists one session per line', async () => {
    const sessions = [{ sessionId: 'a', status: 'idle', title: 'First' }, { sessionId: 'b', status: 'running', title: 'Second' }];
    await withBridge(() => ok({ sessions, ignored: true }), async (bridge, ezil) => {
        const json = await ezil(['chat', 'list', '--json']);
        assert.equal(json.code, 0);
        assert.deepEqual(JSON.parse(json.stdout), { sessions });
        const human = await ezil(['chat', 'list']);
        assert.equal(human.code, 0);
        assert.deepEqual(human.stdout.trim().split('\n'), ['a\tidle\tFirst', 'b\trunning\tSecond']);
        assert.deepEqual(bridge.requests[0], { v: 1, op: 'chat.list', args: {} });
    });
    await withBridge(() => ok({ sessions: [] }), async (_bridge, ezil) => {
        assert.equal((await ezil(['chat', 'list'])).stdout, 'no sessions\n');
    });
});

test('chat send takes the text from the line or from stdin with "-"', async () => {
    await withBridge(() => ok(ACK), async (bridge, ezil) => {
        const line = await ezil(['chat', 'send', 'sess-1', 'hello there', '--json']);
        assert.equal(line.code, 0);
        assert.deepEqual(JSON.parse(line.stdout), ACK);
        const piped = await ezil(['chat', 'send', 'sess-1', '-', '--json'], { stdin: 'line one\nline two\n' });
        assert.equal(piped.code, 0);
        assert.deepEqual(bridge.requests.map((r) => r.args), [{ sessionId: 'sess-1', text: 'hello there' }, { sessionId: 'sess-1', text: 'line one\nline two' }]);
        assert.deepEqual(bridge.requests.map((r) => r.op), ['chat.send', 'chat.send']);
    });
});

test('chat send accepts exactly 16,384 characters and refuses more before connecting', async () => {
    await withBridge(() => ok(ACK), async (bridge, ezil) => {
        assert.equal((await ezil(['chat', 'send', 's', 'x'.repeat(16_384)])).code, 0);
        const { code, stderr } = await ezil(['chat', 'send', 's', 'x'.repeat(16_385)]);
        assert.equal(code, 2);
        assert.match(stderr, /16,?384/);
        assert.equal(bridge.requests.length, 1);
    });
});

test('chat read passes the cursor and prints exactly {sessionId, events, cursor}', async () => {
    const events = [{ type: 'message', text: 'hi' }, { type: 'done' }];
    await withBridge(() => ok({ sessionId: 'sess-1', events, cursor: 'c2', more: 'dropped' }), async (bridge, ezil) => {
        const first = await ezil(['chat', 'read', 'sess-1', '--json']);
        const second = await ezil(['chat', 'read', 'sess-1', '--cursor', 'c1', '--json']);
        assert.equal(first.code, 0);
        assert.deepEqual(JSON.parse(first.stdout), { sessionId: 'sess-1', events, cursor: 'c2' });
        assert.equal(second.code, 0);
        assert.deepEqual(bridge.requests.map((r) => r.args), [{ sessionId: 'sess-1' }, { sessionId: 'sess-1', cursor: 'c1' }]);
        const human = await ezil(['chat', 'read', 'sess-1']);
        assert.deepEqual(human.stdout.trim().split('\n'), [JSON.stringify(events[0]), JSON.stringify(events[1]), 'cursor: c2']);
    });
});

test('human output of new and send is labelled lines', async () => {
    await withBridge(() => ok(ACK), async (_bridge, ezil) => {
        assert.equal((await ezil(['chat', 'new'])).stdout, 'sessionId: sess-1\noperationId: op-1\nstatus: queued\n');
    });
});

test('exit 69 when there is no socket, whichever command', async () => {
    const env = { EZIL_CLI_SOCKET: freshPath('missing') };
    for (const args of [['chat', 'new'], ['chat', 'list'], ['chat', 'send', 's', 't'], ['chat', 'read', 's'], ['chat', 'list', '--json']]) {
        const { code, stdout, stderr } = await run(args, { env });
        assert.equal(code, 69, args.join(' '));
        assert.equal(stdout, '');
        assert.match(stderr, /not running|no socket/);
    }
    const json = await run(['chat', 'list', '--json'], { env });
    assert.deepEqual(JSON.parse(json.stderr), { error: { code: 'cli_unavailable', message: 'the ezil bridge is not running (no socket)' } });
});

test('exit 69 when the socket path is a stale file nobody listens on', async () => {
    const stale = freshPath('stale');
    fs.writeFileSync(stale, '');
    assert.equal((await run(['chat', 'list'], { env: { EZIL_CLI_SOCKET: stale } })).code, 69);
});

test('exit codes follow the error code: 2 usage, 69 unavailable, 77 refused', async () => {
    const cases = [
        ['cli_invalid_request', 2], ['request_too_large', 2],
        ['cli_unavailable', 69], ['editor_disconnected', 69], ['bridge_unreachable', 69], ['bridge_timeout', 69], ['bridge_bad_reply', 69], ['bridge_error', 69],
        ['cli_unauthorized', 77], ['session_not_found', 77], ['editor_controls_unsupported', 77], ['something_new', 77],
    ];
    for (const [code, exit] of cases) {
        await withBridge(() => err(code, `message for ${code}`), async (_bridge, ezil) => {
            const run1 = await ezil(['chat', 'read', 'sess-1']);
            assert.equal(run1.code, exit, code);
            assert.equal(run1.stdout, '');
            assert.match(run1.stderr, new RegExp(`message for ${code}`));
            const json = await ezil(['chat', 'read', 'sess-1', '--json']);
            assert.deepEqual(JSON.parse(json.stderr), { error: { code, message: `message for ${code}` } });
        });
    }
});

test('exit 75 when the operation is queued for a disconnected editor (the object is still printed)', async () => {
    await withBridge(() => ok({ ...ACK, status: 'queued_disconnected' }), async (_bridge, ezil) => {
        for (const args of [['chat', 'new', '--json'], ['chat', 'send', 'sess-1', 'x', '--json']]) {
            const { code, stdout } = await ezil(args);
            assert.equal(code, 75, args.join(' '));
            assert.equal(JSON.parse(stdout).status, 'queued_disconnected');
        }
    });
});

test('an accepted operation exits 0 whatever stage it is at; a turned-away one exits 77 with the object printed', async () => {
    for (const status of ['queued', 'accepted', 'running', 'completed', 'finished_unverified', 'cancel_requested', 'uncertain']) {
        await withBridge(() => ok({ ...ACK, status }), async (_bridge, ezil) => {
            assert.equal((await ezil(['chat', 'send', 'sess-1', 'x', '--json'])).code, 0, status);
        });
    }
    for (const status of ['rejected', 'refused_allowance', 'expired', 'failed', 'cancelled']) {
        await withBridge(() => ok({ ...ACK, status }), async (_bridge, ezil) => {
            const { code, stdout } = await ezil(['chat', 'send', 'sess-1', 'x', '--json']);
            assert.equal(code, 77, status);
            assert.equal(JSON.parse(stdout).status, status);
        });
    }
});

test('exit 2 for usage mistakes, with nothing sent', async () => {
    await withBridge(() => ok(ACK), async (bridge, ezil) => {
        const bad = [
            [], ['frobnicate'], ['chat'], ['chat', 'frobnicate'], ['tool'], ['tool', 'frobnicate'],
            ['chat', 'send'], ['chat', 'send', 's'], ['chat', 'send', 's', 'a', 'b'], ['chat', 'send', 's', '   '],
            ['chat', 'read'], ['chat', 'read', 'a', 'b'], ['chat', 'list', 'extra'], ['chat', 'new', 'extra'],
            ['chat', 'new', '--bogus'], ['chat', 'new', '--model'], ['chat', 'new', '--json=1'], ['chat', 'new', '--cursor', 'c'],
            ['chat', 'read', 's', '--model', 'm'], ['chat', 'new', '--message', ''], ['chat', 'new', '--message', '  '],
            ['tool', 'validate', 'a', 'b'], ['tool', 'validate', 'Bad-Name'],
        ];
        for (const args of bad) {
            const { code, stdout, stderr } = await ezil(args);
            assert.equal(code, 2, JSON.stringify(args));
            assert.equal(stdout, '');
            assert.match(stderr, /^ezil: /);
        }
        assert.deepEqual(bridge.requests, []);
    });
});

test('empty stdin for "-" is a usage error', async () => {
    await withBridge(() => ok(ACK), async (bridge, ezil) => {
        assert.equal((await ezil(['chat', 'send', 's', '-'], { stdin: '\n' })).code, 2);
        assert.deepEqual(bridge.requests, []);
    });
});

test('a bridge that hangs up, answers with junk, or answers without a result is unavailable (69)', async () => {
    for (const answer of [null, '', 'not json\n', '[]\n', '{"v":2,"ok":true,"result":{}}\n', '{"v":1,"ok":true}\n', '{"v":1,"ok":true,"result":{"sessions":"x"}}\n']) {
        await withBridge(() => answer, async (_bridge, ezil) => {
            assert.equal((await ezil(['chat', 'list'])).code, 69, JSON.stringify(answer));
        });
    }
    await withBridge(() => ok({ nothing: true }), async (_bridge, ezil) => {
        for (const args of [['chat', 'new'], ['chat', 'read', 's'], ['chat', 'list']]) assert.equal((await ezil(args)).code, 69, args.join(' '));
    });
});

test('a request is exactly one newline-terminated {v:1, op, args} line and no requestId', async () => {
    const raw = [];
    const socketPath = freshPath('raw');
    const server = net.createServer((socket) => {
        let data = '';
        socket.on('data', (chunk) => { data += chunk; if (data.includes('\n')) { raw.push(data); socket.end(`${JSON.stringify(ok(ACK))}\n`); } });
        socket.on('error', () => {});
    });
    await new Promise((resolve) => server.listen(socketPath, resolve));
    try {
        await run(['chat', 'send', 's', 'héllo'], { env: { EZIL_CLI_SOCKET: socketPath } });
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(raw.length, 1);
    assert.equal(raw[0], '{"v":1,"op":"chat.send","args":{"sessionId":"s","text":"héllo"}}\n');
});

// ezil tool validate: the validator module is a fake here; the real one is worker/toolsd/manifest.mjs.
function fakeManifest(catalog) {
    const file = freshPath('manifest') + '.mjs';
    fs.writeFileSync(file, `export const validateManifest = () => ({ ok: true });
export const scanCatalog = async (root) => ({ ...${JSON.stringify(catalog)}, root, catalogDigest: 'sha256:x' });
`);
    return file;
}
const HELLO = { name: 'hello', description: 'Say hello', inputSchema: { type: 'object' }, run: { argv: ['echo', 'hello'] }, timeoutSeconds: 10 };

test('tool validate --json prints exactly {tools, invalid} and exits 0 when all are valid', async () => {
    const manifest = fakeManifest({ tools: [HELLO], invalid: [] });
    const { code, stdout } = await run(['tool', 'validate', '--json'], { env: { EZIL_TOOLSD_MANIFEST: manifest, EZIL_WORKSPACE_ROOT: '/ws' } });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(stdout), { tools: [HELLO], invalid: [] });
    const human = await run(['tool', 'validate'], { env: { EZIL_TOOLSD_MANIFEST: manifest } });
    assert.equal(human.stdout, 'ok       hello - Say hello\n');
});

test('tool validate scans EZIL_WORKSPACE_ROOT (default /home/neko/project)', async () => {
    const file = freshPath('root') + '.mjs';
    fs.writeFileSync(file, 'export const validateManifest = () => ({ ok: true });\nexport const scanCatalog = async (root) => ({ tools: [], invalid: [{ dir: root, error: "root" }] });\n');
    assert.match((await run(['tool', 'validate', '--json'], { env: { EZIL_TOOLSD_MANIFEST: file } })).stdout, /"\/home\/neko\/project"/);
    assert.match((await run(['tool', 'validate', '--json'], { env: { EZIL_TOOLSD_MANIFEST: file, EZIL_WORKSPACE_ROOT: '/elsewhere' } })).stdout, /"\/elsewhere"/);
});

test('tool validate exits 77 when a tool is invalid; a name selects that tool or that directory', async () => {
    const manifest = fakeManifest({ tools: [HELLO], invalid: [{ dir: 'broken', error: 'manifest_schema' }] });
    const env = { EZIL_TOOLSD_MANIFEST: manifest };
    const all = await run(['tool', 'validate', '--json'], { env });
    assert.equal(all.code, 77);
    assert.deepEqual(JSON.parse(all.stdout), { tools: [HELLO], invalid: [{ dir: 'broken', error: 'manifest_schema' }] });
    const good = await run(['tool', 'validate', 'hello', '--json'], { env });
    assert.equal(good.code, 0);
    assert.deepEqual(JSON.parse(good.stdout), { tools: [HELLO], invalid: [] });
    const broken = await run(['tool', 'validate', 'broken'], { env });
    assert.equal(broken.code, 77);
    assert.equal(broken.stdout, 'invalid  broken: manifest_schema\n');
    const missing = await run(['tool', 'validate', 'nothing_here'], { env });
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /no tool directory named "nothing_here"/);
});

test('tool validate with no tools says so; a missing or unusable validator is 69', async () => {
    const empty = await run(['tool', 'validate'], { env: { EZIL_TOOLSD_MANIFEST: fakeManifest({ tools: [], invalid: [] }) } });
    assert.equal(empty.code, 0);
    assert.equal(empty.stdout, 'no tools\n');
    const missing = await run(['tool', 'validate'], { env: { EZIL_TOOLSD_MANIFEST: freshPath('nope') + '.mjs' } });
    assert.equal(missing.code, 69);
    assert.match(missing.stderr, /validator is not available/);
    const wrong = freshPath('wrong') + '.mjs';
    fs.writeFileSync(wrong, 'export const other = 1;\n');
    const unusable = await run(['tool', 'validate', '--json'], { env: { EZIL_TOOLSD_MANIFEST: wrong } });
    assert.equal(unusable.code, 69);
    assert.equal(JSON.parse(unusable.stderr).error.code, 'validator_unavailable');
    // A validator whose result is not {tools, invalid} must not read as "no tools, all fine".
    for (const catalog of [{}, { tools: [] }, { invalid: [] }, { tools: {}, invalid: [] }, { entries: [], problems: [] }]) {
        const odd = await run(['tool', 'validate', '--json'], { env: { EZIL_TOOLSD_MANIFEST: fakeManifest(catalog) } });
        assert.equal(odd.code, 69, JSON.stringify(catalog));
        assert.equal(JSON.parse(odd.stderr).error.code, 'validator_unavailable');
        assert.equal(odd.stdout, '');
    }
});

test('tool validate never needs the chat socket', async () => {
    const { code } = await run(['tool', 'validate'], { env: { EZIL_CLI_SOCKET: freshPath('absent'), EZIL_TOOLSD_MANIFEST: fakeManifest({ tools: [HELLO], invalid: [] }) } });
    assert.equal(code, 0);
});
