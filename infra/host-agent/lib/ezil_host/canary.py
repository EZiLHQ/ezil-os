"""Opt-in public serial diagnostics. Never serialize a lease, config or exception."""
import hashlib
import json
import os
import re
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
TOOL = "ezil-canary-tool"
TOOL_NAME = re.compile(r"[a-z0-9][a-z0-9._-]{0,63}")   # an npm bin name; never a path
VERSION = re.compile(r"[0-9A-Za-z.+-]{1,32}")
PACKAGE_LIMIT = 65536
PACKAGE_DEPTH_LIMIT = 64
MAX_TOOLS = 4


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


def _tool_path(rootfs, target):
    """Resolve one npm-style link, checking even directories cancelled by '..'."""
    if target.startswith("/") or target.split("/")[-1] in ("", ".", ".."):
        raise Refused("bad_tool_target")
    parts = ["usr", "local", "bin"]
    base = ["usr", "local", "lib", "node_modules"]
    entered = False
    for comp in target.split("/"):
        if comp in ("", "."):
            continue
        if comp == "..":
            # The initial ../lib is normal for npm; once inside node_modules, stay there.
            if len(parts) <= (len(base) if entered else 2):
                raise Refused("tool_target_escape")
            fd = open_dir_below(rootfs, "/".join(parts))
            os.close(fd)
            parts.pop()
        else:
            parts.append(comp)
        entered = entered or parts == base
    if parts[:len(base)] != base or len(parts) <= len(base):
        raise Refused("tool_target_escape")
    return parts


def _inspect_tool(rootfs, name, hash_limit):
    """(status, sha256, size, package dir parts) for /usr/local/bin/<name>, an npm-style link.

    status: absent | ok | large (a regular file over hash_limit: size only, never read) |
    unreadable | refused. The package dir is node_modules/<pkg> or node_modules/@scope/<pkg>."""
    found = False
    try:
        parent = open_dir_below(rootfs, "usr/local/bin")
        try:
            st = os.stat(name, dir_fd=parent, follow_symlinks=False)
            found = True
            if not stat.S_ISLNK(st.st_mode):
                return "refused", None, None, None
            target = os.readlink(name, dir_fd=parent)
        finally:
            os.close(parent)
        parts = _tool_path(rootfs, target)
        parent = open_dir_below(rootfs, "/".join(parts[:-1]))
        try:
            st = os.stat(parts[-1], dir_fd=parent, follow_symlinks=False)
            if stat.S_ISLNK(st.st_mode):
                return "refused", None, None, None
            if not stat.S_ISREG(st.st_mode):
                return "unreadable", None, None, None
            package = parts[:6] if parts[4].startswith("@") else parts[:5]
            if st.st_size > hash_limit:
                return "large", None, st.st_size, package
            raw = read_regular_at(parent, parts[-1], st, limit=hash_limit)
            if raw is None:
                return "unreadable", None, None, None
            return "ok", hashlib.sha256(raw).hexdigest(), st.st_size, package
        finally:
            os.close(parent)
    except FileNotFoundError:
        return ("unreadable" if found else "absent"), None, None, None
    except Refused as error:
        if isinstance(error.__cause__, FileNotFoundError):
            return ("unreadable" if found else "absent"), None, None, None
        if isinstance(error.__cause__, PermissionError):
            return "unreadable", None, None, None
        return "refused", None, None, None
    except OSError:
        return "unreadable", None, None, None


def _read_tool(rootfs):
    """The synthetic sentinel: hashed in full, so an oversized one is unreadable."""
    status, digest, _size, _package = _inspect_tool(rootfs, TOOL, SENTINEL_LIMIT)
    return ("unreadable" if status == "large" else status), digest


def _package_json_within_depth(raw):
    """Bound JSON containers before parsing, regardless of the interpreter's recursion limit."""
    text = raw.decode(json.detect_encoding(raw), "surrogatepass")
    depth = 0
    quoted = escaped = False
    for char in text:
        if quoted:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                quoted = False
        elif char == '"':
            quoted = True
        elif char in "[{":
            depth += 1
            if depth > PACKAGE_DEPTH_LIMIT:
                return False
        elif char in "]}":
            depth -= 1
    return True  # json.loads validates syntax, including mismatched delimiters and quotes.


def _package_version(rootfs, package):
    """The `version` of node_modules/<pkg>/package.json, bounded and validated, else None."""
    try:
        parent = open_dir_below(rootfs, "/".join(package))
        try:
            st = os.stat("package.json", dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISREG(st.st_mode) or st.st_size > PACKAGE_LIMIT:
                return None
            raw = read_regular_at(parent, "package.json", st, limit=PACKAGE_LIMIT)
        finally:
            os.close(parent)
        version = json.loads(raw).get("version") if raw is not None and _package_json_within_depth(raw) else None
    except (OSError, Refused, ValueError, AttributeError, RecursionError):
        return None
    return version if isinstance(version, str) and VERSION.fullmatch(version) else None


def _tool_names(cfg):
    names = cfg.get("canaryTools")
    if not isinstance(names, list):
        return []
    return [n for n in names[:MAX_TOOLS] if isinstance(n, str) and TOOL_NAME.fullmatch(n)]


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
    rootfs = os.path.join(cfg.runDir, "rootfs")
    tool_status, tool_sha256 = _read_tool(rootfs)
    _emit(cfg, "persistence", {
        "phase": _choice(phase, ("boot", "shutdown")),
        "sentinel": sentinel_status,
        "sentinelSha256": hashlib.sha256(sentinel).hexdigest() if sentinel is not None else None,
        "history": history_status, "historyLines": count,
        "historyMarker": HISTORY_MARKER in lines if lines is not None else None,
        "toolStatus": tool_status,
        "toolSha256": tool_sha256,
    })
    # Real installed tools (canaryTools, e.g. ["opencode"]): presence, size and package
    # version after each boot/shutdown. A large binary is never read; only its size is.
    for name in _tool_names(cfg):
        status, digest, size, package = _inspect_tool(rootfs, name, SENTINEL_LIMIT)
        _emit(cfg, "tool", {
            "phase": _choice(phase, ("boot", "shutdown")), "name": name, "status": status,
            "sha256": digest, "size": _integer(size),
            "version": _package_version(rootfs, package) if package is not None else None,
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
