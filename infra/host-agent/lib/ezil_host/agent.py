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

A desktop that needed KILL is never reported as a clean stop: the flush says `unclean`
(the idle stop still proceeds — the desktop is already gone, staying up only bills), and
the worst outcome of this boot is written durably to the data root before it unmounts
(desktop.STOP_RECORD); the next boot reports it (host_clean -> lastStop).
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
from .fsops import DIR_FLAGS, Refused, open_dir_below, write_file_durable_at

LOAD_RE = re.compile(r"^\d+(\.\d+)?$")
MAX_PAST = 120        # seconds a request may be old
MAX_FUTURE = 5        # seconds of clock skew tolerated ahead of this host
MAX_WARN = 900        # a control-plane stop warns for at most 15 minutes
STOP_RANK = {"absent": 0, "clean": 1, "killed": 2}


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
        self.restart_request = False          # a relay config for a desktop started without one
        self.stop_outcome = None              # worst desktop.stop() outcome seen this boot
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
        relay_config = None
        if op == "stop":
            warn = msg.get("warnSeconds", self.cfg.stopWarnSeconds)
            if not isinstance(warn, int) or isinstance(warn, bool) or not 0 <= warn <= MAX_WARN:
                return {"ok": False, "error": "bad_warn"}
        elif op == "ice":
            try:
                relay_config = desktop.validate_desktop_config(msg.get("config"), int(now * 1000))
            except ValueError:
                return {"ok": False, "error": "ice_config_invalid"}   # never echo the config
        elif op not in ("presence", "fence", "desktop_status"):
            return {"ok": False, "error": "unknown_op"}
        with self.lock:
            if seq <= self.last_seq:
                return {"ok": False, "error": "replayed"}
            self._persist_seq(seq)
            if op == "presence":
                self.last_presence = max(self.last_presence, min(float(ts), now))
                return {"ok": True}
            if op == "ice":
                return self._accept_relay(relay_config)
            if op == "desktop_status":
                return self._desktop_status(now)
            if op == "stop":
                self.stop_request = {"kind": "stop", "warn": warn, "reason": str(msg.get("reason", "control_plane"))[:64]}
                return {"ok": True}
            tunnel.fence(self.cfg, f"fence:{str(msg.get('newEpoch'))[:32]}")
            self.stop_request = {"kind": "fence", "warn": 0, "reason": "fence"}
            return {"ok": True}

    def _desktop_state(self):
        try:
            return desktop.state(self.cfg)
        except (OSError, ValueError, subprocess.SubprocessError):
            return "unknown"

    def _accept_relay(self, relay_config):
        """GW-5 `ice` (lock held): store the per-epoch relay config in runDir (tmpfs) for the
        desktop step. A desktop that is already running WITH a relay keeps it (renewal goes
        through neko's /api/relay in place); one that started WITHOUT a relay (the bounded
        wait timed out) is restarted so it picks the config up."""
        try:
            desktop.write_desktop_config(self.cfg, relay_config)
        except (OSError, Refused):
            return {"ok": False, "error": "ice_store_failed"}
        if self._desktop_state() != "running":
            return {"ok": True, "state": "accepted"}
        if desktop.read_ice_state(self.cfg) == "applied":
            return {"ok": True, "state": "already_running"}
        self.restart_request = True
        return {"ok": True, "state": "restart_scheduled"}

    def _desktop_status(self, now):
        """GW-5 `desktop` (lock held): whether an unexpired config is held for this epoch and
        how the desktop runs. Never the config itself."""
        c = desktop.read_desktop_config(self.cfg, int(now * 1000))
        return {"ok": True, "configured": c is not None, "expiresAt": c["expiresAt"] if c else None,
                "desktop": self._desktop_state(), "ice": desktop.read_ice_state(self.cfg)}

    def restart_desktop(self):
        """A relay config arrived after the desktop started without one: restart it through
        its unit (ExecStop stops it the normal way, hanging up terminal shells first; the
        desktop step then starts it with the stored config). Non-blocking."""
        self.log("desktop restart: relay config arrived after the desktop started without one")
        try:
            subprocess.run(list(self.cfg.desktopRestartCmd), timeout=30, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as e:
            self.log(f"desktop restart failed: {type(e).__name__}")

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
    def _note_stop(self, outcome):
        if outcome in STOP_RANK and (self.stop_outcome is None or STOP_RANK[outcome] > STOP_RANK[self.stop_outcome]):
            self.stop_outcome = outcome
        return outcome

    def flush(self, blockable=True):
        """ok | unclean | busy | stale | failed. ok and unclean both mean the desktop is
        stopped and the data volume synced; unclean = it needed KILL (never reported ok)."""
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
            outcome = self._note_stop(desktop.stop(self.cfg, grace=float(self.cfg.idle["flushTimeoutSeconds"])))
            r = subprocess.run(["sync", "-f", self.cfg.dataMount], timeout=self.cfg.idle["flushTimeoutSeconds"])
            if r.returncode != 0:
                return "failed"
            return "unclean" if outcome == "killed" else "ok"
        except (OSError, subprocess.SubprocessError):
            return "failed"

    def record_stop(self, why):
        """Durably write this boot's stop outcome to the data root (host-only, next to the
        marker) BEFORE the volume unmounts; the next boot reports it. Never on the host
        disk: refused unless the data volume is the mount at dataMount."""
        if not guard.is_mounted(self.cfg.dataMount):
            raise Refused("stop_record_no_volume", self.cfg.dataMount)
        rec = {"v": 1, "outcome": self.stop_outcome or "absent", "reason": str(why)[:128], "at": int(time.time()),
               "generation": self.lease["generation"], "leaseEpoch": self.lease["leaseEpoch"]}
        root = os.open(self.cfg.dataMount, DIR_FLAGS)
        try:
            write_file_durable_at(root, desktop.STOP_RECORD, (json.dumps(rec) + "\n").encode(), 0o600)
        finally:
            os.close(root)
        self.log(f"stop recorded: outcome={rec['outcome']} reason={rec['reason']}")

    def shutdown(self, why):
        self.log(f"shutdown: {why}")
        tunnel.fence(self.cfg, why)          # cloudflared stops and wipes its token
        time.sleep(1.0)
        # Ordered quiesce. Each step is attempted even if an earlier one failed: the OS
        # shutdown that follows must happen regardless (it also unmounts).
        for name, fn in (("desktop", lambda: self._note_stop(desktop.stop(self.cfg))),
                         ("record", lambda: self.record_stop(why)),
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
            restart, self.restart_request = self.restart_request and not req, False
        if restart:
            self.restart_desktop()
            return "restarting"
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
        if res not in ("ok", "unclean"):
            self.log(f"idle stop blocked: flush={res}")
            return f"flush_{res}"
        # unclean: the desktop needed KILL and is already gone; stopping is still right
        # (a running computer without a desktop only bills), but it is recorded as unclean
        self.shutdown("idle" if res == "ok" else f"idle flush={res}")
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
