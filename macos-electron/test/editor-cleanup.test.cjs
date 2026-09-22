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
  t.after(() => { for (const instance of supervisor.instances.values()) { clearInterval(instance.monitor); if (instance.runtime) fs.rmSync(instance.runtime, { recursive: true, force: true }); } });
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
  assert.equal(supervisor.failure(workspace.id), 'editor_cleanup_unverified');
  await assert.rejects(supervisor.start(workspace));
  assert.equal(supervisor.failure(workspace.id), 'editor_cleanup_unverified');
  fs.rmSync(instance.runtime, { recursive: true, force: true });
});

const deferred = () => { let resolve, reject; const promise = new Promise((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('transient monitor failure recovers when the same root and descendant identities remain live', async t => {
  const { state, supervisor, workspace } = setup(t, (s, pid) => { s.rows = s.rows.filter(r => r.pid !== pid); });
  const instance = await supervisor.start(workspace);
  const failed = deferred();
  supervisor.snapshot = () => { failed.resolve(); throw Error('transient'); };
  await failed.promise; await delay(0);
  assert.equal(instance.inventoryFailed, true);
  supervisor.snapshot = async () => state.rows;
  await supervisor.track(instance);
  assert.equal(instance.inventoryFailed, false);
  assert.equal(instance.lastLive.get(10001), '10001:original');
  await supervisor.stop(workspace.id);
  assert.equal(instance.inventoryFailed, false); assert.equal(supervisor.failure(workspace.id), null);
  state.rows = [row(10001, 1)];
  await supervisor.start(workspace); await supervisor.stop(workspace.id);
  assert.equal(supervisor.state(workspace.id), 'stopped');
});

test('root disappearing across an inventory gap leaves unknown reparented descendants unresolved', async t => {
  const { state, supervisor, workspace } = setup(t, (s, pid) => { s.rows = s.rows.filter(r => r.pid !== pid); });
  const instance = await supervisor.start(workspace);
  clearInterval(instance.monitor);
  supervisor.snapshot = async () => { throw Error('gap'); };
  await assert.rejects(supervisor.track(instance));
  // 30001 was born during the gap and is no longer linked to a known owner.
  state.rows = [row(10001, 1, 10001, 'replacement'), row(10002, 1), row(10003, 10002), row(30001, 1)];
  supervisor.snapshot = async () => state.rows;
  await assert.rejects(supervisor.stop(workspace.id), /cleanup unverified/);
  assert.equal(instance.inventoryFailed, true);
  assert.equal(supervisor.failure(workspace.id), 'editor_cleanup_unverified');
  assert.equal(fs.existsSync(instance.runtime), true);
  assert.ok(!state.signals.some(([pid]) => pid === 10001 || pid === 30001));
  state.rows = [];
  await assert.rejects(supervisor.stop(workspace.id), /cleanup unverified/);
  await assert.rejects(supervisor.start(workspace), /cleanup unverified/);
});

test('live root cannot resolve a descendant owner disappearing across an inventory gap', async t => {
  const { state, supervisor, workspace } = setup(t, (s, pid) => { s.rows = s.rows.filter(r => r.pid !== pid); });
  const instance = await supervisor.start(workspace); clearInterval(instance.monitor);
  supervisor.snapshot = () => { throw Error('gap'); };
  await assert.rejects(supervisor.track(instance));
  state.rows = [row(10001, 1), row(30001, 1)];
  supervisor.snapshot = () => state.rows;
  await assert.rejects(supervisor.stop(workspace.id), /cleanup unverified/);
  assert.equal(instance.ancestryUnresolved, true);
  assert.ok(!state.signals.some(([pid]) => pid === 30001));
});

test('unavailable inventory never falls back to child.kill against a potentially reused PID', async t => {
  const { state, supervisor, workspace } = setup(t, () => {});
  await supervisor.start(workspace);
  let kills = 0; state.child.kill = () => { kills++; };
  state.rows = [row(10001, 1, 10001, 'replacement')];
  supervisor.snapshot = () => { throw Error('unavailable'); };
  await assert.rejects(supervisor.stop(workspace.id)); await delay(20);
  assert.equal(kills, 0); assert.equal(state.signals.length, 0);
});

test('cancellation during first track drains ownership and cleanup before startup settles', async t => {
  const { state, supervisor, workspace } = setup(t, (s, pid) => { s.rows = s.rows.filter(r => r.pid !== pid); });
  const entered = deferred(), initial = deferred(), cleaning = deferred(), cleanup = deferred();
  let samples = 0, settled = false, authentications = 0;
  supervisor.snapshot = async () => {
    samples++;
    if (samples === 2) { entered.resolve(); return initial.promise; }
    if (samples === 3) { cleaning.resolve(); return cleanup.promise; }
    return state.rows;
  };
  supervisor.authenticate = async () => { authentications++; return 'fixture'; };
  const starting = supervisor.start(workspace);
  const rejected = assert.rejects(starting, /Editor unavailable/).then(() => { settled = true; });
  await entered.promise;
  const instance = supervisor.instances.get(workspace.id);
  const stopping = supervisor.stop(workspace.id);
  await delay(0); assert.equal(settled, false); assert.equal(state.signals.length, 0);
  initial.resolve(state.rows); await cleaning.promise; await delay(0);
  assert.equal(settled, false); assert.equal(authentications, 0);
  cleanup.resolve(state.rows); await stopping; await rejected;
  assert.equal(state.rows.length, 1); assert.equal(state.rows[0].pid, 20000);
  assert.equal(fs.existsSync(instance.runtime), false); assert.equal(instance.cookie, null);
  state.rows = [row(10001, 1)]; await supervisor.start(workspace); await supervisor.stop(workspace.id);
});

test('cancellation during authentication drains cleanup and late authentication cannot make an old instance ready', async t => {
  const { state, supervisor, workspace } = setup(t, (s, pid) => { s.rows = s.rows.filter(r => r.pid !== pid); });
  const entered = deferred(), authentication = deferred(), cleaning = deferred(), cleanup = deferred();
  supervisor.authenticate = () => { entered.resolve(); return authentication.promise; };
  let settled = false;
  const starting = supervisor.start(workspace);
  const rejected = assert.rejects(starting, /Editor unavailable/).then(() => { settled = true; });
  await entered.promise;
  const instance = supervisor.instances.get(workspace.id);
  let snapshots = 0;
  supervisor.snapshot = async () => { if (++snapshots === 1) { cleaning.resolve(); return cleanup.promise; } return state.rows; };
  const stopping = supervisor.stop(workspace.id); await cleaning.promise; await delay(120);
  assert.equal(settled, false);
  cleanup.resolve(state.rows); await stopping; await rejected;
  assert.equal(fs.existsSync(instance.runtime), false); assert.equal(instance.cookie, null);
  state.rows = [row(10001, 1)]; supervisor.authenticate = async () => 'new-fixture';
  const next = await supervisor.start(workspace);
  authentication.resolve('late-fixture'); await delay(0);
  assert.equal(instance.state, 'stopped'); assert.equal(instance.cookie, null);
  assert.equal(next.cookie, 'new-fixture');
  await supervisor.stop(workspace.id);
});

test('failed first track during cancellation settles both operations without adopting or killing a replacement PID', async t => {
  const { state, supervisor, workspace } = setup(t, () => {});
  const entered = deferred(), initial = deferred(); let samples = 0, kills = 0;
  state.child.kill = () => { kills++; };
  supervisor.snapshot = async () => {
    if (++samples === 2) { entered.resolve(); return initial.promise; }
    return state.rows;
  };
  const starting = supervisor.start(workspace);
  const rejected = assert.rejects(starting, /Editor unavailable/);
  await entered.promise;
  const instance = supervisor.instances.get(workspace.id);
  const stopped = assert.rejects(supervisor.stop(workspace.id), /cleanup unverified/);
  state.rows = [row(10001, 1, 10001, 'replacement')];
  initial.reject(Error('unavailable'));
  await stopped; await rejected;
  assert.equal(kills, 0); assert.equal(state.signals.length, 0);
  assert.equal(supervisor.failure(workspace.id), 'editor_cleanup_unverified');
  assert.equal(fs.existsSync(instance.runtime), true);
});

test('stop drains an asynchronous monitor, never overlaps snapshots, and refreshes before signals', async t => {
  const { state, supervisor, workspace } = setup(t, (s, pid) => { s.rows = s.rows.filter(r => r.pid !== pid); });
  await supervisor.start(workspace);
  const entered = deferred(), release = deferred(); let active = 0, maximum = 0, calls = 0;
  supervisor.snapshot = async () => {
    maximum = Math.max(maximum, ++active); calls++;
    try { if (calls === 1) { entered.resolve(); return await release.promise; } return state.rows; }
    finally { active--; }
  };
  await entered.promise; await delay(220);
  assert.equal(calls, 1);
  const stopping = supervisor.stop(workspace.id); await delay(0);
  assert.equal(state.signals.length, 0);
  state.rows = [row(10001, 1, 10001, 'replacement')];
  release.resolve([row(10001, 1), row(10002, 10001)]);
  await stopping;
  assert.equal(maximum, 1); assert.ok(calls > 1); assert.equal(state.signals.length, 0);
});

test('stop cancels asynchronous preflight without spawning or deadlocking startup', async t => {
  const { supervisor, workspace } = setup(t, () => {});
  const entered = deferred(), release = deferred(); let launches = 0;
  supervisor.snapshot = () => { entered.resolve(); return release.promise; };
  supervisor.launch = () => { launches++; throw Error('must not launch'); };
  const starting = supervisor.start(workspace); const rejected = assert.rejects(starting, /Editor unavailable/);
  await entered.promise; await supervisor.stop(workspace.id); await rejected;
  assert.equal(supervisor.state(workspace.id), 'stopped'); assert.equal(launches, 0);
  release.resolve([]); await delay(0); assert.equal(launches, 0);
});

test('throwing notes do not break start/stop and connection loss has a stable reason', async t => {
  const { state, supervisor, workspace } = setup(t, (s, pid) => { s.rows = s.rows.filter(r => r.pid !== pid); });
  // Exercise the constructor wrapper with an injected throwing callback.
  const wrapped = new EditorSupervisor({ note: () => { throw Error('disk'); } });
  supervisor.note = wrapped.note;
  await supervisor.start(workspace); assert.equal(supervisor.failure(workspace.id), null);
  state.child.emit('exit', 1); await supervisor.stop(workspace.id, true);
  assert.equal(supervisor.failure(workspace.id), 'editor_connection_lost');
});

test('preflight failure reports start failure and never launches', async t => {
  const { supervisor, workspace } = setup(t, () => {});
  supervisor.snapshot = async () => { throw Error('unavailable'); };
  supervisor.launch = () => { assert.fail('launched without inventory'); };
  await assert.rejects(supervisor.start(workspace));
  assert.equal(supervisor.failure(workspace.id), 'editor_start_failed');
});

test('unresolved survivors retain runtime and block restart until proven gone', async t => {
  const { state, supervisor, workspace } = setup(t, () => {});
  const instance = await supervisor.start(workspace);
  await assert.rejects(supervisor.stop(workspace.id), /cleanup unverified/);
  assert.equal(supervisor.failure(workspace.id), 'editor_cleanup_unverified');
  assert.equal(fs.existsSync(instance.runtime), true);
  assert.ok(state.signals.some(([, signal]) => signal === 'SIGKILL'));
  state.rows = [];
  await supervisor.stop(workspace.id);
  assert.equal(supervisor.failure(workspace.id), null);
  assert.equal(fs.existsSync(instance.runtime), false);
});

test('asynchronous throwing notes cannot reject lifecycle work', async t => {
  const { supervisor, workspace } = setup(t, (s, pid) => { s.rows = s.rows.filter(r => r.pid !== pid); });
  supervisor.note = new EditorSupervisor({ note: async () => { throw Error('disk'); } }).note;
  await supervisor.start(workspace); await supervisor.stop(workspace.id);
  assert.equal(supervisor.state(workspace.id), 'stopped');
});
