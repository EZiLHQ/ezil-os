/**
 * ── SIGNAL C: terminal work the user left running ───────────────────────────
 *
 * `EzilSandboxDO`'s idle stop (./index.ts) has two signals: A, nobody is
 * present (`isIdleStopDue`), and B, the CPU is quiet (`containerBusyFromProbe`).
 * Together they also killed the work a user leaves running ON PURPOSE when
 * they go: an agent, a dev server or a long command waiting on the network.
 * Closing the desktop window backdates presence by 30 minutes
 * (`shell/ezil/session.js#releaseDesktop`), so that work died on the next
 * alarm (<=60 s); closing the tab killed it after `IDLE_STOP_MS`. Saved-state
 * restore brings back files and installed tools, never processes.
 *
 * Terminal work and active Code inference hold an otherwise-due idle stop, and the routine
 * checkpoint keeps running meanwhile, for at most
 * {@link TERMINAL_KEEPALIVE_MAX_MS} after the last presence or open:
 *   - any tmux session (an explicit request to keep something alive), and
 *   - any terminal (a Code terminal, a tmux pane, a desktop terminal) whose
 *     shell has a foreground job running. An idle prompt does not count, and
 *     neither do background jobs or processes with no terminal, which is what
 *     the billing incident in BILLING-BRIEF.md was made of, and
 *   - a live Code extension host's recently refreshed inference marker.
 * Past the cap the ordinary stop applies.
 *
 * Fails the OTHER way from SIGNAL B: every way of not knowing (probe threw,
 * non-zero exit, unparseable output, tmux or ps missing) means NO hold, i.e.
 * exactly the stop decision the Worker made before SIGNAL C existed.
 *
 * Cost of the cap: memory is billed on provisioned size (6 GiB here) and CPU
 * on active use, so a held, quiet computer costs roughly memory + disk for up
 * to 8 hours. A held computer also occupies one of `max_instances` (20).
 */
export const TERMINAL_KEEPALIVE_MAX_MS = 8 * 60 * 60_000;

/**
 * Prints `<tmux sessions> <terminals with a foreground job> <active Code inferences>`.
 *
 * tmux: sessions across every server socket under /tmp (each user's
 * `tmux-<uid>` dir, any `-L` name); a missing binary or a stale socket counts
 * 0, and `timeout` bounds a hung server.
 *
 * Terminal jobs: a pseudo-terminal's session leader is its shell. When the
 * shell runs a command in the foreground, the terminal's foreground process
 * group (`tpgid`) is that command's group, not the shell's own (`pgid`); at an
 * idle prompt they are equal. Processes without a terminal (the SDK's own
 * session shells, this probe, the desktop stack) have tty `?` and never count.
 *
 * Inference markers are inspected by name, metadata, and PID liveness. The
 * fixed directory and entries must not be symlinks. The scan never reads marker
 * contents and visits at most 256 entries, including invalid entries.
 *
 * Shipped base64-encoded and piped to `sh`, so no quoting can break it and
 * nothing in it can end the SDK's shared session shell.
 */
export const TERMINAL_WORK_SCRIPT = [
  't=0',
  'if command -v tmux >/dev/null 2>&1; then',
  '  for s in /tmp/tmux-*/*; do',
  '    [ -S "$s" ] || continue',
  '    c=$(timeout 5 tmux -S "$s" list-sessions -F x 2>/dev/null | wc -l)',
  '    t=$((t + c))',
  '  done',
  'fi',
  "j=$(ps -e -o pid=,sid=,pgid=,tpgid=,tty= 2>/dev/null | awk '$1 == $2 && $5 ~ /^pts\\// && $4 > 0 && $4 != $3 { n++ } END { print n + 0 }')",
  'a=$(python3 -I -S - 2>/dev/null <<\'EZIL_CODE_INFERENCE\'',
  'import itertools, os, re, stat, time',
  'count = 0',
  'try:',
  '    fd = os.open("/tmp/ezil-code-ai-activity", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)',
  'except OSError:',
  '    fd = None',
  'if fd is not None:',
  '    try:',
  '        directory = os.fstat(fd)',
  '        if stat.S_IMODE(directory.st_mode) != 0o700:',
  '            raise SystemExit(0)',
  '        now = time.time_ns()',
  '        with os.scandir(fd) as entries:',
  '            for entry in itertools.islice(entries, 256):',
  '                marker = re.fullmatch(r"([1-9][0-9]{0,6})-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}", entry.name)',
  '                if marker is None:',
  '                    continue',
  '                try:',
  '                    info = entry.stat(follow_symlinks=False)',
  '                    if (stat.S_ISREG(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o600',
  '                            and info.st_uid == directory.st_uid and info.st_nlink == 1',
  '                            and 0 <= now - info.st_mtime_ns <= 60_000_000_000):',
  '                        os.kill(int(marker[1]), 0)',
  '                        count += 1',
  '                except OSError:',
  '                    continue',
  '    finally:',
  '        os.close(fd)',
  'print(count)',
  'EZIL_CODE_INFERENCE',
  ')',
  'echo "$t ${j:-0} ${a:-0}"',
  '',
].join('\n');

export const TERMINAL_WORK_PROBE_COMMAND =
  `printf %s ${btoa(TERMINAL_WORK_SCRIPT)} | base64 -d | sh`;

export interface TerminalWork {
  tmuxSessions: number;
  runningTerminalJobs: number;
  activeCodeInferences?: number;
}

/** Parse known counts, including the legacy format without the inference count. */
export function parseTerminalWork(stdout: string): TerminalWork | null {
  const match = /^(\d+) (\d+)(?: (\d+))?$/.exec(String(stdout ?? '').trim());
  if (!match) return null;
  const tmuxSessions = Number(match[1]);
  const runningTerminalJobs = Number(match[2]);
  if (!Number.isSafeInteger(tmuxSessions) || !Number.isSafeInteger(runningTerminalJobs)) return null;
  if (match[3] === undefined) return { tmuxSessions, runningTerminalJobs };
  const activeCodeInferences = Number(match[3]);
  if (!Number.isSafeInteger(activeCodeInferences)) return null;
  return { tmuxSessions, runningTerminalJobs, activeCodeInferences };
}

/** Turn the probe plus the idle age into a hold verdict. */
export function terminalKeepAliveFromProbe(params: {
  probe: { exitCode: number; stdout: string } | null;
  idleMs: number;
}): { keepAlive: boolean; work: TerminalWork | null; reason: string } {
  const { probe, idleMs } = params;
  if (probe === null) return { keepAlive: false, work: null, reason: 'probe_threw' };
  if (probe.exitCode !== 0) return { keepAlive: false, work: null, reason: `probe_exit_${probe.exitCode}` };
  const work = parseTerminalWork(probe.stdout);
  if (work === null) return { keepAlive: false, work: null, reason: 'unparseable' };
  const codeInference = (work.activeCodeInferences ?? 0) > 0;
  if (work.tmuxSessions === 0 && work.runningTerminalJobs === 0 && !codeInference) return { keepAlive: false, work, reason: 'no_terminal_work' };
  if (!(idleMs < TERMINAL_KEEPALIVE_MAX_MS)) return { keepAlive: false, work, reason: 'terminal_keepalive_expired' };
  if (codeInference) return { keepAlive: true, work, reason: 'active_code_inference' };
  return { keepAlive: true, work, reason: work.tmuxSessions > 0 ? 'live_tmux_sessions' : 'running_terminal_jobs' };
}
