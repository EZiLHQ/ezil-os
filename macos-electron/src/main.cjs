'use strict';
const { app, BrowserWindow, ipcMain, session, dialog, shell, Menu, safeStorage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Workspaces } = require('./workspaces.cjs');
const { Editors, INSTALLER } = require('./vscode.cjs');
const { Vault, startBroker } = require('./broker.cjs');
const { config, startHelper, authenticatedHeaders, workspaceStatus } = require('./helper.cjs');
const { Browser, scaleBounds } = require('./browser.cjs');
const { EditorSupervisor } = require('./editor.cjs');
const { startGateway } = require('./editor-gateway.cjs');
const { Diagnostics } = require('./diagnostics.cjs');
const { senderAllowed, lockSession, schema, surfaceSchema, runtimeSchema } = require('./policy.cjs');
const { hostSchema, authorize } = require('./host-ipc.cjs');
const { privateDir, atomic } = require('./files.cjs');
const { configureProvider } = require('./prompts.cjs');
app.setName('EZiL OS Native');
const dataRoot = path.resolve(process.env.EZIL_NATIVE_APP_DATA || path.join(app.getPath('appData'), 'EZiL OS Native'));
app.setPath('userData', privateDir(dataRoot));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  const resources = app.isPackaged ? process.resourcesPath : path.resolve(__dirname, '../../');
  const diagnostics = new Diagnostics(), callers = new Map();
  const note = (code, fields) => { diagnostics.note(code, fields); atomic(path.join(dataRoot, 'diagnostics.json'), diagnostics.report()); };
  const embedded = new EditorSupervisor({ resources, extensionSource: path.join(resources, 'extensions/ezil-vscode'), note });
  const editors = new Editors({ extensionSource: path.join(resources, 'extensions/ezil-vscode') });
  let store, vault, broker, desktop, recovery, current, closing, booting = false, quitting = false, providerBusy = false;
  const removingWorkspaces = new Set();
  function register(wc, url, role, workspaceId, generation) {
    const caller = { wc, url, role, workspaceId, generation, sequence: 0 };
    callers.set(wc.id, caller); wc.once('destroyed', () => callers.delete(wc.id));
    wc.setWindowOpenHandler(() => ({ action: 'deny' })); wc.on('will-attach-webview', event => event.preventDefault());
    return caller;
  }
  async function report(action) {
    if (action === 'copy') clipboard.writeText(diagnostics.report());
    if (action === 'save') {
      const result = await dialog.showSaveDialog({ title: 'Save diagnostics', defaultPath: 'ezil-diagnostics.json', filters: [{ name: 'JSON report', extensions: ['json'] }] });
      if (!result.canceled && result.filePath) atomic(result.filePath, diagnostics.report());
    }
  }
  function showRecovery() {
    if (quitting) return;
    if (recovery && !recovery.isDestroyed()) { recovery.show(); return; }
    recovery = new BrowserWindow({ title: 'EZiL OS recovery', width: 480, height: 320, resizable: false, webPreferences: { preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false } });
    const url = pathToFileURL(path.join(__dirname, '../ui/recovery.html')).href;
    register(recovery.webContents, url, 'recovery');
    recovery.webContents.on('will-navigate', event => event.preventDefault()); recovery.loadURL(url).catch(() => {});
  }
  async function closeWorkspace(retireBrowser = false) {
    const previous = current; current = null;
    if (!previous) return closing;
    closing = (async () => {
      previous.gateway?.close();
      if (retireBrowser) await previous.browser?.retire(); else await previous.browser?.close();
      await embedded.stop(previous.workspace.id);
      await previous.helper.close();
      if (previous.window && !previous.window.isDestroyed()) previous.window.destroy();
      await previous.shellSession?.closeAllConnections();
      if (retireBrowser) { await previous.shellSession?.clearStorageData(); await previous.shellSession?.clearCache(); }
      if (desktop === previous.window) desktop = null;
    })();
    try { await closing; } finally { closing = null; }
  }
  async function openWorkspace(id) {
    if (current?.workspace.id === id && desktop && !desktop.isDestroyed()) { desktop.show(); desktop.focus(); return; }
    await closeWorkspace();
    const workspace = store.get(id), generation = randomUUID();
    const settings = config(resources, app.isPackaged ? {} : process.env);
    if (!app.isPackaged && !process.env.EZIL_HELPER_PATH) settings.helper = path.resolve(__dirname, '../../native/src/main.ts');
    let host;
    const helper = await startHelper(settings, dataRoot, workspace, () => {
      if (quitting || current !== host) return;
      note('HELPER_EXITED'); void closeWorkspace().finally(showRecovery);
    });
    host = { workspace, generation, helper, previewOrigins: new Set(), surfaces: new Map(), browserSequence: 0 }; current = host;
    try {
      const shellSession = session.fromPath(privateDir(path.join(workspace.dir, 'shell-profile'))); lockSession(shellSession);
      host.shellSession = shellSession;
      shellSession.on('will-download', event => event.preventDefault());
      shellSession.webRequest.onBeforeRequest((details, callback) => {
        let origin; try { origin = new URL(details.url).origin.replace(/^ws:/, 'http:'); } catch {}
        callback({ cancel: current !== host || details.webContentsId !== helper.webContentsId || ![helper.origin, host.gateway?.origin, ...host.previewOrigins].includes(origin) });
      });
      shellSession.webRequest.onBeforeSendHeaders((details, callback) => {
        const origin = new URL(details.url).origin.replace(/^ws:/, 'http:');
        const requestHeaders = origin === host.gateway?.origin ? host.gateway.headers(details)
          : origin === helper.origin ? authenticatedHeaders(details, helper) : details.requestHeaders;
        callback({ requestHeaders });
      });
      desktop = new BrowserWindow({ title: workspace.name + ' — EZiL OS', width: 1400, height: 920, show: false, backgroundColor: '#f4f5f7', webPreferences: { session: shellSession, preload: path.join(__dirname, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      const window = desktop; host.window = window;
      helper.webContentsId = window.webContents.id;
      register(window.webContents, helper.url, 'desktop', id, generation);
      window.webContents.on('will-navigate', (event, url) => { if (url !== helper.url) event.preventDefault(); });
      window.webContents.on('will-redirect', event => { if (event.isMainFrame && event.url !== helper.url) event.preventDefault(); });
      window.webContents.on('will-frame-navigate', event => {
        if (event.isMainFrame) { if (event.url !== helper.url) event.preventDefault(); return; }
        let origin; try { origin = new URL(event.url).origin; } catch {}
        if (origin !== host.gateway?.origin && !host.previewOrigins.has(origin)) event.preventDefault();
      });
      host.browser = new Browser(workspace, window, generation, undefined, { offline: process.env.EZIL_SMOKE_OFFLINE === '1' });
      window.on('closed', () => { if (current === host) void closeWorkspace(); });
      await window.loadURL(helper.url);
      store.index.activeID = id; store.save(); window.show(); recovery?.close(); note('WORKSPACE_OPENED');
    } catch { await closeWorkspace(); throw Error('Workspace startup failed'); }
  }
  function openEditor(host) {
    host.editorOpening ||= prepareEditor(host).finally(() => { host.editorOpening = null; });
    return host.editorOpening;
  }
  async function prepareEditor(host) {
    if (host.gateway && embedded.state(host.workspace.id) === 'ready') return host.gateway.origin + '/';
    await embedded.start(host.workspace, { connector: host.helper.connector?.descriptor, model: broker?.descriptor });
    if (current !== host) throw Error('Workspace changed');
    host.gateway ||= await startGateway({ getEditor: () => embedded.instances.get(host.workspace.id), shellOrigin: host.helper.origin, webContentsId: desktop.webContents.id, shellWebContents: desktop.webContents });
    if (current !== host) { host.gateway.close(); throw Error('Workspace changed'); }
    return host.gateway.origin + '/';
  }
  async function boot() {
    if (booting || quitting) return; booting = true;
    try {
      store ||= new Workspaces(dataRoot);
      if (!fs.existsSync(path.join(dataRoot, 'guest.json'))) {
        const answer = await dialog.showMessageBox({ type: 'question', message: 'Start a local guest workspace?', detail: 'Projects run on this Mac under your account.', buttons: ['Start local workspace', 'Quit'], defaultId: 0, cancelId: 1 });
        if (answer.response !== 0) { app.quit(); return; }
        store.guest();
      }
      const saved = store.list().find(w => w.id === store.index.activeID) || store.list()[0] || store.create('My workspace');
      await openWorkspace(saved.id); note('HOST_READY');
    } catch { note('HOST_START_FAILED'); showRecovery(); }
    finally { booting = false; }
  }
  function acceptSurface(host, input) {
    const key = input.surfaceId, kind = input.op.split('.')[0], previous = host.surfaces.get(key);
    const opening = ['code.open', 'preview.open', 'browser.attach'].includes(input.op);
    if ((!previous || input.generation > previous.generation) && !opening) throw Error('Surface is not open');
    if (previous && (input.generation < previous.generation || (input.generation === previous.generation && (input.sequence <= previous.sequence || previous.closed || previous.kind !== kind)))) throw Error('Stale surface');
    host.surfaces.set(key, { kind, generation: input.generation, sequence: input.sequence, closed: /\.(close|detach)$/.test(input.op), ...(input.op === 'preview.open' ? { port: input.port } : previous?.port ? { port: previous.port } : {}) });
  }
  function surfaceResult(input, state, fields = {}) {
    return { ok: true, workspaceId: input.workspaceId, surfaceId: input.surfaceId, generation: input.generation, sequence: input.sequence, state, ...fields };
  }
  async function browserOperation(host, input) {
    const operation = (op, fields = {}) => host.browser.operation({ op, workspaceId: input.workspaceId, generation: host.generation,
      sequence: ++host.browserSequence, viewId: input.surfaceId, ...fields });
    switch (input.op) {
      case 'browser.attach': await operation('create', { bounds: { x: 0, y: 0, width: 0, height: 0 } }); break;
      case 'browser.layout':
        if (!input.occluded) await operation('restore');
        await operation('layout', { bounds: scaleBounds(input.bounds, host.window.webContents.getZoomFactor()) });
        await operation('visibility', { visible: input.visible && !input.occluded });
        break;
      case 'browser.focus': await operation('focus'); break;
      case 'browser.snapshot': {
        const result = await operation('snapshot'); return surfaceResult(input, 'ready', typeof result.snapshot === 'string' ? { snapshot: result.snapshot } : {});
      }
      case 'browser.navigate': await operation('navigate', { url: input.url }); break;
      case 'browser.back': await operation('back'); break;
      case 'browser.forward': await operation('forward'); break;
      case 'browser.reload': await operation('reload'); break;
      case 'browser.detach': await operation('destroy'); break;
    }
    return surfaceResult(input, input.op === 'browser.detach' ? 'closed' : 'ready');
  }
  async function runtimeOperation(host, input) {
    if (input.op === 'provider.status') return { ok: true, configured: fs.existsSync(vault.file), keychainAvailable: process.platform === 'darwin' && safeStorage.isEncryptionAvailable() };
    if (input.op === 'provider.configure' || input.op === 'provider.remove') {
      if (providerBusy) throw Error('Provider setup already open'); providerBusy = true;
      try { await configureProvider(input.op === 'provider.remove' ? 'remove' : input.action, vault); note('PROVIDER_UPDATED'); }
      finally { providerBusy = false; }
      return { ok: true, configured: input.op !== 'provider.remove' };
    }
    if (input.op === 'workspace.list') return { ok: true, workspaces: store.list() };
    if (input.op === 'workspace.create') {
      if (store.list().length >= 2) throw Error('Workspace limit reached');
      const workspace = store.create(input.name); note('WORKSPACE_CREATED'); return { ok: true, workspace };
    }
    if (input.op === 'workspace.import') {
      if (store.list().length >= 2) throw Error('Workspace limit reached');
      const selection = await dialog.showOpenDialog({ title: 'Copy a project into EZiL OS', properties: ['openDirectory'] });
      if (selection.canceled || selection.filePaths.length !== 1) return { ok: true, canceled: true };
      const source = selection.filePaths[0], basename = path.basename(source);
      const workspace = store.create(/[\p{L}\p{N}]/u.test(basename) ? basename : 'Imported project', source);
      note('WORKSPACE_CREATED'); return { ok: true, workspace };
    }
    if (input.op === 'workspace.rename') return { ok: true, workspace: store.rename(input.workspaceId, input.name) };
    if (input.op === 'workspace.select') {
      const workspace = store.get(input.workspaceId); setImmediate(() => void openWorkspace(workspace.id).catch(() => showRecovery()));
      return { ok: true, workspace };
    }
    if (input.op === 'workspace.remove') {
      const workspace = store.get(input.workspaceId);
      if (removingWorkspaces.has(workspace.id)) throw Error('Workspace removal already in progress');
      if (workspace.id === host.workspace.id) {
        const fallback = store.list().find(candidate => candidate.id !== workspace.id) || store.create('My workspace');
        removingWorkspaces.add(workspace.id);
        setImmediate(() => void (async () => {
          try {
            await closeWorkspace(true);
            store.remove(workspace.id, 'stopped', true); note('WORKSPACE_REMOVED');
            await openWorkspace(fallback.id);
          } catch { note('NATIVE_OPERATION_FAILED'); showRecovery(); }
          finally { removingWorkspaces.delete(workspace.id); }
        })());
        return { ok: true };
      }
      if (embedded.state(workspace.id) !== 'stopped') await embedded.stop(workspace.id);
      store.remove(workspace.id, 'stopped', true); note('WORKSPACE_REMOVED'); return { ok: true };
    }
    if (input.op === 'diagnostics.read') return { ok: true, events: diagnostics.rendererEvents() };
    if (input.op === 'preview.list') {
      const value = await workspaceStatus(host.helper, host.workspace.id); return { ok: true, ports: value?.ports || [] };
    }
    acceptSurface(host, input);
    if (input.op.startsWith('browser.')) return browserOperation(host, input);
    if (input.op === 'code.open') {
      try { return surfaceResult(input, 'ready', { url: await openEditor(host) }); }
      catch { return surfaceResult(input, 'failed'); }
    }
    if (input.op === 'code.status') {
      const state = embedded.state(host.workspace.id);
      return surfaceResult(input, state === 'ready' && host.gateway ? 'ready' : state, state === 'ready' && host.gateway ? { url: host.gateway.origin + '/' } : {});
    }
    if (input.op === 'code.close') { host.gateway?.close(); host.gateway = null; await embedded.stop(host.workspace.id); return surfaceResult(input, 'closed'); }
    const entry = host.surfaces.get(input.surfaceId), status = await workspaceStatus(host.helper, host.workspace.id), registered = status?.ports.includes(entry.port);
    if (input.op === 'preview.open') {
      if (!registered) return surfaceResult(input, 'unavailable');
      const origin = `http://127.0.0.1:${input.port}`; host.previewOrigins.add(origin); return surfaceResult(input, 'ready', { url: origin + '/' });
    }
    if (input.op === 'preview.status') return surfaceResult(input, registered ? 'ready' : 'unavailable', registered ? { url: `http://127.0.0.1:${entry.port}/` } : {});
    if (input.op === 'preview.close') { if (entry.port) host.previewOrigins.delete(`http://127.0.0.1:${entry.port}`); return surfaceResult(input, 'closed'); }
    throw Error('Unsupported runtime operation');
  }
  ipcMain.handle('ezil:runtime:v2', async (event, raw) => {
    try {
      const host = current, caller = callers.get(event.sender.id), input = runtimeSchema(raw);
      if (!host || caller?.role !== 'desktop' || !senderAllowed(event, caller.wc, caller.url) || caller.workspaceId !== host.workspace.id) throw Error('Sender');
      if ('workspaceId' in input && !input.op.startsWith('workspace.') && input.workspaceId !== host.workspace.id) throw Error('Workspace');
      return await runtimeOperation(host, input);
    } catch { note('NATIVE_OPERATION_FAILED'); return { ok: false, state: 'unavailable' }; }
  });
  ipcMain.handle('ezil:host:v2', async (event, raw) => {
    try {
      const host = current, caller = callers.get(event.sender.id);
      const input = hostSchema(raw); authorize(event, caller, host, input);
      if (input.op === 'browser') return { ok: true, value: await host.browser.operation(input.operation) };
      if (input.op === 'editor.start') {
        return { ok: true, value: { state: 'ready', url: await openEditor(host) } };
      }
      if (input.op === 'editor.stop') { await embedded.stop(host.workspace.id); }
      return { ok: true, value: { state: embedded.state(host.workspace.id) } };
    } catch { note('NATIVE_OPERATION_FAILED'); return { ok: false, error: 'Native surface unavailable' }; }
  });
  ipcMain.handle('ezil:surface:v1', async (event, raw) => {
    try {
      const caller = callers.get(event.sender.id), input = surfaceSchema(raw), host = current;
      if (!host || caller?.role !== 'desktop' || !senderAllowed(event, caller.wc, caller.url) || caller.workspaceId !== input.workspaceId || input.workspaceId !== host.workspace.id) throw Error('Sender');
      if (input.surface === 'code') return { ok: true, state: 'opened', url: await openEditor(host) };
      return { ok: true, state: 'opened' };
    } catch { return { ok: false, state: 'unavailable' }; }
  });
  ipcMain.handle('ezil:native:v1', async (event, raw) => {
    try {
      const caller = callers.get(event.sender.id);
      if (!caller || !senderAllowed(event, caller.wc, caller.url)) throw Error('Sender');
      const input = schema(raw);
      if (input.op === 'diagnostics') { await report(input.action); return { ok: true }; }
      if (caller.role === 'recovery' && input.op === 'retry') { void boot(); return { ok: true }; }
      if (caller.role === 'desktop' && input.op === 'status' && current?.workspace.id === caller.workspaceId) return { ok: true, value: { contractVersion: 2, workspaceId: caller.workspaceId, generation: caller.generation, sequence: caller.sequence, editor: embedded.state(caller.workspaceId) } };
      throw Error('Operation unavailable');
    } catch { return { ok: false, error: 'Native operation unavailable' }; }
  });
  app.on('activate', () => { if (desktop && !desktop.isDestroyed()) desktop.show(); else void boot(); });
  app.on('second-instance', () => { if (desktop && !desktop.isDestroyed()) desktop.focus(); else void boot(); });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return; event.preventDefault(); quitting = true;
    void closeWorkspace().finally(() => { try { broker?.close(); } finally { app.quit(); } });
  });
  app.whenReady().then(async () => {
    lockSession(session.defaultSession);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'EZiL OS', submenu: [{ label: 'Retry workspace', click: () => void boot() }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'windowMenu' },
      { label: 'Diagnostics', submenu: [{ label: 'Copy report', click: () => void report('copy') }, { label: 'Save report', click: () => void report('save') }] },
      { label: 'Optional tools', submenu: [{ label: 'Open external VS Code', click: () => { if (current) void editors.open(current.workspace, { connector: current.helper.connector?.descriptor, model: broker?.descriptor }).catch(() => note('EDITOR_UNAVAILABLE')); } }, { label: 'Get Microsoft VS Code', click: () => void shell.openExternal(INSTALLER) }] }
    ]));
    store = new Workspaces(dataRoot);
    if (!process.argv.includes('--native-smoke')) {
      try { store.migrate(path.join(app.getPath('appData'), 'EZiL OS')); }
      catch { note('LEGACY_IMPORT_NEEDS_REVIEW'); }
    }
    vault = new Vault(path.join(dataRoot, 'private'), safeStorage);
    broker = await startBroker(path.join(dataRoot, 'private'), vault);
    if (process.argv.includes('--native-smoke')) {
      const manifest = path.join(resources, 'INVENTORY.json');
      if (!app.isPackaged || JSON.parse(fs.readFileSync(manifest)).distribution !== 'internal-ad-hoc') throw Error('Packaged artifact required');
      await require('./smoke.cjs').run({ app, dataRoot, store, editors, embedded, vault, broker, openWorkspace, openEditor: () => openEditor(current), getHost: () => current, getDesktop: () => desktop, closeWorkspace });
    } else await boot();
  }).catch(() => { note('HOST_START_FAILED'); showRecovery(); });
}
