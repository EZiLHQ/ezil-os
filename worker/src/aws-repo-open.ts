/**
 * Phase B: POST /sandbox/:name/repo-open for an AWS computer (contract universe-repo-open-v1 §13,
 * LANES A2r; carried from cf27920b, contract 1.0.3). INERT: nothing imports this module. The lead's
 * activation commit (after the A2h security review, the AMI promotion and the canary E2E) mounts it;
 * this lane does not. Its protocol symbols come from ./repo-open-u2 (the u2 module's, 2ca90211):
 * in this tree ./repo-open is open-project's live module.
 *
 * The calling route (u2's `handleRepoOpenRoute` at 2ca90211, or an assessment route) has already
 * verified its signature (own path, 5-minute skew) and the strict §8 body FOR ITS CLASS before
 * `awsControlTarget` names an AWS tunnel; it passes that class as `routeClass` (personal unless
 * said). This module then relays the same request to that computer's host edge and polls the job:
 *
 *   1. Start: `POST /__ezil/control/repo-open/<sha256hex(relay bytes)>`. The gw1 control signature
 *      covers method and path only, so the digest of the exact body bytes is IN the signed path
 *      (like `ice` and `export`); the host compares it with the bytes it read before parsing.
 *   2. Status: `POST /__ezil/control/repo-open-status/<jobId>`, no body, every AWS_RELAY_POLL_MS,
 *      until the job is done or the Worker deadline (receivedAt + WORKER_DEADLINE_MS) passes.
 *
 * The host agent (A2h, infra/host-agent op `repo_open`) writes the sha-pinned kernel and helper, the
 * request and the grant into the desktop's /run/ezil, runs prepare outside and commit inside its
 * one job slot, never execs into a desktop that is not running, and sanitizes the output. This side
 * never trusts that: it re-validates the answer as strictly as the OS app does (worker-client.ts
 * `validateWorkerOk`, including its no-`.`/`..`-segment rule for openFolder), and any edge reply that
 * carries the grant or anything grant-shaped fails the request: the raw bytes are scanned, and so is
 * the decoded JSON value, because JSON.parse decodes \u escapes: the grant with any character written
 * as a JSON \u escape passes a raw scan and decodes to the grant itself.
 *
 * ── Wire protocol with the host edge ────────────────────────────────────────────────────────
 * Pinned by A2h in infra/host-agent/lib/ezil_host/repo_open.py ("Wire interface") and matched here
 * and in aws-repo-open.test.ts. The vectors pin only AWS_RELAY_POLL_MS.
 *
 *  Relay body (built once from validated fields, no whitespace, at most AWS_REPO_OPEN_RELAY_MAX_BYTES
 *  = the host's RELAY_MAX_BYTES): the §8 body plus `jobId`, nothing else:
 *    {"jobId":<64 hex>,"v":1,"op","repositoryId","handle","name","gitHost","defaultBranch","path",
 *     "grant":{"username","token","expiresAt","scope"}}
 *  then (contract 1.0.3) "class" last, only when the route's body carried it; the host re-checks it
 *  against the same closed class → git-host table and forwards it to the kernel only when present.
 *  `jobId` is 32 random bytes, hex, chosen here. Single use: exactly one start is ever sent with it
 *  (the host refuses a replay with `job_replayed`), and it names the job in every status read.
 *  The host runs the job under its own absolute deadline (HOST_DEADLINE_MS from admission, release
 *  grace and slack included, ≤ WORKER_DEADLINE_MS), so its result is published before this side
 *  stops polling.
 *
 *  Start replies:  200 {"ok":true,"state":"running"}
 *                  409 {"ok":false,"error":"workspace_busy"}   the host's one job slot is taken
 *                  409 job_replayed | repo_open_invalid | workspace_failed; 400 body or digest;
 *                  401 gw1; 503 agent_unavailable
 *                  404 an edge without the route (an AMI before the Phase-B rollout)
 *  Status replies: 200 {"ok":true,"state":"running"} | 200 {"ok":true,"state":"done","result":R}
 *                  409 {"ok":false,"error":"job_unknown"}; 503 agent_unavailable
 *  R = the §8 answer itself, {"status","body"}: {200, okOpen | okOpenAssessment (class assessment,
 *      1.0.3: + head, clean) | okRefresh} or
 *      {REPO_OPEN_STATUS[code], {"ok":false,"error":code}}, code ∈ AWS_RESULT_ERROR_CODES (the host's
 *      runtime_not_running, workspace_not_ready, workspace_busy, workspace_failed, plus the kernel's).
 *
 * ── Mapping (to the §8 Worker answers, so the OS maps them through errorTable.upstream) ────────
 *  - start 404 → 409 workspace_unsupported (cbe83f6a aws-workspace.ts mapped it to failed;
 *    changed by §13). A 404 on a status read after the job was acknowledged → workspace_failed.
 *  - start 409 workspace_busy → workspace_busy. R's refusal codes keep their names, and R's status
 *    must equal the §8 table (the answer is rebuilt here from the code, never copied).
 *  - the deadline passes while the job may still run → 409 workspace_busy (retryable for class
 *    personal, like a §8 prepare or commit timeout: the next open is idempotent and answers
 *    `existing`; NOT for class assessment, see "Start and poll" below).
 *  - a status read that throws or answers 5xx is transient: the read is repeated within the deadline.
 *    A start that throws or answers 5xx is an unknown outcome, not a refusal: its reply may be lost
 *    after the host admitted the job (A2h's edge answers 503 agent_unavailable when the agent's reply
 *    fails after delivery; a tunnel 52x says nothing either). It is followed by status reads of the
 *    same jobId, never a second start; `job_unknown` then means it never arrived (workspace_failed),
 *    and a host that never answers ends at the deadline as workspace_busy.
 *  - every other reply (401, 3xx, 400, other 409s, job_unknown, malformed or oversized JSON, an
 *    unexpected envelope) → 500 workspace_failed.
 *  - an awsControlTarget `Response` (503 aws_origin_starting and the like) at the start →
 *    workspace_unsupported with its body never read (vectors errorTable.workerResponses.awsControlTarget);
 *    at a poll of an already started job it is "could not tell" (running), its body never read either.
 *  The host serializes jobs, so a second open, or a refresh, while one runs is `workspace_busy` (the
 *  Cloudflare path's in-flight join is a Durable Object map; this relay holds no state).
 *
 * ── Start and poll (E1-5) ────────────────────────────────────────────────────────────────────
 *  `handleAwsRepoOpen` (start, then poll until done or the 105 s Worker deadline) cannot fit in one
 *  call of the OS app's assessment client (30 s per op, 16f9c25b app/src/server/assessment/
 *  worker-client.ts) inside a 40 s sweep (orchestrator.ts sweepBudgetMs). So it is the composition of
 *  two calls, each ONE edge call bounded by AWS_EDGE_CALL_MAX_MS (10 s):
 *    awsRepoOpenStart(input, name, target, deps, routeClass) → running + job | done + answer
 *    awsRepoOpenPoll(job, target, deps[, until])               → running + job | done + answer
 *  `job` (AwsRepoOpenJob) carries no grant: a caller persists it between sweeps and passes it back.
 *  Assessment callers (class assessment, 1.0.3): once the host has admitted the job, poll the SAME
 *  job until done (results stay readable JOB_TTL = 600 s) and never re-start it. An assessment folder
 *  must be fresh, so after any admitted attempt (including a result `workspace_busy`, which may follow
 *  a commit whose rename happened) a re-open answers `folder_conflict`: treat it as terminal. Only a
 *  start refused before anything ran (`workspace_busy` from the start itself) is safe to retry.
 *
 * ── Activation (lead edit in worker/src/index.ts, sketched here; not made by this lane) ────────
 *    personal (u2's route): open: async (name, input) => {
 *      const aws = await awsControlTarget(env, request, name, 'repo_open');
 *      return aws === null ? (openSandbox(env, name) as unknown as RepoOpenRpc).repoOpen(input)
 *        : handleAwsRepoOpen(input, name, aws, { fetch: (u, i) => fetch(u, i), now: () => Date.now() });
 *    },
 *    assessment: awsRepoOpenStart(input, name, aws, deps, 'assessment'), then one
 *      awsRepoOpenPoll(job, aws, deps) per sweep.
 */
import { readLimited, sha256HexBytes } from './ai-proxy';
import {
  AWS_GATEWAY_HEADER, awsOriginHostname, decodeControlKey, isComputerId, signGatewayHeader, type AwsTunnelRecord, type FetchLike,
} from './aws-origin';
import {
  ASSESSMENT_OPEN_RESULT_KEYS, ASSESSMENT_OPEN_RESULT_STATES, HANDLE_RE, HEAD_RE, OPEN_RESULT_KEYS, OPEN_RESULT_STATES,
  REPO_OPEN_CLASS_DEFAULT, REPO_OPEN_STATUS, WORKER_DEADLINE_MS, isRepoOpenClass, parseRepoOpenBody, refusal, validBranch,
  validName,
  type RepoOpenAnswer, type RepoOpenAssessmentOpenResult, type RepoOpenBody, type RepoOpenClass, type RepoOpenErrorCode,
  type RepoOpenInput, type RepoOpenOpenResult,
} from './repo-open-u2';

// ── protocol constants (AWS_RELAY_POLL_MS is compared with the vectors by the test) ──────────

export const AWS_REPO_OPEN_PATH = '/__ezil/control/repo-open/';
export const AWS_REPO_OPEN_STATUS_PATH = '/__ezil/control/repo-open-status/';
/** vectors timeouts.AWS_RELAY_POLL_MS. */
export const AWS_RELAY_POLL_MS = 1_500;
/** The desktop's workspace root on AWS (desktop.py binds /workspace; never /workspaces). */
export const AWS_REPO_OPEN_ROOT = '/workspace';
/** The host edge's RELAY_MAX_BYTES: the Worker's 4 KiB §8 body plus jobId. */
export const AWS_REPO_OPEN_RELAY_MAX_BYTES = 4_608;
/** Edge replies are read up to this many bytes; a longer one fails the request. */
export const AWS_EDGE_REPLY_MAX_BYTES = 8_192;
/** The longest single edge call; each call is also bounded by the time left before the deadline. */
export const AWS_EDGE_CALL_MAX_MS = 10_000;
export const AWS_JOB_ID_RE = /^[0-9a-f]{64}$/;
/** Codes a job result may carry: the host's own, then the kernel's (vectors kernel.errorCodes). */
export const AWS_HOST_ERROR_CODES: readonly RepoOpenErrorCode[] = ['runtime_not_running', 'workspace_not_ready', 'workspace_busy', 'workspace_failed'];
export const AWS_KERNEL_ERROR_CODES: readonly RepoOpenErrorCode[] = ['folder_conflict', 'repository_too_large', 'git_auth_rejected',
  'repository_unavailable', 'network_unavailable', 'workspace_busy', 'workspace_failed'];
export const AWS_RESULT_ERROR_CODES: readonly RepoOpenErrorCode[] = [...new Set([...AWS_HOST_ERROR_CODES, ...AWS_KERNEL_ERROR_CODES])];

/** Anything grant-shaped in an edge reply. */
const GRANT_SHAPE = /egg_[0-9a-f]{64}/;
const CONTROL_CHAR = /[\u0000-\u001f\u007f]/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/**
 * The §8 fields only, in the vectors' key order (re-validated before anything is relayed), then
 * (1.0.3) `class` only when the input carried it (vectors workerRequest.classRule: the host forwards
 * it to the kernel only when relayed), so a personal body without class relays byte-identically.
 */
function requestBody(input: RepoOpenBody): RepoOpenBody {
  return {
    v: 1, op: input.op, repositoryId: input.repositoryId, handle: input.handle, name: input.name, gitHost: input.gitHost,
    defaultBranch: input.defaultBranch, path: input.path,
    grant: { username: input.grant.username, token: input.grant.token, expiresAt: input.grant.expiresAt, scope: input.grant.scope },
    ...(input.class !== undefined ? { class: input.class } : {}),
  };
}

/** The relay body's exact bytes: the validated §8 body plus the job id. Never the raw input. */
export function awsRepoOpenRelayBody(input: RepoOpenBody, jobId: string): string {
  return JSON.stringify({ jobId, ...requestBody(input) });
}

/**
 * A finished job's result R = {status, body} for the op and class that were sent, validated as
 * strictly as the OS validates the Worker's 200; the answer is rebuilt from validated fields and the
 * §8 table. Class assessment (1.0.3, vectors okOpenAssessment / okAssessmentRule): exactly the 9
 * keys, never `existing`, head null or 40 lowercase hex, clean a boolean, empty === (head === null),
 * and state initialized_empty exactly when head is null. Each class's shape is invalid for the other.
 */
export function awsJobAnswer(result: unknown, op: 'open' | 'refresh', folder: string,
  cls: RepoOpenClass = REPO_OPEN_CLASS_DEFAULT): RepoOpenAnswer {
  if (!isRepoOpenClass(cls) || !exactKeys(result, ['status', 'body'])) return refusal('workspace_failed');
  const { status, body } = result;
  if (isObject(body) && body.ok === false) {
    const code = body.error as RepoOpenErrorCode;
    return exactKeys(body, ['ok', 'error']) && AWS_RESULT_ERROR_CODES.includes(code) && status === REPO_OPEN_STATUS[code]
      ? refusal(code) : refusal('workspace_failed');
  }
  if (status !== 200 || !isObject(body) || body.ok !== true) return refusal('workspace_failed');
  if (op === 'refresh') {
    return exactKeys(body, ['ok', 'state']) && body.state === 'refreshed'
      ? { status: 200, body: { ok: true, state: 'refreshed' } } : refusal('workspace_failed');
  }
  const assessment = cls === 'assessment';
  const keys: readonly string[] = assessment ? ASSESSMENT_OPEN_RESULT_KEYS : OPEN_RESULT_KEYS;
  const states: readonly string[] = assessment ? ASSESSMENT_OPEN_RESULT_STATES : OPEN_RESULT_STATES;
  if (!exactKeys(body, keys) || !states.includes(body.state as string)
    || body.folder !== folder || typeof body.openFolder !== 'string'
    || !(body.openFolder === folder || body.openFolder.startsWith(`${folder}/`))
    // The OS app's `absolute` rule (worker-client.ts validateWorkerOk): no '.' or '..' segment.
    || body.openFolder.split('/').some((segment) => segment === '.' || segment === '..')
    || byteLength(body.openFolder) > 4096 || CONTROL_CHAR.test(body.openFolder)
    || typeof body.pathNotFound !== 'boolean' || typeof body.empty !== 'boolean'
    || typeof body.branch !== 'string' || !validBranch(body.branch)
    // Never answer anything grant-shaped, whoever decoded the result.
    || GRANT_SHAPE.test(body.openFolder) || GRANT_SHAPE.test(body.branch)) {
    return refusal('workspace_failed');
  }
  if (!assessment) {
    const { state, openFolder, pathNotFound, branch, empty } = body as unknown as RepoOpenOpenResult;
    return { status: 200, body: { ok: true, state, folder, openFolder, pathNotFound, branch, empty } };
  }
  const head: unknown = body.head;
  const unborn = head === null;
  if (!(unborn || (typeof head === 'string' && HEAD_RE.test(head))) || typeof body.clean !== 'boolean'
    || body.empty !== unborn || (body.state === 'initialized_empty') !== unborn) {
    return refusal('workspace_failed');
  }
  const { state, openFolder, pathNotFound, branch, empty, clean } = body as unknown as RepoOpenAssessmentOpenResult;
  return { status: 200, body: { ok: true, state, folder, openFolder, pathNotFound, branch, empty, head: head as string | null, clean } };
}

/** A job envelope: exactly {ok:true, state:'running'} or {ok:true, state:'done', result}. */
function envelope(data: Record<string, unknown> | null): data is Record<string, unknown> {
  if (!data || data.ok !== true) return false;
  return data.state === 'running' ? exactKeys(data, ['ok', 'state'])
    : data.state === 'done' && exactKeys(data, ['ok', 'state', 'result']);
}

export type AwsRepoOpenTarget = { record: AwsTunnelRecord; zone: string };

export interface AwsRepoOpenDeps {
  fetch: FetchLike;
  now(): number;
  sleep?(ms: number): Promise<void>;
  randomBytes?(n: number): Uint8Array;
  /** The abort signal for one edge call (default `AbortSignal.timeout`). */
  timeout?(ms: number): AbortSignal;
}

type EdgeReply =
  | { kind: 'reply'; status: number; data: Record<string, unknown> | null }
  | { kind: 'transport' }
  | { kind: 'leak' }
  | { kind: 'deadline' };

/**
 * What a status read needs to know about the job it reads. Token-free by construction (the grant never
 * enters it), so a caller may persist it between sweeps; awsRepoOpenPoll treats it as untrusted and
 * re-validates every field. `acknowledged`: the host has named this job (a start or status reply said
 * running), which decides what a later edge 404 means (workspace_failed, not workspace_unsupported).
 */
export interface AwsRepoOpenJob {
  jobId: string;
  sandboxName: string;
  op: 'open' | 'refresh';
  /** The route class the job was started for (1.0.3); its result is validated against that shape. */
  class: RepoOpenClass;
  handle: string;
  name: string;
  acknowledged: boolean;
}
const JOB_KEYS = ['jobId', 'sandboxName', 'op', 'class', 'handle', 'name', 'acknowledged'];
const validJob = (job: unknown): job is AwsRepoOpenJob =>
  exactKeys(job, JOB_KEYS) && typeof job.jobId === 'string' && AWS_JOB_ID_RE.test(job.jobId)
  && typeof job.sandboxName === 'string' && (job.op === 'open' || job.op === 'refresh') && isRepoOpenClass(job.class)
  && typeof job.handle === 'string' && HANDLE_RE.test(job.handle) && typeof job.name === 'string' && validName(job.name)
  && typeof job.acknowledged === 'boolean';

/** One start or poll: the job is still running (as far as that call can tell), or its final §8 answer. */
export type AwsRepoOpenStep =
  | { state: 'running'; job: AwsRepoOpenJob }
  | { state: 'done'; answer: RepoOpenAnswer };
const finished = (answer: RepoOpenAnswer): AwsRepoOpenStep => ({ state: 'done', answer });
const repoFolder = (handle: string, name: string) => `${AWS_REPO_OPEN_ROOT}/repos/${handle}/${name}`;

type EdgeCall = (path: string, until: number, payload?: string, token?: string) => Promise<EdgeReply>;

/** The gw1-signed edge of `target`, bound to `sandboxName`; null when that binding cannot be signed. */
function edgeOf(target: AwsRepoOpenTarget, sandboxName: string, deps: AwsRepoOpenDeps): EdgeCall | null {
  const { record, zone } = target;
  const key = decodeControlKey(record.controlKey);
  // The gw1 binding must be signable before anything is sent (awsOriginHostname checks the rest).
  if (!key || record.sandboxId !== sandboxName || !record.originVerified || !isComputerId(record.computerId)) return null;
  let host: string;
  try {
    host = awsOriginHostname(record.sandboxId, record.generation, record.leaseEpoch, zone);
  } catch {
    return null;
  }
  const now = () => deps.now();
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));
  /**
   * One edge call, cut by its own abort signal at min(AWS_EDGE_CALL_MAX_MS, until - now). `token` is
   * the grant when the caller holds it (a start). A status read does not: GRANT_RE (the parser's)
   * makes every grant match GRANT_SHAPE, so the shape scan alone already refuses it.
   */
  return async (path, until, payload, token) => {
    const carriesGrant = (text: string) => (token !== undefined && text.includes(token)) || GRANT_SHAPE.test(text);
    const remaining = until - now();
    if (remaining <= 0) return { kind: 'deadline' };
    let text: string;
    let status: number;
    try {
      const header = await signGatewayHeader(key, record, 'POST', path, Math.floor(now() / 1000));
      const res = await deps.fetch(`https://${host}${path}`, {
        method: 'POST', redirect: 'manual', signal: timeout(Math.min(AWS_EDGE_CALL_MAX_MS, remaining)),
        headers: { [AWS_GATEWAY_HEADER]: header, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(payload !== undefined ? { body: payload } : {}),
      });
      status = res.status;
      const bytes = await readLimited(res.body, AWS_EDGE_REPLY_MAX_BYTES);
      if (bytes === null) return { kind: 'reply', status, data: null };
      text = new TextDecoder().decode(bytes);
    } catch {
      // A transport failure or timeout: never echo the cause.
      return { kind: 'transport' };
    }
    // The sanitizer: nothing grant-shaped may come back from the computer, in any reply. First the raw
    // bytes (JSON or not), then the decoded value, whatever its type: JSON.parse decodes \u escapes,
    // so a grant with its '_' (or any character) escaped passes a raw scan; JSON.stringify writes
    // `egg_` and hex digits back literally, so the second scan sees the grant.
    if (carriesGrant(text)) return { kind: 'leak' };
    let data: unknown = null;
    try { data = JSON.parse(text); } catch { data = null; }
    if (data !== null && carriesGrant(JSON.stringify(data))) return { kind: 'leak' };
    return { kind: 'reply', status, data: isObject(data) ? data : null };
  };
}

/**
 * Start (E1-5): steps 2-7 of §8 for an AWS computer. Re-validates the route's verified `input`
 * against `routeClass` (never read from the body), then sends the start exactly once, with a fresh
 * jobId: ONE edge call, bounded by AWS_EDGE_CALL_MAX_MS and by input.receivedAt + WORKER_DEADLINE_MS.
 *  - running + job: the host admitted the job (job.acknowledged), or the start's outcome is unknown
 *    (a transport failure or a 5xx: the host may have admitted it before the reply was lost). Status
 *    reads of the same jobId settle which; a second start is never sent for it.
 *  - done + answer: a refusal (invalid_request; workspace_unsupported for an awsControlTarget Response
 *    or an edge without the route; workspace_busy when the host's one slot is taken or the deadline
 *    passed, both before anything ran; workspace_failed otherwise), or a start already answered done,
 *    validated like a status result.
 */
export async function awsRepoOpenStart(
  input: RepoOpenInput,
  sandboxName: string,
  target: AwsRepoOpenTarget | Response,
  deps: AwsRepoOpenDeps,
  routeClass: RepoOpenClass = REPO_OPEN_CLASS_DEFAULT,
): Promise<AwsRepoOpenStep> {
  // A refusal from awsControlTarget (claims mismatch, origin unavailable or starting): its body is
  // never read or forwarded.
  if (target instanceof Response) return finished(refusal('workspace_unsupported'));
  try {
    // Never relay a field the Worker would refuse, whoever the caller is.
    const body = requestBody(input);
    if (!parseRepoOpenBody(new TextEncoder().encode(JSON.stringify(body)), deps.now(), routeClass)) return finished(refusal('invalid_request'));
    const call = edgeOf(target, sandboxName, deps);
    if (!call) return finished(refusal('workspace_failed'));
    const random = deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
    const jobId = hex(random(32));
    if (!AWS_JOB_ID_RE.test(jobId)) return finished(refusal('workspace_failed'));
    const relay = awsRepoOpenRelayBody(body, jobId);
    if (byteLength(relay) > AWS_REPO_OPEN_RELAY_MAX_BYTES) return finished(refusal('workspace_failed'));
    const digest = await sha256HexBytes(new TextEncoder().encode(relay));
    const job: AwsRepoOpenJob = { jobId, sandboxName, op: body.op, class: routeClass, handle: body.handle, name: body.name, acknowledged: false };

    const started = await call(`${AWS_REPO_OPEN_PATH}${digest}`, input.receivedAt + WORKER_DEADLINE_MS, relay, body.grant.token);
    if (started.kind === 'leak') return finished(refusal('workspace_failed'));
    if (started.kind === 'deadline') return finished(refusal('workspace_busy'));
    // A start that throws ('transport') or answers 5xx has an unknown outcome: the host may have
    // admitted the job before the reply was lost (A2h's edge answers 503 agent_unavailable when the
    // agent's reply fails after delivery). The job's status says which; a second start is never sent.
    if (started.kind === 'transport' || started.status >= 500) return { state: 'running', job };
    if (started.status === 404) return finished(refusal('workspace_unsupported'));
    if (started.status === 409 && exactKeys(started.data, ['ok', 'error']) && started.data.ok === false
      && started.data.error === 'workspace_busy') {
      return finished(refusal('workspace_busy'));
    }
    if (started.status !== 200 || !envelope(started.data)) return finished(refusal('workspace_failed'));
    if (started.data.state === 'running') return { state: 'running', job: { ...job, acknowledged: true } };
    return finished(awsJobAnswer(started.data.result, job.op, repoFolder(job.handle, job.name), job.class));
  } catch {
    return finished(refusal('workspace_failed'));
  }
}

/**
 * Poll (E1-5): ONE status read of `job`, no sleep: one edge call bounded by AWS_EDGE_CALL_MAX_MS and,
 * when the caller has a deadline, by `until` (the composition passes receivedAt + WORKER_DEADLINE_MS;
 * a caller polling across sweeps passes none and keeps its own). `job` is untrusted (it may have been
 * persisted between sweeps): every field is re-validated and the folder is rebuilt from it here.
 *  - running + job: the host says running (job.acknowledged becomes true), or this read could not
 *    tell: a transport failure, a 5xx, or an awsControlTarget Response (its body never read). Poll
 *    again; the host keeps a finished job's result readable for JOB_TTL (600 s, repo_open.py).
 *  - done + answer: the job's result R re-validated for the job's op and class (awsJobAnswer), or a
 *    refusal: invalid_request (a malformed job or `until`); workspace_failed (a target that cannot be
 *    signed or is bound to another sandbox, job_unknown, any other reply, anything grant-shaped);
 *    workspace_unsupported (an edge 404 before the host ever named the job: an AMI without the route);
 *    workspace_busy (`until` passed: nothing was sent).
 */
export async function awsRepoOpenPoll(
  job: AwsRepoOpenJob,
  target: AwsRepoOpenTarget | Response,
  deps: AwsRepoOpenDeps,
  until: number = Infinity,
): Promise<AwsRepoOpenStep> {
  if (!validJob(job) || typeof until !== 'number' || Number.isNaN(until)) return finished(refusal('invalid_request'));
  const current: AwsRepoOpenJob = { ...job };
  if (target instanceof Response) return { state: 'running', job: current };
  try {
    const call = edgeOf(target, current.sandboxName, deps);
    if (!call) return finished(refusal('workspace_failed'));
    const read = await call(`${AWS_REPO_OPEN_STATUS_PATH}${current.jobId}`, until);
    if (read.kind === 'leak') return finished(refusal('workspace_failed'));
    if (read.kind === 'deadline') return finished(refusal('workspace_busy'));
    if (read.kind === 'transport' || read.status >= 500) return { state: 'running', job: current };
    if (read.status === 404) return finished(refusal(current.acknowledged ? 'workspace_failed' : 'workspace_unsupported'));
    if (read.status !== 200 || !envelope(read.data)) return finished(refusal('workspace_failed'));
    if (read.data.state === 'running') return { state: 'running', job: { ...current, acknowledged: true } };
    return finished(awsJobAnswer(read.data.result, current.op, repoFolder(current.handle, current.name), current.class));
  } catch {
    return finished(refusal('workspace_failed'));
  }
}

/**
 * Steps 2-11 of §8 for an AWS computer in one call: awsRepoOpenStart, then awsRepoOpenPoll every
 * AWS_RELAY_POLL_MS until the job is done or receivedAt + WORKER_DEADLINE_MS passes (workspace_busy).
 * The same behaviour as cf27920b's single relay for the personal class. `routeClass` is the class the
 * CALLING route serves (1.0.3), never read from the body.
 */
export async function handleAwsRepoOpen(
  input: RepoOpenInput,
  sandboxName: string,
  target: AwsRepoOpenTarget | Response,
  deps: AwsRepoOpenDeps,
  routeClass: RepoOpenClass = REPO_OPEN_CLASS_DEFAULT,
): Promise<RepoOpenAnswer> {
  try {
    const started = await awsRepoOpenStart(input, sandboxName, target, deps, routeClass);
    if (started.state === 'done') return started.answer;
    const deadline = input.receivedAt + WORKER_DEADLINE_MS;
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    let job = started.job;
    for (;;) {
      const wait = Math.min(AWS_RELAY_POLL_MS, deadline - deps.now());
      if (wait <= 0) return refusal('workspace_busy');
      await sleep(wait);
      const polled = await awsRepoOpenPoll(job, target, deps, deadline);
      if (polled.state === 'done') return polled.answer;
      job = polled.job;
    }
  } catch {
    return refusal('workspace_failed');
  }
}
