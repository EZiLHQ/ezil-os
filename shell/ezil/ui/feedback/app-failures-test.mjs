// Node + jsdom; actual consumer store/dialog, no network or bundle rebuild.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { JSDOM } from 'jsdom';

// Import before there is a window: no listeners, browser globals or persistence required.
const M = await import('./app-failures.js');
const server = await import('../../../../app/src/server/feedback/types.ts');
const fixtures = JSON.parse(readFileSync(new URL('../../../../app/src/server/feedback/app-failures.fixtures.json', import.meta.url)));
const serverSchema = server.appFailureRecordSchema;
assert.ok(serverSchema, 'server record schema export');
let checks = 0;
async function check (name, run) { await run(); checks++; console.log(`PASS ${name}`); }

await check(`golden fixtures: ${fixtures.valid.length} valid, ${fixtures.rejected.length} rejected (server parity)`, () => {
    for (const { name, failure } of fixtures.valid) {
        const clean = M.validate_failure(failure);
        assert.deepEqual(clean, failure, name);
        assert.notEqual(clean, failure, 'clean copy');
        const { app, ageMs, ...parsed } = serverSchema.parse({ ...failure, app: 'code', ageMs: 0 });
        assert.deepEqual(clean, parsed, name);
    }
    for (const { name, failure } of fixtures.rejected) {
        assert.equal(M.validate_failure(failure), null, name);
        assert.equal(serverSchema.safeParse({ ...failure, app: 'code', ageMs: 0 }).success, false, name);
    }
});

const base = fixtures.valid[0].failure;
const uuid = n => `a0000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const failure = n => ({ ...base, eventId: uuid(n) });
await check('closed enums, category codes, required keys, optional types, UUIDs and numeric/model bounds', () => {
    for (const key of ['eventId', 'source', 'operation', 'category', 'code', 'stage', 'outcome']) {
        const record = { ...base }; delete record[key];
        assert.equal(M.validate_failure(record), null, `missing ${key}`);
        assert.equal(M.validate_failure({ ...base, [key]: 'unknown' }), null, `unknown ${key}`);
    }
    for (const [key, low, high] of [['attempt', 1, 64], ['durationMs', 0, 3_600_000], ['httpStatus', 100, 599]]) {
        for (const value of [low, high]) assert.ok(M.validate_failure({ ...base, [key]: value }));
        for (const value of [low - 1, high + 1, low + 0.5, String(low), null, undefined, NaN, Infinity]) {
            assert.equal(M.validate_failure({ ...base, [key]: value }), null, `${key}: ${value}`);
        }
    }
    for (const key of ['eventId', 'clientRequestId', 'gatewayRequestId', 'vscodeRequestId', 'retryOfClientRequestId']) {
        assert.ok(M.validate_failure({ ...base, [key]: uuid(999) }));
        for (const value of [uuid(999).toUpperCase(), 'not-a-uuid', null, 42, undefined]) assert.equal(M.validate_failure({ ...base, [key]: value }), null);
    }
    for (const value of ['eof', 'malformed_event', 'missing_terminal']) assert.ok(M.validate_failure({ ...base, streamReason: value }));
    for (const value of ['other', null, undefined]) assert.equal(M.validate_failure({ ...base, streamReason: value }), null);
    for (const value of [true, false]) assert.ok(M.validate_failure({ ...base, retryable: value }));
    for (const value of [1, 'true', null, undefined]) assert.equal(M.validate_failure({ ...base, retryable: value }), null);
    assert.deepEqual([...M.MODEL_KEY_NAMESPACES], [...server.MODEL_KEY_NAMESPACES], 'namespace allowlist parity');
    assert.deepEqual([...M.MODEL_KEY_FAMILIES], [...server.MODEL_KEY_FAMILIES], 'family allowlist parity');
    for (const value of ['anthropic/claude-sonnet-4-5-20250929', 'anthropic.claude-sonnet-5-5-v1:0', 'openai/gpt-6', 'google/gemini-2.5-flash', 'gpt-6', 'claude-sonnet-5-5', 'gemini-3.8-flash', 'qwen.qwen3-coder-next', 'us.moonshotai.kimi-k3', 'ezil-code', 'ezil-fast']) {
        assert.ok(M.validate_failure({ ...base, modelKey: value }), value);
        assert.ok(server.isSafeModelKey(value), `server agrees: ${value}`);
    }
    for (const value of ['1', 'catalog:model_1.2/variant-3', 'us.sb_secret_ab-cd', 'claude-secret-1', 'ezil-session-1', 'claude.sk_live-1', 'us.project/file-1', 'project/file-1', 'sb_secret_abcd-efgh-ijkl-mnop', 'openai/sb_secret_abcd-efgh', 'anthropic/claude-api-key-1', 'anthropic/sk-proj-1', 'ezil/session-1', '', 'a', 'a'.repeat(64), 'a'.repeat(65), 'A', '/a', 'a b', 'https://host', 'a\n', null,
        'sk-proj-' + 'a'.repeat(32), 'ghp_' + 'z'.repeat(24), 'etc/passwd', 'etc/ssh-host-key', 'home/id-rsa-2', 'home/user/key', 'a/b/c-1', 'bearer-1']) {
        assert.equal(M.validate_failure({ ...base, modelKey: value }), null, String(value));
        assert.equal(server.isSafeModelKey(value), false, `server agrees: ${String(value)}`);
    }
    for (const key of ['computerId', 'app', 'appSession', 'receivedAt', 'ageMs', 'message', 'stack', '__proto__']) {
        assert.equal(M.validate_failure({ ...base, [key]: 'forged' }), null);
    }
    for (const record of [null, [], 'x', Object.create(base), { ...base, [Symbol('extra')]: true }]) assert.equal(M.validate_failure(record), null);
    // The server's own table: a drift on either side fails here.
    const codes = server.APP_FAILURE_CODES;
    for (const category of Object.keys(codes)) {
        const inCategory = category === 'cancellation' ? { ...base, category, outcome: 'cancelled', cancellationSource: 'caller' } : { ...base, category };
        assert.ok(M.validate_failure({ ...inCategory, code: 'unexpected_error' }));
        for (const [owner, values] of Object.entries(codes)) for (const code of values) {
            assert.equal(!!M.validate_failure({ ...inCategory, code }), category === owner, `${category}/${code}`);
        }
    }
});

const dom = new JSDOM('<!doctype html><body></body>', { url: 'https://feedback.test/os', pretendToBeVisual: true });
const { window } = dom;
for (const key of ['window', 'document', 'navigator', 'MutationObserver']) {
    Object.defineProperty(globalThis, key, { configurable: true, value: key === 'window' ? window : window[key] });
}
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://code.test';
const options = { origin: ORIGIN, computerId: A, appSession: 'session-a', app: 'code' };
const context = { computerId: A };
const listeners = new Set();
const add = window.addEventListener.bind(window), remove = window.removeEventListener.bind(window);
window.addEventListener = (type, listener, opts) => { if (type === 'message') listeners.add(listener); add(type, listener, opts); };
window.removeEventListener = (type, listener, opts) => { if (type === 'message') listeners.delete(listener); remove(type, listener, opts); };
function frame (store, opts = options) {
    const iframe = document.createElement('iframe'); iframe.src = ORIGIN; document.body.append(iframe);
    const sent = [];
    iframe.contentWindow.postMessage = (data, origin) => sent.push({ data, origin });
    const unregister = store.register_app_frame(iframe, opts);
    const nonce = () => sent.at(-1)?.data.nonce;
    const post = (data, overrides = {}) => window.dispatchEvent(new window.MessageEvent('message', {
        source: iframe.contentWindow, origin: ORIGIN, data, ...overrides,
    }));
    return { iframe, sent, unregister, nonce, post,
        send: (record = base, overrides) => post({ type: 'ezil.code.failure', v: 1, nonce: nonce(), failure: record }, overrides),
        ready: () => post({ type: 'ezil.code.diag.ready', v: 1, nonce: nonce() }),
        load: () => iframe.dispatchEvent(new window.Event('load')),
    };
}

try {
    await check('exact frame/source check rejects siblings and nested frames', () => {
        const store = M.create_app_failure_store(); const f = frame(store); const sibling = frame(store, { ...options, computerId: B });
        const doc = f.iframe.contentDocument;
        const nested = doc.createElement('iframe'); doc.appendChild(doc.createElement('html')).append(nested);
        for (const source of [sibling.iframe.contentWindow, nested.contentWindow, window, null]) f.send(base, { source });
        assert.deepEqual(store.app_failures_for(context), { available: false, failures: [] }, 'forged source stored nothing');
        store.clear_app_failures();
    });
    await check('pinned origin check rejects wrong and opaque origins', () => {
        const store = M.create_app_failure_store(); const f = frame(store);
        for (const origin of ['https://evil.test', 'http://code.test', 'null', '', 'https://code.test.evil.test']) f.send(base, { origin });
        assert.deepEqual(store.app_failures_for(context), { available: false, failures: [] }, 'forged origin stored nothing');
        store.clear_app_failures();
    });
    await check('one listener, exact-origin hello, load nonce rotation, envelope/size validation and unregister', () => {
        const store = M.create_app_failure_store(); const before = listeners.size; const f = frame(store);
        assert.equal(listeners.size, before + 1);
        assert.deepEqual(f.sent[0], { data: { type: 'ezil.code.diag.hello', v: 1, nonce: f.nonce() }, origin: ORIGIN });
        assert.match(f.nonce(), /^[A-Za-z0-9_-]{22}$/);
        const old = f.nonce(); f.load(); assert.notEqual(f.nonce(), old);
        const envelope = { type: 'ezil.code.failure', v: 1, nonce: f.nonce(), failure: base };
        for (const data of [
            { ...envelope, nonce: old }, { ...envelope, v: 2 }, { ...envelope, extra: true },
            { ...envelope, failure: { ...base, modelKey: 'x'.repeat(2048) } },
            { type: 'ezil.code.diag.ready', v: 1, nonce: f.nonce(), extra: true },
            { type: 'ezil.code.diag.ready', v: 1, nonce: old }, { ...envelope, failure: { ...base, computerId: B } },
        ]) f.post(data);
        assert.deepEqual(store.app_failures_for(context), { available: false, failures: [] });
        f.ready(); assert.equal(store.app_failures_for(context).available, true);
        f.send(); assert.equal(store.app_failures_for(context).failures.length, 1);
        f.unregister(); f.unregister(); assert.equal(listeners.size, before);
        f.send(failure(2)); assert.equal(store.app_failures_for(context).failures.length, 1);
        store.clear_app_failures();
    });
    await check('unknown registrations and stale navigation/frame windows cannot report', () => {
        const store = M.create_app_failure_store(); const before = listeners.size;
        for (const origin of ['null', '*', 'data:text/html,hello', 'file:///x', 'https://code.test/path', undefined]) {
            const f = frame(store, { ...options, origin }); f.send(); assert.equal(f.sent.length, 0);
        }
        assert.equal(listeners.size, before);
        const f = frame(store); const oldWindow = f.iframe.contentWindow;
        f.iframe.src = 'https://code.test/new-mint';
        f.send(); f.send(base, { source: oldWindow });
        assert.deepEqual(store.app_failures_for(context), { available: false, failures: [] });
        const gone = frame(store); gone.iframe.remove(); gone.post({ type: 'ezil.code.diag.ready', v: 1, nonce: gone.nonce() }, { source: oldWindow });
        assert.equal(store.app_failures_for(context).available, false);
        store.clear_app_failures();
    });
    await check('computer filter and session selection use registration only; copies omit all transport context', () => {
        let time = 1000; const store = M.create_app_failure_store({ now: () => time });
        const a = frame(store); const b = frame(store, { ...options, computerId: B });
        const a2 = frame(store, { ...options, appSession: 'session-a2' });
        a.send({ ...failure(1), computerId: B }); a.send(failure(2)); b.ready();
        assert.deepEqual(store.app_failures_for({ computerId: B }).failures, [], 'computer B must never see A failures');
        a2.send(failure(3)); time += 123;
        const selected = store.app_failures_for({ ...context, appSession: options.appSession });
        assert.deepEqual(selected.failures, [{ ...failure(2), app: 'code', ageMs: 123 }]);
        // Without appSession (the global entry) the scope is every session of the frozen computer.
        assert.deepEqual(store.app_failures_for(context).failures.map(f => f.eventId), [uuid(3), uuid(2)]);
        assert.equal(store.app_failures_for({ ...context, appSession: 'unknown' }).available, false);
        selected.failures[0].code = 'mutated';
        assert.equal(store.app_failures_for(context).failures.at(-1).code, base.code);
        store.clear_app_failures();
    });
    await check('ring retains exactly newest 50, ignores duplicate IDs, exports newest 10', () => {
        let time = 0; const store = M.create_app_failure_store({ now: () => time }); const f = frame(store);
        for (let n = 1; n <= 60; n++) { time = Math.floor((n - 1) / 20) * 60_000; f.send(failure(n)); }
        const expected = Array.from({ length: 10 }, (_, i) => uuid(60 - i));
        assert.deepEqual(store.app_failures_for(context).failures.map(f => f.eventId), expected);
        // Every one of 50 retained IDs must dedup, including the oldest (11).
        time += 60_000;
        for (let n = 11; n <= 60; n++) { time += 60_000 / 20; f.send(failure(n)); }
        assert.deepEqual(store.app_failures_for(context).failures.map(f => f.eventId), expected);
        assert.ok(store.app_failures_for(context).failures.every(f => f.ageMs === time - 120_000), 'duplicates must not refresh receipt time');
        time += 60_000; f.send(failure(10)); // evicted ID may enter again
        assert.equal(store.app_failures_for(context).failures[0].eventId, uuid(10));
        store.clear_app_failures();
    });
    await check('TTL is shell time, inclusive at 30 minutes; oldest expired entries disappear', () => {
        let time = 0; const store = M.create_app_failure_store({ now: () => time }); const f = frame(store);
        f.send(failure(1)); time = 100; f.send(failure(2)); time = 1_800_000;
        assert.equal(store.app_failures_for(context).failures.at(-1).ageMs, 1_800_000);
        time++; assert.deepEqual(store.app_failures_for(context).failures.map(f => f.eventId), [uuid(2)]);
        time += 100; assert.deepEqual(store.app_failures_for(context).failures, []);
        f.send(failure(1)); assert.equal(store.app_failures_for(context).failures[0].ageMs, 0);
        store.clear_app_failures();
    });
    await check('rolling throttle accepts 20/min per frame and survives reload/re-registration; ready counts', () => {
        let time = 0; const store = M.create_app_failure_store({ now: () => time }); const f = frame(store);
        for (let n = 1; n <= 20; n++) f.send(failure(n));
        time = 59_999; f.send(failure(21)); f.load(); f.send(failure(22));
        const stop = store.register_app_frame(f.iframe, options); f.send(failure(23));
        assert.equal(store.app_failures_for(context).failures[0].eventId, uuid(20));
        time = 60_000; f.send(failure(24)); assert.equal(store.app_failures_for(context).failures[0].eventId, uuid(24));
        const second = frame(store, { ...options, appSession: 'second' });
        for (let i = 0; i < 20; i++) second.ready();
        second.send(failure(25)); assert.equal(store.app_failures_for(context).failures[0].eventId, uuid(24));
        stop(); store.clear_app_failures();
    });
    await check('shared envelope fixtures: exact hello, ready and failure; every rejected envelope stores nothing', () => {
        const env = fixtures.envelopes;
        const fill = (value, nonce) => JSON.parse(JSON.stringify(value), (_key, v) =>
            v === '$NONCE' ? nonce : v === '$VALID_0' ? fixtures.valid[0].failure : v);
        for (const { name, envelope } of env.rejected) {
            const store = M.create_app_failure_store(); const f = frame(store);
            assert.deepEqual(f.sent.at(-1), { data: fill(env.hello, f.nonce()), origin: ORIGIN }, 'exact hello');
            f.post(fill(envelope, f.nonce()));
            assert.deepEqual(store.app_failures_for(context), { available: false, failures: [] }, name);
            f.unregister();
        }
        for (const { name, envelope, stores } of env.accepted) {
            const store = M.create_app_failure_store(); const f = frame(store);
            f.post(fill(envelope, f.nonce()));
            const result = store.app_failures_for(context);
            assert.equal(result.available, true, name);
            assert.equal(result.failures.length, stores ? 1 : 0, name);
            f.unregister();
        }
    });
    await check('maximal records export <=10 and <=8 KiB, newest first', () => {
        const store = M.create_app_failure_store(); const f = frame(store);
        for (let n = 1; n <= 20; n++) f.send({ ...failure(n), clientRequestId: uuid(100), gatewayRequestId: uuid(101),
            vscodeRequestId: uuid(102), retryOfClientRequestId: uuid(103), attempt: 64, durationMs: 3_600_000, httpStatus: 599, modelKey: 'anthropic/' + 'model-12.'.repeat(6).slice(0, 53) });
        const exported = store.app_failures_for(context).failures;
        assert.ok(exported.length > 0 && exported.length <= 10);
        assert.ok(Buffer.byteLength(JSON.stringify(exported)) <= 8192);
        assert.equal(exported[0].eventId, uuid(20));
        assert.equal(window.localStorage.length, 0, 'ring never persists');
        store.clear_app_failures();
    });

    // Real feedback dialog, with only irrelevant capture modules stubbed as in feedback-test.mjs.
    window.HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    window.HTMLDialogElement.prototype.close = function () { this.open = false; this.dispatchEvent(new window.Event('close')); };
    const captureUrl = new URL('./capture.js', import.meta.url).href;
    const hooks = registerHooks({ load (url, ctx, next) {
        if (url === captureUrl) return { format: 'module', shortCircuit: true, source:
            'export const tab_capture_supported = () => false, desktop_capture_supported = () => false, capture_shell_snapshot = () => null, capture_tab_frame = () => null, capture_desktop_frame = () => null;' };
        return next(url, ctx);
    } });
    const feedback = await import('./feedback.js');
    const { setCurrentComputer } = await import('../../session.js');
    const { signOut } = await import('../../auth.js');
    const { default: telemetry } = await import('../../telemetry.js');
    telemetry.capture = () => { throw new Error('app failure must never call telemetry.capture'); };
    const account = '33333333-3333-4333-8333-333333333333';
    const report = '44444444-4444-4444-8444-444444444444';
    const ui = { feedbackAppFailures: true };
    window.__EZIL_BOOT__ = { computer: { id: A }, user: { id: account }, desktopState: { endpoints: { feedback: '/feedback' }, ui } };
    const calls = []; let respond = () => ({ status: 201, json: async () => ({ id: report }) });
    globalThis.fetch = async (url, opts) => { assert.equal(url, '/feedback'); calls.push(opts.body); return respond(); };
    const current = () => document.querySelector('dialog');
    const form = () => current().querySelector('form');
    // The preview renders only while it is open.
    const body = () => { const box = current().querySelector('.ezil-feedback-preview'); if (!box.open) { box.open = true; box.dispatchEvent(new window.Event('toggle')); } return current().querySelector('pre').textContent; };
    const payload = () => JSON.parse(body());
    const line = () => current().querySelector('[data-role="app-failure-context"]');
    const change = checked => { form().elements.diagnostics.checked = checked; form().elements.diagnostics.dispatchEvent(new window.Event('change', { bubbles: true })); };
    const close = () => current().querySelector('[data-action="cancel"]').click();
    const open = appContext => { feedback.open_feedback_dialog({ source: 'settings', appContext });
        form().elements.description.value = 'Report';
        form().elements.description.dispatchEvent(new window.Event('input', { bubbles: true })); };
    const send = () => form().dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
    const until = async predicate => { for (let i = 0; i < 100 && !predicate(); i++) await new Promise(r => setTimeout(r, 0)); assert.ok(predicate()); };
    const outboxKey = `ezil:feedback:outbox:v1:${account}`;
    const backgroundListeners = listeners.size;
    const a = frame(M); a.send(failure(101));
    const b = frame(M, { ...options, computerId: B, appSession: 'session-b' }); b.send(failure(201));
    await check('dialog freezes current computer at open, default snapshot and cancelled presentation', () => {
        setCurrentComputer({ id: A });
        a.send(fixtures.valid.find(f => f.failure.category === 'cancellation').failure);
        const count = calls.length;
        // Diagnostics are selected by default: the snapshot is taken when the form opens.
        open(); setCurrentComputer({ id: B });
        assert.equal(payload().computerId, A);
        assert.deepEqual(payload().diagnostics.appFailures.map(f => f.eventId), [uuid(11), uuid(101)]);
        assert.equal(payload().diagnostics.appFailures[0].outcome, 'cancelled');
        assert.match(line().textContent, /2 app events \(1 cancelled\)/);
        // The one-line summary names only what the record says: the newest failure's operation, code and outcome.
        const noticed = () => current().querySelector('[data-role="context-line"]');
        assert.equal(noticed().hidden, false);
        assert.match(noticed().textContent, /latest app failure: .+ \(cancelled\)/);
        assert.doesNotMatch(noticed().textContent, /steps|expected|reproduc/i);
        const frozen = body(); a.send(failure(102));
        form().dispatchEvent(new window.Event('input', { bubbles: true })); assert.equal(body(), frozen);
        current().querySelector('[data-action="refresh-diagnostics"]').click();
        assert.equal(payload().diagnostics.appFailures[0].eventId, uuid(102));
        assert.equal(calls.length, count, 'prefill and consent never send');
        change(false); assert.equal(payload().diagnostics, null); assert.equal(line().hidden, true);
        assert.doesNotMatch(noticed().textContent, /latest app failure/, 'unchecked: the failure is not summarised or sent'); close();
    });
    await check('flag absent/false omits appFailures; unavailable context has an honest preview line', () => {
        for (const value of [undefined, false, 'true']) {
            ui.feedbackAppFailures = value; open(); change(true);
            assert.equal(payload().diagnostics.appFailures, undefined); assert.equal(line().hidden, true); close();
        }
        ui.feedbackAppFailures = true; open({ computerId: A, appSession: 'unresponsive-session' }); change(true);
        assert.equal(payload().diagnostics.appFailures, undefined);
        assert.equal(line().hidden, false); assert.match(line().textContent, /App failure context is unavailable/);
        assert.doesNotMatch(line().textContent, /privileged|device log/i);
        change(false); assert.equal(line().hidden, true); close();
    });
    await check('trusted app context overrides current computer, copies session, and never auto-sends', () => {
        setCurrentComputer({ id: B }); const trusted = { computerId: A, appSession: 'session-a' }; const count = calls.length;
        open(trusted); trusted.computerId = B; trusted.appSession = 'session-b'; change(true);
        assert.equal(payload().computerId, A); assert.equal(payload().diagnostics.appFailures[0].eventId, uuid(102));
        assert.doesNotMatch(body(), /session-a|session-b|nonce|origin|receivedAt/);
        assert.equal(calls.length, count); close();
    });
    await check('closed Code window: retained failures still reach the consented report, in both scopes', () => {
        const closed = frame(M, { ...options, appSession: 'session-closed' });
        closed.send(failure(301)); closed.unregister(); closed.send(failure(302));
        // Global entry: every app session of the frozen computer, never another computer's.
        setCurrentComputer({ id: A }); open(); change(true);
        const global = payload().diagnostics.appFailures.map(f => f.eventId);
        assert.ok(global.includes(uuid(301)) && global.includes(uuid(102)), 'global aggregates sessions of A');
        assert.ok(!global.includes(uuid(302)) && !global.includes(uuid(201)), 'nothing after close, nothing from B');
        assert.equal(line().hidden, false); assert.doesNotMatch(line().textContent, /unavailable/); close();
        // App entry: that one session only, even though its window is gone.
        open({ computerId: A, appSession: 'session-closed' }); change(true);
        assert.deepEqual(payload().diagnostics.appFailures.map(f => f.eventId), [uuid(301)]); close();
        open({ computerId: A, appSession: 'session-a' }); change(true);
        assert.ok(!payload().diagnostics.appFailures.some(f => f.eventId === uuid(301)), 'sessions stay isolated'); close();
    });
    await check('healthy producer with zero errors: available, empty list, no unavailable line', () => {
        const healthy = frame(M, { ...options, computerId: B, appSession: 'session-healthy' });
        healthy.ready();
        open({ computerId: B, appSession: 'session-healthy' }); change(true);
        assert.deepEqual(payload().diagnostics.appFailures, []);
        assert.equal(line().hidden, false); assert.doesNotMatch(line().textContent, /unavailable/);
        assert.match(line().textContent, /0 app events/); close(); healthy.unregister();
    });
    await check('outbox replay after computer switch keeps exact frozen app entries and ages', async () => {
        setCurrentComputer({ id: A }); open(); change(true); const frozen = body();
        respond = () => { throw new Error('offline'); }; send();
        await until(() => /automatically/.test(current().querySelector('.ezil-feedback-result').textContent));
        assert.equal(JSON.parse(window.localStorage.getItem(outboxKey))[0].body, frozen);
        close(); setCurrentComputer({ id: B }); a.send(failure(103));
        respond = () => ({ status: 201, json: async () => ({ id: report }) });
        await feedback.flush_feedback_outbox(); assert.equal(calls.at(-1), frozen);
        assert.equal(window.localStorage.getItem(outboxKey), null);
    });
    await check('400 downgrade removes appFailures and retries otherwise identical report', async () => {
        open(); change(true); const original = payload(); const count = calls.length;
        respond = () => calls.length === count + 1 ? { status: 400 } : { status: 201, json: async () => ({ id: report }) };
        send(); await until(() => current().querySelector('.ezil-feedback-result').textContent.includes(report));
        assert.equal(calls.length, count + 2);
        const expected = structuredClone(original); delete expected.diagnostics.appFailures;
        assert.deepEqual(JSON.parse(calls[count]), original); assert.deepEqual(JSON.parse(calls[count + 1]), expected);
        assert.equal(body(), calls[count + 1]); assert.equal(line().hidden, true); close();
    });
    await check('real sign-out clears every ring and listener; stale messages cannot refill', () => {
        let submissions = 0;
        window.HTMLFormElement.prototype.submit = function () { submissions++; assert.equal(this.action, 'https://feedback.test/auth/signout'); };
        assert.ok(M.app_failures_for(context).failures.length);
        signOut(); a.send(failure(999)); b.send(failure(998));
        assert.equal(submissions, 1); assert.equal(listeners.size, backgroundListeners);
        assert.deepEqual(M.app_failures_for(context), { available: false, failures: [] });
        assert.deepEqual(M.app_failures_for({ computerId: B }), { available: false, failures: [] });
    });
    await check('Code source registers at mint with launch computer/session, replaces registration on remint, disposes on close', async () => {
        // Exercise actual code.js and the actual store. Doubles own only window chrome and server mint/confirmation.
        const codeUrl = new URL('../../apps/code.js', import.meta.url).href;
        const hello = [];
        let minted = 'https://mint-one.test/bootstrap';
        const windows = [];
        globalThis.getComputedStyle = window.getComputedStyle.bind(window);
        globalThis.__codeFailureTest = {
            mint: async () => ({ ok: true, url: minted }),
            createWindow: async () => {
                const win = document.createElement('div');
                win.innerHTML = '<div class="window-body"><iframe class="window-app-iframe"></iframe></div>';
                document.body.append(win); windows.push(win);
                const iframe = win.querySelector('iframe');
                const src = Object.getOwnPropertyDescriptor(window.HTMLIFrameElement.prototype, 'src');
                Object.defineProperty(iframe, 'src', { get () { return src.get.call(this); }, set (value) {
                    src.set.call(this, value);
                    this.contentWindow.postMessage = (data, origin) => hello.push({ iframe, data, origin });
                } });
                return win;
            },
        };
        const doubles = {
            '../session.js': `export const DESKTOP_BOOT_TIMEOUT_MS = 60000; export default {
                cancellableWake: () => globalThis.__codeFailureTest.mint(), observeFrame: () => new Promise(() => {}),
                desktopRunning: async () => true, reportActivity() {}, payload: () => ({}) };`,
            '../native-runtime.js': 'export const selectRuntimeAdapter = () => null, watchNativeSurface = () => () => {}, editorFailureCopy = () => ({});',
            '../runtime-recheck.js': 'export const watchRuntimeOnReturn = () => () => {};',
            '../ui/app-spinner.js': 'export default () => ({ el: document.createElement("div"), render() {}, stamp() {}, dispose() {}, computerProgress: () => null });',
            '../ui/app-drawer.js': 'export default () => document.createElement("div");',
            '../ui/full-view.js': `export const createFullView = () => ({ allowed: true, wants: false, is_full: () => false,
                enter() {}, exit() {}, prepare_close() {}, watch_restore: () => ({ disconnect() {} }) });`,
            '../app-history.js': 'export const appUrl = () => "/app/code";',
            '../../src/UI/UIWindow.js': 'export default () => globalThis.__codeFailureTest.createWindow();',
        };
        const codeHooks = registerHooks({ resolve (specifier, ctx, next) {
            if (ctx.parentURL === codeUrl && Object.hasOwn(doubles, specifier)) {
                return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(doubles[specifier])}` };
            }
            return next(specifier, ctx);
        } });
        try {
            const { openCodeWindow } = await import(codeUrl);
            setCurrentComputer({ id: B });
            const before = listeners.size;
            const win = await openCodeWindow({ computer: { id: A }, desktopState: { configured: true } });
            await until(() => hello.length === 1);
            const trusted = win.ezilFeedbackAppContext;
            assert.equal(trusted.computerId, A); assert.ok(Object.isFrozen(trusted));
            // One feedback listener and one expired-auth recovery listener; both belong to this mint.
            assert.equal(listeners.size, before + 2);
            assert.equal(hello[0].origin, 'https://mint-one.test');
            const post = (h, record, overrides = {}) => window.dispatchEvent(new window.MessageEvent('message', {
                source: h.iframe.contentWindow, origin: h.origin,
                data: { type: 'ezil.code.failure', v: 1, nonce: h.data.nonce, failure: record }, ...overrides,
            }));
            post(hello[0], failure(501));
            assert.equal(M.app_failures_for(trusted).failures[0].eventId, uuid(501));
            assert.deepEqual(M.app_failures_for({ computerId: B }).failures, []);
            minted = 'https://mint-two.test/bootstrap';
            window.dispatchEvent(new window.CustomEvent('ezil:desktop-restarted', { detail: { computerId: A } }));
            await until(() => hello.length === 2);
            assert.equal(listeners.size, before + 2, 'both old mint registrations removed');
            assert.equal(win.ezilFeedbackAppContext, trusted, 'one session per window across mints');
            assert.equal(hello[1].origin, 'https://mint-two.test');
            assert.notEqual(hello[1].data.nonce, hello[0].data.nonce);
            post(hello[0], failure(502));
            post(hello[0], failure(503), { origin: hello[1].origin });
            assert.equal(M.app_failures_for(trusted).failures.length, 1, 'stale mint rejected');
            post(hello[1], failure(504));
            assert.equal(M.app_failures_for(trusted).failures[0].eventId, uuid(504));
            const second = await openCodeWindow({ computer: { id: A }, desktopState: { configured: true } });
            await until(() => hello.length === 3);
            assert.notEqual(second.ezilFeedbackAppContext.appSession, trusted.appSession);
            post(hello[2], failure(505));
            assert.equal(M.app_failures_for(trusted).failures[0].eventId, uuid(504), 'other session excluded');
            await win.on_before_exit(); await second.on_before_exit();
            assert.equal(listeners.size, before);
            post(hello[1], failure(506));
            assert.equal(M.app_failures_for(trusted).failures[0].eventId, uuid(504), 'a closed window accepts nothing new');
            // Closing Code after a failure must not hide what it already reported.
            assert.equal(M.app_failures_for(trusted).available, true, 'retained entries outlive the window');
            assert.deepEqual(M.app_failures_for({ ...trusted, appSession: 'never-registered' }), { available: false, failures: [] });
        } finally {
            for (const win of windows) await win.on_before_exit?.();
            M.clear_app_failures(); codeHooks.deregister(); delete globalThis.__codeFailureTest;
        }
    });
    hooks.deregister();
    console.log(`\n${checks} app-failure checks passed. jsdom does not prove browser origin enforcement.`);
} finally {
    M.clear_app_failures();
    dom.window.close();
}
