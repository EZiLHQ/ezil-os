'use strict';
// No free-form errors, URLs, paths, identifiers, headers or image bytes enter events.
const { atomic } = require('./files.cjs');
const EVENTS = new Set(['HOST_READY', 'HOST_START_FAILED', 'HELPER_EXITED', 'WORKSPACE_OPENED', 'WORKSPACE_CREATED', 'WORKSPACE_REMOVED', 'WORKSPACE_CLEANUP_FAILED', 'LEGACY_IMPORT_NEEDS_REVIEW', 'NATIVE_OPERATION_FAILED', 'PROVIDER_UPDATED', 'EDITOR_UNAVAILABLE', 'EDITOR_INVENTORY_FAILED', 'EDITOR_STATE', 'STDIO_PIPE_CLOSED', 'DIAGNOSTICS_WRITE_FAILED', 'EDITOR_CLEANUP_FAILED']);
const STATES = new Set(['stopped', 'starting', 'ready', 'failed', 'stopping']);
function redact(value) {
  return String(value)
    .replace(/\b(?:authorization|proxy-authorization|cookie|set-cookie)\s*["']?\s*[:=][^\r\n]*/gi, '[redacted header]')
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/(["']?(?:password|passwd|token|secret|api[-_]?key|capability)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;}]+)/gi, '$1"[redacted]"')
    .replace(/(?:https?|wss?|file):\/\/[^\s"'<>]*/gi, '[redacted URL]')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s"'<> ,;}]+/g, '[redacted path]');
}
class Diagnostics {
  constructor() { this.events = []; }
  note(code, fields = {}) {
    if (!EVENTS.has(code)) code = 'NATIVE_OPERATION_FAILED';
    const event = { version: 1, at: new Date().toISOString(), component: code.startsWith('EDITOR') ? 'editor' : 'host', code };
    try { if (STATES.has(fields?.state)) event.state = fields.state; } catch {}
    this.events.push(event); if (this.events.length > 100) this.events.shift();
  }
  report() { return redact(redact(JSON.stringify({ version: 1, events: this.events }, null, 2))); }
  rendererEvents() {
    const names = { HELPER_EXITED: 'browser_failed', WORKSPACE_OPENED: 'workspace_changed', NATIVE_OPERATION_FAILED: 'code_failed' };
    return this.events.slice(-100).flatMap(event => {
      const name = event.code === 'EDITOR_STATE'
        ? ({ starting: 'code_starting', ready: 'code_ready', failed: 'code_failed' }[event.state])
        : names[event.code];
      return name ? [{ event: name, t: Date.parse(event.at) }] : [];
    });
  }
}
// Never retry persistence from its own failure handler or record disk errors.
function createDiagnosticSink(file, diagnostics, write = atomic) {
  const failed = () => { try { diagnostics.note('DIAGNOSTICS_WRITE_FAILED'); } catch {} };
  return function note(code, fields) {
    try {
      diagnostics.note(code, fields);
      const result = write(file, diagnostics.report());
      if (result && typeof result.then === 'function') Promise.resolve(result).catch(failed);
    } catch { failed(); }
  };
}
module.exports = { Diagnostics, redact, createDiagnosticSink };
