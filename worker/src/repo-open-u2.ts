/**
 * The u2 repo-open protocol (contract universe-repo-open-v1, §8 body and answers, §13): ONLY the
 * symbols the AWS relay (A2r) needs, taken unchanged from the u2 Worker module (2ca90211
 * worker/src/repo-open.ts). INERT: no route is mounted here, and nothing but the AWS relay imports it.
 *
 * Why a separate module: in this tree `./repo-open` is open-project's live module (the assessment
 * routes import it), not the u2 one, so the u2 symbols cannot live under that path. Nothing here is
 * the Cloudflare in-sandbox runner (runFlight, the kernel assets, the DO lock discipline): the AWS host
 * agent runs the kernel (infra/host-agent/lib/ezil_host/repo_open.py).
 */

// ── constants ────────────────────────────────────────────────────────────────

export const REPO_OPEN_GIT_HOSTS: readonly string[] = ['git-preview.ezil.work'];
export const WORKER_DEADLINE_MS = 105_000;
export const WORKER_ACCEPT_EXPIRY_MAX_MS = 960_000;
export const WORKER_REQUEST_MAX_BYTES = 4_096;

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
export const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
export const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,243}$/;
export const GRANT_RE = /^egg_[0-9a-f]{64}$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const validName = (s: string) => NAME_RE.test(s) && !s.includes('..') && !s.endsWith('.git');
const validBranch = (s: string) => BRANCH_RE.test(s) && !s.includes('..') && !s.includes('//') && !s.endsWith('/')
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

export interface RepoOpenOpenResult {
  ok: true; state: 'cloned' | 'initialized_empty' | 'existing'; folder: string; openFolder: string;
  pathNotFound: boolean; branch: string; empty: boolean;
}
export type RepoOpenAnswer =
  | { status: 200; body: RepoOpenOpenResult | { ok: true; state: 'refreshed' } }
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
}
export interface RepoOpenInput extends RepoOpenBody { receivedAt: number }

const BODY_KEYS = ['v', 'op', 'repositoryId', 'handle', 'name', 'gitHost', 'defaultBranch', 'path', 'grant'];
const GRANT_KEYS = ['username', 'token', 'expiresAt', 'scope'];
const exactKeys = (value: unknown, keys: readonly string[]): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length
  && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
const str = (value: unknown): value is string => typeof value === 'string';

/** Strict §8 body: exact keys, every field re-validated, grant expiry in (now, now + 16 min]. */
export function parseRepoOpenBody(raw: Uint8Array, now: number): RepoOpenBody | null {
  if (raw.byteLength > WORKER_REQUEST_MAX_BYTES) return null;
  let b: unknown;
  try { b = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(raw)); } catch { return null; }
  if (!exactKeys(b, BODY_KEYS) || !exactKeys(b.grant, GRANT_KEYS)) return null;
  const g = b.grant;
  const expiresAt = str(g.expiresAt) && ISO_RE.test(g.expiresAt) ? Date.parse(g.expiresAt) : NaN;
  const ok = b.v === 1 && (b.op === 'open' || b.op === 'refresh') && str(b.repositoryId) && UUID_RE.test(b.repositoryId)
    && str(b.handle) && HANDLE_RE.test(b.handle) && str(b.name) && validName(b.name)
    && str(b.gitHost) && REPO_OPEN_GIT_HOSTS.includes(b.gitHost) && str(b.defaultBranch) && validBranch(b.defaultBranch)
    && (b.path === null || (b.op === 'open' && str(b.path) && pathProblem(b.path) === null))
    && g.username === 'ezil' && str(g.token) && GRANT_RE.test(g.token) && (g.scope === 'write' || g.scope === 'read')
    && Number.isFinite(expiresAt) && expiresAt > now && expiresAt <= now + WORKER_ACCEPT_EXPIRY_MAX_MS;
  return ok ? (b as unknown as RepoOpenBody) : null;
}
