'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { randomUUID } = require('node:crypto');
const { surfaceSchema } = require('../src/policy.cjs');
const { operation } = require('../src/surfaces.cjs');
const id = randomUUID(), url = 'http://127.0.0.1:1234/os';
const frame = { url }, wc = { mainFrame: frame };
const caller = { role: 'desktop', url, wc }, event = { sender: wc, senderFrame: frame };
const input = { op: 'surface.open', workspaceId: id, surface: 'code' };
const unavailable = { ok: false, state: 'unavailable' };
test('surface schema accepts only both typed operations and known surfaces', () => {
  for (const op of ['surface.open', 'surface.focus']) for (const surface of ['code', 'browser']) assert.deepEqual(surfaceSchema({ ...input, op, surface }), { ...input, op, surface });
  for (const extra of [{ url: 'https://example.com' }, { executable: '/bin/sh' }, { args: [] }, { id }, { workspaceId: '../x' }, { surface: 'terminal' }, { op: 'exec' }]) assert.throws(() => surfaceSchema({ ...input, ...extra }));
  for (const value of [null, [], { op: input.op }, Object.create(input)]) assert.throws(() => surfaceSchema(value));
});
test('surface dispatch authenticates top frame, origin, role and workspace before opening', async () => {
  let calls = 0; const open = async () => { calls++; return true; };
  assert.deepEqual(await operation(event, input, caller, id, open), { ok: true, state: 'opened' });
  for (const [e, c, active] of [
    [{ ...event, sender: {} }, caller, id],
    [{ ...event, senderFrame: { url } }, caller, id],
    [event, { ...caller, url: 'http://127.0.0.1:9999/os' }, id],
    [event, { ...caller, role: 'welcome' }, id],
    [event, caller, randomUUID()], [event, undefined, id]
  ]) assert.deepEqual(await operation(e, input, c, active, open), unavailable);
  assert.equal(calls, 1);
});
test('surface results never reflect capabilities, launch diagnostics or exceptions', async () => {
  for (const open of [async () => false, async () => ({ capability: 'secret' }), async () => { throw Error('secret'); }]) assert.deepEqual(await operation(event, input, caller, id, open), unavailable);
});
test('sandbox preload exposes operation alongside request and strips IPC payloads', async () => {
  const runtimeInput = { op: 'code.open', workspaceId: id, surfaceId: randomUUID(), generation: 1, sequence: 1 };
  let bridge, calls = 0, result = { ...runtimeInput, ok: true, state: 'ready', url: 'http://127.0.0.1:8443/', capability: 'secret' };
  const context = vm.createContext({ require: name => {
    assert.equal(name, 'electron');
    return { contextBridge: { exposeInMainWorld: (_name, value) => { bridge = value; } }, ipcRenderer: { invoke: async channel => { assert.equal(channel, 'ezil:runtime:v2'); calls++; return result; } } };
  } });
  vm.runInContext(fs.readFileSync(require.resolve('../src/preload.cjs'), 'utf8'), context);
  const invoke = value => bridge.operation(vm.runInContext(`(${JSON.stringify(value)})`, context));
  assert.equal(typeof bridge.request, 'function');
  const opened = await invoke(runtimeInput);
  assert.equal(opened.state, 'ready'); assert.equal(opened.url, 'http://127.0.0.1:8443/'); assert.equal(opened.capability, undefined);
  assert.equal(calls, 1);
  result = { ok: false, error: 'secret' };
  assert.equal(JSON.stringify(await invoke(runtimeInput)), JSON.stringify(unavailable));
});
