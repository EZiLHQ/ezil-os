import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from './config';
import type { BillingDeps, BillingStore } from './ports';
import { createTRPCContext } from '@/server/api/trpc';
import { createBillingRouter } from '@/server/api/routers/billing';

vi.mock('@/server/db', () => ({ db: {} }));
const auth = vi.hoisted(() => ({ getUser: vi.fn(), getSession: vi.fn() }));
vi.mock('@/utils/supabase/server', () => ({ createClient: async () => ({ auth }) }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn() }));
const now = new Date('2026-10-21Z');
function fixture(sku: 'free_v3' | 'standard_monthly_v3' = 'free_v3') {
    const store = { subscriptionsFor: vi.fn().mockResolvedValue(sku === 'free_v3' ? [] : [{ sku, stripeSubscriptionId: 'sub',
        status: 'active', currentPeriodStart: new Date('2026-10-01Z'), currentPeriodEnd: new Date('2026-11-01Z'), cancelAtPeriodEnd: false }]),
        userCreatedAt: vi.fn().mockResolvedValue(now), openPlanChanges: vi.fn().mockResolvedValue([]),
        epochsFor: vi.fn().mockResolvedValue([]), grantsForPeriod: vi.fn().mockResolvedValue([]), latestConsent: vi.fn().mockResolvedValue(null),
        openPaymentIssues: vi.fn().mockResolvedValue([]), latestStorageFor: vi.fn().mockResolvedValue([]), sizePreference: vi.fn().mockResolvedValue(null),
        stripeCustomerFor: vi.fn().mockResolvedValue(null), overageInvoicesFor: vi.fn().mockResolvedValue([]), enqueueOutbox: vi.fn().mockResolvedValue('queued'),
    };
    const deps: BillingDeps = { config: readBillingConfig({ BILLING_TAB_ENABLED: '1', BILLING_FUNDING_URL: 'https://gateway.test' }),
        store: store as unknown as BillingStore, stripe: null, usage: null, now: () => now };
    const ctx = { user: { id: 'current-user' }, headers: new Headers({ authorization: 'Bearer current-token' }), db: {} } as Awaited<ReturnType<typeof createTRPCContext>>;
    return { store, deps, caller: createBillingRouter(() => deps).createCaller(ctx) };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); vi.restoreAllMocks(); });

describe('billing.summary AI wiring', () => {
    it.each([0, 50, 51])('fills a Free live balance %s and queues the current user trial', async credits => {
        const fetcher = gateway({ credits }); vi.stubGlobal('fetch', fetcher);
        const f = fixture();
        expect(await f.caller.summary()).toMatchObject({ ai: { balance: credits, state: credits === 0 ? 'exhausted' : credits <= 50 ? 'low' : 'ok' } });
        expect(f.store.enqueueOutbox).toHaveBeenCalledWith(expect.objectContaining({ userId: 'current-user', eventKey: 'ezil-os:v1:free-once:current-user:grant' }));
        expect(fetcher.mock.calls[0]![1]!.headers).toEqual({ Authorization: 'Bearer current-token' });
    });
    it('uses the paid plan threshold and never queues a Free trial for it', async () => {
        vi.stubGlobal('fetch', gateway({ available_micro: '20000000' }));
        const f = fixture('standard_monthly_v3');
        expect(await f.caller.summary()).toMatchObject({ ai: { grant: { amount: 200 }, balance: 20, state: 'low' } });
        expect(f.store.enqueueOutbox).not.toHaveBeenCalled();
    });
    it('performs billing reads while balance is stalled and returns unavailable by the timeout', async () => {
        vi.useFakeTimers(); vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => {})));
        const f = fixture(); const pending = f.caller.summary();
        await vi.advanceTimersByTimeAsync(1); expect(f.store.subscriptionsFor).toHaveBeenCalled(); expect(f.store.epochsFor).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(3000);
        expect(await pending).toMatchObject({ ai: { balance: null, state: 'unavailable' } });
    });
    it('has no AI effects when the billing tab is disabled', async () => {
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        const f = fixture(); f.deps.config.tabEnabled = false;
        expect(await f.caller.summary()).toEqual({ enabled: false });
        expect(fetcher).not.toHaveBeenCalled(); expect(f.store.enqueueOutbox).not.toHaveBeenCalled();
    });
});


function gateway(balance: unknown, overrides: Record<string, unknown> = {}) {
    const bodies: Record<string, unknown> = { '/v1/me/balance': balance,
        '/v1/models': { killswitch: false, pause: null }, '/v1/me/usage': { object: 'list', data: [] },
        '/v1/me/limits': { policy: { policy: {} }, pauses: [], entitlement: { required: false, basis: 'not_required' } }, ...overrides };
    return vi.fn<typeof fetch>(async url => Response.json(bodies[new URL(String(url)).pathname]));
}

describe('authenticated C6 AI read procedures', () => {
    async function caller(headers = new Headers()) {
        const f = fixture();
        const ctx = await createTRPCContext({ headers });
        return { ...f, caller: createBillingRouter(() => f.deps).createCaller(ctx) };
    }
    it('isolates users through the actual Supabase context and never enqueues credits on either read', async () => {
        auth.getUser.mockImplementation(async token => ({ data: { user: { id: token === 'alice-token' ? 'alice' : 'bob' } }, error: null }));
        const fetcher = vi.fn<typeof fetch>(async (url, options) => {
            const token = new Headers(options?.headers).get('authorization');
            return Response.json(String(url).includes('/usage?') ? { object: 'list', data: [{ created_at: '2026-10-26T01:00:00Z',
                status: 'settled', hold_micro: 0, cost_micro: token === 'Bearer alice-token' ? '1' : '999999', uncollected_micro: 0 }] }
                : { counters: { pending: token === 'Bearer alice-token' ? 1 : 2 } });
        });
        vi.stubGlobal('fetch', fetcher);
        for (const [name, cost, pending] of [['alice', '1', 1], ['bob', '999999', 2]] as const) {
            const f = await caller(new Headers({ authorization: `Bearer ${name}-token` }));
            expect(await f.caller.aiUsage({ limit: 1 })).toMatchObject({ recentUsage: { rows: [{ chargedMicro: cost }] } });
            expect(await f.caller.aiLimits()).toMatchObject({ limits: { counters: { pending } } });
            expect(f.store.enqueueOutbox).not.toHaveBeenCalled();
        }
        expect(fetcher).toHaveBeenCalledTimes(4);
        for (const [url, options] of fetcher.mock.calls) {
            expect(String(url)).not.toMatch(/userId|payer|subject/);
            expect(options).toMatchObject({ redirect: 'error', cache: 'no-store' });
        }
    });
    it('uses only the matching cookie session credential and refuses a mismatched session', async () => {
        auth.getUser.mockResolvedValue({ data: { user: { id: 'alice' } }, error: null });
        auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'alice' }, access_token: 'alice-cookie' } }, error: null });
        const fetcher = gateway({ credits: 1 }); vi.stubGlobal('fetch', fetcher);
        const f = await caller(); expect((await f.caller.aiUsage()).state).toBe('available');
        expect(new Headers(fetcher.mock.calls[0][1]?.headers).get('authorization')).toBe('Bearer alice-cookie');
        auth.getSession.mockResolvedValue({ data: { session: { user: { id: 'bob' }, access_token: 'bob-cookie' } }, error: null });
        expect(await f.caller.aiLimits()).toEqual({ state: 'unavailable', limits: null });
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it.each(['Bearer invalid', 'Bearer ', 'Basic invalid', 'Bearer foreign-auth0-id-token'])('refuses %s without falling through to cookies', async header => {
        auth.getUser.mockImplementation(async token => ({ data: { user: token === undefined ? { id: 'cookie-user' } : null }, error: null }));
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        const f = await caller(new Headers({ authorization: header }));
        await expect(f.caller.aiUsage()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(f.caller.aiLimits()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(fetcher).not.toHaveBeenCalled(); expect(f.store.enqueueOutbox).not.toHaveBeenCalled();
    });
    it('rejects malformed cursors, out-of-bounds limits and payer selectors', async () => {
        const f = fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { before: 'tomorrow' }, { userId: 'other' }]) {
            await expect(f.caller.aiUsage(input as { limit: number })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        }
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('preserves a paused positive fractional balance without claiming healthy legacy state', async () => {
        vi.stubGlobal('fetch', gateway({ available_micro: '1000001' }, { '/v1/models': { killswitch: true, pause: 'reconciliation' },
            '/v1/me/usage': null }));
        expect(await fixture().caller.summary()).toMatchObject({ ai: { balanceMicro: '1000001', balance: 1.000001,
            balanceState: 'low', spendingState: 'paused_reconciliation', state: 'unavailable', usageState: 'unavailable', limitsState: 'available' } });
    });
    it('returns unknown on Gateway refusals or malformed JSON rather than using privileged fallback credentials', async () => {
        const f = fixture();
        for (const response of [Response.json({}, { status: 401 }), Response.json({}, { status: 503 }), new Response('not json')]) {
            const fetcher = vi.fn<typeof fetch>(async () => response.clone()); vi.stubGlobal('fetch', fetcher);
            expect(await f.caller.aiUsage()).toEqual({ state: 'unavailable', recentUsage: null });
            expect(await f.caller.aiLimits()).toEqual({ state: 'unavailable', limits: null });
            expect(fetcher).toHaveBeenCalledTimes(2);
        }
        expect(f.store.enqueueOutbox).not.toHaveBeenCalled();
    });
    it('does no reads or grants with billing disabled', async () => {
        const f = fixture(); f.deps.config.tabEnabled = false;
        const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
        expect((await f.caller.aiUsage()).state).toBe('unavailable'); expect((await f.caller.aiLimits()).state).toBe('unavailable');
        expect(fetcher).not.toHaveBeenCalled(); expect(f.store.enqueueOutbox).not.toHaveBeenCalled();
    });
    it('propagates caller cancellation through both real read procedures without leaving timers or grants', async () => {
        vi.useFakeTimers();
        const f = fixture(), controller = new AbortController();
        const ctx = { user: { id: 'current-user' }, headers: new Headers({ authorization: 'Bearer current-token' }), db: {} } as Awaited<ReturnType<typeof createTRPCContext>>;
        const caller = createBillingRouter(() => f.deps).createCaller(ctx, { signal: controller.signal });
        const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {})); vi.stubGlobal('fetch', fetcher);
        const reads = Promise.all([caller.aiUsage(), caller.aiLimits()]);
        await vi.advanceTimersByTimeAsync(1); expect(fetcher).toHaveBeenCalledTimes(2);
        controller.abort();
        expect(await reads).toEqual([{ state: 'unavailable', recentUsage: null }, { state: 'unavailable', limits: null }]);
        expect(vi.getTimerCount()).toBe(0); expect(f.store.enqueueOutbox).not.toHaveBeenCalled();
        for (const [, options] of fetcher.mock.calls) expect(options?.signal?.aborted).toBe(true);
    });
});
