/**
 * The retained EZiL ID token (identity part of 1ac89c72): only an opaque handle reaches the browser, the entry is
 * bound to the Supabase user AND session, it is re-verified on use, and sign-out deletes it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const mocks = vi.hoisted(() => ({
    jar: new Map<string, { value: string; options?: Record<string, unknown> }>(),
    claims: { sub: 'os-user', session_id: 'session-a' } as Record<string, unknown> | null,
    verify: vi.fn(),
}));
vi.mock('next/headers', () => ({ cookies: async () => ({
    get: (k: string) => mocks.jar.get(k),
    set: (k: string, value: string, options?: Record<string, unknown>) => mocks.jar.set(k, { value, options }),
}) }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getClaims: async () => ({ data: mocks.claims ? { claims: mocks.claims } : null, error: null }) } }) }));
vi.mock('./auth0', async importOriginal => ({ ...await importOriginal<typeof import('./auth0')>(), verifyProjectIdToken: mocks.verify }));

import { clearProjectIdentity, IDENTITY_COOKIE, IdentityRefreshRequired, identities, retainedIdentity, retainProjectIdentity } from './retained-identity';
import { Vault } from './vault';

const TOKEN = 'eyJ.private-id-token.sig';
const verified = (expiresAt = Date.now() + 3_600_000) => ({ issuer: 'https://id.ezil.work/', subject: 'auth0|a', expiresAt });

beforeEach(() => {
    mocks.jar.clear();
    mocks.claims = { sub: 'os-user', session_id: 'session-a' };
    mocks.verify.mockReset().mockResolvedValue(verified());
});
afterEach(() => { vi.useRealTimers(); });

describe('retained EZiL ID token', () => {
    it('gives the browser only an opaque httpOnly handle that expires with the token', async () => {
        const expiresAt = Date.now() + 3_600_000;
        mocks.verify.mockResolvedValue(verified(expiresAt));
        await retainProjectIdentity(TOKEN);
        const cookie = mocks.jar.get(IDENTITY_COOKIE)!;
        expect(cookie.value).toMatch(/^[\w-]{43}$/);
        expect(JSON.stringify([...mocks.jar.entries()])).not.toContain('private-id-token');
        expect(cookie.options).toMatchObject({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', expires: new Date(expiresAt) });
        expect(await retainedIdentity('os-user')).toMatchObject({ token: TOKEN, subject: 'auth0|a', userId: 'os-user', sessionId: 'session-a' });
    });

    it('is bound to the Supabase session: another session or another user must refresh', async () => {
        await retainProjectIdentity(TOKEN);
        mocks.claims = { sub: 'os-user', session_id: 'session-b' };
        await expect(retainedIdentity('os-user')).rejects.toBeInstanceOf(IdentityRefreshRequired);
        mocks.claims = { sub: 'os-user', session_id: 'session-a' };
        await expect(retainedIdentity('someone-else')).rejects.toBeInstanceOf(IdentityRefreshRequired);
        mocks.claims = null;
        await expect(retainedIdentity('os-user')).rejects.toBeInstanceOf(IdentityRefreshRequired);
    });

    it('a missing cookie, an unknown handle (a restart) or a token about to expire must refresh', async () => {
        await expect(retainedIdentity('os-user')).rejects.toThrow('IDENTITY_REFRESH_REQUIRED');
        mocks.jar.set(IDENTITY_COOKIE, { value: 'a'.repeat(43) });
        await expect(retainedIdentity('os-user')).rejects.toThrow('IDENTITY_REFRESH_REQUIRED');
        mocks.verify.mockResolvedValue(verified(Date.now() + 30_000));
        await retainProjectIdentity(TOKEN);
        await expect(retainedIdentity('os-user')).rejects.toThrow('IDENTITY_REFRESH_REQUIRED');
    });

    it('re-verifies on use: a token that no longer verifies, or names another subject, must refresh', async () => {
        await retainProjectIdentity(TOKEN);
        mocks.verify.mockRejectedValueOnce(new Error('invalid_id_token'));
        await expect(retainedIdentity('os-user')).rejects.toBeInstanceOf(IdentityRefreshRequired);
        mocks.verify.mockResolvedValueOnce({ ...verified(), subject: 'auth0|other' });
        await expect(retainedIdentity('os-user')).rejects.toBeInstanceOf(IdentityRefreshRequired);
        expect((await retainedIdentity('os-user')).subject).toBe('auth0|a');
    });

    it('a new sign-in replaces the earlier entry, and sign-out deletes it and expires the cookie', async () => {
        await retainProjectIdentity(TOKEN);
        const first = mocks.jar.get(IDENTITY_COOKIE)!.value;
        await retainProjectIdentity(TOKEN);
        expect(identities.get(first)).toBeUndefined();
        const second = mocks.jar.get(IDENTITY_COOKIE)!.value;
        await clearProjectIdentity();
        expect(identities.get(second)).toBeUndefined();
        expect(mocks.jar.get(IDENTITY_COOKIE)).toMatchObject({ value: '', options: { maxAge: 0 } });
        mocks.jar.set(IDENTITY_COOKIE, { value: second });
        await expect(retainedIdentity('os-user')).rejects.toBeInstanceOf(IdentityRefreshRequired);
    });

    it('refuses to retain an unverifiable token', async () => {
        mocks.verify.mockRejectedValue(new Error('invalid_id_token'));
        await expect(retainProjectIdentity(TOKEN)).rejects.toThrow();
        expect(mocks.jar.has(IDENTITY_COOKIE)).toBe(false);
    });
});

describe('Vault', () => {
    it('is bounded and drops expired entries', () => {
        const v = new Vault<string>(1);
        const h = v.put('secret', 200, 100);
        expect(() => v.put('second', 200, 100)).toThrow();
        expect(v.get(h, 150)).toBe('secret');
        expect(v.get(h, 200)).toBeUndefined();
        expect(() => v.put('expired', 100, 100)).toThrow();
        expect(v.get(v.put('later', 400, 200), 300)).toBe('later');
    });
});
