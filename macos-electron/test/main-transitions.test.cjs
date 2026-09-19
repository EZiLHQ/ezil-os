'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require.resolve('../src/main.cjs'), 'utf8');
// Exercise the actual host functions without starting Electron or loading services.
function definition(name) {
  const start = source.search(new RegExp(`^  (?:async )?function ${name}\\(`, 'm'));
  assert.ok(start >= 0);
  const rest = source.slice(start + 1);
  const end = rest.search(/^  (?:(?:async )?function |ipcMain\.)/m);
  assert.ok(end >= 0);
  return source.slice(start, start + 1 + end);
}
function fixture() {
  const active = { workspace: { id: 'active' }, generation: 'host', surfaces: new Map(), browserIdentities: new Map(), browserSequence: 0 };
  const actions = [], deferred = [], sent = [], views = new Map();
  const context = vm.createContext({ host: active, current: active, workspace: active.workspace, transitioning: false, booting: false, quitting: false,
    removingWorkspaces: new Set(), setImmediate: fn => deferred.push(fn),
    confirmLeave: async () => true, note() {}, showRecovery: () => actions.push('recovery'),
    editors: { state: () => 'stopped' }, embedded: { state: () => 'stopped', stop: async () => {} },
    store: { get: id => ({ id }), list: () => [{ id: 'active' }, { id: 'missing', available: false }, { id: 'available', available: true }],
      create: () => ({ id: 'new' }), remove: id => actions.push(`remove:${id}`) },
    window: { isDestroyed: () => false, webContents: { send: (channel, value) => sent.push({ channel, ...value }), getZoomFactor: () => 1 } },
    scaleBounds: value => value,
  });
  active.window = context.window;
  context.closeWorkspace = async () => { actions.push('close'); context.current = null; };
  context.openWorkspace = async id => { actions.push(`open:${id}`); context.current = { workspace: { id } }; };
  const eventStart = source.indexOf('      const browserEvent =');
  const eventEnd = source.indexOf('      host.browser = new Browser', eventStart);
  vm.runInContext(source.slice(eventStart, eventEnd) + '\nthis.emitBrowser = browserEvent;', context);
  active.browser = {
    destroy(id) { actions.push(`destroy:${id}`); context.emitBrowser('state', id, { revision: 999 }); views.delete(id); },
    async operation(input) {
      actions.push(`${input.op}:${input.viewId}`);
      if (input.op === 'create') { assert.ok(!views.has(input.viewId)); views.set(input.viewId, { revision: 1 }); context.emitBrowser('state', input.viewId, { revision: 1 }); }
      if (input.op === 'destroy') this.destroy(input.viewId);
      return { state: 'updated' };
    },
    state: id => views.get(id),
  };
  for (const name of ['changeWorkspace', 'acceptSurface', 'surfaceResult', 'browserOperation', 'runtimeOperation']) vm.runInContext(definition(name), context);
  return { context, active, actions, deferred, sent, views };
}
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve)); };
test('workspace cleanup attempts every component even when one fails and still rejects unsafe removal', async () => {
  for (const broken of ['', 'browser', 'editor', 'helper']) {
    const calls = [];
    const action = name => async () => { calls.push(name); if (broken === name) throw Error('private failure detail'); };
    const window = { isDestroyed: () => false, destroy: action('window'), webContents: { executeJavaScript: async () => {} } };
    const host = { workspace: { id: 'fixture' }, window, gateway: { close: action('gateway') },
      browser: { retire: action('browser') }, helper: { close: action('helper') },
      shellSession: { closeAllConnections: action('connections'), clearStorageData: action('storage'), clearCache: action('cache') } };
    const c = vm.createContext({ current: host, desktop: window, closing: null, setTimeout, clearTimeout, clearInterval,
      embedded: { stop: action('editor') }, note: code => calls.push(code) });
    vm.runInContext(definition('closeWorkspace'), c);
    if (broken) await assert.rejects(c.closeWorkspace(true), /Workspace cleanup incomplete/);
    else await c.closeWorkspace(true);
    assert.deepEqual(calls, ['gateway', 'browser', 'editor', 'helper', 'window', 'connections', 'storage', 'cache', ...(broken ? ['WORKSPACE_CLEANUP_FAILED'] : [])]);
    assert.equal(c.current, null); assert.equal(c.desktop, null); assert.equal(c.closing, null);
  }
});
test('replacement retires old Browser view and never relabels old state or shortcuts', async () => {
  const { context: c, active, sent, views, actions } = fixture();
  const input = { op: 'browser.attach', workspaceId: 'active', surfaceId: 'surface', generation: 1, sequence: 1 };
  await c.runtimeOperation(active, input);
  assert.equal(sent.at(-1).generation, 1);
  await c.runtimeOperation(active, { ...input, generation: 2 });
  assert.deepEqual([...views.keys()], ['surface_2']);
  assert.ok(actions.indexOf('destroy:surface_1') < actions.indexOf('create:surface_2'));
  const count = sent.length;
  c.emitBrowser('state', 'surface_1', { revision: 1000 }); c.emitBrowser('shortcut', 'surface_1', { action: 'address' });
  assert.equal(sent.length, count);
  c.emitBrowser('shortcut', 'surface_2', { action: 'address', generation: 99 });
  assert.equal(sent.at(-1).generation, 2); assert.equal(sent.at(-1).surfaceId, 'surface');
  await assert.rejects(c.runtimeOperation(active, { ...input, sequence: 2 }), /Stale surface/);
  await c.runtimeOperation(active, { ...input, op: 'browser.detach', generation: 2, sequence: 2 });
  const detached = sent.length; c.emitBrowser('state', 'surface_2', { revision: 5 }); assert.equal(sent.length, detached);
});
test('an old layout continuation cannot mutate a replacement view', async () => {
  const { context: c, active, actions } = fixture();
  const input = { op: 'browser.attach', workspaceId: 'active', surfaceId: 'surface', generation: 1, sequence: 1 };
  await c.runtimeOperation(active, input);
  let release;
  const operation = active.browser.operation.bind(active.browser);
  active.browser.operation = op => op.op === 'hide' ? new Promise(resolve => { release = resolve; }) : operation(op);
  const pending = c.runtimeOperation(active, { ...input, op: 'browser.layout', sequence: 2, visible: false, occluded: true, bounds: {} });
  const rejected = assert.rejects(pending, /Stale browser surface/);
  await c.runtimeOperation(active, { ...input, generation: 2 }); release({}); await rejected;
  assert.ok(!actions.includes('layout:surface_2')); assert.ok(!actions.includes('visibility:surface_2'));
});
test('surface tombstones are bounded and slot reuse still rejects every older generation', async () => {
  const { context: c, active } = fixture();
  const input = { op: 'browser.attach', workspaceId: 'active', surfaceId: 'slot', generation: 1, sequence: 1 };
  for (let generation = 1; generation <= 300; generation++) {
    await c.runtimeOperation(active, { ...input, generation });
    await c.runtimeOperation(active, { ...input, op: 'browser.detach', generation, sequence: 2 });
  }
  assert.equal(active.surfaces.size, 1); assert.equal(active.browserIdentities.size, 0);
  await assert.rejects(c.runtimeOperation(active, input), /Stale surface/);
  for (let i = 1; i < 4096; i++) active.surfaces.set(`retired-${i}`, { closed: true });
  await assert.rejects(c.runtimeOperation(active, { ...input, surfaceId: 'unexpected' }), /identity limit/);
  assert.equal(active.surfaces.size, 4096);
  await c.runtimeOperation(active, { ...input, generation: 301 });
  await assert.rejects(c.runtimeOperation(active, { ...input, generation: 300, sequence: 99 }), /Stale surface/);
});
test('removal locks confirmation through fallback startup and skips missing folders', async () => {
  const { context: c, active, actions, deferred } = fixture();
  let confirm, finishOpen;
  c.confirmLeave = () => new Promise(resolve => { confirm = resolve; });
  c.openWorkspace = id => new Promise(resolve => { actions.push(`open:${id}`); finishOpen = resolve; });
  const pending = c.runtimeOperation(active, { op: 'workspace.remove', workspaceId: 'active' });
  assert.equal(c.transitioning, true);
  assert.equal((await c.runtimeOperation(active, { op: 'workspace.select', workspaceId: 'available' })).canceled, true);
  assert.equal(await c.changeWorkspace('available'), false);
  confirm(true); assert.equal((await pending).ok, true);
  deferred.shift()(); await settle();
  assert.deepEqual(actions, ['close', 'remove:active', 'open:available']); assert.equal(c.transitioning, true);
  finishOpen(); await settle(); assert.equal(c.transitioning, false);
});
test('canceled, failed, or stale confirmation releases lock without removing workspace', async () => {
  for (const mode of ['cancel', 'throw', 'stale']) {
    const { context: c, active, actions } = fixture();
    c.confirmLeave = async () => { if (mode === 'throw') throw Error('dialog failed'); if (mode === 'stale') c.current = {}; return mode !== 'cancel'; };
    const pending = c.runtimeOperation(active, { op: 'workspace.remove', workspaceId: 'active' });
    if (mode === 'throw') await assert.rejects(pending, /dialog failed/); else assert.equal((await pending).ok, false);
    assert.equal(c.transitioning, false); assert.deepEqual(actions, []);
  }
});
test('stale deferred removal does nothing; no available fallback creates a workspace', async () => {
  const first = fixture();
  await first.context.runtimeOperation(first.active, { op: 'workspace.remove', workspaceId: 'active' });
  first.context.current = {}; first.deferred.shift()(); await settle();
  assert.deepEqual(first.actions, []); assert.equal(first.context.transitioning, false);
  const second = fixture(); second.context.store.list = () => [{ id: 'active' }, { id: 'missing', available: false }];
  await second.context.runtimeOperation(second.active, { op: 'workspace.remove', workspaceId: 'active' });
  second.deferred.shift()(); await settle();
  assert.deepEqual(second.actions, ['close', 'remove:active', 'open:new']); assert.equal(second.context.transitioning, false);
});
test('fallback failure and selection dialog failure release transition ownership', async () => {
  const { context: c, active, actions, deferred } = fixture();
  c.openWorkspace = async () => { throw Error('fallback unavailable'); };
  await c.runtimeOperation(active, { op: 'workspace.remove', workspaceId: 'active' });
  deferred.shift()(); await settle();
  assert.equal(c.transitioning, false); assert.equal(c.removingWorkspaces.size, 0); assert.equal(actions.at(-1), 'recovery');
  c.current = active; c.confirmLeave = async () => { throw Error('dialog failed'); };
  await assert.rejects(c.runtimeOperation(active, { op: 'workspace.select', workspaceId: 'available' }), /dialog failed/);
  assert.equal(c.transitioning, false);
});
