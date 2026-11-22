/**
 * Job runner state machine, caps, stream retention and cwd rules (contract
 * section 5), driven by an injected fake spawner so the LOGIC is provable
 * everywhere. The real privilege drop (`setpriv`), real uid 7001 and the real
 * `/proc` protection are proved by `jobs.root.test.mjs`, which needs root.
 *
 * `node:test`, so this runs under `node --test` and `bun test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createJobManager, resolveCwd, StreamCapture,
  JOB_BASE_ENV, privDropArgv, SETPRIV, STREAM_RETENTION_BYTES, MAX_RUNNING,
} from './jobs.mjs';
import { scanCatalog } from './manifest.mjs';

/** A controllable fake child + spawner + process-group killer. */
function harness() {
  const spawned = [];
  const byPid = new Map();
  let nextPid = 5000;
  const spawn = (cmd, args, opts) => {
    const child = new EventEmitter();
    child.pid = nextPid++;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end() {}, on() {} };
    child.spawnArgs = { cmd, args, opts };
    spawned.push(child);
    byPid.set(child.pid, child);
    return child;
  };
  const killSignals = [];
  const killGroup = (pid, signal) => {
    killSignals.push({ pid, signal });
    const child = byPid.get(pid);
    // A real SIGTERM/SIGKILL to the group ends the process; model that.
    if (child && !child._exited) {
      child._exited = true;
      queueMicrotask(() => child.emit('exit', null, signal));
    }
  };
  return { spawn, killGroup, spawned, killSignals, last: () => spawned.at(-1) };
}

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'ezil-toolsd-jobs-'));
  mkdirSync(join(root, '.ezil/tools'), { recursive: true });
  return root;
}

const scanWith = (byName = new Map(), catalogDigest = 'sha256:' + '0'.repeat(64)) => () => ({ catalogDigest, byName });

// Fast timers so a "wait" resolves quickly; the timeout timer (seconds*1000)
// stays far away unless a test sets timeoutSeconds deliberately small.
const fast = { waitMs: 30, sigkillDelayMs: 10 };

test('resolveCwd: default root, containment, and refusals', () => {
  const root = workspace();
  mkdirSync(join(root, 'sub/deep'), { recursive: true });
  try {
    // realpathSync resolves symlinks (e.g. /tmp -> /private/tmp); compare resolved.
    assert.equal(resolveCwd(root, undefined), realpathSync(root));
    assert.equal(resolveCwd(root, ''), realpathSync(root));
    assert.equal(resolveCwd(root, 'sub/deep'), realpathSync(join(root, 'sub/deep')));
    assert.equal(resolveCwd(root, '../etc'), null);
    assert.equal(resolveCwd(root, '/etc'), null);
    assert.equal(resolveCwd(root, 'x'.repeat(513)), null);
    assert.equal(resolveCwd(root, 'does/not/exist'), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('StreamCapture keeps the last 65,536 bytes and counts everything', () => {
  const cap = new StreamCapture();
  cap.push(Buffer.alloc(40_000, 0x41)); // 'A'
  cap.push(Buffer.alloc(40_000, 0x42)); // 'B'
  assert.equal(cap.bytes, 80_000);
  assert.equal(cap.truncated, true);
  const text = cap.text();
  assert.equal(text.length, STREAM_RETENTION_BYTES);
  // The retained tail is all 'B' plus the end of the 'A' run.
  assert.equal(text.at(-1), 'B');
  assert.ok(text.startsWith('A'));
  // A small stream is retained whole and not marked truncated.
  const small = new StreamCapture();
  small.push(Buffer.from('hello'));
  assert.equal(small.text(), 'hello');
  assert.equal(small.truncated, false);
  assert.equal(small.bytes, 5);
});

test('call spawns via setpriv with a from-scratch env + EZIL_TOOL_DIR, stdin = JSON args', async () => {
  const root = workspace();
  const h = harness();
  // A real tool dir + run.sh so the exec-time ./argv[0] containment check passes.
  mkdirSync(join(root, '.ezil/tools/hello'), { recursive: true });
  writeFileSync(join(root, '.ezil/tools/hello/run.sh'), '#!/bin/sh\n', { mode: 0o755 });
  const byName = new Map([['hello', { argv: ['./run.sh'], dir: join(root, '.ezil/tools/hello'), timeoutSeconds: 10 }]]);
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(byName), ...h, ...fast });
  try {
    const p = jm.call({ name: 'hello', arguments: { a: 1 }, requestId: 'req-1' });
    const child = h.last();
    assert.deepEqual(child.spawnArgs.cmd, SETPRIV);
    assert.equal(SETPRIV, '/usr/bin/setpriv');
    assert.deepEqual(child.spawnArgs.args, privDropArgv(['./run.sh']).slice(1));
    assert.ok(child.spawnArgs.args.includes('--clear-groups'));
    assert.equal(child.spawnArgs.opts.cwd, join(root, '.ezil/tools/hello'));
    assert.equal(child.spawnArgs.opts.detached, true);
    assert.equal(child.spawnArgs.opts.env.EZIL_TOOL_DIR, join(root, '.ezil/tools/hello'));
    assert.equal(child.spawnArgs.opts.env.PATH, JOB_BASE_ENV.PATH);
    // No secret from toolsd's own environment leaks into the job env.
    assert.ok(!Object.keys(child.spawnArgs.opts.env).some((k) => /^EZIL_.*_TOKEN$|^EZIL_TOOLSD_/.test(k)));
    child.stdout.emit('data', Buffer.from('{"ok":true}'));
    child.emit('exit', 0, null);
    const res = await p;
    assert.equal(res.ok, true);
    assert.equal(res.job.kind, 'tool');
    assert.equal(res.job.name, 'hello');
    assert.equal(res.job.state, 'exited');
    assert.equal(res.job.exitCode, 0);
    assert.equal(res.job.stdout, '{"ok":true}');
    assert.equal(res.job.requestId, 'req-1');
    assert.match(res.job.jobId, /^[A-Za-z0-9_-]{22}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('call of an unknown tool is tool_not_found, nothing spawned', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(new Map()), ...h, ...fast });
  try {
    const res = await jm.call({ name: 'nope', arguments: {}, requestId: 'r' });
    assert.deepEqual(res, { ok: false, error: 'tool_not_found' });
    assert.equal(h.spawned.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the 4-process cap: the 5th request is terminal_jobs_busy with nothing started', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast });
  try {
    // Four long-running terminal jobs (timeoutSeconds huge so the timer never fires).
    for (let i = 0; i < MAX_RUNNING; i++) {
      const res = await jm.exec({ command: 'sleep 999', timeoutSeconds: 9999, background: false, requestId: `r${i}` });
      assert.equal(res.job.state, 'running');
    }
    assert.equal(jm._runningCount(), 4);
    const before = h.spawned.length;
    const fifth = await jm.exec({ command: 'echo hi', timeoutSeconds: 9999, background: false, requestId: 'r5' });
    assert.deepEqual(fifth, { ok: false, error: 'terminal_jobs_busy' });
    assert.equal(h.spawned.length, before, 'nothing was spawned for the refused 5th');
    // When one finishes, a slot frees and a new job starts.
    h.spawned[0].emit('exit', 0, null);
    await new Promise((r) => setTimeout(r, 1));
    assert.equal(jm._runningCount(), 3);
    const sixth = await jm.exec({ command: 'echo hi', timeoutSeconds: 9999, background: false, requestId: 'r6' });
    assert.equal(sixth.job.state, 'running');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dedupe: a repeated requestId polls the SAME job, never a second spawn', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast });
  try {
    const first = await jm.exec({ command: 'sleep 999', timeoutSeconds: 9999, background: false, requestId: 'dup' });
    assert.equal(first.job.state, 'running');
    const spawnCount = h.spawned.length;
    const again = await jm.exec({ command: 'sleep 999', timeoutSeconds: 9999, background: false, requestId: 'dup' });
    assert.equal(again.job.jobId, first.job.jobId);
    assert.equal(h.spawned.length, spawnCount, 'no second spawn for the same requestId');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout: SIGTERM then SIGKILL to the group, state timed_out', async () => {
  const root = workspace();
  const h = harness();
  // timeoutSeconds must be small so the real timer fires; sigkill delay tiny.
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, waitMs: 5, sigkillDelayMs: 10 });
  try {
    const started = await jm.exec({ command: 'sleep 999', timeoutSeconds: 1, background: false, requestId: 't' });
    const jobId = started.job.jobId;
    // Wait past the 1s timeout; the fake killGroup ends the process on SIGTERM.
    await new Promise((r) => setTimeout(r, 1200));
    const after = jm.job({ jobId });
    assert.equal(after.job.state, 'timed_out');
    assert.ok(after.job.endedAt);
    assert.ok(h.killSignals.some((k) => k.signal === 'SIGTERM'), 'a SIGTERM was sent to the group');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout schedules a SIGKILL follow-up if the group survives SIGTERM', async () => {
  const root = workspace();
  const h = harness();
  // A killGroup that ignores SIGTERM, so the SIGKILL follow-up is observable.
  const kills = [];
  const stubbornKill = (pid, signal) => {
    kills.push({ pid, signal });
    if (signal === 'SIGKILL') {
      const child = h.spawned.find((c) => c.pid === pid);
      if (child && !child._exited) { child._exited = true; child.emit('exit', null, 'SIGKILL'); }
    }
  };
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), spawn: h.spawn, killGroup: stubbornKill, waitMs: 5, sigkillDelayMs: 30 });
  try {
    const started = await jm.exec({ command: 'sleep 999', timeoutSeconds: 1, background: false, requestId: 'tk' });
    await new Promise((r) => setTimeout(r, 1300));
    const after = jm.job({ jobId: started.job.jobId });
    assert.equal(after.job.state, 'timed_out');
    assert.deepEqual(kills.map((k) => k.signal), ['SIGTERM', 'SIGKILL']);
    assert.equal(after.job.signal, 'SIGKILL');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancel: a running job becomes cancelled; an ended job keeps its final state', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, waitMs: 5, sigkillDelayMs: 10 });
  try {
    const started = await jm.exec({ command: 'sleep 999', timeoutSeconds: 9999, background: false, requestId: 'c' });
    const jobId = started.job.jobId;
    const cancelled = await jm.cancel({ jobId, requestId: 'cx' });
    assert.equal(cancelled.job.state, 'cancelled');
    assert.ok(h.killSignals.some((k) => k.signal === 'SIGTERM'));
    // Cancelling again returns the final state unchanged (no new signal).
    const kcount = h.killSignals.length;
    const again = await jm.cancel({ jobId, requestId: 'cx2' });
    assert.equal(again.job.state, 'cancelled');
    assert.equal(h.killSignals.length, kcount);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cancel of an exited job returns exited, not cancelled', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast });
  try {
    const p = jm.exec({ command: 'echo hi', timeoutSeconds: 9999, background: false, requestId: 'e' });
    const child = h.last();
    child.stdout.emit('data', Buffer.from('hi\n'));
    child.emit('exit', 0, null);
    const started = await p;
    assert.equal(started.job.state, 'exited');
    const res = await jm.cancel({ jobId: started.job.jobId, requestId: 'ex' });
    assert.equal(res.job.state, 'exited');
    assert.equal(res.job.exitCode, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unknown jobId is job_not_found', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast });
  try {
    assert.deepEqual(jm.job({ jobId: 'AAAAAAAAAAAAAAAAAAAAAA' }), { ok: false, error: 'job_not_found' });
    assert.deepEqual(await jm.cancel({ jobId: 'AAAAAAAAAAAAAAAAAAAAAA' }), { ok: false, error: 'job_not_found' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('output truncation flags: stdout over 65,536 bytes is truncated, bytes counts all', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast });
  try {
    const p = jm.exec({ command: 'yes', timeoutSeconds: 9999, background: false, requestId: 'tr' });
    const child = h.last();
    child.stdout.emit('data', Buffer.alloc(70_000, 0x41));
    child.emit('exit', 0, null);
    const res = await p;
    assert.equal(res.job.stdoutBytes, 70_000);
    assert.equal(res.job.stdoutTruncated, true);
    assert.equal(res.job.stdout.length, STREAM_RETENTION_BYTES);
    assert.equal(res.job.stderrBytes, 0);
    assert.equal(res.job.stderrTruncated, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('finished-job retention: at most 64 are kept', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast, maxFinished: 64 });
  try {
    const ids = [];
    for (let i = 0; i < 70; i++) {
      const p = jm.exec({ command: 'echo', timeoutSeconds: 9999, background: false, requestId: `f${i}` });
      const child = h.last();
      child.emit('exit', 0, null);
      const res = await p;
      ids.push(res.job.jobId);
    }
    assert.equal(jm._finishedCount(), 64);
    // The oldest were forgotten → job_not_found; the newest are retained.
    assert.equal(jm.job({ jobId: ids[0] }).ok, false);
    assert.equal(jm.job({ jobId: ids.at(-1) }).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the serialized Job carries every contract field', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast });
  try {
    const p = jm.exec({ command: 'echo', timeoutSeconds: 42, background: true, requestId: 'shape' });
    const child = h.last();
    child.emit('exit', 3, null);
    const { job } = await p;
    assert.deepEqual(Object.keys(job).sort(), [
      'background', 'endedAt', 'exitCode', 'jobId', 'kind', 'name', 'requestId', 'signal',
      'startedAt', 'state', 'stderr', 'stderrBytes', 'stderrTruncated',
      'stdout', 'stdoutBytes', 'stdoutTruncated', 'timeoutSeconds',
    ].sort());
    assert.equal(job.background, true);
    assert.equal(job.timeoutSeconds, 42);
    assert.equal(job.name, null);
    assert.equal(job.exitCode, 3);
    assert.equal(job.state, 'exited');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveCwd refuses a cwd that is a symlink escaping the workspace', () => {
  const root = workspace();
  symlinkSync('/etc', join(root, '.ezil/tools/escape'));
  mkdirSync(join(root, 'real'), { recursive: true });
  try {
    // The symlink resolves to /etc, which is outside the workspace → refused.
    assert.equal(resolveCwd(root, '.ezil/tools/escape'), null);
    // Positive control: a real in-workspace directory resolves.
    assert.equal(resolveCwd(root, 'real'), realpathSync(join(root, 'real')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('exec with a cwd that symlinks outside the workspace is tools_invalid_request, nothing spawned', async () => {
  const root = workspace();
  symlinkSync('/etc', join(root, '.ezil/tools/escape'));
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast });
  try {
    const res = await jm.exec({ command: 'id', cwd: '.ezil/tools/escape', timeoutSeconds: 10, background: false, requestId: 'esc' });
    assert.deepEqual(res, { ok: false, error: 'tools_invalid_request' });
    assert.equal(h.spawned.length, 0, 'nothing was spawned for the escaping cwd');
    // Positive control: a default cwd reaches spawn.
    void jm.exec({ command: 'id', timeoutSeconds: 10, background: false, requestId: 'esc-ok' });
    assert.equal(h.spawned.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('🔴 exec-time TOCTOU: a ./argv[0] swapped for an escaping symlink after the scan is tool_not_found, nothing spawned', async () => {
  const root = workspace();
  const toolDir = join(root, '.ezil/tools/greet');
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, 'tool.json'), JSON.stringify({
    schema: 'ezil.tool/1', name: 'greet', description: 'd', inputSchema: { type: 'object' },
    run: { argv: ['./run.sh'] }, timeoutSeconds: 10,
  }));
  writeFileSync(join(toolDir, 'run.sh'), '#!/bin/sh\necho hi\n', { mode: 0o755 });
  // Scan while the tool is valid; the manager will keep using THIS scan.
  const scan = scanCatalog(root);
  assert.ok(scan.byName.has('greet'), 'greet is valid at scan time (positive control)');
  // Swap the file for a symlink that escapes the tool directory.
  rmSync(join(toolDir, 'run.sh'));
  symlinkSync('/bin/sh', join(toolDir, 'run.sh'));
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: () => scan, ...h, ...fast });
  try {
    const res = await jm.call({ name: 'greet', arguments: {}, requestId: 'swap' });
    assert.deepEqual(res, { ok: false, error: 'tool_not_found' });
    assert.equal(h.spawned.length, 0, 'the swapped tool was never spawned');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('🔴 a job whose spawn THROWS finishes as a clear failure (exitCode null + stderr diagnostic), not a clean exit', async () => {
  const root = workspace();
  const throwingSpawn = () => { throw new Error('ENOENT /usr/bin/setpriv'); };
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), spawn: throwingSpawn, killGroup: () => {}, ...fast });
  try {
    const res = await jm.exec({ command: 'id', timeoutSeconds: 10, background: false, requestId: 'noexec' });
    assert.equal(res.ok, true);
    assert.equal(res.job.state, 'exited');
    assert.equal(res.job.exitCode, null, 'null exit code, never a clean 0');
    assert.ok(res.job.stderr.includes('job could not start'), 'a stderr diagnostic is present');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a job whose child emits error also finishes as a clear failure', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast });
  try {
    const p = jm.exec({ command: 'id', timeoutSeconds: 10, background: false, requestId: 'err' });
    h.last().emit('error', new Error('spawn failed after pipes'));
    const res = await p;
    assert.equal(res.job.state, 'exited');
    assert.equal(res.job.exitCode, null);
    assert.ok(res.job.stderr.includes('job could not start'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('🔴 byRequestId is pruned alongside finished jobs (bounded with the finished cap)', async () => {
  const root = workspace();
  const h = harness();
  const jm = createJobManager({ workspaceRoot: root, getScan: scanWith(), ...h, ...fast, maxFinished: 64 });
  try {
    for (let i = 0; i < 70; i++) {
      const p = jm.exec({ command: 'echo', timeoutSeconds: 9999, background: false, requestId: `rq${i}` });
      h.last().emit('exit', 0, null);
      await p;
    }
    assert.equal(jm._finishedCount(), 64);
    // Without the prune this would be 70 and grow forever; it tracks finished.
    assert.equal(jm._byRequestIdSize(), 64);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
