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
import os
import re
import socket
import subprocess
import threading
import time

from . import desktop, tunnel
from .fsops import Refused

LOAD_RE = re.compile(r"^\d+(\.\d+)?$")


def parse_load1(text):
    first = (text or "").strip().split()
    if not first or not LOAD_RE.match(first[0]):
        return None
    return float(first[0])


def idle_due(last_activity, now, inactivity):
    return now - last_activity >= inactivity


def sign(key, msg):
    body = json.dumps({k: v for k, v in msg.items() if k != "mac"}, sort_keys=True, separators=(",", ":")).encode()
    return hmac.new(key, body, hashlib.sha256).hexdigest()


class Agent:
    def __init__(self, cfg, lease, clock=time.time, log=print):
        self.cfg, self.lease, self.clock, self.log = cfg, lease, clock, log
        self.last_presence = clock()          # boot counts as activity
        self.stop_request = None
        self.lock = threading.Lock()
        with open(os.path.join(cfg.stateDir, "control.key"), "rb") as f:
            self.key = f.read()

    # ---------------------------------------------------------------- control
    def handle(self, raw):
        try:
            msg = json.loads(raw)
            mac = msg.get("mac", "")
        except ValueError:
            return {"ok": False, "error": "bad_json"}
        if not isinstance(mac, str) or not hmac.compare_digest(mac, sign(self.key, msg)):
            return {"ok": False, "error": "bad_mac"}
        if msg.get("leaseEpoch") != self.lease["leaseEpoch"]:
            return {"ok": False, "error": "wrong_epoch"}
        ts = msg.get("ts")
        if not isinstance(ts, (int, float)) or abs(self.clock() - ts) > 120:
            return {"ok": False, "error": "stale_request"}
        op = msg.get("op")
        with self.lock:
            if op == "presence":
                self.last_presence = max(self.last_presence, float(ts))
                return {"ok": True}
            if op == "stop":
                self.stop_request = {"kind": "stop", "warn": int(msg.get("warnSeconds", self.cfg.stopWarnSeconds)),
                                     "reason": str(msg.get("reason", "control_plane"))}
                return {"ok": True}
            if op == "fence":
                tunnel.fence(self.cfg, f"fence:{msg.get('newEpoch')}")
                self.stop_request = {"kind": "fence", "warn": 0, "reason": "fence"}
                return {"ok": True}
        return {"ok": False, "error": "unknown_op"}

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
                    c.sendall((json.dumps(self.handle(data)) + "\n").encode())
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
        if blockable and desktop.state(self.cfg) == "running":
            for lock in ("/var/lib/dpkg/lock-frontend", "/var/lib/dpkg/lock"):
                r = desktop.exec_(self.cfg, ["flock", "-n", "-E", "99", lock, "true"], capture_output=True, timeout=30)
                if r.returncode == 99:
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
        desktop.stop(self.cfg)
        desktop.overlay_umount(self.cfg)
        subprocess.run(["sync"])
        subprocess.run(["umount", self.cfg.dataMount])
        desktop.netns_down(self.cfg)
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
