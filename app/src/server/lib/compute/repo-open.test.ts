import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { canonicalRepository, requestRepositoryOpen, withRepositoryFolder } from './repo-open';
const computer = { userId: '11111111-1111-4111-8111-111111111111', computerId: '22222222-2222-4222-8222-222222222222' };
const repo = 'https://github.ezil.work/team/fixture.git';
const folder = '/workspace/.ezil-repositories/' + createHash('sha256').update(computer.userId).digest('hex') + '/' + createHash('sha256').update(repo).digest('hex');
afterEach(() => vi.unstubAllGlobals());
describe('authenticated repository handoff', () => {
 it.each(['https://code.example/preview-bootstrap?token=test','https://aws-code.example/preview-bootstrap?token=test'])('sets the exact encoded folder for %s', url => {
    const result = new URL(withRepositoryFolder(url, folder));
    expect(result.searchParams.get('folder')).toBe(folder); expect(result.searchParams.get('token')).toBe('test');
    expect(() => withRepositoryFolder(url, '/workspace/../etc')).toThrow();
 });
 it('signs only the authenticated account and URL, never a caller destination', async () => {
    const fetch = vi.fn(async (_url, init) => {
       const body = JSON.parse(init.body); expect(body).toEqual({ repo, userId: computer.userId });
       const token = init.headers['x-ezil-auth']; const claim = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
       expect(claim.userId).toBe(computer.userId); expect(claim.computerId).toBe(computer.computerId);
       expect(init.redirect).toBe('error');
       return new Response(JSON.stringify({ ok: true, canonicalUrl: repo, folder }));
    });
    vi.stubGlobal('fetch', fetch);
    const result = await requestRepositoryOpen('https://worker.example', 'test-only-secret', { sandboxName: 'guac-abc-def', auth: { kind: 'v1' } }, computer, repo);
    expect(result).toEqual({ ok: true, folder }); expect(fetch).toHaveBeenCalledOnce();
 });
 it('refuses clone failures and root substitutions instead of opening root', async () => {
    for (const body of [{ ok: false, error: 'repo_auth_required' }, { ok: true, canonicalUrl: repo, folder: '/workspace' }]) {
       vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body)));
       expect((await requestRepositoryOpen('https://worker.example', 'test-only-secret', { sandboxName: 'guac-a-b', auth: { kind: 'v1' } }, computer, repo)).ok).toBe(false);
    }
 });
 it('uses complete namespaces and rejects canonical URL tricks before network', async () => {
    expect(canonicalRepository.test(repo)).toBe(true);
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await requestRepositoryOpen('https://worker.example', 'test-only-secret', { sandboxName: 'guac-a-b', auth: { kind: 'v1' } }, computer, repo + '?path=/tmp');
    expect(fetch).not.toHaveBeenCalled();
 });
});
