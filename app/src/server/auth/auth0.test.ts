import { createHash, createHmac, hkdfSync } from 'node:crypto';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const jar = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));

import { AUTH0_COOKIE, AUTH0_ISSUER, auth0Enabled, buildAuthorizeUrl, exchangeCode, readTransaction, verifyIdToken, verifyProjectIdToken } from './auth0';

const secret = 'test-client-secret-do-not-log';
const clientId = 'test-client';
let pair: CryptoKeyPair;
let jwk: JsonWebKey;
let kid = 0;
let fetchMock: ReturnType<typeof vi.fn>;
const now = Math.floor(Date.now() / 1000);
const baseClaims = () => ({ iss: AUTH0_ISSUER, aud: clientId, sub: 'auth0|one', email: 'test@example.com', email_verified: true, nonce: 'nonce', iat: now, exp: now + 300 });

async function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
    const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: String(kid), ...header })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ ...baseClaims(), ...claims })).toString('base64url');
    const data = `${head}.${body}`;
    const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(data));
    return `${data}.${Buffer.from(sig).toString('base64url')}`;
}

beforeAll(async () => {
    pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
});
beforeEach(() => {
    vi.stubEnv('AUTH0_CLIENT_ID', clientId);
    vi.stubEnv('AUTH0_SECRET_ID', secret);
    jar.set.mockClear();
    kid += 1;
    fetchMock = vi.fn(async () => Response.json({ keys: [{ ...jwk, kid: String(kid), alg: 'RS256', use: 'sig' }] }));
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function signed(value: unknown, rawKey = false) {
    const payload = Buffer.from(JSON.stringify(value)).toString('base64url');
    const key = rawKey ? secret : Buffer.from(hkdfSync('sha256', secret, AUTH0_ISSUER, 'ezil/auth0/transaction/v1', 32));
    return `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
}
async function start(returnUrl = '/os?computer=one') {
    const url = await buildAuthorizeUrl({ origin: 'https://os-staging.ezil.work', returnUrl });
    return { url, cookie: jar.set.mock.calls[0][1] as string, state: url.searchParams.get('state')! };
}

describe('Auth0 transaction', () => {
    it.each([['', ''], [clientId, ''], ['', secret], [' ', secret]])('is off unless both settings are present (%s)', (id, key) => {
        vi.stubEnv('AUTH0_CLIENT_ID', id); vi.stubEnv('AUTH0_SECRET_ID', key);
        expect(auth0Enabled()).toBe(false);
    });
    it('is enabled with both settings and refuses a disabled start without fetching', async () => {
        expect(auth0Enabled()).toBe(true);
        vi.stubEnv('AUTH0_SECRET_ID', '');
        await expect(start()).rejects.toMatchObject({ code: 'auth0_disabled' });
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('round-trips state, nonce and S256 PKCE in a secure ten-minute cookie', async () => {
        const { url, cookie, state } = await start();
        const tx = readTransaction(cookie, state);
        expect(url.origin + url.pathname).toBe(`${AUTH0_ISSUER}authorize`);
        expect(Object.fromEntries(url.searchParams)).toMatchObject({ client_id: clientId, response_type: 'code', scope: 'openid email profile', redirect_uri: 'https://os-staging.ezil.work/auth/auth0/callback', code_challenge_method: 'S256', nonce: tx.nonce });
        expect(url.searchParams.get('code_challenge')).toBe(createHash('sha256').update(tx.codeVerifier).digest('base64url'));
        expect(tx.returnUrl).toBe('/os?computer=one');
        expect(jar.set.mock.calls[0]).toEqual([AUTH0_COOKIE, cookie, expect.objectContaining({ httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600, expires: new Date(tx.expiresAt) })]);
        expect(url.toString()).not.toContain(secret);
        expect(url.toString()).not.toContain(tx.codeVerifier);
        const second = await start();
        expect(second.state).not.toBe(state);
        expect(second.url.searchParams.get('nonce')).not.toBe(tx.nonce);
        expect(second.url.searchParams.get('code_challenge')).not.toBe(url.searchParams.get('code_challenge'));
    });
    it.each(['https://evil.example', '//evil.example', '/\\evil.example', '/\nevil'])('sanitises returnUrl %j', async input => {
        const { cookie, state } = await start(input);
        expect(readTransaction(cookie, state).returnUrl).toBe('/computers');
    });
    it('refuses tampering, a raw-secret HMAC, malformed and missing cookies', async () => {
        const { cookie, state } = await start();
        const tx = readTransaction(cookie, state);
        for (const bad of [undefined, '', 'bad', `${cookie}.extra`, `${cookie.slice(0, -1)}!`, signed(tx, true), signed({ ...tx, returnUrl: 9 }), signed(null)]) {
            expect(() => readTransaction(bad, state)).toThrow('invalid_transaction');
        }
        const payload = Buffer.from(JSON.stringify({ ...tx, returnUrl: '/other' })).toString('base64url');
        expect(() => readTransaction(`${payload}.${cookie.split('.')[1]}`, state)).toThrow('invalid_transaction');
    });
    it('refuses expired cookies and mismatched or missing state', async () => {
        const { cookie, state } = await start();
        for (const wrong of [null, 'x', `${state.slice(0, -1)}!`]) expect(() => readTransaction(cookie, wrong)).toThrow('state_mismatch');
        vi.useFakeTimers(); vi.setSystemTime(Date.now() + 600_001);
        expect(() => readTransaction(cookie, state)).toThrow('invalid_transaction');
    });
    it('refuses oversized, future-dated and signed malformed transaction payloads', async () => {
        const { cookie, state } = await start();
        expect(() => readTransaction('x'.repeat(4097), state)).toThrow('invalid_transaction');
        const tx = readTransaction(cookie, state);
        expect(() => readTransaction(signed({ ...tx, expiresAt: Date.now() + 700_000 }), state)).toThrow('invalid_transaction');
        const payload = Buffer.from('not-json').toString('base64url');
        const key = Buffer.from(hkdfSync('sha256', secret, AUTH0_ISSUER, 'ezil/auth0/transaction/v1', 32));
        const mac = createHmac('sha256', key).update(payload).digest('base64url');
        expect(() => readTransaction(`${payload}.${mac}`, state)).toThrow('invalid_transaction');
    });
    it.each(['nonce', 'codeVerifier', 'state', 'expiresAt'])('refuses a signed transaction missing %s', async field => {
        const { cookie, state } = await start();
        const tx = { ...readTransaction(cookie, state) } as Record<string, unknown>;
        delete tx[field];
        expect(() => readTransaction(signed(tx), state)).toThrow('invalid_transaction');
    });
});

describe('ID token verification', () => {
    it('accepts a signed verified identity and caches JWKS for ten minutes', async () => {
        const jwt = await token();
        expect(await verifyIdToken(jwt, { nonce: 'nonce' })).toEqual({ sub: 'auth0|one', email: 'test@example.com' });
        const fetched = fetchMock.mock.calls.length;
        await verifyIdToken(jwt, { nonce: 'nonce' });
        expect(fetchMock).toHaveBeenCalledTimes(fetched);
        vi.useFakeTimers(); vi.setSystemTime(Date.now() + 600_001);
        await verifyIdToken(await token({ iat: now + 600, exp: now + 900 }), { nonce: 'nonce' });
        expect(fetchMock).toHaveBeenCalledTimes(fetched + 1);
        expect(String(fetchMock.mock.calls[0][0])).toBe(`${AUTH0_ISSUER}.well-known/jwks.json`);
    });
    it.each([
        ['issuer', { iss: 'https://evil.example/' }], ['audience', { aud: 'other' }],
        ['missing audience', { aud: undefined }], ['multiple audience without azp', { aud: [clientId, 'other'] }],
        ['wrong azp', { azp: 'other' }], ['expiry', { exp: now - 61 }], ['missing expiry', { exp: undefined }],
        ['string expiry', { exp: String(now + 300) }], ['future iat', { iat: now + 3600, exp: now + 7200 }],
        ['missing iat', { iat: undefined }], ['string iat', { iat: String(now) }], ['iat after exp', { iat: now, exp: now - 1 }],
        ['nonce', { nonce: 'other' }], ['missing nonce', { nonce: undefined }],
        ['unverified email', { email_verified: false }], ['truthy email verification', { email_verified: 'true' }],
        ['missing email', { email: undefined }], ['invalid email', { email: 'bad' }], ['missing subject', { sub: undefined }],
    ])('refuses %s', async (_name, claims) => {
        const unverified = 'email_verified' in claims;
        await expect(verifyIdToken(await token(claims), { nonce: 'nonce' })).rejects.toMatchObject({ code: unverified ? 'email_unverified' : 'invalid_id_token' });
    });
    it.each(['HS256', 'none'])('refuses %s before consulting JWKS', async alg => {
        await expect(verifyIdToken(await token({}, { alg }), { nonce: 'nonce' })).rejects.toThrow('invalid_id_token');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('allows sixty seconds of clock skew and a valid audience array', async () => {
        await expect(verifyIdToken(await token({ exp: now - 30, iat: now - 300, aud: [clientId, 'api'], azp: clientId }), { nonce: 'nonce' })).resolves.toMatchObject({ sub: 'auth0|one' });
        await expect(verifyIdToken(await token({ iat: now + 30 }), { nonce: 'nonce' })).resolves.toMatchObject({ sub: 'auth0|one' });
    });
    it('rejects forged signatures and malformed tokens', async () => {
        const jwt = await token();
        const [header, , sig] = jwt.split('.');
        const altered = Buffer.from(JSON.stringify({ ...baseClaims(), sub: 'attacker' })).toString('base64url');
        for (const bad of [`${header}.${altered}.${sig}`, 'bad', 'e30.e30.', `${jwt}.extra`]) {
            await expect(verifyIdToken(bad, { nonce: 'nonce' })).rejects.toThrow('invalid_id_token');
        }
    });
    it('refetches once for an unknown kid, then refuses', async () => {
        await verifyIdToken(await token(), { nonce: 'nonce' });
        fetchMock.mockClear();
        await expect(verifyIdToken(await token({}, { kid: 'unknown' }), { nonce: 'nonce' })).rejects.toThrow('invalid_id_token');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('fetches and refetches exactly once for an unknown kid with an empty cache', async () => {
        vi.resetModules();
        const fresh = await import('./auth0');
        await expect(fresh.verifyIdToken(await token({}, { kid: 'unknown-cold' }), { nonce: 'nonce' })).rejects.toThrow('invalid_id_token');
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
    it('accepts key rotation after a single refresh', async () => {
        await verifyIdToken(await token(), { nonce: 'nonce' });
        fetchMock.mockClear();
        fetchMock.mockResolvedValue(Response.json({ keys: [{ ...jwk, kid: 'rotated' }] }));
        await expect(verifyIdToken(await token({}, { kid: 'rotated' }), { nonce: 'nonce' })).resolves.toMatchObject({ sub: 'auth0|one' });
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it.each([{ kty: 'oct' }, { alg: 'HS256' }, { use: 'enc' }, { key_ops: ['encrypt'] }])('refuses unsuitable JWK %j', async change => {
        fetchMock.mockResolvedValue(Response.json({ keys: [{ ...jwk, kid: String(kid), ...change }] }));
        await expect(verifyIdToken(await token(), { nonce: 'nonce' })).rejects.toThrow('invalid_id_token');
    });
    it.each([{ kid: '' }, { kid: undefined }, { crit: ['unsupported'] }])('refuses invalid token header %j', async header => {
        await expect(verifyIdToken(await token({}, header), { nonce: 'nonce' })).rejects.toThrow('invalid_id_token');
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it.each(['http', 'malformed', 'empty'])('refuses %s JWKS responses', async failure => {
        fetchMock.mockImplementation(async () => Response.json(failure === 'malformed' ? {} : { keys: [] }, { status: failure === 'http' ? 503 : 200 }));
        await expect(verifyIdToken(await token(), { nonce: 'nonce' })).rejects.toThrow('invalid_id_token');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    it('hides JWKS transport failures', async () => {
        fetchMock.mockRejectedValue(new Error(secret));
        await expect(verifyIdToken(await token(), { nonce: 'nonce' })).rejects.toThrow(/^invalid_id_token$/);
    });
});

describe('code exchange', () => {
    it('uses client_secret_post and PKCE at the fixed endpoint', async () => {
        fetchMock.mockResolvedValue(Response.json({ id_token: 'signed-token' }));
        expect(await exchangeCode('code', { origin: 'https://os-staging.ezil.work', codeVerifier: 'verifier' })).toBe('signed-token');
        const [url, options] = fetchMock.mock.calls[0];
        expect(String(url)).toBe(`${AUTH0_ISSUER}oauth/token`);
        expect(options).toMatchObject({ method: 'POST', redirect: 'error', cache: 'no-store' });
        expect(Object.fromEntries(options.body)).toEqual({ grant_type: 'authorization_code', client_id: clientId, client_secret: secret, code: 'code', code_verifier: 'verifier', redirect_uri: 'https://os-staging.ezil.work/auth/auth0/callback' });
        expect(String(url)).not.toContain(secret);
    });
    it.each(['http', 'missing_token', 'network'])('returns only a safe error on %s failure', async failure => {
        if (failure === 'network') fetchMock.mockRejectedValue(new Error(secret));
        else fetchMock.mockResolvedValue(Response.json({ error_description: secret }, { status: failure === 'http' ? 400 : 200 }));
        await expect(exchangeCode('code', { origin: 'https://os-staging.ezil.work', codeVerifier: 'verifier' })).rejects.toThrow(/^token_exchange_failed$/);
    });
});


describe('Works ID-token identity verification', () => {
    it('accepts a single exact audience without azp and returns no email identity', async () => {
        expect(await verifyProjectIdToken(await token())).toEqual({issuer: AUTH0_ISSUER, subject: 'auth0|one', expiresAt: (now + 300) * 1000});
    });
    it.each([{aud:'foreign'}, {iss:'https://other.invalid/'}, {azp:'foreign'}, {aud:[clientId,'another']}, {aud:[clientId,'*'],azp:clientId}, {exp:now-1}, {iat:now+100}, {gty:'client-credentials'}])('rejects invalid exchange claims %j', async claims => {
        await expect(verifyProjectIdToken(await token(claims))).rejects.toMatchObject({code:'invalid_id_token'});
    });
    it('accepts proper multi-audience azp and refuses a tampered signature', async () => {
        await expect(verifyProjectIdToken(await token({aud:[clientId,'another'],azp:clientId}))).resolves.toMatchObject({subject:'auth0|one'});
        const t = await token();
        await expect(verifyProjectIdToken(t.slice(0,-10)+'AAAAAAAAAA')).rejects.toMatchObject({code:'invalid_id_token'});
    });
});
