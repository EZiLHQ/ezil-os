"""C-6 enrollment client and host-only secret storage.

  lease step : IMDSv2 -> user data (lease + one-time nonce), identity document, PKCS7
               signature -> runDir/lease.json (0600, tmpfs) and runDir/identity.json
  enroll step: POST {computerId, generation, leaseEpoch, nonce, identityDocument,
               signature} over verified HTTPS to cfg.enrollUrl; receive the per-epoch
               tunnel token (and the control-channel key); store both under stateDir
               (0700 dir, 0600 files) on the HOST root volume — never in the container's
               view and never on the data volume; then WIPE the nonce from local state.
The nonce is single-use (the app clears it by compare-and-swap): the client never
retries an enrollment with a nonce that was already sent and got an answer.
"""
import base64
import glob
import json
import os

from . import guard, http, lease as leasemod
from .fsops import Refused

TOKEN_FILE = "tunnel.json"


def _write_private(path, data):
    d = os.path.dirname(path)
    os.makedirs(d, mode=0o700, exist_ok=True)
    os.chmod(d, 0o700)
    dfd = os.open(d, os.O_RDONLY | os.O_DIRECTORY)
    try:
        tmp = os.path.basename(path) + f".tmp.{os.getpid()}"
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=dfd)
        try:
            os.write(fd, data)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.rename(tmp, os.path.basename(path), src_dir_fd=dfd, dst_dir_fd=dfd)
        os.fsync(dfd)
    finally:
        os.close(dfd)


def wipe(path):
    """Overwrite then unlink a host secret file (best effort against casual recovery;
    EBS/ext4 give no secure-erase guarantee — the token is per-epoch and revoked by the
    fence anyway)."""
    try:
        fd = os.open(path, os.O_WRONLY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return False
    try:
        size = os.fstat(fd).st_size
        os.write(fd, b"\0" * size)
        os.fsync(fd)
    finally:
        os.close(fd)
    os.unlink(path)
    dfd = os.open(os.path.dirname(path), os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(dfd)
    finally:
        os.close(dfd)
    return True


def fetch_lease(cfg):
    raw, doc, sig = leasemod.Imds(cfg).lease_and_identity()
    lease = leasemod.parse(raw)
    if lease.get("volumeId") is None:  # parse permits this only for PROVISION
        lease["volumeId"] = guard.provision_volume(cfg)
    _write_private(os.path.join(cfg.runDir, "lease.json"), json.dumps(lease).encode())
    _write_private(os.path.join(cfg.runDir, "identity.json"), json.dumps({"document": doc, "signature": sig}).encode())
    return lease


def load_lease(cfg):
    with open(os.path.join(cfg.runDir, "lease.json"), encoding="utf-8") as f:
        return json.load(f)


def wipe_nonce(cfg, lease):
    lease = dict(lease)
    lease.pop("nonce", None)
    lease["nonceConsumed"] = True
    _write_private(os.path.join(cfg.runDir, "lease.json"), json.dumps(lease).encode())
    for pattern in cfg.get("userDataCopies") or []:
        for copy in sorted(glob.glob(pattern)):
            wipe(copy)
    return lease


def enroll(cfg, lease):
    if lease.get("nonceConsumed") or not lease.get("nonce"):
        raise Refused("enroll_nonce_absent", "nonce already used for this epoch")
    if not cfg.enrollUrl:
        raise Refused("enroll_url_unset")
    with open(os.path.join(cfg.runDir, "identity.json"), encoding="utf-8") as f:
        ident = json.load(f)
    body = json.dumps({"computerId": lease["computerId"], "generation": lease["generation"],
                       "leaseEpoch": lease["leaseEpoch"], "nonce": lease["nonce"],
                       "identityDocument": ident["document"], "signature": ident["signature"]}).encode()
    try:
        status, resp = http.request("POST", cfg.enrollUrl, body=body,
                                    headers={"Content-Type": "application/json"}, timeout=20,
                                    ca_file=cfg.caFile, server_name=cfg.tlsServerName)
    except OSError as e:   # transport failure before an answer: the nonce may be retried
        raise Refused("enroll_transport", str(e))
    # Any HTTP answer means the app saw the nonce: never send it again.
    wipe_nonce(cfg, lease)
    if status != 200:
        raise Refused("enroll_refused", f"HTTP {status}: {resp[:200]!r}")
    try:
        r = json.loads(resp)
        token, key = r["tunnelToken"], base64.b64decode(r["controlKey"], validate=True)
        if not isinstance(token, str) or len(token) < 16 or len(key) < 32:
            raise ValueError
    except (ValueError, KeyError, TypeError):
        raise Refused("enroll_response_malformed")
    _write_private(os.path.join(cfg.stateDir, TOKEN_FILE),
                   json.dumps({"token": token, "generation": lease["generation"],
                               "leaseEpoch": lease["leaseEpoch"]}).encode())
    _write_private(os.path.join(cfg.stateDir, "control.key"), key)
    return True
