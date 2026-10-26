vi.mock('@/server/project-repositories/session', () => ({ clearProjectIdentity: vi.fn(async () => {}) }));
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
}));

vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({
        auth: {
            getUser: () => stub.getUser(),
            signOut: async (options?: { scope?: string }) => {
                stub.order.push('signout');
                if (stub.throws) throw new Error('offline');
                stub.scopes.push(options?.scope);
                return { error: stub.error };
            },
        },
    }),
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
