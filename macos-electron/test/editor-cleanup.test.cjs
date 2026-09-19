'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { EditorSupervisor } = require('../src/editor.cjs');
const row = (pid, ppid, pgid = pid, identity = `${pid}:original`) => ({ pid, ppid, pgid, identity, zombie: false });
function setup(t, mutate) {
  t.mock.method(require('node:child_process'), 'spawnSync', () => ({ status: 1 }));
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ezil-process-test-')));
  const workspaceDir = path.join(dir, 'ssd-like-long-workspace-name-'.repeat(4)); fs.mkdirSync(workspaceDir);
  const workspace = { id: 'tracked', dir: workspaceDir, files: path.join(workspaceDir, 'files'), editorData: path.join(workspaceDir, 'editor-data'), extensions: path.join(workspaceDir, 'extensions') };
  for (const key of ['files', 'editorData', 'extensions']) fs.mkdirSync(workspace[key]);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const child = new EventEmitter(); child.pid = 10001;
  child.kill = () => queueMicrotask(() => child.emit('exit', 0));
  const state = { rows: [row(10001, 1), row(10002, 10001), row(10003, 10002), row(20000, 1)], signals: [], child };
  const supervisor = new EditorSupervisor({ resources: dir, stopGrace: 1,
    snapshot: () => state.rows.map(row => ({ ...row })),
    signalProcess: (pid, signal) => { state.signals.push([pid, signal]); mutate(state, pid, signal); },
    launch: (_file, args) => {
      const socket = args[args.indexOf('--session-socket') + 1];
      assert.ok(Buffer.byteLength(workspace.editorData) > 104); assert.ok(Buffer.byteLength(socket) < 104);
      fs.writeFileSync(socket, 'owned socket placeholder'); return child;
    }, socketStat: () => ({ isSocket: () => true, mode: 0o600 }), authenticate: async () => 'fixture' });
  t.after(() => { for (const instance of supervisor.instances.values()) clearInterval(instance.monitor); });
  return { state, supervisor, workspace };
}
test('parent exit does not cancel escalation for surviving terminal session descendants', async t => {
  const { state, supervisor, workspace } = setup(t, (state, pid, signal) => {
    if (pid === 10001 || signal === 'SIGKILL') state.rows = state.rows.filter(row => row.pid !== pid);
    if (pid === 10001) state.child.emit('exit', 0);
  });
  const instance = await supervisor.start(workspace); await supervisor.stop(workspace.id);
  assert.equal(supervisor.state(workspace.id), 'stopped'); assert.equal(fs.existsSync(instance.runtime), false);
  assert.ok(state.signals.some(([pid, signal]) => pid === 10002 && signal === 'SIGKILL'));
  assert.ok(state.signals.some(([pid, signal]) => pid === 10003 && signal === 'SIGKILL'));
  assert.ok(!state.signals.some(([pid]) => pid === 20000));
});
test('crash cleanup reaps recorded orphan sessions and ignores a reused parent PID', async t => {
  const { state, supervisor, workspace } = setup(t, (state, pid) => { state.rows = state.rows.filter(row => row.pid !== pid); });
  const instance = await supervisor.start(workspace);
  state.rows = [row(10001, 1, 10001, '10001:replacement'), row(10002, 1), row(10003, 10002), row(20000, 1)];
  state.child.emit('exit', 1); await supervisor.stop(workspace.id, true);
  assert.equal(supervisor.state(workspace.id), 'failed'); assert.equal(fs.existsSync(instance.runtime), false);
  assert.deepEqual(new Set(state.signals.map(([pid]) => pid)), new Set([10002, 10003]));
});
test('unverifiable inventory fails cleanup and retains runtime instead of claiming stopped', async t => {
  const { supervisor, workspace } = setup(t, () => {});
  const instance = await supervisor.start(workspace);
  supervisor.snapshot = () => { throw Error('unavailable'); };
  await assert.rejects(supervisor.stop(workspace.id)); assert.equal(supervisor.state(workspace.id), 'failed');
  assert.equal(fs.existsSync(instance.runtime), true);
  fs.rmSync(instance.runtime, { recursive: true, force: true });
});
