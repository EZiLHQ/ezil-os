import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
const jar = vi.hoisted(() => ({ set: vi.fn(), get: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => jar }));
import { hashSponsorToken, signSponsorRegistry } from '@/server/billing/v3/sponsor';
import { AUTH0_COOKIE, buildAuthorizeUrl, readTransaction } from './auth0';
import { sponsorFromCoupon } from './sponsor';
import { sponsorEntryContext, SPONSOR_ENTRY_COOKIE } from './sponsor-entry-context';
import { NextRequest } from 'next/server';
vi.mock('@/server/auth/bridge', () => ({ bridgeAuth0Identity: vi.fn(), refuseSilentAccountSwitch: vi.fn() }));
vi.mock('@/server/auth/retained-identity', () => ({ retainProjectIdentity: vi.fn() }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }) }));
import { GET as callback } from '@/app/auth/auth0/callback/route';
const origin = 'https://os-staging.ezil.work', key = 'synthetic-context-key-'.repeat(3), token = 't'.repeat(43);
const campaign = { campaignId: 'fixture-campaign', partnerId: 'staging-qa', version: 2, enabled: true, startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', tokenSha256: hashSponsorToken(token) };
function registry(entry = campaign) { const document = JSON.stringify({ v: 1, campaigns: [entry] }); vi.stubEnv('SPONSOR_REGISTRY', document); vi.stubEnv('SPONSOR_REGISTRY_SIG', signSponsorRegistry(document, key)); }
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T12:00:00Z')); jar.set.mockReset(); jar.get.mockReset(); vi.stubEnv('AUTH0_CLIENT_ID', 'fixture'); vi.stubEnv('AUTH0_SECRET_ID', 'fixture-auth-secret'); vi.stubEnv('SPONSOR_TRIALS_ENABLED', '1'); vi.stubEnv('SPONSOR_KEY', key); vi.stubEnv('SPONSOR_REGISTRY_KEY', key); registry(); });
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

describe('normal login retry after a coupon entry', () => {
    it('reseals the trusted selection with fresh OAuth state and nonce without invitation/query propagation', async () => {
        const pending = sponsorEntryContext(sponsorFromCoupon('staging-qa')!, origin);
        jar.get.mockImplementation(name => name === SPONSOR_ENTRY_COOKIE ? { value: pending } : undefined);
        const first = await buildAuthorizeUrl({ origin, returnUrl: '/os?settings=billing' });
        const a = readTransaction(jar.set.mock.calls.at(-1)![1] as string, first.searchParams.get('state'), origin);
        const second = await buildAuthorizeUrl({ origin, returnUrl: '/os?settings=billing' });
        const b = readTransaction(jar.set.mock.calls.at(-1)![1] as string, second.searchParams.get('state'), origin);
        expect(a.sponsor).toBeTruthy(); expect(b.sponsor).toBeTruthy(); expect(a.state).not.toBe(b.state); expect(a.nonce).not.toBe(b.nonce);
        expect(second.toString()).not.toContain(pending); expect(second.toString()).not.toContain(token); expect(second.searchParams.has('coupon')).toBe(false);
    });
    it('silent login keeps its original identity-only policy; its normal interactive fallback recovers the signed selection', async () => {
        const pending = sponsorEntryContext(sponsorFromCoupon('staging-qa')!, origin);
        jar.get.mockImplementation(name => name === SPONSOR_ENTRY_COOKIE ? { value: pending } : undefined);
        const silent = await buildAuthorizeUrl({ origin, returnUrl: '/os?settings=billing', prompt: 'none' });
        const value = jar.set.mock.calls.at(-1)![1] as string;
        expect(readTransaction(value, silent.searchParams.get('state'), origin).sponsor).toBeUndefined();
        const req = new NextRequest(origin+'/auth/auth0/callback?'+new URLSearchParams({ error: 'login_required', state: silent.searchParams.get('state')! }), { headers: { cookie: `${AUTH0_COOKIE}=${value}; ${SPONSOR_ENTRY_COOKIE}=${pending}` } });
        const response = await callback(req), target = new URL(response.headers.get('location')!);
        expect(target.pathname).toBe('/auth/auth0/login'); expect(response.cookies.get(SPONSOR_ENTRY_COOKIE)).toBeUndefined();
        const next = await buildAuthorizeUrl({ origin, returnUrl: target.searchParams.get('returnUrl') });
        expect(readTransaction(jar.set.mock.calls.at(-1)![1] as string, next.searchParams.get('state'), origin).sponsor).toBeTruthy();
    });
    it('tampering, expiry and unrelated return pages cannot carry attribution into ordinary login', async () => {
        const pending = sponsorEntryContext(sponsorFromCoupon('staging-qa')!, origin);
        jar.get.mockReturnValue({ value: pending });
        const unrelated = await buildAuthorizeUrl({ origin, returnUrl: '/app/code' });
        expect(readTransaction(jar.set.mock.calls.at(-1)![1] as string, unrelated.searchParams.get('state'), origin).sponsor).toBeUndefined();
        vi.advanceTimersByTime(600_001);
        const expired = await buildAuthorizeUrl({ origin, returnUrl: '/os?settings=billing' });
        expect(readTransaction(jar.set.mock.calls.at(-1)![1] as string, expired.searchParams.get('state'), origin).sponsor).toBeUndefined();
    });
});
