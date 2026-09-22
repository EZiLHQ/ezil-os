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
    this.index = fs.existsSync(this.indexPath) ? readJSON(this.indexPath) : { version: 2, workspaces: [], migrated: {} };
    if (![1, 2].includes(this.index.version) || !Array.isArray(this.index.workspaces)) throw Error('Unsupported workspace inventory');
    if (this.index.version === 1) {
      this.index.workspaces = this.index.workspaces.map(record => ({ ...record, kind: 'managed' }));
      this.index.version = 2; this.save();
    }
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
  list() { return this.index.workspaces.map(({ id, name, createdAt, kind }) => {
    let available = false; try { available = this.get(id, { allowMissing: true }).available; } catch { /* Keep damaged entries visible for recovery. */ }
    return { id, name, createdAt, kind, available };
  }); }
  get(id, { allowMissing = false } = {}) {
    this.checkRoots(); uuid(id); const record = this.index.workspaces.find(w => w.id === id);
    if (!record) throw Error('Workspace not found');
    const dir = path.join(this.managed, id);
    if (identity(noLinks(dir)) !== record.identity) throw Error('Workspace identity changed');
    for (const child of ['editor-data', 'extensions', 'browser', ...(record.kind === 'managed' ? ['files'] : [])]) if (identity(noLinks(path.join(dir, child))) !== record.children[child]) throw Error('Workspace child identity changed');
    const files = record.kind === 'attached' ? record.source : path.join(dir, 'files');
    let available = true;
    if (record.kind === 'attached') {
      try { available = fs.statSync(noLinks(files)).isDirectory() && identity(files) === record.sourceIdentity; } catch { available = false; }
      if (!available && !allowMissing) throw Error('Attached folder unavailable');
    }
    return { ...record, available, dir, files, editorData: path.join(dir, 'editor-data'), extensions: path.join(dir, 'extensions'), browser: path.join(dir, 'browser') };
  }
  attachedSource(source) {
    this.checkRoots();
    if (typeof source !== 'string' || !path.isAbsolute(source) || source.includes('\0')) throw Error('Invalid project folder');
    const canonical = fs.realpathSync(source);
    if (!fs.statSync(canonical).isDirectory()) throw Error('Invalid project folder');
    const relative = path.relative(this.root, canonical), inverse = path.relative(canonical, this.root);
    if ((!relative.startsWith(`..${path.sep}`) && relative !== '..') || (!inverse.startsWith(`..${path.sep}`) && inverse !== '..')) throw Error('Project overlaps app storage');
    return { source: canonical, sourceIdentity: identity(canonical) };
  }
  attach(label, source) {
    label = name(label); const target = this.attachedSource(source);
    const existing = this.index.workspaces.find(w => w.kind === 'attached' && (w.source === target.source || w.sourceIdentity === target.sourceIdentity));
    if (existing) return this.relink(existing.id, target.source);
    const id = randomUUID(), dir = privateDir(path.join(this.managed, id));
    const record = { id, name: label, createdAt: new Date().toISOString(), kind: 'attached', ...target, identity: identity(dir), children: {} };
    for (const child of ['editor-data', 'extensions', 'browser']) record.children[child] = identity(privateDir(path.join(dir, child)));
    this.index.workspaces.push(record); this.save(); return this.get(id);
  }
  relink(id, source) {
    const record = this.get(id, { allowMissing: true });
    if (record.kind !== 'attached') throw Error('Only attached folders can be relinked');
    const target = this.attachedSource(source);
    if (this.index.workspaces.some(w => w.id !== id && w.kind === 'attached' && (w.source === target.source || w.sourceIdentity === target.sourceIdentity))) throw Error('Folder already attached');
    Object.assign(this.index.workspaces.find(w => w.id === id), target); this.save(); return this.get(id);
  }
  rename(id, label) {
    this.checkRoots(); label = name(label);
    const record = this.get(id, { allowMissing: true }), index = this.index.workspaces.findIndex(workspace => workspace.id === id);
    this.index.workspaces[index] = { ...this.index.workspaces[index], name: label };
    this.save(); return { ...record, name: label };
  }
  create(label, source, legacyID) {
    this.checkRoots(); label = name(label);
    const id = randomUUID(), dir = privateDir(path.join(this.managed, id));
    try {
      if (source) copyTree(source, path.join(dir, 'files')); else privateDir(path.join(dir, 'files'));
      for (const child of ['editor-data', 'extensions', 'browser']) privateDir(path.join(dir, child));
      const record = { id, name: label, createdAt: new Date().toISOString(), kind: 'managed', identity: identity(dir), children: {} };
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
    const record = this.get(id, { allowMissing: true });
    const entries = treeInventory(record.dir, 100000, { allowSymlinks: true });
    removeInventory(entries);
    this.index.workspaces = this.index.workspaces.filter(w => w.id !== id); this.save();
  }
}
module.exports = { Workspaces };
