import 'server-only';

import { createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';

import { safeReturnUrl } from '@/utils/constants';

export const AUTH0_ISSUER = 'https://id.ezil.work/';
export const AUTH0_COOKIE = '__Host-ezil-auth0';
export const AUTH0_COOKIE_OPTIONS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' } as const;
const TEN_MINUTES = 600_000;

type ErrorCode = 'auth0_disabled' | 'invalid_transaction' | 'state_mismatch' | 'token_exchange_failed'
    | 'invalid_id_token' | 'email_unverified' | 'account_conflict' | 'session_failed' | 'auth0_failed';

export class Auth0Error extends Error {
    constructor(readonly code: ErrorCode) { super(code); }
}

export function auth0Enabled(): boolean {
    return Boolean(process.env.AUTH0_CLIENT_ID?.trim() && process.env.AUTH0_SECRET_ID?.trim());
}

function config() {
    if (!auth0Enabled()) throw new Auth0Error('auth0_disabled');
    return { clientId: process.env.AUTH0_CLIENT_ID!, secret: process.env.AUTH0_SECRET_ID! };
}

function constantTimeEqual(left: string, right: string): boolean {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
}

function signature(payload: string): string {
    // Domain-separated key: the OAuth client secret is never used as an HMAC key.
    const key = hkdfSync('sha256', config().secret, AUTH0_ISSUER, 'ezil/auth0/transaction/v1', 32);
    return createHmac('sha256', Buffer.from(key)).update(payload).digest('base64url');
}

interface Transaction {
    state: string;
    nonce: string;
    codeVerifier: string;
    returnUrl: string;
    expiresAt: number;
}

export async function buildAuthorizeUrl({ origin, returnUrl }: { origin: string; returnUrl?: string | null }) {
    const { clientId } = config();
    const transaction: Transaction = {
        state: randomBytes(32).toString('base64url'),
        nonce: randomBytes(32).toString('base64url'),
        codeVerifier: randomBytes(32).toString('base64url'),
        returnUrl: safeReturnUrl(returnUrl),
        expiresAt: Date.now() + TEN_MINUTES,
    };
    const payload = Buffer.from(JSON.stringify(transaction)).toString('base64url');
    (await cookies()).set(AUTH0_COOKIE, `${payload}.${signature(payload)}`, {
        ...AUTH0_COOKIE_OPTIONS, maxAge: 600, expires: new Date(transaction.expiresAt),
    });
    const challenge = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(transaction.codeVerifier));
    const url = new URL('authorize', AUTH0_ISSUER);
    url.search = new URLSearchParams({
        client_id: clientId, response_type: 'code', scope: 'openid email profile',
        redirect_uri: `${new URL(origin).origin}/auth/auth0/callback`,
        state: transaction.state, nonce: transaction.nonce,
        code_challenge: Buffer.from(challenge).toString('base64url'), code_challenge_method: 'S256',
    }).toString();
    return url;
}

export function readTransaction(cookie: string | undefined, state: string | null): Transaction {
    if (!cookie || cookie.length > 4096) throw new Auth0Error('invalid_transaction');
    const parts = cookie.split('.');
    if (parts.length !== 2 || !/^[\w-]+$/.test(parts[0]) || !constantTimeEqual(signature(parts[0]), parts[1])) {
        throw new Auth0Error('invalid_transaction');
    }
    let value: Transaction;
    try { value = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); }
    catch { throw new Auth0Error('invalid_transaction'); }
    if (!value || !Number.isFinite(value.expiresAt) || value.expiresAt <= Date.now()
        || value.expiresAt > Date.now() + TEN_MINUTES
        || ![value.state, value.nonce, value.codeVerifier].every(v => typeof v === 'string' && /^[\w-]{43}$/.test(v))
        || typeof value.returnUrl !== 'string') throw new Auth0Error('invalid_transaction');
    if (!state || !constantTimeEqual(value.state, state)) throw new Auth0Error('state_mismatch');
    return value;
}

export async function exchangeCode(code: string, { origin, codeVerifier }: { origin: string; codeVerifier: string }) {
    const { clientId, secret } = config();
    try {
        const response = await fetch(new URL('oauth/token', AUTH0_ISSUER), {
            method: 'POST', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(10_000),
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                grant_type: 'authorization_code', client_id: clientId, client_secret: secret, code,
                redirect_uri: `${new URL(origin).origin}/auth/auth0/callback`, code_verifier: codeVerifier,
            }),
        });
        if (!response.ok) {
            const body = await response.json().catch(() => ({}));
            // Auth0's error code and status only: never the code, secret or tokens.
            console.warn('[auth0] token exchange refused', { status: response.status, error: typeof body?.error === 'string' ? body.error : null });
            throw new Error();
        }
        const data = await response.json();
        if (typeof data.id_token !== 'string' || !data.id_token) throw new Error();
        return data.id_token as string;
    } catch { throw new Auth0Error('token_exchange_failed'); }
}

type SigningKey = JsonWebKey & { kid?: string };
let jwks: { keys: SigningKey[]; expiresAt: number } | undefined;

async function signingKeys(refresh = false): Promise<SigningKey[]> {
    if (!refresh && jwks && jwks.expiresAt > Date.now()) return jwks.keys;
    const response = await fetch(new URL('.well-known/jwks.json', AUTH0_ISSUER), {
        cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (!Array.isArray(data.keys)) throw new Error();
    jwks = { keys: data.keys, expiresAt: Date.now() + TEN_MINUTES };
    return jwks.keys;
}

export interface Auth0Identity { sub: string; email: string }

export async function verifyIdToken(idToken: string, { nonce }: { nonce: string }): Promise<Auth0Identity> {
    const { clientId } = config();
    try {
        const parts = idToken.split('.');
        if (parts.length !== 3 || !parts.every(p => /^[\w-]+$/.test(p))) throw new Error();
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit) throw new Error();
        let key = (await signingKeys()).find(k => k.kid === header.kid);
        // An unknown kid can mean rotation. Refresh exactly once, then fail closed.
        if (!key) key = (await signingKeys(true)).find(k => k.kid === header.kid);
        if (!key || key.kty !== 'RSA' || (key.alg && key.alg !== 'RS256') || (key.use && key.use !== 'sig')) throw new Error();
        const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey,
            new Uint8Array(Buffer.from(parts[2], 'base64url')), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error();
        const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
        const now = Date.now() / 1000;
        const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        const failed = claims.iss !== AUTH0_ISSUER ? 'iss'
            : !audience.includes(clientId) || (audience.length > 1 && claims.azp !== clientId) || (claims.azp !== undefined && claims.azp !== clientId) ? 'aud'
            : typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now - 60 ? 'exp'
            : typeof claims.iat !== 'number' || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.iat >= claims.exp ? 'iat'
            : typeof claims.nonce !== 'string' || !constantTimeEqual(claims.nonce, nonce) ? 'nonce'
            : typeof claims.sub !== 'string' || !claims.sub.trim() ? 'sub'
            : typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(claims.email) ? 'email'
            : claims.email_verified !== true ? 'email_verified' : null;
        if (failed) {
            console.warn('[auth0] id token claim refused', { claim: failed });
            throw new Auth0Error(failed === 'email_verified' ? 'email_unverified' : 'invalid_id_token');
        }
        return { sub: claims.sub, email: claims.email };
    } catch (error) {
        if (error instanceof Auth0Error) throw error;
        throw new Auth0Error('invalid_id_token');
    }
}

export function logoutUrl(origin: string): URL {
    const url = new URL('oidc/logout', AUTH0_ISSUER);
    url.search = new URLSearchParams({ client_id: config().clientId, post_logout_redirect_uri: `${new URL(origin).origin}/login` }).toString();
    return url;
}

/** Independent ID-token verification for the Works v1.1 exchange, with no expiry leeway. */
export async function verifyProjectIdToken(token: string) {
    const { clientId } = config();
    try {
        if (token.length > 16384) throw new Error();
        const parts = token.split('.');
        if (parts.length !== 3 || !parts.every(p => /^[\w-]+$/.test(p))) throw new Error();
        const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString());
        if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid || header.crit) throw new Error();
        let key = (await signingKeys()).find(k => k.kid === header.kid);
        if (!key) key = (await signingKeys(true)).find(k => k.kid === header.kid);
        if (!key || key.kty !== 'RSA' || (key.alg && key.alg !== 'RS256') || (key.use && key.use !== 'sig')) throw new Error();
        const publicKey = await crypto.subtle.importKey('jwk', key, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
        if (!await crypto.subtle.verify('RSASSA-PKCS1-v1_5', publicKey, new Uint8Array(Buffer.from(parts[2], 'base64url')), new TextEncoder().encode(`${parts[0]}.${parts[1]}`))) throw new Error();
        const c = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        const audiences = typeof c.aud === 'string' ? [c.aud] : c.aud;
        const now = Date.now() / 1000;
        if (c.iss !== AUTH0_ISSUER || !Array.isArray(audiences) || !audiences.length || !audiences.every(a => typeof a === 'string' && a && !a.includes('*'))
            || !audiences.includes(clientId) || (audiences.length > 1 && c.azp !== clientId) || (c.azp !== undefined && c.azp !== clientId)
            || c.gty === 'client-credentials' || typeof c.sub !== 'string' || !c.sub || c.sub.length > 255
            || !Number.isFinite(c.exp) || c.exp <= now || !Number.isFinite(c.iat) || c.iat > now || c.iat >= c.exp) throw new Error();
        return { issuer: AUTH0_ISSUER, subject: c.sub as string, expiresAt: c.exp * 1000 };
    } catch { throw new Auth0Error('invalid_id_token'); }
}
