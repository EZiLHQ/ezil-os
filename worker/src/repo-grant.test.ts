/**
 * `./repo-grant.ts` without a computer: the refresh body, the grant an open may install, the command (the token
 * never in it), the result line, the runner's refusals, the open-then-grant order and the pinned helper.
 * Real git, the real helper and the two pushes are `repo-grant.git.test.ts`'s.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'bun:test';

import { REPO_OPEN_CLI_PACKET_ENV, REPO_OPEN_TOKEN_ENV, type RepoOpenExec, type RepoOpenRequest } from './repo-open';
import {
  grantRequestFromOpen, parseRepoGrantOutput, parseRepoGrantRequest, repoGrantCommand, repoGrantStatus, repoGrantSubject,
  repoGrantWhenRunning, repoOpenThenGrant, runRepoGrant, REPO_GRANT_ERRORS, REPO_GRANT_HELPER_CONFIG_VALUE,
  REPO_GRANT_MAX_LIFETIME_MS, REPO_GRANT_SCRIPT, type RepoGrantRequest,
} from './repo-grant';
import { EZIL_GIT_GRANT_HELPER_SHA256, EZIL_GIT_GRANT_HELPER_SOURCE } from './repo-grant-helper.generated';

const NOW = Date.parse('2026-11-03T14:00:00Z');
const REPO = '0b6c3c1e-8f0a-4c5e-9a43-2a1f6d0e7b11';
const EGG = `egg_${'ab12'.repeat(16)}`;
const GITHUB = 'https://github.ezil.work/acme/site.git';
const GIT_QA = 'https://git-qa.ezil.work/acme-qa/site.git';
const ARTIFACTS = `https://${'0123456789abcdef'.repeat(2)}.artifacts.cloudflare.net/git/universe-staging/p-${REPO}.git`;
const STAGING = { stagingGitQa: true } as const;
const body = (over: Record<string, unknown> = {}, git: Record<string, unknown> = {}) => ({
  repositoryId: REPO, canonicalURL: GITHUB, git: { token: EGG, expiresAt: new Date(NOW + 240_000).toISOString(), scope: 'write', ...git }, ...over,
});
const SUBJECT = 'c'.repeat(64);

describe('parseRepoGrantRequest: the refresh body', () => {
  it('accepts exactly {repositoryId, canonicalURL, git: {token, expiresAt, scope[, username]}} and normalises the expiry', () => {
    const ok = parseRepoGrantRequest(body({}, { expiresAt: '2026-11-03T14:04:00Z', username: 'ezil' }), NOW);
    expect(ok).toEqual({ ok: true, request: { repositoryId: REPO, canonicalURL: GITHUB, token: EGG, expiresAt: '2026-11-03T14:04:00.000Z', scope: 'write' } });
    expect(parseRepoGrantRequest(body({ canonicalURL: GIT_QA }, { scope: 'read' }), NOW, STAGING)).toMatchObject({ ok: true, request: { scope: 'read' } });
  });
  it('never a branch: a ref, a branch or any extra key is refused', () => {
    for (const extra of [{ ref: 'refs/heads/main' }, { branch: 'main' }, { path: 'src' }, { timeoutMs: 20_000 }]) {
      expect(parseRepoGrantRequest({ ...body(), ...extra }, NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    }
    expect(parseRepoGrantRequest(body({}, { ref: 'refs/heads/main' }), NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
  });
  it('Cloudflare Artifacts is unsupported (Bearer); git-qa only on os-staging; any other host invalid', () => {
    expect(parseRepoGrantRequest(body({ canonicalURL: ARTIFACTS }), NOW)).toEqual({ ok: false, error: 'repo_grant_unsupported_remote' });
    expect(parseRepoGrantRequest(body({ canonicalURL: GIT_QA }), NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    for (const url of ['https://git-staging.ezil.work/acme/site.git', 'https://github.ezil.work.evil.com/acme/site.git', 'http://github.ezil.work/acme/site.git',
      'https://ezil:x@github.ezil.work/acme/site.git', 'https://github.ezil.work/acme/site', 'https://github.ezil.work/acme/si..te.git']) {
      expect({ url, got: parseRepoGrantRequest(body({ canonicalURL: url }), NOW, STAGING) }).toEqual({ url, got: { ok: false, error: 'repo_open_invalid_request' } });
    }
  });
  it('the token is an EZiL Git grant; the scope read or write; the id a lowercase UUID', () => {
    for (const git of [{ token: `art_v1_${'a'.repeat(40)}` }, { token: `egg_${'A'.repeat(64)}` }, { token: `${EGG}x` }, { token: undefined },
      { scope: 'admin' }, { scope: undefined }, { username: 'root' }, { extra: 1 }]) {
      expect(parseRepoGrantRequest(body({}, git), NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    }
    expect(parseRepoGrantRequest(body({ repositoryId: REPO.toUpperCase() }), NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    expect(parseRepoGrantRequest(null, NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
  });
  it('lifetime: under a minute is expired; more than five minutes plus skew is refused; garbage is invalid', () => {
    expect(parseRepoGrantRequest(body({}, { expiresAt: new Date(NOW + 59_000).toISOString() }), NOW)).toEqual({ ok: false, error: 'repo_open_token_expired' });
    expect(parseRepoGrantRequest(body({}, { expiresAt: new Date(NOW + REPO_GRANT_MAX_LIFETIME_MS).toISOString() }), NOW)).toMatchObject({ ok: true });
    expect(parseRepoGrantRequest(body({}, { expiresAt: new Date(NOW + REPO_GRANT_MAX_LIFETIME_MS + 1).toISOString() }), NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    for (const expiresAt of ['soon', '2026-11-03 14:04:00Z', 1762178640000]) {
      expect(parseRepoGrantRequest(body({}, { expiresAt }), NOW)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    }
  });
});

describe('grantRequestFromOpen: what an open may install with its own token', () => {
  const open = (over: Partial<RepoOpenRequest> = {}): RepoOpenRequest => ({
    repositoryId: REPO, canonicalURL: GITHUB, ref: 'refs/heads/main', branch: 'main', token: EGG,
    expiresAt: new Date(NOW + 240_000).toISOString(), scope: 'write', auth: 'basic', timeoutMs: 90_000, ...over,
  });
  it('an EZiL Git open with a scope and a usable lifetime', () => {
    expect(grantRequestFromOpen(open(), NOW)).toEqual({ repositoryId: REPO, canonicalURL: GITHUB, token: EGG, expiresAt: new Date(NOW + 240_000).toISOString(), scope: 'write' });
  });
  it('nothing for Bearer (Artifacts), no scope, a non-egg token, or a lifetime the refresh would refuse', () => {
    for (const over of [{ auth: 'bearer' as const, canonicalURL: ARTIFACTS }, { scope: undefined }, { token: `art_v1_${'a'.repeat(40)}` },
      { expiresAt: new Date(NOW + 30_000).toISOString() }, { expiresAt: new Date(NOW + 3_600_000).toISOString() }]) {
      expect(grantRequestFromOpen(open(over), NOW)).toBeNull();
    }
  });
});

describe('repoGrantCommand / parseRepoGrantOutput', () => {
  const request: RepoGrantRequest = { repositoryId: REPO, canonicalURL: GITHUB, token: EGG, expiresAt: '2026-11-03T14:04:00.000Z', scope: 'write' };
  it('the token is never in the command: it arrives on fd 3 from the per-command env, exactly as an open\'s', () => {
    const command = repoGrantCommand({ root: '/workspace', request, subject: SUBJECT });
    expect(command).not.toContain(EGG);
    expect(command).not.toContain(EGG.slice(4));
    expect(command.startsWith(`(t=$${REPO_OPEN_TOKEN_ENV}; unset ${REPO_OPEN_TOKEN_ENV}; exec bash -c `)).toBe(true);
    expect(command.endsWith(` 3<<<"$t")`)).toBe(true);
    expect(Bun.spawnSync(['bash', '-n', '-c', REPO_GRANT_SCRIPT]).exitCode).toBe(0);
  });
  it('the script never runs git after it has read the token, and never without closing fd 3 before', () => {
    const [beforeRead, afterRead] = REPO_GRANT_SCRIPT.split('IFS= read -r tok <&3');
    expect(afterRead).toBeDefined();
    // no git command at all (`ezil-git-grant` in a path is not one)
    expect(afterRead!).not.toMatch(/(^|[\s;&|({])git\s/m);
    // (a `\`-continued group carries its redirections on its last line: join first)
    const lines = beforeRead!.replace(/\\\n/g, ' ').split('\n').filter((l) => /\bgit -C\b/.test(l));
    expect(lines.length).toBeGreaterThan(4);
    for (const line of lines) expect(line).toContain('3<&-');
  });
  it('reads exactly one known result line', () => {
    expect(parseRepoGrantOutput('noise\nezil-repo-grant:ok\n')).toEqual({ ok: true });
    for (const code of REPO_GRANT_ERRORS) expect(parseRepoGrantOutput(`ezil-repo-grant:error:${code}\n`)).toEqual({ ok: false, error: code });
    for (const out of ['', 'ezil-repo-grant:error:something_else', 'ezil-repo-grant:okay', 'ezil-repo-open:ok']) expect(parseRepoGrantOutput(out)).toBeNull();
  });
});

describe('runRepoGrant, repoGrantWhenRunning and repoOpenThenGrant (fake exec)', () => {
  const root = { path: '/workspace', requireHydrated: true };
  const request: RepoGrantRequest = { repositoryId: REPO, canonicalURL: GITHUB, token: EGG, expiresAt: '2026-11-03T14:04:00.000Z', scope: 'write' };
  const answering = (stdout: string, exitCode = 0) => {
    const calls: Array<{ command: string; env: Record<string, string> }> = [];
    const exec: RepoOpenExec = async (command, options) => { calls.push({ command, env: options.env }); return { exitCode, stdout }; };
    return { exec, calls };
  };
  it('passes the token in the per-command env only and answers the normalised expiry', async () => {
    const { exec, calls } = answering('ezil-repo-grant:ok\n');
    expect(await runRepoGrant(exec, request, root, SUBJECT)).toEqual({ ok: true, expiresAt: request.expiresAt });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.env).toEqual({ [REPO_OPEN_TOKEN_ENV]: EGG });
  });
  it('fails closed: a bad subject (no exec), a thrown exec, a non-zero exit, stray output, an echoed token', async () => {
    const { exec, calls } = answering('ezil-repo-grant:ok\n');
    expect(await runRepoGrant(exec, request, root, 'not-hex')).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    expect(calls).toHaveLength(0);
    expect(await runRepoGrant(async () => { throw new Error('gone'); }, request, root, SUBJECT)).toEqual({ ok: false, error: 'repo_grant_failed' });
    expect(await runRepoGrant(answering('ezil-repo-grant:ok\n', 1).exec, request, root, SUBJECT)).toEqual({ ok: false, error: 'repo_grant_failed' });
    expect(await runRepoGrant(answering('hello\n').exec, request, root, SUBJECT)).toEqual({ ok: false, error: 'repo_grant_failed' });
    expect(await runRepoGrant(answering(`ezil-repo-grant:ok ${EGG}\n`).exec, request, root, SUBJECT)).toEqual({ ok: false, error: 'repo_grant_failed' });
    expect(await runRepoGrant(answering('ezil-repo-grant:error:repo_grant_conflict\n').exec, request, root, SUBJECT)).toEqual({ ok: false, error: 'repo_grant_conflict' });
  });
  it('a stopped computer is refused and never started (no exec)', async () => {
    const { exec, calls } = answering('ezil-repo-grant:ok\n');
    let touched = 0;
    expect(await repoGrantWhenRunning({ running: async () => false, touch: () => { touched += 1; }, exec }, request, root, SUBJECT)).toEqual({ ok: false, error: 'runtime_not_running' });
    expect(calls).toHaveLength(0);
    expect(touched).toBe(0);
  });
  it('an open installs the grant after a successful open only, with its own token, and its answer never changes', async () => {
    const commands: string[] = [];
    const exec = (grantOut: string): RepoOpenExec => async (command) => {
      commands.push(command);
      return { exitCode: 0, stdout: command.includes('ezil-repo-grant') ? grantOut : `ezil-repo-open:ok:cloned:${'a'.repeat(40)}\n` };
    };
    const openReq: RepoOpenRequest = { repositoryId: REPO, canonicalURL: GITHUB, ref: 'refs/heads/main', branch: 'main', token: EGG,
      expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: 'write', auth: 'basic', timeoutMs: 90_000 };
    const deps = (grantOut: string) => ({ running: async () => true, touch: () => undefined, exec: exec(grantOut) });
    const opened = { ok: true, folder: `/workspace/projects/${REPO}`, head: 'a'.repeat(40), status: 'cloned' };
    expect(await repoOpenThenGrant(deps('ezil-repo-grant:ok\n'), openReq, root, SUBJECT)).toEqual(opened);
    expect(commands.filter((c) => c.includes('ezil-repo-grant'))).toHaveLength(1);
    // a failing grant op leaves the open's answer as it was
    expect(await repoOpenThenGrant(deps('ezil-repo-grant:error:repo_grant_conflict\n'), openReq, root, SUBJECT)).toEqual(opened);
    commands.length = 0;
    // no subject, no scope or a Bearer open: the open alone
    await repoOpenThenGrant(deps('ezil-repo-grant:ok\n'), openReq, root);
    await repoOpenThenGrant(deps('ezil-repo-grant:ok\n'), { ...openReq, scope: undefined }, root, SUBJECT);
    await repoOpenThenGrant(deps('ezil-repo-grant:ok\n'), { ...openReq, auth: 'bearer', canonicalURL: ARTIFACTS }, root, SUBJECT);
    expect(commands.filter((c) => c.includes('ezil-repo-grant'))).toHaveLength(0);
    // a failed open never installs anything
    const failing: RepoOpenExec = async (command) => { commands.push(command); return { exitCode: 0, stdout: 'ezil-repo-open:error:repo_open_folder_conflict\n' }; };
    expect(await repoOpenThenGrant({ running: async () => true, touch: () => undefined, exec: failing }, openReq, root, SUBJECT))
      .toEqual({ ok: false, error: 'repo_open_folder_conflict' });
    expect(commands.filter((c) => c.includes('ezil-repo-grant'))).toHaveLength(0);
  });

  it('a private CLI reuse still installs the current write grant through the existing helper', async () => {
    const calls: Array<{ command: string; env: Record<string, string> }> = [];
    const openReq: RepoOpenRequest = { repositoryId: REPO, canonicalURL: GITHUB, ref: 'refs/heads/main', branch: 'main',
      token: EGG, expiresAt: new Date(Date.now() + 240_000).toISOString(), scope: 'write', auth: 'basic', timeoutMs: 90_000,
      privateBinding: { projectId: '33333333-3333-4333-8333-333333333333', bindingVersion: 'b'.repeat(64),
        issuer: 'https://id.ezil.work/', subject: 'auth0|builder' } };
    const exec: RepoOpenExec = async (command, options) => {
      calls.push({ command, env: options.env });
      return { exitCode: 0, stdout: command.includes('ezil-repo-grant') ? 'ezil-repo-grant:ok\n'
        : JSON.stringify({ canonicalUrl: GITHUB, folder: `/workspace/projects/${REPO}/repository`,
          identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|builder' }, status: 'reused' }) };
    };
    expect(await repoOpenThenGrant({ running: async () => true, touch: () => undefined, exec }, openReq, root, SUBJECT))
      .toEqual({ ok: true, folder: `/workspace/projects/${REPO}`, status: 'fetched' });
    expect(calls).toHaveLength(2);
    expect(Object.keys(calls[0]!.env)).toEqual([REPO_OPEN_CLI_PACKET_ENV]);
    expect(calls[1]!.env).toEqual({ [REPO_OPEN_TOKEN_ENV]: EGG });
    expect(calls[1]!.command).not.toContain(EGG);
  });
});

describe('the pinned helper, its config line, the subject and the statuses', () => {
  it('the helper is the u2 kernel\'s, byte for byte (OS 84e4b686 ezil-git-grant.mjs)', () => {
    expect(createHash('sha256').update(EZIL_GIT_GRANT_HELPER_SOURCE, 'utf8').digest('hex')).toBe(EZIL_GIT_GRANT_HELPER_SHA256);
    expect(EZIL_GIT_GRANT_HELPER_SHA256).toBe('5de6b39aeb9ecbdc03cf3334e45047652b7249f0a395227deea92000f61ba55e');
  });
  it('credential.helper names the fixed wrapper exactly as the u2 kernel writes it, and no token', () => {
    expect(REPO_GRANT_HELPER_CONFIG_VALUE).toBe(`!f() { if [ -x /run/ezil/bin/ezil-git-grant ]; then exec /run/ezil/bin/ezil-git-grant "$@"; fi; if [ "$1" = get ]; then echo 'EZiL: Git access for this repository is not connected. Reopen it from EZiL OS.' >&2; echo quit=1; fi; }; f`);
  });
  it('the subject is a digest of the user id: stable, distinct per user, never the id', async () => {
    const a = await repoGrantSubject('user-1');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await repoGrantSubject('user-1')).toBe(a);
    expect(await repoGrantSubject('user-2')).not.toBe(a);
    expect(a).not.toContain('user-1');
  });
  it('statuses', () => {
    expect(repoGrantStatus('repo_open_invalid_request')).toBe(400);
    expect(repoGrantStatus('repo_grant_unsupported_remote')).toBe(400);
    for (const e of ['repo_open_token_expired', 'repo_grant_not_open', 'repo_grant_conflict', 'repo_open_busy', 'runtime_not_running'] as const) expect(repoGrantStatus(e)).toBe(409);
    expect(repoGrantStatus('repo_open_git_missing')).toBe(500);
    expect(repoGrantStatus('repo_grant_failed')).toBe(502);
  });
});
