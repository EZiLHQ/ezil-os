import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import type { RetainedIdentity } from '@/server/auth/retained-identity';
import { computerLabel } from './project-repo';
import { GitAddressGrantError, GIT_ADDRESS_GRANT_URL, grantForGitAddress } from './git-address-grant';

const URL = 'https://github.ezil.work/acme/site.git';
const COMPUTER = '22222222-2222-4222-8222-222222222222';
const REPO = '44444444-4444-4444-8444-444444444444';
const TOKEN = `egg_${'a'.repeat(64)}`;
const identity = (): RetainedIdentity => ({ token: 'private-id-token', issuer: 'https://id.ezil.work/', subject: 'auth0|builder',
    expiresAt: Date.now() + 240_000, userId: '11111111-1111-4111-8111-111111111111', sessionId: 'session-1' });
const answer = (over: Record<string, unknown> = {}) => ({ username: 'ezil', token: TOKEN, expiresAt: new Date(Date.now() + 180_000).toISOString(),
    cloneUrl: URL, repositoryId: REPO, routeName: 'acme/site', handle: 'acme', name: 'site', scope: 'write', defaultBranch: 'topic/main', class: 'project', ...over });

describe('production EZiL Git address grant', () => {
    it('sends the exact owned address and returns only the bounded Worker fields', async () => {
        const fetcher = vi.fn(async () => Response.json(answer(), { status: 201 }));
        const grant = await grantForGitAddress(identity(), COMPUTER, URL, { fetch: fetcher as typeof fetch });
        expect(grant).toEqual({ repositoryId: REPO, canonicalURL: URL, ref: 'refs/heads/topic/main',
            git: { token: TOKEN, expiresAt: expect.any(String), scope: 'write' } });
        expect(fetcher).toHaveBeenCalledTimes(1);
        const [where, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
        expect(where).toBe(GIT_ADDRESS_GRANT_URL);
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
        expect(JSON.parse(String(init.body))).toEqual({ computerLabel: computerLabel(COMPUTER), class: 'project', url: URL });
        expect((init.headers as Record<string, string>).authorization).toBe('Bearer private-id-token');
        expect(String(init.body)).not.toContain(TOKEN);
    });

    it.each([
        [404, 'not_found'], [403, 'not_found'], [401, 'identity_refused'], [409, 'not_ready'], [503, 'unavailable'],
    ] as const)('maps %i without exposing a producer body', async (status, code) => {
        const fetcher = vi.fn(async () => new Response('secret producer detail', { status }));
        await expect(grantForGitAddress(identity(), COMPUTER, URL, { fetch: fetcher as typeof fetch }))
            .rejects.toMatchObject({ code, message: `git_address_grant_${code}` });
    });

    it.each([
        { cloneUrl: 'https://git-qa.ezil.work/acme/site.git' }, { repositoryId: 'not-a-uuid' },
        { defaultBranch: '../other' }, { routeName: 'other/site' }, { scope: 'admin' },
        { expiresAt: new Date(Date.now() + 600_000).toISOString() },
    ])('refuses an answer outside the authenticated route/ref/grant bounds', async over => {
        const fetcher = vi.fn(async () => Response.json(answer(over), { status: 201 }));
        await expect(grantForGitAddress(identity(), COMPUTER, URL, { fetch: fetcher as typeof fetch }))
            .rejects.toBeInstanceOf(GitAddressGrantError);
    });

    it('does not contact Works for an invalid identity or a different host', async () => {
        const fetcher = vi.fn(async () => Response.json(answer(), { status: 201 }));
        await expect(grantForGitAddress({ ...identity(), expiresAt: Date.now() - 1 }, COMPUTER, URL, { fetch: fetcher as typeof fetch }))
            .rejects.toMatchObject({ code: 'identity_refused' });
        await expect(grantForGitAddress(identity(), COMPUTER, 'https://git-qa.ezil.work/acme/site.git', { fetch: fetcher as typeof fetch }))
            .rejects.toMatchObject({ code: 'unavailable' });
        expect(fetcher).not.toHaveBeenCalled();
    });
});
