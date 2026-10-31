/**
 * `POST /sandbox/:name/repo-open` — put one EZiL Git repository into a RUNNING
 * Cloudflare computer, at `<workspace root>/projects/<repositoryId>`, so the
 * Code window can open it (`folder=` on the code-server URL).
 *
 * Pure (runtime-free) helpers, factored out of `index.ts` like `./twen` and
 * `./workspace-diag` so the contract runs under plain `bun test`. The route and
 * the Durable Object method that wire them are in `index.ts`
 * (`handleRepoOpen`, `EzilSandboxDO.repoOpen`).
 *
 * Wire contract (the OS server is the only caller):
 *
 *   POST /sandbox/<name>/repo-open        signed v2 (`x-ezil-auth`), no query
 *   { repositoryId: <lowercase uuid>,
 *     canonicalURL: "https://github.ezil.work/<owner>/<name>.git",
 *     ref: "refs/heads/<branch>",
 *     git: { token: "egg_<64 hex>", expiresAt: <ISO datetime> } }
 *   200 { ok: true, folder: "<root>/projects/<repositoryId>", head: <commit>, status: 'cloned' | 'fetched' }
 *   4xx/5xx { ok: false, error: <one of REPO_OPEN_ERRORS, or an auth code> }
 *
 * The values are Works' `ProjectRepoBinding` and its read grant, passed through
 * (`packages/contracts/src/surface/project-repo.ts` in EZiL-Works: the same URL,
 * ref and token shapes are enforced here). `git.username` ('ezil') and
 * `git.scope` ('read') may ride along unchanged; nothing else may.
 *
 * 🔴 THE TOKEN. It reaches git only through a one-shot credential helper that
 * reads it from the environment of the git process:
 *   - the Sandbox SDK's per-command `env` (exported in the session shell for
 *     this command only, then restored — never part of the command string,
 *     which the SDK logs);
 *   - the script moves it into a shell variable, unsets the exported name, and
 *     hands it back only to `git` itself (`NAME=$tok git …`), never as an
 *     argument;
 *   - the helper is configured through `GIT_CONFIG_COUNT` (command scope, not
 *     written anywhere), after an empty `credential.helper` that drops any
 *     helper the computer's own config names (a `store` helper would write the
 *     token to `~/.git-credentials`); system and global config are not read.
 * So it never appears in argv, a URL, `.git/config`, the response, or the
 * Worker's logs. The clone's `remote.origin.url` is the canonical URL, with no
 * userinfo. `repo-open.git.test.ts` proves each of these against real git.
 *
 * An existing folder with the same origin is fetched only: the working tree,
 * the index and HEAD are not touched, so uncommitted work stays. Any other
 * existing folder is refused, never replaced. A clone lands in a private
 * directory under `/tmp` and is moved into place whole, so a failed clone never
 * leaves a half-folder that a later open would mistake for a repository.
 *
 * Nothing git prints leaves the container: the script classifies git's stderr
 * into one of the codes below and prints a single result line.
 */

/** Largest request body the route reads (the contract body is well under 1 KiB). */
export const REPO_OPEN_MAX_BODY_BYTES = 8 * 1024;
/** The environment variable that carries the token into the container for this one command. */
export const REPO_OPEN_TOKEN_ENV = 'EZIL_REPO_OPEN_TOKEN';
/** Works issues every read grant to this user name (`ProjectRepoRedeemResponse.git.username`). */
export const REPO_OPEN_GIT_USERNAME = 'ezil';
/** Each git network step is bounded inside the container; the exec bound sits above it. */
export const REPO_OPEN_GIT_TIMEOUT_S = 120;
export const REPO_OPEN_EXEC_TIMEOUT_MS = 150_000;
/** A grant with less left than this is refused before git is started. */
export const REPO_OPEN_MIN_TOKEN_LIFETIME_MS = 5_000;
/**
 * code-server's root when no workspace store is configured (`start-neko.sh`'s
 * `WORKSPACE_ROOT` default) — the root Code opens when `/sandbox/preview` sends
 * no `folder=`.
 */
export const REPO_OPEN_UNMOUNTED_ROOT = '/home/neko/project';

/** Every code this route can answer with besides the shared auth codes. Each is in `PUBLIC_ERROR_CODES`. */
export const REPO_OPEN_ERRORS = [
  'repo_open_auth_failed',
  'repo_open_busy',
  'repo_open_failed',
  'repo_open_folder_conflict',
  'repo_open_git_failed',
  'repo_open_git_missing',
  'repo_open_invalid_request',
  'repo_open_not_found',
  'repo_open_ref_not_found',
  'repo_open_timeout',
  'repo_open_token_expired',
  'repo_open_unreachable',
  'repo_open_unsupported_provider',
  'repo_open_workspace_not_ready',
  'repo_open_workspace_unavailable',
] as const;
export type RepoOpenError = (typeof REPO_OPEN_ERRORS)[number];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Works' `ProjectRepoBinding.canonicalURL`, verbatim. */
const CANONICAL_URL = /^https:\/\/github\.ezil\.work\/[a-z0-9-]+\/[a-z0-9._-]+\.git$/;
/** Works' `ProjectRepoBinding.ref` pattern; its refinements are applied in `branchOf`. */
const REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/;
/** Works' git grant (`GIT_GRANT_PATTERN`): only hex after the prefix, so it can never break a credential line. */
const GIT_TOKEN = /^egg_[0-9a-f]{64}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export interface RepoOpenRequest {
  repositoryId: string;
  canonicalURL: string;
  ref: string;
  /** `ref` without `refs/heads/`, for `git clone --branch`. */
  branch: string;
  token: string;
  expiresAt: string;
}

/** Where repositories go, as `handleRepoOpen` resolved it from the Worker's workspace settings. */
export interface RepoOpenRoot {
  path: string;
  /**
   * The root is a store-backed workspace: refuse until this container holds it
   * hydrated (its `.ezil-hydrated.json`), so a repository is never written into
   * a workspace a later restore would replace.
   */
  requireHydrated: boolean;
}

export type RepoOpenAnswer =
  | { ok: true; folder: string; head: string; status: 'cloned' | 'fetched' }
  | { ok: false; error: RepoOpenError | 'runtime_not_running' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The branch name inside a Works ref, or null for any ref Works itself would refuse (or that git could read as an option). */
export function branchOf(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length > 255 || !REF.test(ref)) return null;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/')) return null;
  const branch = ref.slice('refs/heads/'.length);
  for (const part of branch.split('/')) {
    if (part.startsWith('.') || part.startsWith('-') || part.endsWith('.') || part.endsWith('.lock')) return null;
  }
  return branch;
}

/**
 * Validate the request body. Strict: unknown keys are refused, ids must be
 * lowercase canonical UUIDs, and an expired (or nearly expired) grant is its
 * own answer so the caller can mint a fresh one.
 */
export function parseRepoOpenRequest(
  body: unknown,
  now: number = Date.now(),
): { ok: true; request: RepoOpenRequest } | { ok: false; error: 'repo_open_invalid_request' | 'repo_open_token_expired' } {
  const invalid = { ok: false as const, error: 'repo_open_invalid_request' as const };
  if (!isPlainObject(body)) return invalid;
  if (Object.keys(body).sort().join(',') !== 'canonicalURL,git,ref,repositoryId') return invalid;
  const { repositoryId, canonicalURL, ref, git } = body;
  if (typeof repositoryId !== 'string' || !UUID.test(repositoryId)) return invalid;
  if (typeof canonicalURL !== 'string' || !CANONICAL_URL.test(canonicalURL) || canonicalURL.includes('..')) return invalid;
  const branch = branchOf(ref);
  if (branch === null) return invalid;
  if (!isPlainObject(git)) return invalid;
  for (const key of Object.keys(git)) {
    if (!['token', 'expiresAt', 'username', 'scope'].includes(key)) return invalid;
  }
  if ('username' in git && git.username !== REPO_OPEN_GIT_USERNAME) return invalid;
  if ('scope' in git && git.scope !== 'read') return invalid;
  const { token, expiresAt } = git;
  if (typeof token !== 'string' || !GIT_TOKEN.test(token)) return invalid;
  if (typeof expiresAt !== 'string' || !ISO_DATETIME.test(expiresAt)) return invalid;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return invalid;
  if (expiry - now < REPO_OPEN_MIN_TOKEN_LIFETIME_MS) return { ok: false, error: 'repo_open_token_expired' };
  return { ok: true, request: { repositoryId, canonicalURL, ref: ref as string, branch, token, expiresAt } };
}

/** HTTP status for each answer. Upstream (git server) failures are 502s: the caller's own request was fine. */
export function repoOpenStatus(error: RepoOpenError | 'runtime_not_running'): number {
  switch (error) {
    case 'repo_open_invalid_request':
    case 'repo_open_token_expired':
      return 400;
    case 'repo_open_unsupported_provider':
    case 'repo_open_workspace_unavailable':
    case 'repo_open_workspace_not_ready':
    case 'repo_open_folder_conflict':
    case 'repo_open_busy':
    case 'repo_open_ref_not_found':
    case 'runtime_not_running':
      return 409;
    case 'repo_open_timeout':
      return 504;
    case 'repo_open_git_missing':
      return 500;
    default:
      return 502;
  }
}

/** POSIX single-quote a value for a bash command line. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The container-side script. Positional arguments: root, repositoryId, URL,
 * branch, require-hydrated (1|0). The token arrives only as
 * `$EZIL_REPO_OPEN_TOKEN`. Always exits 0 after printing exactly one
 * `ezil-repo-open:` line; git's own output is classified, never printed.
 *
 * This is a template literal: each `${…}` below is a TypeScript constant; the
 * shell's own expansions are all the brace-free `$name` form.
 */
export const REPO_OPEN_SCRIPT = String.raw`
emit() { printf 'ezil-repo-open:%s\n' "$1"; exit 0; }
fail() { emit "error:$1"; }
root=$1; id=$2; url=$3; branch=$4; hydrated=$5; limit=${REPO_OPEN_GIT_TIMEOUT_S}
tok=$EZIL_REPO_OPEN_TOKEN
unset EZIL_REPO_OPEN_TOKEN
[ -n "$tok" ] || fail repo_open_invalid_request
command -v git >/dev/null 2>&1 && command -v flock >/dev/null 2>&1 || fail repo_open_git_missing
# The only git configuration in force is this: no system or global config, no
# inherited command-line config, no hooks, https only, verified TLS, and a
# credential list emptied before the one helper that answers from the env.
unset $(git rev-parse --local-env-vars 2>/dev/null) GIT_CONFIG_PARAMETERS GIT_ASKPASS SSH_ASKPASS \
  GIT_SSL_NO_VERIFY GIT_TRACE_CURL GIT_CURL_VERBOSE GIT_TRACE_REDACT GIT_EXEC_PATH GIT_TEMPLATE_DIR
export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=https GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_COUNT=5
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=credential.helper
export GIT_CONFIG_VALUE_1='!f() { test "$1" = get || return 0; printf "username=${REPO_OPEN_GIT_USERNAME}\npassword=%s\n" "$EZIL_REPO_OPEN_TOKEN"; }; f'
export GIT_CONFIG_KEY_2=core.hooksPath GIT_CONFIG_VALUE_2=/dev/null
export GIT_CONFIG_KEY_3=core.fsmonitor GIT_CONFIG_VALUE_3=false
export GIT_CONFIG_KEY_4=http.sslVerify GIT_CONFIG_VALUE_4=true
classify() {
  case "$1" in 124|137) echo repo_open_timeout; return ;; esac
  if grep -qiE 'authentication failed|could not read (username|password)|terminal prompts disabled|error: 40[13]' "$2"; then
    echo repo_open_auth_failed
  elif grep -qiE "remote branch .* not found|couldn't find remote ref|not found in upstream" "$2"; then
    echo repo_open_ref_not_found
  elif grep -qiE 'repository .* not found|error: 404' "$2"; then
    echo repo_open_not_found
  elif grep -qiE 'could not resolve|failed to connect|connection (refused|reset|timed out)|ssl|tls|certificate' "$2"; then
    echo repo_open_unreachable
  else
    echo repo_open_git_failed
  fi
}
case "$root" in /*) ;; *) fail repo_open_workspace_unavailable ;; esac
[ -d "$root" ] || fail repo_open_workspace_unavailable
if [ "$hydrated" = 1 ] && [ ! -f "$root/.ezil-hydrated.json" ]; then fail repo_open_workspace_not_ready; fi
parent=$root/projects
folder=$parent/$id
if [ -L "$parent" ] || { [ -e "$parent" ] && [ ! -d "$parent" ]; }; then fail repo_open_folder_conflict; fi
mkdir -p "$parent" 2>/dev/null || fail repo_open_workspace_unavailable
work=$(mktemp -d /tmp/ezil-repo-open.XXXXXX) || fail repo_open_git_failed
trap 'rm -rf "$work"' EXIT
exec 9>"/tmp/ezil-repo-open-$id.lock" || fail repo_open_busy
flock -w 60 9 || fail repo_open_busy
[ -L "$folder" ] && fail repo_open_folder_conflict
if [ -d "$folder" ] && [ -z "$(ls -A "$folder" 2>/dev/null)" ]; then rmdir "$folder" 2>/dev/null || fail repo_open_folder_conflict; fi
if [ -e "$folder" ]; then
  # Ours from an earlier open, or nothing we will touch. Fetch only: the
  # working tree, the index and HEAD stay as the person left them.
  { [ -d "$folder/.git" ] && [ ! -L "$folder/.git" ]; } || fail repo_open_folder_conflict
  [ "$(git -C "$folder" rev-parse --git-dir 2>/dev/null)" = .git ] || fail repo_open_folder_conflict
  [ "$(git -C "$folder" config --local --get remote.origin.url 2>/dev/null)" = "$url" ] || fail repo_open_folder_conflict
  # A repository-local url.*.insteadOf could send the credential elsewhere.
  if git -C "$folder" config --local --name-only --get-regexp '^url\.' >/dev/null 2>&1; then fail repo_open_folder_conflict; fi
  EZIL_REPO_OPEN_TOKEN=$tok timeout -k 5 "$limit" git -C "$folder" fetch --quiet --no-recurse-submodules origin 2>"$work/err" \
    || { rc=$?; fail "$(classify "$rc" "$work/err")"; }
  head=$(git -C "$folder" rev-parse --verify --quiet HEAD) || fail repo_open_ref_not_found
  emit "ok:fetched:$head"
fi
EZIL_REPO_OPEN_TOKEN=$tok timeout -k 5 "$limit" git clone --quiet --branch "$branch" --origin origin -- "$url" "$work/clone" 2>"$work/err" \
  || { rc=$?; fail "$(classify "$rc" "$work/err")"; }
head=$(git -C "$work/clone" rev-parse --verify --quiet HEAD) || fail repo_open_ref_not_found
mv -T "$work/clone" "$folder" 2>/dev/null || fail repo_open_git_failed
emit "ok:cloned:$head"
`;

/**
 * The exec command for one open. Takes the URL as given: validation is
 * `parseRepoOpenRequest`'s job (the real-git test points this at a local
 * server). The token is NOT a parameter, by construction.
 */
export function repoOpenCommand(params: {
  root: string;
  repositoryId: string;
  url: string;
  branch: string;
  requireHydrated: boolean;
}): string {
  return ['bash', '-c', shq(REPO_OPEN_SCRIPT), 'ezil-repo-open', shq(params.root), shq(params.repositoryId),
    shq(params.url), shq(params.branch), params.requireHydrated ? '1' : '0'].join(' ');
}

/** The script's result line (the last `ezil-repo-open:` line), or null when there is none or it is malformed. */
export function parseRepoOpenOutput(
  stdout: string,
): { ok: true; status: 'cloned' | 'fetched'; head: string } | { ok: false; error: RepoOpenError } | null {
  const line = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ezil-repo-open:')).pop();
  if (!line) return null;
  const ok = /^ezil-repo-open:ok:(cloned|fetched):([0-9a-f]+)$/.exec(line);
  if (ok) return HEAD.test(ok[2]!) ? { ok: true, status: ok[1] as 'cloned' | 'fetched', head: ok[2]! } : null;
  const error = /^ezil-repo-open:error:([a-z_]+)$/.exec(line)?.[1];
  return error && (REPO_OPEN_ERRORS as readonly string[]).includes(error) ? { ok: false, error: error as RepoOpenError } : null;
}

export type RepoOpenExec = (
  command: string,
  options: { env: Record<string, string>; timeout: number; origin: 'internal' },
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

/**
 * Run one open on a computer known to be running. Only `stdout`'s result line
 * is read; `stderr` is never read, logged or returned.
 */
export async function runRepoOpen(exec: RepoOpenExec, request: RepoOpenRequest, root: RepoOpenRoot): Promise<RepoOpenAnswer> {
  const command = repoOpenCommand({
    root: root.path, repositoryId: request.repositoryId, url: request.canonicalURL,
    branch: request.branch, requireHydrated: root.requireHydrated,
  });
  let stdout: string;
  try {
    const result = await exec(command, {
      env: { [REPO_OPEN_TOKEN_ENV]: request.token }, timeout: REPO_OPEN_EXEC_TIMEOUT_MS, origin: 'internal',
    });
    stdout = result.exitCode === 0 ? result.stdout ?? '' : '';
  } catch {
    return { ok: false, error: 'repo_open_failed' };
  }
  // Belt and braces: the script never prints the token, and nothing that
  // contains it is ever parsed.
  if (stdout.includes(request.token)) return { ok: false, error: 'repo_open_failed' };
  const parsed = parseRepoOpenOutput(stdout);
  if (!parsed) return { ok: false, error: 'repo_open_failed' };
  if (!parsed.ok) return parsed;
  return { ok: true, folder: `${root.path}/projects/${request.repositoryId}`, head: parsed.head, status: parsed.status };
}

/**
 * The Durable Object's half: refuse a stopped computer (an exec would
 * cold-start it), then open. `running` is the object's own check, made under
 * its runtime lock like `runningContainerFetch`'s.
 */
export async function repoOpenWhenRunning(deps: {
  running: () => Promise<boolean>;
  touch: () => void;
  exec: RepoOpenExec;
}, request: RepoOpenRequest, root: RepoOpenRoot): Promise<RepoOpenAnswer> {
  if (!(await deps.running())) return { ok: false, error: 'runtime_not_running' };
  deps.touch();
  return runRepoOpen(deps.exec, request, root);
}
