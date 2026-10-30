import { afterEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
const set = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({ cookies: async () => ({ set }) }));
import { GET } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('Auth0 login route', () => {
    it('starts a document redirect and sets a transaction cookie', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', 'test-client'); vi.stubEnv('AUTH0_SECRET_ID', 'test-secret');
        const response = await GET(new NextRequest('https://os-staging.ezil.work/auth/auth0/login?returnUrl=/os'));
        const url = new URL(response.headers.get('location')!);
        expect(url.origin + url.pathname).toBe('https://id.ezil.work/authorize');
        expect(url.searchParams.get('redirect_uri')).toBe('https://os-staging.ezil.work/auth/auth0/callback');
        expect(set).toHaveBeenCalledOnce();
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
    it('fails safely when disabled without setting a transaction', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', ''); vi.stubEnv('AUTH0_SECRET_ID', '');
        const response = await GET(new NextRequest('https://os-staging.ezil.work/auth/auth0/login'));
        expect(response.headers.get('location')).toBe('https://os-staging.ezil.work/login?error=auth0_disabled');
        expect(set).not.toHaveBeenCalled();
    });
});
