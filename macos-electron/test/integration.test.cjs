'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Workspaces } = require('../src/workspaces.cjs');
const { identity, readJSON } = require('../src/files.cjs');
const { config, helperEnvironment, authenticatedHeaders, registeredPreview } = require('../src/helper.cjs');
const { connectorStatus, installConnector, hashes, ConnectorSession } = require('../src/connector.cjs');
const { Editors } = require('../src/vscode.cjs');
const { stageInputs, validateInputs } = require('../scripts/inputs.cjs');
const { providerFixtures, proveProvider } = require('../src/smoke.cjs');
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-integration-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const extension = path.join(root, 'extension'); fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'ezil-vscode', version: '1.0.0', engines: { vscode: '^1.90.0' }, main: './extension.js' }));
  fs.writeFileSync(path.join(extension, 'extension.js'), 'exports.activate = () => {};');
  return { root, extension, store: new Workspaces(path.join(root, 'data')) };
}
test('helper uses /os and the native env contract without broker or provider env', t => {
  const { root, store } = fixture(t), w = store.create('A'), settings = config(root, {});
  assert.equal(settings.shellPath, '/os');
  const env = helperEnvironment(settings, root, w, 'test-admin');
  assert.equal(env.EZIL_NATIVE_ADMIN_CAPABILITY, 'test-admin');
  assert.equal(env.EZIL_NATIVE_WORKSPACE_ID, w.id); assert.equal(env.EZIL_NATIVE_WORKSPACE_ROOT, w.files);
  for (const key of ['EZIL_BROKER_FILE', 'EZIL_AI_BROKER_FILE', 'EZIL_NATIVE_BROKER_DESCRIPTOR', 'AZURE_API_KEY']) assert.equal(env[key], undefined);
});
test('helper auth overwrites headers case-insensitively only on exact origin', () => {
  const helper = { origin: 'http://127.0.0.1:1234', capability: 'test-admin', shellCapability: 'test-shell', webContentsId: 7 };
  for (const suffix of ['/os', '/api/workspaces']) {
    assert.deepEqual(authenticatedHeaders({ url: helper.origin + suffix, webContentsId: 7, initiator: helper.origin, requestHeaders: { authorization: 'bad', ORIGIN: 'https://evil.test', Accept: '*/*' } }, helper), { Accept: '*/*', Authorization: 'Bearer test-shell', Origin: helper.origin });
  }
  assert.deepEqual(authenticatedHeaders({ url: 'http://127.0.0.1:12345/api', requestHeaders: {} }, helper), {});
});
test('registered preview derives only a validated loopback URL', async () => {
  const id = require('node:crypto').randomUUID();
  const helper = { origin: 'http://127.0.0.1:49152', capability: 'admin-capability' };
  let request;
  const url = await registeredPreview(helper, id, async (target, init) => {
    request = { target, init };
    return Response.json({ ok: true, workspaceId: id, editorState: 'active', ports: [5173, 3000] });
  });
  assert.equal(url, 'http://127.0.0.1:3000/');
  assert.equal(request.target, helper.origin + '/api/native/previews');
  assert.equal(new Headers(request.init.headers).get('authorization'), `Bearer ${helper.capability}`);
  for (const value of [{ ok: true, workspaceId: id, editorState: 'active', ports: [80] },
    { ok: true, workspaceId: 'wrong', editorState: 'active', ports: [3000] },
    { ok: true, workspaceId: id, editorState: 'active', ports: ['3000'] }]) {
    assert.equal(await registeredPreview(helper, id, async () => Response.json(value)), undefined);
  }
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
test('verified editor launch installs extension and passes only private descriptor paths', async t => {
  const { store, extension, root } = fixture(t), w = store.create('A');
  const executable = path.join(root, 'verified-code'); fs.writeFileSync(executable, 'fixture');
  const launches = [], children = [];
  const editors = new Editors({ extensionSource: extension, findCode: () => ({ executable, identity: identity(executable) }), launch: (file, args, options) => {
    launches.push({ file, args, options }); const child = new EventEmitter(); children.push(child);
    queueMicrotask(() => { child.emit('spawn'); if (args[0] === '--reuse-window') child.emit('exit', 0); }); return child;
  } });
  const connector = path.join(root, 'connector.json'), model = path.join(root, 'model.json');
  fs.writeFileSync(connector, '{}', { mode: 0o600 }); fs.writeFileSync(model, '{}', { mode: 0o600 });
  const descriptors = { connector, model };
  assert.equal((await editors.start(w, descriptors)).status, 'running');
  assert.equal((await editors.open(w, descriptors)).status, 'running');
  assert.deepEqual(hashes(path.join(w.extensions, 'ezil-vscode')), hashes(extension));
  for (const launch of launches) {
    assert.equal(launch.file, executable); assert.equal(launch.options.shell, false);
    assert.ok(launch.args.includes(w.extensions)); assert.ok(launch.args.includes(w.files));
    assert.equal(launch.options.env.EZIL_BROKER_FILE, connector); assert.equal(launch.options.env.EZIL_AI_BROKER_FILE, model);
    assert.equal(launch.options.env.EZIL_NATIVE_ADMIN_CAPABILITY, undefined);
  }
  assert.deepEqual(connectorStatus, { readiness: 'available', preview: 'available', modelProvider: 'available' });
  assert.equal(fs.existsSync(path.join(w.dir, 'broker.json')), false);
  children[0].emit('exit');
});
test('connector mints, persists, renews and removes a workspace-scoped capability', async t => {
  const { root, store } = fixture(t), w = store.create('A');
  const now = Date.now(), helper = { origin: 'http://127.0.0.1:49152', capability: 'admin-capability' };
  const calls = [];
  const connector = new ConnectorSession(path.join(root, 'data'), w, helper, { now: () => now, fetchImpl: async (url, init) => {
    calls.push({ url, init });
    return Response.json({ ok: true, token: 'a'.repeat(43), expiresAt: now + 15 * 60_000 });
  } });
  await connector.start();
  assert.equal(calls[0].url, helper.origin + '/api/native/capabilities');
  assert.equal(new Headers(calls[0].init.headers).get('origin'), helper.origin);
  assert.deepEqual(JSON.parse(calls[0].init.body), { workspaceId: w.id, role: 'connector' });
  assert.deepEqual(readJSON(connector.descriptor), { contractVersion: 1, origin: helper.origin, workspaceId: w.id,
    token: 'a'.repeat(43), expiresAt: now + 15 * 60_000, dataRoot: path.join(root, 'data'), workspacePath: w.files });
  assert.deepEqual(connector.status(), connectorStatus);
  connector.close(); assert.equal(fs.existsSync(connector.descriptor), false);
});
test('packaging stages exact shell/helper/extension paths and inventories their bytes', t => {
  const { extension, root } = fixture(t);
  const helper = path.join(root, 'native'), shell = path.join(root, 'shell'), resources = path.join(root, 'Resources');
  fs.mkdirSync(path.join(helper, 'src'), { recursive: true }); fs.mkdirSync(shell);
  fs.writeFileSync(path.join(helper, 'src/main.ts'), 'helper');
  for (const file of ['bundle.min.js', 'bundle.min.css', 'icons.js']) fs.writeFileSync(path.join(shell, file), file);
  fs.mkdirSync(path.join(extension, 'node_modules', 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(extension, 'node_modules', 'ignored', 'dependency.js'), 'do not package');
  const inputs = { helper, shell, extension }, inventory = stageInputs(inputs, resources);
  for (const [key, target] of Object.entries({ helper: 'native', shell: 'app/public/os', extension: 'extensions/ezil-vscode' })) {
    assert.equal(inventory[key].path, target); assert.deepEqual(inventory[key].files, hashes(inputs[key]));
    assert.deepEqual(hashes(path.join(resources, target)), hashes(inputs[key]));
  }
  assert.equal(fs.existsSync(path.join(resources, 'extensions/ezil-vscode/node_modules')), false);
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
test('physical provider fixtures are private and the smoke sends only broker chat schema', async t => {
  const { root } = fixture(t), file = path.join(root, 'providers.json');
  const azure = { provider: 'azure', endpoint: 'https://example.openai.azure.com/', deployment: 'test', key: 'secret-key' };
  const bedrock = { provider: 'bedrock', region: 'us-east-1', model: 'test.model', token: 'secret-token' };
  fs.writeFileSync(file, JSON.stringify({ azure, bedrock }), { mode: 0o600 });
  assert.deepEqual(providerFixtures(file), [azure, bedrock]);
  fs.chmodSync(file, 0o644); assert.throws(() => providerFixtures(file)); fs.chmodSync(file, 0o600);
  const descriptor = path.join(root, 'ai.json');
  fs.writeFileSync(descriptor, JSON.stringify({ url: 'http://127.0.0.1:49153', capability: 'c'.repeat(64) }), { mode: 0o600 });
  const configured = [], calls = [];
  await proveProvider({ set: value => configured.push(value) }, { descriptor }, azure, async (url, init) => {
    calls.push({ url, init });
    return url.endsWith('/v1/models') ? Response.json({ models: ['test'] })
      : new Response('data: ok\n\n', { headers: { 'content-type': 'text/event-stream' } });
  });
  assert.deepEqual(configured, [azure]); assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[1].init.body), { model: 'test', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 8 });
  assert.equal(new Headers(calls[1].init.headers).get('authorization'), `Bearer ${'c'.repeat(64)}`);
  assert.equal(JSON.stringify(calls).includes('secret-key'), false);
});
