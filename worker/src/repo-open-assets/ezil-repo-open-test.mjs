// Kernel tests (contract universe-repo-open-v1 §9, LANES O1b): real git, real filesystem.
//
//   node worker/src/repo-open-assets/ezil-repo-open-test.mjs
//
// The kernel's paths are fixed (/run/ezil/...), and this host may have its own /run/ezil.
// So the suite re-executes itself under `unshare --mount --net` (needs root): a private tmpfs
// on /run and on /tmp, and a network namespace whose only interface is loopback. Nothing
// is written to the host's /run or /tmp, and no packet can leave (an un-proxied git call
// fails locally instead of reaching git-preview.ezil.work).
//
// Network git goes through the kernel's module seam (runKernel(…, {sslCAInfo, proxy}), §9.4):
// a loopback CONNECT proxy in front of a loopback TLS server presenting git-preview.ezil.work
// under a CA generated here with openssl, in front of `git http-backend` behind Basic auth.
// commit, refresh and release run through the real CLI entry, exactly as the Worker runs them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SOURCE_KERNEL = path.join(HERE, 'ezil-repo-open.mjs');
export const SOURCE_HELPER = path.join(HERE, 'ezil-git-grant.mjs');
const VECTORS_PATH = path.join(HERE, '../../../docs/contracts/universe-repo-open-v1.vectors.json');
export const VECTORS_SHA256 = '89a38b35f7927c3163c52dec0d0794055b0eb837edb626ffe674301f276ae711';
export const KERNEL_PATH = '/run/ezil/bin/ezil-repo-open.mjs';
export const HELPER_PATH = '/run/ezil/bin/ezil-git-grant.mjs';
export const WRAPPER_PATH = '/run/ezil/bin/ezil-git-grant';
export const GIT_HOST = 'git-preview.ezil.work';
/** The git host of request class `assessment` (contract 1.0.3, vectors constants GIT_ASSESSMENT_HOST). */
export const QA_HOST = 'git-qa.ezil.work';
const ISOLATED_FLAG = '--isolated-namespace';

// ── vectors ─────────────────────────────────────────────────────────────────

export function loadVectors() {
  const bytes = fs.readFileSync(VECTORS_PATH);
  assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), VECTORS_SHA256, 'vectors sha256 differs from the pinned value');
  return JSON.parse(bytes.toString('utf8'));
}
export const expand = (s) => String(s).replace(/\$\{repeat:(.):(\d+)\}/g, (_, c, n) => c.repeat(Number(n)));
export const newToken = () => `egg_${crypto.randomBytes(32).toString('hex')}`;

// ── isolation ───────────────────────────────────────────────────────────────

const HOST_MARKERS = ['bin', 'git', 'requests'];
/**
 * Re-exec `selfPath` in a private mount + network namespace and exit with its status. Inside
 * (returns true): tmpfs on /run and /tmp, loopback up, and proof that the namespaces differ.
 */
export function isolate(selfPath) {
  if (process.argv.includes(ISOLATED_FLAG)) {
    const parent = JSON.parse(process.argv[process.argv.indexOf(ISOLATED_FLAG) + 1]);
    assert.notEqual(fs.readlinkSync('/proc/self/ns/mnt'), parent.mnt, 'not in a private mount namespace');
    assert.notEqual(fs.readlinkSync('/proc/self/ns/net'), parent.net, 'not in a private network namespace');
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'mode=0755', 'tmpfs', '/run']);
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'mode=1777', 'tmpfs', '/tmp']);
    execFileSync('ip', ['link', 'set', 'lo', 'up']);
    // util-linux mount may create /run/mount/utab; nothing of the host's /run is visible.
    assert.ok(fs.readdirSync('/run').every((name) => name === 'mount'), '/run is not the private tmpfs');
    return true;
  }
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) {
    console.error('FAIL: this suite needs root (unshare --mount --net, uid-0 grant files). Run it with sudo.');
    process.exit(1);
  }
  const hostBefore = HOST_MARKERS.filter((m) => fs.existsSync(`/run/ezil/${m}`));
  // The r56 tests overmount /etc inside the private namespace only; the host's /etc/gitconfig never changes.
  const etcGitconfig = () => { try { return crypto.createHash('sha256').update(fs.readFileSync('/etc/gitconfig')).digest('hex'); } catch { return 'absent'; } };
  const etcBefore = etcGitconfig();
  const parent = JSON.stringify({ mnt: fs.readlinkSync('/proc/self/ns/mnt'), net: fs.readlinkSync('/proc/self/ns/net') });
  const result = spawnSync('unshare', ['--mount', '--net', '--propagation', 'private', process.execPath, selfPath, ISOLATED_FLAG, parent],
    { stdio: 'inherit' });
  const hostAfter = HOST_MARKERS.filter((m) => fs.existsSync(`/run/ezil/${m}`));
  if (JSON.stringify(hostBefore) !== JSON.stringify(hostAfter)) {
    console.error(`FAIL: the host /run/ezil changed (${JSON.stringify(hostBefore)} -> ${JSON.stringify(hostAfter)})`);
    process.exit(1);
  }
  if (etcGitconfig() !== etcBefore) {
    console.error(`FAIL: the host /etc/gitconfig changed (${etcBefore} -> ${etcGitconfig()})`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

// ── runner ──────────────────────────────────────────────────────────────────

export async function runSuite(name, tests) {
  let passed = 0, failed = 0;
  for (const [title, fn] of tests) {
    try {
      await fn();
      passed += 1;
      console.log(`  pass  ${title}`);
    } catch (error) {
      failed += 1;
      console.log(`  FAIL  ${title}\n        ${String(error && error.stack || error).split('\n').slice(0, 6).join('\n        ')}`);
    }
  }
  console.log(`${name}: ${passed} pass, ${failed} fail, ${tests.length} total`);
  return failed === 0 && passed === tests.length;
}

// ── fixtures: CA, TLS git server, CONNECT proxy ─────────────────────────────

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts }).toString('utf8');
const USER_ENV = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/tmp/userhome', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };

export function makeCa(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const f = (n) => path.join(dir, n);
  const ec = ['-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes'];
  sh('openssl', ['req', '-x509', ...ec, '-keyout', f('ca.key'), '-out', f('ca.pem'), '-days', '2', '-subj', '/CN=EZiL repo-open test CA',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign']);
  sh('openssl', ['req', ...ec, '-keyout', f('leaf.key'), '-out', f('leaf.csr'), '-subj', `/CN=${GIT_HOST}`]);
  fs.writeFileSync(f('leaf.ext'), `subjectAltName=DNS:${GIT_HOST},DNS:${QA_HOST}\nextendedKeyUsage=serverAuth\n`);
  sh('openssl', ['x509', '-req', '-in', f('leaf.csr'), '-CA', f('ca.pem'), '-CAkey', f('ca.key'), '-CAcreateserial',
    '-out', f('leaf.pem'), '-days', '2', '-extfile', f('leaf.ext')]);
  // A second, unrelated CA: a client trusting only it must fail TLS.
  sh('openssl', ['req', '-x509', ...ec, '-keyout', f('other.key'), '-out', f('other.pem'), '-days', '2', '-subj', '/CN=Unrelated CA']);
  return { ca: f('ca.pem'), otherCa: f('other.pem'), key: fs.readFileSync(f('leaf.key')), cert: fs.readFileSync(f('leaf.pem')) };
}

/** HTTPS `git http-backend` (CGI) behind Basic auth `ezil:<state.token>`. mode: ok | 403 | 404 | hang. */
export function startGitServer({ key, cert, projectRoot }) {
  const state = { token: null, mode: 'ok', requests: 0 };
  const server = https.createServer({ key, cert }, (req, res) => {
    state.requests += 1;
    if (state.mode === 'hang') return;
    const url = new URL(req.url, `https://${GIT_HOST}`);
    if (state.mode === '404') { res.writeHead(404); res.end('not found\n'); return; }
    const expected = `Basic ${Buffer.from(`ezil:${state.token}`).toString('base64')}`;
    if (!state.token || req.headers.authorization !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="git"' });
      res.end('unauthorized\n');
      return;
    }
    if (state.mode === '403') { res.writeHead(403); res.end('forbidden\n'); return; }
    const env = { PATH: USER_ENV.PATH, HOME: '/tmp/srvhome', GIT_CONFIG_NOSYSTEM: '1', GIT_PROJECT_ROOT: projectRoot,
      GIT_HTTP_EXPORT_ALL: '1', PATH_INFO: url.pathname, QUERY_STRING: url.search.slice(1), REQUEST_METHOD: req.method,
      CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'ezil', REMOTE_ADDR: '127.0.0.1',
      ...(req.headers['content-length'] ? { CONTENT_LENGTH: req.headers['content-length'] } : {}),
      ...(req.headers['git-protocol'] ? { GIT_PROTOCOL: req.headers['git-protocol'] } : {}),
      ...(req.headers['content-encoding'] ? { HTTP_CONTENT_ENCODING: req.headers['content-encoding'] } : {}) };
    const cgi = spawn('git', ['http-backend'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    req.pipe(cgi.stdin);
    let head = Buffer.alloc(0), headersDone = false;
    cgi.stdout.on('data', (chunk) => {
      if (headersDone) { res.write(chunk); return; }
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      headersDone = true;
      let status = 200;
      const headers = {};
      for (const line of head.subarray(0, end).toString('latin1').split('\r\n')) {
        const i = line.indexOf(':');
        const k = line.slice(0, i).trim(), v = line.slice(i + 1).trim();
        if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers);
      res.write(head.subarray(end + 4));
    });
    cgi.on('close', () => res.end());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, port: server.address().port, close: () => server.close() })));
}

/** Loopback CONNECT proxy: only `git-preview.ezil.work:443` and `git-qa.ezil.work:443` reach the TLS server; every CONNECT is counted. */
export function startProxy(tlsPort) {
  const state = { connects: [], mode: 'ok' };
  const server = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  server.on('connect', (req, socket, head) => {
    state.connects.push(req.url);
    if (state.mode !== 'ok' || ![`${GIT_HOST}:443`, `${QA_HOST}:443`].includes(req.url)) {
      socket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      return;
    }
    const upstream = net.connect(tlsPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ state, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

/** Everything the TLS gateway serves, under one project root. */
export async function startFixtures() {
  const tmp = fs.mkdtempSync('/tmp/fixtures-');
  const tls = makeCa(path.join(tmp, 'tls'));
  const projectRoot = path.join(tmp, 'srv');
  fs.mkdirSync(projectRoot);
  const server = await startGitServer({ key: tls.key, cert: tls.cert, projectRoot });
  const proxy = await startProxy(server.port);
  return { tmp, tls, projectRoot, server, proxy, seam: { sslCAInfo: tls.ca, proxy: proxy.url } };
}

/** A bare repository acme/site.git on the server; `seed(work)` may commit into a work tree pushed to it. */
export function makeRemote(fx, { handle = 'acme', name = 'site', head = 'main', branches = {} } = {}) {
  const bare = path.join(fx.projectRoot, handle, `${name}.git`);
  fs.rmSync(bare, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(bare), { recursive: true });
  sh('git', ['init', '-q', '--bare', '-b', head, bare], { env: USER_ENV });
  sh('git', ['-C', bare, 'config', 'http.receivepack', 'true'], { env: USER_ENV });
  const names = Object.keys(branches);
  if (names.length) {
    const work = fs.mkdtempSync('/tmp/seed-');
    sh('git', ['init', '-q', '-b', names[0], work], { env: USER_ENV });
    for (const branch of names) {
      if (branch !== names[0]) sh('git', ['-C', work, 'checkout', '-q', '-B', branch], { env: USER_ENV });
      for (const [file, body] of Object.entries(branches[branch])) {
        fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
        fs.writeFileSync(path.join(work, file), body);
        sh('git', ['-C', work, 'add', '--', file], { env: USER_ENV });
        sh('git', ['-C', work, '-c', 'user.name=Seed', '-c', 'user.email=seed@example.invalid', 'commit', '-q', '-m', `${branch}: ${file}`], { env: USER_ENV });
      }
    }
    sh('git', ['-C', work, 'push', '-q', bare, ...names.map((b) => `refs/heads/${b}:refs/heads/${b}`)], { env: USER_ENV });
    fs.rmSync(work, { recursive: true, force: true });
  }
  return bare;
}

// ── computer-side state (what the Worker sets up, §8 steps 6-7) ─────────────

export const RUN_DIRS = ['/run/ezil', '/run/ezil/bin', '/run/ezil/git', '/run/ezil/git/grants', '/run/ezil/git/incoming', '/run/ezil/requests', '/run/ezil/locks'];
export const DEFAULT_BUDGET = { limitBytes: 536870912, maxEntries: 100000, fraction: 0.8 };
export const REPO_ID = '3f2b8c1a-9d4e-4f6a-8b7c-1d2e3f4a5b6c';
export const OTHER_REPO_ID = '5a6b7c8d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

/** Fresh /run/ezil with the kernel and helper installed as the Worker installs them. */
export function resetRun() {
  fs.rmSync('/run/ezil', { recursive: true, force: true });
  for (const dir of RUN_DIRS) fs.mkdirSync(dir, { mode: 0o700 });
  for (const [from, to] of [[SOURCE_KERNEL, KERNEL_PATH], [SOURCE_HELPER, HELPER_PATH]]) {
    fs.copyFileSync(from, to);
    fs.chmodSync(to, 0o500);
  }
}

export function newRoot() {
  const root = fs.realpathSync(fs.mkdtempSync('/tmp/workspace-'));
  return root;
}

export function writeIncoming(uuid, { token, handle = 'acme', name = 'site', host = GIT_HOST, expiresAt = new Date(Date.now() + 900000).toISOString(), scope = 'write', extra = {} }) {
  const file = `/run/ezil/git/incoming/${uuid}.json`;
  fs.writeFileSync(file, JSON.stringify({ v: 1, protocol: 'https', host, path: `${handle}/${name}.git`, username: 'ezil', password: token, expiresAt, scope, ...extra }), { mode: 0o600 });
  return file;
}

export function writeRequest(fields) {
  const { op = 'open', phase, uuid, inflight = [uuid], repositoryId = REPO_ID, handle = 'acme', name = 'site', gitHost = GIT_HOST,
    defaultBranch = 'main', path: relPath = null, root, deadlineMs = Date.now() + 105000, budget = DEFAULT_BUDGET, extra = {}, omit = [], cls } = fields;
  const request = { v: 1, op, phase, uuid, inflight, repositoryId, handle, name, gitHost, defaultBranch, path: relPath, root,
    staging: `${root}/.ezil-staging/${uuid}`, incoming: `/run/ezil/git/incoming/${uuid}.json`, deadlineMs, budget,
    ...(cls === undefined ? {} : { class: cls }), ...extra };
  for (const key of omit) delete request[key];
  const file = `/run/ezil/requests/${uuid}.json`;
  fs.writeFileSync(file, JSON.stringify(request), { mode: 0o600 });
  return file;
}

let kernelModule;
export async function kernel() {
  kernelModule ??= await import(pathToFileURL(KERNEL_PATH).href);
  return kernelModule;
}

/** The CLI entry exactly as the Worker runs it: `node <kernel> <phase> <request>`. */
export function cli(phase, requestPath, env = { PATH: USER_ENV.PATH }) {
  const r = spawnSync(process.execPath, [KERNEL_PATH, phase, requestPath], { env, encoding: 'utf8' });
  const lines = r.stdout.split('\n').filter(Boolean);
  return { result: lines.length ? JSON.parse(lines.at(-1)) : null, stdout: r.stdout, stderr: r.stderr, status: r.status, lines };
}

/** One Worker-shaped open: prepare (module seam) → commit (CLI) → release (CLI). */
export async function openFlow(fx, { root, uuid = crypto.randomUUID(), token, inflight, skipCommit = false, ...fields }) {
  writeIncoming(uuid, { token, handle: fields.handle, name: fields.name, host: fields.gitHost });
  const prepared = await (await kernel()).runKernel('prepare', writeRequest({ ...fields, phase: 'prepare', uuid, inflight: inflight ?? [uuid], root }), fx.seam);
  let committed = null;
  if (prepared.ok && !skipCommit) committed = cli('commit', writeRequest({ ...fields, phase: 'commit', uuid, inflight: inflight ?? [uuid], root })).result;
  const released = cli('release', writeRequest({ ...fields, phase: 'release', uuid, inflight: inflight ?? [uuid], root })).result;
  return { uuid, prepared, committed, released };
}

/**
 * A child process that may talk to the in-process proxy and TLS server. Always async: a
 * synchronous spawn would block the very event loop that serves it.
 */
export function spawnAsync(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const out = [], err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', (e) => resolve({ status: null, stdout: '', stderr: String(e) }));
    child.on('close', (status) => resolve({ status, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
    child.stdin.end(input ?? '');
  });
}
export const userGit = (fx, cwd, args, extraEnv = {}) => spawnAsync('git', ['-c', `http.sslCAInfo=${fx.tls.ca}`, '-c', `http.proxy=${fx.proxy.url}`,
  '-c', 'user.name=User', '-c', 'user.email=user@example.invalid', ...args], { cwd, env: { ...USER_ENV, ...extraEnv } });

/** Every file under `dir` (path, mode, sha256 or link target), optionally excluding some relative paths. */
export function manifest(dir, exclude = []) {
  const out = [];
  const visit = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const a = path.join(abs, name), r = rel ? `${rel}/${name}` : name;
      if (exclude.includes(r)) continue;
      const st = fs.lstatSync(a);
      if (st.isSymbolicLink()) out.push(`${r} link ${fs.readlinkSync(a)}`);
      else if (st.isDirectory()) { out.push(`${r}/ ${st.mode & 0o7777}`); visit(a, r); }
      else out.push(`${r} ${st.mode & 0o7777} ${crypto.createHash('sha256').update(fs.readFileSync(a)).digest('hex')}`);
    }
  };
  visit(dir, '');
  return out;
}

/** vectors gitConfig.match: the expected lines in order; only core.* before them; branch.* anywhere; no other remote/credential/url line. */
export function gitConfigMatches(lines, expected) {
  let i = 0;
  for (const line of lines) {
    if (i < expected.length && line === expected[i]) { i += 1; continue; }
    const key = line.slice(0, line.indexOf('='));
    if (/^(remote|credential|url)\./.test(key)) return false;
    if (i === 0 && !key.startsWith('core.')) return false;
    if (i > 0 && !key.startsWith('branch.')) return false;
  }
  return i === expected.length;
}
export const localConfig = (dir) => sh('git', ['-C', dir, 'config', '--local', '--list'], { env: USER_ENV }).split('\n').filter(Boolean);
const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** A git index in `dir` listing exactly `paths` (empty-blob entries: no file content is hashed, so 450 MiB sparse files stay cheap). */
export function indexOnly(dir, paths) {
  sh('git', ['-C', dir, 'init', '-q'], { env: USER_ENV });
  const blob = execFileSync('git', ['-C', dir, 'hash-object', '-w', '--stdin'], { env: USER_ENV, input: '' }).toString('utf8').trim();
  for (const p of paths) sh('git', ['-C', dir, 'update-index', '--add', '--cacheinfo', `100644,${blob},${p}`], { env: USER_ENV });
}

/** vectors repoBudget.workspaceCases: every entry on disk (sparse files), the bindings, and real indexes. */
export function buildWorkspaceCase(root, c) {
  const realIndexes = new Set(Object.keys(c.indexes).map((f) => `${f ? `${f}/` : ''}.git/index`));
  for (const e of [...c.entries].sort((a, b) => a.name.split('/').length - b.name.split('/').length)) {
    const abs = `${root}/${e.name}`;
    if (realIndexes.has(e.name)) continue; // git writes the real one below
    if (e.type === 'dir') fs.mkdirSync(abs);
    else if (e.type === 'file') { const fd = fs.openSync(abs, 'wx'); fs.ftruncateSync(fd, e.size); fs.closeSync(fd); }
    else if (e.type === 'symlink') fs.symlinkSync(e.linkname, abs);
    else if (e.type === 'fifo') execFileSync('mkfifo', [abs]);
    else throw new Error(`entry type ${e.type}`);
  }
  for (const [folder, binding] of Object.entries(c.markers)) fs.writeFileSync(`${root}/${folder}/.git/ezil-repo.json`, `${JSON.stringify(binding)}\n`);
  for (const [folder, paths] of Object.entries(c.indexes)) indexOnly(folder ? `${root}/${folder}` : root, paths);
}
const lockOf =(handle = 'acme', name = 'site') => `/run/ezil/locks/${handle}__${name}`;
const grantOf = (handle = 'acme', name = 'site') => `/run/ezil/git/grants/${handle}__${name}.json`;
function plantLock(owner, ageMs = 0, handle, name) {
  const lock = lockOf(handle, name);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(`${lock}/owner`, owner);
  if (ageMs) { const t = (Date.now() - ageMs) / 1000; fs.utimesSync(`${lock}/owner`, t, t); }
}
function assertNoOpenLeftovers(root, uuid, { handle = 'acme', name = 'site', wrapper = null } = {}) {
  assert.equal(exists(`${root}/.ezil-staging/${uuid}`), false, 'staging dir left behind');
  assert.equal(exists(lockOf(handle, name)), false, 'lock left behind');
  assert.equal(exists(`${root}/repos/${handle}/${name}`), false, 'folder created');
  if (wrapper) assert.equal(exists(wrapper), false, 'assessment wrapper created');
  assert.equal(exists(grantOf(handle, name)), false, 'grant left for an absent folder');
  assert.equal(exists(`/run/ezil/requests/${uuid}.json`), false, 'request file left behind');
  assert.equal(exists(`/run/ezil/git/incoming/${uuid}.json`), false, 'incoming file left behind');
}

// ── tests ───────────────────────────────────────────────────────────────────

async function main() {
  const V = loadVectors();
  const fx = await startFixtures();
  fs.mkdirSync('/tmp/userhome', { recursive: true });
  const expectedConfig = V.gitConfig.expectLocalList;
  // vectors gitConfig.branchUpstream (1.0.1), for any branch: its example is `main`.
  const upstream = V.gitConfig.branchUpstream;
  const upstreamLines = (branch) => upstream.lines.map((line) => line.replace(`branch.${upstream.example.branch}.`, `branch.${branch}.`)
    .replace(`=refs/heads/${upstream.example.branch}`, `=refs/heads/${branch}`));
  const nonCore = (dir) => localConfig(dir).filter((line) => !line.startsWith('core.'));
  const tests = [];
  const test = (title, fn) => tests.push([title, async () => { resetRun(); fx.server.state.mode = 'ok'; fx.proxy.state.mode = 'ok'; await fn(); }]);

  test('empty remote: prepare → initialized_empty; commit puts it in place; the first push creates refs/heads/<defaultBranch>', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx);
    const { uuid, prepared, committed, released } = await openFlow(fx, { root, token });
    assert.deepEqual(prepared, { ok: true, state: 'initialized_empty', folder: `${root}/repos/acme/site`, openFolder: `${root}/repos/acme/site`, pathNotFound: false, branch: 'main', empty: true });
    assert.deepEqual(committed, { ok: true, state: 'initialized_empty', folder: `${root}/repos/acme/site`, openFolder: `${root}/repos/acme/site`, pathNotFound: false, branch: 'main', empty: true });
    assert.deepEqual(released, { ok: true });
    const F = `${root}/repos/acme/site`;
    assert.ok(gitConfigMatches(localConfig(F), expectedConfig), `git config differs from vectors gitConfig:\n${localConfig(F).join('\n')}`);
    // Exactly the §9.5 list, then the unborn branch's upstream (vectors gitConfig.branchUpstream, verbatim for `main`).
    assert.deepEqual(upstreamLines('main'), upstream.lines);
    assert.deepEqual(nonCore(F), [...expectedConfig, ...upstream.lines], `git config:\n${localConfig(F).join('\n')}`);
    assert.equal(exists(lockOf()), false); assert.equal(exists(`${root}/.ezil-staging/${uuid}`), false);
    assert.equal(fs.statSync(grantOf()).mode & 0o777, 0o600);
    assert.equal(fs.statSync(WRAPPER_PATH).mode & 0o777, 0o500);
    fs.writeFileSync(`${F}/README.md`, '# site\n');
    assert.equal((await userGit(fx, F, ['add', 'README.md'])).status, 0);
    assert.equal((await userGit(fx, F, ['commit', '-q', '-m', 'first'])).status, 0);
    const push = await userGit(fx, F, ['push', '-q']);
    assert.equal(push.status, 0, push.stderr);
    assert.equal(sh('git', ['-C', bare, 'rev-parse', 'refs/heads/main'], { env: USER_ENV }).trim(), sh('git', ['-C', F, 'rev-parse', 'HEAD'], { env: USER_ENV }).trim());
  });

  test('initialized_empty: a plain `git push` creates refs/heads/<defaultBranch> on a git that ignores push.autosetupremote (< 2.37, e.g. the image\'s 2.34.1); reopen rewrites nothing', async () => {
    // A git that ignores push.autosetupremote is this host git (2.43) on a copy of the folder without
    // that key. (`-c push.autoSetupRemote=false` cannot simulate it: git only ever ORs that flag in, so
    // the repo-local `true` still wins.) The control copy also drops the upstream and must be refused.
    const copyWithout = (F, sections) => {
      const dir = fs.mkdtempSync('/tmp/old-git-');
      sh('cp', ['-a', `${F}/.`, dir]);
      for (const args of sections) sh('git', ['-C', dir, 'config', '--local', ...args], { env: USER_ENV });
      assert.equal(spawnSync('git', ['-C', dir, 'config', '--local', '--get', 'push.autosetupremote'], { env: USER_ENV }).status, 1);
      return dir;
    };
    for (const branch of ['main', 'release/1.0']) {
      resetRun();
      const root = newRoot(); const token = newToken(); fx.server.state.token = token;
      const bare = makeRemote(fx);
      const { committed } = await openFlow(fx, { root, token, defaultBranch: branch });
      const F = `${root}/repos/acme/site`;
      assert.deepEqual(committed, { ok: true, state: 'initialized_empty', folder: F, openFolder: F, pathNotFound: false, branch, empty: true }, branch);
      assert.equal(sh('git', ['-C', F, 'config', '--local', `branch.${branch}.remote`], { env: USER_ENV }).trim(), 'origin', branch);
      assert.equal(sh('git', ['-C', F, 'config', '--local', `branch.${branch}.merge`], { env: USER_ENV }).trim(), `refs/heads/${branch}`, branch);
      assert.deepEqual(nonCore(F), [...expectedConfig, ...upstreamLines(branch)], `${branch}: git config:\n${localConfig(F).join('\n')}`);
      fs.writeFileSync(`${F}/README.md`, '# site\n');
      assert.equal((await userGit(fx, F, ['add', 'README.md'])).status, 0);
      assert.equal((await userGit(fx, F, ['commit', '-q', '-m', 'first'])).status, 0);
      // Control: without the upstream too, the same plain push → "no upstream branch", nothing sent.
      const control = copyWithout(F, [['--unset', 'push.autosetupremote'], ['--remove-section', `branch.${branch}`]]);
      const requests = fx.server.state.requests;
      const refused = await userGit(fx, control, ['push']);
      assert.equal(refused.status, 128, `${branch}: control push exit ${refused.status}: ${refused.stderr}`);
      assert.match(refused.stderr, /has no upstream branch/, branch);
      assert.equal(fx.server.state.requests, requests, `${branch}: the control push reached the git server`);
      fs.rmSync(control, { recursive: true, force: true });
      // The kernel's config minus push.autosetupremote: plain `git push` creates the branch on the empty remote.
      const old = copyWithout(F, [['--unset', 'push.autosetupremote']]);
      const push = await userGit(fx, old, ['push']);
      assert.equal(push.status, 0, `${branch}: ${push.stderr}`);
      assert.match(push.stderr, new RegExp(`\\[new branch\\]\\s+${branch.replace('.', '\\.')} -> ${branch.replace('.', '\\.')}`), branch);
      assert.equal(sh('git', ['-C', bare, 'rev-parse', `refs/heads/${branch}`], { env: USER_ENV }).trim(), sh('git', ['-C', F, 'rev-parse', 'HEAD'], { env: USER_ENV }).trim(), branch);
      assert.equal(sh('git', ['-C', old, 'status', '-sb'], { env: USER_ENV }).split('\n')[0], `## ${branch}...origin/${branch}`, branch);
      fs.rmSync(old, { recursive: true, force: true });
      // Reopen → existing: .git/config is neither rewritten nor replaced; the upstream stays.
      const config = fs.readFileSync(`${F}/.git/config`);
      const ino = fs.statSync(`${F}/.git/config`).ino;
      const reopened = await openFlow(fx, { root, token: newToken(), defaultBranch: branch });
      assert.deepEqual(reopened.committed, { ok: true, state: 'existing', folder: F, openFolder: F, pathNotFound: false, branch, empty: false }, branch);
      assert.deepEqual(fs.readFileSync(`${F}/.git/config`), config, `${branch}: reopen rewrote .git/config`);
      assert.equal(fs.statSync(`${F}/.git/config`).ino, ino, branch);
    }
  });

  test('non-empty remote: full history, all branches fetched, checkout tracks the HEAD symref (not defaultBranch)', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { head: 'trunk', branches: { trunk: { 'a.txt': 'a', 'b.txt': 'b' }, main: { 'm.txt': 'm' }, feature: { 'f.txt': 'f' } } });
    const { committed } = await openFlow(fx, { root, token, defaultBranch: 'main' });
    const F = `${root}/repos/acme/site`;
    assert.deepEqual(committed, { ok: true, state: 'cloned', folder: F, openFolder: F, pathNotFound: false, branch: 'trunk', empty: false });
    assert.equal(sh('git', ['-C', F, 'symbolic-ref', 'HEAD'], { env: USER_ENV }).trim(), 'refs/heads/trunk');
    assert.equal(sh('git', ['-C', F, 'config', 'branch.trunk.merge'], { env: USER_ENV }).trim(), 'refs/heads/trunk');
    for (const b of ['trunk', 'main', 'feature']) {
      assert.equal(sh('git', ['-C', F, 'rev-parse', `refs/remotes/origin/${b}`], { env: USER_ENV }).trim(), sh('git', ['-C', bare, 'rev-parse', b], { env: USER_ENV }).trim());
    }
    assert.equal(sh('git', ['-C', F, 'rev-list', '--count', '--all'], { env: USER_ENV }).trim(), sh('git', ['-C', bare, 'rev-list', '--count', '--all'], { env: USER_ENV }).trim());
    assert.equal(sh('git', ['-C', F, 'rev-list', '--count', 'HEAD'], { env: USER_ENV }).trim(), sh('git', ['-C', bare, 'rev-list', '--count', 'trunk'], { env: USER_ENV }).trim());
    assert.equal(exists(`${F}/.git/shallow`), false);
    assert.ok(gitConfigMatches(localConfig(F), expectedConfig));
    assert.equal(fs.readFileSync(`${F}/a.txt`, 'utf8'), 'a');
  });

  test('defaultBranch is used when the remote HEAD names no branch it has, else the first branch', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { head: 'trunk', branches: { zeta: { 'z.txt': 'z' }, dev: { 'd.txt': 'd' } } });
    fs.writeFileSync(`${bare}/HEAD`, 'ref: refs/heads/missing\n');
    assert.equal((await openFlow(fx, { root, token, defaultBranch: 'dev' })).committed.branch, 'dev');
    const root2 = newRoot();
    assert.equal((await openFlow(fx, { root: root2, token, defaultBranch: 'main' })).committed.branch, 'dev');
  });

  test('reopen: existing; tree, index and refs byte-identical; zero network; stale credential keys repaired; grant and wrapper reinstalled', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    const F = `${root}/repos/acme/site`;
    fs.writeFileSync(`${F}/a.txt`, 'dirty');
    fs.writeFileSync(`${F}/untracked.txt`, 'untracked');
    fs.writeFileSync(`${F}/ahead.txt`, 'ahead');
    assert.equal((await userGit(fx, F, ['add', 'ahead.txt'])).status, 0);
    assert.equal((await userGit(fx, F, ['commit', '-q', '-m', 'ahead'])).status, 0);
    // A stale helper value (an older image's node path) must be rewritten.
    const cred = `credential.https://${GIT_HOST}`;
    sh('git', ['-C', F, 'config', '--replace-all', `${cred}.helper`, '!/usr/bin/node /old/helper.mjs', '^!'], { env: USER_ENV });
    assert.ok(!gitConfigMatches(localConfig(F), expectedConfig));
    fs.rmSync(grantOf()); fs.rmSync(WRAPPER_PATH);
    const before = manifest(F, ['.git/config']);
    const requestsBefore = fx.server.state.requests, connectsBefore = fx.proxy.state.connects.length;
    const token2 = newToken();
    const { prepared, committed, released } = await openFlow(fx, { root, token: token2 });
    assert.equal(prepared.state, 'existing');
    assert.deepEqual(committed, { ok: true, state: 'existing', folder: F, openFolder: F, pathNotFound: false, branch: 'main', empty: false });
    assert.deepEqual(released, { ok: true });
    assert.equal(fx.server.state.requests, requestsBefore, 'reopen reached the git server');
    assert.equal(fx.proxy.state.connects.length, connectsBefore, 'reopen opened a network connection');
    assert.deepEqual(manifest(F, ['.git/config']), before, 'tree, index or refs changed');
    assert.ok(gitConfigMatches(localConfig(F), expectedConfig), `not repaired:\n${localConfig(F).join('\n')}`);
    assert.equal(JSON.parse(fs.readFileSync(grantOf(), 'utf8')).password, token2);
    assert.ok(fs.readFileSync(WRAPPER_PATH, 'utf8').startsWith('#!/bin/sh\n'));
    // and the repaired helper really authenticates (fetch through the grant)
    fx.server.state.token = token2;
    assert.equal((await userGit(fx, F, ['fetch', '-q'])).status, 0);
  });

  test('reopen with matching credential keys rewrites nothing in .git/config', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    const F = `${root}/repos/acme/site`;
    const config = fs.readFileSync(`${F}/.git/config`);
    const st = fs.statSync(`${F}/.git/config`);
    await openFlow(fx, { root, token: newToken() });
    assert.deepEqual(fs.readFileSync(`${F}/.git/config`), config);
    assert.equal(fs.statSync(`${F}/.git/config`).ino, st.ino);
  });

  test('post-check (§9.4): a reopen whose .git/config carries userinfo or a grant-shaped value → workspace_failed, no grant installed, nothing printed; clean again → existing', async () => {
    const k = await kernel();
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    const F = `${root}/repos/acme/site`;
    const cleanUrl = `https://${GIT_HOST}/acme/site.git`;
    const planted = newToken();
    // One row per clause: userinfo plus a token (both), userinfo alone (the `@<gitHost>` clause),
    // a grant-shaped value with no userinfo (the egg_ pattern clause).
    for (const [label, key, value] of [
      ['userinfo and a token in remote.origin.url', 'remote.origin.url', `https://ezil:${planted}@${GIT_HOST}/acme/site.git`],
      ['userinfo without a token in remote.origin.url', 'remote.origin.url', `https://ezil@${GIT_HOST}/acme/site.git`],
      ['a grant-shaped value in another local key, no userinfo', 'ezil.note', planted],
    ]) {
      sh('git', ['-C', F, 'config', key, value], { env: USER_ENV });
      fs.rmSync(grantOf(), { force: true });
      const token2 = newToken();
      const requests = fx.server.state.requests, connects = fx.proxy.state.connects.length;
      const uuid = crypto.randomUUID(); writeIncoming(uuid, { token: token2 });
      assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root }), fx.seam)).state, 'existing', label);
      const run = cli('commit', writeRequest({ phase: 'commit', uuid, root }));
      assert.deepEqual(run.result, { ok: false, errorCode: 'workspace_failed' }, label);
      assert.equal(run.lines.length, 1, label);
      for (const out of [run.stdout, run.stderr]) {
        assert.equal(out.includes(planted), false, `${label}: the planted token was printed`);
        assert.equal(out.includes(token2), false, `${label}: the grant was printed`);
      }
      assert.equal(exists(grantOf()), false, `${label}: a grant was installed`);
      assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid, root })).result, { ok: true }, label);
      assert.equal(exists(`/run/ezil/git/incoming/${uuid}.json`), false, label);
      assert.equal(fx.server.state.requests, requests, `${label}: reached the git server`);
      assert.equal(fx.proxy.state.connects.length, connects, `${label}: opened a connection`);
      if (key === 'remote.origin.url') sh('git', ['-C', F, 'config', key, cleanUrl], { env: USER_ENV });
      else sh('git', ['-C', F, 'config', '--unset', key], { env: USER_ENV });
    }
    // control: the same reopen with the config clean again commits and installs the grant
    const token3 = newToken();
    const { committed } = await openFlow(fx, { root, token: token3 });
    assert.deepEqual(committed, { ok: true, state: 'existing', folder: F, openFolder: F, pathNotFound: false, branch: 'main', empty: false });
    assert.equal(JSON.parse(fs.readFileSync(grantOf(), 'utf8')).password, token3);
    assert.ok(gitConfigMatches(localConfig(F), expectedConfig), `config not restored:\n${localConfig(F).join('\n')}`);
  });

  test('different binding → folder_conflict; nothing installed or changed (prepare and commit)', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    const F = `${root}/repos/acme/site`;
    fs.rmSync(grantOf());
    const before = manifest(F);
    const { uuid, prepared, committed } = await openFlow(fx, { root, token, repositoryId: OTHER_REPO_ID });
    assert.deepEqual(prepared, { ok: false, errorCode: 'folder_conflict' });
    assert.equal(committed, null);
    assert.deepEqual(manifest(F), before);
    assert.equal(exists(grantOf()), false); assert.equal(exists(lockOf()), false);
    assert.equal(exists(`/run/ezil/git/incoming/${uuid}.json`), false);
    // commit's own binding check (a folder that appeared between prepare and commit)
    const u2 = crypto.randomUUID();
    writeIncoming(u2, { token });
    assert.deepEqual(cli('commit', writeRequest({ phase: 'commit', uuid: u2, root, repositoryId: OTHER_REPO_ID })).result, { ok: false, errorCode: 'folder_conflict' });
    assert.equal(exists(grantOf()), false);
    assert.deepEqual(manifest(F), before);
    // a folder with no binding at all, and a symlink at F, are conflicts too
    const root2 = newRoot();
    fs.mkdirSync(`${root2}/repos/acme/site`, { recursive: true });
    assert.deepEqual((await openFlow(fx, { root: root2, token })).prepared, { ok: false, errorCode: 'folder_conflict' });
    const root3 = newRoot();
    fs.mkdirSync(`${root3}/repos/acme`, { recursive: true });
    fs.symlinkSync(F, `${root3}/repos/acme/site`);
    assert.deepEqual((await openFlow(fx, { root: root3, token })).prepared, { ok: false, errorCode: 'folder_conflict' });
  });

  test('path: inside → openFolder; missing, a file, or a symlink escaping F → F with pathNotFound', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'src/main.ts': 'x', 'README.md': 'r' } } });
    const F = `${root}/repos/acme/site`;
    assert.deepEqual((await openFlow(fx, { root, token, path: 'src' })).committed, { ok: true, state: 'cloned', folder: F, openFolder: `${F}/src`, pathNotFound: false, branch: 'main', empty: false });
    fs.symlinkSync('/etc', `${F}/escape`);
    fs.symlinkSync('src', `${F}/inside-link`);
    for (const [p, open, notFound] of [['missing', F, true], ['README.md', F, true], ['escape', F, true], ['inside-link', `${F}/inside-link`, false], ['src', `${F}/src`, false]]) {
      const { committed } = await openFlow(fx, { root, token, path: p });
      assert.deepEqual([committed.openFolder, committed.pathNotFound], [open, notFound], p);
    }
  });

  test('refresh rewrites only /run files: workspace byte-identical, grant replaced, wrapper rewritten, no network', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    const before = manifest(root);
    const requests = fx.server.state.requests, connects = fx.proxy.state.connects.length;
    fs.writeFileSync(WRAPPER_PATH, '#!/bin/sh\nexit 1\n');
    const uuid = crypto.randomUUID(); const token2 = newToken();
    writeIncoming(uuid, { token: token2 });
    assert.deepEqual(cli('refresh', writeRequest({ op: 'refresh', phase: 'refresh', uuid, root })).result, { ok: true, state: 'refreshed' });
    assert.deepEqual(cli('release', writeRequest({ op: 'refresh', phase: 'release', uuid, root })).result, { ok: true });
    assert.deepEqual(manifest(root), before);
    assert.equal(JSON.parse(fs.readFileSync(grantOf(), 'utf8')).password, token2);
    assert.equal(fs.statSync(grantOf()).mode & 0o777, 0o600);
    assert.match(fs.readFileSync(WRAPPER_PATH, 'utf8'), /^#!\/bin\/sh\nexec '\/[^']+' \/run\/ezil\/bin\/ezil-git-grant\.mjs "\$@"\n$/);
    assert.equal(fs.statSync(WRAPPER_PATH).mode & 0o777, 0o500);
    assert.equal(fx.server.state.requests, requests); assert.equal(fx.proxy.state.connects.length, connects);
    // refresh never hands a grant to a folder bound to another repository
    const u2 = crypto.randomUUID();
    writeIncoming(u2, { token: newToken() });
    assert.deepEqual(cli('refresh', writeRequest({ op: 'refresh', phase: 'refresh', uuid: u2, root, repositoryId: OTHER_REPO_ID })).result, { ok: false, errorCode: 'folder_conflict' });
    assert.equal(JSON.parse(fs.readFileSync(grantOf(), 'utf8')).password, token2);
  });

  test('git < 2.28 fallback (injected version): init + symbolic-ref gives an unborn <defaultBranch>; ≥ 2.28 uses init -b', async () => {
    const k = await kernel();
    assert.deepEqual(k.gitInitCommands('develop', { major: 2, minor: 27 }), [['init', '-q'], ['symbolic-ref', 'HEAD', 'refs/heads/develop']]);
    assert.deepEqual(k.gitInitCommands('develop', { major: 2, minor: 28 }), [['init', '-q', '-b', 'develop']]);
    assert.deepEqual(k.gitInitCommands('develop', { major: 3, minor: 0 }), [['init', '-q', '-b', 'develop']]);
    assert.deepEqual(k.gitInitCommands('develop', null), [['init', '-q'], ['symbolic-ref', 'HEAD', 'refs/heads/develop']]);
    assert.deepEqual(k.parseGitVersion('git version 2.27.1\n'), { major: 2, minor: 27 });
    for (const version of [{ major: 2, minor: 27 }, { major: 2, minor: 43 }]) {
      const dir = fs.mkdtempSync('/tmp/init-');
      for (const args of k.gitInitCommands('develop', version)) {
        const r = await k.runGit(args, { cwd: dir, timeoutMs: 5000, seam: null });
        assert.equal(r.code, 0, r.stderr);
      }
      assert.equal(sh('git', ['-C', dir, 'symbolic-ref', 'HEAD'], { env: USER_ENV }).trim(), 'refs/heads/develop');
      assert.notEqual(spawnSync('git', ['-C', dir, 'rev-parse', '--verify', '-q', 'HEAD'], { env: USER_ENV }).status, 0);
    }
  });

  test('classification: 401 and 403 → git_auth_rejected, 404 → repository_unavailable, DNS / connect / TLS / proxy refusal → network_unavailable; each cleans up', async () => {
    const k = await kernel();
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const cases = [
      ['401 (gateway refuses the grant)', () => { fx.server.state.token = newToken(); }, {}, 'git_auth_rejected'],
      ['403', () => { fx.server.state.mode = '403'; }, {}, 'git_auth_rejected'],
      ['404', () => { fx.server.state.mode = '404'; }, {}, 'repository_unavailable'],
      ['DNS (proxy host does not resolve)', () => {}, { proxy: 'http://proxy.invalid:3128' }, 'network_unavailable'],
      ['connect refused', () => {}, { proxy: 'http://127.0.0.1:9' }, 'network_unavailable'],
      ['TLS (untrusted CA)', () => {}, { sslCAInfo: fx.tls.otherCa }, 'network_unavailable'],
      ['proxy refuses CONNECT', () => { fx.proxy.state.mode = 'refuse'; }, {}, 'network_unavailable'],
    ];
    for (const [label, arrange, seamOverride, code] of cases) {
      resetRun(); fx.server.state.mode = 'ok'; fx.proxy.state.mode = 'ok';
      const root = newRoot(); const token = newToken(); fx.server.state.token = token;
      arrange();
      const uuid = crypto.randomUUID();
      writeIncoming(uuid, { token });
      const result = await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root }), { ...fx.seam, ...seamOverride });
      assert.deepEqual(result, { ok: false, errorCode: code }, label);
      assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid, root })).result, { ok: true }, label);
      assertNoOpenLeftovers(root, uuid);
    }
    assert.equal(k.classifyGitFailure({ stderr: "fatal: unable to access 'https://git-preview.ezil.work/acme/site.git/': Could not resolve host: git-preview.ezil.work" }), 'network_unavailable');
    assert.equal(k.classifyGitFailure({ stderr: 'something else entirely' }), 'workspace_failed');
    assert.equal(k.classifyGitFailure({ stderr: '', timedOut: true }), 'workspace_busy');
  });

  test('over-budget remote → repository_too_large; nothing left in the root (content, PAX names and entry count all count)', async () => {
    const k = await kernel();
    const refuses = async (label, files, budget) => {
      resetRun();
      const root = newRoot(); const token = newToken(); fx.server.state.token = token;
      makeRemote(fx, { branches: { main: files } });
      const { uuid, prepared, released } = await openFlow(fx, { root, token, budget });
      assert.deepEqual(prepared, { ok: false, errorCode: 'repository_too_large' }, label);
      assert.deepEqual(released, { ok: true }, label);
      assertNoOpenLeftovers(root, uuid);
      assert.equal(exists(`${root}/repos`), false, label);
    };
    await refuses('content over the tar budget', { 'big.bin': crypto.randomBytes(96 * 1024).toString('base64') }, { limitBytes: 128 * 1024, maxEntries: 100000, fraction: 0.8 });
    await refuses('entry count', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}.txt`, ''])), { limitBytes: 536870912, maxEntries: 50, fraction: 0.8 });
    // Long (PAX) names: calibrate on a real clone so the budget sits between what the tree costs
    // WITHOUT PAX headers and what it costs with them; only the PAX term can refuse it.
    const files = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`dir/${'n'.repeat(120)}${i}.txt`, 'x']));
    resetRun();
    const calib = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: files } });
    assert.equal((await openFlow(fx, { root: calib, token })).committed.state, 'cloned');
    let withPax = k.TAR_ARCHIVE_TAIL_BYTES, withoutPax = k.TAR_ARCHIVE_TAIL_BYTES;
    const count = (abs, name) => {
      const st = fs.lstatSync(abs);
      const e = st.isSymbolicLink() ? { type: 'symlink', name, linkname: fs.readlinkSync(abs) } : st.isDirectory() ? { type: 'dir', name } : { type: 'file', name, size: st.size };
      withPax += k.entryTarBytes(e);
      withoutPax += 512 + (e.type === 'file' ? 512 * Math.ceil(e.size / 512) : 0);
      if (st.isDirectory()) for (const child of fs.readdirSync(abs)) count(`${abs}/${child}`, `${name}/${child}`);
    };
    count(`${calib}/repos`, 'repos');
    const limitBytes = Math.ceil((withPax + withoutPax) / 2 / 0.8);
    const gap = k.budgetLimits({ limitBytes, maxEntries: 100000, fraction: 0.8 }).maxBytes;
    assert.ok(withoutPax + 4096 < gap && gap + 4096 < withPax, `calibration: ${withoutPax} < ${gap} < ${withPax}`);
    await refuses('long PAX names', files, { limitBytes, maxEntries: 100000, fraction: 0.8 });
    // and the same remote fits a normal budget
    resetRun();
    const root = newRoot(); fx.server.state.token = token;
    assert.equal((await openFlow(fx, { root, token })).committed.state, 'cloned');
  });

  test('budget reference: every repoBudget.entryBytes, composite and case through the kernel functions', async () => {
    const k = await kernel();
    for (const e of V.repoBudget.entryBytes) {
      assert.equal(k.entryTarBytes({ type: e.type, name: expand(e.name), size: e.size, linkname: e.linkname === undefined ? '' : expand(e.linkname) }), e.expect, `${e.type} ${expand(e.name).slice(0, 30)}`);
    }
    for (const c of V.repoBudget.cases) {
      assert.equal(k.budgetOk(c.workspaceTarBytes, c.stagedTarBytes, c.workspaceEntries, c.stagedEntries, DEFAULT_BUDGET), c.ok, JSON.stringify(c));
    }
    // composite, measured on a real tree (workspace src/ + src/a.ts; staged README.md; repos and repos/acme absent)
    const K = V.repoBudget.composite;
    const root = newRoot(); const uuid = crypto.randomUUID();
    fs.mkdirSync(`${root}/src`); fs.writeFileSync(`${root}/src/a.ts`, 'a'.repeat(K.workspace[1].size));
    const staging = `${root}/.ezil-staging/${uuid}`;
    fs.mkdirSync(staging, { recursive: true }); fs.writeFileSync(`${staging}/README.md`, 'r'.repeat(K.staged[1].size));
    const m = k.measureBudget({ root, staging, handle: 'acme', name: 'site', budget: DEFAULT_BUDGET });
    assert.equal(m.workspaceTarBytes + m.stagedTarBytes + k.TAR_ARCHIVE_TAIL_BYTES, K.expectTarBytes);
    assert.equal(m.workspaceEntries + m.stagedEntries, K.expectEntries);
    assert.equal(m.ok, K.expectOk);
    // the staging subtree is never counted on the workspace side
    fs.writeFileSync(`${root}/.ezil-staging/other.bin`, 'x'.repeat(5000));
    assert.equal(k.measureBudget({ root, staging, handle: 'acme', name: 'site', budget: DEFAULT_BUDGET }).workspaceEntries, m.workspaceEntries);
  });

  test('budget workspace side (1.0.2): every repoBudget.workspaceCases case on a real filesystem with real git indexes; the kernel archives what the codec archives', async () => {
    const k = await kernel();
    assert.deepEqual(k.SNAPSHOT_INTERNAL_NAMES, V.constants.SNAPSHOT_INTERNAL_NAMES);
    assert.deepEqual(k.SNAPSHOT_CACHE_NAMES, V.constants.SNAPSHOT_CACHE_NAMES);
    assert.equal(k.SNAPSHOT_NESTED_INDEX_MAX, V.constants.SNAPSHOT_NESTED_INDEX_MAX);
    for (const c of V.repoBudget.workspaceCases) {
      const root = newRoot();
      buildWorkspaceCase(root, c);
      const names = [];
      k.walkArchived(root, (e) => { names.push(e.name); }, { tracked: () => k.codecTracked(root, { limitBytes: DEFAULT_BUDGET.limitBytes, scratch: '/tmp' }) });
      // git adds its own files under each index's .git; inside a .git path nothing is skipped, so they are archived too.
      const gitDirs = Object.keys(c.indexes).map((f) => (f ? `${f}/.git` : '.git'));
      const own = (n) => !gitDirs.some((g) => n.startsWith(`${g}/`));
      assert.deepEqual(names.filter(own).sort(), c.expectArchived.filter(own).sort(), c.case);
      for (const g of gitDirs) assert.ok(names.includes(`${g}/index`) && names.includes(`${g}/HEAD`), `${c.case}: ${g} contents archived`);
      for (const folder of Object.keys(c.markers)) assert.ok(names.includes(`${folder}/.git/ezil-repo.json`), `${c.case}: ${folder} binding archived`);
      const empty = fs.mkdtempSync('/tmp/empty-staging-');
      const m = k.measureBudget({ root, staging: empty, handle: 'zz', name: 'zz', budget: DEFAULT_BUDGET, scratch: '/tmp' });
      assert.equal(k.budgetOk(m.workspaceTarBytes, c.stagedTarBytes, m.workspaceEntries, c.stagedEntries, DEFAULT_BUDGET), c.expectOk, `${c.case}: verdict`);
    }
  });

  test('prepare (1.0.2): 450 MiB of untracked node_modules no longer refuses a small open; the same bytes in an ordinary directory, or as a tracked dist of a repo-open folder, still do; an unmarked clone\'s tracked dist does not count', async () => {
    const big = 471859200;
    const sparse = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const fd = fs.openSync(p, 'wx'); fs.ftruncateSync(fd, big); fs.closeSync(fd); };
    const trackedDist = (root, marked) => {
      const folder = `${root}/repos/acme/blog`;
      sparse(`${folder}/dist/app.js`);
      indexOnly(folder, ['dist/app.js']);
      if (marked) fs.writeFileSync(`${folder}/.git/ezil-repo.json`, `${JSON.stringify({ v: 1, repositoryId: OTHER_REPO_ID, handle: 'acme', name: 'blog', gitHost: GIT_HOST })}\n`);
    };
    const attempt = async (arrange) => {
      resetRun();
      const root = newRoot(); const token = newToken(); fx.server.state.token = token;
      arrange(root);
      makeRemote(fx, { branches: { main: { 'README.md': 'hi' } } });
      const flow = await openFlow(fx, { root, token });
      if (!flow.prepared.ok) assertNoOpenLeftovers(root, flow.uuid);
      // The private index copies live under /run/ezil and are always removed.
      assert.deepEqual(fs.readdirSync('/run/ezil').filter((n) => n.startsWith('repo-open-index-')), []);
      return flow;
    };
    assert.equal((await attempt((root) => sparse(`${root}/proj/node_modules/pkg/big.bin`))).committed?.state, 'cloned', 'untracked node_modules');
    assert.deepEqual((await attempt((root) => sparse(`${root}/proj/vendor/big.bin`))).prepared, { ok: false, errorCode: 'repository_too_large' }, 'ordinary directory');
    assert.deepEqual((await attempt((root) => trackedDist(root, true))).prepared, { ok: false, errorCode: 'repository_too_large' }, 'tracked dist, repo-open folder');
    assert.equal((await attempt((root) => trackedDist(root, false))).committed?.state, 'cloned', 'tracked dist, no binding');
    // An unreadable ROOT index fails the codec's whole capture: the kernel then counts every cache name.
    assert.deepEqual((await attempt((root) => { sparse(`${root}/node_modules/big.bin`); fs.mkdirSync(`${root}/.git`); fs.writeFileSync(`${root}/.git/index`, 'not an index'); })).prepared,
      { ok: false, errorCode: 'repository_too_large' }, 'unreadable root index');
  });

  test('deadline: already reached → workspace_busy before any action; a gateway that hangs past it → workspace_busy, cleaned up', async () => {
    const k = await kernel();
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const u1 = crypto.randomUUID(); writeIncoming(u1, { token });
    const reached = Date.now() + k.PREPARE_RESERVE_MS + k.CLEANUP_MARGIN_MS - 1;
    assert.deepEqual(await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid: u1, root, deadlineMs: reached }), fx.seam), { ok: false, errorCode: 'workspace_busy' });
    assert.equal(exists(lockOf()), false); assert.equal(exists(`/run/ezil/git/incoming/${u1}.json`), true, 'nothing consumed');
    fx.server.state.mode = 'hang';
    const u2 = crypto.randomUUID(); writeIncoming(u2, { token });
    const started = Date.now();
    const deadlineMs = started + k.PREPARE_RESERVE_MS + k.CLEANUP_MARGIN_MS + 1500;
    assert.deepEqual(await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid: u2, root, deadlineMs }), fx.seam), { ok: false, errorCode: 'workspace_busy' });
    assert.ok(Date.now() < deadlineMs - k.PREPARE_RESERVE_MS, 'the kernel must stop before the Worker exec timeout');
    assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid: u2, root })).result, { ok: true });
    assertNoOpenLeftovers(root, u2);
  });

  test('lock lifecycle: commit releases on success and failure; release removes staging, its own lock and the grant of an absent folder, never a foreign lock', async () => {
    const k = await kernel();
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    // success: prepare holds the lock; commit releases it
    const u1 = crypto.randomUUID(); writeIncoming(u1, { token });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid: u1, root }), fx.seam)).ok, true);
    assert.equal(fs.readFileSync(`${lockOf()}/owner`, 'utf8'), u1);
    assert.equal(cli('commit', writeRequest({ phase: 'commit', uuid: u1, root })).result.ok, true);
    assert.equal(exists(lockOf()), false);
    // failure: a folder that appears with another binding before commit → folder_conflict, lock released
    const root2 = newRoot();
    const u2 = crypto.randomUUID(); writeIncoming(u2, { token });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid: u2, root: root2 }), fx.seam)).ok, true);
    fs.mkdirSync(`${root2}/repos/acme/site`, { recursive: true });
    assert.deepEqual(cli('commit', writeRequest({ phase: 'commit', uuid: u2, root: root2 })).result, { ok: false, errorCode: 'folder_conflict' });
    assert.equal(exists(lockOf()), false);
    fs.rmSync(`${root2}/repos`, { recursive: true });
    // release: own staging + own lock + grant of the absent folder; request and incoming files
    const u3 = crypto.randomUUID(); writeIncoming(u3, { token });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid: u3, root: root2 }), fx.seam)).ok, true);
    assert.equal(exists(`${root2}/.ezil-staging/${u3}`), true); assert.equal(exists(grantOf()), true);
    assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid: u3, root: root2 })).result, { ok: true });
    assertNoOpenLeftovers(root2, u3);
    // release never removes a lock it does not own, nor the grant of a folder that exists
    const other = crypto.randomUUID(); plantLock(other);
    const u4 = crypto.randomUUID();
    assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid: u4, root: root2 })).result, { ok: true });
    assert.equal(fs.readFileSync(`${lockOf()}/owner`, 'utf8'), other);
    fs.rmSync(lockOf(), { recursive: true });
    fs.writeFileSync(grantOf(), '{}', { mode: 0o600 });
    assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid: crypto.randomUUID(), root })).result, { ok: true });
    assert.equal(exists(grantOf()), true, 'release removed the grant of an existing folder');
    // commit of a staged clone whose lock is owned by another uuid → workspace_busy, lock untouched
    const root3 = newRoot();
    const u5 = crypto.randomUUID(); writeIncoming(u5, { token });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid: u5, root: root3 }), fx.seam)).ok, true);
    const thief = crypto.randomUUID();
    fs.writeFileSync(`${lockOf()}/owner`, thief);
    assert.deepEqual(cli('commit', writeRequest({ phase: 'commit', uuid: u5, root: root3 })).result, { ok: false, errorCode: 'workspace_busy' });
    assert.equal(fs.readFileSync(`${lockOf()}/owner`, 'utf8'), thief);
    assert.equal(exists(`${root3}/repos/acme/site`), false);
  });

  test('lock staleness: owner not in inflight → broken; owner in inflight and young → workspace_busy; in inflight but older than LOCK_STALE_MS → broken', async () => {
    const k = await kernel();
    const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const other = crypto.randomUUID();
    for (const [label, inflightHasOwner, ageMs, expectOk] of [['not in inflight', false, 0, true], ['live', true, 0, false], ['stale by age', true, k.LOCK_STALE_MS + 60000, true]]) {
      resetRun();
      const root = newRoot();
      plantLock(other, ageMs);
      const uuid = crypto.randomUUID(); writeIncoming(uuid, { token });
      const inflight = inflightHasOwner ? [other, uuid] : [uuid];
      const result = await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, inflight }), fx.seam);
      if (expectOk) {
        assert.equal(result.ok, true, label);
        assert.equal(fs.readFileSync(`${lockOf()}/owner`, 'utf8'), uuid, label);
      } else {
        assert.deepEqual(result, { ok: false, errorCode: 'workspace_busy' }, label);
        assert.equal(fs.readFileSync(`${lockOf()}/owner`, 'utf8'), other, label);
        assert.equal(exists(`${root}/.ezil-staging/${uuid}`), false, label);
      }
    }
  });

  test('prepare removes leftovers whose uuid is not in inflight once older than LEFTOVER_MIN_AGE_MS; keeps in-flight ones and young ones (a request that entered the map after this snapshot)', async () => {
    const k = await kernel();
    assert.equal(k.LEFTOVER_MIN_AGE_MS, V.timeouts.WORKER_DEADLINE_MS);
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const gone = crypto.randomUUID(), kept = crypto.randomUUID(), young = crypto.randomUUID(), edge = crypto.randomUUID(), uuid = crypto.randomUUID();
    const files = (id) => [`${root}/.ezil-staging/${id}`, `/run/ezil/requests/${id}.json`, `/run/ezil/git/incoming/${id}.json`];
    const age = (id, ms) => { const t = (Date.now() - ms) / 1000; for (const p of files(id)) fs.utimesSync(p, t, t); };
    for (const id of [gone, kept, young, edge]) {
      fs.mkdirSync(`${root}/.ezil-staging/${id}/.git`, { recursive: true });
      fs.writeFileSync(`/run/ezil/requests/${id}.json`, '{}');
      fs.writeFileSync(`/run/ezil/git/incoming/${id}.json`, '{}');
    }
    age(gone, k.LEFTOVER_MIN_AGE_MS + 60000);
    age(kept, k.LEFTOVER_MIN_AGE_MS + 60000);
    age(edge, k.LEFTOVER_MIN_AGE_MS - 15000); // a concurrent request's files, well inside the window
    fs.mkdirSync(`${root}/.ezil-staging/not-a-uuid`);
    writeIncoming(uuid, { token });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, inflight: [kept, uuid] }), fx.seam)).ok, true);
    for (const p of files(gone)) assert.equal(exists(p), false, p);
    for (const p of [...files(kept), ...files(young), ...files(edge), `${root}/.ezil-staging/not-a-uuid`]) assert.equal(exists(p), true, p);
  });

  test('busy after prepare (Worker busy path: release without commit), then an immediate reopen succeeds', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const first = await openFlow(fx, { root, token, skipCommit: true });
    assert.equal(first.prepared.ok, true);
    assert.deepEqual(first.released, { ok: true });
    assertNoOpenLeftovers(root, first.uuid);
    const second = await openFlow(fx, { root, token });
    assert.equal(second.committed.state, 'cloned');
  });

  test('CLI entry: refuses a request carrying sslCAInfo, proxy or any unknown key (workspace_failed, no action); argv and request strictness', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const bad = [
      ['sslCAInfo key', { extra: { sslCAInfo: fx.tls.ca } }],
      ['proxy key', { extra: { proxy: fx.proxy.url } }],
      ['unknown key', { extra: { debug: true } }],
      ['missing key', { omit: ['budget'] }],
      ['phase mismatch', { phase: 'commit' }],
      ['refresh op on prepare', { op: 'refresh' }],
      ['path on refresh', { op: 'refresh', phase: 'refresh', path: 'src', argvPhase: 'refresh' }],
      ['uuid not in inflight', { inflight: [crypto.randomUUID()] }],
      ['foreign git host', { gitHost: 'github.ezil.work' }],
      ['bad branch', { defaultBranch: 'x.lock' }],
      ['bad name', { name: 'a..b' }],
      ['relative root', { root: 'workspace' }],
    ];
    for (const [label, { argvPhase = 'prepare', ...fields }] of bad) {
      const uuid = crypto.randomUUID(); writeIncoming(uuid, { token });
      const file = writeRequest({ phase: 'prepare', uuid, root, ...fields });
      const { result, lines } = cli(argvPhase, file);
      assert.deepEqual(result, { ok: false, errorCode: 'workspace_failed' }, label);
      assert.equal(lines.length, 1, label);
      assert.equal(exists(`${root}/.ezil-staging`), false, label);
      assert.equal(exists(lockOf()), false, label);
    }
    const uuid = crypto.randomUUID(); writeIncoming(uuid, { token });
    const file = writeRequest({ phase: 'prepare', uuid, root });
    assert.deepEqual(cli('prepare', file.replace('/run/ezil/requests', '/tmp')).result, { ok: false, errorCode: 'workspace_failed' });
    assert.deepEqual(cli('bogus', file).result, { ok: false, errorCode: 'workspace_failed' });
    const r = spawnSync(process.execPath, [KERNEL_PATH, 'prepare'], { encoding: 'utf8', env: { PATH: USER_ENV.PATH } });
    assert.deepEqual(JSON.parse(r.stdout.trim()), { ok: false, errorCode: 'workspace_failed' });
    // the module seam refuses unknown test options too
    assert.deepEqual(await (await kernel()).runKernel('prepare', file, { ...fx.seam, cwd: '/' }), { ok: false, errorCode: 'workspace_failed' });
  });

  test('CLI entry reads no environment: proxy and CA variables neither reach git nor change the outcome', async () => {
    assert.equal(fs.readFileSync(SOURCE_KERNEL, 'utf8').includes('process.env'), false, 'the kernel source names process.env');
    assert.equal(fs.readFileSync(SOURCE_HELPER, 'utf8').includes('process.env'), false, 'the helper source names process.env');
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const uuid = crypto.randomUUID(); writeIncoming(uuid, { token });
    const connects = fx.proxy.state.connects.length;
    const env = { PATH: USER_ENV.PATH, HTTPS_PROXY: fx.proxy.url, https_proxy: fx.proxy.url, ALL_PROXY: fx.proxy.url, GIT_SSL_CAINFO: fx.tls.ca,
      SSL_CERT_FILE: fx.tls.ca, GIT_CONFIG_PARAMETERS: `'http.proxy'='${fx.proxy.url}'`, GIT_CONFIG_GLOBAL: '/tmp/evil', HOME: '/tmp/userhome' };
    fs.writeFileSync('/tmp/evil', `[http]\n\tproxy = ${fx.proxy.url}\n\tsslCAInfo = ${fx.tls.ca}\n`);
    const { result } = cli('prepare', writeRequest({ phase: 'prepare', uuid, root }), env);
    // Without the seam the namespace has no route to git-preview.ezil.work at all.
    assert.deepEqual(result, { ok: false, errorCode: 'network_unavailable' });
    assert.equal(fx.proxy.state.connects.length, connects, 'an environment proxy reached git');
  });

  test('the grant never appears in .git/config, the folder, stdout, or any child process argv/environ (strace of every execve)', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a', 'b/c.txt': 'c' } } });
    const uuid = crypto.randomUUID(); writeIncoming(uuid, { token });
    const trace = `/tmp/trace-${uuid}.log`;
    const driver = `import { runKernel } from ${JSON.stringify(KERNEL_PATH)}; const [phase, request, ca, proxy] = process.argv.slice(1); process.stdout.write(JSON.stringify(await runKernel(phase, request, { sslCAInfo: ca, proxy })) + '\\n');`;
    const run = await spawnAsync('strace', ['-f', '-qq', '-v', '-s', '65535', '-e', 'trace=execve', '-o', trace, process.execPath, '--input-type=module', '-e', driver,
      'prepare', writeRequest({ phase: 'prepare', uuid, root }), fx.tls.ca, fx.proxy.url], { env: { PATH: USER_ENV.PATH } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).state, 'cloned');
    const commitRun = spawnSync('strace', ['-f', '-qq', '-v', '-s', '65535', '-e', 'trace=execve', '-o', `${trace}.commit`, process.execPath, KERNEL_PATH, 'commit',
      writeRequest({ phase: 'commit', uuid, root })], { encoding: 'utf8', env: { PATH: USER_ENV.PATH } });
    assert.equal(JSON.parse(commitRun.stdout.trim()).state, 'cloned');
    const log = fs.readFileSync(trace, 'utf8') + fs.readFileSync(`${trace}.commit`, 'utf8');
    assert.ok(/execve\("[^"]*git"/.test(log) && log.includes('ezil-git-grant') && /remote-https/.test(log), 'the trace did not cover git, its https remote helper and the credential helper');
    assert.equal(log.includes(token), false, 'the grant appeared in a child argv or environ');
    for (const out of [run.stdout, run.stderr, commitRun.stdout, commitRun.stderr]) assert.equal(out.includes(token), false);
    const F = `${root}/repos/acme/site`;
    const grep = spawnSync('grep', ['-rlF', '--', token, F], { encoding: 'utf8' });
    assert.equal(grep.status, 1, `token found in: ${grep.stdout}`);
    const config = fs.readFileSync(`${F}/.git/config`, 'utf8');
    for (const bad of V.gitConfig.forbiddenSubstrings) assert.equal(config.includes(bad), false, bad);
    assert.equal(sh('git', ['-C', F, 'remote', '-v'], { env: USER_ENV }).includes('@'), false);
    assert.ok(gitConfigMatches(localConfig(F), expectedConfig));
  });

  test('gitConfig: the vectors match rule accepts the clone shape and rejects extra remote/credential/url lines', async () => {
    const ok = ['core.bare=false', ...expectedConfig, 'branch.main.remote=origin', 'branch.main.merge=refs/heads/main'];
    assert.equal(gitConfigMatches(ok, expectedConfig), true);
    assert.equal(gitConfigMatches([...ok, 'url.https://x/.insteadof=https://git-preview.ezil.work/'], expectedConfig), false);
    assert.equal(gitConfigMatches([...ok, 'credential.helper=store'], expectedConfig), false);
    assert.equal(gitConfigMatches([...expectedConfig.slice(0, 2), expectedConfig[3], expectedConfig[2], ...expectedConfig.slice(4)], expectedConfig), false);
    assert.equal(gitConfigMatches(['user.name=x', ...expectedConfig], expectedConfig), false);
    const k = await kernel();
    assert.equal(expectedConfig[3], `credential.https://${GIT_HOST}.helper=${k.HELPER_CONFIG_VALUE}`);
  });

  test('vectors link.path cases through the kernel path check', async () => {
    const k = await kernel();
    for (const v of V.link.path.valid) assert.equal(k.pathProblem(expand(v)), null, v);
    for (const [value, raw] of V.link.path.invalid) {
      if (expand(value) !== expand(raw)) continue; // URL-encoding cases concern the link parser only
      assert.notEqual(k.pathProblem(expand(value)), null, JSON.stringify(value));
    }
  });

  // ── class assessment (contract 1.0.3) ────────────────────────────────────────
  const ASSESS = { gitHost: QA_HOST, cls: 'assessment' };
  /** E1-6 (vectors kernel.assessment.layoutRule): the wrapper W (the editor root) and the clone F = W/repository. */
  const wrapperOf = (root, id = REPO_ID) => `${root}/${V.constants.ASSESSMENT_DIR_TEMPLATE.replace('<repositoryId>', id)}`;
  const cloneOf = (root, id = REPO_ID) => `${wrapperOf(root, id)}/${V.constants.ASSESSMENT_CLONE_DIR_NAME}`;
  const QA_REMOTE = V.constants.ASSESSMENT_REMOTE_TEMPLATE.replace('<handle>', 'acme').replace('<name>', 'site');
  /** The assessment commit answer for W under `root` (kernel.assessment.resultOpenKeys), `fields` over a clean clone. */
  const assessed = (root, fields) => ({ ok: true, state: 'cloned', folder: wrapperOf(root), openFolder: wrapperOf(root), pathNotFound: false,
    branch: 'main', empty: false, head: null, clean: true, remote: QA_REMOTE, ...fields });
  const qaConfig = expectedConfig.map((l) => l.split(GIT_HOST).join(QA_HOST));
  const remoteHeadOf = (bare, branch = 'main') => sh('git', ['-C', bare, 'rev-parse', `refs/heads/${branch}`], { env: USER_ENV }).trim();
  const kernelCode = async (fn) => { try { return await fn(); } catch (e) { return e && e.code; } };

  test('class assessment (1.0.3): a git-qa.ezil.work clone of a non-empty repository → cloned, head = the remote commit (40 hex), clean; the repo-local config names git-qa; two pushes through the helper', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { branches: { main: { 'a.txt': 'a', 'src/b.txt': 'b' } } });
    const connects = fx.proxy.state.connects.length;
    const { prepared, committed, released } = await openFlow(fx, { root, token, ...ASSESS });
    const W = wrapperOf(root), F = cloneOf(root);
    assert.deepEqual(prepared, { ok: true, state: 'cloned', folder: W, openFolder: W, pathNotFound: false, branch: 'main', empty: false }, 'the prepare answer keeps its keys (its folder is W)');
    assert.deepEqual(committed, assessed(root, { head: remoteHeadOf(bare) }));
    assert.deepEqual(Object.keys(committed), V.kernel.assessment.resultOpenKeys);
    assert.match(committed.head, /^[0-9a-f]{40}$/);
    assert.deepEqual(released, { ok: true });
    const seen = fx.proxy.state.connects.slice(connects);
    assert.ok(seen.length > 0 && seen.every((c) => c === `${QA_HOST}:443`), `the clone went somewhere else: ${seen}`);
    assert.ok(gitConfigMatches(localConfig(F), qaConfig), `git config:\n${localConfig(F).join('\n')}`);
    assert.equal(localConfig(F).some((l) => l.includes(GIT_HOST)), false, 'the assessment folder names git-preview');
    assert.equal(JSON.parse(fs.readFileSync(grantOf(), 'utf8')).host, QA_HOST);
    assert.equal(fs.statSync(grantOf()).mode & 0o777, 0o600);
    assert.equal(JSON.parse(fs.readFileSync(`${F}/.git/ezil-repo.json`, 'utf8')).gitHost, QA_HOST);
    for (const n of [1, 2]) {
      fs.writeFileSync(`${F}/edit-${n}.txt`, `${n}\n`);
      assert.equal((await userGit(fx, F, ['add', `edit-${n}.txt`])).status, 0);
      assert.equal((await userGit(fx, F, ['commit', '-q', '-m', `edit ${n}`])).status, 0);
      const push = await userGit(fx, F, ['push', '-q']);
      assert.equal(push.status, 0, `push ${n}: ${push.stderr}`);
      assert.equal(remoteHeadOf(bare), sh('git', ['-C', F, 'rev-parse', 'HEAD'], { env: USER_ENV }).trim(), `push ${n} landed`);
    }
  });

  test('class assessment (1.0.3): an empty git-qa repository → initialized_empty, head null, clean true; the first plain push creates the branch', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx);
    const { committed } = await openFlow(fx, { root, token, ...ASSESS });
    const F = cloneOf(root);
    assert.deepEqual(committed, assessed(root, { state: 'initialized_empty', empty: true, head: null }));
    assert.deepEqual(nonCore(F), [...qaConfig, ...upstreamLines('main')]);
    fs.writeFileSync(`${F}/README.md`, '# site\n');
    assert.equal((await userGit(fx, F, ['add', 'README.md'])).status, 0);
    assert.equal((await userGit(fx, F, ['commit', '-q', '-m', 'first'])).status, 0);
    const push = await userGit(fx, F, ['push', '-q']);
    assert.equal(push.status, 0, push.stderr);
    assert.equal(remoteHeadOf(bare), sh('git', ['-C', F, 'rev-parse', 'HEAD'], { env: USER_ENV }).trim());
  });

  test('class → git host is a closed table (1.0.3): absent or personal on git-qa, assessment on git-preview or a foreign host, an unknown, mis-cased, null, empty or non-string class → workspace_failed before any action (CLI and module seam)', async () => {
    const k = await kernel();
    assert.deepEqual({ ...k.CLASS_GIT_HOSTS }, V.constants.REPO_OPEN_CLASS_GIT_HOSTS);
    assert.ok(Object.isFrozen(k.CLASS_GIT_HOSTS));
    assert.deepEqual(k.OPTIONAL_REQUEST_KEYS, V.kernel.optionalRequestKeys);
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const connects = fx.proxy.state.connects.length;
    const bad = [
      ['absent class on git-qa', { gitHost: QA_HOST }],
      ['personal on git-qa', { gitHost: QA_HOST, cls: 'personal' }],
      ['assessment on git-preview', { cls: 'assessment' }],
      ['assessment on a foreign host', { gitHost: 'github.ezil.work', cls: 'assessment' }],
      ['unknown class', { gitHost: QA_HOST, cls: 'exam' }],
      ['mis-cased class', { gitHost: QA_HOST, cls: 'Assessment' }],
      ['an inherited property name', { gitHost: QA_HOST, cls: 'constructor' }],
      ['null class', { cls: null }],
      ['empty class', { cls: '' }],
      ['numeric class', { cls: 1 }],
      ['array class', { gitHost: QA_HOST, cls: ['assessment'] }],
    ];
    for (const [label, fields] of bad) {
      for (const via of ['cli', 'seam']) {
        const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: fields.gitHost ?? GIT_HOST });
        const file = writeRequest({ phase: 'prepare', uuid, root, ...fields });
        const result = via === 'cli' ? cli('prepare', file).result : await k.runKernel('prepare', file, fx.seam);
        assert.deepEqual(result, { ok: false, errorCode: 'workspace_failed' }, `${label} (${via})`);
        assert.equal(exists(`${root}/.ezil-staging`), false, label);
        assert.equal(exists(lockOf()), false, label);
        assert.equal(exists(grantOf()), false, label);
      }
    }
    assert.equal(fx.proxy.state.connects.length, connects, 'a refused request reached the network');
    // both table pairs pass the request check (and clone)
    for (const fields of [{ cls: 'personal' }, ASSESS]) {
      resetRun();
      const r2 = newRoot();
      assert.equal((await openFlow(fx, { root: r2, token, ...fields })).committed.state, 'cloned', JSON.stringify(fields));
    }
  });

  test('class assessment refuses an existing wrapper at prepare (1.0.3, E1-6): even the wrapper an earlier assessment open placed for this very repository and host → folder_conflict before any action (no network, grant, lock or staging; the tree byte-identical)', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    assert.equal((await openFlow(fx, { root, token, ...ASSESS })).committed.state, 'cloned');
    const F = wrapperOf(root);
    fs.writeFileSync(`${cloneOf(root)}/pre-staged.txt`, 'answer written before the attempt');
    const before = manifest(F);
    const connects = fx.proxy.state.connects.length, requests = fx.server.state.requests;
    const token2 = newToken();
    const { uuid, prepared, committed, released } = await openFlow(fx, { root, token: token2, ...ASSESS });
    assert.deepEqual(prepared, { ok: false, errorCode: 'folder_conflict' });
    assert.equal(committed, null);
    assert.deepEqual(released, { ok: true });
    assert.deepEqual(manifest(F), before, 'the existing tree changed');
    assert.equal(JSON.parse(fs.readFileSync(grantOf(), 'utf8')).password, token, 'the refused open installed its grant');
    assert.equal(exists(lockOf()), false);
    assert.equal(exists(`${root}/.ezil-staging/${uuid}`), false);
    assert.equal(fx.proxy.state.connects.length, connects); assert.equal(fx.server.state.requests, requests);
    // control: the same folder reopened as personal is still `existing` (personal behaviour unchanged)
    const root2 = newRoot();
    await openFlow(fx, { root: root2, token });
    assert.equal((await openFlow(fx, { root: root2, token })).committed.state, 'existing');
  });

  test('class assessment refuses at commit a wrapper that appeared after prepare (1.0.3, E1-6): a real repository at W/repository bound to this repository and host, with an incoming grant → folder_conflict; never adopted; lock released; the grant this request installed removed (another request\'s kept); release removes staging', async () => {
    const k = await kernel();
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam)).state, 'cloned');
    const F = wrapperOf(root), planted = cloneOf(root);
    sh('git', ['init', '-q', '-b', 'main', planted], { env: USER_ENV });
    sh('git', ['-C', planted, '-c', 'user.name=P', '-c', 'user.email=p@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'planted'], { env: USER_ENV });
    fs.writeFileSync(`${planted}/.git/ezil-repo.json`, `${JSON.stringify({ v: 1, repositoryId: REPO_ID, handle: 'acme', name: 'site', gitHost: QA_HOST })}\n`);
    writeIncoming(uuid, { token, host: QA_HOST });
    const before = manifest(F);
    assert.deepEqual(cli('commit', writeRequest({ phase: 'commit', uuid, root, ...ASSESS })).result, { ok: false, errorCode: 'folder_conflict' });
    assert.deepEqual(manifest(F), before, 'commit touched the planted folder');
    assert.equal(exists(lockOf()), false, 'commit kept its lock');
    assert.equal(exists(grantOf()), false, 'the refused commit left the grant its prepare installed beside a folder it did not place');
    assert.equal(exists(`${root}/.ezil-staging/${uuid}/.git`), true, 'staging stays for release');
    assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid, root, ...ASSESS })).result, { ok: true });
    assert.equal(exists(`${root}/.ezil-staging/${uuid}`), false);
    assert.deepEqual(manifest(F), before);
    // The lock is no longer this request's (another prepare took it over as stale): the grant in place
    // is that request's, never this one's to remove.
    const uuid2 = crypto.randomUUID(); writeIncoming(uuid2, { token, host: QA_HOST });
    const root2 = newRoot();
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid: uuid2, root: root2, ...ASSESS }), fx.seam)).state, 'cloned');
    const other = crypto.randomUUID();
    plantLock(other);
    fs.writeFileSync(grantOf(), JSON.stringify({ v: 1, protocol: 'https', host: QA_HOST, path: 'acme/site.git', username: 'ezil',
      password: newToken(), expiresAt: new Date(Date.now() + 900000).toISOString(), scope: 'write' }), { mode: 0o600 });
    const otherGrant = fs.readFileSync(grantOf());
    sh('git', ['init', '-q', '-b', 'main', cloneOf(root2)], { env: USER_ENV });
    assert.deepEqual(cli('commit', writeRequest({ phase: 'commit', uuid: uuid2, root: root2, inflight: [uuid2, other], ...ASSESS })).result,
      { ok: false, errorCode: 'folder_conflict' });
    assert.equal(exists(grantOf()) && fs.readFileSync(grantOf()).equals(otherGrant), true, 'a commit removed a grant it did not install');
    assert.equal(fs.readFileSync(`${lockOf()}/owner`, 'utf8'), other, 'the other request\'s lock was released');
  });

  test('class assessment (1.0.3): clean is false when the staged clone gains an untracked or a modified tracked file before commit (head unchanged); assessmentFacts reads clean after the clone and dirty after an untracked file', async () => {
    const k = await kernel();
    for (const [label, tamper] of [['untracked file', (S) => fs.writeFileSync(`${S}/new.txt`, 'n')],
      ['untracked file in a new directory', (S) => { fs.mkdirSync(`${S}/deep/er`, { recursive: true }); fs.writeFileSync(`${S}/deep/er/x.txt`, 'x'); }],
      ['modified tracked file', (S) => fs.writeFileSync(`${S}/a.txt`, 'changed')]]) {
      resetRun();
      const root = newRoot(); const token = newToken(); fx.server.state.token = token;
      const bare = makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
      const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
      assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam)).ok, true, label);
      tamper(`${root}/.ezil-staging/${uuid}`);
      assert.deepEqual(cli('commit', writeRequest({ phase: 'commit', uuid, root, ...ASSESS })).result,
        assessed(root, { head: remoteHeadOf(bare), clean: false }), label);
    }
    resetRun();
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { branches: { main: { 'a.txt': 'a', '.gitignore': 'ignored/\n' } } });
    const { committed } = await openFlow(fx, { root, token, ...ASSESS });
    const F = `${committed.folder}/repository`;
    assert.equal(F, cloneOf(root));
    assert.deepEqual(await k.assessmentFacts(F), { head: remoteHeadOf(bare), clean: true });
    fs.mkdirSync(`${F}/ignored`); fs.writeFileSync(`${F}/ignored/x`, 'x');
    assert.deepEqual(await k.assessmentFacts(F), { head: remoteHeadOf(bare), clean: true }, 'an ignored file is not listed');
    fs.writeFileSync(`${F}/untracked.txt`, 'u');
    assert.deepEqual(await k.assessmentFacts(F), { head: remoteHeadOf(bare), clean: false });
    fs.rmSync(`${F}/untracked.txt`);
    assert.deepEqual(await k.assessmentFacts(F), { head: remoteHeadOf(bare), clean: true });
  });

  test('assessment reads are hardened (1.0.3): a parent repository is never discovered, a planted fsmonitor or hook never runs, the index is neither rewritten nor locked, and a broken HEAD is workspace_failed (never unborn)', async () => {
    const k = await kernel();
    const base = fs.realpathSync(fs.mkdtempSync('/tmp/hardened-'));
    sh('git', ['init', '-q', '-b', 'main', base], { env: USER_ENV });
    sh('git', ['-C', base, '-c', 'user.name=P', '-c', 'user.email=p@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'parent'], { env: USER_ENV });
    const notRepo = `${base}/site`; fs.mkdirSync(notRepo);
    assert.equal(spawnSync('git', ['-C', notRepo, 'rev-parse', '--verify', '-q', 'HEAD'], { env: USER_ENV }).status, 0, 'control: plain git finds the parent');
    assert.equal(await kernelCode(() => k.assessmentFacts(notRepo)), 'workspace_failed', 'the parent repository was discovered');
    const R = `${base}/repo`;
    sh('git', ['init', '-q', '-b', 'main', R], { env: USER_ENV });
    fs.writeFileSync(`${R}/a.txt`, 'a');
    sh('git', ['-C', R, 'add', 'a.txt'], { env: USER_ENV });
    sh('git', ['-C', R, '-c', 'user.name=P', '-c', 'user.email=p@example.invalid', 'commit', '-q', '-m', 'one'], { env: USER_ENV });
    const head = sh('git', ['-C', R, 'rev-parse', 'HEAD'], { env: USER_ENV }).trim();
    const marker = `${base}/ran`;
    fs.writeFileSync(`${base}/evil.sh`, `#!/bin/sh\necho "$0 $*" >> ${marker}\nexit 0\n`, { mode: 0o755 });
    fs.mkdirSync(`${base}/hooks`);
    for (const hook of ['post-index-change', 'reference-transaction', 'fsmonitor-watchman']) fs.copyFileSync(`${base}/evil.sh`, `${base}/hooks/${hook}`);
    sh('git', ['-C', R, 'config', 'core.fsmonitor', `${base}/evil.sh`], { env: USER_ENV });
    sh('git', ['-C', R, 'config', 'core.hooksPath', `${base}/hooks`], { env: USER_ENV });
    sh('git', ['-C', R, 'config', 'core.pager', `${base}/evil.sh`], { env: USER_ENV });
    const t = Date.now() / 1000 + 30; fs.utimesSync(`${R}/a.txt`, t, t);   // stale stat: a plain status would rewrite the index
    const idx = fs.statSync(`${R}/.git/index`);
    assert.deepEqual(await k.assessmentFacts(R), { head, clean: true });
    assert.equal(exists(marker), false, `a planted fsmonitor, hook or pager ran: ${exists(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
    const idx2 = fs.statSync(`${R}/.git/index`);
    assert.deepEqual([idx2.ino, idx2.mtimeMs], [idx.ino, idx.mtimeMs], 'the read rewrote the index');
    assert.equal(exists(`${R}/.git/index.lock`), false);
    // control: the same status with optional locks rewrites that stale index (the fixture is live)
    spawnSync('git', ['-C', R, '-c', 'core.fsmonitor=', '-c', 'core.hooksPath=/dev/null', 'status', '--porcelain'], { env: USER_ENV });
    assert.notDeepEqual((({ ino, mtimeMs }) => [ino, mtimeMs])(fs.statSync(`${R}/.git/index`)), [idx.ino, idx.mtimeMs], 'control: the stale index was not rewritten');
    // HEAD: detached at a missing commit → workspace_failed; a symbolic ref to an unborn branch → null
    fs.writeFileSync(`${R}/.git/HEAD`, `${'0'.repeat(40)}\n`);
    assert.equal(await kernelCode(() => k.assessmentFacts(R)), 'workspace_failed', 'a broken HEAD passed as unborn');
    fs.writeFileSync(`${R}/.git/HEAD`, 'ref: refs/heads/unborn\n');
    assert.deepEqual(await k.assessmentFacts(R), { head: null, clean: false }, 'unborn branch, a.txt staged');
  });

  // ── 1.0.3 review fixes ───────────────────────────────────────────────────────
  /** A repository with one commit of a.txt in `${base}/repo`; returns [dir, head]. */
  const oneCommitRepo = (prefix) => {
    const base = fs.realpathSync(fs.mkdtempSync(`/tmp/${prefix}-`));
    const R = `${base}/repo`;
    sh('git', ['init', '-q', '-b', 'main', R], { env: USER_ENV });
    fs.writeFileSync(`${R}/a.txt`, 'a');
    sh('git', ['-C', R, 'add', 'a.txt'], { env: USER_ENV });
    sh('git', ['-C', R, '-c', 'user.name=P', '-c', 'user.email=p@example.invalid', 'commit', '-q', '-m', 'one'], { env: USER_ENV });
    return [R, sh('git', ['-C', R, 'rev-parse', 'HEAD'], { env: USER_ENV }).trim()];
  };

  test('assessment head (1.0.3): a symbolic HEAD to a missing tag or remote-tracking ref, or a branch that names a tree, is workspace_failed, never unborn', async () => {
    const k = await kernel();
    const [R, head] = oneCommitRepo('headrule');
    const tree = sh('git', ['-C', R, 'rev-parse', 'HEAD^{tree}'], { env: USER_ENV }).trim();
    fs.writeFileSync(`${R}/.git/refs/heads/treeish`, `${tree}\n`);   // git itself refuses to write a non-commit to a branch
    for (const [label, text] of [['a symbolic HEAD to a missing tag', 'ref: refs/tags/missing\n'],
      ['a symbolic HEAD to a missing remote-tracking ref', 'ref: refs/remotes/origin/missing\n'],
      ['a branch that names a tree', 'ref: refs/heads/treeish\n']]) {
      fs.writeFileSync(`${R}/.git/HEAD`, text);
      assert.equal(await kernelCode(() => k.assessmentFacts(R)), 'workspace_failed', `${label} passed as unborn`);
    }
    // controls: a symbolic HEAD to an unborn branch is null; back on main it is the commit
    fs.writeFileSync(`${R}/.git/HEAD`, 'ref: refs/heads/unborn\n');
    assert.equal((await k.assessmentFacts(R)).head, null);
    fs.writeFileSync(`${R}/.git/HEAD`, 'ref: refs/heads/main\n');
    assert.deepEqual(await k.assessmentFacts(R), { head, clean: true });
  });

  test('assessment reads share one budget (1.0.3): ASSESSMENT_READ_BUDGET_MS equals vectors kernel.assessment.readBudgetMs, below the host commit window; reads whose deadline has passed → workspace_busy', async () => {
    const k = await kernel();
    assert.equal(k.ASSESSMENT_READ_BUDGET_MS, V.kernel.assessment.readBudgetMs);
    assert.ok(k.ASSESSMENT_READ_BUDGET_MS > 0 && k.ASSESSMENT_READ_BUDGET_MS < V.timeouts.COMMIT_EXEC_MAX_MS);
    const [R, head] = oneCommitRepo('budget');
    assert.equal(await kernelCode(() => k.assessmentFacts(R, Date.now() - 1)), 'workspace_busy');
    assert.deepEqual(await k.assessmentFacts(R, Date.now() + k.ASSESSMENT_READ_BUDGET_MS), { head, clean: true });
  });

  test('class assessment reads head and clean in staging before the rename (1.0.3): a staged HEAD that cannot be read → workspace_failed with no folder placed; release leaves nothing; a re-open succeeds', async () => {
    const k = await kernel();
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam)).state, 'cloned');
    fs.writeFileSync(`${root}/.ezil-staging/${uuid}/.git/HEAD`, `${'0'.repeat(40)}\n`);
    assert.deepEqual(cli('commit', writeRequest({ phase: 'commit', uuid, root, ...ASSESS })).result, { ok: false, errorCode: 'workspace_failed' });
    assert.equal(exists(wrapperOf(root)), false, 'the folder was placed although its head could not be read');
    assert.equal(exists(lockOf()), false, 'commit kept its lock');
    assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid, root, ...ASSESS })).result, { ok: true });
    assertNoOpenLeftovers(root, uuid, { wrapper: wrapperOf(root) });
    const again = await openFlow(fx, { root, token, ...ASSESS });
    assert.deepEqual([again.committed.state, again.committed.head, again.committed.clean], ['cloned', remoteHeadOf(bare), true]);
  });

  test('class assessment checks out exactly defaultBranch (1.0.3): a remote HEAD on another branch is not followed (personal still follows it); a non-empty remote without defaultBranch → repository_unavailable, nothing placed', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { head: 'trunk', branches: { trunk: { 'a.txt': 'a' }, main: { 'm.txt': 'm' } } });
    const F = cloneOf(root);
    const { committed } = await openFlow(fx, { root, token, defaultBranch: 'main', ...ASSESS });
    assert.deepEqual(committed, assessed(root, { head: remoteHeadOf(bare, 'main') }));
    assert.equal(sh('git', ['-C', F, 'symbolic-ref', 'HEAD'], { env: USER_ENV }).trim(), 'refs/heads/main');
    assert.equal(fs.readFileSync(`${F}/m.txt`, 'utf8'), 'm');
    // control: a personal open of the same remote follows its HEAD
    assert.equal((await openFlow(fx, { root: newRoot(), token, defaultBranch: 'main' })).committed.branch, 'trunk');
    const root3 = newRoot();
    const connects = fx.proxy.state.connects.length;
    const { uuid, prepared, committed: none, released } = await openFlow(fx, { root: root3, token, defaultBranch: 'release', ...ASSESS });
    assert.deepEqual(prepared, { ok: false, errorCode: 'repository_unavailable' });
    assert.equal(none, null);
    assert.deepEqual(released, { ok: true });
    assert.ok(fx.proxy.state.connects.length > connects, 'control: the refusal came from the listing');
    assertNoOpenLeftovers(root3, uuid, { wrapper: wrapperOf(root3) });
  });

  test('no kernel git runs a PATH-resolved `false` as an fsmonitor hook (1.0.3; git < 2.36 reads core.fsmonitor=false as a hook command): prepare, commit and release of both classes, and the assessment reads', async () => {
    // /usr/local/sbin is first on the kernel's git PATH. A tmpfs over it lives in this suite's
    // private mount namespace only (isolate()), and is unmounted at the end.
    const SBIN = '/usr/local/sbin';
    const KERNEL_GIT_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
    assert.ok(fs.lstatSync(SBIN).isDirectory(), `${SBIN} is not a directory`);
    const marker = '/tmp/planted-false-ran';
    fs.rmSync(marker, { force: true });
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'mode=0755', 'tmpfs', SBIN]);
    try {
      fs.writeFileSync(`${SBIN}/false`, `#!/bin/sh\necho "$0 $1" >> ${marker}\nexit 1\n`, { mode: 0o755 });
      const k = await kernel();
      const version = k.parseGitVersion(sh('git', ['--version'], { env: USER_ENV }));
      const legacy = version.major < 2 || (version.major === 2 && version.minor < 36);
      // control: on this git, a bare `-c core.fsmonitor=false status` runs the planted false exactly when git < 2.36
      const [R] = oneCommitRepo('fsmonitor');
      spawnSync('git', ['-c', 'core.fsmonitor=false', 'status', '--porcelain'], { cwd: R, env: { PATH: KERNEL_GIT_PATH, HOME: '/tmp/userhome', GIT_CONFIG_NOSYSTEM: '1' } });
      assert.equal(exists(marker), legacy, `control: git ${version.major}.${version.minor} ${legacy ? 'did not run' : 'ran'} the planted false`);
      fs.rmSync(marker, { force: true });
      const token = newToken(); fx.server.state.token = token;
      makeRemote(fx, { branches: { main: { 'a.txt': 'a', 'b/c.txt': 'c' } } });
      for (const fields of [{}, ASSESS]) {
        const root = newRoot();
        const { committed, released } = await openFlow(fx, { root, token, ...fields });
        assert.equal(committed.state, 'cloned', JSON.stringify(fields));
        assert.deepEqual(released, { ok: true });
        if (fields.cls) {
          const clone = `${committed.folder}/repository`;
          const t = Date.now() / 1000 + 30; fs.utimesSync(`${clone}/a.txt`, t, t);   // stale stat: status consults the index
          assert.deepEqual(await k.assessmentFacts(clone), { head: committed.head, clean: true });
        }
      }
      assert.equal(exists(marker), false, `the kernel ran the planted false: ${exists(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
    } finally {
      execFileSync('umount', [SBIN]);
    }
  });

  test('class assessment: no grant in any argv or environ (strace of every execve across prepare, commit and two pushes through the helper), .git/config, the folder or any output', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { branches: { main: { 'a.txt': 'a', 'b/c.txt': 'c' } } });
    const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
    const trace = `/tmp/trace-qa-${uuid}.log`;
    const strace = ['-f', '-qq', '-v', '-s', '65535', '-e', 'trace=execve', '-o'];
    const driver = `import { runKernel } from ${JSON.stringify(KERNEL_PATH)}; const [phase, request, ca, proxy] = process.argv.slice(1); process.stdout.write(JSON.stringify(await runKernel(phase, request, { sslCAInfo: ca, proxy })) + '\\n');`;
    const outputs = [];
    const run = await spawnAsync('strace', [...strace, trace, process.execPath, '--input-type=module', '-e', driver,
      'prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.tls.ca, fx.proxy.url], { env: { PATH: USER_ENV.PATH } });
    outputs.push(run.stdout, run.stderr);
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout.trim()).state, 'cloned');
    const commitRun = spawnSync('strace', [...strace, `${trace}.commit`, process.execPath, KERNEL_PATH, 'commit',
      writeRequest({ phase: 'commit', uuid, root, ...ASSESS })], { encoding: 'utf8', env: { PATH: USER_ENV.PATH } });
    outputs.push(commitRun.stdout, commitRun.stderr);
    const committed = JSON.parse(commitRun.stdout.trim());
    assert.deepEqual([committed.state, committed.head, committed.clean, committed.remote], ['cloned', remoteHeadOf(bare), true, QA_REMOTE]);
    const F = cloneOf(root);
    for (const n of [1, 2]) {
      fs.writeFileSync(`${F}/edit-${n}.txt`, `${n}\n`);
      assert.equal((await userGit(fx, F, ['add', `edit-${n}.txt`])).status, 0);
      assert.equal((await userGit(fx, F, ['commit', '-q', '-m', `edit ${n}`])).status, 0);
      const push = await spawnAsync('strace', [...strace, `${trace}.push${n}`, 'git', '-c', `http.sslCAInfo=${fx.tls.ca}`, '-c', `http.proxy=${fx.proxy.url}`, 'push', '-q'],
        { cwd: F, env: { ...USER_ENV } });
      outputs.push(push.stdout, push.stderr);
      assert.equal(push.status, 0, push.stderr);
      assert.equal(remoteHeadOf(bare), sh('git', ['-C', F, 'rev-parse', 'HEAD'], { env: USER_ENV }).trim(), `push ${n} landed`);
    }
    const logs = ['', '.commit', '.push1', '.push2'].map((s) => fs.readFileSync(`${trace}${s}`, 'utf8'));
    assert.ok(/execve\("[^"]*git"/.test(logs[0]) && /remote-https/.test(logs[0]) && logs[0].includes('ezil-git-grant'), 'the prepare trace did not cover git, its https remote helper and the credential helper');
    for (const n of [2, 3]) assert.ok(logs[n].includes(WRAPPER_PATH) && /remote-https/.test(logs[n]), `push ${n - 1} trace did not cover the helper`);
    for (const log of logs) {
      assert.equal(log.includes(token), false, 'the grant appeared in a child argv or environ');
      assert.equal(/egg_[0-9a-f]{64}/.test(log), false, 'a grant-shaped value appeared in a child argv or environ');
    }
    for (const out of outputs) assert.equal(out.includes(token) || /egg_[0-9a-f]{64}/.test(out), false, 'a grant-shaped value was printed');
    const grep = spawnSync('grep', ['-rlF', '--', token, F], { encoding: 'utf8' });
    assert.equal(grep.status, 1, `token found in: ${grep.stdout}`);
    const config = fs.readFileSync(`${F}/.git/config`, 'utf8');
    for (const bad of V.gitConfig.forbiddenSubstrings) assert.equal(config.includes(bad), false, bad);
    assert.equal(/egg_[0-9a-f]{64}/.test(config), false);
    assert.equal(sh('git', ['-C', F, 'remote', '-v'], { env: USER_ENV }).includes('@'), false);
  });

  // ── E1-6: the assessment layout, W = <root>/projects/<repositoryId> (the editor root), F = W/repository ──
  const FORMS = ['empty directory', 'directory with editor config', 'file', 'symlink to a directory', 'dangling symlink'];
  /** Plant `form` at `p` (its parent is created as a real directory when missing). */
  const plant = (p, form) => {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (form === 'empty directory') fs.mkdirSync(p);
    else if (form === 'directory with editor config') { fs.mkdirSync(`${p}/.vscode`, { recursive: true }); fs.writeFileSync(`${p}/.vscode/tasks.json`, '{"tasks":[]}'); }
    else if (form === 'file') fs.writeFileSync(p, 'planted');
    else if (form === 'symlink to a directory') fs.symlinkSync(fs.realpathSync(fs.mkdtempSync('/tmp/target-')), p);
    else if (form === 'dangling symlink') fs.symlinkSync(`/tmp/e16-missing-${crypto.randomUUID()}`, p);
    else throw new Error(form);
  };
  /** What is at `p`, never following it, plus whatever a symlink there points at (nothing may be written through it). */
  const snapshot = (p) => {
    const st = fs.lstatSync(p);
    if (!st.isSymbolicLink()) return st.isDirectory() ? `dir\n${manifest(p).join('\n')}` : `file ${fs.readFileSync(p, 'utf8')}`;
    const target = fs.readlinkSync(p);
    return `link ${target}\n${exists(target) ? manifest(target).join('\n') : 'dangling'}`;
  };

  test('E1-6 layout: an assessment clones into F = W/repository under a new wrapper W = <root>/projects/<repositoryId> that holds exactly that entry; projects and W are created like repos and repos/<handle>; folder = openFolder = W, pathNotFound false, remote exact; a personal open of the same repository in the same root still lands in repos/<handle>/<name> with its 7-key answer, is left untouched, and blocks nothing; another repositoryId gets its own wrapper', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { branches: { main: { 'a.txt': 'a', '.vscode/tasks.json': '{"tasks":[]}' } } });
    const personal = await openFlow(fx, { root, token });
    const P = `${root}/repos/acme/site`;
    assert.deepEqual(personal.committed, { ok: true, state: 'cloned', folder: P, openFolder: P, pathNotFound: false, branch: 'main', empty: false });
    assert.deepEqual(Object.keys(personal.committed), V.kernel.resultOpenKeys);
    assert.equal(exists(`${root}/projects`), false, 'a personal open created projects/');
    const personalBefore = manifest(P);
    const { prepared, committed, released } = await openFlow(fx, { root, token, ...ASSESS });
    const W = wrapperOf(root), F = cloneOf(root);
    assert.deepEqual(prepared, { ok: true, state: 'cloned', folder: W, openFolder: W, pathNotFound: false, branch: 'main', empty: false });
    assert.deepEqual(committed, assessed(root, { head: remoteHeadOf(bare) }));
    assert.deepEqual(Object.keys(committed), V.kernel.assessment.resultOpenKeys);
    assert.deepEqual(released, { ok: true });
    assert.equal(W, `${root}/projects/${REPO_ID}`);
    assert.deepEqual(fs.readdirSync(W), ['repository'], 'W holds exactly the clone');
    for (const [made, like] of [[`${root}/projects`, `${root}/repos`], [W, `${root}/repos/acme`]]) {
      const a = fs.lstatSync(made), b = fs.lstatSync(like);
      assert.ok(a.isDirectory() && !a.isSymbolicLink(), made);
      assert.deepEqual([a.mode & 0o7777, a.uid, a.gid], [b.mode & 0o7777, b.uid, b.gid], `${made} is not created like ${like}`);
    }
    assert.equal(fs.readFileSync(`${F}/.vscode/tasks.json`, 'utf8'), '{"tasks":[]}', 'the repository\'s editor config sits in F, below the editor root');
    assert.equal(exists(`${W}/.vscode`), false);
    assert.equal(sh('git', ['-C', F, 'config', '--get', 'remote.origin.url'], { env: USER_ENV }).trim(), committed.remote);
    assert.equal(JSON.parse(fs.readFileSync(`${F}/.git/ezil-repo.json`, 'utf8')).repositoryId, REPO_ID);
    assert.deepEqual(manifest(P), personalBefore, 'the assessment touched the personal folder');
    // another repositoryId of the same handle/name: its own wrapper, beside the first
    const other = await openFlow(fx, { root, token, repositoryId: OTHER_REPO_ID, ...ASSESS });
    assert.deepEqual([other.committed.folder, other.committed.openFolder], [wrapperOf(root, OTHER_REPO_ID), wrapperOf(root, OTHER_REPO_ID)]);
    assert.deepEqual(fs.readdirSync(`${root}/projects`).sort(), [OTHER_REPO_ID, REPO_ID].sort());
    assert.deepEqual(fs.readdirSync(wrapperOf(root, OTHER_REPO_ID)), ['repository']);
  });

  test('E1-6: anything at W before the attempt (an empty directory, a directory with editor config, a file, a symlink to a directory, a dangling symlink) → folder_conflict at prepare before any action: no network, lock, grant or staging; W and anything it points at untouched; release leaves it', async () => {
    const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    for (const form of FORMS) {
      resetRun();
      const root = newRoot(); const W = wrapperOf(root);
      plant(W, form);
      const before = snapshot(W);
      const connects = fx.proxy.state.connects.length;
      const { uuid, prepared, committed, released } = await openFlow(fx, { root, token, ...ASSESS });
      assert.deepEqual([form, prepared], [form, { ok: false, errorCode: 'folder_conflict' }]);
      assert.equal(committed, null);
      assert.deepEqual(released, { ok: true });
      assert.equal(fx.proxy.state.connects.length, connects, `${form}: the refused prepare reached the network`);
      assert.deepEqual([form, exists(lockOf()), exists(grantOf()), exists(`${root}/.ezil-staging/${uuid}`)], [form, false, false, false]);
      assert.equal(snapshot(W), before, `${form}: W changed`);
      assert.deepEqual(fs.readdirSync(`${root}/projects`), [REPO_ID], form);
    }
  });

  test('E1-6: W appearing between prepare and commit in any form → folder_conflict at commit; nothing adopted or written into or through it; lock released; the grant this prepare installed removed; staging stays for release, which then leaves only the planted W', async () => {
    const k = await kernel();
    const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    for (const form of FORMS) {
      resetRun();
      const root = newRoot(); const W = wrapperOf(root);
      const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
      assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam)).state, 'cloned', form);
      assert.equal(exists(grantOf()), true, 'control: prepare installed the grant');
      plant(W, form);
      const before = snapshot(W);
      assert.deepEqual([form, cli('commit', writeRequest({ phase: 'commit', uuid, root, ...ASSESS })).result], [form, { ok: false, errorCode: 'folder_conflict' }]);
      assert.equal(snapshot(W), before, `${form}: commit touched W`);
      assert.deepEqual([form, exists(lockOf()), exists(grantOf())], [form, false, false], `${form}: lock or grant left`);
      assert.equal(exists(`${root}/.ezil-staging/${uuid}/.git`), true, 'staging stays for release');
      assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid, root, ...ASSESS })).result, { ok: true });
      assert.equal(exists(`${root}/.ezil-staging/${uuid}`), false);
      assert.equal(snapshot(W), before);
    }
    // The wrapper is checked first, before any read of the staged clone: W planted AND a staged HEAD
    // that cannot be read is folder_conflict (the precise answer), never workspace_failed.
    resetRun();
    const root = newRoot();
    const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam)).state, 'cloned');
    fs.writeFileSync(`${root}/.ezil-staging/${uuid}/.git/HEAD`, `${'0'.repeat(40)}\n`);
    plant(wrapperOf(root), 'empty directory');
    assert.deepEqual(cli('commit', writeRequest({ phase: 'commit', uuid, root, ...ASSESS })).result, { ok: false, errorCode: 'folder_conflict' },
      'the wrapper was not checked before the reads');
    assert.deepEqual([exists(lockOf()), exists(grantOf())], [false, false]);
  });

  test('E1-6: <root>/projects that is a symlink (to a directory, or dangling) or a file → workspace_failed at prepare before any action, and the same planted after prepare → workspace_failed at commit; nothing is written through it, nothing is placed, lock and grant are gone', async () => {
    const k = await kernel();
    const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    for (const when of ['prepare', 'commit']) {
      for (const form of ['symlink to a directory', 'dangling symlink', 'file']) {
        resetRun();
        const root = newRoot(); const projects = `${root}/projects`;
        const label = `${form} at ${when}`;
        const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
        let before = null;
        if (when === 'prepare') { plant(projects, form); before = snapshot(projects); }
        const connects = fx.proxy.state.connects.length;
        const prepared = await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam);
        if (when === 'prepare') {
          assert.deepEqual([label, prepared], [label, { ok: false, errorCode: 'workspace_failed' }]);
          assert.equal(fx.proxy.state.connects.length, connects, `${label}: the refused prepare reached the network`);
          assert.deepEqual([label, exists(lockOf()), exists(grantOf()), exists(`${root}/.ezil-staging/${uuid}`)], [label, false, false, false]);
        } else {
          assert.equal(prepared.state, 'cloned', label);
          plant(projects, form); before = snapshot(projects);
          assert.deepEqual([label, cli('commit', writeRequest({ phase: 'commit', uuid, root, ...ASSESS })).result], [label, { ok: false, errorCode: 'workspace_failed' }]);
          assert.deepEqual([label, exists(lockOf()), exists(grantOf())], [label, false, false]);
        }
        assert.equal(snapshot(projects), before, `${label}: something was written through it`);
        assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid, root, ...ASSESS })).result, { ok: true });
        assert.equal(snapshot(projects), before, label);
        assert.equal(exists(`${root}/.ezil-staging/${uuid}`), false, label);
      }
    }
  });

  test('E1-6: a rename into the new wrapper that fails (projects on another filesystem: EXDEV) → workspace_failed, never workspace_busy; commit removes the wrapper it made, so nothing is placed; lock and grant are gone; after release a retry places the clone', async () => {
    const k = await kernel();
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const projects = `${root}/projects`;
    fs.mkdirSync(projects);
    const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
    assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam)).state, 'cloned');
    // A tmpfs over projects, in this suite's private mount namespace: mkdir W succeeds on it, and
    // rename(2) of the staging directory (on the root's filesystem) into it fails with EXDEV.
    execFileSync('mount', ['-t', 'tmpfs', '-o', 'mode=0755', 'tmpfs', projects]);
    let result, during;
    try {
      const probe = fs.mkdtempSync(`${root}/probe-`);
      assert.throws(() => fs.renameSync(probe, `${projects}/probe`), { code: 'EXDEV' }, 'control: the rename crosses filesystems');
      fs.rmdirSync(probe);
      result = cli('commit', writeRequest({ phase: 'commit', uuid, root, ...ASSESS })).result;
      during = fs.readdirSync(projects);
    } finally {
      execFileSync('umount', [projects]);
    }
    assert.deepEqual(result, { ok: false, errorCode: 'workspace_failed' });
    assert.deepEqual(during, [], 'the wrapper commit made was left behind');
    assert.deepEqual(fs.readdirSync(projects), []);
    assert.deepEqual([exists(lockOf()), exists(grantOf())], [false, false], 'lock or grant left');
    assert.equal(exists(`${root}/.ezil-staging/${uuid}/.git`), true, 'staging stays for release');
    assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid, root, ...ASSESS })).result, { ok: true });
    assertNoOpenLeftovers(root, uuid, { wrapper: wrapperOf(root) });
    const again = await openFlow(fx, { root, token, ...ASSESS });
    assert.deepEqual(again.committed, assessed(root, { head: remoteHeadOf(bare) }));
    assert.deepEqual(fs.readdirSync(wrapperOf(root)), ['repository']);
  });

  test('E1-6 placement re-check: guest root acting while strace holds the commit\'s rename (at its entry or its exit) — W gains an entry, or the root, projects, W or F becomes a symlink to the same tree moved aside → workspace_failed; lock and grant gone; a re-open is refused; the held rename alone still answers ok with W = [repository]', async () => {
    const k = await kernel();
    const token = newToken(); fx.server.state.token = token;
    const bare = makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const TASKS = JSON.stringify({ version: '2.0.0', tasks: [{ label: 'x', type: 'shell', command: 'true', runOptions: { runOn: 'folderOpen' } }] });
    // The real CLI commit; strace (main thread only, so no git child is touched) holds every rename 2 s at its entry or exit.
    const heldCommit = (requestPath, at) => spawnAsync('strace', ['-o', '/dev/null', '-e', 'trace=rename,renameat,renameat2',
      '-e', `inject=rename,renameat,renameat2:delay_${at}=2000000`, process.execPath, KERNEL_PATH, 'commit', requestPath], { env: { PATH: USER_ENV.PATH } });
    /** Move `p` aside (same filesystem, content kept) and leave a symlink to it at `p`: only the lstat of `p` can tell. */
    const moveAside = (p) => { const to = `${fs.realpathSync(fs.mkdtempSync('/tmp/aside-'))}/moved`; fs.renameSync(p, to); fs.symlinkSync(to, p); };
    const addEditorConfig = (root, W) => { fs.mkdirSync(`${W}/.vscode`); fs.writeFileSync(`${W}/.vscode/tasks.json`, TASKS); };
    // [label, rename end held, act(root, W, F), the re-open's prepare answer]
    const scenarios = [
      ['control: the rename is held and nobody acts', 'exit', null, 'folder_conflict'],
      ['W gains .vscode before the rename', 'enter', addEditorConfig, 'folder_conflict'],
      ['W gains .vscode after the rename', 'exit', addEditorConfig, 'folder_conflict'],
      ['the root becomes a symlink', 'exit', (root) => moveAside(root), 'workspace_failed'],
      ['projects becomes a symlink', 'exit', (root) => moveAside(`${root}/projects`), 'workspace_failed'],
      ['W becomes a symlink', 'exit', (root, W) => moveAside(W), 'folder_conflict'],
      ['F becomes a symlink', 'exit', (root, W, F) => moveAside(F), 'folder_conflict'],
    ];
    for (const [label, at, act, reopen] of scenarios) {
      resetRun();
      const root = newRoot(); const W = wrapperOf(root), F = cloneOf(root);
      const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
      assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam)).state, 'cloned', label);
      const running = heldCommit(writeRequest({ phase: 'commit', uuid, root, ...ASSESS }), at);
      const seen = at === 'enter' ? W : F;   // mkdir(W) done and the rename held; or the rename done and its return held
      for (const until = Date.now() + 10000; !exists(seen) && Date.now() < until;) await sleep(5);
      assert.equal(exists(seen), true, `${label}: the held rename never came`);
      if (act) act(root, W, F);
      const run = await running;
      assert.equal(run.stdout.includes(token) || run.stderr.includes(token), false);
      const result = JSON.parse(run.stdout.trim().split('\n').at(-1));
      if (!act) {
        assert.deepEqual(result, assessed(root, { head: remoteHeadOf(bare) }), label);
        assert.deepEqual(fs.readdirSync(W), ['repository']);
        assert.equal(exists(grantOf()), true, `${label}: an ok commit keeps its grant`);
      } else {
        assert.deepEqual([label, result], [label, { ok: false, errorCode: 'workspace_failed' }]);
        assert.equal(exists(grantOf()), false, `${label}: the grant of a refused placement was kept`);
      }
      assert.equal(exists(lockOf()), false, `${label}: lock left`);
      const again = await openFlow(fx, { root, token, ...ASSESS });
      assert.deepEqual([label, again.prepared], [label, { ok: false, errorCode: reopen }]);
    }
  });

  test('E1-6: remote is read back from the staged config before the rename, as one value equal to ASSESSMENT_REMOTE_TEMPLATE: another repository, the personal host, userinfo, a second value (added directly or through include.path) or no value → workspace_failed with nothing placed; assessmentRemote honours the read budget', async () => {
    const k = await kernel();
    const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    const gitIn = (S, ...args) => sh('git', ['-C', S, ...args], { env: USER_ENV });
    const tampers = [
      ['another repository', (S) => gitIn(S, 'config', 'remote.origin.url', 'https://git-qa.ezil.work/acme/other.git')],
      ['the personal host', (S) => gitIn(S, 'config', 'remote.origin.url', 'https://git-preview.ezil.work/acme/site.git')],
      ['userinfo', (S) => gitIn(S, 'config', 'remote.origin.url', 'https://ezil@git-qa.ezil.work/acme/site.git')],
      ['a second, equal value', (S) => gitIn(S, 'config', '--add', 'remote.origin.url', QA_REMOTE)],
      ['a second value through include.path', (S) => {
        const inc = `/tmp/e16-include-${crypto.randomUUID()}`;
        fs.writeFileSync(inc, '[remote "origin"]\n\turl = https://evil.example/acme/site.git\n');
        gitIn(S, 'config', 'include.path', inc);
      }],
      ['no value', (S) => gitIn(S, 'config', '--unset-all', 'remote.origin.url')],
    ];
    for (const [label, tamper] of tampers) {
      resetRun();
      const root = newRoot();
      const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
      assert.equal((await k.runKernel('prepare', writeRequest({ phase: 'prepare', uuid, root, ...ASSESS }), fx.seam)).state, 'cloned', label);
      const S = `${root}/.ezil-staging/${uuid}`;
      assert.equal(await k.assessmentRemote(S), QA_REMOTE, `control (${label}): the staged remote reads back`);
      tamper(S);
      assert.deepEqual([label, cli('commit', writeRequest({ phase: 'commit', uuid, root, ...ASSESS })).result], [label, { ok: false, errorCode: 'workspace_failed' }]);
      assert.equal(exists(wrapperOf(root)), false, `${label}: placed`);
      assert.deepEqual([label, exists(lockOf()), exists(grantOf())], [label, false, false]);
      assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid, root, ...ASSESS })).result, { ok: true });
      assertNoOpenLeftovers(root, uuid, { wrapper: wrapperOf(root) });
    }
    const root = newRoot();
    const { committed } = await openFlow(fx, { root, token, ...ASSESS });
    assert.equal(committed.remote, QA_REMOTE);
    assert.equal(await kernelCode(() => k.assessmentRemote(cloneOf(root), Date.now() - 1)), 'workspace_busy');
    assert.equal(await k.assessmentRemote(cloneOf(root), Date.now() + k.ASSESSMENT_READ_BUDGET_MS), QA_REMOTE);
  });

  test('E1-6: an assessment request with a non-null path → workspace_failed before any action in every open phase (CLI and module seam); path null opens W; personal keeps its path', async () => {
    const k = await kernel();
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a', 'src/b.txt': 'b' } } });
    const connects = fx.proxy.state.connects.length;
    for (const relPath of ['src', 'src/b.txt', 'repository']) {
      for (const phase of ['prepare', 'commit', 'release']) {
        for (const via of ['cli', 'seam']) {
          const uuid = crypto.randomUUID(); writeIncoming(uuid, { token, host: QA_HOST });
          const file = writeRequest({ phase, uuid, root, path: relPath, ...ASSESS });
          const result = via === 'cli' ? cli(phase, file).result : await k.runKernel(phase, file, fx.seam);
          assert.deepEqual(result, { ok: false, errorCode: 'workspace_failed' }, `${phase} path ${relPath} (${via})`);
          assert.equal(exists(`/run/ezil/git/incoming/${uuid}.json`) && exists(file), true, `${phase} path ${relPath} (${via}): the refused request acted`);
        }
      }
    }
    assert.equal(fx.proxy.state.connects.length, connects, 'a refused request reached the network');
    assert.deepEqual([exists(lockOf()), exists(grantOf()), exists(`${root}/.ezil-staging`), exists(`${root}/projects`)], [false, false, false, false]);
    const a = await openFlow(fx, { root, token, ...ASSESS });
    assert.deepEqual([a.committed.openFolder, a.committed.pathNotFound], [wrapperOf(root), false]);
    resetRun();
    const proot = newRoot();
    const p = await openFlow(fx, { root: proot, token, path: 'src' });
    assert.deepEqual([p.committed.openFolder, p.committed.pathNotFound], [`${proot}/repos/acme/site/src`, false]);
  });

  test('E1-6: refresh and release of an assessment locate F under W, through real directories only: refresh installs beside a bound F and refuses folder_conflict for an F bound elsewhere or a W or projects that is a symlink; release keeps the grant while F is under W and removes it once F is gone; a personal folder of the same handle/name plays no part', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    assert.equal((await openFlow(fx, { root, token, ...ASSESS })).committed.state, 'cloned');
    // a personal folder of the same handle/name bound to ANOTHER repository decides only personal refreshes
    const P = `${root}/repos/acme/site`;
    sh('git', ['init', '-q', '-b', 'main', P], { env: USER_ENV });
    fs.writeFileSync(`${P}/.git/ezil-repo.json`, `${JSON.stringify({ v: 1, repositoryId: OTHER_REPO_ID, handle: 'acme', name: 'site', gitHost: GIT_HOST })}\n`);
    const refreshAs = (fields) => {
      const tok = newToken();
      const uuid = crypto.randomUUID(); writeIncoming(uuid, { token: tok, host: fields.gitHost ?? GIT_HOST });
      const result = cli('refresh', writeRequest({ op: 'refresh', phase: 'refresh', uuid, root, ...fields })).result;
      const released = cli('release', writeRequest({ op: 'refresh', phase: 'release', uuid, root, ...fields })).result;
      assert.deepEqual(released, { ok: true });
      return { result, tok };
    };
    const first = refreshAs(ASSESS);
    assert.deepEqual(first.result, { ok: true, state: 'refreshed' });
    assert.equal(JSON.parse(fs.readFileSync(grantOf(), 'utf8')).password === first.tok, true, 'refresh installed its grant and release kept it (F is under W)');
    assert.deepEqual(refreshAs({}).result, { ok: false, errorCode: 'folder_conflict' }, 'control: the personal refresh sees its own foreign-bound folder');
    const binding = `${cloneOf(root)}/.git/ezil-repo.json`;
    const original = fs.readFileSync(binding);
    fs.writeFileSync(binding, `${JSON.stringify({ v: 1, repositoryId: OTHER_REPO_ID, handle: 'acme', name: 'site', gitHost: QA_HOST })}\n`);
    assert.deepEqual(refreshAs(ASSESS).result, { ok: false, errorCode: 'folder_conflict' }, 'F bound to another repository');
    // the same without the personal folder: only F under W can decide it
    const movedP = `${root}/moved-personal`;
    fs.renameSync(P, movedP);
    assert.deepEqual(refreshAs(ASSESS).result, { ok: false, errorCode: 'folder_conflict' }, 'F bound to another repository, no personal folder');
    fs.renameSync(movedP, P);
    fs.writeFileSync(binding, original);
    const W = wrapperOf(root), movedW = `${root}/moved-wrapper`;
    fs.renameSync(W, movedW); fs.symlinkSync(movedW, W);
    assert.deepEqual(refreshAs(ASSESS).result, { ok: false, errorCode: 'folder_conflict' }, 'W is a symlink');
    fs.unlinkSync(W); fs.renameSync(movedW, W);
    const projects = `${root}/projects`, movedProjects = `${root}/moved-projects`;
    fs.renameSync(projects, movedProjects); fs.symlinkSync(movedProjects, projects);
    assert.deepEqual(refreshAs(ASSESS).result, { ok: false, errorCode: 'folder_conflict' }, 'projects is a symlink');
    fs.unlinkSync(projects); fs.renameSync(movedProjects, projects);
    const last = refreshAs(ASSESS);
    assert.deepEqual(last.result, { ok: true, state: 'refreshed' });
    assert.equal(JSON.parse(fs.readFileSync(grantOf(), 'utf8')).password === last.tok, true, 'the grant beside F is kept');
    fs.rmSync(cloneOf(root), { recursive: true });
    assert.deepEqual(cli('release', writeRequest({ phase: 'release', uuid: crypto.randomUUID(), root, ...ASSESS })).result, { ok: true });
    assert.equal(exists(grantOf()), false, 'release kept the grant of an assessment F that is gone');
  });

  test('E1-6: the budget counts an assessment clone under its final names projects/<repositoryId>/repository/… (plus projects and W when absent): with the same remote and budget, a limit between the two measures admits the personal open and refuses the assessment with repository_too_large, nothing left', async () => {
    const k = await kernel();
    const token = newToken(); fx.server.state.token = token;
    // 40 files whose names cross the 100-byte PAX threshold only under the longer assessment prefix
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`d/${String(i).padStart(2, '0')}${'x'.repeat(56)}`, 'f']));
    makeRemote(fx, { branches: { main: files } });
    const ref = newRoot();
    assert.equal((await openFlow(fx, { root: ref, token })).committed.state, 'cloned');
    const empty = newRoot();
    const huge = { limitBytes: 1 << 30, maxEntries: 1000000, fraction: 1 };
    const measure = (extra) => k.measureBudget({ root: empty, staging: `${ref}/repos/acme/site`, handle: 'acme', name: 'site', budget: huge, ...extra });
    const personal = measure({});
    const assessment = measure({ folder: `projects/${REPO_ID}/repository`, parents: ['projects', `projects/${REPO_ID}`] });
    assert.equal(assessment.stagedEntries, personal.stagedEntries, 'the same entries, under other names');
    assert.ok(assessment.stagedTarBytes - personal.stagedTarBytes >= 40 * 1024, `${personal.stagedTarBytes} vs ${assessment.stagedTarBytes}`);
    const budget = { limitBytes: Math.floor((personal.stagedTarBytes + assessment.stagedTarBytes) / 2) + V.constants.TAR_ARCHIVE_TAIL_BYTES,
      maxEntries: 1000000, fraction: 1 };
    resetRun();
    const p = await openFlow(fx, { root: newRoot(), token, budget });
    assert.equal(p.committed && p.committed.state, 'cloned', JSON.stringify(p.prepared));
    resetRun();
    const root = newRoot();
    const a = await openFlow(fx, { root, token, budget, ...ASSESS });
    assert.deepEqual(a.prepared, { ok: false, errorCode: 'repository_too_large' });
    assertNoOpenLeftovers(root, a.uuid, { wrapper: wrapperOf(root) });
  });

  // ── r56 review (A2h): no global, XDG or system git config; the index read's fsmonitor ────────
  const KERNEL_HOME = '/run/ezil/home';
  /**
   * fn() with an overlay over /etc whose upper directory is on this suite's private /tmp tmpfs: a file written
   * to /etc here lives in this mount namespace only (isolate() also compares the host's /etc/gitconfig).
   */
  async function withPrivateEtc(fn) {
    const ovl = fs.mkdtempSync('/tmp/etc-overlay-');
    fs.mkdirSync(`${ovl}/up`); fs.mkdirSync(`${ovl}/work`);
    execFileSync('mount', ['-t', 'overlay', 'overlay', '-o', `lowerdir=/etc,upperdir=${ovl}/up,workdir=${ovl}/work`, '/etc']);
    try { return await fn(); } finally { execFileSync('umount', ['/etc']); }
  }
  /** A config file a guest root could plant: a proxy and a redirect for `own`, a second remote, an ignore-all excludes file. */
  const plantedConfig = (own, other, proxyUrl) => [`[http "https://${own}"]`, `\tproxy = ${proxyUrl}`, '[http]', `\tproxy = ${proxyUrl}`,
    `[url "https://${other}/"]`, `\tinsteadOf = https://${own}/`, '[remote "origin"]', `\turl = https://${other}/acme/site.git`,
    '[core]', `\texcludesFile = ${KERNEL_HOME}/exclude-all`, ''].join('\n');
  const PLANT_SITES = [`${KERNEL_HOME}/.gitconfig`, `${KERNEL_HOME}/.config/git/config`, '/etc/gitconfig'];
  /** Control: a git WITHOUT the kernel's settings (HOME = the kernel's, no XDG_CONFIG_HOME, system config read only for /etc) sees the plant. */
  const assertPlantLive = (file, own, proxyUrl) => {
    const env = { PATH: USER_ENV.PATH, HOME: KERNEL_HOME, ...(file === '/etc/gitconfig' ? {} : { GIT_CONFIG_NOSYSTEM: '1' }) };
    const seen = spawnSync('git', ['config', '--show-origin', '--get-all', `http.https://${own}.proxy`], { cwd: '/', env, encoding: 'utf8' });
    assert.equal(seen.stdout, `file:${file}\t${proxyUrl}\n`, `control: the plant in ${file} is not live for a plain git`);
  };

  test('r56 D2: prepare\'s ls-remote and fetch read no global, XDG or system config (GIT_CONFIG_GLOBAL=/dev/null, XDG_CONFIG_HOME that cannot exist, GIT_CONFIG_NOSYSTEM=1): an http.<host>.proxy, http.proxy, url.<other host>.insteadOf and remote.origin.url planted in /run/ezil/home/.gitconfig, /run/ezil/home/.config/git/config or /etc/gitconfig never steer either class (every CONNECT through the seam proxy to the class host, none to the planted proxy); the kernel\'s gitEnv is vectors kernel.gitEnv', async () => {
    const k = await kernel();
    const decoy = await startProxy(fx.server.port);   // refuses and counts every CONNECT: git must never use it
    decoy.state.mode = 'refuse';
    try {
      const token = newToken(); fx.server.state.token = token;
      makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
      await withPrivateEtc(async () => {
        for (const file of PLANT_SITES) {
          for (const fields of [{}, ASSESS]) {
            resetRun();
            const own = fields.gitHost ?? GIT_HOST;
            const other = own === GIT_HOST ? QA_HOST : GIT_HOST;
            const label = `${file} (${fields.cls ?? 'personal'})`;
            fs.mkdirSync(path.dirname(file), { recursive: true });
            fs.mkdirSync(KERNEL_HOME, { recursive: true });
            fs.writeFileSync(`${KERNEL_HOME}/exclude-all`, '*\n');
            fs.writeFileSync(file, plantedConfig(own, other, decoy.url));
            try {
              assertPlantLive(file, own, decoy.url);
              const before = fx.proxy.state.connects.length;
              const root = newRoot();
              const { committed, released } = await openFlow(fx, { root, token, ...fields });
              assert.equal(decoy.state.connects.length, 0, `${label}: git used the planted proxy`);
              const connects = fx.proxy.state.connects.slice(before);
              assert.ok(connects.length > 0 && connects.every((c) => c === `${own}:443`), `${label}: CONNECTs ${JSON.stringify(connects)}`);
              assert.equal(committed && committed.state, 'cloned', `${label}: ${JSON.stringify(committed)}`);
              if (fields.cls) assert.equal(committed.remote, QA_REMOTE, label);
              assert.deepEqual(released, { ok: true }, label);
            } finally {
              fs.rmSync(file, { force: true });
            }
          }
        }
      });
    } finally {
      decoy.close();
    }
    assert.deepEqual(k.gitEnv(), V.kernel.gitEnv.env, 'the kernel git environment is vectors kernel.gitEnv');
  });

  test('r56 D2: the assessment reads ignore the same plants in all three places at once, and an ignore file under the kernel HOME (/run/ezil/home/.config/git/ignore: only XDG_CONFIG_HOME keeps git from reading it once GIT_CONFIG_GLOBAL is set): a dirty repository reads clean:false, its one remote exactly', async () => {
    const k = await kernel();
    const [R, head] = oneCommitRepo('r56-reads');
    fs.writeFileSync(`${R}/untracked.txt`, 'u');
    sh('git', ['-C', R, 'config', 'remote.origin.url', QA_REMOTE], { env: USER_ENV });
    assert.deepEqual(await k.assessmentFacts(R), { head, clean: false }, 'control: the repository is dirty');
    await withPrivateEtc(async () => {
      fs.mkdirSync(`${KERNEL_HOME}/.config/git`, { recursive: true });
      fs.writeFileSync(`${KERNEL_HOME}/exclude-all`, '*\n');
      fs.writeFileSync(`${KERNEL_HOME}/.config/git/ignore`, '*\n');
      for (const file of PLANT_SITES) fs.writeFileSync(file, plantedConfig(QA_HOST, GIT_HOST, 'http://127.0.0.1:9'));
      try {
        // controls: a git that sets only GIT_CONFIG_GLOBAL still reads the ignore file under HOME (it hides the
        // untracked file), and a git that reads system and global config sees the three planted remotes beside R's own
        const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'],
          { cwd: R, env: { PATH: USER_ENV.PATH, HOME: KERNEL_HOME, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }, encoding: 'utf8' });
        assert.equal(status.stdout, '', 'control: the ignore file under HOME is not live');
        const remotes = spawnSync('git', ['config', '--get-all', 'remote.origin.url'], { cwd: R, env: { PATH: USER_ENV.PATH, HOME: KERNEL_HOME }, encoding: 'utf8' });
        assert.equal(remotes.stdout.split('\n').filter(Boolean).length, 4, `control: the planted remotes are not live: ${remotes.stdout}`);
        assert.deepEqual(await k.assessmentFacts(R), { head, clean: false }, 'a planted ignore or excludes file hid the untracked file');
        assert.equal(await k.assessmentRemote(R), QA_REMOTE, 'a planted remote.origin.url reached the remote read');
      } finally {
        for (const file of [...PLANT_SITES, `${KERNEL_HOME}/.config/git/ignore`, `${KERNEL_HOME}/exclude-all`]) fs.rmSync(file, { force: true });
      }
    });
  });

  test('r56 D6: the index read (codecTracked) runs no PATH `false`: its argv carries core.fsmonitor= (EMPTY); with the same argv and env, the value false runs a planted /usr/bin/false exactly when git < 2.36 (control)', async () => {
    const k = await kernel();
    const root = newRoot();
    indexOnly(root, ['a.txt', 'node_modules/x.js']);
    const version = k.parseGitVersion(sh('/usr/bin/git', ['--version'], { env: USER_ENV }));
    const legacy = version.major < 2 || (version.major === 2 && version.minor < 36);
    const marker = '/tmp/planted-index-false-ran';
    const planted = '/tmp/planted-index-false';
    fs.writeFileSync(planted, `#!/bin/sh\necho "$0 $*" >> ${marker}\nexit 1\n`, { mode: 0o755 });
    const FALSE = '/usr/bin/false';
    assert.ok(fs.lstatSync(FALSE).isFile(), `${FALSE} is not a regular file`);
    // A bind mount in this suite's private mount namespace only (isolate()); unmounted below.
    execFileSync('mount', ['--bind', planted, FALSE]);
    try {
      // control: the kernel's index-read argv, env and throwaway git dir, with the value `false`
      const dir = fs.mkdtempSync('/tmp/r56-index-');
      fs.mkdirSync(`${dir}/objects`); fs.mkdirSync(`${dir}/refs`);
      fs.writeFileSync(`${dir}/HEAD`, 'ref: refs/heads/main\n');
      fs.copyFileSync(`${root}/.git/index`, `${dir}/index`);
      spawnSync('/usr/bin/git', [`--git-dir=${dir}`, '-c', 'core.fsmonitor=false', 'ls-files', '-z', '--cached', '--sparse'],
        { cwd: dir, env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' }, stdio: 'ignore' });
      assert.equal(exists(marker), legacy, `control: git ${version.major}.${version.minor} ${legacy ? 'did not run' : 'ran'} the planted false`);
      fs.rmSync(marker, { force: true });
      const tracked = k.codecTracked(root, { limitBytes: DEFAULT_BUDGET.limitBytes, scratch: '/tmp' });
      assert.ok(tracked === k.TRACKED_ALL || tracked.has('node_modules/x.js'), 'the index read did not run');
      assert.equal(exists(marker), false, `the index read ran the planted false: ${exists(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
    } finally {
      execFileSync('umount', [FALSE]);
    }
  });

  try {
    const ok = await runSuite('ezil-repo-open-test', tests);
    process.exitCode = ok ? 0 : 1;
  } finally {
    fx.server.close(); fx.proxy.close();
  }
}

const SELF = fileURLToPath(import.meta.url);
const invokedDirectly = (() => { try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(SELF); } catch { return false; } })();
if (invokedDirectly && isolate(SELF)) {
  await main();
  process.exit(process.exitCode ?? 0);
}
