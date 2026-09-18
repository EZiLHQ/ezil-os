'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { bundleHelper } = require('../scripts/bundle-helper.cjs');
const { cleanEnvironment } = require('../src/vscode.cjs');
const { Workspaces } = require('../src/workspaces.cjs');
const { config, helperEnvironment } = require('../src/helper.cjs');
const { verifyArchive } = require('../scripts/code-server.cjs');
const repo = path.resolve(__dirname, '../..');
function bunPath() {
  return (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'bun')).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch { return false; } });
}
test('helper bundle contains its cross-package closure and boots with original source removed', async t => {
  const bun = bunPath(); if (!bun) { t.skip('Bun unavailable; hosted build requires pinned Bun'); return; }
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-closure-'))); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'Resources'); fs.mkdirSync(resources);
  const inventory = bundleHelper(bun, path.join(repo, 'native'), resources);
  assert.ok(inventory.files['src/helper.js']);
  const closure = JSON.parse(fs.readFileSync(path.join(resources, 'native/closure.json')));
  assert.equal(closure.dependencyComplete, true); assert.ok(closure.inputs.some(i => i.name.includes('local/src/boot/os-document')));
  assert.equal(fs.existsSync(path.join(resources, 'native/src/server.ts')), false);
  // A separate throwaway input proves the executable has no runtime dependency
  // on original imports. Removing this source never touches the checkout.
  const source = path.join(root, 'isolated-source'); fs.mkdirSync(path.join(source, 'src'), { recursive: true });
  fs.writeFileSync(path.join(source, 'shared.ts'), 'export const greeting = "dependency-closed";');
  fs.writeFileSync(path.join(source, 'src/main.ts'), 'import { greeting } from "../shared.ts"; console.log(greeting);');
  const fixtureResources = path.join(root, 'fixture'); fs.mkdirSync(fixtureResources);
  bundleHelper(bun, source, fixtureResources); fs.rmSync(source, { recursive: true });
  function execute(args, options) {
    const outputFile = path.join(root, 'probe-output'), fd = fs.openSync(outputFile, 'w');
    try { execFileSync(bun, args, { ...options, stdio: ['ignore', fd, 'inherit'] }); }
    finally { fs.closeSync(fd); }
    return fs.readFileSync(outputFile, 'utf8');
  }
  assert.equal(execute(['--no-env-file', path.join(fixtureResources, 'native/src/helper.js')], { cwd: root, env: cleanEnvironment() }).trim(), 'dependency-closed');
  // Import the real bundled handler in a network-free process. Bun's entrypoint
  // calls Bun.serve, which is replaced with a capture of its exact fetch handler.
  const settings = config(resources, {}), assets = settings.assets; fs.mkdirSync(assets, { recursive: true });
  for (const file of ['bundle.min.js', 'bundle.min.css', 'icons.js']) fs.writeFileSync(path.join(assets, file), 'fixture-asset');
  const dataRoot = path.join(root, 'data'), store = new Workspaces(dataRoot), workspace = store.create('Closure');
  const runner = path.join(resources, 'probe.mjs');
  fs.writeFileSync(runner, `import assert from 'node:assert/strict';
let serve;
Bun.serve = options => { serve = options; return { port: 12345, stop: async () => {} }; };
await import('./native/src/helper.js');
assert.ok(serve);
const origin = 'http://127.0.0.1:12345';
const response = await serve.fetch(new Request(origin + '/os', { headers: { host: '127.0.0.1:12345', origin, authorization: 'Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }));
assert.equal(response.status, 200);
assert.ok((await response.text()).includes('/os/bundle.min.js'));
const asset = await serve.fetch(new Request(origin + '/os/bundle.min.js', { headers: { host: '127.0.0.1:12345' } }));
assert.equal(asset.status, 200); assert.equal(await asset.text(), 'fixture-asset');
console.log('PACKAGED_HELPER_OK');
process.emit('SIGTERM');
`);
  const output = execute(['--no-env-file', runner], { cwd: resources, env: helperEnvironment(settings, dataRoot, workspace, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'), encoding: 'utf8', timeout: 10000 });
  assert.match(output, /PACKAGED_HELPER_OK/);
});
test('runtime archive digest rejects changed or unpinned bytes', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-archive-')); t.after(() => fs.rmSync(root, { recursive: true }));
  const file = path.join(root, 'archive'); fs.writeFileSync(file, 'tampered'); assert.throws(() => verifyArchive(file), /SHA256 mismatch/);
});
