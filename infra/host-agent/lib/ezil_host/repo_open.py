"""Repo-open on an AWS computer: the host side of contract universe-repo-open-v1 §13 (Phase B).

On a Cloudflare computer the Worker runs the repo-open kernel inside the sandbox (§8,
worker/src/repo-open.ts). On an AWS computer the Worker relays the same request to this host's
edge and the agent runs the SAME kernel and credential helper (byte-identical, sha256-pinned
copies in repo_open_assets/, equal to worker/src/repo-open-assets/) inside the desktop with
`runc exec` and argv only. Phase B is inert until the lead's activation commit (§13).

Wire interface (pinned here; worker/src/aws-repo-open.ts, lane A2r, must match it)
---------------------------------------------------------------------------------
Both routes are gw1-signed by the Worker with this epoch's control key (edge.py) and are POST.

1. ``POST /__ezil/control/repo-open/<sha256hex(relay body)>``
   * Content-Length 1..RELAY_MAX_BYTES, no Transfer-Encoding, no query. The body's sha256 is in
     the signed path (gw1 signs the path only) and is compared before the body is parsed.
   * Relay body: the §8 Worker body, exactly as the Worker validated it, plus ``jobId``
     (64 lowercase hex, 32 random bytes chosen by the Worker); nothing else:
     ``{jobId, v:1, op:'open'|'refresh', repositoryId, handle, name, gitHost, defaultBranch,
     path:string|null, grant:{username:'ezil', token, expiresAt, scope}}``.
     Every field is re-validated here with the Worker's rules (parse_relay).
   * Replies (edge status, JSON body):
     200 ``{ok:true, state:'running'}``;
     409 ``{ok:false, error}`` with error ``workspace_busy`` (the host's one slot is taken, or
     the replay guard is not ready: retryable), ``job_replayed`` (this jobId was already
     accepted: job ids are single use, never joined or re-run; its status stays readable),
     ``repo_open_invalid`` or ``workspace_failed``;
     400 ``repo_open_body_invalid`` | ``repo_open_digest_mismatch``; 404 wrong method or a query;
     401 gw1; 503 ``agent_unavailable``. An edge without these routes (an AMI before this
     change) answers 404 ``not_found``, which the Worker maps to ``workspace_unsupported``.
2. ``POST /__ezil/control/repo-open-status/<jobId>``, empty body (no Content-Length, or 0).
   * 200 ``{ok:true, state:'running'}`` or ``{ok:true, state:'done', result}``;
     409 ``{ok:false, error:'job_unknown'}`` (never accepted here, or older than JOB_TTL).
   * ``result`` is the §8 answer itself, ``{status, body}``, so the Worker relays it 1:1 after
     its own validation: ``{status:200, body:{ok:true, state:'cloned'|'initialized_empty'|
     'existing', folder, openFolder, pathNotFound, branch, empty}}`` (open),
     ``{status:200, body:{ok:true, state:'refreshed'}}`` (refresh), or
     ``{status, body:{ok:false, error}}`` with status from REPO_OPEN_STATUS (vectors
     errorTable.workerResponses.refusals). Host-originated codes: ``runtime_not_running`` (a
     stop, fence, desktop restart or export is pending, or the desktop is not running or was
     replaced), ``workspace_not_ready`` (the data volume did not pass the guard for this epoch),
     ``workspace_busy``, ``workspace_failed``; the kernel's own codes pass through.

The job (one serial worker per host; the host serves exactly one computer epoch)
---------------------------------------------------------------------------------
Host steps mirror §8 steps 3-11 (worker/src/repo-open.ts runFlight):
  * before anything: no stop/fence/restart/export pending, guard stamp of THIS epoch, desktop
    running; the desktop's init pid is pinned for the whole job;
  * setup (one SHORT_EXEC_MS budget): ``install -d -m 0700 RUN_DIRS``; the kernel, helper,
    incoming grant and request are each written over runc exec STDIN (a host-private, unlinked
    temporary file in runDir) by a constant shell program that receives only generated paths as
    positional parameters; a constant install program moves kernel and helper into place;
  * open: ``node KERNEL prepare REQUEST`` (no lock; network) within
    min(PREPARE_WINDOW, deadline - PREPARE_RESERVE - now); the host check again; then, if at
    least COMMIT_MIN_REMAINING is left, ``node KERNEL commit REQUEST`` (COMMIT_EXEC_MAX);
  * refresh: ``node KERNEL refresh REQUEST``;
  * release on every outcome unless the desktop stopped: ``node KERNEL release REQUEST``, and on
    its failure the constant fallback program over this request's generated paths.
One absolute deadline (HOST_DEADLINE_MS from admission) bounds every exec but release, which
gets at most RELEASE_GRACE_MS beyond it. HOST_DEADLINE + RELEASE_GRACE + AWS_RELAY_POLL +
RELAY_SLACK <= WORKER_DEADLINE (tested against the vectors), so the result is published before
the Worker stops polling.

The host workspace lock. Commit runs inside the runner's single job slot (``busy``), held from
admission until cleanup is confirmed: no other repo-open prepare or commit can interleave, so the
budget prepare measured still holds at commit. Every other host path that touches /workspace
(the control-plane stop and fence, the idle stop, the reverse-move export) stops the desktop
first, which ends every in-desktop exec; the kernel's commit is one rename(2), and the next open
is idempotent (``existing``, or a re-clone after the step-0 sweep). Those paths are not changed
here (lane rule: no other agent op changes), so a stop that begins after commit's check kills
commit instead of waiting for it: the residual is a retry, never a half-placed folder. Recorded
for the security review.

Host §8.1 (never exec into a desktop that is not running). Before EVERY exec, with nothing in
between but the cgroup lookup: no stop request, no stopping / shutdown-pending / export-quiesce
marker, no fence file, no pending export, no pending or running desktop restart, the guard stamp
names this lease's generation and epoch (the epoch fence), runc reports the desktop running and
its init pid is the one pinned at job start (a restarted desktop is a new container whose /run is
empty). On failure nothing is executed and the answer is ``runtime_not_running``; after prepare,
release is skipped too. Unlike Cloudflare, ``.ezil-staging/<uuid>`` is on the EBS volume and
survives a stop: the next prepare's step-0 sweep removes it (kernel LEFTOVER_MIN_AGE_MS); the
host never deletes inside the tenant-controlled tree from the host side.

Threat model (independent security review required before this rides an AMI)
------------------------------------------------------------------------------
An AWS pool host serves exactly ONE computer epoch and is then retired, and runs one desktop
container. The adversary is that computer's own user, with uid 0 inside the container and the
ability to replace any binary in it (node, sh, cat, git).
Protected: the agent's control channel (stop, fence, presence, idle-stop and billing); host
processes, PIDs, memory and file descriptors; other principals (computers, epochs, users); the
grant outside its own repository and computer (I1, I4).
Out of scope: a user slowing or failing their OWN repo-open (busy / failed answers); the grant
inside their own computer, which any process there can read for <= 15 min (contract §7 accepted
risk); content the user's own kernel replacement prints, beyond the sanitizer below.
  * Binding: every edge request is gw1 over this epoch's lease; the start body's sha256 is in
    the signed path; status names a 256-bit job id. The agent applies its HMAC, epoch,
    freshness and strictly increasing seq to each message. Job ids are single use; the used set
    is kept in runDir (tmpfs, 0600) for USED_ID_TTL > the gw1 window, so a captured start
    replayed within that window is refused even across an agent restart. An unreadable set
    refuses every start until USED_ID_TTL has passed (fail closed).
  * No interpolation: every exec is an argv list; request data and the grant travel only on
    stdin as a host-private regular file (a process that never reads stdin cannot block the
    agent); the constant shell programs receive uuid4-generated paths and constants as
    positional parameters. The grant is never in argv, env, a log line, a reply, or a file on
    the host other than that unlinked temporary file on tmpfs.
  * Bounds: stdout streamed under STDOUT_MAX, stderr discarded, one absolute deadline, relay
    body <= RELAY_MAX_BYTES (edge), at most JOBS_MAX results kept JOB_TTL, host memory only.
  * Process lifetime: each exec runs in its own fresh sub-cgroup of the desktop's cgroup
    (``runc exec --cgroup ezil-repo-open-<tag>-<id>``); afterwards, normal exit included, the
    launcher is killed and reaped first, then ``cgroup.kill``, ``populated 0``, rmdir (repeated
    if repopulated). No PID inside the container is ever signalled. An unconfirmed launcher exit
    or drain keeps the slot busy until the reaper confirms it; at agent start the slot is busy
    until a startup reap confirms no job cgroup is left. Without a cgroup v2 container directory
    with ``cgroup.kill`` nothing runs.
  * Output: the LAST stdout line of a kernel exec is reduced to exactly the §8 answer; any
    captured output that contains the grant or matches GRANT_SHAPE (``egg_`` + 64 hex) fails the
    job with ``workspace_failed`` (a repository may legitimately be named ``egg_x``, so the bare
    prefix is not a credential). Raw output never leaves the host; the Worker re-validates.

To verify on the AMI before rollout (carried over from cbe83f6a §4.1, plus repo-open items)
------------------------------------------------------------------------------------------
  * ``runc exec --cgroup`` with the systemd driver for the desktop's cgroupsPath, on the pinned
    runc (1.3.4);
  * containment of forked and reparented processes; read-only cgroupfs inside the container;
    drains across desktop restarts;
  * ``node`` resolves under runc exec's environment (the image Env PATH) in the promoted desktop
    lower; measured locally: /usr/local/bin/node v22.22.3, git 2.34.1 in
    ezil-os-desktop:staging-lower34ac-106 (git >= 2.28 for init -b; the codec's --sparse needs
    2.35, contract §19);
  * the AMI copies lib/ including lib/ezil_host/repo_open_assets/*.mjs (build-host-ami.sh copies
    lib with ``cp -a``), and the copies' sha256 equal REPO_OPEN_ASSETS;
  * egress from the desktop to git-preview.ezil.work; ``?folder=`` survives /preview-bootstrap
    into code-server (E-AWS, contract §20).

Recorded deviations from the Cloudflare path: one serial worker per host, so a refresh while an
open runs answers ``workspace_busy`` (Cloudflare lets a refresh of another repository proceed);
same-request joining is replaced by single-use job ids; no hydrate marker (AWS /workspace is the
EBS volume: the guard stamp is the readiness proof).
"""
import hashlib
import hmac
import json
import os
import re
import selectors
import subprocess
import tempfile
import threading
import time
import uuid
from datetime import datetime, timezone

from . import desktop, export, tunnel
from .fsops import DIR_FLAGS, read_regular_at
from .lease import strict_json

# ── constants (each compared with the vectors by test_repo_open_op) ─────────────────────────
WORKSPACE_ROOT = "/workspace"                      # vectors WORKSPACE_ROOT_DEFAULT; desktop.py binds it
REPO_OPEN_GIT_HOSTS = ("git-preview.ezil.work",)   # vectors workerRequest.gitHostAllowList
RUN_DIRS = ("/run/ezil", "/run/ezil/bin", "/run/ezil/git", "/run/ezil/git/grants", "/run/ezil/git/incoming",
            "/run/ezil/requests", "/run/ezil/locks")
KERNEL_PATH = "/run/ezil/bin/ezil-repo-open.mjs"
HELPER_MODULE_PATH = "/run/ezil/bin/ezil-git-grant.mjs"
STAGING_ROOT_NAME = ".ezil-staging"
SNAPSHOT_LIMIT_BYTES = 536870912
SNAPSHOT_MAX_ENTRIES = 100000
REPO_BUDGET_FRACTION = 0.8
WORKER_REQUEST_MAX_BYTES = 4096                    # vectors BODY_LIMITS_BYTES.workerRequest
# vectors timeouts
WORKER_DEADLINE_MS = 105_000
PREPARE_WINDOW_MS = 85_000
PREPARE_RESERVE_MS = 20_000
COMMIT_EXEC_MAX_MS = 10_000
COMMIT_MIN_REMAINING_MS = 15_000
WORKER_ACCEPT_EXPIRY_MAX_MS = 960_000
AWS_RELAY_POLL_MS = 1_500
# host-only time budget (see the module docstring)
SHORT_EXEC_MS = 10_000             # setup, refresh and release budgets, as the Worker's
HOST_DEADLINE_MS = 85_000          # from admission: every exec but release
RELEASE_GRACE_MS = 10_000          # release may run this long past the deadline
RELAY_SLACK_MS = 8_000             # Worker receipt -> host admission, the last status round trip, drains
PRECLEAR_CAP_S = 10.0              # leftovers from an earlier job must be gone within this
# relay and job bookkeeping
RELAY_MAX_BYTES = 4608             # the Worker's 4 KiB body plus jobId; edge.py enforces it
STDOUT_MAX = 16 * 1024             # a kernel answer is one short JSON line
JOBS_MAX = 32                      # retained results; the oldest finished one is evicted first
JOB_TTL = 600                      # seconds a finished job's result stays readable
USED_ID_TTL = 300                  # seconds a job id stays refused (> the gw1 window, 120 s + 5 s)
USED_IDS_MAX = 512
USED_IDS_FILE = "repo-open-jobs.json"   # runDir (tmpfs), 0600
CGROUP_PREFIX = "ezil-repo-open-"
DRAIN_CAP = 15.0                   # seconds one exec's cleanup may take before it is left to the reaper
REAP_RETRY_SECONDS = 5.0
# runDir markers under which no desktop runs (= agent.DESKTOP_DOWN_MARKERS; tested)
DOWN_MARKERS = (desktop.STOPPING, "shutdown-pending", desktop.EXPORT_QUIESCE)
MESSAGE_KEYS = frozenset({"op", "leaseEpoch", "ts", "seq", "mac", "request"})
STATUS_MESSAGE_KEYS = frozenset({"op", "leaseEpoch", "ts", "seq", "mac", "jobId"})

# The kernel and helper, sha256-pinned (byte-equal to worker/src/repo-open-assets; tested).
ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "repo_open_assets")
REPO_OPEN_ASSETS = {
    "ezil-repo-open.mjs": "d9168d346ef88ecd2dc2c33d55ad5bb85fecfd707bece4a6940781e535a219aa",
    "ezil-git-grant.mjs": "5de6b39aeb9ecbdc03cf3334e45047652b7249f0a395227deea92000f61ba55e",
}
ASSET_MAX_BYTES = 262144

JOB_RE = re.compile(r"\A[0-9a-f]{64}\Z")
TAG_RE = re.compile(r"\A[0-9a-f]{16}\Z")
UUID_RE = re.compile(r"\A[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
HANDLE_RE = re.compile(r"\A[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\Z")
NAME_RE = re.compile(r"\A[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?\Z")
BRANCH_RE = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._/-]{0,243}\Z")
GRANT_RE = re.compile(r"\Aegg_[0-9a-f]{64}\Z")
PATH_SEGMENT_RE = re.compile(r"\A[A-Za-z0-9._-]+\Z")
ISO_RE = re.compile(r"\A([0-9]{4})-([0-9]{2})-([0-9]{2})T([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.([0-9]{1,3}))?Z\Z")
GRANT_SHAPE = re.compile(rb"egg_[0-9a-f]{64}")
CONTROL_CHAR_RE = re.compile(r"[\x00-\x1f\x7f]")

# Constant programs. Request data never appears here: paths arrive as positional parameters.
WRITE_PROGRAM = 'umask 077 && cat > "$1"'
INSTALL_PROGRAM = 'chmod 0500 -- "$1" "$2" && mv -f -- "$1" "$3" && mv -f -- "$2" "$4" && chmod 0600 -- "$5" "$6"'
FALLBACK_PROGRAM = 'rm -rf -- "$1"; rm -f -- "$2" "$3" "$4" "$5"'

# §8 "Responses" (vectors errorTable.workerResponses.refusals), for the codes the host can answer.
REPO_OPEN_STATUS = {
    "runtime_not_running": 409, "workspace_not_ready": 409, "workspace_busy": 409, "folder_conflict": 409,
    "repository_too_large": 409, "network_unavailable": 502, "git_auth_rejected": 502,
    "repository_unavailable": 502, "workspace_failed": 500,
}
KERNEL_ERROR_CODES = ("folder_conflict", "repository_too_large", "git_auth_rejected", "repository_unavailable",
                      "network_unavailable", "workspace_busy", "workspace_failed")
OPEN_STATES = ("cloned", "initialized_empty", "existing")
OPEN_KEYS = ("ok", "state", "folder", "openFolder", "pathNotFound", "branch", "empty")
START_REFUSALS = frozenset({"workspace_busy", "job_replayed", "repo_open_invalid", "workspace_failed"})
STATUS_REFUSALS = frozenset({"job_unknown", "repo_open_invalid"})
BODY_KEYS = ("v", "op", "repositoryId", "handle", "name", "gitHost", "defaultBranch", "path", "grant")
GRANT_KEYS = ("username", "token", "expiresAt", "scope")
RELAY_KEYS = frozenset(("jobId",) + BODY_KEYS)


# ── validation (the Worker's parseRepoOpenBody, field for field) ────────────────────────────
def _str(v):
    return isinstance(v, str)


def valid_name(s):
    return _str(s) and bool(NAME_RE.match(s)) and ".." not in s and not s.endswith(".git")


def valid_branch(s):
    return (_str(s) and bool(BRANCH_RE.match(s)) and ".." not in s and "//" not in s and not s.endswith("/")
            and not s.endswith(".lock") and "/." not in s and not s.endswith("."))


def path_problem(value):
    """app-link.js pathProblem (vectors link.path); None when acceptable."""
    if value == "":
        return "empty"
    if len(value.encode("utf-8", "surrogatepass")) > 255:
        return "too_long"
    if value.startswith("/"):
        return "absolute"
    if "\\" in value:
        return "backslash"
    if CONTROL_CHAR_RE.search(value):
        return "control"
    for segment in value.split("/"):
        if segment in (".", ".."):
            return "dot_segment"
        if not PATH_SEGMENT_RE.match(segment):
            return "segment"
    return None


def iso_ms(value):
    """Epoch ms of an ISO-8601 UTC timestamp in the Worker's ISO_RE shape, or None."""
    m = ISO_RE.match(value) if _str(value) else None
    if not m:
        return None
    try:
        dt = datetime(*(int(m.group(i)) for i in range(1, 7)), tzinfo=timezone.utc)
    except ValueError:
        return None
    return int(dt.timestamp()) * 1000 + int((m.group(7) or "0").ljust(3, "0"))


def _exact(value, keys):
    return isinstance(value, dict) and len(value) == len(keys) and all(k in value for k in keys)


def valid_job_id(v):
    return _str(v) and bool(JOB_RE.match(v))


def parse_relay(raw, now_ms):
    """The Worker's relay -> (jobId, §8 body). ValueError on anything outside the contract;
    never echoes a value. Same rules as worker/src/repo-open.ts parseRepoOpenBody, stricter
    only where Python and JSON differ (v must be the integer 1)."""
    if not isinstance(raw, dict) or set(raw) != RELAY_KEYS or not valid_job_id(raw.get("jobId")):
        raise ValueError("repo_open_invalid")
    b, g = raw, raw.get("grant")
    if not _exact(g, GRANT_KEYS):
        raise ValueError("repo_open_invalid")
    expires = iso_ms(g.get("expiresAt"))
    path = b.get("path")
    ok = (type(b.get("v")) is int and b["v"] == 1 and b.get("op") in ("open", "refresh")
          and _str(b.get("repositoryId")) and bool(UUID_RE.match(b["repositoryId"]))
          and _str(b.get("handle")) and bool(HANDLE_RE.match(b["handle"])) and valid_name(b.get("name"))
          and b.get("gitHost") in REPO_OPEN_GIT_HOSTS and valid_branch(b.get("defaultBranch"))
          and (path is None or (b["op"] == "open" and _str(path) and path_problem(path) is None))
          and g.get("username") == "ezil" and _str(g.get("token")) and bool(GRANT_RE.match(g["token"]))
          and g.get("scope") in ("write", "read")
          and expires is not None and now_ms < expires <= now_ms + WORKER_ACCEPT_EXPIRY_MAX_MS)
    if not ok:
        raise ValueError("repo_open_invalid")
    body = {k: b[k] for k in BODY_KEYS if k != "grant"}
    body["grant"] = {k: g[k] for k in GRANT_KEYS}
    return raw["jobId"], body


def decode_relay(data):
    """Edge: the digest-checked bytes as a JSON object (duplicate keys and NaN refused), or None."""
    try:
        value = strict_json(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


# ── assets ──────────────────────────────────────────────────────────────────────────────────
class AssetError(Exception):
    """A pinned asset is missing, oversized or not byte-identical to its sha256 pin."""


def load_assets(asset_dir=None, pins=None):
    """{name: bytes} for the kernel and helper, each verified against its sha256 pin."""
    asset_dir = asset_dir or ASSET_DIR
    out = {}
    try:
        dfd = os.open(asset_dir, DIR_FLAGS)
    except OSError as e:
        raise AssetError("repo_open_assets_missing") from e
    try:
        for name, want in (pins or REPO_OPEN_ASSETS).items():
            data = read_regular_at(dfd, name, limit=ASSET_MAX_BYTES)
            if data is None or not hmac.compare_digest(hashlib.sha256(data).hexdigest(), want):
                raise AssetError("repo_open_asset_digest_mismatch")
            out[name] = data
    finally:
        os.close(dfd)
    return out


# ── answers and the sanitizer ───────────────────────────────────────────────────────────────
def refusal(code):
    """The §8 refusal, built from the fixed code itself (no upstream text ever reaches it)."""
    return {"status": REPO_OPEN_STATUS[code], "body": {"ok": False, "error": code}}


def last_json_line(stdout):
    """The LAST non-empty stdout line as a JSON object, or None."""
    try:
        lines = [line for line in stdout.decode("utf-8").split("\n") if line.strip()]
        value = strict_json(lines[-1]) if lines else None
    except (UnicodeDecodeError, ValueError, TypeError):
        return None
    return value if isinstance(value, dict) else None


def kernel_refusal(value):
    code = value.get("errorCode")
    if _exact(value, ("ok", "errorCode")) and value["ok"] is False and code in KERNEL_ERROR_CODES:
        return refusal(code)
    return refusal("workspace_failed")


def open_answer(value, folder):
    """A kernel commit result for op open, validated as strictly as the OS validates the
    Worker's 200 (vectors errorTable.workerResponses.okRule)."""
    if value is None:
        return refusal("workspace_failed")
    if value.get("ok") is False:
        return kernel_refusal(value)
    of = value.get("openFolder")
    if (not _exact(value, OPEN_KEYS) or value["ok"] is not True or value["state"] not in OPEN_STATES
            or value["folder"] != folder or not _str(of) or not (of == folder or of.startswith(folder + "/"))
            or len(of.encode("utf-8", "surrogatepass")) > 4096 or CONTROL_CHAR_RE.search(of)
            or not isinstance(value["pathNotFound"], bool) or not isinstance(value["empty"], bool)
            or not valid_branch(value["branch"])):
        return refusal("workspace_failed")
    return {"status": 200, "body": {k: value[k] for k in OPEN_KEYS}}


def refresh_answer(value):
    if value is None:
        return refusal("workspace_failed")
    if value.get("ok") is not True:
        return kernel_refusal(value)
    if _exact(value, ("ok", "state")) and value["state"] == "refreshed":
        return {"status": 200, "body": {"ok": True, "state": "refreshed"}}
    return refusal("workspace_failed")


def leaked(outputs, token):
    """Anything grant-shaped, or the grant itself, in any captured output."""
    t = token.encode()
    return any(t in out or GRANT_SHAPE.search(out) for out in outputs)


# ── the desktop, its cgroup and bounded execs ───────────────────────────────────────────────
class ExecLimit(Exception):
    """The exec overran its deadline (timed_out) or its output bound, and was killed."""

    def __init__(self, timed_out, output=b""):
        super().__init__("timeout" if timed_out else "overflow")
        self.timed_out, self.output = timed_out, output


class CleanupPending(Exception):
    """A job cgroup or launcher could not be confirmed gone; it keeps the host's slot."""


class ContainerAbsent(Exception):
    """runc positively reports no desktop container (so it has no cgroups either)."""


def desktop_probe(cfg, timeout=10.0):
    """(status, init pid) from runc state, bounded. ContainerAbsent when runc says it does
    not exist; OSError for anything uncertain."""
    try:
        r = desktop.runc(cfg, "state", cfg.containerId, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        raise OSError("desktop_state_timeout") from None
    if r.returncode != 0:
        if "not exist" in (r.stderr or ""):
            raise ContainerAbsent()
        raise OSError("desktop_state_unavailable")
    try:
        state = json.loads(r.stdout)
    except ValueError:
        raise OSError("desktop_state_unavailable") from None
    if not isinstance(state, dict):
        raise OSError("desktop_state_unavailable")
    status, pid = state.get("status"), state.get("pid")
    if not _str(status) or not isinstance(pid, int) or isinstance(pid, bool) or pid <= 1:
        raise OSError("desktop_state_unavailable")
    return status, pid


def cgroup_root_of(pid):
    """The container's cgroup v2 directory, from its init process."""
    with open(f"/proc/{pid}/cgroup") as f:
        for line in f:
            if line.startswith("0::/"):
                path = os.path.realpath("/sys/fs/cgroup" + line[3:].strip())
                if path.startswith("/sys/fs/cgroup/") and os.path.isfile(os.path.join(path, "cgroup.kill")):
                    return path
    raise OSError("desktop_cgroup_unavailable")


def _cgroup_populated(path):
    """True unless the kernel says `populated 0` (any read error counts as populated)."""
    try:
        with open(os.path.join(path, "cgroup.events")) as f:
            return not any(line.strip() == "populated 0" for line in f)
    except FileNotFoundError:
        return False
    except OSError:
        return True


def _drain_cgroup(path, cap=DRAIN_CAP, clock=time.monotonic, sleep=time.sleep):
    """cgroup.kill the job cgroup, wait for `populated 0`, remove it; repeat if repopulated.
    Every process in it dies, including a reparented orphan (cgroupfs is read-only in the
    container). Anything not confirmed within `cap` raises CleanupPending and LEAVES it."""
    deadline = clock() + cap
    while True:
        try:
            os.stat(path)                      # FileNotFoundError = confirmed absent
            with open(os.path.join(path, "cgroup.kill"), "w") as f:
                f.write("1")
            while _cgroup_populated(path):
                if clock() > deadline:
                    raise CleanupPending()
                sleep(0.05)
            os.rmdir(path)
            return
        except FileNotFoundError:
            return
        except OSError:
            if clock() > deadline:
                raise CleanupPending()
            sleep(0.1)


def bounded_runc_exec(cfg, argv, deadline, data=None, limit=STDOUT_MAX, tag="0" * 16, cgroup_root=None,
                      clock=time.monotonic):
    """`runc exec` of `argv` (a list; never a shell string with data) in the desktop, in a fresh
    sub-cgroup of `cgroup_root` (the container's cgroup, from the caller's host check). Stdin is
    `data` as a host-private unlinked regular file in runDir; stderr is discarded; stdout is
    streamed under `limit` until the ABSOLUTE monotonic `deadline`. Afterwards, normal exit
    included, the launcher is killed and reaped first, then the sub-cgroup is drained.
    Returns (returncode, stdout). ExecLimit on an overrun (with the partial output),
    CleanupPending if cleanup is unconfirmed, OSError/ValueError when nothing could run."""
    if not TAG_RE.match(tag):
        raise ValueError("repo_open_tag_invalid")
    if not isinstance(argv, list) or not argv or not all(_str(a) for a in argv):
        raise ValueError("repo_open_argv_invalid")
    if deadline - clock() <= 0:
        raise ExecLimit(True)
    if not cgroup_root or not os.path.isfile(os.path.join(cgroup_root, "cgroup.kill")):
        raise OSError("desktop_cgroup_unavailable")
    name = f"{CGROUP_PREFIX}{tag}-{uuid.uuid4().hex[:16]}"
    path = os.path.join(cgroup_root, name)
    os.mkdir(path, 0o755)
    proc = None
    launcher_stuck = False
    out = bytearray()
    overrun = timed_out = False
    try:
        cmd = [cfg.runcBin, "--root", os.path.join(cfg.runDir, "runc"), "--systemd-cgroup",
               "exec", "--cgroup", name, cfg.containerId, *argv]
        stdin = subprocess.DEVNULL
        if data is not None:
            stdin = tempfile.TemporaryFile(dir=os.path.dirname(desktop._run_file(cfg, "repo-open")))
            stdin.write(data)
            stdin.seek(0)
        try:
            proc = subprocess.Popen(cmd, stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        finally:
            if data is not None:
                stdin.close()
        with selectors.DefaultSelector() as sel:
            sel.register(proc.stdout, selectors.EVENT_READ)
            while True:
                left = deadline - clock()
                if left <= 0:
                    overrun = timed_out = True
                    break
                if not sel.select(min(left, 1.0)):
                    continue
                chunk = os.read(proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                out += chunk
                if len(out) > limit:
                    overrun = True
                    break
        rc = None
        if not overrun:
            try:
                rc = proc.wait(timeout=max(0.1, deadline - clock()))
            except subprocess.TimeoutExpired:
                overrun = timed_out = True
    finally:
        try:
            if proc is not None:
                proc.kill()
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    launcher_stuck = True
                finally:
                    proc.stdout.close()
        finally:
            try:
                _drain_cgroup(path)
            except CleanupPending:
                # Never lose a stuck launcher behind a drain failure: both must be confirmed.
                raise CleanupPending(proc if launcher_stuck else None) from None
    if launcher_stuck:
        raise CleanupPending(proc)
    if overrun:
        raise ExecLimit(timed_out, bytes(out[:limit]))
    return rc, bytes(out)


def reap_cgroups(cfg):
    """Remove empty job cgroups and cgroup.kill populated ones (left by an unconfirmed cleanup
    or an earlier agent process). Returns how many remain (0 = clear). Discovery reports 0 only
    when the container is positively absent; any uncertainty counts as 1 remaining."""
    try:
        _, pid = desktop_probe(cfg)
        root = cgroup_root_of(pid)
    except ContainerAbsent:
        return 0
    except (OSError, ValueError, subprocess.SubprocessError):
        return 1
    try:
        names = [n for n in os.listdir(root) if n.startswith(CGROUP_PREFIX)]
    except OSError:
        return 1
    remaining = 0
    for name in names:
        path = os.path.join(root, name)
        if not _cgroup_populated(path):
            try:
                os.rmdir(path)
                continue
            except FileNotFoundError:
                continue
            except OSError:
                pass
        else:
            try:
                with open(os.path.join(path, "cgroup.kill"), "w") as f:
                    f.write("1")
            except OSError:
                pass
        remaining += 1
    return remaining


# ── the runner: one serial job per host ─────────────────────────────────────────────────────
STOPPED = ("stopped",)


class Runner:
    """Admission, status and the one job thread. The control path (start/status) only touches
    host memory and one small tmpfs file under a tiny lock; every exec runs in the job thread."""

    def __init__(self, agent):
        self.agent, self.cfg, self.lease = agent, agent.cfg, agent.lease
        self.clock = agent.clock
        self.lock = threading.Lock()
        self.jobs = {}                 # jobId -> {"state", "result", "at"}; host memory only
        self.busy = True               # until startup() confirms no job cgroup is left
        self.stuck = []                # launchers whose exit was not confirmed
        self.quiet_until = 0.0
        self.used = self._load_used()

    # ---------------------------------------------------------------- used job ids (tmpfs)
    def _used_path(self):
        return desktop._run_file(self.cfg, USED_IDS_FILE)

    def _load_used(self):
        try:
            dfd = os.open(self.cfg.runDir, DIR_FLAGS)
            try:
                raw = read_regular_at(dfd, USED_IDS_FILE, limit=65536)
                absent = raw is None and not os.path.lexists(os.path.join(self.cfg.runDir, USED_IDS_FILE))
            finally:
                os.close(dfd)
            if absent:
                return {}
            record = strict_json(raw.decode()) if raw is not None else None
            if isinstance(record, dict) and record.get("leaseEpoch") != self.lease.get("leaseEpoch"):
                return {}                  # another epoch's ids: gw1 binds the epoch
            ids = record.get("ids") if isinstance(record, dict) else None
            if (isinstance(ids, dict) and len(ids) <= USED_IDS_MAX and all(valid_job_id(k) for k in ids)
                    and all(isinstance(v, (int, float)) and not isinstance(v, bool) for v in ids.values())):
                return dict(ids)
        except (OSError, ValueError, AttributeError, UnicodeDecodeError):
            pass
        # Unreadable: refuse every start until any id it may have held is too old to replay.
        self.quiet_until = self.clock() + USED_ID_TTL
        return {}

    def _remember(self, job_id, now):
        ids = {k: v for k, v in self.used.items() if now - v < USED_ID_TTL}
        if len(ids) >= USED_IDS_MAX:
            return False
        ids[job_id] = now
        try:
            desktop._write_private_atomic(self._used_path(), json.dumps(
                {"v": 1, "leaseEpoch": self.lease.get("leaseEpoch"), "ids": ids}, separators=(",", ":")).encode())
        except (OSError, ValueError):
            return False
        self.used = ids
        return True

    # ---------------------------------------------------------------- control path
    def _prune(self, now):
        for job_id in [j for j, v in self.jobs.items() if v["state"] == "done" and now - v["at"] > JOB_TTL]:
            del self.jobs[job_id]

    def start(self, job_id, body):
        """Admit one job: a flag flip, the used-id write and a thread start. Job ids are single
        use: a known id is refused (job_replayed), never joined or re-run."""
        now = self.clock()
        with self.lock:
            self._prune(now)
            if job_id in self.jobs or (job_id in self.used and now - self.used[job_id] < USED_ID_TTL):
                return {"ok": False, "error": "job_replayed"}
            if self.busy or now < self.quiet_until:
                return {"ok": False, "error": "workspace_busy"}
            if not self._remember(job_id, now):
                return {"ok": False, "error": "workspace_busy"}
            while len(self.jobs) >= JOBS_MAX:   # only finished jobs remain: one slot per host
                oldest = min(self.jobs, key=lambda j: self.jobs[j]["at"])
                del self.jobs[oldest]
            self.busy = True
            self.jobs[job_id] = {"state": "running", "result": None, "at": now}
            admitted = (time.monotonic(), now)
        try:
            threading.Thread(target=self._job, args=(job_id, body, admitted), name="repo-open", daemon=True).start()
        except RuntimeError:
            with self.lock:
                self.jobs.pop(job_id, None)    # never a reservation without a thread (the id stays used)
                self.busy = False
            return {"ok": False, "error": "workspace_failed"}
        return {"ok": True, "state": "running"}

    def status(self, job_id):
        with self.lock:
            self._prune(self.clock())
            job = self.jobs.get(job_id)
            if job is None:
                return {"ok": False, "error": "job_unknown"}
            if job["state"] == "running":
                return {"ok": True, "state": "running"}
            return {"ok": True, "state": "done", "result": job["result"]}

    # ---------------------------------------------------------------- job thread
    def _log(self, line):
        try:
            self.agent.log(line)
        except Exception:   # noqa: BLE001 — a failing logger never changes repo-open state
            pass

    def _clear(self, deadline=None):
        """Reap until no job cgroup and no stuck launcher remain (True), or `deadline`."""
        while True:
            self.stuck = [p for p in self.stuck if p.poll() is None]
            if not self.stuck and reap_cgroups(self.cfg) == 0:
                return True
            if deadline is not None and time.monotonic() >= deadline:
                return False
            time.sleep(0.2 if deadline is not None else REAP_RETRY_SECONDS)

    def startup(self):
        """Agent start: end whatever an earlier agent process left in job cgroups, then accept work."""
        self._clear()
        with self.lock:
            self.busy = False

    def _job(self, job_id, body, admitted):
        result = refusal("workspace_failed")
        outcome = "workspace_failed"
        pending = False
        try:
            mono, wall = admitted
            deadline = mono + HOST_DEADLINE_MS / 1000
            if not self._clear(min(deadline, time.monotonic() + PRECLEAR_CAP_S)):
                pending = True
            else:
                result = Flight(self, body, job_id[:16], deadline, int(wall * 1000) + HOST_DEADLINE_MS).run()
                outcome = "ok" if result["status"] == 200 else result["body"]["error"]
        except CleanupPending as e:
            pending = True
            outcome = "cleanup_pending"
            if e.args and isinstance(e.args[0], subprocess.Popen):
                self.stuck.append(e.args[0])
        except Exception:   # noqa: BLE001 — never let a job thread die silently
            pass
        finally:
            # Publish the terminal state FIRST; logging can never block it.
            with self.lock:
                self.jobs[job_id] = {"state": "done", "result": result, "at": self.clock()}
            self._log(f"repo_open op={body.get('op')} outcome={outcome}")
            if pending:
                self._clear()          # the slot is released only once cleanup is confirmed
            with self.lock:
                self.busy = False

    # ---------------------------------------------------------------- host checks
    def blocked(self):
        """A stop, fence, desktop restart or export is pending: nothing may run in the desktop."""
        a = self.agent
        if a.stop_request is not None or a.restart_request or a.restart_in_progress:
            return True
        if any(os.path.lexists(os.path.join(self.cfg.runDir, m)) for m in DOWN_MARKERS):
            return True
        if os.path.lexists(tunnel.fence_path(self.cfg)):
            return True
        try:
            return export.pending(self.cfg)
        except Exception:   # noqa: BLE001 — unknown export state blocks (fail closed)
            return True

    def epoch_ok(self):
        """The epoch fence: the guard passed THIS lease (generation and epoch) this boot, so the
        data volume bound at /workspace is this computer's (the stamp goes at shutdown)."""
        try:
            dfd = os.open(self.cfg.runDir, DIR_FLAGS)
            try:
                raw = read_regular_at(dfd, "guard-ok", limit=65536)
            finally:
                os.close(dfd)
            stamp = strict_json(raw.decode()) if raw is not None else None
        except (OSError, ValueError, UnicodeDecodeError):
            return False
        return (isinstance(stamp, dict) and all(
            stamp.get(k) == self.lease.get(k) and type(stamp.get(k)) is int for k in ("generation", "leaseEpoch")))

    def probe(self, timeout=10.0):
        try:
            return desktop_probe(self.cfg, timeout)
        except (ContainerAbsent, OSError, ValueError, subprocess.SubprocessError):
            return None


class Flight:
    """One job: §8 steps 3-11 on the host. Answers {status, body}; raises CleanupPending."""

    def __init__(self, runner, body, tag, deadline, deadline_ms):
        self.r, self.cfg, self.b, self.tag = runner, runner.cfg, body, tag
        self.deadline, self.deadline_ms = deadline, deadline_ms
        self.uuid = str(uuid.uuid4())
        self.pid = None
        self.outputs = []
        self.folder = f"{WORKSPACE_ROOT}/repos/{body['handle']}/{body['name']}"
        self.request_path = f"/run/ezil/requests/{self.uuid}.json"
        self.incoming = f"/run/ezil/git/incoming/{self.uuid}.json"
        self.staging = f"{WORKSPACE_ROOT}/{STAGING_ROOT_NAME}/{self.uuid}"
        self.kernel_tmp = f"/run/ezil/bin/.ezil-repo-open.{self.uuid}.mjs"
        self.helper_tmp = f"/run/ezil/bin/.ezil-git-grant.{self.uuid}.mjs"

    # ------------------------------------------------------------- files
    def request(self, phase):
        """§9.2 request file (no secret). One serial job per host: inflight is this uuid."""
        b = self.b
        return json.dumps({
            "v": 1, "op": b["op"], "phase": phase, "uuid": self.uuid, "inflight": [self.uuid],
            "repositoryId": b["repositoryId"], "handle": b["handle"], "name": b["name"], "gitHost": b["gitHost"],
            "defaultBranch": b["defaultBranch"], "path": b["path"], "root": WORKSPACE_ROOT, "staging": self.staging,
            "incoming": self.incoming, "deadlineMs": self.deadline_ms,
            "budget": {"limitBytes": SNAPSHOT_LIMIT_BYTES, "maxEntries": SNAPSHOT_MAX_ENTRIES,
                       "fraction": REPO_BUDGET_FRACTION},
        }, separators=(",", ":")).encode()

    def grant_file(self):
        """§9.3 grant file content: written as the incoming file, moved into place by the kernel."""
        b, g = self.b, self.b["grant"]
        return json.dumps({"v": 1, "protocol": "https", "host": b["gitHost"], "path": f"{b['handle']}/{b['name']}.git",
                           "username": g["username"], "password": g["token"], "expiresAt": g["expiresAt"],
                           "scope": g["scope"]}, separators=(",", ":")).encode()

    # ------------------------------------------------------------- host §8.1
    def guard(self):
        """The cgroup root to exec in, or None: nothing may run (see the module docstring)."""
        if self.r.blocked() or not self.r.epoch_ok():
            return None
        if self.r.probe() != ("running", self.pid):
            return None
        try:
            return cgroup_root_of(self.pid)
        except OSError:
            return None

    def exec_(self, argv, deadline, data=None):
        """("done", rc, stdout) | STOPPED | ("error", timed_out). The host check runs first."""
        if deadline - time.monotonic() <= 0:
            return ("error", True)
        root = self.guard()
        if root is None:
            return STOPPED
        try:
            rc, out = bounded_runc_exec(self.cfg, argv, deadline, data, tag=self.tag, cgroup_root=root)
        except ExecLimit as e:
            self.outputs.append(e.output)
            return ("error", e.timed_out)
        except (OSError, ValueError):
            return ("error", False)
        self.outputs.append(out)
        return ("done", rc, out)

    def write(self, path, data, deadline):
        return self.exec_(["/bin/sh", "-c", WRITE_PROGRAM, "sh", path], deadline, data)

    def kernel(self, phase, deadline):
        return self.exec_(["node", KERNEL_PATH, phase, self.request_path], deadline)

    @staticmethod
    def ok(res):
        return res[0] == "done" and res[1] == 0

    @staticmethod
    def failure(res, timeout_code):
        """What a failed op (not a kernel answer) means; None for a completed exec."""
        if res is STOPPED:
            return refusal("runtime_not_running")
        if res[0] == "error":
            return refusal(timeout_code if res[1] else "workspace_failed")
        return None

    # ------------------------------------------------------------- the steps
    def run(self):
        b = self.b
        # Step 3 (host): nothing pending, this epoch's volume, the desktop running; pin its init.
        if self.r.blocked():
            return refusal("runtime_not_running")
        if not self.r.epoch_ok():
            return refusal("workspace_not_ready")
        probe = self.r.probe()
        if probe is None or probe[0] != "running":
            return refusal("runtime_not_running")
        self.pid = probe[1]
        try:
            assets = load_assets()
        except AssetError:
            return refusal("workspace_failed")      # nothing ran: a tampered or missing asset
        now = time.monotonic
        stopped = False
        dispatched_write = False

        # Steps 6-7: one SHORT_EXEC_MS budget for all of setup.
        setup_deadline = min(self.deadline, now() + SHORT_EXEC_MS / 1000)
        steps = [
            lambda: self.exec_(["install", "-d", "-m", "0700", *RUN_DIRS], setup_deadline),
            lambda: self.write(self.kernel_tmp, assets["ezil-repo-open.mjs"], setup_deadline),
            lambda: self.write(self.helper_tmp, assets["ezil-git-grant.mjs"], setup_deadline),
            lambda: self.write(self.incoming, self.grant_file(), setup_deadline),
            lambda: self.write(self.request_path, self.request("prepare" if b["op"] == "open" else "refresh"),
                               setup_deadline),
            lambda: self.exec_(["/bin/sh", "-c", INSTALL_PROGRAM, "sh", self.kernel_tmp, self.helper_tmp, KERNEL_PATH,
                                HELPER_MODULE_PATH, self.incoming, self.request_path], setup_deadline),
        ]
        setup_ok = True
        res = None
        for i, step in enumerate(steps):
            dispatched_write = dispatched_write or i >= 1
            res = step()
            if not self.ok(res):
                setup_ok = False
                break
        if not setup_ok:
            answer = self.failure(res, "workspace_failed") or refusal("workspace_failed")
            stopped = res is STOPPED
        elif b["op"] == "open":
            # Step 8: prepare holds nothing; network happens only here.
            timeout = min(PREPARE_WINDOW_MS / 1000, self.deadline - PREPARE_RESERVE_MS / 1000 - now())
            if timeout <= 0:
                answer = refusal("workspace_busy")
            else:
                prepared = self.kernel("prepare", now() + timeout)
                if prepared is STOPPED or self.guard() is None:
                    # A stop, fence or desktop restart while prepare ran: no further exec.
                    stopped = True
                    answer = refusal("runtime_not_running")
                else:
                    failed = self.failure(prepared, "workspace_busy")
                    value = None if failed else last_json_line(prepared[2])
                    if failed:
                        answer = failed
                    elif leaked(self.outputs, b["grant"]["token"]) or value is None:
                        answer = refusal("workspace_failed")
                    elif value.get("ok") is not True:
                        answer = kernel_refusal(value)
                    elif self.deadline - now() < COMMIT_MIN_REMAINING_MS / 1000:
                        answer = refusal("workspace_busy")
                    else:
                        # Step 9: commit, inside the host's one job slot, after the host check.
                        commit_deadline = min(self.deadline, now() + COMMIT_EXEC_MAX_MS / 1000)
                        res = self.write(self.request_path, self.request("commit"), commit_deadline)
                        if self.ok(res):
                            res = self.kernel("commit", commit_deadline)
                        stopped = res is STOPPED
                        # A commit timeout is retryable (vectors workerExec.timeoutErrorByStep): the
                        # rename may have happened, and the next open is idempotent.
                        answer = self.failure(res, "workspace_busy") or open_answer(last_json_line(res[2]), self.folder)
        else:
            # Step 10.
            res = self.kernel("refresh", min(self.deadline, now() + SHORT_EXEC_MS / 1000))
            stopped = res is STOPPED
            answer = self.failure(res, "workspace_failed") or refresh_answer(last_json_line(res[2]))

        # Step 11: release on every outcome, unless the desktop stopped (no exec then).
        if not stopped and dispatched_write:
            cap = self.deadline + RELEASE_GRACE_MS / 1000
            released = False
            if setup_ok:
                rel_deadline = min(cap, now() + SHORT_EXEC_MS / 1000)
                res = self.write(self.request_path, self.request("release"), rel_deadline)
                if self.ok(res):
                    res = self.kernel("release", rel_deadline)
                    value = last_json_line(res[2]) if res[0] == "done" else None
                    released = res[0] == "done" and value == {"ok": True}
                stopped = res is STOPPED
            if not released and not stopped:
                self.exec_(["/bin/sh", "-c", FALLBACK_PROGRAM, "sh", self.staging, self.request_path, self.incoming,
                            self.kernel_tmp, self.helper_tmp], min(cap, now() + SHORT_EXEC_MS / 1000))
        return refusal("workspace_failed") if leaked(self.outputs, b["grant"]["token"]) else answer


__all__ = ["Runner", "parse_relay", "decode_relay", "valid_job_id", "load_assets", "bounded_runc_exec",
           "reap_cgroups", "REPO_OPEN_STATUS", "RELAY_MAX_BYTES"]
