/**
 * SIGNAL C (./tmux-keepalive.ts): live tmux sessions hold an idle stop, bounded.
 *
 * 1. The pure parse and verdict are executed directly.
 * 2. The probe command is executed for real against `tmux` in a private
 *    mount namespace with its own /tmp, so the host's sessions are never
 *    counted (skipped where that is unavailable, e.g. non-root CI).
 * 3. The DO wiring is pinned by source text, the convention
 *    `workspace-idle.test.ts` documents: `EzilSandboxDO` cannot be
 *    instantiated under plain `bun test`.
 */

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  TMUX_KEEPALIVE_MAX_MS,
  TMUX_SESSIONS_PROBE_COMMAND,
  parseTmuxSessionCount,
  tmuxKeepAliveFromProbe,
} from './tmux-keepalive';

const src = readFileSync(fileURLToPath(new URL('./index.ts', import.meta.url)), 'utf8').replace(/\r\n/g, '\n');

function between(startMarker: string, endMarker: string): string {
  const startIdx = src.indexOf(startMarker);
  if (startIdx === -1) throw new Error(`start marker not found: ${startMarker}`);
  const endIdx = src.indexOf(endMarker, startIdx + startMarker.length);
  if (endIdx === -1) throw new Error(`end marker not found (after start): ${endMarker}`);
  return src.slice(startIdx, endIdx);
}

const MIN = 60_000;

describe('parseTmuxSessionCount', () => {
  it('reads the count the probe echoes, including zero', () => {
    expect(parseTmuxSessionCount('0\n')).toBe(0);
    expect(parseTmuxSessionCount(' 3 \n')).toBe(3);
  });

  it('returns null for anything that is not one plain non-negative integer', () => {
    for (const text of ['', 'sh: tmux: not found', '-1', '1e2', '0x1', '2 3', '1.5']) {
      expect(parseTmuxSessionCount(text)).toBeNull();
    }
  });
});

describe('tmuxKeepAliveFromProbe', () => {
  const ok = (stdout: string) => ({ exitCode: 0, stdout });

  it('holds while a session exists and the idle age is under the cap', () => {
    const verdict = tmuxKeepAliveFromProbe({ probe: ok('1\n'), idleMs: 11 * MIN });
    expect(verdict).toEqual({ keepAlive: true, sessions: 1, reason: 'live_tmux_sessions' });
  });

  it('holds right after a window-close release (presence backdated 30 minutes)', () => {
    expect(tmuxKeepAliveFromProbe({ probe: ok('2'), idleMs: 30 * MIN }).keepAlive).toBe(true);
  });

  it('ends the hold exactly at the cap (inclusive) and holds one millisecond before it', () => {
    expect(tmuxKeepAliveFromProbe({ probe: ok('1'), idleMs: TMUX_KEEPALIVE_MAX_MS - 1 }).keepAlive).toBe(true);
    const expired = tmuxKeepAliveFromProbe({ probe: ok('1'), idleMs: TMUX_KEEPALIVE_MAX_MS });
    expect(expired).toEqual({ keepAlive: false, sessions: 1, reason: 'tmux_keepalive_expired' });
  });

  it('caps the hold at eight hours', () => {
    expect(TMUX_KEEPALIVE_MAX_MS).toBe(8 * 60 * MIN);
  });

  it('does not hold with zero sessions (tmux absent prints 0)', () => {
    expect(tmuxKeepAliveFromProbe({ probe: ok('0'), idleMs: 11 * MIN })).toEqual({
      keepAlive: false, sessions: 0, reason: 'no_tmux_sessions',
    });
  });

  it('🔴 every way of not knowing is NO hold, the pre-SIGNAL-C stop decision', () => {
    expect(tmuxKeepAliveFromProbe({ probe: null, idleMs: 11 * MIN })).toEqual({
      keepAlive: false, sessions: null, reason: 'probe_threw',
    });
    expect(tmuxKeepAliveFromProbe({ probe: { exitCode: 1, stdout: '4' }, idleMs: 11 * MIN })).toEqual({
      keepAlive: false, sessions: null, reason: 'probe_exit_1',
    });
    expect(tmuxKeepAliveFromProbe({ probe: ok('garbage'), idleMs: 11 * MIN }).keepAlive).toBe(false);
  });

  it('a NaN idle age never holds', () => {
    expect(tmuxKeepAliveFromProbe({ probe: ok('1'), idleMs: Number.NaN }).keepAlive).toBe(false);
  });
});

// ── The real probe command, against real tmux, in a private /tmp ─────────────

function privateTmpAvailable(): boolean {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  const tmux = spawnSync('sh', ['-c', 'command -v tmux && command -v unshare'], { encoding: 'utf8' });
  if (tmux.status !== 0) return false;
  const probe = spawnSync('unshare', ['--mount', '--propagation', 'private', 'sh', '-c', 'mount -t tmpfs t /tmp && echo ok'], {
    encoding: 'utf8',
  });
  return probe.status === 0 && probe.stdout.trim() === 'ok';
}

/** Run `setup`, then the exact production probe, inside a fresh mount namespace with an empty /tmp. */
function probeInPrivateTmp(setup: string): { status: number | null; stdout: string } {
  const script = `mount -t tmpfs t /tmp && ${setup}\n${TMUX_SESSIONS_PROBE_COMMAND}\ntmux kill-server >/dev/null 2>&1; tmux -L other kill-server >/dev/null 2>&1; true`;
  const res = spawnSync('unshare', ['--mount', '--propagation', 'private', 'sh', '-c', script], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/root' },
    timeout: 30_000,
  });
  const lines = res.stdout.trim().split('\n');
  return { status: res.status, stdout: lines[lines.length - 1] ?? '' };
}

describe.skipIf(!privateTmpAvailable())('TMUX_SESSIONS_PROBE_COMMAND against real tmux', () => {
  it('counts 0 with no tmux server', () => {
    expect(probeInPrivateTmp(':')).toEqual({ status: 0, stdout: '0' });
  });

  it('counts sessions across the default socket and a -L socket', () => {
    const res = probeInPrivateTmp(
      'tmux -f /dev/null new-session -d -s a "sleep 60" && tmux -f /dev/null new-session -d -s b "sleep 60" && ' +
        'tmux -f /dev/null -L other new-session -d -s c "sleep 60"',
    );
    expect(res).toEqual({ status: 0, stdout: '3' });
  });

  it('counts 0 for a stale socket whose server is gone', () => {
    const res = probeInPrivateTmp(
      'tmux -f /dev/null new-session -d -s a "sleep 60" && tmux kill-server && sleep 0.2 && ' +
        'mkdir -p /tmp/tmux-0 && python3 -c "import socket;s=socket.socket(socket.AF_UNIX);s.bind(\'/tmp/tmux-0/stale\')"',
    );
    expect(res).toEqual({ status: 0, stdout: '0' });
  });

  it('counts 0 when tmux is not on PATH', () => {
    const script = `mount -t tmpfs t /tmp && PATH=/nonexistent; ${TMUX_SESSIONS_PROBE_COMMAND.replace(/^sh /, '/bin/sh ')}`;
    const res = spawnSync('unshare', ['--mount', '--propagation', 'private', '/bin/sh', '-c', script], { encoding: 'utf8' });
    // `command -v tmux` fails, so the loop never runs; `echo` is a shell builtin.
    expect(res.stdout.trim()).toBe('0');
  });
});

// ── DO wiring ────────────────────────────────────────────────────────────────

describe('runScheduledFlushCycle: SIGNAL C wiring', () => {
  const cycle = between('private async runScheduledFlushCycle(): Promise<void> {', '\n  /**\n   * DO-storage plumbing');

  it('probes tmux only once idle is due, and only after the not-running guard', () => {
    const running = cycle.indexOf('if (!this.containerIsRunning()) {');
    const probe = cycle.indexOf('await this.probeTmuxKeepAlive(now - lastActivityAt)');
    expect(running).toBeGreaterThan(-1);
    expect(probe).toBeGreaterThan(running);
    expect(cycle).toContain(
      'const tmuxHold = isIdleStopDue({ lastActivityAt, now })\n      ? await this.probeTmuxKeepAlive(now - lastActivityAt)\n      : null;',
    );
  });

  it('🔴 a held cycle neither stops nor final-flushes: the idle branch is skipped entirely', () => {
    const held = between('if (tmuxHold?.keepAlive) {', '} else if (isIdleStopDue({ lastActivityAt, now })) {');
    expect(held).not.toContain('this.stop()');
    expect(held).not.toContain('runWorkspaceFlush');
    expect(held).not.toContain('return;');
    expect(held).toContain('idle_hold_tmux');
  });

  it('a held cycle falls through to the routine checkpoint and its backoff reschedule', () => {
    const afterHold = cycle.slice(cycle.indexOf('} else if (isIdleStopDue({ lastActivityAt, now })) {'));
    expect(afterHold).toContain("const outcome = await this.runWorkspaceFlush('alarm', { allowDefer: true });");
    expect(afterHold).toContain('await this.schedule(nextIntervalSeconds, WORKSPACE_FLUSH_CALLBACK)');
  });

  it('the stop log records the tmux verdict next to the load figure', () => {
    expect(cycle).toContain("${tmuxHold?.detail ?? 'tmuxSessions=unprobed'}");
  });
});

describe('probeTmuxKeepAlive: the I/O half fails to NO hold', () => {
  const method = between(
    'private async probeTmuxKeepAlive(idleMs: number): Promise<{ keepAlive: boolean; detail: string }> {',
    '\n  /**\n   * Tombstone this sandbox',
  );

  it('starts from null and only overwrites it on a completed exec of the exported command', () => {
    expect(method).toContain('let probe: { exitCode: number; stdout: string } | null = null;');
    expect(method).toContain('await this.exec(TMUX_SESSIONS_PROBE_COMMAND');
    expect(method).toContain('tmuxKeepAliveFromProbe({ probe, idleMs })');
  });

  it('swallows the exec error (an alarm crash would strand the flush loop)', () => {
    expect(method).toContain('} catch (err) {');
    expect(method).toContain('tmux_probe_failed');
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
