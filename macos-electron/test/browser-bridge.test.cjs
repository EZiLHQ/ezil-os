'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
function fixture() {
  const ipc = new EventEmitter(); let bridge, result;
  ipc.invoke = async () => result;
  const context = vm.createContext({ URL, require: () => ({ contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: ipc }) });
  vm.runInContext(fs.readFileSync(require.resolve('../src/preload.cjs'), 'utf8'), context);
  return { ipc, bridge, invoke(input, value) { result = value; return bridge.operation(vm.runInContext(`(${JSON.stringify(input)})`, context)); } };
}
const identity = { workspaceId: randomUUID(), surfaceId: randomUUID(), generation: 1 };
test('page zoom keeps the finite operation/shortcut contract and validates observed factors', async () => {
  const { runtimeSchema } = require('../src/policy.cjs');
  for (const action of ['zoom-in', 'zoom-out', 'zoom-reset']) {
    const input = { op: `browser.${action}`, ...identity, sequence: 1 };
    assert.deepEqual(runtimeSchema(input), input);
    assert.throws(() => runtimeSchema({ ...input, zoomFactor: 999 }));
  }
  const { ipc, bridge, invoke } = fixture(), actions = [], states = [];
  bridge.subscribeBrowserShortcut(value => actions.push(value.action));
  bridge.subscribeBrowserState(value => states.push(value));
  for (const action of ['zoom-in', 'zoom-out', 'zoom-reset', 'zoom-arbitrary']) ipc.emit('ezil:browser-shortcut:v2', {}, { ...identity, action });
  assert.deepEqual(actions, ['zoom-in', 'zoom-out', 'zoom-reset']);
  const state = { revision: 1, url: 'https://example.com/', title: 'Example', loading: false, error: null, canGoBack: false, canGoForward: false };
  ipc.emit('ezil:browser-state:v2', {}, { ...identity, ...state, zoomFactor: 1.25 });
  assert.equal(states.at(-1).zoomFactor, 1.25);
  for (const zoomFactor of [0, 0.24, 5.1, Infinity, '1']) ipc.emit('ezil:browser-state:v2', {}, { ...identity, ...state, revision: 2, zoomFactor });
  assert.equal(states.length, 1);
  const result = await invoke({ op: 'browser.status', ...identity, sequence: 2 }, { ok: true, ...identity, sequence: 2, state: 'ready', browserState: state });
  assert.equal(result.browserState.zoomFactor, 1);
});
test('new-tab bridge strips payloads, rejects unsafe URLs/identities, and unsubscribes', () => {
  const { ipc, bridge } = fixture(), received = [];
  const off = bridge.subscribeBrowserNewTab(value => received.push(JSON.parse(JSON.stringify(value))));
  const event = { ...identity, url: 'https://example.com/', background: false };
  ipc.emit('ezil:browser-new-tab:v2', {}, { ...event, private: 'discard' });
  assert.deepEqual(received, [event]);
  for (const patch of [{ generation: 0 }, { surfaceId: '../x' }, { background: 1 },
    ...['file:///private', 'javascript:alert(1)', 'https://u:p@example.com/', 'http://example.com/', ''].map(url => ({ url }))]) {
    ipc.emit('ezil:browser-new-tab:v2', {}, { ...event, ...patch });
  }
  assert.equal(received.length, 1); off(); ipc.emit('ezil:browser-new-tab:v2', {}, event); assert.equal(received.length, 1);
});
test('tab shortcuts use the finite allowlist; desktop reads preserve only bounded safe tabs', async () => {
  const { ipc, bridge, invoke } = fixture(), received = [];
  const off = bridge.subscribeBrowserShortcut(value => received.push(value.action));
  for (const action of ['new-tab', 'close-tab', 'next-tab', 'previous-tab', 'exec']) ipc.emit('ezil:browser-shortcut:v2', {}, { ...identity, action });
  assert.deepEqual(received, ['new-tab', 'close-tab', 'next-tab', 'previous-tab']); off();
  const browser = { tabs: ['', 'https://example.com/', 'http://127.0.0.1:3000/'], activeIndex: 2 };
  let value = await invoke({ op: 'desktop.read', workspaceId: identity.workspaceId }, { ok: true, preferences: { browser: { ...browser, private: '/secret' } } });
  assert.deepEqual(JSON.parse(JSON.stringify(value.preferences.browser)), browser);
  for (const b of [{ tabs: ['file:///private'], activeIndex: 0 }, { tabs: Array(21).fill(''), activeIndex: 0 }, { tabs: [''], activeIndex: 2 }]) {
    value = await invoke({ op: 'desktop.read', workspaceId: identity.workspaceId }, { ok: true, preferences: { browser: b } });
    assert.equal(value.preferences.browser, undefined);
  }
});
