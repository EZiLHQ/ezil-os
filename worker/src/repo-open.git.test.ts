/**
 * `repo-open`'s container script against REAL git and a real smart-HTTP git
 * server: a local HTTPS server (self-signed, trusted through
 * `GIT_SSL_CAINFO`) that hands every authorized request to `git
 * http-backend`. Under `/bearer/` it demands `Authorization: Bearer <token>`,
 * which is what Cloudflare Artifacts takes (EZiL CLI `apps/git-gateway` sends
 * exactly that upstream); everywhere else HTTP Basic `ezil:<token>`, which is
 * what EZiL Git's gateway (github.ezil.work) takes.
 *
 * The script runs through `runRepoOpen` with an exec that does what the
 * Sandbox SDK does with a per-command `env` (the value is in the shell's
 * environment for that one command, never in the command string). What it
 * proves, with the token known to the test:
 *   - it is in no argv: not of any `git` the script runs (a `git` shim first
 *     on PATH logs every invocation's arguments, its working directory, and
 *     whether its ENVIRONMENT holds the token, which it detects from the
 *     token's hex so the log never holds the token itself), and not of
 *     anything git itself spawns (`GIT_TRACE` logs every run_command, the
 *     credential helper's shell included). Both logs are asserted non-empty,
 *     so the checks are not vacuous. Nor in anything the script printed, nor
 *     in any URL the server saw;
 *   - 🔴 exactly one git command per open has the token in its environment,
 *     the network fetch into the private repository under /tmp, and no git
 *     command that names or runs in the person's folder has it;
 *   - 🔴 a clone whose config tries to send the fetch elsewhere cannot: a
 *     prepended `remote.origin.url`, an `include.path` / `includeIf` file with
 *     `url.<evil>.insteadOf` and `http.<evil>.sslVerify=false`, an included
 *     `http.<url>.proxy`, and the same settings written directly. A second
 *     HTTPS server (the "evil" host, trusted by the same CA, so a leak would
 *     succeed) and a TCP listener (the "proxy") record any contact; neither
 *     sees one, and the open still succeeds;
 *   - `.git/config` and every other file under the clone are free of it, and
 *     `remote.origin.url` is the canonical URL with no userinfo;
 *   - a `credential.helper=store` in the computer's own `~/.gitconfig`, or in
 *     the clone's own `.git/config`, never runs (its file is never written),
 *     in either scheme;
 *   - Bearer travels only as that header: the server never sees Basic for it,
 *     and the clone's config holds no `extraHeader`;
 *   - a second open fetches only: an uncommitted edit and HEAD survive, while
 *     the remote-tracking ref moves;
 *   - every refusal (bad grant, missing branch, foreign folder, unhydrated
 *     workspace) leaves the folder untouched.
 *
 * Runs on the host's git by default. `EZIL_REPO_OPEN_IT_IMAGE=cloudflare/sandbox:0.12.1`
 * runs the same script inside that image instead (git 2.34.1, the computer's
 * own), with the token passed to `docker run -e NAME` from the environment.
 * Skipped when git or openssl is missing.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runRepoOpen, REPO_OPEN_EXEC_TIMEOUT_MS, REPO_OPEN_TOKEN_ENV, type RepoOpenExec, type RepoOpenRequest } from './repo-open';

const which = (bin: string) => Bun.spawnSync(['sh', '-c', `command -v ${bin}`]).exitCode === 0;
/** The real git the shim hands over to: the host's own, or the image's. */
const REAL_GIT = process.env.EZIL_REPO_OPEN_IT_IMAGE?.trim() ? '/usr/bin/git'
  : Bun.spawnSync(['sh', '-c', 'command -v git']).stdout.toString().trim();
const IMAGE = process.env.EZIL_REPO_OPEN_IT_IMAGE?.trim() || '';
const AVAILABLE = which('git') && which('openssl') && (!IMAGE || which('docker'));

/** Opaque, and full of what a shell or a config parser would trip on: it must arrive byte for byte. */
const TOKEN = `art_v1_${'7e57'.repeat(16)}$(id)\`x\`"'\\;|&~+/=%s`;
const WRONG = `art_v1_${'0bad'.repeat(16)}`;
const BEARER = `Bearer ${TOKEN}`;
const BASIC = `Basic ${btoa(`ezil:${TOKEN}`)}`;
const REPO = '3f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';

function sh(args: string[], opts: { cwd?: string; env?: Record<string, string> } = {}) {
  const r = Bun.spawnSync(args, { cwd: opts.cwd, env: { PATH: process.env.PATH!, HOME: opts.env?.HOME ?? tmpdir(), ...opts.env } });
  if (r.exitCode !== 0) throw new Error(`${args.join(' ')} failed: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

/** Every file under `dir` whose bytes contain `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile() && readFileSync(p).includes(needle)) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

describe.skipIf(!AVAILABLE)(`repo-open script against real git${IMAGE ? ` in ${IMAGE}` : ''}`, () => {
  let dir: string;
  let upstream: string;
  let seed: string;
  let home: string;
  let root: string;
  let cert: string;
  let trace: string;
  let argvLog: string;
  let tokenHex: string;
  let bin: string;
  let server: ReturnType<typeof Bun.serve>;
  /** Another HTTPS host, with a certificate the same CA vouches for: anything sent here would have been accepted. */
  let evil: ReturnType<typeof Bun.serve>;
  let evilBase: string;
  /** A plain TCP listener standing in for a proxy: any connection is recorded and closed. */
  let proxy: ReturnType<typeof Bun.listen>;
  /** Basic (EZiL Git's scheme) at the root, Bearer (Cloudflare Artifacts') under `/bearer/`. */
  let url: string;
  let bearerUrl: string;
  let base: string;
  const seen: Array<{ url: string; auth: string | null; leak: string | null }> = [];
  const evilSeen: Array<{ url: string; auth: string | null }> = [];
  const proxied: string[] = [];
  const printed: string[] = [];

  /** The SDK's per-command env, applied the way the session shell applies it. */
  const exec = (token: string): RepoOpenExec => async (command, options) => {
    expect(command).not.toContain(token);
    expect(Object.keys(options.env)).toEqual([REPO_OPEN_TOKEN_ENV]);
    const shimmed = `${bin}:${IMAGE ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' : process.env.PATH!}`;
    const envFor = { PATH: shimmed, HOME: home, GIT_SSL_CAINFO: cert, GIT_TRACE: trace, EZIL_IT_ARGV_LOG: argvLog,
      EZIL_IT_TOKEN_HEX: tokenHex, ...options.env };
    // In docker, `-e NAME` (no value) copies NAME from the docker CLI's own
    // environment, so the token is never on docker's command line either. PATH
    // is the exception: the CLI needs the host's to find docker, so the
    // container's (not secret) is given by value.
    const argv = IMAGE
      ? ['docker', 'run', '--rm', '--network', 'host', '-v', `${dir}:${dir}`, '--entrypoint', 'bash', '-e', `PATH=${shimmed}`,
        ...Object.keys(envFor).filter((k) => k !== 'PATH').flatMap((k) => ['-e', k]), IMAGE, '-c', command]
      : ['bash', '-c', command];
    for (const arg of argv) expect(arg).not.toContain(token);
    const proc = Bun.spawn(argv, { env: IMAGE ? { ...envFor, PATH: process.env.PATH! } : envFor, stdout: 'pipe', stderr: 'pipe' });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    printed.push(stdout, stderr);
    return { exitCode, stdout, stderr };
  };
  const request = (patch: Partial<RepoOpenRequest> = {}): RepoOpenRequest => ({
    repositoryId: REPO, canonicalURL: url, ref: 'refs/heads/main', branch: 'main', token: TOKEN,
    expiresAt: new Date(Date.now() + 240_000).toISOString(), auth: 'basic', timeoutMs: REPO_OPEN_EXEC_TIMEOUT_MS, ...patch,
  });
  const bearer = (patch: Partial<RepoOpenRequest> = {}): Partial<RepoOpenRequest> => ({ canonicalURL: bearerUrl, auth: 'bearer', ...patch });
  const open = (patch: Partial<RepoOpenRequest> = {}, opts: { requireHydrated?: boolean; root?: string } = {}) =>
    runRepoOpen(exec(patch.token ?? TOKEN), request(patch), { path: opts.root ?? root, requireHydrated: opts.requireHydrated ?? false });
  const git = (cwd: string, ...args: string[]) => sh(['git', ...args], { cwd, env: { HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });
  const commit = (message: string, file: string, content: string) => {
    writeFileSync(join(seed, file), content);
    git(seed, 'add', file);
    git(seed, '-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-qm', message);
    git(seed, 'push', '-q', 'origin', 'HEAD:main');
    return git(seed, 'rev-parse', 'HEAD');
  };
  /** The shim's log: one entry per `git` the script ran, with whether its environment held the token. */
  const ran = () => readFileSync(argvLog, 'utf8').split('\n').filter(Boolean).map((line) => {
    const [env, cwd, ...argv] = line.split('\t');
    return { token: env === 'token', cwd: cwd!, argv: argv.join('\t') };
  });
  /**
   * 🔴 The isolation invariant, for the `opens` opens logged since `mark`: each
   * had exactly one git command with the token in its environment, the network
   * fetch of the canonical URL into the private repository, run in the private
   * directory; every other command, and so everything that named or ran in an
   * existing folder in the workspace (`fetched`: some must have), had none.
   */
  const expectIsolated = (mark: number, opens: number, fetched = true) => {
    const mine = ran().slice(mark);
    const withToken = mine.filter((r) => r.token);
    expect(withToken).toHaveLength(opens);
    for (const r of withToken) {
      expect(r.cwd).toMatch(/^\/tmp\/ezil-repo-open\.[A-Za-z0-9]+$/);
      expect(r.argv).toMatch(new RegExp(String.raw`^git --git-dir=/tmp/ezil-repo-open\.[A-Za-z0-9]+/mirror fetch --quiet --no-tags `
        + String.raw`--no-recurse-submodules --no-write-fetch-head -- https://127\.0\.0\.1:${server.port}/(bearer/)?acme/[a-z]+\.git `
        + String.raw`\+refs/heads/\*:refs/heads/\* \+refs/tags/\*:refs/tags/\*$`));
      expect(r.argv).not.toContain(TOKEN);
    }
    expect(mine.length).toBeGreaterThan(opens);
    const workspace = mine.filter((r) => r.argv.includes(root) || r.cwd.startsWith(root));
    if (fetched) expect(workspace.length).toBeGreaterThan(0);
    expect(workspace.filter((r) => r.token)).toEqual([]);
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ezil-repo-open-it-'));
    upstream = join(dir, 'upstream');
    seed = join(dir, 'seed');
    home = join(dir, 'home');
    root = join(dir, 'workspace');
    trace = join(dir, 'git-trace.log');
    argvLog = join(dir, 'git-argv.log');
    bin = join(dir, 'bin');
    for (const d of [upstream, home, root, bin]) mkdirSync(d, { recursive: true });
    // Records, for every `git` the script runs, whether the token is anywhere in
    // its environment (matched as hex, so neither this file nor the log holds
    // the token), its working directory and its arguments; then runs the real one.
    tokenHex = join(dir, 'token.hex');
    writeFileSync(tokenHex, Buffer.from(TOKEN).toString('hex'));
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      `if env | od -An -v -tx1 | tr -d ' \\n' | grep -qF "$(cat "$EZIL_IT_TOKEN_HEX")"; then t=token; else t=clean; fi`,
      `printf '%s\\t%s\\tgit %s\\n' "$t" "$(pwd)" "$*" >> "$EZIL_IT_ARGV_LOG"`,
      `exec ${REAL_GIT} "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    // The computer's own git config asks for a credential store. It must never run.
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = store\n');
    sh(['git', 'init', '-q', '--bare', join(upstream, 'acme', 'site.git')]);
    sh(['git', 'symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: join(upstream, 'acme', 'site.git') });
    sh(['git', 'init', '-q', seed]);
    git(seed, 'remote', 'add', 'origin', join(upstream, 'acme', 'site.git'));
    commit('seed', 'README.md', '# site\n');
    cert = join(dir, 'cert.pem');
    const key = join(dir, 'key.pem');
    sh(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1',
      '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1']);
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0, tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') },
      async fetch(req) {
        const u = new URL(req.url);
        seen.push({ url: req.url, auth: req.headers.get('authorization'), leak: req.headers.get('x-leak') });
        const isBearer = u.pathname.startsWith('/bearer/');
        if (req.headers.get('authorization') !== (isBearer ? BEARER : BASIC)) {
          return new Response('authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="ezil-it"' } });
        }
        const proc = Bun.spawn(['git', 'http-backend'], {
          env: {
            PATH: process.env.PATH!, GIT_PROJECT_ROOT: upstream, GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: req.method, PATH_INFO: isBearer ? u.pathname.slice('/bearer'.length) : u.pathname, QUERY_STRING: u.search.slice(1),
            CONTENT_TYPE: req.headers.get('content-type') ?? '', REMOTE_ADDR: '127.0.0.1', REMOTE_USER: 'ezil',
            ...(req.headers.get('git-protocol') ? { GIT_PROTOCOL: req.headers.get('git-protocol')! } : {}),
            ...(req.headers.get('content-encoding') ? { HTTP_CONTENT_ENCODING: req.headers.get('content-encoding')! } : {}),
          },
          stdin: new Blob([await req.arrayBuffer()]), stdout: 'pipe', stderr: 'ignore',
        });
        const out = Buffer.from(await new Response(proc.stdout).arrayBuffer());
        await proc.exited;
        let split = out.indexOf('\r\n\r\n');
        let gap = 4;
        if (split < 0) { split = out.indexOf('\n\n'); gap = 2; }
        const headers = new Headers();
        let status = 200;
        for (const line of out.subarray(0, split).toString().split(/\r?\n/)) {
          const i = line.indexOf(':');
          if (i < 0) continue;
          const [k, v] = [line.slice(0, i).trim(), line.slice(i + 1).trim()];
          if (k.toLowerCase() === 'status') status = Number.parseInt(v, 10);
          else headers.append(k, v);
        }
        return new Response(out.subarray(split + gap), { status, headers });
      },
    });
    base = `https://127.0.0.1:${server.port}`;
    url = `${base}/acme/site.git`;
    bearerUrl = `${base}/bearer/acme/site.git`;
    // Answers every request as a server wanting Basic credentials would, so git
    // would hand over a Basic credential as well as a Bearer header.
    evil = Bun.serve({
      hostname: '127.0.0.1', port: 0, tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') },
      fetch(req) {
        evilSeen.push({ url: req.url, auth: req.headers.get('authorization') });
        return new Response('no', { status: 401, headers: { 'www-authenticate': 'Basic realm="evil"' } });
      },
    });
    evilBase = `https://127.0.0.1:${evil.port}`;
    proxy = Bun.listen({
      hostname: '127.0.0.1', port: 0,
      socket: { open(socket) { proxied.push('connect'); socket.end(); }, data() {} },
    });
  });

  afterAll(() => {
    server?.stop(true);
    evil?.stop(true);
    proxy?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('🔴 clones into <root>/projects/<id> with the token in no argv, file, URL or output', async () => {
    const upstreamHead = git(seed, 'rev-parse', 'HEAD');
    const mark = existsSync(argvLog) ? ran().length : 0;
    const answer = await open();
    expect(answer).toEqual({ ok: true, folder: join(root, 'projects', REPO), head: upstreamHead, status: 'cloned' });
    const folder = join(root, 'projects', REPO);
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# site\n');
    expect(git(folder, 'symbolic-ref', 'HEAD')).toBe('refs/heads/main');
    // The remote is the canonical URL, with no userinfo; the clone's config names no helper.
    expect(git(folder, 'config', '--local', '--get', 'remote.origin.url')).toBe(url);
    expect(readFileSync(join(folder, '.git', 'config'), 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(join(folder, '.git', 'config'), 'utf8')).not.toMatch(/credential|helper/);
    expect(filesContaining(folder, TOKEN)).toEqual([]);
    // GIT_TRACE logged every process git ran, the credential helper's shell included.
    const traced = readFileSync(trace, 'utf8');
    expect(traced).toMatch(/run_command:.*f\(\) \{ test "\$1" = get/);
    expect(traced).not.toContain(TOKEN);
    const logged = readFileSync(argvLog, 'utf8');
    expect(logged).toContain(`--no-write-fetch-head -- ${url} `);
    expect(logged).toMatch(/git clone --quiet --branch main --origin origin -- \/tmp\/ezil-repo-open\.[A-Za-z0-9]+\/mirror /);
    expect(logged).not.toContain(TOKEN);
    expectIsolated(mark, 1, false);
    // The server saw the credential only as Basic auth, never in a URL.
    expect(seen.some((s) => s.auth === BASIC)).toBe(true);
    expect(seen.filter((s) => s.url.includes(TOKEN) || s.url.includes('art_v1_'))).toEqual([]);
    // The computer's own `credential.helper = store` never ran.
    expect(existsSync(join(home, '.git-credentials'))).toBe(false);
    expect(printed.join('\n')).not.toContain(TOKEN);
    expect(filesContaining(dir, TOKEN).filter((p) => !p.startsWith(join(dir, 'upstream')))).toEqual([]);
  });

  it('🔴 a second open fetches only: an uncommitted edit and HEAD survive, the remote-tracking ref moves', async () => {
    const folder = join(root, 'projects', REPO);
    const before = git(folder, 'rev-parse', 'HEAD');
    writeFileSync(join(folder, 'README.md'), '# site\nwork in progress\n');
    writeFileSync(join(folder, 'notes.txt'), 'untracked\n');
    const next = commit('second', 'CHANGELOG.md', 'v2\n');
    const mark = ran().length;
    const answer = await open();
    expect(answer).toEqual({ ok: true, folder, head: before, status: 'fetched' });
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# site\nwork in progress\n');
    expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(git(folder, 'rev-parse', 'refs/remotes/origin/main')).toBe(next);
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(before);
    expect(git(folder, 'config', '--local', '--get', 'remote.origin.url')).toBe(url);
    expect(filesContaining(folder, TOKEN)).toEqual([]);
    expect(readFileSync(trace, 'utf8')).not.toContain(TOKEN);
    // The person's folder is fetched from the private repository, by path, never from `origin`.
    expect(ran().slice(mark).map((r) => r.argv)).toContainEqual(expect.stringMatching(new RegExp(
      String.raw`^git -C ${folder} fetch --quiet --no-recurse-submodules /tmp/ezil-repo-open\.[A-Za-z0-9]+/mirror \+refs/heads/\*:refs/remotes/origin/\*$`)));
    expect(readFileSync(argvLog, 'utf8')).not.toContain(TOKEN);
    expectIsolated(mark, 1);
  });

  it('a refused grant is repo_open_auth_failed and creates nothing', async () => {
    const id = '4f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    expect(await open({ repositoryId: id, token: WRONG })).toEqual({ ok: false, error: 'repo_open_auth_failed' });
    expect(existsSync(join(root, 'projects', id))).toBe(false);
  });

  it('a branch the repository does not have is repo_open_ref_not_found and creates nothing', async () => {
    const id = '5f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    expect(await open({ repositoryId: id, ref: 'refs/heads/nope', branch: 'nope' })).toEqual({ ok: false, error: 'repo_open_ref_not_found' });
    expect(existsSync(join(root, 'projects', id))).toBe(false);
  });

  it('a folder that is not this repository is refused and left exactly as it was', async () => {
    const foreign = '6f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    mkdirSync(join(root, 'projects', foreign));
    writeFileSync(join(root, 'projects', foreign, 'mine.txt'), 'keep\n');
    expect(await open({ repositoryId: foreign })).toEqual({ ok: false, error: 'repo_open_folder_conflict' });
    expect(readdirSync(join(root, 'projects', foreign))).toEqual(['mine.txt']);

    const other = '7f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    sh(['git', 'init', '-q', join(root, 'projects', other)]);
    git(join(root, 'projects', other), 'remote', 'add', 'origin', 'https://github.ezil.work/acme/other.git');
    expect(await open({ repositoryId: other })).toEqual({ ok: false, error: 'repo_open_folder_conflict' });
  });


  it('an empty folder is cloned into', async () => {
    const id = '8f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    mkdirSync(join(root, 'projects', id));
    expect(await open({ repositoryId: id })).toMatchObject({ ok: true, status: 'cloned' });
    expect(existsSync(join(root, 'projects', id, 'CHANGELOG.md'))).toBe(true);
  });

  it('a store-backed root must be hydrated first; a missing root is unavailable', async () => {
    const id = '9f1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    expect(await open({ repositoryId: id }, { requireHydrated: true })).toEqual({ ok: false, error: 'repo_open_workspace_not_ready' });
    expect(existsSync(join(root, 'projects', id))).toBe(false);
    writeFileSync(join(root, '.ezil-hydrated.json'), '{}');
    expect(await open({ repositoryId: id }, { requireHydrated: true })).toMatchObject({ ok: true, status: 'cloned' });
    expect(await open({}, { root: join(dir, 'no-such-root') })).toEqual({ ok: false, error: 'repo_open_workspace_unavailable' });
  });

  it('🔴 Bearer (Cloudflare Artifacts): clones with the token only in an Authorization header, never Basic, argv, file, URL or output', async () => {
    const id = 'af1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    const before = seen.length;
    const mark = ran().length;
    const answer = await open(bearer({ repositoryId: id }));
    const folder = join(root, 'projects', id);
    expect(answer).toEqual({ ok: true, folder, head: git(seed, 'rev-parse', 'HEAD'), status: 'cloned' });
    const mine = seen.slice(before);
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((s) => s.auth === BEARER)).toBe(true);
    expect(mine.filter((s) => s.url.includes(TOKEN) || s.url.includes('art_v1_'))).toEqual([]);
    expect(git(folder, 'config', '--local', '--get', 'remote.origin.url')).toBe(bearerUrl);
    const config = readFileSync(join(folder, '.git', 'config'), 'utf8');
    expect(config).not.toContain(TOKEN);
    expect(config).not.toMatch(/credential|helper|extraheader|authorization/i);
    expect(filesContaining(folder, TOKEN)).toEqual([]);
    expect(readFileSync(trace, 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(trace, 'utf8')).not.toContain('Bearer');
    expect(readFileSync(argvLog, 'utf8')).toContain(`--no-write-fetch-head -- ${bearerUrl} `);
    expect(readFileSync(argvLog, 'utf8')).not.toContain(TOKEN);
    expect(printed.join('\n')).not.toContain(TOKEN);
    expectIsolated(mark, 1, false);
  });

  it('🔴 Bearer: a second open fetches only, and a wrong token is repo_open_auth_failed and creates nothing', async () => {
    const id = 'af1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    const folder = join(root, 'projects', id);
    const before = git(folder, 'rev-parse', 'HEAD');
    writeFileSync(join(folder, 'README.md'), '# bearer edit\n');
    const next = commit('bearer fetch', 'BEARER.md', 'b\n');
    expect(await open(bearer({ repositoryId: id }))).toEqual({ ok: true, folder, head: before, status: 'fetched' });
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# bearer edit\n');
    expect(git(folder, 'rev-parse', 'refs/remotes/origin/main')).toBe(next);
    const other = 'bf1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    expect(await open(bearer({ repositoryId: other, token: WRONG }))).toEqual({ ok: false, error: 'repo_open_auth_failed' });
    expect(existsSync(join(root, 'projects', other))).toBe(false);
    // Basic credentials sent to the Bearer path are refused too: the scheme is the server's, not a guess.
    expect(await open({ repositoryId: other, canonicalURL: bearerUrl, auth: 'basic' })).toEqual({ ok: false, error: 'repo_open_auth_failed' });
    expect(existsSync(join(root, 'projects', other))).toBe(false);
  });

  for (const scheme of ['basic', 'bearer'] as const) {
    it(`🔴 ${scheme}: a credential.helper=store in the clone's own .git/config never runs (review #6)`, async () => {
      const id = scheme === 'basic' ? REPO : 'af1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
      const folder = join(root, 'projects', id);
      const store = join(dir, `local-store-${scheme}`);
      git(folder, 'config', '--local', 'credential.helper', `store --file=${store}`);
      try {
        const answer = await open(scheme === 'basic' ? { repositoryId: id } : bearer({ repositoryId: id }));
        expect(answer).toMatchObject({ ok: true, status: 'fetched' });
        // Without the empty credential.helper reset, Basic would have stored the token here.
        expect(existsSync(store)).toBe(false);
        expect(filesContaining(dir, TOKEN).filter((p) => !p.startsWith(join(dir, 'upstream')))).toEqual([]);
      } finally {
        git(folder, 'config', '--local', '--unset', 'credential.helper');
      }
    });
  }

  let attempts = 0;
  /**
   * 🔴 Review F1. Edits the clone's own `.git/config` (and `.git/evil.cfg`, for
   * an include), pushes a new commit, opens again, and restores both. The open
   * must succeed and fetch the new commit from the real server, while the evil
   * host and the proxy hear nothing, and no git command with the token reads
   * the folder. Against the earlier script, which fetched `origin` inside the
   * folder after checking `config --local --get`, every one of these sent the
   * credential to the evil host or through the proxy.
   */
  const openDespite = async (scheme: 'basic' | 'bearer', edit: (config: string, folder: string) => string, included?: string) => {
    const id = scheme === 'basic' ? REPO : 'af1d2c4b-5a69-4788-9a0b-1c2d3e4f5a6b';
    const folder = join(root, 'projects', id);
    const configPath = join(folder, '.git', 'config');
    const original = readFileSync(configPath, 'utf8');
    if (included !== undefined) writeFileSync(join(folder, '.git', 'evil.cfg'), included);
    const edited = edit(original, folder);
    writeFileSync(configPath, edited);
    attempts += 1;
    const next = commit(`redirect attempt ${attempts}`, 'ATTEMPT.md', `${attempts}\n`);
    const [evilBefore, proxyBefore, seenBefore, mark] = [evilSeen.length, proxied.length, seen.length, ran().length];
    try {
      const answer = await open(scheme === 'basic' ? { repositoryId: id } : bearer({ repositoryId: id }));
      // First what matters: nothing reached the evil host or the proxy (the earlier script fails here).
      expect(evilSeen.slice(evilBefore)).toEqual([]);
      expect(proxied.slice(proxyBefore)).toEqual([]);
      expect(answer).toEqual({ ok: true, folder, head: git(folder, 'rev-parse', 'HEAD'), status: 'fetched' });
      expect(seen.slice(seenBefore).filter((s) => s.leak !== null)).toEqual([]);
      // The real server got the credential in its own scheme (Basic only after git's anonymous first request).
      const auths = new Set(seen.slice(seenBefore).map((s) => s.auth));
      expect([...auths].sort()).toEqual(scheme === 'basic' ? [BASIC, null].sort() : [BEARER]);
      expect(git(folder, 'rev-parse', 'refs/remotes/origin/main')).toBe(next);
      // The folder's config is the person's: read for identity only, never changed.
      expect(readFileSync(configPath, 'utf8')).toBe(edited);
      expectIsolated(mark, 1);
    } finally {
      writeFileSync(configPath, original);
      rmSync(join(folder, '.git', 'evil.cfg'), { force: true });
    }
  };
  const canonical = (scheme: 'basic' | 'bearer') => (scheme === 'basic' ? url : bearerUrl);

  for (const scheme of ['basic', 'bearer'] as const) {
    it(`🔴 ${scheme}: a prepended remote.origin.url (fetch uses the FIRST, config --get answers the LAST) never receives the credential`, async () => {
      const evilUrl = canonical(scheme).replace(base, evilBase);
      await openDespite(scheme, (config, folder) => {
        const edited = config.replace('[remote "origin"]\n', `[remote "origin"]\n\turl = ${evilUrl}\n`);
        expect(edited).not.toBe(config);
        writeFileSync(join(folder, '.git', 'config'), edited);
        // What the earlier identity check read, and what `git fetch origin` would have used.
        expect(git(folder, 'config', '--local', '--get', 'remote.origin.url')).toBe(canonical(scheme));
        expect(git(folder, 'config', '--local', '--get-all', 'remote.origin.url').split('\n')[0]).toBe(evilUrl);
        return edited;
      });
    });

    for (const [form, directive] of [
      ['include.path', () => '[include]\n\tpath = evil.cfg\n'],
      ['includeIf gitdir', (folder: string) => `[includeIf "gitdir:${folder}/.git"]\n\tpath = evil.cfg\n`],
    ] as const) {
      it(`🔴 ${scheme}: an ${form} file with url.<evil>.insteadOf and http.<evil>.sslVerify=false (invisible to config --local) is ignored`, async () => {
        await openDespite(scheme, (config, folder) => {
          const edited = config + directive(folder);
          writeFileSync(join(folder, '.git', 'config'), edited);
          // `--local` does not follow includes: the earlier `--get-regexp '^(url|http)\.'` refusal saw nothing.
          expect(Bun.spawnSync(['git', '-C', folder, 'config', '--local', '--name-only', '--get-regexp', String.raw`^(url|http)\.`],
            { env: { PATH: process.env.PATH!, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } }).exitCode).toBe(1);
          expect(git(folder, 'config', '--get-urlmatch', 'http.sslVerify', `${evilBase}/x`)).toBe('false');
          return edited;
        }, `[url "${evilBase}/"]\n\tinsteadOf = ${base}/\n[http "${evilBase}/"]\n\tsslVerify = false\n`);
      });
    }

    it(`🔴 ${scheme}: an included http.<url>.proxy is ignored (the proxy hears nothing)`, async () => {
      await openDespite(scheme, (config) => `${config}[include]\n\tpath = evil.cfg\n`,
        `[http "${base}/"]\n\tproxy = http://127.0.0.1:${proxy.port}\n`);
    });
  }

  for (const [key, value] of [
    ['url.<evil>.insteadOf', ''], ['http.extraHeader', 'X-Leak: 1'], ['http.proxy', ''], ['http.sslVerify', 'false'],
  ] as const) {
    it(`a repository-local ${key} is ignored, not obeyed (the credential never meets the folder's config)`, async () => {
      const [name, setting] = key === 'url.<evil>.insteadOf' ? [`url.${evilBase}/.insteadOf`, `${base}/`]
        : key === 'http.proxy' ? [key, `http://127.0.0.1:${proxy.port}`] : [key, value];
      await openDespite('bearer', (config, folder) => {
        git(folder, 'config', '--local', name, setting);
        return readFileSync(join(folder, '.git', 'config'), 'utf8');
      });
    });
  }

  it('nothing the whole run left behind holds the token (argv log, trace, workspace, home, /tmp staging)', () => {
    expect(readFileSync(argvLog, 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(trace, 'utf8')).not.toContain(TOKEN);
    expect(filesContaining(root, TOKEN)).toEqual([]);
    expect(filesContaining(home, TOKEN)).toEqual([]);
    expect(existsSync(join(home, '.git-credentials'))).toBe(false);
    expect(printed.join('\n')).not.toContain(TOKEN);
    expect(readdirSync('/tmp').filter((n) => n.startsWith('ezil-repo-open.'))).toEqual([]);
  });
});
