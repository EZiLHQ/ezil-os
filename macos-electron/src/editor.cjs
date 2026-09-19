'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { atomic } = require('./files.cjs');
const { editorEnvironment, cleanEnvironment } = require('./vscode.cjs');
const { configureTerminalEnvironment } = require('./development-environment.cjs');
const { installConnector } = require('./connector.cjs');
const CODE_SERVER = Object.freeze({ version: '4.137.0', archive: 'code-server-4.137.0-macos-arm64.tar.gz', sha256: '118604a8245816535d8e538f478d2ee93514bcb8ac75e210d2345a5dc7806f65' });
function processSnapshot() {
  // Process metadata only: never command lines, arguments, or environments.
  const text = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,lstart=,stat='], { env: cleanEnvironment(), encoding: 'utf8', timeout: 1000, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  return text.split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(\S+)\s*$/.exec(line);
    if (!match) throw Error('Process inventory unavailable');
    return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), identity: `${match[1]}:${match[4].replace(/\s+/g, ' ')}`, zombie: match[5].startsWith('Z') };
  });
}
function login(socketPath, password, request = http.request) {
  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({ password }).toString();
    const req = request({ socketPath, path: '/login', method: 'POST', headers: { host: 'localhost', origin: 'http://localhost', 'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body) } }, res => {
      res.resume();
      const cookies = res.headers['set-cookie'];
      if (res.statusCode === 302 && Array.isArray(cookies) && cookies.length) resolve(cookies.map(c => c.split(';')[0]).join('; '));
      else reject(Error('Editor authentication unavailable'));
    });
    req.on('error', reject); req.setTimeout(1000, () => req.destroy(Error('Editor timeout'))); req.end(body);
  });
}
class EditorSupervisor {
  constructor({ resources, extensionSource, launch = spawn, authenticate = login, socketStat = fs.lstatSync, note = () => {}, timeout = 20000, snapshot = processSnapshot, signalProcess = process.kill, stopGrace = 3000 } = {}) {
    Object.assign(this, { resources, extensionSource, launch, authenticate, socketStat, note, timeout, snapshot, signalProcess, stopGrace }); this.instances = new Map(); this.starts = new Map();
  }
  state(id) { return this.instances.get(id)?.state || 'stopped'; }
  transition(instance, state) { instance.state = state; this.note('EDITOR_STATE', { state }); }
  start(workspace, descriptors = {}) {
    if (this.starts.has(workspace.id)) return this.starts.get(workspace.id);
    const pending = this.startOnce(workspace, descriptors).finally(() => { if (this.starts.get(workspace.id) === pending) this.starts.delete(workspace.id); });
    this.starts.set(workspace.id, pending); return pending;
  }
  track(instance) {
    const rows = this.snapshot(), current = new Map(rows.map(row => [row.pid, row]));
    const root = current.get(instance.child.pid);
    if (!instance.rootIdentity && !instance.exited && root) {
      instance.rootIdentity = root.identity; instance.processes.set(root.pid, root.identity);
    }
    const live = new Set([...instance.processes].filter(([pid, identity]) => current.get(pid)?.identity === identity && !current.get(pid).zombie).map(([pid]) => pid));
    // Follow descendants, including PTY session leaders with different PGIDs.
    // Only a currently live, identity-matched member establishes ancestry.
    let changed;
    do {
      changed = false;
      const ownedGroups = new Set([...live].filter(pid => current.get(pid).pgid === pid));
      for (const row of rows) if (!row.zombie && row.pid > 1 && !live.has(row.pid) && (live.has(row.ppid) || ownedGroups.has(row.pgid))) {
        instance.processes.set(row.pid, row.identity); live.add(row.pid); changed = true;
      }
    } while (changed);
    return [...live].map(pid => current.get(pid));
  }
  signalTracked(instance, signal) {
    // Refresh immediately before signaling; never use a saved PID/group alone.
    const members = this.track(instance);
    for (const row of members.reverse()) {
      try { this.signalProcess(row.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    return members.length;
  }
  async startOnce(workspace, descriptors) {
    const previous = this.instances.get(workspace.id);
    if (previous?.state === 'ready') return previous;
    if (previous?.state === 'starting') return previous.pending;
    if (previous && previous.state !== 'stopped') await this.stop(workspace.id);
    const instance = { state: 'stopped' }; this.instances.set(workspace.id, instance);
    this.transition(instance, 'starting');
    instance.pending = this.launchInstance(workspace, instance, descriptors);
    return instance.pending;
  }
  async launchInstance(workspace, instance, descriptors) {
    try {
      configureTerminalEnvironment(workspace);
      // A short, private directory avoids Darwin's 104-byte Unix socket limit.
      instance.runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-editor-'))); fs.chmodSync(instance.runtime, 0o700);
      instance.socketPath = path.join(instance.runtime, 'editor.sock');
      instance.sessionSocketPath = path.join(instance.runtime, 'cli.sock');
      if ([instance.socketPath, instance.sessionSocketPath].some(file => Buffer.byteLength(file) >= 104)) throw Error('Runtime socket path too long');
      const password = randomBytes(32).toString('base64url');
      const config = path.join(instance.runtime, 'config.yaml');
      atomic(config, `auth: password\npassword: ${JSON.stringify(password)}\nsocket: ${JSON.stringify(instance.socketPath)}\nsocket-mode: "0600"\n`);
      if (this.extensionSource) installConnector(this.extensionSource, workspace);
      const executable = path.join(this.resources, 'code-server', 'bin', 'code-server');
      // Refuse a real launch when process ownership cannot be inspected. This
      // avoids creating an untrackable server in a restricted host/sandbox.
      if (this.launch === spawn) this.snapshot();
      instance.child = this.launch(executable, ['--config', config, '--session-socket', instance.sessionSocketPath, '--user-data-dir', workspace.editorData, '--extensions-dir', workspace.extensions, '--disable-telemetry', '--disable-update-check', workspace.files], {
        cwd: workspace.files, shell: false, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...editorEnvironment(descriptors, this.resources), ...(process.env.EZIL_SMOKE_OFFLINE === '1' ? { EXTENSIONS_GALLERY: '{}' } : {}) }
      });
      instance.child.once('error', () => { instance.exited = true; this.transition(instance, 'failed'); });
      instance.child.once('exit', () => {
        instance.exited = true;
        if (instance.state !== 'stopping' && instance.state !== 'stopped') {
          this.transition(instance, 'failed');
          // Defer so the exit notification remains observable as failed.
          queueMicrotask(() => { if (this.instances.get(workspace.id) === instance && instance.state === 'failed') void this.stop(workspace.id, true).catch(() => this.note('EDITOR_CLEANUP_FAILED')); });
        }
      });
      if (Number.isSafeInteger(instance.child.pid) && instance.child.pid > 1) {
        instance.processes = new Map(); this.track(instance);
        if (!instance.rootIdentity) throw Error('Editor process identity unavailable');
        instance.monitor = setInterval(() => {
          try { this.track(instance); } catch { instance.inventoryFailed = true; }
        }, 100);
        instance.monitor.unref();
      }
      const deadline = Date.now() + this.timeout;
      while (instance.state === 'starting' && Date.now() < deadline) {
        try {
          const stat = this.socketStat(instance.socketPath);
          if (!stat.isSocket() || (stat.mode & 0o077)) throw Error('Private socket required');
          const cookie = await this.authenticate(instance.socketPath, password);
          if (instance.state !== 'starting') throw Error('Cancelled');
          instance.cookie = cookie; this.transition(instance, 'ready'); return instance;
        } catch { await new Promise(resolve => setTimeout(resolve, 100)); }
      }
      throw Error('Editor unavailable');
    } catch {
      const cancelled = instance.state === 'stopping' || instance.state === 'stopped';
      if (!cancelled) this.transition(instance, 'failed');
      // stop() waits for exit before removing the private socket/config.
      if (!cancelled) await this.stop(workspace.id, true);
      throw Error('Editor unavailable');
    }
  }
  async stop(id, failed = false) {
    const instance = this.instances.get(id); if (!instance || instance.state === 'stopped') return;
    if (instance.stopping) return instance.stopping;
    this.transition(instance, 'stopping');
    instance.stopping = (async () => {
      const child = instance.child;
      if (instance.processes) {
        clearInterval(instance.monitor);
        try {
          this.signalTracked(instance, 'SIGTERM');
          const deadline = Date.now() + this.stopGrace;
          while (this.track(instance).length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
          if (this.track(instance).length) this.signalTracked(instance, 'SIGKILL');
          const killDeadline = Date.now() + 1000;
          while (this.track(instance).length && Date.now() < killDeadline) await new Promise(resolve => setTimeout(resolve, 50));
          if (this.track(instance).length || instance.inventoryFailed || !instance.rootIdentity) throw Error('Editor cleanup unverified');
        } catch (error) {
          // A live ChildProcess is still ours even when enumeration fails.
          // Stop that handle, retain the runtime, and do not claim descendants
          // were reaped when their identities cannot be verified.
          if (child && !instance.exited) {
            child.kill('SIGTERM');
            const timer = setTimeout(() => { if (!instance.exited) child.kill('SIGKILL'); }, this.stopGrace);
            timer.unref(); child.once('exit', () => clearTimeout(timer));
          }
          this.transition(instance, 'failed'); throw error;
        }
      } else if (child && !instance.exited) {
        await new Promise(resolve => {
          const timer = setTimeout(() => child.kill('SIGKILL'), this.stopGrace);
          child.once('exit', () => { clearTimeout(timer); resolve(); }); child.kill('SIGTERM');
        });
      }
      instance.cookie = null;
      if (instance.runtime) fs.rmSync(instance.runtime, { recursive: true, force: true });
      this.transition(instance, failed ? 'failed' : 'stopped');
    })();
    try { await instance.stopping; } finally { instance.stopping = null; }
  }
  async close() { await Promise.all([...this.instances.keys()].map(id => this.stop(id))); }
}
module.exports = { EditorSupervisor, CODE_SERVER, login };
