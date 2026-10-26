import { describe, it, expect } from 'bun:test';
import { validRepoIntent, validRepoFolder, repoOpenResult } from './repo-open';
import { sendAwsRepositoryOpen } from './aws-origin';
describe('repo-open wire boundary', () => {
 it('rejects paths and unrecognized fields', () => {
   expect(validRepoIntent({ repo: 'https://github.ezil.work/a/r.git', userId: '11111111-1111-4111-8111-111111111111', path: '/tmp' })).toBe(false);
   expect(validRepoFolder('/workspace/../etc')).toBe(false);
   expect(repoOpenResult({ ok: true, folder: '/workspace', canonicalUrl: 'https://github.ezil.work/a/r.git', status: 'cloned' }, 'https://github.ezil.work/a/r.git').ok).toBe(false);
 });
 it('binds the repository body into the signed AWS control path', async () => {
   const calls: Array<[string, RequestInit | undefined]> = [];
   const record = { sandboxId: 'guac-abc-def', computerId: '11111111-1111-4111-8111-111111111111', generation: 1, leaseEpoch: 1, controlKey: btoa('x'.repeat(32)) } as any;
   await sendAwsRepositoryOpen(record, 'example.test', '{"repo":"a"}', async (url, init) => { calls.push([String(url), init]); return new Response('{}'); }, 100);
   await sendAwsRepositoryOpen(record, 'example.test', '{"repo":"b"}', async (url, init) => { calls.push([String(url), init]); return new Response('{}'); }, 100);
   expect(calls[0][0]).not.toBe(calls[1][0]); expect(calls[0][1]?.body).toBe('{"repo":"a"}');
   expect(calls[0][0]).toMatch(/\/repo-open\/[a-f0-9]{64}$/);
 });
});
