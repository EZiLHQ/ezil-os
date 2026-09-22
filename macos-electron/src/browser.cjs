'use strict';
const path = require('node:path');
const { browserURL, browserRequestURL, lockSession, lockRemote, exact, uuid } = require('./policy.cjs');
const { privateDir } = require('./files.cjs');
const { PasskeyAccounts } = require('./passkeys.cjs');
function bounds(value, size) {
  exact(value, ['x', 'y', 'width', 'height']);
  if (['x', 'y', 'width', 'height'].some(k => !Number.isFinite(value[k]))) throw Error('Invalid bounds');
  const [width, height] = size, x = Math.min(width, Math.max(0, Math.round(value.x))), y = Math.min(height, Math.max(0, Math.round(value.y)));
  return { x, y, width: Math.max(0, Math.min(width - x, Math.round(value.width))), height: Math.max(0, Math.min(height - y, Math.round(value.height))) };
}
function scaleBounds(value, factor) {
  if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) throw Error('Invalid zoom factor');
  return Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, value[key] * factor]));
}
const ZOOM_STEPS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5]);
function zoomStep(factor, direction) {
  const current = Number.isFinite(factor) ? factor : 1;
  return direction > 0 ? ZOOM_STEPS.find(value => value > current + 0.001) ?? 5
    : ZOOM_STEPS.findLast(value => value < current - 0.001) ?? 0.25;
}
function browserSchema(input) {
  const fields = { create: ['bounds'], navigate: ['url'], back: [], forward: [], reload: [], 'zoom-in': [], 'zoom-out': [], 'zoom-reset': [], focus: [], layout: ['bounds'], visibility: ['visible'], destroy: [], hide: [], snapshot: [], restore: [] };
  if (!input || !Object.hasOwn(fields, input.op)) throw Error('Invalid browser operation');
  exact(input, ['op', 'workspaceId', 'generation', 'sequence', 'viewId', ...fields[input.op], ...(input.op === 'create' && input.url !== undefined ? ['url'] : [])]);
  uuid(input.workspaceId);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(input.viewId) || typeof input.generation !== 'string' || !Number.isSafeInteger(input.sequence) || input.sequence < 1) throw Error('Invalid browser identity');
  if (input.op === 'navigate' || (input.op === 'create' && input.url !== undefined)) browserURL(input.url);
  if (['create', 'layout'].includes(input.op)) bounds(input.bounds, [10000, 10000]);
  if (input.op === 'visibility' && typeof input.visible !== 'boolean') throw Error('Invalid visibility');
  return input;
}
class Browser {
  constructor(workspace, window, generation, { WebContentsView, session } = require('electron'), { offline = false, onState = () => {}, onShortcut = () => {}, onNewTab = () => {}, now = Date.now } = {}) {
    this.onState = onState; this.onShortcut = onShortcut; this.onNewTab = onNewTab; this.now = now; this.stateRevision = 0;
    this.workspace = workspace; this.window = window; this.generation = generation; this.sequence = 0; this.views = new Map(); this.closed = false;
    this.session = session.fromPath(privateDir(path.join(workspace.browser, 'profile')));
    lockSession(this.session);
    this.passkeys = new PasskeyAccounts(this.session, window, frame => {
      for (const item of this.views.values()) if (item.visible && !item.occluded && !item.view.webContents.isDestroyed()
          && frame?.top === item.view.webContents.mainFrame) return item.view.webContents;
      return null;
    });
    this.session.webRequest.onBeforeRequest((details, callback) => { try { browserRequestURL(details.url); if (offline && !['127.0.0.1', '[::1]', 'localhost'].includes(new URL(details.url).hostname)) throw Error('Offline smoke'); callback({}); } catch { callback({ cancel: true }); } });
    this.downloadHandler = (_event, item) => {
      const filename = path.basename(item.getFilename() || 'download');
      const directory = privateDir(path.join(workspace.files, 'Downloads'));
      item.setSaveDialogOptions({ defaultPath: path.join(directory, filename) });
    };
    this.session.on('will-download', this.downloadHandler);
    this.WebContentsView = WebContentsView;
    this.resize = () => { for (const item of this.views.values()) item.view.setBounds(bounds(item.bounds, this.window.getContentSize())); };
    this.dispose = () => { void this.close().catch(() => {}); };
    window.on('resize', this.resize); window.once('closed', this.dispose);
    window.webContents.once('destroyed', this.dispose);
    // Reload destroys all native children; a new shell must explicitly recreate them.
    this.navigation = (_event, _url, _inPlace, mainFrame) => { if (mainFrame) this.clear(); };
    window.webContents.on('did-start-navigation', this.navigation);
  }
  attach(item) {
    if (this.closed || item.view.webContents.isDestroyed()) return;
    const attached = this.window.contentView.children.includes(item.view);
    const visible = item.visible && !item.occluded;
    if (visible && !attached) this.window.contentView.addChildView(item.view);
    if (!visible && attached) this.window.contentView.removeChildView(item.view);
    item.view.setVisible(visible);
    this.passkeys.reconcile();
  }
  state(id) { const item = this.views.get(id); return item ? { ...item.state } : null; }
  publish(id, item, patch = {}) {
    if (this.closed || this.views.get(id) !== item || item.view.webContents.isDestroyed()) return;
    const wc = item.view.webContents;
    const observedZoom = wc.getZoomFactor?.();
    item.state = { ...item.state, ...patch, ...(Number.isFinite(observedZoom) && observedZoom >= 0.25 && observedZoom <= 5 ? { zoomFactor: observedZoom } : {}), revision: ++this.stateRevision,
      canGoBack: !!wc.navigationHistory?.canGoBack(), canGoForward: !!wc.navigationHistory?.canGoForward() };
    try { this.onState(id, this.state(id)); } catch { /* Consumer cannot break navigation. */ }
  }
  navigationFailed(id, item, url) {
    const patch = { loading: false, error: 'navigation_failed', title: '' };
    // A failed destination is still the address being retried. Never replace
    // it with a blank/previous address, or expose an internal/unsafe URL.
    try { patch.url = browserURL(url); } catch { /* Keep the last safe address. */ }
    this.publish(id, item, patch);
  }
  navigate(id, item, url) {
    const target = browserURL(url), token = ++item.navigation;
    item.target = target;
    this.publish(id, item, { loading: true, error: null });
    // A load promise can remain pending indefinitely. Never hold the operation queue.
    try {
      Promise.resolve(item.view.webContents.loadURL(target)).catch(error => {
        if (item.navigation === token && item.target === target && error?.code !== 'ERR_ABORTED' && error?.errno !== -3)
          this.navigationFailed(id, item, target);
      });
    } catch { this.navigationFailed(id, item, target); }
  }
  observe(id, item) {
    const wc = item.view.webContents;
    wc.on('did-start-navigation', (_event, url, _inPlace, mainFrame) => { if (mainFrame) { item.target = url; item.gestureAt = null; } });
    const commit = url => {
      try { this.publish(id, item, { url: browserURL(url), error: null }); } catch { /* Never expose internal URLs. */ }
    };
    wc.on('did-navigate', (_event, url) => commit(url));
    wc.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) commit(url); });
    wc.on('zoom-changed', () => this.publish(id, item));
    wc.on('did-finish-load', () => this.publish(id, item));
    wc.on('page-title-updated', (_event, title) => this.publish(id, item, { title: String(title).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512) }));
    wc.on('did-start-loading', () => this.publish(id, item, { loading: true, error: null }));
    wc.on('did-stop-loading', () => this.publish(id, item, { loading: !!wc.isLoading?.() }));
    wc.on('did-fail-load', (_event, code, _description, url, mainFrame) => {
      if (mainFrame && code !== -3 && url === item.target) this.navigationFailed(id, item, url);
    });
    wc.on('render-process-gone', () => this.publish(id, item, { loading: false, error: 'navigation_failed' }));
    wc.setWindowOpenHandler(({ url, disposition, postBody }) => {
      const gestureAt = item.gestureAt; item.gestureAt = null;
      // One explicit input may open one sandboxed tab. Background scripts may
      // not replace the page, create native windows, or transfer POST data.
      if (!this.closed && this.views.get(id) === item && item.visible && !item.occluded
          && gestureAt !== null && gestureAt !== undefined && this.now() - gestureAt <= 1500
          && ['default', 'foreground-tab', 'background-tab', 'new-window'].includes(disposition) && !postBody) {
        try { this.onNewTab(id, { url: browserURL(url), background: disposition === 'background-tab' }); } catch { /* Unsafe URLs and consumer failures stay denied. */ }
      }
      return { action: 'deny' };
    });
    wc.on('before-mouse-event', (_event, input) => {
      if (['mouseDown', 'mouseUp'].includes(input.type) && this.views.get(id) === item && item.visible && !item.occluded) item.gestureAt = this.now();
    });
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || this.views.get(id) !== item || !item.visible || item.occluded) return;
      if (!input.isAutoRepeat) item.gestureAt = this.now();
      const key = input.key?.toLowerCase();
      const action = input.control && !input.alt && key === 'tab' ? (input.shift ? 'previous-tab' : 'next-tab')
        : (input.meta || input.control) && !input.alt ? ({ l: 'address', r: 'reload', '[': input.shift ? 'previous-tab' : 'back', ']': input.shift ? 'next-tab' : 'forward', '{': 'previous-tab', '}': 'next-tab', t: 'new-tab', w: 'close-tab', '+': 'zoom-in', '=': 'zoom-in', '-': 'zoom-out', '0': 'zoom-reset' })[key]
        : input.alt && !input.meta && !input.control ? ({ arrowleft: 'back', arrowright: 'forward' })[key] : key === 'f5' ? 'reload' : null;
      if (action) { event.preventDefault(); item.gestureAt = null; if (['address', 'new-tab', 'close-tab', 'next-tab', 'previous-tab'].includes(action)) this.window.webContents.focus();
        try { this.onShortcut(id, action); } catch { /* Consumer isolation. */ } }
    });
  }
  async operation(raw) {
    const input = browserSchema(raw);
    if (this.closed || this.window.isDestroyed() || input.workspaceId !== this.workspace.id || input.generation !== this.generation || input.sequence <= this.sequence) throw Error('Stale browser operation');
    this.sequence = input.sequence;
    let item = this.views.get(input.viewId);
    if (input.op === 'create') {
      if (item || this.views.size >= 20) throw Error('View limit or duplicate');
      const view = new this.WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
      lockRemote(view.webContents);
      item = { view, bounds: input.bounds, visible: true, occluded: false, snapshot: null, revision: input.sequence, navigation: 0,
        state: { revision: 0, url: '', title: '', loading: false, error: null, canGoBack: false, canGoForward: false, zoomFactor: 1 } };
      this.views.set(input.viewId, item);
      this.observe(input.viewId, item); this.publish(input.viewId, item);
      view.webContents.once('destroyed', () => { if (this.views.get(input.viewId) === item) this.destroy(input.viewId); });
      view.setBounds(bounds(item.bounds, this.window.getContentSize())); this.attach(item);
      if (input.url !== undefined) this.navigate(input.viewId, item, input.url);
      return { state: 'created' };
    }
    if (!item) throw Error('Unknown view');
    item.revision = input.sequence;
    switch (input.op) {
      case 'navigate': item.snapshot = null; this.navigate(input.viewId, item, input.url); break;
      case 'back': if (item.view.webContents.navigationHistory?.canGoBack()) { item.navigation++; item.view.webContents.navigationHistory.goBack(); } break;
      case 'forward': if (item.view.webContents.navigationHistory?.canGoForward()) { item.navigation++; item.view.webContents.navigationHistory.goForward(); } break;
      case 'reload': item.navigation++; item.view.webContents.reload(); break;
      case 'zoom-in': item.view.webContents.setZoomFactor(zoomStep(item.view.webContents.getZoomFactor?.(), 1)); this.publish(input.viewId, item); break;
      case 'zoom-out': item.view.webContents.setZoomFactor(zoomStep(item.view.webContents.getZoomFactor?.(), -1)); this.publish(input.viewId, item); break;
      case 'zoom-reset': item.view.webContents.setZoomFactor(1); this.publish(input.viewId, item); break;
      case 'focus': if (item.visible && !item.occluded) item.view.webContents.focus(); break;
      case 'layout': item.bounds = input.bounds; this.resize(); break;
      case 'visibility': item.visible = input.visible; if (!item.visible) item.gestureAt = null; this.attach(item); break;
      case 'destroy': this.destroy(input.viewId); break;
      case 'hide': item.occluded = true; item.gestureAt = null; item.snapshot = null; this.attach(item); break;
      case 'snapshot': {
        item.occluded = true; this.attach(item);
        let image;
        try { image = await item.view.webContents.capturePage(); }
        catch {
          // Some Chromium platforms cannot capture a detached WebContentsView.
          // Occlusion is the security boundary; a missing decorative snapshot
          // must not make hiding the native surface fail.
          if (this.closed || this.views.get(input.viewId) !== item || item.revision !== input.sequence) throw Error('Stale snapshot');
          item.snapshot = null;
          return { state: 'hidden' };
        }
        if (this.closed || this.views.get(input.viewId) !== item || item.revision !== input.sequence) throw Error('Stale snapshot');
        const snapshot = image.resize({ width: Math.min(1600, Math.max(1, item.view.getBounds().width)) }).toDataURL();
        item.snapshot = snapshot.length <= 2_000_000 ? snapshot : null;
        item.occluded = true; this.attach(item);
        return { state: 'hidden', ...(item.snapshot ? { snapshot: item.snapshot } : {}) };
      }
      case 'restore': item.snapshot = null; item.occluded = false; this.attach(item); break;
    }
    return { state: input.op === 'hide' ? 'hidden' : 'updated' };
  }
  destroy(id) {
    const item = this.views.get(id); if (!item) return;
    this.views.delete(id); item.snapshot = null;
    this.passkeys.reconcile();
    if (!this.window.isDestroyed() && this.window.contentView.children.includes(item.view)) this.window.contentView.removeChildView(item.view);
    if (!item.view.webContents.isDestroyed()) item.view.webContents.close();
  }
  clear() { for (const id of [...this.views.keys()]) this.destroy(id); }
  async close() {
    if (this.closed) return; this.closed = true; this.passkeys.close(); this.clear();
    this.window.removeListener('resize', this.resize); this.window.removeListener('closed', this.dispose);
    this.window.webContents.removeListener('destroyed', this.dispose); this.window.webContents.removeListener('did-start-navigation', this.navigation);
    this.session.removeListener('will-download', this.downloadHandler);
    await this.session.closeAllConnections();
  }
  async retire() { await this.close(); await this.session.clearStorageData(); await this.session.clearCache(); }
}
module.exports = { Browser, bounds, scaleBounds, browserSchema, zoomStep };
