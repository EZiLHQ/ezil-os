import { afterEach, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const jar = vi.hoisted(() => ({ getAll: vi.fn(() => []), set: vi.fn() }));
const admin = vi.hoisted(() => ({ listUsers: vi.fn(), generateLink: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar, headers: async () => new Headers({ 'x-forwarded-proto': 'https' }) }));
vi.mock('@/env', () => ({ env: { NEXT_PUBLIC_SUPABASE_URL: 'https://supabase.example', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'test-anon-key' } }));
vi.mock('./supabase-admin', () => ({ createAdminClient: () => ({ auth: { admin } }) }));

import { bridgeAuth0Identity } from './bridge';

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('redeems the generated hash through the real SSR adapter and writes the existing Supabase session cookie', async () => {
    const user = { id: '00000000-0000-4000-8000-000000000001', email: 'test@example.com', app_metadata: { auth0_sub: 'auth0|one' }, user_metadata: {}, aud: 'authenticated', created_at: new Date().toISOString() };
    const expiry = Math.floor(Date.now() / 1000) + 3600;
    const encode = (data: unknown) => Buffer.from(JSON.stringify(data)).toString('base64url');
    const accessToken = `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ sub: user.id, exp: expiry })}.test-signature`;
    admin.listUsers.mockResolvedValue({ data: { users: [user] }, error: null });
    admin.generateLink.mockResolvedValue({ data: { user, properties: { hashed_token: 'private-hash' } }, error: null });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(String(input)).toBe('https://supabase.example/auth/v1/verify');
        expect(JSON.parse(String(init?.body))).toMatchObject({ token_hash: 'private-hash', type: 'magiclink' });
        return Response.json({ access_token: accessToken, refresh_token: 'private-refresh', token_type: 'bearer', expires_in: 3600, expires_at: expiry, user });
    });
    vi.stubGlobal('fetch', fetchMock);
    await bridgeAuth0Identity({ sub: 'auth0|one', email: user.email });
    expect(fetchMock).toHaveBeenCalledOnce();
    const writes = jar.set.mock.calls as unknown as [string, string, Record<string, unknown>][];
    expect(writes.length).toBeGreaterThan(0);
    expect(writes[0][0]).toBe('__Host-ezil-os-auth');
    expect(writes[0][1].length).toBeGreaterThan(0);
    expect(writes[0][2]).toMatchObject({ secure: true, path: '/', sameSite: 'lax' });
});
