import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({ listUsers: vi.fn(), createUser: vi.fn(), updateUserById: vi.fn(), generateLink: vi.fn(), verifyOtp: vi.fn(), signOut: vi.fn(), materialize: vi.fn() }));
vi.mock('./supabase-admin', () => ({ createAdminClient: () => ({ auth: { admin: stub } }) }));
vi.mock('./staging-ai-enrollment', () => ({ enrollStagingAiMember: vi.fn() }));
vi.mock('./sponsor', async original => ({ ...await original<typeof import('./sponsor')>(), materializeSponsorAttribution: stub.materialize }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: stub }) }));
import { bridgeAuth0Identity } from './bridge';
import { sponsorFromCreationHint, sponsorFromLink, SPONSOR_CREATION_METADATA } from './sponsor';
import { hashSponsorToken, signSponsorRegistry } from '@/server/billing/v3/sponsor';

const identity = { sub: 'auth0|fixture', email: 'fixture@example.invalid' };
const key = 'synthetic-sponsor-bridge-key-'.repeat(2), token = 't'.repeat(43);
let user: { id: string; email: string; email_confirmed_at: string; app_metadata: Record<string, unknown> };
beforeEach(() => {
    vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    vi.stubEnv('SPONSOR_TRIALS_ENABLED', '1'); vi.stubEnv('SPONSOR_KEY', key); vi.stubEnv('SPONSOR_REGISTRY_KEY', key);
    const document = JSON.stringify({ v: 1, campaigns: [{ campaignId: 'fixture-campaign', partnerId: 'fixture-partner', version: 1, enabled: true,
        startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', tokenSha256: hashSponsorToken(token) }] });
    vi.stubEnv('SPONSOR_REGISTRY', document); vi.stubEnv('SPONSOR_REGISTRY_SIG', signSponsorRegistry(document, key));
    user = { id: 'existing-user', email: identity.email, email_confirmed_at: '2026-11-01T00:00:00Z', app_metadata: { auth0_sub: identity.sub } };
    stub.listUsers.mockResolvedValue({ data: { users: [] }, error: null });
    stub.createUser.mockImplementation(async input => { user = { ...user, id: input.id, app_metadata: input.app_metadata }; return { data: { user }, error: null }; });
    stub.generateLink.mockImplementation(async () => ({ data: { user, properties: { hashed_token: 'synthetic-otp' } }, error: null }));
    stub.verifyOtp.mockImplementation(async () => ({ data: { user, session: {} }, error: null }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });
describe('sponsor bridge signup authority', () => {
    it('writes account/subject-bound hint only during actual new Admin account creation, then attributes after OTP', async () => {
        await bridgeAuth0Identity(identity, sponsorFromLink(token)!);
        const input = stub.createUser.mock.calls[0][0];
        expect(input.id).toMatch(/^[a-f0-9-]{36}$/);
        expect(sponsorFromCreationHint(input.app_metadata[SPONSOR_CREATION_METADATA], input.id, identity.sub)).not.toBeNull();
        expect(stub.materialize).toHaveBeenCalledWith(expect.objectContaining({ userId: input.id, metadata: input.app_metadata }));
        expect(stub.verifyOtp.mock.invocationCallOrder[0]).toBeLessThan(stub.materialize.mock.invocationCallOrder[0]);
    });
    it('existing account/email migrated to Auth0 is attribution only, never a new signup hint', async () => {
        user.app_metadata = { role: 'member' };
        stub.listUsers.mockResolvedValue({ data: { users: [user] }, error: null });
        stub.updateUserById.mockImplementation(async (_id, input) => { user.app_metadata = input.app_metadata; return { error: null }; });
        await bridgeAuth0Identity(identity, sponsorFromLink(token)!);
        expect(stub.createUser).not.toHaveBeenCalled();
        expect(stub.updateUserById.mock.calls[0][1].app_metadata).toEqual({ role: 'member', auth0_sub: identity.sub });
        expect(stub.materialize.mock.calls[0][0].metadata[SPONSOR_CREATION_METADATA]).toBeUndefined();
    });
    it('failed OTP never materializes attribution', async () => {
        stub.verifyOtp.mockResolvedValue({ data: { user: null, session: null }, error: {} });
        await expect(bridgeAuth0Identity(identity, sponsorFromLink(token)!)).rejects.toThrow('session_failed');
        expect(stub.materialize).not.toHaveBeenCalled();
    });
    it('SQL failure preserves successful normal session and the creation hint for next login recovery', async () => {
        stub.materialize.mockRejectedValueOnce(new Error('private failure'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        await bridgeAuth0Identity(identity, sponsorFromLink(token)!);
        expect(warn).toHaveBeenCalledWith('[auth0] sponsor attribution unavailable');
        expect(stub.signOut).not.toHaveBeenCalled();
        const originalHint = user.app_metadata[SPONSOR_CREATION_METADATA];
        stub.listUsers.mockResolvedValue({ data: { users: [user] }, error: null });
        await bridgeAuth0Identity(identity);
        expect(stub.materialize).toHaveBeenCalledTimes(2);
        expect(stub.materialize.mock.calls[1][0].metadata[SPONSOR_CREATION_METADATA]).toBe(originalHint);
        expect(stub.createUser).toHaveBeenCalledTimes(1);
    });
});
