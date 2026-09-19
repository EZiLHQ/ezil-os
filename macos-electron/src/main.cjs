'use strict';
const { app, BrowserWindow, ipcMain, session, dialog, shell, Menu, safeStorage, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { pathToFileURL } = require('node:url');
const { Workspaces } = require('./workspaces.cjs');
const { Editors, INSTALLER } = require('./vscode.cjs');
const { openInXcode } = require('./xcode.cjs');
const { Vault, startBroker } = require('./broker.cjs');
const { config, startHelper, authenticatedHeaders, workspaceStatus, performOperation, previewReady } = require('./helper.cjs');
const { Browser, scaleBounds } = require('./browser.cjs');
const { EditorSupervisor } = require('./editor.cjs');
const { startGateway } = require('./editor-gateway.cjs');
const { Diagnostics } = require('./diagnostics.cjs');
const { senderAllowed, lockSession, schema, surfaceSchema, runtimeSchema } = require('./policy.cjs');
const { hostSchema, authorize } = require('./host-ipc.cjs');
const { privateDir, atomic } = require('./files.cjs');
const { configureProvider } = require('./prompts.cjs');
const { readDesktop, writeDesktop } = require('./desktop-state.cjs');
const { queryToolchain } = require('./toolchain.cjs');
app.setName('EZiL OS Native');
const dataRoot = path.resolve(process.env.EZIL_NATIVE_APP_DATA || path.join(app.getPath('appData'), 'EZiL OS Native'));
app.setPath('userData', privateDir(dataRoot));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  const resources = app.isPackaged ? process.resourcesPath : path.resolve(process.env.EZIL_NATIVE_RESOURCES || path.resolve(__dirname, '../../'));
  const diagnostics = new Diagnostics(), callers = new Map();
  const note = (code, fields) => { diagnostics.note(code, fields); atomic(path.join(dataRoot, 'diagnostics.json'), diagnostics.report()); };
  const embedded = new EditorSupervisor({ resources, extensionSource: path.join(resources, 'extensions/ezil-vscode'), note });
  const editors = new Editors({ resources, extensionSource: path.join(resources, 'extensions/ezil-vscode'), findCode: async () => (await queryToolchain()).code });
  let store, vault, broker, desktop, recovery, current, closing, booting = false, quitting = false, providerBusy = false, transitioning = false;
  const removingWorkspaces = new Set();
  async function confirmLeave(reason) {
    if (!current || !['ready', 'starting'].includes(embedded.state(current.workspace.id))) return true;
    const answer = await dialog.showMessageBox(current.window, { type: 'question', message: reason,
      detail: 'Save any unfinished changes in Code first. The workspace terminal and development servers will stop. Your project files stay in place.',
      buttons: ['Cancel', 'Stop workspace'], defaultId: 0, cancelId: 0 });
    return answer.response === 1;
  }
  async function changeWorkspace(id) {
    if (transitioning || booting || quitting) return false;
    const host = current;
    transitioning = true;
    try { if (host?.workspace.id !== id && !await confirmLeave('Switch workspace?')) return false; if (current !== host || quitting) return false; await openWorkspace(id); return true; } finally { transitioning = false; }
  }
  async function chooseProject(id) {
    const selection = await dialog.showOpenDialog({ title: id ? 'Locate the original project folder' : 'Open project folder', properties: ['openDirectory'] });
    if (selection.canceled || selection.filePaths.length !== 1) return null;
    const source = selection.filePaths[0], label = path.basename(source);
    return id ? store.relink(id, source) : store.attach(/[\p{L}\p{N}]/u.test(label) ? label : 'Project', source);
  }
  async function openProject() {
    try { const workspace = await chooseProject(); if (workspace) await changeWorkspace(workspace.id); }
    catch { await dialog.showMessageBox({ type: 'error', message: 'The project could not be opened.', detail: 'Choose an available folder you can read and write.' }); }
  }
  async function refreshPreviewGrants(host) {
    const status = await workspaceStatus(host.helper, host.workspace.id).catch(() => undefined);
    if (current !== host) return;
    const ports = new Set(status?.ports || []);
    for (const origin of host.previewOrigins) if (!ports.has(Number(new URL(origin).port))) host.previewOrigins.delete(origin);
  }
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
    const previous = current;
    if (!previous) return closing;
    if (closing) return closing;
    closing = (async () => {
      if (previous.window && !previous.window.isDestroyed()) {
        let timeout;
        try { await Promise.race([previous.window.webContents.executeJavaScript('window.ezilFlushDesktop?.()'), new Promise(resolve => { timeout = setTimeout(resolve, 2000); })]); }
        catch { /* A crashed renderer may not have pending state. */ }
        finally { clearTimeout(timeout); }
      }
      if (current === previous) current = null;
      clearInterval(previous.previewTimer);
      // One component's cleanup failure must not strand the helper, browser,
      // or window. Still reject afterward so removal/switching cannot mistake
      // an incomplete editor shutdown for confirmed process ownership release.
      let failed = false;
      const cleanup = async action => { try { await action(); } catch { failed = true; } };
      await cleanup(() => previous.gateway?.close());
      await cleanup(() => retireBrowser ? previous.browser?.retire() : previous.browser?.close());
      await cleanup(() => embedded.stop(previous.workspace.id));
      await cleanup(() => previous.helper.close());
      await cleanup(() => { if (previous.window && !previous.window.isDestroyed()) previous.window.destroy(); });
      await cleanup(() => previous.shellSession?.closeAllConnections());
      if (retireBrowser) {
        await cleanup(() => previous.shellSession?.clearStorageData());
        await cleanup(() => previous.shellSession?.clearCache());
      }
      if (desktop === previous.window) desktop = null;
      if (failed) { note('WORKSPACE_CLEANUP_FAILED'); throw Error('Workspace cleanup incomplete'); }
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
    host = { workspace, generation, helper, previewOrigins: new Set(), surfaces: new Map(), browserIdentities: new Map(), browserSequence: 0 }; current = host;
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
      const browserEvent = (channel, viewId, value) => {
        const identity = host.browserIdentities.get(viewId);
        const surface = identity && host.surfaces.get(identity.surfaceId);
        if (current !== host || window.isDestroyed() || !surface || surface.closed || surface.kind !== 'browser'
            || surface.browserViewId !== viewId || surface.generation !== identity.generation) return;
        window.webContents.send(channel, { ...value, workspaceId: workspace.id, ...identity });
      };
      host.browser = new Browser(workspace, window, generation, undefined, {
        offline: process.env.EZIL_SMOKE_OFFLINE === '1',
        onState: (viewId, value) => browserEvent('ezil:browser-state:v2', viewId, value),
        onShortcut: (viewId, action) => browserEvent('ezil:browser-shortcut:v2', viewId, { action }),
        onNewTab: (viewId, value) => browserEvent('ezil:browser-new-tab:v2', viewId, value)
      });
      host.previewTimer = setInterval(() => { void refreshPreviewGrants(host); }, 5000); host.previewTimer.unref();
      window.on('close', event => {
        if (current !== host || quitting || host.allowClose) return;
        event.preventDefault();
        void confirmLeave('Close this workspace?').then(confirmed => { if (confirmed && current === host) { host.allowClose = true; void closeWorkspace(); } });
      });
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
    if (booting || quitting || transitioning) return; booting = true;
    try {
      store ||= new Workspaces(dataRoot);
      if (!fs.existsSync(path.join(dataRoot, 'guest.json'))) {
        const answer = await dialog.showMessageBox({ type: 'question', message: 'Welcome to EZiL OS', detail: 'Open an existing project or create a workspace. Programs run on this Mac under your account.', buttons: ['Create workspace', 'Open project folder', 'Quit'], defaultId: 0, cancelId: 2 });
        if (answer.response === 2) { app.quit(); return; }
        if (answer.response === 1) { const project = await chooseProject(); if (!project) { booting = false; return boot(); } store.index.activeID = project.id; store.save(); }
        store.guest();
      }
      const saved = store.list().find(w => w.id === store.index.activeID && w.available !== false) || store.list().find(w => w.available !== false) || store.create('My workspace');
      await openWorkspace(saved.id); note('HOST_READY');
    } catch { note('HOST_START_FAILED'); showRecovery(); }
    finally { booting = false; }
  }
  function acceptSurface(host, input) {
    const key = input.surfaceId, kind = input.op.split('.')[0], previous = host.surfaces.get(key);
    // Keep exact generation tombstones for stale-message rejection. The shell
    // reuses settled slots; also bound malformed/crash-loop identity floods.
    if (!previous && host.surfaces.size >= 4096) throw Error('Surface identity limit');
    const opening = ['code.open', 'preview.open', 'browser.attach'].includes(input.op);
    if ((!previous || input.generation > previous.generation) && !opening) throw Error('Surface is not open');
    if (previous && (input.generation < previous.generation || (input.generation === previous.generation && (input.sequence <= previous.sequence || previous.closed || previous.kind !== kind)))) throw Error('Stale surface');
    if (previous && previous.kind !== kind) throw Error('Surface kind changed');
    let browserViewId = previous?.browserViewId;
    if (input.op === 'browser.attach') {
      if (previous && input.generation === previous.generation) throw Error('Browser already attached');
      if (browserViewId) {
        host.browserIdentities.delete(browserViewId);
        host.browser.destroy(browserViewId);
      }
      browserViewId = `${key}_${input.generation}`;
      host.browserIdentities.set(browserViewId, { surfaceId: key, generation: input.generation });
    }
    if (input.op === 'browser.detach') host.browserIdentities.delete(browserViewId);
    host.surfaces.set(key, { kind, generation: input.generation, sequence: input.sequence, closed: /\.(close|detach)$/.test(input.op),
      ...(browserViewId ? { browserViewId } : {}), ...(input.op === 'preview.open' ? { port: input.port } : previous?.port ? { port: previous.port } : {}) });
  }
  function surfaceResult(input, state, fields = {}) {
    return { ok: true, workspaceId: input.workspaceId, surfaceId: input.surfaceId, generation: input.generation, sequence: input.sequence, state, ...fields };
  }
  async function browserOperation(host, input) {
    const viewId = host.surfaces.get(input.surfaceId)?.browserViewId;
    const operation = (op, fields = {}) => {
      const surface = host.surfaces.get(input.surfaceId);
      if (current !== host || surface?.generation !== input.generation || surface.browserViewId !== viewId || (surface.closed && op !== 'destroy')) throw Error('Stale browser surface');
      return host.browser.operation({ op, workspaceId: input.workspaceId, generation: host.generation,
        sequence: ++host.browserSequence, viewId, ...fields });
    };
    switch (input.op) {
      case 'browser.attach': await operation('create', { bounds: { x: 0, y: 0, width: 0, height: 0 } }); break;
      case 'browser.layout':
        if (input.occluded || !input.visible) await operation('hide');
        await operation('layout', { bounds: scaleBounds(input.bounds, host.window.webContents.getZoomFactor()) });
        await operation('visibility', { visible: input.visible && !input.occluded });
        if (!input.occluded && input.visible) await operation('restore');
        break;
      case 'browser.focus': await operation('focus'); break;
      case 'browser.snapshot': {
        const result = await operation('snapshot'); return surfaceResult(input, 'ready', typeof result.snapshot === 'string' ? { snapshot: result.snapshot } : {});
      }
      case 'browser.navigate': await operation('navigate', { url: input.url }); break;
      case 'browser.back': await operation('back'); break;
      case 'browser.forward': await operation('forward'); break;
      case 'browser.reload': await operation('reload'); break;
      case 'browser.zoom-in': await operation('zoom-in'); break;
      case 'browser.zoom-out': await operation('zoom-out'); break;
      case 'browser.zoom-reset': await operation('zoom-reset'); break;
      case 'browser.detach': await operation('destroy'); break;
      case 'browser.status': break;
    }
    return surfaceResult(input, input.op === 'browser.detach' ? 'closed' : 'ready',
      ['browser.attach', 'browser.status'].includes(input.op) ? { browserState: host.browser.state(viewId) } : {});
  }
  async function runtimeOperation(host, input) {
    if (input.op === 'desktop.read') return { ok: true, preferences: readDesktop(host.workspace) };
    if (input.op === 'desktop.write') { writeDesktop(host.workspace, input.preferences); return { ok: true }; }
    if (input.op === 'provider.status') return { ok: true, ...vault.status() };
    if (input.op === 'provider.configure' || input.op === 'provider.remove') {
      if (providerBusy) throw Error('Provider setup already open'); providerBusy = true;
      try { await configureProvider(input.op === 'provider.remove' ? 'remove' : input.action, vault); note('PROVIDER_UPDATED'); }
      finally { providerBusy = false; }
      return { ok: true, configured: input.op !== 'provider.remove' };
    }
    if (input.op === 'workspace.list') return { ok: true, workspaces: store.list() };
    if (input.op === 'workspace.create') {
      const workspace = store.create(input.name); note('WORKSPACE_CREATED'); return { ok: true, workspace };
    }
    if (['workspace.import', 'workspace.attach', 'workspace.relink'].includes(input.op)) {
      const workspace = await chooseProject(input.op === 'workspace.relink' ? input.workspaceId : undefined);
      if (!workspace) return { ok: true, canceled: true };
      note('WORKSPACE_CREATED'); return { ok: true, workspace };
    }
    if (input.op === 'toolchain.status') {
      const { xcode, code } = await queryToolchain();
      return { ok: true, tools: { xcodeAvailable: xcode.available === true, xcodeVersion: xcode.version || '', swiftAvailable: !!xcode.swift, metalAvailable: !!xcode.metal, vscodeAvailable: !!code } };
    }
    if (input.op === 'workspace.reveal') { const error = await shell.openPath(store.get(input.workspaceId).files); return { ok: true, opened: !error }; }
    if (input.op === 'workspace.openVSCode') {
      const workspace = store.get(input.workspaceId);
      const result = await editors.open(workspace, current?.workspace.id === workspace.id ? { connector: current.helper.connector?.descriptor, model: broker?.descriptor } : {});
      return { ok: true, opened: result.status === 'running' };
    }
    if (input.op === 'workspace.openXcode') return { ok: true, ...await openInXcode(store.get(input.workspaceId).files, { dialog, shell, discovery: (await queryToolchain()).xcode }) };
    if (input.op === 'workspace.rename') return { ok: true, workspace: store.rename(input.workspaceId, input.name) };
    if (input.op === 'workspace.select') {
      const workspace = store.get(input.workspaceId);
      if (transitioning || booting || quitting || current !== host) return { ok: true, canceled: true };
      transitioning = true;
      try {
        if (!await confirmLeave('Switch workspace?') || current !== host || quitting) { transitioning = false; return { ok: true, canceled: true }; }
      } catch (error) { transitioning = false; throw error; }
      setImmediate(() => { void (async () => { if (current === host && !quitting) await openWorkspace(workspace.id); })().catch(() => showRecovery()).finally(() => { transitioning = false; }); });
      return { ok: true, workspace };
    }
    if (input.op === 'workspace.remove') {
      if (transitioning || booting || quitting || current !== host) return { ok: false, error: 'canceled' };
      transitioning = true;
      let deferred = false;
      try {
        const workspace = store.get(input.workspaceId, { allowMissing: true });
        if (removingWorkspaces.has(workspace.id)) throw Error('Workspace removal already in progress');
        if (editors.state(workspace) !== 'stopped') return { ok: false, error: 'external_editor_running' };
        if (workspace.id === host.workspace.id) {
          if (!await confirmLeave('Remove this workspace?') || current !== host || quitting) return { ok: false, error: 'canceled' };
          const fallback = store.list().find(candidate => candidate.id !== workspace.id && candidate.available !== false) || store.create('My workspace');
          store.get(fallback.id); // Validate before retiring the active workspace.
          removingWorkspaces.add(workspace.id);
          deferred = true;
          setImmediate(() => void (async () => {
            try {
              if (current !== host || quitting) return;
              await closeWorkspace(true);
              if (current || quitting) return;
              store.remove(workspace.id, editors.state(workspace), true); note('WORKSPACE_REMOVED');
              await openWorkspace(fallback.id);
            } catch { note('NATIVE_OPERATION_FAILED'); showRecovery(); }
            finally { removingWorkspaces.delete(workspace.id); transitioning = false; }
          })());
          return { ok: true };
        }
        if (embedded.state(workspace.id) !== 'stopped') await embedded.stop(workspace.id);
        if (current !== host || quitting) return { ok: false, error: 'canceled' };
        store.remove(workspace.id, editors.state(workspace), true); note('WORKSPACE_REMOVED'); return { ok: true };
      } finally { if (!deferred) transitioning = false; }
    }
    if (input.op === 'diagnostics.read') return { ok: true, events: diagnostics.rendererEvents() };
    if (input.op === 'preview.list') {
      const value = await workspaceStatus(host.helper, host.workspace.id); return { ok: true, ports: value?.ports || [] };
    }
    if (input.op === 'preview.register' || input.op === 'preview.unregister') {
      if (input.port === Number(new URL(host.helper.origin).port) || input.port === Number(new URL(host.gateway?.origin || 'http://127.0.0.1:1').port)) throw Error('Reserved port');
      if (input.op === 'preview.register' && !await previewReady(input.port)) return { ok: false, error: 'preview_unavailable' };
      await performOperation(host.helper, input);
      await refreshPreviewGrants(host); return { ok: true };
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
    if (input.op === 'code.close') return surfaceResult(input, 'closed');
    const entry = host.surfaces.get(input.surfaceId), status = await workspaceStatus(host.helper, host.workspace.id), registered = status?.ports.includes(entry.port);
    if (input.op === 'preview.open') {
      if (!registered || !await previewReady(input.port)) return surfaceResult(input, 'unavailable');
      const origin = `http://127.0.0.1:${input.port}`; host.previewOrigins.add(origin); return surfaceResult(input, 'ready', { url: origin + '/' });
    }
    if (input.op === 'preview.status') { const ready = registered && await previewReady(entry.port); return surfaceResult(input, ready ? 'ready' : 'unavailable', ready ? { url: `http://127.0.0.1:${entry.port}/` } : {}); }
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
  function restoreDesktop() {
    if (desktop && !desktop.isDestroyed()) { if (desktop.isMinimized()) desktop.restore(); desktop.show(); desktop.focus(); }
    else void boot();
  }
  function zoomBrowserPage(action) {
    const host = current;
    if (!host || !['zoom-in', 'zoom-out', 'zoom-reset'].includes(action)) return;
    const selected = [...host.browser.views].find(([, item]) => item.visible && !item.occluded && !item.view.webContents.isDestroyed());
    if (!selected) return;
    const [viewId] = selected, identity = host.browserIdentities.get(viewId), surface = identity && host.surfaces.get(identity.surfaceId);
    if (!surface || surface.closed || surface.generation !== identity.generation || surface.browserViewId !== viewId) return;
    void host.browser.operation({ op: action, workspaceId: host.workspace.id, generation: host.generation,
      sequence: ++host.browserSequence, viewId }).catch(() => note('NATIVE_OPERATION_FAILED'));
  }
  app.on('activate', restoreDesktop);
  app.on('second-instance', restoreDesktop);
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
  app.on('before-quit', event => {
    if (quitting) return; event.preventDefault();
    void confirmLeave('Quit EZiL OS?').then(confirmed => {
      if (!confirmed || quitting) return; quitting = true;
      void closeWorkspace().finally(() => { try { broker?.close(); } finally { app.quit(); } });
    });
  });
  app.whenReady().then(async () => {
    lockSession(session.defaultSession);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'EZiL OS', submenu: [{ label: 'Retry workspace', click: () => void boot() }, { type: 'separator' }, { role: 'quit' }] },
      { role: 'editMenu' }, { role: 'windowMenu' },
      { label: 'View', submenu: [
        { label: 'Browser Page', submenu: [
          { label: 'Zoom In', click: () => zoomBrowserPage('zoom-in') },
          { label: 'Zoom Out', click: () => zoomBrowserPage('zoom-out') },
          { label: 'Actual Size', click: () => zoomBrowserPage('zoom-reset') }
        ] },
        { label: 'Desktop Size', submenu: [
          { role: 'resetZoom', accelerator: 'CmdOrCtrl+Alt+0' },
          { role: 'zoomIn', accelerator: 'CmdOrCtrl+Alt+=' },
          { role: 'zoomOut', accelerator: 'CmdOrCtrl+Alt+-' }
        ] }, { type: 'separator' }, { role: 'togglefullscreen' }
      ] },
      { label: 'Project', submenu: [
        { label: 'Open project folder…', accelerator: 'CmdOrCtrl+O', click: () => void openProject() },
        { label: 'Create workspace', click: () => { const workspace = store.create('My workspace'); void changeWorkspace(workspace.id); } },
        { type: 'separator' },
        { label: 'Show in Finder', click: () => { if (current) void shell.openPath(current.workspace.files); } },
        { label: 'Open in Xcode', click: () => { const host = current; if (host) void queryToolchain().then(({ xcode }) => openInXcode(host.workspace.files, { dialog, shell, discovery: xcode })).then(result => { if (!result.opened && result.reason !== 'canceled') void dialog.showMessageBox({ message: result.reason === 'unavailable' ? 'Install Xcode to open this project.' : 'No Xcode project was found.', detail: 'Use a macOS Xcode project or Swift package in this folder.' }); }).catch(() => { void dialog.showMessageBox({ message: 'Xcode discovery did not finish.', detail: 'Complete Xcode setup, then try again.' }); }); } }
      ] },
      { label: 'Diagnostics', submenu: [{ label: 'Copy report', click: () => void report('copy') }, { label: 'Save report', click: () => void report('save') }] },
      { label: 'Optional tools', submenu: [{ label: 'Open external VS Code', click: () => { if (current) void editors.open(current.workspace, { connector: current.helper.connector?.descriptor, model: broker?.descriptor }).catch(() => note('EDITOR_UNAVAILABLE')); } }, { label: 'Get Microsoft VS Code', click: () => void shell.openExternal(INSTALLER) }] }
    ]));
    store = new Workspaces(dataRoot);
    if (!process.argv.includes('--native-smoke') && process.env.EZIL_NATIVE_SKIP_LEGACY !== '1') {
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
