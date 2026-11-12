import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
vi.mock('server-only', () => ({}));
const stub = vi.hoisted(() => ({ set: vi.fn(), exchange: vi.fn(), verify: vi.fn(), bridge: vi.fn(), retain: vi.fn() }));
vi.mock('next/headers', () => ({ cookies: async () => ({ set: stub.set }) }));
vi.mock('@/server/auth/auth0', async original => ({ ...await original<typeof import('@/server/auth/auth0')>(), exchangeCode: stub.exchange, verifyIdToken: stub.verify }));
vi.mock('@/server/auth/bridge', () => ({ bridgeAuth0Identity: stub.bridge, refuseSilentAccountSwitch: vi.fn() }));
vi.mock('@/server/auth/retained-identity', () => ({ retainProjectIdentity: stub.retain }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null }, error: null }) } }) }));
import { AUTH0_COOKIE, buildAuthorizeUrl, readTransaction } from '@/server/auth/auth0';
import { hashSponsorToken, signSponsorRegistry } from '@/server/billing/v3/sponsor';
import { GET } from './route';
const token = 't'.repeat(43), origin = 'https://os-staging.ezil.work', key = 'synthetic-callback-key-'.repeat(3);
let cookie: string, state: string;
function registry(enabled = true) {
    const document = JSON.stringify({ v: 1, campaigns: [{ campaignId: 'fixture-campaign', partnerId: 'fixture-partner', version: 1, enabled,
        startsAt: '2026-11-01T00:00:00Z', expiresAt: '2026-12-01T00:00:00Z', tokenSha256: hashSponsorToken(token) }] });
    vi.stubEnv('SPONSOR_REGISTRY', document); vi.stubEnv('SPONSOR_REGISTRY_SIG', signSponsorRegistry(document, key));
}
beforeEach(async () => {
    vi.resetAllMocks(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-11T12:00:00Z'));
    vi.stubEnv('AUTH0_CLIENT_ID', 'synthetic-client'); vi.stubEnv('AUTH0_SECRET_ID', 'synthetic-secret');
    vi.stubEnv('SPONSOR_TRIALS_ENABLED', '1'); vi.stubEnv('SPONSOR_KEY', key); vi.stubEnv('SPONSOR_REGISTRY_KEY', key); registry();
    stub.exchange.mockResolvedValue('synthetic-token'); stub.verify.mockResolvedValue({ sub: 'auth0|fixture', email: 'fixture@example.invalid' });
    const url = await buildAuthorizeUrl({ origin, sponsorToken: token, returnUrl: 'https://evil.example' });
    state = url.searchParams.get('state')!; cookie = stub.set.mock.calls.at(-1)![1];
    expect(url.toString()).not.toContain(token); expect(cookie).not.toContain(token);
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); vi.restoreAllMocks(); });
function request(value = cookie, host = origin) {
    return new NextRequest(`${host}/auth/auth0/callback?state=${state}&code=synthetic-code&campaignId=attacker&returnUrl=https://evil.example`, { headers: { cookie: `${AUTH0_COOKIE}=${value}` } });
}
describe('signed sponsor OAuth transaction consumption', () => {
    it('uses signed origin/state/nonce and fixed billing intent, then clears browser transaction so replay cannot bridge again', async () => {
        const tx = readTransaction(cookie, state, origin);
        expect(tx.returnUrl).toBe('/os?settings=billing');
        const response = await GET(request());
        expect(response.headers.get('location')).toBe(`${origin}/os?settings=billing`);
        expect(stub.bridge).toHaveBeenCalledWith({ sub: 'auth0|fixture', email: 'fixture@example.invalid' }, expect.objectContaining({ campaignId: 'fixture-campaign' }));
        expect(response.cookies.get(AUTH0_COOKIE)?.maxAge).toBe(0);
        expect(response.cookies.get('__Host-ezil-sponsor-entry')?.maxAge).toBe(0);
        stub.exchange.mockClear(); stub.bridge.mockClear();
        await GET(request(response.cookies.get(AUTH0_COOKIE)!.value));
        expect(stub.exchange).not.toHaveBeenCalled(); expect(stub.bridge).not.toHaveBeenCalled();
    });
    it.each(['tamper', 'expired', 'origin', 'revoked'])('refuses %s before token exchange and account attribution', async kind => {
        let value = cookie, host = origin;
        if (kind === 'tamper') value += 'x';
        if (kind === 'expired') vi.setSystemTime(new Date('2026-11-11T12:10:01Z'));
        if (kind === 'origin') host = 'https://os.ezil.org';
        if (kind === 'revoked') registry(false);
        const response = await GET(request(value, host));
        expect(stub.exchange).not.toHaveBeenCalled(); expect(stub.bridge).not.toHaveBeenCalled();
        expect(response.cookies.get(AUTH0_COOKIE)?.maxAge).toBe(0);
    });
    it('revalidates campaign after token verification before bridging verified account', async () => {
        stub.verify.mockImplementation(async () => { registry(false); return { sub: 'auth0|fixture', email: 'fixture@example.invalid' }; });
        await GET(request());
        expect(stub.exchange).toHaveBeenCalledOnce(); expect(stub.verify).toHaveBeenCalledOnce(); expect(stub.bridge).not.toHaveBeenCalled();
    });
});
