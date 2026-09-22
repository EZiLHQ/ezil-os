'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const { cleanEnvironment } = require('./vscode.cjs');
const { noLinks, identity } = require('./files.cjs');
const active = new Set();
const TEAM = 'EQHXZ8M8AV';
const unknown = () => Object.assign(Error('Chrome profile use cannot be excluded'), { code: 'secure_browser_unknown' });
const busy = () => Object.assign(Error('Chrome profile is in use'), { code: 'secure_browser_busy' });

function secureDestination(value = 'https://www.google.com/') {
  if (typeof value !== 'string' || value.length > 4096 || !/^https:\/\//i.test(value) || /[\s\\\x00-\x1f\x7f]/.test(value)) throw TypeError('HTTPS destination required');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || value.slice(8).split('/')[0].includes('@')) throw TypeError('Credential-free HTTPS required');
  return url.hostname === 'accounts.google.com' ? 'https://www.google.com/' : `${url.origin}/`;
}

function directory(file, create = false) {
  noLinks(file);
  if (create && !fs.existsSync(file)) fs.mkdirSync(file, { mode: 0o700 });
  const s = fs.lstatSync(file);
  if (!s.isDirectory() || s.uid !== process.getuid() || (s.mode & 0o077)) throw unknown();
  return identity(file);
}
function layout(w, create = false) {
  // Repeated inode checks detect path replacement; like the host's file helpers,
  // they are not containment against a hostile concurrent process of this UID.
  if (!w || typeof w.id !== 'string' || !w.id || typeof w.dir !== 'string' || !path.isAbsolute(w.dir) || w.dir !== path.resolve(w.dir) || w.browser !== path.join(w.dir, 'browser')) throw unknown();
  const profile = path.join(w.browser, 'secure-chrome');
  const dirs = [w.dir, w.browser, profile];
  const ids = dirs.map((p, i) => directory(p, create && i > 0));
  return { profile, marker: path.join(profile, '.ezil-owner.json'), check() { dirs.forEach((p, i) => { if (directory(p) !== ids[i]) throw unknown(); }); } };
}
function readMarker(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== process.getuid() || s.nlink !== 1 || (s.mode & 0o077) || s.size > 4096) throw unknown();
    const buf = Buffer.alloc(4097), n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n > 4096) throw unknown();
    return JSON.parse(buf.subarray(0, n).toString());
  } catch (e) { if (e.code === 'ENOENT') return null; throw unknown(); }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

class SecureBrowser {
  constructor({ platform = process.platform, home = os.homedir(), run = execute, launch = spawn, snapshot, timeout = 5000 } = {}) {
    Object.assign(this, { platform, home, run, launch });
    this.timeout = Math.max(1, Math.min(Number(timeout) || 5000, 10000));
    this.snapshot = snapshot || (async () => {
      const output = await this.invoke('/bin/ps', ['-axo', 'pid=,ppid=,lstart=,comm=']);
      const rows = output.split('\n').filter(s => s.trim()).map(line => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(line);
        if (!m) throw unknown();
        return { pid: Number(m[1]), ppid: Number(m[2]), start: m[3].replace(/\s+/g, ' '), executable: m[4], chrome: /Google Chrome/.test(m[4]), profile: null };
      });
      const roots = rows.filter(r => r.chrome && r.executable.endsWith('/Contents/MacOS/Google Chrome'));
      if (roots.length > 128 || rows.length > 16384) throw unknown();
      await Promise.all(roots.map(async row => {
        // Only Chrome browser PIDs: discard command text immediately after extracting
        // the profile switch. Never log, persist or return URLs/other arguments.
        const detail = await this.invoke('/bin/ps', ['-ww', '-p', String(row.pid), '-o', 'lstart=,command=']);
        const fields = /^(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(detail);
        if (!fields || fields[1].replace(/\s+/g, ' ') !== row.start) return;
        const command = fields[2];
        if (!command.startsWith(row.executable + ' ') && command !== row.executable) return;
        const tail = command.slice(row.executable.length);
        const switches = tail.match(/--user-data-dir(?:=|\s)/g) || [];
        if (!switches.length) { row.profile = path.join(this.home, 'Library/Application Support/Google/Chrome'); return; }
        if (switches.length !== 1) return;
        // ps flattens argv. Ambiguous quoting or delimiters fail closed.
        const match = /(?:^|\s)--user-data-dir(?:=|\s+)(.*?)(?=\s+--|\s+https?:\/\/|$)/.exec(tail);
        const value = match?.[1];
        if (!value || !path.isAbsolute(value) || value !== path.resolve(value) || /["'\x00-\x1f]/.test(value)) return;
        try { noLinks(value); if (fs.statSync(value).isDirectory()) row.profile = fs.realpathSync(value); } catch { /* Unknown alias or flattened argv. */ }
      }));
      // Chrome crash reporters intentionally outlive/reparent away from browser
      // processes. Attribute their own database, not the browser's cookie store.
      // Only a known, verified Google bundle and a single canonical Crashpad
      // directory establish ownership; unresolved reporters still fail closed.
      const reporters = rows.filter(r => r.chrome && r.executable.endsWith('/chrome_crashpad_handler'));
      if (reporters.length > 128) throw unknown();
      const verifiedBundles = new Map();
      await Promise.all(reporters.map(async row => {
        const app = ['/Applications/Google Chrome.app', path.join(this.home, 'Applications/Google Chrome.app')].find(app => {
          const prefix = app + '/Contents/Frameworks/Google Chrome Framework.framework/Versions/';
          return row.executable.startsWith(prefix) && /^\d+\.\d+\.\d+\.\d+\/Helpers\/chrome_crashpad_handler$/.test(row.executable.slice(prefix.length));
        });
        if (!app) return;
        try {
          noLinks(row.executable);
          const before = identity(row.executable);
          if (!verifiedBundles.has(app)) verifiedBundles.set(app, this.invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "${TEAM}"`, app]));
          await verifiedBundles.get(app);
          const detail = await this.invoke('/bin/ps', ['-ww', '-p', String(row.pid), '-o', 'lstart=,command=']);
          const fields = /^(\S+\s+\S+\s+\d+\s+\S+\s+\d+)\s+(.+)$/.exec(detail);
          if (!fields || fields[1].replace(/\s+/g, ' ') !== row.start || !fields[2].startsWith(row.executable + ' ') || identity(row.executable) !== before) return;
          const tail = fields[2].slice(row.executable.length);
          if ((tail.match(/--database(?:=|\s)/g) || []).length !== 1) return;
          const value = /(?:^|\s)--database(?:=|\s+)(.*?)(?=\s+--|$)/.exec(tail)?.[1];
          if (!value || !path.isAbsolute(value) || value !== path.resolve(value) || /["'\x00-\x1f]/.test(value) || path.basename(value) !== 'Crashpad') return;
          noLinks(value);
          if (fs.statSync(value).isDirectory()) row.profile = path.dirname(fs.realpathSync(value));
        } catch { /* Keep the reporter unresolved; never guess its owner. */ }
      }));
      // Helpers inherit only through observed ancestry, never name alone.
      const byPID = new Map(rows.map(row => [row.pid, row]));
      const rootPIDs = new Set(roots.map(row => row.pid));
      for (let pass = 0; pass < 32; pass++) {
        let changed = false;
        for (const row of rows.filter(r => r.chrome && !r.profile && !rootPIDs.has(r.pid))) {
          const parent = byPID.get(row.ppid);
          if (parent?.chrome && parent.profile) { row.profile = parent.profile; changed = true; }
        }
        if (!changed) break;
      }
      return rows;
    });
  }
  async bounded(operation) {
    let timer;
    try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(unknown()), this.timeout); })]); }
    finally { clearTimeout(timer); }
  }
  async invoke(file, args) {
    const result = await this.bounded(() => this.run(file, args, { env: cleanEnvironment(), encoding: 'utf8', timeout: this.timeout, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], shell: false }));
    return (typeof result === 'string' ? result : result.stdout).trim();
  }
  async discover() {
    if (this.platform !== 'darwin') return { available: false, version: '', reason: 'unavailable' };
    let result = { available: false, version: '', reason: 'missing' };
    for (const app of ['/Applications/Google Chrome.app', path.join(this.home, 'Applications/Google Chrome.app')]) {
      try {
        if (!fs.lstatSync(app, { throwIfNoEntry: false })) continue;
        noLinks(app);
        const plist = path.join(app, 'Contents/Info.plist');
        noLinks(plist); const before = identity(plist);
        await this.invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "${TEAM}"`, app]);
        const read = key => this.invoke('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist]);
        if (await read('CFBundleIdentifier') !== 'com.google.Chrome') throw Error('Bundle identity');
        const version = await read('CFBundleShortVersionString'), binary = await read('CFBundleExecutable');
        if (binary !== 'Google Chrome' || !/^\d+\.\d+\.\d+\.\d+$/.test(version)) throw Error('Manifest');
        const executable = path.join(app, 'Contents/MacOS', binary);
        noLinks(executable); const s = fs.lstatSync(executable);
        if (!s.isFile() || !(s.mode & 0o111) || identity(plist) !== before) throw Error('Changed bundle');
        await this.invoke('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `=anchor apple generic and identifier "com.google.Chrome" and certificate leaf[subject.OU] = "${TEAM}"`, app]);
        if (Number(version.split('.')[0]) < 153) { result = { available: false, version, reason: 'outdated' }; continue; }
        return { available: true, version, executable, fingerprint: `${identity(executable)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` };
      } catch (error) {
        // A bounded/OS timeout is not evidence of a bad Google signature.
        // Still refuse launch, but allow retry instead of recommending reinstall.
        const incomplete = error?.code === 'secure_browser_unknown' || error?.code === 'ETIMEDOUT' || error?.killed === true;
        result = { available: false, version: '', reason: incomplete ? 'unavailable' : 'untrusted' };
      }
    }
    return result;
  }
  async status() { const { available, version, reason } = await this.discover(); return reason ? { available, version, reason } : { available, version }; }
  async inspect(w, l, ownGate = false, executable) {
    l.check();
    if (!ownGate && fs.lstatSync(path.join(l.profile, '.ezil-launch'), { throwIfNoEntry: false })) throw unknown();
    const rows = await this.bounded(() => this.snapshot());
    l.check();
    if (!ownGate && active.has(w.browser)) throw busy();
    if (!ownGate && fs.lstatSync(path.join(l.profile, '.ezil-launch'), { throwIfNoEntry: false })) throw unknown();
    if (!Array.isArray(rows) || !rows.length || rows.some(r => !Number.isSafeInteger(r.pid) || r.pid < 1 || typeof r.start !== 'string' || !r.start || typeof r.chrome !== 'boolean')) throw unknown();
    const m = readMarker(l.marker);
    if (m && (m.schema !== 1 || m.workspace !== w.id || m.profile !== l.profile || m.host !== os.hostname() || !['owned', 'failed'].includes(m.state))) throw unknown();
    let owner;
    if (m?.state === 'owned') {
      if (!Number.isSafeInteger(m.pid) || m.pid < 2 || typeof m.start !== 'string' || !m.start) throw unknown();
      const row = rows.find(r => r.pid === m.pid);
      if (row?.start === m.start) {
        if (!row.chrome || row.profile !== l.profile || row.executable !== m.executable) throw unknown();
        owner = row;
      }
    }
    let locked = false;
    for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
      const file = path.join(l.profile, name), s = fs.lstatSync(file, { throwIfNoEntry: false });
      if (!s) continue;
      if (name === 'SingletonLock' && s.isSymbolicLink()) {
        const target = fs.readlinkSync(file);
        const prefix = `${os.hostname()}-`;
        if (target.startsWith(prefix) && /^\d+$/.test(target.slice(prefix.length))) {
          const row = rows.find(r => r.pid === Number(target.slice(prefix.length)) && r.chrome);
          if (row && row === owner) { locked = true; continue; }
          if (row) throw busy();
        }
      }
      if (name !== 'SingletonLock' && locked && owner) continue;
      throw unknown();
    }
    if (rows.some(r => r.chrome && !r.profile)) throw unknown();
    if (owner) {
      if (rows.some(r => r !== owner && r.chrome && r.profile === l.profile && r.executable === owner.executable)) throw unknown();
      if (executable === owner.executable) { l.check(); return owner; }
      throw busy();
    }
    if (rows.some(r => r.chrome && r.profile === l.profile)) throw busy();
    l.check();
  }
  async assertRemovable(w) {
    try {
      if (active.has(w?.browser)) throw busy();
      if (!w || typeof w.id !== 'string' || !w.id || typeof w.dir !== 'string' || !path.isAbsolute(w.dir) || w.dir !== path.resolve(w.dir)) throw unknown();
      // Missing profile is safe only after validating existing ancestors.
      directory(w.dir);
      if (w.browser !== path.join(w.dir, 'browser')) throw unknown();
      if (!fs.lstatSync(w.browser, { throwIfNoEntry: false })) return;
      directory(w.browser);
      if (!fs.lstatSync(path.join(w.browser, 'secure-chrome'), { throwIfNoEntry: false })) return;
      const l = layout(w); await this.inspect(w, l); await this.inspect(w, l);
    } catch (e) { throw e.code === 'secure_browser_busy' ? e : unknown(); }
  }
  async open(w, destination) {
    const url = secureDestination(destination);
    if (active.has(w?.browser)) return { opened: false, reason: 'profile_busy' };
    active.add(w?.browser);
    let fd, child, l, gate, gateID, owner;
    try {
      const chrome = await this.discover();
      if (!chrome.available) return { opened: false, reason: chrome.reason };
      l = layout(w, true);
      try {
        gate = path.join(l.profile, '.ezil-launch');
        const handle = fs.openSync(gate, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
        fs.closeSync(handle); gateID = identity(gate);
        owner = await this.inspect(w, l, true, chrome.executable);
      } catch { return { opened: false, reason: 'profile_busy' }; }
      // Exclusive intent survives a host crash before process ownership is saved.
      // A previous validated marker may be replaced, never profile contents.
      const previous = readMarker(l.marker);
      if (!owner) {
        if (previous) { l.check(); fs.unlinkSync(l.marker); }
        fd = fs.openSync(l.marker, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
      }
      const base = { schema: 1, workspace: w.id, profile: l.profile, host: os.hostname(), executable: chrome.executable };
      const write = value => { l.check(); fs.ftruncateSync(fd, 0); fs.writeSync(fd, JSON.stringify({ ...base, ...value }), 0, 'utf8'); fs.fsyncSync(fd); };
      if (!owner) write({ state: 'starting' });
      const s = fs.lstatSync(noLinks(chrome.executable));
      if (`${identity(chrome.executable)}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` !== chrome.fingerprint) throw unknown();
      l.check();
      let spawned = false, definiteFailure = false;
      try {
        child = this.launch(chrome.executable, ['--new-window', `--user-data-dir=${l.profile}`, url], { cwd: l.profile, env: cleanEnvironment(), detached: true, shell: false, stdio: 'ignore' });
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(unknown()), this.timeout);
          child.once('spawn', () => { spawned = true; if (!owner) { clearTimeout(timer); resolve(); } });
          child.once('error', e => { definiteFailure = !spawned && !child.pid; clearTimeout(timer); reject(e); });
          child.once('exit', code => { clearTimeout(timer); if (owner && code === 0) resolve(); else reject(unknown()); });
        });
      } catch (e) {
        // Only a definite spawn failure establishes that no process was created.
        if (!owner && (!child || definiteFailure)) write({ state: 'failed' });
        throw e;
      }
      if (owner) { l.check(); return { opened: true }; }
      const row = (await this.bounded(() => this.snapshot())).find(r => r.pid === child.pid && r.chrome && r.start && r.profile === l.profile && r.executable === chrome.executable);
      if (!row) throw unknown();
      write({ state: 'owned', pid: row.pid, start: row.start });
      return { opened: true };
    } catch { return { opened: false, reason: 'unavailable' }; }
    finally {
      child?.unref();
      if (fd !== undefined) fs.closeSync(fd);
      try { if (gateID) { l.check(); if (identity(gate) === gateID) fs.unlinkSync(gate); } } catch { /* Retain uncertainty. */ }
      active.delete(w?.browser);
    }
  }
}
module.exports = { SecureBrowser, secureDestination };
