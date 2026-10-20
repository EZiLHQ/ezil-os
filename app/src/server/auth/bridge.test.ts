import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({ listUsers: vi.fn(), createUser: vi.fn(), updateUserById: vi.fn(), generateLink: vi.fn(), verifyOtp: vi.fn(), signOut: vi.fn(), adminClient: vi.fn() }));
vi.mock('./supabase-admin', () => ({ createAdminClient: stub.adminClient }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { verifyOtp: stub.verifyOtp, signOut: stub.signOut } }) }));

import { bridgeAuth0Identity } from './bridge';
const identity = { sub: 'auth0|one', email: 'Test@example.com' };
const user = { id: 'supabase-user', email: 'test@example.com', app_metadata: { auth0_sub: identity.sub } };
beforeEach(() => {
    vi.resetAllMocks();
    stub.adminClient.mockReturnValue({ auth: { admin: stub } });
    stub.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    stub.createUser.mockResolvedValue({ data: { user }, error: null });
    stub.updateUserById.mockResolvedValue({ data: { user }, error: null });
    stub.generateLink.mockResolvedValue({ data: { user, properties: { hashed_token: 'private-otp' } }, error: null });
    stub.verifyOtp.mockResolvedValue({ data: { user, session: { access_token: 'private-session' } }, error: null });
});
afterEach(() => vi.restoreAllMocks());

describe('verified Auth0 identity bridge', () => {
    it('creates a confirmed user with a subject and sets the standard session via verifyOtp', async () => {
        await bridgeAuth0Identity(identity);
        expect(stub.createUser).toHaveBeenCalledWith({ email: 'test@example.com', email_confirm: true, app_metadata: { auth0_sub: 'auth0|one' } });
        expect(stub.generateLink).toHaveBeenCalledWith({ type: 'magiclink', email: 'test@example.com' });
        expect(stub.verifyOtp).toHaveBeenCalledWith({ type: 'magiclink', token_hash: 'private-otp' });
        expect(stub.createUser.mock.invocationCallOrder[0]).toBeLessThan(stub.generateLink.mock.invocationCallOrder[0]);
        expect(stub.generateLink.mock.invocationCallOrder[0]).toBeLessThan(stub.verifyOtp.mock.invocationCallOrder[0]);
        expect(stub.signOut).not.toHaveBeenCalled();
    });
    it('reuses the same subject without creating or updating an account', async () => {
        stub.listUsers.mockResolvedValue({ data: { users: [user] }, error: null });
        await bridgeAuth0Identity(identity);
        expect(stub.createUser).not.toHaveBeenCalled();
        expect(stub.updateUserById).not.toHaveBeenCalled();
        expect(stub.verifyOtp).toHaveBeenCalledOnce();
    });
    it('records a previously unbound subject while preserving other metadata', async () => {
        stub.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: { role: 'member' } }] }, error: null });
        await bridgeAuth0Identity(identity);
        expect(stub.updateUserById).toHaveBeenCalledWith(user.id, { app_metadata: { role: 'member', auth0_sub: identity.sub } });
        expect(stub.createUser).not.toHaveBeenCalled();
    });
    it('refuses a conflicting subject without linking, updating or establishing a session', async () => {
        stub.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: { auth0_sub: 'auth0|other' } }] }, error: null });
        await expect(bridgeAuth0Identity(identity)).rejects.toMatchObject({ code: 'account_conflict' });
        for (const fn of [stub.createUser, stub.updateUserById, stub.generateLink, stub.verifyOtp]) expect(fn).not.toHaveBeenCalled();
    });
    it('searches subsequent pages rather than creating a duplicate', async () => {
        stub.listUsers.mockResolvedValueOnce({ data: { users: Array.from({ length: 1000 }, () => ({ email: 'other@example.com' })) }, error: null })
            .mockResolvedValueOnce({ data: { users: [user] }, error: null });
        await bridgeAuth0Identity(identity);
        expect(stub.listUsers).toHaveBeenNthCalledWith(2, { page: 2, perPage: 1000 });
        expect(stub.createUser).not.toHaveBeenCalled();
    });
    it.each(['listUsers', 'createUser', 'updateUserById', 'generateLink'] as const)('fails closed when %s fails', async method => {
        if (method === 'updateUserById') stub.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: {} }] }, error: null });
        stub[method].mockResolvedValue({ data: null, error: { message: 'sensitive-provider-detail' } });
        await expect(bridgeAuth0Identity(identity)).rejects.toThrow(/^session_failed$/);
        expect(stub.verifyOtp).not.toHaveBeenCalled();
    });
    it.each([
        { properties: {}, user },
        { properties: { hashed_token: 'otp' }, user: { ...user, id: 'other' } },
        { properties: { hashed_token: 'otp' }, user: { ...user, app_metadata: { auth0_sub: 'other' } } },
    ])('does not redeem an incomplete or mismatched generated link', async data => {
        stub.generateLink.mockResolvedValue({ data, error: null });
        await expect(bridgeAuth0Identity(identity)).rejects.toThrow('session_failed');
        expect(stub.verifyOtp).not.toHaveBeenCalled();
    });
    it.each([
        { data: { session: null, user: null }, error: { message: 'secret' } },
        { data: { session: null, user }, error: null },
        { data: { session: {}, user: { id: 'other' } }, error: null },
    ])('refuses failed OTP verification or an unexpected session', async result => {
        stub.verifyOtp.mockResolvedValue(result);
        await expect(bridgeAuth0Identity(identity)).rejects.toThrow('session_failed');
        expect(stub.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });
});
