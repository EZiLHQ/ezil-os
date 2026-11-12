import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({ record: vi.fn(), db: {} }));
vi.mock('@/server/db', () => ({ db: stub.db }));
vi.mock('./sponsor-attribution', () => ({ recordSponsorAttribution: stub.record }));
import { hashSponsorToken, signSponsorRegistry } from '@/server/billing/v3/sponsor';
import { loginSponsorContext, materializeSponsorAttribution, sponsorCreationHint, sponsorFromCreationHint, sponsorFromLink, sponsorFromTransaction, SPONSOR_CREATION_METADATA } from './sponsor';

const key = 'synthetic-sponsor-key-'.repeat(3);
const token = 't'.repeat(43), nonce = 'n'.repeat(43), origin = 'https://os-staging.ezil.work';
const entry = { campaignId: 'fixture-campaign', partnerId: 'fixture-partner', version: 1, enabled: true,
    startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', tokenSha256: hashSponsorToken(token) };
function registry(value = entry) {
    const document = JSON.stringify({ v: 1, campaigns: [value] });
    vi.stubEnv('SPONSOR_REGISTRY', document);
    vi.stubEnv('SPONSOR_REGISTRY_SIG', signSponsorRegistry(document, key));
}
beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    vi.stubEnv('SPONSOR_TRIALS_ENABLED', '1'); vi.stubEnv('SPONSOR_KEY', key); vi.stubEnv('SPONSOR_REGISTRY_KEY', key);
    registry(); stub.record.mockReset(); stub.record.mockResolvedValue('same');
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('sponsor auth authority', () => {
    it('resolves only opaque registered token, independently of public trial gate', () => {
        vi.stubEnv('BILLING_PUBLIC_STANDARD_TRIAL', '0');
        expect(sponsorFromLink(token)?.campaignId).toBe(entry.campaignId);
        for (const bad of ['fixture-campaign', 'x'.repeat(43), '', '<script>']) expect(sponsorFromLink(bad)).toBeNull();
    });
    it('binds signed login context to origin, state and nonce; rejects tamper, expiry and changed config', () => {
        const campaign = sponsorFromLink(token)!;
        const value = loginSponsorContext(campaign, origin, 'state', nonce);
        expect(sponsorFromTransaction(value, origin, 'state', nonce)).toEqual(campaign);
        expect(sponsorFromTransaction(value + 'x', origin, 'state', nonce)).toBeNull();
        expect(sponsorFromTransaction(value, 'https://os.ezil.org', 'state', nonce)).toBeNull();
        expect(sponsorFromTransaction(value, origin, 'other-state', nonce)).toBeNull();
        expect(sponsorFromTransaction(value, origin, 'state', 'other-nonce')).toBeNull();
        registry({ ...entry, version: 2 });
        expect(sponsorFromTransaction(value, origin, 'state', nonce)).toBeNull();
        registry(); vi.setSystemTime(new Date('2026-11-11T12:30:01Z'));
        expect(sponsorFromTransaction(value, origin, 'state', nonce)).toBeNull();
    });
    it('fails closed for master off, missing registry, revoked and expired campaigns', () => {
        vi.stubEnv('SPONSOR_TRIALS_ENABLED', '0'); expect(sponsorFromLink(token)).toBeNull();
        vi.stubEnv('SPONSOR_TRIALS_ENABLED', '1'); vi.stubEnv('SPONSOR_REGISTRY', ''); expect(sponsorFromLink(token)).toBeNull();
        registry({ ...entry, enabled: false }); expect(sponsorFromLink(token)).toBeNull();
        registry({ ...entry, expiresAt: '2026-11-10T00:00:00Z' }); expect(sponsorFromLink(token)).toBeNull();
    });
    it('binds creation recovery to BOTH verified subject and actual OS UUID, with bounded expiry', () => {
        const campaign = sponsorFromLink(token)!;
        const hint = sponsorCreationHint(campaign, 'user-one', 'auth0|one');
        expect(sponsorFromCreationHint(hint, 'user-one', 'auth0|one')?.campaign).toEqual(campaign);
        expect(sponsorFromCreationHint(hint, 'user-two', 'auth0|one')).toBeNull();
        expect(sponsorFromCreationHint(hint, 'user-one', 'auth0|two')).toBeNull();
        expect(sponsorFromCreationHint(hint + 'x', 'user-one', 'auth0|one')).toBeNull();
        vi.setSystemTime(new Date('2026-11-12T12:00:01Z'));
        expect(sponsorFromCreationHint(hint, 'user-one', 'auth0|one')).toBeNull();
    });
    it.each(['auth0|' + 's'.repeat(249), '"'.repeat(255)])('materializes genuine signup recovery at maximum UUID/subject/campaign bounds (%#)', async subject => {
        registry({ ...entry, campaignId: 'c'.repeat(64) });
        const campaign = sponsorFromLink(token)!;
        const userId = '11111111-1111-4111-8111-111111111111';
        expect(subject).toHaveLength(255);
        const hint = sponsorCreationHint(campaign, userId, subject);
        expect(hint.split('.')[0].length).toBeGreaterThan(600);
        expect(hint.split('.')[0].length).toBeLessThanOrEqual(1024);
        expect(sponsorFromCreationHint(hint, userId, subject)?.campaign).toEqual(campaign);
        expect(sponsorFromCreationHint(hint + 'x', userId, subject)).toBeNull();
        await materializeSponsorAttribution({ userId, verifiedSubject: subject,
            metadata: { auth0_sub: subject, [SPONSOR_CREATION_METADATA]: hint } });
        expect(stub.record).toHaveBeenCalledWith(stub.db, expect.objectContaining({ campaign, signedUpAt: new Date('2026-11-11T12:00:00Z') }));
    });
    it('refuses oversize and non-ASCII subjects only for sponsor hint/sign-up attribution', async () => {
        const campaign = sponsorFromLink(token)!;
        const hint = sponsorCreationHint(campaign, 'user-one', 'auth0|one');
        for (const subject of ['s'.repeat(256), 'é'.repeat(255)]) {
            expect(() => sponsorCreationHint(campaign, 'user-one', subject)).toThrow('sponsor_subject_unsupported');
            expect(sponsorFromCreationHint(hint, 'user-one', subject)).toBeNull();
            await materializeSponsorAttribution({ userId: 'user-one', verifiedSubject: subject, metadata: { auth0_sub: subject }, campaign });
        }
        expect(stub.record).not.toHaveBeenCalled();
    });
    it('existing login attribution has no signup timestamp; recovery retains original creation time on replay', async () => {
        const campaign = sponsorFromLink(token)!;
        await materializeSponsorAttribution({ userId: 'user-one', verifiedSubject: 'auth0|one', metadata: { auth0_sub: 'auth0|one' }, campaign });
        expect(stub.record).toHaveBeenLastCalledWith(stub.db, expect.objectContaining({ campaign, signedUpAt: null }));
        const hint = sponsorCreationHint(campaign, 'user-one', 'auth0|one');
        const input = { userId: 'user-one', verifiedSubject: 'auth0|one', metadata: { auth0_sub: 'auth0|one', [SPONSOR_CREATION_METADATA]: hint } };
        await materializeSponsorAttribution(input);
        vi.setSystemTime(new Date('2026-11-11T13:00:00Z'));
        await materializeSponsorAttribution(input);
        for (const call of stub.record.mock.calls.slice(1)) expect(call[1].signedUpAt).toEqual(new Date('2026-11-11T12:00:00Z'));
        expect(stub.record.mock.calls[1][1].accountKey).toBe(stub.record.mock.calls[2][1].accountKey);
    });
    it('wrong account/subject, ordinary normal login and disabled runtime cause no attribution write', async () => {
        const campaign = sponsorFromLink(token)!;
        const hint = sponsorCreationHint(campaign, 'user-one', 'auth0|one');
        await materializeSponsorAttribution({ userId: 'other', verifiedSubject: 'auth0|one', metadata: { auth0_sub: 'auth0|one', [SPONSOR_CREATION_METADATA]: hint } });
        await materializeSponsorAttribution({ userId: 'user-one', verifiedSubject: 'auth0|other', metadata: { auth0_sub: 'auth0|one' }, campaign });
        await materializeSponsorAttribution({ userId: 'user-one', verifiedSubject: 'auth0|one', metadata: { auth0_sub: 'auth0|one' } });
        vi.stubEnv('SPONSOR_TRIALS_ENABLED', '0');
        await materializeSponsorAttribution({ userId: 'user-one', verifiedSubject: 'auth0|one', metadata: { auth0_sub: 'auth0|one' }, campaign });
        expect(stub.record).not.toHaveBeenCalled();
    });
    it('propagates SQL failure so bridge can preserve auth and retry the unconsumed creation hint', async () => {
        const campaign = sponsorFromLink(token)!;
        const hint = sponsorCreationHint(campaign, 'user-one', 'auth0|one');
        const input = { userId: 'user-one', verifiedSubject: 'auth0|one', metadata: { auth0_sub: 'auth0|one', [SPONSOR_CREATION_METADATA]: hint } };
        stub.record.mockRejectedValueOnce(new Error('SQL unavailable'));
        await expect(materializeSponsorAttribution(input)).rejects.toThrow('SQL unavailable');
        await materializeSponsorAttribution(input);
        expect(stub.record.mock.calls[0][1]).toEqual(stub.record.mock.calls[1][1]);
    });
});
