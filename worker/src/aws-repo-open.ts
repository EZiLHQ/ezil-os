/**
 * Phase B: POST /sandbox/:name/repo-open for an AWS computer (contract universe-repo-open-v1 §13,
 * LANES A2r). INERT: nothing imports this module. The lead's activation commit (after the A2h
 * security review, the AMI promotion and the canary E2E) swaps the route's Phase-A AWS refusal
 * for this relay; this lane does not mount it.
 *
 * The route (`handleRepoOpenRoute`, repo-open.ts) has already verified the repo-open signature
 * (own path, 5-minute skew) and the strict §8 body before `awsControlTarget` names an AWS tunnel.
 * This module then relays the same request to that computer's host edge and polls the job:
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
 *  R = the §8 answer itself, {"status","body"}: {200, okOpen | okRefresh} or
 *      {REPO_OPEN_STATUS[code], {"ok":false,"error":code}}, code ∈ AWS_RESULT_ERROR_CODES (the host's
 *      runtime_not_running, workspace_not_ready, workspace_busy, workspace_failed, plus the kernel's).
 *
 * ── Mapping (to the §8 Worker answers, so the OS maps them through errorTable.upstream) ────────
 *  - start 404 → 409 workspace_unsupported (cbe83f6a aws-workspace.ts mapped it to failed;
 *    changed by §13). A 404 on a status read after the job was acknowledged → workspace_failed.
 *  - start 409 workspace_busy → workspace_busy. R's refusal codes keep their names, and R's status
 *    must equal the §8 table (the answer is rebuilt here from the code, never copied).
 *  - the deadline passes while the job may still run → 409 workspace_busy (retryable, like a §8
 *    prepare or commit timeout: the next open is idempotent and answers `existing`).
 *  - a status read that throws or answers 5xx is transient: the read is repeated within the deadline.
 *    A start that throws or answers 5xx is an unknown outcome, not a refusal: its reply may be lost
 *    after the host admitted the job (A2h's edge answers 503 agent_unavailable when the agent's reply
 *    fails after delivery; a tunnel 52x says nothing either). It is followed by status reads of the
 *    same jobId, never a second start; `job_unknown` then means it never arrived (workspace_failed),
 *    and a host that never answers ends at the deadline as workspace_busy.
 *  - every other reply (401, 3xx, 400, other 409s, job_unknown, malformed or oversized JSON, an
 *    unexpected envelope) → 500 workspace_failed.
 *  - an awsControlTarget `Response` (503 aws_origin_starting and the like) → workspace_unsupported
 *    with its body never read (vectors errorTable.workerResponses.awsControlTarget).
 *  The host serializes jobs, so a second open, or a refresh, while one runs is `workspace_busy` (the
 *  Cloudflare path's in-flight join is a Durable Object map; this relay holds no state).
 *
 * ── Activation (lead edit in worker/src/index.ts, sketched here; not made by this lane) ────────
 *    awsTarget: async () => null,        // the route's Phase-A refusal no longer applies
 *    open: async (name, input) => {
 *      const aws = await awsControlTarget(env, request, name, 'repo_open');
 *      return aws === null ? (openSandbox(env, name) as unknown as RepoOpenRpc).repoOpen(input)
 *        : handleAwsRepoOpen(input, name, aws, { fetch: (u, i) => fetch(u, i), now: () => Date.now() });
 *    },
 */
import { readLimited, sha256HexBytes } from './ai-proxy';
import {
  AWS_GATEWAY_HEADER, awsOriginHostname, decodeControlKey, isComputerId, signGatewayHeader, type AwsTunnelRecord, type FetchLike,
} from './aws-origin';
import {
  BRANCH_RE, REPO_OPEN_STATUS, WORKER_DEADLINE_MS, parseRepoOpenBody, refusal,
  type RepoOpenAnswer, type RepoOpenBody, type RepoOpenErrorCode, type RepoOpenInput, type RepoOpenOpenResult,
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
const OPEN_KEYS = ['ok', 'state', 'folder', 'openFolder', 'pathNotFound', 'branch', 'empty'];
const OPEN_STATES = ['cloned', 'initialized_empty', 'existing'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  isObject(value) && Object.keys(value).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
const validBranch = (s: string) => BRANCH_RE.test(s) && !s.includes('..') && !s.includes('//') && !s.endsWith('/')
  && !s.endsWith('.lock') && !s.includes('/.') && !s.endsWith('.');
const hex = (bytes: Uint8Array) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

/** The §8 fields only, in the vectors' key order (re-validated before anything is relayed). */
function requestBody(input: RepoOpenBody): RepoOpenBody {
  return {
    v: 1, op: input.op, repositoryId: input.repositoryId, handle: input.handle, name: input.name, gitHost: input.gitHost,
    defaultBranch: input.defaultBranch, path: input.path,
    grant: { username: input.grant.username, token: input.grant.token, expiresAt: input.grant.expiresAt, scope: input.grant.scope },
  };
}

/** The relay body's exact bytes: the validated §8 body plus the job id. Never the raw input. */
export function awsRepoOpenRelayBody(input: RepoOpenBody, jobId: string): string {
  return JSON.stringify({ jobId, ...requestBody(input) });
}

/**
 * A finished job's result R = {status, body} for the op that was sent, validated as strictly as the
 * OS validates the Worker's 200; the answer is rebuilt from validated fields and the §8 table.
 */
export function awsJobAnswer(result: unknown, op: 'open' | 'refresh', folder: string): RepoOpenAnswer {
  if (!exactKeys(result, ['status', 'body'])) return refusal('workspace_failed');
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
  if (!exactKeys(body, OPEN_KEYS) || !OPEN_STATES.includes(body.state as string)
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
  const { state, openFolder, pathNotFound, branch, empty } = body as unknown as RepoOpenOpenResult;
  return { status: 200, body: { ok: true, state, folder, openFolder, pathNotFound, branch, empty } };
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
 * Steps 2-11 of §8 for an AWS computer: relay, poll, validate. `input` is the route's verified
 * request; `target` is what `awsControlTarget` returned for `sandboxName` (non-null).
 */
export async function handleAwsRepoOpen(
  input: RepoOpenInput,
  sandboxName: string,
  target: AwsRepoOpenTarget | Response,
  deps: AwsRepoOpenDeps,
): Promise<RepoOpenAnswer> {
  // A refusal from awsControlTarget (claims mismatch, origin unavailable or starting): its body is
  // never read or forwarded.
  if (target instanceof Response) return refusal('workspace_unsupported');
  const now = () => deps.now();
  const deadline = input.receivedAt + WORKER_DEADLINE_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = deps.randomBytes ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const timeout = deps.timeout ?? ((ms: number) => AbortSignal.timeout(ms));

  // Never relay a field the Worker would refuse, whoever the caller is.
  const body = requestBody(input);
  if (!parseRepoOpenBody(new TextEncoder().encode(JSON.stringify(body)), now())) return refusal('invalid_request');
  const { record, zone } = target;
  const key = decodeControlKey(record.controlKey);
  // The gw1 binding must be signable before anything is sent (awsOriginHostname checks the rest).
  if (!key || record.sandboxId !== sandboxName || !record.originVerified || !isComputerId(record.computerId)) return refusal('workspace_failed');
  let host: string;
  try {
    host = awsOriginHostname(record.sandboxId, record.generation, record.leaseEpoch, zone);
  } catch {
    return refusal('workspace_failed');
  }
  const folder = `${AWS_REPO_OPEN_ROOT}/repos/${body.handle}/${body.name}`;
  const token = body.grant.token;
  const carriesGrant = (text: string) => text.includes(token) || GRANT_SHAPE.test(text);

  const call = async (path: string, payload?: string): Promise<EdgeReply> => {
    const remaining = deadline - now();
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

  try {
    const jobId = hex(random(32));
    if (!AWS_JOB_ID_RE.test(jobId)) return refusal('workspace_failed');
    const relay = awsRepoOpenRelayBody(body, jobId);
    if (byteLength(relay) > AWS_REPO_OPEN_RELAY_MAX_BYTES) return refusal('workspace_failed');
    const digest = await sha256HexBytes(new TextEncoder().encode(relay));

    // 1. Start (sent exactly once with this jobId).
    let acknowledged = false;
    let state: unknown = 'running';
    let result: unknown;
    const started = await call(`${AWS_REPO_OPEN_PATH}${digest}`, relay);
    if (started.kind === 'leak') return refusal('workspace_failed');
    if (started.kind === 'deadline') return refusal('workspace_busy');
    // A start that throws ('transport') or answers 5xx has an unknown outcome: the host may have
    // admitted the job before the reply was lost (A2h's edge answers 503 agent_unavailable when the
    // agent's reply fails after delivery). The job's status says which; a second start is never sent.
    if (started.kind === 'reply' && started.status < 500) {
      if (started.status === 404) return refusal('workspace_unsupported');
      if (started.status === 409 && exactKeys(started.data, ['ok', 'error']) && started.data.ok === false
        && started.data.error === 'workspace_busy') {
        return refusal('workspace_busy');
      }
      if (started.status !== 200 || !envelope(started.data)) return refusal('workspace_failed');
      acknowledged = true;
      state = started.data.state;
      result = started.data.result;
    }

    // 2. Status reads until done or the deadline.
    while (state !== 'done') {
      const wait = Math.min(AWS_RELAY_POLL_MS, deadline - now());
      if (wait <= 0) return refusal('workspace_busy');
      await sleep(wait);
      const read = await call(`${AWS_REPO_OPEN_STATUS_PATH}${jobId}`);
      if (read.kind === 'leak') return refusal('workspace_failed');
      if (read.kind === 'deadline') return refusal('workspace_busy');
      if (read.kind === 'transport' || read.status >= 500) continue;
      if (read.status === 404) return refusal(acknowledged ? 'workspace_failed' : 'workspace_unsupported');
      if (read.status !== 200 || !envelope(read.data)) return refusal('workspace_failed');
      acknowledged = true;
      state = read.data.state;
      result = read.data.result;
    }
    return awsJobAnswer(result, body.op, folder);
  } catch {
    return refusal('workspace_failed');
  }
}
