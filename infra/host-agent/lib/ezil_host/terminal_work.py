"""SIGNAL C on AWS: terminal work in the desktop container holds an idle stop.

worker/src/terminal-keepalive.ts is the spec. Terminal work and active Code inference
hold the stop for at most 8 hours after presence. Unknown means no hold. Keep SCRIPT
verbatim.
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
])


def parse(stdout):
    """Read two or three ASCII counts, matching JS Number.isSafeInteger."""
    match = re.fullmatch(r"([0-9]+) ([0-9]+)(?: ([0-9]+))?", str(stdout or "").strip())
    if not match:
        return None
    counts = tuple(value.lstrip("0") or "0" for value in match.groups() if value is not None)
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
    if not any(work):
        return False, work, "no_terminal_work"
    if not (idle_seconds < TERMINAL_KEEPALIVE_MAX_SECONDS):
        return False, work, "terminal_keepalive_expired"
    if len(work) == 3 and work[2] > 0:
        return True, work, "active_code_inference"
    return True, work, "live_tmux_sessions" if work[0] > 0 else "running_terminal_jobs"


def probe(cfg):
    """Probe through runc exec, inheriting the desktop's confinement; unknown = no hold."""
    try:
        result = desktop.exec_(cfg, ["/bin/sh", "-c", SCRIPT], capture_output=True, text=True,
                               stdin=subprocess.DEVNULL, timeout=PROBE_TIMEOUT_SECONDS)
        return result.returncode, result.stdout
    except Exception:  # noqa: BLE001 — every way of not knowing means no hold
        return None
