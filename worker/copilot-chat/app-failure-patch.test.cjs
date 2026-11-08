// COPILOT_TEST_ROOT must be the read-only, pristine code-server 4.141.0 lib/vscode tree.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json',
    'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb,
    'out/vs/code/browser/workbench/workbench.css', 'out/server-main.js'];
const anchor = 'qe.registerCommand("noop",()=>{});var YLi=';
const count = (s, needle) => s.split(needle).length - 1;
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

test('app-failure: pinned anchor, apply, verify, idempotence and registered renderer handler',
    { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-app-failure-patch-'));
    try {
        for (const file of files) {
            const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(source, file), dest);
        }
        assert.equal(count(fs.readFileSync(path.join(root, wb), 'utf8'), anchor), 1);
        for (const args of [[root], ['--verify', root]]) {
            const result = run(...args); assert.equal(result.status, 0, result.stdout + result.stderr);
            assert.match(result.stdout, /gate ok \[app-failure\] workbench.js x0/);
            assert.match(result.stdout, /gate ok \[app-failure\] workbench.js x1/);
        }
        const before = files.map(file => fs.readFileSync(path.join(root, file)));
        const again = run(root); assert.equal(again.status, 0, again.stdout + again.stderr);
        files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[i], file));
        const code = fs.readFileSync(path.join(root, wb), 'utf8');
        assert.equal(count(code, anchor), 0);
        assert.equal(count(code, 'qe.registerCommand("_ezil.appFailure",'), 1);
        const start = code.indexOf('qe.registerCommand("_ezil.appFailure",');
        const registration = code.slice(start, code.indexOf(';var YLi=', start) + 1);
        const handlers = new Map(), events = [];
        const window = { dispatchEvent: event => events.push(event) };
        runInNewContext(registration, {
            qe: { registerCommand: (id, handler) => handlers.set(id, handler) }, window,
            CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        });
        await t.test('one command dispatches one event with JSON detail and no return value', () => {
            assert.equal(handlers.size, 1);
            const record = { eventId: 'a0000000-0000-4000-8000-000000000001', source: 'ezil_chat', operation: 'chat_request',
                category: 'network', code: 'network_failed', stage: 'request', outcome: 'failed' };
            assert.equal(handlers.get('_ezil.appFailure')({}, record), undefined);
            assert.equal(events.length, 1);
            assert.equal(events[0].type, 'ezil-app-failure');
            assert.deepEqual(JSON.parse(events[0].detail), record);
        });
        await t.test('serialization and dispatch exceptions are swallowed', () => {
            const circular = {}; circular.self = circular;
            assert.doesNotThrow(() => handlers.get('_ezil.appFailure')({}, circular));
            assert.equal(events.length, 1);
            window.dispatchEvent = () => { throw new Error('unavailable'); };
            assert.doesNotThrow(() => handlers.get('_ezil.appFailure')({}, {}));
        });
        await t.test('verify rejects a missing registration', () => {
            fs.writeFileSync(path.join(root, wb), code.replace(registration, ''));
            const result = run('--verify', root);
            assert.notEqual(result.status, 0); assert.match(result.stderr, /GATE FAILED \[app-failure\]/);
        });
        await t.test('apply rejects an upstream anchor change', () => {
            for (const file of files) fs.copyFileSync(path.join(source, file), path.join(root, file));
            const file = path.join(root, wb);
            fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(anchor, anchor.replace('YLi', 'upstreamMoved')));
            const result = run(root);
            assert.notEqual(result.status, 0); assert.match(result.stderr, /\[app-failure\] anchor occurs 0 times/);
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
