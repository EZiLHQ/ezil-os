/**
 * `POST /auth/signout`. The Supabase client is stubbed at the module boundary,
 * as in `../confirm/confirm-route.test.ts`, so these prove control flow — the
 * status, the destination and which cookies are expired by hand — not that
 * Supabase's own cookie writes land on the response.
 */
import { describe, expect, it, vi } from 'vitest';

const stub = vi.hoisted(() => ({
    scopes: [] as (string | undefined)[],
    error: null as { message: string } | null,
}));

vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({
        auth: {
            signOut: async (options?: { scope?: string }) => {
                stub.scopes.push(options?.scope);
                return { error: stub.error };
            },
        },
    }),
}));

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
