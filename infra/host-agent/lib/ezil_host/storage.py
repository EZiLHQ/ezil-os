"""Storage sampler (docs/billing/CONTRACT.md §3.2): the used bytes of this computer's retained
data volume, measured by the HOST, outside the guest container, and posted to the app every
storageSampleSeconds (15 min; the first storageFirstSampleSeconds after the agent starts) and
once on stop.

  * The meter is statvfs's used blocks, (f_blocks - f_bfree) * f_frsize, of the data volume.
    It is O(1) and counts what the filesystem allocated: nothing is traversed, so guest
    symlinks, hardlinks, deep trees or races cannot hide or double-count bytes. The volume
    holds /workspace, HOME, the overlay upper and the profiles (editor and chat state), so
    each is counted once. The host root disk, checkpoints and snapshots are not on it.
  * Only the volume THIS lease's guard mounted is measured: dataMount must be a mountpoint
    and runDir/guard-ok must name this lease's (generation, leaseEpoch). An unmounted
    mountpoint would silently report the host root disk instead.
  * The credential is the epoch's control key (stateDir/control.key, host-only, the agent's
    in-memory copy): X-Ezil-Signature = v1=HMAC-SHA256(key,
    "ezil-storage-sample-v1|ts|computerId|generation|leaseEpoch|sha256hex(body)") with the
    epoch in X-Ezil-Computer-Id / X-Ezil-Generation / X-Ezil-Lease-Epoch and X-Ezil-Timestamp
    (app: billing/http/host-storage.ts). The body names no computer or user. The key never
    enters the container.
  * Posting never blocks a lifecycle operation. Periodic samples run on their own daemon
    thread; transport errors, 429 and 5xx are retried with backoff (1 s doubling to 30 s)
    inside one interval, re-signed each time over the same body (the app is idempotent on
    measuredAt). The stop sample has a hard wall-clock budget (storageStopBudgetSeconds):
    it runs on its own daemon thread and the shutdown waits for it at most that long, so a
    DNS lookup, a stalled handshake or a trickled reply (each bounded only per socket
    operation, if at all) cannot hold the unmount. It never raises. Any other answer is final
    for that sample; the next interval measures again.
    The app refuses a stop sample once a control-plane stop began (it cleared the key's
    proof at DRAINING); the last periodic sample then stands.
"""
from http.client import HTTPException
import hashlib
import hmac
import json
import os
import re
import threading
import time

from . import guard, http, pool
from .fsops import Refused

MAC_INFO = "ezil-storage-sample-v1"
PATH = "/api/compute/aws/storage"
UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")


def used_bytes(path, statvfs=os.statvfs):
    """Used bytes as df reports them: allocated blocks, root-reserved free blocks excluded."""
    st = statvfs(path)
    return max(0, (st.f_blocks - st.f_bfree) * st.f_frsize)


def _guarded(cfg, lease):
    """True only while runDir/guard-ok names this lease's epoch. The stamp is the guard's full
    marker (guard.new_marker: computerId, volumeId, fsUuid, generation, leaseEpoch, ...), so
    its epoch keys are compared, as guard.committed_digest does, and its computer when named."""
    try:
        with open(os.path.join(cfg.runDir, "guard-ok"), encoding="utf-8") as f:
            stamp = json.load(f)
    except (OSError, ValueError):
        return False
    if not isinstance(stamp, dict) or any(stamp.get(k) != lease.get(k) or lease.get(k) is None for k in ("generation", "leaseEpoch")):
        return False
    return "computerId" not in stamp or str(stamp["computerId"]).lower() == str(lease.get("computerId", "")).lower()


def measure(cfg, lease, is_mounted=guard.is_mounted, statvfs=os.statvfs):
    """The data volume's used bytes, or None when it is not this lease's guarded mount."""
    try:
        if not _guarded(cfg, lease) or not is_mounted(cfg.dataMount):
            return None
        return used_bytes(cfg.dataMount, statvfs)
    except OSError:
        return None


def identity(lease):
    """(computerId, generation, leaseEpoch) of an enrolled computer's lease, or None."""
    cid, gen, epoch = lease.get("computerId"), lease.get("generation"), lease.get("leaseEpoch")
    if not isinstance(cid, str) or not UUID_RE.fullmatch(cid.lower()):
        return None
    for n in (gen, epoch):
        if not isinstance(n, int) or isinstance(n, bool) or not 1 <= n <= 2147483647:
            return None
    return cid.lower(), gen, epoch


def endpoint(cfg, lease):
    """The app origin this host enrolled with (pool.app_origin's rule) + PATH, or None. A
    pool-claimed computer's lease.json is claim-shaped (no appOrigin): the origin its pool
    record saved for THIS claim is the one it enrolled with."""
    try:
        record = pool.read_record(cfg)
    except (Refused, OSError):
        record = None
    if (isinstance(record, dict) and record.get("appOrigin") and not lease.get("appOrigin")
            and all(record["claim"].get(k) == lease.get(k) for k in ("computerId", "generation", "leaseEpoch"))):
        lease = dict(lease, appOrigin=record["appOrigin"])
    try:
        return pool.app_origin(cfg, lease) + PATH
    except Refused:
        return None


def iso(ts):
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(int(ts)))


def body(n, measured_at, reason):
    return json.dumps({"bytes": str(int(n)), "measuredAt": iso(measured_at), "reason": reason},
                      separators=(",", ":")).encode()


def sign(key, ts, computer_id, generation, lease_epoch, raw):
    msg = "|".join([MAC_INFO, str(int(ts)), computer_id.lower(), str(generation), str(lease_epoch),
                    hashlib.sha256(raw).hexdigest()])
    return "v1=" + hmac.new(key, msg.encode(), hashlib.sha256).hexdigest()


def post(cfg, lease, key, raw, deadline, request=http.request, sleep=time.sleep, clock=time.time,
         monotonic=time.monotonic):
    """POST one sample until it settles or `deadline` (monotonic) passes. Returns an outcome
    string; never raises and never prints the key or a signature."""
    ident, url = identity(lease), endpoint(cfg, lease)
    if ident is None or url is None:
        return "storage_unconfigured"
    computer_id, generation, lease_epoch = ident
    delay = 1.0
    while True:
        remaining = deadline - monotonic()
        if remaining <= 0:
            return "storage_retry_exhausted"
        ts = int(clock())
        headers = {"Content-Type": "application/json", "Cache-Control": "no-store",
                   "X-Ezil-Computer-Id": computer_id, "X-Ezil-Generation": str(generation),
                   "X-Ezil-Lease-Epoch": str(lease_epoch), "X-Ezil-Timestamp": str(ts),
                   "X-Ezil-Signature": sign(key, ts, computer_id, generation, lease_epoch, raw)}
        try:
            status, resp = request("POST", url, body=raw, headers=headers, timeout=max(0.1, min(10.0, remaining)),
                                   ca_file=cfg.get("caFile"), server_name=cfg.get("tlsServerName"))
        except (OSError, HTTPException, ValueError):
            pass
        else:
            if status == 200:
                try:
                    return "recorded" if json.loads(resp).get("recorded") is True else "duplicate"
                except (ValueError, AttributeError, UnicodeDecodeError):
                    return "recorded"
            if status != 429 and status < 500:
                return f"refused_{status}"   # final: the next interval measures again
        if monotonic() + delay > deadline:
            return "storage_retry_exhausted"
        if sleep(delay):   # the periodic path sleeps on the agent's stop event: set, give up now
            return "storage_stopped"
        delay = min(delay * 2, 30.0)


def sample_once(cfg, lease, key, reason, deadline, *, measure_fn=measure, clock=time.time, **post_kw):
    """Measure now and post it. Returns (outcome, bytes or None). Never raises."""
    try:
        n = measure_fn(cfg, lease)
        if n is None:
            return "not_mounted", None
        return post(cfg, lease, key, body(n, clock(), reason), deadline, clock=clock, **post_kw), n
    except Exception as e:  # noqa: BLE001 — metering must never break the agent or a stop
        return f"error_{type(e).__name__}", None


def on_stop(cfg, lease, key, log, **kw):
    """The stop sample: measured after the desktop stopped and the volume synced, and given
    storageStopBudgetSeconds of wall-clock time. post()'s deadline is checked only between
    attempts and its timeout applies per socket operation (getaddrinfo has none), so the
    sample runs on a daemon thread that this waits for at most the budget. A post still in
    flight then is abandoned: statvfs ran before it and holds nothing open on the volume, so
    the unmount can go ahead, and the thread dies with the power-off. Never raises."""
    budget = max(0.0, float(cfg.get("storageStopBudgetSeconds", 5)))
    done = []

    def run():
        done.append(sample_once(cfg, lease, key, "stop", time.monotonic() + budget, **kw)[0])
    try:
        th = threading.Thread(target=run, name="ezil-storage-stop", daemon=True)
        th.start()
        th.join(budget)
        outcome = done[0] if done else "storage_stop_timeout"
    except Exception as e:  # noqa: BLE001 — metering must never break a stop
        outcome = f"error_{type(e).__name__}"
    try:
        log(f"storage: stop sample {outcome}")
    except Exception:  # noqa: BLE001
        pass
    return outcome


class Sampler:
    """The periodic sampler, on its own daemon thread (Agent.run). `stop` is a threading.Event:
    set, the loop ends at its next wait, including inside a retry backoff."""

    def __init__(self, cfg, lease, key, log, **kw):
        self.cfg, self.lease, self.key, self.log, self.kw = cfg, lease, key, log, kw

    def enabled(self):
        return (float(self.cfg.get("storageSampleSeconds", 900)) > 0 and identity(self.lease) is not None
                and endpoint(self.cfg, self.lease) is not None)

    def run(self, stop):
        interval = float(self.cfg.get("storageSampleSeconds", 900))
        wait = float(self.cfg.get("storageFirstSampleSeconds", 60))
        sleep = lambda s: stop.wait(s)  # noqa: E731 — a backoff wakes on stop
        while not stop.wait(wait):
            # Retries stay inside this interval, so samples never pile up behind a slow app.
            outcome, n = sample_once(self.cfg, self.lease, self.key, "interval", time.monotonic() + interval * 0.8,
                                     sleep=sleep, **self.kw)
            try:
                self.log(f"storage: sample {outcome}" + (f" bytes={n}" if n is not None else ""))
            except Exception:  # noqa: BLE001
                pass
            wait = interval
