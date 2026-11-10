import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import { GitAccessError, grantForStandaloneGit, STANDALONE_GIT_GRANT_URL } from './access';
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
