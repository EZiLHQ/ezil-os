import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const stub = vi.hoisted(() => ({ available: vi.fn(), coupon: vi.fn(), authorize: vi.fn(), fromLink: vi.fn(), fromCoupon: vi.fn(), materialize: vi.fn(), user: vi.fn(), context: vi.fn() }));
vi.mock('@/server/auth/sponsor-entry', () => ({ sponsorEntryAvailable: stub.available, sponsorCouponEntryAvailable: stub.coupon }));
vi.mock('@/server/auth/auth0', () => ({ AUTH0_COOKIE: '__Host-ezil-auth0', AUTH0_COOKIE_OPTIONS: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }, Auth0Error: class extends Error {}, buildAuthorizeUrl: stub.authorize }));
vi.mock('@/server/auth/sponsor', () => ({ sponsorFromLink: stub.fromLink, sponsorFromCoupon: stub.fromCoupon, materializeSponsorAttribution: stub.materialize, sponsorSubjectSupported: (s: string) => /^[\x21-\x7e]{1,255}$/.test(s) }));
vi.mock('@/server/auth/sponsor-entry-context', () => ({ SPONSOR_ENTRY_COOKIE: '__Host-ezil-sponsor-entry', SPONSOR_ENTRY_COOKIE_OPTIONS: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }, sponsorEntryContext: stub.context }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: stub.user } }) }));
import { GET as tokenGet } from './[token]/route';
import { GET as couponGet } from './coupon/route';
const origin = 'https://os-staging.ezil.work', token = 't'.repeat(43), campaign = { campaignId: 'fixture-campaign', partnerId: 'staging-qa' };
const signedUser = { id: 'existing', app_metadata: { auth0_sub: 'auth0|fixture' } };
function get(kind: 'coupon' | 'token', query = '') { return kind === 'coupon'
    ? couponGet(new NextRequest(origin+'/sponsor/coupon?coupon=staging-qa'+query, { headers: { accept: 'text/html' } }))
    : tokenGet(new NextRequest(origin+'/sponsor/'+token+query, { headers: { accept: 'text/html' } }), { params: Promise.resolve({ token }) }); }
beforeEach(() => { vi.resetAllMocks(); stub.available.mockResolvedValue(true); stub.coupon.mockResolvedValue(true); stub.fromLink.mockReturnValue(campaign); stub.fromCoupon.mockReturnValue(campaign); stub.user.mockResolvedValue({ data: { user: null }, error: null }); stub.context.mockReturnValue('signed-campaign-only'); stub.authorize.mockResolvedValue(new URL('https://id.ezil.work/authorize?state=synthetic')); });
describe('direct coupon and opaque invitations', () => {
    it.each(['coupon', 'token'] as const)('anonymous %s goes to ordinary Auth0 without a separate landing or provider token', async kind => {
        const r = await get(kind);
        expect(r.status).toBe(303); expect(r.headers.get('location')).toBe('https://id.ezil.work/authorize?state=synthetic'); expect(await r.text()).toBe('');
        expect(stub.authorize).toHaveBeenCalledExactlyOnceWith({ origin, returnUrl: '/os?settings=billing', ...(kind === 'coupon' ? { sponsorCoupon: 'staging-qa' } : { sponsorToken: token }) });
        expect(r.headers.get('location')).not.toContain(token); expect(r.headers.get('referrer-policy')).toBe('no-referrer'); expect(r.headers.get('cache-control')).toBe('no-store');
        expect(r.cookies.get('__Host-ezil-sponsor-entry')).toMatchObject({ value: 'signed-campaign-only', httpOnly: true, secure: true, sameSite: 'lax', path: '/', maxAge: 600 });
    });
    it.each(['coupon', 'token'] as const)('signed-in %s preserves account, attributes only, and opens Billing', async kind => {
        stub.user.mockResolvedValue({ data: { user: signedUser }, error: null });
        const r = await get(kind);
        expect(r.headers.get('location')).toBe(origin+'/os?settings=billing'); expect(stub.authorize).not.toHaveBeenCalled();
        expect(stub.materialize).toHaveBeenCalledExactlyOnceWith({ userId: signedUser.id, verifiedSubject: 'auth0|fixture', metadata: signedUser.app_metadata, campaign });
        expect(r.cookies.get('__Host-ezil-sponsor-entry')?.maxAge).toBe(0);
    });
    it('never accepts user-editable metadata as an Auth0 identity or switches an unlinked account', async () => {
        stub.user.mockResolvedValue({ data: { user: { id: 'legacy', app_metadata: {}, user_metadata: { auth0_sub: 'forged' } } }, error: null });
        const r = await get('coupon'); expect(r.headers.get('location')).toBe(origin+'/os?settings=billing&coupon_entry=identity_required');
        expect(stub.materialize).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled();
    });
    it('SQL refusal stays in Billing with a safe reason and never falls back to another auth account', async () => {
        stub.user.mockResolvedValue({ data: { user: signedUser }, error: null }); stub.materialize.mockRejectedValue(new Error('private SQL detail'));
        const r = await get('coupon'); expect(r.headers.get('location')).toBe(origin+'/os?settings=billing&coupon_entry=unavailable'); expect(stub.authorize).not.toHaveBeenCalled(); expect(await r.text()).not.toContain('private');
    });
    it('a missing session is anonymous, but unavailable identity service cannot start an account switch', async () => {
        stub.user.mockResolvedValueOnce({ data: { user: null }, error: { name: 'AuthSessionMissingError' } });
        expect((await get('coupon')).headers.get('location')).toContain('id.ezil.work');
        stub.authorize.mockClear(); stub.user.mockResolvedValueOnce({ data: { user: signedUser }, error: { name: 'AuthRetryableFetchError' } });
        expect((await get('coupon')).headers.get('location')).toBe(origin+'/os?settings=billing&coupon_entry=unavailable'); expect(stub.authorize).not.toHaveBeenCalled(); expect(stub.materialize).not.toHaveBeenCalled();
    });
    it.each(['coupon', 'token'] as const)('inactive %s continues normal sign-in to a fixed unavailable Billing status', async kind => {
        stub.available.mockResolvedValue(false); stub.coupon.mockResolvedValue(false);
        const r = await get(kind); expect(stub.authorize).toHaveBeenCalledExactlyOnceWith({ origin, returnUrl: '/os?settings=billing&coupon_entry=unavailable' });
        expect(stub.context).not.toHaveBeenCalled(); expect(stub.materialize).not.toHaveBeenCalled(); expect(r.cookies.get('__Host-ezil-sponsor-entry')?.maxAge).toBe(0);
    });
    it.each(['?coupon=staging-qa', '?token=another', '?%63oupon=staging-qa'])('opaque mixed selection %j cannot resolve or attribute', async query => {
        await get('token', query); expect(stub.available).not.toHaveBeenCalled(); expect(stub.fromLink).not.toHaveBeenCalled(); expect(stub.materialize).not.toHaveBeenCalled();
        expect(stub.authorize).toHaveBeenCalledWith({ origin, returnUrl: '/os?settings=billing&coupon_entry=unavailable' });
    });
    it('caller redirect and price inputs cannot alter the destination or campaign', async () => {
        stub.user.mockResolvedValue({ data: { user: signedUser }, error: null });
        expect((await get('coupon', '&returnUrl=https://evil.example&price=1')).headers.get('location')).toBe(origin+'/os?settings=billing');
    });
});

it.each([{ 'sec-fetch-dest': 'image' }, { 'sec-fetch-dest': 'iframe' }, { 'sec-fetch-dest': 'empty', accept: 'text/html' }, { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'cors' }, {}] as Record<string,string>[])('non-document request %j refuses before identity/attribution/OAuth', async headers => {
    const r = await couponGet(new NextRequest(origin+'/sponsor/coupon?coupon=staging-qa', { headers }));
    expect(r.status).toBe(403); expect(stub.user).not.toHaveBeenCalled(); expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled(); expect(stub.materialize).not.toHaveBeenCalled();
});
it('native document navigation with real fetch metadata enters the direct flow', async () => {
    const r = await couponGet(new NextRequest(origin+'/sponsor/coupon?coupon=staging-qa', { headers: { 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' } }));
    expect(r.status).toBe(303); expect(stub.authorize).toHaveBeenCalledWith({ origin, returnUrl: '/os?settings=billing', sponsorCoupon: 'staging-qa' });
});
