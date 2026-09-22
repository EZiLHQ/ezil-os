'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Browser } = require('../src/browser.cjs');

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-browser-')));
  const session = Object.assign(new EventEmitter(), { setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {},
    webRequest: { onBeforeRequest() {} }, closeAllConnections: async () => {} });
  class WC extends EventEmitter {
    navigationHistory = { canGoBack: () => true, canGoForward: () => false, goBack() {}, goForward() {} };
    loads = []; url = ''; focused = 0; zoomFactor = 1;
    setWindowOpenHandler(handler) { this.popup = handler; }
    isDestroyed() { return !!this.dead; }
    getURL() { return this.url; }
    loadURL(url) { return new Promise((resolve, reject) => this.loads.push({ url, resolve, reject })); }
    focus() { this.focused++; }
    getZoomFactor() { return this.zoomFactor; }
    setZoomFactor(value) { this.zoomFactor = value; }
    close() { this.dead = true; this.emit('destroyed'); }
    capturePage() { return new Promise(resolve => { this.capture = resolve; }); }
  }
  class View { constructor(options) { this.options = options; this.webContents = new WC(); } setBounds(b) { this.bounds = b; } getBounds() { return this.bounds; } setVisible(v) { this.visible = v; } }
  const window = Object.assign(new EventEmitter(), { isDestroyed: () => false, getContentSize: () => [1000, 800], webContents: new WC(),
    contentView: { children: [], addChildView(v) { this.children.push(v); }, removeChildView(v) { this.children = this.children.filter(x => x !== v); } } });
  const states = [], shortcuts = [], newTabs = [], workspace = { id: randomUUID(), browser: root, files: root };
  let now = 100;
  const browser = new Browser(workspace, window, 'g', { WebContentsView: View, session: { fromPath: () => session } }, {
    onState: (id, state) => states.push({ id, ...state }), onShortcut: (id, action) => shortcuts.push({ id, action }),
    onNewTab: (id, value) => newTabs.push({ id, ...value }), now: () => now,
  });
  let sequence = 0;
  const op = (op, fields = {}) => browser.operation({ op, workspaceId: workspace.id, generation: 'g', viewId: 'one', sequence: ++sequence, ...fields });
  t.after(async () => { await browser.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { browser, window, states, shortcuts, newTabs, op, advance: ms => { now += ms; } };
}
test('pending navigation never blocks composition; state is committed and destroyed views stay dead', async t => {
  const { browser, op, states } = fixture(t);
  await op('create', { bounds: { x: 0, y: 0, width: 800, height: 600 }, url: 'https://example.com' });
  const item = browser.views.get('one'), wc = item.view.webContents;
  assert.equal(item.view.options.webPreferences.sandbox, true);
  assert.equal(browser.state('one').url, '');
  await op('layout', { bounds: { x: 4, y: 8, width: 300, height: 200 } });
  await op('hide'); assert.equal(item.view.visible, false);
  await op('restore'); await op('focus'); assert.equal(wc.focused, 1);
  await op('navigate', { url: 'https://second.example/' });
  wc.loads[0].reject(Error('old private error'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.state('one').error, null);
  wc.url = 'https://redirect.example/'; wc.emit('did-navigate', {}, wc.url);
  wc.emit('page-title-updated', {}, 'A\n' + 'x'.repeat(800));
  wc.emit('did-stop-loading');
  assert.equal(browser.state('one').url, wc.url); assert.equal(browser.state('one').title.length, 512);
  assert.equal(browser.state('one').loading, false); assert.equal(browser.state('one').canGoBack, true);
  assert.ok(states.every((state, i) => state.revision > (states[i - 1]?.revision ?? 0)));
  const pending = op('snapshot'); assert.equal(item.view.visible, false);
  await op('destroy'); const count = states.length;
  wc.loads[1].reject(Error('late private error')); wc.emit('did-stop-loading');
  wc.capture({ resize() { return this; }, toDataURL() { return 'data:image/png;base64,AAAA'; } });
  await assert.rejects(pending, /Stale snapshot/);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(states.length, count); assert.equal(browser.state('one'), null);
});
test('user popups request sandboxed tabs without replacing the original page; shortcuts are routed', async t => {
  const { browser, op, shortcuts, newTabs, window, advance } = fixture(t);
  await op('create', { bounds: { x: 0, y: 0, width: 800, height: 600 } });
  const wc = browser.views.get('one').view.webContents;
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'http://example.com', 'https://user:pass@example.com']) {
    assert.deepEqual(wc.popup({ url }), { action: 'deny' });
    await assert.rejects(op('navigate', { url }));
  }
  assert.equal(wc.loads.length, 0);
  const popup = { url: 'https://example.com/', disposition: 'foreground-tab' };
  assert.deepEqual(wc.popup(popup), { action: 'deny' }); assert.equal(newTabs.length, 0, 'no input means no popup');
  const click = () => wc.emit('before-mouse-event', {}, { type: 'mouseUp', button: 'left' });
  click(); assert.deepEqual(wc.popup(popup), { action: 'deny' });
  assert.deepEqual(newTabs, [{ id: 'one', url: popup.url, background: false }]); assert.equal(wc.loads.length, 0);
  wc.popup(popup); assert.equal(newTabs.length, 1, 'one gesture cannot create a popup storm');
  click(); wc.popup({ ...popup, disposition: 'background-tab' }); assert.equal(newTabs.at(-1).background, true);
  click(); advance(1600); wc.popup(popup); assert.equal(newTabs.length, 2, 'expired input is rejected');
  for (const extra of [{ url: 'file:///private' }, { postBody: { data: [] } }, { disposition: 'other' }]) {
    click(); wc.popup({ ...popup, ...extra }); assert.equal(newTabs.length, 2);
  }
  let prevented = 0;
  wc.emit('before-input-event', { preventDefault() { prevented++; } }, { type: 'keyDown', key: 'l', meta: true });
  assert.equal(prevented, 1); assert.equal(window.webContents.focused, 1);
  assert.deepEqual(shortcuts, [{ id: 'one', action: 'address' }]);
  for (const [input, action] of [
    [{ key: 't', meta: true }, 'new-tab'], [{ key: 'w', meta: true }, 'close-tab'],
    [{ key: 'Tab', control: true }, 'next-tab'], [{ key: 'Tab', control: true, shift: true }, 'previous-tab'],
    [{ key: '[', meta: true, shift: true }, 'previous-tab'], [{ key: ']', meta: true, shift: true }, 'next-tab'],
    [{ key: '{', meta: true, shift: true }, 'previous-tab'], [{ key: '}', meta: true, shift: true }, 'next-tab'],
    [{ key: '=', meta: true }, 'zoom-in'], [{ key: '+', control: true }, 'zoom-in'],
    [{ key: '-', meta: true }, 'zoom-out'], [{ key: '0', meta: true }, 'zoom-reset'],
  ]) {
    wc.emit('before-input-event', { preventDefault() {} }, { type: 'keyDown', ...input });
    assert.equal(shortcuts.at(-1).action, action);
  }
  await op('hide'); wc.emit('before-input-event', { preventDefault() { prevented++; } }, { type: 'keyDown', key: 'r', meta: true });
  assert.equal(prevented, 1);
  click(); wc.popup(popup); assert.equal(newTabs.length, 2, 'occluded pages cannot request tabs');
});
test('page zoom uses finite Chromium factors and publishes externally observed changes', async t => {
  const { browser, op } = fixture(t);
  await op('create', { bounds: { x: 0, y: 0, width: 800, height: 600 } });
  const wc = browser.views.get('one').view.webContents;
  assert.equal(browser.state('one').zoomFactor, 1);
  await op('zoom-in'); assert.equal(wc.zoomFactor, 1.1); assert.equal(browser.state('one').zoomFactor, 1.1);
  await op('zoom-out'); assert.equal(wc.zoomFactor, 1);
  wc.zoomFactor = 1.25; wc.emit('zoom-changed', {}, 'in');
  assert.equal(browser.state('one').zoomFactor, 1.25, 'host observation is authoritative');
  await op('zoom-reset'); assert.equal(wc.zoomFactor, 1);
  for (let i = 0; i < 30; i++) await op('zoom-out');
  assert.equal(wc.zoomFactor, 0.25);
  for (let i = 0; i < 40; i++) await op('zoom-in');
  assert.equal(wc.zoomFactor, 5);
});
test('failed navigations expose only fixed codes and subframes never replace committed state', async t => {
  const { browser, op } = fixture(t);
  await op('create', { bounds: { x: 0, y: 0, width: 800, height: 600 }, url: 'https://example.com/' });
  const wc = browser.views.get('one').view.webContents;
  wc.loads[0].reject(Error('sensitive diagnostic'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(browser.state('one').error, 'navigation_failed');
  assert.equal(browser.state('one').url, 'https://example.com/', 'failed destination stays visible for retry');
  wc.emit('did-navigate-in-page', {}, 'https://frame.example/', false);
  assert.equal(browser.state('one').url, 'https://example.com/');
  wc.emit('did-navigate', {}, 'https://example.com/');
  wc.emit('did-navigate-in-page', {}, 'https://example.com/#section', true);
  assert.equal(browser.state('one').url, 'https://example.com/#section');
  assert.equal(browser.state('one').error, null);
  wc.emit('did-navigate', {}, 'file:///private');
  assert.equal(browser.state('one').url, 'https://example.com/#section');
  await op('navigate', { url: 'http://localhost:32123/' });
  wc.emit('did-fail-load', {}, -102, 'private diagnostic', 'http://localhost:32123/', true);
  assert.equal(browser.state('one').url, 'http://localhost:32123/');
  assert.equal(browser.state('one').error, 'navigation_failed');
  wc.emit('did-fail-load', {}, -102, 'old private diagnostic', 'https://example.com/', true);
  assert.equal(browser.state('one').url, 'http://localhost:32123/', 'old failure never replaces current destination');
});
