/**
 * `repo-open`'s container script against REAL git and a real smart-HTTP git
 * server: a local HTTPS server (self-signed, trusted through
 * `GIT_SSL_CAINFO`) that demands HTTP Basic `ezil:<token>` and hands every
 * authorized request to `git http-backend`.
 *
 * The script runs through `runRepoOpen` with an exec that does what the
 * Sandbox SDK does with a per-command `env` (the value is in the shell's
 * environment for that one command, never in the command string). What it
 * proves, with the token known to the test:
 *   - it is in no argv: not of any `git` the script runs (a `git` shim first
 *     on PATH logs every invocation's arguments), and not of anything git
 *     itself spawns (`GIT_TRACE` logs every run_command, the credential
 *     helper's shell included). Both logs are asserted non-empty, so the
 *     checks are not vacuous. Nor in anything the script printed, nor in any
 *     URL the server saw;
 *   - `.git/config` and every other file under the clone are free of it, and
 *     `remote.origin.url` is the canonical URL with no userinfo;
 *   - a `credential.helper=store` in the computer's own `~/.gitconfig` never
 *     runs (`~/.git-credentials` is never written);
 *   - a second open fetches only: an uncommitted edit and HEAD survive, while
 *     the remote-tracking ref moves;
 *   - every refusal (bad grant, missing branch, foreign folder, unhydrated
 *     workspace, a repository-local `insteadOf`) leaves the folder untouched.
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

import { runRepoOpen, REPO_OPEN_TOKEN_ENV, type RepoOpenExec, type RepoOpenRequest } from './repo-open';

const which = (bin: string) => Bun.spawnSync(['sh', '-c', `command -v ${bin}`]).exitCode === 0;
/** The real git the shim hands over to: the host's own, or the image's. */
const REAL_GIT = process.env.EZIL_REPO_OPEN_IT_IMAGE?.trim() ? '/usr/bin/git'
  : Bun.spawnSync(['sh', '-c', 'command -v git']).stdout.toString().trim();
const IMAGE = process.env.EZIL_REPO_OPEN_IT_IMAGE?.trim() || '';
const AVAILABLE = which('git') && which('openssl') && (!IMAGE || which('docker'));

const TOKEN = `egg_${'7e57'.repeat(16)}`;
const WRONG = `egg_${'0bad'.repeat(16)}`;
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
  let bin: string;
  let server: ReturnType<typeof Bun.serve>;
  let url: string;
  const seen: Array<{ url: string; auth: string | null }> = [];
  const printed: string[] = [];

  /** The SDK's per-command env, applied the way the session shell applies it. */
  const exec = (token: string): RepoOpenExec => async (command, options) => {
    expect(command).not.toContain(token);
    expect(Object.keys(options.env)).toEqual([REPO_OPEN_TOKEN_ENV]);
    const shimmed = `${bin}:${IMAGE ? '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' : process.env.PATH!}`;
    const envFor = { PATH: shimmed, HOME: home, GIT_SSL_CAINFO: cert, GIT_TRACE: trace, EZIL_IT_ARGV_LOG: argvLog, ...options.env };
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
    expiresAt: new Date(Date.now() + 240_000).toISOString(), ...patch,
  });
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
    // Records the arguments of every `git` the script runs, then runs the real one.
    writeFileSync(join(bin, 'git'), `#!/bin/sh\nprintf '%s\\n' "git $*" >> "$EZIL_IT_ARGV_LOG"\nexec ${REAL_GIT} "$@"\n`, { mode: 0o755 });
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
    const expected = `Basic ${btoa(`ezil:${TOKEN}`)}`;
    server = Bun.serve({
      hostname: '127.0.0.1', port: 0, tls: { cert: readFileSync(cert, 'utf8'), key: readFileSync(key, 'utf8') },
      async fetch(req) {
        const u = new URL(req.url);
        seen.push({ url: req.url, auth: req.headers.get('authorization') });
        if (req.headers.get('authorization') !== expected) {
          return new Response('authentication required', { status: 401, headers: { 'www-authenticate': 'Basic realm="ezil-it"' } });
        }
        const proc = Bun.spawn(['git', 'http-backend'], {
          env: {
            PATH: process.env.PATH!, GIT_PROJECT_ROOT: upstream, GIT_HTTP_EXPORT_ALL: '1',
            REQUEST_METHOD: req.method, PATH_INFO: u.pathname, QUERY_STRING: u.search.slice(1),
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
    url = `https://127.0.0.1:${server.port}/acme/site.git`;
  });

  afterAll(() => {
    server?.stop(true);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('🔴 clones into <root>/projects/<id> with the token in no argv, file, URL or output', async () => {
    const upstreamHead = git(seed, 'rev-parse', 'HEAD');
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
    const ran = readFileSync(argvLog, 'utf8');
    expect(ran).toContain(`git clone --quiet --branch main --origin origin -- ${url}`);
    expect(ran).not.toContain(TOKEN);
    // The server saw the credential only as Basic auth, never in a URL.
    expect(seen.some((s) => s.auth === `Basic ${btoa(`ezil:${TOKEN}`)}`)).toBe(true);
    expect(seen.filter((s) => s.url.includes(TOKEN) || s.url.includes('egg_'))).toEqual([]);
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
    const answer = await open();
    expect(answer).toEqual({ ok: true, folder, head: before, status: 'fetched' });
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('# site\nwork in progress\n');
    expect(readFileSync(join(folder, 'notes.txt'), 'utf8')).toBe('untracked\n');
    expect(git(folder, 'rev-parse', 'refs/remotes/origin/main')).toBe(next);
    expect(git(folder, 'rev-parse', 'HEAD')).toBe(before);
    expect(filesContaining(folder, TOKEN)).toEqual([]);
    expect(readFileSync(trace, 'utf8')).not.toContain(TOKEN);
    expect(readFileSync(argvLog, 'utf8')).toContain('fetch --quiet --no-recurse-submodules origin');
    expect(readFileSync(argvLog, 'utf8')).not.toContain(TOKEN);
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

  it('a repository-local url.insteadOf (which could redirect the credential) is refused', async () => {
    const folder = join(root, 'projects', REPO);
    git(folder, 'config', '--local', 'url.https://evil.invalid/.insteadOf', url);
    const before = seen.length;
    expect(await open()).toEqual({ ok: false, error: 'repo_open_folder_conflict' });
    expect(seen.length).toBe(before);
    git(folder, 'config', '--local', '--unset', 'url.https://evil.invalid/.insteadOf');
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
