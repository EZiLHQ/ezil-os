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
import uuid

from . import http

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
VOL_RE = re.compile(r"^vol-[0-9a-f]{8,17}$")
SNAP_RE = re.compile(r"^snap-[0-9a-f]{8,17}$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
NONCE_RE = re.compile(r"^[A-Za-z0-9_-]{32,128}$")


class LeaseError(Exception):
    pass


def _int(v, name):
    if not isinstance(v, int) or isinstance(v, bool) or v < 0:
        raise LeaseError(f"lease_field_invalid: {name}")
    return v


def parse(raw):
    try:
        d = json.loads(raw)
    except (ValueError, UnicodeDecodeError) as e:
        raise LeaseError("lease_userdata_not_json") from e
    if not isinstance(d, dict) or d.get("v") != 1:
        raise LeaseError("lease_userdata_version")
    for k in ("computerId", "fsUuid"):
        if not isinstance(d.get(k), str) or not UUID_RE.match(d[k]):
            raise LeaseError(f"lease_field_invalid: {k}")
    # A provision intent precedes CreateVolume; all other leases still need an ID.
    discover = (d.get("provision") is True and d.get("volumeId") is None
                and d.get("rebase") is None)
    if not discover and (not isinstance(d.get("volumeId"), str) or not VOL_RE.fullmatch(d["volumeId"])):
        raise LeaseError("lease_field_invalid: volumeId")
    _int(d.get("generation"), "generation")
    if _int(d.get("leaseEpoch"), "leaseEpoch") < 1:
        raise LeaseError("lease_field_invalid: leaseEpoch")
    n = d.get("nonce")
    if n is not None and (not isinstance(n, str) or not NONCE_RE.match(n)):
        raise LeaseError("lease_field_invalid: nonce")
    if not isinstance(d.get("provision", False), bool):
        raise LeaseError("lease_field_invalid: provision")
    r = d.get("rebase")
    if r is not None:
        if not isinstance(r, dict) or not SNAP_RE.match(str(r.get("snapshotId", ""))) \
                or r.get("volumeId") != d["volumeId"] \
                or not DIGEST_RE.match(str(r.get("fromDigest", ""))) or not DIGEST_RE.match(str(r.get("toDigest", ""))):
            raise LeaseError("lease_field_invalid: rebase")
    uuid.UUID(d["fsUuid"])
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
