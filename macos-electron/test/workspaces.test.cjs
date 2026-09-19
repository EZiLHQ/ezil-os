'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Workspaces } = require('../src/workspaces.cjs');
const { treeInventory, removeInventory, identity } = require('../src/files.cjs');
function setup(t) { const temp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-test-'))); t.after(() => fs.rmSync(temp, { recursive: true, force: true })); return temp; }
function snapshot(root) {
  const result = {};
  function visit(file) {
    const stat = fs.lstatSync(file), key = path.relative(root, file);
    result[key] = { identity: `${stat.dev}:${stat.ino}`, mode: stat.mode, link: stat.isSymbolicLink() ? fs.readlinkSync(file) : null,
      contents: stat.isFile() ? fs.readFileSync(file).toString('base64') : null };
    if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
  }
  visit(root); return result;
}
test('installed 0.0.14 v1 store upgrades without replacing managed files, profiles, guest or migration markers', t => {
  // Load application source only, never the installed user's data directory.
  const source = '/Applications/EZiL OS.app/Contents/Resources/app/src/workspaces.cjs';
  if (!fs.existsSync(source)) return t.skip('Installed 0.0.14 source unavailable');
  const version = require('node:child_process').execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', '/Applications/EZiL OS.app/Contents/Info.plist'], { encoding: 'utf8' }).trim();
  if (version !== '0.0.14') return t.skip('Installed application is no longer 0.0.14');
  const Legacy = require(source).Workspaces;
  const temp = setup(t), root = path.join(temp, 'native'), original = path.join(temp, 'original');
  fs.mkdirSync(original); fs.writeFileSync(path.join(original, 'source.ts'), 'original import source');
  const legacy = new Legacy(root), guest = legacy.guest(), legacyID = randomUUID();
  const w = legacy.create('Existing workspace', original, legacyID), second = legacy.create('Second workspace');
  fs.writeFileSync(path.join(w.files, 'source.ts'), 'managed edits after import');
  for (const relative of ['editor-data/User/settings.json', 'extensions/custom/extension.js', 'browser/profile/preferences', 'shell-profile/preferences']) {
    const file = path.join(w.dir, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `synthetic ${relative}`);
  }
  fs.symlinkSync('../source.ts', path.join(w.files, 'project-link'));
  legacy.index.activeID = second.id; legacy.save();
  assert.equal(legacy.index.version, 1); assert.equal(legacy.index.workspaces[0].kind, undefined);
  const before = snapshot(w.dir), other = snapshot(second.dir), originalBefore = snapshot(original), guestBefore = fs.readFileSync(path.join(root, 'guest.json'));
  const upgraded = new Workspaces(root), loaded = upgraded.get(w.id);
  assert.equal(upgraded.index.version, 2); assert.equal(loaded.kind, 'managed'); assert.equal(loaded.available, true);
  assert.equal(loaded.files, w.files); assert.equal(loaded.editorData, w.editorData); assert.equal(loaded.createdAt, w.createdAt);
  assert.deepEqual(loaded.children, w.children); assert.equal(loaded.identity, w.identity);
  assert.deepEqual(upgraded.guest(), guest); assert.deepEqual(fs.readFileSync(path.join(root, 'guest.json')), guestBefore);
  assert.equal(upgraded.index.activeID, second.id); assert.equal(upgraded.index.migrated[legacyID], w.id);
  assert.deepEqual(snapshot(w.dir), before); assert.deepEqual(snapshot(second.dir), other); assert.deepEqual(snapshot(original), originalBefore);
  const metadata = fs.readFileSync(path.join(root, 'inventory.json'));
  new Workspaces(root); assert.deepEqual(fs.readFileSync(path.join(root, 'inventory.json')), metadata);
  assert.deepEqual(snapshot(w.dir), before);
});
test('portable synthetic v1 inventory preserves deleted migration markers and all existing record identities', t => {
  const temp = setup(t), root = path.join(temp, 'native'), dir = path.join(root, 'workspaces', randomUUID());
  const id = path.basename(dir), legacyID = randomUUID(), children = {};
  for (const child of ['files', 'editor-data', 'extensions', 'browser']) {
    fs.mkdirSync(path.join(dir, child), { recursive: true }); children[child] = identity(path.join(dir, child));
    fs.writeFileSync(path.join(dir, child, 'canary'), child);
  }
  const record = { id, name: 'V1', createdAt: '2026-09-01T00:00:00.000Z', identity: identity(dir), children };
  fs.writeFileSync(path.join(root, 'inventory.json'), JSON.stringify({ version: 1, workspaces: [record], migrated: { [legacyID]: randomUUID() }, activeID: id }));
  const before = snapshot(dir), store = new Workspaces(root);
  assert.deepEqual(store.index.workspaces, [{ ...record, kind: 'managed' }]); assert.deepEqual(snapshot(dir), before);
  assert.equal(store.index.activeID, id); assert.ok(store.index.migrated[legacyID]);
  const old = path.join(temp, 'legacy/workspaces', legacyID); fs.mkdirSync(old, { recursive: true });
  // A tombstone must bypass old records entirely; even malformed old JSON is not reread.
  fs.writeFileSync(path.join(old, 'workspace.json'), 'not JSON'); store.migrate(path.join(temp, 'legacy'));
  assert.equal(store.list().length, 1); assert.deepEqual(snapshot(dir), before);
});
test('detachment removes only owned profiles and preserves original content, identities and symlink targets', t => {
  const temp = setup(t), original = path.join(temp, 'original'); fs.mkdirSync(original);
  const canary = path.join(temp, 'outside'); fs.writeFileSync(canary, 'outside');
  fs.writeFileSync(path.join(original, 'source.ts'), 'source'); fs.mkdirSync(path.join(original, '.git')); fs.writeFileSync(path.join(original, '.git/HEAD'), 'ref: refs/heads/main');
  fs.symlinkSync(canary, path.join(original, 'external')); fs.symlinkSync('missing', path.join(original, 'dangling'));
  fs.linkSync(canary, path.join(original, 'hardlink'));
  const store = new Workspaces(path.join(temp, 'native')), w = store.attach('Original', original);
  fs.symlinkSync(original, path.join(w.browser, 'project-link')); fs.symlinkSync(canary, path.join(w.editorData, 'outside-link'));
  const before = snapshot(original), outsideIdentity = identity(canary);
  store.remove(w.id, 'stopped', true);
  assert.equal(fs.existsSync(w.dir), false); assert.deepEqual(snapshot(original), before); assert.equal(identity(canary), outsideIdentity);
  assert.equal(new Workspaces(store.root).list().length, 0);
});
test('detachment after folder replacement or profile substitution never follows an outside target', t => {
  const temp = setup(t), original = path.join(temp, 'original'), outside = path.join(temp, 'outside'); fs.mkdirSync(original); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'canary'), 'keep');
  const store = new Workspaces(path.join(temp, 'native')), w = store.attach('Original', original);
  fs.renameSync(original, path.join(temp, 'moved')); fs.symlinkSync(outside, original);
  assert.equal(store.get(w.id, { allowMissing: true }).available, false);
  const before = snapshot(outside); store.remove(w.id, 'stopped', true); assert.deepEqual(snapshot(outside), before); assert.ok(fs.lstatSync(original).isSymbolicLink());
  const next = store.attach('Moved', path.join(temp, 'moved'));
  fs.rmdirSync(next.browser); fs.symlinkSync(outside, next.browser);
  assert.throws(() => store.remove(next.id, 'stopped', true)); assert.deepEqual(snapshot(outside), before); assert.ok(fs.existsSync(next.dir));
});
test('persistent random guest/workspace; removal preserves imports and outside canary', t => {
  const temp = setup(t), source = path.join(temp, 'source'); fs.mkdirSync(source); fs.writeFileSync(path.join(source, 'project.txt'), 'original');
  const root = path.join(temp, 'native'), store = new Workspaces(root), guest = store.guest(), w = store.create('Test', source);
  assert.equal(new Workspaces(root).guest().id, guest.id); assert.equal(new Workspaces(root).get(w.id).name, 'Test');
  fs.mkdirSync(path.join(w.dir, 'shell-profile')); fs.writeFileSync(path.join(w.dir, 'shell-profile', 'preferences'), 'persisted');
  for (const state of ['running', 'unknown']) assert.throws(() => store.remove(w.id, state, true));
  assert.throws(() => store.remove(w.id, 'stopped', false));
  store.remove(w.id, 'stopped', true); assert.equal(fs.existsSync(w.dir), false); assert.equal(fs.readFileSync(path.join(source, 'project.txt'), 'utf8'), 'original');
});
test('removal preserves symlink targets and rejects hardlink and replaced directory escapes', t => {
  const temp = setup(t), store = new Workspaces(path.join(temp, 'native')), w = store.create('Test');
  const outside = path.join(temp, 'canary'); fs.writeFileSync(outside, 'keep');
  fs.symlinkSync(outside, path.join(w.files, 'escape')); assert.throws(() => treeInventory(w.files));
  const links = store.create('Links'); fs.symlinkSync(outside, path.join(links.files, 'file')); fs.symlinkSync(temp, path.join(links.files, 'directory')); fs.symlinkSync('/missing-ezil-target', path.join(links.files, 'dangling'));
  store.remove(links.id, 'stopped', true); assert.equal(fs.readFileSync(outside, 'utf8'), 'keep');
  fs.linkSync(outside, path.join(w.files, 'hard')); assert.throws(() => store.remove(w.id, 'stopped', true)); fs.unlinkSync(path.join(w.files, 'hard'));
  fs.renameSync(w.files, path.join(w.dir, 'old-files')); fs.mkdirSync(w.files); assert.throws(() => store.remove(w.id, 'stopped', true));
});
test('attached originals deduplicate, survive removal, and recover after moves or replacement', t => {
  const temp = setup(t), root = path.join(temp, 'native'), source = path.join(temp, 'source'); fs.mkdirSync(source);
  fs.writeFileSync(path.join(source, 'file'), 'original'); fs.symlinkSync('/missing-target', path.join(source, 'link'));
  const store = new Workspaces(root), w = store.attach('Original', source);
  const alias = path.join(temp, 'alias'); fs.symlinkSync(source, alias);
  assert.equal(store.attach('Duplicate', alias).id, w.id);
  assert.deepEqual(Object.keys(store.list()[0]).sort(), ['available', 'createdAt', 'id', 'kind', 'name']);
  assert.equal(w.files, fs.realpathSync(source)); assert.equal(w.kind, 'attached');
  const moved = path.join(temp, 'moved'); fs.renameSync(source, moved);
  assert.equal(new Workspaces(root).list()[0].available, false); assert.throws(() => store.get(w.id));
  assert.equal(store.get(w.id, { allowMissing: true }).available, false);
  assert.equal(store.attach('Moved', moved).id, w.id);
  fs.renameSync(moved, source); fs.mkdirSync(moved);
  assert.equal(store.list()[0].available, false);
  assert.equal(store.relink(w.id, source).available, true);
  const other = store.attach('Other', moved); assert.throws(() => store.relink(other.id, source));
  store.remove(w.id, 'stopped', true); assert.equal(fs.readFileSync(path.join(source, 'file'), 'utf8'), 'original');
  fs.rmdirSync(moved); store.remove(other.id, 'stopped', true); assert.equal(store.list().length, 0);
  assert.throws(() => store.attach('Storage', root)); assert.throws(() => store.attach('Parent', temp));
});
test('v1 inventory migrates in place to managed v2 and retains data', t => {
  const temp = setup(t), root = path.join(temp, 'native'), store = new Workspaces(root), w = store.create('Old');
  fs.writeFileSync(path.join(w.files, 'kept'), 'yes');
  const file = path.join(root, 'inventory.json'), old = JSON.parse(fs.readFileSync(file)); old.version = 1; delete old.workspaces[0].kind;
  fs.writeFileSync(file, JSON.stringify(old));
  const migrated = new Workspaces(root); assert.equal(migrated.get(w.id).kind, 'managed');
  assert.equal(JSON.parse(fs.readFileSync(file)).version, 2); assert.equal(fs.readFileSync(path.join(w.files, 'kept'), 'utf8'), 'yes');
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
