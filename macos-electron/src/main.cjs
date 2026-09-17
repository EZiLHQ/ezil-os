'use strict';
const { app, BrowserWindow, ipcMain, session, dialog, shell, Menu, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { Workspaces } = require('./workspaces.cjs');
const { Editors, discover, INSTALLER } = require('./vscode.cjs');
const { Vault, startBroker } = require('./broker.cjs');
const { config, startHelper, authenticatedHeaders } = require('./helper.cjs');
const { operation } = require('./surfaces.cjs');
const { connectorStatus } = require('./connector.cjs');
const { Browser } = require('./browser.cjs');
const { schema, senderAllowed, capabilities, lockSession } = require('./policy.cjs');
const { privateDir, atomic } = require('./files.cjs');
const { configureProvider } = require('./prompts.cjs');

app.setName('EZiL OS Native');
const dataRoot = path.resolve(process.env.EZIL_NATIVE_APP_DATA || path.join(app.getPath('appData'), 'EZiL OS Native'));
app.setPath('userData', privateDir(dataRoot));
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let store, broker, vault, desktop, helper, activeID, onboarding, busy = false, providerBusy = false, quitting = false;
  const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../');
  const editors = new Editors({ extensionSource: path.join(resources, 'extensions/ezil-vscode') }), browsers = new Map(), callers = new Map(), diagnostics = [];
  function note(code) {
    diagnostics.push({ at: new Date().toISOString(), code }); if (diagnostics.length > 100) diagnostics.shift();
    atomic(path.join(dataRoot, 'diagnostics.json'), JSON.stringify(diagnostics));
  }
  function register(wc, url, role, browser) {
    callers.set(wc.id, { wc, url, role, browser });
    wc.once('destroyed', () => callers.delete(wc.id));
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-attach-webview', event => event.preventDefault());
  }
  function showOnboarding() {
    if (onboarding && !onboarding.isDestroyed()) { onboarding.show(); onboarding.focus(); return; }
    onboarding = new BrowserWindow({ title: 'EZiL OS', width: 820, height: 700, backgroundColor: '#f4f5f7', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const url = pathToFileURL(path.join(__dirname, '../ui/welcome.html')).href;
    register(onboarding.webContents, url, 'welcome');
    onboarding.webContents.on('will-navigate', event => event.preventDefault());
    onboarding.loadURL(url);
  }
  async function openWorkspace(id) {
    const workspace = store.get(id);
    if (activeID === id && desktop && !desktop.isDestroyed()) { desktop.show(); desktop.focus(); return; }
    if (desktop && !desktop.isDestroyed()) desktop.destroy();
    helper?.close(); helper = null; activeID = null;
    const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../');
    const settings = config(resources);
    if (!app.isPackaged && !process.env.EZIL_HELPER_PATH) settings.helper = path.resolve(__dirname, '../../native/src/main.ts');
    let started;
    started = await startHelper(settings, dataRoot, workspace, () => {
      if (quitting || helper !== started) return;
      note('HELPER_EXITED');
      if (desktop && !desktop.isDestroyed()) desktop.destroy();
      activeID = null; showOnboarding();
    });
    helper = started;
    const currentHelper = helper;
    const desktopSession = session.fromPartition(`ezil-shell-${id}-${Date.now()}`);
    lockSession(desktopSession);
    desktopSession.webRequest.onBeforeRequest((details, callback) => {
      let permitted = false; try { permitted = new URL(details.url).origin === currentHelper.origin; } catch {}
      callback({ cancel: !permitted });
    });
    // Capability stays in main and the helper's inherited environment. The
    // renderer gets neither a token nor a token-bearing URL/storage entry.
    desktopSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: authenticatedHeaders(details, currentHelper) });
    });
    desktop = new BrowserWindow({ title: workspace.name + ' — EZiL OS', width: 1400, height: 920, show: false, backgroundColor: '#f4f5f7', webPreferences: { session: desktopSession, preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
    const currentWindow = desktop;
    register(desktop.webContents, currentHelper.url, 'desktop');
    desktop.webContents.on('will-navigate', (event, url) => { if (url !== currentHelper.url) event.preventDefault(); });
    desktop.webContents.on('will-redirect', event => event.preventDefault());
    desktop.webContents.on('will-frame-navigate', event => event.preventDefault());
    desktop.on('closed', () => { if (desktop === currentWindow) { desktop = null; currentHelper.close(); if (helper === currentHelper) helper = null; activeID = null; } });
    await desktop.loadURL(currentHelper.url); activeID = id; desktop.show(); onboarding?.hide(); note('WORKSPACE_OPENED');
  }
  function openBrowser(id, url) {
    const workspace = store.get(id);
    if (!browsers.has(id)) browsers.set(id, new Browser(workspace, register, () => browsers.delete(id)));
    const browser = browsers.get(id); browser.focus(url); return browser;
  }
  async function status() {
    return { capabilities, guest: fs.existsSync(path.join(dataRoot, 'guest.json')), workspaces: store.list(), activeID, editor: discover() ? 'available' : 'missing', installer: INSTALLER, provider: { configured: fs.existsSync(vault.file), keychainAvailable: process.platform === 'darwin' && safeStorage.isEncryptionAvailable(), temporaryIAM: 'unavailable' }, usage: { ...broker.usage, accounting: 'Requests and bytes only; provider token/cost accounting is not inferred' }, diagnostics: [...diagnostics] };
  }
  async function dispatch(input, caller) {
    if (input.op === 'status') return { ...await status(), connector: connectorStatus };
    if (input.op === 'browserAction') return caller.browser.action(input);
    if (input.op === 'settings') { showOnboarding(); return; }
    if (input.op === 'installer') { await shell.openExternal(INSTALLER); return; }
    if (input.op === 'guest') return store.guest();
    if (input.op === 'provider') {
      if (providerBusy) throw Error('Provider setup already open'); providerBusy = true;
      try { await configureProvider(input.action, vault); note('PROVIDER_UPDATED'); } finally { providerBusy = false; }
      return;
    }
    if (input.op === 'browser') { openBrowser(input.id, input.url); return; }
    if (input.op === 'editor') return editors.open(store.get(input.id));
    if (input.op === 'stopEditor') return editors.stop(store.get(input.id));
    if (busy) throw Error('Another workspace operation is in progress'); busy = true;
    try {
      if (input.op === 'create' || input.op === 'import') {
        store.guest(); let source;
        if (input.op === 'import') {
          const selection = await dialog.showOpenDialog({ title: 'Copy a project into EZiL OS', properties: ['openDirectory'] });
          if (selection.canceled) return null; source = selection.filePaths[0];
        }
        const workspace = store.create(input.name, source); note('WORKSPACE_CREATED'); return { id: workspace.id, name: workspace.name };
      }
      if (input.op === 'open') return await openWorkspace(input.id);
      if (input.op === 'remove') {
        const workspace = store.get(input.id);
        if (editors.state(workspace) !== 'stopped') throw Error('Running or unknown VS Code instance blocks removal');
        const confirmation = await dialog.showMessageBox({ type: 'warning', message: `Remove ${workspace.name}?`, detail: 'This deletes its native project copy, Chromium profile and editor data. Original imports and legacy VM/WebKit data are preserved.', buttons: ['Cancel', 'Remove workspace'], defaultId: 0, cancelId: 0 });
        if (confirmation.response !== 1) return;
        await browsers.get(input.id)?.retire();
        if (activeID === input.id) {
          const child = helper?.child;
          desktop?.destroy(); helper?.close();
          if (child && child.exitCode === null) await Promise.race([new Promise(resolve => child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
          if (child && child.exitCode === null && child.signalCode === null) throw Error('Helper has not stopped');
        }
        store.remove(input.id, editors.state(workspace), !browsers.has(input.id)); note('WORKSPACE_REMOVED'); return;
      }
    } finally { busy = false; }
  }
  ipcMain.handle('ezil:surface:v1', (event, raw) => operation(event, raw, callers.get(event.sender.id), activeID, async input => {
    if (input.surface === 'browser') { openBrowser(input.workspaceId); return true; }
    return (await editors.open(store.get(input.workspaceId))).status === 'running';
  }));
  ipcMain.handle('ezil:native:v1', async (event, raw) => {
    try {
      const caller = callers.get(event.sender.id);
      if (!caller || !senderAllowed(event, caller.wc, caller.url)) throw Error('Untrusted IPC sender');
      const input = schema(raw);
      if ((caller.role === 'browser') !== (input.op === 'browserAction')) throw Error('Operation unavailable in this window');
      if (caller.role === 'desktop' && !['status', 'browser', 'editor', 'settings'].includes(input.op)) throw Error('Use native Settings for this operation');
      if (caller.role === 'desktop' && input.id && input.id !== activeID) throw Error('Workspace does not match desktop');
      return { ok: true, value: await dispatch(input, caller) };
    } catch (error) {
      note('NATIVE_OPERATION_FAILED');
      // Fixed messages only: unexpected errors may carry credential material.
      const message = /^(Running or unknown|Native runtime assets\/helper absent|Native helper failed|Use native Settings|Workspace exceeds|Link or special file refused|Close the browser|Temporary IAM)/.test(error.message) ? error.message : 'The operation could not complete. Check Settings diagnostics; your original files are preserved.';
      return { ok: false, error: message };
    }
  });
  app.on('second-instance', () => { if (desktop && !desktop.isDestroyed()) { desktop.show(); desktop.focus(); } else showOnboarding(); });
  app.on('activate', showOnboarding);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', () => { quitting = true; helper?.close(); broker?.close(); });
  app.whenReady().then(async () => {
    lockSession(session.defaultSession);
    session.defaultSession.on('will-download', event => event.preventDefault());
    app.on('web-contents-created', (_event, wc) => { wc.on('will-attach-webview', event => event.preventDefault()); });
    store = new Workspaces(dataRoot);
    if (!process.argv.includes('--native-smoke')) {
      try { store.migrate(path.join(app.getPath('appData'), 'EZiL OS')); } catch { note('LEGACY_IMPORT_NEEDS_REVIEW'); }
    }
    vault = new Vault(path.join(dataRoot, 'private'), safeStorage);
    broker = await startBroker(path.join(dataRoot, 'private'), vault);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'EZiL OS', submenu: [{ label: 'Settings and workspaces', click: showOnboarding }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'windowMenu' },
      { label: 'Workspace', submenu: [{ label: 'Open Browser', click: () => { if (activeID) openBrowser(activeID); } }, { label: 'Open Microsoft VS Code', click: () => { if (activeID) editors.open(store.get(activeID)).catch(() => note('EDITOR_UNAVAILABLE')); } }] }
    ]));
    showOnboarding(); note('HOST_READY');
    if (process.argv.includes('--native-smoke')) {
      const manifest = path.join(process.resourcesPath, 'INVENTORY.json');
      if (!app.isPackaged || !fs.existsSync(manifest) || JSON.parse(fs.readFileSync(manifest)).distribution !== 'internal-ad-hoc') throw Error('Smoke requires an internal packaged artifact');
      await require('./smoke.cjs').run({ app, dataRoot, store, editors, broker, openWorkspace, openBrowser, getDesktop: () => desktop, closeDesktop: () => desktop?.destroy() });
    }
  }).catch(() => {
    note('HOST_START_FAILED');
    dialog.showErrorBox('EZiL OS could not start', 'The native runtime or helper is unavailable. See docs/NATIVE-MAC.md and the Application Support diagnostics.json file.');
    app.exit(1);
  });
}
