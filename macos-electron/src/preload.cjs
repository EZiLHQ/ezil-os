'use strict';
const { contextBridge, ipcRenderer } = require('electron');
// Sandboxed preload may only require Electron/builtin allowlisted modules.
// Validation is duplicated here for early feedback; main is authoritative.
const operations = new Set(['status', 'guest', 'create', 'import', 'open', 'remove', 'browser', 'editor', 'stopEditor', 'installer', 'settings', 'provider', 'browserAction']);
contextBridge.exposeInMainWorld('ezilNative', Object.freeze({
  contractVersion: 1,
  operation: async input => {
    const unavailable = { ok: false, state: 'unavailable' };
    try {
      if (!input || Object.getPrototypeOf(input) !== Object.prototype ||
          Object.keys(input).length !== 3 || Object.keys(input).some(k => !['op', 'workspaceId', 'surface'].includes(k)) ||
          !['surface.open', 'surface.focus'].includes(input.op) || !['code', 'browser'].includes(input.surface) ||
          typeof input.workspaceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(input.workspaceId)) return unavailable;
      const result = await ipcRenderer.invoke('ezil:surface:v1', input);
      return result?.ok === true && result.state === 'opened' ? { ok: true, state: 'opened' } : unavailable;
    } catch { return unavailable; }
  },
  request: async input => {
    if (!input || typeof input !== 'object' || !operations.has(input.op) || JSON.stringify(input).length > 8192) throw Error('Invalid native request');
    const result = await ipcRenderer.invoke('ezil:native:v1', input);
    if (!result.ok) throw Error(result.error);
    return result.value;
  }
}));
