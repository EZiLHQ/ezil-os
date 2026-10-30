"""The lease this boot runs under, from instance user data (C-6), and IMDSv2 access.

User data is written by the lifecycle workflow for each epoch. It is JSON (not a
script; the AMI does not let cloud-init execute it):

  {"v":1, "computerId":uuid, "volumeId":"vol-…", "fsUuid":uuid, "generation":N,
   "leaseEpoch":E, "nonce":"…", "provision":bool,
   "rebase": {"snapshotId":"snap-…", "volumeId":"vol-…", "fromDigest":"sha256:…",
              "toDigest":"sha256:…"}            # optional, see rebase.py }

User data is readable on this host only, and by guest root too if the guest can reach
IMDS — it cannot: the container's network namespace has no route to it (netns.py).
"""
import json
import re
import time
from datetime import datetime, timezone

from . import http

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
POOL_UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
VOL_RE = re.compile(r"^vol-[0-9a-f]{8,17}$")
SNAP_RE = re.compile(r"^snap-[0-9a-f]{8,17}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


class LeaseError(Exception):
    pass


USER_DATA_MAX = 4096
USER_DATA_DECODED_MAX = 3072
ENROLL_NONCE_TTL_SECONDS = 600
REBASE_ENROLL_RESERVE_SECONDS = 120
REBASE_CLOCK_SKEW_SECONDS = 30
TIME_RE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")
ENROLL_URL_RE = re.compile(r"https://(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}/api/compute/aws/enroll")
REBASE_KEYS = {"snapshotId", "volumeId", "fromDigest", "toDigest"}
PERMIT_KEYS = {"v", "preparationJobId", "launchJobId", "computerId", "fsUuid", "generation",
               "leaseEpoch", "fenceToken", "issuedAt", "expiresAt"}
EBS_RESTORE_KEYS = PERMIT_KEYS | {"recoveryJobId", "snapshotId", "originalVolumeId", "volumeId",
                                 "fromDigest", "sourceGeneration", "sourceLeaseEpoch", "maintenance"}
LEASE_KEYS = {"v", "computerId", "volumeId", "fsUuid", "generation", "leaseEpoch", "nonce",
              "provision", "enrollUrl", "restore", "rebase", "rebasePermit", "ebsRestore"}


def _invalid(name):
    raise LeaseError(f"lease_field_invalid: {name}")


def _string(d, name, pattern):
    if not isinstance(d.get(name), str) or not pattern.fullmatch(d[name]):
        _invalid(name)


def _counter(value, name):
    if type(value) is not int or not 1 <= value <= 2147483647:
        _invalid(name)


def _closed(value, keys, name):
    if not isinstance(value, dict) or set(value) != keys:
        _invalid(name)


def _object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def _constant(value):
    raise ValueError("non-finite JSON")


def strict_json(raw):
    return json.loads(raw, object_pairs_hook=_object, parse_constant=_constant)


def timestamp_ms(value):
    if not isinstance(value, str) or not TIME_RE.fullmatch(value):
        _invalid("permit time")
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as e:
        raise LeaseError("lease_field_invalid: permit time") from e
    if dt.isoformat(timespec="milliseconds").replace("+00:00", "Z") != value:
        _invalid("permit time")
    delta = dt - datetime(1970, 1, 1, tzinfo=timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000


def validate_authorization(d, p, keys, name):
    _closed(p, keys, name)
    if type(p.get("v")) is not int or p["v"] != 1:
        _invalid(name)
    for key in ("preparationJobId", "launchJobId", "computerId", "fsUuid", "fenceToken"):
        _string(p, key, UUID_RE)
    if p["preparationJobId"] == p["launchJobId"]:
        _invalid(name + " job IDs")
    for key in ("generation", "leaseEpoch"):
        _counter(p[key], key)
    for key in ("computerId", "fsUuid", "generation", "leaseEpoch"):
        if p[key] != d[key]:
            _invalid(name + " " + key)
    if timestamp_ms(p["expiresAt"]) - timestamp_ms(p["issuedAt"]) != ENROLL_NONCE_TTL_SECONDS * 1000:
        _invalid(name + " lifetime")
    if d.get("provision") is not False or not isinstance(d.get("volumeId"), str):
        _invalid(name + " provision")
    _string(d, "nonce", NONCE_RE)


def mutation_deadline(permit):
    """Validate wall time once, then bound work with a monotonic deadline."""
    from .fsops import Refused
    now = time.time() * 1000
    if timestamp_ms(permit["issuedAt"]) > now + REBASE_CLOCK_SKEW_SECONDS * 1000:
        raise Refused("permit_invalid")
    remaining = (timestamp_ms(permit["expiresAt"]) - now) / 1000
    if remaining <= 0:
        raise Refused("permit_expired")
    if remaining <= REBASE_ENROLL_RESERVE_SECONDS:
        raise Refused("enrollment_time_insufficient")
    return time.monotonic() + remaining - REBASE_ENROLL_RESERVE_SECONDS


def require_budget(permit, deadline):
    """Also recheck wall time after slow preflight; a backward jump cannot extend work."""
    from .fsops import Refused
    remaining = min(deadline, mutation_deadline(permit)) - time.monotonic()
    if remaining <= 0:
        raise Refused("enrollment_time_insufficient")
    return remaining


def parse(raw):
    # IMDS returns the already base64-decoded RunInstances.UserData. Bound those
    # bytes before json.loads; no permissive second decode or script execution.
    if not isinstance(raw, (str, bytes)):
        raise LeaseError("lease_userdata_not_json")
    try:
        raw_bytes = raw.encode("utf-8") if isinstance(raw, str) else raw
        if len(raw_bytes) > USER_DATA_DECODED_MAX:
            raise LeaseError("lease_userdata_too_large")
        d = strict_json(raw_bytes.decode("utf-8"))
    except (ValueError, UnicodeError, RecursionError) as e:
        raise LeaseError("lease_userdata_not_json") from e
    if isinstance(d, dict) and d.get("kind") == "pool":
        if type(d.get("v", 1)) is not int or d.get("v", 1) != 1:
            raise LeaseError("lease_userdata_version")
        _string(d, "poolHostId", POOL_UUID_RE)
        if type(d.get("poolGeneration")) is not int or not 1 <= d["poolGeneration"] <= 2**53 - 1:
            _invalid("poolGeneration")
        if any(k in d for k in ("computerId", "volumeId", "fsUuid", "nonce", "provision",
                               "restore", "rebase", "rebasePermit", "ebsRestore")):
            raise LeaseError("pool_lease_contains_user_data")
        return d
    if not isinstance(d, dict) or type(d.get("v")) is not int or d["v"] != 1:
        raise LeaseError("lease_userdata_version")
    if set(d) - LEASE_KEYS:
        _invalid("unknown field")
    for k in ("computerId", "fsUuid"):
        _string(d, k, UUID_RE)
    discover = d.get("provision") is True and d.get("volumeId") is None
    if not discover:
        _string(d, "volumeId", VOL_RE)
    for k in ("generation", "leaseEpoch"):
        _counter(d.get(k), k)
    if "nonce" in d:
        _string(d, "nonce", NONCE_RE)
    if not isinstance(d.get("provision", False), bool):
        _invalid("provision")
    if "enrollUrl" in d:
        _string(d, "enrollUrl", ENROLL_URL_RE)
        if len(d["enrollUrl"]) > 512:
            _invalid("enrollUrl")
    if "restore" in d and d["restore"] is None:
        _invalid("restore")
    if ("rebase" in d) != ("rebasePermit" in d):
        _invalid("rebase pair")
    if "rebase" in d:
        r = d["rebase"]
        _closed(r, REBASE_KEYS, "rebase")
        if "restore" in d or "ebsRestore" in d:
            _invalid("rebase mode")
        validate_authorization(d, d["rebasePermit"], PERMIT_KEYS, "rebasePermit")
        for k, pattern in (("snapshotId", SNAP_RE), ("volumeId", VOL_RE),
                           ("fromDigest", DIGEST_RE), ("toDigest", DIGEST_RE)):
            _string(r, k, pattern)
        if r["volumeId"] != d["volumeId"] or r["fromDigest"] == r["toDigest"]:
            _invalid("rebase")
    if "ebsRestore" in d:
        p = d["ebsRestore"]
        if any(k in d for k in ("restore", "rebase", "rebasePermit")):
            _invalid("ebsRestore mode")
        validate_authorization(d, p, EBS_RESTORE_KEYS, "ebsRestore")
        for key, pattern in (("recoveryJobId", UUID_RE), ("snapshotId", SNAP_RE),
                             ("originalVolumeId", VOL_RE), ("volumeId", VOL_RE), ("fromDigest", DIGEST_RE)):
            _string(p, key, pattern)
        for key in ("sourceGeneration", "sourceLeaseEpoch"):
            _counter(p[key], key)
        if (p["maintenance"] is not True or p["volumeId"] != d["volumeId"]
                or p["volumeId"] == p["originalVolumeId"]
                or p["generation"] <= p["sourceGeneration"] or p["leaseEpoch"] <= p["sourceLeaseEpoch"]):
            _invalid("ebsRestore")
    return d


class Imds:
    """IMDSv2 only: PUT a session token, then GET with it. Hop limit 1 is enforced by
    the instance metadata options (launch template), not here."""

    def __init__(self, cfg):
        self.base = cfg.imdsUrl.rstrip("/")

    def _token(self):
        st, body = http.request("PUT", self.base + "/latest/api/token",
                                headers={"X-aws-ec2-metadata-token-ttl-seconds": "300"}, timeout=5)
        if st != 200 or not body:
            raise LeaseError(f"imds_token_failed: {st}")
        return body.decode("ascii").strip()

    def get(self, path, token=None):
        token = token or self._token()
        st, body = http.request("GET", self.base + path, headers={"X-aws-ec2-metadata-token": token}, timeout=5)
        if st != 200:
            raise LeaseError(f"imds_get_failed: {path} {st}")
        return body

    def lease_and_identity(self):
        t = self._token()
        return (self.get("/latest/user-data", t),
                self.get("/latest/dynamic/instance-identity/document", t).decode("utf-8"),
                self.get("/latest/dynamic/instance-identity/pkcs7", t).decode("ascii").strip())
