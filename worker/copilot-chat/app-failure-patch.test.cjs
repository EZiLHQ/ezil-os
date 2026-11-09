// COPILOT_TEST_ROOT is read-only. Every mutation below is on a disposable copy.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runInNewContext } = require('node:vm');
const { randomUUID } = require('node:crypto');
const fixtures = require('../../app/src/server/feedback/app-failures.fixtures.json');
const source = process.env.COPILOT_TEST_ROOT;
const script = path.join(__dirname, 'patch-copilot-chat.sh');
const wb = 'out/vs/code/browser/workbench/workbench.js';
const files = ['extensions/copilot/dist/extension.js', 'extensions/copilot/package.json', 'extensions/copilot/package.nls.json',
    'extensions/copilot/LICENSE.txt', 'product.json', 'out/nls.messages.js', 'out/nls.messages.json', wb,
    'out/vs/code/browser/workbench/workbench.css', 'out/server-main.js'];
const anchor = 'qe.registerCommand("noop",()=>{});var YLi=';
const timeoutAnchor = 'if(M==="timedout"){let N;this.chatEntitlementService.anonymous?N=d(10558,null,RF.chatExtensionId):N=d(10557,null,RF.provider.default.name,RF.chatExtensionId);';
const count = (s, needle) => s.split(needle).length - 1;
const run = (...args) => spawnSync('bash', [script, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });

test('renderer and bridge embed exactly the same validator', () => {
    const bridge = fs.readFileSync(path.join(__dirname, '../src/code-diag-bridge.ts'), 'utf8');
    const validator = bridge.split('// APP_FAILURE_VALIDATOR_BEGIN\n')[1].split('\n// APP_FAILURE_VALIDATOR_END')[0];
    const patch = fs.readFileSync(script, 'utf8');
    assert.equal(patch.match(/^APP_FAILURE_VALIDATOR='([^']+)'$/m)[1], validator);
});

test('app-failure: pinned anchors, apply, verify, idempotence and actual renderer/startup functions',
    { skip: !source && 'set COPILOT_TEST_ROOT to local pristine bundle' }, async t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-app-failure-patch-'));
    const restore = () => {
        for (const file of files) {
            const dest = path.join(root, file); fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.copyFileSync(path.join(source, file), dest);
        }
    };
    try {
        restore();
        const pristine = fs.readFileSync(path.join(root, wb), 'utf8');
        assert.equal(count(pristine, anchor), 1);
        assert.equal(count(pristine, timeoutAnchor), 1);
        assert.equal(count(pristine, 'async doForwardRequestToChatWhenReady('), 1);
        for (const args of [[root], ['--verify', root]]) {
            const result = run(...args); assert.equal(result.status, 0, result.stdout + result.stderr);
            for (const id of ['app-failure', 'app-start-timeout']) {
                assert.ok(result.stdout.includes(`gate ok [${id}] workbench.js x0`));
                assert.ok(result.stdout.includes(`gate ok [${id}] workbench.js x1`));
            }
        }
        const before = files.map(file => fs.readFileSync(path.join(root, file)));
        const again = run(root); assert.equal(again.status, 0, again.stdout + again.stderr);
        files.forEach((file, i) => assert.deepEqual(fs.readFileSync(path.join(root, file)), before[i], file));
        const code = fs.readFileSync(path.join(root, wb), 'utf8');
        assert.equal(count(code, anchor), 0);
        assert.equal(count(code, timeoutAnchor), 0);
        assert.equal(count(code, 'qe.registerCommand("_ezil.appFailure",'), 1);
        const start = code.indexOf('function ezilDispatchAppFailure(');
        const registration = code.slice(start, code.indexOf(';var YLi=', start) + 1);
        const handlers = new Map(), events = [];
        const window = { dispatchEvent: event => events.push(event) };
        const sandbox = {
            qe: { registerCommand: (id, handler) => handlers.set(id, handler) }, window,
            CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
            crypto: { randomUUID },
        };
        runInNewContext(registration, sandbox);
        const dispatch = value => handlers.get('_ezil.appFailure')({}, value);
        await t.test('every valid fixture dispatches unchanged; every rejected fixture is dropped', () => {
            assert.equal(handlers.size, 1);
            for (const { failure } of fixtures.valid) {
                events.length = 0;
                assert.equal(dispatch(failure), undefined);
                assert.equal(events.length, 1);
                assert.equal(events[0].type, 'ezil-app-failure');
                assert.deepEqual(JSON.parse(events[0].detail), failure);
            }
            events.length = 0;
            for (const { failure } of fixtures.rejected) dispatch(failure);
            assert.equal(events.length, 0);
        });
        await t.test('projection never reads getters, Error details or arbitrary toJSON and drops malformed inputs', () => {
            events.length = 0;
            const record = fixtures.valid[0].failure;
            let touched = 0;
            const getter = () => { touched++; throw new Error('must not read'); };
            const error = new Error();
            Object.defineProperties(error, { message: { get: getter }, stack: { get: getter } });
            const circular = {}; circular.self = circular;
            const inherited = Object.create({ toJSON: getter }); Object.assign(inherited, record);
            const invalid = [error, circular, { ...record, extra: {} }, { ...record, get modelKey() { return getter(); } },
                { ...record, modelKey: 'x'.repeat(65) }, { ...record, toJSON: getter },
                { ...record, durationMs: Infinity }, { ...record, attempt: 1.5 }, { ...record, retryable: {} },
                { ...record, [Symbol('extra')]: true }];
            for (const value of invalid) assert.doesNotThrow(() => dispatch(value));
            assert.equal(events.length, 0); assert.equal(touched, 0);
            dispatch(inherited); // only own contract data is copied; inherited serialization is never invoked
            assert.equal(touched, 0); assert.deepEqual(JSON.parse(events.pop().detail), record);
            const original = window.dispatchEvent;
            window.dispatchEvent = () => { throw new Error('unavailable'); };
            assert.doesNotThrow(() => dispatch(record)); window.dispatchEvent = original;
        });
        await t.test('actual readiness function emits one startup timeout, fresh UUID each time, none on success/guidance', async () => {
            const at = code.indexOf('async doForwardRequestToChatWhenReady(');
            const method = code.slice(at, code.indexOf('async whenPanelAgentHasGuidance(', at));
            for (const mode of ['timedout', 'timedout', 'success', 'panelGuidance']) {
                events.length = 0;
                class P extends Promise { static race() { return P.resolve(mode); } }
                let resent = 0;
                const noop = () => {};
                Object.assign(sandbox, {
                    Promise: P, Kbi: async () => false, Vme: noop, GGi: noop, qGi: {},
                    setTimeout: () => 1, clearTimeout: noop, Y: fn => fn,
                    A: class { add() {} dispose() {} }, ji: () => new P(noop),
                    Se: class {}, d: () => '', RF: { chatExtensionId: 'fixture', provider: { default: { name: 'fixture' } } },
                    bI: {},
                });
                const subject = runInNewContext(`({${method}})`, sandbox);
                Object.assign(subject, {
                    whenAgentActivated: () => P.resolve(), whenAgentReady: () => P.resolve(),
                    whenLanguageModelReady: noop, whenToolsModelReady: noop,
                    whenPanelAgentHasGuidance: () => new P(noop), environmentService: {},
                    chatEntitlementService: { anonymous: true }, computeDiagnosticInfo: () => ({}),
                    logService: { warn: noop, info: noop }, telemetryService: { publicLog2: noop },
                    _onUnresolvableError: { fire: noop },
                });
                await subject.doForwardRequestToChatWhenReady({ session: { sessionResource: 'fixture' } }, noop,
                    { resendRequest: async () => { resent++; } }, {}, {}, { getWidgetBySessionResource: noop }, {});
                assert.equal(resent, mode === 'panelGuidance' ? 0 : 1);
                assert.equal(events.length, mode === 'timedout' ? 1 : 0);
                if (mode === 'timedout') {
                    const failure = JSON.parse(events[0].detail);
                    assert.match(failure.eventId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
                    assert.notEqual(failure.eventId, sandbox.lastId); sandbox.lastId = failure.eventId;
                    assert.deepEqual(failure, { eventId: failure.eventId, source: 'code_app', operation: 'app_start',
                        category: 'app_startup', code: 'app_start_timeout', stage: 'startup', outcome: 'failed' });
                }
            }
        });
        await t.test('verify rejects missing command or startup patch', () => {
            for (const modified of [code.replace(registration, ''), code.replace('code:"app_start_timeout"', 'code:"unexpected_error"')]) {
                fs.writeFileSync(path.join(root, wb), modified);
                const result = run('--verify', root);
                assert.notEqual(result.status, 0); assert.match(result.stderr, /GATE FAILED \[app-(failure|start-timeout)\]/);
            }
        });
        await t.test('apply rejects either upstream anchor drifting', () => {
            for (const needle of [anchor, timeoutAnchor]) {
                restore();
                fs.writeFileSync(path.join(root, wb), pristine.replace(needle, '/* anchor drift */'));
                const result = run(root);
                assert.notEqual(result.status, 0); assert.match(result.stderr, /\[app-(failure|start-timeout)\] anchor occurs 0 times/);
            }
        });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
