import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({
    adminClient: vi.fn(), listUsers: vi.fn(), createUser: vi.fn(), updateUserById: vi.fn(),
    generateLink: vi.fn(), verifyOtp: vi.fn(), signOut: vi.fn(), enroll: vi.fn(),
}));
vi.mock('./supabase-admin', () => ({ createAdminClient: stub.adminClient }));
vi.mock('./staging-ai-enrollment', () => ({ enrollStagingAiMember: stub.enroll }));
vi.mock('@/utils/supabase/server', () => ({
    createClient: async () => ({ auth: { verifyOtp: stub.verifyOtp, signOut: stub.signOut } }),
}));

import { bridgeAuth0Identity } from './bridge';

const identity = { sub: 'auth0|enrollment-fixture', email: 'Member@example.test' };
const user = {
    id: '00000000-0000-4000-8000-000000000041', email: 'member@example.test',
    email_confirmed_at: '2026-10-26T00:00:00Z', app_metadata: { auth0_sub: identity.sub },
};

beforeEach(() => {
    vi.resetAllMocks();
    stub.adminClient.mockReturnValue({ auth: { admin: stub } });
    stub.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    stub.createUser.mockResolvedValue({ data: { user }, error: null });
    stub.updateUserById.mockResolvedValue({ data: { user }, error: null });
    stub.enroll.mockResolvedValue(undefined);
    stub.generateLink.mockResolvedValue({ data: { user, properties: { hashed_token: 'fixture-otp' } }, error: null });
    stub.verifyOtp.mockResolvedValue({ data: { user, session: { access_token: 'fixture-supabase-token' } }, error: null });
});

describe('Auth0 bridge staging enrollment boundary', () => {
    it.each(['create', 'link', 'reuse'] as const)('awaits enrollment after %s and before minting the Supabase session', async path => {
        if (path === 'link') stub.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: {} }] }, error: null });
        if (path === 'reuse') stub.listUsers.mockResolvedValue({ data: { users: [user] }, error: null });
        let finishEnrollment!: () => void;
        let enteredEnrollment!: () => void;
        const entered = new Promise<void>(resolve => { enteredEnrollment = resolve; });
        const enrollment = new Promise<void>(resolve => { finishEnrollment = resolve; });
        stub.enroll.mockImplementation(() => { enteredEnrollment(); return enrollment; });

        const signingIn = bridgeAuth0Identity(identity);
        await entered;
        expect(stub.enroll).toHaveBeenCalledExactlyOnceWith(user.id, identity.sub);
        expect(stub.generateLink).not.toHaveBeenCalled();
        expect(stub.verifyOtp).not.toHaveBeenCalled();
        if (path === 'create') {
            expect(stub.createUser).toHaveBeenCalledExactlyOnceWith({
                email: user.email, email_confirm: true, app_metadata: { auth0_sub: identity.sub },
            });
            expect(stub.createUser.mock.invocationCallOrder[0]).toBeLessThan(stub.enroll.mock.invocationCallOrder[0]);
        } else if (path === 'link') {
            expect(stub.updateUserById).toHaveBeenCalledExactlyOnceWith(user.id, { app_metadata: { auth0_sub: identity.sub } });
            expect(stub.updateUserById.mock.invocationCallOrder[0]).toBeLessThan(stub.enroll.mock.invocationCallOrder[0]);
        } else {
            expect(stub.createUser).not.toHaveBeenCalled();
            expect(stub.updateUserById).not.toHaveBeenCalled();
        }
        finishEnrollment();
        await signingIn;
        expect(stub.generateLink).toHaveBeenCalledExactlyOnceWith({ type: 'magiclink', email: user.email });
        expect(stub.verifyOtp).toHaveBeenCalledExactlyOnceWith({ type: 'magiclink', token_hash: 'fixture-otp' });
        expect(stub.enroll.mock.invocationCallOrder[0]).toBeLessThan(stub.generateLink.mock.invocationCallOrder[0]);
        expect(stub.generateLink.mock.invocationCallOrder[0]).toBeLessThan(stub.verifyOtp.mock.invocationCallOrder[0]);
        expect(stub.signOut).not.toHaveBeenCalled();
    });

    it('preserves existing metadata while linking and leaves membership changes to enrollment SQL', async () => {
        const metadata = { ezil_role: 'operations', public_id: 'existing-public-id', suspended: true, provider: 'email' };
        stub.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: metadata }] }, error: null });
        await bridgeAuth0Identity(identity);
        expect(stub.updateUserById).toHaveBeenCalledExactlyOnceWith(user.id, {
            app_metadata: { ...metadata, auth0_sub: identity.sub },
        });
        expect(stub.enroll).toHaveBeenCalledExactlyOnceWith(user.id, identity.sub);
        expect(metadata).toEqual({ ezil_role: 'operations', public_id: 'existing-public-id', suspended: true, provider: 'email' });
    });

    it('does not rewrite metadata for an already linked member', async () => {
        stub.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: {
            ...user.app_metadata, ezil_role: 'creator', public_id: 'existing-public-id', suspended: true,
        } }] }, error: null });
        await bridgeAuth0Identity(identity);
        expect(stub.createUser).not.toHaveBeenCalled();
        expect(stub.updateUserById).not.toHaveBeenCalled();
        expect(stub.enroll).toHaveBeenCalledExactlyOnceWith(user.id, identity.sub);
    });

    it('refuses a conflicting Auth0 subject before enrollment', async () => {
        stub.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: { auth0_sub: 'auth0|another' } }] }, error: null });
        await expect(bridgeAuth0Identity(identity)).rejects.toMatchObject({ code: 'account_conflict' });
        for (const fn of [stub.createUser, stub.updateUserById, stub.enroll, stub.generateLink, stub.verifyOtp]) {
            expect(fn).not.toHaveBeenCalled();
        }
    });

    it.each(['listUsers', 'createUser', 'updateUserById'] as const)('does not enroll after %s fails', async method => {
        if (method === 'updateUserById') stub.listUsers.mockResolvedValue({ data: { users: [{ ...user, app_metadata: {} }] }, error: null });
        stub[method].mockResolvedValue({ data: null, error: { message: 'provider fixture failure' } });
        await expect(bridgeAuth0Identity(identity)).rejects.toThrow(/^session_failed$/);
        expect(stub.enroll).not.toHaveBeenCalled();
        expect(stub.generateLink).not.toHaveBeenCalled();
        expect(stub.verifyOtp).not.toHaveBeenCalled();
    });

    it.each([
        { properties: {}, user },
        { properties: { hashed_token: 'fixture-otp' }, user: { ...user, id: '00000000-0000-4000-8000-000000000042' } },
        { properties: { hashed_token: 'fixture-otp' }, user: { ...user, app_metadata: { auth0_sub: 'auth0|another' } } },
    ])('still refuses an incomplete or mismatched generated link after enrollment', async data => {
        stub.generateLink.mockResolvedValue({ data, error: null });
        await expect(bridgeAuth0Identity(identity)).rejects.toThrow(/^session_failed$/);
        expect(stub.enroll).toHaveBeenCalledOnce();
        expect(stub.verifyOtp).not.toHaveBeenCalled();
    });

    it('preserves the GoTrue ban refusal after the enrollment attempt', async () => {
        stub.verifyOtp.mockResolvedValue({
            data: { user: null, session: null }, error: { code: 'user_banned', message: 'fixture banned account' },
        });
        await expect(bridgeAuth0Identity(identity)).rejects.toThrow(/^session_failed$/);
        expect(stub.enroll).toHaveBeenCalledOnce();
        expect(stub.signOut).toHaveBeenCalledExactlyOnceWith({ scope: 'local' });
    });
});
