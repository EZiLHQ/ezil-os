'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { capabilities } = require('./policy.cjs');
const { cleanEnvironment } = require('./vscode.cjs');
const { privateDir } = require('./files.cjs');
const { ConnectorSession } = require('./connector.cjs');
function config(resources, env = process.env) {
  return {
    bun: env.EZIL_BUN_PATH || path.join(resources, 'bun', 'bun'),
    helper: env.EZIL_HELPER_PATH || path.join(resources, 'native', 'src', 'helper.js'),
    assets: env.EZIL_SHELL_ASSETS || path.join(resources, 'app', 'public', 'os'),
    shellPath: env.EZIL_SHELL_PATH || '/os'
  };
}
function readyLine(line) {
  if (!line.startsWith('EZIL_NATIVE_READY ')) return null;
  const value = JSON.parse(line.slice('EZIL_NATIVE_READY '.length));
  if (value.contractVersion !== 2 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw Error('Invalid native helper ready line');
  for (const [key, expected] of Object.entries(capabilities)) if (key !== 'contractVersion' && value.capabilities?.[key] !== expected) throw Error('Native helper capabilities mismatch');
  return value;
}
function helperEnvironment(settings, root, workspace, capability) {
  return { ...cleanEnvironment(), EZIL_NATIVE_DATA_ROOT: privateDir(path.join(root, 'helper')), EZIL_NATIVE_WORKSPACE_ID: workspace.id, EZIL_NATIVE_WORKSPACE_ROOT: workspace.files, EZIL_NATIVE_SHELL_ASSETS: settings.assets, EZIL_NATIVE_ADMIN_CAPABILITY: capability, EZIL_NATIVE_HOST: '127.0.0.1', EZIL_NATIVE_PORT: '0' };
}
function authenticatedHeaders(details, helper) {
  const headers = { ...details.requestHeaders };
  for (const key of Object.keys(headers)) if (['authorization', 'cookie', 'origin'].includes(key.toLowerCase())) delete headers[key];
  if (new URL(details.url).origin !== helper.origin || details.webContentsId !== helper.webContentsId || !helper.shellCapability) return headers;
  let source; try { source = new URL(details.initiator || details.origin || details.frame?.url || details.referrer).origin; } catch {}
  // The initial main-frame navigation has no initiator. All subsequent requests
  // must originate in the exact shared-shell origin and registered webContents.
  if (source !== helper.origin && !(details.resourceType === 'mainFrame' && details.url === helper.url)) return headers;
  headers.Authorization = `Bearer ${helper.shellCapability}`;
  headers.Origin = helper.origin;
  return headers;
}
async function shellCapability(helper, workspaceId) {
  const response = await fetch(`${helper.origin}/api/native/capabilities`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { origin: helper.origin, authorization: `Bearer ${helper.capability}`, 'content-type': 'application/json' },
    body: JSON.stringify({ workspaceId, role: 'shell' })
  });
  const value = await response.json();
  if (!response.ok || value.ok !== true || !/^[A-Za-z0-9_-]{43}$/.test(value.token) || !Number.isFinite(value.expiresAt) || value.expiresAt < Date.now() + 30000 || value.expiresAt > Date.now() + 6 * 60000) throw Error('Shell capability unavailable');
  helper.shellCapability = value.token;
  return value.expiresAt;
}
async function workspaceStatus(helper, workspaceId, fetchImpl = fetch) {
  const response = await fetchImpl(`${helper.origin}/api/native/previews`, {
    method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000),
    headers: { origin: helper.origin, authorization: `Bearer ${helper.capability}` },
  });
  if (!response.ok) return undefined;
  const value = await response.json();
  if (!value || value.ok !== true || value.workspaceId !== workspaceId || !Array.isArray(value.ports) || value.ports.length > 16 ||
      !['active', 'closed', 'unknown'].includes(value.editorState) ||
      value.ports.some(port => !Number.isInteger(port) || port < 1024 || port > 65535)) return undefined;
  return { editorState: value.editorState, ports: [...value.ports].sort((a, b) => a - b) };
}
async function registeredPreview(helper, workspaceId, fetchImpl = fetch) {
  const value = await workspaceStatus(helper, workspaceId, fetchImpl);
  return value?.ports.length ? `http://127.0.0.1:${value.ports[0]}/` : undefined;
}
async function performOperation(helper, operation, fetchImpl = fetch) {
  const response = await fetchImpl(`${helper.origin}/api/native/operations`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { origin: helper.origin, authorization: `Bearer ${helper.capability}`, 'content-type': 'application/json' },
    body: JSON.stringify(operation)
  });
  const value = await response.json();
  if (!response.ok || value?.ok !== true) throw Error('Local operation unavailable');
  return value;
}
async function previewReady(port, fetchImpl = fetch) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) return false;
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/`, { redirect: 'manual', signal: AbortSignal.timeout(2000) });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 400;
  } catch { return false; }
}
function waitForReady(child, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    let buffer = '', total = 0, settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('error', launchFailed); child.removeListener('exit', exited);
      child.stdout.removeListener('data', data); child.stdout.resume();
    };
    // Report fixed, actionable reasons only. Child output can contain private
    // paths or credentials and must never become an error message or log.
    const fail = message => {
      if (settled) return;
      settled = true; cleanup();
      try { child.kill('SIGTERM'); } catch { /* The child may already be gone. */ }
      reject(Error(message));
    };
    const launchFailed = () => fail('Native helper could not start. Rebuild or reinstall EZiL OS.');
    const exited = () => fail('Native helper exited before becoming ready. Rebuild or reinstall EZiL OS.');
    const data = chunk => {
      total += chunk.length;
      if (total > 65536) return fail('Native helper exceeded its startup response limit. Rebuild or reinstall EZiL OS.');
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        let parsed;
        try { parsed = readyLine(line); }
        catch { fail('Native helper returned an incompatible startup response (contract v2). Rebuild or reinstall EZiL OS.'); return; }
        if (parsed) { settled = true; cleanup(); resolve(parsed); return; }
      }
    };
    const timer = setTimeout(() => fail('Native helper did not become ready within 20 seconds (contract v2). Try again or reinstall EZiL OS.'), timeoutMs);
    child.once('error', launchFailed); child.once('exit', exited); child.stdout.on('data', data);
  });
}
async function startHelper(settings, root, workspace, onExit = () => {}) {
  for (const file of [settings.bun, settings.helper, ...['bundle.min.js', 'bundle.min.css', 'icons.js'].map(f => path.join(settings.assets, f))]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw Error('Native runtime assets/helper absent. Set EZIL_BUN_PATH, EZIL_HELPER_PATH and EZIL_SHELL_ASSETS or rebuild the app.');
  }
  if (!/^\/(?!\/)[^?#]*$/.test(settings.shellPath)) throw Error('Invalid shell path');
  const capability = randomBytes(32).toString('hex');
  const child = spawn(settings.bun, ['--no-env-file', settings.helper], {
    cwd: path.dirname(path.dirname(settings.helper)), stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    env: helperEnvironment(settings, root, workspace, capability)
  });
  // Helper output is a protocol, not a log sink. Never persist arbitrary output.
  child.stderr.resume();
  const ready = await waitForReady(child);
  child.once('exit', onExit);
  const origin = `http://127.0.0.1:${ready.port}`;
  const helper = { origin, capability };
  let connector = null;
  try { connector = await new ConnectorSession(root, workspace, helper).start(); } catch { /* Desktop/browser stay available without the editor connector. */ }
  Object.assign(helper, { child, url: origin + settings.shellPath, connector });
  let timer, closed = false;
  const renew = async () => {
    const expiresAt = await shellCapability(helper, workspace.id);
    if (closed) { helper.shellCapability = null; return; }
    timer = setTimeout(() => { renew().catch(() => { helper.shellCapability = null; child.kill('SIGTERM'); }); }, Math.max(1000, expiresAt - Date.now() - 60000));
    timer.unref?.();
  };
  helper.close = () => {
    if (helper.closing) return helper.closing;
    closed = true; clearTimeout(timer); helper.shellCapability = null; connector?.close();
    helper.closing = new Promise(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      const kill = setTimeout(() => child.kill('SIGKILL'), 3000);
      child.once('exit', () => { clearTimeout(kill); resolve(); }); child.kill('SIGTERM');
    });
    return helper.closing;
  };
  try { await renew(); } catch { helper.close(); throw Error('Shell capability unavailable'); }
  return helper;
}
module.exports = { config, readyLine, waitForReady, startHelper, helperEnvironment, authenticatedHeaders, workspaceStatus, registeredPreview, shellCapability, performOperation, previewReady };
