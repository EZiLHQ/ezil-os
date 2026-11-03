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

describe('Auth0 login route: silent re-auth', () => {
    it('passes prompt=none through to Auth0 exactly, and nothing else', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', 'test-client'); vi.stubEnv('AUTH0_SECRET_ID', 'test-secret');
        const silent = new URL((await GET(new NextRequest('https://os-staging.ezil.work/auth/auth0/login?prompt=none&returnUrl=/app/code'))).headers.get('location')!);
        expect(silent.searchParams.get('prompt')).toBe('none');
        for (const prompt of ['login', 'consent', 'select_account', 'none ', '']) {
            const url = new URL((await GET(new NextRequest(`https://os-staging.ezil.work/auth/auth0/login?${new URLSearchParams({ prompt })}`))).headers.get('location')!);
            expect(url.searchParams.has('prompt')).toBe(false);
        }
        const plain = new URL((await GET(new NextRequest('https://os-staging.ezil.work/auth/auth0/login'))).headers.get('location')!);
        expect(plain.searchParams.has('prompt')).toBe(false);
    });
});

describe('Auth0 login route: auth recovery', () => {
    const KEPT = '__Host-ezil-login-return';
    const withKept = (query: string) => new NextRequest(`https://os-staging.ezil.work/auth/auth0/login?${query}`, { headers: { cookie: `${KEPT}=L2FwcC9icm93c2Vy` } });
    it('an interactive sign-in takes over the page a sign-out kept, and expires it', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', 'test-client'); vi.stubEnv('AUTH0_SECRET_ID', 'test-secret');
        const response = await GET(withKept('returnUrl=%2Fapp%2Fbrowser'));
        expect(new URL(response.headers.get('location')!).pathname).toBe('/authorize');
        expect(response.cookies.get(KEPT)).toMatchObject({ value: '', maxAge: 0, secure: true, httpOnly: true, path: '/' });
    });
    it('a silent re-auth leaves it alone, and nothing is set when there is none', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', 'test-client'); vi.stubEnv('AUTH0_SECRET_ID', 'test-secret');
        expect((await GET(withKept('prompt=none&returnUrl=%2Fos'))).cookies.get(KEPT)).toBeUndefined();
        expect((await GET(new NextRequest('https://os-staging.ezil.work/auth/auth0/login?returnUrl=/os'))).cookies.get(KEPT)).toBeUndefined();
    });
    it.each([['/app/browser', '%2Fapp%2Fbrowser'], ['//evil.example', '%2Fcomputers'], ['https://evil.example/', '%2Fcomputers']])(
        'a failed start goes back to sign-in still headed for %j, narrowed', async (returnUrl, encoded) => {
            vi.stubEnv('AUTH0_CLIENT_ID', ''); vi.stubEnv('AUTH0_SECRET_ID', '');
            const response = await GET(new NextRequest(`https://os-staging.ezil.work/auth/auth0/login?${new URLSearchParams({ returnUrl })}`));
            expect(response.headers.get('location')).toBe(`https://os-staging.ezil.work/login?error=auth0_disabled&returnUrl=${encoded}`);
            expect(response.headers.get('cache-control')).toBe('no-store');
            expect(set).not.toHaveBeenCalled();
        },
    );
});
