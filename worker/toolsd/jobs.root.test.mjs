/**
 * Job runner against REAL processes — the section 5.1 execution identity proved
 * for real, not modelled. These spawn `setpriv`, drop to uid/gid 7001, and read
 * `/proc`, so they NEED ROOT (and util-linux `setpriv`). When they cannot run
 * they SKIP with the exact reason and are never counted as passes — a skipped
 * security proof is not a security proof.
 *
 * What only a real run can show, and `jobs.test.mjs`'s fakes cannot:
 *   - the job's `id -u` is 7001 (the privilege drop actually happened);
 *   - the job's environment has NO `EZIL_*`, even with `EZIL_FAKE_TOKEN` and
 *     `EZIL_TOOLSD_SEED` planted in toolsd's own environment (the env scrub,
 *     and its mutation-proof: spread `process.env` into the job env and this
 *     goes red);
 *   - a job gets EACCES reading `/proc/<pid>/environ` of a ROOT process started
 *     with a planted `EZIL_` token — root's secrets are unreadable to 7001;
 *   - timeout (SIGTERM→SIGKILL), cancel, the 4-process cap and the 65,536-byte
 *     retention, with real pipes and real signals.
 *
 * `node:test`; runs under `node --test` and `bun test`.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJobManager, prepareToolsDir, JOB_UID, JOB_GID } from './jobs.mjs';
import { scanCatalog } from './manifest.mjs';

const SECRET = 'planted-sekret-correct-horse-battery-staple';

function skipReason() {
  if (typeof process.getuid !== 'function') return 'no process.getuid (not a POSIX host)';
  if (process.getuid() !== 0) return 'not running as root — cannot drop a job to uid 7001';
  if (spawnSync('setpriv', ['--version']).status !== 0) return 'setpriv (util-linux) is not installed on PATH';
  if (spawnSync('bash', ['-c', 'true']).status !== 0) return '/bin/bash is not runnable';
  const drop = spawnSync('setpriv', ['--reuid', '7001', '--regid', '7001', '--clear-groups', '--no-new-privs', '--', 'id', '-u'], { encoding: 'utf8' });
  if (drop.status !== 0 || (drop.stdout || '').trim() !== '7001') return `setpriv could not drop to uid 7001 (${(drop.stderr || drop.stdout || '').trim()})`;
  return null;
}

const SKIP = skipReason();
if (SKIP) {
  console.warn(
    `\n${'='.repeat(78)}\n`
    + `SKIPPING the toolsd ROOT job suite: ${SKIP}.\n`
    + `The uid-7001 drop, the EZIL_* environment scrub, and the /proc EACCES\n`
    + `protection are ONLY provable with a real privilege drop. The fake-spawn\n`
    + `suite (jobs.test.mjs) checks the state machine, not these properties.\n`
    + `${'='.repeat(78)}\n`,
  );
}
const t = SKIP ? test.skip : test;

/** A fresh workspace with `.ezil/tools` prepared (chown/1777) like boot does. */
function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'ezil-toolsd-root-'));
  // The real workspace is readable (not writable) by jobs; mkdtemp is 0700, so
  // widen it to 0755 or a dropped job cannot even traverse its own cwd.
  chmodSync(root, 0o755);
  prepareToolsDir(root);
  return root;
}

/** `gone` (reaped), `zombie` (killed, unreaped) or `alive` — a zombie is dead. */
function procState(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const state = stat.slice(stat.lastIndexOf(')') + 2)[0];
    return state === 'Z' ? 'zombie' : 'alive';
  } catch {
    return 'gone';
  }
}

function manager(root, { waitMs = 400, sigkillDelayMs = 2000 } = {}) {
  return createJobManager({ workspaceRoot: root, getScan: () => scanCatalog(root), waitMs, sigkillDelayMs });
}

t('a terminal job runs as uid 7001', async () => {
  const root = workspace();
  try {
    const jm = manager(root);
    const res = await jm.exec({ command: 'id -u', timeoutSeconds: 10, background: false, requestId: 'uid-1' });
    assert.equal(res.ok, true);
    assert.equal(res.job.state, 'exited');
    assert.equal(res.job.exitCode, 0);
    assert.equal(res.job.stdout.trim(), String(JOB_UID));
    // Contrast: this very test process is root, so the drop is real and not a
    // no-op inherited from the parent.
    assert.equal(process.getuid(), 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

t('🔴 a job has uid 7001, gid 7001 and NO supplementary groups (id -G is exactly 7001)', async () => {
  const root = workspace();
  const savedGroups = process.getgroups();
  try {
    // Plant supplementary groups on toolsd itself, so the drop has something to
    // strip. Without this, a host whose root has no supplementary groups (like a
    // bare CI box) cannot tell --clear-groups from --keep-groups; the image's
    // root DOES carry extra groups, which is the condition this reproduces.
    process.setgroups([0, 1, 2]);
    const jm = manager(root);
    const res = await jm.exec({ command: 'echo "$(id -u) $(id -g) $(id -G)"', timeoutSeconds: 10, background: false, requestId: 'ids-1' });
    assert.equal(res.job.state, 'exited');
    assert.equal(res.job.exitCode, 0);
    // 🔴 The whole-groups assertion. `--clear-groups` empties the supplementary
    // list, so `id -G` lists only the primary 7001. With `--keep-groups` the job
    // inherits the planted [0,1,2] and `id -G` becomes "7001 0 1 2" -> red.
    assert.equal(res.job.stdout.trim(), `${JOB_UID} ${JOB_GID} ${JOB_GID}`);
  } finally {
    try { process.setgroups(savedGroups); } catch { /* best effort restore */ }
    rmSync(root, { recursive: true, force: true });
  }
});

t('🔴 env scrub: a job sees the from-scratch env and NO EZIL_*, with tokens planted in toolsd\'s env', async () => {
  const root = workspace();
  process.env.EZIL_FAKE_TOKEN = SECRET;
  process.env.EZIL_TOOLSD_SEED = SECRET;
  try {
    // Positive control: the tokens really are in this (parent) process's env.
    assert.equal(process.env.EZIL_FAKE_TOKEN, SECRET);
    assert.equal(process.env.EZIL_TOOLSD_SEED, SECRET);
    const jm = manager(root);
    const res = await jm.exec({ command: 'env', timeoutSeconds: 10, background: false, requestId: 'env-1' });
    assert.equal(res.job.state, 'exited');
    const lines = res.job.stdout.split('\n');
    // The job env is really the from-scratch one…
    assert.ok(lines.includes('USER=ezil-run'), 'USER=ezil-run present');
    assert.ok(lines.includes('PATH=/usr/local/bin:/usr/bin:/bin'), 'the fixed PATH present');
    // …and carries NOTHING starting with EZIL_ (would go red if process.env leaked in).
    const leaked = lines.filter((l) => l.startsWith('EZIL_'));
    assert.deepEqual(leaked, [], `no EZIL_* in the job env (saw: ${leaked.join(', ')})`);
    assert.ok(!res.job.stdout.includes(SECRET), 'the planted secret never reached the job');
  } finally {
    delete process.env.EZIL_FAKE_TOKEN;
    delete process.env.EZIL_TOOLSD_SEED;
    rmSync(root, { recursive: true, force: true });
  }
});

t('🔴 a job gets EACCES reading /proc/<pid>/environ of a root process holding an EZIL_ token', async () => {
  const root = workspace();
  // A long-lived ROOT process whose environ holds a secret EZIL_ token.
  const victim = spawn('sleep', ['30'], { env: { ...process.env, EZIL_PLANTED_TOKEN: SECRET }, stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 150));
  try {
    const pid = victim.pid;
    // Positive control: root (this process) CAN read it and the token is there.
    const asRoot = readFileSync(`/proc/${pid}/environ`);
    assert.ok(asRoot.includes(Buffer.from(`EZIL_PLANTED_TOKEN=${SECRET}`)), 'the token is really in the victim environ');
    // The job (uid 7001) must NOT be able to read it.
    const jm = manager(root);
    const res = await jm.exec({ command: `cat /proc/${pid}/environ`, timeoutSeconds: 10, background: false, requestId: 'proc-1' });
    assert.equal(res.job.state, 'exited');
    assert.notEqual(res.job.exitCode, 0, 'cat failed');
    assert.ok(/permission denied/i.test(res.job.stderr), `EACCES surfaced (stderr: ${res.job.stderr.slice(0, 120)})`);
    assert.ok(!res.job.stdout.includes(SECRET), 'the secret never leaked into the job');
  } finally {
    victim.kill('SIGKILL');
    rmSync(root, { recursive: true, force: true });
  }
});

t('a tool call runs in the tool dir as 7001, with EZIL_TOOL_DIR set and args on stdin', async () => {
  const root = workspace();
  const toolDir = join(root, '.ezil/tools/probe');
  mkdirSync(toolDir, { recursive: true });
  writeFileSync(join(toolDir, 'tool.json'), JSON.stringify({
    schema: 'ezil.tool/1', name: 'probe', description: 'probe', inputSchema: { type: 'object' },
    run: { argv: ['./run.sh'] }, timeoutSeconds: 10,
  }));
  writeFileSync(join(toolDir, 'run.sh'), '#!/bin/bash\nread -r line\necho "uid=$(id -u) dir=$EZIL_TOOL_DIR args=$line"\n', { mode: 0o755 });
  chmodSync(toolDir, 0o755);
  try {
    const jm = manager(root);
    const res = await jm.call({ name: 'probe', arguments: { x: 1 }, requestId: 'tool-1' });
    assert.equal(res.ok, true);
    assert.equal(res.job.state, 'exited');
    assert.equal(res.job.exitCode, 0, `stderr: ${res.job.stderr}`);
    assert.ok(res.job.stdout.includes(`uid=${JOB_UID}`), 'ran as 7001');
    assert.ok(res.job.stdout.includes(`dir=${toolDir}`), 'EZIL_TOOL_DIR is the tool dir');
    assert.ok(res.job.stdout.includes('args={"x":1}'), 'arguments arrived as JSON on stdin');
    // catalogDigest comes from the scan the server pairs with the reply.
    assert.match(scanCatalog(root).catalogDigest, /^sha256:[0-9a-f]{64}$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

t('timeout: a job past its timeout is timed_out (SIGTERM, then SIGKILL)', async () => {
  const root = workspace();
  try {
    const jm = manager(root, { waitMs: 200, sigkillDelayMs: 1000 });
    const started = await jm.exec({ command: 'sleep 30', timeoutSeconds: 1, background: false, requestId: 'to-1' });
    assert.equal(started.job.state, 'running');
    await new Promise((r) => setTimeout(r, 1600));
    const after = jm.job({ jobId: started.job.jobId });
    assert.equal(after.job.state, 'timed_out');
    assert.ok(after.job.endedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

t('cancel: a running job is cancelled by signalling its group', async () => {
  const root = workspace();
  try {
    const jm = manager(root, { waitMs: 1500, sigkillDelayMs: 2000 });
    const started = await jm.exec({ command: 'sleep 30', timeoutSeconds: 600, background: false, requestId: 'ca-1' });
    assert.equal(started.job.state, 'running');
    const cancelled = await jm.cancel({ jobId: started.job.jobId, requestId: 'ca-x' });
    assert.equal(cancelled.job.state, 'cancelled');
    assert.ok(cancelled.job.endedAt);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

t('a whole process group is killed — a child of the job dies too', async () => {
  const root = workspace();
  // /tmp (world-writable, sticky) — the job runs as 7001 and cannot write the
  // workspace, so the forked child records its pid here.
  const pidFile = join(tmpdir(), `ezil-grp-${process.pid}-${Math.random().toString(36).slice(2)}.pid`);
  try {
    const jm = manager(root, { waitMs: 300, sigkillDelayMs: 1000 });
    const started = await jm.exec({
      command: `sleep 30 & echo $! > ${pidFile}; wait`,
      timeoutSeconds: 1, background: false, requestId: 'grp-1',
    });
    assert.equal(started.job.state, 'running');
    // Past the timeout (1s) and the SIGKILL follow-up (1s) with margin.
    await new Promise((r) => setTimeout(r, 2600));
    const childPid = Number(readFileSync(pidFile, 'utf8').trim());
    assert.ok(Number.isInteger(childPid) && childPid > 0, 'the forked child recorded its pid');
    // The grandchild sleep must be dead (gone or a zombie) — the group signal
    // reached it, not just the leader. A live 'S' here means the group kill
    // did not reach descendants.
    assert.notEqual(procState(childPid), 'alive', 'the forked sleep was killed with the group');
  } finally {
    rmSync(pidFile, { force: true });
    rmSync(root, { recursive: true, force: true });
  }
});

t('the 4-process cap: a 5th real job is terminal_jobs_busy with nothing started', async () => {
  const root = workspace();
  const jm = manager(root, { waitMs: 200, sigkillDelayMs: 500 });
  const running = [];
  try {
    for (let i = 0; i < 4; i++) {
      const res = await jm.exec({ command: 'sleep 20', timeoutSeconds: 600, background: false, requestId: `cap-${i}` });
      assert.equal(res.job.state, 'running');
      running.push(res.job.jobId);
    }
    const fifth = await jm.exec({ command: 'echo hi', timeoutSeconds: 10, background: false, requestId: 'cap-5' });
    assert.deepEqual(fifth, { ok: false, error: 'terminal_jobs_busy' });
  } finally {
    for (const id of running) await jm.cancel({ jobId: id, requestId: `cleanup-${id}` });
    rmSync(root, { recursive: true, force: true });
  }
});

t('output retention: >65,536 bytes of stdout is truncated, bytes counts them all', async () => {
  const root = workspace();
  try {
    const jm = manager(root, { waitMs: 8000 });
    const res = await jm.exec({
      command: "head -c 70000 /dev/zero | tr '\\0' A",
      timeoutSeconds: 30, background: false, requestId: 'ret-1',
    });
    assert.equal(res.job.state, 'exited');
    assert.equal(res.job.stdoutBytes, 70_000);
    assert.equal(res.job.stdoutTruncated, true);
    assert.equal(res.job.stdout.length, 65_536);
    assert.ok(/^A+$/.test(res.job.stdout));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
