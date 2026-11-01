"""Control channel, idle predicate and quiesce/shutdown (R9).

Presence and control-plane commands arrive on a root-only unix socket
(runDir/control.sock, 0600), each request HMAC-SHA256-signed with the per-epoch control
key the app returned at enrollment and bound to this lease epoch and a fresh timestamp.
(The gateway reaches it through the tunnel; that wiring is the gateway lane's.)

This agent NEVER renews its own lease and makes one kind of outbound call only: the storage
sample (storage.py; every storageSampleSeconds on a daemon thread, and once on stop within
storageStopBudgetSeconds), signed with the control key. It is metering, best effort: no answer
or failure changes a lifecycle decision. Lease renewal is the control plane's, from
gateway-observed presence (R9). Caps are enforced by the control plane regardless of what
this agent reports; this agent only:
  * idle-stops (guest-initiated, allowed by R9) when the #183 predicate holds:
      A. no presence for idle.inactivitySeconds  (worker isIdleStopDue)
         then, before B: a tmux session or a terminal running a foreground job in the
         desktop HOLDS the due stop (held_terminal: no marker, no flush) for at most 8 h
         of idle (a lapsed control-plane lease still stops it, about 1 h after the owner
         left); unknown = no hold (worker SIGNAL C, terminal-keepalive.ts; terminal_work)
      B. host 1-min load below idle.load1Busy, strictly parsed; unknown = busy
         (worker CONTAINER_BUSY_LOAD1 / parseLoadAvg1)
      C. a SUCCESSFUL final flush; busy (dpkg/apt lock held in the guest) or stale
         (fenced / lease changed) or failed blocks the stop and the check repeats;
  * honours a control-plane `stop`: warn -> flush (not blockable) -> stop;
  * honours a `fence`: cloudflared stops and the token is wiped, then stop.
Stop = desktop stopped, overlay and data volume unmounted in order (sync), then
cfg.shutdownCmd (`shutdown -h now`). A poweroff that fails is retried with backoff, alternating
with cfg.shutdownFallbackCmd, until one succeeds: the agent never ends while the instance runs
with its tunnel fenced and its volume unmounted. A shutdown that began is resumed by a
restarted agent (runDir/shutdown-pending).

Once the agent commits to stopping, runDir/stopping makes the desktop step refuse, so the
desktop unit's Restart=always cannot bring a desktop back onto a volume being unmounted.
A desktop that exited is restarted by systemd (bounded by its start limit); an `ice` push that
finds it exited or failed makes the agent reset and restart it, at most desktopRestartMax
times per desktopRestartWindowSeconds, after which `desktop_status` says restartsExhausted.

A signed `export` (REVERSE-MOVE-CONTRACT §2.5) persists one reverse-move export job per host and
answers at once; a worker thread stops the desktop (runDir/export-quiesce, and its unit) and captures
/workspace with the Worker's codec in a throwaway container (export.py). The edge serves the
result from disk. While the job captures, and for 15 min after the Worker's last GET once it is
ready, it holds an otherwise-due idle stop (never past 185 min after the job started).
runDir/export-quiesce refuses only the desktop step (and this agent's own desktop restarts): it is
never runDir/stopping, which would also refuse a restarted edge or cloudflared mid-export, and the
idle tick's blocked-flush path, which clears runDir/stopping, never clears it.

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

from . import canary, desktop, export, guard, storage, terminal_work, tunnel
from .fsops import DIR_FLAGS, Refused, open_dir_below, write_file_durable_at

LOAD_RE = re.compile(r"^\d+(\.\d+)?$")
MAX_PAST = 120        # seconds a request may be old
MAX_FUTURE = 5        # seconds of clock skew tolerated ahead of this host
MAX_WARN = 900        # a control-plane stop warns for at most 15 minutes
STOP_RANK = {"absent": 0, "clean": 1, "killed": 2}
SHUTDOWN_PENDING = "shutdown-pending"      # runDir: a shutdown began; a restarted agent resumes it
UNIT_STATES = ("active", "activating", "deactivating", "reloading", "inactive", "failed")
STALLED_UNIT_STATES = ("inactive", "failed")   # exited after running, or failed: nothing will start it
# An export stops the desktop UNIT, not only its container: on an export boot no relay config ever
# arrives (§4.1), so the desktop step may still sit in its bounded relay wait, which no
# runDir/stopping check interrupts, and would start runc mid-capture. Bounded by TimeoutStopSec.
DESKTOP_STOP_CMD = ("/usr/bin/systemctl", "stop", "ezil-desktop.service")
DESKTOP_STOP_TIMEOUT = 150
# runDir markers under which this agent never restarts the desktop: a committed stop, a shutdown
# begun, and a reverse-move export's quiesce (§2.5 step 3).
DESKTOP_DOWN_MARKERS = (desktop.STOPPING, SHUTDOWN_PENDING, desktop.EXPORT_QUIESCE)


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
    def __init__(self, cfg, lease, clock=time.time, log=lambda m: print(m, flush=True), sleep=time.sleep):
        self.cfg, self.lease, self.clock, self.log, self.sleep = cfg, lease, clock, log, sleep
        self.desktop_restarts = []            # when this agent restarted the desktop (bounded)
        self.last_presence = clock()          # boot counts as activity
        self.stop_request = None
        self.restart_request = False          # a relay config for a desktop started without one
        self.stop_outcome = None              # worst desktop.stop() outcome seen this boot
        self.lock = threading.Lock()
        with open(os.path.join(cfg.stateDir, "control.key"), "rb") as f:
            self.key = f.read()
        self.last_seq = self._load_seq()
        self.restart_in_progress = False
        self.restart_ids = []
        self._load_restart_requests()
        self.export_thread = None             # the one reverse-move export job (export.Job)
        self.storage_stop = threading.Event()  # ends the periodic storage sampler (storage.Sampler)

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
        elif op == "restart-desktop":
            request_id = msg.get("requestId")
            if not isinstance(request_id, str) or len(request_id) != 64 or any(c not in "0123456789abcdef" for c in request_id):
                return {"ok": False, "error": "restart_unavailable"}
        elif op == "export":
            # Closed field set; the ids are lowercase UUIDs (the edge maps the body's generation).
            if (set(msg) != export.MESSAGE_KEYS or not export.valid_id(msg.get("moveId"))
                    or not export.valid_id(msg.get("importGeneration"))):
                return {"ok": False, "error": "export_invalid"}
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
            if op == "restart-desktop":
                return self._accept_restart(msg["requestId"], now)
            if op == "export":
                return self._accept_export(msg["moveId"], msg["importGeneration"], now)
            if op == "stop":
                self.stop_request = {"kind": "stop", "warn": warn, "reason": str(msg.get("reason", "control_plane"))[:64]}
                return {"ok": True}
            tunnel.fence(self.cfg, f"fence:{str(msg.get('newEpoch'))[:32]}")
            self.stop_request = {"kind": "fence", "warn": 0, "reason": "fence"}
            return {"ok": True}

    def _restart_path(self):
        return os.path.join(self.cfg.stateDir, "desktop-restart-requests.json")

    def _load_restart_requests(self):
        try:
            with open(self._restart_path()) as f:
                record = json.load(f)
        except FileNotFoundError:
            return
        # A corrupt journal must not silently forget acknowledged requests.
        if record.get("leaseEpoch") != self.lease["leaseEpoch"]:
            return
        ids = record.get("ids")
        if not isinstance(ids, list) or len(ids) > 128 or any(
                not isinstance(i, str) or len(i) != 64 or any(c not in "0123456789abcdef" for c in i) for i in ids):
            raise ValueError("invalid desktop restart journal")
        self.restart_ids = ids
        self.restart_request = record.get("pending") is True

    def _save_restart_requests(self, ids, pending):
        from .enroll import _write_private
        _write_private(self._restart_path(), json.dumps({
            "leaseEpoch": self.lease["leaseEpoch"], "ids": ids, "pending": pending,
        }).encode())

    def _accept_restart(self, request_id, now):
        """Lock held. Deduplicate retries across ticks and agent restarts within this epoch.
        Only the desktop unit is queued; never stop the host, unmount data or kill host tmux.
        The bounded journal refuses new IDs when full, retaining all acknowledged IDs."""
        unavailable = {"ok": False, "error": "restart_unavailable"}
        if self.stop_request or any(os.path.exists(self._marker(m)) for m in DESKTOP_DOWN_MARKERS):
            return unavailable
        if request_id in self.restart_ids:
            return {"ok": True, "state": "restart_requested"}
        if len(self.restart_ids) >= 128:
            return unavailable
        pending = self.restart_request or self.restart_in_progress
        if not pending and (self._restarts_exhausted(now) or self._desktop_unit() not in ("active", "inactive", "failed")):
            return unavailable
        ids = self.restart_ids + [request_id]
        try:
            self._save_restart_requests(ids, True)
        except OSError:
            return unavailable
        self.restart_ids = ids
        if not self.restart_in_progress:
            self.restart_request = True
        return {"ok": True, "state": "restart_requested"}

    def _accept_export(self, move_id, import_generation, now):
        """Lock held. Validate, persist, answer: never wait for the stop or the capture (the
        socket has one thread and a 5 s client timeout). The same ids resume or report. A host
        that committed to stopping answers `stopping` (the edge's retryable 503): no job may
        start a container that binds /workspace while the quiesce unmounts it. runDir/export-quiesce
        is not that: the export's own desktop stop sets it, and its re-POSTs must report."""
        if self._host_stopping():
            return {"ok": False, "error": "stopping"}
        accepted = export.accept(self.cfg, move_id, import_generation, now)
        if accepted == "busy":
            return {"ok": False, "error": "export_busy"}
        if accepted == "unreadable":
            # Not the message's fault and not another move's: the edge answers a retryable 503.
            return {"ok": False, "error": "export_state_unreadable"}
        self._start_export()
        return {"ok": True}

    def _host_stopping(self):
        """A control-plane stop or fence was accepted, or a shutdown began (it sets
        shutdown-pending before its quiesce; an idle stop sets it too)."""
        return bool(self.stop_request) or os.path.exists(self._marker(SHUTDOWN_PENDING))

    def _start_export(self):
        """Start the job's worker thread unless it already runs (one job per host). The job
        itself does nothing unless the record is still `capturing`."""
        if self.export_thread is not None and self.export_thread.is_alive():
            return
        job = export.Job(self.cfg, self.lease, self._export_stop_desktop, log=self.log, clock=self.clock,
                         stopping=self._host_stopping)
        self.export_thread = threading.Thread(target=job.run, name="ezil-export", daemon=True)
        self.export_thread.start()

    def _export_stop_desktop(self):
        """§2.5 step 3 (r7): stop the desktop under the export's own quiesce marker,
        runDir/export-quiesce (the desktop unit's Restart= then refuses, exit 2), stop the unit
        itself (bounded), and confirm both are down. Never runDir/stopping: that marker also
        refuses a restarted edge or cloudflared, which serve this export's chunks."""
        self._set_marker(desktop.EXPORT_QUIESCE)
        try:
            subprocess.run(list(DESKTOP_STOP_CMD), timeout=DESKTOP_STOP_TIMEOUT, check=False,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError) as e:
            self.log(f"export: desktop unit stop failed: {type(e).__name__}")
        try:
            self._note_stop(desktop.stop(self.cfg, grace=float(self.cfg.idle["flushTimeoutSeconds"])))
        except (OSError, ValueError, subprocess.SubprocessError) as e:
            self.log(f"export: desktop stop failed: {type(e).__name__}")
            return False
        # pending (its start job still queued) is down too: the step refuses on runDir/export-quiesce.
        return self._desktop_state() == "absent" and self._desktop_unit() in ("inactive", "failed", "pending")

    def _desktop_state(self):
        try:
            return desktop.state(self.cfg)
        except (OSError, ValueError, subprocess.SubprocessError):
            return "unknown"

    def _desktop_unit(self):
        """The desktop unit's systemd state: active | activating | deactivating | reloading |
        pending (inactive, never started this boot: its start job still waits) | inactive (it
        ran and exited) | failed | unknown."""
        try:
            r = subprocess.run(list(self.cfg.desktopUnitStateCmd), capture_output=True, text=True, timeout=5)
        except (OSError, subprocess.SubprocessError):
            return "unknown"
        if r.returncode != 0:
            return "unknown"
        props = dict(line.split("=", 1) for line in r.stdout.splitlines() if "=" in line)
        state = props.get("ActiveState", "").strip()
        if state not in UNIT_STATES:
            return "unknown"
        if state == "inactive" and props.get("ExecMainStartTimestampMonotonic", "").strip() in ("", "0"):
            return "pending"
        return state

    def _restarts_exhausted(self, now):
        window = float(self.cfg.get("desktopRestartWindowSeconds", 600))
        self.desktop_restarts = [t for t in self.desktop_restarts if now - t < window]
        return len(self.desktop_restarts) >= int(self.cfg.get("desktopRestartMax", 3))

    def _accept_relay(self, relay_config):
        """GW-5 `ice` (lock held): store the per-epoch relay config in runDir (tmpfs) for the
        desktop step. A desktop that is already running WITH a relay keeps it (renewal goes
        through neko's /api/relay in place); one that started WITHOUT a relay (the bounded
        wait timed out) is restarted so it picks the config up. A desktop that is not running
        and that nothing will start (its unit exited or failed: a crash) is reset and
        restarted, bounded; once the bound is reached the push is refused, never `accepted`."""
        try:
            desktop.write_desktop_config(self.cfg, relay_config)
        except (OSError, Refused):
            return {"ok": False, "error": "ice_store_failed"}
        if self._desktop_state() != "running":
            if self._desktop_unit() not in STALLED_UNIT_STATES:
                return {"ok": True, "state": "accepted"}
            if self._restarts_exhausted(self.clock()):
                return {"ok": False, "error": "desktop_restart_exhausted"}
            self.restart_request = True
            return {"ok": True, "state": "restart_scheduled"}
        if desktop.read_ice_state(self.cfg) == "applied" and (not relay_config.get("ai") or desktop.ai_configured(self.cfg)):
            return {"ok": True, "state": "already_running"}
        self.restart_request = True
        return {"ok": True, "state": "restart_scheduled"}

    def _desktop_status(self, now):
        """GW-5 `desktop` (lock held): whether an unexpired config is held for this epoch, how
        the desktop runs, its unit's state and whether the agent's restarts are exhausted.
        Never the config itself."""
        c = desktop.read_desktop_config(self.cfg, int(now * 1000))
        result = {"ok": True, "configured": c is not None, "expiresAt": c["expiresAt"] if c else None,
                "bootId": desktop.host_boot_id(), "aiConfigured": desktop.ai_configured(self.cfg),
                "desktop": self._desktop_state(), "ice": desktop.read_ice_state(self.cfg),
                "unit": self._desktop_unit(), "restartsExhausted": self._restarts_exhausted(now)}
        from . import pool
        if os.path.lexists(os.path.join(self.cfg.stateDir, pool.EPOCH_FILE)):
            result["sessionReady"] = c is not None and pool.session_ready(self.cfg, self.lease)
            if result["desktop"] == "running" and not result["sessionReady"]:
                result["desktop"] = "starting"
        return result

    def restart_desktop(self):
        """Restart the desktop through its unit: a relay config arrived after it started
        without one, or it exited and nothing would start it. reset-failed first, so a unit
        stopped by its start limit can start again. ExecStop stops a running desktop the
        normal way (terminal shells hung up first); the desktop step then starts it with the
        stored config. Non-blocking; counted against desktopRestartMax."""
        self.log("desktop restart: through its unit (signed request, relay config, or desktop exit)")
        with self.lock:
            self.desktop_restarts.append(self.clock())
        for cmd in (self.cfg.get("desktopResetCmd"), self.cfg.desktopRestartCmd):
            if not cmd:
                continue
            try:
                subprocess.run(list(cmd), timeout=30, check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            except (OSError, subprocess.SubprocessError) as e:
                self.log(f"desktop restart step failed: {type(e).__name__}")

    def _marker(self, name):
        return os.path.join(self.cfg.runDir, name)

    def _set_marker(self, name):
        from .enroll import _write_private
        _write_private(self._marker(name), b"1\n")

    def _clear_marker(self, name):
        try:
            os.unlink(self._marker(name))
        except FileNotFoundError:
            pass

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
        stop_sampler = getattr(self, "storage_stop", None)
        if stop_sampler is not None:
            stop_sampler.set()               # no periodic sample races the quiesce below
        for name in (desktop.STOPPING, SHUTDOWN_PENDING):
            try:
                self._set_marker(name)       # no desktop may start; a restarted agent resumes
            except OSError as e:
                self.log(f"shutdown marker {name} failed: {type(e).__name__}")
        tunnel.fence(self.cfg, why)          # cloudflared stops and wipes its token
        time.sleep(1.0)
        # Ordered quiesce. Each step is attempted even if an earlier one failed: the OS
        # shutdown that follows must happen regardless (it also unmounts).
        quiesce_ok = True
        for name, fn in (("desktop", lambda: self._note_stop(desktop.stop(self.cfg))),
                         ("export", lambda: export.remove_container(self.cfg)),   # it binds /workspace
                         ("record", lambda: self.record_stop(why)),
                         ("overlay", lambda: desktop.overlay_umount(self.cfg)),
                         ("sync", lambda: subprocess.run(["sync"], check=True)),
                         # Synced, still mounted and stamped: the final size. Bounded, never raises.
                         ("storage", self._storage_stop_sample),
                         ("stamp", lambda: guard.clear_stamp(self.cfg)),
                         ("data", lambda: subprocess.run(["umount", self.cfg.dataMount], check=True)),
                         ("netns", lambda: desktop.netns_down(self.cfg))):
            try:
                fn()
            except Exception as e:  # noqa: BLE001
                quiesce_ok = False
                self.log(f"quiesce step {name} failed: {e}")
        canary.stopped(self.cfg, self.stop_outcome, source="agent", quiesce_ok=quiesce_ok)
        self.power_off()

    def _storage_stop_sample(self):
        """The stop sample (storage.on_stop): at most storageStopBudgetSeconds of wall-clock time, and metering
        only, so nothing here fails the quiesce (an agent without a lease or key skips it)."""
        lease, key = getattr(self, "lease", None), getattr(self, "key", None)
        if isinstance(lease, dict) and key:
            storage.on_stop(self.cfg, lease, key, self.log)

    def power_off(self):
        """Run cfg.shutdownCmd until the OS accepts it. A nonzero exit or a failure to run is
        retried with backoff (initial, doubling, capped at shutdownRetryMaxSeconds),
        alternating with cfg.shutdownFallbackCmd after shutdownFallbackAfter failures. Never
        gives up: the volume is already unmounted and the tunnel fenced, so a running
        instance only bills."""
        delay = float(self.cfg.get("shutdownRetryInitialSeconds", 1))
        cap = float(self.cfg.get("shutdownRetryMaxSeconds", 60))
        after = int(self.cfg.get("shutdownFallbackAfter", 3))
        fallback = self.cfg.get("shutdownFallbackCmd")
        attempt = 0
        while True:
            cmd = self.cfg.shutdownCmd
            if fallback and attempt >= after and (attempt - after) % 2 == 0:
                cmd = fallback
            attempt += 1
            try:
                rc = subprocess.run(list(cmd), timeout=60).returncode
            except (OSError, subprocess.SubprocessError) as e:
                rc = type(e).__name__
            if rc == 0:
                if attempt > 1:
                    self.log(f"poweroff accepted after {attempt} attempts")
                return attempt
            self.log(f"poweroff failed (attempt {attempt}: {rc}); retrying in {delay:g}s")
            self.sleep(delay)
            delay = min(delay * 2, cap)

    # ------------------------------------------------------------------- loop
    def _terminal_hold(self, idle_seconds):
        """SIGNAL C: does terminal work in the running desktop hold this otherwise-due idle
        stop? Probed only once idle is due. Never raises: an exception escaping tick() ends
        the agent, systemd restarts it and the new agent counts boot as presence, so a crash
        loop would never idle-stop, the opposite of "unknown means no hold". Any failure
        here, even of the log line, is no hold."""
        try:
            if self._desktop_state() != "running":
                keep_alive, work, reason = False, None, "desktop_not_running"
            else:
                keep_alive, work, reason = terminal_work.verdict(terminal_work.probe(self.cfg), idle_seconds)
            if keep_alive:
                t, j = work
                self.log(f"idle stop held: tmuxSessions/terminalJobs={t}/{j} reason={reason} idle={int(idle_seconds)}s")
            elif reason != "no_terminal_work":
                counts = f"{work[0]}/{work[1]}" if work is not None else None
                self.log(f"terminal hold: none (tmuxSessions/terminalJobs={counts or 'unknown'} reason={reason})")
            return keep_alive
        except Exception:  # noqa: BLE001 — a crash must not renew presence on restart
            return False

    def tick(self):
        with self.lock:
            req = self.stop_request
            restart, self.restart_request = self.restart_request and not req, False
            # A persisted pending request cannot undo a committed shutdown after a crash, and no
            # restart (an `ice` push included) brings the desktop back during an export.
            if any(os.path.exists(self._marker(m)) for m in DESKTOP_DOWN_MARKERS):
                restart = False
            self.restart_in_progress = bool(restart)
        if restart:
            try:
                self.restart_desktop()
            finally:
                with self.lock:
                    self.restart_in_progress = False
                    if self.restart_ids:
                        self._save_restart_requests(self.restart_ids, False)
            return "restarting"
        if req:
            self._set_marker(desktop.STOPPING)     # committed: no desktop may start again
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
            held = export.holds_idle(self.cfg, now)
        except Exception:  # noqa: BLE001 — as for the terminal hold: a crash must not renew presence
            held = False
        if held:
            self.log(f"idle stop held: export idle={int(now - self.last_presence)}s")
            return "held_export"
        if self._terminal_hold(now - self.last_presence):
            return "held_terminal"
        # The probe can take up to 30 s; a user who came back meanwhile is present again.
        if not idle_due(self.last_presence, self.clock(), self.cfg.idle["inactivitySeconds"]):
            return "active"
        try:
            with open("/proc/loadavg") as f:
                load1 = parse_load1(f.read())
        except OSError:
            load1 = None
        if load1 is None or load1 >= self.cfg.idle["load1Busy"]:
            return "busy_load"
        self._set_marker(desktop.STOPPING)         # the desktop's Restart= must not undo the flush
        res = self.flush(blockable=True)
        if res not in ("ok", "unclean"):
            self._clear_marker(desktop.STOPPING)   # not stopping after all: the desktop may start
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
        if os.path.exists(self._marker(SHUTDOWN_PENDING)):
            # A previous agent began a shutdown and ended before the OS accepted the poweroff
            # (it crashed, or was restarted): finish it. Every quiesce step tolerates having run.
            self.shutdown("resume: a shutdown was in progress")
            return
        try:
            if export.pending(self.cfg):
                self.log("export: resuming a capture this agent did not finish")
                self._start_export()
        except Exception as e:  # noqa: BLE001 — a bad export record must never stop the agent
            self.log(f"export: resume failed: {type(e).__name__}")
        ev = threading.Event()
        t = threading.Thread(target=self.serve, args=(ev,), daemon=True)
        t.start()
        self._start_storage_sampler()
        try:
            while True:
                if self.tick() == "stopped":
                    return
                time.sleep(self.cfg.idle["intervalSeconds"])
        finally:
            ev.set()
            self.storage_stop.set()

    def _start_storage_sampler(self):
        """The periodic storage sample (storage.py) on its own daemon thread. Metering only: a
        lease without a computer, no app origin or a failure here never stops the agent."""
        try:
            sampler = storage.Sampler(self.cfg, self.lease, self.key, self.log)
            if not sampler.enabled():
                self.log("storage: sampler off (no computer, app origin or interval)")
                return None
            th = threading.Thread(target=sampler.run, args=(self.storage_stop,), name="ezil-storage", daemon=True)
            th.start()
            return th
        except Exception as e:  # noqa: BLE001
            self.log(f"storage: sampler not started: {type(e).__name__}")
            return None


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
