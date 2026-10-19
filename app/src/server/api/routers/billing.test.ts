import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '@/server/billing/config';
import type { SubscriptionRow } from '@/server/billing/meters';
import type { BillingDeps, BillingStore, GrantRow, StripeApi, StripeCheckoutSession, StripeInvoiceSummary } from '@/server/billing/ports';
import { OVERAGE_TERMS_VERSION } from '@/server/billing/v2/contract';
import type { createTRPCContext } from '../trpc';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({
    getBillingDeps: () => { throw new Error('Tests must inject billing ports'); },
}));

import { createBillingRouter } from './billing';

const now = new Date('2026-10-11T12:00:00Z');
const sku = 'pro_monthly_v1';
const userId = '11111111-1111-4111-8111-111111111111';
const session: StripeCheckoutSession = {
    id: 'cs_fixture', customer: 'cus_fixture', clientReferenceId: userId,
    mode: 'subscription', status: 'open', paymentStatus: 'unpaid', paymentIntentId: null, sku,
};
const invoice: StripeInvoiceSummary = {
    id: 'in_fixture', number: 'INV-1', status: 'paid', amountPaidCents: 2000,
    currency: 'usd', created: now, hostedInvoiceUrl: 'https://invoice.stripe.com/fixture', description: 'EZiL Pro',
};
const history = [{
    id: invoice.id, number: invoice.number, status: invoice.status, amountPaidCents: invoice.amountPaidCents,
    currency: invoice.currency, created: now.toISOString(), url: invoice.hostedInvoiceUrl, description: invoice.description,
}];

afterEach(() => vi.restoreAllMocks());

function subscription(overrides: Partial<SubscriptionRow> = {}): SubscriptionRow {
    return {
        stripeSubscriptionId: 'sub_fixture', status: 'active', sku,
        currentPeriodStart: new Date('2026-09-20T00:00:00Z'),
        currentPeriodEnd: new Date('2026-10-20T00:00:00Z'), cancelAtPeriodEnd: false,
        ...overrides,
    };
}

function grant(amount: number, meter: GrantRow['meter'] = 'compute_std_seconds'): GrantRow {
    return {
        id: 'grant_fixture', userId, subscriptionId: 'sub_fixture', meter, kind: meter === 'workspace_seconds' ? 'pro_period' : 'plan_period',
        amount: BigInt(amount), periodStart: subscription().currentPeriodStart, periodEnd: subscription().currentPeriodEnd,
        sourceType: 'invoice', sourceId: 'in_fixture', createdAt: now,
    };
}

function fixture() {
    let customer: string | null = null;
    const store = {
        grantsForPeriod: vi.fn<BillingStore['grantsForPeriod']>().mockResolvedValue([]),
        openEpoch: vi.fn<BillingStore['openEpoch']>(async () => { throw new Error('Unused v2 store stub'); }),
        openEpochFor: vi.fn<BillingStore['openEpochFor']>(async () => { throw new Error('Unused v2 store stub'); }),
        touchEpoch: vi.fn<BillingStore['touchEpoch']>(async () => { throw new Error('Unused v2 store stub'); }),
        openEpochsForSweep: vi.fn<BillingStore['openEpochsForSweep']>(async () => { throw new Error('Unused v2 store stub'); }),
        policyClosedEpochsSince: vi.fn<BillingStore['policyClosedEpochsSince']>(async () => { throw new Error('Unused v2 store stub'); }),
        closeEpoch: vi.fn<BillingStore['closeEpoch']>(async () => { throw new Error('Unused v2 store stub'); }),
        epochsFor: vi.fn<BillingStore['epochsFor']>().mockResolvedValue([{
            id: 'epoch_fixture', userId, computerId: 'computer', size: 'free-cf', weight: 1,
            readyAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:00Z', endReason: 'user_stop', overheadSeconds: 0, deadlineAt: null, lastHeartbeatAt: null,
        }]),
        recordConsent: vi.fn<BillingStore['recordConsent']>(async () => { throw new Error('Unused v2 store stub'); }),
        latestConsent: vi.fn<BillingStore['latestConsent']>().mockResolvedValue(null),
        upsertOverageInvoice: vi.fn<BillingStore['upsertOverageInvoice']>(async () => { throw new Error('Unused v2 store stub'); }),
        attachOverageStripeInvoice: vi.fn<BillingStore['attachOverageStripeInvoice']>(async () => { throw new Error('Unused v2 store stub'); }),
        setOverageInvoiceStatus: vi.fn<BillingStore['setOverageInvoiceStatus']>(async () => { throw new Error('Unused v2 store stub'); }),
        overageInvoiceByStripeId: vi.fn<BillingStore['overageInvoiceByStripeId']>(async () => { throw new Error('Unused v2 store stub'); }),
        overageInvoicesFor: vi.fn<BillingStore['overageInvoicesFor']>(async () => { throw new Error('Unused v2 store stub'); }),
        recordPlanChange: vi.fn<BillingStore['recordPlanChange']>(async () => { throw new Error('Unused v2 store stub'); }),
        setPlanChangeState: vi.fn<BillingStore['setPlanChangeState']>(async () => { throw new Error('Unused v2 store stub'); }),
        openPlanChanges: vi.fn<BillingStore['openPlanChanges']>().mockResolvedValue([]),
        recordPaymentIssue: vi.fn<BillingStore['recordPaymentIssue']>(async () => { throw new Error('Unused v2 store stub'); }),
        resolvePaymentIssue: vi.fn<BillingStore['resolvePaymentIssue']>(async () => { throw new Error('Unused v2 store stub'); }),
        openPaymentIssues: vi.fn<BillingStore['openPaymentIssues']>().mockResolvedValue([]),
        setSizePreference: vi.fn<BillingStore['setSizePreference']>(async () => { throw new Error('Unused v2 store stub'); }),
        sizePreference: vi.fn<BillingStore['sizePreference']>().mockResolvedValue(null),
        userCreatedAt: vi.fn<BillingStore['userCreatedAt']>().mockResolvedValue(now),
        stripeCustomerFor: vi.fn(async () => customer),
        userForStripeCustomer: vi.fn(async () => userId),
        subscriptionsFor: vi.fn(async (): Promise<SubscriptionRow[]> => []),
        intervalsFor: vi.fn(async () => [{ startedAt: new Date('2026-10-01T00:00:00Z'), endedAt: new Date('2026-10-01T00:01:00Z') }]),
        latestStorageFor: vi.fn(async () => [{ computerId: 'computer', bytes: BigInt(123), measuredAt: now }]),
        grantsBySource: vi.fn(async () => []),
        computerOwner: vi.fn(async () => userId),
        linkCustomer: vi.fn(async (_user: string, id: string): Promise<'linked' | 'exists' | 'conflict'> => {
            customer = id;
            return 'linked';
        }),
        recordEvent: vi.fn(async () => 'new' as const),
        markEventProcessed: vi.fn(async () => {}),
        upsertSubscription: vi.fn(async () => 'applied' as const),
        insertGrant: vi.fn(async () => 'inserted' as const),
        enqueueOutbox: vi.fn(async () => 'queued' as const),
        latestIntervalFor: vi.fn<BillingStore['latestIntervalFor']>().mockResolvedValue(null),
        openInterval: vi.fn(async () => {}),
        touchInterval: vi.fn(async () => {}),
        closeInterval: vi.fn(async () => {}),
        insertStorageSample: vi.fn(async () => {}),
        closeStaleIntervals: vi.fn(async () => 0),
    } satisfies BillingStore;
    const stripe = {
        createCustomer: vi.fn(async () => ({ id: 'cus_fixture' })),
        createCheckoutSession: vi.fn<StripeApi['createCheckoutSession']>(async input => ({
            id: session.id, url: input.uiMode === 'hosted' ? 'https://checkout.example/session' : null,
            clientSecret: input.uiMode === 'embedded' ? 'cs_fixture_secret_fixture' : null,
        })),
        listInvoices: vi.fn<StripeApi['listInvoices']>(async () => [{ ...invoice }]),
        createPortalSession: vi.fn(async () => ({ url: 'https://billing.example/portal' })),
        retrieveCheckoutSession: vi.fn(async () => ({ ...session })),
        retrieveSubscription: vi.fn<StripeApi['retrieveSubscription']>(),
        retrieveInvoice: vi.fn<StripeApi['retrieveInvoice']>(),
        retrieveCharge: vi.fn<StripeApi['retrieveCharge']>(),
    } satisfies StripeApi;
    const deps: BillingDeps = {
        config: readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'fixture-only' }),
        store, stripe, now: () => now,
    };
    const ctx: Awaited<ReturnType<typeof createTRPCContext>> = {
        db: {} as Awaited<ReturnType<typeof createTRPCContext>>['db'],
        headers: new Headers({ origin: 'https://app.example' }),
        user: { id: userId, email: 'fixture@example.org', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: now.toISOString() },
    };
    const router = createBillingRouter(() => deps);
    return { deps, store, stripe, ctx, router, caller: router.createCaller(ctx) };
}

async function checkoutControl(f = fixture()) {
    await expect(f.caller.createCheckout({ sku })).resolves.toEqual({ mode: 'redirect', sessionId: session.id, url: 'https://checkout.example/session' });
    expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(1);
    return f;
}

describe('billing router', () => {
    it('does no store reads with the tab off and returns v2 legacy Free with epochs when enabled', async () => {
        const f = fixture();
        f.deps.config.tabEnabled = false;
        await expect(f.caller.summary()).resolves.toEqual({ enabled: false });
        for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
        f.deps.config.tabEnabled = true;
        await expect(f.caller.summary()).resolves.toMatchObject({ enabled: true, version: 2,
            plan: { sku: 'free_v1_legacy', family: 'free' },
            compute: { allowanceStdSeconds: 28800, usedStdSeconds: 60, remainingStdSeconds: 28740 },
            storage: { usedBytes: '123' }, overage: null });
        expect(f.store.subscriptionsFor).toHaveBeenCalledWith(userId);
        expect(f.store.epochsFor).toHaveBeenCalledWith(userId, new Date('2026-10-01T00:00:00Z'));
        expect(f.store.grantsForPeriod).toHaveBeenCalledWith(userId,
            { start: new Date('2026-10-01T00:00:00Z'), end: new Date('2026-11-01T00:00:00Z') }, []);
        expect(f.store.latestStorageFor).toHaveBeenCalledWith(userId);
        expect(f.store.latestConsent).not.toHaveBeenCalled();
        expect(f.store.intervalsFor).not.toHaveBeenCalled();
    });

    it('loads the selected Standard period and reads its allowance from grants', async () => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'standard_monthly_v2' }),
            subscription({ stripeSubscriptionId: 'sub_old', status: 'canceled', currentPeriodStart: new Date('2026-01-01T00:00:00Z') })]);
        f.store.grantsForPeriod.mockResolvedValue([grant(120000)]);
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { family: 'standard' },
            compute: { allowanceStdSeconds: 120000, usedStdSeconds: 60, remainingStdSeconds: 119940 } });
        expect(f.store.epochsFor).toHaveBeenCalledWith(userId, new Date('2026-09-20T00:00:00Z'));
        expect(f.store.grantsForPeriod).toHaveBeenCalledWith(userId,
            { start: new Date('2026-09-20T00:00:00Z'), end: new Date('2026-10-20T00:00:00Z') }, ['compute_std_seconds']);
        expect(f.store.latestConsent).toHaveBeenCalledWith(userId, 'sub_fixture');
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'standard_monthly_v2', currentPeriodStart: new Date('2026-10-05T00:00:00Z') })]);
        await f.caller.summary();
        expect(f.store.epochsFor).toHaveBeenLastCalledWith(userId, new Date('2026-10-05T00:00:00Z'));
    });

    it('returns Compute consent, weighted usage, overage and size preference', async () => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'compute_monthly_v2' })]);
        f.store.grantsForPeriod.mockResolvedValue([grant(144)]);
        f.store.epochsFor.mockResolvedValue([{
            id: 'epoch_compute', userId, computerId: 'computer', size: 'cmp-8', weight: 4,
            readyAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:12Z', endReason: 'user_stop', overheadSeconds: 0, deadlineAt: null, lastHeartbeatAt: null,
        }]);
        f.store.latestConsent.mockResolvedValue({
            id: BigInt(1), userId, subscriptionId: 'sub_fixture', enabled: true, capCents: 100,
            termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: 2, rateCentsPerStdHour: 25, actor: 'user', acceptedAt: now,
        });
        f.store.sizePreference.mockResolvedValue('cmp-8');
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { family: 'compute' },
            compute: { allowanceStdSeconds: 144, usedStdSeconds: 288, remainingStdSeconds: 0, selectedSize: 'cmp-8' },
            overage: { enabled: true, capCents: 100, accruedCents: 1 },
            estimate: { subscriptionCents: 10000, accruedOverageCents: 1, worstCaseOverageCents: 100 } });
    });

    it('loads both compute and legacy workspace grants for Pro', async () => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription()]);
        f.store.grantsForPeriod.mockResolvedValue([grant(72000, 'workspace_seconds')]);
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { family: 'pro_legacy' },
            compute: { allowanceStdSeconds: 72000, remainingStdSeconds: 71940 }, overage: null });
        expect(f.store.grantsForPeriod).toHaveBeenCalledWith(userId,
            { start: subscription().currentPeriodStart, end: subscription().currentPeriodEnd }, ['compute_std_seconds', 'workspace_seconds']);
    });

    it('scopes every summary store read to the authenticated user', async () => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'standard_monthly_v2' })]);
        const otherUser = '22222222-2222-4222-8222-222222222222';
        const caller = f.router.createCaller({ ...f.ctx, user: { ...f.ctx.user!, id: otherUser } });
        await caller.summary();
        const reads = ['subscriptionsFor', 'userCreatedAt', 'openPlanChanges', 'epochsFor', 'grantsForPeriod',
            'latestConsent', 'openPaymentIssues', 'latestStorageFor', 'sizePreference', 'stripeCustomerFor'] as const;
        for (const [name, method] of Object.entries(f.store)) {
            if (reads.includes(name as typeof reads[number])) {
                expect(method, name).toHaveBeenCalledTimes(1);
                expect(method.mock.calls[0]?.[0], name).toBe(otherUser);
            } else expect(method, name).not.toHaveBeenCalled();
        }
    });

    it.each(['flag', 'key', 'client'] as const)('gates every Stripe procedure without %s', async missing => {
        const f = fixture();
        if (missing === 'flag') f.deps.config.checkoutEnabled = false;
        if (missing === 'key') f.deps.config.stripeSecret = undefined;
        if (missing === 'client') f.deps.stripe = null;
        await expect(f.caller.createCheckout({ sku })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await expect(f.caller.portal()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        await expect(f.caller.history()).resolves.toEqual([]);
        expect(f.stripe.listInvoices).toHaveBeenCalledTimes(0);
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
        expect(f.stripe.createPortalSession).toHaveBeenCalledTimes(0);
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledTimes(0);
        f.deps.config.checkoutEnabled = true;
        f.deps.config.stripeSecret = 'fixture-only';
        f.deps.stripe = f.stripe;
        await checkoutControl(f);
        await expect(f.caller.portal()).resolves.toEqual({ url: 'https://billing.example/portal' });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'pending' });
        await expect(f.caller.history()).resolves.toEqual(history);
        expect(f.stripe.listInvoices).toHaveBeenCalledWith('cus_fixture', 12);
        expect(f.stripe.createPortalSession).toHaveBeenCalledTimes(1);
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledTimes(1);
    });

    it.each(['ai_pack_10_v1', 'ai_pack_25_v1'])('keeps %s behind G4', async pack => {
        const f = fixture();
        await expect(f.caller.createCheckout({ sku: pack })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'ai_not_available' });
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
        await checkoutControl(f);
    });

    it('rejects unknown SKUs and permits the catalog Pro SKU', async () => {
        const f = fixture();
        await expect(f.caller.createCheckout({ sku: 'invented' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
        await checkoutControl(f);
    });

    it.each([
        { status: 'active' }, { status: 'trialing' }, { status: 'active', cancelAtPeriodEnd: true },
        { status: 'past_due' }, { status: 'unpaid' },
    ])('refuses a second subscription for %j', async overrides => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription(overrides)]);
        await expect(f.caller.createCheckout({ sku })).rejects.toMatchObject({ code: 'CONFLICT', message: 'already_subscribed' });
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
        f.store.subscriptionsFor.mockResolvedValue([subscription({ status: 'canceled' })]);
        await checkoutControl(f);
    });

    it('refuses another checkout for a v2 Standard subscription', async () => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'standard_monthly_v2' })]);
        await expect(f.caller.createCheckout({ sku })).rejects.toMatchObject({ code: 'CONFLICT', message: 'already_subscribed' });
        expect(f.stripe.createCustomer).not.toHaveBeenCalled();
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('creates and links the customer once, using session identity and distinct checkout keys', async () => {
        const f = await checkoutControl();
        await f.caller.createCheckout({ sku });
        expect(f.stripe.createCustomer).toHaveBeenCalledTimes(1);
        expect(f.stripe.createCustomer).toHaveBeenCalledWith({ userId, email: 'fixture@example.org', idempotencyKey: `customer:${userId}` });
        expect(f.store.linkCustomer).toHaveBeenCalledTimes(1);
        expect(f.store.linkCustomer).toHaveBeenCalledWith(userId, 'cus_fixture');
        const calls = vi.mocked<StripeApi['createCheckoutSession']>(f.stripe.createCheckoutSession).mock.calls;
        expect(calls).toHaveLength(2);
        expect(calls[0][0]).toMatchObject({
            userId, customerId: 'cus_fixture', sku,
            uiMode: 'hosted', returnUrl: 'https://app.example/billing/return?session_id={CHECKOUT_SESSION_ID}',
            successUrl: 'https://app.example/billing/return?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://app.example/os',
        });
        expect(calls[0][0].idempotencyKey).toMatch(new RegExp(`^checkout:${userId}:${sku}:`));
        expect(new Set(calls.map(([input]) => input.idempotencyKey)).size).toBe(2);
    });

    it('refuses a customer link conflict and accepts an idempotent existing link', async () => {
        const f = fixture();
        f.store.linkCustomer.mockResolvedValueOnce('conflict');
        await expect(f.caller.createCheckout({ sku })).rejects.toMatchObject({ code: 'CONFLICT' });
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
        f.store.linkCustomer.mockResolvedValueOnce('exists');
        await checkoutControl(f);
    });

    it.each([null, 'null', 'not a url', 'javascript:alert(1)'])('uses the public origin when Origin is %s', async origin => {
        const f = fixture();
        if (origin === null) f.ctx.headers.delete('origin');
        else f.ctx.headers.set('origin', origin);
        await checkoutControl(f);
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ cancelUrl: 'https://os.ezil.org/os' }));
        await f.caller.portal();
        expect(f.stripe.createPortalSession).toHaveBeenCalledWith({ customerId: 'cus_fixture', returnUrl: 'https://os.ezil.org/os' });
    });

    it('requires a linked customer for the portal', async () => {
        const f = fixture();
        await expect(f.caller.portal()).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
        expect(f.stripe.createPortalSession).toHaveBeenCalledTimes(0);
        await checkoutControl(f);
        await expect(f.caller.portal()).resolves.toEqual({ url: 'https://billing.example/portal' });
        expect(f.stripe.createPortalSession).toHaveBeenCalledWith({ customerId: 'cus_fixture', returnUrl: 'https://app.example/os' });
    });

    it.each(['other-user', null])('hides sessions belonging to %s with an owner control', async owner => {
        const f = fixture();
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, clientReferenceId: owner });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, status: 'complete' });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'complete' });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenNthCalledWith(1, session.id);
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenNthCalledWith(2, session.id);
    });

    it.each(['open', 'complete', 'expired'] as const)('maps %s from a fresh Stripe read', async status => {
        const f = fixture();
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, status });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: status === 'open' ? 'pending' : status });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledWith(session.id);
    });

    it.each(['', 'cs_', 'pi_fixture', 'cs_bad/path', 'cs_bad?query'])('rejects malformed session id %s before reading Stripe', async sessionId => {
        const f = fixture();
        await expect(f.caller.checkoutStatus({ sessionId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledTimes(0);
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'pending' });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledTimes(1);
    });

    it('protects all five procedures with the real authentication middleware', async () => {
        const f = fixture();
        const anonymous = f.router.createCaller({ ...f.ctx, user: null });
        await expect(anonymous.summary()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(anonymous.createCheckout({ sku })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(anonymous.portal()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(anonymous.checkoutStatus({ sessionId: session.id })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(anonymous.history()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        await expect(f.caller.summary()).resolves.toMatchObject({ enabled: true });
        await checkoutControl(f);
        await expect(f.caller.portal()).resolves.toMatchObject({ url: 'https://billing.example/portal' });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'pending' });
        await expect(f.caller.history()).resolves.toEqual(history);
    });

    it('starts embedded checkout with the configured publishable key and session secret', async () => {
        const f = fixture();
        f.deps.config.stripePublishableKey = 'pk_test_fixture';
        await expect(f.caller.createCheckout({ sku })).resolves.toEqual({
            mode: 'embedded', sessionId: session.id, clientSecret: 'cs_fixture_secret_fixture', publishableKey: 'pk_test_fixture',
        });
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
            customerId: 'cus_fixture', userId, sku, uiMode: 'embedded',
            returnUrl: 'https://app.example/billing/return?session_id={CHECKOUT_SESSION_ID}',
        }));
    });

    it.each(['embedded', 'hosted'] as const)('forwards the Managed Payments flag in %s checkout', async mode => {
        const f = fixture();
        if (mode === 'embedded') f.deps.config.stripePublishableKey = 'pk_test_fixture';
        for (const enabled of [false, true]) {
            f.deps.config.managedPaymentsEnabled = enabled;
            await expect(f.caller.createCheckout({ sku })).resolves.toMatchObject({
                mode: mode === 'embedded' ? 'embedded' : 'redirect', sessionId: session.id,
            });
            expect(f.stripe.createCheckoutSession).toHaveBeenLastCalledWith(expect.objectContaining({
                managedPayments: enabled, uiMode: mode, userId, sku,
            }));
        }
    });

    it.each(['embedded', 'hosted'] as const)('rejects an unusable %s session and accepts a complete response', async mode => {
        const f = fixture();
        if (mode === 'embedded') f.deps.config.stripePublishableKey = 'pk_test_fixture';
        f.stripe.createCheckoutSession.mockResolvedValueOnce({ id: session.id, url: null, clientSecret: null });
        await expect(f.caller.createCheckout({ sku })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'checkout_unavailable' });
        await expect(f.caller.createCheckout({ sku })).resolves.toMatchObject({ mode: mode === 'embedded' ? 'embedded' : 'redirect', sessionId: session.id });
    });

    it('returns empty history without a customer and loads invoices for the session customer', async () => {
        const f = fixture();
        await expect(f.caller.history()).resolves.toEqual([]);
        expect(f.stripe.listInvoices).toHaveBeenCalledTimes(0);
        expect(f.store.stripeCustomerFor).toHaveBeenCalledWith(userId);
        await f.store.linkCustomer(userId, 'cus_fixture');
        await expect(f.caller.history()).resolves.toEqual(history);
        expect(f.stripe.listInvoices).toHaveBeenCalledWith('cus_fixture', 12);
        f.stripe.listInvoices.mockResolvedValueOnce([]);
        await expect(f.caller.history()).resolves.toEqual([]);
    });

    it('serializes at most the twelve newest invoices, including nullable fields', async () => {
        const f = fixture();
        await f.store.linkCustomer(userId, 'cus_fixture');
        f.stripe.listInvoices.mockResolvedValueOnce(Array.from({ length: 14 }, (_, i) => ({
            ...invoice, id: `in_${i}`, created: new Date(now.getTime() + i * 1000),
            number: null, hostedInvoiceUrl: null, description: null,
        })));
        const rows = await f.caller.history();
        expect(rows).toHaveLength(12);
        expect(rows.map(row => row.id)).toEqual(Array.from({ length: 12 }, (_, i) => `in_${13 - i}`));
        expect(rows[0]).toEqual({ ...history[0], id: 'in_13', created: new Date(now.getTime() + 13_000).toISOString(), number: null, url: null, description: null });
        expect(f.stripe.listInvoices).toHaveBeenCalledWith('cus_fixture', 12);
    });

    it('returns empty history and logs safely after Stripe errors, then recovers', async () => {
        const f = fixture();
        await f.store.linkCustomer(userId, 'cus_fixture');
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        f.stripe.listInvoices.mockRejectedValueOnce(new Error('upstream private billing data'));
        await expect(f.caller.history()).resolves.toEqual([]);
        expect(log).toHaveBeenCalledExactlyOnceWith('Billing invoice history unavailable');
        await expect(f.caller.history()).resolves.toEqual(history);
    });
});

describe('Managed Payments configuration', () => {
    it('enables only the exact string 1 and defaults off', () => {
        expect(readBillingConfig({ BILLING_MANAGED_PAYMENTS: '1' }).managedPaymentsEnabled).toBe(true);
        for (const value of [undefined, '', '0', 'true', 'TRUE', 'yes', 'on', '01', ' 1', '1 ', '1\n']) {
            expect(readBillingConfig({ BILLING_MANAGED_PAYMENTS: value }).managedPaymentsEnabled).toBe(false);
        }
        expect(readBillingConfig({}).managedPaymentsEnabled).toBe(false);
        expect(readBillingConfig({ BILLING_AUTOMATIC_TAX: '1', BILLING_ADAPTIVE_PRICING: '1' }).managedPaymentsEnabled).toBe(false);
    });
});

describe('billing publishable-key configuration', () => {
    it.each(['STRIPE_PUBLISHABLE_KEY', 'STRIPE_KEY'])('accepts only public Stripe keys from %s', async name => {
        for (const value of ['pk_test_fixture', 'pk_live_fixture']) {
            expect(readBillingConfig({ [name]: ` ${value} ` }).stripePublishableKey).toBe(value);
        }
        for (const value of ['sk_test_fixture', 'sk_live_fixture', 'rk_test_fixture', 'whsec_fixture', 'pk_invalid', 'prefix_pk_test_fixture', '', ' ']) {
            const f = fixture();
            f.deps.config = readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture', [name]: value });
            expect(f.deps.config.stripePublishableKey).toBeUndefined();
            await checkoutControl(f);
        }
    });

    it('prefers the explicit public key and never sources it from the secret', () => {
        expect(readBillingConfig({ STRIPE_PUBLISHABLE_KEY: 'pk_live_explicit', STRIPE_KEY: 'pk_test_legacy' }).stripePublishableKey).toBe('pk_live_explicit');
        expect(readBillingConfig({ STRIPE_PUBLISHABLE_KEY: 'sk_test_invalid', STRIPE_KEY: 'pk_test_legacy' }).stripePublishableKey).toBeUndefined();
        expect(readBillingConfig({ STRIPE_SECRET: 'sk_test_fixture' }).stripePublishableKey).toBeUndefined();
    });
});
