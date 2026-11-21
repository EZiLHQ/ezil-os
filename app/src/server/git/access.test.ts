import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { GitAccessError, grantForStandaloneGit, grantForWorksGitAddress, STANDALONE_GIT_GRANT_URL, WORKS_GIT_ADDRESS_GRANT_URL } from './access';
import { computerLabel } from '@/server/works/project-repo';
import type { RetainedIdentity } from '@/server/auth/retained-identity';

const URL = 'https://github.ezil.work/default/os-code-url-20261110-a.git';
const NOW = Date.parse('2026-11-10T17:00:00.000Z');
const identity: RetainedIdentity = { token: 'private-id-token', issuer: 'https://id.ezil.work/', subject: 'auth0|qa-free2',
    expiresAt: NOW + 600_000, userId: 'user', sessionId: 'session' };
const packet = (scope: 'read' | 'write') => ({ version: 2,
    repository: { id: 'fg1wtcrexaf7acl0', canonicalURL: URL, ref: 'refs/heads/main' },
    identity: { issuer: identity.issuer, subject: identity.subject },
    git: { username: 'ezil', token: 'opaque-gateway-credential', expiresAt: '2026-11-10T17:04:00.000Z', scope } });
const capture = (respond: (scope: 'read' | 'write') => Response) => {
    const calls: Array<{ endpoint: string; init: RequestInit; body: { repoURL: string; scope: 'read' | 'write' } }> = [];
    const fetcher = vi.fn(async (endpoint: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        calls.push({ endpoint, init, body });
        return respond(body.scope);
    });
    return { calls, fetcher: fetcher as unknown as typeof fetch };
};
const failure = async (promise: Promise<unknown>, code: GitAccessError['code']) => {
    await expect(promise).rejects.toMatchObject({ code });
};

describe('standalone Git gateway access', () => {
    it('asks for write using the retained EZiL ID token and verifies the exact v2 packet', async () => {
        const { calls, fetcher } = capture(scope => Response.json(packet(scope)));
        expect(await grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW })).toEqual(packet('write'));
        expect(calls).toHaveLength(1);
        expect(calls[0]!.endpoint).toBe(STANDALONE_GIT_GRANT_URL);
        expect(calls[0]!.body).toEqual({ repoURL: URL, scope: 'write' });
        expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${identity.token}`);
        expect(calls[0]!.endpoint).not.toContain(identity.token);
        expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    });
    it('retries read only after a 403 and reports the actual read scope', async () => {
        const { calls, fetcher } = capture(scope => scope === 'write' ? new Response(null, { status: 403 }) : Response.json(packet('read')));
        expect(await grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW })).toEqual(packet('read'));
        expect(calls.map(call => call.body.scope)).toEqual(['write', 'read']);
    });
    it('never retries read after a 401 or accepts a false write claim', async () => {
        const refused = capture(() => new Response(null, { status: 401 }));
        await failure(grantForStandaloneGit(identity, URL, { fetch: refused.fetcher, now: () => NOW }), 'identity_refused');
        expect(refused.calls.map(call => call.body.scope)).toEqual(['write']);
        const mismatch = capture(() => Response.json(packet('read')));
        await failure(grantForStandaloneGit(identity, URL, { fetch: mismatch.fetcher, now: () => NOW }), 'invalid_response');
        expect(mismatch.calls.map(call => call.body.scope)).toEqual(['write']);
    });
    it('refuses substituted repository, subject, ref, and expired credentials', async () => {
        const changed = [
            { ...packet('write'), repository: { ...packet('write').repository, id: '../wrong' } },
            { ...packet('write'), repository: { ...packet('write').repository, canonicalURL: 'https://github.ezil.work/default/other.git' } },
            { ...packet('write'), repository: { ...packet('write').repository, ref: 'refs/heads/../bad' } },
            { ...packet('write'), identity: { ...packet('write').identity, subject: 'auth0|other' } },
            { ...packet('write'), git: { ...packet('write').git, expiresAt: '2026-11-10T16:59:00.000Z' } },
        ];
        for (const answer of changed) {
            const { fetcher } = capture(() => Response.json(answer));
            await failure(grantForStandaloneGit(identity, URL, { fetch: fetcher, now: () => NOW }), 'invalid_response');
        }
    });
    it('sends no OAuth token for a noncanonical address', async () => {
        const { calls, fetcher } = capture(() => Response.json(packet('write')));
        await failure(grantForStandaloneGit(identity, 'https://github.ezil.work/default/../other.git', { fetch: fetcher, now: () => NOW }), 'invalid_response');
        expect(calls).toEqual([]);
    });
});

const QA_URL = 'https://git-qa.ezil.work/candidate-a/interview-1121.git';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const worksAnswer = (over: Record<string, unknown> = {}) => ({ username: 'ezil', token: `egg_${'a'.repeat(40)}`,
    expiresAt: '2026-11-10T17:04:00.000Z', cloneUrl: QA_URL, repositoryId: '4211', routeName: 'candidate-a/interview-1121',
    handle: 'candidate-a', name: 'interview-1121', scope: 'write', defaultBranch: 'main', class: 'project', ...over });
const captureWorks = (respond: () => Response) => {
    const calls: Array<{ endpoint: string; init: RequestInit }> = [];
    const fetcher = vi.fn(async (endpoint: string, init: RequestInit) => { calls.push({ endpoint, init }); return respond(); });
    return { calls, fetcher: fetcher as unknown as typeof fetch };
};

describe('staging Works git-qa address grant (contract §6)', () => {
    it('POSTs os-grant under the EZiL ID token with exactly {computerLabel, class, url}, returning the remote, ref and credential', async () => {
        const { calls, fetcher } = captureWorks(() => Response.json(worksAnswer()));
        const grant = await grantForWorksGitAddress(identity, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW });
        expect(grant).toEqual({ canonicalURL: QA_URL, ref: 'refs/heads/main',
            git: { token: `egg_${'a'.repeat(40)}`, expiresAt: '2026-11-10T17:04:00.000Z', scope: 'write' } });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.endpoint).toBe(WORKS_GIT_ADDRESS_GRANT_URL);
        const body = JSON.parse(String(calls[0]!.init.body));
        expect(body).toEqual({ computerLabel: computerLabel(COMPUTER), class: 'project', url: QA_URL });
        expect(Object.keys(body).sort()).toEqual(['class', 'computerLabel', 'url']); // Works refuses unknown keys
        expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Bearer ${identity.token}`);
        // The retained ID token travels only in the header, never the body or the URL.
        expect(String(calls[0]!.init.body)).not.toContain(identity.token);
        expect(calls[0]!.endpoint).not.toContain(identity.token);
        expect(calls[0]!.init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
    });
    it('reports an actual read scope without inventing write', async () => {
        const { fetcher } = captureWorks(() => Response.json(worksAnswer({ scope: 'read' })));
        expect((await grantForWorksGitAddress(identity, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW })).git.scope).toBe('read');
    });
    it.each([[401, 'identity_refused'], [403, 'not_found'], [404, 'not_found'], [429, 'unavailable'], [500, 'unavailable'], [502, 'unavailable']] as const)(
        'maps status %i to %s', async (status, code) => {
            const { fetcher } = captureWorks(() => new Response('x', { status }));
            await failure(grantForWorksGitAddress(identity, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW }), code);
        });
    it('a network failure is unavailable', async () => {
        const fetcher = vi.fn(async () => { throw new TypeError('network'); }) as unknown as typeof fetch;
        await failure(grantForWorksGitAddress(identity, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW }), 'unavailable');
    });
    it('a non-JSON or off-shape answer is invalid_response', async () => {
        const answers: Array<() => Response> = [
            () => new Response('not json', { status: 200 }),
            () => Response.json(worksAnswer({ class: 'hired' })),
            () => Response.json(worksAnswer({ username: 'other' })),
            () => Response.json(worksAnswer({ scope: 'admin' })),
            () => Response.json(worksAnswer({ token: 'has space' })),
            () => Response.json(worksAnswer({ expiresAt: 'not-a-date' })),
            () => Response.json({ ...worksAnswer(), extra: 1 }),
            () => Response.json((() => { const a = worksAnswer(); delete (a as Record<string, unknown>).defaultBranch; return a; })()),
        ];
        for (const respond of answers) {
            const { fetcher } = captureWorks(respond);
            await failure(grantForWorksGitAddress(identity, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW }), 'invalid_response');
        }
    });
    it('a grant for a different repository, or a branch git could read as an option, is invalid_response', async () => {
        for (const over of [{ cloneUrl: 'https://git-qa.ezil.work/other/repo.git' }, { defaultBranch: '../evil' },
            { defaultBranch: '-x' }, { defaultBranch: 'a..b' }, { defaultBranch: 'feature/' }]) {
            const { fetcher } = captureWorks(() => Response.json(worksAnswer(over)));
            await failure(grantForWorksGitAddress(identity, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW }), 'invalid_response');
        }
    });
    it('a feature-branch default is canonicalised to its full ref', async () => {
        const { fetcher } = captureWorks(() => Response.json(worksAnswer({ defaultBranch: 'feature/x' })));
        expect((await grantForWorksGitAddress(identity, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW })).ref).toBe('refs/heads/feature/x');
    });
    it('a noncanonical address, a non-git-qa host, or an expired or non-EZiL-ID identity is refused before any fetch', async () => {
        const { calls, fetcher } = captureWorks(() => Response.json(worksAnswer()));
        await failure(grantForWorksGitAddress(identity, 'https://git-qa.ezil.work/acme/../other.git', COMPUTER, { fetch: fetcher, now: () => NOW }), 'invalid_response');
        await failure(grantForWorksGitAddress(identity, 'https://github.ezil.work/default/x.git', COMPUTER, { fetch: fetcher, now: () => NOW }), 'invalid_response');
        await failure(grantForWorksGitAddress({ ...identity, issuer: 'https://evil/' }, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW }), 'identity_refused');
        await failure(grantForWorksGitAddress({ ...identity, expiresAt: NOW - 1 }, QA_URL, COMPUTER, { fetch: fetcher, now: () => NOW }), 'identity_refused');
        expect(calls).toEqual([]);
    });
});
