"""SIGNAL C on AWS: terminal work in the desktop container holds an idle stop.

worker/src/terminal-keepalive.ts is the spec: any tmux session or terminal foreground
job holds the stop for at most 8 hours after presence. Unknown means no hold, so a
failed probe leaves the ordinary idle predicate in charge. Keep SCRIPT verbatim.
"""
import re
import subprocess

from . import desktop

TERMINAL_KEEPALIVE_MAX_SECONDS = 8 * 60 * 60
PROBE_TIMEOUT_SECONDS = 30

SCRIPT = "\n".join([
    't=0',
    'if command -v tmux >/dev/null 2>&1; then',
    '  for s in /tmp/tmux-*/*; do',
    '    [ -S "$s" ] || continue',
    '    c=$(timeout 5 tmux -S "$s" list-sessions -F x 2>/dev/null | wc -l)',
    '    t=$((t + c))',
    '  done',
    'fi',
    "j=$(ps -e -o pid=,sid=,pgid=,tpgid=,tty= 2>/dev/null | awk '$1 == $2 && $5 ~ /^pts\\// && $4 > 0 && $4 != $3 { n++ } END { print n + 0 }')",
    'echo "$t ${j:-0}"',
    '',
])


def parse(stdout):
    """The probe's two ASCII counts, or None; match JS Number.isSafeInteger."""
    match = re.fullmatch(r"([0-9]+) ([0-9]+)", str(stdout or "").strip())
    if not match:
        return None
    counts = tuple(value.lstrip("0") or "0" for value in match.groups())
    # Bound before int() so long counts cannot hit Python's integer conversion limit.
    if any(len(value) > 16 for value in counts):
        return None
    work = tuple(int(value) for value in counts)
    return None if any(value > 2**53 - 1 for value in work) else work


def verdict(probe, idle_seconds):
    """Turn a probe and idle age into (keep_alive, work, reason), as in the Worker."""
    if probe is None:
        return False, None, "probe_threw"
    rc, stdout = probe
    if rc != 0:
        return False, None, f"probe_exit_{rc}"
    work = parse(stdout)
    if work is None:
        return False, None, "unparseable"
    if work == (0, 0):
        return False, work, "no_terminal_work"
    if not (idle_seconds < TERMINAL_KEEPALIVE_MAX_SECONDS):
        return False, work, "terminal_keepalive_expired"
    return True, work, "live_tmux_sessions" if work[0] > 0 else "running_terminal_jobs"


def probe(cfg):
    """Probe through runc exec, inheriting the desktop's confinement; unknown = no hold."""
    try:
        result = desktop.exec_(cfg, ["/bin/sh", "-c", SCRIPT], capture_output=True, text=True,
                               stdin=subprocess.DEVNULL, timeout=PROBE_TIMEOUT_SECONDS)
        return result.returncode, result.stdout
    except Exception:  # noqa: BLE001 — every way of not knowing means no hold
        return None
