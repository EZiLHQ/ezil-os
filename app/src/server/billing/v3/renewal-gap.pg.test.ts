import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import { readBillingConfig } from '../config';
import type { BillingDeps, BillingStore, StripeApi, StripeInvoice, StripeInvoicePaymentState, StripeSubscription } from '../ports';
import { processStripeEvent } from '../processor';
import { createBillingStore } from '../store';
import type { StripeEventLike } from '../stripe/events';
import { billingV2EntitlementReader, loadComputeBillingState } from '../v2/compute-access';
import { epochSeconds } from '../v2/time';
import { CATALOG_V3, type BillingSummaryV3 } from './contract';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));
vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ schedulePaidMigration: vi.fn() }));

type Database = typeof import('@/server/db').db;
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const T = new Date('2026-11-30T09:00:00Z');
const P1 = { start: new Date(T.getTime() - 30 * DAY), end: T };
const P2 = { start: T, end: new Date(T.getTime() + 30 * DAY) };
const at = (ms: number) => new Date(T.getTime() + ms);
const STANDARD = CATALOG_V3.standard_monthly_v3;

/**
 * The renewal gap (renewal-gap.test.ts) against the real store and schema: Stripe's event order at renewal, the stored
 * period and receipt rows, and the summary and compute state read back from Postgres.
 */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('renewal gap with Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let store: BillingStore;
    let userId: string, customerId: string, subscriptionId: string;
    let subscription: StripeSubscription;
    let invoices: Map<string, StripeInvoice>;
    let paymentStates: Map<string, StripeInvoicePaymentState>;
    let stripe: StripeApi;
    const config = readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' });
    const deps = (now: Date): BillingDeps => ({ config, store, stripe: null, usage: null, now: () => now });

    function invoice(id: string, period: typeof P1, billingReason: string, status = 'paid'): StripeInvoice {
        return { id, customer: customerId, status, subscriptionId, billingReason, metadataKind: null, hostedInvoiceUrl: null,
            periodStart: period.start, periodEnd: period.end,
            lines: [{ id: `il_${id}`, lookupKey: STANDARD.stripeLookupKey, subscriptionId, proration: false,
                amount: STANDARD.priceCents, periodStart: period.start, periodEnd: period.end }] };
    }
    const deliver = (type: string, object: Record<string, unknown>, created: Date) => processStripeEvent(
        { id: `evt_${randomUUID()}`, type, created: epochSeconds(created), livemode: false, data: { object } } satisfies StripeEventLike,
        { store, stripe, now: () => created });
    const invoiceEvent = (type: string, id: string, created: Date) => deliver(type,
        { id, customer: customerId, parent: { subscription_details: { subscription: subscriptionId } }, lines: { data: [] } }, created);
    async function read(now: Date) {
        const state = await loadComputeBillingState(deps(now), userId, now);
        return { state, summary: state.summary as BillingSummaryV3, entitlement: await billingV2EntitlementReader(() => deps(now)).read(userId) };
    }
    async function expectPending(now: Date) {
        const { state, summary, entitlement } = await read(now);
        expect(summary).toMatchObject({ fairUse: { status: 'renewing' }, computer: { standing: 'paid' }, actions: { upgrade: false } });
        expect(state.allowanceStdSeconds).toBe(0);
        expect(entitlement).toMatchObject({ status: 'expired' });
    }
    async function expectSettled(now: Date) {
        const { state, summary, entitlement } = await read(now);
        expect(summary).toMatchObject({ fairUse: { status: 'ok' }, actions: { upgrade: true } });
        expect(state.allowanceStdSeconds).toBe(STANDARD.fairUseSeconds);
        expect(entitlement).toMatchObject({ status: 'active', provider: 'aws' });
    }

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        db = drizzle(client, { schema });
        store = createBillingStore(db);
    });
    beforeEach(async () => {
        await client`begin`;
        vi.spyOn(console, 'info').mockImplementation(() => {});
        userId = randomUUID();
        customerId = `cus_${randomUUID()}`;
        subscriptionId = `sub_${randomUUID()}`;
        await client`insert into auth.users (id, created_at) values (${userId}::uuid, ${new Date(T.getTime() - 90 * DAY).toISOString()}::timestamptz)`;
        expect(await store.linkCustomer(userId, customerId)).toBe('linked');
        subscription = { id: subscriptionId, customer: customerId, status: 'active', sku: 'standard_monthly_v3', cancelAtPeriodEnd: false,
            currentPeriodStart: P1.start, currentPeriodEnd: P1.end, pendingUpdateExpiresAt: null, defaultPaymentMethod: null, scheduleId: null,
            latestInvoiceId: null, items: [{ id: 'si_renewal', priceId: 'price_standard', lookupKey: STANDARD.stripeLookupKey }] };
        invoices = new Map();
        paymentStates = new Map();
        const methods: Partial<StripeApi> = {
            retrieveSubscription: async () => structuredClone(subscription),
            retrieveInvoice: async id => structuredClone(invoices.get(id)!),
            retrieveInvoicePaymentState: async id => paymentStates.get(id) ?? 'failed',
        };
        stripe = methods as StripeApi;
        invoices.set('in_first', invoice('in_first', P1, 'subscription_create'));
        expect(await invoiceEvent('invoice.paid', 'in_first', new Date(P1.start.getTime() + MIN))).toBe('applied');
        // Renewal T: the new period, its invoice a draft.
        Object.assign(subscription, { currentPeriodStart: P2.start, currentPeriodEnd: P2.end });
        invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle', 'draft'));
        expect(await deliver('customer.subscription.updated', { id: subscriptionId }, T)).toBe('applied');
    });
    afterEach(async () => { vi.restoreAllMocks(); await client`rollback`; });
    afterAll(async () => { await client?.end(); });

    it('updated at T, invoice.paid at T+60 m: pending until the receipt is stored', async () => {
        for (const ms of [0, MIN, 30 * MIN, 59 * MIN]) await expectPending(at(ms));
        invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle'));
        expect(await invoiceEvent('invoice.paid', 'in_renewal', at(HOUR))).toBe('applied');
        await expectSettled(at(HOUR + MIN));
    });

    it('a late invoice.paid at T+3 h', async () => {
        await expectPending(at(3 * HOUR - MIN));
        invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle'));
        expect(await invoiceEvent('invoice.paid', 'in_renewal', at(3 * HOUR))).toBe('applied');
        await expectSettled(at(3 * HOUR + MIN));
    });

    it('invoice.payment_failed at T+60 m is the stored payment issue and grace, not pending', async () => {
        subscription.status = 'past_due';
        invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle', 'open'));
        paymentStates.set('in_renewal', 'failed');
        expect(await invoiceEvent('invoice.payment_failed', 'in_renewal', at(HOUR))).toBe('applied');
        const { state, summary } = await read(at(HOUR + MIN));
        expect(summary).toMatchObject({ plan: { status: 'past_due', paymentIssue: 'payment_failed', graceEndsAt: '2026-12-07T10:00:00Z' },
            computer: { standing: 'grace' }, fairUse: { status: 'ok' }, actions: { upgrade: false } });
        expect(state.allowanceStdSeconds).toBe(STANDARD.fairUseSeconds);
    });
});
