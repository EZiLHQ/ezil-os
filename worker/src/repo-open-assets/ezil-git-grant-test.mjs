// Credential helper tests (contract universe-repo-open-v1 §9.5-§9.6, LANES O1b):
//
//   node worker/src/repo-open-assets/ezil-git-grant-test.mjs
//
// Same isolation as ezil-repo-open-test.mjs (private /run, /tmp and network namespace; needs
// root, because grant files must be uid 0). Every vectors `helperTranscripts` case runs the
// real helper module; then real git proves the repo-local config never prompts: with the
// wrapper gone it prints the not-connected hint and stops, and the empty `helper=` line
// shuts out every inherited helper.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  isolate, runSuite, loadVectors, startFixtures, resetRun, makeRemote, newRoot, newToken, openFlow, spawnAsync,
  HELPER_PATH, WRAPPER_PATH, GIT_HOST,
} from './ezil-repo-open-test.mjs';

const GRANT = '/run/ezil/git/grants/acme__site.json';
const HINT_NOT_CONNECTED = 'EZiL: Git access for this repository is not connected. Reopen it from EZiL OS.';
const HINT_EXPIRED = 'EZiL: Git access for acme/site expired. Reopen it from EZiL OS (Code renews it while open).';
const ENV = { PATH: '/usr/local/bin:/usr/bin:/bin' };

function plantGrant({ remainingS, mode, uid, symlink }, token) {
  const expiresAt = Date.now() + remainingS * 1000;
  const body = JSON.stringify({ v: 1, protocol: 'https', host: GIT_HOST, path: 'acme/site.git', username: 'ezil', password: token, expiresAt: new Date(expiresAt).toISOString(), scope: 'write' });
  const target = symlink ? '/run/ezil/git/grants/real.json' : GRANT;
  fs.writeFileSync(target, body, { mode: 0o600 });
  fs.chmodSync(target, Number.parseInt(mode, 8));
  fs.chownSync(target, uid, uid);
  if (symlink) fs.symlinkSync(target, GRANT);
  return Math.floor(new Date(new Date(expiresAt).toISOString()).getTime() / 1000);
}

function stdinOf(c) {
  if (typeof c.stdin === 'string') return c.stdin;
  // An otherwise valid request padded past the cap: size is the only reason to refuse.
  const head = `protocol=https\nhost=${GIT_HOST}\npath=acme/site.git\n`;
  const pad = c.stdin.repeatBytes - Buffer.byteLength(head) - '\n\n'.length - 'x='.length;
  const text = `${head}x=${'y'.repeat(pad)}\n\n`;
  assert.equal(Buffer.byteLength(text), c.stdin.repeatBytes);
  return text;
}

async function main() {
  const V = loadVectors();
  const fx = await startFixtures();
  fs.mkdirSync('/tmp/userhome', { recursive: true });
  const tests = [];
  const test = (title, fn) => tests.push([title, async () => { resetRun(); fx.server.state.mode = 'ok'; fx.proxy.state.mode = 'ok'; await fn(); }]);

  assert.ok(V.helperTranscripts.length >= 16);
  for (const c of V.helperTranscripts) {
    test(`helperTranscripts: ${c.case}`, async () => {
      const token = newToken();
      const epoch = c.grant ? plantGrant(c.grant, token) : null;
      const r = await spawnAsync(process.execPath, [HELPER_PATH, c.argv], { env: ENV, input: stdinOf(c) });
      assert.equal(r.status, 0);
      assert.equal(r.stdout, c.expectStdout.replace('<token>', token).replace('<epoch s>', String(epoch)));
      if (c.expectStderr === 'hint') {
        // The expiry hint names the requested route when it is a valid <handle>/<name>.git; otherwise the generic hint.
        const m = typeof c.stdin === 'string' ? /^path=([a-z0-9-]+)\/([a-z0-9._-]+)\.git$/m.exec(c.stdin) : /^path=([a-z0-9-]+)\/([a-z0-9._-]+)\.git$/m.exec(stdinOf(c));
        const expected = m && typeof c.stdin === 'string' ? `EZiL: Git access for ${m[1]}/${m[2]} expired. Reopen it from EZiL OS (Code renews it while open).` : HINT_NOT_CONNECTED;
        assert.equal(r.stderr, `${expected}\n`);
      } else {
        assert.equal(r.stderr, c.expectStderr);
      }
      if (!c.expectStdout.includes('<token>')) assert.equal(r.stdout.includes(token) || r.stderr.includes(token), false);
    });
  }

  test('a grant file whose own protocol, host, path or username differ from the request is refused', async () => {
    const token = newToken();
    const request = `protocol=https\nhost=${GIT_HOST}\npath=acme/site.git\n\n`;
    const grant = { v: 1, protocol: 'https', host: GIT_HOST, path: 'acme/site.git', username: 'ezil', password: token, expiresAt: new Date(Date.now() + 600000).toISOString(), scope: 'write' };
    const ask = async (patch) => {
      fs.rmSync(GRANT, { force: true });
      fs.writeFileSync(GRANT, JSON.stringify({ ...grant, ...patch }), { mode: 0o600 });
      return spawnAsync(process.execPath, [HELPER_PATH, 'get'], { env: ENV, input: request });
    };
    assert.match((await ask({})).stdout, /^username=ezil\n/); // the unpatched file answers
    for (const patch of [{ path: 'acme/other.git' }, { host: 'github.ezil.work' }, { protocol: 'http' }, { username: 'root' }, { password: 'egg_short' }]) {
      const r = await ask(patch);
      assert.equal(r.stdout, 'quit=1\n', JSON.stringify(patch));
      assert.equal(r.stderr, `${HINT_EXPIRED}\n`);
    }
  });

  test('the wrapper runs the helper with the kernel node and the same answers', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    const r = await spawnAsync(WRAPPER_PATH, ['get'], { env: ENV, input: `protocol=https\nhost=${GIT_HOST}\npath=acme/site.git\n\n` });
    assert.equal(r.status, 0);
    assert.match(r.stdout, new RegExp(`^username=ezil\\npassword=${token}\\npassword_expiry_utc=\\d+\\n$`));
    const refused = await spawnAsync(WRAPPER_PATH, ['get'], { env: ENV, input: `protocol=https\nhost=${GIT_HOST}\npath=acme/other.git\n\n` });
    assert.equal(refused.stdout, 'quit=1\n');
  });

  // Prompt recorders: if git ever asked anyone for a credential, these files would exist.
  const recorder = (name) => {
    const log = `/tmp/${name}.log`;
    const script = `/tmp/${name}.sh`;
    fs.writeFileSync(script, `#!/bin/sh\necho "$@" >> ${log}\necho quit=1\n`, { mode: 0o755 });
    fs.rmSync(log, { force: true });
    return { script, log };
  };
  const promptable = (fx, extra = {}) => {
    const askpass = recorder('askpass');
    // No GIT_TERMINAL_PROMPT=0 and every askpass hook armed: only the helper config can keep git from prompting.
    return { askpass, env: { PATH: ENV.PATH, HOME: '/tmp/userhome', GIT_CONFIG_NOSYSTEM: '1', GIT_ASKPASS: askpass.script, SSH_ASKPASS: askpass.script, ...extra } };
  };
  const lsRemote = (fx, cwd, env) => spawnAsync('setsid', ['git', '-c', `http.sslCAInfo=${fx.tls.ca}`, '-c', `http.proxy=${fx.proxy.url}`, 'ls-remote', 'origin'], { cwd, env });

  test('wrapper removed (container recycled): git ls-remote prints the not-connected hint, the helper says quit=1, git stops and never prompts', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    fs.rmSync(WRAPPER_PATH);
    const { askpass, env } = promptable(fx);
    const r = await lsRemote(fx, `${root}/repos/acme/site`, env);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(HINT_NOT_CONNECTED), r.stderr);
    assert.match(r.stderr, /told us to quit/);
    assert.equal(fs.existsSync(askpass.log), false, 'git prompted through askpass');
    assert.equal(r.stderr.includes(token), false);
  });

  test('the empty helper= line shuts out an inherited helper (and a control repository without it does consult that helper)', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    const inherited = recorder('global-helper');
    fs.writeFileSync('/tmp/global.gitconfig', `[credential]\n\thelper = !${inherited.script}\n`);
    const { askpass, env } = promptable(fx, { GIT_CONFIG_GLOBAL: '/tmp/global.gitconfig' });
    const ok = await lsRemote(fx, `${root}/repos/acme/site`, env);
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /refs\/heads\/main/);
    assert.equal(fs.existsSync(inherited.log), false, 'an inherited credential helper was consulted');
    assert.equal(fs.existsSync(askpass.log), false);
    // control: the same global helper IS consulted by a repository without the repo-local reset
    const control = fs.mkdtempSync('/tmp/control-');
    await spawnAsync('git', ['init', '-q', control], { env });
    await spawnAsync('git', ['-C', control, 'remote', 'add', 'origin', `https://${GIT_HOST}/acme/site.git`], { env });
    const denied = await lsRemote(fx, control, env);
    assert.notEqual(denied.status, 0);
    assert.equal(fs.existsSync(inherited.log), true, 'the control did not reach the inherited helper: the test proves nothing');
  });

  test('expired grant: git fetch prints the expiry hint and stops without prompting; a fresh grant restores access', async () => {
    const root = newRoot(); const token = newToken(); fx.server.state.token = token;
    makeRemote(fx, { branches: { main: { 'a.txt': 'a' } } });
    await openFlow(fx, { root, token });
    const grant = JSON.parse(fs.readFileSync(GRANT, 'utf8'));
    fs.writeFileSync(GRANT, JSON.stringify({ ...grant, expiresAt: new Date(Date.now() - 1000).toISOString() }), { mode: 0o600 });
    const { askpass, env } = promptable(fx);
    const r = await lsRemote(fx, `${root}/repos/acme/site`, env);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes(HINT_EXPIRED), r.stderr);
    assert.equal(fs.existsSync(askpass.log), false);
    await openFlow(fx, { root, token, uuid: crypto.randomUUID() });
    assert.equal((await lsRemote(fx, `${root}/repos/acme/site`, env)).status, 0);
  });

  try {
    const ok = await runSuite('ezil-git-grant-test', tests);
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
