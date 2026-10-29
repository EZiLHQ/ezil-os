import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '@/server/billing/config';
import * as catalog from '@/server/billing/catalog';
import type { AiTopupReceiptStore } from '@/server/billing/ai-credits';
import { processStripeEvent } from '@/server/billing/processor';
import type { SubscriptionRow } from '@/server/billing/meters';
import { packProduct, packPrice, packCoupon, offeredPack, productResponse, priceResponse, couponResponse } from '@/server/billing/stripe/packs.test-support';
import { resetStripePackCachesForTests } from '@/server/billing/stripe/packs';
import type { BillingDeps, BillingStore, GrantRow, PlanChangeRow, OverageConsentRow, StripeApi, StripeCheckoutSession, StripeInvoiceSummary } from '@/server/billing/ports';
import { CATALOG_V2, type BillingErrorCode, OVERAGE_TERMS_VERSION } from '@/server/billing/v2/contract';
import { BillingProviderError, createStripeClient, StripeRequestError } from '@/server/billing/stripe/client';
import { epochSeconds, isoSeconds } from '@/server/billing/v2/time';
import { upgradeGrantSeconds } from '@/server/billing/v3/catalog';
import type { createTRPCContext } from '../trpc';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ schedulePaidMigration: vi.fn() }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({
    getBillingDeps: () => { throw new Error('Tests must inject billing ports'); },
}));

import { createBillingRouter, userPlacementProvider } from './billing';

const now = new Date('2026-10-11T12:00:00Z');
const sku = 'standard_monthly_v3';
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

afterEach(() => { vi.restoreAllMocks(); resetStripePackCachesForTests(); });

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
        openEpochFor: vi.fn<BillingStore['openEpochFor']>(async () => { throw new Error('Unused v2 store stub'); }),
        touchEpoch: vi.fn<BillingStore['touchEpoch']>(async () => { throw new Error('Unused v2 store stub'); }),
        openEpochsForSweep: vi.fn<BillingStore['openEpochsForSweep']>(async () => { throw new Error('Unused v2 store stub'); }),
        policyClosedEpochsSince: vi.fn<BillingStore['policyClosedEpochsSince']>(async () => { throw new Error('Unused v2 store stub'); }),
        closeEpoch: vi.fn<BillingStore['closeEpoch']>(async () => { throw new Error('Unused v2 store stub'); }),
        epochsFor: vi.fn<BillingStore['epochsFor']>().mockResolvedValue([{
            id: 'epoch_fixture', userId, computerId: 'computer', size: 'free-cf', weight: 1,
            readyAt: '2026-10-01T00:00:00Z', endedAt: '2026-10-01T00:01:00Z', endReason: 'user_stop', overheadSeconds: 0, deadlineAt: null, lastHeartbeatAt: null,
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
        listProducts: vi.fn<StripeApi['listProducts']>().mockResolvedValue([packProduct]),
        retrieveProduct: vi.fn<StripeApi['retrieveProduct']>().mockResolvedValue(packProduct),
        retrievePackPrice: vi.fn<StripeApi['retrievePackPrice']>().mockResolvedValue(packPrice),
        retrieveCoupon: vi.fn<StripeApi['retrieveCoupon']>().mockResolvedValue(packCoupon),
        retrieveCheckoutLineItems: vi.fn<StripeApi['retrieveCheckoutLineItems']>().mockResolvedValue([{ quantity: 1, price: packPrice }]),
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
        config: readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' }),
        store, stripe, usage: null, now: () => now,
    };
    const ctx: Awaited<ReturnType<typeof createTRPCContext>> = {
        db: {} as Awaited<ReturnType<typeof createTRPCContext>>['db'],
        headers: new Headers({ origin: 'https://os.ezil.work' }),
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
    it('does no store reads with the tab off and returns v3 legacy Free with epochs when enabled', async () => {
        const f = fixture();
        f.deps.config.tabEnabled = false;
        await expect(f.caller.summary()).resolves.toEqual({ enabled: false });
        for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
        f.deps.config.tabEnabled = true;
        await expect(f.caller.summary()).resolves.toMatchObject({ enabled: true, version: 3,
            plan: { sku: 'free_v3' }, fairUse: { status: 'ok' },
            computer: { sessionMaxSeconds: 3600 }, storage: { usedBytes: '123' } });
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
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { sku: 'legacy', name: 'Standard (legacy)' }, fairUse: { status: 'ok' } });
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
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { sku: 'legacy', name: 'Compute (legacy)' },
            computer: { vcpu: 8, memoryGiB: 32, sessionMaxSeconds: 21600 }, fairUse: { status: 'paused' } });
    });

    it('loads both compute and legacy workspace grants for Pro', async () => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'pro_monthly_v1' })]);
        f.store.grantsForPeriod.mockResolvedValue([grant(72000, 'workspace_seconds')]);
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { sku: 'legacy', name: 'Pro (legacy)' }, fairUse: { status: 'ok' } });
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
        f.deps.config.stripeSecret = 'sk_test_fixture';
        f.deps.stripe = f.stripe;
        await checkoutControl(f);
        await expect(f.caller.portal()).resolves.toEqual({ url: 'https://billing.example/portal' });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'pending', paymentStatus: 'unpaid', sku });
        await expect(f.caller.history()).resolves.toEqual(history);
        expect(f.stripe.listInvoices).toHaveBeenCalledWith('cus_fixture', 12);
        expect(f.stripe.createPortalSession).toHaveBeenCalledTimes(1);
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledTimes(1);
    });

    it.each(['ai_pack_10_v1', 'ai_pack_25_v1', 'pro_monthly_v1'])('refuses unsellable %s', async pack => {
        const f = fixture();
        await expect(f.caller.createCheckout({ sku: pack as typeof sku })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
        await checkoutControl(f);
    });

    it('rejects unknown SKUs and permits the catalog Standard SKU', async () => {
        const f = fixture();
        await expect(f.caller.createCheckout({ sku: 'invented' as typeof sku })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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
            uiMode: 'hosted', returnUrl: 'https://os.ezil.work/billing/return?session_id={CHECKOUT_SESSION_ID}',
            successUrl: 'https://os.ezil.work/billing/return?session_id={CHECKOUT_SESSION_ID}', cancelUrl: 'https://os.ezil.work/os',
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
        expect(f.stripe.createPortalSession).toHaveBeenCalledWith({ customerId: 'cus_fixture', returnUrl: 'https://os.ezil.work/os' });
    });

    it.each(['other-user', null])('hides sessions belonging to %s with an owner control', async owner => {
        const f = fixture();
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, clientReferenceId: owner });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, status: 'complete' });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'complete', paymentStatus: 'unpaid', sku });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenNthCalledWith(1, session.id);
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenNthCalledWith(2, session.id);
    });

    it.each(['open', 'complete', 'expired'] as const)('maps %s from a fresh Stripe read', async status => {
        const f = fixture();
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, status });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: status === 'open' ? 'pending' : status, paymentStatus: 'unpaid', sku });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledWith(session.id);
    });

    it.each(['unpaid', 'paid', 'no_payment_required'] as const)('reports complete Checkout and %s independently without granting a plan', async paymentStatus => {
        const f = fixture();
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, status: 'complete', paymentStatus });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'complete', paymentStatus, sku });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledExactlyOnceWith(session.id);
        for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it.each([undefined, null, 'unexpected'])('does not infer payment when Stripe payment status is %s', async paymentStatus => {
        const f = fixture();
        // Simulate an incomplete/unknown provider response at the runtime boundary.
        const response = { ...session, status: 'complete', paymentStatus } as unknown as StripeCheckoutSession;
        if (paymentStatus === undefined) delete (response as Partial<StripeCheckoutSession>).paymentStatus;
        f.stripe.retrieveCheckoutSession.mockResolvedValue(response);
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'complete', paymentStatus: null, sku });
        for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
    });

    it.each(['standard_monthly_v3', 'premium_monthly_v3', 'compute_monthly_v2'])('returns the verified session SKU %s without looking up or granting a plan', async checkoutSku => {
        const f = fixture();
        f.stripe.retrieveCheckoutSession.mockResolvedValue({ ...session, status: 'complete', paymentStatus: 'paid', sku: checkoutSku });
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'complete', paymentStatus: 'paid', sku: checkoutSku });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledExactlyOnceWith(session.id);
        for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it.each([undefined, null, '', '   ', 42, false, {}])('does not invent a target SKU for invalid session metadata %j', async checkoutSku => {
        const f = fixture();
        const response = { ...session, status: 'complete', paymentStatus: 'paid', sku: checkoutSku } as unknown as StripeCheckoutSession;
        if (checkoutSku === undefined) delete (response as Partial<StripeCheckoutSession>).sku;
        f.stripe.retrieveCheckoutSession.mockResolvedValue(response);
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'complete', paymentStatus: 'paid', sku: null });
        for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
    });

    it.each(['', 'cs_', 'pi_fixture', 'cs_bad/path', 'cs_bad?query'])('rejects malformed session id %s before reading Stripe', async sessionId => {
        const f = fixture();
        await expect(f.caller.checkoutStatus({ sessionId })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(f.stripe.retrieveCheckoutSession).toHaveBeenCalledTimes(0);
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'pending', paymentStatus: 'unpaid', sku });
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
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'pending', paymentStatus: 'unpaid', sku });
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
            returnUrl: 'https://os.ezil.work/billing/return?session_id={CHECKOUT_SESSION_ID}',
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
        // A set-but-invalid publishable value is a misconfiguration: never sent to
        // a browser, and checkout refuses rather than silently selling hosted.
        for (const value of ['sk_test_fixture', 'sk_live_fixture', 'rk_test_fixture', 'whsec_fixture', 'pk_invalid', 'prefix_pk_test_fixture']) {
            const f = fixture();
            f.deps.config = readBillingConfig({ CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture', [name]: value });
            expect(f.deps.config.stripePublishableKey).toBeUndefined();
            await expect(f.caller.createCheckout({ sku })).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
            expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(0);
        }
        for (const value of ['', ' ']) {
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

describe('billing top-up checkout', () => {
    function topupFixture() {
        const f = fixture();
        f.deps.config.stripePublishableKey = 'pk_test_fixture';
        return f;
    }

    it('keeps custom checkout available during a catalog failure and rejects missing packs', async () => {
        const f = topupFixture();
        f.stripe.listProducts.mockRejectedValue(new Error('unavailable'));
        await expect(f.caller.createTopupCheckout({ sku: 'ai_pack_fixture' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'unknown_pack' });
        await expect(f.caller.createTopupCheckout({ customAmountCents: 1000 })).resolves.toMatchObject({ sessionId: session.id });
        expect(await f.caller.summary()).toMatchObject({ catalog: { packs: [] }, actions: { topup: true } });
        f.deps.stripe = null;
        expect(await f.caller.summary()).toMatchObject({ catalog: { packs: [] }, actions: { topup: false } });
    });

    it('creates and reuses the authenticated customer for embedded payment on any plan', async () => {
        const f = topupFixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription()]);
        const input = { sku: 'ai_pack_fixture' };
        await expect(f.caller.createTopupCheckout(input)).resolves.toEqual({
            sessionId: session.id, clientSecret: 'cs_fixture_secret_fixture', publishableKey: 'pk_test_fixture' });
        await f.caller.createTopupCheckout(input);
        expect(f.stripe.createCustomer).toHaveBeenCalledTimes(1);
        expect(f.stripe.createCustomer).toHaveBeenCalledWith({ userId, email: 'fixture@example.org', idempotencyKey: `customer:${userId}` });
        expect(f.store.linkCustomer).toHaveBeenCalledWith(userId, 'cus_fixture');
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({
            customerId: 'cus_fixture', userId, sku: input.sku, uiMode: 'embedded', adaptivePricing: false,
            returnUrl: 'https://os.ezil.work/billing/return?session_id={CHECKOUT_SESSION_ID}' }));
        const calls = f.stripe.createCheckoutSession.mock.calls;
        expect(calls[0]![0].idempotencyKey).not.toBe(calls[1]![0].idempotencyKey);
    });

    it.each(['unknown', 'ai_pack_10_v1', 'ai_pack_25_v1', 'ai_custom_v2', sku])('refuses unknown or unsellable pack %s', async sku => {
        const f = topupFixture();
        await expect(f.caller.createTopupCheckout({ sku })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'unknown_pack' });
        expect(f.stripe.createCustomer).not.toHaveBeenCalled();
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('refuses a pack with an ineligible credit policy', async () => {
        const f = topupFixture();
        vi.spyOn(catalog, 'aiPackCheckoutEligible').mockReturnValue(false);
        await expect(f.caller.createTopupCheckout({ sku: 'ai_pack_fixture' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'unknown_pack' });
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it.each(['flag', 'secret', 'client', 'publishableKey'] as const)('uses the existing disabled error without %s', async missing => {
        const f = topupFixture();
        if (missing === 'flag') f.deps.config.checkoutEnabled = false;
        if (missing === 'secret') f.deps.config.stripeSecret = undefined;
        if (missing === 'client') f.deps.stripe = null;
        if (missing === 'publishableKey') f.deps.config.stripePublishableKey = undefined;
        await expect(f.caller.createTopupCheckout({ sku: 'ai_pack_fixture' })).rejects.toMatchObject({
            code: 'PRECONDITION_FAILED', message: 'billing_not_configured' });
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('requires authentication before creating a top-up', async () => {
        const f = topupFixture();
        await expect(f.router.createCaller({ ...f.ctx, user: null }).createTopupCheckout({ sku: 'ai_pack_fixture' }))
            .rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        expect(f.stripe.createCustomer).not.toHaveBeenCalled();
    });

    it('refuses a conflicting customer and a missing embedded secret', async () => {
        const f = topupFixture();
        f.store.linkCustomer.mockResolvedValueOnce('conflict');
        await expect(f.caller.createTopupCheckout({ sku: 'ai_pack_fixture' })).rejects.toMatchObject({ code: 'CONFLICT', message: 'customer_conflict' });
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
        f.stripe.createCheckoutSession.mockResolvedValueOnce({ id: session.id, url: null, clientSecret: null });
        await expect(f.caller.createTopupCheckout({ sku: 'ai_pack_fixture' })).rejects.toMatchObject({ message: 'stripe_unavailable' });
    });

    it.each([1000, 1200, 1000000])('accepts custom whole-dollar amount %i', async customAmountCents => {
        const f = topupFixture();
        await f.caller.createTopupCheckout({ customAmountCents });
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ sku: 'ai_custom_v2', customAmountCents }));
    });

    it.each([0, -100, 900, 999, 1001, 1050, 1000.5, 1000001, 1000100])('refuses invalid custom amount %i', async customAmountCents => {
        const f = topupFixture();
        await expect(f.caller.createTopupCheckout({ customAmountCents })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it('requires exactly one of sku or custom amount', async () => {
        const f = topupFixture();
        await expect(f.caller.createTopupCheckout({ sku: 'ai_pack_fixture', customAmountCents: 1000 })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });

    it.each([{ sku: 'ai_pack_fixture' }, { customAmountCents: 2500 }])('fulfils the created checkout through Stripe events exactly once: %j', async input => {
        resetStripePackCachesForTests();
        const f = topupFixture();
        const pack = input.sku ? offeredPack : catalog.customTopupPack(input.customAmountCents!)!;
        let paidSession: Record<string, unknown> = {};
        let form = new URLSearchParams();
        const fetcher = vi.fn<typeof fetch>(async (url, init) => {
            if (String(url).endsWith('/customers')) return Response.json({ id: 'cus_fixture' });
            const path = new URL(String(url)).pathname;
            if (path === '/v1/products') return Response.json({ data: [productResponse], has_more: false });
            if (path === '/v1/prices/price_pack') return Response.json(priceResponse);
            if (path === '/v1/products/prod_fixture') return Response.json(productResponse);
            if (path === '/v1/coupons/coupon_pack') return Response.json(couponResponse);
            if (path.endsWith('/line_items')) return Response.json({ data: [{ id: 'li_pack', quantity: 1, price: priceResponse }], has_more: false });
            if (init?.method === 'POST') {
                form = new URLSearchParams(String(init.body));
                paidSession = { id: session.id, customer: form.get('customer'), client_reference_id: form.get('client_reference_id'),
                    mode: form.get('mode'), status: 'complete', payment_status: 'paid', payment_intent: 'pi_fixture',
                    amount_total: input.sku ? 8000 : Number(form.get('line_items[0][price_data][unit_amount]')), currency: 'usd',
                    metadata: { sku: form.get('metadata[sku]'), credits: form.get('metadata[credits]'), ezil_credits: form.get('metadata[ezil_credits]') } };
                return Response.json({ id: session.id, client_secret: 'cs_fixture_secret_fixture' });
            }
            return Response.json(paidSession);
        });
        const stripe = createStripeClient({ secretKey: 'sk_test_fixture', fetch: fetcher });
        f.deps.stripe = stripe;
        const receipts: Parameters<AiTopupReceiptStore['recordAiTopup']>[1][] = [];
        const grants: Parameters<AiTopupReceiptStore['recordAiTopup']>[0][] = [];
        const recordAiTopup = vi.fn<AiTopupReceiptStore['recordAiTopup']>(async (grant, receipt) => {
            grants.push(grant); receipts.push(receipt); return 'applied';
        });
        const store = Object.assign(f.store, {
            aiTopupReceipt: vi.fn<AiTopupReceiptStore['aiTopupReceipt']>(async () => receipts[0] ?? null), recordAiTopup,
        });
        await expect(f.caller.createTopupCheckout(input)).resolves.toEqual({
            sessionId: session.id, clientSecret: 'cs_fixture_secret_fixture', publishableKey: 'pk_test_fixture' });
        expect(form.get('mode')).toBe('payment');
        expect(form.get('ui_mode')).toBe('embedded_page');
        expect(form.get('return_url')).toBe('https://os.ezil.work/billing/return?session_id={CHECKOUT_SESSION_ID}');
        if (input.sku) expect(form.get('line_items[0][price]')).toBe('price_pack');
        else expect(form.get('line_items[0][price_data][unit_amount]')).toBe(String(pack.totalCents));
        expect(form.get('metadata[sku]')).toBe(pack.sku);
        expect(form.get('payment_intent_data[metadata][sku]')).toBe(pack.sku);
        const event = { id: 'evt_topup', type: 'checkout.session.completed', created: now.getTime() / 1000,
            livemode: false, data: { object: paidSession } };
        const deps = { store, stripe, now: () => now };
        expect(await processStripeEvent(event, deps)).toBe('applied');
        expect(await processStripeEvent({ ...event, id: 'evt_async', type: 'checkout.session.async_payment_succeeded' }, deps)).toBe('applied');
        expect(recordAiTopup).toHaveBeenCalledTimes(1);
        expect(grants).toEqual([expect.objectContaining({ userId, kind: 'topup', meter: 'ai_usd_micro',
            amount: BigInt(pack.creditCents) * BigInt(10000), sourceType: 'payment_intent', sourceId: 'pi_fixture' })]);
        expect(receipts).toEqual([expect.objectContaining({ kind: 'ai_grant',
            eventKey: `ezil-os:v1:topup:${pack.sku}:pi_fixture:grant`, payload: expect.objectContaining({ credits: pack.aiCredits }) })]);
        await expect(f.caller.checkoutStatus({ sessionId: session.id })).resolves.toEqual({ status: 'complete', paymentStatus: 'paid', sku: pack.sku });
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
        toSku: 'premium_monthly_v3', stripeInvoiceId: null, stripeScheduleId: null, hostedInvoiceUrl: null,
        state: 'pending', effectiveAt: null, expiresAt: null, createdAt: now, updatedAt: now, ...overrides };
}

const toCompute = { toSku: 'premium_monthly_v3' };
const toStandard = { toSku: 'standard_monthly_v3' };
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

describe('billing v3 mutations', () => {
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

    it.each(['standard_monthly_v3', 'premium_monthly_v3'] as const)('sells %s and strips smuggled checkout ownership', async sku => {
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
            grantStdSeconds: upgradeGrantSeconds({ periodStart, periodEnd, effectiveAt: isoSeconds(epochSeconds(now)) }) });
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
        const call = (f: Fixture, toSku = 'premium_monthly_v3') => operation === 'preview'
            ? f.caller.previewUpgrade({ toSku }) : f.caller.confirmUpgrade({ ...confirmInput, toSku });
        for (const wrong of ['standard_monthly_v3', 'pro_monthly_v1', 'invented']) {
            await domainFailure(() => call(fixture(), wrong), 'unknown_sku');
        }
        await domainFailure(() => call(fixture()), 'not_subscribed');
        for (const overrides of [{ sku: 'premium_monthly_v3' }, { sku: 'pro_monthly_v1' }, { cancelAtPeriodEnd: true }]) {
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
        const f = await paidFixture('premium_monthly_v3');
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
        for (const overrides of [{ sku }, { sku: 'pro_monthly_v1' }, { sku: 'premium_monthly_v3', cancelAtPeriodEnd: true }]) {
            const f = await paidFixture();
            f.store.subscriptionsFor.mockResolvedValue([subscription(overrides)]);
            await domainFailure(() => f.caller.scheduleDowngrade(toStandard), 'downgrade_not_allowed');
        }
    });

    it('releases the downgrade before canceling and checks tenancy before both writes', async () => {
        const f = await paidFixture('premium_monthly_v3');
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
        const legacy = await paidFixture('compute_monthly_v2');
        await domainFailure(() => legacy.caller.setOverage({ ...overageInput, termsVersion: 'old' }), 'terms_version_mismatch');
        await domainFailure(() => fixture().caller.setOverage(overageInput), 'upgrade_not_allowed');
        for (const overrides of [{ sku: 'standard_monthly_v2' }, { sku: 'pro_monthly_v1' }, { sku: 'compute_monthly_v2', cancelAtPeriodEnd: true },
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
        const f = await paidFixture('standard_monthly_v2');
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'standard_monthly_v2' }), subscription({ stripeSubscriptionId: 'sub_compute',
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
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { sku: 'legacy' } });
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

    it.each(['standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1'] as const)('selects only %s sizes', async planSku => {
        const f = await paidFixture(planSku);
        for (const size of ['free-cf', 'std-2', 'cmp-4', 'cmp-8', 'unknown']) {
            const allowed = CATALOG_V2[planSku].sizes.some(code => code === size);
            if (allowed) {
                const input = { size, userId: 'foreign', subscriptionId: 'sub_foreign' };
                await expect(f.caller.selectSize(input)).resolves.toEqual({ selectedSize: size });
                expect(f.store.setSizePreference).toHaveBeenLastCalledWith(userId, size);
            } else await domainFailure(() => f.caller.selectSize({ size }), 'size_not_allowed');
        }
    });

    it.each([
        ['preview', sku], ['confirm', sku], ['downgrade', 'premium_monthly_v3'],
        ['downgrade', sku], ['cancel', 'premium_monthly_v3'], ['portal', sku],
    ] as const)('%s from %s refuses foreign Stripe ownership before all writes', async (name, planSku) => {
        const f = await paidFixture(planSku);
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
            const f = await paidFixture(name === 'downgrade' ? 'premium_monthly_v3' : sku);
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
        await expect(f.caller.createCheckout({ sku: 'bad' as typeof sku })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
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

describe('v3-only sales and renewal', () => {
    it.each(['standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1'])('does not sell dormant %s', async oldSku => {
        const f = fixture();
        await expect(f.caller.createCheckout({ sku: oldSku as typeof sku })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });
    it.each(['free_v3', 'standard_monthly_v3', 'premium_monthly_v3'])('%s rejects legacy overage and selectSize', async planSku => {
        const f = planSku === 'free_v3' ? fixture() : await paidFixture(planSku);
        await domainFailure(() => f.caller.setOverage(overageInput), 'upgrade_not_allowed');
        await domainFailure(() => f.caller.selectSize({ size: 'cmp-8' }), 'upgrade_not_allowed');
        expect(f.store.recordConsent).not.toHaveBeenCalled();
        expect(f.store.setSizePreference).not.toHaveBeenCalled();
    });
    it('previews renewal only for the session-owned subscription and keeps provider failure readable', async () => {
        const f = await paidFixture();
        const preview = vi.fn<NonNullable<StripeApi['previewRenewal']>>().mockResolvedValue({ at: new Date('2026-10-20T00:00:00Z'), amountCents: 1734 });
        f.deps.stripe = { ...f.stripe, previewRenewal: preview };
        expect(await f.caller.summary()).toMatchObject({ plan: { sku, renewal: { at: '2026-10-20T00:00:00Z', amountCents: 1734 } } });
        expect(preview).toHaveBeenCalledExactlyOnceWith('sub_fixture');
        f.stripe.retrieveSubscription.mockResolvedValue({ ...(await f.stripe.retrieveSubscription('sub_fixture')), customer: 'cus_foreign' });
        preview.mockClear();
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(await f.caller.summary()).toMatchObject({ plan: { renewal: null } });
        expect(preview).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith('Billing renewal preview unavailable');
    });
});


describe('v3 Premium machine selection', () => {
    it.each(['std-2', 'cmp-4', 'cmp-8'] as const)('persists %s for the authenticated user and reports next_open', async size => {
        const f = await paidFixture('premium_monthly_v3');
        f.store.setSizePreference.mockImplementation(async (_userId, chosen) => { f.store.sizePreference.mockResolvedValue(chosen); });
        const untrusted = { size, userId: 'foreign', subscriptionId: 'foreign' };
        await expect(f.caller.selectMachine(untrusted)).resolves.toEqual({ size, effective: 'next_open' });
        expect(f.store.setSizePreference).toHaveBeenCalledExactlyOnceWith(userId, size);
        expect(await f.caller.summary()).toMatchObject({ computer: { size } });
        expect(f.store.openEpoch).not.toHaveBeenCalled();
        expect(f.store.closeEpoch).not.toHaveBeenCalled();
    });
    it.each(['free_v3', 'standard_monthly_v3', 'standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly_v1'])(
        'refuses %s even when std-2 would otherwise be allowed', async planSku => {
            const f = planSku === 'free_v3' ? fixture() : await paidFixture(planSku);
            await expect(f.caller.selectMachine({ size: 'std-2' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'size_not_allowed' });
            expect(f.store.setSizePreference).not.toHaveBeenCalled();
        });
    it.each(['past_due', 'incomplete', 'canceled', 'unpaid'])(
        'refuses Premium in %s', async status => {
            const f = fixture(); f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3', status })]);
            await expect(f.caller.selectMachine({ size: 'cmp-8' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'size_not_allowed' });
            expect(f.store.setSizePreference).not.toHaveBeenCalled();
        });
    it('refuses expired and canceling Premium subscriptions', async () => {
        for (const overrides of [{ currentPeriodEnd: new Date('2026-10-01T00:00:00Z') }, { cancelAtPeriodEnd: true }]) {
            const f = fixture(); f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3', ...overrides })]);
            await expect(f.caller.selectMachine({ size: 'cmp-8' })).rejects.toMatchObject({ code: 'BAD_REQUEST', message: 'size_not_allowed' });
            expect(f.store.setSizePreference).not.toHaveBeenCalled();
        }
    });
    it.each(['free-cf', 'unknown', '__proto__', 'toString', '', 4, null])('refuses invalid Premium size %s before writing', async size => {
        const f = await paidFixture('premium_monthly_v3');
        await expect(f.caller.selectMachine({ size: size as 'cmp-8' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        expect(f.store.setSizePreference).not.toHaveBeenCalled();
        if (size !== 'free-cf') expect(f.store.subscriptionsFor).not.toHaveBeenCalled();
    });
    it('requires authentication before reading or writing preferences', async () => {
        const f = fixture();
        await expect(f.router.createCaller({ ...f.ctx, user: null }).selectMachine({ size: 'cmp-8' })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
        for (const method of Object.values(f.store)) expect(method).not.toHaveBeenCalled();
    });
});

describe('billing.usage read-only boundary', () => {
    it('authenticates, scopes all reads and has no external or write effects', async () => {
        const f = fixture();
        const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No external calls allowed'));
        const result = await f.caller.usage();
        expect(result).toMatchObject({ enabled: true, version: 1, egress: { state: 'unavailable', usedBytes: null } });
        for (const name of ['subscriptionsFor', 'userCreatedAt', 'epochsFor', 'grantsForPeriod', 'latestStorageFor', 'overageInvoicesFor', 'sizePreference'] as const)
            expect(f.store[name].mock.calls[0][0]).toBe(userId);
        const reads = new Set(['subscriptionsFor', 'userCreatedAt', 'epochsFor', 'grantsForPeriod', 'latestStorageFor', 'overageInvoicesFor', 'sizePreference']);
        for (const [name, method] of Object.entries(f.store)) if (!reads.has(name)) expect(method).not.toHaveBeenCalled();
        for (const method of Object.values(f.stripe)) expect(method).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        await expect(f.router.createCaller({ ...f.ctx, user: null }).usage()).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
    it('does not reveal a foreign computer and makes no reads when disabled', async () => {
        const f = fixture(); f.store.computerOwner.mockResolvedValue('another-user');
        await expect(f.caller.usage({ computerId: '22222222-2222-4222-8222-222222222222' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(f.store.epochsFor).not.toHaveBeenCalled();
        f.deps.config.tabEnabled = false;
        await expect(f.caller.usage()).resolves.toEqual({ enabled: false });
        expect(f.store.subscriptionsFor).not.toHaveBeenCalled();
    });
});

describe('round 3 D5: operator-only AI requeue', () => {
    function requeueFixture(operator: boolean | 'throws') {
        const f = fixture();
        const isOperator = vi.fn(async (email: string | null | undefined) => {
            if (operator === 'throws') throw new Error('env unavailable');
            return operator && email === 'fixture@example.org';
        });
        const requeueFailed = vi.fn(async (input: { apply: boolean }) => ({ dryRun: !input.apply, selected: 1, eligible: 1,
            requeued: input.apply ? 1 : 0, decisions: [] }));
        f.deps.aiCredits = { claim: vi.fn(), accountFor: vi.fn(), pinAccount: vi.fn(), finish: vi.fn(), requeueFailed };
        const caller = createBillingRouter(() => f.deps, { isOperator }).createCaller(f.ctx);
        return { ...f, caller, isOperator, requeueFailed };
    }
    it.each([false, 'throws'] as const)('hides the procedure from a non-operator (%s) without reading or writing', async operator => {
        const f = requeueFixture(operator);
        await expect(f.caller.requeueAiCredits({ userId })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(f.requeueFailed).not.toHaveBeenCalled();
        await expect(f.router.createCaller({ ...f.ctx, user: null }).requeueAiCredits({ userId })).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    });
    it('is a dry run by default and applies only when asked', async () => {
        const f = requeueFixture(true);
        vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await f.caller.requeueAiCredits({ eventKeys: ['k'] })).toMatchObject({ dryRun: true, requeued: 0 });
        expect(f.requeueFailed).toHaveBeenLastCalledWith({ eventKeys: ['k'], userId: undefined, apply: false, now: now.getTime() });
        expect(await f.caller.requeueAiCredits({ userId, apply: true })).toMatchObject({ dryRun: false, requeued: 1 });
        expect(f.isOperator).toHaveBeenCalledWith('fixture@example.org');
    });
    it('refuses an empty or malformed selection', async () => {
        const f = requeueFixture(true);
        for (const input of [{}, { eventKeys: [] }, { userId: 'not-a-uuid' }, { userId, extra: true }]) {
            await expect(f.caller.requeueAiCredits(input as never)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
        }
        expect(f.requeueFailed).not.toHaveBeenCalled();
    });
});

describe('round 4: the computer standing in the summary', () => {
    afterEach(() => vi.unstubAllEnvs());
    const withPlacement = (provider: 'aws-ec2' | 'cloudflare' | null) => {
        const f = fixture();
        const placementProvider = vi.fn(async () => provider);
        return { ...f, placementProvider, caller: createBillingRouter(() => f.deps, { placementProvider }).createCaller(f.ctx) };
    };

    it('an immediate cancel with the computer still on AWS reads files_on_aws, with no move', async () => {
        const f = withPlacement('aws-ec2');
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3', status: 'canceled',
            currentPeriodEnd: new Date('2026-11-20T00:00:00Z') })]);
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { sku: 'free_v3', graceEndsAt: null, planEndsAt: null },
            computer: { standing: 'files_on_aws', filesOn: 'aws', heldSince: null, move: null } });
        expect(f.placementProvider).toHaveBeenCalledWith(f.ctx.db, userId);
    });

    it('a failed renewal reads grace with its end date; a cancel at period end reads plan_ending', async () => {
        const f = withPlacement('aws-ec2');
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'standard_monthly_v3', status: 'past_due',
            currentPeriodStart: new Date('2026-10-10T00:00:00Z'), currentPeriodEnd: new Date('2026-11-10T00:00:00Z') })]);
        f.store.openPaymentIssues.mockResolvedValue([{ stripeInvoiceId: 'in_f', userId, subscriptionId: 'sub_fixture', invoiceKind: 'subscription',
            issue: 'payment_failed', hostedInvoiceUrl: null, stripeEventCreated: new Date('2026-10-10T06:00:00Z'), resolvedAt: null, updatedAt: now }]);
        await expect(f.caller.summary()).resolves.toMatchObject({
            plan: { sku: 'standard_monthly_v3', status: 'past_due', paymentIssue: 'payment_failed', graceEndsAt: '2026-10-17T06:00:00Z' },
            // The unpaid renewal has no receipt yet: grace keeps the plan's fair use, never "paused".
            computer: { standing: 'grace', filesOn: 'aws' }, fairUse: { status: 'ok' } });
        f.store.openPaymentIssues.mockResolvedValue([]);
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3', cancelAtPeriodEnd: true })]);
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { planEndsAt: '2026-10-20T00:00:00Z' }, computer: { standing: 'plan_ending' } });
    });

    it('Free on Cloudflare (or an unreadable placement) reads free', async () => {
        for (const provider of ['cloudflare', null] as const) {
            await expect(withPlacement(provider).caller.summary()).resolves.toMatchObject({ computer: { standing: 'free', filesOn: 'cloudflare', move: null } });
        }
    });

    it('userPlacementProvider: off without placement reads, null without the table or on error, aws-ec2 wins across computers', async () => {
        const execute = vi.fn(async (): Promise<unknown> => [{ present: true }]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        expect(execute).not.toHaveBeenCalled();
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        execute.mockResolvedValueOnce([{ present: false }]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        execute.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([{ provider: 'cloudflare' }, { provider: 'aws-ec2' }]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBe('aws-ec2');
        execute.mockResolvedValueOnce({ rows: [{ present: true }] }).mockResolvedValueOnce({ rows: [{ provider: 'cloudflare' }] });
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBe('cloudflare');
        execute.mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        execute.mockRejectedValueOnce(new Error('relation missing'));
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        expect(warn).toHaveBeenCalledWith('[billing.summary] placement unavailable');
    });
});
