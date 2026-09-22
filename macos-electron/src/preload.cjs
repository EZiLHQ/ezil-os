'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preload may only require Electron/builtin allowlisted modules.
// Validation is duplicated here for early feedback; main is authoritative.
const operations = new Set(['status', 'retry', 'diagnostics']);
const editorErrors = new Set(['editor_start_failed', 'editor_connection_lost', 'editor_cleanup_unverified']);
const runtimeErrors = new Set(['external_editor_running', 'canceled', 'preview_unavailable', 'project_unavailable', 'secure_browser_busy', 'secure_browser_unknown', ...editorErrors]);
const workspace = value => value && typeof value.id === 'string' && typeof value.name === 'string'
  ? { id: value.id, name: value.name, kind: value.kind === 'attached' ? 'attached' : 'managed', available: value.available !== false, ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}) } : null;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
function safeBrowserURL(value) {
  if (typeof value !== 'string' || !value || value.length > 4096) return false;
  try { const url = new URL(value); return url.href === value && !url.username && !url.password
    && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)); }
  catch { return false; }
}
function browserState(value) {
  if (!value || !Number.isSafeInteger(value.revision) || value.revision < 1 || typeof value.url !== 'string' || value.url.length > 4096) return null;
  if (value.url) {
    try { const url = new URL(value.url); if (url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) return null; }
    catch { return null; }
  }
  if (value.zoomFactor !== undefined && (!Number.isFinite(value.zoomFactor) || value.zoomFactor < 0.25 || value.zoomFactor > 5)) return null;
  return { revision: value.revision, url: value.url, title: typeof value.title === 'string' ? value.title.slice(0, 256) : '',
    zoomFactor: value.zoomFactor ?? 1,
    loading: value.loading === true, error: value.error === 'navigation_failed' ? value.error : null,
    canGoBack: value.canGoBack === true, canGoForward: value.canGoForward === true };
}
function subscribe(channel, listener, kind = 'state') {
  if (typeof listener !== 'function') return () => {};
  const revisions = new Map();
  const handler = (_event, value) => {
    if (!value || !uuid(value.workspaceId) || !uuid(value.surfaceId) || !Number.isSafeInteger(value.generation) || value.generation < 1) return;
    const identity = { workspaceId: value.workspaceId, surfaceId: value.surfaceId, generation: value.generation };
    if (kind === 'shortcut') { if (['address', 'reload', 'back', 'forward', 'new-tab', 'close-tab', 'next-tab', 'previous-tab', 'zoom-in', 'zoom-out', 'zoom-reset'].includes(value.action)) listener({ ...identity, action: value.action }); return; }
    if (kind === 'new-tab') { if (safeBrowserURL(value.url) && typeof value.background === 'boolean') listener({ ...identity, url: value.url, background: value.background }); return; }
    const state = browserState(value); if (!state) return;
    const key = `${value.workspaceId}:${value.surfaceId}:${value.generation}`;
    if (state.revision <= (revisions.get(key) || 0)) return;
    if (revisions.size > 100) revisions.clear();
    revisions.set(key, state.revision); listener({ ...identity, ...state });
  };
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); revisions.clear(); };
}
function cleanRuntimeResult(input, result) {
  if (result?.ok !== true) return { ok: false, state: 'unavailable', ...(runtimeErrors.has(result?.error) ? { error: result.error } : {}) };
  if (input.op === 'passkeys.status') return { ok: true, embeddedTouchID: result.embeddedTouchID === true,
    syncedPasskeys: false, existingPasskeys: 'secure-browser',
    ...(['signing_required', 'runtime_unsupported', 'platform_unavailable', 'setup_failed'].includes(result.reason) ? { reason: result.reason } : {}) };
  if (input.op === 'secureBrowser.status' || input.op === 'secureBrowser.open') return { ok: true,
    ...(input.op === 'secureBrowser.status' ? { available: result.available === true, ...(typeof result.version === 'string' && /^\d+(\.\d+){3}$/.test(result.version) ? { version: result.version } : {}) } : { opened: result.opened === true }),
    ...(['missing', 'outdated', 'untrusted', 'unavailable', 'profile_busy'].includes(result.reason) ? { reason: result.reason } : {}) };
  if (input.op === 'workspace.list') return { ok: true, workspaces: Array.isArray(result.workspaces) ? result.workspaces.map(workspace).filter(Boolean).slice(0, 100) : [] };
  if (input.op === 'desktop.read') {
    const p = result.preferences || {}, preferences = {};
    if (['charcoal', 'teal-dusk', 'deep-slate', 'aurora'].includes(p.wallpaper)) preferences.wallpaper = p.wallpaper;
    if (['teal', 'violet', 'amber', 'rose'].includes(p.accent)) preferences.accent = p.accent;
    if (Number.isInteger(p.previewPort) && p.previewPort >= 1024 && p.previewPort <= 65535) preferences.previewPort = p.previewPort;
    if (Array.isArray(p.layout)) preferences.layout = p.layout.slice(0, 4).filter(w => w && ['browser', 'code', 'preview', 'settings'].includes(w.app) && ['x', 'y', 'width', 'height'].every(k => Number.isFinite(w[k]) && Math.abs(w[k]) <= 32768)).map(w => ({ app: w.app, x: w.x, y: w.y, width: w.width, height: w.height, minimized: w.minimized === true }));
    const b = p.browser;
    if (Array.isArray(b?.tabs) && b.tabs.length >= 1 && b.tabs.length <= 20 && b.tabs.every(url => url === '' || safeBrowserURL(url))
        && Number.isInteger(b.activeIndex) && b.activeIndex >= 0 && b.activeIndex < b.tabs.length) preferences.browser = { tabs: [...b.tabs], activeIndex: b.activeIndex };
    return { ok: true, preferences };
  }
  if (['workspace.create', 'workspace.import', 'workspace.attach', 'workspace.relink', 'workspace.rename', 'workspace.select'].includes(input.op)) return { ok: true, workspace: workspace(result.workspace), ...(result.canceled === true ? { canceled: true } : {}) };
  if (input.op === 'toolchain.status') return { ok: true, tools: { xcodeAvailable: result.tools?.xcodeAvailable === true, xcodeVersion: typeof result.tools?.xcodeVersion === 'string' ? result.tools.xcodeVersion.slice(0, 100) : '', swiftAvailable: result.tools?.swiftAvailable === true, metalAvailable: result.tools?.metalAvailable === true, vscodeAvailable: result.tools?.vscodeAvailable === true } };
  if (['workspace.openXcode', 'workspace.openVSCode', 'workspace.reveal'].includes(input.op)) return { ok: true, opened: result.opened === true, ...(result.canceled === true ? { canceled: true } : {}), ...(typeof result.reason === 'string' && /^[a-z_]{1,64}$/.test(result.reason) ? { reason: result.reason } : {}) };
  if (input.op === 'preview.list') return { ok: true, ports: Array.isArray(result.ports) ? result.ports.filter(port => Number.isInteger(port) && port >= 1024 && port <= 65535).slice(0, 32) : [] };
  if (input.op === 'diagnostics.read') return { ok: true, events: Array.isArray(result.events) ? result.events.slice(-100).map(event => ({ event: event.event, t: event.t, ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}) })) : [] };
  if (input.op.startsWith('provider.')) return { ok: true, configured: result.configured === true, ...(typeof result.keychainAvailable === 'boolean' ? { keychainAvailable: result.keychainAvailable } : {}) };
  if (!input.surfaceId) return { ok: true };
  const clean = { ok: true, workspaceId: result.workspaceId, surfaceId: result.surfaceId, generation: result.generation, sequence: result.sequence, state: result.state };
  if (editorErrors.has(result.error)) clean.error = result.error;
  if (typeof result.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(result.url)) clean.url = result.url;
  if (typeof result.snapshot === 'string' && result.snapshot.length <= 2_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.snapshot)) clean.snapshot = result.snapshot;
  if (result.browserState) clean.browserState = browserState(result.browserState);
  return clean;
}
contextBridge.exposeInMainWorld('ezilNative', Object.freeze({
  contractVersion: 2,
  subscribeBrowserState: listener => subscribe('ezil:browser-state:v2', listener),
  subscribeBrowserShortcut: listener => subscribe('ezil:browser-shortcut:v2', listener, 'shortcut'),
  subscribeBrowserNewTab: listener => subscribe('ezil:browser-new-tab:v2', listener, 'new-tab'),
  operation: async input => {
    const unavailable = { ok: false, state: 'unavailable' };
    try {
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || JSON.stringify(input).length > (input.op === 'desktop.write' ? 96 * 1024 : 16384)) return unavailable;
      const result = await ipcRenderer.invoke('ezil:runtime:v2', input);
      return cleanRuntimeResult(input, result);
    } catch { return unavailable; }
  },
  host: async input => {
    if (!input || typeof input !== 'object' || JSON.stringify(input).length > 16384) throw Error('Invalid host request');
    const result = await ipcRenderer.invoke('ezil:host:v2', input);
    if (!result?.ok) throw Error('Native surface unavailable');
    return result.value;
  },
  request: async input => {
    if (!input || typeof input !== 'object' || !operations.has(input.op) || JSON.stringify(input).length > 8192) throw Error('Invalid native request');
    const result = await ipcRenderer.invoke('ezil:native:v1', input);
    if (!result.ok) throw Error(result.error);
    return result.value;
  }
}));
