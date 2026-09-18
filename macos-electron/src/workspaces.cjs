'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { uuid, name } = require('./policy.cjs');
const { privateDir, atomic, readJSON, identity, noLinks, copyTree, treeInventory, removeInventory } = require('./files.cjs');
class Workspaces {
  constructor(root) {
    this.root = privateDir(root); this.rootIdentity = identity(root);
    this.managed = privateDir(path.join(root, 'workspaces')); this.managedIdentity = identity(this.managed);
    this.indexPath = path.join(root, 'inventory.json');
    this.index = fs.existsSync(this.indexPath) ? readJSON(this.indexPath) : { version: 1, workspaces: [], migrated: {} };
    if (this.index.version !== 1 || !Array.isArray(this.index.workspaces)) throw Error('Unsupported workspace inventory');
  }
  save() { this.checkRoots(); atomic(this.indexPath, JSON.stringify(this.index)); }
  checkRoots() {
    if (identity(noLinks(this.root)) !== this.rootIdentity || identity(noLinks(this.managed)) !== this.managedIdentity) throw Error('Workspace root changed');
  }
  guest() {
    const file = path.join(this.root, 'guest.json');
    if (fs.existsSync(file)) return readJSON(file);
    const value = { id: randomUUID(), createdAt: new Date().toISOString() }; atomic(file, JSON.stringify(value)); return value;
  }
  list() { return this.index.workspaces.map(({ id, name, createdAt }) => ({ id, name, createdAt })); }
  get(id) {
    this.checkRoots(); uuid(id); const record = this.index.workspaces.find(w => w.id === id);
    if (!record) throw Error('Workspace not found');
    const dir = path.join(this.managed, id);
    if (identity(noLinks(dir)) !== record.identity) throw Error('Workspace identity changed');
    for (const child of ['files', 'editor-data', 'extensions', 'browser']) if (identity(noLinks(path.join(dir, child))) !== record.children[child]) throw Error('Workspace child identity changed');
    return { ...record, dir, files: path.join(dir, 'files'), editorData: path.join(dir, 'editor-data'), extensions: path.join(dir, 'extensions'), browser: path.join(dir, 'browser') };
  }
  rename(id, label) {
    this.checkRoots(); label = name(label);
    const record = this.get(id), index = this.index.workspaces.findIndex(workspace => workspace.id === id);
    this.index.workspaces[index] = { ...this.index.workspaces[index], name: label };
    this.save(); return { ...record, name: label };
  }
  create(label, source, legacyID) {
    this.checkRoots(); label = name(label);
    const id = randomUUID(), dir = privateDir(path.join(this.managed, id));
    try {
      if (source) copyTree(source, path.join(dir, 'files')); else privateDir(path.join(dir, 'files'));
      for (const child of ['editor-data', 'extensions', 'browser']) privateDir(path.join(dir, child));
      const record = { id, name: label, createdAt: new Date().toISOString(), identity: identity(dir), children: {} };
      if (legacyID) { record.legacyID = legacyID; this.index.migrated[legacyID] = id; }
      for (const child of ['files', 'editor-data', 'extensions', 'browser']) record.children[child] = identity(path.join(dir, child));
      this.index.workspaces.push(record); this.save(); return this.get(id);
    } catch (error) { // Leave an unregistered failed copy for manual recovery; never delete source.
      throw Error('Workspace creation failed; original files are preserved', { cause: error });
    }
  }
  migrate(legacyRoot) {
    const guestFile = path.join(legacyRoot, 'guest-profile.json');
    if (!fs.existsSync(path.join(this.root, 'guest.json')) && fs.existsSync(guestFile)) {
      const guest = readJSON(guestFile);
      uuid(guest.id.toLowerCase());
      atomic(path.join(this.root, 'guest.json'), JSON.stringify({ id: guest.id.toLowerCase(), migrated: true }));
    }
    const base = path.join(legacyRoot, 'workspaces');
    if (!fs.existsSync(base)) return;
    noLinks(base);
    for (const folder of fs.readdirSync(base)) {
      if (!/^[0-9a-f-]{36}$/i.test(folder)) continue;
      const key = folder.toLowerCase();
      if (this.index.migrated[key]) continue;
      const old = path.join(base, folder), source = path.join(old, 'files');
      const record = readJSON(path.join(old, 'workspace.json'));
      // Never copy VM disks, editor passwords, or WebKit state. Copy-once marker
      // remains after native deletion so reopening never resurrects deleted work.
      const existing = this.index.workspaces.find(w => w.legacyID === key);
      const imported = existing || this.create(name(record.name), source, key);
      this.index.workspaces.find(w => w.id === imported.id).legacyID = key;
      this.index.migrated[key] = imported.id; this.save();
    }
  }
  remove(id, editorState, browserClosed) {
    if (editorState !== 'stopped' || browserClosed !== true) throw Error('Close the browser and stop the tracked editor before removal; unknown instances block removal');
    const record = this.get(id);
    const entries = treeInventory(record.dir);
    removeInventory(entries);
    this.index.workspaces = this.index.workspaces.filter(w => w.id !== id); this.save();
  }
}
module.exports = { Workspaces };
