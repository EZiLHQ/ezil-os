'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
test.before(() => test.mock.method(require('node:child_process'), 'spawnSync', () => ({ status: 1 })));
const { EventEmitter } = require('node:events');
const { Editors } = require('../src/vscode.cjs');
const { Workspaces } = require('../src/workspaces.cjs');
const { identity } = require('../src/files.cjs');
const path = require('node:path');
const { validSignature, supportedVersion, argv, cleanEnvironment, editorEnvironment, discover } = require('../src/vscode.cjs');
const details = 'Identifier=com.microsoft.VSCode\nAuthority=Developer ID Application: Microsoft Corporation (UBF8T346G9)\nTeamIdentifier=UBF8T346G9\n';
test('verifier requires Microsoft bundle, team and Developer ID identity together', () => {
  assert.ok(validSignature('com.microsoft.VSCode', details));
  assert.equal(validSignature('com.evil.editor', details), false);
  for (const needle of ['UBF8T346G9', 'com.microsoft.VSCode', 'Microsoft Corporation']) assert.equal(validSignature('com.microsoft.VSCode', details.replaceAll(needle, 'bad')), false);
  assert.equal(supportedVersion('1.108.2'), false); assert.equal(supportedVersion('1.109.0'), true); assert.equal(supportedVersion('2.0.0'), true); assert.equal(supportedVersion('bad'), false);
  assert.equal(discover({ platform: 'linux' }), null);
});
test('discovery verifies an inline signature requirement and resolves current or older signed executable names', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-code-discovery-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const app = path.join(home, 'Applications/Visual Studio Code.app');
  fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
  for (const name of ['Code', 'Electron']) fs.writeFileSync(path.join(app, 'Contents/MacOS', name), 'fixture');
  let binary = 'Code', verified = false;
  const run = (command, args) => {
    if (!args.at(-1).startsWith(app)) throw Error('not the disposable fixture');
    if (command === '/usr/bin/codesign') {
      assert.equal(args[args.indexOf('-R') + 1], '=anchor apple generic and identifier "com.microsoft.VSCode" and certificate leaf[subject.OU] = "UBF8T346G9"');
      verified = true; return '';
    }
    if (args[1] === 'Print :CFBundleIdentifier') return 'com.microsoft.VSCode';
    if (args[1] === 'Print :CFBundleShortVersionString') return '1.137.0';
    if (args[1] === 'Print :CFBundleExecutable') { assert.ok(verified); return binary; }
    throw Error('unexpected invocation');
  };
  const options = { platform: 'darwin', home, run, display: () => ({ status: 0, stderr: details }) };
  for (binary of ['Code', 'Electron']) assert.equal(discover(options).executable, path.join(app, 'Contents/MacOS', binary));
  for (binary of ['../Code', '/bin/sh', 'unverified']) assert.equal(discover(options), null);
  binary = 'Code'; assert.equal(discover({ ...options, display: () => ({ status: 1, stderr: details }) }), null);
});
test('launch argv keeps workspace as literal argument and app-owned editor dirs', () => {
  const w = { files: '/tmp/a $(touch nope); space', editorData: '/tmp/owner/data', extensions: '/tmp/owner/extensions' };
  assert.deepEqual(argv(w), ['--new-window', '--user-data-dir', path.join(w.editorData, 'external-vscode'), '--extensions-dir', path.join(w.extensions, 'external-vscode'), w.files]);
  assert.throws(() => argv({ ...w, files: '--extensions-dir' }));
  process.env.EZIL_NATIVE_ADMIN_CAPABILITY = 'private'; process.env.AZURE_API_KEY = 'private';
  const env = cleanEnvironment(); assert.equal(env.EZIL_NATIVE_ADMIN_CAPABILITY, undefined); assert.equal(env.AZURE_API_KEY, undefined);
  delete process.env.EZIL_NATIVE_ADMIN_CAPABILITY; delete process.env.AZURE_API_KEY;
});
test('editor environment accepts only private absolute descriptor files', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-editor-env-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const connector = path.join(root, 'connector.json'), model = path.join(root, 'model.json');
  fs.writeFileSync(connector, '{}', { mode: 0o600 }); fs.writeFileSync(model, '{}', { mode: 0o600 });
  const env = editorEnvironment({ connector, model });
  assert.equal(env.EZIL_BROKER_FILE, connector); assert.equal(env.EZIL_AI_BROKER_FILE, model);
  fs.chmodSync(connector, 0o644); assert.throws(() => editorEnvironment({ connector }));
  assert.throws(() => editorEnvironment({ connector: 'relative.json' }));
});
test('external Code installs its connector in an isolated profile and reuses that profile', async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-external-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const w = new Workspaces(path.join(root, 'store')).create('Code');
  const extension = path.join(root, 'extension'); fs.mkdirSync(extension);
  fs.writeFileSync(path.join(extension, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', engines: { vscode: '^1.109.0' }, main: 'extension.js' }));
  fs.writeFileSync(path.join(extension, 'extension.js'), 'module.exports = {};');
  const executable = path.join(root, 'code'); fs.writeFileSync(executable, 'fixture');
  const launches = [], children = [];
  const editors = new Editors({ resources: root, extensionSource: extension, findCode: () => ({ executable, identity: identity(executable) }), launch: (file, args, options) => {
    launches.push({ file, args, options }); const child = new EventEmitter(); children.push(child);
    queueMicrotask(() => { child.emit('spawn'); if (args[0] === '--reuse-window') child.emit('exit', 0); }); return child;
  } });
  assert.equal((await editors.start(w)).status, 'running'); assert.equal((await editors.open(w)).status, 'running');
  assert.ok(fs.existsSync(path.join(w.extensions, 'external-vscode/ezil-vscode/extension.js')));
  assert.equal(fs.existsSync(path.join(w.extensions, 'ezil-vscode')), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(w.editorData, 'external-vscode/User/settings.json')))['terminal.integrated.env.osx'].EZIL_AI_BROKER_FILE, null);
  for (const { args, options } of launches) {
    assert.ok(args.includes(path.join(w.editorData, 'external-vscode'))); assert.ok(args.includes(path.join(w.extensions, 'external-vscode')));
    assert.equal(options.cwd, w.files); assert.equal(options.env.HOME, os.homedir()); assert.ok(options.env.PATH.endsWith(path.join(root, 'code-server/lib')));
  }
  children[0].emit('exit');
});
