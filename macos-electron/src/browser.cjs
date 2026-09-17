'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { BrowserWindow, WebContentsView, session, dialog } = require('electron');
const { browserURL, partition, lockSession, lockRemote } = require('./policy.cjs');
const { atomic, readJSON, privateDir } = require('./files.cjs');
const TOP = 108;
class Browser {
  constructor(workspace, register, onClose) {
    this.workspace = workspace; this.tabs = []; this.active = 0;
    this.stateFile = path.join(workspace.browser, 'tabs.json');
    // fromPath creates an isolated persistent Chromium session, located inside
    // the inventoried workspace. It never uses Chrome/Safari/WebKit profiles.
    this.partition = partition(workspace.id);
    this.session = session.fromPath(privateDir(path.join(workspace.browser, 'profile')));
    lockSession(this.session);
    this.session.webRequest.onBeforeRequest((details, callback) => {
      try { browserURL(details.url); callback({}); } catch { callback({ cancel: true }); }
    });
    this.window = new BrowserWindow({ title: 'EZiL Browser', width: 1200, height: 850, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const toolbarURL = pathToFileURL(path.join(__dirname, '../ui/browser.html')).href;
    register(this.window.webContents, toolbarURL, 'browser', this);
    lockRemote(this.window.webContents);
    this.window.webContents.on('will-navigate', event => event.preventDefault());
    this.window.loadURL(toolbarURL).catch(() => {});
    this.window.on('resize', () => this.layout());
    this.window.on('closed', () => {
      this.persist(); for (const tab of this.tabs) tab.view.webContents.close();
      this.session.removeListener('will-download', this.downloadHandler);
      onClose();
    });
    this.downloadHandler = async (event, item, wc) => {
      // Cancel automatic downloads. User approves a URL first; the explicit
      // replacement download receives a save dialog and is never auto-opened.
      const downloadURL = item.getURL();
      if (this.approvedDownload === downloadURL) {
        this.approvedDownload = null;
        item.setSaveDialogOptions({ title: 'Save browser download', defaultPath: path.basename(item.getFilename()).replace(/[\x00-\x1f]/g, '_') });
        return;
      }
      event.preventDefault();
      if (!this.tabs.some(tab => tab.view.webContents === wc)) return;
      let url; try { url = browserURL(downloadURL); } catch { return; }
      const answer = await dialog.showMessageBox(this.window, { type: 'question', message: 'Download this file?', detail: new URL(url).origin, buttons: ['Cancel', 'Choose save location'], defaultId: 0, cancelId: 0 });
      if (answer.response === 1 && !this.window.isDestroyed()) { this.approvedDownload = url; wc.downloadURL(url); }
    };
    this.session.on('will-download', this.downloadHandler);
    let saved; try { saved = readJSON(this.stateFile); } catch { saved = null; }
    for (const url of (Array.isArray(saved?.urls) ? saved.urls.slice(0, 20) : [])) { try { this.add(browserURL(url)); } catch { /* Drop invalid persisted URL. */ } }
    if (!this.tabs.length) this.add();
    this.select(Math.min(Number.isInteger(saved?.active) ? Math.max(saved.active, 0) : 0, this.tabs.length - 1));
  }
  add(url) {
    if (this.tabs.length >= 20) throw Error('Tab limit reached');
    const view = new WebContentsView({ webPreferences: { session: this.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false } });
    lockRemote(view.webContents);
    const tab = { view, url: '', title: 'New tab' }; this.tabs.push(tab);
    view.webContents.on('did-navigate', (_event, target) => { try { tab.url = browserURL(target); this.persist(); } catch {} });
    view.webContents.on('page-title-updated', (_event, title) => { tab.title = title.slice(0, 120); });
    view.webContents.on('did-fail-load', () => { tab.title = 'Page unavailable'; });
    if (url) { tab.url = browserURL(url); view.webContents.loadURL(tab.url).catch(() => {}); }
    this.select(this.tabs.length - 1); this.persist();
  }
  select(index) {
    if (!this.tabs[index]) throw Error('Tab not found');
    for (const tab of this.tabs) if (this.window.contentView.children.includes(tab.view)) this.window.contentView.removeChildView(tab.view);
    this.active = index; this.window.contentView.addChildView(this.tabs[index].view); this.layout(); this.persist();
  }
  layout() { if (this.window.isDestroyed()) return; const [width, height] = this.window.getContentSize(); this.tabs[this.active]?.view.setBounds({ x: 0, y: TOP, width, height: Math.max(0, height - TOP) }); }
  persist() { if (fs.existsSync(this.workspace.browser)) atomic(this.stateFile, JSON.stringify({ urls: this.tabs.map(t => t.url).filter(Boolean), active: this.active })); }
  state() { const wc = this.tabs[this.active]?.view.webContents; return { partition: this.partition, active: this.active, tabs: this.tabs.map(t => ({ url: t.url, title: t.title })), back: wc?.navigationHistory.canGoBack() || false, forward: wc?.navigationHistory.canGoForward() || false }; }
  action(input) {
    const wc = this.tabs[this.active]?.view.webContents;
    switch (input.action) {
      case 'new': this.add(input.url); break;
      case 'select': this.select(input.tab); break;
      case 'close': {
        const tab = this.tabs[input.tab]; if (!tab) throw Error('Tab not found');
        if (this.window.contentView.children.includes(tab.view)) this.window.contentView.removeChildView(tab.view);
        tab.view.webContents.close(); this.tabs.splice(input.tab, 1); this.active = 0;
        if (!this.tabs.length) this.add(); else this.select(0); break;
      }
      case 'navigate': wc.loadURL(browserURL(input.url)).catch(() => {}); break;
      case 'back': if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack(); break;
      case 'forward': if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward(); break;
      case 'reload': wc.reload(); break;
      case 'devtools': wc.openDevTools({ mode: 'detach' }); break;
    }
    this.persist(); return this.state();
  }
  focus(url) { if (url) this.add(browserURL(url)); this.window.show(); this.window.focus(); }
  close() {
    if (this.window.isDestroyed()) return Promise.resolve();
    return new Promise(resolve => { this.window.once('closed', resolve); this.window.close(); });
  }
  async retire() {
    await this.close();
    await this.session.closeAllConnections();
    await this.session.clearStorageData();
    await this.session.clearCache();
    this.session.flushStorageData();
  }
}
module.exports = { Browser, TOP };
