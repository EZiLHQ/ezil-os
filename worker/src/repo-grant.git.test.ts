/**
 * Renewable push access (`./repo-grant.ts`, contract os-builder-project-open-v1 §7) against REAL git, the u2
 * kernel's real credential helper (node) and a real smart-HTTP server with HTTP Basic, the way EZiL Git
 * (github.ezil.work, git-qa.ezil.work) takes an `egg_` grant. The open script, the grant op and the person's
 * own `git push` all run in ONE private mount namespace whose /run is a fresh tmpfs (`unshare` + `nsenter`), so
 * the helper's fixed /run/ezil paths are real and the host's /run is never touched. Needs root, git, node,
 * openssl, unshare and nsenter; skipped otherwise.
 *
 * Acceptance (founder 9aae): edit → push #1 → expiry refuses → refresh → push #2; wrong subject, repository,
 * host and path refused; symlinks never followed; concurrent refreshes and retries never change identity or
 * lose work; the grant in no argv, environment, git config, folder, output or checkpointed path.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { REPO_OPEN_EXEC_TIMEOUT_MS, REPO_OPEN_TOKEN_ENV, type RepoOpenExec, type RepoOpenRequest } from './repo-open';
import {
  REPO_GRANT_GRANTS_DIR, REPO_GRANT_HELPER_CONFIG_VALUE, REPO_GRANT_HELPER_MODULE_PATH, REPO_GRANT_HELPER_WRAPPER_PATH,
  repoGrantSubject, repoOpenThenGrant, runRepoGrant, type RepoGrantRequest,
} from './repo-grant';
import { EZIL_GIT_GRANT_HELPER_SHA256 } from './repo-grant-helper.generated';

const which = (bin: string) => Bun.spawnSync(['sh', '-c', `command -v ${bin}`]).exitCode === 0;
const AVAILABLE = process.getuid?.() === 0 && ['git', 'node', 'openssl', 'unshare', 'nsenter'].every(which);
const egg = () => `egg_${createHash('sha256').update(crypto.randomUUID()).digest('hex')}`;
const T1 = egg(), T2 = egg(), T3 = egg(), T4 = egg();
const REPO = '7a1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
const OTHER = '8b2e3d5c-6b7a-4899-8a1c-2d3e4f5a6b7c';
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

describe.skipIf(!AVAILABLE)('repo-grant: renewable push access against real git and the u2 helper', () => {
  let dir: string, upstream: string, seed: string, home: string, root: string, cert: string;
  let server: ReturnType<typeof Bun.serve>;
  let holder: ReturnType<typeof Bun.spawn>;
  let url: string;
  let subjectA: string, subjectB: string;
  /** The tokens the server accepts right now (rotated by the tests), and what it saw. */
  const valid = new Set<string>();
  const seen: Array<{ path: string; user: string | null; service: string }> = [];
  const printed: string[] = [];

  /** A command in the private mount namespace. */
  const inNs = (argv: string[], env: Record<string, string> = {}, stdin?: string) => {
    const p = Bun.spawnSync(['nsenter', '-t', String(holder.pid), '-m', '--', ...argv], {
      env: { PATH: process.env.PATH!, HOME: home, GIT_SSL_CAINFO: cert, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...env },
      ...(stdin !== undefined ? { stdin: new Blob([stdin]) } : {}),
    });
    return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
  };
  /** The same, asynchronously: anything that talks to the in-process server must never block its event loop. */
  const inNsAsync = async (argv: string[], env: Record<string, string> = {}, stdin?: string) => {
    const p = Bun.spawn(['nsenter', '-t', String(holder.pid), '-m', '--', ...argv], {
      env: { PATH: process.env.PATH!, HOME: home, GIT_SSL_CAINFO: cert, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', ...env },
      stdin: stdin !== undefined ? new Blob([stdin]) : 'ignore', stdout: 'pipe', stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    return { code, out, err };
  };
  /** The Sandbox SDK's per-command env, as in repo-open.git.test.ts: exported in a bash that was started without it. */
  const exec = (token: string): RepoOpenExec => async (command, options) => {
    expect(command).not.toContain(token);
    expect(Object.keys(options.env)).toEqual([REPO_OPEN_TOKEN_ENV]);
    const exports = Object.entries(options.env).map(([k, v]) => `  export ${k}='${v.replace(/'/g, `'\\''`)}'\n`).join('');
    const r = await inNsAsync(['bash', '--norc'], {}, `{\n${exports}${command}\n} < /dev/null\n`);
    printed.push(r.out, r.err);
    return { exitCode: r.code, stdout: r.out, stderr: r.err };
  };
  const openRequest = (patch: Partial<RepoOpenRequest> = {}): RepoOpenRequest => ({
    repositoryId: REPO, canonicalURL: url, ref: 'refs/heads/main', branch: 'main', token: T1, expiresAt: iso(240_000),
    auth: 'basic', timeoutMs: REPO_OPEN_EXEC_TIMEOUT_MS, ...patch,
  });
  const grant = (patch: Partial<RepoGrantRequest> = {}): RepoGrantRequest => ({
    repositoryId: REPO, canonicalURL: url, token: T1, expiresAt: iso(240_000), scope: 'write', ...patch,
  });
  const repoDir = (r = root, id = REPO) => join(r, 'projects', id, 'repository');
  const git = (cwd: string, ...args: string[]) => inNs(['git', '-C', cwd, ...args], { GIT_CONFIG_GLOBAL: '/dev/null' });
  const edit = (file: string, text: string) => {
    writeFileSync(join(repoDir(), file), text);
    expect(git(repoDir(), 'add', file).code).toBe(0);
    expect(git(repoDir(), '-c', 'user.name=b', '-c', 'user.email=b@example.test', 'commit', '-qm', `edit ${file}`).code).toBe(0);
  };
  const push = () => inNsAsync(['git', '-C', repoDir(), 'push', 'origin', 'HEAD:main'], { GIT_CONFIG_GLOBAL: '/dev/null' });
  const grantFile = () => inNs(['cat', `${REPO_GRANT_GRANTS_DIR}/acme__site.json`]).out;
  const upstreamHead = () => Bun.spawnSync(['git', '--git-dir', join(upstream, 'acme', 'site.git'), 'rev-parse', 'refs/heads/main']).stdout.toString().trim();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'ezil-repo-grant-it-'));
    upstream = join(dir, 'upstream'); seed = join(dir, 'seed'); home = join(dir, 'home'); root = join(dir, 'workspace');
    for (const d of [upstream, home, root]) mkdirSync(d, { recursive: true });
    const sh = (args: string[], cwd?: string) => {
      const r = Bun.spawnSync(args, { cwd, env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
      if (r.exitCode !== 0) throw new Error(`${args.join(' ')}: ${r.stderr.toString()}`);
    };
    for (const name of ['site', 'other']) {
      sh(['git', 'init', '-q', '--bare', join(upstream, 'acme', `${name}.git`)]);
      sh(['git', 'symbolic-ref', 'HEAD', 'refs/heads/main'], join(upstream, 'acme', `${name}.git`));
    }
    sh(['git', 'init', '-q', seed]);
    writeFileSync(join(seed, 'README.md'), '# site\n');
    sh(['git', 'add', 'README.md'], seed);
    sh(['git', '-c', 'user.name=s', '-c', 'user.email=s@example.test', 'commit', '-qm', 'seed'], seed);
    for (const name of ['site', 'other']) sh(['git', 'push', '-q', join(upstream, 'acme', `${name}.git`), 'HEAD:main'], seed);
    cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    sh(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0, tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') },
      async fetch(req) {
        const u = new URL(req.url);
        const auth = req.headers.get('authorization') ?? '';
        const basic = auth.startsWith('Basic ') ? atob(auth.slice(6)) : '';
        const token = basic.startsWith('ezil:') ? basic.slice(5) : '';
        const service = u.searchParams.get('service') ?? u.pathname.split('/').pop() ?? '';
        seen.push({ path: u.pathname, user: token ? (token === T1 ? 'T1' : token === T2 ? 'T2' : token === T3 ? 'T3' : token === T4 ? 'T4' : 'other') : null, service });
        if (!valid.has(token)) return new Response('auth', { status: 401, headers: { 'www-authenticate': 'Basic realm="ezil-it"' } });
        const proc = Bun.spawn(['git', 'http-backend'], {
          env: {
            PATH: process.env.PATH!, GIT_PROJECT_ROOT: upstream, GIT_HTTP_EXPORT_ALL: '1', REQUEST_METHOD: req.method,
            PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1), CONTENT_TYPE: req.headers.get('content-type') ?? '',
            REMOTE_ADDR: '127.0.0.1', REMOTE_USER: 'ezil',
            ...(req.headers.get('git-protocol') ? { GIT_PROTOCOL: req.headers.get('git-protocol')! } : {}),
            ...(req.headers.get('content-encoding') ? { HTTP_CONTENT_ENCODING: req.headers.get('content-encoding')! } : {}),
          },
          stdin: new Blob([await req.arrayBuffer()]), stdout: 'pipe', stderr: 'ignore',
        });
        const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
        await proc.exited;
        let split = out.indexOf('\r\n\r\n'); let gap = 4;
        if (split < 0) { split = out.indexOf('\n\n'); gap = 2; }
        const headers = new Headers(); let status = 200;
        for (const line of out.subarray(0, split).toString().split(/\r?\n/)) {
          const i = line.indexOf(':'); if (i < 0) continue;
          const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
          if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10); else headers.append(k, v);
        }
        return new Response(out.subarray(split + gap), { status, headers });
      },
    });
    url = `https://127.0.0.1:${server.port}/acme/site.git`;
    // The computer: a private mount namespace whose /run is empty, held open by a sleeping process.
    holder = Bun.spawn(['unshare', '--mount', '--propagation', 'private', 'bash', '-c', 'mount -t tmpfs -o mode=0755 tmpfs /run && echo ready && exec sleep 900'], { stdout: 'pipe', stderr: 'pipe' });
    const reader = holder.stdout.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    if (!first.includes('ready')) throw new Error('namespace holder did not start');
    expect(inNs(['ls', '-A', '/run']).out.trim()).toBe('');
    subjectA = await repoGrantSubject('user-a');
    subjectB = await repoGrantSubject('user-b');
    valid.add(T1);
  });
  afterAll(() => {
    holder?.kill();
    server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('open (no scope): the folder is placed exactly as before and no push access is installed', async () => {
    const opened = await repoOpenThenGrant({ running: async () => true, touch: () => undefined, exec: exec(T1) }, openRequest(),
      { path: root, requireHydrated: false }, subjectA);
    expect(opened).toMatchObject({ ok: true, status: 'cloned' });
    expect(inNs(['test', '-e', `${REPO_GRANT_GRANTS_DIR}/acme__site.json`]).code).not.toBe(0);
  });

  it('🔴 edit → push #1 → expiry refuses → refresh → push #2; the person\'s uncommitted work and HEAD never move', async () => {
    const first = grant();
    expect(await runRepoGrant(exec(T1), first, { path: root, requireHydrated: false }, subjectA)).toEqual({ ok: true, expiresAt: first.expiresAt });
    edit('one.txt', 'first edit\n');
    const p1 = await push();
    expect(p1.code).toBe(0);
    expect(upstreamHead()).toBe(git(repoDir(), 'rev-parse', 'HEAD').out.trim());
    expect(seen.some((s) => s.service === 'git-receive-pack' && s.user === 'T1')).toBe(true);
    // Expiry: a grant with less than the helper's 30 s margin left is refused locally, with the fixed hint,
    // and no credential reaches the server.
    expect((await runRepoGrant(exec(T1), grant({ expiresAt: iso(20_000) }), { path: root, requireHydrated: false }, subjectA)).ok).toBe(true);
    edit('two.txt', 'second edit\n');
    const before = seen.length;
    const refused = await push();
    expect(refused.code).not.toBe(0);
    expect(refused.err).toContain('EZiL: Git access for acme/site expired. Reopen it from EZiL OS (Code renews it while open).');
    expect(seen.slice(before).filter((s) => s.user !== null)).toEqual([]);
    // The server rotates to a new grant (the old one has expired there too); the person has uncommitted work.
    valid.delete(T1); valid.add(T2);
    writeFileSync(join(repoDir(), 'wip.txt'), 'not committed\n');
    writeFileSync(join(repoDir(), 'README.md'), '# site, edited but not staged\n');
    const status = git(repoDir(), 'status', '--porcelain').out;
    const head = git(repoDir(), 'rev-parse', 'HEAD').out;
    const index = createHash('sha256').update(readFileSync(join(repoDir(), '.git', 'index'))).digest('hex');
    // Refresh: T2, five minutes. Nothing in the folder changes but the grant.
    expect(await runRepoGrant(exec(T2), grant({ token: T2, expiresAt: iso(300_000) }), { path: root, requireHydrated: false }, subjectA))
      .toMatchObject({ ok: true });
    expect(git(repoDir(), 'status', '--porcelain').out).toBe(status);
    expect(git(repoDir(), 'rev-parse', 'HEAD').out).toBe(head);
    expect(createHash('sha256').update(readFileSync(join(repoDir(), '.git', 'index'))).digest('hex')).toBe(index);
    const p2 = await push();
    expect(p2.code).toBe(0);
    expect(upstreamHead()).toBe(head.trim());
    expect(seen.filter((s) => s.service === 'git-receive-pack' && s.user === 'T2').length).toBeGreaterThan(0);
    expect(readFileSync(join(repoDir(), 'wip.txt'), 'utf8')).toBe('not committed\n');
  });

  it('the grant and helper are root-only under /run, the u2 helper byte for byte; nothing secret is in git config, the folder or any output', () => {
    const g = JSON.parse(grantFile()) as Record<string, string>;
    expect(Object.keys(g).sort()).toEqual(['expiresAt', 'host', 'password', 'path', 'protocol', 'scope', 'username', 'v']);
    expect(g).toMatchObject({ v: 1, protocol: 'https', host: `127.0.0.1:${server.port}`, path: 'acme/site.git', username: 'ezil', password: T2, scope: 'write' });
    expect(inNs(['stat', '-c', '%a %u', `${REPO_GRANT_GRANTS_DIR}/acme__site.json`]).out.trim()).toBe('600 0');
    expect(inNs(['stat', '-c', '%a %u', REPO_GRANT_HELPER_WRAPPER_PATH]).out.trim()).toBe('500 0');
    expect(inNs(['stat', '-c', '%a', '/run/ezil', '/run/ezil/git', REPO_GRANT_GRANTS_DIR, '/run/ezil/bin']).out.trim().split('\n')).toEqual(['700', '700', '700', '700']);
    expect(createHash('sha256').update(inNs(['cat', REPO_GRANT_HELPER_MODULE_PATH]).out).digest('hex')).toBe(EZIL_GIT_GRANT_HELPER_SHA256);
    const config = readFileSync(join(repoDir(), '.git', 'config'), 'utf8');
    for (const t of [T1, T2]) {
      expect(config).not.toContain(t);
      expect(config).not.toContain(t.slice(4));
      for (const out of printed) expect(out).not.toContain(t);
    }
    const helpers = git(repoDir(), 'config', '--local', '--get-all', `credential.https://127.0.0.1:${server.port}.helper`).out;
    expect(helpers).toBe(`\n${REPO_GRANT_HELPER_CONFIG_VALUE}\n`);
    expect(git(repoDir(), 'config', '--local', '--get-all', `credential.https://127.0.0.1:${server.port}.usehttppath`).out.trim()).toBe('true');
    expect(git(repoDir(), 'remote', '-v').out).not.toMatch(/egg_|@127/);
    // The workspace (what a checkpoint archives) holds no grant: every file under the root, bytes compared.
    const hits: string[] = [];
    const walk = (d: string) => { for (const n of readdirSync(d)) { const p = join(d, n); const st = lstatSync(p); if (st.isDirectory()) walk(p); else if (st.isFile() && (readFileSync(p).includes(T1) || readFileSync(p).includes(T2))) hits.push(p); } };
    walk(root);
    expect(hits).toEqual([]);
  });

  it('wrong subject, repository, host or path is refused, and the installed grant is untouched', async () => {
    const r = { path: root, requireHydrated: false };
    const installed = grantFile();
    expect(await runRepoGrant(exec(T3), grant({ token: T3 }), r, subjectB)).toEqual({ ok: false, error: 'repo_grant_conflict' });
    expect(await runRepoGrant(exec(T3), grant({ token: T3, repositoryId: OTHER }), r, subjectA)).toEqual({ ok: false, error: 'repo_grant_not_open' });
    expect(await runRepoGrant(exec(T3), grant({ token: T3, canonicalURL: url.replace('/site.git', '/other.git') }), r, subjectA)).toEqual({ ok: false, error: 'repo_grant_not_open' });
    expect(await runRepoGrant(exec(T3), grant({ token: T3, canonicalURL: url.replace('127.0.0.1', 'localhost') }), r, subjectA)).toEqual({ ok: false, error: 'repo_grant_not_open' });
    expect(await runRepoGrant(exec(T3), grant({ token: T3 }), { path: join(dir, 'nowhere'), requireHydrated: false }, subjectA)).toEqual({ ok: false, error: 'repo_grant_not_open' });
    expect(await runRepoGrant(exec('not-an-egg'), grant({ token: 'not-an-egg' }), r, subjectA)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    expect(grantFile()).toBe(installed);
  });

  it('🔴 symlinks are never followed: projects, the project folder, the repository, .git or .git/config as a link, and a linked /run grants directory', async () => {
    const installed = grantFile();
    const linked = join(dir, 'linked');
    // the same repository reached only through a link, at each level in turn
    for (const level of ['projects', 'folder', 'repository', 'git', 'config'] as const) {
      const r = join(linked, level);
      rmSync(r, { recursive: true, force: true });
      mkdirSync(join(r, 'real'), { recursive: true });
      Bun.spawnSync(['cp', '-a', join(root, 'projects'), join(r, 'real', 'projects')]);
      const real = join(r, 'real', 'projects');
      if (level === 'projects') symlinkSync(real, join(r, 'projects'));
      else {
        Bun.spawnSync(['cp', '-a', real, join(r, 'projects')]);
        const folder = join(r, 'projects', REPO);
        if (level === 'folder') { rmSync(folder, { recursive: true }); symlinkSync(join(real, REPO), folder); }
        if (level === 'repository') { rmSync(join(folder, 'repository'), { recursive: true }); symlinkSync(join(real, REPO, 'repository'), join(folder, 'repository')); }
        if (level === 'git') { rmSync(join(folder, 'repository', '.git'), { recursive: true }); symlinkSync(join(real, REPO, 'repository', '.git'), join(folder, 'repository', '.git')); }
        if (level === 'config') { rmSync(join(folder, 'repository', '.git', 'config')); symlinkSync(join(real, REPO, 'repository', '.git', 'config'), join(folder, 'repository', '.git', 'config')); }
      }
      expect({ level, got: await runRepoGrant(exec(T3), grant({ token: T3 }), { path: r, requireHydrated: false }, subjectA) })
        .toEqual({ level, got: { ok: false, error: 'repo_grant_not_open' } });
    }
    expect(grantFile()).toBe(installed);
    // /run/ezil/git/grants replaced by a link to a directory the attacker reads: refused, nothing written there.
    const bait = join(dir, 'bait');
    mkdirSync(bait);
    expect(inNs(['bash', '-c', `mv ${REPO_GRANT_GRANTS_DIR} /run/ezil/git/grants.real && ln -s ${bait} ${REPO_GRANT_GRANTS_DIR}`]).code).toBe(0);
    expect(await runRepoGrant(exec(T3), grant({ token: T3 }), { path: root, requireHydrated: false }, subjectA)).toEqual({ ok: false, error: 'repo_grant_failed' });
    expect(readdirSync(bait)).toEqual([]);
    expect(inNs(['bash', '-c', `rm ${REPO_GRANT_GRANTS_DIR} && mv /run/ezil/git/grants.real ${REPO_GRANT_GRANTS_DIR}`]).code).toBe(0);
    expect(grantFile()).toBe(installed);
  });

  it('concurrent refreshes (two tabs, a remint) all succeed; the grant is always one whole grant and no temporary file is left', async () => {
    const r = { path: root, requireHydrated: false };
    valid.add(T3); valid.add(T4);
    const answers = await Promise.all([T2, T3, T4, T3].map((t) => runRepoGrant(exec(t), grant({ token: t, expiresAt: iso(290_000) }), r, subjectA)));
    expect(answers.every((a) => a.ok)).toBe(true);
    const g = JSON.parse(grantFile()) as { password: string };
    expect([T2, T3, T4]).toContain(g.password);
    expect(inNs(['ls', '-A', REPO_GRANT_GRANTS_DIR]).out.trim().split('\n').sort()).toEqual(['acme__site.bind', 'acme__site.json']);
    expect(inNs(['ls', '-A', '/run/ezil/bin']).out.trim().split('\n').sort()).toEqual(['ezil-git-grant', 'ezil-git-grant.mjs']);
    edit('three.txt', 'after concurrent refreshes\n');
    expect((await push()).code).toBe(0);
  });

  it('retries: a repeated refresh and a repeated open keep the identity and the work; an open with a scope installs push access itself', async () => {
    const r = { path: root, requireHydrated: false };
    const bind = inNs(['cat', `${REPO_GRANT_GRANTS_DIR}/acme__site.bind`]).out;
    expect(bind).toBe(`v1 ${subjectA} ${REPO} ${url}\n`);
    for (let i = 0; i < 2; i += 1) expect((await runRepoGrant(exec(T4), grant({ token: T4 }), r, subjectA)).ok).toBe(true);
    writeFileSync(join(repoDir(), 'wip2.txt'), 'still mine\n');
    const head = git(repoDir(), 'rev-parse', 'HEAD').out;
    valid.clear(); valid.add(T3);
    // The open retried (a remint): fetch only, the grant from the open's own token, the same slot owner.
    const deps = { running: async () => true, touch: () => undefined, exec: exec(T3) };
    const reopened = await repoOpenThenGrant(deps, openRequest({ token: T3, scope: 'write', expiresAt: iso(280_000) }), r, subjectA);
    expect(reopened).toMatchObject({ ok: true, status: 'fetched' });
    expect(JSON.parse(grantFile())).toMatchObject({ password: T3 });
    expect(inNs(['cat', `${REPO_GRANT_GRANTS_DIR}/acme__site.bind`]).out).toBe(bind);
    expect(git(repoDir(), 'rev-parse', 'HEAD').out).toBe(head);
    expect(readFileSync(join(repoDir(), 'wip2.txt'), 'utf8')).toBe('still mine\n');
    edit('four.txt', 'after the reopen\n');
    expect((await push()).code).toBe(0);
    // Another subject reopening the same computer gets the folder (the open is unchanged) but never the slot.
    valid.add(T4);
    const other = await repoOpenThenGrant({ ...deps, exec: exec(T4) }, openRequest({ token: T4, scope: 'write' }), r, subjectB);
    expect(other).toMatchObject({ ok: true });
    expect(JSON.parse(grantFile())).toMatchObject({ password: T3 });
    expect(inNs(['cat', `${REPO_GRANT_GRANTS_DIR}/acme__site.bind`]).out).toBe(bind);
  });
});
