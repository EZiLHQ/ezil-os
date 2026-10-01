import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    ensureEzilAccount,
    ezilAccountStepForOsPage,
    parseWorksApiOrigin,
    refreshSessionUrl,
    tokenEzilRole,
} from './ezil-account';

const WORKS = 'https://works-api.example.test';
const USER = 'abcdef01-2345-6789-abcd-ef0123456789';

function jwt(claims: Record<string, unknown>): string {
    const enc = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
    return `${enc({ alg: 'ES256' })}.${enc(claims)}.sig`;
}
const NO_ROLE = jwt({ sub: USER, role: 'authenticated', app_metadata: { provider: 'email' } });
const BUILDER = jwt({ sub: USER, role: 'authenticated', app_metadata: { ezil_role: 'builder' } });

function works(status: number, body: unknown = {}) {
    const mock = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
    return mock as typeof mock & typeof fetch;
}

afterEach(() => vi.restoreAllMocks());

describe('tokenEzilRole', () => {
    it('reads app_metadata.ezil_role and nothing else', () => {
        expect(tokenEzilRole(BUILDER)).toBe('builder');
        expect(tokenEzilRole(NO_ROLE)).toBeNull();
        expect(tokenEzilRole(jwt({ user_metadata: { ezil_role: 'operations' } }))).toBeNull();
        expect(tokenEzilRole('garbage')).toBeNull();
    });
});

describe('ensureEzilAccount', () => {
    it('does nothing (no request) when the token already carries a role', async () => {
        const fetchImpl = works(201);
        expect(await ensureEzilAccount({ accessToken: BUILDER, userAppMetadata: {}, worksApiOrigin: WORKS, fetchImpl })).toEqual({ status: 'ready', role: 'builder' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('only asks for a refresh when the auth record already has the role (stale token)', async () => {
        const fetchImpl = works(201);
        expect(await ensureEzilAccount({ accessToken: NO_ROLE, userAppMetadata: { ezil_role: 'builder' }, worksApiOrigin: WORKS, fetchImpl })).toEqual({ status: 'refresh', adopted: false });
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('calls Works POST /account with the user\'s own bearer and role builder, then asks for a refresh', async () => {
        const fetchImpl = works(201, { accountId: USER, email: 'a@b.c', role: 'builder' });
        expect(await ensureEzilAccount({ accessToken: NO_ROLE, userAppMetadata: {}, worksApiOrigin: WORKS, fetchImpl })).toEqual({ status: 'refresh', adopted: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe(`${WORKS}/account`);
        expect(init!.method).toBe('POST');
        expect((init!.headers as Record<string, string>).authorization).toBe(`Bearer ${NO_ROLE}`);
        expect(JSON.parse(init!.body as string)).toEqual({ role: 'builder' });
    });

    it('a 409 (account row without a role) is a final, clear error', async () => {
        const result = await ensureEzilAccount({ accessToken: NO_ROLE, userAppMetadata: {}, worksApiOrigin: WORKS, fetchImpl: works(409, { error: 'account_exists', message: 'This sign-in already has an EZiL account.' }) });
        expect(result).toMatchObject({ status: 'failed', code: 'account_exists', httpStatus: 409, retry: false });
        expect((result as { message: string }).message).toContain('Contact EZiL support');
    });

    it('a 403 keeps Works\' own message; 5xx and network failures are retryable', async () => {
        expect(await ensureEzilAccount({ accessToken: NO_ROLE, userAppMetadata: {}, worksApiOrigin: WORKS, fetchImpl: works(403, { error: 'role_unusable', message: 'Operations accounts are provisioned internally.' }) }))
            .toEqual({ status: 'failed', code: 'role_unusable', httpStatus: 403, message: 'Operations accounts are provisioned internally.', retry: false });
        expect(await ensureEzilAccount({ accessToken: NO_ROLE, userAppMetadata: {}, worksApiOrigin: WORKS, fetchImpl: works(500, { error: 'internal_error' }) })).toMatchObject({ status: 'failed', retry: true });
        const down = vi.fn(async () => { throw new TypeError('fetch failed'); });
        expect(await ensureEzilAccount({ accessToken: NO_ROLE, userAppMetadata: {}, worksApiOrigin: WORKS, fetchImpl: down as unknown as typeof fetch })).toMatchObject({ status: 'failed', code: 'works_unreachable', retry: true });
    });

    it('is skipped without a Works origin or a session', async () => {
        const fetchImpl = works(201);
        expect(await ensureEzilAccount({ accessToken: NO_ROLE, userAppMetadata: {}, worksApiOrigin: null, fetchImpl })).toEqual({ status: 'skipped', reason: 'not_configured' });
        expect(await ensureEzilAccount({ accessToken: null, userAppMetadata: {}, worksApiOrigin: WORKS, fetchImpl })).toEqual({ status: 'skipped', reason: 'no_session' });
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('the /os page step', () => {
    it('redirects to the refresh route once, then never again on the same chain', async () => {
        vi.spyOn(console, 'info').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const first = await ezilAccountStepForOsPage({ userId: USER, accessToken: NO_ROLE, userAppMetadata: {}, worksApiOrigin: WORKS, refreshedMarker: undefined, fetchImpl: works(201) });
        expect(first.redirectTo).toBe(`/auth/refresh?returnUrl=${encodeURIComponent('/os?ezil_account=refreshed')}`);
        // Back from the refresh, the token still has no role (and the row now exists): no second redirect.
        const second = await ezilAccountStepForOsPage({ userId: USER, accessToken: NO_ROLE, userAppMetadata: { ezil_role: 'builder' }, worksApiOrigin: WORKS, refreshedMarker: 'refreshed', fetchImpl: works(409) });
        expect(second.redirectTo).toBeNull();
        expect(error).toHaveBeenCalled();
    });

    it('logs a refusal without the token and lets the OS open', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const step = await ezilAccountStepForOsPage({ userId: USER, accessToken: NO_ROLE, userAppMetadata: {}, worksApiOrigin: WORKS, refreshedMarker: undefined, fetchImpl: works(409, { error: 'account_exists' }) });
        expect(step.redirectTo).toBeNull();
        expect(JSON.stringify(error.mock.calls)).toContain('account_exists');
        expect(JSON.stringify(error.mock.calls)).not.toContain(NO_ROLE);
    });

    it('a ready user is untouched', async () => {
        const fetchImpl = works(201);
        expect((await ezilAccountStepForOsPage({ userId: USER, accessToken: BUILDER, userAppMetadata: {}, worksApiOrigin: WORKS, refreshedMarker: undefined, fetchImpl })).redirectTo).toBeNull();
        expect(fetchImpl).not.toHaveBeenCalled();
    });
});

describe('configuration helpers', () => {
    it('accepts https (and http on localhost) origins only', () => {
        expect(parseWorksApiOrigin('https://works-api.example.test/')).toBe('https://works-api.example.test');
        expect(parseWorksApiOrigin('http://localhost:8787')).toBe('http://localhost:8787');
        expect(parseWorksApiOrigin('http://works-api.example.test')).toBeNull();
        expect(parseWorksApiOrigin('')).toBeNull();
        expect(parseWorksApiOrigin(undefined)).toBeNull();
        expect(parseWorksApiOrigin('not a url')).toBeNull();
    });

    it('builds a same-origin refresh URL that comes back marked', () => {
        expect(refreshSessionUrl('/os')).toBe('/auth/refresh?returnUrl=%2Fos%3Fezil_account%3Drefreshed');
    });
});
