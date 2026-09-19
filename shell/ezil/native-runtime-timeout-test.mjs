import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('./native-runtime.js', import.meta.url), 'utf8');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const { nativeOperation, NATIVE_CAPABILITIES } = await import(moduleUrl);
const settingsSource = readFileSync(new URL('./ui/Settings/native-adapter.js', import.meta.url), 'utf8')
    .replace("'../../native-runtime.js'", JSON.stringify(moduleUrl));
const { nativeSettingsRequest } = await import(`data:text/javascript;base64,${Buffer.from(settingsSource).toString('base64')}`);
const original = { setTimeout, clearTimeout, window: globalThis.window };
const timers = new Map();
let now = 0, nextId = 0, respond;
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const advance = async ms => {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    await flush();
};
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
};
const unavailable = { ok: false, error: 'native_unavailable' };
try {
    globalThis.setTimeout = (fn, ms) => { const id = ++nextId; timers.set(id, { fn, at: now + ms }); return id; };
    globalThis.clearTimeout = id => timers.delete(id);
    globalThis.window = { ezilNative: { operation: op => respond(op) } };
    const dialogs = ['workspace.import', 'workspace.attach', 'workspace.relink', 'workspace.select', 'workspace.remove', 'workspace.openXcode'];
    for (const op of dialogs) {
        const success = op === 'workspace.openXcode' ? { ok: true, opened: true } : { ok: true, workspace: { id: 'chosen' } };
        const canceled = op === 'workspace.openXcode' ? { ok: true, opened: false, reason: 'canceled' }
            : op === 'workspace.remove' ? { ok: false, error: 'canceled' } : { ok: true, canceled: true };
        for (const result of [success, canceled]) {
            const host = deferred(); respond = () => host.promise;
            let settled = false;
            const pending = nativeOperation({ op }).then(value => { settled = true; return value; });
            await advance(600_000);
            assert.equal(settled, false, `${op} must await the user beyond ordinary and extended deadlines`);
            assert.equal(timers.size, 0, `${op} must not schedule a renderer deadline`);
            host.resolve(result);
            assert.deepEqual(await pending, result, `${op} preserves the host result`);
        }
        const host = deferred(); respond = () => host.promise;
        const pending = nativeOperation({ op });
        await advance(20_000); host.reject(Error('host unavailable'));
        assert.deepEqual(await pending, unavailable, `${op} still handles host rejection`);
    }
    // Noninteractive operations, including adjacent workspace actions, remain bounded.
    for (const [op, deadline] of [
        ...['workspace.list', 'workspace.create', 'workspace.rename', 'workspace.reveal', 'workspace.openVSCode',
            'toolchain.status', 'desktop.read', 'browser.attach', 'code.status', 'preview.list', 'diagnostics.read',
            'provider.status', 'provider.remove', 'workspace.unknown'].map(op => [op, 10_000]),
        ['code.open', 35_000], ['provider.configure', 300_000],
    ]) {
        const host = deferred(); respond = () => host.promise;
        let settled = false;
        const pending = nativeOperation({ op }).then(value => { settled = true; return value; });
        await advance(deadline - 1); assert.equal(settled, false, `${op} must not expire early`);
        await advance(1); assert.deepEqual(await pending, unavailable, `${op} expires at ${deadline}ms`);
        host.resolve({ ok: true }); await flush();
        assert.deepEqual(await pending, unavailable, 'late success cannot replace a timeout');
        assert.equal(timers.size, 0);
    }
    for (const [respondWith, expected] of [
        [() => ({ ok: true }), { ok: true }],
        [() => Promise.reject(Error('failed')), unavailable],
        [() => { throw Error('failed'); }, unavailable],
    ]) {
        respond = respondWith;
        const result = await nativeOperation({ op: 'workspace.list' });
        assert.deepEqual(result, expected);
        assert.equal(timers.size, 0, 'completion and rejection clear the deadline');
    }
    // Reproduce the Settings import mapping with a folder chosen after ten seconds.
    const ctx = { desktopState: { provider: 'native-macos', runtime: NATIVE_CAPABILITIES } };
    for (const canceled of [false, true]) {
        const host = deferred();
        respond = op => { assert.equal(op.op, 'workspace.attach'); return host.promise; };
        let settled = false;
        const pending = nativeSettingsRequest('computer.import', {}, ctx).then(value => { settled = true; return value; });
        await advance(20_000); assert.equal(settled, false);
        host.resolve(canceled ? { ok: true, canceled: true } : { ok: true, workspace: { id: 'chosen', name: 'Project' } });
        const result = await pending;
        assert.equal(result.ok, true);
        if (canceled) assert.deepEqual(result, { ok: true, canceled: true, data: null });
        else assert.equal(result.data.id, 'chosen');
    }
    delete window.ezilNative;
    assert.deepEqual(await nativeOperation({ op: 'workspace.attach' }), unavailable);
    assert.equal(timers.size, 0);
} finally {
    globalThis.setTimeout = original.setTimeout;
    globalThis.clearTimeout = original.clearTimeout;
    if (original.window === undefined) delete globalThis.window;
    else globalThis.window = original.window;
}
console.log('PASS native dialog delayed success/cancel/rejection, bounded deadlines, timer cleanup and delayed Settings import');
