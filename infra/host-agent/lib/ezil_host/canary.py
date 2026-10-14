"""Opt-in public serial diagnostics. Never serialize a lease, config or exception."""
import hashlib
import json
import os
import stat
import subprocess
import time

from .fsops import DIR_FLAGS, Refused, open_dir_below, read_regular_at

CONSOLE = "/dev/ttyS0"     # EC2 Linux first serial port; independent of /dev/console routing
PREFIX = "EZIL-CANARY "
SENTINEL = ".ezil-canary-sentinel"
HISTORY_MARKER = b": EZIL-CANARY-HISTORY-v1"
SENTINEL_LIMIT = 65536
HISTORY_LIMIT = 4 * 1024 * 1024


def enabled(cfg):
    return cfg.get("canaryConsole") is True


def _integer(value):
    return value if type(value) is int and 0 <= value <= (1 << 63) - 1 else None


def _choice(value, choices, fallback="unknown"):
    return value if type(value) is str and value in choices else fallback


def _write_console(line):
    """One bounded, nonblocking write; no stdout/journal fallback and no file creation."""
    fd = os.open(CONSOLE, os.O_WRONLY | os.O_NONBLOCK | os.O_NOCTTY | os.O_CLOEXEC | os.O_NOFOLLOW)
    try:
        if stat.S_ISCHR(os.fstat(fd).st_mode):
            os.write(fd, line)
    finally:
        os.close(fd)


def _emit(cfg, event, fields):
    # Only the explicit projections below call this private serializer.
    if not enabled(cfg):
        return
    line = (PREFIX + json.dumps({"v": 1, "event": event, **fields},
                               separators=(",", ":"), ensure_ascii=True) + "\n").encode("ascii")
    if len(line) > 512:
        return
    try:
        _write_console(line)
    except OSError:
        pass                            # diagnostics must not block boot or shutdown


def _read_file(parent, name, limit):
    try:
        st = os.stat(name, dir_fd=parent, follow_symlinks=False)
        if not stat.S_ISREG(st.st_mode) or st.st_size > limit:
            return "unreadable", None
        raw = read_regular_at(parent, name, st, limit=limit)
        return ("ok", raw) if raw is not None else ("unreadable", None)
    except FileNotFoundError:
        return "missing", None
    except OSError:
        return "unreadable", None


def _read_json(parent, name):
    status, raw = _read_file(parent, name, 65536)
    if status == "missing":
        return None
    try:
        value = json.loads(raw) if raw is not None else {}
        return value if isinstance(value, dict) else {}
    except (ValueError, RecursionError):
        return {}


def guard_result(cfg, verdict):
    if not enabled(cfg):
        return
    base = verdict.partition(" ")[0] if type(verdict) is str else ""
    result = _choice(base, ("init", "ok", "reboot", "rebase_needed", "refused", "error"))
    marker, previous = {}, None
    # On refusal the guard has unmounted: do not mistake host-root files for volume data.
    if result in ("init", "ok", "reboot", "rebase_needed"):
        try:
            root = os.open(cfg.dataMount, DIR_FLAGS)
            try:
                marker = _read_json(root, ".ezil-marker.json") or {}
                previous = _read_json(root, ".ezil-last-stop.json")
            finally:
                os.close(root)
        except OSError:
            pass
    last_stop = None
    if previous is not None:
        last_stop = {"outcome": _choice(previous.get("outcome"), ("absent", "clean", "killed"), "unreadable")}
        for key in ("at", "generation", "leaseEpoch"):
            last_stop[key] = _integer(previous.get(key))
    _emit(cfg, "guard", {"result": result, "generation": _integer(marker.get("generation")),
                         "leaseEpoch": _integer(marker.get("leaseEpoch")), "lastStop": last_stop})


def probe(cfg, phase):
    if not enabled(cfg):
        return
    sentinel_status = history_status = "unreadable"
    sentinel = history = None
    try:
        # build_spec fixes the user HOME to /root. Never read the host HOME or OCI env.
        home = open_dir_below(os.path.join(cfg.runDir, "rootfs"), "root")
        try:
            sentinel_status, sentinel = _read_file(home, SENTINEL, SENTINEL_LIMIT)
            history_status, history = _read_file(home, ".bash_history", HISTORY_LIMIT)
        finally:
            os.close(home)
    except (OSError, Refused):
        pass
    lines = history.split(b"\n") if history is not None else None
    count = None if lines is None else len(lines) - int(history.endswith(b"\n") or not history)
    _emit(cfg, "persistence", {
        "phase": _choice(phase, ("boot", "shutdown")),
        "sentinel": sentinel_status,
        "sentinelSha256": hashlib.sha256(sentinel).hexdigest() if sentinel is not None else None,
        "history": history_status, "historyLines": count,
        "historyMarker": HISTORY_MARKER in lines if lines is not None else None,
    })


def desktop_started(cfg, wait_seconds=10):
    """Observe runc running, including the foreground exec path via ExecStartPost."""
    if not enabled(cfg):
        return
    from . import desktop
    deadline = time.monotonic() + wait_seconds
    result = "unconfirmed"
    while True:
        try:
            proc = desktop.runc(cfg, "state", cfg.containerId, capture_output=True, text=True, timeout=1)
            state = json.loads(proc.stdout) if proc.returncode == 0 else {}
            if isinstance(state, dict) and state.get("status") == "running":
                result = "started"
                break
        except (OSError, ValueError, RecursionError, subprocess.SubprocessError):
            pass
        if time.monotonic() >= deadline:
            break
        time.sleep(0.1)
    _emit(cfg, "desktop", {"result": result})


def stopped(cfg, outcome, source="desktop", quiesce_ok=None):
    if not enabled(cfg):
        return
    _emit(cfg, "stop", {
        "source": _choice(source, ("desktop", "agent")),
        "outcome": _choice(outcome, ("absent", "clean", "killed", "error")),
        "quiesceOk": quiesce_ok if type(quiesce_ok) is bool else None,
    })
