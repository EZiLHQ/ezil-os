import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('./native-runtime.js', import.meta.url), 'utf8');
const { selectRuntimeAdapter, NATIVE_CAPABILITIES } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const calls = [], shortcuts = new Set(); let holdClose = false, releaseClose;
globalThis.window = { crypto: { randomUUID }, ezilNative: {
    subscribeBrowserShortcut(fn) { shortcuts.add(fn); return () => shortcuts.delete(fn); },
    async operation(op) {
    calls.push(op);
    if (op.op === 'browser.detach' && holdClose) { holdClose = false; await new Promise(resolve => { releaseClose = resolve; }); }
    return { ...op, ok: true, state: 'ready' };
} } };
const ctx = { computer: { id: randomUUID() }, desktopState: { provider: 'native-macos', runtime: NATIVE_CAPABILITIES } };
const adapter = selectRuntimeAdapter(ctx);
const flush = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
for (let i = 0; i < 300; i++) {
    const surface = adapter.surface('browser'); assert.equal((await surface.open()).ok, true);
    surface.dispose(); await flush();
}
const opened = calls.filter(op => op.op === 'browser.attach');
assert.equal(new Set(opened.map(op => op.surfaceId)).size, 1, 'tab churn reuses a settled identity');
assert.deepEqual(opened.map(op => op.generation), Array.from({ length: 300 }, (_, i) => i + 1));
const first = adapter.surface('browser'); await first.open(); const firstId = calls.at(-1).surfaceId;
holdClose = true; first.dispose(); await flush();
const second = adapter.surface('browser'); await second.open();
assert.notEqual(calls.at(-1).surfaceId, firstId, 'pending detach cannot release its slot');
releaseClose(); await flush(); second.dispose(); await flush();
const third = adapter.surface('browser'); await third.open();
assert.equal(calls.at(-1).surfaceId, firstId); assert.equal(calls.at(-1).generation, 302);
const received = []; third.subscribeBrowserShortcut(action => received.push(action));
for (const fn of shortcuts) {
    fn({ ...calls.at(-1), generation: 301, action: 'close-tab' });
    fn({ ...calls.at(-1), action: 'address' });
}
assert.deepEqual(received, ['address'], 'late notifications cannot target a new lease of the same identity');
third.dispose(); await flush();
assert.equal(shortcuts.size, 0);
console.log('PASS 300 close/open cycles reuse bounded identities with monotonic generations; pending detaches retain exclusive slots');
