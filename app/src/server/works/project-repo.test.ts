import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { openProjectRepository, worksProjectRepoOrigin, WorksProjectRepoError } from './project-repo';

const PROJECT = '3333abcd-3333-4333-8333-33333333cdef';
const REPO = '44444444-4444-4444-8444-44444444abcd';
const NOW = Date.parse('2026-10-31T12:00:00Z');
const env = { EZIL_WORKS_PROJECT_REPO_ORIGIN: 'https://api-staging.example' };
const answer = (over: Record<string, unknown> = {}) => ({
    binding: { projectId: PROJECT, repositoryId: REPO, canonicalURL: 'https://github.ezil.work/acme/site.git', ref: 'refs/heads/main', bindingVersion: 'c'.repeat(64) },
    access: { role: 'client' },
    git: { username: 'ezil', token: `egg_${'0'.repeat(64)}`, expiresAt: new Date(NOW + 300_000).toISOString(), scope: 'read' },
    ...over,
});
const input = { userIdToken: 'id-token', projectId: PROJECT, repositoryId: REPO, identityExpiresAt: NOW + 3_600_000 };
const open = (fetcher: (url: URL, init: RequestInit) => Response | Promise<Response>, over: Partial<typeof input> = {}) =>
    openProjectRepository({ ...input, ...over }, { env, now: () => NOW, fetch: (async (u: URL, i: RequestInit) => fetcher(u, i)) as unknown as typeof fetch });
const code = (p: Promise<unknown>) => p.then(() => 'resolved', (e: unknown) => e instanceof WorksProjectRepoError ? e.code : `other:${String(e)}`);

describe('Works origin (EZIL_WORKS_PROJECT_REPO_ORIGIN)', () => {
    it('is a bare https origin', () => {
        expect(worksProjectRepoOrigin(env)).toBe('https://api-staging.example');
        expect(worksProjectRepoOrigin({ EZIL_WORKS_PROJECT_REPO_ORIGIN: ' https://api-staging.example:8443 ' })).toBe('https://api-staging.example:8443');
    });
    it.each([undefined, '', 'http://api-staging.example', 'https://api-staging.example/', 'https://api-staging.example/v1',
        'https://api-staging.example?x=1', 'https://api-staging.example#f', 'https://u:p@api-staging.example', 'api-staging.example', 'https://'])('refuses %j', value => {
        expect(() => worksProjectRepoOrigin({ EZIL_WORKS_PROJECT_REPO_ORIGIN: value })).toThrow(WorksProjectRepoError);
    });
});

describe('openProjectRepository', () => {
    it('POSTs exactly {userIdToken, projectId, repositoryId} as JSON and returns the validated grant', async () => {
        const seen: { url: URL; init: RequestInit }[] = [];
        const grant = await open((url, init) => { seen.push({ url, init }); return Response.json(answer()); });
        expect(seen[0].url.toString()).toBe('https://api-staging.example/internal/project-repositories/open');
        expect(seen[0].init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store', headers: { 'content-type': 'application/json' } });
        expect(JSON.parse(String(seen[0].init.body))).toStrictEqual({ userIdToken: 'id-token', projectId: PROJECT, repositoryId: REPO });
        expect(grant).toEqual({ binding: answer().binding, role: 'client', git: { username: 'ezil', token: answer().git.token, expiresAt: answer().git.expiresAt } });
    });

    it('ignores unknown top-level fields but holds the grant to its exact shape', async () => {
        expect(await code(open(() => Response.json({ ...answer(), identity: { issuer: 'https://id.ezil.work/', subject: 'auth0|a' } })))).toBe('resolved');
        expect(await code(open(() => Response.json(answer({ git: { ...answer().git, extra: 1 } }))))).toBe('unavailable');
    });

    it('refuses before any request when the ids are not lowercase canonical UUIDs', async () => {
        const fetcher = vi.fn(() => Response.json(answer()));
        expect(await code(open(fetcher, { projectId: PROJECT.toUpperCase() }))).toBe('not_authorized');
        expect(await code(open(fetcher, { repositoryId: `{${REPO}}` }))).toBe('not_authorized');
        expect(fetcher).not.toHaveBeenCalled();
    });

    it.each([
        [401, 'identity_refused'], [403, 'not_authorized'], [400, 'unavailable'], [404, 'unavailable'], [500, 'unavailable'], [503, 'unavailable'],
    ])('maps Works %i to %s', async (status, expected) => {
        expect(await code(open(() => Response.json({ error: 'project_repo_x', message: 'm' }, { status })))).toBe(expected);
    });

    it.each([
        ['another project', { binding: { ...answer().binding, projectId: '55555555-5555-4555-8555-555555555555' } }, 'not_authorized'],
        ['another repository', { binding: { ...answer().binding, repositoryId: '55555555-5555-4555-8555-555555555555' } }, 'not_authorized'],
        ['a write scope', { git: { ...answer().git, scope: 'write' } }, 'unavailable'],
        ['a non-egg token', { git: { ...answer().git, token: 'ghp_x' } }, 'unavailable'],
        ['an expired grant', { git: { ...answer().git, expiresAt: new Date(NOW - 1).toISOString() } }, 'unavailable'],
        ['a ten-minute grant', { git: { ...answer().git, expiresAt: new Date(NOW + 600_000).toISOString() } }, 'unavailable'],
        ['an unknown role', { access: { role: 'owner' } }, 'unavailable'],
        ['a foreign host', { binding: { ...answer().binding, canonicalURL: 'https://github.com/acme/site.git' } }, 'unavailable'],
        ['a dot-dot repository', { binding: { ...answer().binding, canonicalURL: 'https://github.ezil.work/acme/..site.git' } }, 'unavailable'],
        ['an unsafe ref', { binding: { ...answer().binding, ref: 'refs/heads/../x' } }, 'unavailable'],
    ])('refuses %s', async (_name, over, expected) => {
        expect(await code(open(() => Response.json(answer(over))))).toBe(expected);
    });

    it('does not believe a grant that outlives the ID token it was issued for', async () => {
        expect(await code(open(() => Response.json(answer()), { identityExpiresAt: NOW + 60_000 }))).toBe('unavailable');
    });

    it('a transport failure, an oversized body or non-JSON is unavailable, and no error carries Works\' text', async () => {
        expect(await code(open(() => { throw new Error('ECONNREFUSED id-token'); }))).toBe('unavailable');
        expect(await code(open(() => new Response('x'.repeat(20_000))))).toBe('unavailable');
        const error = await open(() => new Response('<html>id-token egg_secret</html>')).catch((e: Error) => e);
        expect(error).toBeInstanceOf(WorksProjectRepoError);
        expect((error as Error).message).toBe('works_project_repo_unavailable');
    });

    it('is not_configured without an origin, and never fetches', async () => {
        const fetcher = vi.fn();
        await expect(openProjectRepository(input, { env: {}, fetch: fetcher })).rejects.toMatchObject({ code: 'not_configured' });
        expect(fetcher).not.toHaveBeenCalled();
    });
});
