import { describe, expect, it, vi } from 'vitest';

import { resolvePublicGitHubSourcePin } from './github-source-pin';

const COMMIT = '39cc34a84bfb78023154c9f4e99c61f3cbe8fc19';
const TREE = 'b'.repeat(40);
const request = (repositoryUrl = 'https://github.com/reticlehq/reticle', requestedCommitSha?: string) => ({
    schemaVersion: 1,
    repositoryUrl,
    requestedCommitSha,
    clientRequestId: '11111111-1111-4111-8111-111111111111',
});
const json = (body: unknown, init: ResponseInit = {}) =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });

describe('public GitHub commit resolution', () => {
    it('resolves a requested full SHA without following redirects or accepting a mutable tag', async () => {
        const fetcher = vi.fn(async () => json({ sha: COMMIT, tree: { sha: TREE } })) as unknown as typeof fetch;

        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), fetcher)).toEqual({
            ok: true,
            repositoryUrl: 'https://github.com/reticlehq/reticle',
            commitSha: COMMIT,
            treeSha: TREE,
        });
        expect(fetcher).toHaveBeenCalledOnce();
        const [url, options] = vi.mocked(fetcher).mock.calls[0]!;
        expect(url).toBe(`https://api.github.com/repos/reticlehq/reticle/git/commits/${COMMIT}`);
        expect(options).toMatchObject({ method: 'GET', redirect: 'manual', credentials: 'omit', cache: 'no-store' });
        expect(await resolvePublicGitHubSourcePin(request(undefined, 'main'), fetcher)).toEqual({
            ok: false, reason: 'invalid-submission',
        });
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('pins a moving default branch to the returned commit and canonicalizes .git URLs', async () => {
        const fetcher = vi.fn(async () => json([{
            sha: COMMIT,
            commit: { tree: { sha: TREE } },
        }])) as unknown as typeof fetch;

        expect(await resolvePublicGitHubSourcePin(request('https://github.com/reticlehq/reticle.git'), fetcher))
            .toEqual({ ok: true, repositoryUrl: 'https://github.com/reticlehq/reticle',
                commitSha: COMMIT, treeSha: TREE });
        expect(vi.mocked(fetcher).mock.calls[0]![0])
            .toBe('https://api.github.com/repos/reticlehq/reticle/commits?per_page=1');
    });

    it('does not fetch non-GitHub hosts, embedded credentials, or repository subpaths', async () => {
        const fetcher = vi.fn() as unknown as typeof fetch;
        expect(await resolvePublicGitHubSourcePin(request('https://git.example.com/org/repo'), fetcher))
            .toEqual({ ok: false, reason: 'unsupported-host' });
        expect(await resolvePublicGitHubSourcePin(request('https://github.com/org/repo/tree/main'), fetcher))
            .toEqual({ ok: false, reason: 'unsupported-path' });
        expect(await resolvePublicGitHubSourcePin(request('https://user:pass@github.com/org/repo'), fetcher))
            .toEqual({ ok: false, reason: 'invalid-submission' });
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('refuses a response for another commit, a redirect, and a non-JSON response', async () => {
        const mismatch = vi.fn(async () => json({ sha: 'c'.repeat(40), tree: { sha: TREE } })) as unknown as typeof fetch;
        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), mismatch))
            .toEqual({ ok: false, reason: 'invalid-response' });
        const redirect = vi.fn(async () => new Response(null, { status: 302,
            headers: { location: 'https://127.0.0.1/private' } })) as unknown as typeof fetch;
        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), redirect))
            .toEqual({ ok: false, reason: 'source-unavailable' });
        const foreignResponse = json({ sha: COMMIT, tree: { sha: TREE } });
        Object.defineProperty(foreignResponse, 'url', { value: 'https://private.example.test/commit' });
        const foreign = vi.fn(async () => foreignResponse) as unknown as typeof fetch;
        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), foreign))
            .toEqual({ ok: false, reason: 'source-unavailable' });
        const html = vi.fn(async () => new Response('<html/>', { status: 200,
            headers: { 'content-type': 'text/html' } })) as unknown as typeof fetch;
        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), html))
            .toEqual({ ok: false, reason: 'invalid-response' });
    });

    it('bounds both declared and streamed response sizes', async () => {
        const declared = vi.fn(async () => new Response('{}', { status: 200,
            headers: { 'content-type': 'application/json', 'content-length': String(600 * 1024) } })) as unknown as typeof fetch;
        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), declared))
            .toEqual({ ok: false, reason: 'response-too-large' });
        const streamed = vi.fn(async () => new Response('x'.repeat(513 * 1024), { status: 200,
            headers: { 'content-type': 'application/json' } })) as unknown as typeof fetch;
        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), streamed))
            .toEqual({ ok: false, reason: 'response-too-large' });
    });

    it('keeps rate limits, missing repositories, and transport errors as bounded codes', async () => {
        const fetcher = vi.fn()
            .mockResolvedValueOnce(new Response('{}', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
            .mockResolvedValueOnce(new Response('{}', { status: 404 }))
            .mockRejectedValueOnce(new Error('https://internal.example/token/secret-value')) as typeof fetch;

        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), fetcher))
            .toEqual({ ok: false, reason: 'rate-limited' });
        expect(await resolvePublicGitHubSourcePin(request(undefined, COMMIT), fetcher))
            .toEqual({ ok: false, reason: 'not-found' });
        const failed = await resolvePublicGitHubSourcePin(request(undefined, COMMIT), fetcher);
        expect(failed).toEqual({ ok: false, reason: 'source-unavailable' });
        expect(JSON.stringify(failed)).not.toContain('secret-value');
    });
});
