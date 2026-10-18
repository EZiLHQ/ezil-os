/**
 * SIGNAL C (./terminal-keepalive.ts): terminal work holds an idle stop, bounded.
 *
 * 1. The pure parse and verdict are executed directly.
 * 2. The probe command is executed for real, against real tmux and real
 *    pseudo-terminals, inside private PID and mount namespaces (own /proc, own
 *    /tmp) so the host's sessions and terminals are never counted. Skipped
 *    where that is unavailable (non-root CI).
 * 3. The DO wiring is pinned by source text, the convention
 *    `workspace-idle.test.ts` documents: `EzilSandboxDO` cannot be
 *    instantiated under plain `bun test`. `workspace-flush-loop.test.ts`
 *    executes the wired behaviour against the real prototype.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TERMINAL_KEEPALIVE_MAX_MS,
  TERMINAL_WORK_PROBE_COMMAND,
  parseTerminalWork,
  terminalKeepAliveFromProbe,
} from './terminal-keepalive';

const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

function between(startMarker: string, endMarker: string): string {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`start marker not found: ${startMarker}`);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`end marker not found (after start): ${endMarker}`);
  return src.slice(startIdx, endIdx);
}

const MIN = 60_000;
const ok = (stdout: string) => ({ exitCode: 0, stdout });

describe('parseTerminalWork', () => {
  it('reads both counts, including zeros', () => {
    expect(parseTerminalWork('0 0\n')).toEqual({ tmuxSessions: 0, runningTerminalJobs: 0 });
    expect(parseTerminalWork(' 2 3 \n')).toEqual({ tmuxSessions: 2, runningTerminalJobs: 3 });
  });

  it('returns null for anything that is not exactly two plain non-negative integers', () => {
    for (const text of ['', '0', '1 2 3', 'sh: ps: not found', '-1 0', '1e2 0', '0x1 0', '1.5 0', '1  2']) {
      expect(parseTerminalWork(text)).toBeNull();
    }
  });
});

describe('terminalKeepAliveFromProbe', () => {
  it('holds while a tmux session exists and the idle age is under the cap', () => {
    expect(terminalKeepAliveFromProbe({ probe: ok('1 0\n'), idleMs: 11 * MIN })).toEqual({
      keepAlive: true, work: { tmuxSessions: 1, runningTerminalJobs: 0 }, reason: 'live_tmux_sessions',
    });
  });

  it('holds while a terminal runs a foreground job, with no tmux at all', () => {
    expect(terminalKeepAliveFromProbe({ probe: ok('0 1'), idleMs: 11 * MIN })).toEqual({
      keepAlive: true, work: { tmuxSessions: 0, runningTerminalJobs: 1 }, reason: 'running_terminal_jobs',
    });
  });

  it('holds right after a window-close release (presence backdated 30 minutes)', () => {
    expect(terminalKeepAliveFromProbe({ probe: ok('0 2'), idleMs: 30 * MIN }).keepAlive).toBe(true);
  });

  it('ends the hold exactly at the cap (inclusive) and holds one millisecond before it', () => {
    expect(terminalKeepAliveFromProbe({ probe: ok('1 1'), idleMs: TERMINAL_KEEPALIVE_MAX_MS - 1 }).keepAlive).toBe(true);
    expect(terminalKeepAliveFromProbe({ probe: ok('1 1'), idleMs: TERMINAL_KEEPALIVE_MAX_MS })).toEqual({
      keepAlive: false, work: { tmuxSessions: 1, runningTerminalJobs: 1 }, reason: 'terminal_keepalive_expired',
    });
  });

  it('caps the hold at eight hours', () => {
    expect(TERMINAL_KEEPALIVE_MAX_MS).toBe(8 * 60 * MIN);
  });

  it('does not hold with no tmux session and only idle prompts', () => {
    expect(terminalKeepAliveFromProbe({ probe: ok('0 0'), idleMs: 11 * MIN })).toEqual({
      keepAlive: false, work: { tmuxSessions: 0, runningTerminalJobs: 0 }, reason: 'no_terminal_work',
    });
  });

  it('🔴 every way of not knowing is NO hold, the pre-SIGNAL-C stop decision', () => {
    expect(terminalKeepAliveFromProbe({ probe: null, idleMs: 11 * MIN })).toEqual({ keepAlive: false, work: null, reason: 'probe_threw' });
    expect(terminalKeepAliveFromProbe({ probe: { exitCode: 1, stdout: '4 4' }, idleMs: 11 * MIN })).toEqual({
      keepAlive: false, work: null, reason: 'probe_exit_1',
    });
    expect(terminalKeepAliveFromProbe({ probe: ok('garbage'), idleMs: 11 * MIN }).keepAlive).toBe(false);
  });

  it('a NaN idle age never holds', () => {
    expect(terminalKeepAliveFromProbe({ probe: ok('1 1'), idleMs: Number.NaN }).keepAlive).toBe(false);
  });
});

// ── The real probe, in private PID + mount namespaces ───────────────────────

const NAMESPACE = ['--mount', '--pid', '--fork', '--mount-proc', '--propagation', 'private'];

function namespacesAvailable(): boolean {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  const tools = spawnSync('sh', ['-c', 'command -v tmux && command -v unshare && command -v python3 && command -v ps'], { encoding: 'utf8' });
  if (tools.status !== 0) return false;
  const probe = spawnSync('unshare', [...NAMESPACE, 'sh', '-c', 'mount -t tmpfs t /tmp && echo ok'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() === 'ok';
}

/**
 * Opens one real pseudo-terminal per argument, each running an interactive
 * bash (job control on, like a Code terminal). `busy` starts `sleep 60` in the
 * foreground; `idle` leaves the prompt; `background` runs `sleep 60 &`.
 */
const PTY_HELPER = [
  'import os, pty, sys, time',
  'for kind in sys.argv[1:]:',
  '    pid, fd = pty.fork()',
  '    if pid == 0:',
  "        os.execvp('bash', ['bash', '--norc', '--noprofile', '-i'])",
  "    time.sleep(0.3)",
  "    if kind == 'busy': os.write(fd, b'sleep 60\\n')",
  "    if kind == 'background': os.write(fd, b'sleep 60 &\\n')",
  'time.sleep(20)',
].join('\n');

/** Run `setup`, then the exact production probe, with nothing of the host visible. */
function probeInNamespace(setup: string): { status: number | null; stdout: string } {
  const script = `mount -t tmpfs t /tmp && ${setup}\n${TERMINAL_WORK_PROBE_COMMAND}`;
  const res = spawnSync('unshare', [...NAMESPACE, 'sh', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/root', PTY_HELPER },
    timeout: 30_000,
  });
  const lines = res.stdout.trim().split('\n');
  return { status: res.status, stdout: lines[lines.length - 1] ?? '' };
}
const ptys = (...kinds: string[]) => `(python3 -c "$PTY_HELPER" ${kinds.join(' ')} >/dev/null 2>&1 &) && sleep 1.5`;

describe.skipIf(!namespacesAvailable())('TERMINAL_WORK_PROBE_COMMAND against real tmux and terminals', () => {
  it('counts nothing with no tmux server and no terminals', () => {
    expect(probeInNamespace(':')).toEqual({ status: 0, stdout: '0 0' });
  });

  it('counts tmux sessions across the default socket and a -L socket', () => {
    const res = probeInNamespace(
      'tmux -f /dev/null new-session -d -s a "sleep 60" && tmux -f /dev/null new-session -d -s b "sleep 60" && ' +
        'tmux -f /dev/null -L other new-session -d -s c "sleep 60"',
    );
    // Each pane runs `sleep` directly (no shell), so no pane counts as a shell running a job.
    expect(res).toEqual({ status: 0, stdout: '3 0' });
  });

  it('counts 0 tmux sessions for a stale socket whose server is gone', () => {
    const res = probeInNamespace(
      'tmux -f /dev/null new-session -d -s a "sleep 60" && tmux kill-server && sleep 0.2 && ' +
        'mkdir -p /tmp/tmux-0 && python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind(\'/tmp/tmux-0/stale\')"',
    );
    expect(res).toEqual({ status: 0, stdout: '0 0' });
  });

  it('🔴 counts a terminal whose shell runs a foreground job, and only that one', () => {
    expect(probeInNamespace(ptys('busy', 'idle'))).toEqual({ status: 0, stdout: '0 1' });
  });

  it('does not count idle prompts or background jobs', () => {
    expect(probeInNamespace(ptys('idle', 'idle', 'background'))).toEqual({ status: 0, stdout: '0 0' });
  });

  it('counts a job running in a tmux pane shell as terminal work too', () => {
    const res = probeInNamespace('tmux -f /dev/null new-session -d -s a "bash --norc --noprofile -i" && sleep 0.5 && tmux send-keys -t a "sleep 60" Enter && sleep 1');
    expect(res).toEqual({ status: 0, stdout: '1 1' });
  });

  it('reports 0 0 when neither tmux nor ps is on PATH', () => {
    const script = `mount -t tmpfs t /tmp && PATH=/nonexistent; ${TERMINAL_WORK_PROBE_COMMAND.replace(/\| base64 -d \| sh$/, '| /usr/bin/base64 -d | /bin/sh')}`;
    const res = spawnSync('unshare', [...NAMESPACE, '/bin/sh', '-c', script], { encoding: 'utf8' });
    expect(res.stdout.trim()).toBe('0 0');
  });
});

// ── DO wiring ────────────────────────────────────────────────────────────────

describe('runScheduledFlushCycle: SIGNAL C wiring', () => {
  const cycle = between('private async runScheduledFlushCycle(): Promise<void> {', '\n  /**\n   * DO-storage plumbing');

  it('probes only once idle is due, and only after the not-running guard', () => {
    const running = cycle.indexOf('if (!this.containerIsRunning()) {');
    const probe = cycle.indexOf('await this.probeTerminalKeepAlive(now - lastActivityAt)');
    expect(running).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(running);
    expect(cycle).toContain(
      'const terminalHold = isIdleStopDue({ lastActivityAt, now })\n      ? await this.probeTerminalKeepAlive(now - lastActivityAt)\n      : null;',
    );
  });

  it('🔴 a held cycle neither stops nor final-flushes: the idle branch is skipped entirely', () => {
    const held = between('if (terminalHold?.keepAlive) {', '} else if (isIdleStopDue({ lastActivityAt, now })) {');
    expect(held).not.toContain('this.stop()');
    expect(held).not.toContain('runWorkspaceFlush');
    expect(held).not.toContain('return;');
    expect(held).toContain('idle_hold_terminal');
  });

  it('a held cycle falls through to the routine checkpoint and its backoff reschedule', () => {
    const afterHold = cycle.slice(cycle.indexOf('} else if (isIdleStopDue({ lastActivityAt, now })) {'));
    expect(afterHold).toContain("const outcome = await this.runWorkspaceFlush('alarm', { allowDefer: true });");
    expect(afterHold).toContain('await this.schedule(nextIntervalSeconds, WORKSPACE_FLUSH_CALLBACK)');
  });

  it('the stop log records the terminal verdict next to the load figure', () => {
    expect(cycle).toContain("${terminalHold?.detail ?? 'terminalWork=unprobed'}");
  });
});

describe('probeTerminalKeepAlive: the I/O half fails to NO hold', () => {
  const method = between(
    'private async probeTerminalKeepAlive(idleMs: number): Promise<{ keepAlive: boolean; detail: string }> {',
    '\n  /**\n   * Tombstone this sandbox',
  );

  it('starts from null and only overwrites it on a completed exec of the exported command', () => {
    expect(method).toContain('let probe: { exitCode: number; stdout: string } | null = null;');
    expect(method).toContain('await this.exec(TERMINAL_WORK_PROBE_COMMAND');
    expect(method).toContain('terminalKeepAliveFromProbe({ probe, idleMs })');
  });

  it('swallows the exec error (an alarm crash would strand the flush loop)', () => {
    expect(method).toContain('} catch (err) {');
    expect(method).toContain('terminal_probe_failed');
  });
});

describe('runSystemFlush: an oversized system layer waits out the interval (held computers would re-walk it)', () => {
  const sys = between('private async runSystemFlush(', '/** Superseded checkpoint generations');

  it('advances SYSTEM_LAST_FLUSH_AT_KEY on too_large, so routine cycles do not re-walk up to 512 MiB every 10-60 s', () => {
    expect(sys).toContain("|| system.skippedReason === 'too_large') {\n        await this.ctx.storage.put(SYSTEM_LAST_FLUSH_AT_KEY, Date.now());");
  });

  it('final checkpoints still ignore the clock', () => {
    expect(sys).toContain('if (!final && Date.now() - last < SYSTEM_FLUSH_INTERVAL_MS) return undefined;');
  });
});
