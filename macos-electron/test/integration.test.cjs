'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Workspaces } = require('../src/workspaces.cjs');
const { identity } = require('../src/files.cjs');
const { config, helperEnvironment, authenticatedHeaders } = require('../src/helper.cjs');
const { connectorStatus, installConnector, hashes } = require('../src/connector.cjs');
const { Editors } = require('../src/vscode.cjs');
const { stageInputs, validateInputs } = require('../scripts/inputs.cjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-integration-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extension = path.join(root, 'extension'); fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'ezil-vscode', version: '1.0.0', engines: { vscode: '^1.90.0' }, main: './extension.js' }));
  fs.writeFileSync(path.join(extension, 'extension.js'), 'exports.activate = () => {};');
  return { root, extension, store: new Workspaces(path.join(root, 'data')) };
}
test('helper uses /os and Worker A env names without broker or provider env', t => {
  const { root, store } = fixture(t), w = store.create('A'), settings = config(root, {});
  assert.equal(settings.shellPath, '/os');
  const env = helperEnvironment(settings, root, w, 'test-admin');
  assert.equal(env.EZIL_NATIVE_ADMIN_CAPABILITY, 'test-admin');
  assert.equal(env.EZIL_NATIVE_WORKSPACE_ID, w.id); assert.equal(env.EZIL_NATIVE_WORKSPACE_ROOT, w.files);
  for (const key of ['EZIL_BROKER_FILE', 'EZIL_AI_BROKER_FILE', 'EZIL_NATIVE_BROKER_DESCRIPTOR', 'AZURE_API_KEY']) assert.equal(env[key], undefined);
});
test('helper auth overwrites headers case-insensitively only on exact origin', () => {
  const helper = { origin: 'http://127.0.0.1:1234', capability: 'test-admin' };
  for (const suffix of ['/os', '/api/workspaces']) {
    assert.deepEqual(authenticatedHeaders({ url: helper.origin + suffix, requestHeaders: { authorization: 'bad', ORIGIN: 'https://evil.test', Accept: '*/*' } }, helper), { Accept: '*/*', Authorization: 'Bearer test-admin', Origin: helper.origin });
  }
  assert.deepEqual(authenticatedHeaders({ url: 'http://127.0.0.1:12345/api', requestHeaders: {} }, helper), {});
});
test('connector install verifies bundled bytes and changes only the workspace connector', t => {
  const { store, extension } = fixture(t), a = store.create('A'), b = store.create('B');
  const other = path.join(a.extensions, 'other.txt'); fs.writeFileSync(other, 'preserve');
  const installed = installConnector(extension, a);
  assert.deepEqual(hashes(installed), hashes(extension));
  assert.equal(installConnector(extension, a), installed);
  fs.writeFileSync(path.join(installed, 'extension.js'), 'old version');
  installConnector(extension, a); assert.deepEqual(hashes(installed), hashes(extension));
  assert.equal(fs.readFileSync(other, 'utf8'), 'preserve'); assert.deepEqual(fs.readdirSync(b.extensions), []);
});
test('connector rejects symlinks and missing extension entrypoints', t => {
  const { store, extension, root } = fixture(t), w = store.create('A');
  fs.symlinkSync(root, path.join(w.extensions, 'ezil-vscode'));
  assert.throws(() => installConnector(extension, w), /link/i);
  fs.unlinkSync(path.join(w.extensions, 'ezil-vscode')); fs.unlinkSync(path.join(extension, 'extension.js'));
  assert.throws(() => installConnector(extension, w), /runnable/);
});
test('verified editor launch installs extension and passes no incompatible descriptor', async t => {
  const { store, extension, root } = fixture(t), w = store.create('A');
  const executable = path.join(root, 'verified-code'); fs.writeFileSync(executable, 'fixture');
  const launches = [], children = [];
  const editors = new Editors({ extensionSource: extension, findCode: () => ({ executable, identity: identity(executable) }), launch: (file, args, options) => {
    launches.push({ file, args, options }); const child = new EventEmitter(); children.push(child);
    queueMicrotask(() => { child.emit('spawn'); if (args[0] === '--reuse-window') child.emit('exit', 0); }); return child;
  } });
  assert.equal((await editors.start(w)).status, 'running');
  assert.equal((await editors.open(w)).status, 'running');
  assert.deepEqual(hashes(path.join(w.extensions, 'ezil-vscode')), hashes(extension));
  for (const launch of launches) {
    assert.equal(launch.file, executable); assert.equal(launch.options.shell, false);
    assert.ok(launch.args.includes(w.extensions)); assert.ok(launch.args.includes(w.files));
    assert.equal(launch.options.env.EZIL_BROKER_FILE, undefined); assert.equal(launch.options.env.EZIL_AI_BROKER_FILE, undefined);
    assert.equal(launch.options.env.EZIL_NATIVE_ADMIN_CAPABILITY, undefined);
  }
  assert.deepEqual(connectorStatus, { readiness: 'unavailable', preview: 'unavailable', modelProvider: 'unavailable' });
  assert.equal(fs.existsSync(path.join(w.dir, 'broker.json')), false);
  children[0].emit('exit');
});
test('packaging stages exact shell/helper/extension paths and inventories their bytes', t => {
  const { extension, root } = fixture(t);
  const helper = path.join(root, 'native'), shell = path.join(root, 'shell'), resources = path.join(root, 'Resources');
  fs.mkdirSync(path.join(helper, 'src'), { recursive: true }); fs.mkdirSync(shell);
  fs.writeFileSync(path.join(helper, 'src/main.ts'), 'helper');
  for (const file of ['bundle.min.js', 'bundle.min.css', 'icons.js']) fs.writeFileSync(path.join(shell, file), file);
  const inputs = { helper, shell, extension }, inventory = stageInputs(inputs, resources);
  for (const [key, target] of Object.entries({ helper: 'native', shell: 'app/public/os', extension: 'extensions/ezil-vscode' })) {
    assert.equal(inventory[key].path, target); assert.deepEqual(inventory[key].files, hashes(inputs[key]));
    assert.deepEqual(hashes(path.join(resources, target)), hashes(inputs[key]));
  }
  fs.unlinkSync(path.join(shell, 'icons.js')); assert.throws(() => validateInputs(inputs), /Missing exact/);
});
test('editor launch failure cannot claim opened and never falls back to another executable', async t => {
  const { store, extension, root } = fixture(t), w = store.create('A');
  const executable = path.join(root, 'verified-code'); fs.writeFileSync(executable, 'fixture');
  let attempts = 0;
  const editors = new Editors({ extensionSource: extension, findCode: () => ({ executable, identity: identity(executable) }), launch: () => {
    attempts++; const child = new EventEmitter(); queueMicrotask(() => child.emit('error', Error('spawn failed'))); return child;
  } });
  await assert.rejects(editors.start(w), /spawn failed/);
  assert.equal(attempts, 1); assert.equal(editors.state(w), 'unknown');
  const missing = new Editors({ extensionSource: extension, findCode: () => null, launch: () => assert.fail('must not launch') });
  assert.equal((await missing.start(store.create('B'))).status, 'missing');
});
test('packaging refuses a helper symlink and missing committed connector', t => {
  const { extension, root } = fixture(t), helper = path.join(root, 'native'), shell = path.join(root, 'shell');
  fs.mkdirSync(path.join(helper, 'src'), { recursive: true }); fs.mkdirSync(shell);
  fs.writeFileSync(path.join(helper, 'src/main.ts'), 'helper');
  for (const file of ['bundle.min.js', 'bundle.min.css', 'icons.js']) fs.writeFileSync(path.join(shell, file), file);
  assert.throws(() => validateInputs({ helper, shell, extension: path.join(root, 'absent') }));
  fs.symlinkSync(path.join(helper, 'src/main.ts'), path.join(helper, 'linked.ts'));
  assert.throws(() => stageInputs({ helper, shell, extension }, path.join(root, 'Resources')), /symlink/);
});
