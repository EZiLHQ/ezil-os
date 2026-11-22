/**
 * toolsd job runner — the frozen contract's section 5, exactly.
 *
 * 🔴 EXECUTION IDENTITY (5.1). toolsd runs as root and must NOT hand a job any
 * of root's power. Every job is spawned through `setpriv`, which drops to uid
 * and gid 7001 (`ezil-run`), CLEARS the supplementary group list, and sets
 * no-new-privs before it execs the tool. Node's own `spawn({uid,gid})` does
 * NOT clear supplementary groups — the child would keep root's — so the
 * `--clear-groups` wrapper is load-bearing, not cosmetic. The environment is
 * built from scratch: a job sees only the fixed variables below (plus
 * `EZIL_TOOL_DIR` for a tool call), never toolsd's own environment, so no
 * `EZIL_*_TOKEN` and no `EZIL_TOOLSD_*` can reach it.
 *
 * Each job runs in its own process group (`detached`), so a timeout or a cancel
 * signals the WHOLE group — the tool and anything it forked — not just the
 * leader.
 *
 * The runner is constructed with injectable `spawn`, `killGroup`, `now` and
 * timers so its state machine, caps and retention are testable without being
 * root; the real privilege drop and process-group kill are exercised by the
 * root-only integration suite.
 */

import { spawn as realSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, chownSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

export const JOB_UID = 7001;
export const JOB_GID = 7001;

/** Section 5.2 constants. */
export const MAX_RUNNING = 4;
export const STREAM_RETENTION_BYTES = 65_536;
export const FIRST_WAIT_MS = 8_000;
export const SIGKILL_DELAY_MS = 2_000;
export const FINISHED_RETENTION_MS = 60 * 60 * 1_000;
export const MAX_FINISHED = 64;

/** The from-scratch job environment (5.1). Nothing is inherited from toolsd. */
export const JOB_BASE_ENV = Object.freeze({
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/home/ezil-run',
  USER: 'ezil-run',
  LOGNAME: 'ezil-run',
  LANG: 'C.UTF-8',
  TERM: 'dumb',
  NO_COLOR: '1',
});

/** `jobId` matches `^[A-Za-z0-9_-]{22}$` (16 random bytes, base64url, no padding). */
export function newJobId() {
  return randomBytes(16).toString('base64url');
}

/**
 * The privilege-drop wrapper placed in front of every job's argv. `setpriv`
 * must be on toolsd's own PATH (install via `worker/Dockerfile`).
 */
export function privDropArgv(argv) {
  return [
    'setpriv',
    '--reuid', String(JOB_UID),
    '--regid', String(JOB_GID),
    '--clear-groups',
    '--no-new-privs',
    '--',
    ...argv,
  ];
}

/**
 * Make `<workspace>/.ezil/tools` exist and be writable by the job user (5.1):
 * `chown 7001:7001` on THAT directory only; if the chown is not permitted, fall
 * back to mode 1777 (sticky, world-writable). The rest of the workspace is left
 * exactly as it is. Returns the tools directory path.
 */
export function prepareToolsDir(workspaceRoot) {
  const toolsDir = join(workspaceRoot, '.ezil/tools');
  mkdirSync(toolsDir, { recursive: true });
  try {
    chownSync(toolsDir, JOB_UID, JOB_GID);
  } catch {
    try { chmodSync(toolsDir, 0o1777); } catch { /* best effort; the job just cannot write its tools dir */ }
  }
  return toolsDir;
}

/** A rolling capture of a stream's LAST `max` bytes, with the full byte count. */
class StreamCapture {
  constructor(max = STREAM_RETENTION_BYTES) {
    this.max = max;
    this.chunks = [];
    this.retained = 0;
    this.total = 0;
  }

  push(chunk) {
    this.total += chunk.length;
    if (chunk.length >= this.max) {
      this.chunks = [chunk.subarray(chunk.length - this.max)];
      this.retained = this.max;
      return;
    }
    this.chunks.push(chunk);
    this.retained += chunk.length;
    while (this.retained > this.max) {
      const first = this.chunks[0];
      const over = this.retained - this.max;
      if (first.length <= over) { this.chunks.shift(); this.retained -= first.length; }
      else { this.chunks[0] = first.subarray(over); this.retained -= over; }
    }
  }

  text() {
    const buf = Buffer.concat(this.chunks, this.retained);
    // UTF-8 with replacement (TextDecoder is non-fatal by default); slicing to
    // the last `max` bytes can clip a multibyte sequence, which becomes U+FFFD.
    return new TextDecoder('utf-8').decode(buf);
  }

  get bytes() { return this.total; }
  get truncated() { return this.total > this.max; }
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Default timers. The handle is `unref`'d so a pending job timeout (which can be
 * up to an hour away for a background command) never keeps the process alive on
 * its own — toolsd stays up on its HTTP listener, and an idle test process is
 * free to exit. The timeout still fires while the loop has other work.
 */
const defaultTimers = {
  set: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; },
  clear: clearTimeout,
};

/**
 * The job runner. One per container (toolsd process).
 *
 * `getScan()` returns the current catalog scan (`{ catalogDigest, byName }`)
 * from `manifest.mjs`; `workspaceRoot` is `EZIL_TOOLSD_WORKSPACE`.
 */
export function createJobManager({
  workspaceRoot,
  getScan,
  spawn = realSpawn,
  killGroup = (pid, signal) => { try { process.kill(-pid, signal); } catch { /* already gone */ } },
  now = Date.now,
  waitMs = FIRST_WAIT_MS,
  sigkillDelayMs = SIGKILL_DELAY_MS,
  retentionMs = FINISHED_RETENTION_MS,
  maxFinished = MAX_FINISHED,
  maxRunning = MAX_RUNNING,
  timers = defaultTimers,
} = {}) {
  /** jobId -> live job record. */
  const running = new Map();
  /** jobId -> finalized job record (retained ≤ 1 h, ≤ 64). */
  const finished = new Map();
  /** requestId -> jobId (in-memory dedupe, a second line of defence per 5.2). */
  const byRequestId = new Map();

  function serialize(job) {
    return {
      jobId: job.jobId,
      kind: job.kind,
      name: job.name,
      requestId: job.requestId,
      state: job.state,
      exitCode: job.exitCode,
      signal: job.signal,
      stdout: job.stdoutCap.text(),
      stderr: job.stderrCap.text(),
      stdoutBytes: job.stdoutCap.bytes,
      stderrBytes: job.stderrCap.bytes,
      stdoutTruncated: job.stdoutCap.truncated,
      stderrTruncated: job.stderrCap.truncated,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
      timeoutSeconds: job.timeoutSeconds,
      background: job.background,
    };
  }

  function pruneFinished() {
    const cutoff = now() - retentionMs;
    for (const [id, job] of finished) {
      if (Date.parse(job.endedAt) < cutoff) finished.delete(id);
    }
    while (finished.size > maxFinished) {
      const oldest = finished.keys().next().value;
      finished.delete(oldest);
    }
  }

  function finalize(job, state, { exitCode = null, signal = null } = {}) {
    if (job.state !== 'running') return; // already finalized
    job.state = state;
    job.exitCode = exitCode;
    job.signal = signal;
    job.endedAt = new Date(now()).toISOString();
    if (job.timeoutTimer) timers.clear(job.timeoutTimer);
    if (job.killTimer) timers.clear(job.killTimer);
    running.delete(job.jobId);
    finished.set(job.jobId, job);
    pruneFinished();
    job.resolveDone();
  }

  function start(spec) {
    const job = {
      jobId: newJobId(),
      kind: spec.kind,
      name: spec.name ?? null,
      requestId: spec.requestId ?? null,
      state: 'running',
      exitCode: null,
      signal: null,
      startedAt: new Date(now()).toISOString(),
      endedAt: null,
      timeoutSeconds: spec.timeoutSeconds,
      background: spec.background ?? false,
      stdoutCap: new StreamCapture(),
      stderrCap: new StreamCapture(),
      timedOut: false,
      cancelRequested: false,
      timeoutTimer: undefined,
      killTimer: undefined,
    };
    job.donePromise = new Promise((res) => { job.resolveDone = res; });

    const [cmd, ...args] = privDropArgv(spec.argv);
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: spec.cwd,
        env: spec.env,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      // Could not even start (e.g. setpriv missing): a finalized, failed job
      // rather than a thrown request. No internal error text is surfaced. The
      // job was never added to `running`, so finalize just records it finished.
      if (job.requestId) byRequestId.set(job.requestId, job.jobId);
      finalize(job, 'exited', { exitCode: null });
      return job;
    }

    job.pid = child.pid;
    running.set(job.jobId, job);
    if (job.requestId) byRequestId.set(job.requestId, job.jobId);

    child.stdout?.on('data', (chunk) => job.stdoutCap.push(chunk));
    child.stderr?.on('data', (chunk) => job.stderrCap.push(chunk));
    child.stdout?.on('error', () => {});
    child.stderr?.on('error', () => {});

    // stdin: a tool call receives its arguments as JSON; a terminal command
    // gets an empty, closed stdin so it never blocks on a read.
    if (child.stdin) {
      child.stdin.on('error', () => {});
      if (typeof spec.stdin === 'string') child.stdin.end(spec.stdin);
      else child.stdin.end();
    }

    const pid = child.pid;
    child.on('error', () => finalize(job, job.timedOut ? 'timed_out' : job.cancelRequested ? 'cancelled' : 'exited', { exitCode: null }));
    child.on('exit', (code, signal) => {
      const state = job.timedOut ? 'timed_out' : job.cancelRequested ? 'cancelled' : 'exited';
      finalize(job, state, { exitCode: typeof code === 'number' ? code : null, signal: signal ?? null });
    });

    if (typeof pid === 'number') {
      job.timeoutTimer = timers.set(() => {
        if (job.state !== 'running') return;
        job.timedOut = true;
        killGroup(pid, 'SIGTERM');
        job.killTimer = timers.set(() => killGroup(pid, 'SIGKILL'), sigkillDelayMs);
      }, spec.timeoutSeconds * 1000);
    }

    return job;
  }

  /** Wait at most `waitMs` for a job to end, then return its current state. */
  async function waitAndReturn(job) {
    if (job.state === 'running') {
      let timer;
      const deadline = new Promise((res) => { timer = timers.set(res, waitMs); });
      try {
        await Promise.race([job.donePromise, deadline]);
      } finally {
        timers.clear(timer);
      }
    }
    return { ok: true, job: serialize(job) };
  }

  function lookup(jobId) {
    return running.get(jobId) ?? finished.get(jobId) ?? null;
  }

  function dedupeHit(requestId) {
    if (!requestId) return null;
    const jobId = byRequestId.get(requestId);
    if (!jobId) return null;
    return lookup(jobId);
  }

  return {
    /** op `call`: run a self-built tool. The server adds `catalogDigest`. */
    async call({ name, arguments: args, requestId }) {
      const scan = getScan();
      const existing = dedupeHit(requestId);
      if (existing) return waitAndReturn(existing);
      const entry = scan.byName.get(name);
      if (!entry) return { ok: false, error: 'tool_not_found' };
      if (running.size >= maxRunning) return { ok: false, error: 'terminal_jobs_busy' };
      const job = start({
        kind: 'tool',
        name,
        requestId,
        argv: entry.argv,
        cwd: entry.dir,
        timeoutSeconds: entry.timeoutSeconds,
        background: false,
        env: { ...JOB_BASE_ENV, EZIL_TOOL_DIR: entry.dir },
        stdin: JSON.stringify(args ?? {}),
      });
      return waitAndReturn(job);
    },

    /** op `exec`: run a terminal command as `/bin/bash --noprofile --norc -c`. */
    async exec({ command, cwd, timeoutSeconds, background, requestId }) {
      const existing = dedupeHit(requestId);
      if (existing) return waitAndReturn(existing);
      const resolvedCwd = resolveCwd(workspaceRoot, cwd);
      if (resolvedCwd === null) return { ok: false, error: 'tools_invalid_request' };
      if (running.size >= maxRunning) return { ok: false, error: 'terminal_jobs_busy' };
      const job = start({
        kind: 'terminal',
        name: null,
        requestId,
        argv: ['/bin/bash', '--noprofile', '--norc', '-c', command],
        cwd: resolvedCwd,
        timeoutSeconds,
        background: background === true,
        env: { ...JOB_BASE_ENV },
        stdin: '',
      });
      return waitAndReturn(job);
    },

    /** op `job`: read a job by id. Unknown id → `job_not_found`. */
    job({ jobId }) {
      const job = lookup(jobId);
      if (!job) return { ok: false, error: 'job_not_found' };
      return { ok: true, job: serialize(job) };
    },

    /** op `cancel`: signal a running job's group; an ended job is unchanged. */
    async cancel({ jobId }) {
      const job = lookup(jobId);
      if (!job) return { ok: false, error: 'job_not_found' };
      if (job.state === 'running' && typeof job.pid === 'number') {
        job.cancelRequested = true;
        killGroup(job.pid, 'SIGTERM');
        if (job.killTimer) timers.clear(job.killTimer);
        job.killTimer = timers.set(() => killGroup(job.pid, 'SIGKILL'), sigkillDelayMs);
        return waitAndReturn(job);
      }
      return { ok: true, job: serialize(job) };
    },

    // Test/inspection seams.
    _runningCount: () => running.size,
    _finishedCount: () => finished.size,
    _serialize: serialize,
  };
}

/**
 * Resolve a terminal `cwd`: relative to the workspace root, realpath must land
 * inside (or at) the workspace root. `null` → refuse (`tools_invalid_request`).
 * An absent cwd is the workspace root itself.
 */
export function resolveCwd(workspaceRoot, cwd) {
  let rootReal;
  try {
    rootReal = realpathSync(workspaceRoot);
  } catch {
    return null;
  }
  if (cwd === undefined || cwd === null || cwd === '') return rootReal;
  if (typeof cwd !== 'string' || cwd.length > 512 || cwd.startsWith('/')) return null;
  // No `..` segment (format guard; realpath containment is the real check).
  if (cwd.split('/').includes('..')) return null;
  let resolved;
  try {
    resolved = realpathSync(resolve(rootReal, cwd));
  } catch {
    return null;
  }
  if (resolved === rootReal || resolved.startsWith(rootReal + sep)) return resolved;
  return null;
}

export { StreamCapture, isPlainObject };
