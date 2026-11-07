/**
 * code-folder-resolve.test.ts — the Cloudflare walk (`./code-folder-resolve.ts`): the result parser,
 * the exec it makes, and the constant script run by real shells against real temp trees (symlinks
 * first, middle and last, dangling; files; missing; spaces, Unicode, glob characters and a leading
 * `-` in names; the root itself), then end to end through `settleCodeFolder`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import gw from './aws-gateway.vectors.json';
import {
  AWS_GATEWAY_HEADER,
  awsOriginHostname,
  decodeControlKey,
  handleAwsPreview,
  verifyGatewayHeader,
  type AwsTunnelRecord,
  type FetchLike,
} from './aws-origin';
import { settleCodeFolder } from './code-folder';
import {
  AWS_CODE_FOLDER_CONTROL_PATH,
  CODE_FOLDER_REL_ENV,
  CODE_FOLDER_RESOLVE_BOUND_MS,
  CODE_FOLDER_RESOLVE_COMMAND,
  CODE_FOLDER_RESOLVE_SCRIPT,
  CODE_FOLDER_RESOLVE_TIMEOUT_MS,
  CODE_FOLDER_ROOT_ENV,
  CODE_FOLDER_WALK_OUTCOMES,
  awsCodeFolderBody,
  awsCodeFolderOutcome,
  awsCodeFolderResolver,
  cloudflareCodeFolderResolver,
  codeFolderWalkOutcome,
} from './code-folder-resolve';
import type { CodeFolderExec as RepoOpenExec } from './code-folder-resolve';

/** The shared v1 table (shell, app, Worker, host agent): its `walk` rows are every resolver's cases. */
const V = JSON.parse(readFileSync(new URL('../../docs/contracts/code-folder-v1.vectors.json', import.meta.url), 'utf8')) as {
  walk: Array<{ tree: string; rel: string; expect: string }>;
};

describe('codeFolderWalkOutcome: exit 0 and exactly one known result line, else error', () => {
  it('reads each walk outcome, with or without the trailing newline', () => {
    for (const code of CODE_FOLDER_WALK_OUTCOMES) {
      expect(codeFolderWalkOutcome(0, `ezil-code-folder:${code}\n`)).toBe(code);
      expect(codeFolderWalkOutcome(0, `ezil-code-folder:${code}`)).toBe(code);
    }
  });
  it('refuses everything else', () => {
    for (const [exit, out] of [
      [1, 'ezil-code-folder:restored\n'], // a non-zero exit
      [124, 'ezil-code-folder:restored\n'], // the SDK's timeout exit
      [0, undefined],
      [0, ''],
      [0, 'ezil-code-folder:restored\nezil-code-folder:restored\n'], // two lines
      [0, 'noise\nezil-code-folder:restored\n'],
      [0, 'ezil-code-folder:restored\r\n'],
      [0, ' ezil-code-folder:restored\n'],
      [0, 'ezil-code-folder:outside\n'], // the planner's codes are not the walk's
      [0, 'ezil-code-folder:not_allowed\n'],
      [0, 'ezil-code-folder:unverified\n'],
      [0, 'ezil-code-folder:too_long\n'],
      [0, 'ezil-code-folder:invalid\n'],
      [0, 'ezil-code-folder:/workspace/a\n'], // never a path
    ] as const) {
      expect([exit, out, codeFolderWalkOutcome(exit, out)]).toEqual([exit, out, 'error']);
    }
  });
});

describe('cloudflareCodeFolderResolver: one bounded exec of the constant script', () => {
  it('passes the root and rel in env only, with the timeout and internal origin', async () => {
    const calls: Array<{ command: string; options: Parameters<RepoOpenExec>[1] }> = [];
    const exec: RepoOpenExec = async (command, options) => {
      calls.push({ command, options });
      return { exitCode: 0, stdout: 'ezil-code-folder:restored\n' };
    };
    const rel = "my folder/$(touch pwned)/`id`/a'b\"c";
    expect(await cloudflareCodeFolderResolver(exec, '/workspace')(rel)).toBe('restored');
    expect(calls).toHaveLength(1);
    // The constant script, inside a subshell: never run in the SDK's shared session shell itself.
    expect(calls[0]!.command).toBe(CODE_FOLDER_RESOLVE_COMMAND);
    expect(CODE_FOLDER_RESOLVE_COMMAND).toBe(`(\n${CODE_FOLDER_RESOLVE_SCRIPT}\n)`);
    expect(calls[0]!.command.includes('pwned')).toBe(false);
    expect(calls[0]!.options).toEqual({
      env: { [CODE_FOLDER_ROOT_ENV]: '/workspace', [CODE_FOLDER_REL_ENV]: rel },
      timeout: CODE_FOLDER_RESOLVE_TIMEOUT_MS,
      origin: 'internal',
    });
  });
  it('answers error for a refused exec, a timeout or stray output, and never throws', async () => {
    const throwing: RepoOpenExec = async () => { throw new Error('container gone'); };
    expect(await cloudflareCodeFolderResolver(throwing, '/workspace')('a')).toBe('error');
    const timedOut: RepoOpenExec = async () => ({ exitCode: 124, stdout: '' });
    expect(await cloudflareCodeFolderResolver(timedOut, '/workspace')('a')).toBe('error');
    const stray: RepoOpenExec = async () => ({ exitCode: 0, stdout: 'hello\n' });
    expect(await cloudflareCodeFolderResolver(stray, '/workspace')('a')).toBe('error');
  });
  it('settles as error by its bound when the exec never answers (the Code mint is never held longer)', async () => {
    const hung: RepoOpenExec = () => new Promise(() => undefined);
    const started = Date.now();
    expect(await cloudflareCodeFolderResolver(hung, '/workspace', 50)('a')).toBe('error');
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(CODE_FOLDER_RESOLVE_BOUND_MS).toBeGreaterThan(CODE_FOLDER_RESOLVE_TIMEOUT_MS);
    expect(CODE_FOLDER_RESOLVE_BOUND_MS).toBeLessThanOrEqual(CODE_FOLDER_RESOLVE_TIMEOUT_MS + 1_000);
  });
  it('a walk that answers in time is not cut by the bound', async () => {
    const slowish: RepoOpenExec = () => new Promise((r) => setTimeout(() => r({ exitCode: 0, stdout: 'ezil-code-folder:missing\n' }), 20));
    expect(await cloudflareCodeFolderResolver(slowish, '/workspace', 500)('a')).toBe('missing');
  });
});

const which = (bin: string) => Bun.spawnSync(['sh', '-c', `command -v ${bin}`]).exitCode === 0;
const SHELLS = ['bash', 'sh', 'dash'].filter(which);

describe('the walk script in real shells', () => {
  let dir = '';
  let root = '';
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ezil-code-folder-'));
    root = join(dir, 'workspace');
    mkdirSync(join(root, 'a', 'b', 'c'), { recursive: true });
    mkdirSync(join(root, 'my folder', 'ünï cødé'), { recursive: true });
    mkdirSync(join(root, 'g*'));
    mkdirSync(join(root, 'xa'));
    mkdirSync(join(root, '-n'));
    mkdirSync(join(root, '-e', 'x'), { recursive: true });
    mkdirSync(join(dir, 'outside', 'deep'), { recursive: true });
    writeFileSync(join(root, 'a', 'file.txt'), 'x');
    symlinkSync(join(root, 'a'), join(root, 'link')); // first component
    symlinkSync('..', join(root, 'a', 'mid')); // middle component, back into a
    symlinkSync(join(dir, 'outside'), join(root, 'a', 'b', 'last')); // last component, outside the root
    symlinkSync(join(root, 'nope'), join(root, 'a', 'dang')); // dangling
    symlinkSync(join(root, 'a', 'file.txt'), join(root, 'a', 'flink')); // to a file
    symlinkSync(root, join(dir, 'rootlink')); // the root itself through a symlink
    writeFileSync(join(dir, 'rootfile'), 'x');
  });
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  // The shell runs IN the walk root (as a session whose cwd is the workspace would), so an unguarded glob
  // in `set -- $rel` really meets the root's names (`x*` -> `xa`).
  const walk = (shell: string, r: string, rel: string) => {
    const p = Bun.spawnSync([shell, '-c', CODE_FOLDER_RESOLVE_SCRIPT], {
      cwd: root,
      env: { PATH: process.env.PATH!, [CODE_FOLDER_ROOT_ENV]: r, [CODE_FOLDER_REL_ENV]: rel },
    });
    return codeFolderWalkOutcome(p.exitCode, p.stdout.toString());
  };

  it('has at least bash and sh to run', () => {
    expect(SHELLS).toContain('bash');
    expect(SHELLS).toContain('sh');
  });

  for (const shell of SHELLS) {
    describe(shell, () => {
      it('restores the root itself and real directories at any depth', () => {
        expect(walk(shell, root, '')).toBe('restored');
        expect(walk(shell, `${root}/`, '')).toBe('restored');
        expect(walk(shell, root, 'a')).toBe('restored');
        expect(walk(shell, root, 'a/b/c')).toBe('restored');
      });
      it('answers symlink for a symlink at the first, middle or last component, and a dangling one', () => {
        expect(walk(shell, root, 'link')).toBe('symlink');
        expect(walk(shell, root, 'link/b')).toBe('symlink');
        expect(walk(shell, root, 'a/mid/b')).toBe('symlink');
        expect(walk(shell, root, 'a/b/last')).toBe('symlink');
        expect(walk(shell, root, 'a/b/last/deep')).toBe('symlink');
        expect(walk(shell, root, 'a/dang')).toBe('symlink');
        expect(walk(shell, root, 'a/flink')).toBe('symlink');
      });
      it('answers file for a regular file as the last component, not_directory for one in the middle, and missing for what is not there', () => {
        expect(walk(shell, root, 'a/file.txt')).toBe('file');
        expect(walk(shell, root, 'a/file.txt/x')).toBe('not_directory');
        expect(walk(shell, root, 'a/nope')).toBe('missing');
        expect(walk(shell, root, 'a/nope/x')).toBe('missing');
        // a symlink TO a file is a symlink, never a file (checked before -f, which follows links)
        expect(walk(shell, root, 'a/flink')).toBe('symlink');
      });
      it('keeps spaces, Unicode, glob characters and a leading - literal', () => {
        expect(walk(shell, root, 'my folder/ünï cødé')).toBe('restored');
        expect(walk(shell, root, 'g*')).toBe('restored');
        expect(walk(shell, root, 'x*')).toBe('missing'); // a glob would have matched xa
        expect(walk(shell, root, 'x?')).toBe('missing');
        expect(walk(shell, root, '-n')).toBe('restored');
        expect(walk(shell, root, '-e/x')).toBe('restored');
      });
      it('checks the root: missing, a file, relative; a root reached through a symlink is the server\'s choice', () => {
        expect(walk(shell, join(dir, 'gone'), '')).toBe('missing');
        expect(walk(shell, join(dir, 'rootfile'), 'a')).toBe('not_directory');
        expect(walk(shell, 'workspace', 'a')).toBe('error');
        expect(walk(shell, '', 'a')).toBe('error');
        expect(walk(shell, join(dir, 'rootlink'), 'a/b')).toBe('restored');
        expect(walk(shell, join(dir, 'rootlink'), 'link')).toBe('symlink');
      });
    });
  }

  it('every shared `walk` vector (docs/contracts/code-folder-v1.vectors.json) in every shell', () => {
    const shared = join(dir, 'shared');
    mkdirSync(join(shared, 'sports', 'sports-web'), { recursive: true });
    mkdirSync(join(shared, 'My Project', '日本'), { recursive: true });
    mkdirSync(join(shared, 'via-target', 'child'), { recursive: true });
    writeFileSync(join(shared, 'sports', 'next.config.ts'), 'x');
    symlinkSync('/etc', join(shared, 'link-out'));
    symlinkSync('sports', join(shared, 'link-in'));
    symlinkSync('via-target', join(shared, 'via-link'));
    expect(V.walk.length).toBeGreaterThanOrEqual(8);
    for (const shell of SHELLS) {
      for (const v of V.walk) {
        const p = Bun.spawnSync([shell, '-c', CODE_FOLDER_RESOLVE_SCRIPT], {
          cwd: shared, env: { PATH: process.env.PATH!, [CODE_FOLDER_ROOT_ENV]: shared, [CODE_FOLDER_REL_ENV]: v.rel },
        });
        expect({ shell, tree: v.tree, got: codeFolderWalkOutcome(p.exitCode, p.stdout.toString()) }).toEqual({ shell, tree: v.tree, got: v.expect });
      }
    }
  });

  it('settles end to end: only a walked real directory becomes the folder', async () => {
    const exec: RepoOpenExec = async (command, options) => {
      const p = Bun.spawnSync(['bash', '-c', command], { cwd: root, env: { PATH: process.env.PATH!, ...options.env } });
      return { exitCode: p.exitCode, stdout: p.stdout.toString() };
    };
    const resolve = cloudflareCodeFolderResolver(exec, root);
    expect(await settleCodeFolder({ v: 1, path: `${root}/a/b` }, root, resolve)).toEqual({ outcome: 'restored', folder: `${root}/a/b` });
    expect(await settleCodeFolder({ v: 1, path: root }, root, resolve)).toEqual({ outcome: 'restored', folder: root });
    expect(await settleCodeFolder({ v: 1, path: `${root}/link/b` }, root, resolve)).toEqual({ outcome: 'symlink' });
    expect(await settleCodeFolder({ v: 1, path: `${root}/a/b/last` }, root, resolve)).toEqual({ outcome: 'symlink' });
    // a regular file: its parent is the folder, the file rides beside it (the bootstrap's `file=`)
    expect(await settleCodeFolder({ v: 1, path: `${root}/a/file.txt` }, root, resolve)).toEqual({ outcome: 'file', folder: `${root}/a`, file: `${root}/a/file.txt` });
    expect(await settleCodeFolder({ v: 1, path: `${root}/a/file.txt/x` }, root, resolve)).toEqual({ outcome: 'not_directory' });
    expect(await settleCodeFolder({ v: 1, path: `${root}/my folder/ünï cødé` }, root, resolve)).toEqual({ outcome: 'restored', folder: `${root}/my folder/ünï cødé` });
    // the planner's refusals never reach the walk
    expect(await settleCodeFolder({ v: 1, path: `${dir}/outside` }, root, resolve)).toEqual({ outcome: 'outside' });
    expect(await settleCodeFolder({ v: 1, path: `${root}/projects/00000000-0000-4000-8000-000000000000/repository` }, root, resolve)).toEqual({ outcome: 'not_allowed' });
  });

  /**
   * The Sandbox SDK's session, as its container server (0.12.1, `/container-server` in the desktop image) runs
   * it: ONE persistent `bash --norc` reading commands on stdin. A foreground exec exports its env for that
   * command only and runs the command inside `{ …; EXIT_CODE=$? }` IN THAT SHELL, then writes the exit code to a
   * file. The desktop stack runs in the same session as a background job whose output a labeler reads through a
   * FIFO (`startProcess`). Every exec of a walk here goes through the real `cloudflareCodeFolderResolver` call.
   */
  const sdkSession = () => {
    const sdir = mkdtempSync(join(tmpdir(), 'ezil-sdk-session-'));
    const shell = Bun.spawn(['bash', '--norc'], { cwd: root, stdin: 'pipe', stdout: 'ignore', stderr: 'ignore', env: { PATH: process.env.PATH! } });
    const send = (text: string) => { shell.stdin.write(`${text}\n`); shell.stdin.flush(); };
    const alive = () => shell.exitCode === null && !shell.killed;
    const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
    let n = 0;
    const exec: RepoOpenExec = async (command, options) => {
      const id = ++n;
      const out = join(sdir, `${id}.out`);
      const code = join(sdir, `${id}.exit`);
      const env = Object.entries(options.env ?? {});
      send(['{', ...env.map(([k, v]) => `  export ${k}=${q(String(v))}`), '  {', command, '  EXIT_CODE=$?', `  } < /dev/null > ${q(out)} 2> /dev/null`,
        ...env.map(([k]) => `  unset ${k}`), `  echo "$EXIT_CODE" > ${q(`${code}.tmp`)}; mv ${q(`${code}.tmp`)} ${q(code)}`, '}'].join('\n'));
      for (const deadline = Date.now() + 5_000; Date.now() < deadline; await Bun.sleep(10)) {
        if (existsSync(code)) return { exitCode: Number(readFileSync(code, 'utf8').trim()), stdout: readFileSync(out, 'utf8') };
        if (!alive()) throw new Error('SESSION_TERMINATED: the session shell exited');
      }
      throw new Error('exec timed out');
    };
    // The desktop stack's stand-in: a background job in the session that logs constantly, read by a labeler.
    const pipe = join(sdir, 'desktop.pipe');
    send(`mkfifo ${q(pipe)}; (while IFS= read -r l; do :; done < ${q(pipe)}) & { while :; do echo desk; sleep 0.05; done; } > ${q(pipe)} & echo $! > ${q(join(sdir, 'desktop.pid'))}`);
    const desktop = async () => {
      for (let i = 0; i < 200 && !existsSync(join(sdir, 'desktop.pid')); i++) await Bun.sleep(10);
      const pid = Number(readFileSync(join(sdir, 'desktop.pid'), 'utf8').trim());
      try { process.kill(pid, 0); return pid; } catch { return 0; }
    };
    const close = async () => {
      const pid = await desktop().catch(() => 0);
      if (pid) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
      shell.kill('SIGKILL');
      rmSync(sdir, { recursive: true, force: true });
    };
    return { exec, alive, desktop, close, pid: shell.pid };
  };

  it('in a real persistent SDK-style session, every outcome leaves the session shell, its state and the desktop running', async () => {
    const s = sdkSession();
    try {
      const desktopPid = await s.desktop();
      expect(desktopPid).toBeGreaterThan(0);
      const resolve = cloudflareCodeFolderResolver(s.exec, root);
      expect(await resolve('a/b')).toBe('restored');
      expect(await resolve('nope')).toBe('missing');
      expect(await resolve('link/b')).toBe('symlink');
      expect(await resolve('a/file.txt')).toBe('file');
      expect(await resolve('a/file.txt/x')).toBe('not_directory');
      expect(await cloudflareCodeFolderResolver(s.exec, 'relative/root')('a')).toBe('error');
      expect(await resolve('x*')).toBe('missing'); // a glob is still literal (set -f, inside the subshell)
      // The same shell, unchanged: no `set -f`, default IFS, no positional parameters, and it still runs commands.
      expect(s.alive()).toBe(true);
      const state = await s.exec('printf "%s|%s|%s" "$-" "$#" "$IFS" | od -An -c | tr -s " "', { env: {} });
      expect(state.exitCode).toBe(0);
      expect(state.stdout).not.toMatch(/f/);
      expect(state.stdout).toContain('| 0 |');
      expect(state.stdout).toContain('\\t \\n');
      expect(await s.desktop()).toBe(desktopPid);
    } finally {
      await s.close();
    }
  });

  it('control: the bare script in that session ends the session shell (what the subshell prevents)', async () => {
    const s = sdkSession();
    try {
      await expect(s.exec(CODE_FOLDER_RESOLVE_SCRIPT, { env: { [CODE_FOLDER_ROOT_ENV]: root, [CODE_FOLDER_REL_ENV]: 'nope' } }))
        .rejects.toThrow('SESSION_TERMINATED');
      expect(s.alive()).toBe(false);
    } finally {
      await s.close();
    }
  });
});

describe('awsCodeFolderResolver: the host edge folder op (host-agent edge.py `_folder`)', () => {
  const KEY = decodeControlKey(gw.controlKeyBase64)!;
  const ZONE = 'origin.example.net';
  const CID = '0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b';
  const SID = 'guac-0a0a0a0a0a0a0a0a-0b0b0b0b0b0b4b0b';
  const record = (over: Partial<AwsTunnelRecord> = {}): AwsTunnelRecord => ({
    computerId: CID, sandboxId: SID, generation: 1, leaseEpoch: 2, instanceId: 'i-0123456789abcdef0', region: 'ap-south-1',
    publicIp: '13.200.1.2', tunnelId: 't-1', dnsRecordId: 'd-1', hostname: `c-${SID}-g1-e2.${ZONE}`, controlKey: gw.controlKeyBase64,
    createdAt: 1, originVerified: true, originVerifiedAt: Date.now(), ...over,
  });
  const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
  /** The walk's code → the host's `result` (the inverse of the resolver's table). */
  const HOST_RESULT: Record<string, string> = { restored: 'ok', file: 'file', missing: 'missing', not_directory: 'not_directory', symlink: 'symlink' };

  /**
   * A host edge stand-in that holds the Worker to the op's contract before answering: POST, the record's own origin,
   * no query, a gw1 header that verifies for exactly this path and binding, the path digest equal to sha256 of the
   * bytes sent, and a body of exactly {"v":1,"rel":…}. Then it answers from the shared `walk` vectors.
   */
  const strictHost = (answerFor: (rel: string) => Response | Promise<Response>, rec = record()) => {
    const seen: string[] = [];
    const fetch: FetchLike = async (url, init) => {
      const u = new URL(url);
      expect(u.protocol).toBe('https:');
      expect(u.hostname).toBe(awsOriginHostname(rec.sandboxId, rec.generation, rec.leaseEpoch, ZONE));
      expect(u.search).toBe('');
      expect(init.method).toBe('POST');
      expect(init.redirect).toBe('manual');
      const body = init.body as string;
      expect(u.pathname).toBe(`${AWS_CODE_FOLDER_CONTROL_PATH}/${sha(body)}`);
      const header = new Headers(init.headers).get(AWS_GATEWAY_HEADER);
      expect(await verifyGatewayHeader(header, KEY, rec, 'POST', u.pathname, Math.floor(Date.now() / 1000))).toEqual({ ok: true });
      const parsed = JSON.parse(body) as { v: number; rel: string };
      expect(Object.keys(parsed)).toEqual(['v', 'rel']);
      expect(parsed.v).toBe(1);
      seen.push(parsed.rel);
      return answerFor(parsed.rel);
    };
    return { fetch, seen };
  };
  const fromVectors = (rel: string) => {
    const v = V.walk.find((w) => w.rel === rel);
    return v ? Response.json({ ok: true, result: HOST_RESULT[v.expect] }) : new Response('{}', { status: 500 });
  };

  it('sends exactly the signed, digested op and maps every shared `walk` vector', async () => {
    const host = strictHost(fromVectors);
    const resolve = awsCodeFolderResolver(ZONE, host.fetch, Date.now);
    for (const v of V.walk) expect({ tree: v.tree, got: await resolve(record(), v.rel) }).toEqual({ tree: v.tree, got: v.expect });
    expect(host.seen).toEqual(V.walk.map((w) => w.rel));
    expect(awsCodeFolderBody('My Project/日本')).toBe('{"v":1,"rel":"My Project/日本"}');
  });

  it('the host answer: exact {ok:true,result} only; 404 (an agent without the op) is unverified; anything else is error', async () => {
    const res = (body: string, status = 200) => new Response(body, { status });
    for (const [r, want] of [
      [res('{"ok":true,"result":"ok"}'), 'restored'],
      [res('{"result":"symlink","ok":true}'), 'symlink'],
      [res('{"ok":false,"error":"not_found"}', 404), 'unverified'],
      [res('{"ok":true,"result":"bad_path"}'), 'error'],
      [res('{"ok":true,"result":"restored"}'), 'error'],
      [res('{"ok":true,"result":"ok","path":"/workspace"}'), 'error'],
      [res('{"ok":"true","result":"ok"}'), 'error'],
      [res('{"ok":true,"result":"toString"}'), 'error'],
      [res('{"ok":true,"result":"__proto__"}'), 'error'],
      [res('[true,"ok"]'), 'error'],
      [res('not json'), 'error'],
      [res(`{"ok":true,"result":"ok","pad":"${'x'.repeat(300)}"}`), 'error'],
      [res('{"ok":false,"error":"folder_body_invalid"}', 400), 'error'],
      [res('{"ok":false,"error":"gw_stale"}', 401), 'error'],
      [res('', 302), 'error'],
      [res('', 502), 'error'],
      [res('', 503), 'error'],
    ] as const) {
      expect(await awsCodeFolderOutcome(r)).toBe(want);
    }
  });

  it('never throws and never fetches without a usable control key; a refused fetch is error', async () => {
    let calls = 0;
    const counting: FetchLike = async () => { calls += 1; return Response.json({ ok: true, result: 'ok' }); };
    expect(await awsCodeFolderResolver(ZONE, counting, Date.now)(record({ controlKey: 'bad' }), 'a')).toBe('error');
    expect(await awsCodeFolderResolver('not a zone', counting, Date.now)(record(), 'a')).toBe('error');
    expect(calls).toBe(0);
    const throwing: FetchLike = async () => { throw new TypeError('network'); };
    expect(await awsCodeFolderResolver(ZONE, throwing, Date.now)(record(), 'a')).toBe('error');
  });

  it('settles as error by its bound when the host never answers, and is not cut when it answers in time', async () => {
    const hung: FetchLike = () => new Promise(() => undefined);
    const started = Date.now();
    expect(await awsCodeFolderResolver(ZONE, hung, Date.now, 50)(record(), 'a')).toBe('error');
    expect(Date.now() - started).toBeLessThan(2_000);
    const slowish: FetchLike = () => new Promise((r) => setTimeout(() => r(Response.json({ ok: true, result: 'missing' })), 20));
    expect(await awsCodeFolderResolver(ZONE, slowish, Date.now, 500)(record(), 'a')).toBe('missing');
  });

  it('a stale record (another generation or lease epoch) addresses its own host, never the current one', async () => {
    const current = record();
    const stale = record({ generation: 1, leaseEpoch: 1 });
    const hosts: string[] = [];
    const f: FetchLike = async (url) => { hosts.push(new URL(url).hostname); return new Response('', { status: 404 }); };
    await awsCodeFolderResolver(ZONE, f, Date.now)(stale, 'a');
    expect(hosts).toEqual([awsOriginHostname(SID, 1, 1, ZONE)]);
    expect(hosts[0]).not.toBe(awsOriginHostname(current.sandboxId, current.generation, current.leaseEpoch, ZONE));
  });

  it('end to end through handleAwsPreview: the folder opens only on `ok`; the answer is a code; the ask never reaches the host unplanned', async () => {
    const SECRET = 'aws-folder-test-secret';
    const claims = { ts: Date.now(), sandboxId: SID, computerId: CID, userId: 'u1', provider: 'aws-ec2', store: '', generation: 1, leaseEpoch: 2 } as const;
    const host = strictHost(fromVectors);
    const preview = (path: string) => handleAwsPreview(claims, {
      zone: ZONE, secrets: [SECRET], zoneRoot: 'preview.example.org', lookup: async () => record(), verifyOrigin: async () => 'verified',
      surface: 'code', ensureConfig: async () => ({ state: 'applied' }) as never, codeAnswers: async () => true, nowMs: Date.now,
      codeFolder: { v: 1, path }, resolveFolder: awsCodeFolderResolver(ZONE, host.fetch, Date.now),
    });
    const read = async (path: string) => (await (await preview(path)).json()) as { codePreviewUrl: string; codeFolder?: unknown };
    const ok = await read('/workspace/sports/sports-web');
    expect(ok.codeFolder).toEqual({ v: 1, outcome: 'restored' });
    expect(new URL(ok.codePreviewUrl).searchParams.get('folder')).toBe('/workspace/sports/sports-web');
    const unicode = await read('/workspace/My Project/日本');
    expect(unicode.codeFolder).toEqual({ v: 1, outcome: 'restored' });
    for (const [path, outcome] of [['/workspace/sports/gone', 'missing'], ['/workspace/link-out', 'symlink'], ['/workspace/via-link/child', 'symlink']] as const) {
      const body = await read(path);
      expect(body.codeFolder).toEqual({ v: 1, outcome });
      // The workspace root, named explicitly: never code-server's own last-visited folder.
      expect(new URL(body.codePreviewUrl).searchParams.get('folder')).toBe('/workspace');
    }
    // Refused by the planner before any host call: another root, a project's repository, the shell's own files.
    host.seen.length = 0;
    for (const [path, outcome] of [
      ['/etc', 'outside'],
      ['/workspace/projects/0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b/repository', 'not_allowed'],
      ['/workspace/.ezil/x', 'not_allowed'],
    ] as const) {
      const body = await read(path);
      expect(body.codeFolder).toEqual({ v: 1, outcome });
      expect(new URL(body.codePreviewUrl).searchParams.get('folder')).toBe('/workspace');
    }
    expect(host.seen).toEqual([]);
  });
});
