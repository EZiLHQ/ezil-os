import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const stub = vi.hoisted(() => ({ token: vi.fn(), coupon: vi.fn(), authorize: vi.fn(), user: vi.fn() }));
vi.mock('@/server/auth/sponsor-entry', () => ({ sponsorEntryAvailable: stub.token, sponsorCouponEntryAvailable: stub.coupon }));
vi.mock('@/server/auth/auth0', () => ({ AUTH0_COOKIE: '__Host-ezil-auth0', AUTH0_COOKIE_OPTIONS: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }, Auth0Error: class extends Error {}, buildAuthorizeUrl: stub.authorize }));
vi.mock('@/server/auth/sponsor', () => ({ sponsorFromLink: () => ({ campaignId: 'fixture' }), sponsorFromCoupon: () => ({ campaignId: 'fixture' }), materializeSponsorAttribution: vi.fn(), sponsorSubjectSupported: () => true }));
vi.mock('@/server/auth/sponsor-entry-context', () => ({ SPONSOR_ENTRY_COOKIE: '__Host-ezil-sponsor-entry', SPONSOR_ENTRY_COOKIE_OPTIONS: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }, sponsorEntryContext: () => 'signed-campaign' }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: stub.user } }) }));
import { GET } from './coupon/route';
import { POST } from './continue/route';
const origin = 'https://os-staging.ezil.work';
beforeEach(() => { vi.resetAllMocks(); stub.coupon.mockResolvedValue(true); stub.token.mockResolvedValue(true); stub.authorize.mockResolvedValue(new URL('https://id.ezil.work/authorize?state=fixture')); stub.user.mockResolvedValue({ data: { user: null }, error: null }); });
function post(body = 'coupon=staging-qa', headers: Record<string,string> = {}) {
    return new NextRequest(origin+'/sponsor/continue', { method: 'POST', body, headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers } });
}
describe('direct coupon entry retains strict input/POST boundaries', () => {
    it.each(['', '?coupon=', '?coupon=staging-qa&coupon=staging-qa', '?coupon=../bad', '?coupon=staging-qa&token=', '?coupon=staging-qa&%74oken=x', '?coupon=staging-qa&padding='+ 'x'.repeat(2048)])('invalid query %j cannot select an attribution', async query => {
        const r = await GET(new NextRequest(origin+'/sponsor/coupon'+query, { headers: { accept: 'text/html' } }));
        expect(r.status).toBe(303); expect(await r.text()).toBe('');
        expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.token).not.toHaveBeenCalled();
        expect(stub.authorize).toHaveBeenCalledExactlyOnceWith({ origin, returnUrl: '/os?settings=billing&coupon_entry=unavailable' });
    });
    it('already-open old invitation forms use the same direct Auth0 flow', async () => {
        const r = await POST(post()); expect(r.status).toBe(303); expect(r.headers.get('location')).toBe('https://id.ezil.work/authorize?state=fixture');
        expect(stub.authorize).toHaveBeenCalledExactlyOnceWith({ origin, returnUrl: '/os?settings=billing', sponsorCoupon: 'staging-qa' });
    });
    it.each(['https://evil.example', 'https://other.ezil.work', 'null', ''])('Origin %j refuses before body/auth/DB', async bad => {
        expect((await POST(post(undefined, { origin: bad }))).status).toBe(403);
        expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled(); expect(stub.user).not.toHaveBeenCalled();
    });
    it.each(['coupon=staging-qa&coupon=staging-qa', 'coupon=staging-qa&token='+ 't'.repeat(43), 'coupon=staging-qa&returnUrl=https://evil.example', 'coupon[]=staging-qa', 'coupon=%FF'])('bad form %j cannot supply campaign or redirect', async body => {
        const r = await POST(post(body)); expect(r.status).toBe(303);
        expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.token).not.toHaveBeenCalled();
        expect(stub.authorize).not.toHaveBeenCalled(); expect(stub.user).not.toHaveBeenCalled(); expect(r.headers.get('location')).toBe(origin+'/os?settings=billing&coupon_entry=unavailable');
    });
    it.each([{}, { 'content-length': '1' }] as Record<string, string>[])('bounds actual streamed bytes despite declared length %j', async headers => {
        await POST(post('coupon=staging-qa&padding='+ 'x'.repeat(3000), headers));
        expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled(); expect(stub.user).not.toHaveBeenCalled();
    });
    it.each(['2049', 'NaN', '-1'])('invalid declared length %j refuses before auth', async length => {
        expect((await POST(post(undefined, { 'content-length': length }))).status).toBe(403); expect(stub.authorize).not.toHaveBeenCalled(); expect(stub.user).not.toHaveBeenCalled();
    });
    it('supports owned HTTPS behind the internal Next listener without trusting a foreign forwarded host', async () => {
        const r = new NextRequest('http://0.0.0.0:3000/sponsor/continue', { method: 'POST', body: 'coupon=staging-qa', headers: { origin, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'os-staging.ezil.work', 'content-type': 'application/x-www-form-urlencoded' } });
        expect((await POST(r)).status).toBe(303); expect(stub.authorize).toHaveBeenCalledWith({ origin, returnUrl: '/os?settings=billing', sponsorCoupon: 'staging-qa' });
    });
});
