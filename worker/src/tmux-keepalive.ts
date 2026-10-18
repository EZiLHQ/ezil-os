/**
 * ── SIGNAL C: live tmux sessions the user left running ──────────────────────
 *
 * `EzilSandboxDO`'s idle stop (./index.ts) has two signals: A, nobody is
 * present (`isIdleStopDue`), and B, the CPU is quiet (`containerBusyFromProbe`).
 * Together they also killed the one thing a user leaves running ON PURPOSE
 * when they go: a tmux session (an agent waiting on the network, a REPL, a log
 * tail). Closing the desktop window backdates presence by 30 minutes
 * (`shell/ezil/session.js#releaseDesktop`), so such a session died on the next
 * alarm (<=60 s); closing the tab killed it after `IDLE_STOP_MS`. Saved-state
 * restore brings back the files and the tmux binary, never the processes.
 *
 * While at least one tmux session exists, an otherwise-due idle stop is held
 * and the routine checkpoint keeps running, for at most
 * {@link TMUX_KEEPALIVE_MAX_MS} after the last presence or open. Past that the
 * ordinary stop applies. tmux, not "any process", because a session is an
 * explicit request to keep something alive; arbitrary leftover processes are
 * what the billing incident in BILLING-BRIEF.md was made of.
 *
 * Fails the OTHER way from SIGNAL B: every way of not knowing (probe threw,
 * non-zero exit, unparseable output, tmux not installed) means NO hold, i.e.
 * exactly the stop decision the Worker made before SIGNAL C existed.
 *
 * Cost of the cap: memory is billed on provisioned size (6 GiB here) and CPU
 * on active use, so a held, quiet computer costs roughly memory + disk for up
 * to 8 hours. A held computer also occupies one of `max_instances` (20).
 */
export const TMUX_KEEPALIVE_MAX_MS = 8 * 60 * 60_000;

/**
 * Counts sessions across every tmux server socket under /tmp (each user's
 * `tmux-<uid>` dir, any `-L` name). Runs in `sh -c` so nothing here can end
 * the SDK's shared session shell. A missing tmux binary or a stale socket
 * counts 0; `timeout` bounds a hung server.
 */
export const TMUX_SESSIONS_PROBE_COMMAND =
  `sh -c 'n=0; if command -v tmux >/dev/null 2>&1; then for s in /tmp/tmux-*/*; do ` +
  `[ -S "$s" ] || continue; c=$(timeout 5 tmux -S "$s" list-sessions -F x 2>/dev/null | wc -l); ` +
  `n=$((n + c)); done; fi; echo "$n"'`;

/** Pure parse of the probe's single number. `null` for anything else. */
export function parseTmuxSessionCount(stdout: string): number | null {
  const text = String(stdout ?? '').trim();
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

/** Turn the tmux probe plus the idle age into a hold verdict. */
export function tmuxKeepAliveFromProbe(params: {
  probe: { exitCode: number; stdout: string } | null;
  idleMs: number;
}): { keepAlive: boolean; sessions: number | null; reason: string } {
  const { probe, idleMs } = params;
  if (probe === null) return { keepAlive: false, sessions: null, reason: 'probe_threw' };
  if (probe.exitCode !== 0) return { keepAlive: false, sessions: null, reason: `probe_exit_${probe.exitCode}` };
  const sessions = parseTmuxSessionCount(probe.stdout);
  if (sessions === null) return { keepAlive: false, sessions: null, reason: 'unparseable' };
  if (sessions === 0) return { keepAlive: false, sessions, reason: 'no_tmux_sessions' };
  if (!(idleMs < TMUX_KEEPALIVE_MAX_MS)) return { keepAlive: false, sessions, reason: 'tmux_keepalive_expired' };
  return { keepAlive: true, sessions, reason: 'live_tmux_sessions' };
}
