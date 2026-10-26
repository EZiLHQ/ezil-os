import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VerifiedDelegatedAccount, DelegatedAccountDeps } from '../delegated-account';
import type { SubscriptionRow } from '../meters';
import { projectRestEntitlement, restEntitlement, teamBillingUnavailable } from './rest-entitlement';
import { GET as entitlementGET } from '@/app/api/billing/v3/entitlement/route';
import { GET as teamsGET } from '@/app/api/billing/v3/teams/mine/route';
import { POST as seatsPOST } from '@/app/api/billing/v3/teams/[id]/seats/route';

vi.mock('server-only', () => ({}));
const composition = vi.hoisted(() => ({ getBillingDeps: vi.fn() }));
vi.mock('@/server/billing/deps', () => composition);
vi.mock('@/utils/supabase/server', () => ({ createClient: () => { throw new Error('cookie auth forbidden'); } }));

// Deliberately fictitious, non-secret fixtures. No token claims are decoded here.
const SUBJECT = 'a1b2c3d4-1111-4111-8111-111111111111';
const OTHER = 'b1b2c3d4-2222-4222-8222-222222222222';
const WORKS = 'c1b2c3d4-3333-4333-8333-333333333333';
const GRANT = 'd1b2c3d4-4444-4444-8444-444444444444';
const POLICY = 'e1b2c3d4-5555-4555-8555-555555555555';
const SERVICE = `ezs_${'s'.repeat(48)}`;
const TOKEN = `ezg_${'g'.repeat(48)}`;
const PROOF = 'genuine-api-access-token-fixture';
const ISSUER = 'https://stage-auth.example.test/auth/v1';
const NOW = new Date('2026-10-26T06:00:00.000Z');
const account = (wallet: Partial<VerifiedDelegatedAccount['wallet']> = {}): VerifiedDelegatedAccount => ({
    environment: 'staging',
    identity: { issuer: ISSUER, subject: SUBJECT, account_public_id: WORKS },
    wallet: { state: 'ok', available_micro: '1000001', held_micro: '0', ...wallet },
});
const subscription = (overrides: Partial<SubscriptionRow> = {}): SubscriptionRow => ({
    stripeSubscriptionId: 'sub_fixture', sku: 'standard_monthly_v3', status: 'active',
    currentPeriodStart: new Date('2026-10-01T00:00:00Z'), currentPeriodEnd: new Date('2026-11-01T00:00:00Z'),
    cancelAtPeriodEnd: false, ...overrides,
});

function gateway(value = account()) {
    return vi.fn<typeof fetch>().mockResolvedValueOnce(Response.json({
        token_type: 'Bearer', access_token: TOKEN, grant_id: GRANT, expires_at: '2026-10-26T06:01:00.000Z',
    }, { status: 201 })).mockResolvedValueOnce(Response.json({ object: 'delegated_self', ...value }));
}

function fixture(value = account(), subs = [subscription()]) {
    const fetcher = gateway(value);
    const delegation: DelegatedAccountDeps = {
        config: { fundingUrl: 'https://ai-staging.ezil.work', serviceToken: SERVICE, policyId: POLICY,
            environment: 'staging', supabaseIssuer: ISSUER },
        fetch: fetcher, now: () => NOW,
    };
    const subscriptionsFor = vi.fn().mockResolvedValue(subs);
    const forbidden = vi.fn(() => { throw new Error('Unexpected billing operation'); });
    const store = new Proxy({ subscriptionsFor }, {
        get(target, key) { return key === 'subscriptionsFor' ? target.subscriptionsFor : forbidden(); },
    });
    const billing = vi.fn(() => ({ store, now: () => NOW }));
    return { fetcher, delegation, subscriptionsFor, forbidden, billing, deps: { delegation, billing } };
}

function request(path = '/api/billing/v3/entitlement', init: RequestInit = {}) {
    return new Request(`https://os-staging.ezil.work${path}`, {
        headers: { Authorization: `Bearer ${PROOF}` }, ...init,
    });
}

afterEach(() => {
    vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); composition.getBillingDeps.mockReset();
});

describe('pure delegated REST entitlement projection', () => {
    it.each([
        ['1', 'ok', 0.000001, 'warning'], ['999999', 'ok', 0.999999, 'warning'],
        ['1000001', 'ok', 1.000001, 'warning'], ['400000000', 'ok', 400, 'warning'],
        ['400000001', 'ok', 400.000001, 'ok'], ['0', 'exhausted', 0, 'exhausted'],
    ] as const)('preserves %s microcredits with wallet %s', (micro, walletState, balance, state) => {
        expect(projectRestEntitlement(account({ available_micro: micro, state: walletState }), [subscription()], NOW)).toEqual({
            plan: { sku: 'standard_monthly_v3', tier: 'standard', team: null }, compute: null, ai: { balance, state },
        });
    });

    it('uses the approved Premium grant threshold, including its exact microcredit boundary', () => {
        for (const [micro, state] of [['2000000000', 'warning'], ['2000000001', 'ok']] as const) {
            expect(projectRestEntitlement(account({ available_micro: micro }), [subscription({ sku: 'premium_monthly_v3' })], NOW))
                .toMatchObject({ plan: { sku: 'premium_monthly_v3', tier: 'premium', team: null }, ai: { state } });
        }
    });

    it.each(['paused_reconciliation', 'paused_operations'] as const)('returns unknown AI during %s even with a positive balance', state => {
        expect(projectRestEntitlement(account({ state }), [subscription()], NOW)?.ai).toBeNull();
    });

    it('does not subtract held funds twice or round an unrepresentable number', () => {
        expect(projectRestEntitlement(account({ held_micro: '999999999999' }), [subscription()], NOW)?.ai?.balance).toBe(1.000001);
        for (const available_micro of ['9007199254740991', '9007199254740992000000', '9'.repeat(100)]) {
            expect(projectRestEntitlement(account({ available_micro }), [subscription()], NOW)?.ai).toBeNull();
        }
    });

    it('does not advertise contradictory or unknown wallet states', () => {
        expect(projectRestEntitlement(account({ state: 'exhausted', available_micro: '1' }), [subscription()], NOW)?.ai).toBeNull();
        expect(projectRestEntitlement(account({ state: 'ok', available_micro: '0' }), [subscription()], NOW)?.ai).toBeNull();
        expect(projectRestEntitlement(account({ state: 'unknown' as 'ok' }), [subscription()], NOW)?.ai).toBeNull();
    });

    it.each([
        [], [subscription({ sku: 'free_v3' })], [subscription({ sku: 'pro_monthly_v1' })],
        [subscription({ sku: 'standard_monthly_v2' })], [subscription({ sku: 'unapproved_v4' })],
        [subscription({ currentPeriodEnd: new Date('2026-10-25T00:00:00Z') })],
        [subscription({ currentPeriodStart: new Date('2026-10-27T00:00:00Z') })],
        [subscription({ status: 'canceled' })], [subscription({ status: 'active', currentPeriodStart: null })],
    ].map(subs => ({ subs })))('never substitutes Free for missing or unsupported local plan evidence %#', ({ subs }) => {
        expect(projectRestEntitlement(account(), subs, NOW)).toBeNull();
    });

    it('retains canonical current-plan precedence over a later delinquent subscription', () => {
        const current = subscription();
        const later = subscription({ stripeSubscriptionId: 'sub_later', sku: 'premium_monthly_v3', status: 'past_due',
            currentPeriodEnd: new Date('2026-12-01T00:00:00Z') });
        const subs = [later, current];
        expect(projectRestEntitlement(account(), subs, NOW)?.plan.sku).toBe('standard_monthly_v3');
        expect(subs).toEqual([later, current]);
    });

    it('keeps delinquent plan metadata without claiming compute admission', () => {
        expect(projectRestEntitlement(account(), [subscription({ status: 'incomplete' })], NOW))
            .toMatchObject({ plan: { sku: 'standard_monthly_v3' }, compute: null });
        expect(projectRestEntitlement(account(), [subscription()], new Date('invalid'))).toBeNull();
    });
});

describe('authenticated self-only entitlement handler', () => {
    it('verifies both Gateway responses before even constructing billing dependencies', async () => {
        const f = fixture();
        let release!: (response: Response) => void;
        f.fetcher.mockReset().mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const pending = restEntitlement(request(), f.deps);
        await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(1));
        expect(f.billing).not.toHaveBeenCalled(); expect(f.subscriptionsFor).not.toHaveBeenCalled();
        f.fetcher.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        release(Response.json({ token_type: 'Bearer', access_token: TOKEN, grant_id: GRANT,
            expires_at: '2026-10-26T06:01:00.000Z' }, { status: 201 }));
        await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledTimes(2));
        expect(f.billing).not.toHaveBeenCalled(); expect(f.subscriptionsFor).not.toHaveBeenCalled();
        release(Response.json({ object: 'delegated_self', ...account() }));
        const response = await pending;
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ plan: { sku: 'standard_monthly_v3' }, ai: { balance: 1.000001 } });
        expect(f.subscriptionsFor).toHaveBeenCalledExactlyOnceWith(SUBJECT);
        expect(f.forbidden).not.toHaveBeenCalled();
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('vary')).toBe('Authorization');
    });

    it.each([undefined, 'Basic credential', 'Bearer first, Bearer second'])
    ('rejects non-customer Authorization %s without cookie fallback or local reads', async authorization => {
        const f = fixture();
        const headers = new Headers({ Cookie: 'sb-session=other-user-session' });
        if (authorization !== undefined) headers.set('Authorization', authorization);
        const response = await restEntitlement(request(undefined, { headers }), f.deps);
        expect(response.status).toBe(401);
        expect(f.fetcher).not.toHaveBeenCalled(); expect(f.billing).not.toHaveBeenCalled();
    });

    it.each(['issuer', 'subject', 'account_public_id', 'environment', 'wallet'] as const)
    ('performs zero local reads for invalid delegated %s', async field => {
        const f = fixture();
        const value = { object: 'delegated_self', ...account() };
        if (field === 'environment') value.environment = 'production';
        else if (field === 'wallet') value.wallet.available_micro = '-1';
        else value.identity[field] = field === 'issuer' ? 'https://wrong.example.test/auth/v1' : 'not-a-uuid';
        f.fetcher.mockReset().mockImplementationOnce(gateway()).mockResolvedValueOnce(Response.json(value));
        const response = await restEntitlement(request(), f.deps);
        expect(response.status).toBe(503);
        expect(f.billing).not.toHaveBeenCalled(); expect(f.subscriptionsFor).not.toHaveBeenCalled();
    });

    it.each([401, 403, 302, 500])('does not read local plans when the read service exchange returns %s', async status => {
        const f = fixture(); f.fetcher.mockReset().mockResolvedValue(Response.json({ secret: SERVICE }, { status }));
        const response = await restEntitlement(request(), f.deps);
        expect(response.status).toBe(503);
        expect(await response.text()).not.toContain(SERVICE); expect(f.billing).not.toHaveBeenCalled();
    });

    it('uses only the verified Supabase UUID despite caller-selected identity headers and cookies', async () => {
        const f = fixture();
        const response = await restEntitlement(request(undefined, { headers: {
            Authorization: `Bearer ${PROOF}`, Cookie: `userId=${OTHER}`, 'x-user-id': OTHER,
            'x-account-id': WORKS, 'x-supabase-subject': OTHER,
        } }), f.deps);
        expect(response.status).toBe(200);
        expect(f.subscriptionsFor).toHaveBeenCalledExactlyOnceWith(SUBJECT);
        expect(f.forbidden).not.toHaveBeenCalled();
        const exchange = JSON.parse(f.fetcher.mock.calls[0]![1]!.body as string);
        expect(exchange).toEqual({ policyId: POLICY, proofKind: 'auth0_access', subjectToken: PROOF });
        expect(String(f.fetcher.mock.calls[1]![0])).toBe('https://ai-staging.ezil.work/v1/delegation/me');
    });

    it.each(['userId', 'subject', 'account_public_id', 'teamId', 'sku'])('rejects query input %s after auth and before local reads', async selector => {
        const f = fixture(); const response = await restEntitlement(request(`/api/billing/v3/entitlement?${selector}=${OTHER}`), f.deps);
        expect(response.status).toBe(400); expect(f.fetcher).toHaveBeenCalledTimes(2); expect(f.billing).not.toHaveBeenCalled();
    });

    it('reports an absent local plan explicitly with no Free provisioning or grants', async () => {
        const f = fixture(account(), []);
        const response = await restEntitlement(request(), f.deps);
        expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'billing_entitlement_unknown' });
        expect(f.subscriptionsFor).toHaveBeenCalledExactlyOnceWith(SUBJECT); expect(f.forbidden).not.toHaveBeenCalled();
    });

    it('redacts dependency errors and never supplies Free as a recovery plan', async () => {
        const f = fixture(); f.subscriptionsFor.mockRejectedValue(new Error(`database credential ${SERVICE} ${PROOF}`));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const response = await restEntitlement(request(), f.deps);
        expect(response.status).toBe(503); expect(await response.json()).toEqual({ error: 'billing_entitlement_unavailable' });
        expect(warn).not.toHaveBeenCalled(); expect(error).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
    });

    it('bounds stalled verification and skips all local reads on timeout or caller cancellation', async () => {
        vi.useFakeTimers();
        for (const cancel of [false, true]) {
            const f = fixture(); f.fetcher.mockReset().mockImplementation(() => new Promise(() => {}));
            f.delegation.timeoutMs = 100;
            const controller = new AbortController();
            const pending = restEntitlement(request(undefined, { signal: controller.signal }), f.deps);
            await vi.advanceTimersByTimeAsync(1);
            if (cancel) controller.abort(); else await vi.advanceTimersByTimeAsync(100);
            expect((await pending).status).toBe(503);
            expect(f.billing).not.toHaveBeenCalled(); expect(f.subscriptionsFor).not.toHaveBeenCalled();
            expect(f.fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
        }
        expect(vi.getTimerCount()).toBe(0);
    });

    it('does not issue a local query when cancellation arrives during dependency construction', async () => {
        const f = fixture(); const controller = new AbortController();
        f.billing.mockImplementation(() => { controller.abort(); return { store: { subscriptionsFor: f.subscriptionsFor }, now: () => NOW }; });
        expect((await restEntitlement(request(undefined, { signal: controller.signal }), f.deps)).status).toBe(503);
        expect(f.subscriptionsFor).not.toHaveBeenCalled();
    });
});

describe('actual route wiring and unavailable team contracts', () => {
    function configure(f: ReturnType<typeof fixture>) {
        vi.stubEnv('BILLING_AI_READ_SERVICE_TOKEN', SERVICE); vi.stubEnv('BILLING_AI_READ_POLICY_ID', POLICY);
        vi.stubEnv('BILLING_FUNDING_URL', 'https://ai-staging.ezil.work');
        vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ISSUER.replace('/auth/v1', ''));
        vi.stubGlobal('fetch', f.fetcher); vi.useFakeTimers(); vi.setSystemTime(NOW);
        composition.getBillingDeps.mockImplementation(f.billing);
    }

    it('GET entitlement uses the server configuration and existing store only after delegation', async () => {
        const f = fixture(); configure(f);
        const response = await entitlementGET(request());
        expect(response.status).toBe(200); expect(f.fetcher).toHaveBeenCalledTimes(2);
        expect(f.subscriptionsFor).toHaveBeenCalledExactlyOnceWith(SUBJECT); expect(f.forbidden).not.toHaveBeenCalled();
    });

    it.each([teamsGET, seatsPOST])('authenticates the actual team route then returns501 with zero billing operations', async handler => {
        const f = fixture(); configure(f);
        const isPost = handler === seatsPOST;
        const response = await handler(request(isPost ? `/api/billing/v3/teams/${OTHER}/seats` : '/api/billing/v3/teams/mine', {
            method: isPost ? 'POST' : 'GET', body: isPost ? 'unparsed malformed or oversized assignment body' : undefined,
            headers: { Authorization: `Bearer ${PROOF}` },
        }));
        expect(response.status).toBe(501); expect(await response.json()).toEqual({ error: 'team_billing_unavailable' });
        expect(f.fetcher).toHaveBeenCalledTimes(2); expect(composition.getBillingDeps).not.toHaveBeenCalled();
        expect(f.subscriptionsFor).not.toHaveBeenCalled(); expect(f.forbidden).not.toHaveBeenCalled();
    });

    it.each([teamsGET, seatsPOST])('requires bearer auth before disclosing unavailable team billing', async handler => {
        const f = fixture(); configure(f);
        const response = await handler(request('/api/billing/v3/teams/existing/seats', { headers: { Cookie: 'session=present' } }));
        expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'delegated_auth_required' });
        expect(f.fetcher).not.toHaveBeenCalled(); expect(composition.getBillingDeps).not.toHaveBeenCalled();
    });

    it('does not turn a verification refusal into501 or a fictional404 team', async () => {
        const f = fixture(); f.fetcher.mockReset().mockResolvedValue(Response.json({}, { status: 403 }));
        const response = await teamBillingUnavailable(request(), f.deps);
        expect(response.status).toBe(503); expect(f.billing).not.toHaveBeenCalled();
    });

    it('fails closed without a read-service credential despite other configured credentials', async () => {
        const f = fixture(); configure(f); vi.stubEnv('BILLING_AI_READ_SERVICE_TOKEN', '');
        vi.stubEnv('ENTITLEMENT_HMAC_SECRET', 'test-only-forbidden-hmac');
        vi.stubEnv('BILLING_FUNDING_HMAC_SECRET', 'test-only-forbidden-admin');
        expect((await entitlementGET(request())).status).toBe(503);
        expect(f.fetcher).not.toHaveBeenCalled(); expect(composition.getBillingDeps).not.toHaveBeenCalled();
    });
});
