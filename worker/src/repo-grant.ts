/**
 * Renewable Git push access for a repository the open-project flow placed (`./repo-open.ts`)
 * (docs/contracts/os-builder-project-open-v1.md §7).
 *
 * An open uses its grant for the clone or fetch and leaves no credential on the computer, so a
 * later `git push` from Code had nothing to answer with. The repo-grant op installs the u2
 * kernel's fixed credential helper (`./repo-grant-helper.generated.ts`, byte for byte OS 84e4b686
 * `ezil-git-grant.mjs`) and a grant of at most five minutes for ONE repository:
 *
 *   /run/ezil/git/grants/<handle>__<name>.json   the grant: uid 0, mode 0600, the helper's exact
 *                                                eight keys; outside /workspace, never checkpointed
 *   /run/ezil/git/grants/<handle>__<name>.bind   `v1 <subject> <repositoryId> <url>`: the slot's
 *                                                owner; another subject, repository or URL is refused
 *   /run/ezil/bin/ezil-git-grant(.mjs)           the fixed wrapper and the helper module
 *   <repository>/.git/config                     credential.https://<host>.helper '' + the fixed
 *                                                wrapper, credential.https://<host>.usehttppath true:
 *                                                a path, never a token
 *
 * The same op is the refresh (`POST /sandbox/:name/repo-grant`): it never fetches, clones,
 * resets or replaces anything in the person's folder; it finds the repository the open placed
 * (`<root>/projects/<repositoryId>/repository`, or the older layout at the folder itself), through
 * real directories only, with the binding's URL as its one origin, and rewrites the /run files.
 * Basic-auth remotes only (EZiL Git: github.ezil.work, and git-qa.ezil.work on os-staging):
 * git 2.34.1 cannot take a Bearer token (Cloudflare Artifacts) from a credential helper.
 *
 * The token reaches the script as the open's does (`repoOpenCommand`): on fd 3, never in an
 * argument or a process environment. Every git the script runs in the person's repository runs
 * BEFORE the token is read and without fd 3; after that the script runs no git at all.
 */
import {
  ARTIFACTS_REPOSITORY_URL,
  repoOpenAuthFor,
  repoOpenWhenRunning,
  REPO_OPEN_GIT_USERNAME,
  REPO_OPEN_LOCK,
  REPO_OPEN_NESTED_DIR,
  REPO_OPEN_TOKEN_ENV,
  type RepoOpenAnswer,
  type RepoOpenExec,
  type RepoOpenRemotes,
  type RepoOpenRequest,
  type RepoOpenRoot,
} from './repo-open';
import { EZIL_GIT_GRANT_HELPER_SOURCE } from './repo-grant-helper.generated';

/** The helper's fixed paths (u2 contract §9.6; the helper reads only GRANTS_DIR). */
export const REPO_GRANT_RUN_DIR = '/run/ezil';
export const REPO_GRANT_GRANTS_DIR = '/run/ezil/git/grants';
export const REPO_GRANT_HELPER_MODULE_PATH = '/run/ezil/bin/ezil-git-grant.mjs';
export const REPO_GRANT_HELPER_WRAPPER_PATH = '/run/ezil/bin/ezil-git-grant';
/** The repository's credential.helper value: the u2 kernel's HELPER_CONFIG_VALUE, byte for byte (a path and a hint, never a token). */
export const REPO_GRANT_HELPER_CONFIG_VALUE = `!f() { if [ -x ${REPO_GRANT_HELPER_WRAPPER_PATH} ]; then exec ${REPO_GRANT_HELPER_WRAPPER_PATH} "$@"; fi; `
  + `if [ "$1" = get ]; then echo 'EZiL: Git access for this repository is not connected. Reopen it from EZiL OS.' >&2; echo quit=1; fi; }; f`;

/** Largest refresh body the route reads. */
export const REPO_GRANT_MAX_BODY_BYTES = 4 * 1024;
/** A grant may not claim to outlive five minutes (Universe's and Works' cap) plus clock skew. */
export const REPO_GRANT_MAX_LIFETIME_MS = 300_000 + 30_000;
/** The helper stops answering 30 s before expiry; a grant with less than this left is not worth installing. */
export const REPO_GRANT_MIN_LIFETIME_MS = 60_000;
export const REPO_GRANT_EXEC_TIMEOUT_MS = 30_000;
export const REPO_GRANT_LOCK_WAIT_S = 20;

export const REPO_GRANT_ERRORS = [
  'repo_open_invalid_request',
  'repo_open_token_expired',
  'repo_grant_unsupported_remote',
  'repo_grant_not_open',
  'repo_grant_conflict',
  'repo_open_busy',
  'repo_open_git_missing',
  'repo_grant_failed',
] as const;
export type RepoGrantError = (typeof REPO_GRANT_ERRORS)[number];

export interface RepoGrantRequest {
  repositoryId: string;
  canonicalURL: string;
  /** An EZiL Git grant: `egg_` + 64 hex. */
  token: string;
  /** Normalised to `YYYY-MM-DDTHH:MM:SS.sssZ`, the helper's own grammar. */
  expiresAt: string;
  scope: 'read' | 'write';
}

export type RepoGrantAnswer = { ok: true; expiresAt: string } | { ok: false; error: RepoGrantError | 'runtime_not_running' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EGG = /^egg_[0-9a-f]{64}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The grant's lifetime rules, shared by a refresh and an open: the normalised expiry, or the refusal. */
function grantExpiry(expiresAt: unknown, now: number): { ok: true; expiresAt: string } | { ok: false; error: 'repo_open_invalid_request' | 'repo_open_token_expired' } {
  if (typeof expiresAt !== 'string' || !ISO_DATETIME.test(expiresAt)) return { ok: false, error: 'repo_open_invalid_request' };
  const expiry = Date.parse(expiresAt);
  if (!Number.isFinite(expiry)) return { ok: false, error: 'repo_open_invalid_request' };
  if (expiry - now < REPO_GRANT_MIN_LIFETIME_MS) return { ok: false, error: 'repo_open_token_expired' };
  if (expiry - now > REPO_GRANT_MAX_LIFETIME_MS) return { ok: false, error: 'repo_open_invalid_request' };
  return { ok: true, expiresAt: new Date(expiry).toISOString() };
}

/**
 * `POST /sandbox/:name/repo-grant`'s body: exactly `{repositoryId, canonicalURL, git: {token, expiresAt, scope
 * [, username: 'ezil']}}`. No ref and no branch: a refresh never chooses one (and never guesses a default).
 * A Cloudflare Artifacts remote is `repo_grant_unsupported_remote`; any other unknown remote, as with an open,
 * is `repo_open_invalid_request` (git-qa.ezil.work only where `remotes` opts in, i.e. on os-staging).
 */
export function parseRepoGrantRequest(
  body: unknown,
  now: number = Date.now(),
  remotes: RepoOpenRemotes = {},
): { ok: true; request: RepoGrantRequest } | { ok: false; error: 'repo_open_invalid_request' | 'repo_open_token_expired' | 'repo_grant_unsupported_remote' } {
  const invalid = { ok: false as const, error: 'repo_open_invalid_request' as const };
  if (!isPlainObject(body)) return invalid;
  if (Object.keys(body).sort().join(',') !== 'canonicalURL,git,repositoryId') return invalid;
  const { repositoryId, canonicalURL, git } = body;
  if (typeof repositoryId !== 'string' || !UUID.test(repositoryId)) return invalid;
  const auth = repoOpenAuthFor(canonicalURL, remotes);
  if (auth === null) return invalid;
  if (auth !== 'basic') return { ok: false, error: 'repo_grant_unsupported_remote' };
  if (!isPlainObject(git)) return invalid;
  for (const key of Object.keys(git)) if (!['token', 'expiresAt', 'scope', 'username'].includes(key)) return invalid;
  if ('username' in git && git.username !== REPO_OPEN_GIT_USERNAME) return invalid;
  if (git.scope !== 'read' && git.scope !== 'write') return invalid;
  if (typeof git.token !== 'string' || !EGG.test(git.token)) return invalid;
  const expiry = grantExpiry(git.expiresAt, now);
  if (!expiry.ok) return expiry;
  return { ok: true, request: { repositoryId, canonicalURL: canonicalURL as string, token: git.token, expiresAt: expiry.expiresAt, scope: git.scope } };
}

/**
 * The grant an open can install with its own token: only a Basic-auth remote, an EZiL Git (`egg_`) token, a
 * scope the caller sent, and a lifetime the refresh would accept too. Anything else installs nothing (the
 * open itself is unaffected; the app's refresh installs the grant later).
 */
export function grantRequestFromOpen(request: RepoOpenRequest, now: number = Date.now()): RepoGrantRequest | null {
  if (request.auth !== 'basic' || ARTIFACTS_REPOSITORY_URL.test(request.canonicalURL)) return null;
  if (request.scope !== 'read' && request.scope !== 'write') return null;
  if (!EGG.test(request.token)) return null;
  const expiry = grantExpiry(request.expiresAt, now);
  if (!expiry.ok) return null;
  return { repositoryId: request.repositoryId, canonicalURL: request.canonicalURL, token: request.token, expiresAt: expiry.expiresAt, scope: request.scope };
}

/** The slot's subject: sha256 of the OS user id (the v2 claims' `userId`), never the id itself. */
export async function repoGrantSubject(userId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`ezil.repo-grant.subject.v1\n${userId}`)));
  return [...digest].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** POSIX single-quote a value for a bash command line. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The container-side script. Positional arguments: root, repositoryId, URL, expiresAt, scope, subject, lock
 * wait (s), the repository's credential.helper value, the helper module's source. The token arrives on fd 3
 * only. Always exits 0 after printing exactly one `ezil-repo-grant:` line; nothing git prints is printed.
 * A template literal: each `${…}` is a TypeScript constant; the shell's own expansions are brace-free.
 */
export const REPO_GRANT_SCRIPT = String.raw`
emit() { printf 'ezil-repo-grant:%s\n' "$1"; exit 0; }
fail() { emit "error:$1"; }
[ -z "$${REPO_OPEN_TOKEN_ENV}" ] || fail repo_open_invalid_request
[ "$#" -eq 9 ] || fail repo_open_invalid_request
root=$1; id=$2; url=$3; expires=$4; scope=$5; subject=$6; lockwait=$7; helpercfg=$8; helper=$9
case "$root" in /*) ;; *) fail repo_open_invalid_request ;; esac
[ "${'$'}{#id}" -eq 36 ] || fail repo_open_invalid_request
case "$id" in *[!0-9a-f-]*) fail repo_open_invalid_request ;; esac
case "$scope" in read|write) ;; *) fail repo_open_invalid_request ;; esac
[ "${'$'}{#subject}" -eq 64 ] || fail repo_open_invalid_request
case "$subject" in *[!0-9a-f]*) fail repo_open_invalid_request ;; esac
case "$lockwait" in ''|*[!0-9]*) fail repo_open_invalid_request ;; esac
case "$expires" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z) ;; *) fail repo_open_invalid_request ;; esac
# https://<host>/<handle>/<name>.git and nothing else (the Worker checked the remote against its table).
rest=${'$'}{url#https://}
[ "$rest" != "$url" ] || fail repo_open_invalid_request
host=${'$'}{rest%%/*}; route=${'$'}{rest#*/}; handle=${'$'}{route%%/*}; tail=${'$'}{route#*/}; name=${'$'}{tail%.git}
[ "$route" = "$handle/$name.git" ] || fail repo_open_invalid_request
case "$host" in ''|*[!a-z0-9.:-]*) fail repo_open_invalid_request ;; esac
case "$handle" in ''|*[!a-z0-9-]*) fail repo_open_invalid_request ;; esac
case "$name" in ''|*[!a-z0-9._-]*|*..*) fail repo_open_invalid_request ;; esac
command -v git >/dev/null 2>&1 && command -v flock >/dev/null 2>&1 || fail repo_open_git_missing
node=$(command -v node 2>/dev/null) || fail repo_open_git_missing
case "$node" in /*) ;; *) fail repo_open_git_missing ;; esac
case "$node" in *[!A-Za-z0-9._/-]*) fail repo_open_git_missing ;; esac
# As in the open: no system, global or inherited config, no hook, fsmonitor, askpass or prompt.
unset $(git rev-parse --local-env-vars 2>/dev/null 3<&-) GIT_CONFIG_PARAMETERS GIT_ASKPASS SSH_ASKPASS GIT_EXEC_PATH GIT_TEMPLATE_DIR XDG_CONFIG_HOME
export GIT_TERMINAL_PROMPT=0 GIT_ALLOW_PROTOCOL=file GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null
export GIT_CONFIG_COUNT=5
export GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=
export GIT_CONFIG_KEY_1=core.hooksPath GIT_CONFIG_VALUE_1=/dev/null
export GIT_CONFIG_KEY_2=core.fsmonitor GIT_CONFIG_VALUE_2=false
export GIT_CONFIG_KEY_3=core.askPass GIT_CONFIG_VALUE_3=
export GIT_CONFIG_KEY_4=protocol.allow GIT_CONFIG_VALUE_4=never
# The computer's repo-open lock, alone: never while an open places or updates a folder, nor beside another grant.
exec 9>"${REPO_OPEN_LOCK}" || fail repo_open_busy
flock -x -w "$lockwait" 9 || fail repo_open_busy
# The repository the open placed, through real directories only, with this URL as its one origin.
parent=$root/projects
folder=$parent/$id
for p in "$parent" "$folder"; do { [ ! -L "$p" ] && [ -d "$p" ]; } || fail repo_grant_not_open; done
if [ -e "$folder/.git" ] || [ -L "$folder/.git" ]; then repo=$folder; else repo=$folder/${REPO_OPEN_NESTED_DIR}; fi
{ [ ! -L "$repo" ] && [ -d "$repo" ]; } || fail repo_grant_not_open
{ [ ! -L "$repo/.git" ] && [ -d "$repo/.git" ]; } || fail repo_grant_not_open
{ [ ! -L "$repo/.git/config" ] && [ -f "$repo/.git/config" ]; } || fail repo_grant_not_open
[ "$(git -C "$repo" rev-parse --git-dir 2>/dev/null 3<&-)" = .git ] || fail repo_grant_not_open
[ "$(git -C "$repo" config --local --get-all remote.origin.url 2>/dev/null 3<&-)" = "$url" ] || fail repo_grant_not_open
# The repository names the fixed wrapper for its own host, and only that: rewritten only when it differs.
cred="credential.https://$host"
have=$(git -C "$repo" config --local --get-all "$cred.helper" 2>/dev/null 3<&-; echo x)
want=$(printf '\n%s\n' "$helpercfg"; echo x)
paths=$(git -C "$repo" config --local --get-all "$cred.usehttppath" 2>/dev/null 3<&-)
if [ "$have" != "$want" ] || [ "$paths" != true ]; then
  git -C "$repo" config --local --unset-all "$cred.helper" >/dev/null 2>&1 3<&-
  git -C "$repo" config --local --unset-all "$cred.usehttppath" >/dev/null 2>&1 3<&-
  { git -C "$repo" config --local --add "$cred.helper" '' && git -C "$repo" config --local --add "$cred.helper" "$helpercfg" \
    && git -C "$repo" config --local --add "$cred.usehttppath" true; } >/dev/null 2>&1 3<&- || fail repo_grant_failed
fi
# /run/ezil: real directories, root only.
umask 077
for d in ${REPO_GRANT_RUN_DIR} ${REPO_GRANT_RUN_DIR}/git ${REPO_GRANT_GRANTS_DIR} ${REPO_GRANT_RUN_DIR}/bin; do
  if [ -L "$d" ] || { [ -e "$d" ] && [ ! -d "$d" ]; }; then fail repo_grant_failed; fi
  [ -d "$d" ] || mkdir -m 700 "$d" 2>/dev/null || fail repo_grant_failed
done
slot=${REPO_GRANT_GRANTS_DIR}/${'$'}{handle}__$name
bindline="v1 $subject $id $url"
if [ -e "$slot.bind" ] || [ -L "$slot.bind" ]; then
  { [ ! -L "$slot.bind" ] && [ -f "$slot.bind" ] && [ "$(cat "$slot.bind" 3<&-)" = "$bindline" ]; } || fail repo_grant_conflict
fi
# From here on no git runs. The token: read from fd 3, an EZiL Git grant or nothing.
IFS= read -r tok <&3
exec 3<&-
case "$tok" in egg_*) ;; *) fail repo_open_invalid_request ;; esac
[ "${'$'}{#tok}" -eq 68 ] || fail repo_open_invalid_request
case "${'$'}{tok#egg_}" in *[!0-9a-f]*) fail repo_open_invalid_request ;; esac
# Each file is written beside its target and renamed over it (never through a link, never into a
# directory: mv -T), in THIS shell (no pipeline subshell, so a failure is the script's answer).
tmps=
trap 'rm -f $tmps' EXIT
newtmp() { t=$(mktemp "$(dirname "$1")/.ezil-grant.XXXXXX") || fail repo_grant_failed; tmps="$tmps $t"; }
commit() {
  if [ ! -L "$1" ] && cmp -s "$t" "$1"; then chmod "$2" "$1" 2>/dev/null || fail repo_grant_failed; return 0; fi
  { chmod "$2" "$t" && mv -fT "$t" "$1"; } 2>/dev/null || fail repo_grant_failed
}
if [ ! -f "$slot.bind" ]; then
  newtmp "$slot.bind"; printf '%s\n' "$bindline" >"$t" || fail repo_grant_failed; commit "$slot.bind" 600
fi
newtmp ${REPO_GRANT_HELPER_MODULE_PATH}; printf '%s' "$helper" >"$t" || fail repo_grant_failed; commit ${REPO_GRANT_HELPER_MODULE_PATH} 400
newtmp ${REPO_GRANT_HELPER_WRAPPER_PATH}
printf "#!/bin/sh\nexec '%s' %s \"\$@\"\n" "$node" ${REPO_GRANT_HELPER_MODULE_PATH} >"$t" || fail repo_grant_failed
commit ${REPO_GRANT_HELPER_WRAPPER_PATH} 500
newtmp "$slot.json"
printf '{"v":1,"protocol":"https","host":"%s","path":"%s","username":"${REPO_OPEN_GIT_USERNAME}","password":"%s","expiresAt":"%s","scope":"%s"}\n' \
  "$host" "$handle/$name.git" "$tok" "$expires" "$scope" >"$t" || fail repo_grant_failed
commit "$slot.json" 600
emit ok
`;

/** The exec command for one grant op: the token on fd 3 only, exactly as `repoOpenCommand` hands it over. */
export function repoGrantCommand(params: { root: string; request: RepoGrantRequest; subject: string; lockWaitS?: number }): string {
  const { root, request, subject } = params;
  const script = ['bash', '-c', shq(REPO_GRANT_SCRIPT), 'ezil-repo-grant', shq(root), shq(request.repositoryId), shq(request.canonicalURL),
    shq(request.expiresAt), shq(request.scope), shq(subject), String(params.lockWaitS ?? REPO_GRANT_LOCK_WAIT_S),
    shq(REPO_GRANT_HELPER_CONFIG_VALUE), shq(EZIL_GIT_GRANT_HELPER_SOURCE)].join(' ');
  return `(t=$${REPO_OPEN_TOKEN_ENV}; unset ${REPO_OPEN_TOKEN_ENV}; exec ${script} 3<<<"$t")`;
}

/** The script's result line (the last `ezil-repo-grant:` line), or null. */
export function parseRepoGrantOutput(stdout: string): { ok: true } | { ok: false; error: RepoGrantError } | null {
  const line = stdout.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('ezil-repo-grant:')).pop();
  if (!line) return null;
  if (line === 'ezil-repo-grant:ok') return { ok: true };
  const error = /^ezil-repo-grant:error:([a-z_]+)$/.exec(line)?.[1];
  return error && (REPO_GRANT_ERRORS as readonly string[]).includes(error) ? { ok: false, error: error as RepoGrantError } : null;
}

/** One grant op on a computer known to be running. Only stdout's result line is read; never stderr. */
export async function runRepoGrant(exec: RepoOpenExec, request: RepoGrantRequest, root: RepoOpenRoot, subject: string): Promise<RepoGrantAnswer> {
  if (!/^[0-9a-f]{64}$/.test(subject)) return { ok: false, error: 'repo_open_invalid_request' };
  let stdout: string;
  try {
    const result = await exec(repoGrantCommand({ root: root.path, request, subject }), {
      env: { [REPO_OPEN_TOKEN_ENV]: request.token }, timeout: REPO_GRANT_EXEC_TIMEOUT_MS, origin: 'internal',
    });
    stdout = result.exitCode === 0 ? result.stdout ?? '' : '';
  } catch {
    return { ok: false, error: 'repo_grant_failed' };
  }
  if (stdout.includes(request.token)) return { ok: false, error: 'repo_grant_failed' };
  const parsed = parseRepoGrantOutput(stdout);
  if (!parsed) return { ok: false, error: 'repo_grant_failed' };
  return parsed.ok ? { ok: true, expiresAt: request.expiresAt } : parsed;
}

/** The Durable Object's refresh: a stopped computer is refused (an exec would cold-start it), never started. */
export async function repoGrantWhenRunning(deps: { running: () => Promise<boolean>; touch: () => void; exec: RepoOpenExec },
  request: RepoGrantRequest, root: RepoOpenRoot, subject: string): Promise<RepoGrantAnswer> {
  if (!(await deps.running())) return { ok: false, error: 'runtime_not_running' };
  deps.touch();
  return runRepoGrant(deps.exec, request, root, subject);
}

/**
 * The Durable Object's open: the open exactly as before, then, for an EZiL Git remote opened with a scope and
 * when the caller names the subject, the grant op with the same token. The open's answer is unchanged
 * whatever the grant op answers (a later refresh installs it).
 */
export async function repoOpenThenGrant(deps: { running: () => Promise<boolean>; touch: () => void; exec: RepoOpenExec },
  request: RepoOpenRequest, root: RepoOpenRoot, subject?: string, now: () => number = Date.now): Promise<RepoOpenAnswer> {
  const answer = await repoOpenWhenRunning(deps, request, root);
  const grant = answer.ok && subject ? grantRequestFromOpen(request, now()) : null;
  if (grant && subject) await runRepoGrant(deps.exec, grant, root, subject);
  return answer;
}

/** HTTP status for a refresh refusal. */
export function repoGrantStatus(error: RepoGrantError | 'runtime_not_running'): number {
  switch (error) {
    case 'repo_open_invalid_request':
    case 'repo_grant_unsupported_remote':
      return 400;
    case 'repo_open_token_expired':
    case 'repo_grant_not_open':
    case 'repo_grant_conflict':
    case 'repo_open_busy':
    case 'runtime_not_running':
      return 409;
    case 'repo_open_git_missing':
      return 500;
    default:
      return 502;
  }
}
