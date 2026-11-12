import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
import { hashSponsorToken, signSponsorRegistry } from '@/server/billing/v3/sponsor';
import { loginSponsorContext, sponsorFromCoupon, sponsorFromTransaction } from './sponsor';
import { sponsorEntryContext, sponsorFromEntryContext } from './sponsor-entry-context';
const origin = 'https://os-staging.ezil.work', key = 'synthetic-entry-context-'.repeat(3), token = 't'.repeat(43);
const entry = { campaignId: 'fixture-campaign', partnerId: 'staging-qa', version: 1, enabled: true, startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', tokenSha256: hashSponsorToken(token) };
function registry(c = entry) { const text = JSON.stringify({ v: 1, campaigns: [c] }); vi.stubEnv('SPONSOR_REGISTRY', text); vi.stubEnv('SPONSOR_REGISTRY_SIG', signSponsorRegistry(text, key)); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-12T12:00:00Z')); vi.stubEnv('SPONSOR_TRIALS_ENABLED', '1'); vi.stubEnv('SPONSOR_KEY', key); vi.stubEnv('SPONSOR_REGISTRY_KEY', key); vi.stubEnv('BILLING_PUBLIC_STANDARD_TRIAL', '0'); registry(); });
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('campaign-only retry handoff', () => {
    it('retains signed campaign with public offer off, no raw opaque token or provider identity', () => {
        const c = sponsorFromCoupon('staging-qa')!, value = sponsorEntryContext(c, origin);
        expect(sponsorFromEntryContext(value, origin)?.campaignId).toBe(c.campaignId);
        const body = Buffer.from(value.split('.')[0]!, 'base64url').toString();
        expect(body).not.toContain(token); expect(body).not.toContain('auth0|');
        expect(sponsorFromTransaction(value, origin, 'state', 'nonce')).toBeNull();
    });
    it('different origin, signature corruption, and normal OAuth context cannot be reused as an entry', () => {
        const c = sponsorFromCoupon('staging-qa')!, value = sponsorEntryContext(c, origin);
        expect(sponsorFromEntryContext(value, 'https://other.ezil.work')).toBeNull();
        expect(sponsorFromEntryContext(value.slice(0, -2)+'zz', origin)).toBeNull();
        expect(sponsorFromEntryContext(loginSponsorContext(c, origin, 'state', 'nonce'), origin)).toBeNull();
    });
    it('expires server-side at ten minutes even if the browser keeps stale bytes', () => {
        const value = sponsorEntryContext(sponsorFromCoupon('staging-qa')!, origin);
        vi.advanceTimersByTime(600_001); expect(sponsorFromEntryContext(value, origin)).toBeNull();
    });
    it.each(['disabled', 'config_changed', 'expired'] as const)('fresh signed registry %s refuses stale selection', kind => {
        const value = sponsorEntryContext(sponsorFromCoupon('staging-qa')!, origin);
        registry(kind === 'disabled' ? { ...entry, enabled: false } : kind === 'config_changed' ? { ...entry, version: 2 } : { ...entry, expiresAt: '2026-11-12T11:59:00Z' });
        expect(sponsorFromEntryContext(value, origin)).toBeNull();
    });
});
