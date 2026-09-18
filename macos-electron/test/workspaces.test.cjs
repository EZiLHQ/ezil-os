'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Workspaces } = require('../src/workspaces.cjs');
const { treeInventory, removeInventory } = require('../src/files.cjs');
function setup(t) { const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-test-'))); t.after(() => fs.rmSync(temp, { recursive: true, force: true })); return temp; }
test('persistent random guest/workspace; removal preserves imports and outside canary', t => {
  const temp = setup(t), source = path.join(temp, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'project.txt'), 'original');
  const root = path.join(temp, 'native'), store = new Workspaces(root), guest = store.guest(), w = store.create('Test', source);
  assert.equal(new Workspaces(root).guest().id, guest.id); assert.equal(new Workspaces(root).get(w.id).name, 'Test');
  fs.mkdirSync(path.join(w.dir, 'shell-profile')); fs.writeFileSync(path.join(w.dir, 'shell-profile', 'preferences'), 'persisted');
  for (const state of ['running', 'unknown']) assert.throws(() => store.remove(w.id, state, true));
  assert.throws(() => store.remove(w.id, 'stopped', false));
  store.remove(w.id, 'stopped', true); assert.equal(fs.existsSync(w.dir), false); assert.equal(fs.readFileSync(path.join(source, 'project.txt'), 'utf8'), 'original');
});
test('removal rejects symlink, hardlink and replaced directory escapes', t => {
  const temp = setup(t), store = new Workspaces(path.join(temp, 'native')), w = store.create('Test');
  const outside = path.join(temp, 'canary'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(w.files, 'escape')); assert.throws(() => store.remove(w.id, 'stopped', true)); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  fs.unlinkSync(path.join(w.files, 'escape')); fs.linkSync(outside, path.join(w.files, 'hard')); assert.throws(() => store.remove(w.id, 'stopped', true)); fs.unlinkSync(path.join(w.files, 'hard'));
  fs.renameSync(w.files, path.join(w.dir, 'old-files')); fs.mkdirSync(w.files); assert.throws(() => store.remove(w.id, 'stopped', true));
});
test('inventoried removal detects an identity replacement before deleting anything', t => {
  const temp = setup(t), root = path.join(temp, 'tree'); fs.mkdirSync(root); fs.writeFileSync(path.join(root, 'a'), 'a');
  const entries = treeInventory(root); fs.renameSync(path.join(root, 'a'), path.join(temp, 'old')); fs.writeFileSync(path.join(root, 'a'), 'b');
  assert.throws(() => removeInventory(entries)); assert.ok(fs.existsSync(root));
});
test('migration copies only managed files, preserves disks/profile, and is idempotent after removal', t => {
  const temp = setup(t), legacy = path.join(temp, 'legacy'), id = randomUUID(), guest = randomUUID();
  const old = path.join(legacy, 'workspaces', id); fs.mkdirSync(path.join(old, 'files'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'guest-profile.json'), JSON.stringify({ id: guest }));
  fs.writeFileSync(path.join(old, 'workspace.json'), JSON.stringify({ id, name: 'Migrated', editorPassword: 'not-copied' }));
  fs.writeFileSync(path.join(old, 'files/file.txt'), 'persist'); fs.writeFileSync(path.join(old, 'runtime.img'), 'legacy-disk');
  const store = new Workspaces(path.join(temp, 'native')); store.migrate(legacy); store.migrate(legacy);
  assert.equal(store.list().length, 1); assert.equal(store.guest().id, guest);
  const w = store.get(store.list()[0].id); assert.equal(fs.existsSync(path.join(w.dir, 'runtime.img')), false);
  assert.equal(fs.readFileSync(path.join(w.files, 'file.txt'), 'utf8'), 'persist');
  store.remove(w.id, 'stopped', true); store.migrate(legacy); assert.equal(store.list().length, 0); assert.equal(fs.readFileSync(path.join(old, 'runtime.img'), 'utf8'), 'legacy-disk');
});
