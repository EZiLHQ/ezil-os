'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { treeInventory, removeInventory, privateDir, noLinks, atomic, identity } = require('./files.cjs');
const connectorStatus = Object.freeze({ readiness: 'available', preview: 'available', modelProvider: 'available' });
const unavailableStatus = Object.freeze({ readiness: 'unavailable', preview: 'unavailable', modelProvider: 'unavailable' });
const forbidden = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|\.git)$/i;
function hashes(root) {
  noLinks(root);
  const result = {};
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      if (forbidden.test(entry.name)) throw Error('Private files in runtime input');
      const file = path.join(directory, entry.name), stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) throw Error('Link or special file refused');
      if (stat.isDirectory()) visit(file);
      else result[path.relative(root, file)] = createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    }
  }
  visit(root);
  return result;
}
function validateExtension(source) {
  const inventory = hashes(source);
  const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  if (!pkg.name || !pkg.version || !pkg.engines?.vscode || typeof pkg.main !== 'string' || path.isAbsolute(pkg.main) || pkg.main.split(/[\\/]/).includes('..') || !inventory[path.normalize(pkg.main)]) throw Error('Missing runnable connector extension');
  return inventory;
}
function copyHashed(source, destination, inventory) {
  privateDir(destination);
  for (const [relative, expected] of Object.entries(inventory)) {
    const from = path.join(source, relative), to = path.join(destination, relative);
    noLinks(from); privateDir(path.dirname(to));
    const stat = fs.lstatSync(from);
    if (!stat.isFile() || stat.nlink !== 1 || createHash('sha256').update(fs.readFileSync(from)).digest('hex') !== expected) throw Error('Connector source changed');
    fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  }
}
function installConnector(source, workspace) {
  // Only the fixed connector directory in this workspace's dedicated profile
  // is managed; the user's global extensions and other workspaces are untouched.
  const expected = validateExtension(source);
  const destination = path.join(privateDir(workspace.extensions), 'ezil-vscode');
  noLinks(destination);
  if (fs.existsSync(destination)) {
    const dependencies = path.join(destination, 'node_modules');
    if (fs.existsSync(dependencies)) removeInventory(treeInventory(dependencies));
    if (JSON.stringify(hashes(destination)) === JSON.stringify(expected)) return destination;
    removeInventory(treeInventory(destination));
  }
  copyHashed(source, destination, expected);
  if (JSON.stringify(hashes(destination)) !== JSON.stringify(expected)) throw Error('Connector copy mismatch');
  return destination;
}
function descriptorValue(root, workspace, helper, value, now = Date.now()) {
  if (!value || value.ok !== true || !/^[A-Za-z0-9_-]{43}$/.test(value.token) ||
      !Number.isFinite(value.expiresAt) || value.expiresAt <= now + 30_000 || value.expiresAt > now + 16 * 60_000) {
    throw Error('Invalid connector capability');
  }
  const workspaceIdentity = identity(noLinks(workspace.files));
  const expectedIdentity = workspace.kind === 'attached' ? workspace.sourceIdentity : workspace.children.files;
  if (workspaceIdentity !== expectedIdentity || !fs.lstatSync(workspace.files).isDirectory()) throw Error('Workspace identity changed');
  return { contractVersion: 1, origin: helper.origin, workspaceId: workspace.id,
    token: value.token, expiresAt: value.expiresAt, dataRoot: root, workspacePath: workspace.files,
    workspaceKind: workspace.kind, workspaceIdentity };
}
class ConnectorSession {
  constructor(root, workspace, helper, { fetchImpl = fetch, now = Date.now } = {}) {
    this.root = root; this.workspace = workspace; this.helper = helper; this.fetchImpl = fetchImpl; this.now = now;
    this.directory = privateDir(path.join(root, 'private', 'connectors'));
    this.descriptor = path.join(this.directory, `${workspace.id}.json`);
    this.closed = false; this.timer = null;
  }
  async renew() {
    if (this.closed) throw Error('Connector closed');
    const response = await this.fetchImpl(`${this.helper.origin}/api/native/capabilities`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { origin: this.helper.origin, authorization: `Bearer ${this.helper.capability}`, 'content-type': 'application/json' },
      body: JSON.stringify({ workspaceId: this.workspace.id, role: 'connector' }),
    });
    if (!response.ok) throw Error('Connector capability unavailable');
    const value = descriptorValue(this.root, this.workspace, this.helper, await response.json(), this.now());
    atomic(this.descriptor, JSON.stringify(value));
    this.schedule(Math.max(30_000, Math.min(10 * 60_000, value.expiresAt - this.now() - 2 * 60_000)));
    return value;
  }
  schedule(delay) {
    clearTimeout(this.timer);
    if (this.closed) return;
    this.timer = setTimeout(() => {
      void this.renew().catch(() => this.schedule(30_000));
    }, delay);
    this.timer.unref?.();
  }
  async start() { await this.renew(); return this; }
  status() { return this.closed ? unavailableStatus : connectorStatus; }
  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer);
    try { noLinks(this.descriptor); fs.unlinkSync(this.descriptor); } catch { /* Expiry revokes any descriptor we cannot safely unlink. */ }
  }
}
module.exports = { connectorStatus, unavailableStatus, hashes, validateExtension, installConnector, descriptorValue, ConnectorSession };
