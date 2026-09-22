'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { EditorSupervisor } = require('../src/editor.cjs');

test('embedded editor retains host HOME and connector descriptors but removes them from terminal settings before launch', async t => {
  t.mock.method(require('node:child_process'), 'spawnSync', () => ({ status: 1 }));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-embedded-env-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const workspace = { id: 'environment-fixture', dir, files: path.join(dir, 'files'), editorData: path.join(dir, 'editor-data'), extensions: path.join(dir, 'extensions') };
  for (const key of ['files', 'editorData', 'extensions']) fs.mkdirSync(workspace[key]);
  const connector = path.join(dir, 'connector.json'), model = path.join(dir, 'model.json');
  for (const file of [connector, model]) fs.writeFileSync(file, '{}', { mode: 0o600 });
  let cliSocket;
  const supervisor = new EditorSupervisor({ resources: dir, socketStat: () => ({ isSocket: () => true, mode: 0o600 }), authenticate: async () => 'fixture-cookie', launch: (_file, args, options) => {
    cliSocket = args[args.indexOf('--session-socket') + 1]; assert.ok(Buffer.byteLength(cliSocket) < 104); assert.equal(path.basename(cliSocket), 'cli.sock');
    fs.writeFileSync(cliSocket, 'fixture');
    assert.equal(options.env.HOME, os.homedir());
    assert.equal(options.env.EZIL_BROKER_FILE, connector); assert.equal(options.env.EZIL_AI_BROKER_FILE, model);
    assert.equal(options.env.OPENAI_API_KEY, undefined);
    const removals = JSON.parse(fs.readFileSync(path.join(workspace.editorData, 'User/settings.json')))['terminal.integrated.env.osx'];
    assert.equal(removals.EZIL_BROKER_FILE, null); assert.equal(removals.EZIL_AI_BROKER_FILE, null); assert.equal(removals.OPENAI_API_KEY, null);
    const child = new EventEmitter(); child.kill = () => queueMicrotask(() => child.emit('exit', 0)); return child;
  } });
  t.after(() => supervisor.close());
  assert.equal((await supervisor.start(workspace, { connector, model })).state, 'ready');
  await supervisor.stop(workspace.id); assert.equal(supervisor.state(workspace.id), 'stopped');
  assert.equal(fs.existsSync(cliSocket), false);
});
