/**
 * A public github.com repository opened from a direct URL (`/app/code?repo=<https URL>`, founder 547ed35a): the
 * Worker accepts it only on os-staging (`repoOpenRemotesFor`), fetches it anonymously (`auth: 'none'`), and the body
 * carries no grant at all. The real-git behaviour (no credential sent, reopen keeps work) is in repo-open.git.test.ts.
 */
import { describe, expect, it } from 'bun:test';

import { parseRepoOpenRequest, PUBLIC_GITHUB_REPOSITORY_URL, repoOpenAuthFor, repoOpenCommand, repoOpenRemotesFor } from './repo-open';

const REPO = '00000000-0000-4000-8000-0000000000ab';
const URL_OK = 'https://github.com/EZiLHQ/ezil-os.git';
const staging = repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: 'https://ai-staging.ezil.work' });
const body = (over: Record<string, unknown> = {}) => ({ repositoryId: REPO, canonicalURL: URL_OK, ref: 'refs/heads/main', ...over });
const grant = { token: `egg_${'1'.repeat(64)}`, expiresAt: new Date(Date.now() + 240_000).toISOString() };

describe('public github.com remote (anonymous, os-staging only)', () => {
  it('os-staging opts in to both staging remotes; production and anything else to neither', () => {
    expect(staging).toEqual({ stagingGitQa: true, publicGitHub: true });
    for (const value of ['https://ai.ezil.work', undefined, '', 'https://ai-staging.ezil.work//', ' https://ai-staging.ezil.work']) {
      expect(repoOpenRemotesFor({ EZIL_AI_GATEWAY_URL: value })).toEqual({});
    }
  });

  it('is accepted with no git object on os-staging, and is anonymous', () => {
    const parsed = parseRepoOpenRequest(body(), Date.now(), staging);
    expect(parsed).toEqual({ ok: true, request: { repositoryId: REPO, canonicalURL: URL_OK, ref: 'refs/heads/main', branch: 'main',
      token: '', expiresAt: '', auth: 'none', timeoutMs: expect.any(Number) } });
  });

  it('is refused off os-staging, with a grant (no credential may go to GitHub), or as an inherited opt-in', () => {
    expect(parseRepoOpenRequest(body(), Date.now(), {})).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    expect(parseRepoOpenRequest(body({ git: grant }), Date.now(), staging)).toEqual({ ok: false, error: 'repo_open_invalid_request' });
    const inherited = Object.create({ publicGitHub: true }) as Record<string, unknown>;
    expect(repoOpenAuthFor(URL_OK, inherited)).toBeNull();
    expect(repoOpenAuthFor(URL_OK, { publicGitHub: 'true' as unknown as boolean })).toBeNull();
  });

  it('every other remote still needs its grant on os-staging', () => {
    expect(parseRepoOpenRequest(body({ canonicalURL: 'https://git-qa.ezil.work/acme-qa/site.git' }), Date.now(), staging))
      .toEqual({ ok: false, error: 'repo_open_invalid_request' });
    expect(parseRepoOpenRequest(body({ canonicalURL: 'https://git-qa.ezil.work/acme-qa/site.git', git: grant }), Date.now(), staging))
      .toMatchObject({ ok: true, request: { auth: 'basic' } });
  });

  it.each([
    'https://github.com/EZiLHQ/ezil-os.git', 'https://github.com/a/b.git', 'https://github.com/a-b/c.d_e-f.git',
    `https://github.com/${'a'.repeat(39)}/x.git`,
  ])('accepts %s', url => expect(PUBLIC_GITHUB_REPOSITORY_URL.test(url)).toBe(true));
  it.each([
    'https://github.com/EZiLHQ/ezil-os', 'https://github.com/EZiLHQ/ezil-os.git/', 'http://github.com/a/b.git', 'https://www.github.com/a/b.git',
    'https://github.com:443/a/b.git', 'https://user@github.com/a/b.git', 'https://github.com/a/b.git?x=1', 'https://github.com/a/b.git#x',
    'https://github.com/-a/b.git', 'https://github.com/a-/b.git', 'https://github.com/a--b/c.git', `https://github.com/${'a'.repeat(40)}/x.git`,
    'https://github.com/a/.hidden.git', 'https://github.com/a/b..c.git', 'https://github.com/a/b/c.git', 'https://github.com.evil.com/a/b.git',
    'https://github.com/a/b%2e.git', 'https://github.com/a/b c.git',
  ])('refuses %s', url => expect(PUBLIC_GITHUB_REPOSITORY_URL.test(url)).toBe(false));

  it("the exec command passes 'none' and no token is ever part of it", () => {
    const command = repoOpenCommand({ root: '/workspace', repositoryId: REPO, url: URL_OK, branch: 'main', requireHydrated: false, auth: 'none', timeoutMs: 60_000 });
    // The arguments after the script: the remote, the branch, not hydrated, `none`, then the bounds; the token only ever via fd 3.
    expect(command).toMatch(/' ezil-repo-open fetch '\/workspace' '00000000-0000-4000-8000-0000000000ab' 'https:\/\/github\.com\/EZiLHQ\/ezil-os\.git' 'main' 0 none \d+ \d+ 3<<<"\$t"\)$/);
    expect(command).not.toContain('egg_');
  });
});
