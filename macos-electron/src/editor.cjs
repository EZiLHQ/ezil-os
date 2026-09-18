'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { privateDir, atomic } = require('./files.cjs');
const { editorEnvironment } = require('./vscode.cjs');
const { installConnector } = require('./connector.cjs');
const CODE_SERVER = Object.freeze({ version: '4.137.0', archive: 'code-server-4.137.0-macos-arm64.tar.gz', sha256: '118604a8245816535d8e538f478d2ee93514bcb8ac75e210d2345a5dc7806f65' });
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
  constructor({ resources, extensionSource, launch = spawn, authenticate = login, socketStat = fs.lstatSync, note = () => {}, timeout = 20000 } = {}) {
    Object.assign(this, { resources, extensionSource, launch, authenticate, socketStat, note, timeout }); this.instances = new Map(); this.starts = new Map();
  }
  state(id) { return this.instances.get(id)?.state || 'stopped'; }
  transition(instance, state) { instance.state = state; this.note('EDITOR_STATE', { state }); }
  start(workspace, descriptors = {}) {
    if (this.starts.has(workspace.id)) return this.starts.get(workspace.id);
    const pending = this.startOnce(workspace, descriptors).finally(() => { if (this.starts.get(workspace.id) === pending) this.starts.delete(workspace.id); });
    this.starts.set(workspace.id, pending); return pending;
  }
  signal(instance, signal) {
    if (Number.isSafeInteger(instance.child?.pid) && instance.child.pid > 1) {
      try { process.kill(-instance.child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    } else instance.child?.kill(signal);
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
      // A short, private directory avoids Darwin's 104-byte Unix socket limit.
      instance.runtime = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-editor-'))); fs.chmodSync(instance.runtime, 0o700);
      instance.socketPath = path.join(instance.runtime, 'editor.sock');
      const password = randomBytes(32).toString('base64url');
      const config = path.join(instance.runtime, 'config.yaml');
      atomic(config, `auth: password\npassword: ${JSON.stringify(password)}\nsocket: ${JSON.stringify(instance.socketPath)}\nsocket-mode: "0600"\n`);
      const home = privateDir(path.join(workspace.editorData, 'home'));
      if (this.extensionSource) installConnector(this.extensionSource, workspace);
      const executable = path.join(this.resources, 'code-server', 'bin', 'code-server');
      instance.child = this.launch(executable, ['--config', config, '--user-data-dir', workspace.editorData, '--extensions-dir', workspace.extensions, '--disable-telemetry', '--disable-update-check', workspace.files], {
        cwd: workspace.files, shell: false, detached: true, stdio: ['ignore', 'ignore', 'ignore'],
        env: { ...editorEnvironment(descriptors), HOME: home, XDG_CONFIG_HOME: privateDir(path.join(home, '.config')), ...(process.env.EZIL_SMOKE_OFFLINE === '1' ? { EXTENSIONS_GALLERY: '{}' } : {}) }
      });
      instance.child.once('error', () => { instance.exited = true; this.transition(instance, 'failed'); });
      instance.child.once('exit', () => { instance.exited = true; if (instance.state !== 'stopping' && instance.state !== 'stopped') this.transition(instance, 'failed'); });
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
      if (child && !instance.exited) {
        await new Promise(resolve => {
          const timer = setTimeout(() => this.signal(instance, 'SIGKILL'), 3000);
          child.once('exit', () => { clearTimeout(timer); resolve(); }); this.signal(instance, 'SIGTERM');
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
