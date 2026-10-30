"""Single-use warm hosts. No user disk, tunnel, or control channel before a claim.

The guard unit owns a disposable desktop while it waits. Adoption uses the normal
disk guard and enrollment; the rest of the boot chain opens the user's overlay/home.
The authenticated claim is authority; durable state permits only exact-instance resume.
"""
import base64
import fcntl
from http.client import HTTPException
import json
import os
import re
import shutil
import subprocess
import time
from urllib.parse import urlsplit, urlunsplit

from . import config, desktop, enroll, guard, http, lease as leasemod, rebase
from .fsops import DIR_FLAGS, Refused, read_regular_at

EPOCH_FILE = "pool-epoch.json"       # host root disk; survives reboots, never guest-visible
POLL_SECONDS = 1.0
READY_POLL_SECONDS = 0.25
REFRESH_SECONDS = 300
REFRESH_RETRY_SECONDS = 20
# R2-4: a readiness miss is never fatal. A cold first boot (lazily loaded root volume) can need
# more than one 180 s wait; each retry re-enrolls first, which is this host's liveness for the
# planner's stall rule (ready-pool.ts bootStalled: not ready 5 min after enrolling = dead).
# Bounded: after FIRST_BOOT_READY_ATTEMPTS misses the host waits for a claim unready, its
# refreshes try again, and a host that never gets ready ages past that rule and is retired.
FIRST_BOOT_READY_ATTEMPTS = 2
TIMING_FILE = "pool-session-timing.json"
TIMING_PHASES = ("claimObservedMs", "guardDoneMs", "enrollDoneMs", "warmStoppedMs",
                 "relayAvailableMs", "desktopStartedMs", "desktopHealthyMs")
FENCE_RE = re.compile(r"[A-Za-z0-9_.:-]{1,256}")
SERIAL_RE = re.compile(r"vol-?([0-9a-f]{8,17})")
# C3 (REVERSE-MOVE-CONTRACT §2.8): a claim may carry the migration's restore lease, the same
# RestoreLease the cold provision puts in user data (app provider-migrate.ts restoreLeaseFor), so
# an adopted spare restores the Cloudflare workspace before the marker, exactly as a cold boot.
RESTORE_KEYS = {"kind", "migrationId", "generation", "system", "fetchBase", "identityToken"}
RESTORE_TOKEN_RE = re.compile(r"[A-Za-z0-9_-]{43}")


def parse_restore(r, computer_id, origin=None):
    """The claim's restore lease, closed; the token is never echoed. fetchBase is the app's
    restore route for THIS computer, over https (restore.http_fetch requires it), and on the
    pool's own app origin when that is known."""
    if (not isinstance(r, dict) or set(r) != RESTORE_KEYS or r["kind"] != "cf-snapshot" or type(r["system"]) is not bool
            or not all(isinstance(r[k], str) and leasemod.POOL_UUID_RE.fullmatch(r[k]) for k in ("migrationId", "generation"))
            or not isinstance(r["identityToken"], str) or not RESTORE_TOKEN_RE.fullmatch(r["identityToken"])
            or not isinstance(r["fetchBase"], str) or len(r["fetchBase"]) > 512):
        raise Refused("pool_claim_invalid", "restore")
    try:
        url = urlsplit(r["fetchBase"])
        ok = (url.scheme == "https" and url.hostname and not url.username and not url.password and not url.query
              and not url.fragment and url.path == "/api/compute/restore/" + computer_id
              and not any(ord(c) <= 32 for c in r["fetchBase"]))
        url.port
    except ValueError:
        ok = False
    if not ok or (origin is not None and urlunsplit((url.scheme, url.netloc, "", "", "")) != origin):
        raise Refused("pool_claim_invalid", "restore fetchBase")
    return dict(r)


def parse_claim(raw, *, require_nonce=True, origin=None):
    try:
        claim = leasemod.strict_json(raw)
    except (ValueError, UnicodeDecodeError, TypeError, RecursionError) as e:
        raise Refused("pool_claim_malformed") from e
    if not isinstance(claim, dict):
        raise Refused("pool_claim_malformed")
    if not isinstance(claim.get("computerId"), str) or not leasemod.UUID_RE.fullmatch(claim["computerId"]):
        raise Refused("pool_claim_invalid", "computerId")
    for field in ("generation", "leaseEpoch"):
        value = claim.get(field)
        if type(value) is not int or not 1 <= value <= 2147483647:
            raise Refused("pool_claim_invalid", field)
    for field, pattern in (("fence", FENCE_RE), ("volumeSerial", SERIAL_RE),
                           ("enrollNonce", leasemod.NONCE_RE), ("fsUuid", leasemod.UUID_RE)):
        if field not in claim and (field == "fsUuid" or (field == "enrollNonce" and not require_nonce)):
            continue
        if not isinstance(claim.get(field), str) or not pattern.fullmatch(claim[field]):
            raise Refused("pool_claim_invalid", field)
    if "createVolume" in claim and type(claim["createVolume"]) is not bool:
        raise Refused("pool_claim_invalid", "createVolume")
    if claim.get("createVolume") and "fsUuid" not in claim:
        raise Refused("pool_claim_invalid", "createVolume requires fsUuid")
    if "restore" in claim:
        # The guard restores only into a fresh volume (its marker-less init path).
        if claim.get("createVolume") is not True:
            raise Refused("pool_claim_invalid", "restore requires createVolume")
        claim["restore"] = parse_restore(claim["restore"], claim["computerId"], origin)
    if "claimPublishedAtMs" in claim:
        published = claim["claimPublishedAtMs"]
        if type(published) not in (int, float) or not 0 <= published <= 4102444800000:
            raise Refused("pool_claim_invalid", "claimPublishedAtMs")
    # Unknown response fields cannot override local paths, authority or device identity.
    return {k: claim[k] for k in ("computerId", "generation", "leaseEpoch", "fence", "volumeSerial", "enrollNonce",
                                  "fsUuid", "createVolume", "claimPublishedAtMs", "restore") if k in claim}


def timing(cfg, phase=None, claim=None):
    """Boot-local monotonic milliseconds, shared by guard and desktop units.

    tmpfs avoids mixing monotonic clocks across reboots. Never copy claim material
    into telemetry; publication time is the sole optional wall-clock value.
    """
    path = os.path.join(cfg.runDir, TIMING_FILE)
    try:
        with open(path, encoding="utf-8") as f:
            values = json.load(f)
    except (OSError, ValueError):
        values = {}
    keys = (*TIMING_PHASES, "claimPublishedAtMs")
    values = {k: v for k, v in values.items() if k in keys and type(v) in (int, float)
              and 0 <= v <= 9007199254740991} if isinstance(values, dict) else {}
    if phase is not None:
        values.setdefault(phase, round(time.monotonic() * 1000))
        if claim is not None:
            published = claim.get("claimPublishedAtMs")
            if type(published) in (int, float) and 0 <= published <= 4102444800000:
                values["claimPublishedAtMs"] = published
        enroll._write_private(path, json.dumps(values).encode())
    return values


def app_origin(cfg, lease):
    url = lease.get("appOrigin") or cfg.enrollUrl
    try:
        parsed = urlsplit(url)
        if (parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password
                or parsed.query or parsed.fragment):
            raise ValueError
        if lease.get("appOrigin") and parsed.path not in ("", "/"):
            raise ValueError
        return urlunsplit((parsed.scheme, parsed.netloc, "", "", ""))
    except (ValueError, TypeError, AttributeError) as e:
        raise Refused("pool_app_origin_invalid") from e


class Client:
    def __init__(self, cfg, lease):
        self.cfg, self.lease = cfg, lease
        self.origin = app_origin(cfg, lease)
        with open(os.path.join(cfg.runDir, "identity.json"), encoding="utf-8") as f:
            self.identity = json.load(f)

    def request(self, method, endpoint, payload=None, *, retry_seconds=None):
        headers = {
            "Accept": "application/json", "Cache-Control": "no-store",
            "X-Ezil-Pool-Host-Id": self.lease["poolHostId"],
            "X-Ezil-Pool-Generation": str(self.lease["poolGeneration"]),
            "X-Ezil-Identity-Document": base64.b64encode(self.identity["document"].encode()).decode(),
            "X-Ezil-Identity-Signature": "".join(self.identity["signature"].split()),
        }
        body = None
        if payload is not None:
            headers["Content-Type"] = "application/json"
            body = json.dumps(payload).encode()
        budget = float(self.cfg.get("enrollRetrySeconds", 540))
        if retry_seconds is not None:
            budget = min(budget, retry_seconds)
        deadline = time.monotonic() + budget
        delay = 1.0
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise Refused("pool_retry_exhausted", endpoint)
            try:
                status, response = http.request(method, self.origin + "/api/compute/aws/pool/" + endpoint,
                                                body=body, headers=headers, timeout=min(20, remaining),
                                                ca_file=self.cfg.caFile, server_name=self.cfg.tlsServerName)
            except (OSError, HTTPException):
                pass
            else:
                if status in (200, 204):
                    return status, response
                if status != 429 and not enroll.retryable(status, response):
                    # Do not echo server bodies: they can contain identity/claim material.
                    raise Refused("pool_request_refused", f"{endpoint} HTTP {status}")
            if time.monotonic() + delay > deadline:
                raise Refused("pool_retry_exhausted", endpoint)
            time.sleep(delay)
            delay = min(delay * 2, 30.0)

    def enroll(self, *, retry_seconds=None):
        status, _ = self.request("POST", "enroll", {
            "poolHostId": self.lease["poolHostId"], "poolGeneration": self.lease["poolGeneration"],
            "identityDocument": self.identity["document"], "signature": self.identity["signature"],
        }, retry_seconds=retry_seconds)
        if status != 200:
            raise Refused("pool_enroll_invalid_status")

    def ready(self, health, *, retry_seconds=None):
        self.request("POST", "ready", {"poolHostId": self.lease["poolHostId"],
                                       "health": {"editorOk": health["ok"]}}, retry_seconds=retry_seconds)

    def claim(self):
        status, body = self.request("GET", "claim")
        return None if status == 204 else parse_claim(body, origin=self.origin)


def read_record(cfg):
    try:
        root = os.open(cfg.stateDir, DIR_FLAGS)
    except FileNotFoundError:
        return None
    try:
        try:
            st = os.stat(EPOCH_FILE, dir_fd=root, follow_symlinks=False)
        except FileNotFoundError:
            return None
        try:
            record = leasemod.strict_json(read_regular_at(root, EPOCH_FILE, st, limit=65536))
            if record["phase"] not in ("reserved", "guarding", "enrolled", "switched", "failed"):
                raise ValueError
            record["claim"] = parse_claim(json.dumps(record["claim"]),
                                         require_nonce=record["phase"] in ("reserved", "guarding"),
                                         origin=record.get("appOrigin"))
            leasemod.parse(json.dumps({"kind": "pool", "poolHostId": record["poolHostId"],
                                      "poolGeneration": record["poolGeneration"]}))
            if not isinstance(record["instanceId"], str) or not record["instanceId"]:
                raise ValueError
            if "lease" in record:
                saved = leasemod.parse(json.dumps({k: v for k, v in record["lease"].items()
                                                   if k in leasemod.LEASE_KEYS}))
                if (any(saved[k] != record["claim"][k] for k in ("computerId", "generation", "leaseEpoch"))
                        or saved["volumeId"].replace("-", "") != record["claim"]["volumeSerial"].replace("-", "")):
                    raise ValueError
        except (ValueError, TypeError, KeyError, AttributeError, RecursionError, leasemod.LeaseError, Refused) as e:
            raise Refused("pool_epoch_malformed") from e
        return record
    finally:
        os.close(root)


def save_record(cfg, record):
    enroll._write_private(os.path.join(cfg.stateDir, EPOCH_FILE), json.dumps(record).encode())


def reserve_claim(cfg, pool_lease, claim):
    """Caller holds the adoption lock. Never accept a second claim on this host."""
    claim = parse_claim(json.dumps(claim))
    previous = read_record(cfg)
    if previous is not None:
        if (claim["generation"] <= previous["claim"]["generation"]
                or claim["leaseEpoch"] <= previous["claim"]["leaseEpoch"]):
            raise Refused("epoch_not_increasing")
        raise Refused("pool_host_already_claimed")
    instance_id = guard.current_instance_id(cfg)
    if not instance_id:
        raise Refused("pool_instance_missing")
    record = dict(poolHostId=pool_lease["poolHostId"], poolGeneration=pool_lease["poolGeneration"],
                  instanceId=instance_id, claim=dict(claim), phase="reserved",
                  appOrigin=app_origin(cfg, pool_lease))
    save_record(cfg, record)
    return record


def computer_lease(cfg, claim):
    # The EC2 attachment name (/dev/sdf) is deliberately irrelevant here.
    volume_id = "vol-" + SERIAL_RE.fullmatch(claim["volumeSerial"])[1]
    device = guard.wait_device_for_volume(cfg, volume_id)
    observed_uuid = guard.fs_uuid(device)
    fs_uuid = claim.get("fsUuid") or observed_uuid
    if observed_uuid is None:
        if not claim.get("createVolume") or not fs_uuid:
            raise Refused("pool_volume_unformatted")
        # blkid probes every signature (including filesystems without UUIDs and partition tables).
        probe = subprocess.run(["blkid", "-p", "-o", "export", device], capture_output=True, text=True)
        if probe.returncode != 2 or probe.stdout.strip():
            raise Refused("pool_volume_has_signature")
    lease = {"v": 1, "computerId": claim["computerId"], "generation": claim["generation"],
             "leaseEpoch": claim["leaseEpoch"], "volumeId": volume_id, "fsUuid": fs_uuid,
             "provision": claim.get("createVolume", False)}
    if "enrollNonce" in claim:
        lease["nonce"] = claim["enrollNonce"]
    if "restore" in claim:
        lease["restore"] = dict(claim["restore"])   # guard.run_guard restores before the marker
    return leasemod.parse(json.dumps(lease))


def warm_config(cfg):
    warm = config.Config(dict(cfg))
    warm.update(runDir=os.path.join(cfg.runDir, "pool-desktop"),
                dataMount=os.path.join(cfg.stateDir, "pool-desktop"),
                containerId=cfg.containerId + "-pool", cgroupsPath=cfg.cgroupsPath + "-pool",
                iceMode="local", canaryConsole=False)
    return warm


def start_warm(cfg, pool_lease):
    os.makedirs(cfg.stateDir, mode=0o700, exist_ok=True)
    os.chmod(cfg.stateDir, 0o700)
    os.makedirs(cfg.dataMount, mode=0o700, exist_ok=True)
    root = os.open(cfg.dataMount, DIR_FLAGS)
    try:
        for path in ("root/upper", "root/work", "workspace", "profiles", *guard.GUEST_LAYOUT):
            guard._mkdirs_nofollow(root, path)
    finally:
        os.close(root)
    desktop.overlay_mount(cfg)
    desktop.netns_up(cfg)
    desktop.build_spec(cfg, {"generation": pool_lease["poolGeneration"], "leaseEpoch": 0})
    if desktop.run(cfg, detach=True, log=os.path.join(cfg.runDir, "desktop.log")) != 0:
        raise Refused("pool_desktop_start_failed")


def health(cfg):
    if desktop.state(cfg) != "running":
        return {"ok": False, "desktop": False, "editor": False}
    # Probe from the guest namespace, with bounded requests. Neko starts only
    # after its mandatory-app gate; the editor must also answer now, not just
    # have emitted a ready log line earlier in the boot.
    results = []
    for url in ("http://127.0.0.1:8181/", "http://127.0.0.1:8443/healthz"):
        result = desktop.exec_(cfg, ["curl", "--fail", "--silent", "--max-time", "2", url],
                               capture_output=True, timeout=5)
        results.append(result.returncode == 0)
    return {"ok": all(results), "desktop": results[0], "editor": results[1]}


def wait_ready(cfg, timeout=180):
    deadline = time.monotonic() + timeout
    while True:
        try:
            result = health(cfg)
        except (OSError, subprocess.SubprocessError):
            result = {"ok": False}
        if result["ok"]:
            return result
        if time.monotonic() >= deadline:
            raise Refused("pool_desktop_not_ready")
        time.sleep(min(READY_POLL_SECONDS, max(0, deadline - time.monotonic())))


def first_ready(client, warm):
    """The first boot's readiness: post ready once the warm desktop answers. True once posted;
    False after FIRST_BOOT_READY_ATTEMPTS misses (never pool_desktop_not_ready: the caller keeps
    the host and waits for a claim, and the next refresh tries again)."""
    for attempt in range(FIRST_BOOT_READY_ATTEMPTS):
        if attempt:
            try:
                client.enroll(retry_seconds=REFRESH_RETRY_SECONDS)
            except Refused as e:
                if e.code not in ("pool_retry_exhausted", "pool_unavailable"):
                    raise                          # e.g. the planner already failed this host
        try:
            health = wait_ready(warm)
        except Refused as e:
            if e.code != "pool_desktop_not_ready":
                raise
            print(f"[pool] warm desktop not ready (attempt {attempt + 1}/{FIRST_BOOT_READY_ATTEMPTS})", flush=True)
            continue
        client.ready(health)
        return True
    return False


def wait_claim(client, warm):
    refresh_at = time.monotonic() + REFRESH_SECONDS
    while True:
        claim = client.claim()
        if claim is not None:
            return claim
        if time.monotonic() >= refresh_at:
            # Ready hosts require enrollment age < 10 min even when idle for hours. Health first:
            # an unready warm desktop never refreshes the enrollment, so a host that stays unready
            # ages out of the claimable set instead of being handed to a user.
            try:
                health = wait_ready(warm, timeout=REFRESH_RETRY_SECONDS)
                client.enroll(retry_seconds=REFRESH_RETRY_SECONDS)
                client.ready(health, retry_seconds=REFRESH_RETRY_SECONDS)
            except Refused as e:
                # Leasing can refuse a refresh before the claim response is published.
                claim = client.claim()
                if claim is not None:
                    return claim
                if e.code == "pool_desktop_not_ready":
                    # R2-4: never fatal. The host stays; the next refresh tries again.
                    print("[pool] warm desktop not ready at refresh; keeping the host", flush=True)
                    refresh_at = time.monotonic() + REFRESH_SECONDS
                elif e.code not in ("pool_retry_exhausted", "pool_unavailable"):
                    raise
            else:
                refresh_at = time.monotonic() + REFRESH_SECONDS
        time.sleep(POLL_SECONDS)


def stop_warm(cfg):
    # Disposable root-only guest: no tenant history or data needs a TERM grace.
    desktop.stop(cfg, grace=0, kill=True)
    if desktop.state(cfg) != "absent":
        raise Refused("pool_desktop_stop_failed")
    desktop.overlay_umount(cfg)
    # Guest-controlled scratch: rmtree's fd-based traversal does not follow links.
    if os.path.exists(cfg.dataMount):
        shutil.rmtree(cfg.dataMount)


def run(cfg, pool_lease):
    os.makedirs(cfg.stateDir, mode=0o700, exist_ok=True)
    root = os.open(cfg.stateDir, DIR_FLAGS)
    try:
        try:
            fcntl.flock(root, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError as e:
            raise Refused("pool_adoption_busy") from e
        return _adopt(cfg, pool_lease)
    finally:
        os.close(root)


def _adopt(cfg, pool_lease):
    from .cli import enroll_or_reuse

    record = read_record(cfg)
    client = Client(cfg, pool_lease)
    warm = warm_config(cfg)
    mounted = False
    succeeded = False
    stopped = record is not None and record["phase"] == "switched"
    stop_attempted = stopped
    try:
        if record is None:
            # A restart may find the row leased before the claim was saved locally.
            claim = client.claim()
            if claim is None:
                client.enroll()
                # A guard process may have died while waiting for a claim.
                if desktop.state(warm) != "running":
                    start_warm(warm, pool_lease)
                if not first_ready(client, warm):
                    print("[pool] warm desktop not ready after the first boot's waits; refreshes retry", flush=True)
                claim = wait_claim(client, warm)
            timing(cfg, "claimObservedMs", claim)
            record = reserve_claim(cfg, pool_lease, claim)
        else:
            if (record["poolHostId"] != pool_lease["poolHostId"]
                    or record["poolGeneration"] != pool_lease["poolGeneration"]
                    or record["instanceId"] != guard.current_instance_id(cfg)):
                raise Refused("pool_resume_mismatch")
            if record["phase"] == "failed":
                raise Refused("pool_host_already_claimed")
            claim = record["claim"]
        # The saved lease pins the filesystem UUID across interrupted marker commits.
        lease = record.get("lease") or computer_lease(cfg, claim)
        resumed_guard = record["phase"] != "reserved"
        record["lease"] = lease
        if not resumed_guard:
            record["phase"] = "guarding"
            save_record(cfg, record)
        guard.run_guard(cfg, lease, rebase_runner=rebase.run_job, allow_reboot=resumed_guard)
        mounted = True
        timing(cfg, "guardDoneMs")
        enroll._write_private(os.path.join(cfg.runDir, "lease.json"), json.dumps(lease).encode())
        enrollment_cfg = config.Config(dict(cfg))
        enrollment_cfg["enrollUrl"] = client.origin + "/api/compute/aws/enroll"
        try:
            enroll_or_reuse(enrollment_cfg, lease)
        except Refused as e:
            if e.code in ("enroll_refused", "enroll_nonce_absent"):
                record["phase"] = "failed"
                record["claim"].pop("enrollNonce", None)
                record["lease"].pop("nonce", None)
                save_record(cfg, record)
            raise
        timing(cfg, "enrollDoneMs")
        record["lease"] = enroll.load_lease(cfg)
        record["claim"].pop("enrollNonce", None)
        record["phase"] = "switched" if stopped else "enrolled"
        save_record(cfg, record)
        if not stopped:
            stop_attempted = True
            stop_warm(warm)
            stopped = True
            timing(cfg, "warmStoppedMs")
            record["phase"] = "switched"
            save_record(cfg, record)
        succeeded = True
    finally:
        try:
            if not stop_attempted:
                stop_warm(warm)
        finally:
            if not succeeded:
                guard.clear_stamp(cfg)
                if mounted:
                    subprocess.run(["umount", cfg.dataMount], check=True)
    # Relay arrives via the existing agent/edge/tunnel units. The desktop step
    # makes the single warm-to-user transition only after that config arrives.
    return "pool claimed; data guarded and enrolled; waiting for the user desktop"


def session_record(cfg, lease):
    record = read_record(cfg)
    if record is not None:
        if (record["phase"] != "switched" or any(record["claim"][k] != lease.get(k)
                for k in ("computerId", "generation", "leaseEpoch"))):
            raise Refused("pool_session_mismatch")
    return record


def run_desktop(cfg, lease, detach=False):
    """One transition, owned by the normal desktop unit. Reattach after a crash
    between runc start and health completion instead of restarting a live session.
    """
    if session_record(cfg, lease) is None:
        raise Refused("pool_session_missing")
    guard.require_stamp(cfg, lease)
    if desktop.state(cfg) != "running":
        relay = desktop.wait_desktop_config(cfg, min(30, float(cfg.get("iceWaitSeconds", 90))))
        if relay is None:
            raise Refused("pool_relay_missing")
        timing(cfg, "relayAvailableMs")
        desktop.build_spec(cfg, lease, os.environ.get("EZIL_DESKTOP_MODE", "desktop"), desktop_config=relay)
        desktop.write_ice_state(cfg, "applied", relay["expiresAt"])
        if desktop.run(cfg, detach=True, log=os.path.join(cfg.runDir, "desktop.log")) != 0:
            raise Refused("pool_desktop_start_failed")
        timing(cfg, "desktopStartedMs")
    if desktop.read_ice_state(cfg) != "applied":
        raise Refused("pool_relay_missing")
    wait_ready(cfg, timeout=30)
    timing(cfg, "desktopHealthyMs")
    record = session_record(cfg, lease)
    if not record.get("sessionReadyReported"):
        client = Client(cfg, {"poolHostId": record["poolHostId"], "poolGeneration": record["poolGeneration"],
                              "appOrigin": record["appOrigin"]})
        status, _ = client.request("POST", "session-ready", {"sessionReady": True, "timing": timing(cfg)})
        if status != 200:
            raise Refused("pool_session_ack_refused")
        record["sessionReadyReported"] = True
        save_record(cfg, record)
    if not detach:
        # Keep the Type=simple unit alive while supervising detached runc.
        while desktop.state(cfg) == "running":
            time.sleep(POLL_SECONDS)
    return "pool user desktop healthy with disk home and relay"


def session_ready(cfg, lease):
    """GW-5 desktop status is the existing session readiness acknowledgement."""
    try:
        if session_record(cfg, lease) is None:
            return False
        guard.require_stamp(cfg, lease)
        return desktop.read_ice_state(cfg) == "applied" and health(cfg)["ok"]
    except (Refused, OSError, subprocess.SubprocessError):
        return False
