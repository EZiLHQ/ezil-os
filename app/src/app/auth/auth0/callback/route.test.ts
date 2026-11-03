import { createHmac, hkdfSync } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({ set: vi.fn(), exchangeCode: vi.fn(), verifyIdToken: vi.fn(), bridge: vi.fn(), refuseSwitch: vi.fn(), retain: vi.fn(), getUser: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: stub.set }) }));
vi.mock('@/server/auth/auth0', async importOriginal => ({ ...await importOriginal<typeof import('@/server/auth/auth0')>(), exchangeCode: stub.exchangeCode, verifyIdToken: stub.verifyIdToken }));
vi.mock('@/server/auth/bridge', () => ({ bridgeAuth0Identity: stub.bridge, refuseSilentAccountSwitch: stub.refuseSwitch }));
vi.mock('@/server/auth/retained-identity', () => ({ retainProjectIdentity: stub.retain }));
// The OS session, asked only on a replayed or lost transaction. None by default.
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: stub.getUser } }) }));

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
    stub.getUser.mockResolvedValue({ data: { user: null }, error: null });
    const url = await buildAuthorizeUrl({ origin, returnUrl: '/os?computer=one' });
    state = url.searchParams.get('state')!;
    cookie = stub.set.mock.calls[0][1];
    tx = JSON.parse(Buffer.from(cookie.split('.')[0], 'base64url').toString());
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
function request(query: Record<string, string> = {}, cookieValue: string | null = cookie) {
    return new NextRequest(`${origin}/auth/auth0/callback?${new URLSearchParams({ state, code: 'private-code', ...query })}`, { headers: cookieValue === null ? {} : { cookie: `${AUTH0_COOKIE}=${cookieValue}` } });
}
/** `/login` after a failure; `returnUrl` only when a signed transaction vouched for it, narrowed. */
function failed(code: string, returnUrl?: string) {
    return `${origin}/login?${new URLSearchParams({ error: code, ...(returnUrl === undefined ? {} : { returnUrl }) })}`;
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
        if (failure === 'missing_code' || failure === 'provider_error') {
            // The signed transaction was read before the refusal: back to sign-in, still headed for its page.
            expect(response.headers.get('location')).toBe(failed('auth0_failed', '/os?computer=one'));
        } else {
            // Nothing vouched for a destination, so none is kept.
            expect(response.headers.get('location')).toMatch(new RegExp(`^${origin}/login\\?error=(invalid_transaction|state_mismatch|auth0_disabled)$`));
        }
        expect(stub.exchangeCode).not.toHaveBeenCalled();
        expect(stub.verifyIdToken).not.toHaveBeenCalled();
        expect(stub.bridge).not.toHaveBeenCalled();
        expectCleared(response);
    });
    it.each(['exchangeCode', 'verifyIdToken', 'bridge'] as const)('never logs or redirects private details from %s failures', async method => {
        const logs = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}), vi.spyOn(console, 'error').mockImplementation(() => {})];
        stub[method].mockRejectedValue(new Error(`${secret} private-code private-id-token private@example.com`));
        const response = await GET(request());
        expect(response.headers.get('location')).toBe(failed('auth0_failed', '/os?computer=one'));
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
        expect(response.headers.get('location')).toBe(failed('account_conflict', '/os?computer=one'));
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

describe('Auth0 callback retains the verified ID token for Universe', () => {
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
        expect(response.headers.get('location')).toBe(failed('auth0_failed', '/app/code?project=p&repo=r'));
    });
    it('a silent success retains the token like an interactive one', async () => {
        const response = await GET(await silentRequest({ code: 'private-code' }));
        expect(response.headers.get('location')).toBe(`${origin}/app/code?project=p&repo=r`);
        expect(stub.retain).toHaveBeenCalledWith('private-id-token');
    });
    it('🔴 a silent success first checks it is the signed-in account, BEFORE the bridge replaces the session (review #3)', async () => {
        await GET(await silentRequest({ code: 'private-code' }));
        expect(stub.refuseSwitch).toHaveBeenCalledWith({ sub: 'auth0|one', email: 'private@example.com' });
        expect(stub.verifyIdToken.mock.invocationCallOrder[0]).toBeLessThan(stub.refuseSwitch.mock.invocationCallOrder[0]);
        expect(stub.refuseSwitch.mock.invocationCallOrder[0]).toBeLessThan(stub.bridge.mock.invocationCallOrder[0]);
    });
    it('🔴 a silent sign-in into another account is account_conflict: no bridge, no retained token, the tab stays signed in as before', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stub.refuseSwitch.mockRejectedValue(new Auth0Error('account_conflict'));
        const response = await GET(await silentRequest({ code: 'private-code' }));
        expect(response.headers.get('location')).toBe(failed('account_conflict', '/app/code?project=p&repo=r'));
        expect(stub.bridge).not.toHaveBeenCalled();
        expect(stub.retain).not.toHaveBeenCalled();
        expectCleared(response);
    });
    it('an interactive sign-in is the person choosing an account: no switch check', async () => {
        await GET(request());
        expect(stub.refuseSwitch).not.toHaveBeenCalled();
        expect(stub.bridge).toHaveBeenCalledOnce();
    });
    it('an interactive transaction never takes the silent fallback', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const response = await GET(request({ error: 'login_required', code: '' }));
        expect(response.headers.get('location')).toBe(failed('auth0_failed', '/os?computer=one'));
    });
});

describe('Auth0 callback failure keeps only a vouched-for destination (auth recovery)', () => {
    async function transactionFor(returnUrl: string) {
        stub.set.mockClear();
        const url = await buildAuthorizeUrl({ origin, returnUrl });
        state = url.searchParams.get('state')!; cookie = stub.set.mock.calls[0][1];
    }
    beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    it('🔴 an unverified email is refused (no bridge, no session, no retained token) and the sign-in page keeps /app/browser', async () => {
        await transactionFor('/app/browser');
        stub.verifyIdToken.mockRejectedValue(new Auth0Error('email_unverified'));
        const response = await GET(request());
        expect(response.headers.get('location')).toBe(failed('email_unverified', '/app/browser'));
        expect(stub.bridge).not.toHaveBeenCalled();
        expect(stub.retain).not.toHaveBeenCalled();
        expect(response.headers.get('location')).not.toContain('private');
        expectCleared(response);
    });
    it('a verified retry of the same page lands on it', async () => {
        await transactionFor('/app/browser');
        const response = await GET(request());
        expect(response.headers.get('location')).toBe(`${origin}/app/browser`);
        expect(stub.bridge).toHaveBeenCalledOnce();
    });
    it('a cancelled sign-in (access_denied) keeps the page, query and hash included', async () => {
        await transactionFor('/app/code?project=p&repo=r&path=src/main.ts#L4');
        const response = await GET(request({ error: 'access_denied', code: '' }));
        expect(response.headers.get('location')).toBe(failed('auth0_failed', '/app/code?project=p&repo=r&path=src/main.ts#L4'));
        expect(stub.exchangeCode).not.toHaveBeenCalled();
    });
    it.each(['//evil.example', 'https://evil.example/', '/\\evil.example', '/app/%2e%2e/admin', '/os\tx'])(
        'a signed transaction carrying %j is narrowed again on the failure path', async hostile => {
            const value = JSON.parse(Buffer.from(cookie.split('.')[0], 'base64url').toString());
            const payload = Buffer.from(JSON.stringify({ ...value, returnUrl: hostile })).toString('base64url');
            const key = Buffer.from(hkdfSync('sha256', secret, 'https://id.ezil.work/', 'ezil/auth0/transaction/v1', 32));
            stub.verifyIdToken.mockRejectedValue(new Auth0Error('email_unverified'));
            const response = await GET(request({}, `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`));
            const location = new URL(response.headers.get('location')!);
            expect(location.origin + location.pathname).toBe(`${origin}/login`);
            expect(['/computers', '/os']).toContain(location.searchParams.get('returnUrl'));
            expect(response.headers.get('location')).not.toContain('evil');
        },
    );
    it.each(['missing_cookie', 'expired_cookie', 'state_mismatch'])('🔴 %s: the callback query never supplies a destination', async failure => {
        let value: string | null = cookie; let query: Record<string, string> = { returnUrl: '/app/browser' };
        if (failure === 'missing_cookie') value = null;
        if (failure === 'expired_cookie') { vi.useFakeTimers(); vi.setSystemTime(Date.now() + 600_001); }
        if (failure === 'state_mismatch') query = { ...query, state: 'other' };
        const response = await GET(request(query, value));
        expect(new URL(response.headers.get('location')!).searchParams.has('returnUrl')).toBe(false);
    });
    it('a successful sign-in spends the page a sign-out kept; a failed one keeps it for the retry', async () => {
        const KEPT = '__Host-ezil-login-return';
        const withKept = (query: Record<string, string> = {}) => new NextRequest(
            `${origin}/auth/auth0/callback?${new URLSearchParams({ state, code: 'private-code', ...query })}`,
            { headers: { cookie: `${AUTH0_COOKIE}=${cookie}; ${KEPT}=L2FwcC9icm93c2Vy` } });
        const ok = await GET(withKept());
        expect(ok.headers.get('location')).toBe(`${origin}/os?computer=one`);
        expect(ok.cookies.get(KEPT)).toMatchObject({ value: '', maxAge: 0, secure: true, httpOnly: true, sameSite: 'lax', path: '/' });
        stub.verifyIdToken.mockRejectedValue(new Auth0Error('email_unverified'));
        expect((await GET(withKept())).cookies.get(KEPT)).toBeUndefined();
        expect((await GET(withKept({ error: 'access_denied', code: '' }))).cookies.get(KEPT)).toBeUndefined();
        stub.verifyIdToken.mockResolvedValue({ sub: 'auth0|one', email: 'private@example.com' });
        // Nothing to spend: nothing is set.
        expect((await GET(request())).cookies.get(KEPT)).toBeUndefined();
    });
    it('a transaction-backed failure ignores a returnUrl in the callback query', async () => {
        stub.verifyIdToken.mockRejectedValue(new Auth0Error('email_unverified'));
        const response = await GET(request({ returnUrl: '/app/settings' }));
        expect(response.headers.get('location')).toBe(failed('email_unverified', '/os?computer=one'));
    });
});

describe('Auth0 callback: Back after a successful sign-in (fd0 QA-SH-1)', () => {
    const signedIn = () => stub.getUser.mockResolvedValue({ data: { user: { id: 'abcdef01-2345-6789-abcd-ef0123456789' } }, error: null });
    beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); });
    it.each([
        ['the spent transaction is gone', () => ({ query: {}, value: null as string | null })],
        ['another tab holds the transaction', () => ({ query: { state: 'replayed-state' }, value: cookie as string | null })],
    ])('🔴 %s and the person is still signed in: back into the OS, the replayed code never used', async (_label, setup) => {
        signedIn();
        const { query, value } = setup();
        const response = await GET(request({ code: 'replayed-code', ...query }, value));
        expect(response.headers.get('location')).toBe(`${origin}/os`);
        expect(stub.exchangeCode).not.toHaveBeenCalled();
        expect(stub.bridge).not.toHaveBeenCalled();
        expect(stub.retain).not.toHaveBeenCalled();
        expectCleared(response);
    });
    it('without a session it is still the plain refusal, and an unreadable session counts as none', async () => {
        expect((await GET(request({ code: 'replayed-code' }, null))).headers.get('location')).toBe(failed('invalid_transaction'));
        stub.getUser.mockResolvedValue({ data: { user: { id: 'x' } }, error: { message: 'jwt expired' } });
        expect((await GET(request({ code: 'replayed-code' }, null))).headers.get('location')).toBe(failed('invalid_transaction'));
        stub.getUser.mockRejectedValue(new Error('auth unreachable'));
        expect((await GET(request({ code: 'replayed-code' }, null))).headers.get('location')).toBe(failed('invalid_transaction'));
    });
    it('a refusal with a valid transaction is never turned into a pass, signed in or not', async () => {
        signedIn();
        stub.verifyIdToken.mockRejectedValue(new Auth0Error('email_unverified'));
        expect((await GET(request())).headers.get('location')).toBe(failed('email_unverified', '/os?computer=one'));
        expect((await GET(request({ error: 'access_denied', code: '' }))).headers.get('location')).toBe(failed('auth0_failed', '/os?computer=one'));
    });
    it('the session is only asked on a replayed or lost transaction', async () => {
        signedIn();
        await GET(request());
        vi.stubEnv('AUTH0_CLIENT_ID', '');
        expect((await GET(request())).headers.get('location')).toBe(failed('auth0_disabled'));
        expect(stub.getUser).not.toHaveBeenCalled();
    });
});
