import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const stub = vi.hoisted(() => ({ token: vi.fn(), coupon: vi.fn(), authorize: vi.fn() }));
vi.mock('@/server/auth/sponsor-entry', () => ({ sponsorEntryAvailable: stub.token, sponsorCouponEntryAvailable: stub.coupon }));
vi.mock('@/server/auth/auth0', () => ({ AUTH0_ISSUER: 'https://id.ezil.work/', AUTH0_COOKIE: '__Host-ezil-auth0', AUTH0_COOKIE_OPTIONS: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }, buildAuthorizeUrl: stub.authorize }));
import { GET } from './coupon/route';
import { POST } from './continue/route';
const origin = 'https://os-staging.ezil.work';
beforeEach(() => { vi.resetAllMocks(); stub.coupon.mockResolvedValue(true); stub.token.mockResolvedValue(true); stub.authorize.mockResolvedValue(new URL('https://id.ezil.work/authorize?state=fixture')); });
function post(body = 'coupon=staging-qa', headers: Record<string,string> = {}) {
    return new NextRequest(origin+'/sponsor/continue', { method: 'POST', body, headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...headers } });
}
describe('friendly coupon document and existing consent', () => {
    it('shows card/$20 renewal terms and posts only alias after a click', async () => {
        const r = await GET(new NextRequest(origin+'/sponsor/coupon?coupon=staging-qa'));
        const html = await r.text();
        expect(r.status).toBe(200); expect(html).toContain('A card is required.'); expect(html).toContain('$20/month'); expect(html).toContain('unless you cancel');
        expect(html).toContain('name="coupon" value="staging-qa"'); expect(html).toContain('method="post" action="/sponsor/continue"');
        expect(html).not.toMatch(/<script|analytics|src=|href="https:/i);
        expect(r.headers.get('cache-control')).toBe('no-store'); expect(r.headers.get('referrer-policy')).toBe('strict-origin');
        expect(r.headers.get('content-security-policy')).toContain("form-action 'self' https://id.ezil.work;");
        expect(stub.authorize).not.toHaveBeenCalled();
    });
    it.each(['', '?coupon=', '?coupon=staging-qa&coupon=staging-qa', '?coupon=%3Cscript%3E', '?coupon=staging-qa&token=', '?coupon=staging-qa&%74oken=t', '?coupon='+ 'x'.repeat(65), '?coupon=staging-qa&x='+ 'x'.repeat(2048)])('invalid query %j cannot probe SQL/auth', async query => {
        const r = await GET(new NextRequest(origin+'/sponsor/coupon'+query));
        expect(r.status).toBe(404); expect(await r.text()).not.toContain('name="coupon"');
        expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled();
    });
    it('unknown/disabled/expired alias is unavailable without reflecting it', async () => {
        stub.coupon.mockResolvedValue(false);
        const r = await GET(new NextRequest(origin+'/sponsor/coupon?coupon=unregistered'));
        expect(r.status).toBe(404); expect(await r.text()).not.toContain('unregistered');
    });
    it('continues through existing Auth0', async () => {
        const r = await POST(post());
        expect(stub.authorize).toHaveBeenCalledExactlyOnceWith({ origin, sponsorCoupon: 'staging-qa' });
        expect(r.status).toBe(303); expect(r.headers.get('location')).toBe('https://id.ezil.work/authorize?state=fixture');
    });
    it.each(['https://evil.example', 'null', ''])('origin %j refuses before campaign/auth', async bad => {
        expect((await POST(post(undefined, { origin: bad }))).status).toBe(403);
        expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled();
    });
    it.each(['coupon=staging-qa&coupon=staging-qa', 'coupon=staging-qa&token='+ 't'.repeat(43), 'coupon=staging-qa&returnUrl=https://evil.example', 'coupon[]=staging-qa', 'coupon=%FF'])('bad form %j refuses before auth/DB', async body => {
        const r = await POST(post(body));
        expect(r.headers.get('location')).toBe(origin+'/login?error=sponsor_unavailable'); expect(r.cookies.get('__Host-ezil-auth0')?.maxAge).toBe(0);
        expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.token).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled();
    });
    it.each([{}, { 'content-length': '1' }] as Record<string, string>[])('bounds actual bytes with length %j', async headers => {
        const r = await POST(post('coupon=staging-qa&padding='+ 'x'.repeat(3000), headers));
        expect(r.headers.get('location')).toBe(origin+'/login?error=sponsor_unavailable');
        expect(stub.coupon).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled();
    });
    it.each(['2049', 'NaN', '-1'])('declared length %j refuses', async length => {
        expect((await POST(post(undefined, { 'content-length': length }))).status).toBe(403); expect(stub.authorize).not.toHaveBeenCalled();
    });
});

it('supports the normal HTTPS origin behind the internal Next listener', async () => {
    const r = new NextRequest('http://0.0.0.0:3000/sponsor/continue', { method: 'POST', body: 'coupon=staging-qa', headers: { origin, 'x-forwarded-proto': 'https', 'x-forwarded-host': 'os-staging.ezil.work', 'content-type': 'application/x-www-form-urlencoded' } });
    expect((await POST(r)).status).toBe(303);
    expect(stub.authorize).toHaveBeenCalledWith({ origin, sponsorCoupon: 'staging-qa' });
});

it('never derives CSP form destinations from query or forwarded host', async () => {
    const r = await GET(new NextRequest(origin+'/sponsor/coupon?coupon=staging-qa&returnUrl=https://evil.example', { headers: { 'x-forwarded-host': 'evil.example', 'x-forwarded-proto': 'https' } }));
    const directives = r.headers.get('content-security-policy')!.split(';').map(value => value.trim()).filter(value => value.startsWith('form-action'));
    expect(directives).toEqual(["form-action 'self' https://id.ezil.work"]);
    expect(r.headers.get('content-security-policy')).not.toContain('evil.example');
});
