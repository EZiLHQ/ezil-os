'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const { noLinks, identity, atomic, readJSON } = require('./files.cjs');
const { installConnector } = require('./connector.cjs');
const TEAM = 'UBF8T346G9', BUNDLE = 'com.microsoft.VSCode';
const MINIMUM_VERSION = Object.freeze({ major: 1, minor: 109 });
const INSTALLER = 'https://code.visualstudio.com/download';
function validSignature(bundleID, details) {
  return bundleID.trim() === BUNDLE && details.split('\n').includes(`TeamIdentifier=${TEAM}`) && details.split('\n').includes(`Identifier=${BUNDLE}`) && details.split('\n').includes(`Authority=Developer ID Application: Microsoft Corporation (${TEAM})`);
}
function supportedVersion(value) {
  const match = /^(\d+)\.(\d+)(?:\.\d+)?$/.exec(String(value).trim());
  return !!match && (Number(match[1]) > MINIMUM_VERSION.major || (Number(match[1]) === MINIMUM_VERSION.major && Number(match[2]) >= MINIMUM_VERSION.minor));
}
function discover({ platform = process.platform, home = os.homedir(), run = execFileSync } = {}) {
  if (platform !== 'darwin') return null;
  for (const app of ['/Applications/Visual Studio Code.app', path.join(home, 'Applications/Visual Studio Code.app')]) {
    try {
      noLinks(app);
      const bundleID = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' });
      run('/usr/bin/codesign', ['--verify', '--deep', '--strict', '-R', `anchor apple generic and identifier "${BUNDLE}" and certificate leaf[subject.OU] = "${TEAM}"`, app], { stdio: 'pipe' });
      // codesign writes its display output to stderr even on success.
      const details = require('node:child_process').spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', app], { encoding: 'utf8' });
      if (details.status !== 0 || !validSignature(bundleID, details.stderr)) continue;
      const version = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', path.join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
      if (!supportedVersion(version)) continue;
      const executable = path.join(app, 'Contents/MacOS/Electron');
      noLinks(executable); return { app, executable, identity: identity(executable), version };
    } catch { /* Missing, changed or unverifiable: never fall back to PATH. */ }
  }
  return null;
}
function argv(workspace) {
  for (const key of ['files', 'editorData', 'extensions']) if (!path.isAbsolute(workspace[key]) || workspace[key].includes('\0')) throw Error('Invalid editor directory');
  return ['--new-window', '--user-data-dir', workspace.editorData, '--extensions-dir', workspace.extensions, workspace.files];
}
function cleanEnvironment() {
  // Project tools retain normal user permissions, but never inherit EZiL
  // bootstrap/broker capabilities or provider credentials from Electron.
  return { HOME: os.homedir(), USER: os.userInfo().username, LOGNAME: os.userInfo().username, PATH: '/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin', TMPDIR: os.tmpdir(), LANG: 'en_US.UTF-8' };
}
function descriptorPath(file) {
  if (!file) return undefined;
  if (!path.isAbsolute(file)) throw Error('Invalid broker descriptor');
  noLinks(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096 || (stat.mode & 0o077) !== 0) throw Error('Invalid broker descriptor');
  return file;
}
function editorEnvironment(descriptors = {}) {
  const env = cleanEnvironment();
  const connector = descriptorPath(descriptors.connector);
  const model = descriptorPath(descriptors.model);
  if (connector) env.EZIL_BROKER_FILE = connector;
  if (model) env.EZIL_AI_BROKER_FILE = model;
  return env;
}
class Editors {
  constructor({ extensionSource, findCode = discover, launch = spawn } = {}) {
    this.instances = new Map(); this.starting = new Set();
    this.extensionSource = extensionSource; this.findCode = findCode; this.launch = launch;
  }
  marker(w) { return path.join(w.dir, 'editor-instance.json'); }
  state(w) {
    if (this.instances.has(w.id)) return 'running';
    if (!fs.existsSync(this.marker(w))) return 'stopped';
    return readJSON(this.marker(w)).state === 'stopped' ? 'stopped' : 'unknown';
  }
  async start(w, descriptors) {
    if (this.starting.has(w.id)) return { status: 'unavailable' };
    if (this.state(w) !== 'stopped') return { status: this.state(w) };
    const code = this.findCode(); if (!code) return { status: 'missing', installer: INSTALLER };
    installConnector(this.extensionSource, w);
    if (identity(code.executable) !== code.identity) throw Error('VS Code changed during verification');
    this.starting.add(w.id);
    try {
      atomic(this.marker(w), JSON.stringify({ state: 'unknown' }));
      const child = this.launch(code.executable, argv(w), { env: editorEnvironment(descriptors), stdio: 'ignore', shell: false });
      const instance = { child, stopping: false }; this.instances.set(w.id, instance);
      child.once('error', () => { this.instances.delete(w.id); });
      child.once('exit', () => {
        this.instances.delete(w.id);
        atomic(this.marker(w), JSON.stringify({ state: instance.stopping ? 'stopped' : 'unknown' }));
      });
      await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
      atomic(this.marker(w), JSON.stringify({ state: 'running', pid: child.pid || null, startedAt: new Date().toISOString() }));
      return { status: 'running' };
    } finally { this.starting.delete(w.id); }
  }
  async open(w, descriptors) {
    if (this.state(w) !== 'running') return this.start(w, descriptors);
    const code = this.findCode();
    if (!code || identity(code.executable) !== code.identity) return { status: 'unavailable' };
    // Forward a fixed reuse-window invocation to this dedicated VS Code profile.
    const child = this.launch(code.executable, ['--reuse-window', ...argv(w).slice(1)], { env: editorEnvironment(descriptors), stdio: 'ignore', shell: false });
    const status = await new Promise(resolve => {
      const timer = setTimeout(() => resolve('unavailable'), 5000);
      const done = value => { clearTimeout(timer); resolve(value); };
      child.once('error', () => done('unavailable'));
      child.once('exit', code => done(code === 0 ? 'running' : 'unavailable'));
    });
    return { status };
  }
  async stop(w) {
    const instance = this.instances.get(w.id);
    if (!instance) return this.state(w);
    instance.stopping = true;
    // Signal only this live child; never kill a saved PID or name-match processes.
    instance.child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => instance.child.once('exit', resolve)), new Promise(resolve => setTimeout(resolve, 5000))]);
    return this.state(w);
  }
}
module.exports = { MINIMUM_VERSION, validSignature, supportedVersion, discover, argv, cleanEnvironment, descriptorPath, editorEnvironment, Editors, INSTALLER };
