'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preload may only require Electron/builtin allowlisted modules.
// Validation is duplicated here for early feedback; main is authoritative.
const operations = new Set(['status', 'retry', 'diagnostics']);
const workspace = value => value && typeof value.id === 'string' && typeof value.name === 'string'
  ? { id: value.id, name: value.name, ...(typeof value.createdAt === 'string' ? { createdAt: value.createdAt } : {}) } : null;
function cleanRuntimeResult(input, result) {
  if (input.op.startsWith('provider.')) {
    const codes = ['signin_required', 'builder_required', 'membership_required', 'paused', 'model_unavailable', 'gateway_unavailable', 'auth_unavailable', 'secure_storage_unavailable', 'rate_limited'];
    const clean = { ok: result?.ok === true, configured: result?.configured === true };
    if (codes.includes(result?.errorCode)) clean.errorCode = result.errorCode;
    if (['none', 'ezil', 'azure', 'bedrock'].includes(result?.provider)) clean.provider = result.provider;
    if (['disconnected', 'stored', 'ready', 'paused', 'model_unavailable', 'signin_required', 'unavailable'].includes(result?.state)) clean.state = result.state;
    if (typeof result?.keychainAvailable === 'boolean') clean.keychainAvailable = result.keychainAvailable;
    if (Array.isArray(result?.models)) clean.models = result.models.filter(id => id === 'ezil-fast' || id === 'ezil-code').slice(0, 2);
    return clean;
  }
  if (result?.ok !== true) return { ok: false, state: 'unavailable' };
  if (input.op === 'workspace.list') return { ok: true, workspaces: Array.isArray(result.workspaces) ? result.workspaces.map(workspace).filter(Boolean).slice(0, 100) : [] };
  if (['workspace.create', 'workspace.import', 'workspace.rename', 'workspace.select'].includes(input.op)) return { ok: true, workspace: workspace(result.workspace), ...(result.canceled === true ? { canceled: true } : {}) };
  if (input.op === 'preview.list') return { ok: true, ports: Array.isArray(result.ports) ? result.ports.filter(port => Number.isInteger(port) && port >= 1024 && port <= 65535).slice(0, 32) : [] };
  if (input.op === 'diagnostics.read') return { ok: true, events: Array.isArray(result.events) ? result.events.slice(-100).map(event => ({ event: event.event, t: event.t, ...(Number.isFinite(event.durationMs) ? { durationMs: event.durationMs } : {}) })) : [] };
  if (!input.surfaceId) return { ok: true };
  const clean = { ok: true, workspaceId: result.workspaceId, surfaceId: result.surfaceId, generation: result.generation, sequence: result.sequence, state: result.state };
  if (typeof result.url === 'string' && /^http:\/\/127\.0\.0\.1:\d+\/$/.test(result.url)) clean.url = result.url;
  if (typeof result.snapshot === 'string' && result.snapshot.length <= 2_000_000 && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.snapshot)) clean.snapshot = result.snapshot;
  return clean;
}
contextBridge.exposeInMainWorld('ezilNative', Object.freeze({
  contractVersion: 2,
  operation: async input => {
    const unavailable = { ok: false, state: 'unavailable' };
    try {
      if (!input || Object.getPrototypeOf(input) !== Object.prototype || JSON.stringify(input).length > 16384) return unavailable;
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
