'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { attachRepositoryProjection, patchBundle, patches } = require('./project-explorer.cjs');

const folder = '/workspace/projects/44444444-4444-8444-8444-444444444444';
const checkout = folder + '/private-repo';
const marker = 'data-ezil-repo-explorer-ready';
const hint = 'data-ezil-repo-checkout';
const flush = () => new Promise(setImmediate);

function uri(path, authority = 'test-remote') {
  return { path, authority, scheme: 'vscode-remote', with(change) { return uri(change.path, authority); } };
}

function fixture({
  path = checkout,
  folders = [{ uri: uri(folder) }],
  search = '?folder=' + folder + '&ezil_mint=AAAAAAAAAAAAAAAAAAAAAA',
  state = 2,
} = {}) {
  const attrs = new Map([[hint, path]]);
  let mutation;
  let fileChanges;
  let stat = { isDirectory: true, resource: uri(checkout) };
  const checked = [];
  const workspace = { folders };
  let updates = 0;

  const context = {
    globalThis: undefined,
    URLSearchParams,
    location: { search },
    document: { documentElement: {
      getAttribute: key => attrs.get(key) ?? null,
      setAttribute: (key, value) => attrs.set(key, value),
      removeAttribute: key => attrs.delete(key),
    } },
    MutationObserver: class {
      constructor(listener) { mutation = listener; }
      observe() {}
      disconnect() { mutation = undefined; }
    },
  };
  context.globalThis = context;
  const run = vm.runInNewContext('(' + attachRepositoryProjection.toString() + ')', context);
  const model = {
    contextService: { getWorkspace: () => workspace, getWorkbenchState: () => state },
    uriIdentityService: { extUri: { isEqual: (a, b) => a.path === b.path && a.authority === b.authority } },
    get roots() { return this._roots; },
    _onDidChangeRoots: { fire: () => { updates++; } },
  };
  const makeRoot = (resource, name) => ({ resource, name });
  const restoreRoots = () => { model._roots = workspace.folders.map(entry => makeRoot(entry.uri, 'wrapper')); };
  restoreRoots();
  const lifecycle = run(model, {
    resolve: resource => { checked.push(resource); return Promise.resolve(stat); },
    onDidChangeFileSystemProviderRegistrations: () => ({ dispose() {} }),
    onDidFilesChange(listener) { fileChanges = listener; return { dispose: () => { fileChanges = undefined; } }; },
  }, makeRoot, restoreRoots);
  return {
    attrs, model, workspace, checked, lifecycle,
    project(path) { attrs.set(hint, path); mutation?.(); },
    setStat(value) { stat = value; },
    fileChange(path, type) { fileChanges?.({ contains: (resource, kind) => resource.path === path && kind === type }); },
    updates: () => updates,
  };
}

test('projects only Explorer after the direct checkout is confirmed', async () => {
  const f = fixture();
  assert.equal(f.model.roots[0].resource.path, folder);
  assert.equal(f.attrs.has(marker), false);
  await flush();
  assert.equal(f.model.roots[0].resource.path, checkout);
  assert.equal(f.model.roots[0].resource.authority, 'test-remote');
  assert.equal(f.model.roots[0].name, 'private-repo');
  assert.equal(f.workspace.folders[0].uri.path, folder);
  assert.equal(f.attrs.get(marker), checkout);
  assert.equal(f.updates(), 1);
  f.project(checkout);
  await flush();
  assert.equal(f.checked.length, 1);
});

test('ignores foreign roots, outside or nested paths, malformed mints, and ambiguous workspaces', async () => {
  for (const input of [
    { path: folder + '/nested/private-repo' }, { path: folder + '/../private-repo' },
    { path: '/workspace/private-repo' }, { folders: [{ uri: uri('/workspace') }] },
    { folders: [{ uri: uri(folder) }, { uri: uri('/an-extra-folder') }] },
    { search: '?folder=' + folder }, { search: '?folder=' + folder + '&folder=/other&ezil_mint=AAAAAAAAAAAAAAAAAAAAAA' },
    { state: 3 },
  ]) {
    const f = fixture(input);
    await flush();
    assert.equal(f.checked.length, 0);
    assert.equal(f.attrs.has(marker), false);
  }
});

test('drops a removed root, rejects a symbolic link, and verifies a recreated directory', async () => {
  const f = fixture();
  await flush();
  f.setStat({ resource: uri(checkout), isDirectory: true, isSymbolicLink: true });
  f.fileChange(checkout, 2);
  assert.equal(f.model.roots[0].resource.path, folder);
  await flush();
  assert.equal(f.attrs.has(marker), false);
  f.setStat({ resource: uri(checkout), isDirectory: true });
  f.fileChange(checkout, 1);
  await flush();
  assert.equal(f.attrs.get(marker), checkout);
});

test('ignores asynchronous resolutions after hint invalidation or disposal', async () => {
  for (const invalidate of [f => f.project(null), f => f.lifecycle.dispose()]) {
    const f = fixture();
    invalidate(f);
    await flush();
    assert.equal(f.attrs.has(marker), false);
    assert.equal(f.model.roots[0].resource.path, folder);
  }
});

test('matches each pinned asset anchor exactly once and rejects old or partial output', () => {
  const original = patches.map(patch => patch.before).join('\n');
  const changed = patchBundle(original);
  assert.equal(patchBundle(changed, true), changed);
  assert.throws(() => patchBundle(original, true), /verification failed/);
  assert.throws(() => patchBundle(original + patches[0].before), /anchor must occur once/);
  assert.throws(() => patchBundle(changed.replace(patches[0].after, 'partial'), true), /verification failed/);
});
