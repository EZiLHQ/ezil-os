"""One closed standalone Git job; grants never enter host files or diagnostics."""
import hashlib
import json
import os
import re
import subprocess
import threading
import time
from datetime import datetime

from . import desktop, guard, lease as leasemod, tunnel
from .fsops import DIR_FLAGS, FILE_FLAGS, read_regular_at

MAX_BODY, MAX_PACKET, MAX_OUTPUT = 20480, 16384, 65536
MIN_MS, MAX_MS, JOBS_MAX, TTL_SECONDS = 20000, 130000, 16, 600
MARKER = "standalone-git-active"
UUID = re.compile(r"[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}")
HEX64 = re.compile(r"[0-9a-f]{64}")
URL = re.compile(r"https://github\.ezil\.work/[a-z0-9][a-z0-9-]{0,63}/[a-z0-9][a-z0-9._-]{0,99}\.git")
OPAQUE = re.compile(r"[^\s\x00-\x1f\x7f]{1,255}")
TOKEN = re.compile(r"[A-Za-z0-9._~+/=?-]{16,8192}")
TIME = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z")
MESSAGE_KEYS = {"op", "seq", "ts", "leaseEpoch", "mac", "request"}
STATUS_KEYS = {"op", "seq", "ts", "leaseEpoch", "mac", "jobId"}


def expiry(value):
    if not isinstance(value, str) or not TIME.fullmatch(value):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000
    except ValueError:
        return None


def valid_ref(value):
    return (isinstance(value, str) and len(value) <= 255
            and re.fullmatch(r"refs/heads/[A-Za-z0-9._/-]+", value)
            and ".." not in value and "//" not in value and not value.endswith("/")
            and all(not p.startswith((".", "-")) and not p.endswith((".", ".lock"))
                    for p in value.split("/")))


def valid_request(req, now_ms):
    if (not isinstance(req, dict) or set(req) != {"v", "jobId", "repositoryId", "privatePacket", "timeoutMs"}
            or type(req["v"]) is not int or req["v"] != 1
            or not isinstance(req["jobId"], str) or not HEX64.fullmatch(req["jobId"])
            or not isinstance(req["repositoryId"], str) or not UUID.fullmatch(req["repositoryId"])
            or type(req["timeoutMs"]) is not int or not MIN_MS <= req["timeoutMs"] <= MAX_MS):
        return False
    p = req["privatePacket"]
    if not isinstance(p, dict) or set(p) != {"version", "repository", "identity", "git"} or type(p["version"]) is not int or p["version"] != 2:
        return False
    r, i, g = p["repository"], p["identity"], p["git"]
    if (not isinstance(r, dict) or set(r) != {"id", "canonicalURL", "ref"}
            or not isinstance(r["id"], str) or not re.fullmatch(r"[a-z0-9]{1,64}", r["id"])
            or not isinstance(r["canonicalURL"], str) or not URL.fullmatch(r["canonicalURL"])
            or ".." in r["canonicalURL"] or r["canonicalURL"].endswith(".git.git") or not valid_ref(r["ref"])
            or not isinstance(i, dict) or set(i) != {"issuer", "subject"}
            or i["issuer"] != "https://id.ezil.work/" or not isinstance(i["subject"], str) or not OPAQUE.fullmatch(i["subject"])
            or not isinstance(g, dict) or set(g) != {"username", "token", "expiresAt", "scope"}
            or g["username"] != "ezil" or g["scope"] not in ("read", "write")
            or not isinstance(g["token"], str) or not TOKEN.fullmatch(g["token"])):
        return False
    end = expiry(g["expiresAt"])
    return (end is not None and req["timeoutMs"] + 5000 <= end - now_ms <= 300000
            and len(json.dumps(p, separators=(",", ":")).encode()) <= MAX_PACKET)


def parse_request(raw, now_ms):
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_BODY:
        return None
    try:
        req = leasemod.strict_json(raw.decode("utf-8", "strict"))
        return req if valid_request(req, now_ms) else None
    except (UnicodeError, ValueError, RecursionError, TypeError):
        return None


def host_ready(cfg, lease):
    """Recheck this mounted volume/guard epoch immediately before each runc exec."""
    if any(os.path.lexists(os.path.join(cfg.runDir, p)) for p in
           (desktop.STOPPING, desktop.EXPORT_QUIESCE, "shutdown-pending")) or os.path.lexists(tunnel.fence_path(cfg)):
        return False
    try:
        root = os.open(cfg.runDir, DIR_FLAGS)
        try:
            st = os.stat("guard-ok", dir_fd=root, follow_symlinks=False)
            raw = read_regular_at(root, "guard-ok", st, limit=1024)
        finally:
            os.close(root)
        if leasemod.strict_json(raw) != {"generation": lease["generation"], "leaseEpoch": lease["leaseEpoch"]}:
            return False
        mount = subprocess.run(["mountpoint", "-q", cfg.dataMount], timeout=0.5,
                               stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if mount.returncode != 0:
            return False
        root = os.open(cfg.dataMount, DIR_FLAGS)
        try:
            st = os.stat(guard.MARKER, dir_fd=root, follow_symlinks=False)
            raw = read_regular_at(root, guard.MARKER, st, limit=4096)
        finally:
            os.close(root)
        marker = leasemod.strict_json(raw)
        if any(marker.get(k) != lease[k] for k in ("computerId", "volumeId", "fsUuid", "generation", "leaseEpoch")):
            return False
        state = desktop.runc(cfg, "state", cfg.containerId, timeout=0.5,
                             stdin=subprocess.DEVNULL, capture_output=True, text=True)
        return state.returncode == 0 and leasemod.strict_json(state.stdout).get("status") == "running"
    except (OSError, ValueError, TypeError, AttributeError, subprocess.SubprocessError):
        return False


def validate_output(raw, req):
    p = req["privatePacket"]
    if not isinstance(raw, bytes) or len(raw) > MAX_OUTPUT or p["git"]["token"].encode() in raw:
        return None
    try:
        v = leasemod.strict_json(raw.decode("utf-8", "strict"))
    except (UnicodeError, ValueError, RecursionError):
        return None
    if (not isinstance(v, dict) or set(v) != {"canonicalUrl", "folder", "repository", "identity", "status"}
            or v["canonicalUrl"] != p["repository"]["canonicalURL"] or v["repository"] != p["repository"]
            or v["identity"] != p["identity"] or v["status"] not in ("cloned", "reused")
            or v["folder"] != "/workspace/projects/" + req["repositoryId"] + "/repository"):
        return None
    return {"ok": True, "folder": "/workspace/projects/" + req["repositoryId"],
            "status": "fetched" if v["status"] == "reused" else "cloned"}


class Jobs:
    """Admission/status never wait for runc. Marker survives restart/unknown outcome."""
    def __init__(self, cfg, lease, runner=None, ready=host_ready, clock=time.time):
        self.cfg, self.lease, self.ready, self.clock = cfg, lease, ready, clock
        if runner is None:
            from .standalone_git_runtime import execute
            runner = execute
        self.runner = runner
        self.lock = threading.RLock()
        self.jobs = {}
        self.active_id = None
        self.marker = os.path.join(cfg.runDir, MARKER)

    def active(self):
        with self.lock:
            return self.active_id is not None or os.path.lexists(self.marker)

    def _prune(self, now):
        for key in list(self.jobs):
            job = self.jobs[key]
            if job.get("finishedAt") is not None and now - job["finishedAt"] > TTL_SECONDS:
                del self.jobs[key]

    def start(self, req):
        now = self.clock()
        if not valid_request(req, now * 1000):
            return {"ok": False, "error": "standalone_repo_invalid"}
        fingerprint = hashlib.sha256(json.dumps(req, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        with self.lock:
            self._prune(now)
            prior = self.jobs.get(req["jobId"])
            if prior:
                return {"ok": True, "state": prior["state"]} if prior["fingerprint"] == fingerprint else {"ok": False, "error": "job_replayed"}
            if self.active() or len(self.jobs) >= JOBS_MAX:
                return {"ok": False, "error": "workspace_busy"}
            if not self.ready(self.cfg, self.lease):
                return {"ok": False, "error": "runtime_not_running"}
            try:
                fd = os.open(self.marker, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
                with os.fdopen(fd, "w") as f:
                    f.write(req["jobId"])
                    f.flush()
                    os.fsync(f.fileno())
            except OSError:
                return {"ok": False, "error": "workspace_busy"}
            self.jobs[req["jobId"]] = {"state": "running", "fingerprint": fingerprint}
            self.active_id = req["jobId"]
            threading.Thread(target=self._run, args=(req, time.monotonic()), name="ezil-standalone-git", daemon=True).start()
            return {"ok": True, "state": "running"}

    def _run(self, req, admitted_at):
        try:
            left = req["timeoutMs"] - int(max(0, time.monotonic() - admitted_at) * 1000)
            if left < MIN_MS:
                result, uncertain = {"ok": False, "error": "repo_open_timeout"}, False
            else:
                result, uncertain = self.runner(self.cfg, self.lease, {**req, "timeoutMs": left})
        except Exception:
            result, uncertain = {"ok": False, "error": "repo_open_failed"}, True
        with self.lock:
            self.jobs[req["jobId"]].update(state="done", result=result, finishedAt=self.clock())
            self.active_id = None
            if not uncertain:
                try:
                    fd = os.open(self.marker, FILE_FLAGS)
                    with os.fdopen(fd, "r") as f:
                        owned = f.read(65) == req["jobId"]
                    if owned:
                        os.unlink(self.marker)
                except OSError:
                    pass

    def status(self, job_id):
        with self.lock:
            self._prune(self.clock())
            job = self.jobs.get(job_id)
            if job is None:
                return {"ok": False, "error": "job_unknown"}
            return {"ok": True, "state": job["state"], **({"result": job["result"]} if job["state"] == "done" else {})}
