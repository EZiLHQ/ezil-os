import { createHmac, hkdfSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({ set: vi.fn(), exchangeCode: vi.fn(), verifyIdToken: vi.fn(), bridge: vi.fn(), retain: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: stub.set }) }));
vi.mock('@/server/auth/auth0', async importOriginal => ({ ...await importOriginal<typeof import('@/server/auth/auth0')>(), exchangeCode: stub.exchangeCode, verifyIdToken: stub.verifyIdToken }));
vi.mock('@/server/auth/bridge', () => ({ bridgeAuth0Identity: stub.bridge }));
vi.mock('@/server/auth/retained-identity', () => ({ retainProjectIdentity: stub.retain }));

import { AUTH0_COOKIE, Auth0Error, buildAuthorizeUrl } from '@/server/auth/auth0';
import { GET } from './route';
const origin = 'https://os-staging.ezil.work';
let cookie: string;
let state: string;
let tx: { codeVerifier: string; nonce: string };
const secret = 'test-secret-not-for-urls';

beforeEach(async () => {
    vi.resetAllMocks();
    vi.stubEnv('AUTH0_CLIENT_ID', 'client'); vi.stubEnv('AUTH0_SECRET_ID', secret);
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network call'); }));
    stub.exchangeCode.mockResolvedValue('private-id-token');
    stub.verifyIdToken.mockResolvedValue({ sub: 'auth0|one', email: 'private@example.com' });
    const url = await buildAuthorizeUrl({ origin, returnUrl: '/os?computer=one' });
    state = url.searchParams.get('state')!;
    cookie = stub.set.mock.calls[0][1];
    tx = JSON.parse(Buffer.from(cookie.split('.')[0], 'base64url').toString());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function request(query: Record<string, string> = {}, cookieValue: string | null = cookie) {
    return new NextRequest(`${origin}/auth/auth0/callback?${new URLSearchParams({ state, code: 'private-code', ...query })}`, { headers: cookieValue === null ? {} : { cookie: `${AUTH0_COOKIE}=${cookieValue}` } });
}
function expectCleared(response: Awaited<ReturnType<typeof GET>>) {
    expect(response.cookies.get(AUTH0_COOKIE)).toMatchObject({ value: '', maxAge: 0, secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
}

describe('Auth0 callback', () => {
    it('validates the transaction and token before bridging, then performs a document redirect', async () => {
        const response = await GET(request());
        expect(response.headers.get('location')).toBe(`${origin}/os?computer=one`);
        expect(stub.exchangeCode).toHaveBeenCalledWith('private-code', { origin, codeVerifier: tx.codeVerifier });
        expect(stub.verifyIdToken).toHaveBeenCalledWith('private-id-token', { nonce: tx.nonce });
        expect(stub.bridge).toHaveBeenCalledWith({ sub: 'auth0|one', email: 'private@example.com' });
        expect(stub.verifyIdToken.mock.invocationCallOrder[0]).toBeLessThan(stub.bridge.mock.invocationCallOrder[0]);
        expectCleared(response);
    });
    it.each(['missing_cookie', 'tampered_cookie', 'expired_cookie', 'state_mismatch', 'missing_state', 'missing_code', 'provider_error', 'disabled'])('refuses %s before exchanging any code', async failure => {
        let query = {}; let value: string | null = cookie;
        if (failure === 'missing_cookie') value = null;
        if (failure === 'tampered_cookie') value = `${cookie}!`;
        if (failure === 'expired_cookie') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 600_001); }
        if (failure === 'state_mismatch') query = { state: 'other' };
        if (failure === 'missing_state') query = { state: '' };
        if (failure === 'missing_code') query = { code: '' };
        if (failure === 'provider_error') query = { error: secret, error_description: 'private@example.com' };
        if (failure === 'disabled') vi.stubEnv('AUTH0_CLIENT_ID', '');
        const response = await GET(request(query, value));
        expect(response.headers.get('location')).toMatch(new RegExp(`^${origin}/login\\?error=(invalid_transaction|state_mismatch|auth0_failed|auth0_disabled)$`));
        expect(stub.exchangeCode).not.toHaveBeenCalled();
        expect(stub.verifyIdToken).not.toHaveBeenCalled();
        expect(stub.bridge).not.toHaveBeenCalled();
        expectCleared(response);
    });
    it.each(['exchangeCode', 'verifyIdToken', 'bridge'] as const)('never logs or redirects private details from %s failures', async method => {
        const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
        stub[method].mockRejectedValue(new Error(`${secret} private-code private-id-token private@example.com`));
        const response = await GET(request());
        expect(response.headers.get('location')).toBe(`${origin}/login?error=auth0_failed`);
        // Only the fixed failure code may be logged; never provider text, tokens or user data.
        expect(logs[0]).not.toHaveBeenCalled();
        expect(logs[2]).not.toHaveBeenCalled();
        expect(logs[1].mock.calls).toEqual([['[auth0] callback failed', { code: 'auth0_failed' }]]);
        if (method !== 'bridge') expect(stub.bridge).not.toHaveBeenCalled();
        expectCleared(response);
    });
    it('reports an account conflict using only its fixed error code', async () => {
        stub.bridge.mockRejectedValue(new Auth0Error('account_conflict'));
        const response = await GET(request());
        expect(response.headers.get('location')).toBe(`${origin}/login?error=account_conflict`);
        expectCleared(response);
    });
    it('sanitises even a correctly signed cookie destination at the final redirect', async () => {
        const value = JSON.parse(Buffer.from(cookie.split('.')[0], 'base64url').toString());
        const payload = Buffer.from(JSON.stringify({ ...value, returnUrl: '//evil.example' })).toString('base64url');
        const key = Buffer.from(hkdfSync('sha256', secret, 'https://id.ezil.work/', 'ezil/auth0/transaction/v1', 32));
        const mac = createHmac('sha256', key).update(payload).digest('base64url');
        const response = await GET(request({}, `${payload}.${mac}`));
        expect(response.headers.get('location')).toBe(`${origin}/computers`);
        expect(stub.bridge).toHaveBeenCalledOnce();
    });
    it('never redirects to a supplied foreign returnUrl', async () => {
        stub.set.mockClear();
        const url = await buildAuthorizeUrl({ origin, returnUrl: '//evil.example' });
        state = url.searchParams.get('state')!; cookie = stub.set.mock.calls[0][1];
        const response = await GET(request({ returnUrl: '//also-evil.example' }));
        expect(response.headers.get('location')).toBe(`${origin}/computers`);
    });
});

describe('Auth0 callback retains the verified ID token for EZiL Works', () => {
    it('retains the exact token only after the bridge minted the session it is bound to', async () => {
        const response = await GET(request());
        expect(stub.retain).toHaveBeenCalledWith('private-id-token');
        expect(stub.bridge.mock.invocationCallOrder[0]).toBeLessThan(stub.retain.mock.invocationCallOrder[0]);
        expect(response.headers.get('location')).toBe(`${origin}/os?computer=one`);
        expectCleared(response);
    });
    it('a retention failure never fails the sign-in and logs only a fixed line', async () => {
        const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
        stub.retain.mockRejectedValue(new Error('private-id-token vault full'));
        const response = await GET(request());
        expect(response.headers.get('location')).toBe(`${origin}/os?computer=one`);
        expect(logs[1].mock.calls).toEqual([['[auth0] identity not retained']]);
        expect(logs[0]).not.toHaveBeenCalled(); expect(logs[2]).not.toHaveBeenCalled();
    });
    it.each(['exchangeCode', 'verifyIdToken', 'bridge'] as const)('retains nothing when %s fails', async method => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stub[method].mockRejectedValue(new Error('refused'));
        await GET(request());
        expect(stub.retain).not.toHaveBeenCalled();
    });
});

describe('Auth0 callback after a silent (prompt=none) attempt', () => {
    async function silentRequest(query: Record<string, string>) {
        stub.set.mockClear();
        const url = await buildAuthorizeUrl({ origin, returnUrl: '/app/code?project=p&repo=r', prompt: 'none' });
        expect(url.searchParams.get('prompt')).toBe('none');
        const silentState = url.searchParams.get('state')!;
        const silentCookie = stub.set.mock.calls[0][1];
        return new NextRequest(`${origin}/auth/auth0/callback?${new URLSearchParams({ state: silentState, ...query })}`, { headers: { cookie: `${AUTH0_COOKIE}=${silentCookie}` } });
    }
    it.each(['login_required', 'interaction_required', 'consent_required'])('%s falls back to ONE interactive sign-in for the same page', async error => {
        const response = await GET(await silentRequest({ error }));
        const location = new URL(response.headers.get('location')!);
        expect(location.origin + location.pathname).toBe(`${origin}/auth/auth0/login`);
        expect([...location.searchParams.keys()]).toEqual(['returnUrl']);
        expect(location.searchParams.get('returnUrl')).toBe('/app/code?project=p&repo=r');
        expect(stub.exchangeCode).not.toHaveBeenCalled();
        expect(stub.retain).not.toHaveBeenCalled();
        expectCleared(response);
    });
    it('any other provider error after a silent attempt is still the plain refusal', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const response = await GET(await silentRequest({ error: 'access_denied' }));
        expect(response.headers.get('location')).toBe(`${origin}/login?error=auth0_failed`);
    });
    it('a silent success retains the token like an interactive one', async () => {
        const response = await GET(await silentRequest({ code: 'private-code' }));
        expect(response.headers.get('location')).toBe(`${origin}/app/code?project=p&repo=r`);
        expect(stub.retain).toHaveBeenCalledWith('private-id-token');
    });
    it('an interactive transaction never takes the silent fallback', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const response = await GET(request({ error: 'login_required', code: '' }));
        expect(response.headers.get('location')).toBe(`${origin}/login?error=auth0_failed`);
    });
});
