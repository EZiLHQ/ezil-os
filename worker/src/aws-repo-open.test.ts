/**
 * Phase B AWS relay for POST /sandbox/:name/repo-open (contract universe-repo-open-v1 §13; LANES A2r).
 *
 *  - constants against the vectors and the contract text;
 *  - the start: body digest in the gw1-signed path, single-use 64-hex jobId, validated relay body
 *    in the wire shape A2h pins (infra/host-agent/lib/ezil_host/repo_open.py "Wire interface");
 *  - status reads every AWS_RELAY_POLL_MS within the Worker deadline, each edge call bounded by the
 *    abort signal deps.timeout() made for it;
 *  - the mapping: edge 404 → workspace_unsupported, start busy, a start that throws or answers 5xx →
 *    status reads of the same jobId (never a second start), job results R = {status, body}
 *    validated strictly (vectors errorTable.workerResponses.okCases and refusals, the OS app's
 *    openFolder segment rule), deadline → workspace_busy, everything else → workspace_failed;
 *  - the sanitizer: anything grant-shaped in any edge reply, raw or JSON-escaped → workspace_failed,
 *    nothing leaks.
 * A fake host edge records every call; a fake clock advances only through sleep and edge latency.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import gateway from './aws-gateway.vectors.json';
import { awsOriginHostname, decodeControlKey, verifyGatewayHeader, type AwsTunnelRecord, type FetchLike } from './aws-origin';
import {
  AWS_EDGE_CALL_MAX_MS, AWS_EDGE_REPLY_MAX_BYTES, AWS_HOST_ERROR_CODES, AWS_JOB_ID_RE, AWS_KERNEL_ERROR_CODES, AWS_RELAY_POLL_MS,
  AWS_REPO_OPEN_PATH, AWS_REPO_OPEN_RELAY_MAX_BYTES, AWS_REPO_OPEN_ROOT, AWS_REPO_OPEN_STATUS_PATH, AWS_RESULT_ERROR_CODES,
  awsJobAnswer, awsRepoOpenPoll, awsRepoOpenRelayBody, awsRepoOpenStart, handleAwsRepoOpen,
  type AwsRepoOpenDeps, type AwsRepoOpenJob, type AwsRepoOpenStep, type AwsRepoOpenTarget,
} from './aws-repo-open';
import {
  REPO_OPEN_STATUS, WORKER_DEADLINE_MS, WORKER_REQUEST_MAX_BYTES, refusal, repoOpenResponse,
  type RepoOpenAnswer, type RepoOpenClass, type RepoOpenErrorCode, type RepoOpenInput,
} from './repo-open-u2';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const VECTORS_BYTES = readFileSync(here('../../docs/contracts/universe-repo-open-v1.vectors.json'));
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const V: any = JSON.parse(VECTORS_BYTES.toString('utf8'));
const CONTRACT = readFileSync(here('../../docs/contracts/universe-repo-open-v1.md'), 'utf8');
const expand = (s: string) => String(s).replace(/\$\{repeat:(.):(\d+)\}/g, (_, c: string, n: string) => c.repeat(Number(n)));
const T = V.timeouts;
const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const NOW = V.fixtures.nowMs as number;
const SANDBOX = V.fixtures.sandboxName as string;
const FOLDER = `${AWS_REPO_OPEN_ROOT}/repos/${V.fixtures.handle}/${V.fixtures.name}`;
const record: AwsTunnelRecord = {
  computerId: V.fixtures.computerId, sandboxId: SANDBOX, generation: 3, leaseEpoch: 7,
  instanceId: 'i-0123456789abcdef0', region: 'ap-south-1', publicIp: '13.200.1.2', tunnelId: 't', dnsRecordId: 'd', hostname: '',
  controlKey: gateway.controlKeyBase64, createdAt: NOW, originVerified: true,
};
const ZONE = 'origin.example.net';
const target = { record, zone: ZONE };
const KEY = decodeControlKey(record.controlKey)!;
const HOST = awsOriginHostname(record.sandboxId, record.generation, record.leaseEpoch, ZONE);
const JOB = 'ab'.repeat(32);

/** vectors workerRequest.base with `relativeSeconds` made absolute against `now`, as the route hands it over. */
function materialise(value: unknown, now: number): unknown {
  if (Array.isArray(value)) return value.map((v) => materialise(v, now));
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    if ('relativeSeconds' in o) return new Date(now + Number(o.relativeSeconds) * 1000).toISOString();
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, materialise(v, now)]));
  }
  return typeof value === 'string' ? expand(value) : value;
}
const input = (patch: Record<string, unknown> = {}, receivedAt = NOW): RepoOpenInput =>
  ({ ...(materialise(V.workerRequest.base, NOW) as object), ...patch, receivedAt }) as RepoOpenInput;
const TOKEN = input().grant.token;
const okOpen = { ok: true, state: 'cloned', folder: FOLDER, openFolder: FOLDER, pathNotFound: false, branch: 'main', empty: false };

// ── fake host edge and clock ────────────────────────────────────────────────

interface Call { url: string; path: string; init: RequestInit; at: number; timeoutMs: number }
type Answer = Response | 'throw' | { latencyMs: number; reply: Response | 'throw' };
let clock = NOW;
/** Every abort signal deps.timeout() made, with its ms; each edge call must carry its own. */
let signals = new Map<AbortSignal, number>();
let sleeps: number[] = [];
/**
 * Harness faults (an edge call without the signal timeout() made for it, or one reused). Recorded,
 * not thrown: the relay would swallow a throw as a transport failure. Checked after every test.
 */
let faults: string[] = [];
afterEach(() => {
  const found = faults;
  faults = [];
  expect(found).toEqual([]);
});

/**
 * `respond(path, counts)`; every call is recorded with the abort timeout of the signal it carried.
 * A call's latency is bounded by THAT signal's timeout: past it the call aborts, as fetch does.
 */
function edge(respond: (path: string, n: { starts: number; reads: number }) => Answer) {
  const calls: Call[] = [];
  const n = { starts: 0, reads: 0 };
  const used = new Set<AbortSignal>();
  const fetch: FetchLike = async (url, init) => {
    const path = new URL(url).pathname;
    const signal = init.signal ?? undefined;
    const ms = signal ? signals.get(signal) : undefined;
    if (ms === undefined) faults.push(`${path}: no abort signal from deps.timeout()`);
    else if (used.has(signal!)) faults.push(`${path}: an abort signal reused`);
    if (signal) used.add(signal);
    calls.push({ url, path, init, at: clock, timeoutMs: ms ?? NaN });
    if (path.startsWith(AWS_REPO_OPEN_PATH)) n.starts += 1; else n.reads += 1;
    let answer = respond(path, n);
    if (typeof answer === 'object' && 'latencyMs' in answer) {
      // A slow edge: the call takes its latency unless its own signal aborts it first. With no
      // signal, a hung edge hangs the call (and the test times out), as fetch would.
      if (ms === undefined && answer.latencyMs === Infinity) return new Promise<Response>(() => {});
      if (answer.latencyMs >= (ms ?? Infinity)) {
        clock += ms!;
        throw new DOMException('The operation timed out.', 'TimeoutError');
      }
      clock += answer.latencyMs;
      answer = answer.reply;
    }
    if (answer === 'throw') throw new Error(`connection reset ${TOKEN}`);
    return answer;
  };
  return {
    calls, fetch,
    starts: () => calls.filter((c) => c.path.startsWith(AWS_REPO_OPEN_PATH)),
    reads: () => calls.filter((c) => c.path.startsWith(AWS_REPO_OPEN_STATUS_PATH)),
  };
}
function deps(fetch: FetchLike, extra: Partial<AwsRepoOpenDeps> = {}): AwsRepoOpenDeps {
  clock = NOW;
  signals = new Map();
  sleeps = [];
  return {
    fetch, now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    randomBytes: (n) => new Uint8Array(n).fill(0xab),
    timeout: (ms) => {
      const signal = new AbortController().signal;
      signals.set(signal, ms);
      return signal;
    },
    ...extra,
  };
}
const json = (body: unknown, status = 200) => Response.json(body, { status });
const running = () => json({ ok: true, state: 'running' });
/** A finished job whose result R is the §8 answer {status, body}. */
const done = (status: number, body: unknown) => json({ ok: true, state: 'done', result: { status, body } });
const ok = (body: unknown) => done(200, body);
const refused = (code: RepoOpenErrorCode) => done(REPO_OPEN_STATUS[code], { ok: false, error: code });
/** start → running, `reads - 1` running reads, then `last`. */
const job = (last: () => Answer, reads = 1) => edge((path, n) => (path.startsWith(AWS_REPO_OPEN_PATH) ? running() : n.reads < reads ? running() : last()));
const run = (e: ReturnType<typeof edge>, i: RepoOpenInput = input(), extra: Partial<AwsRepoOpenDeps> = {}) =>
  handleAwsRepoOpen(i, SANDBOX, target, deps(e.fetch, extra));

// ── constants ───────────────────────────────────────────────────────────────

describe('aws relay constants equal the vectors and the contract', () => {
  it('vectors are the pinned file', () => {
    expect(createHash('sha256').update(VECTORS_BYTES).digest('hex')).toBe('86fe643c377463367c1a480947d15421e19833e2bf9ccc72fad588ffbc6f4eb3');
  });
  it('the poll interval is the vectors AWS_RELAY_POLL_MS, inside the Worker deadline', () => {
    expect(AWS_RELAY_POLL_MS).toBe(T.AWS_RELAY_POLL_MS);
    expect(WORKER_DEADLINE_MS).toBe(T.WORKER_DEADLINE_MS);
    expect(T.strictChains).toContainEqual(['AWS_RELAY_POLL_MS', 'WORKER_DEADLINE_MS']);
    expect(AWS_EDGE_CALL_MAX_MS).toBeLessThan(WORKER_DEADLINE_MS);
    expect(WORKER_DEADLINE_MS).toBeLessThan(T.OS_TO_WORKER_FETCH_MS);
  });
  it('the edge paths are the ones §13 names', () => {
    expect(CONTRACT).toContain(`POST ${AWS_REPO_OPEN_PATH}<sha256hex(relay body)>`);
    expect(CONTRACT).toContain(`${AWS_REPO_OPEN_STATUS_PATH}<jobId 64-hex>`);
    expect(CONTRACT).toContain('Edge 404 (an AMI before the rollout) → `workspace_unsupported`');
  });
  it('kernel codes are the vectors kernel.errorCodes; every code this relay can answer is a §8 Worker refusal', () => {
    expect([...AWS_KERNEL_ERROR_CODES]).toEqual(V.kernel.errorCodes);
    expect(new Set(AWS_RESULT_ERROR_CODES)).toEqual(new Set([...AWS_HOST_ERROR_CODES, ...V.kernel.errorCodes]));
    const workerRefusals = new Map<string, number>();
    for (const r of V.errorTable.workerResponses.refusals) for (const e of r.error) workerRefusals.set(e, r.status);
    for (const code of [...AWS_RESULT_ERROR_CODES, 'workspace_unsupported', 'invalid_request'] as RepoOpenErrorCode[]) {
      expect(workerRefusals.get(code)).toBe(REPO_OPEN_STATUS[code]);
    }
    // A job result never claims a code only the route or this relay may answer.
    for (const code of ['workspace_unsupported', 'invalid_request', 'invalid_signature']) {
      expect(AWS_RESULT_ERROR_CODES).not.toContain(code as RepoOpenErrorCode);
    }
  });
  it('the AWS workspace root is /workspace, the root of the vectors okCases folders', () => {
    expect(AWS_REPO_OPEN_ROOT).toBe('/workspace');
    for (const c of V.errorTable.workerResponses.okCases) if (c.body.folder) expect(c.body.folder.startsWith(`${AWS_REPO_OPEN_ROOT}/repos/`)).toBe(true);
  });
});

// ── start and status ────────────────────────────────────────────────────────

describe('start: the body hash is bound into the gw1-signed path', () => {
  it('relays the validated body to the digest path, polls the job by jobId every 1.5 s, and answers the job result', async () => {
    const e = job(() => ok(okOpen), 3);
    const answer = await run(e);
    expect(answer).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    const [start, ...reads] = e.calls;
    const sent = start!.init.body as string;
    // The path digest is the sha256 of the EXACT bytes sent, and gw1 covers that path.
    expect(start!.url).toBe(`https://${HOST}${AWS_REPO_OPEN_PATH}${sha256(sent)}`);
    const header = new Headers(start!.init.headers).get('x-ezil-gw');
    expect(await verifyGatewayHeader(header, KEY, record, 'POST', start!.path, Math.floor(NOW / 1000))).toEqual({ ok: true });
    expect(await verifyGatewayHeader(header, KEY, record, 'POST', `${AWS_REPO_OPEN_PATH}${sha256(`${sent} `)}`, Math.floor(NOW / 1000)))
      .toEqual({ ok: false, error: 'gw_bad_mac' });
    expect(start!.init.method).toBe('POST');
    expect(start!.init.redirect).toBe('manual');
    expect(new Headers(start!.init.headers).get('content-type')).toBe('application/json');
    // The relay body (A2h RELAY_KEYS): jobId plus the §8 fields, nothing else.
    const relayed = JSON.parse(sent);
    expect(Object.keys(relayed)).toEqual(['jobId', ...V.workerRequest.keys]);
    expect(Object.keys(relayed.grant)).toEqual(V.workerRequest.grantKeys);
    const { receivedAt: _r, ...wire } = input();
    expect(relayed).toEqual({ ...wire, jobId: JOB });
    expect(sent).toBe(JSON.stringify(relayed));
    // Status reads: the jobId in the signed path, no body, one every AWS_RELAY_POLL_MS.
    expect(reads.map((c) => c.path)).toEqual(Array(3).fill(`${AWS_REPO_OPEN_STATUS_PATH}${JOB}`));
    for (const c of reads) {
      expect(c.init.body).toBeUndefined();
      expect(c.init.redirect).toBe('manual');
      expect(new URL(c.url).search).toBe('');
      expect(await verifyGatewayHeader(new Headers(c.init.headers).get('x-ezil-gw'), KEY, record, 'POST', c.path, Math.floor(c.at / 1000)))
        .toEqual({ ok: true });
    }
    expect(sleeps).toEqual(Array(3).fill(AWS_RELAY_POLL_MS));
    expect(clock - NOW).toBe(3 * AWS_RELAY_POLL_MS);
    // Every call carries the abort signal timeout() made for it, a new one per call, bounded as listed.
    const carried = e.calls.map((c) => c.init.signal);
    expect(new Set(carried).size).toBe(e.calls.length);
    expect(signals.size).toBe(e.calls.length);
    for (const c of e.calls) {
      expect(signals.has(c.init.signal as AbortSignal)).toBe(true);
      expect(c.timeoutMs).toBe(Math.min(AWS_EDGE_CALL_MAX_MS, NOW + WORKER_DEADLINE_MS - c.at));
    }
  });

  it('the production default bounds each edge call with its own AbortSignal.timeout', async () => {
    const e = job(() => ok(okOpen), 2);
    expect(await run(e, input(), { timeout: undefined })).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    faults = []; // the default signals are not the fake's: checked here instead
    const carried = e.calls.map((c) => c.init.signal);
    expect(carried.length).toBe(3);
    for (const s of carried) expect(s).toBeInstanceOf(AbortSignal);
    expect(new Set(carried).size).toBe(3);
  });

  it('the jobId is 64 hex from 32 random bytes, and two requests never share one', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const e = job(() => ok(okOpen));
      await handleAwsRepoOpen(input(), SANDBOX, target, deps(e.fetch, { randomBytes: undefined }));
      const id = JSON.parse(e.calls[0]!.init.body as string).jobId as string;
      expect(id).toMatch(AWS_JOB_ID_RE);
      expect(e.reads()[0]!.path).toBe(`${AWS_REPO_OPEN_STATUS_PATH}${id}`);
      ids.push(id);
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect(AWS_JOB_ID_RE.source).toBe('^[0-9a-f]{64}$');
  });

  it('a short random source never names a job: workspace_failed, no edge call', async () => {
    const e = job(() => ok(okOpen));
    expect(await run(e, input(), { randomBytes: () => new Uint8Array(16) })).toEqual(refusal('workspace_failed'));
    expect(e.calls).toEqual([]);
  });

  it('relays only the validated §8 fields: never receivedAt or anything else the caller carried', () => {
    const i = { ...input(), receivedAt: 1, shell: 'rm -rf /' } as unknown as RepoOpenInput;
    const relayed = JSON.parse(awsRepoOpenRelayBody(i, JOB));
    expect(Object.keys(relayed)).toEqual(['jobId', ...V.workerRequest.keys]);
  });

  it('the largest §8 body the route accepts relays within the host edge limit', () => {
    const i = input({ handle: 'h'.repeat(39), name: 'n'.repeat(100), defaultBranch: 'b'.repeat(244), path: 'p'.repeat(255) });
    const { receivedAt: _r, ...wire } = i;
    const overhead = new TextEncoder().encode(awsRepoOpenRelayBody(i, JOB)).byteLength - new TextEncoder().encode(JSON.stringify(wire)).byteLength;
    expect(overhead).toBe(`"jobId":"${JOB}",`.length);
    expect(WORKER_REQUEST_MAX_BYTES + overhead).toBeLessThanOrEqual(AWS_REPO_OPEN_RELAY_MAX_BYTES);
    expect(AWS_REPO_OPEN_RELAY_MAX_BYTES).toBe(WORKER_REQUEST_MAX_BYTES + 512);
  });

  it.each([
    ['a git host off the allow-list', { gitHost: 'github.ezil.work' }],
    ['an expired grant', { grant: { ...input().grant, expiresAt: new Date(NOW - 1000).toISOString() } }],
    ['a path on refresh', { op: 'refresh', path: 'src' }],
    ['a malformed token', { grant: { ...input().grant, token: 'egg_x' } }],
  ])('never relays a request the Worker would refuse (%s): invalid_request, no edge call', async (_label, patch) => {
    const e = job(() => ok(okOpen));
    expect(await run(e, input(patch))).toEqual(refusal('invalid_request'));
    expect(e.calls).toEqual([]);
  });

  it('a start answered done at once needs no status read', async () => {
    const e = edge(() => ok(okOpen));
    expect(await run(e)).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    expect(e.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('refresh relays op refresh with path null and answers refreshed', async () => {
    const e = job(() => ok({ ok: true, state: 'refreshed' }));
    expect(await run(e, input({ op: 'refresh' }))).toEqual({ status: 200, body: { ok: true, state: 'refreshed' } });
    const relayed = JSON.parse(e.calls[0]!.init.body as string);
    expect([relayed.op, relayed.path]).toEqual(['refresh', null]);
  });
});

// ── mapping ─────────────────────────────────────────────────────────────────

describe('mapping (§13, vectors errorTable.workerResponses)', () => {
  it.each([
    ['the generic edge not_found', () => json({ ok: false, error: 'not_found' }, 404)],
    ['an empty 404', () => new Response(null, { status: 404 })],
    ['a non-JSON 404', () => new Response('Not Found', { status: 404 })],
  ])('edge 404 on the start (%s): workspace_unsupported, one call, no status read', async (_label, notFound) => {
    const e = edge(notFound);
    const answer = await run(e);
    expect(answer).toEqual(refusal('workspace_unsupported'));
    expect(answer.status).toBe(409);
    expect(e.calls.length).toBe(1);
  });

  it('a 404 on a status read after the job was acknowledged is workspace_failed', async () => {
    const e = job(() => json({ ok: false, error: 'not_found' }, 404));
    expect(await run(e)).toEqual(refusal('workspace_failed'));
  });

  it.each([
    [json({ ok: false, error: 'workspace_busy' }, 409), 'workspace_busy'],
    [json({ ok: false, error: 'job_replayed' }, 409), 'workspace_failed'],
    [json({ ok: false, error: 'repo_open_invalid' }, 409), 'workspace_failed'],
    [json({ ok: false, error: 'workspace_failed' }, 409), 'workspace_failed'],
    [json({ ok: false, error: 'runtime_not_running' }, 409), 'workspace_failed'],
    [json({ ok: false, error: 'workspace_busy', detail: 'x' }, 409), 'workspace_failed'],
    [json({ ok: false, error: 'workspace_busy' }, 400), 'workspace_failed'],
    [json({ ok: false, error: 'repo_open_body_invalid' }, 400), 'workspace_failed'],
    [json({ ok: false, error: 'repo_open_digest_mismatch' }, 400), 'workspace_failed'],
    [json({ ok: false, error: 'gw_stale' }, 401), 'workspace_failed'],
    // (a start 5xx is an unknown outcome, not a refusal: see the deadline block)
    [new Response(null, { status: 302, headers: { location: 'https://example.com/' } }), 'workspace_failed'],
    [json({ ok: true, state: 'running' }, 202), 'workspace_failed'],
    [json({ ok: false }, 200), 'workspace_failed'],
    [json({ ok: true, state: 'queued' }, 200), 'workspace_failed'],
    [json({ ok: true, state: 'running', jobId: JOB }, 200), 'workspace_failed'],
    [json({ ok: true, state: 'done' }, 200), 'workspace_failed'],
    [new Response('{', { status: 200 }), 'workspace_failed'],
  ] as [Response, RepoOpenErrorCode][])('start reply #%# maps as listed, with one call', async (reply, code) => {
    const e = edge(() => reply.clone());
    expect(await run(e)).toEqual(refusal(code));
    expect(e.calls.length).toBe(1);
  });

  it('every vectors okCases row: a valid 200 result is answered as is, an invalid one is workspace_failed', async () => {
    const cases = V.errorTable.workerResponses.okCases as { op: 'open' | 'refresh'; body: Record<string, unknown>; valid: boolean }[];
    expect(cases.some((c) => c.valid) && cases.some((c) => !c.valid)).toBe(true);
    for (const c of cases) {
      const answer = await run(job(() => ok(c.body)), input({ op: c.op, path: c.op === 'open' ? 'src' : null }));
      expect(answer).toEqual(c.valid ? { status: 200, body: c.body } as RepoOpenAnswer : refusal('workspace_failed'));
    }
  });

  it.each([
    ['another repository\'s folder', { folder: '/workspace/repos/acme/other', openFolder: '/workspace/repos/acme/other' }],
    ['a folder that is not this repository\'s (openFolder still is)', { folder: '/workspace/repos/acme/other' }],
    ['a folder under /workspaces', { folder: '/workspaces/repos/acme/site', openFolder: '/workspaces/repos/acme/site' }],
    ['an openFolder outside the folder', { openFolder: '/workspace/repos/acme' }],
    ['an openFolder with a control character', { openFolder: `${FOLDER}/a\nb` }],
    // The OS app's `absolute` rule (app/src/server/repo-open/worker-client.ts validateWorkerOk).
    ['an openFolder with ".." segments that leave the folder', { openFolder: `${FOLDER}/../../../etc` }],
    ['an openFolder with a "." segment', { openFolder: `${FOLDER}/./src` }],
    ['an openFolder ending in a ".." segment', { openFolder: `${FOLDER}/..` }],
    ['a branch BRANCH_RE refuses', { branch: 'x.lock' }],
    ['a non-boolean empty', { empty: 0 }],
  ])('a 200 result with %s is workspace_failed', async (_label, patch) => {
    expect(await run(job(() => ok({ ...okOpen, ...patch })))).toEqual(refusal('workspace_failed'));
  });

  it.each([
    ['a subfolder', `${FOLDER}/src/app`],
    ['dots inside a segment name', `${FOLDER}/.github/..x/a.b`],
    ['an empty segment (the app accepts it)', `${FOLDER}//src`],
    ['a trailing slash (the app accepts it)', `${FOLDER}/`],
  ])('a 200 result with an openFolder holding %s is answered as is (no stricter than the app)', async (_label, openFolder) => {
    const body = { ...okOpen, openFolder, pathNotFound: false };
    expect(await run(job(() => ok(body)))).toEqual({ status: 200, body } as RepoOpenAnswer);
  });

  it('a 200 result only with status 200; a refresh answer to an open and an open answer to a refresh are workspace_failed', async () => {
    expect(await run(job(() => done(201, okOpen)))).toEqual(refusal('workspace_failed'));
    expect(await run(job(() => ok({ ok: true, state: 'refreshed' })))).toEqual(refusal('workspace_failed'));
    expect(await run(job(() => ok(okOpen)), input({ op: 'refresh' }))).toEqual(refusal('workspace_failed'));
  });

  it('every result refusal code (host and kernel) keeps its name and §8 status', async () => {
    for (const code of AWS_RESULT_ERROR_CODES) {
      const answer = await run(job(() => refused(code)));
      expect(answer).toEqual(refusal(code));
      expect(answer.status).toBe(REPO_OPEN_STATUS[code]);
    }
  });

  it('a result refusal is workspace_failed when its status disagrees with the §8 table, its code is not a job code, or its shape is off', async () => {
    const bad: [number, unknown][] = [
      [200, { ok: false, error: 'folder_conflict' }],
      [500, { ok: false, error: 'folder_conflict' }],
      [409, { ok: false, error: 'workspace_unsupported' }],
      [400, { ok: false, error: 'invalid_request' }],
      [409, { ok: false, error: 'repo_open_invalid' }],
      [409, { ok: false, errorCode: 'folder_conflict' }],
      [409, { ok: false, error: 'folder_conflict', message: 'x' }],
    ];
    for (const [status, body] of bad) expect(await run(job(() => done(status, body)))).toEqual(refusal('workspace_failed'));
    for (const result of [null, 'ok', [], { status: 200 }, { body: okOpen }, { status: 200, body: okOpen, extra: 1 }, { ok: true, output: okOpen }]) {
      expect(await run(job(() => json({ ok: true, state: 'done', result })))).toEqual(refusal('workspace_failed'));
    }
  });

  it('a status refusal (job_unknown, an agent refusal, 401) is workspace_failed', async () => {
    expect(await run(job(() => json({ ok: false, error: 'job_unknown' }, 409)))).toEqual(refusal('workspace_failed'));
    expect(await run(job(() => json({ ok: false, error: 'wrong_epoch' }, 409)))).toEqual(refusal('workspace_failed'));
    expect(await run(job(() => json({ ok: false, error: 'gw_bad_mac' }, 401)))).toEqual(refusal('workspace_failed'));
  });

  it('awsJobAnswer validates the folder it is given (pure)', () => {
    expect(awsJobAnswer({ status: 200, body: okOpen }, 'open', FOLDER)).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    expect(awsJobAnswer({ status: 200, body: okOpen }, 'open', `${FOLDER}x`)).toEqual(refusal('workspace_failed'));
  });
});

// ── sanitizer ───────────────────────────────────────────────────────────────

describe('sanitizer: anything grant-shaped in any edge reply fails the request', () => {
  const shaped = `egg_${'0123456789abcdef'.repeat(4)}`;
  it.each([
    ['a credential-shaped branch in the result', () => job(() => ok({ ...okOpen, branch: shaped }))],
    ['the grant echoed in a result refusal', () => job(() => done(409, { ok: false, error: 'workspace_busy', why: TOKEN }))],
    ['the grant echoed in a start reply', () => edge(() => json({ ok: false, error: 'workspace_busy', echo: TOKEN }, 409))],
    ['a grant-shaped status reply', () => job(() => json({ ok: true, state: 'running', note: shaped }))],
    ['a grant-shaped 404 (never workspace_unsupported)', () => edge(() => new Response(shaped, { status: 404 }))],
    ['a grant-shaped error body', () => job(() => new Response(`oops ${shaped}`, { status: 409 }))],
  ])('%s → workspace_failed, and the answer carries no grant', async (_label, make) => {
    const answer = await run(make());
    expect(answer).toEqual(refusal('workspace_failed'));
    expect(await repoOpenResponse(answer).text()).not.toContain('egg_');
  });

  // JSON \u escapes: the reply text holds neither the token nor /egg_[0-9a-f]{64}/, but JSON.parse
  // decodes it to the real grant. Each reply text is built by escaping the token in JSON.stringify output.
  const escapeUnderscore = (s: string) => s.replace('egg_', 'egg\\u005f');
  const escapeAll = (s: string) => [...s].map((c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  const escaped = (value: unknown, status: number, esc: (s: string) => string = escapeUnderscore) => {
    const text = JSON.stringify(value).replaceAll(TOKEN, esc(TOKEN));
    // The precondition that makes these cases: a raw scan alone passes this text, yet it decodes to
    // the grant. Recorded as a harness fault (this runs inside the fake fetch, which must not throw).
    if (text.includes(TOKEN) || /egg_[0-9a-f]{64}/.test(text)) faults.push(`raw text carries the grant: ${status}`);
    if (!JSON.stringify(JSON.parse(text)).includes(TOKEN)) faults.push(`text does not decode to the grant: ${status}`);
    return new Response(text, { status, headers: { 'content-type': 'application/json' } });
  };
  const doneBody = (status: number, body: unknown) => ({ ok: true, state: 'done', result: { status, body } });
  it.each([
    ['in branch, in a 200 result', () => job(() => escaped(doneBody(200, { ...okOpen, branch: TOKEN }), 200))],
    ['in branch, every character escaped', () => job(() => escaped(doneBody(200, { ...okOpen, branch: TOKEN }), 200, escapeAll))],
    ['in openFolder, in a 200 result', () => job(() => escaped(doneBody(200, { ...okOpen, openFolder: `${FOLDER}/${TOKEN}` }), 200))],
    ['in a result refusal', () => job(() => escaped(doneBody(409, { ok: false, error: 'workspace_busy', why: TOKEN }), 200))],
    ['in a start 404 (never workspace_unsupported)', () => edge(() => escaped({ ok: false, error: 'not_found', echo: TOKEN }, 404))],
    ['as a bare JSON string in a start 404', () => edge(() => escaped(TOKEN, 404))],
    ['in a start 5xx, before a good result', () => edge((path) => (path.startsWith(AWS_REPO_OPEN_PATH)
      ? escaped({ ok: false, error: 'agent_unavailable', echo: TOKEN }, 503) : ok(okOpen)))],
    ['in a status 5xx, before a good result', () => edge((path, n) => (path.startsWith(AWS_REPO_OPEN_PATH) ? running()
      : n.reads === 1 ? escaped({ ok: false, error: 'agent_unavailable', echo: TOKEN }, 502) : ok(okOpen)))],
    ['in a running status', () => job(() => escaped({ ok: true, state: 'running', note: TOKEN }, 200))],
  ])('a JSON-escaped grant %s → workspace_failed, and the answer carries no grant', async (_label, make) => {
    const answer = await run(make());
    expect(answer).toEqual(refusal('workspace_failed'));
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
    expect(await repoOpenResponse(answer).text()).not.toContain('egg_');
  });

  it('awsJobAnswer never answers anything grant-shaped, whoever decoded the result (pure)', () => {
    for (const patch of [{ branch: shaped }, { branch: `x/${TOKEN}` }, { openFolder: `${FOLDER}/${shaped}` }, { openFolder: `${FOLDER}/a${TOKEN}b` }]) {
      expect(awsJobAnswer({ status: 200, body: { ...okOpen, ...patch } }, 'open', FOLDER)).toEqual(refusal('workspace_failed'));
    }
    // The near-miss is not grant-shaped and is answered.
    const near = { ...okOpen, branch: `egg_${'0'.repeat(63)}` };
    expect(awsJobAnswer({ status: 200, body: near }, 'open', FOLDER)).toEqual({ status: 200, body: near } as RepoOpenAnswer);
  });

  it('a transport failure whose message holds the grant never leaks it', async () => {
    const answer = await run(edge(() => 'throw'));
    expect(JSON.stringify(answer)).not.toContain('egg_');
    expect(await repoOpenResponse(answer).text()).not.toContain('egg_');
  });

  it('a success answer is built from validated fields only (no token, no extra keys)', async () => {
    const answer = await run(job(() => ok(okOpen)));
    expect(Object.keys(answer.body)).toEqual(Object.keys(okOpen));
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it('an oversized reply is never parsed: workspace_failed', async () => {
    const big = JSON.stringify({ ok: true, state: 'done', result: { status: 200, body: okOpen }, pad: 'x'.repeat(AWS_EDGE_REPLY_MAX_BYTES) });
    expect(await run(job(() => new Response(big)))).toEqual(refusal('workspace_failed'));
  });
});

// ── deadline ────────────────────────────────────────────────────────────────

describe('deadline: the Worker answers within receivedAt + WORKER_DEADLINE_MS', () => {
  it('a job that never finishes ends at the deadline as workspace_busy, with no edge call after it', async () => {
    const e = edge(() => running());
    expect(await run(e)).toEqual(refusal('workspace_busy'));
    const deadline = NOW + WORKER_DEADLINE_MS;
    expect(clock).toBeLessThanOrEqual(deadline);
    expect(e.calls.every((c) => c.at < deadline)).toBe(true);
    for (const c of e.calls) expect(c.timeoutMs).toBeLessThanOrEqual(Math.min(AWS_EDGE_CALL_MAX_MS, deadline - c.at));
    expect(e.starts().length).toBe(1);
    expect(e.reads().length).toBe(Math.ceil(WORKER_DEADLINE_MS / AWS_RELAY_POLL_MS) - 1);
  });

  it('a slow edge cannot carry the answer past the deadline (each call is bounded by the time left)', async () => {
    const e = edge(() => ({ latencyMs: 9_000, reply: running() }));
    expect(await run(e)).toEqual(refusal('workspace_busy'));
    expect(clock).toBeLessThanOrEqual(NOW + WORKER_DEADLINE_MS);
    for (const c of e.calls) expect(c.timeoutMs).toBeLessThanOrEqual(NOW + WORKER_DEADLINE_MS - c.at);
  });

  it('a hung edge: each call is cut by its own signal at min(10 s, time left), and the answer is workspace_busy by the deadline', async () => {
    const e = edge(() => ({ latencyMs: Infinity, reply: running() }));
    expect(await run(e)).toEqual(refusal('workspace_busy'));
    const deadline = NOW + WORKER_DEADLINE_MS;
    expect(clock).toBeLessThanOrEqual(deadline);
    expect(e.starts().length).toBe(1);
    expect(e.reads().length).toBeGreaterThan(0);
    for (const c of e.calls) expect(c.timeoutMs).toBe(Math.min(AWS_EDGE_CALL_MAX_MS, deadline - c.at));
  });

  it('the deadline counts from the route\'s receipt, not from the relay', async () => {
    const e = edge(() => running());
    expect(await run(e, input({}, NOW - 60_000))).toEqual(refusal('workspace_busy'));
    expect(clock).toBeLessThanOrEqual(NOW - 60_000 + WORKER_DEADLINE_MS);
  });

  it('a request whose deadline already passed is workspace_busy, with no edge call', async () => {
    const e = job(() => ok(okOpen));
    expect(await run(e, input({}, NOW - WORKER_DEADLINE_MS))).toEqual(refusal('workspace_busy'));
    expect(e.calls).toEqual([]);
  });

  it('status reads that throw or answer 5xx are repeated within the deadline', async () => {
    const replies: Answer[] = ['throw', json({ ok: false, error: 'agent_unavailable' }, 503), new Response('bad gateway', { status: 502 }), running()];
    const e = edge((path, n) => (path.startsWith(AWS_REPO_OPEN_PATH) ? running() : replies[n.reads - 1] ?? ok(okOpen)));
    expect(await run(e)).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    expect(e.starts().length).toBe(1);
    expect(e.reads().length).toBe(5);
  });

  it('a start whose reply is lost is followed by status reads of the same jobId, never a second start', async () => {
    const e = edge((path) => (path.startsWith(AWS_REPO_OPEN_PATH) ? 'throw' : ok(okOpen)));
    expect(await run(e)).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    expect(e.starts().length).toBe(1);
    expect(e.reads().map((c) => c.path)).toEqual([`${AWS_REPO_OPEN_STATUS_PATH}${JSON.parse(e.calls[0]!.init.body as string).jobId}`]);
  });

  it('a lost start the host never saw: job_unknown is workspace_failed; an edge without the route is workspace_unsupported', async () => {
    const unknown = edge((path) => (path.startsWith(AWS_REPO_OPEN_PATH) ? 'throw' : json({ ok: false, error: 'job_unknown' }, 409)));
    expect(await run(unknown)).toEqual(refusal('workspace_failed'));
    const old = edge((path) => (path.startsWith(AWS_REPO_OPEN_PATH) ? 'throw' : json({ ok: false, error: 'not_found' }, 404)));
    expect(await run(old)).toEqual(refusal('workspace_unsupported'));
  });

  // A2h's edge answers 503 agent_unavailable when the agent's reply fails after delivery (edge.py
  // _repo_open_agent), so the job may run on: a start 5xx is read like a lost reply.
  const fiveHundreds: [string, () => Response][] = [
    ['503 agent_unavailable', () => json({ ok: false, error: 'agent_unavailable' }, 503)],
    ['a tunnel 502 with a text body', () => new Response('bad gateway', { status: 502 })],
    ['an empty 500', () => new Response(null, { status: 500 })],
    ['a 530 origin error', () => new Response('error code: 1033', { status: 530 })],
  ];
  it.each(fiveHundreds)('a start answered %s, then running, then done: the job result, after exactly one start', async (_label, five) => {
    const e = edge((path, n) => (path.startsWith(AWS_REPO_OPEN_PATH) ? five() : n.reads < 2 ? running() : ok(okOpen)));
    expect(await run(e)).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    expect(e.starts().length).toBe(1);
    expect(e.reads().map((c) => c.path)).toEqual(Array(2).fill(`${AWS_REPO_OPEN_STATUS_PATH}${JOB}`));
  });

  it.each(fiveHundreds)('a start answered %s that the host never admitted: job_unknown is workspace_failed, one start', async (_label, five) => {
    const e = edge((path) => (path.startsWith(AWS_REPO_OPEN_PATH) ? five() : json({ ok: false, error: 'job_unknown' }, 409)));
    expect(await run(e)).toEqual(refusal('workspace_failed'));
    expect(e.starts().length).toBe(1);
    expect(e.reads().length).toBe(1);
  });

  it('a start 5xx followed by a refusal result keeps the result\'s code (the job did run)', async () => {
    const e = edge((path) => (path.startsWith(AWS_REPO_OPEN_PATH) ? json({ ok: false, error: 'agent_unavailable' }, 503) : refused('folder_conflict')));
    expect(await run(e)).toEqual(refusal('folder_conflict'));
    expect(e.starts().length).toBe(1);
  });

  it('an edge that answers 503 to every call ends at the deadline as workspace_busy, after exactly one start', async () => {
    const e = edge(() => json({ ok: false, error: 'agent_unavailable' }, 503));
    expect(await run(e)).toEqual(refusal('workspace_busy'));
    expect(e.starts().length).toBe(1);
    expect(clock).toBeLessThanOrEqual(NOW + WORKER_DEADLINE_MS);
    expect(e.calls.every((c) => c.at < NOW + WORKER_DEADLINE_MS)).toBe(true);
  });

  it('an unreachable edge ends at the deadline as workspace_busy, after exactly one start', async () => {
    const e = edge(() => 'throw');
    expect(await run(e)).toEqual(refusal('workspace_busy'));
    expect(e.starts().length).toBe(1);
    expect(clock).toBeLessThanOrEqual(NOW + WORKER_DEADLINE_MS);
  });
});

// ── target and boundaries ───────────────────────────────────────────────────

describe('target and module boundaries', () => {
  it('an awsControlTarget Response is workspace_unsupported: no edge call, its body never read', async () => {
    const e = job(() => ok(okOpen));
    const starting = Response.json({ ok: false, error: 'aws_origin_starting' }, { status: 503 });
    expect(await handleAwsRepoOpen(input(), SANDBOX, starting, deps(e.fetch))).toEqual(refusal('workspace_unsupported'));
    expect(starting.bodyUsed).toBe(false);
    expect(e.calls).toEqual([]);
  });

  it.each([
    ['another sandbox\'s record', { ...target, record: { ...record, sandboxId: 'guac-0a1b2c3d4e5f6a7b-0000000000000000' } }],
    ['an unverified origin', { ...target, record: { ...record, originVerified: false } }],
    ['a malformed control key', { ...target, record: { ...record, controlKey: 'short' } }],
    ['an unroutable zone', { ...target, zone: 'not a zone' }],
    ['a computer id gw1 cannot sign', { ...target, record: { ...record, computerId: record.computerId.toUpperCase() } }],
    ['a lease epoch gw1 cannot sign', { ...target, record: { ...record, leaseEpoch: 0 } }],
  ])('%s is workspace_failed before any edge call', async (_label, t) => {
    const e = job(() => ok(okOpen));
    expect(await handleAwsRepoOpen(input(), SANDBOX, t, deps(e.fetch))).toEqual(refusal('workspace_failed'));
    expect(e.calls).toEqual([]);
  });

  it('the relay carries no kernel or helper bytes and never references runKernel', () => {
    const source = readFileSync(here('./aws-repo-open.ts'), 'utf8');
    expect(source).not.toContain('repo-open-assets');
    expect(source).not.toContain('runKernel');
  });

  it('inert in this lane: no Worker module imports aws-repo-open (the lead\'s activation commit mounts it and updates this check)', () => {
    const importers = readdirSync(here('.')).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'aws-repo-open.ts')
      .filter((f) => readFileSync(here(`./${f}`), 'utf8').includes('aws-repo-open'));
    expect(importers).toEqual([]);
  });
});

// ── contract 1.0.3: the route class (added on the carried cf27920b suite above) ─────────────

const QA = V.constants.GIT_ASSESSMENT_HOST as string;
/**
 * The grant replaced by a marker. The added blocks compare relayed bodies through this, so a failing
 * assertion never prints the grant (the vectors fixture) into test output; the grant itself is
 * checked by a boolean.
 */
const redact = (text: unknown) => String(text).replaceAll(TOKEN, '<grant>');
/** An assessment §8 body: class assessment on its own host, as the assessment route hands it over. */
const assessmentInput = (patch: Record<string, unknown> = {}, receivedAt = NOW) => input({ class: 'assessment', gitHost: QA, ...patch }, receivedAt);
const okAssessment = { ...okOpen, head: 'a'.repeat(40), clean: true };
const runAs = (e: ReturnType<typeof edge>, i: RepoOpenInput, routeClass: RepoOpenClass | undefined, extra: Partial<AwsRepoOpenDeps> = {}) =>
  handleAwsRepoOpen(i, SANDBOX, target, deps(e.fetch, extra), routeClass);

describe('contract 1.0.3: the route class decides the git host and the answer shape', () => {
  it('an assessment open relays class last, polls, and answers head and clean', async () => {
    const e = job(() => ok(okAssessment), 2);
    expect(await runAs(e, assessmentInput(), 'assessment')).toEqual({ status: 200, body: okAssessment } as RepoOpenAnswer);
    const sent = e.calls[0]!.init.body as string;
    expect(e.calls[0]!.url).toBe(`https://${HOST}${AWS_REPO_OPEN_PATH}${sha256(sent)}`);
    const relayed = JSON.parse(sent);
    expect(Object.keys(relayed)).toEqual(['jobId', ...V.workerRequest.keys, ...V.workerRequest.optionalKeys]);
    expect([relayed.class, relayed.gitHost]).toEqual(['assessment', QA]);
    const { receivedAt: _r, ...wire } = assessmentInput();
    expect(redact(sent)).toBe(redact(JSON.stringify({ jobId: JOB, ...wire })));
    expect(relayed.grant.token === TOKEN && sent.split(TOKEN).length === 2).toBe(true);
    expect(e.reads().length).toBe(2);
  });

  it('a personal body without class relays byte-identically to 1.0.2; an explicit personal class is relayed last', async () => {
    const e = job(() => ok(okOpen));
    expect(await runAs(e, input(), 'personal')).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    const { receivedAt: _r, ...wire } = input();
    expect(redact(e.calls[0]!.init.body)).toBe(redact(JSON.stringify({ jobId: JOB, ...wire })));
    expect(e.calls[0]!.init.body === JSON.stringify({ jobId: JOB, ...wire })).toBe(true);
    expect('class' in JSON.parse(e.calls[0]!.init.body as string)).toBe(false);
    const explicit = job(() => ok(okOpen));
    expect(await runAs(explicit, input({ class: 'personal' }), undefined)).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    expect(Object.keys(JSON.parse(explicit.calls[0]!.init.body as string)).at(-1)).toBe('class');
  });

  it.each([
    ['an assessment body on the default (personal) route', () => assessmentInput(), undefined],
    ['an assessment body on the personal route', () => assessmentInput(), 'personal'],
    ['a personal body on the assessment route', () => input(), 'assessment'],
    ['a class-less body on git-qa on the assessment route (an assessment body must carry class)', () => input({ gitHost: QA }), 'assessment'],
    ['a class-less body on git-qa on the personal route', () => input({ gitHost: QA }), 'personal'],
    ['class assessment on git-preview', () => input({ class: 'assessment' }), 'assessment'],
    ['class personal on git-qa', () => input({ class: 'personal', gitHost: QA }), 'personal'],
    ['an unknown route class', () => assessmentInput(), 'exam'],
    ['an inherited property name as the class', () => input({ class: 'constructor', gitHost: QA }), 'constructor'],
  ] as [string, () => RepoOpenInput, RepoOpenClass | undefined][])('never relays a body outside the route class (%s): invalid_request, no edge call', async (_label, make, routeClass) => {
    const e = job(() => ok(okAssessment));
    expect(await runAs(e, make(), routeClass)).toEqual(refusal('invalid_request'));
    expect(e.calls.length).toBe(0);
  });

  it('every vectors okAssessmentCases row through an assessment open: a valid result is answered as is, an invalid one is workspace_failed', async () => {
    const cases = V.errorTable.workerResponses.okAssessmentCases as { body: Record<string, unknown>; valid: boolean; why?: string }[];
    expect(cases.length).toBe(16);
    for (const c of cases) {
      const body = materialise(c.body, NOW) as Record<string, unknown>;
      const answer = await runAs(job(() => ok(body)), assessmentInput({ path: 'src' }), 'assessment');
      expect([c.why ?? 'valid', answer]).toEqual([c.why ?? 'valid', c.valid ? { status: 200, body } as RepoOpenAnswer : refusal('workspace_failed')]);
    }
  });

  it('the two shapes exclude each other: an assessment-shaped result for a personal open, a personal one for an assessment open', async () => {
    let carried = 0;
    for (const c of V.errorTable.workerResponses.okAssessmentCases as { body: Record<string, unknown> }[]) {
      // The one row without head and clean is the 'personal shape' row: valid for personal by construction.
      if (!('head' in c.body) && !('clean' in c.body)) continue;
      carried += 1;
      expect(await run(job(() => ok(materialise(c.body, NOW))), input({ path: 'src' }))).toEqual(refusal('workspace_failed'));
    }
    expect(carried).toBe(15);
    for (const c of V.errorTable.workerResponses.okCases as { op: string; body: Record<string, unknown>; valid: boolean }[]) {
      if (c.op !== 'open') continue;
      expect(await runAs(job(() => ok(c.body)), assessmentInput({ path: 'src' }), 'assessment')).toEqual(refusal('workspace_failed'));
    }
  });

  it('an assessment refresh answers refreshed; an assessment refusal keeps its code and §8 status', async () => {
    const e = job(() => ok({ ok: true, state: 'refreshed' }));
    expect(await runAs(e, assessmentInput({ op: 'refresh' }), 'assessment')).toEqual({ status: 200, body: { ok: true, state: 'refreshed' } });
    expect(JSON.parse(e.calls[0]!.init.body as string).class).toBe('assessment');
    for (const code of AWS_RESULT_ERROR_CODES) expect(await runAs(job(() => refused(code)), assessmentInput(), 'assessment')).toEqual(refusal(code));
  });

  it('awsJobAnswer for class assessment: head, clean, empty and state agree (pure)', () => {
    const answer = (body: unknown) => awsJobAnswer({ status: 200, body }, 'open', FOLDER, 'assessment');
    const empty = { ...okAssessment, state: 'initialized_empty', empty: true, head: null };
    expect(answer(okAssessment)).toEqual({ status: 200, body: okAssessment } as RepoOpenAnswer);
    expect(answer(empty)).toEqual({ status: 200, body: empty } as RepoOpenAnswer);
    expect(answer({ ...okAssessment, clean: false })).toEqual({ status: 200, body: { ...okAssessment, clean: false } } as RepoOpenAnswer);
    for (const bad of [
      { ...okAssessment, state: 'existing' },
      { ...okAssessment, head: null },
      { ...empty, head: 'a'.repeat(40) },
      { ...okAssessment, empty: true },
      { ...empty, empty: false },
      { ...empty, state: 'cloned' },
      { ...okAssessment, head: 'A'.repeat(40) },
      { ...okAssessment, head: 'a'.repeat(64) },
      { ...okAssessment, head: 7 },
      { ...okAssessment, clean: 'true' },
      { ...okAssessment, clean: null },
      { ...okAssessment, extra: 1 },
      okOpen,
    ]) {
      expect(answer(bad)).toEqual(refusal('workspace_failed'));
    }
    // The personal default is unchanged, and refuses the assessment shape.
    expect(awsJobAnswer({ status: 200, body: okOpen }, 'open', FOLDER)).toEqual({ status: 200, body: okOpen } as RepoOpenAnswer);
    expect(awsJobAnswer({ status: 200, body: okAssessment }, 'open', FOLDER)).toEqual(refusal('workspace_failed'));
    // A class outside the closed list validates nothing.
    for (const cls of ['exam', 'constructor']) {
      expect(awsJobAnswer({ status: 200, body: okOpen }, 'open', FOLDER, cls as RepoOpenClass)).toEqual(refusal('workspace_failed'));
    }
  });
});

// ── E1-5: start and poll (added on the carried cf27920b suite above) ────────────────────────

/** 16f9c25b app/src/server/assessment/worker-client.ts ASSESSMENT_WORKER_TIMEOUTS_MS.repoOpen. */
const APP_REPO_OPEN_OP_TIMEOUT_MS = 30_000;
/** 16f9c25b app/src/server/assessment/orchestrator.ts sweepBudgetMs. */
const ASSESSMENT_SWEEP_BUDGET_MS = 40_000;
const HANDLE = V.fixtures.handle as string;
const NAME = V.fixtures.name as string;
const jobOf = (patch: Partial<AwsRepoOpenJob> = {}): AwsRepoOpenJob =>
  ({ jobId: JOB, sandboxName: SANDBOX, op: 'open', class: 'personal', handle: HANDLE, name: NAME, acknowledged: true, ...patch });
const running$ = (job: AwsRepoOpenJob): AwsRepoOpenStep => ({ state: 'running', job });
const done$ = (answer: RepoOpenAnswer): AwsRepoOpenStep => ({ state: 'done', answer });
/** A reply text whose grant is JSON-escaped: a raw scan passes it, JSON.parse decodes it to the grant. */
const escapedReply = (value: unknown, status: number) =>
  new Response(JSON.stringify(value).replaceAll(TOKEN, TOKEN.replace('egg_', 'egg\\u005f')), { status, headers: { 'content-type': 'application/json' } });

describe('E1-5: awsRepoOpenStart sends the start exactly once and answers a token-free job', () => {
  it('a start the host admits: running + the job (acknowledged), one edge call, no sleep, no status read', async () => {
    const e = edge(() => running());
    const r = await awsRepoOpenStart(input(), SANDBOX, target, deps(e.fetch));
    expect(r).toEqual(running$(jobOf()));
    expect(e.calls.length).toBe(1);
    expect(e.starts().length).toBe(1);
    expect(sleeps).toEqual([]);
    const { receivedAt: _r, ...wire } = input();
    expect(redact(e.calls[0]!.init.body)).toBe(redact(JSON.stringify({ jobId: JOB, ...wire })));
    expect(e.calls[0]!.init.body === JSON.stringify({ jobId: JOB, ...wire })).toBe(true);
    // The job never carries the grant, so a caller may persist it.
    expect(JSON.stringify(r)).not.toContain('egg_');
    expect(Object.keys((r as { job: AwsRepoOpenJob }).job)).toEqual(['jobId', 'sandboxName', 'op', 'class', 'handle', 'name', 'acknowledged']);
  });

  it.each([
    ['a lost reply', () => 'throw' as const],
    ['503 agent_unavailable', () => json({ ok: false, error: 'agent_unavailable' }, 503)],
    ['a tunnel 502', () => new Response('bad gateway', { status: 502 })],
    ['an empty 500', () => new Response(null, { status: 500 })],
    ['a 530', () => new Response('error code: 1033', { status: 530 })],
  ] as [string, () => Answer][])('a start whose outcome is unknown (%s): running + the job, not acknowledged', async (_label, reply) => {
    const e = edge(reply);
    expect(await awsRepoOpenStart(input(), SANDBOX, target, deps(e.fetch))).toEqual(running$(jobOf({ acknowledged: false })));
    expect(e.calls.length).toBe(1);
  });

  it('an assessment start records the route class in the job; a refresh records op refresh', async () => {
    expect(await awsRepoOpenStart(assessmentInput(), SANDBOX, target, deps(edge(() => running()).fetch), 'assessment'))
      .toEqual(running$(jobOf({ class: 'assessment' })));
    expect(await awsRepoOpenStart(input({ op: 'refresh' }), SANDBOX, target, deps(edge(() => running()).fetch)))
      .toEqual(running$(jobOf({ op: 'refresh' })));
  });

  it('a start answered done at once: done + the validated answer, for the route class', async () => {
    expect(await awsRepoOpenStart(input(), SANDBOX, target, deps(edge(() => ok(okOpen)).fetch))).toEqual(done$({ status: 200, body: okOpen } as RepoOpenAnswer));
    expect(await awsRepoOpenStart(assessmentInput(), SANDBOX, target, deps(edge(() => ok(okAssessment)).fetch), 'assessment'))
      .toEqual(done$({ status: 200, body: okAssessment } as RepoOpenAnswer));
    expect(await awsRepoOpenStart(assessmentInput(), SANDBOX, target, deps(edge(() => ok(okOpen)).fetch), 'assessment'))
      .toEqual(done$(refusal('workspace_failed')));
  });

  it.each([
    ['an awsControlTarget Response', () => edge(() => ok(okOpen)), 'workspace_unsupported', 0, { target: Response.json({}, { status: 503 }) }],
    ['an edge without the route (404)', () => edge(() => new Response(null, { status: 404 })), 'workspace_unsupported', 1, {}],
    ['the host\'s one slot taken', () => edge(() => json({ ok: false, error: 'workspace_busy' }, 409)), 'workspace_busy', 1, {}],
    ['a deadline already passed', () => edge(() => running()), 'workspace_busy', 0, { receivedAt: NOW - WORKER_DEADLINE_MS }],
    ['job_replayed', () => edge(() => json({ ok: false, error: 'job_replayed' }, 409)), 'workspace_failed', 1, {}],
    ['a 401', () => edge(() => json({ ok: false, error: 'gw_bad_mac' }, 401)), 'workspace_failed', 1, {}],
    ['a grant echoed', () => edge(() => json({ ok: false, error: 'workspace_busy', echo: TOKEN }, 409)), 'workspace_failed', 1, {}],
    ['an assessment body on the personal route', () => edge(() => running()), 'invalid_request', 0, { input: assessmentInput() }],
  ] as [string, () => ReturnType<typeof edge>, RepoOpenErrorCode, number, { target?: Response; receivedAt?: number; input?: RepoOpenInput }][])(
    'a start refused (%s): done + the refusal', async (_label, make, code, calls, o) => {
      const e = make();
      const i = o.input ?? input({}, o.receivedAt ?? NOW);
      expect(await awsRepoOpenStart(i, SANDBOX, o.target ?? target, deps(e.fetch))).toEqual(done$(refusal(code)));
      expect(e.calls.length).toBe(calls);
    });
});

describe('E1-5: awsRepoOpenPoll reads the job once', () => {
  it('one status read of the jobId (signed, no body, no sleep); running → running, now acknowledged', async () => {
    const e = edge(() => running());
    expect(await awsRepoOpenPoll(jobOf({ acknowledged: false }), target, deps(e.fetch))).toEqual(running$(jobOf()));
    expect(e.calls.length).toBe(1);
    expect(e.starts()).toEqual([]);
    const c = e.calls[0]!;
    expect(c.path).toBe(`${AWS_REPO_OPEN_STATUS_PATH}${JOB}`);
    expect(c.init.body).toBeUndefined();
    expect(c.init.redirect).toBe('manual');
    expect(await verifyGatewayHeader(new Headers(c.init.headers).get('x-ezil-gw'), KEY, record, 'POST', c.path, Math.floor(c.at / 1000))).toEqual({ ok: true });
    expect(sleeps).toEqual([]);
  });

  it('done → the result re-validated for the job (personal and assessment)', async () => {
    expect(await awsRepoOpenPoll(jobOf(), target, deps(edge(() => ok(okOpen)).fetch))).toEqual(done$({ status: 200, body: okOpen } as RepoOpenAnswer));
    expect(await awsRepoOpenPoll(jobOf({ class: 'assessment' }), target, deps(edge(() => ok(okAssessment)).fetch)))
      .toEqual(done$({ status: 200, body: okAssessment } as RepoOpenAnswer));
    expect(await awsRepoOpenPoll(jobOf({ op: 'refresh' }), target, deps(edge(() => ok({ ok: true, state: 'refreshed' })).fetch)))
      .toEqual(done$({ status: 200, body: { ok: true, state: 'refreshed' } }));
    expect(await awsRepoOpenPoll(jobOf(), target, deps(edge(() => refused('folder_conflict')).fetch))).toEqual(done$(refusal('folder_conflict')));
  });

  it('the poll re-validates the result against the job\'s class, op and folder', async () => {
    const poll = (job: AwsRepoOpenJob, result: Response) => awsRepoOpenPoll(job, target, deps(edge(() => result.clone()).fetch));
    expect(await poll(jobOf(), ok(okAssessment))).toEqual(done$(refusal('workspace_failed')));
    expect(await poll(jobOf({ class: 'assessment' }), ok(okOpen))).toEqual(done$(refusal('workspace_failed')));
    expect(await poll(jobOf({ class: 'assessment' }), ok({ ...okAssessment, state: 'existing' }))).toEqual(done$(refusal('workspace_failed')));
    expect(await poll(jobOf({ class: 'assessment' }), ok({ ...okAssessment, head: null }))).toEqual(done$(refusal('workspace_failed')));
    expect(await poll(jobOf({ name: 'other' }), ok(okOpen))).toEqual(done$(refusal('workspace_failed')));
    expect(await poll(jobOf({ op: 'refresh' }), ok(okOpen))).toEqual(done$(refusal('workspace_failed')));
    expect(await poll(jobOf(), done(201, okOpen))).toEqual(done$(refusal('workspace_failed')));
    expect(await poll(jobOf(), done(409, { ok: false, error: 'invalid_request' }))).toEqual(done$(refusal('workspace_failed')));
    for (const c of V.errorTable.workerResponses.okAssessmentCases as { body: Record<string, unknown>; valid: boolean; why?: string }[]) {
      const body = materialise(c.body, NOW);
      expect([c.why ?? 'valid', await poll(jobOf({ class: 'assessment' }), ok(body))])
        .toEqual([c.why ?? 'valid', done$(c.valid ? { status: 200, body } as RepoOpenAnswer : refusal('workspace_failed'))]);
    }
  });

  it('a transport failure or a 5xx is not an answer: running, the job unchanged', async () => {
    for (const acknowledged of [false, true]) {
      for (const reply of ['throw', json({ ok: false, error: 'agent_unavailable' }, 503), new Response('bad gateway', { status: 502 })] as Answer[]) {
        const e = edge(() => (reply instanceof Response ? reply.clone() : reply));
        expect(await awsRepoOpenPoll(jobOf({ acknowledged }), target, deps(e.fetch))).toEqual(running$(jobOf({ acknowledged })));
        expect(e.calls.length).toBe(1);
      }
    }
  });

  it('a 404 is workspace_unsupported before the host named the job and workspace_failed after', async () => {
    const notFound = () => json({ ok: false, error: 'not_found' }, 404);
    expect(await awsRepoOpenPoll(jobOf({ acknowledged: false }), target, deps(edge(notFound).fetch))).toEqual(done$(refusal('workspace_unsupported')));
    expect(await awsRepoOpenPoll(jobOf({ acknowledged: true }), target, deps(edge(notFound).fetch))).toEqual(done$(refusal('workspace_failed')));
  });

  it('job_unknown, any other refusal and any malformed envelope are workspace_failed', async () => {
    for (const reply of [json({ ok: false, error: 'job_unknown' }, 409), json({ ok: false, error: 'gw_stale' }, 401),
      json({ ok: true, state: 'queued' }), json({ ok: true, state: 'running', jobId: JOB }), json({ ok: true, state: 'done' }), new Response('{')]) {
      expect(await awsRepoOpenPoll(jobOf(), target, deps(edge(() => reply.clone()).fetch))).toEqual(done$(refusal('workspace_failed')));
    }
  });

  it('the poll holds no grant, yet anything grant-shaped in a status reply, raw or JSON-escaped, is workspace_failed', async () => {
    const shaped = `egg_${'0123456789abcdef'.repeat(4)}`;
    for (const reply of [
      json({ ok: true, state: 'running', note: TOKEN }),
      json({ ok: true, state: 'running', note: shaped }),
      escapedReply({ ok: true, state: 'running', note: TOKEN }, 200),
      escapedReply({ ok: true, state: 'done', result: { status: 200, body: { ...okOpen, branch: TOKEN } } }, 200),
      escapedReply({ ok: false, error: 'agent_unavailable', echo: TOKEN }, 503),
      escapedReply({ ok: false, error: 'not_found', echo: TOKEN }, 404),
    ]) {
      const answer = await awsRepoOpenPoll(jobOf({ acknowledged: false }), target, deps(edge(() => reply.clone()).fetch));
      expect(answer).toEqual(done$(refusal('workspace_failed')));
      expect(JSON.stringify(answer)).not.toContain('egg_');
    }
  });

  it.each([
    ['a short jobId', { jobId: 'ab'.repeat(16) }],
    ['an uppercase jobId', { jobId: 'AB'.repeat(32) }],
    ['an unknown op', { op: 'delete' }],
    ['an unknown class', { class: 'exam' }],
    ['an inherited name as the class', { class: 'constructor' }],
    ['a handle HANDLE_RE refuses', { handle: 'h'.repeat(40) }],
    ['a name ending in .git', { name: 'site.git' }],
    ['a name with ..', { name: 'a..b' }],
    ['a non-boolean acknowledged', { acknowledged: 'yes' }],
    ['a non-string sandbox name', { sandboxName: 7 }],
    ['an extra key (a grant)', { token: TOKEN }],
  ] as [string, Record<string, unknown>][])('the job is untrusted (%s): invalid_request, no edge call', async (_label, patch) => {
    const e = edge(() => ok(okOpen));
    expect(await awsRepoOpenPoll({ ...jobOf(), ...patch } as AwsRepoOpenJob, target, deps(e.fetch))).toEqual(done$(refusal('invalid_request')));
    expect(e.calls.length).toBe(0);
  });

  it('a missing key, a non-object job, or a NaN `until` is invalid_request, no edge call', async () => {
    const e = edge(() => ok(okOpen));
    const { acknowledged: _a, ...missing } = jobOf();
    for (const job of [missing, null, [], 'job'] as unknown as AwsRepoOpenJob[]) {
      expect(await awsRepoOpenPoll(job, target, deps(e.fetch))).toEqual(done$(refusal('invalid_request')));
    }
    expect(await awsRepoOpenPoll(jobOf(), target, deps(e.fetch), Number.NaN)).toEqual(done$(refusal('invalid_request')));
    expect(e.calls.length).toBe(0);
  });

  it.each([
    ['another sandbox\'s job', jobOf({ sandboxName: 'guac-0a1b2c3d4e5f6a7b-0000000000000000' }), target],
    ['an unverified origin', jobOf(), { ...target, record: { ...record, originVerified: false } }],
    ['a malformed control key', jobOf(), { ...target, record: { ...record, controlKey: 'short' } }],
    ['an unroutable zone', jobOf(), { ...target, zone: 'not a zone' }],
  ] as [string, AwsRepoOpenJob, AwsRepoOpenTarget][])('%s is workspace_failed before any edge call', async (_label, job, t) => {
    const e = edge(() => ok(okOpen));
    expect(await awsRepoOpenPoll(job, t, deps(e.fetch))).toEqual(done$(refusal('workspace_failed')));
    expect(e.calls.length).toBe(0);
  });

  it('an awsControlTarget Response is not an answer: running, the job unchanged, no edge call, its body never read', async () => {
    const e = edge(() => ok(okOpen));
    const starting = Response.json({ ok: false, error: 'aws_origin_starting' }, { status: 503 });
    expect(await awsRepoOpenPoll(jobOf({ acknowledged: false }), starting, deps(e.fetch))).toEqual(running$(jobOf({ acknowledged: false })));
    expect(starting.bodyUsed).toBe(false);
    expect(e.calls.length).toBe(0);
  });

  it('without `until`, a poll long after the 105 s Worker deadline still reads the result', async () => {
    const e = edge(() => ok(okAssessment));
    const d = deps(e.fetch);
    clock = NOW + 9 * 60_000;
    expect(await awsRepoOpenPoll(jobOf({ class: 'assessment' }), target, d)).toEqual(done$({ status: 200, body: okAssessment } as RepoOpenAnswer));
    expect(e.calls[0]!.timeoutMs).toBe(AWS_EDGE_CALL_MAX_MS);
  });

  it('`until` bounds the read: passed → workspace_busy with no edge call; near → the call is cut at it', async () => {
    const e = edge(() => ({ latencyMs: Infinity, reply: running() }));
    const d = deps(e.fetch);
    expect(await awsRepoOpenPoll(jobOf(), target, d, NOW)).toEqual(done$(refusal('workspace_busy')));
    expect(e.calls.length).toBe(0);
    expect(await awsRepoOpenPoll(jobOf(), target, d, NOW + 2_000)).toEqual(running$(jobOf()));
    expect(e.calls[0]!.timeoutMs).toBe(2_000);
    expect(clock).toBe(NOW + 2_000);
  });
});

describe('E1-5: each start and each poll is bounded well under the app\'s 30 s op and the 40 s sweep', () => {
  it('one edge call each, at most AWS_EDGE_CALL_MAX_MS; a start and a poll fit one sweep with room', () => {
    expect(AWS_EDGE_CALL_MAX_MS).toBe(10_000);
    expect(AWS_EDGE_CALL_MAX_MS).toBeLessThanOrEqual(APP_REPO_OPEN_OP_TIMEOUT_MS / 3);
    expect(AWS_EDGE_CALL_MAX_MS * 2).toBeLessThanOrEqual(ASSESSMENT_SWEEP_BUDGET_MS / 2);
  });

  it('a hung edge: a start answers within AWS_EDGE_CALL_MAX_MS (running, outcome unknown), after one call cut by its own signal', async () => {
    const e = edge(() => ({ latencyMs: Infinity, reply: running() }));
    expect(await awsRepoOpenStart(input(), SANDBOX, target, deps(e.fetch))).toEqual(running$(jobOf({ acknowledged: false })));
    expect(clock - NOW).toBe(AWS_EDGE_CALL_MAX_MS);
    expect(e.calls.map((c) => c.timeoutMs)).toEqual([AWS_EDGE_CALL_MAX_MS]);
  });

  it('a hung edge: a poll answers within AWS_EDGE_CALL_MAX_MS (running), after one call cut by its own signal', async () => {
    const e = edge(() => ({ latencyMs: Infinity, reply: running() }));
    expect(await awsRepoOpenPoll(jobOf(), target, deps(e.fetch))).toEqual(running$(jobOf()));
    expect(clock - NOW).toBe(AWS_EDGE_CALL_MAX_MS);
    expect(e.calls.map((c) => c.timeoutMs)).toEqual([AWS_EDGE_CALL_MAX_MS]);
  });

  it('the production default: each start and each poll call carries AbortSignal.timeout(AWS_EDGE_CALL_MAX_MS)', async () => {
    const original = AbortSignal.timeout;
    const seen: number[] = [];
    AbortSignal.timeout = (ms: number) => { seen.push(ms); return original.call(AbortSignal, ms); };
    try {
      const e = edge(() => running());
      const d = deps(e.fetch, { timeout: undefined });
      const s = await awsRepoOpenStart(input(), SANDBOX, target, d);
      expect(s.state).toBe('running');
      await awsRepoOpenPoll((s as { job: AwsRepoOpenJob }).job, target, d);
    } finally {
      AbortSignal.timeout = original;
    }
    faults = []; // the default signals are not the fake's: checked here instead
    expect(seen).toEqual([AWS_EDGE_CALL_MAX_MS, AWS_EDGE_CALL_MAX_MS]);
  });
});

describe('E1-5: across sweeps, and handleAwsRepoOpen as the composition', () => {
  it('an assessment open across sweeps: start, persist the job (JSON), poll per sweep, answer head and clean', async () => {
    const e = edge((path, n) => (path.startsWith(AWS_REPO_OPEN_PATH) ? running() : n.reads < 2 ? running() : ok(okAssessment)));
    const d = deps(e.fetch);
    const s = await awsRepoOpenStart(assessmentInput(), SANDBOX, target, d, 'assessment');
    expect(s.state).toBe('running');
    const persisted = JSON.parse(JSON.stringify((s as { job: AwsRepoOpenJob }).job)) as AwsRepoOpenJob;
    expect(JSON.stringify(persisted)).not.toContain('egg_');
    clock += 60_000;
    const first = await awsRepoOpenPoll(persisted, target, d);
    expect(first).toEqual(running$(jobOf({ class: 'assessment' })));
    clock += 60_000;
    const second = await awsRepoOpenPoll((first as { job: AwsRepoOpenJob }).job, target, d);
    expect(second).toEqual(done$({ status: 200, body: okAssessment } as RepoOpenAnswer));
    expect(e.starts().length).toBe(1);
    expect(e.reads().map((c) => c.path)).toEqual(Array(2).fill(`${AWS_REPO_OPEN_STATUS_PATH}${JOB}`));
    expect(sleeps).toEqual([]);
  });

  it('a lost start, then the poll: the same jobId, never a second start; job_unknown is workspace_failed', async () => {
    const e = edge((path) => (path.startsWith(AWS_REPO_OPEN_PATH) ? 'throw' : json({ ok: false, error: 'job_unknown' }, 409)));
    const d = deps(e.fetch);
    const s = await awsRepoOpenStart(input(), SANDBOX, target, d);
    expect(s).toEqual(running$(jobOf({ acknowledged: false })));
    expect(await awsRepoOpenPoll((s as { job: AwsRepoOpenJob }).job, target, d)).toEqual(done$(refusal('workspace_failed')));
    expect(e.starts().length).toBe(1);
  });

  it('handleAwsRepoOpen makes exactly the edge calls of a start and its polls, every AWS_RELAY_POLL_MS', async () => {
    const e = job(() => ok(okAssessment), 4);
    expect(await runAs(e, assessmentInput(), 'assessment')).toEqual({ status: 200, body: okAssessment } as RepoOpenAnswer);
    expect(e.starts().length).toBe(1);
    expect(e.reads().length).toBe(4);
    expect(sleeps).toEqual(Array(4).fill(AWS_RELAY_POLL_MS));
  });
});
