"""Control channel, idle predicate and quiesce/shutdown (R9).

Presence and control-plane commands arrive on a root-only unix socket
(runDir/control.sock, 0600), each request HMAC-SHA256-signed with the per-epoch control
key the app returned at enrollment and bound to this lease epoch and a fresh timestamp.
(The gateway reaches it through the tunnel; that wiring is the gateway lane's.)

This agent NEVER renews its own lease and makes no outbound call: lease renewal is the
control plane's, from gateway-observed presence (R9). Caps are enforced by the control
plane regardless of what this agent reports; this agent only:
  * idle-stops (guest-initiated, allowed by R9) when the #183 predicate holds:
      A. no presence for idle.inactivitySeconds  (worker isIdleStopDue)
      B. host 1-min load below idle.load1Busy, strictly parsed; unknown = busy
         (worker CONTAINER_BUSY_LOAD1 / parseLoadAvg1)
      C. a SUCCESSFUL final flush; busy (dpkg/apt lock held in the guest) or stale
         (fenced / lease changed) or failed blocks the stop and the check repeats;
  * honours a control-plane `stop`: warn -> flush (not blockable) -> stop;
  * honours a `fence`: cloudflared stops and the token is wiped, then stop.
Stop = desktop stopped, overlay and data volume unmounted in order (sync), then
cfg.shutdownCmd (`shutdown -h now`).
"""
import hashlib
import hmac
import json
import math
import os
import re
import socket
import stat
import subprocess
import threading
import time

from . import desktop, guard, tunnel
from .fsops import Refused, open_dir_below

LOAD_RE = re.compile(r"^\d+(\.\d+)?$")
MAX_PAST = 120        # seconds a request may be old
MAX_FUTURE = 5        # seconds of clock skew tolerated ahead of this host
MAX_WARN = 900        # a control-plane stop warns for at most 15 minutes


def _is_number(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def parse_load1(text):
    first = (text or "").strip().split()
    if not first or not LOAD_RE.match(first[0]):
        return None
    return float(first[0])


def dpkg_lock_held(cfg, proc_locks="/proc/locks"):
    """Is apt/dpkg running in the guest? Host-side: lstat the guest's dpkg lock files
    through the merged overlay (no-follow, regular files only) and look their inode up in
    /proc/locks (POSIX fcntl locks as dpkg/apt take them, and flock). Matched by inode
    number only — the device shown in /proc/locks is not the overlay's (measured) — so
    an unrelated inode collision reads as busy: conservative, it only delays a stop."""
    inos = set()
    for rel in ("var/lib/dpkg/lock-frontend", "var/lib/dpkg/lock"):
        try:
            fd = open_dir_below(desktop.merged(cfg), os.path.dirname(rel))
        except Refused:
            continue
        try:
            st = os.stat(os.path.basename(rel), dir_fd=fd, follow_symlinks=False)
            if stat.S_ISREG(st.st_mode):
                inos.add(st.st_ino)
        except FileNotFoundError:
            pass
        finally:
            os.close(fd)
    if not inos:
        return False
    with open(proc_locks) as f:
        for line in f:
            parts = line.split()
            dev_ino = next((p for p in parts if p.count(":") == 2), None)
            if dev_ino and int(dev_ino.rsplit(":", 1)[1]) in inos:
                return True
    return False


def idle_due(last_activity, now, inactivity):
    return now - last_activity >= inactivity


def sign(key, msg):
    body = json.dumps({k: v for k, v in msg.items() if k != "mac"}, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


class Agent:
    def __init__(self, cfg, lease, clock=time.time, log=lambda m: print(m, flush=True)):
        self.cfg, self.lease, self.clock, self.log = cfg, lease, clock, log
        self.last_presence = clock()          # boot counts as activity
        self.stop_request = None
        self.lock = threading.Lock()
        with open(os.path.join(cfg.stateDir, "control.key"), "rb") as f:
            self.key = f.read()
        self.last_seq = self._load_seq()

    # ---------------------------------------------------------------- control
    def handle(self, raw):
        """Authenticate (HMAC), bind to this epoch, check freshness and replay, then act.
        Every request carries ts (finite, at most MAX_PAST s old and MAX_FUTURE s ahead)
        and seq (integer, strictly increasing within the epoch; the high-water mark is
        persisted host-only and fsynced BEFORE the request takes effect, so a replay is
        refused even across an agent restart)."""
        try:
            msg = json.loads(raw)
        except ValueError:
            return {"ok": False, "error": "bad_json"}
        if not isinstance(msg, dict):
            return {"ok": False, "error": "bad_json"}
        mac = msg.get("mac", "")
        if not isinstance(mac, str) or not hmac.compare_digest(mac, sign(self.key, msg)):
            return {"ok": False, "error": "bad_mac"}
        if msg.get("leaseEpoch") != self.lease["leaseEpoch"] or isinstance(msg.get("leaseEpoch"), bool):
            return {"ok": False, "error": "wrong_epoch"}
        ts = msg.get("ts")
        if not _is_number(ts) or not math.isfinite(ts):
            return {"ok": False, "error": "bad_ts"}
        now = self.clock()
        if ts < now - MAX_PAST or ts > now + MAX_FUTURE:
            return {"ok": False, "error": "stale_request"}
        seq = msg.get("seq")
        if not isinstance(seq, int) or isinstance(seq, bool) or seq < 1:
            return {"ok": False, "error": "bad_seq"}
        op = msg.get("op")
        if op == "stop":
            warn = msg.get("warnSeconds", self.cfg.stopWarnSeconds)
            if not isinstance(warn, int) or isinstance(warn, bool) or not 0 <= warn <= MAX_WARN:
                return {"ok": False, "error": "bad_warn"}
        elif op not in ("presence", "fence"):
            return {"ok": False, "error": "unknown_op"}
        with self.lock:
            if seq <= self.last_seq:
                return {"ok": False, "error": "replayed"}
            self._persist_seq(seq)
            if op == "presence":
                self.last_presence = max(self.last_presence, min(float(ts), now))
                return {"ok": True}
            if op == "stop":
                self.stop_request = {"kind": "stop", "warn": warn, "reason": str(msg.get("reason", "control_plane"))[:64]}
                return {"ok": True}
            tunnel.fence(self.cfg, f"fence:{str(msg.get('newEpoch'))[:32]}")
            self.stop_request = {"kind": "fence", "warn": 0, "reason": "fence"}
            return {"ok": True}

    def _seq_path(self):
        return os.path.join(self.cfg.stateDir, "control-seq.json")

    def _load_seq(self):
        try:
            with open(self._seq_path()) as f:
                d = json.load(f)
            if d.get("leaseEpoch") == self.lease["leaseEpoch"] and isinstance(d.get("seq"), int):
                return d["seq"]
        except (OSError, ValueError, AttributeError):
            pass
        return 0

    def _persist_seq(self, seq):
        from .enroll import _write_private
        _write_private(self._seq_path(), json.dumps({"leaseEpoch": self.lease["leaseEpoch"], "seq": seq}).encode())
        self.last_seq = seq

    def serve(self, stop_event):
        path = os.path.join(self.cfg.runDir, "control.sock")
        try:
            os.unlink(path)
        except FileNotFoundError:
            pass
        old = os.umask(0o177)
        s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        s.bind(path)
        os.umask(old)
        os.chmod(path, 0o600)
        s.listen(8)
        s.settimeout(0.5)
        while not stop_event.is_set():
            try:
                c, _ = s.accept()
            except socket.timeout:
                continue
            with c:
                c.settimeout(5)
                data = b""
                try:
                    while not data.endswith(b"\n") and len(data) < 65536:
                        chunk = c.recv(4096)
                        if not chunk:
                            break
                        data += chunk
                    try:
                        resp = self.handle(data)
                    except Exception as e:  # noqa: BLE001 — a bad request must never kill the channel
                        resp = {"ok": False, "error": "internal", "detail": type(e).__name__}
                    c.sendall((json.dumps(resp) + "\n").encode())
                except OSError:
                    pass
        s.close()

    # ------------------------------------------------------------------ flush
    def flush(self, blockable=True):
        """ok | busy | stale | failed. Only ok permits an idle stop."""
        if os.path.exists(tunnel.fence_path(self.cfg)) and blockable:
            return "stale"
        try:
            with open(os.path.join(self.cfg.runDir, "guard-ok")) as f:
                stamp = json.load(f)
            if stamp != {"generation": self.lease["generation"], "leaseEpoch": self.lease["leaseEpoch"]}:
                return "stale"
        except (OSError, ValueError):
            return "stale"
        if blockable and dpkg_lock_held(self.cfg):
            return "busy"
        try:
            desktop.stop(self.cfg, grace=float(self.cfg.idle["flushTimeoutSeconds"]))
            r = subprocess.run(["sync", "-f", self.cfg.dataMount], timeout=self.cfg.idle["flushTimeoutSeconds"])
            return "ok" if r.returncode == 0 else "failed"
        except (OSError, subprocess.SubprocessError):
            return "failed"

    def shutdown(self, why):
        self.log(f"shutdown: {why}")
        tunnel.fence(self.cfg, why)          # cloudflared stops and wipes its token
        time.sleep(1.0)
        # Ordered quiesce. Each step is attempted even if an earlier one failed: the OS
        # shutdown that follows must happen regardless (it also unmounts).
        for name, fn in (("desktop", lambda: desktop.stop(self.cfg)),
                         ("overlay", lambda: desktop.overlay_umount(self.cfg)),
                         ("sync", lambda: subprocess.run(["sync"], check=True)),
                         ("stamp", lambda: guard.clear_stamp(self.cfg)),
                         ("data", lambda: subprocess.run(["umount", self.cfg.dataMount], check=True)),
                         ("netns", lambda: desktop.netns_down(self.cfg))):
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                self.log(f"quiesce step {name} failed: {e}")
        subprocess.run(list(self.cfg.shutdownCmd))

    # ------------------------------------------------------------------- loop
    def tick(self):
        with self.lock:
            req = self.stop_request
        if req:
            if req["warn"] > 0:
                self.warn(req["warn"], req["reason"])
                time.sleep(req["warn"])
            res = self.flush(blockable=False)      # caps and fences are not blockable
            self.shutdown(f"{req['kind']}:{req['reason']} flush={res}")
            return "stopped"
        now = self.clock()
        if not idle_due(self.last_presence, now, self.cfg.idle["inactivitySeconds"]):
            return "active"
        try:
            with open("/proc/loadavg") as f:
                load1 = parse_load1(f.read())
        except OSError:
            load1 = None
        if load1 is None or load1 >= self.cfg.idle["load1Busy"]:
            return "busy_load"
        res = self.flush(blockable=True)
        if res != "ok":
            self.log(f"idle stop blocked: flush={res}")
            return f"flush_{res}"
        self.shutdown("idle")
        return "stopped"

    def warn(self, seconds, reason):
        self.log(f"warn: stopping in {seconds}s ({reason})")
        hook = self.cfg.get("warnHook")
        if hook and desktop.state(self.cfg) == "running":
            desktop.exec_(self.cfg, [hook, str(seconds), reason], capture_output=True, timeout=10)

    def run(self):
        ev = threading.Event()
        t = threading.Thread(target=self.serve, args=(ev,), daemon=True)
        t.start()
        try:
            while True:
                if self.tick() == "stopped":
                    return
                time.sleep(self.cfg.idle["intervalSeconds"])
        finally:
            ev.set()


def client(cfg, key, msg):
    msg = dict(msg)
    msg["mac"] = sign(key, msg)
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(5)
    s.connect(os.path.join(cfg.runDir, "control.sock"))
    s.sendall((json.dumps(msg) + "\n").encode())
    data = b""
    while not data.endswith(b"\n"):
        chunk = s.recv(4096)
        if not chunk:
            break
        data += chunk
    s.close()
    return json.loads(data or b"{}")


__all__ = ["Agent", "client", "parse_load1", "idle_due", "sign", "Refused"]
