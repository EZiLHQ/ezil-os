import { afterEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '@/server/billing/config';
import type { SubscriptionRow } from '@/server/billing/meters';
import type { BillingDeps, BillingStore, StripeApi, StripeCheckoutSession, StripeInvoiceSummary } from '@/server/billing/ports';
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

function fixture() {
    let customer: string | null = null;
    const store = {
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
    it('does no billing reads with the tab off, and loads the same user when enabled', async () => {
        const f = fixture();
        f.deps.config.tabEnabled = false;
        await expect(f.caller.summary()).resolves.toEqual({ enabled: false });
        expect(f.store.subscriptionsFor).toHaveBeenCalledTimes(0);
        expect(f.store.intervalsFor).toHaveBeenCalledTimes(0);
        expect(f.store.latestStorageFor).toHaveBeenCalledTimes(0);
        f.deps.config.tabEnabled = true;
        await expect(f.caller.summary()).resolves.toMatchObject({ enabled: true, meters: { workspace: { usedSeconds: 60 }, storage: { usedBytes: '123' } } });
        expect(f.store.subscriptionsFor).toHaveBeenCalledWith(userId);
        expect(f.store.intervalsFor).toHaveBeenCalledWith(userId, new Date('2026-10-01T00:00:00Z'));
        expect(f.store.latestStorageFor).toHaveBeenCalledWith(userId);
    });

    it('loads intervals back to the earliest subscription period or Free window', async () => {
        const f = fixture();
        f.store.subscriptionsFor.mockResolvedValue([subscription(), subscription({ currentPeriodStart: null })]);
        await expect(f.caller.summary()).resolves.toMatchObject({ plan: { id: 'pro' } });
        expect(f.store.intervalsFor).toHaveBeenCalledWith(userId, new Date('2026-09-20T00:00:00Z'));
        f.store.subscriptionsFor.mockResolvedValue([subscription({ currentPeriodStart: new Date('2026-10-05T00:00:00Z') })]);
        await f.caller.summary();
        expect(f.store.intervalsFor).toHaveBeenLastCalledWith(userId, new Date('2026-10-01T00:00:00Z'));
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
