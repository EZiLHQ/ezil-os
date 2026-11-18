"""Fresh native-session authority: a pure permission query from this host to the OS.

Before every native dispatch and on every watchdog tick, the root manager (native_session.py) asks
the OS whether the exact stored operation it admitted still holds for THIS placement. Nothing here
exchanges a Gateway grant, settles model usage or changes OS state: a signed `allow` is permission
for a short window, nothing more.

Transport. As the storage sample (storage.py; app billing/http/host-storage.ts): HTTPS POST to the
app origin this host enrolled with, under the epoch's control key, which the OS re-derives from the
placement (deriveControlKey), so no new secret exists. The MAC is domain separated:

  X-Ezil-Signature = v1=HMAC-SHA256(controlKey,
      "ezil-native-authority-v1|ts|computerId|generation|leaseEpoch|sha256hex(body)")

  body (closed, canonical, <= 2048 bytes):
    {"v":1,"operationId","sessionId","computerId","ownerUserId",
     "placement":{"generation","leaseEpoch","instanceId","fenceToken"},
     "runtimeId","policyDigest","requestNonce","issuedAt","expiresAt"}

The answer is bound to the exact request bytes, so it cannot be replayed onto another query:

  X-Ezil-Authority = v1=HMAC-SHA256(controlKey,
      "ezil-native-authority-v1-reply|computerId|generation|leaseEpoch|sha256hex(request)|sha256hex(reply)")

  reply (closed): {"v":1,"requestNonce","operationId","runtimeId","decision":"allow","expiresAt"}
               or {"v":1,"requestNonce","operationId","runtimeId","decision":"deny","reason"}

`expiresAt` is fixed by the OS as min(issuedAt + 30 s, requested expiresAt, live lease, grant
expiry); it is a function of the request, so a duplicate never slides it. The host additionally
caps it by its own clock and the local grant expiry. Any other answer, status, size or signature
is `unknown`, which the manager treats as a failed check (fence), never as permission.
"""
import hashlib
import hmac
import json
import re
import secrets
import time
from datetime import datetime, timezone

from . import http
from .lease import strict_json

MAC_INFO = "ezil-native-authority-v1"
REPLY_INFO = "ezil-native-authority-v1-reply"
PATH = "/api/compute/aws/native-authority"
MAX_REQUEST = 2048
MAX_REPLY = 1024
WINDOW_MS = 30_000
PLACEMENT_KEYS = {"generation", "leaseEpoch", "instanceId", "fenceToken"}
# pre-runtime: before Core mints its runtime UUID. runtimeId is ABSENT from request and reply (never
# null or a placeholder); the answer is pure and never a runtime permit.
# runtime: runtimeId is the exact Core-minted lowercase UUID the host ledger adopted.
_BASE = {"v", "phase", "operationId", "sessionId", "computerId", "ownerUserId", "placement", "policyDigest",
         "requestNonce", "issuedAt", "expiresAt"}
REQUEST_KEYS = {"pre-runtime": _BASE, "runtime": _BASE | {"runtimeId"}}
_REPLY = {"v", "phase", "requestNonce", "operationId", "decision"}
ALLOW_KEYS = {"pre-runtime": _REPLY | {"expiresAt"}, "runtime": _REPLY | {"runtimeId", "expiresAt"}}
DENY_KEYS = {"pre-runtime": _REPLY | {"reason"}, "runtime": _REPLY | {"runtimeId", "reason"}}
PHASES = ("pre-runtime", "runtime")
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
HEX64 = re.compile(r"[0-9a-f]{64}")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
COUNTER = re.compile(r"[1-9][0-9]{0,9}")
INSTANCE = re.compile(r"i-[0-9a-f]{8,17}")
NONCE = re.compile(r"[A-Za-z0-9_-]{43}")
REASON = re.compile(r"[a-z][a-z0-9_]{0,63}")
TIME = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z")


def iso_ms(ms):
    """Exact RFC 3339 UTC with milliseconds, as JavaScript's toISOString."""
    dt = datetime.fromtimestamp(ms // 1000, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S") + f".{ms % 1000:03d}Z"


def parse_ms(value):
    """Milliseconds for an exact `YYYY-MM-DDTHH:MM:SS.mmmZ` that round-trips, else None."""
    if not isinstance(value, str) or not TIME.fullmatch(value):
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    delta = dt - datetime(1970, 1, 1, tzinfo=timezone.utc)
    ms = (delta.days * 86400 + delta.seconds) * 1000 + delta.microseconds // 1000
    return ms if iso_ms(ms) == value else None


def canonical(obj):
    return json.dumps(obj, separators=(",", ":"), sort_keys=True, ensure_ascii=True).encode()


def valid_placement(p):
    return (isinstance(p, dict) and set(p) == PLACEMENT_KEYS
            and isinstance(p["generation"], str) and COUNTER.fullmatch(p["generation"]) and int(p["generation"]) <= 2147483647
            and isinstance(p["leaseEpoch"], str) and COUNTER.fullmatch(p["leaseEpoch"]) and int(p["leaseEpoch"]) <= 2147483647
            and isinstance(p["instanceId"], str) and INSTANCE.fullmatch(p["instanceId"])
            and isinstance(p["fenceToken"], str) and UUID.fullmatch(p["fenceToken"]))


def build_request(binding, runtime_id, policy_digest, now_ms, expires_ms, nonce=None):
    """binding: the ledger's pinned {operationId, sessionId, computerId, ownerUserId, placement}.
    runtime_id None = the pre-runtime phase (the key is then omitted)."""
    body = {"v": 1, "phase": "pre-runtime" if runtime_id is None else "runtime",
            "operationId": binding["operationId"], "sessionId": binding["sessionId"],
            "computerId": binding["computerId"], "ownerUserId": binding["ownerUserId"],
            "placement": dict(binding["placement"]), "policyDigest": policy_digest,
            "requestNonce": nonce or secrets.token_urlsafe(32), "issuedAt": iso_ms(now_ms),
            "expiresAt": iso_ms(min(expires_ms, now_ms + WINDOW_MS))}
    if runtime_id is not None:
        body["runtimeId"] = runtime_id
    if not valid_request(body):
        raise ValueError("native_authority_request_invalid")
    return canonical(body)


def valid_request(body):
    if not isinstance(body, dict) or body.get("phase") not in PHASES or set(body) != REQUEST_KEYS[body["phase"]]:
        return False
    if type(body["v"]) is not int or body["v"] != 1:
        return False
    if not all(isinstance(body[k], str) and UUID.fullmatch(body[k])
               for k in ("operationId", "sessionId", "computerId", "ownerUserId")):
        return False
    if not valid_placement(body["placement"]):
        return False
    if body["phase"] == "runtime" and (not isinstance(body["runtimeId"], str) or not UUID.fullmatch(body["runtimeId"])):
        return False
    if not isinstance(body["policyDigest"], str) or not DIGEST.fullmatch(body["policyDigest"]):
        return False
    if not isinstance(body["requestNonce"], str) or not NONCE.fullmatch(body["requestNonce"]):
        return False
    issued, expires = parse_ms(body["issuedAt"]), parse_ms(body["expiresAt"])
    return issued is not None and expires is not None and issued < expires <= issued + WINDOW_MS


def request_mac(key, ts, computer_id, generation, lease_epoch, raw):
    msg = "|".join([MAC_INFO, str(int(ts)), computer_id, str(generation), str(lease_epoch),
                    hashlib.sha256(raw).hexdigest()])
    return "v1=" + hmac.new(key, msg.encode(), hashlib.sha256).hexdigest()


def reply_mac(key, computer_id, generation, lease_epoch, request_raw, reply_raw):
    msg = "|".join([REPLY_INFO, computer_id, str(generation), str(lease_epoch),
                    hashlib.sha256(request_raw).hexdigest(), hashlib.sha256(reply_raw).hexdigest()])
    return "v1=" + hmac.new(key, msg.encode(), hashlib.sha256).hexdigest()


def verify_reply(key, request_raw, status, headers, reply_raw, local_cap_ms):
    """('allow', expires_ms) | ('deny', reason) | ('unknown', why). Never raises."""
    try:
        req = strict_json(request_raw.decode("utf-8"))
        if status not in (200, 403):
            return "unknown", f"status_{int(status)}"
        if not isinstance(reply_raw, bytes) or not 0 < len(reply_raw) <= MAX_REPLY:
            return "unknown", "reply_size"
        presented = {k.lower(): v for k, v in (headers or {}).items()}.get("x-ezil-authority", "")
        want = reply_mac(key, req["computerId"], req["placement"]["generation"], req["placement"]["leaseEpoch"],
                         request_raw, reply_raw)
        if not isinstance(presented, str) or not hmac.compare_digest(presented, want):
            return "unknown", "reply_mac"
        rep = strict_json(reply_raw.decode("utf-8", "strict"))
    except (ValueError, UnicodeError, RecursionError, KeyError, TypeError, AttributeError):
        return "unknown", "reply_invalid"
    if not isinstance(rep, dict) or type(rep.get("v")) is not int or rep["v"] != 1:
        return "unknown", "reply_invalid"
    phase = req["phase"]
    if (rep.get("phase") != phase or rep.get("requestNonce") != req["requestNonce"] or rep.get("operationId") != req["operationId"]
            or ("runtimeId" in rep) != (phase == "runtime") or rep.get("runtimeId") != req.get("runtimeId")):
        return "unknown", "reply_uncorrelated"
    if rep.get("decision") == "deny" and set(rep) == DENY_KEYS[phase] and status == 403:
        reason = rep["reason"]
        return ("deny", reason) if isinstance(reason, str) and REASON.fullmatch(reason) else ("unknown", "reply_invalid")
    if rep.get("decision") != "allow" or set(rep) != ALLOW_KEYS[phase] or status != 200:
        return "unknown", "reply_invalid"
    expires = parse_ms(rep["expiresAt"])
    issued, requested = parse_ms(req["issuedAt"]), parse_ms(req["expiresAt"])
    # The OS may only shorten the window it was asked for.
    if expires is None or not issued < expires <= requested:
        return "unknown", "reply_window"
    return "allow", min(expires, local_cap_ms)


def post_with_headers(method, url, body=None, headers=None, timeout=5.0, ca_file=None, server_name=None, max_reply=MAX_REPLY):
    """https:// (production) or https+unix:// (tests) only; TLS always verified; reply capped.
    Returns (status, body, headers)."""
    import http.client
    import urllib.parse
    u = urllib.parse.urlsplit(url)
    if u.scheme == "https" and not u.query:
        conn, path = http.client.HTTPSConnection(u.hostname, u.port or 443, timeout=timeout,
                                                 context=http_tls(ca_file)), u.path
    elif u.scheme == "https+unix" and server_name:
        sock, path = http._split_unix(u.path)
        conn = http._UnixHTTPS(sock, server_name, http_tls(ca_file), timeout)
    else:
        raise ValueError("native_authority_url_invalid")
    try:
        conn.request(method, path, body=body, headers=dict(headers or {}))
        r = conn.getresponse()
        if type(max_reply) is not int or max_reply not in (MAX_REPLY, 131072):
            raise ValueError("native_reply_limit_invalid")
        reply = r.read(max_reply + 1)
        if len(reply) > max_reply:
            raise ValueError("native_authority_reply_too_large")
        return r.status, reply, dict(r.getheaders())
    finally:
        conn.close()


def http_tls(ca_file):
    return http.tls_context(ca_file)


class Client:
    """One query at a time per call; no retry (a lost answer is simply not permission)."""

    def __init__(self, url, key, ca_file=None, server_name=None, request=post_with_headers, clock=time.time):
        self.url, self.key, self.ca_file, self.server_name = url, key, ca_file, server_name
        self.request, self.clock = request, clock

    def check(self, binding, runtime_id, policy_digest, expires_ms, local_cap_ms, timeout=5.0):
        now_ms = int(self.clock() * 1000)
        if expires_ms <= now_ms or local_cap_ms <= now_ms:
            return "deny", "expired_locally"
        try:
            raw = build_request(binding, runtime_id, policy_digest, now_ms, expires_ms)
        except (ValueError, KeyError, TypeError):
            return "unknown", "request_invalid"
        if len(raw) > MAX_REQUEST:
            return "unknown", "request_invalid"
        p = binding["placement"]
        ts = int(self.clock())
        headers = {"Content-Type": "application/json", "Cache-Control": "no-store",
                   "X-Ezil-Computer-Id": binding["computerId"], "X-Ezil-Generation": p["generation"],
                   "X-Ezil-Lease-Epoch": p["leaseEpoch"], "X-Ezil-Timestamp": str(ts),
                   "X-Ezil-Signature": request_mac(self.key, ts, binding["computerId"], p["generation"], p["leaseEpoch"], raw)}
        try:
            status, body, reply_headers = self.request("POST", self.url, body=raw, headers=headers, timeout=timeout,
                                                       ca_file=self.ca_file, server_name=self.server_name)
        except Exception:  # noqa: BLE001 — transport failure is never permission
            return "unknown", "transport"
        verdict = verify_reply(self.key, raw, status, reply_headers, body, local_cap_ms)
        if verdict[0] == "allow" and verdict[1] <= int(self.clock() * 1000):
            return "deny", "expired_locally"
        return verdict


def runtime_check(client, rpc):
    """Private read/control authority uses its own MAC domain, exact request nonce and 10s envelope."""
    now = int(client.clock() * 1000)
    try:
        scope = rpc["scope"]; p = scope["placement"]
        expires = min(parse_ms(rpc["deadline"]), now + 10000)
        body = {"v": 1, "requestNonce": secrets.token_urlsafe(32), "issuedAt": iso_ms(now), "expiresAt": iso_ms(expires), "request": rpc}
        raw = canonical(body); ts = str(now // 1000)
        key = client.key
        digest = hashlib.sha256(raw).hexdigest()
        material = "|".join(["ezil-native-runtime-authority-v1", ts, scope["computerId"], p["generation"], p["leaseEpoch"], digest])
        signature = "v1=" + hmac.new(key, material.encode(), hashlib.sha256).hexdigest()
        headers = {"Content-Type": "application/json", "X-Ezil-Computer-Id": scope["computerId"], "X-Ezil-Generation": p["generation"],
            "X-Ezil-Lease-Epoch": p["leaseEpoch"], "X-Ezil-Timestamp": ts, "X-Ezil-Signature": signature}
        url = client.url.rsplit("/", 1)[0] + "/native-runtime-authority"
        status, response, response_headers = client.request("POST", url, body=raw, headers=headers,
            timeout=max(.05, min(10, (expires - now) / 1000)), ca_file=client.ca_file, server_name=client.server_name, max_reply=131072)
        if len(response) > 131072: return False
        expected = "v1=" + hmac.new(key, "|".join(["ezil-native-runtime-authority-reply-v1", scope["computerId"],
            p["generation"], p["leaseEpoch"], digest, hashlib.sha256(response).hexdigest()]).encode(), hashlib.sha256).hexdigest()
        presented = next((v for k,v in response_headers.items() if k.lower() == "x-ezil-authority"), "")
        if not hmac.compare_digest(expected, presented): return False
        reply = json.loads(response)
        if status != 200 or reply.get("ok") is not True or reply.get("requestNonce") != body["requestNonce"] or reply.get("requestSha256") != digest:
            return False
        resolved = reply["resolved"]
        # AI state is dynamic read metadata; all immutable scope keys must remain exact.
        actual, original = dict(resolved["scope"]), dict(scope)
        aa, oa = dict(actual["aiAuthorization"]), dict(original["aiAuthorization"])
        aa.pop("state"); oa.pop("state")
        actual.pop("aiAuthorization"); original.pop("aiAuthorization")
        return (actual == original and aa == oa and resolved["action"] == rpc["action"]
            and resolved["rootRequestId"] == rpc["rootRequestId"] and resolved["requestDigest"] == rpc["requestDigest"]
            and int(client.clock() * 1000) < expires)
    except (ValueError, TypeError, KeyError, OSError):
        return False
