import { afterEach, describe, expect, it, vi } from 'vitest';

import { REBASE_RELEASE_REGISTRY_CAPACITY } from '@/server/lib/compute/aws-rebase-release';
import { GET } from './route';

afterEach(() => vi.unstubAllEnvs());

describe('GET /api/health', () => {
    it('reports the deployed commit and is never cached', async () => {
        vi.stubEnv('EZIL_GIT_SHA', '40064294a1b2c3d4e5f60718293a4b5c6d7e8f90');
        const res = GET();
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(await res.json()).toEqual({ ok: true, sha: '40064294a1b2c3d4e5f60718293a4b5c6d7e8f90', registryCapacity: 35 });
    });

    it('reports the registry capacity the running parsers enforce, not a configured value', async () => {
        vi.stubEnv('EZIL_GIT_SHA', '40064294a1b2c3d4e5f60718293a4b5c6d7e8f90');
        vi.stubEnv('EZIL_REGISTRY_CAPACITY', '99');
        const body = await GET().json();
        expect(body.registryCapacity).toBe(REBASE_RELEASE_REGISTRY_CAPACITY);
        expect(Number.isSafeInteger(body.registryCapacity)).toBe(true);
    });

    it('falls back to the Vercel commit', async () => {
        vi.stubEnv('EZIL_GIT_SHA', '');
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', 'abcdef1');
        expect(await GET().json()).toEqual({ ok: true, sha: 'abcdef1', registryCapacity: 35 });
    });

    it('never echoes a value that is not a commit SHA', async () => {
        vi.stubEnv('EZIL_GIT_SHA', 'sk_test_not-a-sha');
        vi.stubEnv('VERCEL_GIT_COMMIT_SHA', '');
        expect(await GET().json()).toEqual({ ok: true, sha: null, registryCapacity: 35 });
    });
});
