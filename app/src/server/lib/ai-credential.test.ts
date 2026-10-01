import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import {
    AI_CREDENTIAL_REFRESH_BEFORE_MS,
    currentAccessToken,
    mintAiCredentialSignature,
    pushAiCredential,
    readAccessTokenClaims,
    syncAiCredential,
    type SessionSource,
} from './ai-credential';

const USER = 'abcdef01-2345-6789-abcd-ef0123456789';
const SANDBOX = 'guac-abcdef0123456789-fedcba9876543210';
const SECRET = 'test-hmac-secret';
const CONFIG = { workerUrl: 'https://api-desktop.ezil.org', hasHmacSecret: true, isConfigured: true };

function jwt(claims: Record<string, unknown>): string {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${enc({ alg: 'ES256' })}.${enc(claims)}.sig`;
}

const inAnHour = () => Math.floor(Date.now() / 1000) + 3600;
const builderToken = (exp = inAnHour(), sub = USER) =>
    jwt({ sub, exp, role: 'authenticated', app_metadata: { ezil_role: 'builder' } });

function session(token: string | null, refreshed: string | null = null): SessionSource & { refreshes: number } {
    const source = {
        refreshes: 0,
        auth: {
            getSession: async () => ({ data: { session: token === null ? null : { access_token: token } } }),
            refreshSession: async () => {
                source.refreshes += 1;
                return { data: { session: refreshed === null ? null : { access_token: refreshed } }, error: refreshed === null ? new Error('x') : null };
            },
        },
    };
    return source;
}

describe('mintAiCredentialSignature', () => {
    it('signs timestamp, sandbox id and the SHA-256 of the exact body (the Worker contract)', () => {
        const body = '{"accessToken":"a.b.c"}';
        const sig = mintAiCredentialSignature(SECRET, SANDBOX, body, 1_700_000_000_000);
        const hash = createHash('sha256').update(body).digest('hex');
        const expected = createHmac('sha256', SECRET).update(`1700000000000.POST./sandbox/${SANDBOX}/ai-credential.${hash}`).digest('hex');
        expect(sig).toBe(`t=1700000000000,v1=${expected}`);
    });
});

describe('readAccessTokenClaims', () => {
    it('reads sub, exp and the ezil role claim without verifying', () => {
        expect(readAccessTokenClaims(builderToken(2_000_000_000))).toEqual({ sub: USER, expiresAt: 2_000_000_000_000, ezilRole: 'builder' });
        expect(readAccessTokenClaims(jwt({ sub: USER, exp: 1 }))?.ezilRole).toBeNull();
        expect(readAccessTokenClaims('nope')).toBeNull();
        expect(readAccessTokenClaims('a.%%%.c')).toBeNull();
    });
});

describe('currentAccessToken', () => {
    it('returns the cookie session token for the same user', async () => {
        const token = builderToken();
        expect(await currentAccessToken(USER, new Headers(), session(token))).toBe(token);
    });

    it('refuses bearer callers, missing sessions and another user’s session', async () => {
        expect(await currentAccessToken(USER, new Headers({ authorization: 'Bearer x' }), session(builderToken()))).toBeNull();
        expect(await currentAccessToken(USER, new Headers(), session(null))).toBeNull();
        expect(await currentAccessToken(USER, new Headers(), session(builderToken(inAnHour(), '00000000-0000-0000-0000-000000000000')))).toBeNull();
    });

    it('refreshes first when the token is about to expire', async () => {
        const soon = Math.floor((Date.now() + AI_CREDENTIAL_REFRESH_BEFORE_MS - 60_000) / 1000);
        const fresh = builderToken();
        const source = session(builderToken(soon), fresh);
        expect(await currentAccessToken(USER, new Headers(), source)).toBe(fresh);
        expect(source.refreshes).toBe(1);
    });

    it('keeps a still-valid token when the refresh fails, and drops an expired one', async () => {
        const soon = Math.floor((Date.now() + 120_000) / 1000);
        const nearly = builderToken(soon);
        expect(await currentAccessToken(USER, new Headers(), session(nearly, null))).toBe(nearly);
        const expired = builderToken(Math.floor(Date.now() / 1000) - 10);
        expect(await currentAccessToken(USER, new Headers(), session(expired, null))).toBeNull();
    });
});

describe('pushAiCredential', () => {
    it('POSTs the token in the body with a body-bound signature, never in a header', async () => {
        const token = builderToken();
        const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, stored: true }), { status: 200 }));
        const result = await pushAiCredential(CONFIG, SECRET, SANDBOX, token, fetchImpl as unknown as typeof fetch);
        expect(result).toEqual({ ok: true, stored: true });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`https://api-desktop.ezil.org/sandbox/${SANDBOX}/ai-credential`);
        const headers = init.headers as Record<string, string>;
        expect(Object.values(headers).join(' ')).not.toContain(token);
        expect(JSON.parse(init.body as string)).toEqual({ accessToken: token });
        const ts = Number(/^t=(\d+),/.exec(headers['x-ezil-signature']!)![1]);
        expect(headers['x-ezil-signature']).toBe(mintAiCredentialSignature(SECRET, SANDBOX, init.body as string, ts));
    });

    it('skips without a request when unconfigured, unsigned, sessionless or role-less', async () => {
        const fetchImpl = vi.fn();
        const f = fetchImpl as unknown as typeof fetch;
        expect(await pushAiCredential({ ...CONFIG, isConfigured: false }, SECRET, SANDBOX, builderToken(), f)).toMatchObject({ skipped: 'not_configured' });
        expect(await pushAiCredential(CONFIG, '', SANDBOX, builderToken(), f)).toMatchObject({ skipped: 'not_configured' });
        expect(await pushAiCredential(CONFIG, SECRET, SANDBOX, null, f)).toMatchObject({ skipped: 'no_session' });
        expect(await pushAiCredential(CONFIG, SECRET, SANDBOX, jwt({ sub: USER, exp: inAnHour() }), f)).toMatchObject({ skipped: 'no_ezil_role' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('reports a rejection or network failure as a value and never logs the token', async () => {
        const token = builderToken();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const rejected = vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'access_token_wrong_user' }), { status: 400 }));
        expect(await pushAiCredential(CONFIG, SECRET, SANDBOX, token, rejected as unknown as typeof fetch)).toEqual({ ok: false, error: 'access_token_wrong_user' });
        const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
        expect(await pushAiCredential(CONFIG, SECRET, SANDBOX, token, down as unknown as typeof fetch)).toEqual({ ok: false, error: 'TypeError' });
        expect(JSON.stringify(warn.mock.calls)).not.toContain(token);
        warn.mockRestore();
    });
});

describe('syncAiCredential', () => {
    it('never throws, even when the session source does', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const result = await syncAiCredential({
            config: CONFIG,
            hmacSecret: SECRET,
            sandboxName: SANDBOX,
            userId: USER,
            headers: new Headers(),
            supabase: async () => { throw new Error('cookies() outside a request'); },
        });
        expect(result).toEqual({ ok: false, error: 'sync_failed' });
        warn.mockRestore();
    });
});
