import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({ campaign: vi.fn(), coupon: vi.fn(), auth: vi.fn(), ready: vi.fn(), load: vi.fn(), db: {} }));
vi.mock('./sponsor', () => ({ sponsorFromLink: stub.campaign, sponsorFromCoupon: stub.coupon }));
vi.mock('./auth0', () => ({ auth0Enabled: stub.auth }));
vi.mock('@/server/billing/v3/sponsor-store', () => ({ sponsorSchemaReady: stub.ready }));
vi.mock('@/server/db', () => { stub.load(); return { db: stub.db }; });
import { sponsorCouponEntryAvailable, sponsorEntryAvailable } from './sponsor-entry';
beforeEach(() => {
    vi.clearAllMocks(); vi.stubEnv('CHECKOUT_ENABLED', '1'); vi.stubEnv('STRIPE_SECRET', 'sk_test_synthetic');
    stub.campaign.mockReturnValue({ campaignId: 'fixture' }); stub.coupon.mockReturnValue({ campaignId: 'fixture' }); stub.auth.mockReturnValue(true); stub.ready.mockResolvedValue(true);
});
afterEach(() => vi.unstubAllEnvs());
describe('sponsor entry readiness', () => {
    it('invalid/disabled/missing-registry campaign does not initialize a DB', async () => {
        stub.campaign.mockReturnValue(null);
        expect(await sponsorEntryAvailable('synthetic')).toBe(false);
        expect(stub.load).not.toHaveBeenCalled(); expect(stub.ready).not.toHaveBeenCalled();
    });
    it('global checkout off does not initialize a DB', async () => {
        vi.stubEnv('CHECKOUT_ENABLED', '0');
        expect(await sponsorEntryAvailable('synthetic')).toBe(false);
        expect(stub.load).not.toHaveBeenCalled(); expect(stub.ready).not.toHaveBeenCalled();
    });
    it('Auth0 unavailable does not initialize a DB', async () => {
        stub.auth.mockReturnValue(false);
        expect(await sponsorEntryAvailable('synthetic')).toBe(false);
        expect(stub.load).not.toHaveBeenCalled(); expect(stub.ready).not.toHaveBeenCalled();
    });
    it('schema absent and probe failure fail closed; present schema permits handoff', async () => {
        stub.ready.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('synthetic failure')).mockResolvedValueOnce(true);
        expect(await sponsorEntryAvailable('synthetic')).toBe(false);
        expect(await sponsorEntryAvailable('synthetic')).toBe(false);
        expect(await sponsorEntryAvailable('synthetic')).toBe(true);
        expect(stub.ready).toHaveBeenLastCalledWith(stub.db);
    });
});

describe('coupon entry shares all normal readiness gates', () => {
    it('unknown or inactive alias cannot initialize sponsor SQL', async () => {
        stub.coupon.mockReturnValue(null);
        expect(await sponsorCouponEntryAvailable('staging-qa')).toBe(false);
        expect(stub.ready).not.toHaveBeenCalled(); expect(stub.load).not.toHaveBeenCalled();
    });
    it('requires normal checkout, Auth0 and existing sponsor schema', async () => {
        vi.stubEnv('CHECKOUT_ENABLED', '0'); expect(await sponsorCouponEntryAvailable('staging-qa')).toBe(false);
        vi.stubEnv('CHECKOUT_ENABLED', '1'); stub.auth.mockReturnValue(false); expect(await sponsorCouponEntryAvailable('staging-qa')).toBe(false);
        stub.auth.mockReturnValue(true); stub.ready.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(true);
        expect(await sponsorCouponEntryAvailable('staging-qa')).toBe(false);
        expect(await sponsorCouponEntryAvailable('staging-qa')).toBe(false);
        expect(await sponsorCouponEntryAvailable('staging-qa')).toBe(true);
    });
});
