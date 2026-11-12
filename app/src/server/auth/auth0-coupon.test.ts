import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const jar = vi.hoisted(() => ({ set: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
import { hashSponsorToken, signSponsorRegistry } from '@/server/billing/v3/sponsor';
import { buildAuthorizeUrl, readTransaction } from './auth0';
const origin = 'https://os-staging.ezil.work', key = 'synthetic-context-key-'.repeat(3), token = 't'.repeat(43);
const campaign = { campaignId: 'fixture-campaign', partnerId: 'staging-qa', version: 2, enabled: true, startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', tokenSha256: hashSponsorToken(token) };
function registry(entry = campaign) { const document = JSON.stringify({ v: 1, campaigns: [entry] }); vi.stubEnv('SPONSOR_REGISTRY', document); vi.stubEnv('SPONSOR_REGISTRY_SIG', signSponsorRegistry(document, key)); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T12:00:00Z')); jar.set.mockReset(); vi.stubEnv('AUTH0_CLIENT_ID', 'fixture'); vi.stubEnv('AUTH0_SECRET_ID', 'fixture-auth-secret'); vi.stubEnv('SPONSOR_TRIALS_ENABLED', '1'); vi.stubEnv('SPONSOR_KEY', key); vi.stubEnv('SPONSOR_REGISTRY_KEY', key); registry(); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('coupon reuses the real sealed Auth0 transaction', () => {
    it.each(['coupon', 'token'])('both %s formats bind same campaign and fixed billing destination', async kind => {
        const url = await buildAuthorizeUrl({ origin, returnUrl: 'https://evil.example', ...(kind === 'coupon' ? { sponsorCoupon: 'staging-qa' } : { sponsorToken: token }) });
        const cookie = jar.set.mock.calls[0]![1] as string;
        const tx = readTransaction(cookie, url.searchParams.get('state'), origin);
        expect(tx.returnUrl).toBe('/os?settings=billing'); expect(tx.sponsor).toBeTruthy();
        expect(url.searchParams.has('coupon')).toBe(false); expect(url.searchParams.has('sponsorToken')).toBe(false); expect(url.toString()).not.toContain(token);
        expect(() => readTransaction(cookie, 'wrong-state', origin)).toThrow('state_mismatch');
        expect(() => readTransaction(cookie, url.searchParams.get('state'), 'https://evil.example')).toThrow('invalid_transaction');
        registry({ ...campaign, version: 3 });
        expect(() => readTransaction(cookie, url.searchParams.get('state'), origin)).toThrow('invalid_transaction');
    });
    it('unknown alias, mixed inputs, and silent coupon attempts cannot start auth', async () => {
        for (const options of [{ sponsorCoupon: 'unknown' }, { sponsorCoupon: 'staging-qa', sponsorToken: token }, { sponsorCoupon: 'staging-qa', prompt: 'none' as const }]) await expect(buildAuthorizeUrl({ origin, ...options })).rejects.toMatchObject({ code: 'invalid_transaction' });
        expect(jar.set).not.toHaveBeenCalled();
    });
    it('disable after start invalidates callback while ordinary login survives', async () => {
        const url = await buildAuthorizeUrl({ origin, sponsorCoupon: 'staging-qa' }); const cookie = jar.set.mock.calls[0]![1] as string;
        registry({ ...campaign, enabled: false });
        expect(() => readTransaction(cookie, url.searchParams.get('state'), origin)).toThrow('invalid_transaction');
        await expect(buildAuthorizeUrl({ origin })).resolves.toBeInstanceOf(URL);
    });
});
