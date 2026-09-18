'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { schema, runtimeSchema, browserURL, browserRequestURL, partition, senderAllowed, lockSession, lockRemote } = require('../src/policy.cjs');
const { readyLine } = require('../src/helper.cjs');
const { capabilities } = require('../src/policy.cjs');
test('strict native schemas reject injection, extra fields and malformed identifiers', () => {
  const id = randomUUID(); assert.equal(schema({ op: 'open', id }).id, id);
  for (const input of [{ op: 'open', id: '../../x' }, { op: 'create', name: 'ok', command: 'id' }, { op: 'exec', command: 'id' }, { op: 'provider', action: 'iam' }, { op: 'browserAction', action: 'select', tab: -1 }, { op: 'open', id, url: 'https://example.com' }]) assert.throws(() => schema(input));
});
test('v2 runtime schema accepts typed surfaces and rejects executable or remote HTTP input', () => {
  const workspaceId = randomUUID(), surfaceId = randomUUID(), base = { workspaceId, surfaceId, generation: 1, sequence: 1 };
  assert.equal(runtimeSchema({ ...base, op: 'code.open' }).op, 'code.open');
  assert.equal(runtimeSchema({ ...base, op: 'browser.navigate', url: 'https://example.com/' }).op, 'browser.navigate');
  assert.equal(runtimeSchema({ op: 'provider.configure', action: 'azure' }).action, 'azure');
  assert.equal(runtimeSchema({ op: 'workspace.import' }).op, 'workspace.import');
  for (const input of [{ ...base, op: 'browser.navigate', url: 'http://example.com/' }, { ...base, op: 'code.open', command: 'id' }, { ...base, op: 'browser.layout', bounds: { x: 0, y: 0, width: -1, height: 1 }, visible: true, occluded: false }, { op: 'provider.configure', action: 'iam' }, { op: 'workspace.import', source: '/tmp/project' }]) assert.throws(() => runtimeSchema(input));
});
test('HTTPS and exact loopback only; no URL credentials', () => {
  for (const url of ['https://example.com/a', 'http://127.0.0.1:3000/', 'http://localhost:3000/', 'http://[::1]:3000/']) assert.ok(browserURL(url));
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'http://example.com', 'http://localhost.evil/', 'https://u:p@example.com', 'ftp://example.com']) assert.throws(() => browserURL(url));
});
test('browser subresources allow secure WebSockets and loopback HMR only', () => {
  for (const url of ['wss://example.com/socket', 'ws://127.0.0.1:3000/hmr', 'ws://localhost:5173/hmr']) assert.ok(browserRequestURL(url));
  for (const url of ['ws://example.com/socket', 'wss://u:p@example.com/socket', 'file:///tmp/socket']) assert.throws(() => browserRequestURL(url));
});
test('partitions stable per random workspace and different across workspaces', () => {
  const a = randomUUID(), b = randomUUID(); assert.equal(partition(a), partition(a)); assert.notEqual(partition(a), partition(b)); assert.ok(partition(a).startsWith('persist:')); assert.throws(() => partition('../profile'));
});
test('IPC requires registered contents, exact document and top frame', () => {
  const frame = { url: 'http://127.0.0.1:1234/' }, wc = { mainFrame: frame };
  assert.ok(senderAllowed({ sender: wc, senderFrame: frame }, wc, frame.url));
  assert.equal(senderAllowed({ sender: wc, senderFrame: { url: frame.url } }, wc, frame.url), false);
  assert.equal(senderAllowed({ sender: {}, senderFrame: frame }, wc, frame.url), false);
  assert.equal(senderAllowed({ sender: wc, senderFrame: frame }, wc, 'https://evil.test'), false);
});
test('permissions, device requests and popups default deny', () => {
  let permission, check, device, popup; const events = {};
  lockSession({ setPermissionRequestHandler: v => { permission = v; }, setPermissionCheckHandler: v => { check = v; }, setDevicePermissionHandler: v => { device = v; }, on() {} });
  permission({}, 'camera', result => assert.equal(result, false)); assert.equal(check(), false); assert.equal(device(), false);
  lockRemote({ setWindowOpenHandler: v => { popup = v; }, on: (name, fn) => { events[name] = fn; } });
  assert.deepEqual(popup({ url: 'https://example.com' }), { action: 'deny' });
  let blocked = false; events['will-redirect']({ preventDefault: () => { blocked = true; } }, 'file:///tmp/file'); assert.ok(blocked);
});
test('helper ready line strictly verifies version, port and capabilities', () => {
  assert.equal(readyLine('ordinary diagnostic'), null);
  assert.equal(readyLine('EZIL_NATIVE_READY ' + JSON.stringify({ contractVersion: 2, port: 1234, capabilities })).port, 1234);
  for (const value of [{ contractVersion: 1, port: 1, capabilities }, { contractVersion: 2, port: 65536, capabilities }, { contractVersion: 2, port: 1234, capabilities: { ...capabilities, isolation: 'container' } }]) assert.throws(() => readyLine('EZIL_NATIVE_READY ' + JSON.stringify(value)));
});
