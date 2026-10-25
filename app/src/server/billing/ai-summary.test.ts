import { afterEach, describe, expect, it, vi } from 'vitest';
import { readBillingConfig } from './config';
import type { BillingDeps, BillingStore } from './ports';
import type { createTRPCContext } from '@/server/api/trpc';
import { createBillingRouter } from '@/server/api/routers/billing';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
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
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ credits })); vi.stubGlobal('fetch', fetcher);
        const f = fixture();
        expect(await f.caller.summary()).toMatchObject({ ai: { balance: credits, state: credits === 0 ? 'exhausted' : credits <= 50 ? 'low' : 'ok' } });
        expect(f.store.enqueueOutbox).toHaveBeenCalledWith(expect.objectContaining({ userId: 'current-user', eventKey: 'ezil-os:v1:free-once:current-user:grant' }));
        expect(fetcher.mock.calls[0]![1]!.headers).toEqual({ Authorization: 'Bearer current-token' });
    });
    it('uses the paid plan threshold and never queues a Free trial for it', async () => {
        vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(Response.json({ available_micro: '400000000' })));
        const f = fixture('standard_monthly_v3');
        expect(await f.caller.summary()).toMatchObject({ ai: { grant: { amount: 4000 }, balance: 400, state: 'low' } });
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
