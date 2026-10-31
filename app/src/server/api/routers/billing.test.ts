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
const auth0 = vi.hoisted(() => ({ enabled: vi.fn(() => true) }));
vi.mock('@/server/auth/auth0', () => ({ auth0Enabled: auth0.enabled }));
vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ schedulePaidMigration: vi.fn() }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({
    getBillingDeps: () => { throw new Error('Tests must inject billing ports'); },
}));
// Round 5 D3: the router's DEFAULT volume reader goes through the app's EC2 collaborators. The describer is a
// fake; by default it knows no volume (null), which is the AWS-off answer, so every other case keeps the fallback.
const awsDescribeVolume = vi.hoisted(() => vi.fn<(region: string, volumeId: string) => Promise<{ sizeGiB?: number } | null>>(async () => null));
vi.mock('@/server/lib/compute/aws-clients', async importOriginal => ({
    ...await importOriginal<typeof import('@/server/lib/compute/aws-clients')>(),
    sharedAwsSdkCollaborators: () => ({ describer: { describeVolume: awsDescribeVolume } }),
}));

import { createBillingRouter, createVolumeSizeReader, userPlacement, userPlacementProvider, type UserPlacement } from './billing';
import { PgDialect } from 'drizzle-orm/pg-core';
import { placementRow } from '@/server/lib/compute/fake-placement-db.test-support';

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
        listCustomerSubscriptions: vi.fn<StripeApi['listCustomerSubscriptions']>().mockResolvedValue([]),
        listOpenCheckoutSessions: vi.fn<StripeApi['listOpenCheckoutSessions']>().mockResolvedValue([]),
        expireCheckoutSession: vi.fn<StripeApi['expireCheckoutSession']>().mockResolvedValue(undefined),
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
    // Round 5 D1: the fixture user is a Gateway member unless a test says otherwise.
    const router = createBillingRouter(() => deps, { aiMember: async () => 'works-member-fixture' });
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

    // Promotion review (double subscription): the local plan lags Stripe until the webhook lands.
    it.each(['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused', 'unrecognized'])(
        'refuses checkout when Stripe lists a %s subscription the local plan does not show yet', async status => {
            const f = fixture();
            await f.store.linkCustomer(userId, 'cus_fixture');
            const log = vi.spyOn(console, 'error').mockImplementation(() => {});
            f.stripe.listCustomerSubscriptions.mockResolvedValueOnce([{ id: 'sub_canceled', status: 'canceled' }, { id: 'sub_live', status }]);
            await expect(f.caller.createCheckout({ sku })).rejects.toMatchObject({ code: 'CONFLICT', message: 'already_subscribed' });
            expect(f.stripe.listCustomerSubscriptions).toHaveBeenCalledExactlyOnceWith('cus_fixture');
            expect(f.stripe.createCustomer).not.toHaveBeenCalled();
            expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
            expect(log).not.toHaveBeenCalled();
            // Positive control: only ended subscriptions → checkout proceeds for the same customer.
            f.stripe.listCustomerSubscriptions.mockResolvedValueOnce([{ id: 'sub_canceled', status: 'canceled' }, { id: 'sub_expired', status: 'incomplete_expired' }]);
            await checkoutControl(f);
            expect(f.stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cus_fixture' }));
        });

    it('expires the customer\'s other open subscription Checkout Sessions before the subscription check and the new session', async () => {
        const f = fixture();
        await f.store.linkCustomer(userId, 'cus_fixture');
        f.stripe.listOpenCheckoutSessions.mockResolvedValueOnce([
            { id: 'cs_old_window', mode: 'subscription' }, { id: 'cs_topup', mode: 'payment' }, { id: 'cs_older_window', mode: 'subscription' },
        ]);
        await checkoutControl(f);
        expect(f.stripe.listOpenCheckoutSessions).toHaveBeenCalledExactlyOnceWith('cus_fixture');
        // A top-up (payment mode) session is not a subscription and stays payable.
        expect(f.stripe.expireCheckoutSession.mock.calls).toEqual([['cs_old_window'], ['cs_older_window']]);
        const order = (mock: { mock: { invocationCallOrder: number[] } }) => mock.mock.invocationCallOrder;
        expect(Math.max(...order(f.stripe.expireCheckoutSession))).toBeLessThan(order(f.stripe.listCustomerSubscriptions)[0]!);
        expect(order(f.stripe.listCustomerSubscriptions)[0]).toBeLessThan(order(f.stripe.createCheckoutSession)[0]!);
        expect(f.stripe.createCustomer).not.toHaveBeenCalled();
    });

    it.each(['list sessions', 'expire', 'list subscriptions'] as const)('refuses checkout (stripe_unavailable) when the %s guard call fails', async step => {
        const f = fixture();
        await f.store.linkCustomer(userId, 'cus_fixture');
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const error = new StripeRequestError(step === 'expire' ? 400 : 503, null, 'invalid_request_error', null, 'private detail');
        if (step === 'list sessions') f.stripe.listOpenCheckoutSessions.mockRejectedValueOnce(error);
        else f.stripe.listOpenCheckoutSessions.mockResolvedValueOnce([{ id: 'cs_old_window', mode: 'subscription' }]);
        if (step === 'expire') f.stripe.expireCheckoutSession.mockRejectedValueOnce(error);
        if (step === 'list subscriptions') f.stripe.listCustomerSubscriptions.mockRejectedValueOnce(error);
        await domainFailure(() => f.caller.createCheckout({ sku }), 'stripe_unavailable');
        expect(log).toHaveBeenCalledExactlyOnceWith('Billing Stripe unavailable');
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
        if (step !== 'list subscriptions') expect(f.stripe.listCustomerSubscriptions).not.toHaveBeenCalled();
        // Positive control: the next attempt, with Stripe answering, proceeds.
        await checkoutControl(f);
    });

    it('creates a first customer\'s checkout without the Stripe subscription guard, then guards that customer', async () => {
        const f = await checkoutControl();
        expect(f.stripe.createCustomer).toHaveBeenCalledTimes(1);
        expect(f.stripe.listOpenCheckoutSessions).not.toHaveBeenCalled();
        expect(f.stripe.listCustomerSubscriptions).not.toHaveBeenCalled();
        expect(f.stripe.expireCheckoutSession).not.toHaveBeenCalled();
        await expect(f.caller.createCheckout({ sku })).resolves.toMatchObject({ mode: 'redirect', sessionId: session.id });
        expect(f.stripe.createCustomer).toHaveBeenCalledTimes(1);
        expect(f.stripe.listOpenCheckoutSessions).toHaveBeenCalledExactlyOnceWith('cus_fixture');
        expect(f.stripe.listCustomerSubscriptions).toHaveBeenCalledExactlyOnceWith('cus_fixture');
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledTimes(2);
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
        expect(f.stripe.createCheckoutSession).toHaveBeenCalledWith(expect.objectContaining({ cancelUrl: 'https://os.ezil.work/os' }));
        await f.caller.portal();
        expect(f.stripe.createPortalSession).toHaveBeenCalledWith({ customerId: 'cus_fixture', returnUrl: 'https://os.ezil.work/os' });
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

    // Promotion review: operator-granted rows (op_…, no Stripe subscription) are standard_monthly_v3, active, and
    // may cancel at period end. Each Stripe-backed handler used to read Stripe for 'op_…' and fail stripe_unavailable.
    const operatorId = 'op_canary_b91f424a_20261031';
    const operatorCalls = {
        preview: (f: Fixture) => f.caller.previewUpgrade(toCompute),
        confirm: (f: Fixture) => f.caller.confirmUpgrade(confirmInput),
        downgrade: (f: Fixture) => f.caller.scheduleDowngrade(toStandard),
        cancel: (f: Fixture) => f.caller.cancelAtPeriodEnd({ cancel: true }),
        resume: (f: Fixture) => f.caller.cancelAtPeriodEnd({ cancel: false }),
        portal: (f: Fixture) => f.caller.portal(),
    };
    it.each([
        ['preview', sku, false, 'upgrade_not_allowed'], ['confirm', sku, false, 'upgrade_not_allowed'],
        ['downgrade', 'premium_monthly_v3', false, 'downgrade_not_allowed'], ['cancel', sku, false, 'not_subscribed'],
        ['resume', sku, true, 'not_subscribed'], ['portal', sku, true, 'not_subscribed'],
    ] as const)('%s on an operator-granted %s row refuses before any Stripe call or store write (cancel at period end: %s)', async (name, planSku, cancelAtPeriodEnd, code) => {
        const f = await paidFixture(planSku);
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: planSku, stripeSubscriptionId: operatorId, cancelAtPeriodEnd })]);
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        await domainFailure(() => operatorCalls[name](f), code);
        for (const [method, mock] of Object.entries(f.stripe)) expect(mock, method).not.toHaveBeenCalled();
        expect(f.store.recordPlanChange).not.toHaveBeenCalled();
        expect(f.store.setPlanChangeState).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        // Positive control: the same row with a Stripe id reaches Stripe.
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: planSku, cancelAtPeriodEnd })]);
        await operatorCalls[name](f);
        expect(f.stripe.retrieveSubscription).toHaveBeenCalledWith('sub_fixture');
    });

    it('summarises an operator-granted row with every Stripe-backed action off and no Stripe read', async () => {
        const f = await paidFixture();
        const preview = vi.fn<NonNullable<StripeApi['previewRenewal']>>().mockResolvedValue({ at: new Date('2026-10-20T00:00:00Z'), amountCents: 1734 });
        f.deps.stripe = { ...f.stripe, previewRenewal: preview };
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        for (const cancelAtPeriodEnd of [false, true]) {
            f.store.subscriptionsFor.mockResolvedValue([subscription({ stripeSubscriptionId: operatorId, cancelAtPeriodEnd })]);
            expect(await f.caller.summary()).toMatchObject({ plan: { sku, status: cancelAtPeriodEnd ? 'cancels' : 'active', renewal: null },
                actions: { checkout: false, upgrade: false, downgrade: false, cancel: false, portal: false } });
        }
        expect(preview).not.toHaveBeenCalled();
        expect(f.stripe.retrieveSubscription).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
        // Positive control: a Stripe subscription row offers them and previews its renewal.
        f.store.subscriptionsFor.mockResolvedValue([subscription()]);
        expect(await f.caller.summary()).toMatchObject({ actions: { upgrade: true, cancel: true, portal: true } });
        expect(preview).toHaveBeenCalledExactlyOnceWith('sub_fixture');
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
        // Round 6: open payment issues too, so usage derives the same standing as the summary (the D16 hold).
        for (const name of ['subscriptionsFor', 'userCreatedAt', 'epochsFor', 'grantsForPeriod', 'latestStorageFor', 'overageInvoicesFor', 'sizePreference', 'openPaymentIssues'] as const)
            expect(f.store[name].mock.calls[0][0]).toBe(userId);
        const reads = new Set(['subscriptionsFor', 'userCreatedAt', 'epochsFor', 'grantsForPeriod', 'latestStorageFor', 'overageInvoicesFor', 'sizePreference', 'openPaymentIssues']);
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
        const [c1, c2] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
        const execute = vi.fn(async (): Promise<unknown> => []);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        expect(execute).not.toHaveBeenCalled();
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        // No live computers.
        execute.mockResolvedValueOnce([]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        // Live computers, no placement table.
        execute.mockResolvedValueOnce([{ id: c1 }]).mockResolvedValueOnce([{ present: false }]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        // Two computers: Cloudflare and aws-ec2 → aws-ec2 (rows or { rows } results).
        execute.mockResolvedValueOnce({ rows: [{ id: c1 }, { id: c2 }] })
            .mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([{ present: true }])
            .mockResolvedValueOnce([{ provider: 'cloudflare' }]).mockResolvedValueOnce([{ provider: 'aws-ec2' }]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBe('aws-ec2');
        execute.mockResolvedValueOnce([{ id: c1 }]).mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([{ provider: 'cloudflare' }]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBe('cloudflare');
        execute.mockResolvedValueOnce([{ id: c1 }]).mockResolvedValueOnce([{ present: true }]).mockResolvedValueOnce([]);
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        execute.mockRejectedValueOnce(new Error('relation missing'));
        await expect(userPlacementProvider({ execute }, userId)).resolves.toBeNull();
        expect(warn).toHaveBeenCalledWith('[billing.summary] placement unavailable');
    });
});

describe('round 5 D1: summary enrollment state and top-up gating', () => {
    const link = '/auth/auth0/login?returnUrl=/os';
    function enrolling(member: string | null | Error, sub?: unknown) {
        const f = fixture();
        f.deps.config.stripePublishableKey = 'pk_test_fixture';
        const aiMember = vi.fn(async () => { if (member instanceof Error) throw member; return member; });
        const ctx = { ...f.ctx, user: { ...f.ctx.user!, app_metadata: sub === undefined ? {} : { auth0_sub: sub } } };
        const caller = createBillingRouter(() => f.deps, { aiMember }).createCaller(ctx);
        return { ...f, ctx, aiMember, caller };
    }
    afterEach(() => { auth0.enabled.mockReset(); auth0.enabled.mockReturnValue(true); });

    it('needs_ezil_id: no Gateway member and no stored EZiL ID; CTA link, no top-up', async () => {
        const f = enrolling(null);
        const summary = await f.caller.summary();
        expect(f.aiMember).toHaveBeenCalledWith(f.ctx.db, userId);
        expect(summary).toMatchObject({ ai: { enrollment: 'needs_ezil_id' }, actions: { topup: false, ezilId: link } });
    });
    it('needs_ezil_id with EZiL ID sign-in off has no link', async () => {
        auth0.enabled.mockReturnValue(false);
        expect(await enrolling(null, '').caller.summary()).toMatchObject({ ai: { enrollment: 'needs_ezil_id' }, actions: { topup: false, ezilId: null } });
    });
    it('activating: a stored EZiL ID subject without a member yet', async () => {
        expect(await enrolling(null, 'auth0|stored').caller.summary()).toMatchObject({
            ai: { enrollment: 'activating' }, actions: { topup: false, ezilId: null } });
    });
    it('enrolled: a Works member (even without a stored subject, e.g. operator-seeded)', async () => {
        expect(await enrolling('works-member').caller.summary()).toMatchObject({
            ai: { enrollment: 'enrolled', waiting: null }, actions: { topup: true, ezilId: null } });
    });
    it('sums waiting credits from undelivered, unexpired stored receipts', async () => {
        const f = enrolling(null);
        const receiptsFor = vi.fn(async () => [
            { entitlementId: `ezil-os:v1:free-once:${userId}`, credits: 100, expiresAt: '2027-10-01T00:00:00.000Z', deliveredAt: null },
            { entitlementId: 'ezil-os:v1:standard_monthly_v3:sub:2026-10-01T00:00:00.000Z', credits: 200, expiresAt: '2027-10-01T00:00:00.000Z', deliveredAt: '2026-10-02T00:00:00.000Z' },
        ]);
        f.deps.aiCredits = { claim: vi.fn(), accountFor: vi.fn(), pinAccount: vi.fn(), finish: vi.fn(), receiptsFor };
        expect((await f.caller.summary() as { ai: { waiting: unknown } }).ai.waiting).toEqual({ credits: 100 });
    });
    it('a member lookup failure keeps the enrolled default with a fixed warning (no false CTA, top-up unchanged)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const f = enrolling(new Error('postgres://private:secret@host'));
        expect(await f.caller.summary()).toMatchObject({ ai: { enrollment: 'enrolled' }, actions: { topup: true, ezilId: null } });
        expect(warn).toHaveBeenCalledWith('[billing.ai] enrollment state unavailable');
        expect(JSON.stringify(warn.mock.calls)).not.toContain('secret');
        warn.mockRestore();
    });
    it('a database without the Works member view keeps the enrolled default silently (enrollment does not apply there)', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const f = enrolling(Object.assign(new Error('relation "ezil_works.ai_members" does not exist'), { code: '42P01' }));
        expect(await f.caller.summary()).toMatchObject({ ai: { enrollment: 'enrolled' }, actions: { topup: true, ezilId: null } });
        await expect(f.caller.createTopupCheckout({ customAmountCents: 1000 })).resolves.toMatchObject({ sessionId: session.id });
        expect(warn).not.toHaveBeenCalledWith('[billing.ai] enrollment state unavailable');
        warn.mockRestore();
    });
    it('the default member lookup is strict: a missing view is not read as "no member"', async () => {
        const f = fixture();
        const execute = vi.fn(async () => { throw Object.assign(new Error('missing'), { code: '42P01' }); });
        const caller = createBillingRouter(() => f.deps).createCaller({ ...f.ctx, db: { execute } as unknown as typeof f.ctx.db });
        expect(await caller.summary()).toMatchObject({ ai: { enrollment: 'enrolled' }, actions: { topup: true } });
        expect(execute).toHaveBeenCalled();
    });
    it.each([['needs_ezil_id', undefined], ['activating', 'auth0|stored']] as const)
    ('createTopupCheckout refuses %s before any Stripe call', async (_state, sub) => {
        const f = enrolling(null, sub);
        await expect(f.caller.createTopupCheckout({ customAmountCents: 1000 }))
            .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'ai_enrollment_required' });
        await expect(f.caller.createTopupCheckout({ sku: 'ai_pack_fixture' }))
            .rejects.toMatchObject({ code: 'PRECONDITION_FAILED', message: 'ai_enrollment_required' });
        expect(f.stripe.listProducts).not.toHaveBeenCalled();
        expect(f.stripe.createCustomer).not.toHaveBeenCalled();
        expect(f.stripe.createCheckoutSession).not.toHaveBeenCalled();
    });
    it('createTopupCheckout proceeds for an enrolled member', async () => {
        const f = enrolling('works-member');
        await expect(f.caller.createTopupCheckout({ customAmountCents: 1000 })).resolves.toMatchObject({ sessionId: session.id });
    });
});

/**
 * Phase B (docs/compute/REVERSE-MOVE-CONTRACT.md §6.1.1): the `summary` procedure wires the move computer's reads into the
 * builder. With 0012 the three keys come from the newest row; without it (production today) none of them appears.
 */
describe('Phase B: billing.summary carries the reverse move from the router\'s reads', () => {
    afterEach(() => vi.unstubAllEnvs());
    const C1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const view = { provider: 'aws-ec2' as const, state: 'STOPPED' as const, leaseEpoch: 12, lifecycleJobId: null, instanceType: 'm6i.large' };
    const row = { id: '33333333-3333-4333-8333-333333333333', user_id: userId, computer_id: C1, started_by: 'open', state: 'copying', generation: 'g',
        export_boot: { placementGeneration: 8, leaseEpoch: 12, region: 'ap-south-1', volumeId: 'vol-0aaaaaaaaaaaaaaaa', jobId: null, instanceId: null,
            fsUuid: null, claimedAt: '2026-10-11T11:00:00.000Z' },
        bytes_total: 2_000_000, attempts: 0, last_error: null, state_entered_at: '2026-10-11 11:00:00+00', commit_sent_at: null,
        created_at: '2026-10-11 10:59:00+00', updated_at: '2026-10-11 11:00:01+00', age_created: 120, age_state_entered: 60 };
    const held = (present: boolean) => {
        for (const [k, v] of Object.entries({ EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_AWS_KILL_SWITCH: '0', AWS_REGIONS: 'ap-south-1', AWS_MAX_RUNNING: '10',
            EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
            EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200' })) vi.stubEnv(k, v);
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3', status: 'canceled' })]);
        const placement = vi.fn(async (): Promise<UserPlacement> => ({ provider: 'aws-ec2', awsVolumes: [],
            computers: [{ computerId: C1, provider: 'aws-ec2', placement: view }] }));
        const dialect = new PgDialect();
        const execute = vi.fn(async (q: Parameters<typeof dialect.sqlToQuery>[0]) => {
            const text = dialect.sqlToQuery(q).sql;
            if (text.includes("to_regclass('public.ezil_compute_reverse_moves')")) return [{ present }];
            if (text.includes('FROM public.ezil_compute_reverse_moves')) return [row];
            throw new Error(`unexpected query ${text}`);
        });
        const caller = createBillingRouter(() => f.deps, { placement, isOperator: () => false })
            .createCaller({ ...f.ctx, db: { execute } as unknown as typeof f.ctx.db });
        return { caller, execute };
    };
    it('with 0012: reverseMove from the newest row, moveOnOpen false while it holds, moveAvailable true; computer.move stays null', async () => {
        const summary = await held(true).caller.summary();
        expect(summary).toMatchObject({ computer: { standing: 'files_on_aws', move: null, moveOnOpen: false, moveAvailable: true,
            reverseMove: { direction: 'to_cloudflare', stage: 'copying', bytesDone: '0', bytesTotal: '2000000', reason: null, retry: null,
                openBlocked: false, holdOpenable: true } } });
    });
    it('without 0012 (production today): none of the three keys, and no reverse read', async () => {
        const { caller, execute } = held(false);
        const summary = await caller.summary();
        if (!summary.enabled) throw new Error('summary disabled');
        for (const key of ['reverseMove', 'moveOnOpen', 'moveAvailable']) expect(summary.computer).not.toHaveProperty(key);
        expect(summary.computer.move).toBeNull();
        // Only the probe touched the reverse table (the AI member lookup shares this executor).
        const reverse = execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q).sql).filter(text => text.includes('ezil_compute_reverse_moves'));
        expect(reverse).toEqual([expect.stringContaining('to_regclass')]);
    });
});

describe('round 5 D3: the summary and usage show the computer\'s REAL volume', () => {
    afterEach(() => vi.unstubAllEnvs());
    const [C1, C2] = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
    const VOL_TODAY = 'vol-0aaaaaaaaaaaaaaaa', VOL_OLD = 'vol-0bbbbbbbbbbbbbbbb';
    const GiB = 1024 ** 3;
    const withVolumes = (awsVolumes: UserPlacement['awsVolumes'], sizes: Record<string, number | null | Error>) => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3' })]);
        const placement = vi.fn(async (): Promise<UserPlacement> => ({ provider: awsVolumes.length ? 'aws-ec2' : null, awsVolumes }));
        const volumeGiB = vi.fn(async ({ volumeId }: { region: string; volumeId: string }) => {
            const size = sizes[volumeId];
            if (size instanceof Error) throw size;
            return size ?? null;
        });
        return { ...f, placement, volumeGiB, caller: createBillingRouter(() => f.deps, { placement, volumeGiB }).createCaller(f.ctx) };
    };

    it('a Premium computer created today (100 GiB volume) shows 100; an older one (50 GiB) shows 50; summary and usage agree', async () => {
        for (const [volumeId, gib] of [[VOL_TODAY, 100], [VOL_OLD, 50]] as const) {
            const f = withVolumes([{ computerId: C1, region: 'ap-south-1', volumeId }], { [VOL_TODAY]: 100, [VOL_OLD]: 50 });
            const summary = await f.caller.summary();
            expect(summary).toMatchObject({ computer: { disk: { provisionedGiB: gib, growsOnSwitch: false }, standing: 'paid', filesOn: 'aws' },
                storage: { capBytes: String(gib * GiB) } });
            if (!summary.enabled) throw new Error('summary disabled');
            // D3 + W0 pin: the tiles carry no disk figure; the real volume is the computer's disk.
            expect(summary.computer.machineChoice.map(option => option.diskGiB)).toEqual([null, null, null]);
            await expect(f.caller.usage()).resolves.toMatchObject({ storage: { capBytes: String(gib * GiB), disk: { provisionedGiB: gib } } });
            expect(f.volumeGiB).toHaveBeenCalledWith({ computerId: C1, region: 'ap-south-1', volumeId });
            expect(f.placement).toHaveBeenCalledWith(f.ctx.db, userId);
        }
    });

    it('round 6: Free held on AWS (D16): usage shows the held 2 vCPU computer and its real disk, as the summary does', async () => {
        const f = withVolumes([{ computerId: C1, region: 'ap-south-1', volumeId: VOL_OLD }], { [VOL_OLD]: 50 });
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3', status: 'canceled' })]);
        f.store.epochsFor.mockResolvedValue([{ id: 'hold', userId, computerId: C1, size: 'std-2', weight: 1, readyAt: '2026-10-11T11:30:00Z',
            endedAt: null, endReason: null, overheadSeconds: 0, deadlineAt: '2026-10-11T12:29:59Z', lastHeartbeatAt: null }]);
        await expect(f.caller.summary()).resolves.toMatchObject({ computer: { standing: 'files_on_aws', size: 'std-2', disk: { provisionedGiB: 50 } } });
        const usage = await f.caller.usage({ computerId: C1 });
        expect(usage).toMatchObject({ period: { currentSize: 'std-2', allowanceStandardSeconds: 8 * 3600, equivalents: [{ size: 'std-2', weight: 1 }] },
            storage: { disk: { provisionedGiB: 50 } } });
        if (!usage.enabled) throw new Error('usage disabled');
        expect(usage.period.equivalents).toHaveLength(1);
        // The same standing as the summary: the open payment issues are read for usage too.
        expect(f.store.openPaymentIssues).toHaveBeenLastCalledWith(userId);
    });

    it('round 6 review (R4-02): the summary carries the PLACED AWS size from the placement read (a held 8 vCPU stays 8)', async () => {
        const f = withVolumes([{ computerId: C1, region: 'ap-south-1', volumeId: VOL_OLD }], { [VOL_OLD]: 50 });
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3', status: 'canceled' })]);
        f.placement.mockResolvedValue({ provider: 'aws-ec2', awsVolumes: [{ computerId: C1, region: 'ap-south-1', volumeId: VOL_OLD }], awsSize: 'cmp-8' });
        await expect(f.caller.summary()).resolves.toMatchObject({ computer: { standing: 'files_on_aws', size: 'std-2',
            awsSize: { size: 'cmp-8', vcpu: 8, memoryGiB: 32 } } });
        // No size from the placement read (unknown or mixed): null.
        f.placement.mockResolvedValue({ provider: 'aws-ec2', awsVolumes: [] });
        await expect(f.caller.summary()).resolves.toMatchObject({ computer: { standing: 'files_on_aws', awsSize: null } });
    });

    it('round 6 review (dunning into the hold): after grace both read epochs from Free\'s month and rate the computer as Free', async () => {
        // A Premium renewal on 10-03 failed at once; grace ended 10-10; on 10-11 the computer runs as Free (Oct 1 - Nov 1).
        const f = withVolumes([{ computerId: C1, region: 'ap-south-1', volumeId: VOL_OLD }], { [VOL_OLD]: 50 });
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3', status: 'past_due',
            currentPeriodStart: new Date('2026-10-03T00:00:00Z'), currentPeriodEnd: new Date('2026-11-03T00:00:00Z') })]);
        f.store.openPaymentIssues.mockResolvedValue([{ stripeInvoiceId: 'in_fail', userId, subscriptionId: 'sub_fixture', invoiceKind: 'subscription',
            issue: 'payment_failed', hostedInvoiceUrl: null, stripeEventCreated: new Date('2026-10-03T00:00:00Z'), resolvedAt: null, updatedAt: now }]);
        f.store.grantsForPeriod.mockResolvedValue([]);
        f.store.epochsFor.mockResolvedValue([{ id: 'hold', userId, computerId: C1, size: 'std-2', weight: 1, readyAt: '2026-10-11T11:30:00Z',
            endedAt: null, endReason: null, overheadSeconds: 0, deadlineAt: '2026-10-11T12:29:59Z', lastHeartbeatAt: null }]);
        const free = { start: new Date('2026-10-01T00:00:00Z'), periodStart: new Date('2026-10-03T00:00:00Z') };
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { sku: 'premium_monthly_v3', status: 'past_due' },
            computer: { standing: 'files_on_aws', sessionMaxSeconds: 3600, activeDeadline: '2026-10-11T12:29:59Z' }, fairUse: { status: 'ok' } });
        expect(f.store.epochsFor.mock.calls.map(([, since]) => since.toISOString())).toEqual([free.periodStart.toISOString(), free.start.toISOString()]);
        f.store.epochsFor.mockClear();
        await expect(f.caller.usage({ computerId: C1 })).resolves.toMatchObject({ period: { startsAt: '2026-10-01T00:00:00Z',
            allowanceStandardSeconds: 8 * 3600, usedStandardSeconds: 1800, currentSize: 'std-2' } });
        expect(f.store.epochsFor.mock.calls.map(([, since]) => since.toISOString())).toEqual([free.periodStart.toISOString(), free.start.toISOString()]);
        // Paid access (no issue): one read from the paid period's start, as before.
        f.store.openPaymentIssues.mockResolvedValue([]);
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3',
            currentPeriodStart: new Date('2026-10-03T00:00:00Z'), currentPeriodEnd: new Date('2026-11-03T00:00:00Z') })]);
        f.store.epochsFor.mockClear();
        await f.caller.summary();
        expect(f.store.epochsFor.mock.calls.map(([, since]) => since.toISOString())).toEqual([free.periodStart.toISOString()]);
    });

    it('an unreadable volume (error, missing, no AWS placement) shows 50 and never fails the summary or usage', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const f of [withVolumes([{ computerId: C1, region: 'ap-south-1', volumeId: VOL_TODAY }], { [VOL_TODAY]: new Error('AccessDenied') }),
            withVolumes([{ computerId: C1, region: 'ap-south-1', volumeId: VOL_TODAY }], { [VOL_TODAY]: null }),
            withVolumes([], {})]) {
            await expect(f.caller.summary()).resolves.toMatchObject({ computer: { disk: { provisionedGiB: 50 } }, storage: { capBytes: String(50 * GiB) } });
            await expect(f.caller.usage()).resolves.toMatchObject({ storage: { disk: { provisionedGiB: 50 } } });
        }
        const failing = withVolumes([], {});
        failing.placement.mockRejectedValue(new Error('db down'));
        await expect(failing.caller.summary()).resolves.toMatchObject({ computer: { disk: { provisionedGiB: 50 }, filesOn: 'cloudflare' } });
        expect(warn).toHaveBeenCalled();
    });

    it('two AWS volumes: the smallest readable size (never overclaim); usage for one computer reads that computer\'s volume', async () => {
        const volumes = [{ computerId: C1, region: 'ap-south-1', volumeId: VOL_TODAY }, { computerId: C2, region: 'ap-south-1', volumeId: VOL_OLD }];
        const f = withVolumes(volumes, { [VOL_TODAY]: 100, [VOL_OLD]: 50 });
        await expect(f.caller.summary()).resolves.toMatchObject({ computer: { disk: { provisionedGiB: 50 } } });
        f.store.computerOwner = vi.fn(async () => userId) as never;
        await expect(f.caller.usage({ computerId: C1 })).resolves.toMatchObject({ storage: { disk: { provisionedGiB: 100 } } });
        await expect(f.caller.usage({ computerId: C2 })).resolves.toMatchObject({ storage: { disk: { provisionedGiB: 50 } } });
        // One volume unreadable (error/timeout) beside a readable 100: that computer may be 50, so the summary shows 50.
        const partly = withVolumes([{ computerId: C1, region: 'ap-south-1', volumeId: VOL_TODAY }, { computerId: C2, region: 'ap-south-1', volumeId: VOL_OLD }],
            { [VOL_TODAY]: 100, [VOL_OLD]: new Error('Throttling') });
        await expect(partly.caller.summary()).resolves.toMatchObject({ computer: { disk: { provisionedGiB: 50 } } });
        // z.string().uuid() accepts upper case; the placement ids are lower case.
        await expect(f.caller.usage({ computerId: C1.toUpperCase() })).resolves.toMatchObject({ storage: { disk: { provisionedGiB: 100 } } });
    });

    it('without an injected reader, the router reads the volume through the app\'s EC2 describer (region, volumeId)', async () => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'premium_monthly_v3' })]);
        // Unique ids: the default reader's cache is module-wide.
        const VOL_DEFAULT = 'vol-0dddddddddddddddd', VOL_DEFAULT_OLD = 'vol-0eeeeeeeeeeeeeeee';
        const sizes: Record<string, number> = { [VOL_DEFAULT]: 100, [VOL_DEFAULT_OLD]: 50 };
        awsDescribeVolume.mockImplementation(async (region, volumeId) => region === 'ap-south-1' && sizes[volumeId] ? { sizeGiB: sizes[volumeId] } : null);
        try {
            for (const [volumeId, gib] of [[VOL_DEFAULT, 100], [VOL_DEFAULT_OLD, 50]] as const) {
                const placement = vi.fn(async (): Promise<UserPlacement> => ({ provider: 'aws-ec2',
                    awsVolumes: [{ computerId: C1, region: 'ap-south-1', volumeId }] }));
                const caller = createBillingRouter(() => f.deps, { placement }).createCaller(f.ctx);
                await expect(caller.summary()).resolves.toMatchObject({ computer: { disk: { provisionedGiB: gib } }, storage: { capBytes: String(gib * GiB) } });
                await expect(caller.usage()).resolves.toMatchObject({ storage: { disk: { provisionedGiB: gib } } });
                expect(awsDescribeVolume).toHaveBeenCalledWith('ap-south-1', volumeId);
            }
        } finally {
            awsDescribeVolume.mockReset();
            awsDescribeVolume.mockResolvedValue(null);
        }
    });

    it('the legacy placementProvider option still works (provider only, fallback disk)', async () => {
        const f = fixture();
        const placementProvider = vi.fn(async () => 'aws-ec2' as const);
        const caller = createBillingRouter(() => f.deps, { placementProvider }).createCaller(f.ctx);
        f.store.subscriptionsFor.mockResolvedValue([subscription({ sku: 'standard_monthly_v3' })]);
        await expect(caller.summary()).resolves.toMatchObject({ computer: { filesOn: 'aws', disk: { provisionedGiB: 50 } } });
    });

    it('userPlacement: aws-ec2 placements expose {computerId, region, volumeId}; a failed rich read keeps the provider', async () => {
        vi.stubEnv('EZIL_COMPUTE_PLACEMENT_READS', '1');
        const dialect = new PgDialect();
        const rows: Record<string, Record<string, unknown>> = {
            [C1]: placementRow({ computer_id: C1, owner_user_id: userId, provider: 'aws-ec2', region: 'ap-south-1', volume_id: VOL_TODAY }),
            [C2]: placementRow({ computer_id: C2, owner_user_id: userId, provider: 'cloudflare', workspace_store: 'r2' }),
        };
        let richFails = false;
        const execute = vi.fn(async (query: Parameters<typeof dialect.sqlToQuery>[0]) => {
            const { sql: text, params } = dialect.sqlToQuery(query);
            if (text.includes('billing:live-computers')) return [{ id: C1 }, { id: C2 }];
            if (text.includes('placement:provider-table')) return [{ present: true }];
            if (text.includes('placement:provider */')) return [{ provider: rows[String(params[0])]!.provider }];
            if (text.includes('placement:read')) { if (richFails) throw new Error('column missing'); return [rows[String(params[0])]!]; }
            if (text.includes('placement:image-reservation')) return [];
            throw new Error(`unexpected query ${text}`);
        });
        const cloudflareView = { provider: 'cloudflare', state: null, leaseEpoch: null, lifecycleJobId: null, instanceType: null };
        const first = await userPlacement({ execute: execute as never }, userId);
        expect(first).toEqual({ provider: 'aws-ec2', awsVolumes: [{ computerId: C1, region: 'ap-south-1', volumeId: VOL_TODAY }],
            ...(first.awsSize ? { awsSize: first.awsSize } : {}),
            // Phase B (REVERSE-MOVE-CONTRACT §6.1.1): the live computers and the records already read, for the move computer.
            computers: [
                { computerId: C1.toLowerCase(), provider: 'aws-ec2', placement: expect.objectContaining({ provider: 'aws-ec2', state: rows[C1]!.state }) },
                { computerId: C2.toLowerCase(), provider: 'cloudflare', placement: cloudflareView },
            ] });
        await expect(userPlacementProvider({ execute: execute as never }, userId)).resolves.toBe('aws-ec2');
        // Only the aws-ec2 computer gets the rich read.
        expect(execute.mock.calls.filter(([q]) => dialect.sqlToQuery(q).sql.includes('placement:read')).map(([q]) => dialect.sqlToQuery(q).params[0])).toEqual([C1, C1]);
        // Round 6 (R4-02): the instance type, metered as the start gate meters it; an unlisted type is no size.
        for (const [type, size] of [['m6i.2xlarge', 'cmp-8'], ['m6i.xlarge', 'cmp-4'], ['m6i.large', 'std-2']] as const) {
            rows[C1] = { ...rows[C1], instance_type: type };
            await expect(userPlacement({ execute: execute as never }, userId)).resolves.toMatchObject({ provider: 'aws-ec2', awsSize: size });
        }
        rows[C1] = { ...rows[C1], instance_type: 'p5.48xlarge' };
        expect(await userPlacement({ execute: execute as never }, userId)).not.toHaveProperty('awsSize');
        // Two aws-ec2 computers on different sizes: no single placed size.
        rows[C1] = { ...rows[C1], instance_type: 'm6i.2xlarge' };
        rows[C2] = placementRow({ computer_id: C2, owner_user_id: userId, provider: 'aws-ec2', region: 'ap-south-1', instance_type: 'm6i.large' });
        expect(await userPlacement({ execute: execute as never }, userId)).not.toHaveProperty('awsSize');
        rows[C2] = { ...rows[C2], instance_type: 'm6i.2xlarge' };
        await expect(userPlacement({ execute: execute as never }, userId)).resolves.toMatchObject({ awsSize: 'cmp-8' });
        rows[C1] = { ...rows[C1], instance_type: null };
        rows[C2] = placementRow({ computer_id: C2, owner_user_id: userId, provider: 'cloudflare', workspace_store: 'r2' });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        richFails = true;
        // A failed rich read is no record: no volume, and no placement for the move computer (its fields fail closed).
        await expect(userPlacement({ execute: execute as never }, userId)).resolves.toEqual({ provider: 'aws-ec2', awsVolumes: [],
            computers: [{ computerId: C1.toLowerCase(), provider: 'aws-ec2', placement: null },
                { computerId: C2.toLowerCase(), provider: 'cloudflare', placement: cloudflareView }] });
        expect(warn).toHaveBeenCalledWith('[billing.summary] volume placement unavailable');
        // A placement without a volume yet (provisioning) has nothing to read.
        richFails = false; rows[C1] = { ...rows[C1], volume_id: null };
        await expect(userPlacement({ execute: execute as never }, userId)).resolves.toMatchObject({ provider: 'aws-ec2', awsVolumes: [] });
        // Placement reads off: nothing is read at all, and there is no computer (Phase B §6.1.1 rule 4: no move computer).
        vi.unstubAllEnvs(); execute.mockClear();
        await expect(userPlacement({ execute: execute as never }, userId)).resolves.toEqual({ provider: null, awsVolumes: [], computers: [] });
        expect(execute).not.toHaveBeenCalled();
    });
});

describe('round 5 D3: the volume size reader (describeVolume, cached)', () => {
    const volume = { computerId: 'c', region: 'ap-south-1', volumeId: 'vol-0aaaaaaaaaaaaaaaa' };
    const setup = (sizeGiB: number | 'missing' | Error | 'hang' = 100) => {
        let clock = 0;
        const describe = vi.fn(async () => {
            if (sizeGiB === 'hang') return new Promise<never>(() => {});
            if (sizeGiB instanceof Error) throw sizeGiB;
            return sizeGiB === 'missing' ? {} : { sizeGiB };
        });
        const read = createVolumeSizeReader(describe, { now: () => clock, timeoutMs: 20, maxEntries: 3 });
        return { describe, read, at: (ms: number) => { clock = ms; } };
    };
    it('reads sizeGiB once per volume within 5 minutes, then again after', async () => {
        const r = setup();
        await expect(r.read(volume)).resolves.toBe(100);
        r.at(299_000);
        await expect(r.read(volume)).resolves.toBe(100);
        expect(r.describe).toHaveBeenCalledTimes(1);
        expect(r.describe).toHaveBeenCalledWith('ap-south-1', volume.volumeId);
        r.at(300_001);
        await expect(r.read(volume)).resolves.toBe(100);
        expect(r.describe).toHaveBeenCalledTimes(2);
    });
    it('is bounded: the oldest entry is evicted past maxEntries', async () => {
        const r = setup();
        for (const id of ['1', '2', '3', '4']) await r.read({ ...volume, volumeId: `vol-0${id.repeat(16)}` });
        expect(r.describe).toHaveBeenCalledTimes(4);
        await r.read({ ...volume, volumeId: `vol-0${'4'.repeat(16)}` });
        expect(r.describe).toHaveBeenCalledTimes(4);
        await r.read({ ...volume, volumeId: `vol-0${'1'.repeat(16)}` });
        expect(r.describe).toHaveBeenCalledTimes(5);
    });
    it('a caller ttlMs above 5 minutes is clamped to 5 minutes', async () => {
        let clock = 0;
        const describe = vi.fn(async () => ({ sizeGiB: 100 }));
        const read = createVolumeSizeReader(describe, { now: () => clock, ttlMs: 60 * 60_000 });
        await read(volume);
        clock = 300_001;
        await read(volume);
        expect(describe).toHaveBeenCalledTimes(2);
    });
    it.each([['an AWS error', new Error('Throttling')], ['a missing size', 'missing' as const], ['a hung call (timeout)', 'hang' as const]])(
        '%s is null, held for 30 s (a throttled EC2 is not re-hit on every call), then read again', async (_name, size) => {
            const r = setup(size);
            await expect(r.read(volume)).resolves.toBeNull();
            r.at(30_000);
            await expect(r.read(volume)).resolves.toBeNull();
            expect(r.describe).toHaveBeenCalledTimes(1);
            r.at(30_001);
            await expect(r.read(volume)).resolves.toBeNull();
            expect(r.describe).toHaveBeenCalledTimes(2);
        });
    it('a caller negativeTtlMs is clamped to the positive TTL', async () => {
        let clock = 0;
        const describe = vi.fn(async () => { throw new Error('Throttling'); });
        const read = createVolumeSizeReader(describe, { now: () => clock, ttlMs: 1_000, negativeTtlMs: 60_000 });
        await read(volume);
        clock = 1_001;
        await read(volume);
        expect(describe).toHaveBeenCalledTimes(2);
    });
    it('concurrent reads of one volume share one DescribeVolumes call', async () => {
        let release!: (view: { sizeGiB: number }) => void;
        const describe = vi.fn(() => new Promise<{ sizeGiB: number }>(resolve => { release = resolve; }));
        const read = createVolumeSizeReader(describe, { timeoutMs: 1_000 });
        const reads = Array.from({ length: 5 }, () => read(volume));
        release({ sizeGiB: 100 });
        await expect(Promise.all(reads)).resolves.toEqual([100, 100, 100, 100, 100]);
        expect(describe).toHaveBeenCalledTimes(1);
    });
    it('a read that finishes after the timeout still fills the cache (the next summary shows the real size)', async () => {
        let release!: (view: { sizeGiB: number }) => void;
        const describe = vi.fn(() => new Promise<{ sizeGiB: number }>(resolve => { release = resolve; }));
        const read = createVolumeSizeReader(describe, { timeoutMs: 10 });
        await expect(read(volume)).resolves.toBeNull();
        release({ sizeGiB: 100 });
        await new Promise(resolve => setTimeout(resolve, 0));
        await expect(read(volume)).resolves.toBe(100);
        expect(describe).toHaveBeenCalledTimes(1);
    });
    it('a volume EC2 does not know (null) or AWS off is null', async () => {
        const read = createVolumeSizeReader(async () => null, { timeoutMs: 20 });
        await expect(read(volume)).resolves.toBeNull();
    });
});
