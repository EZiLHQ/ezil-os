/**
 * `POST /sandbox/:name/repo-open` — put one project repository into a RUNNING
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
 *     canonicalURL: "https://<32 hex>.artifacts.cloudflare.net/git/<namespace>/<name>.git"
 *                 | "https://github.ezil.work/<owner>/<name>.git",
 *     ref: "refs/heads/<branch>",
 *     git: { token: <opaque, visible ASCII, ≤ 4096>, expiresAt: <ISO datetime> },
 *     timeoutMs?: <integer, REPO_OPEN_MIN_TIMEOUT_MS..REPO_OPEN_EXEC_TIMEOUT_MS> }
 *   200 { ok: true, folder: "<root>/projects/<repositoryId>", head?: <commit>, status: 'cloned' | 'fetched' | 'created' }
 *   4xx/5xx { ok: false, error: <one of REPO_OPEN_ERRORS, or an auth code> }
 *
 * The values are Universe's project repository binding and its Git grant,
 * passed through (`ProjectRepositories::open()` in universe-2.0: the same URL,
 * ref and token rules are enforced here). `git.username` ('ezil') and
 * `git.scope` ('read' | 'write') may ride along unchanged; nothing else may.
 * `timeoutMs` is what is left of the OS server's own deadline: every bound
 * inside the computer (lock wait, git, the exec itself) is derived from it, so
 * the Worker never keeps cloning after the caller has given up.
 *
 * 🔴 THE TOKEN never meets the person's repository. The person (and anything
 * running on their computer, as root) can write the clone's `.git/config`:
 * a second `remote.origin.url`, an `include.path` naming a
 * `url.<x>.insteadOf`, an `http.<url>.proxy`. A git command that carries the
 * token and reads that config can be sent anywhere, so none does:
 *   1. the ONE network command fetches into a fresh bare repository under the
 *      script's private `/tmp` directory (`git init --bare --template=`: no
 *      hooks, no config but git's own), from the canonical URL given
 *      explicitly (never a remote name), with system and global config off,
 *      `HOME` an empty private directory, no prompt and no askpass, every
 *      inherited credential helper and extra header cleared, redirects not
 *      followed, https the only protocol, and the credential scoped to that
 *      remote (`http.<canonicalURL>.extraHeader`, as EZiL Works' runner sends
 *      it, or `credential.https://<host>.helper`);
 *   2. the person's folder is then updated (or created) from that private
 *      repository by a LOCAL fetch or clone whose environment holds no token,
 *      and the private repository is deleted.
 * The token is sent the way the server behind the URL expects it:
 *   - Cloudflare Artifacts: `Authorization: Bearer <token>`, exactly what EZiL
 *     Git's own gateway sends upstream (EZiL CLI `apps/git-gateway`). The
 *     computer's git (2.34) cannot take a Bearer token from a credential
 *     helper, so it is an extra header given to the network command through
 *     `GIT_CONFIG_VALUE_<n>` in that command's environment;
 *   - github.ezil.work (the gateway): HTTP Basic `ezil:<token>`, from a
 *     one-shot credential helper that reads it from the git process's env.
 * Either way:
 *   - it arrives through the Sandbox SDK's per-command `env` (exported in the
 *     session shell for this command only, then restored — never part of the
 *     command string, which the SDK logs);
 *   - the script moves it into a shell variable, unsets the exported name, and
 *     hands it back only to the network `git` itself, as an environment prefix
 *     (`NAME=… git …`), never as an argument;
 *   - git is configured through `GIT_CONFIG_COUNT` (command scope, not written
 *     anywhere), so a `store` helper or a header can never be written to a file.
 * So it never appears in argv, a URL, any `.git/config`, the response, or the
 * Worker's logs. The clone's `remote.origin.url` is the canonical URL, with no
 * userinfo. `repo-open.git.test.ts` proves each of these against real git, in
 * both schemes, including a clone whose config tries to redirect the fetch.
 *
 * An existing folder with the same origin is fetched only: the working tree,
 * the index and HEAD are not touched, so uncommitted work stays. The one
 * exception is a clone that is still empty (its branch unborn, from an open of
 * an empty repository): once the branch exists upstream it is checked out,
 * unless that would overwrite a file. Any other existing folder is refused,
 * never replaced. A clone lands in the private directory and is moved into
 * place whole, so a failed clone never leaves a half-folder that a later open
 * would mistake for a repository.
 *
 * A repository with no commits yet (a new Cloudflare Artifacts repository), or
 * without the binding's branch yet, opens as an empty clone: `origin` the
 * canonical URL, HEAD on the binding's branch (unborn) with its upstream set,
 * any other branches as remote-tracking refs, `status: 'created'`, no `head`.
 *
 * Nothing git prints leaves the container: the script classifies git's stderr
 * into one of the codes below and prints a single result line.
 */

/** Largest request body the route reads (the contract body is well under 1 KiB). */
export const REPO_OPEN_MAX_BODY_BYTES = 8 * 1024;
/** The environment variable that carries the token into the container for this one command. */
export const REPO_OPEN_TOKEN_ENV = 'EZIL_REPO_OPEN_TOKEN';
/** Universe (and EZiL Git) issue every Git grant to this user name (`ProjectRepositories::GIT_USERNAME`). */
export const REPO_OPEN_GIT_USERNAME = 'ezil';
/**
 * The longest one open may take, and the default when the caller sends no
 * `timeoutMs`. Every bound inside the container is derived from the exec
 * bound (`repoOpenBounds`): at this maximum, 30 s waiting for another open of
 * the same repository, then 90 s of git plus its 5 s kill grace, with 5 s to
 * spare, so the Worker never answers while the script is still working.
 */
export const REPO_OPEN_EXEC_TIMEOUT_MS = 130_000;
/** The shortest `timeoutMs` the Worker will start git under. */
export const REPO_OPEN_MIN_TIMEOUT_MS = 20_000;
export const REPO_OPEN_MAX_LOCK_WAIT_S = 30;
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
/**
 * `<namespace>/<name>.git`: EZiL Git's route rules (`ROUTE_NAMESPACE_PATTERN`,
 * `ROUTE_NAME_PATTERN`), which also cover Universe's `p-<uuid>` names, with no
 * `..` anywhere in the name. The same text is in the OS server's
 * `app/src/server/works/project-repo.ts` and `git-smart-http.ts`.
 */
const REPOSITORY_PATH = String.raw`[a-z0-9][a-z0-9-]{0,63}\/(?![a-z0-9._-]*\.\.)[a-z0-9][a-z0-9._-]{0,99}\.git`;
/** Cloudflare Artifacts' Git remote, exactly as Universe builds it (`ArtifactsClient::remoteFor`): Bearer auth. */
export const ARTIFACTS_REPOSITORY_URL = new RegExp(String.raw`^https:\/\/[0-9a-f]{32}\.artifacts\.cloudflare\.net\/git\/${REPOSITORY_PATH}$`);
/** EZiL Git's gateway (`github.ezil.work`): Basic auth with an `egg_` grant. */
export const EZIL_GIT_REPOSITORY_URL = new RegExp(String.raw`^https:\/\/github\.ezil\.work\/${REPOSITORY_PATH}$`);
/** The binding's `ref` pattern; its refinements are applied in `branchOf`. */
const REF = /^refs\/heads\/[A-Za-z0-9._/-]+$/;
/**
 * An opaque Git token: visible ASCII only (no space, no control byte), so it
 * can break neither an HTTP header nor a credential-helper line.
 */
const GIT_TOKEN = /^[\x21-\x7e]{1,4096}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** How git presents the token: Bearer to Cloudflare Artifacts, Basic `ezil:<token>` to EZiL Git's gateway. */
export type RepoOpenAuth = 'bearer' | 'basic';

export interface RepoOpenRequest {
  repositoryId: string;
  canonicalURL: string;
  ref: string;
  /** `ref` without `refs/heads/`, for `git clone --branch`. */
  branch: string;
  token: string;
  expiresAt: string;
  /** Chosen from the URL's host by `parseRepoOpenRequest`, never by the caller. */
  auth: RepoOpenAuth;
  /** The whole open's bound, ms: the caller's `timeoutMs`, or `REPO_OPEN_EXEC_TIMEOUT_MS`. */
  timeoutMs: number;
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

/**
 * `cloned` and `fetched` name the folder's HEAD; `created` (an empty clone of a
 * repository with no commits on the binding's branch yet) has none, nor has
 * `fetched` while that clone is still empty.
 */
export type RepoOpenStatus = 'cloned' | 'fetched' | 'created';

export type RepoOpenAnswer =
  | { ok: true; folder: string; head?: string; status: RepoOpenStatus }
  | { ok: false; error: RepoOpenError | 'runtime_not_running' };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The branch name inside a binding's ref, or null for any ref Universe itself would refuse (or that git could read as an option). */
export function branchOf(ref: unknown): string | null {
  if (typeof ref !== 'string' || ref.length > 255 || !REF.test(ref)) return null;
  if (ref.includes('..') || ref.includes('//') || ref.endsWith('/')) return null;
  const branch = ref.slice('refs/heads/'.length);
  for (const part of branch.split('/')) {
    if (part.startsWith('.') || part.startsWith('-') || part.endsWith('.') || part.endsWith('.lock')) return null;
  }
  return branch;
}

/** The auth scheme for a canonical URL, or null for any URL that is not one of the two remotes. */
export function repoOpenAuthFor(url: unknown): RepoOpenAuth | null {
  if (typeof url !== 'string') return null;
  if (ARTIFACTS_REPOSITORY_URL.test(url)) return 'bearer';
  if (EZIL_GIT_REPOSITORY_URL.test(url)) return 'basic';
  return null;
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
  const keys = Object.keys(body).filter((k) => k !== 'timeoutMs').sort().join(',');
  if (keys !== 'canonicalURL,git,ref,repositoryId') return invalid;
  const { repositoryId, canonicalURL, ref, git } = body;
  if (typeof repositoryId !== 'string' || !UUID.test(repositoryId)) return invalid;
  const auth = repoOpenAuthFor(canonicalURL);
  if (auth === null) return invalid;
  const branch = branchOf(ref);
  if (branch === null) return invalid;
  let timeoutMs = REPO_OPEN_EXEC_TIMEOUT_MS;
  if ('timeoutMs' in body) {
    const t = body.timeoutMs;
    if (typeof t !== 'number' || !Number.isInteger(t) || t < REPO_OPEN_MIN_TIMEOUT_MS || t > REPO_OPEN_EXEC_TIMEOUT_MS) return invalid;
    timeoutMs = t;
  }
  if (!isPlainObject(git)) return invalid;
  for (const key of Object.keys(git)) {
    if (!['token', 'expiresAt', 'username', 'scope'].includes(key)) return invalid;
  }
  if ('username' in git && git.username !== REPO_OPEN_GIT_USERNAME) return invalid;
  if ('scope' in git && git.scope !== 'read' && git.scope !== 'write') return invalid;
  const { token, expiresAt } = git;
  if (typeof token !== 'string' || !GIT_TOKEN.test(token)) return invalid;
  if (typeof expiresAt !== 'string' || !ISO_DATETIME.test(expiresAt)) return invalid;
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return invalid;
  if (expiry - now < REPO_OPEN_MIN_TOKEN_LIFETIME_MS) return { ok: false, error: 'repo_open_token_expired' };
  return {
    ok: true,
    request: { repositoryId, canonicalURL: canonicalURL as string, ref: ref as string, branch, token, expiresAt, auth, timeoutMs },
  };
}

/**
 * The script's bounds for an open that must be over within `timeoutMs`: the
 * lock wait and the git limit (seconds), leaving 5 s for git's kill grace and
 * 5 s for everything else (rev-parse, the move, the exec's own round trip).
 * The git limit is one deadline shared by every bounded git command (the
 * network fetch, then the local fetch or clone), not a limit per command.
 */
export function repoOpenBounds(timeoutMs: number): { lockWaitS: number; gitTimeoutS: number } {
  const total = Math.floor(Math.min(Math.max(timeoutMs, REPO_OPEN_MIN_TIMEOUT_MS), REPO_OPEN_EXEC_TIMEOUT_MS) / 1000) - 10;
  const lockWaitS = Math.min(REPO_OPEN_MAX_LOCK_WAIT_S, Math.max(1, Math.floor(total / 4)));
  return { lockWaitS, gitTimeoutS: total - lockWaitS };
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
 * branch, require-hydrated (1|0), auth (bearer|basic), lock wait (s), git
 * limit (s). The token arrives only as `$EZIL_REPO_OPEN_TOKEN`. Always exits 0
 * after printing exactly one `ezil-repo-open:` line; git's own output is
 * classified, never printed.
 *
 * This is a template literal: each `${…}` below is a TypeScript constant; the
 * shell's own expansions are all the brace-free `$name` form.
 */
export const REPO_OPEN_SCRIPT = String.raw`
emit() { printf 'ezil-repo-open:%s\n' "$1"; exit 0; }
fail() { emit "error:$1"; }
root=$1; id=$2; url=$3; branch=$4; hydrated=$5; auth=$6; lockwait=$7; limit=$8
tok=$EZIL_REPO_OPEN_TOKEN
unset EZIL_REPO_OPEN_TOKEN
[ -n "$tok" ] || fail repo_open_invalid_request
case "$auth" in bearer|basic) ;; *) fail repo_open_invalid_request ;; esac
case "$lockwait" in ''|*[!0-9]*) fail repo_open_invalid_request ;; esac
case "$limit" in ''|*[!0-9]*) fail repo_open_invalid_request ;; esac
case "$url" in https://?*/*) ;; *) fail repo_open_invalid_request ;; esac
command -v git >/dev/null 2>&1 && command -v flock >/dev/null 2>&1 || fail repo_open_git_missing
# Every git below reads no system or global config and no inherited
# command-line config, runs no hook, no fsmonitor and no askpass, prompts for
# nothing, uses no credential helper or extra header from anywhere, and speaks
# only the local "file" protocol: to the private repository, by path. Values in
# GIT_CONFIG_COUNT outrank a repository's own .git/config. net() alone adds
# https and the credential.
unset $(git rev-parse --local-env-vars 2>/dev/null) GIT_CONFIG_PARAMETERS GIT_ASKPASS SSH_ASKPASS \
  GIT_SSL_NO_VERIFY GIT_TRACE_CURL GIT_CURL_VERBOSE GIT_TRACE_REDACT GIT_EXEC_PATH GIT_TEMPLATE_DIR XDG_CONFIG_HOME
export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=file GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_COUNT=6
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=http.extraHeader GIT_CONFIG_VALUE_1=
export GIT_CONFIG_KEY_2=core.hooksPath GIT_CONFIG_VALUE_2=/dev/null
export GIT_CONFIG_KEY_3=core.fsmonitor GIT_CONFIG_VALUE_3=false
export GIT_CONFIG_KEY_4=core.askPass GIT_CONFIG_VALUE_4=
export GIT_CONFIG_KEY_5=protocol.allow GIT_CONFIG_VALUE_5=never
# One deadline for every bounded git command (set once the lock is held).
bounded() {
  s=$((deadline - $(date +%s)))
  [ "$s" -ge 1 ] || return 124
  timeout -k 5 "$s" "$@"
}
# 🔴 The ONLY command that carries the credential: one fetch of every branch
# and tag of the canonical URL, named explicitly, into the private bare
# repository ($mirror), run from the private directory with HOME an empty
# private directory. It never reads the person's repository or its config,
# so nothing there can send it elsewhere. The credential is scoped to that
# URL (Bearer) or its host (Basic) and goes only into this command's
# environment.
net() {
  (
    cd "$work" || exit 1
    export HOME="$work/home" GIT_ALLOW_PROTOCOL=https GIT_CONFIG_COUNT=10 \
      GIT_CONFIG_KEY_6=protocol.https.allow GIT_CONFIG_VALUE_6=always \
      GIT_CONFIG_KEY_7=http.followRedirects GIT_CONFIG_VALUE_7=false \
      GIT_CONFIG_KEY_8=http.sslVerify GIT_CONFIG_VALUE_8=true
    s=$((deadline - $(date +%s)))
    [ "$s" -ge 1 ] || exit 124
    set -- git --git-dir="$mirror" fetch --quiet --no-tags --no-recurse-submodules --no-write-fetch-head -- \
      "$url" '+refs/heads/*:refs/heads/*' '+refs/tags/*:refs/tags/*'
    if [ "$auth" = bearer ]; then
      export GIT_CONFIG_KEY_9="http.$url.extraHeader"
      GIT_CONFIG_VALUE_9="Authorization: Bearer $tok" timeout -k 5 "$s" "$@"
    else
      export GIT_CONFIG_KEY_9="credential.https://$host.helper"
      export GIT_CONFIG_VALUE_9='!f() { test "$1" = get || return 0; printf "username=${REPO_OPEN_GIT_USERNAME}\npassword=%s\n" "$EZIL_REPO_OPEN_TOKEN"; }; f'
      EZIL_REPO_OPEN_TOKEN=$tok timeout -k 5 "$s" "$@"
    fi
  )
}
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
mirror=$work/mirror
host=$(printf '%s' "$url" | cut -d/ -f3)
exec 9>"/tmp/ezil-repo-open-$id.lock" || fail repo_open_busy
flock -w "$lockwait" 9 || fail repo_open_busy
deadline=$(($(date +%s) + limit))
[ -L "$folder" ] && fail repo_open_folder_conflict
if [ -d "$folder" ] && [ -z "$(ls -A "$folder" 2>/dev/null)" ]; then rmdir "$folder" 2>/dev/null || fail repo_open_folder_conflict; fi
if [ -e "$folder" ]; then
  # Ours from an earlier open, or nothing we will touch. These checks are
  # about identity, not the credential: no command with the credential ever
  # reads this repository.
  { [ -d "$folder/.git" ] && [ ! -L "$folder/.git" ]; } || fail repo_open_folder_conflict
  [ "$(git -C "$folder" rev-parse --git-dir 2>/dev/null)" = .git ] || fail repo_open_folder_conflict
  [ "$(git -C "$folder" config --local --get remote.origin.url 2>/dev/null)" = "$url" ] || fail repo_open_folder_conflict
fi
{ mkdir "$work/home" && git init --quiet --bare --template= "$mirror" && git --git-dir="$mirror" symbolic-ref HEAD "refs/heads/$branch"; } \
  >/dev/null 2>&1 || fail repo_open_git_failed
net 2>"$work/err" || { rc=$?; fail "$(classify "$rc" "$work/err")"; }
if [ -e "$folder" ]; then
  # Fetch only, from the private repository and with no credential in the
  # environment: the working tree, the index and HEAD stay as the person left them.
  bounded git -C "$folder" fetch --quiet --no-recurse-submodules "$mirror" '+refs/heads/*:refs/remotes/origin/*' 2>"$work/err" \
    || { rc=$?; fail "$(classify "$rc" "$work/err")"; }
  if ! git -C "$folder" rev-parse --verify --quiet HEAD >/dev/null; then
    # Still the empty clone of an earlier open. Once the branch exists upstream,
    # check it out; git refuses (and changes nothing) if a file would be overwritten.
    if [ "$(git -C "$folder" symbolic-ref --quiet HEAD)" = "refs/heads/$branch" ] \
      && git -C "$folder" rev-parse --verify --quiet "refs/remotes/origin/$branch" >/dev/null; then
      bounded git -C "$folder" checkout --quiet -b "$branch" --track "origin/$branch" >/dev/null 2>&1
    fi
  fi
  head=$(git -C "$folder" rev-parse --verify --quiet HEAD) || emit ok:fetched
  emit "ok:fetched:$head"
fi
if git --git-dir="$mirror" rev-parse --verify --quiet "refs/heads/$branch^{commit}" >/dev/null; then
  bounded git clone --quiet --branch "$branch" --origin origin -- "$mirror" "$work/clone" 2>"$work/err" \
    || { rc=$?; fail "$(classify "$rc" "$work/err")"; }
  git -C "$work/clone" remote set-url origin "$url" 2>/dev/null || fail repo_open_git_failed
  head=$(git -C "$work/clone" rev-parse --verify --quiet HEAD) || fail repo_open_ref_not_found
  status=cloned:$head
else
  # The repository has no commits yet (a new Cloudflare Artifacts repository),
  # or not this branch yet: an empty clone, as "git clone" makes of an empty
  # repository, with HEAD on the binding's branch and any other branches as
  # remote-tracking refs.
  { git init --quiet "$work/clone" && git -C "$work/clone" symbolic-ref HEAD "refs/heads/$branch" \
    && git -C "$work/clone" remote add origin "$url" \
    && git -C "$work/clone" config "branch.$branch.remote" origin \
    && git -C "$work/clone" config "branch.$branch.merge" "refs/heads/$branch"; } >/dev/null 2>&1 || fail repo_open_git_failed
  bounded git -C "$work/clone" fetch --quiet --no-recurse-submodules "$mirror" '+refs/heads/*:refs/remotes/origin/*' 2>"$work/err" \
    || { rc=$?; fail "$(classify "$rc" "$work/err")"; }
  status=created
fi
mv -T "$work/clone" "$folder" 2>/dev/null || fail repo_open_git_failed
emit "ok:$status"
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
  auth: RepoOpenAuth;
  timeoutMs: number;
}): string {
  const { lockWaitS, gitTimeoutS } = repoOpenBounds(params.timeoutMs);
  return ['bash', '-c', shq(REPO_OPEN_SCRIPT), 'ezil-repo-open', shq(params.root), shq(params.repositoryId),
    shq(params.url), shq(params.branch), params.requireHydrated ? '1' : '0', params.auth === 'bearer' ? 'bearer' : 'basic',
    String(lockWaitS), String(gitTimeoutS)].join(' ');
}

/** The script's result line (the last `ezil-repo-open:` line), or null when there is none or it is malformed. */
export function parseRepoOpenOutput(
  stdout: string,
): { ok: true; status: RepoOpenStatus; head?: string } | { ok: false; error: RepoOpenError } | null {
  const line = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ezil-repo-open:')).pop();
  if (!line) return null;
  if (line === 'ezil-repo-open:ok:created' || line === 'ezil-repo-open:ok:fetched') {
    return { ok: true, status: line.slice('ezil-repo-open:ok:'.length) as RepoOpenStatus };
  }
  const ok = /^ezil-repo-open:ok:(cloned|fetched):([0-9a-f]+)$/.exec(line);
  if (ok) return HEAD.test(ok[2]!) ? { ok: true, status: ok[1] as RepoOpenStatus, head: ok[2]! } : null;
  const error = /^ezil-repo-open:error:([a-z_]+)$/.exec(line)?.[1];
  return error && (REPO_OPEN_ERRORS as readonly string[]).includes(error) ? { ok: false, error: error as RepoOpenError } : null;
}

export type RepoOpenExec = (
  command: string,
  options: { env: Record<string, string>; timeout: number; origin: 'internal' },
) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

/** The slice of the Sandbox SDK `ownSessionExec` needs (`createSession` / `deleteSession`). */
export interface RepoOpenSessions {
  createSession(options: { id: string }): Promise<{ id: string; exec: RepoOpenExec }>;
  deleteSession(sessionId: string): Promise<unknown>;
}

/**
 * An exec in a shell session of its own, deleted afterwards. The container
 * server runs one session's commands one at a time, and the default session
 * carries the Durable Object's own probes (load average, terminal keep-alive);
 * an open can take minutes and must not queue them behind it. Deleting the
 * session also ends a script the exec bound gave up on.
 */
export function ownSessionExec(
  sandbox: RepoOpenSessions,
  newId: () => string = () => `ezil-repo-open-${crypto.randomUUID()}`,
): RepoOpenExec {
  return async (command, options) => {
    const session = await sandbox.createSession({ id: newId() });
    try {
      return await session.exec(command, options);
    } finally {
      await sandbox.deleteSession(session.id).catch(() => undefined);
    }
  };
}

/**
 * Run one open on a computer known to be running. Only `stdout`'s result line
 * is read; `stderr` is never read, logged or returned.
 */
export async function runRepoOpen(exec: RepoOpenExec, request: RepoOpenRequest, root: RepoOpenRoot): Promise<RepoOpenAnswer> {
  const command = repoOpenCommand({
    root: root.path, repositoryId: request.repositoryId, url: request.canonicalURL,
    branch: request.branch, requireHydrated: root.requireHydrated, auth: request.auth, timeoutMs: request.timeoutMs,
  });
  let stdout: string;
  try {
    const result = await exec(command, {
      env: { [REPO_OPEN_TOKEN_ENV]: request.token },
      timeout: Math.min(Math.max(request.timeoutMs, REPO_OPEN_MIN_TIMEOUT_MS), REPO_OPEN_EXEC_TIMEOUT_MS),
      origin: 'internal',
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
  return { ok: true, folder: `${root.path}/projects/${request.repositoryId}`, ...(parsed.head ? { head: parsed.head } : {}), status: parsed.status };
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
