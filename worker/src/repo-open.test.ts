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
  repoOpenCommand,
  repoOpenStatus,
  repoOpenWhenRunning,
  runRepoOpen,
  ownSessionExec,
  REPO_OPEN_ERRORS,
  REPO_OPEN_TOKEN_ENV,
  type RepoOpenExec,
  type RepoOpenRequest,
} from './repo-open';

const REPO = '0b6c3c1e-8f0a-4c5e-9a43-2a1f6d0e7b11';
const TOKEN = `egg_${'ab12'.repeat(16)}`;
const HEAD = 'c'.repeat(40);
const NOW = Date.parse('2026-10-31T12:00:00Z');
const body = (patch: Record<string, unknown> = {}, git: Record<string, unknown> = {}) => ({
  repositoryId: REPO,
  canonicalURL: 'https://github.ezil.work/acme/site.git',
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
  it('accepts the contract body and derives the branch', () => {
    expect(parsed()).toEqual({
      repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main',
      branch: 'main', token: TOKEN, expiresAt: '2026-10-31T12:04:00.000Z',
    });
  });

  it("accepts Works' git object passed through unchanged (username 'ezil', scope 'read')", () => {
    expect(parseRepoOpenRequest(body({}, { username: 'ezil', scope: 'read' }), NOW).ok).toBe(true);
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
    ['a tag ref', body({ ref: 'refs/tags/v1' })],
    ['a bare branch', body({ ref: 'main' })],
    ['a dot-dot ref', body({ ref: 'refs/heads/a..b' })],
    ['an option-looking branch', body({ ref: 'refs/heads/-x' })],
    ['a .lock ref', body({ ref: 'refs/heads/main.lock' })],
    ['an unknown git key', body({}, { password: 'x' })],
    ['another username', body({}, { username: 'root' })],
    ['a write scope', body({}, { scope: 'write' })],
    ['a token without the egg_ prefix', body({}, { token: 'ab12'.repeat(16) })],
    ['a token with a newline (credential-line injection)', body({}, { token: `${TOKEN}\nhost=evil.test` })],
    ['an uppercase-hex token', body({}, { token: TOKEN.toUpperCase().replace('EGG_', 'egg_') })],
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

  it('branchOf keeps nested branch names and refuses what Works refuses', () => {
    expect(branchOf('refs/heads/feature/x-1')).toBe('feature/x-1');
    for (const ref of ['refs/heads/', 'refs/heads/a//b', 'refs/heads/a/', 'refs/heads/.hidden', 'refs/heads/a.', `refs/heads/${'a'.repeat(250)}`]) {
      expect(branchOf(ref)).toBeNull();
    }
  });
});

describe('repoOpenCommand', () => {
  const cmd = repoOpenCommand({ root: '/workspace', repositoryId: REPO, url: 'https://github.ezil.work/acme/site.git', branch: 'main', requireHydrated: true });

  it('is one bash invocation whose arguments are single-quoted, and never takes the token', () => {
    expect(cmd.startsWith("bash -c '")).toBe(true);
    expect(cmd.endsWith(` ezil-repo-open '/workspace' '${REPO}' 'https://github.ezil.work/acme/site.git' 'main' 1`)).toBe(true);
    expect(cmd).not.toContain('egg_');
    // `repoOpenCommand` has no token parameter at all: the only route in is the env.
    expect(cmd).toContain(`$${REPO_OPEN_TOKEN_ENV}`);
  });

  it('quotes a single quote in an argument so it cannot end the word', () => {
    const odd = repoOpenCommand({ root: "/w'; rm -rf /; '", repositoryId: REPO, url: 'u', branch: 'b', requireHydrated: false });
    expect(odd).toContain(`'/w'\\''; rm -rf /; '\\'''`);
    expect(odd.endsWith(' 0')).toBe(true);
  });

  it('configures git only through the environment, resetting every inherited credential helper first', () => {
    expect(cmd).toContain('GIT_CONFIG_KEY_0=credential.helper GIT_CONFIG_VALUE_0=');
    expect(cmd).toContain('GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL=/dev/null');
    expect(cmd).toContain('GIT_ALLOW_PROTOCOL=https');
    expect(cmd).toContain('core.hooksPath');
    // `git clone -c` would write the value into the new repository's .git/config.
    expect(cmd).not.toMatch(/git clone[^\n]* -c /);
    expect(cmd).not.toMatch(/git -c /);
  });
});

describe('parseRepoOpenOutput', () => {
  it('reads the last result line and nothing else', () => {
    expect(parseRepoOpenOutput(`noise\nezil-repo-open:ok:cloned:${HEAD}\n`)).toEqual({ ok: true, status: 'cloned', head: HEAD });
    expect(parseRepoOpenOutput(`ezil-repo-open:ok:fetched:${'d'.repeat(64)}`)).toEqual({ ok: true, status: 'fetched', head: 'd'.repeat(64) });
    expect(parseRepoOpenOutput('ezil-repo-open:error:repo_open_auth_failed')).toEqual({ ok: false, error: 'repo_open_auth_failed' });
  });
  it('refuses a malformed head, an unknown code or no result line', () => {
    expect(parseRepoOpenOutput('ezil-repo-open:ok:cloned:abc')).toBeNull();
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
    // Above the script's worst case: 60 s lock wait + 120 s git + 5 s kill grace.
    expect(options.timeout).toBeGreaterThan((60 + 120 + 5) * 1000);
    expect(JSON.stringify(answer)).not.toContain(TOKEN);
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
    const { sandbox, log } = recorder(async () => { throw new Error('Command timeout after 200000ms'); });
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
