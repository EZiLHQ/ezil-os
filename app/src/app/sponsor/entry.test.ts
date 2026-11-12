import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
const stub = vi.hoisted(() => ({ available: vi.fn(), coupon: vi.fn(), authorize: vi.fn() }));
vi.mock('@/server/auth/sponsor-entry', () => ({ sponsorEntryAvailable: stub.available, sponsorCouponEntryAvailable: stub.coupon }));
vi.mock('@/server/auth/auth0', () => ({ AUTH0_ISSUER: 'https://id.ezil.work/', AUTH0_COOKIE: '__Host-ezil-auth0', AUTH0_COOKIE_OPTIONS: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' }, buildAuthorizeUrl: stub.authorize }));
import { GET } from './[token]/route';
import { POST } from './continue/route';
const origin = 'https://os-staging.ezil.work', token = 't'.repeat(43);
beforeEach(() => { vi.resetAllMocks(); stub.available.mockResolvedValue(true); stub.coupon.mockResolvedValue(true); stub.authorize.mockResolvedValue(new URL('https://id.ezil.work/authorize?state=synthetic-state')); });
function post(extra: Record<string,string> = {}) {
    return new NextRequest(`${origin}/sponsor/continue`, { method: 'POST', headers: { origin, 'content-type': 'application/x-www-form-urlencoded', ...extra }, body: new URLSearchParams({ token }) });
}
describe('private sponsor entry document', () => {
    it('shows card and paid renewal disclosure without scripts, analytics or external subresources', async () => {
        const response = await GET(new NextRequest(`${origin}/sponsor/${token}`), { params: Promise.resolve({ token }) });
        const html = await response.text();
        expect(response.status).toBe(200);
        expect(html).toContain('A card is required.'); expect(html).toContain('$20/month'); expect(html).toContain('unless you cancel');
        expect(html).toContain('method="post" action="/sponsor/continue"');
        expect(html).not.toMatch(/<script|analytics|src=|href="https:/i);
        expect(response.headers.get('referrer-policy')).toBe('strict-origin');
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-security-policy')).toContain("default-src 'none'");
        expect(response.headers.get('content-security-policy')).toContain("form-action 'self' https://id.ezil.work;");
    });
    it('unavailable invitation reveals no token or campaign in document and offers ordinary sign in', async () => {
        stub.available.mockResolvedValue(false);
        const response = await GET(new NextRequest(`${origin}/sponsor/${token}`), { params: Promise.resolve({ token }) });
        const html = await response.text();
        expect(response.status).toBe(404); expect(html).not.toContain(token); expect(html).toContain('href="/login"');
    });
    it('moves raw token only through same-origin body, never provider URL', async () => {
        const response = await POST(post());
        expect(stub.authorize).toHaveBeenCalledWith({ origin, sponsorToken: token });
        expect(response.status).toBe(303);
        expect(response.headers.get('location')).not.toContain(token);
        expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    });
    it.each(['https://evil.example', 'https://other.ezil.work', 'null', ''])('refuses another/missing origin %j before auth and DB', async badOrigin => {
        const response = await POST(post({ origin: badOrigin }));
        expect(response.status).toBe(403); expect(stub.available).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled();
    });
    it('expired/disabled/schema-absent invitation does not start auth and clears prior transaction', async () => {
        stub.available.mockResolvedValue(false);
        const response = await POST(post());
        expect(stub.authorize).not.toHaveBeenCalled();
        expect(response.cookies.get('__Host-ezil-auth0')?.maxAge).toBe(0);
        expect(response.headers.get('location')).toBe(`${origin}/login?error=sponsor_unavailable`);
    });
});

it.each(['?coupon=staging-qa', '?token=another', '?%63oupon=staging-qa'])('legacy opaque link refuses extra URL selection %j', async query => {
    const r = await GET(new NextRequest(origin+'/sponsor/'+token+query), { params: Promise.resolve({ token }) });
    expect(r.status).toBe(404); expect(stub.available).not.toHaveBeenCalled(); expect(stub.authorize).not.toHaveBeenCalled();
});
