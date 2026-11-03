// EZiL repo-open kernel (contract universe-repo-open-v1 §9). Runs inside the computer as
//
//   node /run/ezil/bin/ezil-repo-open.mjs <prepare|commit|refresh|release> /run/ezil/requests/<uuid>.json
//
// The Worker writes this file and the request (§8 step 7) and runs exactly that command line;
// the CLI entry has no other input: it reads no environment variable and refuses a request
// with any key outside the contract's list (including the test-seam keys). The last stdout
// line is the result JSON; nothing else is ever printed, and never the grant.
//
// Phases (§9.4):
//   prepare  outside the persistence tail; the only phase with network; writes only under
//            <root>/.ezil-staging/<uuid> and /run/ezil.
//   commit   inside the tail; no network; binding check, rename(2) into place or credential
//            repair of an existing folder; releases the lock it owns as its last act.
//   refresh  installs the grant and rewrites the /run/ezil/bin wrapper only.
//   release  idempotent cleanup the Worker runs after every outcome.
//
// Class assessment (1.0.3, §9.4): git-qa.ezil.work; the clone goes to <root>/projects/<repositoryId>/repository
// inside a wrapper the commit creates fresh (the editor root); head, clean and remote are read in staging
// before the rename, and the placement is re-checked right after it. All of it is in-guest evidence: guest
// root (identity A) can change W at any time. Class personal keeps <root>/repos/<handle>/<name>.
//
// Class project (1.0.4): an ordinary Builder-created project's repository on github.ezil.work or git-qa.ezil.work,
// in the assessment layout, with exactly defaultBranch; a re-open of a folder this class placed (marked in
// F/.git/ezil-repo-class) is `existing`, and push access is the same /run/ezil grant and fixed helper, renewed by
// `refresh`. No class adopts a folder another class placed.
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RUN_DIR = '/run/ezil';
const BIN_DIR = '/run/ezil/bin';
const HELPER_MODULE_PATH = '/run/ezil/bin/ezil-git-grant.mjs';
export const HELPER_WRAPPER_PATH = '/run/ezil/bin/ezil-git-grant';
const GRANTS_DIR = '/run/ezil/git/grants';
const INCOMING_DIR = '/run/ezil/git/incoming';
const REQUESTS_DIR = '/run/ezil/requests';
const LOCKS_DIR = '/run/ezil/locks';
// gitEnv's HOME and XDG_CONFIG_HOME (r56 review and recheck): paths that cannot exist (below a character device), so
// git finds no $HOME/.gitconfig and none of its XDG files, and libcurl (inside git) no $HOME/.netrc. HOME is set,
// never unset: without HOME, libcurl reads the .netrc of the passwd home instead.
const GIT_HOME = '/dev/null/ezil-no-home';
const GIT_XDG_CONFIG_HOME = '/dev/null/ezil-no-xdg';
const GIT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
export const STAGING_ROOT_NAME = '.ezil-staging';
const BINDING_FILE = 'ezil-repo.json';
/** The binding's exact keys (writeBinding, bindingMatches, repoOpenMarked for projects/<repositoryId>/repository). */
const BINDING_KEYS = ['v', 'repositoryId', 'handle', 'name', 'gitHost'];
// Request class → the one git host it may name (1.0.3; vectors constants REPO_OPEN_CLASS_GIT_HOSTS).
// A closed table: a request whose gitHost is not its class's host is refused. A request without
// `class` is 'personal', so a 1.0.2 request reads exactly as before.
export const CLASS_GIT_HOSTS = Object.freeze({ personal: 'git-preview.ezil.work', assessment: 'git-qa.ezil.work' });
const DEFAULT_CLASS = 'personal';
// Class project (1.0.4, vectors kernel.project): an ordinary Builder-created project's own repository, on the
// deployment's EZiL Git host (production github.ezil.work, os-staging git-qa.ezil.work; the Worker sends the one
// its deployment serves, the kernel takes either and nothing else). Layout as class assessment (W/repository, W the
// editor root, path null, exactly defaultBranch), but a W this class placed itself, marked in F/.git, re-opens as
// `existing`; a folder another class placed never does, and class assessment still adopts nothing.
export const PROJECT_CLASS = 'project';
export const PROJECT_GIT_HOSTS = Object.freeze(['github.ezil.work', 'git-qa.ezil.work']);
export const PROJECT_MARKER_FILE = 'ezil-repo-class';
const PROJECT_MARKER = 'project\n';
export const KERNEL_CLASSES = Object.freeze(['personal', 'assessment', PROJECT_CLASS]);
const classAllowsHost = (cls, host) => (cls === PROJECT_CLASS ? PROJECT_GIT_HOSTS.includes(host) : CLASS_GIT_HOSTS[cls] === host);
/** The classes whose repository sits in a wrapper W = <root>/projects/<repositoryId> (E1-6 layout). */
const wrapped = (r) => r.class === 'assessment' || r.class === PROJECT_CLASS;
// Class assessment layout (1.0.3 E1-6, vectors kernel.assessment.layoutRule; constants ASSESSMENT_DIR_TEMPLATE and
// ASSESSMENT_CLONE_DIR_NAME): the wrapper W = <root>/projects/<repositoryId> is the editor root, and the clone is
// F = W/repository (the OS open-project layout), so no file of the repository sits at the editor root.
export const ASSESSMENT_PROJECTS_DIR = 'projects';
export const ASSESSMENT_CLONE_DIR = 'repository';
/** The personal layout's top directory, repos/<handle>/<name> (REPO_DIR_TEMPLATE). */
const NESTED_REPOS_DIR = 'repos';
export const LOCK_STALE_MS = 600000;
export const KERNEL_GIT_COMMAND_MAX_MS = 80000;
export const PREPARE_RESERVE_MS = 20000;
// The Worker's prepare exec ends at deadline - PREPARE_RESERVE_MS. The kernel stops its own
// work this much earlier so it can still clean up and print its result before that.
export const CLEANUP_MARGIN_MS = 5000;
// Prepare step 0 removes a non-inflight leftover only once it is this old (= the Worker deadline,
// vectors timeouts.WORKER_DEADLINE_MS). A prepare sweeps only before deadline - 25 s, i.e. within
// 80 s of its request's receipt and so of its `inflight` snapshot: files of a request missing from
// that snapshot are younger than 80 s when it sweeps.
export const LEFTOVER_MIN_AGE_MS = 105000;
const LOCAL_GIT_COMMAND_MS = 5000;
const MAX_INFLIGHT = 64;
const MAX_REQUEST_BYTES = 16384;
const MAX_GRANT_BYTES = 4096;

export const TAR_BLOCK_BYTES = 512;
export const TAR_PAX_NAME_BYTES = 100;
export const TAR_PAX_RECORD_SLACK_BYTES = 64;
export const TAR_ARCHIVE_TAIL_BYTES = 11264;
// The snapshot codec's own skip sets (worker/src/workspace-snapshot-script.ts INTERNAL, CACHES,
// MAX_NESTED_INDEXES; vectors SNAPSHOT_*). The budget counts only what the codec archives (1.0.2).
export const SNAPSHOT_INTERNAL_NAMES = ['.ezil-hydrated.json', '.ezil-flush-manifest.json'];
export const SNAPSHOT_CACHE_NAMES = ['node_modules', '.next', '.turbo', 'dist'];
export const SNAPSHOT_NESTED_INDEX_MAX = 256;
// How the codec reads an index: this binary, this environment, these limits.
const INDEX_GIT = '/usr/bin/git';
const INDEX_GIT_ENV = { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' };
const INDEX_GIT_TIMEOUT_MS = 30000;
/** git's usage-error exit: git < 2.35 (the image's 2.34.1) has no `ls-files --sparse` and exits with it before reading the index. */
const GIT_USAGE_EXIT = 129;
/**
 * The codec's budgets for one inventory pass (vectors repoBudget.workspaceRule): index bytes copied, one pool
 * the root spends first and the bound folders then share (the codec's LIMIT); ls-files output bytes, the root's
 * own pool, then a second one the bound folders share (PATHS_LIMIT). A failed read keeps what it spent.
 */
export const SNAPSHOT_INDEX_BYTES = 512 * 1024 * 1024;
export const SNAPSHOT_INDEX_PATHS_BYTES = 16 * 1024 * 1024;
const MARKER_MAX_BYTES = 4096;

export const HELPER_HINT_NOT_CONNECTED = 'EZiL: Git access for this repository is not connected. Reopen it from EZiL OS.';
/** The repo-local helper (§9.5). Fixed path; names no node binary, so an image change cannot break it. */
export const HELPER_CONFIG_VALUE = `!f() { if [ -x ${HELPER_WRAPPER_PATH} ]; then exec ${HELPER_WRAPPER_PATH} "$@"; fi; if [ "$1" = get ]; then echo '${HELPER_HINT_NOT_CONNECTED}' >&2; echo quit=1; fi; }; f`;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HANDLE_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const NAME_RE = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,243}$/;
const GRANT_RE = /^egg_[0-9a-f]{64}$/;
const NODE_PATH_RE = /^\/[A-Za-z0-9._/-]+$/;
const PATH_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const validHandle = (s) => typeof s === 'string' && HANDLE_RE.test(s);
export const validName = (s) => typeof s === 'string' && NAME_RE.test(s) && !s.includes('..') && !s.endsWith('.git');
export const validBranch = (s) => typeof s === 'string' && BRANCH_RE.test(s) && !s.includes('..') && !s.includes('//')
  && !s.endsWith('/') && !s.endsWith('.lock') && !s.includes('/.') && !s.endsWith('.');
const validUuid = (s) => typeof s === 'string' && UUID_RE.test(s);

/** The decoded-path half of app-link.js `pathProblem` (vectors `link.path`); null when acceptable. */
export function pathProblem(value) {
  if (typeof value !== 'string') return 'type';
  if (value === '') return 'empty';
  if (Buffer.byteLength(value, 'utf8') > 255) return 'too_long';
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

export const REQUEST_KEYS = ['v', 'op', 'phase', 'uuid', 'inflight', 'repositoryId', 'handle', 'name', 'gitHost',
  'defaultBranch', 'path', 'root', 'staging', 'incoming', 'deadlineMs', 'budget'];
/** The one optional request key (1.0.3, vectors kernel.optionalRequestKeys). */
export const OPTIONAL_REQUEST_KEYS = ['class'];
export const PHASES = ['prepare', 'commit', 'refresh', 'release'];
const PHASE_OPS = { prepare: ['open'], commit: ['open'], refresh: ['refresh'], release: ['open', 'refresh'] };
const BUDGET_KEYS = ['limitBytes', 'maxEntries', 'fraction'];
const GRANT_KEYS = ['v', 'protocol', 'host', 'path', 'username', 'password', 'expiresAt', 'scope'];
export const TEST_SEAM_KEYS = ['sslCAInfo', 'proxy'];

class KernelError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const refuse = (code) => { throw new KernelError(code); };
const fail = (errorCode) => ({ ok: false, errorCode });
const KERNEL_CODES = ['folder_conflict', 'repository_too_large', 'git_auth_rejected', 'repository_unavailable',
  'network_unavailable', 'workspace_busy', 'workspace_failed'];
const codeOf = (error) => (error instanceof KernelError && KERNEL_CODES.includes(error.code) ? error.code : 'workspace_failed');

const exactKeys = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every((k) => Object.prototype.hasOwnProperty.call(value, k));
const lstatOrNull = (p) => { try { return fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } };
const isWholeNumber = (n) => Number.isSafeInteger(n) && n > 0;

// ── request ─────────────────────────────────────────────────────────────────

function validRoot(root) {
  if (typeof root !== 'string' || !NODE_PATH_RE.test(root) || root === '/' || path.posix.normalize(root) !== root
    || root.endsWith('/')) return false;
  const st = lstatOrNull(root);
  return !!st && st.isDirectory() && fs.realpathSync(root) === root;
}

/** Strict request file (§9.2, vectors kernel.requestKeys). Any deviation → workspace_failed before any action. */
export function readRequest(phase, requestPath) {
  if (!PHASES.includes(phase)) refuse('workspace_failed');
  const m = typeof requestPath === 'string' ? /^\/run\/ezil\/requests\/([0-9a-f-]{36})\.json$/.exec(requestPath) : null;
  if (!m || !validUuid(m[1])) refuse('workspace_failed');
  const st = lstatOrNull(requestPath);
  if (!st || !st.isFile() || st.size > MAX_REQUEST_BYTES) refuse('workspace_failed');
  let r;
  try { r = JSON.parse(fs.readFileSync(requestPath, 'utf8')); } catch { refuse('workspace_failed'); }
  const classed = exactKeys(r, [...REQUEST_KEYS, ...OPTIONAL_REQUEST_KEYS]);
  if (!classed && !exactKeys(r, REQUEST_KEYS)) refuse('workspace_failed');
  const cls = classed ? r.class : DEFAULT_CLASS;
  if (typeof cls !== 'string' || !KERNEL_CLASSES.includes(cls)) refuse('workspace_failed');
  const ok = r.v === 1 && (r.op === 'open' || r.op === 'refresh') && r.phase === phase && PHASE_OPS[phase].includes(r.op)
    && r.uuid === m[1] && Array.isArray(r.inflight) && r.inflight.length >= 1 && r.inflight.length <= MAX_INFLIGHT
    && r.inflight.every(validUuid) && new Set(r.inflight).size === r.inflight.length && r.inflight.includes(r.uuid)
    && validUuid(r.repositoryId) && validHandle(r.handle) && validName(r.name) && typeof r.gitHost === 'string' && classAllowsHost(cls, r.gitHost)
    // A wrapped class's editor root is always its wrapper (E1-6, 1.0.4): its path must be null.
    && validBranch(r.defaultBranch) && (r.path === null || (cls === 'personal' && r.op === 'open' && pathProblem(r.path) === null))
    && validRoot(r.root) && r.staging === `${r.root}/${STAGING_ROOT_NAME}/${r.uuid}`
    && r.incoming === `${INCOMING_DIR}/${r.uuid}.json` && isWholeNumber(r.deadlineMs)
    && exactKeys(r.budget, BUDGET_KEYS) && isWholeNumber(r.budget.limitBytes) && isWholeNumber(r.budget.maxEntries)
    && typeof r.budget.fraction === 'number' && r.budget.fraction > 0 && r.budget.fraction <= 1;
  if (!ok) refuse('workspace_failed');
  r.class = cls;
  return r;
}

function readSeam(testOptions) {
  if (testOptions === undefined) return null;
  if (!testOptions || typeof testOptions !== 'object' || Array.isArray(testOptions)
    || !Object.keys(testOptions).every((k) => TEST_SEAM_KEYS.includes(k))) refuse('workspace_failed');
  for (const value of Object.values(testOptions)) {
    if (typeof value !== 'string' || !/^[^\s]+$/.test(value)) refuse('workspace_failed');
  }
  return testOptions;
}

const projectsOf = (r) => `${r.root}/${ASSESSMENT_PROJECTS_DIR}`;
/** The editor root of an assessment, W (E1-6). */
const wrapperOf = (r) => `${projectsOf(r)}/${r.repositoryId}`;
/** The repository folder F: <root>/repos/<handle>/<name> (personal), W/repository (assessment, project). */
const folderOf = (r) => (wrapped(r) ? `${wrapperOf(r)}/${ASSESSMENT_CLONE_DIR}` : `${r.root}/repos/${r.handle}/${r.name}`);
/** What an open answers as its folder: F (personal), W (assessment, project). */
const editorRootOf = (r) => (wrapped(r) ? wrapperOf(r) : folderOf(r));
/** The repo-local remote (§9.5); for class assessment, vectors constants ASSESSMENT_REMOTE_TEMPLATE. */
const remoteUrlOf = (r) => `https://${r.gitHost}/${r.handle}/${r.name}.git`;
// Grants and locks stay keyed by handle and name for both classes (the helper finds the grant that way).
const lockOf = (r) => `${LOCKS_DIR}/${r.handle}__${r.name}`;
const grantOf = (r) => `${GRANTS_DIR}/${r.handle}__${r.name}.json`;
const requestFileOf = (r) => `${REQUESTS_DIR}/${r.uuid}.json`;

// ── git ─────────────────────────────────────────────────────────────────────

// `core.fsmonitor=` (empty) turns fsmonitor off on every git: git < 2.36 (the image's 2.34.1) reads
// the value `false` as a hook command and runs the PATH's `false` (1.0.3).
const GIT_BASE_CONFIG = ['-c', 'core.hooksPath=/dev/null', '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
  '-c', 'submodule.recurse=false', '-c', 'core.fsmonitor='];
/**
 * The whole environment of every runGit child: nothing inherited (§9.4 "Git hygiene", vectors kernel.gitEnv). git's own
 * configuration sources are closed: no system, global or XDG config (GIT_CONFIG_NOSYSTEM, GIT_CONFIG_GLOBAL,
 * XDG_CONFIG_HOME), no system attributes file (GIT_ATTR_NOSYSTEM), no template directory (GIT_TEMPLATE_DIR empty: git
 * init copies nothing into .git) and no file under HOME (libcurl's .netrc). A value guest root plants in any of them
 * (http.proxy, url.<base>.insteadOf, credential.helper, include.path, core.excludesFile, an eol attribute, a netrc
 * login, ...) never reaches ls-remote, fetch, checkout or the reads. The programs, libraries and other system files git
 * and libcurl use (PATH, the CA store, the resolver) stay writable by guest root (vectors kernel.assessment.trust).
 * The index read is no runGit child: it runs the codec's own binary and environment (INDEX_GIT_ENV) in a throwaway git dir.
 */
export const gitEnv = () => ({ PATH: GIT_PATH, HOME: GIT_HOME, XDG_CONFIG_HOME: GIT_XDG_CONFIG_HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_ATTR_NOSYSTEM: '1', GIT_TEMPLATE_DIR: '' });
const seamConfig = (seam) => (seam ? [
  ...(seam.sslCAInfo ? ['-c', `http.sslCAInfo=${seam.sslCAInfo}`] : []),
  ...(seam.proxy ? ['-c', `http.proxy=${seam.proxy}`] : []),
] : []);

const OUTPUT_CAP = 1 << 20;
/**
 * One git process (own process group, killed whole on timeout); output captured, never forwarded.
 * `env` adds fixed variables to the cleared environment (the hardened reads); nothing is inherited.
 */
export function runGit(args, { cwd, timeoutMs, seam, env = null }) {
  return new Promise((resolve) => {
    if (!(timeoutMs > 0)) { resolve({ code: null, stdout: '', stderr: '', timedOut: true }); return; }
    let child;
    try {
      child = spawn('git', [...GIT_BASE_CONFIG, ...seamConfig(seam), ...args],
        { cwd, env: env ? { ...gitEnv(), ...env } : gitEnv(), stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    } catch {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false });
      return;
    }
    const out = [], err = [];
    let outBytes = 0, errBytes = 0, timedOut = false, settled = false;
    child.stdout.on('data', (d) => { if (outBytes < OUTPUT_CAP) { out.push(d); outBytes += d.length; } });
    child.stderr.on('data', (d) => { if (errBytes < OUTPUT_CAP) { err.push(d); errBytes += d.length; } });
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* gone */ } }
    }, timeoutMs);
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8'), timedOut });
    };
    child.on('error', () => done(null));
    child.on('close', (code) => done(code));
  });
}

/** Contract §9.4 classification of a failed network git command (vectors kernel.classification). */
export function classifyGitFailure({ stderr = '', timedOut = false }) {
  if (timedOut) return 'workspace_busy';
  const s = String(stderr);
  if (/returned error: 40[13]\b|Authentication failed|terminal prompts disabled|could not read (Username|Password)|told us to quit/i.test(s)) return 'git_auth_rejected';
  if (/returned error: 404\b|repository '[^']*' not found|Repository not found/i.test(s)) return 'repository_unavailable';
  if (/Could not resolve (host|proxy)|Failed to connect|Couldn't connect|Connection refused|Connection timed out|timed out|Network is unreachable|No route to host|SSL|TLS|certificate|gnutls|CONNECT tunnel failed|Proxy CONNECT aborted|Received HTTP code \d+ from proxy|Empty reply from server|Recv failure|Send failure|connection reset/i.test(s)) return 'network_unavailable';
  return 'workspace_failed';
}

export function parseGitVersion(text) {
  const m = /git version (\d+)\.(\d+)/.exec(String(text));
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}
/**
 * `git init` argument lists for `dir` (§9.4 step 2): `-b` from git 2.28, else a symbolic-ref fallback. Both run with
 * gitEnv, whose empty GIT_TEMPLATE_DIR keeps any template directory out of .git (r56 recheck).
 */
export function gitInitCommands(branch, version) {
  const modern = !!version && (version.major > 2 || (version.major === 2 && version.minor >= 28));
  return modern ? [['init', '-q', '-b', branch]] : [['init', '-q'], ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]];
}

async function git(args, opts, failCode = 'workspace_failed') {
  const result = await runGit(args, opts);
  if (result.code !== 0) refuse(result.timedOut ? 'workspace_busy' : failCode);
  return result.stdout;
}
const localGit = (cwd) => ({ cwd, timeoutMs: LOCAL_GIT_COMMAND_MS, seam: null });

/** `git config --local --get-all`, [] when unset. */
async function getAll(cwd, key) {
  const result = await runGit(['config', '--local', '--get-all', key], localGit(cwd));
  if (result.code === 1) return [];
  if (result.code !== 0) refuse(result.timedOut ? 'workspace_busy' : 'workspace_failed');
  const lines = result.stdout.split('\n');
  lines.pop();
  return lines;
}
const sameList = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
async function unsetAll(cwd, key) {
  const result = await runGit(['config', '--local', '--unset-all', key], localGit(cwd));
  if (result.code !== 0 && result.code !== 5) refuse('workspace_failed');
}

/** §9.5: the repo-local config, written in this order on a new clone (before the fetch). */
async function writeNewConfig(dir, r) {
  const cred = `credential.https://${r.gitHost}`;
  for (const args of [
    ['config', 'remote.origin.url', remoteUrlOf(r)],
    ['config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'],
    ['config', '--add', `${cred}.helper`, ''],
    ['config', '--add', `${cred}.helper`, HELPER_CONFIG_VALUE],
    ['config', '--add', `${cred}.usehttppath`, 'true'],
    ['config', 'push.autosetupremote', 'true'],
  ]) await git(args, localGit(dir));
}

/**
 * §9.4 step 3 / §9.5 (1.0.1), initialized_empty only: the unborn default branch's upstream
 * (vectors gitConfig.branchUpstream), so the notice's plain `git push` creates
 * refs/heads/<branch> on git < 2.37, which ignores push.autosetupremote.
 */
async function writeEmptyUpstream(dir, branch) {
  await git(['config', `branch.${branch}.remote`, 'origin'], localGit(dir));
  await git(['config', `branch.${branch}.merge`, `refs/heads/${branch}`], localGit(dir));
}

/**
 * Commit on an existing folder: rewrite exactly the credential keys when they differ (repairs an
 * older value). git drops an emptied section and re-adds it last, so an unchanged
 * `push.autosetupremote=true` is re-added after it to keep the §9.5 order; its value never changes.
 */
async function repairCredentialConfig(dir, r) {
  const cred = `credential.https://${r.gitHost}`;
  const helpers = await getAll(dir, `${cred}.helper`);
  const httpPath = await getAll(dir, `${cred}.usehttppath`);
  if (sameList(helpers, ['', HELPER_CONFIG_VALUE]) && sameList(httpPath, ['true'])) return;
  await unsetAll(dir, `${cred}.helper`);
  await unsetAll(dir, `${cred}.usehttppath`);
  await git(['config', '--add', `${cred}.helper`, ''], localGit(dir));
  await git(['config', '--add', `${cred}.helper`, HELPER_CONFIG_VALUE], localGit(dir));
  await git(['config', '--add', `${cred}.usehttppath`, 'true'], localGit(dir));
  if (sameList(await getAll(dir, 'push.autosetupremote'), ['true'])) {
    await unsetAll(dir, 'push.autosetupremote');
    await git(['config', 'push.autosetupremote', 'true'], localGit(dir));
  }
}

/** §9.4 post-check: neither .git/config nor `git remote -v` carries userinfo or the grant. */
async function assertNoCredentials(dir, r, token) {
  const config = fs.readFileSync(`${dir}/.git/config`, 'utf8');
  const remotes = await git(['remote', '-v'], localGit(dir));
  for (const text of [config, remotes]) {
    if (text.includes(`@${r.gitHost}`) || /egg_[0-9a-f]{64}/.test(text) || (token && text.includes(token))) refuse('workspace_failed');
  }
}

// ── /run/ezil files ─────────────────────────────────────────────────────────

function ensureDir(dir, mode) {
  const st = lstatOrNull(dir);
  if (st) { if (!st.isDirectory()) refuse('workspace_failed'); return; }
  fs.mkdirSync(dir, { recursive: true, mode });
}

/** Validate the incoming grant (§9.3) and return its token; nothing is printed. */
function readIncomingGrant(r) {
  const st = lstatOrNull(r.incoming);
  if (!st || !st.isFile() || st.size > MAX_GRANT_BYTES) refuse('workspace_failed');
  let g;
  try { g = JSON.parse(fs.readFileSync(r.incoming, 'utf8')); } catch { refuse('workspace_failed'); }
  const ok = exactKeys(g, GRANT_KEYS) && g.v === 1 && g.protocol === 'https' && g.host === r.gitHost
    && g.path === `${r.handle}/${r.name}.git` && g.username === 'ezil' && typeof g.password === 'string'
    && GRANT_RE.test(g.password) && typeof g.expiresAt === 'string' && ISO_RE.test(g.expiresAt)
    && Number.isFinite(Date.parse(g.expiresAt)) && (g.scope === 'write' || g.scope === 'read');
  if (!ok) refuse('workspace_failed');
  return g.password;
}

/** lstat the incoming file, rename(2) it into place, chmod 0600 (§9.3). Returns the token. */
function installGrant(r) {
  const token = readIncomingGrant(r);
  ensureDir(GRANTS_DIR, 0o700);
  fs.renameSync(r.incoming, grantOf(r));
  fs.chmodSync(grantOf(r), 0o600);
  return token;
}

/** /run/ezil/bin/ezil-git-grant (§9.6), rewritten by every phase that installs a grant. */
function writeWrapper() {
  const node = process.execPath;
  if (typeof node !== 'string' || !NODE_PATH_RE.test(node)) refuse('workspace_failed');
  ensureDir(BIN_DIR, 0o700);
  const tmp = `${HELPER_WRAPPER_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `#!/bin/sh\nexec '${node}' ${HELPER_MODULE_PATH} "$@"\n`, { mode: 0o500 });
  fs.chmodSync(tmp, 0o500);
  fs.renameSync(tmp, HELPER_WRAPPER_PATH);
}

const removeTree = (p) => { fs.rmSync(p, { recursive: true, force: true }); };
const removeFile = (p) => { try { fs.unlinkSync(p); } catch (e) { if (!e || e.code !== 'ENOENT') throw e; } };

/** The staging root, only when it is a real directory (never through a symlink). */
function stagingRootOf(r) {
  const dir = `${r.root}/${STAGING_ROOT_NAME}`;
  const st = lstatOrNull(dir);
  if (!st) return null;
  if (!st.isDirectory()) refuse('workspace_failed');
  return dir;
}

/**
 * Class assessment (E1-6, vectors kernel.assessment.layoutRule): what stands at W, never following a
 * symlink. 'absent' (no <root>/projects, or no W in it), 'real' (both are real directories), 'foreign'
 * (W exists as anything else: a file, a symlink, a dangling symlink) or 'bad-parent' (<root>/projects exists
 * but is not a real directory: lstat, so W is never looked up through it).
 */
function wrapperState(r) {
  const parent = lstatOrNull(projectsOf(r));
  if (!parent) return 'absent';
  if (!parent.isDirectory()) return 'bad-parent';
  const wrapper = lstatOrNull(wrapperOf(r));
  if (!wrapper) return 'absent';
  return wrapper.isDirectory() ? 'real' : 'foreign';
}

/**
 * Prepare and commit of an assessment (E1-6): null when W is absent and <root>/projects is absent or a real
 * directory, else the refusal: workspace_failed for a <root>/projects that is not a real directory,
 * folder_conflict for anything at W (the wrapper must be fresh: nothing there is ever adopted).
 */
function freshWrapperRefusal(r) {
  const state = wrapperState(r);
  if (state === 'bad-parent') return fail('workspace_failed');
  return state === 'absent' ? null : fail('folder_conflict');
}

/** lstat of F for refresh and release: a wrapped class's F only through real directories (null when W is not one). */
function cloneStat(r) {
  if (!wrapped(r)) return lstatOrNull(folderOf(r));
  return wrapperState(r) === 'real' ? lstatOrNull(folderOf(r)) : null;
}

/** F/.git/PROJECT_MARKER_FILE is a regular file (lstat) holding exactly "project\n": a folder class project placed. */
function projectMarked(folder) {
  try {
    const file = `${folder}/.git/${PROJECT_MARKER_FILE}`;
    const st = fs.lstatSync(file);
    return st.isFile() && st.size === PROJECT_MARKER.length && fs.readFileSync(file, 'utf8') === PROJECT_MARKER;
  } catch { return false; }
}

/**
 * Class project (1.0.4): what stands at W. `fresh` when nothing does (the open places a new wrapper, as an
 * assessment does); `existing` when W and F are real directories and F is bound to this request AND marked as a
 * project folder (a re-open: nothing fetched, nothing replaced); otherwise the refusal (workspace_failed for a
 * <root>/projects that is not a real directory, folder_conflict for anything else, an assessment's W included).
 */
function projectWrapper(r) {
  const state = wrapperState(r);
  if (state === 'bad-parent') return { refusal: fail('workspace_failed') };
  if (state === 'foreign') return { refusal: fail('folder_conflict') };
  if (state === 'absent') return { fresh: true };
  const folder = folderOf(r);
  const st = lstatOrNull(folder);
  if (!st || !st.isDirectory() || !bindingMatches(folder, r) || !projectMarked(folder)) return { refusal: fail('folder_conflict') };
  return { existing: true };
}

function readOwner(lock) {
  try {
    const st = fs.lstatSync(`${lock}/owner`);
    if (!st.isFile() || st.size > 64) return null;
    const owner = fs.readFileSync(`${lock}/owner`, 'utf8');
    return validUuid(owner) ? { owner, mtimeMs: st.mtimeMs } : null;
  } catch { return null; }
}

/**
 * Lock (§9.1, vectors kernel.lockRule): created atomically with its owner (rename of a
 * prepared directory). An existing lock is live only while its owner is in this request's
 * `inflight` AND younger than LOCK_STALE_MS; otherwise it is stale and is replaced.
 */
function takeLock(r, now) {
  ensureDir(LOCKS_DIR, 0o700);
  const lock = lockOf(r);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const tmp = `${lock}.${r.uuid}.tmp`;
    removeTree(tmp);
    fs.mkdirSync(tmp, { mode: 0o700 });
    fs.writeFileSync(`${tmp}/owner`, r.uuid, { mode: 0o600, flag: 'wx' });
    try {
      fs.renameSync(tmp, lock);
      return true;
    } catch (e) {
      removeTree(tmp);
      if (!e || !['ENOTEMPTY', 'EEXIST', 'ENOTDIR', 'EISDIR'].includes(e.code)) throw e;
    }
    const held = readOwner(lock);
    if (held && r.inflight.includes(held.owner) && now - held.mtimeMs < LOCK_STALE_MS) return false;
    removeTree(lock);
  }
  return false;
}

/** Release `lock` only when this request owns it. */
function releaseOwnLock(r) {
  const held = readOwner(lockOf(r));
  if (held && held.owner === r.uuid) removeTree(lockOf(r));
}

/**
 * Prepare step 0: leftovers of requests the Worker no longer tracks: uuid not in inflight AND
 * older than LEFTOVER_MIN_AGE_MS. The age gate keeps the files of a request that entered the
 * Worker's map after this request's `inflight` snapshot (a refresh of another repository may
 * write its request and incoming files while this prepare starts); those are always younger
 * than this request's own deadline window, while a real leftover only grows older.
 */
function removeLeftovers(r, now) {
  const stagingRoot = stagingRootOf(r);
  const sweep = (dir, suffix, remove) => {
    let names;
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const id = suffix ? (name.endsWith(suffix) ? name.slice(0, -suffix.length) : null) : name;
      if (id === null || !validUuid(id) || r.inflight.includes(id)) continue;
      let st;
      try { st = fs.lstatSync(`${dir}/${name}`); } catch { continue; }
      if (now - st.mtimeMs >= LEFTOVER_MIN_AGE_MS) remove(`${dir}/${name}`);
    }
  };
  if (stagingRoot) sweep(stagingRoot, '', removeTree);
  sweep(REQUESTS_DIR, '.json', removeFile);
  sweep(INCOMING_DIR, '.json', removeFile);
}

/** `F/.git/ezil-repo.json` equals the request's binding (read-only; never through a symlink). */
function bindingMatches(dir, r) {
  try {
    const git = fs.lstatSync(`${dir}/.git`);
    const file = fs.lstatSync(`${dir}/.git/${BINDING_FILE}`);
    if (!git.isDirectory() || !file.isFile() || file.size > 4096) return false;
    const b = JSON.parse(fs.readFileSync(`${dir}/.git/${BINDING_FILE}`, 'utf8'));
    return exactKeys(b, BINDING_KEYS) && b.v === 1 && b.repositoryId === r.repositoryId
      && b.handle === r.handle && b.name === r.name && b.gitHost === r.gitHost;
  } catch { return false; }
}
function writeBinding(dir, r) {
  fs.writeFileSync(`${dir}/.git/${BINDING_FILE}`, `${JSON.stringify({ v: 1, repositoryId: r.repositoryId, handle: r.handle, name: r.name, gitHost: r.gitHost })}\n`, { flag: 'wx' });
}

// ── tar-byte budget (§9.4 step 5, vectors repoBudget) ────────────────────────

const ASCII_RE = /^[\x00-\x7f]*$/;
/** Tar bytes one entry costs in the codec's PAX_FORMAT archive (conservative). */
export function entryTarBytes({ type, name, size = 0, linkname = '' }) {
  const B = TAR_BLOCK_BYTES;
  const nameBytes = Buffer.byteLength(name, 'utf8');
  const linkBytes = Buffer.byteLength(linkname, 'utf8');
  const pax = nameBytes >= TAR_PAX_NAME_BYTES || linkBytes >= TAR_PAX_NAME_BYTES || !ASCII_RE.test(name) || !ASCII_RE.test(linkname)
    ? B + B * Math.ceil((nameBytes + linkBytes + TAR_PAX_RECORD_SLACK_BYTES) / B) : 0;
  return B + (type === 'file' ? B * Math.ceil(size / B) : 0) + pax;
}
export function budgetLimits(budget) {
  return { maxBytes: Math.floor(budget.limitBytes * budget.fraction), maxEntries: Math.floor(budget.maxEntries * budget.fraction) };
}
export function budgetOk(workspaceTarBytes, stagedTarBytes, workspaceEntries, stagedEntries, budget) {
  const { maxBytes, maxEntries } = budgetLimits(budget);
  return workspaceTarBytes + stagedTarBytes + TAR_ARCHIVE_TAIL_BYTES <= maxBytes && workspaceEntries + stagedEntries <= maxEntries;
}

function entryOf(abs, name, st) {
  if (st.isSymbolicLink()) {
    let linkname = '';
    try { linkname = fs.readlinkSync(abs); } catch { /* counted without a target */ }
    return { type: 'symlink', name, linkname };
  }
  if (st.isDirectory()) return { type: 'dir', name };
  return { type: 'file', name, size: st.isFile() ? st.size : 0 };
}

/** Walks `dir` (never following links), calling visit(entry) per entry; visit returns false to stop. */
function walk(dir, prefix, visit, overDeadline) {
  const stack = [[dir, prefix]];
  let count = 0;
  while (stack.length) {
    const [abs, rel] = stack.pop();
    let names;
    try { names = fs.readdirSync(abs); } catch { continue; }
    for (const child of names) {
      const childAbs = `${abs}/${child}`;
      const childRel = rel ? `${rel}/${child}` : child;
      let st;
      try { st = fs.lstatSync(childAbs); } catch { continue; }
      if (visit(entryOf(childAbs, childRel, st)) === false) return false;
      if (st.isDirectory()) stack.push([childAbs, childRel]);
      count += 1;
      if (count % 1000 === 0 && overDeadline()) refuse('workspace_busy');
    }
  }
  return true;
}

// ── what the snapshot codec archives (§9.4 step 5, §9.8; vectors repoBudget.workspaceRule) ──

/**
 * vectors repoBudget.repoOpenMarkerRule, the codec's nested_marked: <layout>/<a>/<b> is a repo-open folder when
 * <layout>, <a>, <b> and .git are real directories (lstat, never a symlink) and .git/ezil-repo.json is a regular
 * file of at most 4096 bytes whose strict UTF-8 text (a byte-order mark kept, so refused) parses as an object
 * with v 1. repos/<handle>/<name>: its own handle and name, other keys allowed. projects/<repositoryId>/repository:
 * exactly BINDING_KEYS, its own repositoryId and string handle and name. Anything else marks nothing.
 */
export function repoOpenMarked(root, layout, a, b) {
  try {
    const folder = `${root}/${layout}/${a}/${b}`;
    for (const p of [`${root}/${layout}`, `${root}/${layout}/${a}`, folder, `${folder}/.git`]) {
      if (!fs.lstatSync(p).isDirectory()) return false;
    }
    const file = `${folder}/.git/${BINDING_FILE}`;
    const st = fs.lstatSync(file);
    if (!st.isFile() || st.size > MARKER_MAX_BYTES) return false;
    const m = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(fs.readFileSync(file)));
    if (!m || typeof m !== 'object' || Array.isArray(m) || m.v !== 1) return false;
    if (layout === NESTED_REPOS_DIR) return m.handle === a && m.name === b;
    return exactKeys(m, BINDING_KEYS) && m.repositoryId === a && typeof m.handle === 'string' && typeof m.name === 'string';
  } catch { return false; }
}

/** The codec's representable(): a name it archives; anything else it skips, a directory with its whole subtree. */
const representable = (name) => name !== '' && !name.startsWith('/') && !name.includes('\\')
  && name.split('/').every((x) => x !== '' && x !== '.' && x !== '..') && !SNAPSHOT_INTERNAL_NAMES.includes(name.split('/')[0]);
/** Tuples of names in Python's order: component-wise by code point (JS `<` compares UTF-16 units instead). */
const byComponents = (x, y) => {
  for (let i = 0; i < x.length; i += 1) {
    const c = Buffer.compare(Buffer.from(x[i], 'utf8'), Buffer.from(y[i], 'utf8'));
    if (c !== 0) return c;
  }
  return 0;
};
/** A real directory's names (lstat first, so a symlink is never listed). */
const listRealDir = (dir) => {
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('not a directory');
  return fs.readdirSync(dir);
};
/** A directory's names in its own order (no sort), as the codec's os.listdir returns them. */
function unsortedNames(dir) {
  const d = fs.opendirSync(dir);
  try {
    const out = [];
    for (let e = d.readSync(); e !== null; e = d.readSync()) out.push(e.name);
    return out;
  } finally { d.closeSync(); }
}

/**
 * The codec's nested_candidates: [layout, a, b] for every projects/<repositoryId>/repository and
 * repos/<handle>/<name>, in byComponents order (so projects/ first). A projects, repos or handle that is
 * a symlink or cannot be listed contributes nothing.
 */
function nestedCandidates(root) {
  const out = [];
  let top;
  try { top = fs.readdirSync(root); } catch { return out; }
  if (top.includes(ASSESSMENT_PROJECTS_DIR)) {
    try {
      for (const id of listRealDir(`${root}/${ASSESSMENT_PROJECTS_DIR}`)) out.push([ASSESSMENT_PROJECTS_DIR, id, ASSESSMENT_CLONE_DIR]);
    } catch { /* contributes nothing */ }
  }
  if (top.includes(NESTED_REPOS_DIR)) {
    try {
      for (const handle of listRealDir(`${root}/${NESTED_REPOS_DIR}`)) {
        try {
          for (const name of listRealDir(`${root}/${NESTED_REPOS_DIR}/${handle}`)) out.push([NESTED_REPOS_DIR, handle, name]);
        } catch { continue; }
      }
    } catch { /* contributes nothing */ }
  }
  return out.sort(byComponents);
}

/**
 * The paths one index lists, read exactly as the codec reads it: a private copy of `index` and
 * any `sharedindex.*` (in the directory's own order) in a throwaway git dir under `scratch`
 * (never git inside the user's repository, so its config, hooks and fsmonitor never run), the
 * codec's binary, environment and flags. `budget` ({index, paths}: what the pass has left) is
 * spent as the codec spends it: every copied byte, even by a read that then fails; the listed
 * bytes once git exits 0. null when the codec could not read it either.
 */
function indexPaths(gitDir, prefix, { budget, scratch, timeoutMs }) {
  let tmp = null;
  try {
    if (!fs.lstatSync(gitDir).isDirectory()) return null;
    const names = unsortedNames(gitDir);
    if (!names.includes('index')) return new Set();
    if (!(timeoutMs() > 0)) return null;
    tmp = fs.mkdtempSync(`${scratch}/repo-open-index-`);
    fs.mkdirSync(`${tmp}/objects`);
    fs.mkdirSync(`${tmp}/refs`);
    fs.writeFileSync(`${tmp}/HEAD`, 'ref: refs/heads/main\n');
    for (const n of names) {
      if (n !== 'index' && !n.startsWith('sharedindex.')) continue;
      const st = fs.lstatSync(`${gitDir}/${n}`);
      if (!st.isFile()) return null;
      budget.index -= st.size;
      if (budget.index < 0) return null;
      fs.copyFileSync(`${gitDir}/${n}`, `${tmp}/${n}`, fs.constants.COPYFILE_EXCL);
    }
    // core.fsmonitor= (EMPTY, r56 review): git < 2.36 runs any other value, `false` included, as a hook command
    // found on PATH; the listed paths are the same either way. GIT_USAGE_EXIT alone retries, once, without
    // --sparse (git 2.34.1 exits so before reading the index); every other failure is final. maxBuffer is
    // at least 1 because 0 would lift the bound.
    const lsFiles = (extra) => {
      const ms = timeoutMs();
      if (!(ms > 0)) return null;
      return spawnSync(INDEX_GIT, [`--git-dir=${tmp}`, '-c', 'core.fsmonitor=', 'ls-files', '-z', '--cached', ...extra],
        { cwd: tmp, env: INDEX_GIT_ENV, stdio: ['ignore', 'pipe', 'ignore'], timeout: ms, maxBuffer: Math.max(budget.paths, 0) + 1, killSignal: 'SIGKILL' });
    };
    let r = lsFiles(['--sparse']);
    if (r && !r.error && r.status === GIT_USAGE_EXIT) r = lsFiles([]);
    if (!r) return null;
    // More output than the pool holds: git listed it after reading the whole index, so the codec spends it all.
    if (r.error && r.error.code === 'ENOBUFS') budget.paths = -1;
    if (r.error || r.status !== 0) return null;
    budget.paths -= r.stdout.length;
    if (budget.paths < 0) return null;
    const text = new TextDecoder('utf-8', { fatal: true }).decode(r.stdout);
    const out = new Set();
    for (const p of text.split('\0')) {
      const parts = `${prefix}${p}`.split('/');
      for (let i = 1; i <= parts.length; i += 1) out.add(parts.slice(0, i).join('/'));
    }
    return out;
  } catch {
    return null;
  } finally {
    if (tmp) { try { removeTree(tmp); } catch { /* scratch */ } }
  }
}

/** Every cache-named entry counts: the codec could not read the root index (it then fails the whole capture). */
export const TRACKED_ALL = Symbol('every cache-named entry counts');

/** The codec's pools for one inventory pass (SNAPSHOT_INDEX_BYTES, SNAPSHOT_INDEX_PATHS_BYTES). */
export const CODEC_INDEX_POOLS = Object.freeze({ indexBytes: SNAPSHOT_INDEX_BYTES, pathBytes: SNAPSHOT_INDEX_PATHS_BYTES });

/**
 * The codec's `tracked` for one inventory pass (its inventory() and nested_index_paths): the root
 * index first, then each nestedCandidates folder whose name is representable and that carries the
 * binding (repoOpenMarked), at most SNAPSHOT_NESTED_INDEX_MAX over both layouts. Index bytes come
 * from one pool, root first; path bytes from the root's own pool, then one the folders share. An
 * unreadable nested index, or one past a pool, adds nothing (as in the codec); an unreadable root
 * index → TRACKED_ALL (the codec fails the whole capture; conservative). `pools` is for tests.
 */
export function codecTracked(root, { scratch, remainingMs = () => INDEX_GIT_TIMEOUT_MS, pools = CODEC_INDEX_POOLS }) {
  const timeoutMs = () => Math.min(INDEX_GIT_TIMEOUT_MS, remainingMs());
  const tracked = new Set();
  const budget = { index: pools.indexBytes, paths: pools.pathBytes };
  if (lstatOrNull(`${root}/.git`)) {
    const found = indexPaths(`${root}/.git`, '', { budget, scratch, timeoutMs });
    if (found === null) return TRACKED_ALL;
    for (const p of found) tracked.add(p);
  }
  budget.paths = pools.pathBytes;
  let read = 0;
  for (const [layout, a, b] of nestedCandidates(root)) {
    const folder = `${layout}/${a}/${b}`;
    if (!representable(folder) || !repoOpenMarked(root, layout, a, b)) continue;
    if (read >= SNAPSHOT_NESTED_INDEX_MAX) break;
    read += 1;
    const found = indexPaths(`${root}/${folder}/.git`, `${folder}/`, { budget, scratch, timeoutMs });
    if (found) for (const p of found) tracked.add(p);
  }
  return tracked;
}

/** The codec's link_ok, counting the entry wherever Node cannot answer as Python would (conservative). */
function codecLinkOk(realRoot, name, abs) {
  let target;
  try { target = fs.readlinkSync(abs); } catch { return true; }
  if (!target || target.startsWith('/') || target.includes('\\')) return false;
  const dir = path.posix.dirname(name);
  const resolved = path.posix.normalize(dir === '.' ? target : `${dir}/${target}`);
  if (resolved === '..' || resolved.startsWith('../')) return false;
  let real;
  try { real = fs.realpathSync(abs); } catch { return true; }
  return real === realRoot || real.startsWith(`${realRoot}/`);
}

/**
 * Walks the workspace root as the codec's inventory() does and calls visit(entry) only for what
 * the codec would archive (vectors repoBudget.workspaceRule): never the top-level internal names
 * or staging node; outside .git paths never an untracked cache-named entry, a backslash name,
 * anything but a file, directory or symlink, or an absolute or escaping symlink. A skipped
 * directory's subtree is never entered. `tracked` is built lazily, at the first cache name.
 */
export function walkArchived(root, visit, { tracked, overDeadline = () => false }) {
  let realRoot = root;
  try { realRoot = fs.realpathSync(root); } catch { /* the codec refuses such a root anyway */ }
  let trackedSet;
  const isTracked = (name) => {
    trackedSet ??= tracked();
    if (overDeadline()) refuse('workspace_busy');
    return trackedSet === TRACKED_ALL || trackedSet.has(name);
  };
  const stack = [['', root]];
  let count = 0;
  while (stack.length) {
    const [rel, abs] = stack.pop();
    let names;
    try { names = fs.readdirSync(abs); } catch { continue; }
    for (const child of names) {
      if (!rel && (SNAPSHOT_INTERNAL_NAMES.includes(child) || child === STAGING_ROOT_NAME)) continue;
      const name = rel ? `${rel}/${child}` : child;
      const childAbs = `${abs}/${child}`;
      let st;
      try { st = fs.lstatSync(childAbs); } catch { continue; }
      if (!name.split('/').includes('.git')) {
        if (SNAPSHOT_CACHE_NAMES.includes(child) && !isTracked(name)) continue;
        if (name.includes('\\')) continue;
        if (!st.isFile() && !st.isDirectory() && !st.isSymbolicLink()) continue;
        if (st.isSymbolicLink() && !codecLinkOk(realRoot, name, childAbs)) continue;
      }
      if (visit(entryOf(childAbs, name, st)) === false) return false;
      if (st.isDirectory()) stack.push([name, childAbs]);
      count += 1;
      if (count % 1000 === 0 && overDeadline()) refuse('workspace_busy');
    }
  }
  return true;
}

/**
 * The staged clone measured under its final names (every entry: a fresh checkout holds only
 * tracked files and .git) plus the workspace as the codec would archive it; the workspace scan
 * stops as soon as either sum is over. `scratch` holds the private index copies. `folder` and
 * `parents` (relative to root) default to the personal repos/<handle>/<name> and its two parents;
 * an assessment passes projects/<repositoryId>/repository with projects and W (E1-6).
 */
export function measureBudget({ root, staging, handle, name, budget, scratch = '/tmp', remainingMs,
  folder = `repos/${handle}/${name}`, parents = ['repos', `repos/${handle}`] }, overDeadline = () => false) {
  const { maxBytes, maxEntries } = budgetLimits(budget);
  let stagedTarBytes = 0, stagedEntries = 0;
  const stagedOver = () => stagedTarBytes + TAR_ARCHIVE_TAIL_BYTES > maxBytes || stagedEntries > maxEntries;
  const addStaged = (e) => { stagedTarBytes += entryTarBytes(e); stagedEntries += 1; return !stagedOver(); };
  addStaged({ type: 'dir', name: folder });
  for (const parent of parents) {
    if (!lstatOrNull(`${root}/${parent}`)) addStaged({ type: 'dir', name: parent });
  }
  if (!stagedOver()) walk(staging, folder, addStaged, overDeadline);
  let workspaceTarBytes = 0, workspaceEntries = 0;
  const over = () => workspaceTarBytes + stagedTarBytes + TAR_ARCHIVE_TAIL_BYTES > maxBytes || workspaceEntries + stagedEntries > maxEntries;
  if (!over()) {
    walkArchived(root, (e) => { workspaceTarBytes += entryTarBytes(e); workspaceEntries += 1; return !over(); }, {
      tracked: () => codecTracked(root, { scratch, ...(remainingMs ? { remainingMs } : {}) }),
      overDeadline,
    });
  }
  return { ok: budgetOk(workspaceTarBytes, stagedTarBytes, workspaceEntries, stagedEntries, budget),
    workspaceTarBytes, stagedTarBytes, workspaceEntries, stagedEntries };
}

// ── phases ──────────────────────────────────────────────────────────────────

/** openFolder (§9.1): F/path when realpath(F/path) is a directory inside realpath(F); else F. */
function openFolderOf(folder, relPath) {
  if (relPath === null) return { openFolder: folder, pathNotFound: false };
  try {
    const base = fs.realpathSync(folder);
    const target = fs.realpathSync(`${folder}/${relPath}`);
    if ((target === base || target.startsWith(`${base}/`)) && fs.statSync(target).isDirectory()) {
      return { openFolder: `${folder}/${relPath}`, pathNotFound: false };
    }
  } catch { /* missing or unreadable */ }
  return { openFolder: folder, pathNotFound: true };
}

function currentBranch(folder, fallback) {
  try {
    const st = fs.lstatSync(`${folder}/.git/HEAD`);
    if (st.isFile() && st.size <= 1024) {
      const m = /^ref: refs\/heads\/(.+)\n?$/.exec(fs.readFileSync(`${folder}/.git/HEAD`, 'utf8'));
      if (m && validBranch(m[1])) return m[1];
    }
  } catch { /* detached or unreadable */ }
  return fallback;
}

/**
 * The local git of the assessment reads (1.0.3): on top of the cleared environment (gitEnv: git's
 * own configuration sources closed since the r56 review; GIT_CONFIG_GLOBAL is
 * repeated here, vectors hardenedRead.env) and GIT_BASE_CONFIG (hooks /dev/null, fsmonitor off),
 * repository discovery stops at the directory's parent (the directory itself must be the
 * repository), no pager, and no optional lock (a status killed at its timeout never leaves
 * .git/index.lock behind). These flags keep the kernel's own environment from adding anything;
 * they do not make the repository's own state trustworthy. Its .git (config filter drivers,
 * core.worktree, info/exclude, info/attributes, index bits) and the git binary itself are
 * writable by guest root, so head and clean are in-guest evidence, not proof (vectors
 * kernel.assessment.trust).
 */
const HARDENED_GLOBAL_OPTIONS = ['--no-pager', '--no-optional-locks'];
/** All reads of one assessment commit share this budget (vectors kernel.assessment.readBudgetMs), well inside the host's commit window. */
export const ASSESSMENT_READ_BUDGET_MS = 5000;
const HEAD_RE = /^[0-9a-f]{40}\n$/;
const SYMREF_RE = /^refs\/heads\/[^\n]+\n$/;
const ONE_LINE_RE = /^[^\n]+\n$/;

/** One hardened read in the repository `dir` that ends by `untilMs` (no time left, or killed at it: workspace_busy). */
function hardenedReader(dir, untilMs) {
  const env = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CEILING_DIRECTORIES: path.posix.dirname(dir), GIT_OPTIONAL_LOCKS: '0' };
  return async (args) => {
    const result = await runGit([...HARDENED_GLOBAL_OPTIONS, ...args],
      { cwd: dir, timeoutMs: Math.min(LOCAL_GIT_COMMAND_MS, untilMs - Date.now()), seam: null, env });
    if (result.timedOut) refuse('workspace_busy');
    return result;
  };
}

/**
 * Assessment readiness facts of the repository `dir` (1.0.3; commit reads them in staging, before
 * the rename). Every read ends by `untilMs` (a read with no time left, or killed at it, is
 * workspace_busy):
 *   head   the 40-hex commit HEAD resolves to; null only when HEAD resolves to no object at all
 *          and is a symbolic ref to a refs/heads/ branch (unborn); anything else that is not a
 *          commit (a branch naming a tree, a symbolic ref outside refs/heads/) is workspace_failed;
 *   clean  `git status --porcelain=v1 --untracked-files=all` printed nothing.
 */
export async function assessmentFacts(dir, untilMs = Date.now() + ASSESSMENT_READ_BUDGET_MS) {
  const run = hardenedReader(dir, untilMs);
  let head = null;
  const rev = await run(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  if (rev.code === 0) {
    if (!HEAD_RE.test(rev.stdout)) refuse('workspace_failed');
    head = rev.stdout.slice(0, 40);
  } else {
    // HEAD names an object that is not a commit: never unborn.
    if ((await run(['rev-parse', '--verify', '-q', 'HEAD'])).code === 0) refuse('workspace_failed');
    const sym = await run(['symbolic-ref', '-q', 'HEAD']);
    if (sym.code !== 0 || !SYMREF_RE.test(sym.stdout)) refuse('workspace_failed');
  }
  const status = await run(['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.code !== 0) refuse('workspace_failed');
  return { head, clean: status.stdout === '' };
}

/**
 * The assessment remote of the repository `dir` (1.0.3 E1-6, vectors kernel.assessment.remoteRule), read
 * by the same hardened git within `untilMs`: every remote.origin.url value git sees there. Not --local,
 * so a value added through include.path is listed too. Exactly one value, else workspace_failed; the
 * caller compares it with the expected URL.
 */
export async function assessmentRemote(dir, untilMs = Date.now() + ASSESSMENT_READ_BUDGET_MS) {
  const result = await hardenedReader(dir, untilMs)(['config', '--get-all', 'remote.origin.url']);
  if (result.code !== 0 || !ONE_LINE_RE.test(result.stdout)) refuse('workspace_failed');
  return result.stdout.slice(0, -1);
}

async function describeFolder(folder, r, state) {
  const head = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], localGit(folder));
  if (head.timedOut) refuse('workspace_busy');
  const empty = head.code !== 0;
  const resolvedState = state ?? (empty ? 'initialized_empty' : 'cloned');
  return { ok: true, state: resolvedState, folder, ...openFolderOf(folder, r.path), branch: currentBranch(folder, r.defaultBranch), empty };
}

function parseLsRemote(text) {
  let symref = null;
  const heads = [];
  for (const line of String(text).split('\n')) {
    const sym = /^ref: refs\/heads\/(\S+)\tHEAD$/.exec(line);
    if (sym) { symref = sym[1]; continue; }
    const ref = /^[0-9a-f]{40,64}\trefs\/heads\/(.+)$/.exec(line);
    if (ref) heads.push(ref[1]);
  }
  return { symref, heads };
}

async function prepare(r, seam) {
  const folder = folderOf(r);
  if (r.class === 'assessment') {
    // An assessment opens only a clone it places itself in a wrapper it creates (1.0.3, E1-6): anything
    // already at W, whatever it is, never stands in for the starter clone, and a <root>/projects that is
    // not a real directory is never looked through. Refused before any action.
    const refused = freshWrapperRefusal(r);
    if (refused) return refused;
  } else if (r.class === PROJECT_CLASS) {
    // Read-only, like a personal re-open: an existing project folder is answered, never fetched or changed here.
    const w = projectWrapper(r);
    if (w.refusal) return w.refusal;
    if (w.existing) {
      const root = editorRootOf(r);
      return { ok: true, state: 'existing', folder: root, openFolder: root, pathNotFound: false, branch: r.defaultBranch, empty: false };
    }
  } else {
    const existing = lstatOrNull(folder);
    if (existing) {
      // Read-only: nothing installed or changed here (commit installs for an existing folder).
      if (!existing.isDirectory() || !bindingMatches(folder, r)) return fail('folder_conflict');
      return { ok: true, state: 'existing', folder, openFolder: folder, pathNotFound: false, branch: r.defaultBranch, empty: false };
    }
  }
  const kernelDeadline = r.deadlineMs - PREPARE_RESERVE_MS - CLEANUP_MARGIN_MS;
  const remaining = () => Math.min(KERNEL_GIT_COMMAND_MAX_MS, kernelDeadline - Date.now());
  const net = (cwd) => ({ cwd, timeoutMs: remaining(), seam });
  if (remaining() <= 0) return fail('workspace_busy');

  removeLeftovers(r, Date.now());
  if (!takeLock(r, Date.now())) return fail('workspace_busy');
  let installed = false;
  try {
    const token = installGrant(r);
    installed = true;
    writeWrapper();
    if (!stagingRootOf(r)) fs.mkdirSync(`${r.root}/${STAGING_ROOT_NAME}`, { mode: 0o700 });
    if (lstatOrNull(r.staging)) refuse('workspace_failed');
    fs.mkdirSync(r.staging, { mode: 0o755 });

    const version = parseGitVersion((await runGit(['--version'], localGit(r.staging))).stdout);
    for (const args of gitInitCommands(r.defaultBranch, version)) await git(args, localGit(r.staging));
    await writeNewConfig(r.staging, r);

    const listed = await runGit(['ls-remote', '--symref', 'origin', 'HEAD', 'refs/heads/*'], net(r.staging));
    if (listed.code !== 0) refuse(classifyGitFailure(listed));
    const { symref, heads } = parseLsRemote(listed.stdout);
    let state, branch, empty;
    if (heads.length === 0) {
      state = 'initialized_empty'; branch = r.defaultBranch; empty = true;
      await writeEmptyUpstream(r.staging, r.defaultBranch);
    } else {
      // An assessment and a project check out exactly defaultBranch, never the remote HEAD's branch (1.0.3,
      // 1.0.4: never a guessed default): a non-empty remote without it is refused before the fetch.
      const exact = wrapped(r);
      if (exact && !heads.filter(validBranch).includes(r.defaultBranch)) refuse('repository_unavailable');
      const fetched = await runGit(['fetch', '-q', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*'], net(r.staging));
      if (fetched.code !== 0) refuse(classifyGitFailure(fetched));
      const usable = heads.filter(validBranch).sort();
      branch = exact ? r.defaultBranch
        : symref && usable.includes(symref) ? symref : usable.includes(r.defaultBranch) ? r.defaultBranch : usable[0];
      if (!branch) refuse('workspace_failed');
      await git(['checkout', '-q', '-b', branch, '--track', `origin/${branch}`], { cwd: r.staging, timeoutMs: remaining(), seam: null });
      state = 'cloned'; empty = false;
    }
    writeBinding(r.staging, r);
    if (r.class === PROJECT_CLASS) fs.writeFileSync(`${r.staging}/.git/${PROJECT_MARKER_FILE}`, PROJECT_MARKER, { flag: 'wx' });
    await assertNoCredentials(r.staging, r, token);
    // The staged clone counts under its final names (E1-6: an assessment's under projects/<repositoryId>/repository).
    const finalNames = wrapped(r)
      ? { folder: `${ASSESSMENT_PROJECTS_DIR}/${r.repositoryId}/${ASSESSMENT_CLONE_DIR}`, parents: [ASSESSMENT_PROJECTS_DIR, `${ASSESSMENT_PROJECTS_DIR}/${r.repositoryId}`] }
      : {};
    const budget = measureBudget({ root: r.root, staging: r.staging, handle: r.handle, name: r.name, budget: r.budget,
      scratch: RUN_DIR, remainingMs: () => kernelDeadline - Date.now(), ...finalNames }, () => Date.now() > kernelDeadline);
    if (!budget.ok) refuse('repository_too_large');
    const editorRoot = editorRootOf(r);
    return { ok: true, state, folder: editorRoot, openFolder: editorRoot, pathNotFound: false, branch, empty };
  } catch (error) {
    // §9.4 step 6: only the staging directory, the lock and any grant this op installed.
    try { removeTree(r.staging); } catch { /* reported below */ }
    try { releaseOwnLock(r); } catch { /* stale at the next prepare */ }
    if (installed) { try { removeFile(grantOf(r)); } catch { /* release removes it */ } }
    return fail(codeOf(error));
  }
}

function ensureParent(dir) {
  const st = lstatOrNull(dir);
  if (st) { if (!st.isDirectory()) refuse('workspace_failed'); return; }
  fs.mkdirSync(dir, { mode: 0o755 });
}

const realDir = (p) => { const st = lstatOrNull(p); return !!st && st.isDirectory(); };
/**
 * An assessment placement re-checked after its rename (vectors kernel.assessment.layoutRule): the root is
 * still canonical, <root>/projects, W and F are real directories (lstat, never followed), and W holds
 * exactly F. In-guest evidence at that moment (kernel.assessment.trust), not a lasting guarantee.
 */
function placementHolds(r, wrapper, folder) {
  try {
    return validRoot(r.root)
      && realDir(projectsOf(r))
      && realDir(wrapper)
      && fs.readdirSync(wrapper).join('/') === ASSESSMENT_CLONE_DIR
      && realDir(folder);
  } catch {
    return false;
  }
}

async function commit(r) {
  const assessment = r.class === 'assessment';
  const project = r.class === PROJECT_CLASS;
  let placed = false;
  let reopened = false;
  try {
    const folder = folderOf(r);
    if (assessment) {
      // A wrapper that appeared between prepare and commit, in any form, is never adopted; a
      // <root>/projects that became anything but a real directory is never written through (E1-6).
      const refused = freshWrapperRefusal(r);
      if (refused) return refused;
    } else if (project) {
      // 1.0.4: a project folder this class placed (bound + marked) is re-opened in place, exactly as a personal
      // existing folder: credential config repaired, grant and wrapper installed, nothing fetched or replaced.
      const w = projectWrapper(r);
      if (w.refusal) return w.refusal;
      if (w.existing) {
        reopened = true;
        const token = readIncomingGrant(r);
        await repairCredentialConfig(folder, r);
        await assertNoCredentials(folder, r, token);
        installGrant(r);
        writeWrapper();
        const d = await describeFolder(folder, r, 'existing');
        const root = editorRootOf(r);
        return { ok: true, state: d.state, folder: root, openFolder: root, pathNotFound: false, branch: d.branch, empty: d.empty };
      }
    } else {
      const existing = lstatOrNull(folder);
      if (existing) {
        if (!existing.isDirectory() || !bindingMatches(folder, r)) return fail('folder_conflict');
        const token = readIncomingGrant(r);
        await repairCredentialConfig(folder, r);
        await assertNoCredentials(folder, r, token);
        installGrant(r);
        writeWrapper();
        return await describeFolder(folder, r, 'existing');
      }
    }
    const held = readOwner(lockOf(r));
    if (!held || held.owner !== r.uuid) return fail('workspace_busy');
    const staged = lstatOrNull(r.staging);
    if (!staged || !staged.isDirectory() || !bindingMatches(r.staging, r)) return fail('workspace_failed');
    if (project && !projectMarked(r.staging)) return fail('workspace_failed');
    if (!wrapped(r)) {
      ensureParent(`${r.root}/repos`);
      ensureParent(`${r.root}/repos/${r.handle}`);
      fs.renameSync(r.staging, folder);
      return await describeFolder(folder, r, null);
    }
    // An assessment reads head, clean and remote in staging, BEFORE the rename, all within one budget
    // (1.0.3): a read that fails, a remote that is not this repository's, or a read out of time places
    // nothing, so a re-open is still a fresh open. No git runs after the rename. A project (1.0.4) reads only
    // whether its HEAD is born, also before the rename.
    let head = null, clean = null, remote = null;
    if (assessment) {
      const untilMs = Date.now() + ASSESSMENT_READ_BUDGET_MS;
      ({ head, clean } = await assessmentFacts(r.staging, untilMs));
      remote = await assessmentRemote(r.staging, untilMs);
      if (remote !== remoteUrlOf(r)) refuse('workspace_failed');
    } else {
      const born = await runGit(['rev-parse', '--verify', '-q', 'HEAD'], localGit(r.staging));
      if (born.timedOut) refuse('workspace_busy');
      head = born.code === 0 ? 'born' : null;
    }
    const branch = currentBranch(r.staging, r.defaultBranch);
    // E1-6: a new wrapper W (mkdir: one that appeared meanwhile is folder_conflict), then the clone into
    // W/repository. A failed rename removes the empty W again (rmdir never removes what someone else put
    // there), so no folder is placed and the open stays retryable.
    const wrapper = wrapperOf(r);
    ensureParent(projectsOf(r));
    try {
      fs.mkdirSync(wrapper, { mode: 0o755 });
    } catch (error) {
      refuse(error && error.code === 'EEXIST' ? 'folder_conflict' : 'workspace_failed');
    }
    try {
      fs.renameSync(r.staging, folder);
    } catch {
      try { fs.rmdirSync(wrapper); } catch { /* not empty: something else is in it, never removed here */ }
      refuse('workspace_failed');
    }
    // The placement as the kernel sees it right after the rename (E1-6 review): anything else means guest
    // root acted in the window, so workspace_failed; the clone stays where the rename put it (a re-open is
    // refused, as after a commit timeout) and the grant goes below, as for every assessment commit not ok.
    if (!placementHolds(r, wrapper, folder)) refuse('workspace_failed');
    placed = true;
    const empty = head === null;
    if (project) return { ok: true, state: empty ? 'initialized_empty' : 'cloned', folder: wrapper, openFolder: wrapper, pathNotFound: false, branch, empty };
    return { ok: true, state: empty ? 'initialized_empty' : 'cloned', folder: wrapper, openFolder: wrapper, pathNotFound: false,
      branch, empty, head, clean, remote };
  } catch (error) {
    return fail(codeOf(error));
  } finally {
    // An assessment commit that does not answer ok (it placed nothing, or its placement re-check failed)
    // removes the grant its own prepare installed (this request still owns that prepare's lock), never
    // another request's (1.0.3).
    if ((assessment || (project && !reopened)) && !placed) {
      try { if (readOwner(lockOf(r))?.owner === r.uuid) removeFile(grantOf(r)); } catch { /* release, or the TTL */ }
    }
    // Last act on every outcome.
    try { releaseOwnLock(r); } catch { /* stale at the next prepare */ }
  }
}

function refresh(r) {
  const folder = folderOf(r);
  // An assessment's F is found only through real directories (E1-6): a <root>/projects or W that
  // is anything else never gets a grant beside it.
  if (wrapped(r) && ['bad-parent', 'foreign'].includes(wrapperState(r))) return fail('folder_conflict');
  const existing = cloneStat(r);
  // Never hand a folder bound to another repository a grant for this route, nor a project grant to a folder
  // another class placed (1.0.4).
  if (existing && (!existing.isDirectory() || !bindingMatches(folder, r)
    || (r.class === PROJECT_CLASS && !projectMarked(folder)))) return fail('folder_conflict');
  installGrant(r);
  writeWrapper();
  return { ok: true, state: 'refreshed' };
}

function release(r) {
  let ok = true;
  const attempt = (fn) => { try { fn(); } catch { ok = false; } };
  attempt(() => { if (stagingRootOf(r)) removeTree(r.staging); });
  attempt(() => releaseOwnLock(r));
  attempt(() => { if (!cloneStat(r)) removeFile(grantOf(r)); });
  attempt(() => removeFile(requestFileOf(r)));
  attempt(() => removeFile(r.incoming));
  return ok ? { ok: true } : fail('workspace_failed');
}

/**
 * Module entry (§9.4 test seam): `testOptions = {sslCAInfo, proxy}` adds
 * `-c http.sslCAInfo=… -c http.proxy=…` to every network git command. The CLI entry below
 * never passes it.
 */
export async function runKernel(phase, requestPath, testOptions) {
  try {
    const seam = readSeam(testOptions);
    const r = readRequest(phase, requestPath);
    if (phase === 'prepare') return await prepare(r, seam);
    if (phase === 'commit') return await commit(r);
    if (phase === 'refresh') return refresh(r);
    return release(r);
  } catch (error) {
    return fail(codeOf(error));
  }
}

async function main(argv) {
  let result;
  try {
    result = argv.length === 2 ? await runKernel(argv[0], argv[1]) : fail('workspace_failed');
  } catch {
    result = fail('workspace_failed');
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.ok ? 0 : 2;
}

function invokedDirectly() {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (invokedDirectly()) await main(process.argv.slice(2));
