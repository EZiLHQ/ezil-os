/**
 * The pure half of `POST /sandbox/:name/repo-open`: what the route accepts,
 * the command it hands the container, and what it makes of the answer. The
 * route table is `repo-open-route.test.ts`; real git is `repo-open.git.test.ts`.
 */
import { describe, expect, it } from 'bun:test';

import {
  branchOf,
  parseRepoOpenOutput,
  parseRepoOpenRequest,
  repoOpenAuthFor,
  repoOpenBounds,
  repoOpenCommand,
  repoOpenStatus,
  repoOpenWhenRunning,
  runRepoOpen,
  ownSessionExec,
  REPO_OPEN_ERRORS,
  REPO_OPEN_SCRIPT,
  REPO_OPEN_EXEC_TIMEOUT_MS,
  REPO_OPEN_MIN_TIMEOUT_MS,
  REPO_OPEN_TOKEN_ENV,
  type RepoOpenExec,
  type RepoOpenRequest,
} from './repo-open';

const REPO = '0b6c3c1e-8f0a-4c5e-9a43-2a1f6d0e7b11';
/** An opaque Cloudflare Artifacts repo token: no `egg_` prefix, any visible ASCII. */
const TOKEN = `art_v1_${'ab12'.repeat(16)}.Zz-9~/+=`;
const GRANT = `egg_${'ab12'.repeat(16)}`;
const ACCOUNT = '0123456789abcdef'.repeat(2);
/** Universe's remote: `https://<32 hex account>.artifacts.cloudflare.net/git/<namespace>/<name>.git`. */
const ARTIFACTS = `https://${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/p-${REPO}.git`;
const HEAD = 'c'.repeat(40);
const NOW = Date.parse('2026-10-31T12:00:00Z');
const body = (patch: Record<string, unknown> = {}, git: Record<string, unknown> = {}) => ({
  repositoryId: REPO,
  canonicalURL: ARTIFACTS,
  ref: 'refs/heads/main',
  git: { token: TOKEN, expiresAt: '2026-10-31T12:04:00.000Z', ...git },
  ...patch,
});
const parsed = (b: unknown = body()): RepoOpenRequest => {
  const r = parseRepoOpenRequest(b, NOW);
  if (!r.ok) throw new Error(r.error);
  return r.request;
};

describe('parseRepoOpenRequest', () => {
  it('accepts the contract body, derives the branch, and sends an Artifacts remote Bearer auth', () => {
    expect(parsed()).toEqual({
      repositoryId: REPO, canonicalURL: ARTIFACTS, ref: 'refs/heads/main',
      branch: 'main', token: TOKEN, expiresAt: '2026-10-31T12:04:00.000Z', auth: 'bearer', timeoutMs: REPO_OPEN_EXEC_TIMEOUT_MS,
    });
  });

  it('still accepts an EZiL Git (github.ezil.work) remote, as Basic auth', () => {
    expect(parsed(body({ canonicalURL: 'https://github.ezil.work/acme/site.git' }, { token: GRANT }))).toMatchObject({
      canonicalURL: 'https://github.ezil.work/acme/site.git', token: GRANT, auth: 'basic',
    });
  });

  it("accepts Universe's git object passed through unchanged (username 'ezil', scope 'read' or 'write')", () => {
    expect(parseRepoOpenRequest(body({}, { username: 'ezil', scope: 'read' }), NOW).ok).toBe(true);
    expect(parseRepoOpenRequest(body({}, { username: 'ezil', scope: 'write' }), NOW).ok).toBe(true);
  });

  it("takes the caller's remaining deadline as timeoutMs, within the Worker's own bounds", () => {
    expect(parsed(body({ timeoutMs: 45_000 })).timeoutMs).toBe(45_000);
    expect(parsed(body({ timeoutMs: REPO_OPEN_MIN_TIMEOUT_MS })).timeoutMs).toBe(REPO_OPEN_MIN_TIMEOUT_MS);
    expect(parsed(body({ timeoutMs: REPO_OPEN_EXEC_TIMEOUT_MS })).timeoutMs).toBe(REPO_OPEN_EXEC_TIMEOUT_MS);
    for (const timeoutMs of [REPO_OPEN_MIN_TIMEOUT_MS - 1, REPO_OPEN_EXEC_TIMEOUT_MS + 1, 30_000.5, '60000', null, -1]) {
      expect(parseRepoOpenRequest(body({ timeoutMs }), NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    }
  });

  const invalid: Array<[string, unknown]> = [
    ['a non-object', 'x'],
    ['an array', [body()]],
    ['an unknown top-level key', body({ folder: '/etc' })],
    ['a missing key', (({ ref: _r, ...rest }) => rest)(body())],
    ['an uppercase UUID', body({ repositoryId: REPO.toUpperCase() })],
    ['a non-UUID id', body({ repositoryId: '../../etc' })],
    ['another host', body({ canonicalURL: 'https://github.com/acme/site.git' })],
    ['a lookalike host', body({ canonicalURL: 'https://github.ezil.work.evil.test/acme/site.git' })],
    ['userinfo in the URL', body({ canonicalURL: `https://ezil:${TOKEN}@github.ezil.work/acme/site.git` })],
    ['plain http', body({ canonicalURL: 'http://github.ezil.work/acme/site.git' })],
    ['a query', body({ canonicalURL: 'https://github.ezil.work/acme/site.git?x=1' })],
    ['a dot-dot name', body({ canonicalURL: 'https://github.ezil.work/acme/a..git' })],
    ['no .git suffix', body({ canonicalURL: 'https://github.ezil.work/acme/site' })],
    ...([
      ['a 31-hex account', `https://${ACCOUNT.slice(1)}.artifacts.cloudflare.net/git/universe-staging/site.git`],
      ['a 33-hex account', `https://${ACCOUNT}0.artifacts.cloudflare.net/git/universe-staging/site.git`],
      ['an uppercase-hex account', `https://${ACCOUNT.toUpperCase()}.artifacts.cloudflare.net/git/universe-staging/site.git`],
      ['a lookalike Artifacts host', `https://${ACCOUNT}.artifacts.cloudflare.net.evil.test/git/universe-staging/site.git`],
      ['userinfo naming the Artifacts host', `https://${ACCOUNT}.artifacts.cloudflare.net@evil.test/git/universe-staging/site.git`],
      ['userinfo before the Artifacts host', `https://ezil:${GRANT}@${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/site.git`],
      ['a port', `https://${ACCOUNT}.artifacts.cloudflare.net:8443/git/universe-staging/site.git`],
      ['an Artifacts query', `${ARTIFACTS}?x=1`],
      ['an Artifacts fragment', `${ARTIFACTS}#x`],
      ['plain http to Artifacts', ARTIFACTS.replace('https:', 'http:')],
      ['no /git/ prefix', `https://${ACCOUNT}.artifacts.cloudflare.net/universe-staging/site.git`],
      ['a dot-dot Artifacts name', `https://${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/a..b.git`],
      ['a dot-dot namespace', `https://${ACCOUNT}.artifacts.cloudflare.net/git/../site.git`],
      ['an extra path segment', `https://${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/x/site.git`],
      ['an uppercase namespace', `https://${ACCOUNT}.artifacts.cloudflare.net/git/Universe/site.git`],
    ] as const).map(([name, canonicalURL]): [string, unknown] => [name, body({ canonicalURL })]),
    ['a tag ref', body({ ref: 'refs/tags/v1' })],
    ['a bare branch', body({ ref: 'main' })],
    ['a dot-dot ref', body({ ref: 'refs/heads/a..b' })],
    ['an option-looking branch', body({ ref: 'refs/heads/-x' })],
    ['a .lock ref', body({ ref: 'refs/heads/main.lock' })],
    ['an unknown git key', body({}, { password: 'x' })],
    ['another username', body({}, { username: 'root' })],
    ['an admin scope', body({}, { scope: 'admin' })],
    ['an empty token', body({}, { token: '' })],
    ['a token with a newline (credential-line or header injection)', body({}, { token: `${TOKEN}\nhost=evil.test` })],
    ['a token with a carriage return', body({}, { token: `${TOKEN}\rX-Evil: 1` })],
    ['a token with a space', body({}, { token: 'Bearer x' })],
    ['a token with a tab', body({}, { token: `${TOKEN}\t` })],
    ['a non-ASCII token', body({}, { token: `${TOKEN}é` })],
    ['a 4097-character token', body({}, { token: 'a'.repeat(4097) })],
    ['a numeric token', body({}, { token: 1234 })],
    ['a non-ISO expiry', body({}, { expiresAt: 'tomorrow' })],
    ['an unparseable expiry', body({}, { expiresAt: '2026-13-45T99:99:99Z' })],
  ];
  for (const [name, b] of invalid) {
    it(`refuses ${name} as repo_open_invalid_request`, () => {
      expect(parseRepoOpenRequest(b, NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    });
  }

  it('refuses an expired or nearly expired grant with its own code', () => {
    for (const expiresAt of ['2026-10-31T11:59:00Z', '2026-10-31T12:00:02Z']) {
      expect(parseRepoOpenRequest(body({}, { expiresAt }), NOW)).toEqual({ ok: false, error: 'repo_open_token_expired' });
    }
    expect(parseRepoOpenRequest(body({}, { expiresAt: '2026-10-31T12:00:10Z' }), NOW).ok).toBe(true);
  });

  it('accepts a 4096-character token (the cap) and a plain egg_ grant', () => {
    expect(parseRepoOpenRequest(body({}, { token: 'a'.repeat(4096) }), NOW).ok).toBe(true);
    expect(parseRepoOpenRequest(body({}, { token: GRANT }), NOW).ok).toBe(true);
  });

  it('repoOpenAuthFor picks the scheme from the host, and nothing for anything else', () => {
    expect(repoOpenAuthFor(ARTIFACTS)).toBe('bearer');
    expect(repoOpenAuthFor('https://github.ezil.work/acme/site.git')).toBe('basic');
    for (const url of ['https://127.0.0.1/acme/site.git', `${ARTIFACTS}/`, 7, null]) expect(repoOpenAuthFor(url)).toBeNull();
  });

  it('branchOf keeps nested branch names and refuses what Universe refuses', () => {
    expect(branchOf('refs/heads/feature/x-1')).toBe('feature/x-1');
    for (const ref of ['refs/heads/', 'refs/heads/a//b', 'refs/heads/a/', 'refs/heads/.hidden', 'refs/heads/a.', `refs/heads/${'a'.repeat(250)}`]) {
      expect(branchOf(ref)).toBeNull();
    }
  });
});

describe('repoOpenCommand', () => {
  const cmd = repoOpenCommand({ root: '/workspace', repositoryId: REPO, url: ARTIFACTS, branch: 'main', requireHydrated: true,
    auth: 'bearer', timeoutMs: REPO_OPEN_EXEC_TIMEOUT_MS });

  it('is one bash invocation whose arguments are single-quoted, and never takes the token', () => {
    expect(cmd.startsWith("bash -c '")).toBe(true);
    expect(cmd.endsWith(` ezil-repo-open '/workspace' '${REPO}' '${ARTIFACTS}' 'main' 1 bearer 30 90`)).toBe(true);
    expect(cmd).not.toContain('egg_');
    expect(cmd).not.toContain('art_v1_');
    // `repoOpenCommand` has no token parameter at all: the only route in is the env.
    expect(cmd).toContain(`$${REPO_OPEN_TOKEN_ENV}`);
  });

  it('quotes a single quote in an argument so it cannot end the word', () => {
    const odd = repoOpenCommand({ root: "/w'; rm -rf /; '", repositoryId: REPO, url: 'u', branch: 'b', requireHydrated: false,
      auth: 'basic', timeoutMs: REPO_OPEN_MIN_TIMEOUT_MS });
    expect(odd).toContain(`'/w'\\''; rm -rf /; '\\'''`);
    expect(odd.endsWith(' 0 basic 2 8')).toBe(true);
  });

  it('configures git only through the environment, resetting inherited helpers and headers first, never following redirects', () => {
    expect(cmd).toContain('GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=');
    expect(cmd).toContain('GIT_CONFIG_KEY_1=http.extraHeader GIT_CONFIG_VALUE_1=');
    expect(cmd).toContain('GIT_CONFIG_KEY_4=core.askPass GIT_CONFIG_VALUE_4=');
    expect(cmd).toContain('GIT_CONFIG_KEY_5=protocol.allow GIT_CONFIG_VALUE_5=never');
    expect(cmd).toContain('GIT_CONFIG_KEY_7=http.followRedirects GIT_CONFIG_VALUE_7=false');
    expect(cmd).toContain('GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null');
    expect(cmd).toContain('core.hooksPath');
    // Local commands speak only "file" (the private repository, by path); the network fetch only https.
    expect(cmd).toContain('GIT_ALLOW_PROTOCOL=file');
    expect(cmd).toContain('GIT_ALLOW_PROTOCOL=https GIT_CONFIG_COUNT=10');
    expect(cmd).toContain('GIT_CONFIG_KEY_6=protocol.https.allow GIT_CONFIG_VALUE_6=always');
    // Bearer is a command-scope header on the network git only, never exported, scoped to the remote's URL.
    expect(cmd).toContain('export GIT_CONFIG_KEY_9="http.$url.extraHeader"');
    expect(cmd).toContain('GIT_CONFIG_VALUE_9="Authorization: Bearer $tok" timeout');
    expect(cmd).not.toMatch(/export[^\n]*Bearer/);
    expect(cmd).toContain('export GIT_CONFIG_KEY_9="credential.https://$host.helper"');
    // `git clone -c` would write the value into the new repository's .git/config.
    expect(cmd).not.toMatch(/git clone[^\n]* -c /);
    expect(cmd).not.toMatch(/git -c /);
  });

  it('🔴 the credential goes only to a fetch of the canonical URL into the private repository; the folder is fetched from that, by path', () => {
    // A fresh bare repository with no template (so no hooks), in the private directory, HOME an empty private directory.
    expect(cmd).toContain('git init --quiet --bare --template= "$mirror"');
    expect(cmd).toContain('export HOME="$work/home"');
    expect(cmd).toContain('set -- git --git-dir="$mirror" fetch --quiet --no-tags --no-recurse-submodules --no-write-fetch-head -- \\\n      "$url" ');
    // Besides the presence check, the only lines that use the token are the network fetch's, inside net().
    const tokenLines = REPO_OPEN_SCRIPT.split('\n').filter((l) => l.includes('$tok'));
    expect(tokenLines).toEqual([
      '[ -n "$tok" ] || fail repo_open_invalid_request',
      '      GIT_CONFIG_VALUE_9="Authorization: Bearer $tok" timeout -k 5 "$s" "$@"',
      '      EZIL_REPO_OPEN_TOKEN=$tok timeout -k 5 "$s" "$@"',
    ]);
    // Nothing fetches `origin` (whatever the folder's config says it is), and nothing with the credential runs in the folder.
    expect(REPO_OPEN_SCRIPT).not.toMatch(/fetch[^\n]* origin/);
    expect(REPO_OPEN_SCRIPT).toContain(`bounded git -C "$folder" fetch --quiet --no-recurse-submodules "$mirror" '+refs/heads/*:refs/remotes/origin/*'`);
    expect(REPO_OPEN_SCRIPT).toContain('bounded git clone --quiet --branch "$branch" --origin origin -- "$mirror" "$work/clone"');
    expect(REPO_OPEN_SCRIPT).toContain('git -C "$work/clone" remote set-url origin "$url"');
  });
});

describe('repoOpenBounds', () => {
  it('derives the lock wait and the git limit from one deadline, leaving 10 s for the kill grace and the rest', () => {
    expect(repoOpenBounds(REPO_OPEN_EXEC_TIMEOUT_MS)).toEqual({ lockWaitS: 30, gitTimeoutS: 90 });
    expect(repoOpenBounds(REPO_OPEN_MIN_TIMEOUT_MS)).toEqual({ lockWaitS: 2, gitTimeoutS: 8 });
    for (let t = REPO_OPEN_MIN_TIMEOUT_MS; t <= REPO_OPEN_EXEC_TIMEOUT_MS; t += 777) {
      const { lockWaitS, gitTimeoutS } = repoOpenBounds(t);
      expect(lockWaitS).toBeGreaterThanOrEqual(1);
      expect(gitTimeoutS).toBeGreaterThanOrEqual(1);
      expect((lockWaitS + gitTimeoutS + 10) * 1000).toBeLessThanOrEqual(t);
    }
  });
});

describe('parseRepoOpenOutput', () => {
  it('reads the last result line and nothing else', () => {
    expect(parseRepoOpenOutput(`noise\nezil-repo-open:ok:cloned:${HEAD}\n`)).toEqual({ ok: true, status: 'cloned', head: HEAD });
    expect(parseRepoOpenOutput(`ezil-repo-open:ok:fetched:${'d'.repeat(64)}`)).toEqual({ ok: true, status: 'fetched', head: 'd'.repeat(64) });
    expect(parseRepoOpenOutput('ezil-repo-open:error:repo_open_auth_failed')).toEqual({ ok: false, error: 'repo_open_auth_failed' });
  });
  it('an empty repository: created, or fetched while still empty, with no head', () => {
    expect(parseRepoOpenOutput('ezil-repo-open:ok:created\n')).toEqual({ ok: true, status: 'created' });
    expect(parseRepoOpenOutput('ezil-repo-open:ok:fetched')).toEqual({ ok: true, status: 'fetched' });
  });
  it('refuses a malformed head, an unknown code or no result line', () => {
    expect(parseRepoOpenOutput('ezil-repo-open:ok:cloned:abc')).toBeNull();
    expect(parseRepoOpenOutput('ezil-repo-open:ok:cloned')).toBeNull();
    expect(parseRepoOpenOutput(`ezil-repo-open:ok:created:${HEAD}`)).toBeNull();
    expect(parseRepoOpenOutput('ezil-repo-open:error:rm_rf')).toBeNull();
    expect(parseRepoOpenOutput('')).toBeNull();
  });
});

describe('runRepoOpen', () => {
  const root = { path: '/workspace', requireHydrated: true };
  const fakeExec = (stdout: string, exitCode = 0) => {
    const calls: Array<Parameters<RepoOpenExec>> = [];
    const exec: RepoOpenExec = async (...args) => { calls.push(args); return { exitCode, stdout, stderr: `fatal: ${TOKEN}` }; };
    return { exec, calls };
  };

  it('🔴 the token travels only in the per-command env, never in the command', async () => {
    const { exec, calls } = fakeExec(`ezil-repo-open:ok:cloned:${HEAD}\n`);
    const answer = await runRepoOpen(exec, parsed(), root);
    expect(answer).toEqual({ ok: true, folder: `/workspace/projects/${REPO}`, head: HEAD, status: 'cloned' });
    expect(calls).toHaveLength(1);
    const [command, options] = calls[0]!;
    expect(command).not.toContain(TOKEN);
    expect(options.env).toEqual({ [REPO_OPEN_TOKEN_ENV]: TOKEN });
    expect(options.origin).toBe('internal');
    // The caller's deadline (the default here), above the script's worst case: 30 s lock wait + 90 s git + 5 s kill grace.
    expect(options.timeout).toBe(REPO_OPEN_EXEC_TIMEOUT_MS);
    expect(options.timeout).toBeGreaterThan((30 + 90 + 5) * 1000);
    expect(command.endsWith(' bearer 30 90')).toBe(true);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it('a shorter deadline shrinks the exec bound and the script bounds with it', async () => {
    const { exec, calls } = fakeExec(`ezil-repo-open:ok:cloned:${HEAD}\n`);
    await runRepoOpen(exec, parsed(body({ timeoutMs: 40_000 })), root);
    const [command, options] = calls[0]!;
    expect(options.timeout).toBe(40_000);
    const { lockWaitS, gitTimeoutS } = repoOpenBounds(40_000);
    expect(command.endsWith(` bearer ${lockWaitS} ${gitTimeoutS}`)).toBe(true);
    expect((lockWaitS + gitTimeoutS + 5) * 1000).toBeLessThan(40_000);
  });

  it('an empty repository is ok with no head (the folder still opens)', async () => {
    expect(await runRepoOpen(fakeExec('ezil-repo-open:ok:created\n').exec, parsed(), root))
      .toEqual({ ok: true, folder: `/workspace/projects/${REPO}`, status: 'created' });
  });

  it('passes the script\'s error code through; stderr (even one holding the token) is never read', async () => {
    const answer = await runRepoOpen(fakeExec('ezil-repo-open:error:repo_open_folder_conflict').exec, parsed(), root);
    expect(answer).toEqual({ ok: false, error: 'repo_open_folder_conflict' });
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
  });

  it('fails closed: a non-zero exit, a throw, no result line, or output carrying the token', async () => {
    expect(await runRepoOpen(fakeExec(`ezil-repo-open:ok:cloned:${HEAD}`, 1).exec, parsed(), root)).toEqual({ ok: false, error: 'repo_open_failed' });
    expect(await runRepoOpen(async () => { throw new Error(`boom ${TOKEN}`); }, parsed(), root)).toEqual({ ok: false, error: 'repo_open_failed' });
    expect(await runRepoOpen(fakeExec('bash: syntax error').exec, parsed(), root)).toEqual({ ok: false, error: 'repo_open_failed' });
    expect(await runRepoOpen(fakeExec(`${TOKEN}\nezil-repo-open:ok:cloned:${HEAD}`).exec, parsed(), root)).toEqual({ ok: false, error: 'repo_open_failed' });
  });

  it('a stopped computer is refused before any exec (an exec would cold-start it)', async () => {
    const { exec, calls } = fakeExec(`ezil-repo-open:ok:cloned:${HEAD}`);
    let touched = 0;
    expect(await repoOpenWhenRunning({ running: async () => false, touch: () => { touched++; }, exec }, parsed(), root))
      .toEqual({ ok: false, error: 'runtime_not_running' });
    expect(calls).toHaveLength(0);
    expect(touched).toBe(0);
    expect((await repoOpenWhenRunning({ running: async () => true, touch: () => { touched++; }, exec }, parsed(), root)).ok).toBe(true);
    expect(touched).toBe(1);
  });
});

describe('ownSessionExec', () => {
  const recorder = (execImpl: () => Promise<{ exitCode: number; stdout: string }>) => {
    const log: string[] = [];
    const sandbox = {
      createSession: async ({ id }: { id: string }) => {
        log.push(`create ${id}`);
        return { id, exec: async (command: string) => { log.push(`exec ${id} ${command}`); return execImpl(); } };
      },
      deleteSession: async (id: string) => { log.push(`delete ${id}`); },
    };
    return { sandbox, log };
  };

  it('🔴 runs the open in a session of its own, never the default one the probes use, and deletes it', async () => {
    const { sandbox, log } = recorder(async () => ({ exitCode: 0, stdout: `ezil-repo-open:ok:cloned:${HEAD}` }));
    const answer = await runRepoOpen(ownSessionExec(sandbox, () => 'ezil-repo-open-1'), parsed(), { path: '/workspace', requireHydrated: true });
    expect(answer.ok).toBe(true);
    expect(log.map((l) => l.split(' ').slice(0, 2).join(' '))).toEqual(['create ezil-repo-open-1', 'exec ezil-repo-open-1', 'delete ezil-repo-open-1']);
  });

  it('deletes the session even when the exec throws (an exec timeout), and the open fails closed', async () => {
    const { sandbox, log } = recorder(async () => { throw new Error('Command timeout after 130000ms'); });
    const answer = await runRepoOpen(ownSessionExec(sandbox, () => 'ezil-repo-open-2'), parsed(), { path: '/workspace', requireHydrated: true });
    expect(answer).toEqual({ ok: false, error: 'repo_open_failed' });
    expect(log.at(-1)).toBe('delete ezil-repo-open-2');
  });

  it('gives each open a fresh session id by default', async () => {
    const ids: string[] = [];
    const sandbox = {
      createSession: async ({ id }: { id: string }) => { ids.push(id); return { id, exec: async () => ({ exitCode: 0, stdout: '' }) }; },
      deleteSession: async () => undefined,
    };
    await ownSessionExec(sandbox)('true', { env: {}, timeout: 1, origin: 'internal' });
    await ownSessionExec(sandbox)('true', { env: {}, timeout: 1, origin: 'internal' });
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
    for (const id of ids) expect(id).toMatch(/^ezil-repo-open-[0-9a-f-]{36}$/);
  });
});

describe('repoOpenStatus', () => {
  it('maps every code to a status: caller errors 4xx, state 409, upstream 5xx', () => {
    expect(repoOpenStatus('repo_open_invalid_request')).toBe(400);
    expect(repoOpenStatus('repo_open_token_expired')).toBe(400);
    expect(repoOpenStatus('repo_open_unsupported_provider')).toBe(409);
    expect(repoOpenStatus('runtime_not_running')).toBe(409);
    expect(repoOpenStatus('repo_open_folder_conflict')).toBe(409);
    expect(repoOpenStatus('repo_open_auth_failed')).toBe(502);
    expect(repoOpenStatus('repo_open_timeout')).toBe(504);
    for (const code of REPO_OPEN_ERRORS) expect(repoOpenStatus(code)).toBeGreaterThanOrEqual(400);
  });
});
