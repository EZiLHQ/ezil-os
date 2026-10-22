"""Single-use warm hosts. No user disk, tunnel, or control channel before a claim.

The guard unit owns a disposable desktop while it waits. Adoption uses the normal
disk guard and enrollment; the rest of the boot chain opens the user's overlay/home.
Only a verified HTTPS claim may supply the fence when IMDS tags are disabled.
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
FENCE_RE = re.compile(r"[A-Za-z0-9_.:-]{1,256}")
SERIAL_RE = re.compile(r"vol-?([0-9a-f]{8,17})")


def parse_claim(raw):
    try:
        claim = json.loads(raw)
    except (ValueError, UnicodeDecodeError, TypeError) as e:
        raise Refused("pool_claim_malformed") from e
    if not isinstance(claim, dict):
        raise Refused("pool_claim_malformed")
    if not isinstance(claim.get("computerId"), str) or not leasemod.UUID_RE.fullmatch(claim["computerId"]):
        raise Refused("pool_claim_invalid", "computerId")
    for field in ("generation", "leaseEpoch"):
        value = claim.get(field)
        if type(value) is not int or not 1 <= value <= 2**53 - 1:
            raise Refused("pool_claim_invalid", field)
    for field, pattern in (("fence", FENCE_RE), ("volumeSerial", SERIAL_RE),
                           ("nonce", leasemod.NONCE_RE), ("fsUuid", leasemod.UUID_RE)):
        if field in ("nonce", "fsUuid") and field not in claim:
            continue
        if not isinstance(claim.get(field), str) or not pattern.fullmatch(claim[field]):
            raise Refused("pool_claim_invalid", field)
    if "provision" in claim and type(claim["provision"]) is not bool:
        raise Refused("pool_claim_invalid", "provision")
    if claim.get("provision") and "fsUuid" not in claim:
        raise Refused("pool_claim_invalid", "provision requires fsUuid")
    # Unknown response fields cannot override local paths, authority or device identity.
    return {k: claim[k] for k in ("computerId", "generation", "leaseEpoch", "fence",
                                  "volumeSerial", "nonce", "fsUuid", "provision") if k in claim}


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

    def request(self, method, endpoint, payload=None):
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
        deadline = time.monotonic() + float(self.cfg.get("enrollRetrySeconds", 540))
        delay = 1.0
        while True:
            try:
                status, response = http.request(method, self.origin + "/api/compute/aws/pool/" + endpoint,
                                                body=body, headers=headers, timeout=20,
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

    def enroll(self):
        status, _ = self.request("POST", "enroll", {
            "poolHostId": self.lease["poolHostId"], "poolGeneration": self.lease["poolGeneration"],
            "identityDocument": self.identity["document"], "signature": self.identity["signature"],
        })
        if status != 200:
            raise Refused("pool_enroll_invalid_status")

    def ready(self, health):
        self.request("POST", "ready", {"poolHostId": self.lease["poolHostId"], "health": health})

    def claim(self):
        status, body = self.request("GET", "claim")
        return None if status == 204 else parse_claim(body)


def reserve_claim(cfg, pool_lease, claim, tag_fence):
    """Persist before mounting/enrolling. A crash burns this host; it cannot become
    a spare again. The flock also excludes concurrent guard activations.

    When tags are disabled (None), the fence is the authority returned by the app
    over verified TLS to this identity-authenticated request, not an unsigned
    value from disk/user data. No independent claim-signature format is defined.
    """
    if tag_fence is not None and tag_fence != claim["fence"]:
        raise Refused("pool_fence_mismatch")
    os.makedirs(cfg.stateDir, mode=0o700, exist_ok=True)
    root = os.open(cfg.stateDir, DIR_FLAGS)
    try:
        fcntl.flock(root, fcntl.LOCK_EX)
        try:
            st = os.stat(EPOCH_FILE, dir_fd=root, follow_symlinks=False)
        except FileNotFoundError:
            previous = None
        else:
            raw = read_regular_at(root, EPOCH_FILE, st, limit=65536)
            try:
                previous = json.loads(raw)
                if not isinstance(previous, dict) or type(previous.get("leaseEpoch")) is not int:
                    raise ValueError
            except (ValueError, TypeError) as e:
                raise Refused("pool_epoch_malformed") from e
        if previous is not None:
            if claim["leaseEpoch"] <= previous["leaseEpoch"]:
                raise Refused("epoch_not_increasing")
            raise Refused("pool_host_already_claimed")
        record = {k: claim[k] for k in ("computerId", "generation", "leaseEpoch", "fence", "volumeSerial")}
        record.update(poolHostId=pool_lease["poolHostId"], poolGeneration=pool_lease["poolGeneration"])
        enroll._write_private(os.path.join(cfg.stateDir, EPOCH_FILE), json.dumps(record).encode())
    finally:
        os.close(root)


def computer_lease(cfg, claim):
    # The EC2 attachment name (/dev/sdf) is deliberately irrelevant here.
    volume_id = "vol-" + SERIAL_RE.fullmatch(claim["volumeSerial"])[1]
    device = guard.wait_device_for_volume(cfg, volume_id)
    fs_uuid = claim.get("fsUuid") or guard.fs_uuid(device)
    if fs_uuid is None:
        raise Refused("pool_volume_unformatted", "a new volume requires provision and fsUuid in the claim")
    lease = {"v": 1, "computerId": claim["computerId"], "generation": claim["generation"],
             "leaseEpoch": claim["leaseEpoch"], "volumeId": volume_id, "fsUuid": fs_uuid,
             "provision": claim.get("provision", False)}
    if "nonce" in claim:
        lease["nonce"] = claim["nonce"]
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


def wait_ready(cfg):
    deadline = time.monotonic() + 180
    while True:
        try:
            result = health(cfg)
        except (OSError, subprocess.SubprocessError):
            result = {"ok": False}
        if result["ok"]:
            return result
        if time.monotonic() >= deadline:
            raise Refused("pool_desktop_not_ready")
        time.sleep(POLL_SECONDS)


def wait_claim(client, warm):
    refresh_at = time.monotonic() + 300
    while True:
        if time.monotonic() >= refresh_at:
            # Ready hosts require enrollment age < 10 min even when idle for hours.
            client.enroll()
            client.ready(wait_ready(warm))
            refresh_at = time.monotonic() + 300
        claim = client.claim()
        if claim is not None:
            return claim
        time.sleep(POLL_SECONDS)


def stop_warm(cfg):
    desktop.stop(cfg)
    if desktop.state(cfg) != "absent":
        raise Refused("pool_desktop_stop_failed")
    desktop.overlay_umount(cfg)
    # Guest-controlled scratch: rmtree's fd-based traversal does not follow links.
    if os.path.exists(cfg.dataMount):
        shutil.rmtree(cfg.dataMount)


def run(cfg, pool_lease):
    if os.path.lexists(os.path.join(cfg.stateDir, EPOCH_FILE)):
        raise Refused("pool_host_already_claimed")
    client = Client(cfg, pool_lease)
    client.enroll()
    warm = warm_config(cfg)
    mounted = False
    succeeded = False
    try:
        start_warm(warm, pool_lease)
        client.ready(wait_ready(warm))
        claim = wait_claim(client, warm)
        reserve_claim(cfg, pool_lease, claim, leasemod.Imds(cfg).fence_tag())
        lease = computer_lease(cfg, claim)
        # Pool claims always require a strict disk epoch increase, including on
        # the same instance; the cold path's reboot exception does not apply.
        guard.run_guard(cfg, lease, rebase_runner=rebase.run_job, allow_reboot=False)
        mounted = True
        enroll._write_private(os.path.join(cfg.runDir, "lease.json"), json.dumps(lease).encode())
        enrollment_cfg = config.Config(dict(cfg))
        enrollment_cfg["enrollUrl"] = client.origin + "/api/compute/aws/enroll"
        enroll.enroll(enrollment_cfg, lease, instance_id=guard.current_instance_id(cfg),
                      pool_claim={**pool_lease, "fence": claim["fence"]})
        succeeded = True
    finally:
        try:
            stop_warm(warm)
        except BaseException:
            succeeded = False
            raise
        finally:
            if not succeeded:
                guard.clear_stamp(cfg)
                if mounted:
                    subprocess.run(["umount", cfg.dataMount], check=True)
    # The normal clean/overlay/desktop steps now use the data disk's /root,
    # workspace and profiles. No warm home content is copied to the tenant disk.
    return "pool claimed; data guarded and enrolled; desktop home switches to the user disk"
