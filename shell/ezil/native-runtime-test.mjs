import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('./native-runtime.js', import.meta.url), 'utf8');
const runtime = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const { selectRuntimeAdapter, NATIVE_CAPABILITIES, validBounds, sanitizeNativeEvents } = runtime;
const ctx = { computer: { id: randomUUID() }, desktopState: { provider: 'native-macos', runtime: NATIVE_CAPABILITIES } };
const calls = [];
let responder = async op => ({ ...op, ok: true, state: 'ready', url: 'http://127.0.0.1:8443/' });
globalThis.window = { crypto: { randomUUID }, __EZIL_BOOT__: ctx, ezilNative: { operation: async op => { calls.push(op); return responder(op); } } };
assert.equal(selectRuntimeAdapter({ desktopState: { provider: 'cloudflare' } }), null);
assert.equal(selectRuntimeAdapter({ desktopState: { provider: 'local' } }), null);
const unsupported = selectRuntimeAdapter({ ...ctx, desktopState: { provider: 'native-macos', runtime: { contractVersion: 1 } } });
assert.equal((await unsupported.surface('code').open()).ok, false);
assert.equal(calls.length, 0);
assert.ok(validBounds({ x: -10, y: 0, width: 800.5, height: 600 }));
for (const width of [-1, NaN, Infinity, '800', 32769]) assert.ok(!validBounds({ x: 0, y: 0, width, height: 600 }));
const adapter = selectRuntimeAdapter(ctx);
let starting = true;
responder = async op => ({ ...op, ok: true, state: op.op === 'code.open' && starting ? (starting = false, 'starting') : 'ready', url: 'http://127.0.0.1:8443/' });
const code = adapter.surface('code');
assert.equal((await code.open()).url, 'http://127.0.0.1:8443/');
assert.ok(calls.some(op => op.op === 'code.status'));
assert.equal(await code.confirm(), true);
code.dispose(); code.dispose(); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(calls.filter(op => op.op === 'code.close').length, 1);
assert.equal((await code.open()).ok, false);
const afterClose = calls.length; assert.equal(await code.confirm(), false); assert.equal(calls.length, afterClose);
for (const response of [{ state: 'failed' }, { state: 'unavailable' }, { state: 'ready', url: 'https://example.com/' }, { state: 'ready', url: 'http://127.0.0.1:8443/?secret=x' }, { state: 'ready', generation: 999 }]) {
    responder = async op => ({ ...op, ok: true, ...response });
    assert.equal((await adapter.surface('code').open()).ok, false);
}
responder = async op => { if (op.op === 'preview.list') return { ok: true, ports: [3000] }; return { ...op, ok: true, state: 'ready', url: 'http://127.0.0.1:3000/' }; };
assert.equal((await adapter.surface('preview').open()).url, 'http://127.0.0.1:3000/');
assert.equal((await adapter.surface('preview').open(4000)).ok, false);
// Closing while a retry is still listing ports closes the last attached generation.
const retryPreview = adapter.surface('preview'); await retryPreview.open();
let finishPorts;
responder = op => op.op === 'preview.list' ? new Promise(resolve => { finishPorts = () => resolve({ ok: true, ports: [3000] }); }) : Promise.resolve({ ...op, ok: true, state: 'closed' });
const retryPending = retryPreview.open(); retryPreview.dispose(); finishPorts();
assert.equal((await retryPending).ok, false); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(calls.at(-1).op, 'preview.close'); assert.equal(calls.at(-1).generation, 1);
// Close during an in-flight open is serialized after open and its completion cannot become ready.
let finish;
responder = op => op.op === 'code.open' ? new Promise(resolve => { finish = () => resolve({ ...op, ok: true, state: 'ready', url: 'http://127.0.0.1:8443/' }); }) : Promise.resolve({ ...op, ok: true, state: 'closed' });
const pendingCode = adapter.surface('code'); const pending = pendingCode.open();
await new Promise(resolve => setTimeout(resolve, 0)); pendingCode.dispose(); finish();
assert.equal((await pending).ok, false); await new Promise(resolve => setTimeout(resolve, 0));
assert.equal(calls.at(-1).op, 'code.close');
// Invalid bounds never reach IPC; valid browser calls carry monotonic identities.
responder = async op => ({ ...op, ok: true, state: 'ready' });
const browser = adapter.surface('browser'); await browser.open();
const beforeBadBounds = calls.length;
await browser.layout({ x: 0, y: 0, width: Infinity, height: 600 }, true, false);
assert.equal(calls.length, beforeBadBounds);
await browser.layout({ x: 5, y: 20, width: 800, height: 600 }, true, true);
await browser.focus(); browser.dispose(); await new Promise(resolve => setTimeout(resolve, 0));
const browserCalls = calls.filter(op => op.op.startsWith('browser.'));
assert.deepEqual(browserCalls.map(op => op.op), ['browser.attach', 'browser.layout', 'browser.focus', 'browser.detach']);
assert.deepEqual(browserCalls.map(op => op.sequence), [1, 2, 3, 4]);
assert.equal(new Set(browserCalls.map(op => op.surfaceId)).size, 1);
delete window.ezilNative;
assert.equal((await adapter.surface('code').open()).ok, false);
window.ezilNative = { operation: async op => { calls.push(op); return responder(op); } };
assert.deepEqual(sanitizeNativeEvents([{ event: 'code_ready', t: 1, token: 'secret' }, { event: 'arbitrary', t: 1 }]), [{ event: 'code_ready', t: 1 }]);
// Load the Settings mapping without a bundler; its sole dependency is the tested adapter.
const settingsSource = readFileSync(new URL('./ui/Settings/native-adapter.js', import.meta.url), 'utf8')
    .replace("'../../native-runtime.js'", JSON.stringify(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`));
const { nativeSettingsRequest } = await import(`data:text/javascript;base64,${Buffer.from(settingsSource).toString('base64')}`);
responder = async op => ({ ok: true, workspaces: [{ id: ctx.computer.id, name: 'Local', createdAt: '2026-01-01', root: '/secret' }], workspace: { id: ctx.computer.id, name: op.name } });
assert.equal((await nativeSettingsRequest('computer.list', undefined, ctx)).data[0].slot, 1);
assert.ok(!JSON.stringify(await nativeSettingsRequest('computer.list', undefined, ctx)).includes('/secret'));
for (const [path, op] of [['create', 'create'], ['import', 'attach'], ['rename', 'rename'], ['delete', 'remove'], ['select', 'select']]) {
    await nativeSettingsRequest(`computer.${path}`, { id: ctx.computer.id, name: 'New', command: 'arbitrary' }, ctx);
    assert.equal(calls.at(-1).op, `workspace.${op}`); assert.ok(!('command' in calls.at(-1)));
}
assert.equal((await nativeSettingsRequest('arbitrary.exec', {}, ctx)).code, 'UNSUPPORTED');
assert.equal(await nativeSettingsRequest('computer.list', {}, { desktopState: { provider: 'cloudflare' } }), null);
console.log('PASS native adapter selection, bounds, readiness/failures, disposal races, port restrictions, diagnostics and Settings allowlist');
