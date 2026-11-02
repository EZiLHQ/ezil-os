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
     path:string|null, grant:{username:'ezil', token, expiresAt, scope}}``, plus (contract 1.0.3)
     the one optional key ``class: 'personal'|'assessment'`` (absent = personal). gitHost must be
     REPO_OPEN_CLASS_GIT_HOSTS[class], a closed table (personal -> git-preview.ezil.work,
     assessment -> git-qa.ezil.work), refused in both directions; ``class`` reaches the kernel
     request only when the relay carried it. Every field is re-validated here with the Worker's
     rules (parse_relay).
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
     'existing', folder, openFolder, pathNotFound, branch, empty}}`` (open; for class assessment
     ``state`` is never 'existing' and the body adds ``head`` (40 hex, or null for an unborn
     branch) and ``clean`` (boolean), vectors errorTable.workerResponses.okOpenAssessment),
     ``{status:200, body:{ok:true, state:'refreshed'}}`` (refresh), or
     ``{status, body:{ok:false, error}}`` with status from REPO_OPEN_STATUS (vectors
     errorTable.workerResponses.refusals). Host-originated codes: ``runtime_not_running`` (a
     stop, fence, desktop restart or export is pending, or the desktop is not running or was
     replaced), ``workspace_not_ready`` (the data volume did not pass the guard for this epoch),
     ``workspace_busy``, ``workspace_failed``; the kernel's own codes pass through.

The job (one serial worker per host; the host serves exactly one computer epoch)
---------------------------------------------------------------------------------
Host steps mirror §8 steps 3-11 (worker/src/repo-open.ts runFlight):
  * pre-clear: job cgroups left by an earlier job or agent process are killed and confirmed
    gone (at most PRECLEAR_CAP_S) before anything runs; otherwise ``workspace_busy`` and the
    slot stays busy until the reaper confirms. Nothing runs at agent start (no thread, no runc
    call): this pre-clear is the guard, so Phase B is inert until a signed start arrives;
  * step 3: nothing pending, guard stamp of THIS epoch, desktop running; the desktop's init pid
    is pinned for the whole job;
  * setup (one SHORT_EXEC_MS budget): ``install -d -m 0700 RUN_DIRS``; the kernel, helper,
    incoming grant and request are each written over runc exec STDIN (a host-private, unlinked
    temporary file in runDir) by a constant shell program that receives only generated paths as
    positional parameters; a constant install program moves kernel and helper into place;
  * open: ``node KERNEL prepare REQUEST`` (no lock; network) within
    min(PREPARE_WINDOW, deadline - PREPARE_RESERVE - now); the host check again; then, if at
    least COMMIT_MIN_REMAINING is left, ``node KERNEL commit REQUEST`` (COMMIT_EXEC_MAX);
  * refresh: ``node KERNEL refresh REQUEST``;
  * release on every outcome unless the desktop positively stopped: ``node KERNEL release
    REQUEST``, and on its failure the constant fallback program over this request's generated
    paths; both go through the host check like every exec.

Timing chain. One absolute deadline (HOST_DEADLINE_MS from admission) bounds every exec but
release INCLUDING its cleanup, and release and the fallback, cleanup included, end within
RELEASE_GRACE_MS beyond it: each exec's launcher kill-wait and cgroup drain are cut to the time
left before that bound (``cleanup_by``), and every runc state probe is bounded by the time left
before the exec it guards (``probe_timeout``, floor PROBE_MIN_S). So the result is published by
HOST_DEADLINE + RELEASE_GRACE (+ one PROBE_MIN_S and scheduling, inside RELAY_SLACK), and
HOST_DEADLINE + RELEASE_GRACE + AWS_RELAY_POLL + RELAY_SLACK <= WORKER_DEADLINE (tested against
the vectors, and with slow probes, execs and drains). An exec whose cleanup is still not
confirmed by then (CleanupPending) ends the job: the answer already computed is published
(release only follows it), else the step's timeout code (UNCONFIRMED_ERROR_BY_STEP =
vectors workerExec.timeoutErrorByStep without release; a commit's outcome is unknown, so
``workspace_busy``; for class assessment UNCONFIRMED_ERROR_BY_STEP_ASSESSMENT = vectors
workerExec.assessment.timeoutErrorByStep, where that commit is ``workspace_failed``); the slot
stays busy until the reaper confirms (backoff up to REAP_RETRY_MAX_SECONDS).

The host workspace lock (lead acceptance needed: §13 says "commit under the host's workspace
lock"). Commit runs inside the runner's single job slot (``busy``), held from admission until
cleanup is confirmed: no other repo-open prepare or commit can interleave, so the budget prepare
measured still holds at commit. No other host path takes this slot. Every other host path that
touches /workspace (the control-plane stop and fence, the idle stop, the reverse-move export)
stops the desktop first, which ends every in-desktop exec, so a stop that begins after commit's
check KILLS commit instead of waiting for it. Those paths are not changed here (lane rule: no
other agent op changes). The kernel's commit of a new folder is one rename(2), and the next open
is idempotent (``existing``, or a re-clone after the step-0 sweep); an ``existing`` commit killed
mid-way can leave partial credential keys in .git/config until the next open repairs them, as on
Cloudflare. The residual is a retry, never a half-placed folder. Class assessment (contract 1.0.3)
is NOT idempotent: a re-open after its folder is in place answers ``folder_conflict``. Its kernel
reads head and clean before the rename, so every kernel ``workspace_busy`` comes before it; a
commit killed at its timeout (or left unconfirmed) may have renamed, and answers
``workspace_failed`` (vectors workerExec.assessment).

Host §8.1 (never exec into a desktop that is not running). Before EVERY exec, with nothing in
between but the cgroup lookup, the host check (Flight.guard) answers a cgroup root or one of:
  * STOPPED (positively stopped, replaced or committed to stopping): a stop request; a stopping /
    shutdown-pending / export-quiesce marker; the fence file; a pending export (or an
    export.pending failure); the guard stamp gone (it goes at shutdown) or naming another
    generation or epoch (the epoch fence); runc reporting no container, a status other than
    running, or an init pid other than the one pinned at job start (a restarted desktop is a new
    container whose /run is empty);
  * HELD: a desktop restart requested or running while runc still reports the pinned desktop
    running;
  * UNSURE: runc state failed or timed out, the guard stamp could not be read as a stamp, or the
    desktop's cgroup could not be found.
Nothing is executed on any of them. Answers: STOPPED is ``runtime_not_running`` and release is
skipped (nothing in /run survives; staging on EBS is swept later). HELD is
``runtime_not_running`` (§8.1) except at the re-check after prepare, where it is
``workspace_busy`` and release still goes through its own check (vectors
workerExec.postPrepareRecheck; an AWS restart replaces the container, so that check normally
skips it). UNSURE is ``workspace_busy`` everywhere (host only: the host could not tell, so the
caller retries; a refresh keeps refreshing instead of going quiet), and release still goes
through its own check. At step 3 a stamp that is not this epoch's is ``workspace_not_ready``.
A check that refused release also skips the fallback. Unlike Cloudflare,
``.ezil-staging/<uuid>`` is on the EBS volume and survives a stop: the next prepare's step-0
sweep removes it (kernel LEFTOVER_MIN_AGE_MS); the host never deletes inside the
tenant-controlled tree from the host side.

The export case. The guarantee that nothing runs during a reverse-move export is the
EXPORT_QUIESCE marker, which agent._export_stop_desktop sets BEFORE it stops the desktop.
export.pending answers False for an unreadable export record (export.py swallows Refused), so it
only adds the resumed-capture case; any other failure of export.pending also blocks (tested).
Treating an unreadable export record as blocking is a lead decision (it would block repo-open
for that host's life).

Threat model (reviewed for 7b936ae0..4afb9533 against contract 1.0.2; the reviewer's model)
------------------------------------------------------------------------------------------
An AWS pool host serves exactly ONE computer epoch and is then retired, and runs one desktop
container. Inert until A2r is mounted and the Phase-A refusal is removed: only the Worker holds
the gw1 key.
Protected: the per-epoch control channel (stop, fence, presence, idle-stop and billing); host
processes, PIDs, memory and file descriptors; other computers and epochs; the grant outside its
own repository and computer (I1, I4); the data volume (I5: repo-open never starts or replaces a
desktop).
Trust boundaries:
  * Worker -> edge: gw1 HMAC over METHOD|path, bound to computerId, generation and leaseEpoch,
    fresh within -120 s/+5 s; the start body's sha256 is in the signed path; status names a
    256-bit jobId.
  * Edge -> agent: a root-only 0600 unix socket; messages HMAC'd with the control key, carrying
    epoch, ts and a strictly increasing persisted seq.
  * Agent -> desktop: argv-only ``runc exec --cgroup <sub>`` as container uid 0. The desktop
    spec has NO user namespace (desktop.py namespaces: pid, ipc, uts, mount, cgroup, network), so
    container uid 0 is host uid 0, confined by the desktop's capability set (desktop.CAPS, 13
    at this base), noNewPrivileges, seccomp, AppArmor and a read-only cgroupfs.
  * Grant lifetime: on the host only in edge and agent memory and an unlinked 0600 tmpfs file
    used as runc stdin; in the guest /run/ezil/git/incoming/<uuid>.json -> grants/<h>__<n>.json
    (0600, <= 15 min), removed by release when there is no folder.
Attackers:
  1. A malicious repository acts only inside the kernel's git (hooks /dev/null, no submodules,
     protocol allow-list, tar-byte budget). The host never reads /workspace. A branch or path
     shaped like a grant only DoSes that repository, through the sanitizer, as on Cloudflare.
  2. A compromised guest (uid 0; can replace node, sh, cat, git) can read its own grant (§7,
     accepted) and make its own job fail or be slow. It cannot block the agent: stdin is a
     regular file, stdout is bounded at STDOUT_MAX, stderr is discarded, one absolute deadline.
     Orphans die by cgroup.kill on a sub-cgroup it cannot leave (read-only cgroupfs, no
     CAP_SYS_ADMIN). Answers are re-validated field by field; any grant-shaped output is
     ``workspace_failed``.
     RESIDUAL, named: ``runc exec`` into a hostile container with no user namespace is the
     classic breakout surface (a runc exec-time escape would be full host compromise: control
     channel and billing). The exposure already exists (terminal_work.probe and pool.py exec
     into the desktop); repo-open adds about 6 setup execs, 2-3 kernel execs, release and the
     fallback, each after a runc state, per open. Mitigations: the runc argv overrides nothing
     in the container's process spec (tested), the AMI checks below, and the epoch-scoped host.
  3. A replayed or forged edge request: forging needs the epoch control key; a replay inside the
     gw1 window hits the single-use jobId, persisted in tmpfs for USED_ID_TTL (> 125 s) across
     agent restarts and failing closed when unreadable; a body swap fails the digest before
     parsing; status reveals nothing secret. A host reboot clears the tmpfs ids, but a replay
     then re-runs an identical idempotent job (informational).
  4. A stale epoch after stop or restart: the host check above runs before every exec; a
     replaced desktop (fresh /run) never receives a later exec.
Out of scope: a user slowing or failing their OWN repo-open (busy / failed answers); content the
user's own kernel replacement prints, beyond the sanitizer.
Mechanisms:
  * No interpolation: every exec is an argv list; request data and the grant travel only on
    stdin as a host-private regular file (a process that never reads stdin cannot block the
    agent); the constant shell programs receive uuid4-generated paths and constants as
    positional parameters. The grant is never in argv, env, a log line, a reply, or a file on
    the host other than that unlinked temporary file on tmpfs.
  * Bounds: stdout streamed under STDOUT_MAX, stderr discarded, one absolute deadline (timing
    chain above), relay body <= RELAY_MAX_BYTES (edge), at most JOBS_MAX results kept JOB_TTL,
    host memory only.
  * Process lifetime: each exec runs in its own fresh sub-cgroup of the desktop's cgroup
    (``runc exec --cgroup ezil-repo-open-<tag>-<id>``); afterwards, normal exit included, the
    launcher is killed and reaped first, then ``cgroup.kill``, ``populated 0``, rmdir (repeated
    if repopulated). No PID inside the container is ever signalled. An unconfirmed launcher exit
    or drain keeps the slot busy until the reaper confirms it. Without a cgroup v2 container
    directory with ``cgroup.kill`` nothing runs.
  * Output: the LAST stdout line of a kernel exec is reduced to exactly the §8 answer; any
    captured output that contains the grant or matches GRANT_SHAPE (``egg_`` + 64 hex) fails the
    job with ``workspace_failed`` (a repository may legitimately be named ``egg_x``, so the bare
    prefix is not a credential). Raw output never leaves the host; the Worker re-validates.

To verify on the AMI before rollout (carried over from cbe83f6a §4.1, plus repo-open items)
------------------------------------------------------------------------------------------
  * the pinned runc build (ami/build-host-ami.sh) carries the current upstream exec-time
    security fixes: check it against the runc security advisories AT ROLLOUT TIME;
  * a process started by ``runc exec`` (as this module starts it) runs under the desktop's
    seccomp filter (/proc/<pid>/status Seccomp: 2), its AppArmor profile (/proc/<pid>/attr/
    current), its capability set (CapEff/CapBnd equal to the desktop's) and NoNewPrivs: 1;
  * ``runc exec --cgroup`` with the systemd driver for the desktop's cgroupsPath, on the pinned
    runc;
  * containment of forked and reparented processes; read-only cgroupfs inside the container;
    drains across desktop restarts;
  * ``node`` resolves under runc exec's environment (the image Env PATH) in the promoted desktop
    lower; measured locally: /usr/local/bin/node v22.22.3, git 2.34.1 in
    ezil-os-desktop:staging-lower34ac-106 (git >= 2.28 for init -b; the codec's --sparse needs
    2.35, contract §19). Adding that check to validate-lowers.py belongs to the AMI owner;
  * /run stays exec in the desktop spec (no noexec; tested here), or the helper wrapper fails;
  * the AMI copies lib/ including lib/ezil_host/repo_open_assets/*.mjs (build-host-ami.sh copies
    lib with ``cp -a``), and the copies' sha256 equal REPO_OPEN_ASSETS;
  * egress from the desktop to git-preview.ezil.work; ``?folder=`` survives /preview-bootstrap
    into code-server (E-AWS, contract §20).

Recorded deviations from the Cloudflare path (lead rulings where marked)
------------------------------------------------------------------------
  * Shorter git budget (lead): the kernel bounds git by deadlineMs - PREPARE_RESERVE -
    CLEANUP_MARGIN (kernel). The host writes deadlineMs = admission + HOST_DEADLINE (85 s), so
    git gets about admission + 60 s minus pre-clear and setup, against Worker receipt + 80 s on
    Cloudflare. A repository whose full-history fetch needs 60-80 s opens on Cloudflare but
    answers ``workspace_busy`` here, and each wake-loop retry clones again from scratch until
    the 180 s cap. HOST_DEADLINE is pinned by WORKER_DEADLINE minus grace, poll and slack, so a
    larger budget needs a contract change (for example a longer AWS Worker deadline inside the
    OS's 120 s fetch).
  * One serial worker per host, so a refresh while an open runs answers ``workspace_busy``
    (Cloudflare lets a refresh of another repository proceed).
  * Same-request joining is replaced by single-use job ids.
  * No hydrate marker (AWS /workspace is the EBS volume: the guard stamp is the readiness proof).
  * UNSURE host checks answer ``workspace_busy`` (no Cloudflare equivalent: containerIsRunning
    is synchronous there).
  * An exec whose cleanup is unconfirmed answers as above (computed answer, else the step's
    timeout code) and keeps the slot until reaped.
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
# Request class -> the one git host it may name (contract 1.0.3; vectors constants
# REPO_OPEN_CLASS_GIT_HOSTS = the kernel's CLASS_GIT_HOSTS). A relay without `class` is personal.
REPO_OPEN_CLASS_GIT_HOSTS = {"personal": "git-preview.ezil.work", "assessment": "git-qa.ezil.work"}
REPO_OPEN_CLASS_DEFAULT = "personal"
REPO_OPEN_GIT_HOSTS = (REPO_OPEN_CLASS_GIT_HOSTS[REPO_OPEN_CLASS_DEFAULT],)   # vectors workerRequest.gitHostAllowList
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
KILL_WAIT_S = 5.0                  # seconds to reap the killed launcher before it is left to the reaper
CLEANUP_MIN_S = 0.05               # the least a capped kill-wait or drain is given
PROBE_MAX_S = 10.0                 # runc state bound, further capped by the time left (probe_timeout)
PROBE_MIN_S = 0.1
REAP_RETRY_SECONDS = 5.0           # first wait between reaps of an unconfirmed cleanup; doubles up to the max
REAP_RETRY_MAX_SECONDS = 30.0
# runDir markers under which no desktop runs (= agent.DESKTOP_DOWN_MARKERS; tested)
DOWN_MARKERS = (desktop.STOPPING, "shutdown-pending", desktop.EXPORT_QUIESCE)
MESSAGE_KEYS = frozenset({"op", "leaseEpoch", "ts", "seq", "mac", "request"})
STATUS_MESSAGE_KEYS = frozenset({"op", "leaseEpoch", "ts", "seq", "mac", "jobId"})

# The kernel and helper, sha256-pinned (byte-equal to worker/src/repo-open-assets; tested).
ASSET_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "repo_open_assets")
REPO_OPEN_ASSETS = {
    "ezil-repo-open.mjs": "31c178cdeee7bdd2061b024c8662be43b94758951de7ad954e0a55209ba4cc40",
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
HEAD_RE = re.compile(r"\A[0-9a-f]{40}\Z")
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
ASSESSMENT_OPEN_STATES = ("cloned", "initialized_empty")      # vectors kernel.assessment.states
ASSESSMENT_OPEN_KEYS = OPEN_KEYS + ("head", "clean")           # vectors kernel.assessment.resultOpenKeys
START_REFUSALS = frozenset({"workspace_busy", "job_replayed", "repo_open_invalid", "workspace_failed"})
STATUS_REFUSALS = frozenset({"job_unknown", "repo_open_invalid"})
BODY_KEYS = ("v", "op", "repositoryId", "handle", "name", "gitHost", "defaultBranch", "path", "grant")
GRANT_KEYS = ("username", "token", "expiresAt", "scope")
RELAY_KEYS = frozenset(("jobId",) + BODY_KEYS)
OPTIONAL_BODY_KEYS = ("class",)                                # vectors workerRequest.optionalKeys
CLASSED_RELAY_KEYS = RELAY_KEYS | frozenset(OPTIONAL_BODY_KEYS)


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


def relay_class(raw):
    """The relay's request class (contract 1.0.3): its `class` when present (a string in the
    table), else the default; None when `class` is present but not a known class."""
    if "class" not in raw:
        return REPO_OPEN_CLASS_DEFAULT
    cls = raw["class"]
    return cls if isinstance(cls, str) and cls in REPO_OPEN_CLASS_GIT_HOSTS else None


def parse_relay(raw, now_ms):
    """The Worker's relay -> (jobId, §8 body). ValueError on anything outside the contract;
    never echoes a value. Same rules as worker/src/repo-open.ts parseRepoOpenBody, stricter
    only where Python and JSON differ (v must be the integer 1). gitHost must be the relay
    class's host (REPO_OPEN_CLASS_GIT_HOSTS); `class` stays in the body only when it was sent."""
    if (not isinstance(raw, dict) or set(raw) not in (RELAY_KEYS, CLASSED_RELAY_KEYS)
            or not valid_job_id(raw.get("jobId"))):
        raise ValueError("repo_open_invalid")
    cls = relay_class(raw)
    if cls is None:
        raise ValueError("repo_open_invalid")
    b, g = raw, raw.get("grant")
    if not _exact(g, GRANT_KEYS):
        raise ValueError("repo_open_invalid")
    expires = iso_ms(g.get("expiresAt"))
    path = b.get("path")
    ok = (type(b.get("v")) is int and b["v"] == 1 and b.get("op") in ("open", "refresh")
          and _str(b.get("repositoryId")) and bool(UUID_RE.match(b["repositoryId"]))
          and _str(b.get("handle")) and bool(HANDLE_RE.match(b["handle"])) and valid_name(b.get("name"))
          and b.get("gitHost") == REPO_OPEN_CLASS_GIT_HOSTS[cls] and valid_branch(b.get("defaultBranch"))
          and (path is None or (b["op"] == "open" and _str(path) and path_problem(path) is None))
          and g.get("username") == "ezil" and _str(g.get("token")) and bool(GRANT_RE.match(g["token"]))
          and g.get("scope") in ("write", "read")
          and expires is not None and now_ms < expires <= now_ms + WORKER_ACCEPT_EXPIRY_MAX_MS)
    if not ok:
        raise ValueError("repo_open_invalid")
    body = {k: b[k] for k in BODY_KEYS if k != "grant"}
    body["grant"] = {k: g[k] for k in GRANT_KEYS}
    if "class" in raw:
        body["class"] = cls
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


def open_answer(value, folder, cls=REPO_OPEN_CLASS_DEFAULT):
    """A kernel commit result for op open, validated as strictly as the OS validates the
    Worker's 200 (vectors errorTable.workerResponses.okRule). Class assessment (contract 1.0.3,
    okAssessmentRule): exactly ASSESSMENT_OPEN_KEYS, never `existing`, head None or 40 lowercase
    hex, clean a bool, and head None exactly when empty and when the state is initialized_empty."""
    if value is None:
        return refusal("workspace_failed")
    if value.get("ok") is False:
        return kernel_refusal(value)
    assessment = cls == "assessment"
    keys = ASSESSMENT_OPEN_KEYS if assessment else OPEN_KEYS
    if not _exact(value, keys):
        return refusal("workspace_failed")
    if assessment:
        head = value["head"]
        if (value["state"] not in ASSESSMENT_OPEN_STATES or not (head is None or (_str(head) and HEAD_RE.match(head)))
                or not isinstance(value["clean"], bool) or value["empty"] is not (head is None)
                or (value["state"] == "initialized_empty") is not (head is None)):
            return refusal("workspace_failed")
    of = value.get("openFolder")
    if (value["ok"] is not True or value["state"] not in OPEN_STATES
            or value["folder"] != folder or not _str(of) or not (of == folder or of.startswith(folder + "/"))
            or len(of.encode("utf-8", "surrogatepass")) > 4096 or CONTROL_CHAR_RE.search(of)
            or not isinstance(value["pathNotFound"], bool) or not isinstance(value["empty"], bool)
            or not valid_branch(value["branch"])):
        return refusal("workspace_failed")
    return {"status": 200, "body": {k: value[k] for k in keys}}


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
                      clock=time.monotonic, cleanup_by=None):
    """`runc exec` of `argv` (a list; never a shell string with data) in the desktop, in a fresh
    sub-cgroup of `cgroup_root` (the container's cgroup, from the caller's host check). Stdin is
    `data` as a host-private unlinked regular file in runDir; stderr is discarded; stdout is
    streamed under `limit` until the ABSOLUTE monotonic `deadline`. Afterwards, normal exit
    included, the launcher is killed and reaped first (KILL_WAIT_S), then the sub-cgroup is
    drained (DRAIN_CAP); with `cleanup_by` (absolute monotonic) both are cut to the time left
    before it, so the whole call ends by max(deadline, cleanup_by) plus scheduling.
    The runc argv carries no flag that overrides the container's process spec (user, caps,
    noNewPrivileges, AppArmor, env, cwd, tty): the exec'd process runs under the desktop's own
    seccomp, AppArmor, capability set and noNewPrivileges (tested; verified on the AMI).
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
        def room(cap):
            return cap if cleanup_by is None else min(cap, max(CLEANUP_MIN_S, cleanup_by - clock()))
        try:
            if proc is not None:
                proc.kill()
                try:
                    proc.wait(timeout=room(KILL_WAIT_S))
                except subprocess.TimeoutExpired:
                    launcher_stuck = True
                finally:
                    proc.stdout.close()
        finally:
            try:
                _drain_cgroup(path, cap=room(DRAIN_CAP))
            except CleanupPending:
                # Never lose a stuck launcher behind a drain failure: both must be confirmed.
                raise CleanupPending(proc if launcher_stuck else None) from None
    if launcher_stuck:
        raise CleanupPending(proc)
    if overrun:
        raise ExecLimit(timed_out, bytes(out[:limit]))
    return rc, bytes(out)


def probe_timeout(deadline, now):
    """The runc state bound for a check made at `now` for something that must end by `deadline`."""
    return min(PROBE_MAX_S, max(PROBE_MIN_S, deadline - now))


def reap_cgroups(cfg, timeout=PROBE_MAX_S):
    """Remove empty job cgroups and cgroup.kill populated ones (left by an unconfirmed cleanup
    or an earlier agent process). Returns how many remain (0 = clear). Discovery reports 0 only
    when the container is positively absent; any uncertainty counts as 1 remaining."""
    try:
        _, pid = desktop_probe(cfg, timeout)
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
# What the host check (Flight.guard) answers instead of a cgroup root. None of them execs.
STOPPED = ("stopped",)   # positively stopped, replaced or committed to stopping: no exec, no release
HELD = ("held",)         # a desktop restart is requested or running while the pinned desktop still runs
UNSURE = ("unsure",)     # the host could not tell (runc state failed or timed out, unreadable stamp)
GUARD_KEYS = ("generation", "leaseEpoch")
# A job whose exec cleanup is unconfirmed before its answer exists answers like a timeout of that
# step (vectors workerExec.timeoutErrorByStep, release excepted: its answer always exists).
UNCONFIRMED_ERROR_BY_STEP = {"setup": "workspace_failed", "prepare": "workspace_busy", "commit": "workspace_busy",
                             "refresh": "workspace_failed"}
# Class assessment (contract 1.0.3, vectors workerExec.assessment.timeoutErrorByStep): a commit
# that may have renamed is terminal, because an assessment re-open would answer folder_conflict.
UNCONFIRMED_ERROR_BY_STEP_ASSESSMENT = {**UNCONFIRMED_ERROR_BY_STEP, "commit": "workspace_failed"}


def timeout_codes(body):
    """The step -> timeout/unconfirmed code map for the relay body's class."""
    return UNCONFIRMED_ERROR_BY_STEP_ASSESSMENT if body.get("class") == "assessment" else UNCONFIRMED_ERROR_BY_STEP


def refused(res):
    """True when the host check refused the exec (nothing ran)."""
    return res is STOPPED or res is HELD or res is UNSURE


class Runner:
    """Admission, status and the one job thread. The control path (start/status) only touches
    host memory and one small tmpfs file under a tiny lock; every exec runs in the job thread.
    Nothing runs at agent start: leftovers of an earlier agent process are reaped by the first
    job's pre-clear, before its first exec (Phase B stays inert until a signed start arrives)."""

    def __init__(self, agent):
        self.agent, self.cfg, self.lease = agent, agent.cfg, agent.lease
        self.clock = agent.clock
        self.mono, self.sleep = time.monotonic, time.sleep
        self.lock = threading.Lock()
        self.jobs = {}                 # jobId -> {"state", "result", "at"}; host memory only
        self.busy = False              # the one job slot: held from admission until cleanup is confirmed
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
            admitted = (self.mono(), now)
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
        """Reap until no job cgroup and no stuck launcher remain (True), or `deadline` (False).
        Without a deadline (a job's unconfirmed cleanup) it keeps trying, waiting
        REAP_RETRY_SECONDS between rounds and doubling up to REAP_RETRY_MAX_SECONDS."""
        wait = REAP_RETRY_SECONDS
        while True:
            self.stuck = [p for p in self.stuck if p.poll() is None]
            timeout = PROBE_MAX_S if deadline is None else probe_timeout(deadline, self.mono())
            if not self.stuck and reap_cgroups(self.cfg, timeout) == 0:
                return True
            if deadline is not None:
                if self.mono() >= deadline:
                    return False
                self.sleep(0.2)
            else:
                self.sleep(wait)
                wait = min(wait * 2, REAP_RETRY_MAX_SECONDS)

    def _job(self, job_id, body, admitted):
        result = refusal("workspace_failed")
        outcome = "workspace_failed"
        pending = False
        try:
            mono, wall = admitted
            deadline = mono + HOST_DEADLINE_MS / 1000
            if not self._clear(min(deadline, self.mono() + PRECLEAR_CAP_S)):
                # Job cgroups left by an earlier job or agent process are not confirmed gone:
                # nothing runs beside them, and the slot stays busy until they are (retryable).
                pending = True
                result = refusal("workspace_busy")
            else:
                flight = Flight(self, body, job_id[:16], deadline, int(wall * 1000) + HOST_DEADLINE_MS)
                result = flight.run()
                if flight.cleanup is not None:
                    pending = True
                    if flight.cleanup.args and isinstance(flight.cleanup.args[0], subprocess.Popen):
                        self.stuck.append(flight.cleanup.args[0])
            outcome = "ok" if result["status"] == 200 else result["body"]["error"]
        except Exception:   # noqa: BLE001 — never let a job thread die silently
            pass
        finally:
            # Publish the terminal state FIRST; logging can never block it.
            with self.lock:
                self.jobs[job_id] = {"state": "done", "result": result, "at": self.clock()}
            self._log(f"repo_open op={body.get('op')} outcome={outcome}" + (" cleanup=pending" if pending else ""))
            if pending:
                self._clear()          # the slot is released only once cleanup is confirmed
            with self.lock:
                self.busy = False

    # ---------------------------------------------------------------- host checks
    def down(self):
        """The desktop is stopping, stopped or held down: a stop request, a stopping /
        shutdown-pending / export-quiesce marker, the tunnel fence, or a pending export.
        The export guarantee is the EXPORT_QUIESCE marker, which agent._export_stop_desktop sets
        BEFORE it stops the desktop: export.pending answers False for an unreadable export
        record (export.py swallows Refused), so it only adds the resumed-capture case. Any other
        failure of export.pending also counts as down."""
        if self.agent.stop_request is not None:
            return True
        if any(os.path.lexists(os.path.join(self.cfg.runDir, m)) for m in DOWN_MARKERS):
            return True
        if os.path.lexists(tunnel.fence_path(self.cfg)):
            return True
        try:
            return bool(export.pending(self.cfg))
        except Exception:   # noqa: BLE001 — an export state that cannot be read as usual blocks
            return True

    def transition(self):
        """A desktop restart is requested or running (it replaces the container and its /run)."""
        a = self.agent
        return bool(a.restart_request or a.restart_in_progress)

    def epoch(self):
        """The epoch fence: True when the guard passed THIS lease (generation and epoch) this
        boot, so the data volume bound at /workspace is this computer's. STOPPED when the stamp
        is gone (it goes at shutdown) or names another generation or epoch; UNSURE when it
        cannot be read as a stamp."""
        path = os.path.join(self.cfg.runDir, "guard-ok")
        try:
            dfd = os.open(self.cfg.runDir, DIR_FLAGS)
            try:
                raw = read_regular_at(dfd, "guard-ok", limit=65536)
            finally:
                os.close(dfd)
            if raw is None:
                return UNSURE if os.path.lexists(path) else STOPPED
            stamp = strict_json(raw.decode())
        except (OSError, ValueError, UnicodeDecodeError):
            return UNSURE
        if not isinstance(stamp, dict) or any(type(stamp.get(k)) is not int for k in GUARD_KEYS):
            return UNSURE
        return True if all(stamp[k] == self.lease.get(k) for k in GUARD_KEYS) else STOPPED

    def probe(self, timeout=PROBE_MAX_S):
        """(status, init pid); STOPPED when runc positively reports no desktop; UNSURE otherwise."""
        try:
            return desktop_probe(self.cfg, timeout)
        except ContainerAbsent:
            return STOPPED
        except (OSError, ValueError, subprocess.SubprocessError):
            return UNSURE


class Flight:
    """One job: §8 steps 3-11 on the host. Answers {status, body}; raises CleanupPending."""

    def __init__(self, runner, body, tag, deadline, deadline_ms):
        self.r, self.cfg, self.b, self.tag = runner, runner.cfg, body, tag
        self.deadline, self.deadline_ms = deadline, deadline_ms
        self.uuid = str(uuid.uuid4())
        self.pid = None
        self.outputs = []
        self.answer = None             # the job's answer once computed (before release)
        self.step = "check"            # the step running, for an unconfirmed cleanup's answer
        self.cleanup = None            # the CleanupPending that ended the flight, if any
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
            **({"class": b["class"]} if "class" in b else {}),   # contract 1.0.3: only when the relay sent it
        }, separators=(",", ":")).encode()

    def grant_file(self):
        """§9.3 grant file content: written as the incoming file, moved into place by the kernel."""
        b, g = self.b, self.b["grant"]
        return json.dumps({"v": 1, "protocol": "https", "host": b["gitHost"], "path": f"{b['handle']}/{b['name']}.git",
                           "username": g["username"], "password": g["token"], "expiresAt": g["expiresAt"],
                           "scope": g["scope"]}, separators=(",", ":")).encode()

    # ------------------------------------------------------------- host §8.1
    def guard(self, deadline):
        """The cgroup root to exec in, or STOPPED / HELD / UNSURE (nothing may run; see the
        module docstring). The probe is bounded by the time left before `deadline`. Positive
        evidence wins: the down and epoch checks and the probe come first; the cheap flags are
        read again after the probe, right before the caller's exec."""
        r = self.r
        if r.down():
            return STOPPED
        epoch = r.epoch()
        if epoch is not True:
            return epoch
        probe = r.probe(probe_timeout(deadline, r.mono()))
        if probe is STOPPED or probe is UNSURE:
            return probe
        if probe != ("running", self.pid):
            return STOPPED                           # stopped, paused, or a replaced desktop (new init)
        if r.down():
            return STOPPED
        if r.transition():
            return HELD
        try:
            return cgroup_root_of(self.pid)
        except OSError:
            return UNSURE

    def exec_(self, argv, deadline, data=None, cleanup_by=None):
        """("done", rc, stdout) | STOPPED | HELD | UNSURE | ("error", timed_out). The host check
        runs first. The exec's own cleanup ends by `cleanup_by` (default: the job deadline)."""
        if deadline - self.r.mono() <= 0:
            return ("error", True)
        root = self.guard(deadline)
        if refused(root):
            return root
        try:
            rc, out = bounded_runc_exec(self.cfg, argv, deadline, data, tag=self.tag, cgroup_root=root,
                                        cleanup_by=self.deadline if cleanup_by is None else cleanup_by)
        except ExecLimit as e:
            self.outputs.append(e.output)
            return ("error", e.timed_out)
        except (OSError, ValueError):
            return ("error", False)
        self.outputs.append(out)
        return ("done", rc, out)

    def write(self, path, data, deadline, cleanup_by=None):
        return self.exec_(["/bin/sh", "-c", WRITE_PROGRAM, "sh", path], deadline, data, cleanup_by)

    def kernel(self, phase, deadline, cleanup_by=None):
        return self.exec_(["node", KERNEL_PATH, phase, self.request_path], deadline, cleanup_by=cleanup_by)

    @staticmethod
    def ok(res):
        return res[0] == "done" and res[1] == 0

    @staticmethod
    def failure(res, timeout_code, held_code="runtime_not_running"):
        """What a failed op (not a kernel answer) means; None for a completed exec. A refused
        check: STOPPED is runtime_not_running; HELD is runtime_not_running (§8.1) except after
        prepare (workspace_busy, vectors workerExec.postPrepareRecheck.transition); UNSURE is
        workspace_busy (host only: the host could not tell, so the caller retries)."""
        if res is STOPPED:
            return refusal("runtime_not_running")
        if res is HELD:
            return refusal(held_code)
        if res is UNSURE:
            return refusal("workspace_busy")
        if res[0] == "error":
            return refusal(timeout_code if res[1] else "workspace_failed")
        return None

    # ------------------------------------------------------------- the steps
    def run(self):
        """The job's answer. An exec whose cleanup is unconfirmed (CleanupPending) ends the
        flight: the answer already computed is published (release only follows it), else the
        step's timeout code; the caller keeps the slot until the reaper confirms. The sanitizer
        applies on every path."""
        try:
            answer = self._steps()
        except CleanupPending as e:
            self.cleanup = e
            answer = self.answer or refusal(timeout_codes(self.b).get(self.step, "workspace_failed"))
        return refusal("workspace_failed") if leaked(self.outputs, self.b["grant"]["token"]) else answer

    def _steps(self):
        b, r = self.b, self.r
        now = r.mono
        # Step 3 (host): nothing pending, this epoch's volume, the desktop running; pin its init.
        if r.down() or r.transition():
            return refusal("runtime_not_running")
        if r.epoch() is not True:
            return refusal("workspace_not_ready")
        probe = r.probe(probe_timeout(self.deadline, now()))
        if probe is UNSURE:
            return refusal("workspace_busy")
        if probe is STOPPED or probe[0] != "running":
            return refusal("runtime_not_running")
        self.pid = probe[1]
        try:
            assets = load_assets()
        except AssetError:
            return refusal("workspace_failed")      # nothing ran: a tampered or missing asset
        stopped = False
        dispatched_write = False

        # Steps 6-7: one SHORT_EXEC_MS budget for all of setup.
        self.step = "setup"
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
            self.step = "prepare"
            timeout = min(PREPARE_WINDOW_MS / 1000, self.deadline - PREPARE_RESERVE_MS / 1000 - now())
            if timeout <= 0:
                answer = refusal("workspace_busy")
            else:
                prepared = self.kernel("prepare", now() + timeout)
                # The re-check after prepare (vectors workerExec.postPrepareRecheck): stopped or
                # replaced -> runtime_not_running and no further exec; a restart requested or
                # running in the still-running desktop, or a check the host could not complete
                # -> workspace_busy, and release still goes through its own check.
                check = prepared if refused(prepared) else self.guard(self.deadline)
                if check is STOPPED:
                    stopped = True
                    answer = refusal("runtime_not_running")
                elif refused(prepared):
                    answer = self.failure(prepared, "workspace_busy")      # refused before prepare ran
                elif refused(check):
                    answer = refusal("workspace_busy")
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
                        self.step = "commit"
                        commit_deadline = min(self.deadline, now() + COMMIT_EXEC_MAX_MS / 1000)
                        res = self.write(self.request_path, self.request("commit"), commit_deadline)
                        if self.ok(res):
                            res = self.kernel("commit", commit_deadline)
                        stopped = res is STOPPED
                        # A commit timeout may follow the rename. Personal: workspace_busy, because the
                        # next open is idempotent (vectors workerExec.timeoutErrorByStep). Assessment:
                        # workspace_failed, because a re-open would answer folder_conflict
                        # (workerExec.assessment).
                        answer = self.failure(res, timeout_codes(b)["commit"]) or open_answer(
                            last_json_line(res[2]), self.folder, b.get("class", REPO_OPEN_CLASS_DEFAULT))
        else:
            # Step 10.
            self.step = "refresh"
            res = self.kernel("refresh", min(self.deadline, now() + SHORT_EXEC_MS / 1000))
            stopped = res is STOPPED
            answer = self.failure(res, "workspace_failed") or refresh_answer(last_json_line(res[2]))
        self.answer = answer

        # Step 11: release on every outcome, unless the desktop stopped (no exec then). Release and
        # its fallback, cleanup included, end by the job deadline plus RELEASE_GRACE.
        self.step = "release"
        if not stopped and dispatched_write:
            cap = self.deadline + RELEASE_GRACE_MS / 1000
            released = False
            res = None
            if setup_ok:
                rel_deadline = min(cap, now() + SHORT_EXEC_MS / 1000)
                res = self.write(self.request_path, self.request("release"), rel_deadline, cleanup_by=cap)
                if self.ok(res):
                    res = self.kernel("release", rel_deadline, cleanup_by=cap)
                    value = last_json_line(res[2]) if res[0] == "done" else None
                    released = res[0] == "done" and value == {"ok": True}
            # A check that refused release would refuse the fallback too: nothing more runs then.
            if not released and not refused(res):
                self.exec_(["/bin/sh", "-c", FALLBACK_PROGRAM, "sh", self.staging, self.request_path, self.incoming,
                            self.kernel_tmp, self.helper_tmp], min(cap, now() + SHORT_EXEC_MS / 1000), cleanup_by=cap)
        return answer

__all__ = ["Runner", "parse_relay", "decode_relay", "valid_job_id", "load_assets", "bounded_runc_exec",
           "reap_cgroups", "REPO_OPEN_STATUS", "RELAY_MAX_BYTES"]
