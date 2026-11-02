/**
 * The u2 repo-open protocol (contract universe-repo-open-v1 1.0.3, §8 body and answers, §13): ONLY the
 * symbols the AWS relay (A2r) needs, taken from the u2 Worker module (2ca90211 worker/src/repo-open.ts)
 * and updated for 1.0.3. INERT: no route is mounted here, and nothing but the AWS relay imports it.
 *
 * Why a separate module: in this tree `./repo-open` is open-project's live module (the assessment
 * routes import it), not the u2 one, so the u2 symbols cannot live under that path. Nothing here is
 * the Cloudflare in-sandbox runner (runFlight, the kernel assets, the DO lock discipline): the AWS host
 * agent runs the kernel (infra/host-agent/lib/ezil_host/repo_open.py).
 *
 * 1.0.3 (vectors workerRequest.classRule, okAssessmentRule):
 *  - The §8 body may carry `class: 'personal'|'assessment'`; absent = personal. Class → git host is a
 *    closed table (REPO_OPEN_CLASS_GIT_HOSTS). The parser takes the ROUTE's class: the body's
 *    effective class must equal it, and gitHost must be exactly that class's host. There is no union
 *    allow-list: a personal route never accepts git-qa, an assessment route never accepts git-preview,
 *    and an assessment body must carry `class` (so the host and the kernel see it too).
 *  - An assessment open answers okOpenAssessment: the 7 personal keys plus `head` (40 lowercase hex,
 *    or null for an unborn branch), `clean` and (E1-6) `remote`, never state `existing`.
 *  - E1-6 (vectors kernel.assessment.layoutRule): an assessment's editor root is the wrapper
 *    W = <root>/projects/<repositoryId> (the clone is W/repository, the OS open-project layout), so its
 *    body carries path null, and its answer names W as folder and openFolder with pathNotFound false and
 *    remote = https://git-qa.ezil.work/<handle>/<name>.git. The caller rebuilds W and the remote from
 *    what it sent (assessmentEditorRoot, assessmentRemoteUrl), never from the answer.
 */

// ── constants (each compared with the vectors by repo-open-u2.test.ts) ─────────

export const WORKER_DEADLINE_MS = 105_000;
export const WORKER_ACCEPT_EXPIRY_MAX_MS = 960_000;
export const WORKER_REQUEST_MAX_BYTES = 4_096;

/** vectors constants REPO_OPEN_CLASSES / REPO_OPEN_CLASS_DEFAULT (1.0.3). */
export const REPO_OPEN_CLASSES = Object.freeze(['personal', 'assessment'] as const);
export type RepoOpenClass = (typeof REPO_OPEN_CLASSES)[number];
export const REPO_OPEN_CLASS_DEFAULT: RepoOpenClass = 'personal';
/** vectors constants REPO_OPEN_CLASS_GIT_HOSTS: the one git host each class may name. */
export const REPO_OPEN_CLASS_GIT_HOSTS: Readonly<Record<RepoOpenClass, string>> = Object.freeze({
  personal: 'git-preview.ezil.work',
  assessment: 'git-qa.ezil.work',
});
/** A known class: a member of the closed list, never an inherited property name ('constructor', '__proto__'). */
export const isRepoOpenClass = (value: unknown): value is RepoOpenClass =>
  typeof value === 'string' && (REPO_OPEN_CLASSES as readonly string[]).includes(value);

/** vectors constants ASSESSMENT_DIR_TEMPLATE (projects/<repositoryId>) and ASSESSMENT_CLONE_DIR_NAME (E1-6). */
export const ASSESSMENT_PROJECTS_DIR = 'projects';
export const ASSESSMENT_CLONE_DIR = 'repository';
/** The wrapper W an assessment answers as its folder and openFolder: `<root>/projects/<repositoryId>`. */
export const assessmentEditorRoot = (root: string, repositoryId: string) => `${root}/${ASSESSMENT_PROJECTS_DIR}/${repositoryId}`;
/** vectors constants ASSESSMENT_REMOTE_TEMPLATE for `<handle>/<name>`. */
export const assessmentRemoteUrl = (handle: string, name: string) => `https://${REPO_OPEN_CLASS_GIT_HOSTS.assessment}/${handle}/${name}.git`;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,243}$/;
export const GRANT_RE = /^egg_[0-9a-f]{64}$/;
/** okAssessmentRule: a head is 40 lowercase hex. */
export const HEAD_RE = /^[0-9a-f]{40}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const validName = (s: string) => NAME_RE.test(s) && !s.includes('..') && !s.endsWith('.git');
export const validBranch = (s: string) => BRANCH_RE.test(s) && !s.includes('..') && !s.includes('//') && !s.endsWith('/')
  && !s.endsWith('.lock') && !s.includes('/.') && !s.endsWith('.');

/** The decoded-path checks of app-link.js `pathProblem` (vectors `link.path`); null when acceptable. */
function pathProblem(value: string): string | null {
  if (value === '') return 'empty';
  if (new TextEncoder().encode(value).length > 255) return 'too_long';
  if (value.startsWith('/')) return 'absolute';
  if (value.includes('\\')) return 'backslash';
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return 'control';
  }
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') return 'dot_segment';
    if (!PATH_SEGMENT_RE.test(segment)) return 'segment';
  }
  return null;
}

// ── responses ───────────────────────────────────────────────────────────────

export type RepoOpenErrorCode =
  | 'runtime_not_running' | 'workspace_not_ready' | 'workspace_busy' | 'folder_conflict' | 'workspace_unsupported'
  | 'repository_too_large' | 'network_unavailable' | 'git_auth_rejected' | 'repository_unavailable'
  | 'workspace_failed' | 'invalid_signature' | 'invalid_request';
/** §8 "Responses" (vectors errorTable.workerResponses.refusals). */
export const REPO_OPEN_STATUS: Readonly<Record<RepoOpenErrorCode, number>> = {
  runtime_not_running: 409, workspace_not_ready: 409, workspace_busy: 409, folder_conflict: 409,
  workspace_unsupported: 409, repository_too_large: 409,
  network_unavailable: 502, git_auth_rejected: 502, repository_unavailable: 502,
  workspace_failed: 500, invalid_signature: 401, invalid_request: 400,
};

/** vectors errorTable.workerResponses.okOpen (keys in order, states). */
export const OPEN_RESULT_KEYS = Object.freeze(['ok', 'state', 'folder', 'openFolder', 'pathNotFound', 'branch', 'empty'] as const);
export const OPEN_RESULT_STATES = Object.freeze(['cloned', 'initialized_empty', 'existing'] as const);
/** vectors errorTable.workerResponses.okOpenAssessment (1.0.3, E1-6 `remote`): never `existing`. */
export const ASSESSMENT_OPEN_RESULT_KEYS = Object.freeze([...OPEN_RESULT_KEYS, 'head', 'clean', 'remote'] as const);
export const ASSESSMENT_OPEN_RESULT_STATES = Object.freeze(['cloned', 'initialized_empty'] as const);

export interface RepoOpenOpenResult {
  ok: true; state: 'cloned' | 'initialized_empty' | 'existing'; folder: string; openFolder: string;
  pathNotFound: boolean; branch: string; empty: boolean;
}
/**
 * An assessment open's 200 body (okOpenAssessment): head null exactly when the branch is unborn (empty);
 * folder = openFolder = the wrapper W, pathNotFound false, remote git-qa's URL of the repository (E1-6).
 */
export interface RepoOpenAssessmentOpenResult extends Omit<RepoOpenOpenResult, 'state'> {
  state: 'cloned' | 'initialized_empty'; head: string | null; clean: boolean; remote: string;
}
export type RepoOpenAnswer =
  | { status: 200; body: RepoOpenOpenResult | RepoOpenAssessmentOpenResult | { ok: true; state: 'refreshed' } }
  | { status: number; body: { ok: false; error: RepoOpenErrorCode } };

/** The refusal body is built from the fixed code itself; no upstream text ever reaches it. */
export const refusal = (code: RepoOpenErrorCode): RepoOpenAnswer => ({ status: REPO_OPEN_STATUS[code], body: { ok: false, error: code } });

export function repoOpenResponse(answer: RepoOpenAnswer): Response {
  return new Response(JSON.stringify(answer.body), {
    status: answer.status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ── body (§8, vectors workerRequest) ────────────────────────────────────────

export interface RepoOpenGrant { username: 'ezil'; token: string; expiresAt: string; scope: 'write' | 'read' }
export interface RepoOpenBody {
  v: 1; op: 'open' | 'refresh'; repositoryId: string; handle: string; name: string; gitHost: string;
  defaultBranch: string; path: string | null; grant: RepoOpenGrant;
  /** 1.0.3 (vectors workerRequest.optionalKeys): absent = personal. */
  class?: RepoOpenClass;
}
export interface RepoOpenInput extends RepoOpenBody { receivedAt: number }

const BODY_KEYS = ['v', 'op', 'repositoryId', 'handle', 'name', 'gitHost', 'defaultBranch', 'path', 'grant'];
const OPTIONAL_BODY_KEYS = ['class'];
const GRANT_KEYS = ['username', 'token', 'expiresAt', 'scope'];
const hasOwn = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
/** Every required key, each own, and nothing outside required + optional. */
const strictKeys = (value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> =>
  isObject(value) && keys.every((k) => hasOwn(value, k))
  && Object.keys(value).every((k) => keys.includes(k) || optional.includes(k));
const str = (value: unknown): value is string => typeof value === 'string';

/**
 * Strict §8 body for a route that serves `routeClass`: required keys exactly, plus at most the
 * optional `class`; every field re-validated; grant expiry in (now, now + 16 min]. The body's class
 * (absent = personal) must BE the route's class, and gitHost must be exactly that class's host
 * (vectors workerRequest.classRule: a closed table, refused in both directions). An assessment body
 * carries path null (E1-6: its editor root is always the wrapper).
 */
export function parseRepoOpenBody(raw: Uint8Array, now: number, routeClass: RepoOpenClass): RepoOpenBody | null {
  if (!isRepoOpenClass(routeClass)) return null;
  if (raw.byteLength > WORKER_REQUEST_MAX_BYTES) return null;
  let b: unknown;
  try { b = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)); } catch { return null; }
  if (!strictKeys(b, BODY_KEYS, OPTIONAL_BODY_KEYS) || !strictKeys(b.grant, GRANT_KEYS)) return null;
  const g = b.grant;
  const bodyClass: unknown = hasOwn(b, 'class') ? b.class : REPO_OPEN_CLASS_DEFAULT;
  const expiresAt = str(g.expiresAt) && ISO_RE.test(g.expiresAt) ? Date.parse(g.expiresAt) : NaN;
  const ok = b.v === 1 && (b.op === 'open' || b.op === 'refresh') && str(b.repositoryId) && UUID_RE.test(b.repositoryId)
    && str(b.handle) && HANDLE_RE.test(b.handle) && str(b.name) && validName(b.name)
    && bodyClass === routeClass && str(b.gitHost) && b.gitHost === REPO_OPEN_CLASS_GIT_HOSTS[routeClass]
    && str(b.defaultBranch) && validBranch(b.defaultBranch)
    && (b.path === null || (routeClass !== 'assessment' && b.op === 'open' && str(b.path) && pathProblem(b.path) === null))
    && g.username === 'ezil' && str(g.token) && GRANT_RE.test(g.token) && (g.scope === 'write' || g.scope === 'read')
    && Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + WORKER_ACCEPT_EXPIRY_MAX_MS;
  return ok ? (b as unknown as RepoOpenBody) : null;
}
