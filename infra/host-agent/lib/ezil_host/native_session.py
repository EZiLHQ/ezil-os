"""Native sessions on this host: the root manager (one per agent).

Off unless gate() holds: agent.json "nativeSessions": "enabled", an installed artifact matching
"nativeRuntimePin", and a kernel witness record (native_isolation.read_witness) for THIS kernel,
runc and pin. Otherwise every request is refused `native_unavailable` and nothing is admitted.

Delivery (edge POST /__ezil/control/native-session/<sha256(body)>; agent op `native-session`):
  {"v":1,"kind":"create","profileId":"ezil-native-claude-v1","operationId","sessionId","computerId",
   "ownerUserId","placement":{"generation","leaseEpoch","instanceId","fenceToken"},"leaseUntil",
   "sourceAuthorization":{"authorizationId","epoch","authorizationDeadline","clientId","profileId",
                          "policyId","budgetMicro","initialApprovalAt"},
   "task":{"taskRef","instructionRevision":1,"instructionDigest":"sha256:<64 hex>","instruction"},
   "grant":{"accessToken":"ezg_…","tokenSha256":"<64 hex>","grantId","expiresAt"}}
  * closed keys at every level; generation/leaseEpoch canonical decimal strings EQUAL to this host's
    lease integers (never cast); instanceId equal to this host's instance; instructionDigest kept
    exactly and equal to sha256:<hex of the instruction's UTF-8 bytes>; tokenSha256 is the RAW hex
    sha256 of the whole token (a different format on purpose);
  * `renew` is refused `renew_unsupported` (no qualified Core renew; no file-swap stub).
  * fenceToken, owner, lease end and sourceAuthorization cannot be checked against host files: they
    are PINNED in the ledger and confirmed by the OS's fresh authority answer before anything runs.

Idempotency: ledger key = operationId; its digest covers the SEMANTIC request (kind, ids, owner,
placement, profile, sourceAuthorization, task revision/digest) and excludes the grant and its
expiry, so a redelivery with a fresh grant matches and never spawns twice; any other request under
the same operationId is `operation_conflict`. The record is fsynced before any side effect.

Runtime: the root starts the public driver (native_driver.mjs) as the native service UID in the
runtime's own netns and cgroup, with one socketpair on FD 3, and answers its typed RPCs. Core mints
the runtime UUID; the root adopts and persists exactly that UUID at isolation.prepare. Authority:
`pre-runtime` (runtimeId null) before adoption, `runtime` after; a pre-runtime answer is never a
runtime permit. ACK (`running`) = the driver's `accepted` with Core's exact echoed userUuid and
acceptedAt for this session and runtime; before that the status is `starting`.

Lifecycle: watchdog authority every AUTH_INTERVAL; deny, unknown, lease or grant end, wall limit,
protocol violation, driver exit or a host stop/fence/export fences the runtime: driver (relay)
first, then the whole runtime cgroup, CLI container, netns, grant. Only a complete verified cleanup
receipt releases the permit; anything uncertain, a partial spawn or an agent restart leaves the
record `quarantined` with its permit held.
"""
import hashlib
import hmac
import json
import os
import re
import secrets
import threading
import queue
import time

from . import native_authority as nauth
from .fsops import DIR_FLAGS, read_regular_at, write_file_durable_at
from .lease import strict_json

PROFILE_ID = "ezil-native-claude-v1"
POLICY_REVISION = "bare-cli2.1.310-r2"
# The one trusted execution profile (Core binding fields model/tools/limits). Its digest is the
# host policyDigest the OS also derives; Core's own policyDigest is recorded next to it, never equated.
PROFILE = {"profileId": PROFILE_ID, "policyRevision": POLICY_REVISION, "cliVersion": "2.1.310", "model": "claude-sonnet-5-5",
           "permissionMode": "acceptEdits",
           "tools": ["Bash", "Edit", "Read"],
           "limits": {"maxRequestsPerOperation": 256, "maxRequestsPerLease": 2048, "maxConcurrentRequests": 2,
                      "maxRequestBytes": 4 << 20, "maxResponseBytes": 32 << 20, "maxOutputTokens": 64000,
                      "upstreamTimeoutMs": 600000, "maxTurnMs": 3600000, "maxInstructionBytes": 16384},
           "wallSeconds": 14400}
POLICY_DIGEST = "sha256:" + hashlib.sha256(nauth.canonical(PROFILE)).hexdigest()

DELIVERY_KEYS = {"v", "kind", "profileId", "operationId", "sessionId", "computerId", "ownerUserId", "placement",
                 "leaseUntil", "sourceAuthorization", "task", "grant"}
SOURCE_KEYS = {"authorizationId", "epoch", "authorizationDeadline", "clientId", "profileId", "policyId",
               "budgetMicro", "initialApprovalAt"}
TASK_KEYS = {"taskRef", "instructionRevision", "instructionDigest", "instruction"}
GRANT_KEYS = {"accessToken", "tokenSha256", "grantId", "expiresAt"}
UUID = nauth.UUID
HEX64 = nauth.HEX64
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")
TASK_REF = re.compile(r"[a-z0-9][a-z0-9._:-]{0,127}")
GRANT_TOKEN = re.compile(r"ezg_[A-Za-z0-9_-]{43}")
POSITIVE = re.compile(r"[1-9][0-9]{0,18}")
CLIENT_ID = re.compile(r"[A-Za-z0-9._:-]{1,200}")
MAX_BODY = 131072          # >= 96 KiB: a max-escaped 16 KiB instruction plus trusted overhead
MAX_INSTRUCTION = 16384
GRANT_MAX_MS = 5 * 60_000 + 30_000
AUTH_INTERVAL = 20.0
START_TIMEOUT = 120.0
WORK_HOLD_MS = 30_000
PROMPT_GRACE_MS = 120_000

LIVE = ("admitted", "authorizing", "spawning", "starting", "running", "stopping")
REFUSALS = frozenset({"native_unavailable", "native_invalid", "renew_unsupported", "placement_mismatch",
                      "operation_conflict", "session_exists", "permits_exhausted", "stopping", "grant_invalid",
                      "lease_expired"})


def gate(cfg, artifact_loader, witness_reader):
    """The artifact descriptor when every production prerequisite holds, else None. The witness is a
    record produced by a real qualification run on this kernel (never a config boolean)."""
    if cfg.get("nativeSessions") != "enabled":
        return None
    try:
        artifact = artifact_loader()
        witness = witness_reader(artifact)
    except Exception:  # noqa: BLE001 — any doubt is "unavailable"
        return None
    return artifact if witness is not None else None


def semantic_digest(d):
    task, src = d["task"] or {}, d["sourceAuthorization"]
    fields = ["ezil.native-host.request.v2", d["kind"], d["profileId"], d["operationId"], d["sessionId"],
              d["computerId"], d["ownerUserId"], d["placement"]["generation"], d["placement"]["leaseEpoch"],
              d["placement"]["instanceId"], d["placement"]["fenceToken"],
              *[src[k] for k in sorted(SOURCE_KEYS)], task.get("taskRef", ""),
              str(task.get("instructionRevision", "")), task.get("instructionDigest", "")]
    return "sha256:" + hashlib.sha256(json.dumps(fields, separators=(",", ":")).encode()).hexdigest()


def parse_delivery(raw):
    """Strict parse of the exact edge body. None when anything is off (never a partial object)."""
    if not isinstance(raw, bytes) or not 0 < len(raw) <= MAX_BODY:
        return None
    try:
        d = strict_json(raw.decode("utf-8", "strict"))
    except (ValueError, UnicodeError, RecursionError):
        return None
    return d if valid_delivery(d) else None


def _valid_source(s):
    return (isinstance(s, dict) and set(s) == SOURCE_KEYS
            and all(isinstance(s[k], str) and UUID.fullmatch(s[k]) for k in ("authorizationId", "policyId"))
            and all(isinstance(s[k], str) and POSITIVE.fullmatch(s[k]) for k in ("epoch", "budgetMicro"))
            and all(nauth.parse_ms(s[k]) is not None for k in ("authorizationDeadline", "initialApprovalAt"))
            and nauth.parse_ms(s["initialApprovalAt"]) < nauth.parse_ms(s["authorizationDeadline"])
            and s["profileId"] == PROFILE_ID and isinstance(s["clientId"], str) and CLIENT_ID.fullmatch(s["clientId"]))


def valid_delivery(d):
    if not isinstance(d, dict) or set(d) != DELIVERY_KEYS or type(d["v"]) is not int or d["v"] != 1:
        return False
    if d["kind"] not in ("create", "renew") or d["profileId"] != PROFILE_ID:
        return False
    if not all(isinstance(d[k], str) and UUID.fullmatch(d[k]) for k in ("operationId", "sessionId", "computerId", "ownerUserId")):
        return False
    if not nauth.valid_placement(d["placement"]) or nauth.parse_ms(d["leaseUntil"]) is None or not _valid_source(d["sourceAuthorization"]):
        return False
    g = d["grant"]
    if (not isinstance(g, dict) or set(g) != GRANT_KEYS or not isinstance(g["accessToken"], str)
            or not GRANT_TOKEN.fullmatch(g["accessToken"]) or not isinstance(g["grantId"], str)
            or not UUID.fullmatch(g["grantId"]) or nauth.parse_ms(g["expiresAt"]) is None
            or not isinstance(g["tokenSha256"], str) or not HEX64.fullmatch(g["tokenSha256"])
            or not hmac.compare_digest(hashlib.sha256(g["accessToken"].encode()).hexdigest(), g["tokenSha256"])):
        return False
    t = d["task"]
    if d["kind"] == "renew":
        return t is None
    if (not isinstance(t, dict) or set(t) != TASK_KEYS or not isinstance(t["taskRef"], str) or not TASK_REF.fullmatch(t["taskRef"])
            or type(t["instructionRevision"]) is not int or t["instructionRevision"] != 1
            or not isinstance(t["instructionDigest"], str) or not DIGEST.fullmatch(t["instructionDigest"])
            or not isinstance(t["instruction"], str) or not t["instruction"].strip()):
        return False
    try:
        data = t["instruction"].encode("utf-8", "strict")
    except UnicodeEncodeError:
        return False
    return len(data) <= MAX_INSTRUCTION and hmac.compare_digest(
        "sha256:" + hashlib.sha256(data).hexdigest(), t["instructionDigest"])


def from_config(cfg, lease, key, log):
    """The agent's manager, or None when native sessions are not enabled in agent.json. Being
    constructed admits nothing: gate() is re-evaluated on every request."""
    if cfg.get("nativeSessions") != "enabled":
        return None
    from urllib.parse import urlsplit
    from . import guard, native_artifact, native_isolation
    from .storage import endpoint
    origin = endpoint(cfg, lease)
    if origin is None:
        return None
    os_url = urlsplit(origin)
    expected_gateway = {
        "https://os-staging.ezil.work": "https://ai-staging.ezil.work",
        "https://os.ezil.work": "https://ai.ezil.work",
        "https://os-prod.ezil.work": "https://ai.ezil.work",
    }.get(f"{os_url.scheme}://{os_url.netloc}")
    if not expected_gateway or cfg.get("nativeGatewayOrigin") != expected_gateway:
        return None
    url = origin[: -len("/api/compute/aws/storage")] + nauth.PATH
    pin = cfg.get("nativeRuntimePin")
    loader = lambda: native_artifact.load(cfg.nativeRuntimeRoot, pin)  # noqa: E731
    return Manager(cfg, lease, artifact_loader=loader,
                   witness_reader=lambda artifact: native_isolation.read_witness(cfg, artifact),
                   launcher=native_isolation.Launcher(cfg, lease),
                   authority=nauth.Client(url, key, ca_file=cfg.get("caFile"), server_name=cfg.get("tlsServerName")),
                   instance_id=lambda: guard.current_instance_id(cfg), log=log)


class Ledger:
    """stateDir/native/ops/<operationId>.json, one fsynced record per admitted operation. Holds no
    token, instruction or relay key."""

    def __init__(self, cfg):
        self.dir = os.path.join(cfg.stateDir, "native", "ops")
        for rel in ("native", "native/ops"):
            try:
                os.mkdir(os.path.join(cfg.stateDir, rel), 0o700)
            except FileExistsError:
                pass

    def write(self, rec):
        blob = nauth.canonical(rec)
        if b"ezg_" in blob or any(k in rec for k in ("grant", "accessToken", "instruction")):
            raise ValueError("secret in ledger record")
        fd = os.open(self.dir, DIR_FLAGS)
        try:
            write_file_durable_at(fd, rec["operationId"] + ".json", blob, 0o600)
        finally:
            os.close(fd)

    def all(self):
        out = {}
        fd = os.open(self.dir, DIR_FLAGS)
        try:
            for name in os.listdir(fd):
                m = re.fullmatch(r"([0-9a-f-]{36})\.json", name)
                if not m or not UUID.fullmatch(m.group(1)):
                    continue
                raw = read_regular_at(fd, name, limit=65536)
                if raw is None:
                    raise ValueError("native ledger unreadable")
                rec = strict_json(raw.decode("utf-8"))
                if not isinstance(rec, dict) or rec.get("operationId") != m.group(1):
                    raise ValueError("native ledger invalid")
                out[m.group(1)] = rec
        finally:
            os.close(fd)
        return out


class Runtime:
    """In-memory companion of one ledger record: secrets live only here, never on disk."""

    def __init__(self, rec, token, instruction):
        self.rec, self.token, self.instruction = rec, token, instruction
        self.authorized_until = 0
        self.last_work_ms = 0
        self.prompt_since_ms = None
        self.driver = None
        self.pending = {}
        self.active_rpc = None
        self.stop_reason = None
        self.cond = threading.Condition()


class Manager:
    """Admission (under the agent's lock: never blocks on the network), status (pure read), and one
    thread per runtime for authority, driver RPCs, watchdog and fencing."""

    def __init__(self, cfg, lease, *, artifact_loader, witness_reader, launcher, authority, instance_id,
                 clock=time.time, log=lambda m: print(m, flush=True), monotonic=time.monotonic, start_threads=True):
        self.cfg, self.lease, self.clock, self.log, self.monotonic = cfg, lease, clock, log, monotonic
        self.artifact_loader, self.witness_reader = artifact_loader, witness_reader
        self.launcher, self.authority, self.instance_id = launcher, authority, instance_id
        self.start_threads = start_threads
        self.lock = threading.RLock()
        self.ledger = Ledger(cfg)
        self.runtimes = {}
        self.records = self.ledger.all()
        self.max_runtimes = int(cfg.get("nativeMaxRuntimes", 1))
        self._recover()

    # ------------------------------------------------------------------ restart
    def _recover(self):
        """A record still live after a restart is uncertain: quarantine it (permit held), then run an
        exact local cleanup of the resources it names and record the receipt. Never resumed."""
        for rec in list(self.records.values()):
            from .native_isolation import derive_host_epoch
            try:
                valid_identity = rec.get("hostEpoch") == derive_host_epoch(rec.get("bootId"), rec["computerId"], rec["placement"])
            except (ValueError, TypeError, KeyError):
                valid_identity = False
            if not valid_identity:
                self._save(dict(rec, state="quarantined", reason="historical_identity_missing"))
                continue
            if rec["state"] in LIVE:
                rec = dict(rec, state="quarantined", reason="agent_restart")
                self._save(rec)
                if rec.get("resourceKey"):
                    self._save(dict(rec, cleanup=self._cleanup(rec, None)))

    def readiness(self, query):
        """Authenticated target qualification only: no ledger mutation, admission, grant or process."""
        try:
            from .native_isolation import boot_id, derive_host_epoch
            keys = {"kind", "profileId", "ownerUserId", "computerId", "placement", "issuedAt", "expiresAt", "nonce"}
            if set(query) not in (keys, keys | {"gatewayOrigin"}):
                raise ValueError("shape")
            # Original staging queries omitted the Gateway. Production must bind its expected origin
            # in the authenticated challenge before OS can exchange a credential.
            gateway = query.get("gatewayOrigin", "https://ai-staging.ezil.work")
            if gateway not in ("https://ai-staging.ezil.work", "https://ai.ezil.work") or gateway != self.cfg.get("nativeGatewayOrigin"):
                raise ValueError("gateway_origin")
            now = int(self.clock() * 1000)
            issued, expires = nauth.parse_ms(query["issuedAt"]), nauth.parse_ms(query["expiresAt"])
            p = query["placement"]
            if (query["kind"] != "create" or query["profileId"] != PROFILE_ID
                    or not UUID.fullmatch(query["ownerUserId"]) or not nauth.valid_placement(p)
                    or query["computerId"] != str(self.lease.get("computerId", "")).lower()
                    or p["generation"] != str(self.lease.get("generation"))
                    or p["leaseEpoch"] != str(self.lease.get("leaseEpoch")) or p["instanceId"] != self.instance_id()
                    or not issued <= now < expires <= issued + 5000
                    or not re.fullmatch(r"[A-Za-z0-9_-]{43}", query["nonce"])):
                raise ValueError("target")
            artifact = gate(self.cfg, self.artifact_loader, self.witness_reader)
            witness = self.witness_reader(artifact) if artifact else None
            if not witness or witness.get("computerId") != query["computerId"] or witness.get("placement") != p:
                raise ValueError("qualification_target")
            identity = boot_id()
            if artifact is None or identity is None:
                raise ValueError("qualification")
            return {"ok": True, "kind": "ready", "nonce": query["nonce"], "expiresAt": query["expiresAt"],
                    "targetDigest": hashlib.sha256(nauth.canonical(query)).hexdigest(),
                    "hostEpoch": derive_host_epoch(identity, query["computerId"], p), "manifestSha256": artifact["manifestSha256"]}
        except (ValueError, TypeError, KeyError):
            return {"ok": False, "kind": "refused"}

    # ------------------------------------------------------------------ admission
    def admit(self, raw):
        now_ms = int(self.clock() * 1000)
        d = parse_delivery(raw)
        if d is None:
            return {"ok": False, "error": "native_invalid"}
        artifact = gate(self.cfg, self.artifact_loader, self.witness_reader)
        if artifact is None:
            return {"ok": False, "error": "native_unavailable"}
        if d["kind"] == "renew":
            return {"ok": False, "error": "renew_unsupported"}
        digest = semantic_digest(d)
        with self.lock:
            prior = self.records.get(d["operationId"])
            if prior is not None:
                if not hmac.compare_digest(prior["digest"], digest):
                    return {"ok": False, "error": "operation_conflict"}
                return self.status(d["operationId"])
            p, lease = d["placement"], self.lease
            if (d["computerId"] != str(lease.get("computerId", "")).lower()
                    or p["generation"] != str(lease.get("generation")) or p["leaseEpoch"] != str(lease.get("leaseEpoch"))
                    or p["instanceId"] != self.instance_id()):
                return {"ok": False, "error": "placement_mismatch"}
            lease_ms, grant_ms = nauth.parse_ms(d["leaseUntil"]), nauth.parse_ms(d["grant"]["expiresAt"])
            deadline_ms = nauth.parse_ms(d["sourceAuthorization"]["authorizationDeadline"])
            if lease_ms <= now_ms or deadline_ms <= now_ms:
                return {"ok": False, "error": "lease_expired"}
            if not now_ms + 30_000 < grant_ms <= min(lease_ms, now_ms + GRANT_MAX_MS):
                return {"ok": False, "error": "grant_invalid"}
            if any(r["sessionId"] == d["sessionId"] for r in self.records.values()):
                return {"ok": False, "error": "session_exists"}
            if sum(1 for r in self.records.values() if r["state"] in LIVE or r["state"] == "quarantined") >= self.max_runtimes:
                return {"ok": False, "error": "permits_exhausted"}
            from .native_isolation import boot_id, derive_host_epoch
            kernel_boot_id = boot_id()
            witness = self.witness_reader(artifact)
            if isinstance(witness, dict) and witness.get("v") == 2 and (witness.get("computerId") != d["computerId"] or witness.get("placement") != p):
                return {"ok": False, "error": "native_unavailable"}
            try:
                host_epoch = derive_host_epoch(kernel_boot_id, d["computerId"], p)
            except (ValueError, TypeError):
                return {"ok": False, "error": "native_unavailable"}
            rec = {"v": 2, "bootId": kernel_boot_id, "hostEpoch": host_epoch, "operationId": d["operationId"], "digest": digest, "kind": d["kind"], "sessionId": d["sessionId"],
                   "computerId": d["computerId"], "ownerUserId": d["ownerUserId"], "placement": dict(p),
                   "leaseUntil": d["leaseUntil"], "sourceAuthorization": dict(d["sourceAuthorization"]),
                   "grantId": d["grant"]["grantId"], "grantExpiresAt": d["grant"]["expiresAt"],
                   "taskRef": d["task"]["taskRef"], "instructionRevision": 1,
                   "instructionDigest": d["task"]["instructionDigest"], "artifact": artifact["manifestSha256"],
                   "policyDigest": POLICY_DIGEST, "corePolicyDigest": None, "state": "admitted", "reason": None,
                   "resourceKey": None, "runtimeId": None, "receipt": None, "slot": None, "ack": None,
                   "admittedAt": nauth.iso_ms(now_ms), "cleanup": None}
            self._save(rec)
            rt = Runtime(rec, d["grant"]["accessToken"], d["task"]["instruction"])
            self.runtimes[rec["operationId"]] = rt
            if self.start_threads:
                threading.Thread(target=self._run, args=(rt, artifact), name="ezil-native", daemon=True).start()
            return {"ok": True, "state": "starting"}

    def _save(self, rec):
        self.ledger.write(rec)
        self.records[rec["operationId"]] = rec

    def _move(self, rt, state, reason=None, **extra):
        with self.lock:
            rt.rec = dict(rt.rec, state=state, reason=reason, **extra)
            self._save(rt.rec)
        with rt.cond:
            rt.cond.notify_all()

    # ------------------------------------------------------------------ status (pure read)
    def status(self, operation_id):
        with self.lock:
            rec = self.records.get(operation_id)
            if rec is None:
                return {"ok": False, "error": "operation_unknown"}
            state = rec["state"]
        public = {"admitted": "starting", "authorizing": "starting", "spawning": "starting", "starting": "starting",
                  "running": "running", "stopping": "stopping", "stopped": "stopped", "quarantined": "quarantined",
                  "refused": "refused"}[state]
        out = {"ok": True, "state": public}
        if public in ("refused", "stopped", "quarantined") and rec.get("reason"):
            out["reason"] = rec["reason"]
        return out

    def wait_running(self, operation_id, timeout):
        """For the edge's bounded hold: the state once it is no longer `starting`, or at the bound."""
        deadline = self.monotonic() + timeout
        rt = self.runtimes.get(operation_id)
        while rt is not None:
            with rt.cond:
                if self.status(operation_id).get("state") != "starting":
                    break
                left = deadline - self.monotonic()
                if left <= 0:
                    break
                rt.cond.wait(min(left, 0.25))
        return self.status(operation_id)

    def runtime_request(self, request):
        """Exact sealed namespace only. A read never prepares, recovers, resumes or redelivers."""
        try:
            scope = request["scope"]
            with self.lock:
                rec = next((r for r in self.records.values() if r["sessionId"] == scope["sessionId"]), None)
                if rec is None: return {"kind": "unavailable", "reason": "runtime_unavailable"}
                if (rec["ownerUserId"] != scope["ownerUserId"] or rec["computerId"] != scope["computerId"]
                    or rec["sourceAuthorization"]["clientId"] != scope["originalOAuthClientId"] or rec["placement"] != scope["placement"]
                    or (scope["runtimeId"] is not None and (scope["runtimeId"] != rec["runtimeId"] or scope["hostEpoch"] != rec["hostEpoch"]))):
                    return {"kind": "refused", "reason": "scope_mismatch"}
                rt = self.runtimes.get(rec["operationId"])
            if not nauth.runtime_check(self.authority, request): return {"kind": "refused", "reason": "authority_denied"}
            if rt is None or rt.driver is None: return {"kind": "unavailable", "reason": "runtime_unavailable"}
            ident = secrets.token_hex(16); waiter = queue.Queue(maxsize=1)
            with rt.cond:
                if rt.active_rpc is not None: return {"kind": "unavailable", "reason": "runtime_busy"}
                rt.active_rpc = request; rt.pending[ident] = waiter
            try:
                rt.driver.send({"type": "runtime_rpc", "id": ident, "request": request})
                response = waiter.get(timeout=max(.01, min(10, (nauth.parse_ms(request["deadline"]) - int(self.clock()*1000))/1000)))
                return {"kind": "ok", "result": response["result"]} if response.get("ok") is True else {"kind": "refused", "reason": response.get("code", "runtime_unavailable")}
            except queue.Empty: return {"kind": "unknown", "reason": "host_timeout"}
            finally:
                with rt.cond: rt.pending.pop(ident, None); rt.active_rpc = None
        except (ValueError, TypeError, KeyError): return {"kind": "refused", "reason": "runtime_invalid"}

    # ------------------------------------------------------------------ authority
    def _binding(self, rec):
        return {k: rec[k] for k in ("operationId", "sessionId", "computerId", "ownerUserId")} | {"placement": rec["placement"]}

    def _local_cap(self, rec):
        return min(nauth.parse_ms(rec["leaseUntil"]), nauth.parse_ms(rec["grantExpiresAt"]),
                   nauth.parse_ms(rec["sourceAuthorization"]["authorizationDeadline"]))

    def _authorize(self, rt, runtime_id):
        """runtime_id None = pre-runtime (pure: no permit, no idle hold)."""
        cap = self._local_cap(rt.rec)
        verdict, detail = self.authority.check(self._binding(rt.rec), runtime_id, POLICY_DIGEST, cap, cap)
        if verdict == "allow":
            if runtime_id is not None:
                rt.authorized_until = detail
            return True, None
        rt.authorized_until = 0
        return False, (f"authority_{verdict}" if verdict != "deny" else f"authority_denied_{detail}")[:64]

    # ------------------------------------------------------------------ runtime thread
    def _run(self, rt, artifact):
        try:
            self._move(rt, "authorizing")
            ok, why = self._authorize(rt, None)
            if not ok:
                rt.token = rt.instruction = None
                self._move(rt, "refused", why)
                return
            with self.lock:
                used = {r.get("slot") for r in self.records.values() if r["state"] in LIVE or r["state"] == "quarantined"}
                slot = next(i for i in range(16384) if i not in used)
            # The private resource key is chosen and persisted before any side effect.
            self._move(rt, "spawning", resourceKey=secrets.token_hex(32), slot=slot)
            rt.driver = self.launcher.start_driver(rt.rec, artifact, rt.token, rt.instruction, PROFILE)
            rt.token = rt.instruction = None    # now only in the private 0600 file / the driver's memory
            self._move(rt, "starting")
            self._serve(rt)
        except Exception as e:  # noqa: BLE001 — any failure fences; never silently left running
            self.log(f"native: runtime failed: {type(e).__name__}")
            rt.stop_reason = rt.stop_reason or "spawn_failed"
        self._fence(rt, rt.stop_reason or "internal")

    def _serve(self, rt):
        """Answer the driver until something ends the runtime. Every reply is typed and closed."""
        started = self.monotonic()
        next_check = None
        while rt.stop_reason is None:
            now_ms = int(self.clock() * 1000)
            if now_ms >= self._local_cap(rt.rec):
                rt.stop_reason = "lease_or_grant_expired"
                break
            if rt.rec["state"] == "starting" and self.monotonic() - started > START_TIMEOUT:
                rt.stop_reason = "start_timeout"
                break
            if self.monotonic() - started > PROFILE["wallSeconds"]:
                rt.stop_reason = "wall_limit"
                break
            if next_check is not None and self.monotonic() >= next_check:
                ok, why = self._authorize(rt, rt.rec["runtimeId"])
                if not ok:
                    rt.stop_reason = why
                    break
                next_check = self.monotonic() + AUTH_INTERVAL
            proc = getattr(self.launcher, "procs", {}).get(rt.rec["operationId"], {}).get("cliPopen")
            if proc is not None and proc.poll() is not None:
                code = proc.returncode
                rt.driver.send({"event": "cli_exit", "code": code if code >= 0 else None,
                    "signal": None if code >= 0 else "SIGKILL" if code == -9 else "SIGTERM"})
            frame = rt.driver.next_frame(timeout=0.5)
            if frame is None:
                continue
            if frame.get("eof"):
                rt.stop_reason = rt.stop_reason or "driver_exited"
                break
            if "rpc" in frame:
                result = self._rpc(rt, frame)
                rt.driver.send({"id": frame.get("id"), "result": result})
                continue
            ev = frame.get("event")
            if ev == "runtime_result":
                waiter = rt.pending.get(frame.get("id"))
                if waiter is not None: waiter.put_nowait(frame)
                continue
            if ev == "accepted" and rt.rec["state"] == "starting":
                if (set(frame) == {"event", "runtimeId", "sessionId", "userUuid", "acceptedAt"}
                        and frame["runtimeId"] == rt.rec["runtimeId"] and frame["sessionId"] == rt.rec["sessionId"]
                        and isinstance(frame["userUuid"], str) and UUID.fullmatch(frame["userUuid"])
                        and isinstance(frame["acceptedAt"], str) and len(frame["acceptedAt"]) <= 40):
                    rt.last_work_ms = now_ms
                    self._move(rt, "running", ack={"userUuid": frame["userUuid"], "acceptedAt": frame["acceptedAt"]})
                    next_check = self.monotonic() + AUTH_INTERVAL
                else:
                    rt.stop_reason = "protocol_violation"
            elif ev == "started" and frame.get("runtimeId") == rt.rec["runtimeId"]:
                if not isinstance(frame.get("policyDigest"), str) or not HEX64.fullmatch(frame["policyDigest"]):
                    rt.stop_reason = "policy_unverified"
                else:
                    self._move(rt, rt.rec["state"], corePolicyDigest=frame["policyDigest"])
                continue
            elif ev == "failed":
                code = frame.get("code")
                rt.stop_reason = code if isinstance(code, str) and re.fullmatch(r"[a-z][a-z0-9_]{0,63}", code) else "driver_failed"
            else:
                rt.stop_reason = "protocol_violation"

    def _rpc(self, rt, frame):
        name, rid = frame.get("rpc"), frame.get("runtimeId")
        adopted = rt.rec["runtimeId"]
        if name in ("authority.checkRead", "authority.checkControl"):
            request = rt.active_rpc
            if request is None or frame.get("requestScope") != request.get("scope"):
                return {"ok": False, "code": "authority_unavailable"}
            return {"ok": True} if nauth.runtime_check(self.authority, request) else {"ok": False, "code": "authority_denied"}
        if name == "authority.check":
            if rid is not None and rid != adopted:
                return {"ok": False, "code": "runtime_mismatch"}
            ok, why = self._authorize(rt, adopted)
            return {"ok": True} if ok else {"ok": False, "code": why}
        if name == "isolation.prepare":
            if not isinstance(rid, str) or not UUID.fullmatch(rid) or (adopted and adopted != rid):
                return {"ok": False, "code": "runtime_mismatch"}
            if not adopted:
                self._move(rt, rt.rec["state"], runtimeId=rid)     # adopt Core's exact UUID, durably
            ok, why = self._authorize(rt, rid)
            if not ok:
                return {"ok": False, "code": why}
            receipt = self.launcher.prepare(rt.rec)
            self._move(rt, rt.rec["state"], receipt=receipt)
            return {"ok": True, "receipt": receipt}
        if rid != adopted or adopted is None:
            return {"ok": False, "code": "runtime_mismatch"}
        if name == "isolation.spawn":
            if frame.get("receipt") != rt.rec["receipt"]:
                return {"ok": False, "code": "isolation_unverified"}
            ok, why = self._authorize(rt, adopted)
            if not ok: return {"ok": False, "code": why}
            result = self.launcher.spawn_cli(rt.rec, frame.get("options"))
            prepared = self.launcher.procs[rt.rec["operationId"]].get("rootfsPreparation")
            self._move(rt, rt.rec["state"], rootfsPreparation=prepared)
            return result
        if name in ("isolation.captureIdentity", "authority.verifyRuntimeIdentity"):
            identity = self.launcher.capture_identity(rt.rec)
            if name == "authority.verifyRuntimeIdentity" and frame.get("receipt") != identity:
                return {"ok": False, "code": "runtime_identity_unverified"}
            self._move(rt, rt.rec["state"], childIdentity=identity)
            return {"ok": True, "identity": identity}
        if name == "isolation.verify":
            return {"ok": True} if frame.get("receipt") == rt.rec["receipt"] else {"ok": False, "code": "isolation_unverified"}
        if name == "permits.acquire":
            permit = hashlib.sha256(("permit|" + rt.rec["resourceKey"]).encode()).hexdigest()
            return {"ok": True, "permitId": f"{permit[:8]}-{permit[8:12]}-{permit[12:16]}-{permit[16:20]}-{permit[20:32]}"}
        if name == "permits.release":
            return {"ok": True}     # the host permit is released only by its own verified cleanup receipt
        if name == "isolation.terminate":
            self.launcher.kill_cli(rt.rec)
            return {"ok": True}
        if name == "isolation.reap":
            fenced = self.launcher.reap_cli(rt.rec) is True
            runtime = frame.get("runtime")
            if not fenced or not isinstance(runtime, dict) or runtime.get("id") != adopted:
                return {"fenced": False}
            keys = ("sessionId", "ownerId", "computerId", "hostEpoch", "placement", "leaseUntil", "policyDigest", "controllerId", "pid", "procStart", "identity")
            receipt = {"runtimeId": adopted, **{k: runtime.get(k) for k in keys}}
            if (receipt["sessionId"] != rt.rec["sessionId"] or receipt["ownerId"] != rt.rec["ownerUserId"]
                or receipt["computerId"] != rt.rec["computerId"] or receipt["hostEpoch"] != rt.rec["hostEpoch"]
                or receipt["placement"] != rt.rec["placement"] or receipt["identity"] != rt.rec.get("childIdentity")):
                return {"fenced": False}
            self._move(rt, rt.rec["state"], fenceReceipt=receipt)
            return {"fenced": True, "receipt": receipt}
        if name == "authority.verifyFence":
            return {"ok": True} if frame.get("receipt") == rt.rec.get("fenceReceipt") and rt.rec.get("fenceReceipt") is not None else {"ok": False, "code": "fence_unverified"}
        return {"ok": False, "code": "rpc_unknown"}

    # ------------------------------------------------------------------ fencing
    def _fence(self, rt, reason):
        """Exactly one caller cleans up (the claim is the move to `stopping` under the lock)."""
        with self.lock:
            if rt.rec["state"] in ("stopped", "quarantined", "refused", "stopping"):
                return False
            rt.stop_reason = rt.stop_reason or reason
            self._move(rt, "stopping", reason)
        rt.token = rt.instruction = None
        receipt = self._cleanup(rt.rec, rt.driver)
        complete = receipt is not None and all(receipt.values())
        self._move(rt, "stopped" if complete else "quarantined", reason, cleanup=receipt)
        return True

    def _cleanup(self, rec, driver):
        """Driver (relay) first, then everything in the runtime cgroup. The verified receipt."""
        try:
            return self.launcher.stop(rec, driver)
        except Exception as e:  # noqa: BLE001
            self.log(f"native: cleanup failed: {type(e).__name__}")
            return None

    def fence_all(self, reason):
        """Host stop / fence / export: revoke every runtime before the desktop or volume goes."""
        with self.lock:
            live = [rt for rt in self.runtimes.values() if rt.rec["state"] in LIVE]
        for rt in live:
            rt.stop_reason = rt.stop_reason or reason
        for rt in live:
            if not self._fence(rt, reason):
                deadline = self.monotonic() + 30
                with rt.cond:
                    while rt.rec["state"] == "stopping" and self.monotonic() < deadline:
                        rt.cond.wait(0.25)
        return all(rt.rec["state"] in ("stopped", "refused") for rt in live)

    def active(self):
        with self.lock:
            return any(r["state"] in LIVE or r["state"] == "quarantined" for r in self.records.values())

    # ------------------------------------------------------------------ idle hold
    def holds_idle(self, now):
        """native_work: a running runtime with real model/tool work in the last 30 s, or a prompt
        waiting at most 120 s, AND an unexpired runtime authority answer before the lease/grant/
        consent end. No presence is invented and no control-plane stop or cap is held."""
        now_ms = int(now * 1000)
        with self.lock:
            rts = [rt for rt in self.runtimes.values() if rt.rec["state"] == "running"]
        for rt in rts:
            if not now_ms < min(rt.authorized_until, self._local_cap(rt.rec)):
                continue
            if now_ms - rt.last_work_ms <= WORK_HOLD_MS:
                return True
            if rt.prompt_since_ms is not None and now_ms - rt.prompt_since_ms <= PROMPT_GRACE_MS:
                return True
        return False
