/**
 * `POST /auth/signout`. The Supabase client is stubbed at the module boundary,
 * as in `../confirm/confirm-route.test.ts`, so these prove control flow — the
 * status, the destination and which cookies are expired by hand — not that
 * Supabase's own cookie writes land on the response.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
beforeEach(() => { vi.stubEnv('AUTH0_CLIENT_ID', ''); vi.stubEnv('AUTH0_SECRET_ID', ''); });
afterEach(() => vi.unstubAllEnvs());

const stub = vi.hoisted(() => ({
    getUser: vi.fn(),
    list: vi.fn(),
    throws: false,
    order: [] as string[],
    scopes: [] as (string | undefined)[],
    error: null as { message: string } | null,
    identityThrows: false,
    identityAt: [] as number[],
    createThrows: false,
}));

vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => {
        if (stub.createThrows) throw new Error('supabase env missing');
        return { auth: {
            getUser: () => stub.getUser(),
            signOut: async (options?: { scope?: string }) => {
                stub.order.push('signout');
                if (stub.throws) throw new Error('offline');
                stub.scopes.push(options?.scope);
                return { error: stub.error };
            },
        } };
    },
}));

vi.mock('@/server/auth/retained-identity', () => ({
    // Its own record, so the AI-revocation tests' exact `order` stays as it was: how much had happened when it ran.
    clearProjectIdentity: async () => { stub.identityAt.push(stub.order.length); if (stub.identityThrows) throw new Error('no request scope'); },
}));
vi.mock('@/server/db', () => ({ db: { query: { computers: { findMany: (options: unknown) => stub.list(options) } } } }));
vi.mock('@/server/lib/cloudflare-guacamole-provider', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/server/lib/cloudflare-guacamole-provider')>(),
    resolveCloudflareGuacamoleConfig: () => ({ workerUrl: 'https://worker.invalid', isConfigured: true, hasHmacSecret: true }),
}));

import { PgDialect } from 'drizzle-orm/pg-core';
import { AI_LOGOUT_TIMEOUT_MS } from '@/server/lib/ai-credential';
import { deriveGuacamoleSandboxId } from '@/server/lib/cloudflare-guacamole-provider';

const USER = 'abcdef01-2345-6789-abcd-ef0123456789';
const COMPUTERS = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'];
beforeEach(() => {
    vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'signout-test-secret');
    stub.getUser.mockReset().mockResolvedValue({ data: { user: { id: USER } } });
    stub.list.mockReset().mockResolvedValue(COMPUTERS.map((id) => ({ id })));
    stub.error = null;
    stub.throws = false;
    stub.identityThrows = false;
    stub.identityAt = [];
    stub.createThrows = false;
    stub.order = [];
    vi.stubGlobal('fetch', vi.fn(async () => { stub.order.push('delete'); return new Response('{}'); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

import { NextRequest } from 'next/server';

import { POST } from './route';

const ORIGIN = 'https://os.ezil.org';

function signOutRequest(cookie = '') {
    return new NextRequest(`${ORIGIN}/auth/signout`, {
        method: 'POST',
        headers: cookie ? { cookie } : {},
    });
}

describe('POST /auth/signout', () => {
    it('signs this browser out and answers 303 to /login (a document load)', async () => {
        stub.scopes = [];
        stub.error = null;
        const response = await POST(signOutRequest());
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).toBe(`${ORIGIN}/login`);
        expect(stub.scopes).toEqual(['local']);
    });

    it('🔴 still clears the session cookies when Supabase reports an error', async () => {
        stub.scopes = [];
        stub.error = { message: 'fetch failed' };
        const response = await POST(
            signOutRequest(
                '__Host-ezil-os-auth.0=a; __Host-ezil-os-auth.1=b; sb-btgqfmnzycdecmeyqubx-auth-token=c; theme=dark',
            ),
        );
        expect(response.status).toBe(303);
        const cleared = response.cookies.getAll().filter((c) => c.value === '' && c.maxAge === 0);
        expect(cleared.map((c) => c.name).sort()).toEqual([
            '__Host-ezil-os-auth.0',
            '__Host-ezil-os-auth.1',
            'sb-btgqfmnzycdecmeyqubx-auth-token',
        ]);
        // A __Host- cookie can only be overwritten by a Secure one at Path=/.
        for (const c of cleared.filter((c) => c.name.startsWith('__Host-'))) {
            expect(c.secure).toBe(true);
            expect(c.path).toBe('/');
        }
        // Unrelated cookies are left alone.
        expect(response.cookies.get('theme')).toBeUndefined();
    });

    it('exports no GET: an <img src> must not be able to sign anyone out', async () => {
        const route = await import('./route');
        expect('GET' in route).toBe(false);
    });
});

describe('Auth0 sign-out', () => {
    it('ends Supabase locally before redirecting through the fixed OIDC logout endpoint', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', 'test-client'); vi.stubEnv('AUTH0_SECRET_ID', 'private-secret');
        stub.scopes = []; stub.error = null;
        const response = await POST(signOutRequest());
        const url = new URL(response.headers.get('location')!);
        expect(response.status).toBe(303);
        expect(stub.scopes).toEqual(['local']);
        expect(url.origin + url.pathname).toBe('https://id.ezil.work/oidc/logout');
        expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'test-client', post_logout_redirect_uri: `${ORIGIN}/login` });
        expect(url.toString()).not.toContain('private-secret');
    });
    it('still logs out of Auth0 and clears cookies without logging provider details on Supabase error', async () => {
        vi.stubEnv('AUTH0_CLIENT_ID', 'test-client'); vi.stubEnv('AUTH0_SECRET_ID', 'private-secret');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        stub.error = { message: 'private-secret private-user@example.com' };
        const response = await POST(signOutRequest('__Host-ezil-os-auth=token'));
        expect(new URL(response.headers.get('location')!).pathname).toBe('/oidc/logout');
        expect(response.cookies.get('__Host-ezil-os-auth')?.maxAge).toBe(0);
        expect(JSON.stringify(warn.mock.calls)).not.toContain('private-');
        warn.mockRestore();
    });
});

describe('signout AI revocation', () => {
    it.each(['success', 'error', 'throw'])('deletes every owned computer before Supabase signOut (%s)', async (outcome) => {
        stub.error = outcome === 'error' ? { message: 'offline' } : null;
        stub.throws = outcome === 'throw';
        const response = await POST(signOutRequest('__Host-ezil-os-auth=opaque'));
        expect(response.status).toBe(303);
        expect(stub.order).toEqual(['delete', 'delete', 'signout']);
        expect(fetch).toHaveBeenCalledTimes(2);
        for (const id of COMPUTERS) {
            expect(fetch).toHaveBeenCalledWith(`https://worker.invalid/sandbox/${deriveGuacamoleSandboxId(USER, id)}/ai-credential`, expect.objectContaining({ method: 'DELETE' }));
        }
        const query = new PgDialect().sqlToQuery(stub.list.mock.calls[0]![0].where);
        expect(query.params).toEqual([USER]);
        expect(query.sql).toContain('user_id');
        if (outcome !== 'success') expect(response.cookies.get('__Host-ezil-os-auth')?.maxAge).toBe(0);
    });

    it('continues when the database or identity lookup fails', async () => {
        stub.list.mockRejectedValue(new Error('database unavailable'));
        expect((await POST(signOutRequest())).status).toBe(303);
        expect(fetch).not.toHaveBeenCalled();
        stub.getUser.mockRejectedValue(new Error('auth unavailable'));
        expect((await POST(signOutRequest())).status).toBe(303);
    });

    it('continues at the total deadline when deletion never settles', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', vi.fn(async () => new Promise<Response>(() => {})));
        const result = POST(signOutRequest());
        await vi.advanceTimersByTimeAsync(AI_LOGOUT_TIMEOUT_MS);
        expect((await result).status).toBe(303);
        expect(fetch).toHaveBeenCalledTimes(2);
        expect(stub.order).toContain('signout');
    });
});

describe('signout clears the retained EZiL ID token', () => {
    it('before the AI revocation and the Supabase signOut', async () => {
        await POST(signOutRequest());
        expect(stub.identityAt).toEqual([0]);
        expect(stub.order).toEqual(['delete', 'delete', 'signout']);
    });
    it('a failure to clear it never blocks the sign-out', async () => {
        stub.identityThrows = true;
        const response = await POST(signOutRequest());
        expect(response.status).toBe(303);
        expect(stub.order).toContain('signout');
    });
});

describe('/login "Sign out and use another account" (auth recovery)', () => {
    const decode = (value: string | undefined) => Buffer.from(value ?? '', 'base64url').toString('utf8');
    function formRequest(fields: [string, string][], cookie = '') {
        return new NextRequest(`${ORIGIN}/auth/signout`, {
            method: 'POST',
            headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}) },
            body: new URLSearchParams(fields).toString(),
        });
    }
    const auth0 = () => { vi.stubEnv('AUTH0_CLIENT_ID', 'test-client'); vi.stubEnv('AUTH0_SECRET_ID', 'private-secret'); };

    it('🔴 with no OS session cookie: still leaves id.ezil.work through the unchanged logout URL and keeps the page in a host-only cookie', async () => {
        auth0();
        stub.getUser.mockResolvedValue({ data: { user: null } });
        const response = await POST(formRequest([['returnUrl', '/app/browser']]));
        expect(response.status).toBe(303);
        const url = new URL(response.headers.get('location')!);
        expect(url.origin + url.pathname).toBe('https://id.ezil.work/oidc/logout');
        // Exactly the registered post-logout URL: nothing rides on it.
        expect(Object.fromEntries(url.searchParams)).toEqual({ client_id: 'test-client', post_logout_redirect_uri: `${ORIGIN}/login` });
        const kept = response.cookies.get('__Host-ezil-login-return');
        expect(kept).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 });
        expect(decode(kept?.value)).toBe('/app/browser');
        expect(fetch).not.toHaveBeenCalled();
        expect(stub.identityAt).toEqual([0]);
    });

    it('🔴 a Supabase client that cannot be built never traps the person: logout, cookies expired by hand, page kept', async () => {
        auth0();
        stub.createThrows = true;
        const response = await POST(formRequest([['returnUrl', '/app/browser']], '__Host-ezil-os-auth=stale; theme=dark'));
        expect(response.status).toBe(303);
        expect(new URL(response.headers.get('location')!).pathname).toBe('/oidc/logout');
        expect(response.cookies.get('__Host-ezil-os-auth')).toMatchObject({ value: '', maxAge: 0, secure: true, path: '/' });
        expect(response.cookies.get('theme')).toBeUndefined();
        expect(decode(response.cookies.get('__Host-ezil-login-return')?.value)).toBe('/app/browser');
        expect(stub.order).toEqual([]);
        expect(stub.identityAt).toEqual([0]);
    });

    it('expires an abandoned sign-in transaction, and only when one is present', async () => {
        auth0();
        const withTx = await POST(formRequest([['returnUrl', '/os']], '__Host-ezil-auth0=abandoned'));
        expect(withTx.cookies.get('__Host-ezil-auth0')).toMatchObject({ value: '', maxAge: 0, secure: true, httpOnly: true, path: '/' });
        const without = await POST(formRequest([['returnUrl', '/os']]));
        expect(without.cookies.get('__Host-ezil-auth0')).toBeUndefined();
    });

    it.each([
        ['https://evil.example/', '/computers'], ['//evil.example', '/computers'], ['/\\evil.example', '/computers'],
        ['%2F%2Fevil.example', '/computers'], ['/app/%2e%2e/admin', '/os'], ['/app/browser?x=1#frag', '/app/browser?x=1#frag'],
        ['javascript:alert(1)', '/computers'], ['/os\nSet-Cookie: x=y', '/computers'],
    ])('narrows the field %j to %j before keeping it', async (field, kept) => {
        auth0();
        const response = await POST(formRequest([['returnUrl', field]]));
        expect(decode(response.cookies.get('__Host-ezil-login-return')?.value)).toBe(kept);
        expect(response.headers.get('location')).not.toContain('evil');
    });

    it('a repeated field counts by its first value only', async () => {
        auth0();
        const response = await POST(formRequest([['returnUrl', '/app/browser'], ['returnUrl', 'https://evil.example/']]));
        expect(decode(response.cookies.get('__Host-ezil-login-return')?.value)).toBe('/app/browser');
    });

    it('an over-long destination is dropped, never truncated', async () => {
        auth0();
        const response = await POST(formRequest([['returnUrl', `/os?x=${'a'.repeat(2100)}`]]));
        expect(response.status).toBe(303);
        expect(response.cookies.get('__Host-ezil-login-return')).toBeUndefined();
    });

    it("the shell's body-less sign-out is unchanged: no kept page", async () => {
        auth0();
        const response = await POST(signOutRequest());
        expect(response.cookies.get('__Host-ezil-login-return')).toBeUndefined();
        const empty = await POST(formRequest([['returnUrl', '']]));
        expect(empty.cookies.get('__Host-ezil-login-return')).toBeUndefined();
    });

    it('without Auth0 the narrowed page rides on /login itself and no cookie is set', async () => {
        const response = await POST(formRequest([['returnUrl', '//evil.example']]));
        expect(response.headers.get('location')).toBe(`${ORIGIN}/login?returnUrl=%2Fcomputers`);
        const fine = await POST(formRequest([['returnUrl', '/app/browser']]));
        expect(fine.headers.get('location')).toBe(`${ORIGIN}/login?returnUrl=%2Fapp%2Fbrowser`);
        expect(fine.cookies.get('__Host-ezil-login-return')).toBeUndefined();
    });
});
