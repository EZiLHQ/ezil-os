import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '@/server/billing/config';
import type { SubscriptionRow } from '@/server/billing/meters';
import type { BillingDeps, BillingStore, GrantRow, PlanChangeRow, OverageConsentRow, StripeApi, StripeCheckoutSession, StripeInvoiceSummary } from '@/server/billing/ports';
import { CATALOG_V2, type BillingErrorCode, OVERAGE_TERMS_VERSION } from '@/server/billing/v2/contract';
import { BillingProviderError, StripeRequestError } from '@/server/billing/stripe/client';
import { epochSeconds, isoSeconds } from '@/server/billing/v2/time';
import { upgradeGrantStdSeconds } from '@/server/billing/v2/rating';
import type { createTRPCContext } from '../trpc';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({
    getBillingDeps: () => { throw new Error('Tests must inject billing ports'); },
}));

import { createBillingRouter } from './billing';

const now = new Date('2026-10-11T12:00:00Z');
const sku = 'standard_monthly_v2';
const userId = '11111111-1111-4111-8111-111111111111';
const session: StripeCheckoutSession = {
    id: 'cs_fixture', customer: 'cus_fixture', clientReferenceId: userId,
    mode: 'subscription', status: 'open', paymentStatus: 'unpaid', paymentIntentId: null, sku,
};
const invoice: StripeInvoiceSummary = {
    id: 'in_fixture', number: 'INV-1', status: 'paid', amountPaidCents: 2000, amountDueCents: 2000, metadataKind: null, billingReason: null,
    currency: 'usd', created: now, hostedInvoiceUrl: 'https://invoice.stripe.com/fixture', description: 'EZiL Pro',
};
const history = [{
    id: invoice.id, number: invoice.number, status: invoice.status, amountPaidCents: invoice.amountPaidCents,
    kind: 'other', amountDueCents: invoice.amountDueCents,
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
    let consent: OverageConsentRow | null = null;
    const changes: PlanChangeRow[] = [];
    const isOpen = (row: PlanChangeRow) => ['pending', 'requires_action', 'payment_failed', 'scheduled'].includes(row.state);
    const store = {
        grantsForPeriod: vi.fn<BillingStore['grantsForPeriod']>().mockResolvedValue([]),
        openEpoch: vi.fn<BillingStore['openEpoch']>(async () => { throw new Error('Unused v2 store stub'); }),
        closeEpoch: vi.fn<BillingStore['closeEpoch']>(async () => { throw new Error('Unused v2 store stub'); }),
        epochsFor: vi.fn<BillingStore['epochsFor']>().mockResolvedValue([{
            id: 'epoch_fixture', userId, computerId: 'computer', size: 'free-cf', weight: 1,
            readyAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:00Z', endReason: 'user_stop', overheadSeconds: 0,
        }]),
        recordConsent: vi.fn<BillingStore['recordConsent']>(async input => consent = { ...input, id: BigInt(1) }),
        consentAsOf: vi.fn<BillingStore['consentAsOf']>().mockResolvedValue(null),
        consentDecisionsForPeriod: vi.fn<BillingStore['consentDecisionsForPeriod']>().mockResolvedValue([]),
        latestConsent: vi.fn<BillingStore['latestConsent']>(async () => consent),
        upsertOverageInvoice: vi.fn<BillingStore['upsertOverageInvoice']>(async () => { throw new Error('Unused v2 store stub'); }),
        attachOverageStripeInvoice: vi.fn<BillingStore['attachOverageStripeInvoice']>(async () => { throw new Error('Unused v2 store stub'); }),
        markOverageInvoiceOpen: vi.fn<BillingStore['markOverageInvoiceOpen']>(),
        setOverageInvoiceStatus: vi.fn<BillingStore['setOverageInvoiceStatus']>(async () => { throw new Error('Unused v2 store stub'); }),
        overageInvoiceByStripeId: vi.fn<BillingStore['overageInvoiceByStripeId']>(async () => { throw new Error('Unused v2 store stub'); }),
        overageInvoicesFor: vi.fn<BillingStore['overageInvoicesFor']>().mockResolvedValue([]),
        recordPlanChange: vi.fn<BillingStore['recordPlanChange']>(async input => {
            if (changes.some(row => row.subscriptionId === input.subscriptionId && row.kind === input.kind && isOpen(row))) return 'exists';
            changes.push({ ...input, id: `change_${changes.length}`, createdAt: now, updatedAt: now });
            return 'inserted';
        }),
        setPlanChangeState: vi.fn<BillingStore['setPlanChangeState']>(async input => {
            for (const row of changes.filter(row => row.userId === input.userId && row.subscriptionId === input.subscriptionId
                && row.kind === input.kind && isOpen(row))) {
                Object.assign(row, Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)));
            }
        }),
        openPlanChanges: vi.fn<BillingStore['openPlanChanges']>(async () => changes.filter(isOpen)),
        recordPaymentIssue: vi.fn<BillingStore['recordPaymentIssue']>(async () => { throw new Error('Unused v2 store stub'); }),
        resolvePaymentIssue: vi.fn<BillingStore['resolvePaymentIssue']>(async () => { throw new Error('Unused v2 store stub'); }),
        openPaymentIssues: vi.fn<BillingStore['openPaymentIssues']>().mockResolvedValue([]),
        setSizePreference: vi.fn<BillingStore['setSizePreference']>().mockResolvedValue(undefined),
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
        resolvePrice: vi.fn<StripeApi['resolvePrice']>(),
        previewUpgrade: vi.fn<StripeApi['previewUpgrade']>(async input => ({
            prorationDate: input.prorationDate, amountDueCents: 2400, currency: 'usd', lines: [{ description: 'Proration', amountCents: 2400 }],
            periodStart: subscription().currentPeriodStart!, periodEnd: subscription().currentPeriodEnd!,
        })),
        confirmUpgrade: vi.fn<StripeApi['confirmUpgrade']>().mockResolvedValue({ status: 'applied', invoiceId: 'in_upgrade', hostedInvoiceUrl: null, expiresAt: null }),
        scheduleDowngrade: vi.fn<StripeApi['scheduleDowngrade']>().mockResolvedValue({ scheduleId: 'sched_fixture', effectiveAt: subscription().currentPeriodEnd! }),
        cancelScheduledChange: vi.fn<StripeApi['cancelScheduledChange']>(),
        setCancelAtPeriodEnd: vi.fn<StripeApi['setCancelAtPeriodEnd']>(async input => ({ cancelsAt: input.cancel ? subscription().currentPeriodEnd : null })),

        createCustomer: vi.fn(async () => ({ id: 'cus_fixture' })),
        createCheckoutSession: vi.fn<StripeApi['createCheckoutSession']>(async input => ({
            id: session.id, url: input.uiMode === 'hosted' ? 'https://checkout.example/session' : null,
            clientSecret: input.uiMode === 'embedded' ? 'cs_fixture_secret_fixture' : null,
        })),
        listInvoices: vi.fn<StripeApi['listInvoices']>(async () => [{ ...invoice }]),
        createPortalSession: vi.fn(async () => ({ url: 'https://billing.example/portal' })),
        retrieveCheckoutSession: vi.fn(async () => ({ ...session })),
        retrieveSubscription: vi.fn<StripeApi['retrieveSubscription']>().mockResolvedValue({
            id: 'sub_fixture', customer: 'cus_fixture', status: 'active', sku, cancelAtPeriodEnd: false,
            currentPeriodStart: subscription().currentPeriodStart, currentPeriodEnd: subscription().currentPeriodEnd,
            items: [], defaultPaymentMethod: null, scheduleId: null, latestInvoiceId: null, pendingUpdateExpiresAt: null,
        }),
        retrieveInvoice: vi.fn<StripeApi['retrieveInvoice']>(),
        retrieveInvoicePaymentState: vi.fn<StripeApi['retrieveInvoicePaymentState']>(),
        retrieveCharge: vi.fn<StripeApi['retrieveCharge']>(),
    } satisfies StripeApi;
    const deps: BillingDeps = {
        config: readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'fixture-only' }),
        store, stripe, usage: null, now: () => now,
    };
    const ctx: Awaited<ReturnType<typeof createTRPCContext>> = {
        db: {} as Awaited<ReturnType<typeof createTRPCContext>>['db'],
        headers: new Headers({ origin: 'https://app.example' }),
        user: { id: userId, email: 'fixture@example.org', aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: now.toISOString() },
    };
    const router = createBillingRouter(() => deps);
    return { deps, store, stripe, ctx, router, changes, caller: router.createCaller(ctx) };
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
            readyAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:12Z', endReason: 'user_stop', overheadSeconds: 0,
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
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'pro_monthly_v1' })]);
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
            'latestConsent', 'openPaymentIssues', 'latestStorageFor', 'sizePreference', 'stripeCustomerFor', 'overageInvoicesFor'] as const;
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

    it.each(['ai_pack_10_v1', 'ai_pack_25_v1', 'pro_monthly_v1'])('refuses unsellable %s', async pack => {
        const f = fixture();
        await expect(f.caller.createCheckout({ sku: pack })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'unknown_sku' });
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
        await checkoutControl(f);
    });

    it('rejects unknown SKUs and permits the catalog Standard SKU', async () => {
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
        await expect(f.caller.createCheckout({ sku })).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR', message: 'stripe_unavailable' });
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

async function paidFixture(planSku = sku) {
    const f = fixture();
    await f.store.linkCustomer(userId, 'cus_fixture');
    f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: planSku })]);
    return f;
}

function change(overrides: Partial<PlanChangeRow> = {}): PlanChangeRow {
    return { id: 'change_fixture', userId, subscriptionId: 'sub_fixture', kind: 'upgrade', fromSku: sku,
        toSku: 'compute_monthly_v2', stripeInvoiceId: null, stripeScheduleId: null, hostedInvoiceUrl: null,
        state: 'pending', effectiveAt: null, expiresAt: null, createdAt: now, updatedAt: now, ...overrides };
}

const toCompute = { toSku: 'compute_monthly_v2' };
const toStandard = { toSku: 'standard_monthly_v2' };
const confirmInput = { ...toCompute, prorationDate: epochSeconds(now) };
const overageInput = { enabled: true, capCents: 2500, termsVersion: OVERAGE_TERMS_VERSION };
const errorCodes = [
    'billing_not_configured', 'unknown_sku', 'already_subscribed', 'not_subscribed', 'upgrade_not_allowed',
    'upgrade_pending', 'downgrade_not_allowed', 'cap_out_of_range', 'terms_version_mismatch', 'size_not_allowed',
    'customer_conflict', 'stripe_unavailable',
] as const satisfies readonly BillingErrorCode[];

type Fixture = ReturnType<typeof fixture>;
const mutations = [
    ['checkout', (f: Fixture) => f.caller.createCheckout({ sku })],
    ['preview', (f: Fixture) => f.caller.previewUpgrade(toCompute)],
    ['confirm', (f: Fixture) => f.caller.confirmUpgrade(confirmInput)],
    ['downgrade', (f: Fixture) => f.caller.scheduleDowngrade(toStandard)],
    ['cancel', (f: Fixture) => f.caller.cancelAtPeriodEnd({ cancel: true })],
    ['overage', (f: Fixture) => f.caller.setOverage(overageInput)],
    ['size', (f: Fixture) => f.caller.selectSize({ size: 'std-2' })],
    ['portal', (f: Fixture) => f.caller.portal()],
] as const;

async function domainFailure(call: () => Promise<unknown>, message: BillingErrorCode) {
    const error = await call().then(() => null, (error: unknown) => error);
    expect(error).toMatchObject({ message });
    expect(errorCodes).toContain((error as Error).message);
}

describe('billing v2 mutations', () => {
    it.each(mutations)('%s requires billing configuration and authentication', async (_name, call) => {
        for (const missing of ['flag', 'secret', 'stripe'] as const) {
            const f = fixture();
            if (missing === 'flag') f.deps.config.checkoutEnabled = false;
            if (missing === 'secret') f.deps.config.stripeSecret = undefined;
            if (missing === 'stripe') f.deps.stripe = null;
            await domainFailure(() => call(f), 'billing_not_configured');
            for (const method of Object.values(f.stripe)) expect(method).not.toHaveBeenCalled();
            for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
        }
        const f = fixture();
        f.caller = f.router.createCaller({ ...f.ctx, user: null });
        await expect(call(f)).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });

    it.each(['standard_monthly_v2', 'compute_monthly_v2'])('sells %s and strips smuggled checkout ownership', async sku => {
        const f = fixture();
        const input = { sku, userId: 'foreign', subscriptionId: 'sub_foreign' };
        await f.caller.createCheckout(input);
        expect(f.stripe.createCustomer).toHaveBeenCalledWith(expect.objectContaining({ userId }));
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ sku, userId, customerId: 'cus_fixture' }));
        expect(f.stripe.createCheckoutSession.mock.calls[0][0]).not.toHaveProperty('subscriptionId');
    });

    it('echoes the preview proration date, grants whole seconds, and inserts before confirming', async () => {
        const f = await paidFixture();
        f.deps.now = () => new Date(now.getTime() + 999);
        const preview = await f.caller.previewUpgrade({ ...toCompute, userId: 'foreign', subscriptionId: 'sub_foreign' } as typeof toCompute);
        const periodStart = isoSeconds(epochSeconds(subscription().currentPeriodStart!));
        const periodEnd = isoSeconds(epochSeconds(subscription().currentPeriodEnd!));
        expect(preview).toEqual({ ...toCompute, prorationDate: epochSeconds(now), amountDueCents: 2400, currency: 'usd',
            lines: [{ description: 'Proration', amountCents: 2400 }], periodEnd,
            grantStdSeconds: upgradeGrantStdSeconds({ fromSku: sku, toSku: 'compute_monthly_v2', periodStart, periodEnd, effectiveAt: isoSeconds(epochSeconds(now)) }) });
        f.stripe.confirmUpgrade.mockImplementationOnce(async () => {
            expect(f.changes).toEqual([expect.objectContaining({ state: 'pending', userId, subscriptionId: 'sub_fixture' })]);
            return { status: 'applied', invoiceId: 'in_upgrade', hostedInvoiceUrl: null, expiresAt: null };
        });
        const smuggled = { ...toCompute, prorationDate: preview.prorationDate, userId: 'foreign', subscriptionId: 'sub_foreign' };
        await expect(f.caller.confirmUpgrade(smuggled)).resolves.toEqual({ status: 'applied', invoiceId: 'in_upgrade', hostedInvoiceUrl: null, expiresAt: null });
        expect(f.stripe.confirmUpgrade).toHaveBeenCalledWith({ subscriptionId: 'sub_fixture', ...confirmInput,
            now: f.deps.now(), idempotencyKey: `upgrade:sub_fixture:${preview.prorationDate}` });
        expect(f.changes[0]).toMatchObject({ state: 'applied', stripeInvoiceId: 'in_upgrade', effectiveAt: now });
        expect(f.stripe.retrieveSubscription).toHaveBeenCalledTimes(2);
        expect(f.stripe.retrieveSubscription).toHaveBeenCalledWith('sub_fixture');
    });

    it.each(['requires_action', 'payment_failed'] as const)('persists and serializes %s upgrade details', async status => {
        const f = await paidFixture();
        const expiresAt = new Date(now.getTime() + 600_999);
        const hostedInvoiceUrl = 'https://invoice.example/action';
        f.stripe.confirmUpgrade.mockResolvedValue({ status, invoiceId: 'in_pending', hostedInvoiceUrl, expiresAt });
        await expect(f.caller.confirmUpgrade(confirmInput)).resolves.toEqual({ status, invoiceId: 'in_pending', hostedInvoiceUrl,
            expiresAt: isoSeconds(epochSeconds(expiresAt)) });
        expect(f.changes[0]).toMatchObject({ state: status, stripeInvoiceId: 'in_pending', hostedInvoiceUrl, expiresAt, effectiveAt: null });
        await domainFailure(() => f.caller.confirmUpgrade(confirmInput), 'upgrade_pending');
        expect(f.stripe.confirmUpgrade).toHaveBeenCalledTimes(1);
    });

    it('handles a concurrent upgrade insert without touching Stripe', async () => {
        const f = await paidFixture();
        f.store.recordPlanChange.mockResolvedValueOnce('exists');
        await domainFailure(() => f.caller.confirmUpgrade(confirmInput), 'upgrade_pending');
        expect(f.stripe.confirmUpgrade).not.toHaveBeenCalled();
    });

    it.each(['preview', 'confirm'] as const)('%s upgrade refusals use only BillingErrorCode messages', async operation => {
        const call = (f: Fixture, toSku = 'compute_monthly_v2') => operation === 'preview'
            ? f.caller.previewUpgrade({ toSku }) : f.caller.confirmUpgrade({ ...confirmInput, toSku });
        for (const wrong of ['standard_monthly_v2', 'pro_monthly_v1', 'invented']) {
            await domainFailure(() => call(fixture(), wrong), 'unknown_sku');
        }
        await domainFailure(() => call(fixture()), 'not_subscribed');
        for (const overrides of [{ sku: 'compute_monthly_v2' }, { sku: 'pro_monthly_v1' }, { cancelAtPeriodEnd: true }]) {
            const f = await paidFixture();
            f.store.subscriptionsFor.mockResolvedValue([subscription(overrides)]);
            await domainFailure(() => call(f), 'upgrade_not_allowed');
        }
        for (const status of ['past_due', 'incomplete', 'canceled']) {
            const f = await paidFixture();
            f.store.subscriptionsFor.mockResolvedValue([subscription({ status })]);
            await domainFailure(() => call(f), 'not_subscribed');
        }
        for (const state of ['pending', 'requires_action', 'payment_failed'] as const) {
            const f = await paidFixture();
            f.changes.push(change({ state }));
            await domainFailure(() => call(f), 'upgrade_pending');
        }
        const f = await paidFixture();
        f.changes.push(change({ kind: 'downgrade', state: 'scheduled' }));
        await domainFailure(() => call(f), 'upgrade_not_allowed');
        f.changes.length = 0;
        f.stripe.retrieveSubscription.mockResolvedValue({ ...(await f.stripe.retrieveSubscription('sub_fixture')), scheduleId: 'sched_existing' });
        await domainFailure(() => call(f), 'upgrade_not_allowed');
        expect(f.stripe.previewUpgrade).not.toHaveBeenCalled();
        expect(f.stripe.confirmUpgrade).not.toHaveBeenCalled();
    });

    it('schedules a downgrade, persists its identity, and ignores foreign plan changes', async () => {
        const f = await paidFixture('compute_monthly_v2');
        f.changes.push(change({ subscriptionId: 'sub_foreign', kind: 'downgrade', state: 'scheduled' }));
        const input = { ...toStandard, userId: 'foreign', subscriptionId: 'sub_foreign' };
        await expect(f.caller.scheduleDowngrade(input)).resolves.toEqual({ effectiveAt: '2026-10-20T00:00:00Z' });
        expect(f.stripe.scheduleDowngrade).toHaveBeenCalledWith({ subscriptionId: 'sub_fixture', ...toStandard,
            idempotencyKey: `downgrade:sub_fixture:${epochSeconds(subscription().currentPeriodEnd!)}` });
        expect(f.changes[1]).toMatchObject({ userId, subscriptionId: 'sub_fixture', kind: 'downgrade', state: 'scheduled', stripeScheduleId: 'sched_fixture' });
        await domainFailure(() => f.caller.scheduleDowngrade(toStandard), 'downgrade_not_allowed');
        expect(f.stripe.scheduleDowngrade).toHaveBeenCalledTimes(1);
    });

    it('maps all downgrade refusals', async () => {
        await domainFailure(() => fixture().caller.scheduleDowngrade(toCompute), 'unknown_sku');
        await domainFailure(() => fixture().caller.scheduleDowngrade(toStandard), 'not_subscribed');
        for (const overrides of [{ sku }, { sku: 'pro_monthly_v1' }, { sku: 'compute_monthly_v2', cancelAtPeriodEnd: true }]) {
            const f = await paidFixture();
            f.store.subscriptionsFor.mockResolvedValue([subscription(overrides)]);
            await domainFailure(() => f.caller.scheduleDowngrade(toStandard), 'downgrade_not_allowed');
        }
    });

    it('releases the downgrade before canceling and checks tenancy before both writes', async () => {
        const f = await paidFixture('compute_monthly_v2');
        f.changes.push(change({ kind: 'downgrade', state: 'scheduled', stripeScheduleId: 'sched_fixture' }));
        f.stripe.setCancelAtPeriodEnd.mockImplementationOnce(async () => {
            expect(f.changes[0].state).toBe('canceled');
            expect(f.stripe.cancelScheduledChange).toHaveBeenCalledExactlyOnceWith({ scheduleId: 'sched_fixture' });
            expect(f.stripe.retrieveSubscription).toHaveBeenCalledTimes(2);
            return { cancelsAt: subscription().currentPeriodEnd };
        });
        const input = { cancel: true, userId: 'foreign', subscriptionId: 'sub_foreign' };
        await expect(f.caller.cancelAtPeriodEnd(input)).resolves.toEqual({ cancelsAt: '2026-10-20T00:00:00Z' });
        expect(f.stripe.setCancelAtPeriodEnd).toHaveBeenCalledWith({ subscriptionId: 'sub_fixture', cancel: true,
            idempotencyKey: `cancel:sub_fixture:true:${epochSeconds(now)}` });
        await expect(f.caller.cancelAtPeriodEnd({ cancel: false })).resolves.toEqual({ cancelsAt: null });
    });

    it('does not release a downgrade when resuming, and blocks cancel for Free or pending upgrades', async () => {
        await domainFailure(() => fixture().caller.cancelAtPeriodEnd({ cancel: true }), 'not_subscribed');
        const f = await paidFixture();
        f.changes.push(change());
        await domainFailure(() => f.caller.cancelAtPeriodEnd({ cancel: true }), 'upgrade_pending');
        f.changes[0] = change({ kind: 'downgrade', state: 'scheduled', stripeScheduleId: 'sched_fixture' });
        await expect(f.caller.cancelAtPeriodEnd({ cancel: false })).resolves.toEqual({ cancelsAt: null });
        expect(f.changes[0].state).toBe('scheduled');
        expect(f.stripe.cancelScheduledChange).not.toHaveBeenCalled();
    });

    it.each([-100, 0, 2500, 10000, 10100, 2550, 25.5])('validates overage cap %s and records only authenticated consent', async capCents => {
        const f = await paidFixture('compute_monthly_v2');
        const input = { ...overageInput, capCents, userId: 'foreign', subscriptionId: 'sub_foreign', actor: 'foreign', rateCentsPerStdHour: 1 };
        if ([0, 2500, 10000].includes(capCents)) {
            await expect(f.caller.setOverage(input)).resolves.toMatchObject({ enabled: true, capCents, acceptedVersion: OVERAGE_TERMS_VERSION });
            expect(f.store.recordConsent).toHaveBeenCalledExactlyOnceWith({ userId, subscriptionId: 'sub_fixture', enabled: true,
                capCents, termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: 2, rateCentsPerStdHour: 25, actor: userId, acceptedAt: now });
        } else {
            await domainFailure(() => f.caller.setOverage(input), 'cap_out_of_range');
            expect(f.store.recordConsent).not.toHaveBeenCalled();
        }
    });

    it('requires current overage terms and an active Compute plan', async () => {
        await domainFailure(() => fixture().caller.setOverage({ ...overageInput, termsVersion: 'old' }), 'terms_version_mismatch');
        await domainFailure(() => fixture().caller.setOverage(overageInput), 'not_subscribed');
        for (const overrides of [{ sku }, { sku: 'pro_monthly_v1' }, { sku: 'compute_monthly_v2', cancelAtPeriodEnd: true },
            { sku: 'compute_monthly_v2', status: 'past_due' }]) {
            const f = await paidFixture();
            f.store.subscriptionsFor.mockResolvedValue([subscription(overrides)]);
            await domainFailure(() => f.caller.setOverage(overageInput), 'not_subscribed');
        }
    });

    it.each([
        { status: 'active' }, { status: 'active', cancelAtPeriodEnd: true }, { status: 'past_due' },
        { status: 'incomplete' }, { status: 'incomplete', currentPeriodStart: null, currentPeriodEnd: null },
        { status: 'unpaid' }, { status: 'canceled' }, { status: 'incomplete_expired' }, { status: 'paused' },
        { status: 'active', currentPeriodEnd: new Date('2026-10-01T00:00:00Z') },
    ])('allows Compute opt-out for %o using only the session-owned subscription', async overrides => {
        const f = await paidFixture('compute_monthly_v2');
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'compute_monthly_v2', ...overrides })]);
        const input = { ...overageInput, enabled: false, subscriptionId: 'sub_foreign', userId: 'foreign' };
        await expect(f.caller.setOverage(input))
            .resolves.toMatchObject({ enabled: false });
        expect(f.store.subscriptionsFor).toHaveBeenCalledWith(userId);
        expect(f.store.recordConsent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ userId,
            subscriptionId: 'sub_fixture', actor: userId, enabled: false }));
        if (overrides.status !== 'active' || overrides.cancelAtPeriodEnd) {
            await domainFailure(() => f.caller.setOverage(overageInput), 'not_subscribed');
        }
    });

    it('allows opting out of an owned Compute subscription while Standard supplies the current plan', async () => {
        const f = await paidFixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription(), subscription({ stripeSubscriptionId: 'sub_compute',
            sku: 'compute_monthly_v2', status: 'past_due' })]);
        await expect(f.caller.setOverage({ ...overageInput, enabled: false })).resolves.toMatchObject({ enabled: false, available: false });
        expect(f.store.recordConsent).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
            userId, subscriptionId: 'sub_compute', enabled: false, actor: userId,
        }));
    });

    it.each(['open', 'payment_failed', 'requires_action', 'uncollectible'] as const)('keeps overage paused for a %s invoice without an issue row', async status => {
        const f = await paidFixture('compute_monthly_v2');
        await f.caller.setOverage(overageInput);
        f.store.overageInvoicesFor.mockResolvedValue([{ id: 'previous', userId, subscriptionId: 'sub_fixture',
            periodStart: new Date('2026-08-20T00:00:00Z'), periodEnd: subscription().currentPeriodStart!,
            ratingVersion: 1, stdSecondsOver: BigInt(14400), cents: 100, stripeInvoiceId: 'in_previous', status,
            createdAt: now, updatedAt: now }]);
        await expect(f.caller.summary()).resolves.toMatchObject({ overage: { enabled: false, pausedReason: 'payment_failed' } });
        await domainFailure(() => f.caller.setOverage(overageInput), 'not_subscribed');
        await expect(f.caller.setOverage({ ...overageInput, enabled: false })).resolves.toMatchObject({ enabled: false });
    });

    it('blocks enabling unresolved overage issues, permits disabling, and isolates other subscriptions', async () => {
        const f = await paidFixture('compute_monthly_v2');
        const issue = { userId, subscriptionId: 'sub_fixture', stripeInvoiceId: 'in_overage', invoiceKind: 'overage' as const,
            issue: 'requires_action' as const, hostedInvoiceUrl: null, stripeEventCreated: now, resolvedAt: null, updatedAt: now };
        for (const kind of ['payment_failed', 'requires_action', 'voided', 'uncollectible'] as const) {
            f.store.openPaymentIssues.mockResolvedValue([{ ...issue, issue: kind }]);
            await domainFailure(() => f.caller.setOverage(overageInput), 'not_subscribed');
        }
        f.store.openPaymentIssues.mockResolvedValue([issue]);
        await expect(f.caller.setOverage({ ...overageInput, enabled: false })).resolves.toMatchObject({ enabled: false, pausedReason: 'payment_failed' });
        f.store.openPaymentIssues.mockResolvedValue([{ ...issue, subscriptionId: 'sub_foreign' }]);
        await expect(f.caller.setOverage(overageInput)).resolves.toMatchObject({ enabled: true });
        f.store.openPaymentIssues.mockResolvedValue([{ ...issue, resolvedAt: now }]);
        await expect(f.caller.setOverage(overageInput)).resolves.toMatchObject({ enabled: true });
    });

    it.each(['free_v1_legacy', 'standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1'] as const)('selects only %s sizes', async planSku => {
        const f = planSku === 'free_v1_legacy' ? fixture() : await paidFixture(planSku);
        for (const size of ['free-cf', 'std-2', 'cmp-4', 'cmp-8', 'unknown']) {
            const allowed = CATALOG_V2[planSku].sizes.some(code => code === size);
            if (allowed) {
                const input = { size, userId: 'foreign', subscriptionId: 'sub_foreign' };
                await expect(f.caller.selectSize(input)).resolves.toEqual({ selectedSize: size });
                expect(f.store.setSizePreference).toHaveBeenLastCalledWith(userId, size);
            } else await domainFailure(() => f.caller.selectSize({ size }), 'size_not_allowed');
        }
    });

    it.each(['preview', 'confirm', 'downgrade', 'cancel', 'portal'] as const)('%s refuses foreign Stripe ownership before all writes', async name => {
        const f = await paidFixture(name === 'downgrade' || name === 'cancel' ? 'compute_monthly_v2' : sku);
        const sub = await f.stripe.retrieveSubscription('sub_fixture');
        f.stripe.retrieveSubscription.mockClear().mockResolvedValue({ ...sub, customer: 'cus_foreign' });
        if (name === 'cancel') f.changes.push(change({ kind: 'downgrade', state: 'scheduled', stripeScheduleId: 'sched_fixture' }));
        const call = mutations.find(([label]) => label === name)![1];
        await domainFailure(() => call(f), 'customer_conflict');
        for (const [method, mock] of Object.entries(f.stripe)) {
            if (method !== 'retrieveSubscription') expect(mock, method).not.toHaveBeenCalled();
        }
        expect(f.store.recordPlanChange).not.toHaveBeenCalled();
        expect(f.store.setPlanChangeState).not.toHaveBeenCalled();
    });

    it.each(['preview', 'confirm', 'downgrade'] as const)('%s maps provider failures without exposing their messages', async name => {
        for (const error of [new BillingProviderError('price_not_found'), new BillingProviderError('portal_configuration_missing'),
            new BillingProviderError('preview_expired'), new BillingProviderError('invalid_subscription_state'),
            new StripeRequestError(500, 'private data', 'api_error'), new Error('private data')]) {
            const f = await paidFixture(name === 'downgrade' ? 'compute_monthly_v2' : sku);
            const log = vi.spyOn(console, 'error').mockImplementation(() => {});
            const method = name === 'preview' ? f.stripe.previewUpgrade : name === 'confirm' ? f.stripe.confirmUpgrade : f.stripe.scheduleDowngrade;
            method.mockRejectedValueOnce(error);
            const disallowed = error instanceof BillingProviderError && ['preview_expired', 'invalid_subscription_state'].includes(error.code);
            await domainFailure(() => mutations.find(([label]) => label === name)![1](f),
                disallowed ? name === 'downgrade' ? 'downgrade_not_allowed' : 'upgrade_not_allowed' : 'stripe_unavailable');
            if (disallowed) expect(log).not.toHaveBeenCalled();
            else expect(log).toHaveBeenCalledExactlyOnceWith('Billing Stripe unavailable');
            if (name === 'confirm') expect(f.changes[0].state).toBe('canceled');
            log.mockRestore();
        }
    });

    it.each(['customer', 'checkout', 'retrieve', 'cancel', 'release', 'portal', 'status'] as const)('sanitizes %s Stripe errors', async name => {
        const f = name === 'customer' || name === 'checkout' ? fixture() : await paidFixture();
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const error = new Error('private customer and card details');
        if (name === 'customer') f.stripe.createCustomer.mockRejectedValue(error);
        if (name === 'checkout') f.stripe.createCheckoutSession.mockRejectedValue(error);
        if (name === 'retrieve') f.stripe.retrieveSubscription.mockRejectedValue(error);
        if (name === 'cancel') f.stripe.setCancelAtPeriodEnd.mockRejectedValue(error);
        if (name === 'release') {
            f.changes.push(change({ kind: 'downgrade', state: 'scheduled', stripeScheduleId: 'sched_fixture' }));
            f.stripe.cancelScheduledChange.mockRejectedValue(error);
        }
        if (name === 'portal') f.stripe.createPortalSession.mockRejectedValue(new BillingProviderError('portal_configuration_missing'));
        if (name === 'status') f.stripe.retrieveCheckoutSession.mockRejectedValue(error);
        await domainFailure(() => name === 'customer' || name === 'checkout' ? f.caller.createCheckout({ sku })
            : name === 'status' ? f.caller.checkoutStatus({ sessionId: session.id })
                : name === 'portal' ? f.caller.portal() : f.caller.cancelAtPeriodEnd({ cancel: true }), 'stripe_unavailable');
        expect(log).toHaveBeenCalledExactlyOnceWith('Billing Stripe unavailable');
        if (name === 'release') {
            expect(f.changes[0].state).toBe('scheduled');
            expect(f.stripe.setCancelAtPeriodEnd).not.toHaveBeenCalled();
        }
    });

    it('covers remaining domain errors with pinned messages', async () => {
        const f = fixture();
        await domainFailure(() => f.caller.portal(), 'not_subscribed');
        await domainFailure(() => f.caller.createCheckout({ sku: 'bad' }), 'unknown_sku');
        f.store.linkCustomer.mockResolvedValueOnce('conflict');
        await domainFailure(() => f.caller.createCheckout({ sku }), 'customer_conflict');
        f.store.subscriptionsFor.mockResolvedValue([subscription()]);
        await domainFailure(() => f.caller.createCheckout({ sku }), 'already_subscribed');
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, clientReferenceId: 'foreign' });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'not_subscribed' });
        await domainFailure(() => f.caller.checkoutStatus({ sessionId: '' }), 'not_subscribed');
    });

    it('distinguishes subscription, overage, and other invoices including amount due', async () => {
        const f = await paidFixture();
        f.stripe.listInvoices.mockResolvedValue([
            { ...invoice, id: 'overage', metadataKind: 'overage', billingReason: 'subscription_cycle', amountDueCents: 2500 },
            { ...invoice, id: 'subscription', billingReason: 'subscription_update' },
            { ...invoice, id: 'other', billingReason: 'manual' },
        ]);
        expect((await f.caller.history()).map(({ id, kind, amountDueCents }) => ({ id, kind, amountDueCents }))).toEqual([
            { id: 'overage', kind: 'overage', amountDueCents: 2500 },
            { id: 'subscription', kind: 'subscription', amountDueCents: 2000 },
            { id: 'other', kind: 'other', amountDueCents: 2000 },
        ]);
    });
});
