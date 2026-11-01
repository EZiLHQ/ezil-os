import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { openProjectRepository, projectRepoOrigin, ProjectRepoError, repositoryDisplayName } from './project-repo';

const PROJECT = '3333abcd-3333-4333-8333-33333333cdef';
const REPO = '44444444-4444-4444-8444-44444444abcd';
const NOW = Date.parse('2026-10-31T12:00:00Z');
const ACCOUNT = '0123456789abcdef'.repeat(2);
/** Universe's remote: `ArtifactsClient::remoteFor`, `https://<account>.artifacts.cloudflare.net/git/<namespace>/<name>.git`. */
const ARTIFACTS = `https://${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/p-${PROJECT}.git`;
/** An opaque Cloudflare Artifacts repo token. Not `egg_`. */
const TOKEN = 'art_v1_0123456789abcdefABCDEF-_.~+/=';
const env = { UNIVERSE_PROJECT_REPO_ORIGIN: 'https://universe-staging.ezil.work' };
/** `ProjectRepositories::open()`'s answer, as `ProjectRepositoriesOpenTest` pins it. */
const answer = (over: Record<string, unknown> = {}) => ({
    binding: { projectId: PROJECT, repositoryId: REPO, canonicalURL: ARTIFACTS, ref: 'refs/heads/main', bindingVersion: '1' },
    access: { role: 'builder' },
    git: { username: 'ezil', token: TOKEN, expiresAt: new Date(NOW + 300_000).toISOString(), scope: 'write' },
    ...over,
});
const withBinding = (over: Record<string, unknown>) => ({ binding: { ...answer().binding, ...over } });
const withGit = (over: Record<string, unknown>) => ({ git: { ...answer().git, ...over } });
const input = { userIdToken: 'id-token', projectId: PROJECT, repositoryId: REPO, identityExpiresAt: NOW + 3_600_000 };
const open = (fetcher: (url: URL, init: RequestInit) => Response | Promise<Response>, over: Partial<typeof input> = {}) =>
    openProjectRepository({ ...input, ...over }, { env, now: () => NOW, fetch: (async (u: URL, i: RequestInit) => fetcher(u, i)) as unknown as typeof fetch });
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e instanceof ProjectRepoError ? e.code : `other:${String(e)}`);

describe('Universe origin (UNIVERSE_PROJECT_REPO_ORIGIN)', () => {
    it('is a bare https origin', () => {
        expect(projectRepoOrigin(env)).toBe('https://universe-staging.ezil.work');
        expect(projectRepoOrigin({ UNIVERSE_PROJECT_REPO_ORIGIN: ' https://universe-staging.ezil.work:8443 ' })).toBe('https://universe-staging.ezil.work:8443');
    });
    it.each([undefined, '', 'http://universe-staging.ezil.work', 'https://universe-staging.ezil.work/', 'https://universe-staging.ezil.work/v1',
        'https://universe-staging.ezil.work?x=1', 'https://universe-staging.ezil.work#f', 'https://u:p@universe-staging.ezil.work', 'universe-staging.ezil.work', 'https://'])('refuses %j', value => {
        expect(() => projectRepoOrigin({ UNIVERSE_PROJECT_REPO_ORIGIN: value })).toThrow(ProjectRepoError);
    });
    it('the old EZiL Works name is not read', () => {
        expect(() => projectRepoOrigin({ EZIL_WORKS_PROJECT_REPO_ORIGIN: 'https://universe-staging.ezil.work' })).toThrow(ProjectRepoError);
    });
});

describe('openProjectRepository', () => {
    it('POSTs exactly {userIdToken, projectId, repositoryId} as JSON, no Authorization, no query, and returns the validated grant', async () => {
        const seen: { url: URL; init: RequestInit }[] = [];
        const grant = await open((url, init) => { seen.push({ url, init }); return Response.json(answer()); });
        expect(seen).toHaveLength(1);
        expect(seen[0].url.toString()).toBe('https://universe-staging.ezil.work/internal/project-repositories/open');
        expect(seen[0].url.search).toBe('');
        expect(seen[0].init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
        expect(seen[0].init.headers).toStrictEqual({ 'content-type': 'application/json' });
        expect(JSON.parse(String(seen[0].init.body))).toStrictEqual({ userIdToken: 'id-token', projectId: PROJECT, repositoryId: REPO });
        expect(grant).toEqual({ binding: answer().binding, role: 'builder', git: { username: 'ezil', token: TOKEN, expiresAt: answer().git.expiresAt, scope: 'write' } });
    });

    it("accepts the client's read grant and an EZiL Git (github.ezil.work) remote", async () => {
        expect(await open(() => Response.json(answer({ access: { role: 'client' }, ...withGit({ scope: 'read' }) })))).toMatchObject({ role: 'client', git: { scope: 'read' } });
        expect(await code(open(() => Response.json(answer(withBinding({ canonicalURL: 'https://github.ezil.work/acme/site.git' })))))).toBe('resolved');
        expect(await code(open(() => Response.json(answer(withGit({ token: `egg_${'0'.repeat(64)}` })))))).toBe('resolved');
    });

    it.each([['1'], ['a'.repeat(64)], ['v2:sha256/abc']])('accepts bindingVersion %j (any 1-64 characters)', async bindingVersion => {
        expect(await code(open(() => Response.json(answer(withBinding({ bindingVersion })))))).toBe('resolved');
    });

    it('a token of 4096 characters is the cap', async () => {
        expect(await code(open(() => Response.json(answer(withGit({ token: 'a'.repeat(4096) })))))).toBe('resolved');
        expect(await code(open(() => Response.json(answer(withGit({ token: 'a'.repeat(4097) })))))).toBe('unavailable');
    });

    it('ignores unknown top-level fields but holds the grant to its exact shape', async () => {
        expect(await code(open(() => Response.json({ ...answer(), identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|a' } })))).toBe('resolved');
        expect(await code(open(() => Response.json(answer(withGit({ extra: 1 })))))).toBe('unavailable');
        expect(await code(open(() => Response.json(answer(withBinding({ extra: 1 })))))).toBe('unavailable');
    });

    it('refuses before any request when the ids are not lowercase canonical UUIDs', async () => {
        const fetcher = vi.fn(() => Response.json(answer()));
        expect(await code(open(fetcher, { projectId: PROJECT.toUpperCase() }))).toBe('not_authorized');
        expect(await code(open(fetcher, { repositoryId: `{${REPO}}` }))).toBe('not_authorized');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
        [400, 'project_repo_invalid_request', 'unavailable'],
        [401, 'project_repo_invalid_identity', 'identity_refused'],
        [403, 'project_repo_not_authorized', 'not_authorized'],
        [404, 'not_found', 'disabled'],
        [429, 'project_repo_rate_limited', 'rate_limited'],
        [500, 'server_error', 'unavailable'],
        [502, 'project_repo_upstream_unavailable', 'unavailable'],
        [503, 'project_repo_configuration_required', 'unavailable'],
        [503, 'project_repo_identity_unavailable', 'unavailable'],
    ])('maps Universe %i %s to %s', async (status, error, expected) => {
        expect(await code(open(() => Response.json({ error, message: 'm' }, { status })))).toBe(expected);
    });

    const ACCOUNT_URL = (host: string, path = 'universe-staging/site.git') => `https://${host}.artifacts.cloudflare.net/git/${path}`;
    it.each([
        ['another project', withBinding({ projectId: '55555555-5555-4555-8555-555555555555' }), 'not_authorized'],
        ['another repository', withBinding({ repositoryId: '55555555-5555-4555-8555-555555555555' }), 'not_authorized'],
        ['an admin scope', withGit({ scope: 'admin' }), 'unavailable'],
        ['an empty token', withGit({ token: '' }), 'unavailable'],
        ['a token with a space', withGit({ token: 'Bearer x' }), 'unavailable'],
        ['a token with a newline', withGit({ token: `${TOKEN}\nX-Evil: 1` }), 'unavailable'],
        ['a non-ASCII token', withGit({ token: `${TOKEN}é` }), 'unavailable'],
        ['another git username', withGit({ username: 'x-access-token' }), 'unavailable'],
        ['an expired grant', withGit({ expiresAt: new Date(NOW - 1).toISOString() }), 'unavailable'],
        ['a grant that ends exactly now', withGit({ expiresAt: new Date(NOW).toISOString() }), 'unavailable'],
        ['a grant past now + 330 s', withGit({ expiresAt: new Date(NOW + 330_001).toISOString() }), 'unavailable'],
        ['a ten-minute grant', withGit({ expiresAt: new Date(NOW + 600_000).toISOString() }), 'unavailable'],
        ['an unknown role', { access: { role: 'owner' } }, 'unavailable'],
        ['an empty bindingVersion', withBinding({ bindingVersion: '' }), 'unavailable'],
        ['a 65-character bindingVersion', withBinding({ bindingVersion: 'a'.repeat(65) }), 'unavailable'],
        ['a numeric bindingVersion', withBinding({ bindingVersion: 1 }), 'unavailable'],
        ['a foreign host', withBinding({ canonicalURL: 'https://github.com/acme/site.git' }), 'unavailable'],
        ['a dot-dot repository', withBinding({ canonicalURL: 'https://github.ezil.work/acme/..site.git' }), 'unavailable'],
        ['a 31-hex account', withBinding({ canonicalURL: ACCOUNT_URL(ACCOUNT.slice(1)) }), 'unavailable'],
        ['a 33-hex account', withBinding({ canonicalURL: ACCOUNT_URL(`${ACCOUNT}0`) }), 'unavailable'],
        ['an uppercase-hex account', withBinding({ canonicalURL: ACCOUNT_URL(ACCOUNT.toUpperCase()) }), 'unavailable'],
        ["Universe's own test account label", withBinding({ canonicalURL: ACCOUNT_URL('acct-test') }), 'unavailable'],
        ['a lookalike Artifacts host', withBinding({ canonicalURL: `https://${ACCOUNT}.artifacts.cloudflare.net.evil.test/git/universe-staging/site.git` }), 'unavailable'],
        ['userinfo on the Artifacts host', withBinding({ canonicalURL: `https://ezil:x@${ACCOUNT}.artifacts.cloudflare.net/git/universe-staging/site.git` }), 'unavailable'],
        ['a port', withBinding({ canonicalURL: `https://${ACCOUNT}.artifacts.cloudflare.net:443/git/universe-staging/site.git` }), 'unavailable'],
        ['a query', withBinding({ canonicalURL: `${ARTIFACTS}?x=1` }), 'unavailable'],
        ['no /git/ prefix', withBinding({ canonicalURL: `https://${ACCOUNT}.artifacts.cloudflare.net/universe-staging/site.git` }), 'unavailable'],
        ['a dot-dot Artifacts name', withBinding({ canonicalURL: ACCOUNT_URL(ACCOUNT, 'universe-staging/a..b.git') }), 'unavailable'],
        ['an unsafe ref', withBinding({ ref: 'refs/heads/../x' }), 'unavailable'],
    ])('refuses %s', async (_name, over, expected) => {
        expect(await code(open(() => Response.json(answer(over))))).toBe(expected);
    });

    it('accepts a grant up to now + 330 s (five minutes plus clock skew)', async () => {
        expect(await code(open(() => Response.json(answer(withGit({ expiresAt: new Date(NOW + 330_000).toISOString() })))))).toBe('resolved');
    });

    it('does not believe a grant that outlives the ID token it was issued for', async () => {
        expect(await code(open(() => Response.json(answer()), { identityExpiresAt: NOW + 60_000 }))).toBe('unavailable');
    });

    it("gives up with the caller's deadline", async () => {
        const deadline = new AbortController();
        const pending = openProjectRepository(input, { env, now: () => NOW, signal: deadline.signal,
            fetch: ((_u: URL, init: RequestInit) => new Promise((_resolve, reject) => {
                init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
            })) as unknown as typeof fetch });
        deadline.abort();
        expect(await code(pending)).toBe('unavailable');
    });

    it('a transport failure, an oversized body or non-JSON is unavailable, and no error carries Universe\'s text', async () => {
        expect(await code(open(() => { throw new Error('ECONNREFUSED id-token'); }))).toBe('unavailable');
        expect(await code(open(() => new Response('x'.repeat(20_000))))).toBe('unavailable');
        const error = await open(() => new Response(`<html>id-token ${TOKEN}</html>`)).catch((e: Error) => e);
        expect(error).toBeInstanceOf(ProjectRepoError);
        expect((error as Error).message).toBe('project_repo_unavailable');
    });

    it('is not_configured without an origin, and never fetches', async () => {
        const fetcher = vi.fn();
        await expect(openProjectRepository(input, { env: {}, fetch: fetcher })).rejects.toMatchObject({ code: 'not_configured' });
        expect(fetcher).not.toHaveBeenCalled();
    });
});

describe('repositoryDisplayName', () => {
    it('is <namespace>/<name> of either remote, never the URL or the account', () => {
        expect(repositoryDisplayName(ARTIFACTS)).toBe(`universe-staging/p-${PROJECT}`);
        expect(repositoryDisplayName('https://github.ezil.work/acme/site.git')).toBe('acme/site');
        expect(repositoryDisplayName(ARTIFACTS)).not.toContain(ACCOUNT);
        expect(repositoryDisplayName('https://github.com/acme/site.git')).toBeNull();
    });
});
