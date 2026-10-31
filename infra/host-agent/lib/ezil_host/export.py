"""Reverse move export: the user's /workspace, captured for the Worker's import
(REVERSE-MOVE-CONTRACT §2.2-§2.5; the Worker side is worker/src/workspace-migration-import.ts).

The agent's signed `export` op validates, persists the job and answers within 1 s; one worker
thread per host then runs it (the socket is served by one thread with a 5 s client timeout):
  1. free space on the export dir (root volume) >= 1.75 GiB, else staging_space_low;
  2. the desktop stops under the runDir/stopping guard, as for `stop`, else desktop_stop_failed;
  3. /workspace missing (or not a real directory) on the volume -> workspace_missing;
  4. the Worker's own codec (`export-capture`) runs in a throwaway runc container
     (desktop.build_export_spec): exit 3 -> workspace_too_large (permanent), other -> capture_failed;
  5. staging: the chunk files move into chunks/, the archive goes, every chunk is re-hashed on
     the host against the codec's JSON, head.json is written, the state is ready.
The edge serves status, head and chunks from disk, never through the agent socket (a 1 MiB chunk
does not fit its 64 KiB JSON line). Everything the container wrote is guest-influenced (it runs
the codec, and Git, on guest bytes): read no-follow, regular files only, bounded.

state.json has two writers in two processes, the agent's job and the edge's lastServedAt: every
write is a read-modify-write under an flock, written temp -> fsync -> rename (fsops). Only one
job per host: the same {moveId, importGeneration} resumes or reports, any other is export_busy.
The export dir lives under stateDir (/var/lib/ezil-host/export), on the ROOT volume: it dies with
the instance at retire and never touches the user's data volume.
"""
import fcntl
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import time
from contextlib import contextmanager
from datetime import datetime, timezone

from . import desktop, lease as leasemod
from .fsops import DIR_FLAGS, FILE_FLAGS, Refused, open_dir_below, read_regular_at, write_file_durable_at

EXPORT_DIR = "export"                      # stateDir/export: the root volume, never dataMount
STATE_FILE, LOCK_FILE, HEAD_FILE, RESULT_FILE = "state.json", ".lock", "head.json", "codec-result.json"
CHUNK = 1024 * 1024                        # the Worker codec's own limits (workspace-persist.ts)
MAX_CHUNKS = 512
MAX_BYTES = MAX_CHUNKS * CHUNK
MAX_ENTRIES = 100_000
MAX_HEAD_BYTES = 128 * 1024
MAX_STATE_BYTES = 256 * 1024
MAX_RESULT_BYTES = 256 * 1024              # the codec's stdout: its JSON result only
MIN_FREE_BYTES = 7 * 1024**3 // 4          # 1.75 GiB: archive + chunk copies + Git index copy + paths + slack
READY_HOLD_SECONDS = 15 * 60               # idle hold while ready: 15 min after the last GET
HOLD_CAP_SECONDS = 185 * 60                # never held more than 185 min after the job started
SERVED_WRITE_INTERVAL = 15                 # lastServedAt is written at most once per 15 s
# The whole job (desktop stop + capture) ends within 15 min of its startedAt, so a capture never
# outlives the app's 20 min `exporting` deadline (§5.4), which starts before `begin` reaches this
# host (up to 3 ticks and a drive earlier). A resumed job past it fails at once.
JOB_BUDGET_SECONDS = 15 * 60
STATES = ("capturing", "ready", "failed")
ERRORS = ("workspace_too_large", "workspace_missing", "capture_failed", "desktop_stop_failed", "staging_space_low")
RECORD_KEYS = {"moveId", "importGeneration", "state", "startedAt", "finishedAt", "lastServedAt", "error", "head"}
# The agent message's closed field set: what every signed message carries, plus the two ids.
MESSAGE_KEYS = {"op", "seq", "ts", "leaseEpoch", "mac", "moveId", "importGeneration"}
REQUEST_KEYS = {"v", "moveId", "generation"}
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
HEX64_RE = re.compile(r"[0-9a-f]{64}")
TIME_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")


def valid_id(value):
    return isinstance(value, str) and UUID_RE.fullmatch(value) is not None


def _count(value, low, high):
    return type(value) is int and low <= value <= high


def iso(t):
    return datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_iso(value):
    if not isinstance(value, str) or not TIME_RE.fullmatch(value):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def parse_request(body):
    """The Worker's POST body (§2.2), already proven to hash to the signed path digest: UTF-8,
    no duplicate key, exactly {v, moveId, generation}, v the integer 1, lowercase UUIDs. None
    otherwise. Never re-serialized: the digest already fixed the bytes, key order and spacing."""
    try:
        d = leasemod.strict_json(body.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError):
        return None
    if not isinstance(d, dict) or set(d) != REQUEST_KEYS or type(d["v"]) is not int or d["v"] != 1:
        return None
    return d if valid_id(d["moveId"]) and valid_id(d["generation"]) else None


def valid_head(h, move_id=None, generation=None):
    """The §2.3 export head: the Worker codec's limits, so the result is a valid Cloudflare v1
    snapshot (the app's validExportHead and the Worker check it again)."""
    if not isinstance(h, dict) or set(h) != {"v", "moveId", "generation", "sha256", "entries", "skipped", "bytes", "chunks"}:
        return False
    if h["v"] != 1 or type(h["v"]) is not int or not valid_id(h["moveId"]) or not valid_id(h["generation"]):
        return False
    if (move_id, generation) != (None, None) and (h["moveId"], h["generation"]) != (move_id, generation):
        return False
    if not isinstance(h["sha256"], str) or not HEX64_RE.fullmatch(h["sha256"]):
        return False
    if not _count(h["entries"], 0, MAX_ENTRIES) or not _count(h["skipped"], 0, 2**53 - 1):
        return False
    chunks = h["chunks"]
    if not isinstance(chunks, list) or not 1 <= len(chunks) <= MAX_CHUNKS:
        return False
    total = 0
    for k, c in enumerate(chunks):
        if (not isinstance(c, dict) or set(c) != {"i", "size", "sha256"} or c["i"] != k or type(c["i"]) is not int
                or not _count(c["size"], 1, CHUNK) or not isinstance(c["sha256"], str) or not HEX64_RE.fullmatch(c["sha256"])):
            return False
        if k < len(chunks) - 1 and c["size"] != CHUNK:
            return False                   # every chunk but the last is exactly 1 MiB
        total += c["size"]
    return total == h["bytes"] and total <= MAX_BYTES


# --------------------------------------------------------------------------- the export dir
def root(cfg):
    """stateDir/export. Refused if it resolves onto the data volume: staged bytes and the job's
    state stay on the host root volume, which dies with the instance at retire."""
    path = os.path.join(cfg.stateDir, EXPORT_DIR)
    real, data = os.path.realpath(path), os.path.realpath(cfg.dataMount)
    if real == data or real.startswith(data.rstrip("/") + "/"):
        raise Refused("export_dir_on_data_volume", real)
    return path


def ensure_root(cfg):
    path = root(cfg)
    os.makedirs(path, mode=0o700, exist_ok=True)
    fd = os.open(path, DIR_FLAGS)          # a planted symlink refuses (ELOOP)
    try:
        if os.path.ismount(cfg.dataMount) and os.fstat(fd).st_dev == os.stat(cfg.dataMount).st_dev:
            raise Refused("export_dir_on_data_volume", path)
        os.fchmod(fd, 0o700)
    finally:
        os.close(fd)
    return path


@contextmanager
def _locked(cfg):
    """One read-modify-write at a time across the agent and the edge (flock per open file)."""
    fd = os.open(os.path.join(ensure_root(cfg), LOCK_FILE), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        yield
    finally:
        os.close(fd)                       # closing the only fd releases the lock


def _valid_record(r):
    if not isinstance(r, dict) or set(r) != RECORD_KEYS or r["state"] not in STATES:
        return False
    if not valid_id(r["moveId"]) or not valid_id(r["importGeneration"]) or parse_iso(r["startedAt"]) is None:
        return False
    if any(r[k] is not None and parse_iso(r[k]) is None for k in ("finishedAt", "lastServedAt")):
        return False
    if (r["state"] == "failed") != (r["error"] in ERRORS) or (r["state"] != "failed" and r["error"] is not None):
        return False
    if r["state"] == "ready":
        return valid_head(r["head"], r["moveId"], r["importGeneration"])
    return r["head"] is None


def read_state(cfg):
    """The job record, None when this host has none, or Refused('export_state_unreadable')."""
    try:
        fd = os.open(root(cfg), DIR_FLAGS)
    except FileNotFoundError:
        return None
    except OSError as e:
        raise Refused("export_state_unreadable") from e
    try:
        try:
            st = os.stat(STATE_FILE, dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            return None
        except OSError as e:
            raise Refused("export_state_unreadable") from e
        raw = read_regular_at(fd, STATE_FILE, st, limit=MAX_STATE_BYTES)
    finally:
        os.close(fd)
    try:
        record = leasemod.strict_json(raw) if raw is not None else None
    except (ValueError, RecursionError):
        record = None
    if not _valid_record(record):
        raise Refused("export_state_unreadable")
    return record


def _write_state(cfg, record):
    fd = os.open(ensure_root(cfg), DIR_FLAGS)
    try:
        write_file_durable_at(fd, STATE_FILE, json.dumps(record, separators=(",", ":")).encode(), 0o600)
    finally:
        os.close(fd)


def status(record):
    """The §2.4 status JSON. entries, bytes and skipped only when ready."""
    if record is None:
        return {"ok": True, "state": "none", "moveId": None, "generation": None, "startedAt": None,
                "finishedAt": None, "lastServedAt": None, "error": None}
    out = {"ok": True, "state": record["state"], "moveId": record["moveId"], "generation": record["importGeneration"],
           "startedAt": record["startedAt"], "finishedAt": record["finishedAt"],
           "lastServedAt": record["lastServedAt"], "error": record["error"]}
    if record["state"] == "ready":
        h = record["head"]
        out.update(entries=h["entries"], bytes=h["bytes"], skipped=h["skipped"])
    return out


def accept(cfg, move_id, import_generation, now):
    """The agent's half of the POST (lock held by the agent): 'new' (persisted as capturing),
    'same' (this host's job: resume or report) or 'busy' (another job holds the host, or its
    record is unreadable and cannot be matched)."""
    with _locked(cfg):
        try:
            record = read_state(cfg)
        except Refused:
            return "busy"
        if record is not None:
            return "same" if (record["moveId"], record["importGeneration"]) == (move_id, import_generation) else "busy"
        _write_state(cfg, {"moveId": move_id, "importGeneration": import_generation, "state": "capturing",
                           "startedAt": iso(now), "finishedAt": None, "lastServedAt": None, "error": None, "head": None})
        return "new"


def pending(cfg):
    """A job left `capturing` (the agent restarted mid-job): it must be resumed, or the Worker,
    which re-POSTs only on `none` (§4.3), would poll `capturing` until the app's deadline."""
    try:
        record = read_state(cfg)
    except Refused:
        return False
    return record is not None and record["state"] == "capturing"


def note_served(cfg, now):
    """The edge served a status, head or chunk GET: lastServedAt for the idle hold. Throttled to
    one write per SERVED_WRITE_INTERVAL, so parallel chunk GETs never queue on fsyncs."""
    with _locked(cfg):
        record = read_state(cfg)
        if record is None:
            return
        last = parse_iso(record["lastServedAt"])
        if last is not None and 0 <= now - last < SERVED_WRITE_INTERVAL:
            return
        record["lastServedAt"] = iso(now)
        _write_state(cfg, record)


def holds_idle(cfg, now):
    """§2.5 step 7: does the export hold an otherwise-due idle stop? Always while capturing;
    while ready, until 15 min after the last GET (or after finishedAt before any); never more
    than 185 min after the job started. Unknown (no or unreadable record) = no hold."""
    try:
        record = read_state(cfg)
    except Refused:
        return False
    if record is None:
        return False
    started = parse_iso(record["startedAt"])
    if started is None or now - started >= HOLD_CAP_SECONDS:
        return False
    if record["state"] == "capturing":
        return True
    if record["state"] != "ready":
        return False
    anchors = [t for t in (parse_iso(record["lastServedAt"]), parse_iso(record["finishedAt"])) if t is not None]
    return bool(anchors) and now - max(anchors) < READY_HOLD_SECONDS


def open_chunk(cfg, record, i):
    """The staged chunk i as (fd, size), or None. No-follow, regular, exactly the head's size."""
    try:
        dfd = open_dir_below(root(cfg), record["importGeneration"] + "/chunks")
    except (Refused, OSError):
        return None
    try:
        fd = os.open(str(i), FILE_FLAGS, dir_fd=dfd)
    except OSError:
        return None
    finally:
        os.close(dfd)
    st = os.fstat(fd)
    size = record["head"]["chunks"][i]["size"]
    if not stat.S_ISREG(st.st_mode) or st.st_size != size:
        os.close(fd)
        return None
    return fd, size


# ---------------------------------------------------------------------------- the container
def remove_container(cfg):
    """Kill and delete the export container, if any (a resumed job, a stop, the job's end)."""
    try:
        desktop.runc(cfg, "delete", "--force", desktop.EXPORT_CONTAINER_ID, capture_output=True, timeout=60)
    except (OSError, subprocess.SubprocessError):
        pass


def run_container(cfg, bundle, result_path, timeout):
    """Run the export container to completion. The codec's stdout goes to a file (bounded by
    the caller's read, never held in this process's memory). The exit code, or None on timeout."""
    remove_container(cfg)
    try:
        with open(result_path, "xb") as out:
            r = desktop.runc(cfg, "run", "--bundle", bundle, desktop.EXPORT_CONTAINER_ID,
                             stdin=subprocess.DEVNULL, stdout=out, stderr=subprocess.DEVNULL, timeout=timeout)
        return r.returncode
    except subprocess.TimeoutExpired:
        return None
    finally:
        remove_container(cfg)


# ---------------------------------------------------------------------------------- the job
class Failed(Exception):
    def __init__(self, error):
        super().__init__(error)
        self.error = error


def _free_bytes(path):
    s = os.statvfs(path)
    return s.f_bavail * s.f_frsize


def _workspace_present(cfg):
    """dataMount/workspace is a real directory (no-follow). The guard creates it at every boot;
    anything else is workspace_missing, and the container never binds a symlink."""
    try:
        fd = os.open(cfg.dataMount, DIR_FLAGS)
    except OSError:
        return False
    try:
        st = os.stat("workspace", dir_fd=fd, follow_symlinks=False)
        return stat.S_ISDIR(st.st_mode)
    except OSError:
        return False
    finally:
        os.close(fd)


def _parse_result(raw):
    """The codec's JSON result: {sha256, chunks:[{size, sha256}], entries, skipped}, in limits."""
    try:
        r = leasemod.strict_json(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, RecursionError, AttributeError):
        raise Failed("capture_failed")
    if not isinstance(r, dict) or set(r) != {"sha256", "chunks", "entries", "skipped"}:
        raise Failed("capture_failed")
    chunks = r["chunks"]
    if (not isinstance(chunks, list) or not 1 <= len(chunks) <= MAX_CHUNKS
            or not all(isinstance(c, dict) and set(c) == {"size", "sha256"} for c in chunks)):
        raise Failed("capture_failed")
    return r


def stage(cfg, export_dir, move_id, generation, raw_result):
    """§2.5 step 6: move the codec's chunk files into chunks/, drop the archive and the codec's
    scratch, re-hash every chunk on the host and compare with the codec's JSON. The export head,
    or Failed('capture_failed') on any mismatch. The container has exited: nothing races here,
    but whatever it left in tmp/ is untrusted (links, odd types, wrong sizes)."""
    result = _parse_result(raw_result)
    work = "tmp/ezil-snapshot-" + generation
    try:
        work_fd = open_dir_below(export_dir, work)
    except Refused:
        raise Failed("capture_failed")
    try:
        dfd = os.open(export_dir, DIR_FLAGS)
        try:
            os.mkdir("chunks", 0o700, dir_fd=dfd)
            chunks_fd = os.open("chunks", DIR_FLAGS, dir_fd=dfd)
        finally:
            os.close(dfd)
        try:
            whole, chunks = hashlib.sha256(), []
            for i, c in enumerate(result["chunks"]):
                name = str(i)
                try:
                    st = os.stat(name, dir_fd=work_fd, follow_symlinks=False)
                except OSError:
                    raise Failed("capture_failed")
                if not stat.S_ISREG(st.st_mode) or st.st_nlink != 1:
                    raise Failed("capture_failed")
                os.rename(name, name, src_dir_fd=work_fd, dst_dir_fd=chunks_fd)
                data = read_regular_at(chunks_fd, name, limit=CHUNK)
                if data is None or len(data) != c["size"] or hashlib.sha256(data).hexdigest() != c["sha256"]:
                    raise Failed("capture_failed")
                whole.update(data)
                chunks.append({"i": i, "size": len(data), "sha256": c["sha256"]})
            os.fsync(chunks_fd)
        finally:
            os.close(chunks_fd)
    finally:
        os.close(work_fd)
    shutil.rmtree(os.path.join(export_dir, "tmp"))   # archive.tar and the codec's scratch; never follows links
    head = {"v": 1, "moveId": move_id, "generation": generation, "sha256": result["sha256"],
            "entries": result["entries"], "skipped": result["skipped"],
            "bytes": sum(c["size"] for c in chunks), "chunks": chunks}
    data = json.dumps(head, separators=(",", ":")).encode()
    if whole.hexdigest() != result["sha256"] or not valid_head(head, move_id, generation) or len(data) > MAX_HEAD_BYTES:
        raise Failed("capture_failed")
    dfd = os.open(export_dir, DIR_FLAGS)
    try:
        write_file_durable_at(dfd, HEAD_FILE, data, 0o600)
    finally:
        os.close(dfd)
    return head


class Job:
    """One export, run in the agent's worker thread. `stop_desktop()` is the agent's: it stops
    the desktop under the runDir/stopping guard and says whether it is down. `stopping()` is the
    agent's too: True once it committed to stopping the host (a control-plane stop or fence, a
    shutdown begun), when no container may start: the quiesce is about to unmount /workspace."""

    def __init__(self, cfg, lease, stop_desktop, log=lambda m: print(m, flush=True), clock=time.time,
                 stopping=lambda: False):
        self.cfg, self.lease, self.stop_desktop, self.log, self.clock = cfg, lease, stop_desktop, log, clock
        self.stopping = stopping

    def run(self):
        """Never raises and never leaves its own record `capturing` while it can still write:
        the Worker re-POSTs only on `none` (§4.3), so a dead job would be polled until the
        app's deadline instead of failing at once."""
        try:
            record = read_state(self.cfg)
        except Refused:
            return
        if record is None or record["state"] != "capturing":
            return
        move_id, generation = record["moveId"], record["importGeneration"]
        export_dir = None
        try:
            export_dir = os.path.join(ensure_root(self.cfg), generation)
            head = self._capture(export_dir, move_id, generation, parse_iso(record["startedAt"]) + JOB_BUDGET_SECONDS)
        except Failed as f:
            self.log(f"export: failed {f.error}")
            self._failed(export_dir, move_id, generation, f.error)
            return
        except Exception as e:  # noqa: BLE001 — a job that dies must still report, never hang `capturing`
            self.log(f"export: failed capture_failed ({type(e).__name__})")
            self._failed(export_dir, move_id, generation, "capture_failed")
            return
        self.log(f"export: ready chunks={len(head['chunks'])} entries={head['entries']} skipped={head['skipped']}")
        self._finish(move_id, generation, "ready", head=head)

    def _failed(self, export_dir, move_id, generation, error):
        if export_dir is not None:
            shutil.rmtree(export_dir, ignore_errors=True)
        self._finish(move_id, generation, "failed", error=error)

    def _capture(self, export_dir, move_id, generation, deadline):
        if self.stopping():
            raise Failed("capture_failed")
        remove_container(self.cfg)                 # a resumed job: the old container still runs
        shutil.rmtree(export_dir, ignore_errors=True)
        os.mkdir(export_dir, 0o700)
        os.mkdir(os.path.join(export_dir, "tmp"), 0o700)
        if _free_bytes(export_dir) < MIN_FREE_BYTES:
            raise Failed("staging_space_low")
        if not self.stop_desktop():
            raise Failed("desktop_stop_failed")
        if not _workspace_present(self.cfg):
            raise Failed("workspace_missing")
        try:
            bundle = desktop.build_export_spec(self.cfg, self.lease, export_dir)
        except Refused as e:
            self.log(f"export: spec refused ({e.code})")
            raise Failed("capture_failed")
        result_path = os.path.join(export_dir, RESULT_FILE)
        started = self.clock()
        budget = deadline - started
        # Checked last, right before the container binds /workspace: a stop committed meanwhile
        # quiesces (removes the container, unmounts) and would find this capture holding the volume.
        if budget <= 0 or self.stopping():
            self.log("export: no capture (budget spent or the host is stopping)")
            raise Failed("capture_failed")
        rc = run_container(self.cfg, bundle, result_path, timeout=budget)
        self.log(f"export: codec exit={rc} seconds={int(self.clock() - started)}")
        if rc == 3:
            raise Failed("workspace_too_large")
        if rc != 0:
            raise Failed("capture_failed")
        dfd = os.open(export_dir, DIR_FLAGS)
        try:
            raw = read_regular_at(dfd, RESULT_FILE, limit=MAX_RESULT_BYTES)
        finally:
            os.close(dfd)
        if raw is None:
            raise Failed("capture_failed")
        return stage(self.cfg, export_dir, move_id, generation, raw)

    def _finish(self, move_id, generation, state, error=None, head=None):
        """Only this job's own `capturing` record changes; lastServedAt is kept. One retry of a
        failed write (the root volume briefly full or erroring); after that the record stays
        `capturing` and the app's `exporting` deadline ends the move."""
        for attempt in (1, 2):
            try:
                with _locked(self.cfg):
                    try:
                        record = read_state(self.cfg)
                    except Refused:
                        return
                    if (record is None or record["state"] != "capturing"
                            or (record["moveId"], record["importGeneration"]) != (move_id, generation)):
                        return
                    record.update(state=state, error=error, head=head, finishedAt=iso(self.clock()))
                    _write_state(self.cfg, record)
                return
            except (OSError, Refused) as e:   # Refused: the export dir itself refused (ensure_root)
                self.log(f"export: {state} not recorded (attempt {attempt}): {type(e).__name__}")
                if attempt == 1:
                    time.sleep(1)


__all__ = ["accept", "holds_idle", "note_served", "open_chunk", "parse_request", "pending", "read_state",
           "remove_container", "status", "valid_head", "valid_id", "Job"]
