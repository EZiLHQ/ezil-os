import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const source = readFileSync(new URL('./native-runtime.js', import.meta.url), 'utf8');
const { browserAddress, selectRuntimeAdapter, NATIVE_CAPABILITIES } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
for (const [input, expected] of [['localhost:3000', 'http://localhost:3000/'], ['127.0.0.1:8080/a', 'http://127.0.0.1:8080/a'], ['[::1]:4000', 'http://[::1]:4000/'], ['example.com', 'https://example.com/'], ['javascript:alert(1)', null], ['https://u:p@example.com', null], ['http://example.com', null]]) assert.equal(browserAddress(input), expected);
const ctx = { computer: { id: randomUUID() }, desktopState: { provider: 'native-macos', runtime: NATIVE_CAPABILITIES } };
let stateListener, shortcutListener, removed = 0, identity;
const state = { revision: 1, url: 'https://example.com/', title: 'Example', loading: false, error: null, canGoBack: true, canGoForward: false };
globalThis.window = { crypto: { randomUUID }, ezilNative: {
    subscribeBrowserState(fn) { stateListener = fn; return () => removed++; },
    subscribeBrowserShortcut(fn) { shortcutListener = fn; return () => removed++; },
    async operation(op) { identity = op; return { ...op, ok: true, state: 'ready', browserState: state }; },
} };
const surface = selectRuntimeAdapter(ctx).surface('browser'), received = [], shortcuts = [];
surface.subscribeBrowserState(s => received.push(s)); surface.subscribeBrowserShortcut(s => shortcuts.push(s));
await surface.open();
const emit = value => stateListener({ ...identity, ...value });
emit({ ...state, revision: 2, generation: 99 });
emit({ ...state, revision: 2, surfaceId: randomUUID() });
emit({ ...state, revision: 2, url: 'file:///private' });
emit({ ...state, revision: 2, error: 'private_message' });
assert.equal(received.length, 1);
emit({ ...state, revision: 3, title: 'New', private: 'discard' });
emit({ ...state, revision: 2, title: 'Old' });
assert.equal(received.length, 2); assert.equal(received[1].title, 'New'); assert.equal(received[1].private, undefined);
assert.equal(received[0].zoomFactor, 1, 'older host state defaults safely');
emit({ ...state, revision: 4, zoomFactor: 1.25 }); assert.equal(received.at(-1).zoomFactor, 1.25);
emit({ ...state, revision: 5, zoomFactor: 8 }); assert.equal(received.at(-1).revision, 4);
shortcutListener({ ...identity, action: 'address' }); shortcutListener({ ...identity, action: 'zoom-in' }); shortcutListener({ ...identity, action: 'exec' });
shortcutListener({ ...identity, generation: 99, action: 'reload' }); assert.deepEqual(shortcuts, ['address', 'zoom-in']);
await surface.open(); assert.equal(received.at(-1).revision, 1, 'new generation accepts initial revision');
surface.dispose(); assert.equal(removed, 2);
const count = received.length; emit({ ...state, revision: 100 }); assert.equal(received.length, count);
console.log('PASS address normalization, state validation, identity/revision ordering, generation reset, shortcuts and disposal');
