import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET } from './route';

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/health', () => {
    it('reports the deployed commit and is never cached', async () => {
        vi.stubEnv('EZIL_GIT_SHA', '40064294a1b2c3d4e5f60718293a4b5c6d7e8f90');
        const res = GET();
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ ok: true, sha: '40064294a1b2c3d4e5f60718293a4b5c6d7e8f90' });
    });

    it('falls back to the Vercel commit', async () => {
        vi.stubEnv('EZIL_GIT_SHA', '');
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abcdef1');
        expect(await GET().json()).toEqual({ ok: true, sha: 'abcdef1' });
    });

    it('never echoes a value that is not a commit SHA', async () => {
        vi.stubEnv('EZIL_GIT_SHA', 'sk_test_not-a-sha');
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
        expect(await GET().json()).toEqual({ ok: true, sha: null });
    });
});
