'use strict';
const path = require('node:path');
const { browserURL, browserRequestURL, lockSession, lockRemote, exact, uuid } = require('./policy.cjs');
const { privateDir } = require('./files.cjs');
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
function browserSchema(input) {
  const fields = { create: ['bounds'], navigate: ['url'], back: [], forward: [], reload: [], focus: [], layout: ['bounds'], visibility: ['visible'], destroy: [], hide: [], snapshot: [], restore: [] };
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
  constructor(workspace, window, generation, { WebContentsView, session } = require('electron'), { offline = false } = {}) {
    this.workspace = workspace; this.window = window; this.generation = generation; this.sequence = 0; this.views = new Map(); this.closed = false;
    this.session = session.fromPath(privateDir(path.join(workspace.browser, 'profile')));
    lockSession(this.session);
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
    const attached = this.window.contentView.children.includes(item.view);
    const visible = item.visible && !item.occluded;
    if (visible && !attached) this.window.contentView.addChildView(item.view);
    if (!visible && attached) this.window.contentView.removeChildView(item.view);
    item.view.setVisible(visible);
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
      item = { view, bounds: input.bounds, visible: true, occluded: false, snapshot: null, revision: input.sequence };
      this.views.set(input.viewId, item);
      view.webContents.once('destroyed', () => { if (this.views.get(input.viewId) === item) this.destroy(input.viewId); });
      view.setBounds(bounds(item.bounds, this.window.getContentSize())); this.attach(item);
      try {
        if (input.url !== undefined) await view.webContents.loadURL(browserURL(input.url));
        if (this.closed || this.views.get(input.viewId) !== item || item.revision !== input.sequence) throw Error('Stale create');
        return { state: 'created' };
      } catch {
        if (this.views.get(input.viewId) === item) this.destroy(input.viewId);
        throw Error('Browser creation failed');
      }
    }
    if (!item) throw Error('Unknown view');
    item.revision = input.sequence;
    switch (input.op) {
      case 'navigate': item.snapshot = null; await item.view.webContents.loadURL(browserURL(input.url)); break;
      case 'back': if (item.view.webContents.navigationHistory?.canGoBack()) item.view.webContents.navigationHistory.goBack(); break;
      case 'forward': if (item.view.webContents.navigationHistory?.canGoForward()) item.view.webContents.navigationHistory.goForward(); break;
      case 'reload': item.view.webContents.reload(); break;
      case 'focus': if (item.visible && !item.occluded) item.view.webContents.focus(); break;
      case 'layout': item.bounds = input.bounds; this.resize(); break;
      case 'visibility': item.visible = input.visible; this.attach(item); break;
      case 'destroy': this.destroy(input.viewId); break;
      case 'hide': item.occluded = true; item.snapshot = null; this.attach(item); break;
      case 'snapshot': {
        const image = await item.view.webContents.capturePage();
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
    if (!this.window.isDestroyed() && this.window.contentView.children.includes(item.view)) this.window.contentView.removeChildView(item.view);
    if (!item.view.webContents.isDestroyed()) item.view.webContents.close();
  }
  clear() { for (const id of [...this.views.keys()]) this.destroy(id); }
  async close() {
    if (this.closed) return; this.closed = true; this.clear();
    this.window.removeListener('resize', this.resize); this.window.removeListener('closed', this.dispose);
    this.window.webContents.removeListener('destroyed', this.dispose); this.window.webContents.removeListener('did-start-navigation', this.navigation);
    this.session.removeListener('will-download', this.downloadHandler);
    await this.session.closeAllConnections();
  }
  async retire() { await this.close(); await this.session.clearStorageData(); await this.session.clearCache(); }
}
module.exports = { Browser, bounds, scaleBounds, browserSchema };
