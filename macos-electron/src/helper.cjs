'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { capabilities } = require('./policy.cjs');
const { cleanEnvironment } = require('./vscode.cjs');
const { privateDir } = require('./files.cjs');
function config(resources, env = process.env) {
  return {
    bun: env.EZIL_BUN_PATH || path.join(resources, 'bun', 'bun'),
    helper: env.EZIL_HELPER_PATH || path.join(resources, 'native', 'src', 'main.ts'),
    assets: env.EZIL_SHELL_ASSETS || path.join(resources, 'app', 'public', 'os'),
    shellPath: env.EZIL_SHELL_PATH || '/os'
  };
}
function readyLine(line) {
  if (!line.startsWith('EZIL_NATIVE_READY ')) return null;
  const value = JSON.parse(line.slice('EZIL_NATIVE_READY '.length));
  if (value.contractVersion !== 1 || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw Error('Invalid native helper ready line');
  for (const [key, expected] of Object.entries(capabilities)) if (key !== 'contractVersion' && value.capabilities?.[key] !== expected) throw Error('Native helper capabilities mismatch');
  return value;
}
function helperEnvironment(settings, root, workspace, capability) {
  return { ...cleanEnvironment(), EZIL_NATIVE_DATA_ROOT: privateDir(path.join(root, 'helper')), EZIL_NATIVE_WORKSPACE_ID: workspace.id, EZIL_NATIVE_WORKSPACE_ROOT: workspace.files, EZIL_NATIVE_SHELL_ASSETS: settings.assets, EZIL_NATIVE_ADMIN_CAPABILITY: capability, EZIL_NATIVE_HOST: '127.0.0.1', EZIL_NATIVE_PORT: '0' };
}
function authenticatedHeaders(details, helper) {
  const headers = { ...details.requestHeaders };
  if (new URL(details.url).origin !== helper.origin) return headers;
  for (const key of Object.keys(headers)) if (['authorization', 'origin'].includes(key.toLowerCase())) delete headers[key];
  headers.Authorization = `Bearer ${helper.capability}`;
  // Supplying the exact origin also covers API calls where Chromium omits it.
  headers.Origin = helper.origin;
  return headers;
}
async function startHelper(settings, root, workspace, onExit = () => {}) {
  for (const file of [settings.bun, settings.helper, ...['bundle.min.js', 'bundle.min.css', 'icons.js'].map(f => path.join(settings.assets, f))]) {
    if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) throw Error('Native runtime assets/helper absent. Set EZIL_BUN_PATH, EZIL_HELPER_PATH and EZIL_SHELL_ASSETS or rebuild the app.');
  }
  if (!/^\/(?!\/)[^?#]*$/.test(settings.shellPath)) throw Error('Invalid shell path');
  const capability = randomBytes(32).toString('hex');
  const child = spawn(settings.bun, ['run', settings.helper], {
    cwd: path.dirname(path.dirname(settings.helper)), stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    env: helperEnvironment(settings, root, workspace, capability)
  });
  // Helper output is a protocol, not a log sink. Never persist arbitrary output.
  child.stderr.resume();
  const ready = await new Promise((resolve, reject) => {
    let buffer = '', total = 0;
    const timer = setTimeout(() => fail(), 20000);
    const fail = () => { clearTimeout(timer); child.kill('SIGTERM'); reject(Error('Native helper failed to become ready (contract v1, 20 second timeout)')); };
    child.once('error', fail); child.once('exit', fail);
    child.stdout.on('data', chunk => {
      total += chunk.length; if (total > 65536) return fail();
      buffer += chunk.toString('utf8');
      while (buffer.includes('\n')) {
        const index = buffer.indexOf('\n'), line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
        try {
          const parsed = readyLine(line);
          if (parsed) { clearTimeout(timer); child.removeListener('exit', fail); child.removeListener('error', fail); child.stdout.removeAllListeners('data'); child.stdout.resume(); resolve(parsed); return; }
        } catch { fail(); }
      }
    });
  });
  child.once('exit', onExit);
  const origin = `http://127.0.0.1:${ready.port}`;
  return { child, origin, url: origin + settings.shellPath, capability, close: () => child.kill('SIGTERM') };
}
module.exports = { config, readyLine, startHelper, helperEnvironment, authenticatedHeaders };
