import { createHash, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '@/server/db/schema';
import { authUsers, computers } from '@/server/db/schema';
import { aiCreditEntitlement, aiCreditOutboxItem, aiCreditRevokeItem } from './ai-credits';
import { readBillingConfig } from './config';
import type { BillingStore, StripeApi, StripeCharge, StripeInvoice, StripeInvoicePaymentState, StripeSubscription } from './ports';
import { processStripeEvent } from './processor';
import { createBillingStore } from './store';
import type { StripeEventLike } from './stripe/events';
import { planFromSubscriptions } from './v2/catalog';
import { CATALOG_V2, OVERAGE_PRICE_LOOKUP_KEY, OVERAGE_TERMS_VERSION, type SellableSku } from './v2/contract';
import { upgradeGrantStdSeconds } from './v2/rating';
import { buildSummaryV2, summaryMeters } from './v2/summary';
import { epochSeconds } from './v2/time';

type Database = typeof import('@/server/db').db;
type Tenant = { userId: string; computerId: string; customerId: string; subscriptionId: string };
const START = new Date('2026-10-01T00:00:00Z');
const END = new Date('2026-11-01T00:00:00Z');
const NOW = new Date('2026-10-18T12:00:00Z');
const window = { start: START, end: END };
const config = readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' });

function tenant(): Tenant {
    return { userId: randomUUID(), computerId: randomUUID(), customerId: `cus_${randomUUID()}`, subscriptionId: `sub_${randomUUID()}` };
}

function subscription(owner: Tenant, sku: SellableSku = 'standard_monthly_v2'): StripeSubscription {
    return {
        id: owner.subscriptionId, customer: owner.customerId, status: 'active', sku, cancelAtPeriodEnd: false,
        currentPeriodStart: START, currentPeriodEnd: END, pendingUpdateExpiresAt: null,
        defaultPaymentMethod: null, scheduleId: null, latestInvoiceId: null,
        items: [{ id: null, priceId: `price_${sku}`, lookupKey: CATALOG_V2[sku].stripeLookupKey }],
    };
}

function line(sub: StripeSubscription, sku: SellableSku, overrides: Partial<StripeInvoice['lines'][number]> = {}): StripeInvoice['lines'][number] {
    return {
        id: `il_${randomUUID()}`, lookupKey: CATALOG_V2[sku].stripeLookupKey, subscriptionId: sub.id,
        proration: false, amount: CATALOG_V2[sku].priceCents,
        periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, ...overrides,
    };
}

function invoice(sub: StripeSubscription, overrides: Partial<StripeInvoice> = {}): StripeInvoice {
    return {
        id: `in_${randomUUID()}`, customer: sub.customer, status: 'paid', subscriptionId: sub.id,
        billingReason: 'subscription_cycle', metadataKind: null, hostedInvoiceUrl: 'https://invoice.example/fixture',
        periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd,
        // The base line is deliberately not first. Only the lookup key chooses it.
        lines: [line(sub, 'standard_monthly_v2', { lookupKey: null, amount: 10 }), line(sub, sub.sku as SellableSku)],
        ...overrides,
    };
}

function event(type: string, object: Record<string, unknown>, at = NOW): StripeEventLike {
    return { id: `evt_${randomUUID()}`, type, created: epochSeconds(at), livemode: false, data: { object } };
}

/** Endive invoice references live under parent, not the old top-level subscription field. */
function invoiceEvent(value: StripeInvoice, type = 'invoice.paid', at = NOW): StripeEventLike {
    return event(type, {
        id: value.id, customer: value.customer, status: value.status, billing_reason: value.billingReason,
        metadata: value.metadataKind === null ? {} : { kind: value.metadataKind },
        parent: value.subscriptionId === null ? null : {
            type: 'subscription_details', subscription_details: { subscription: value.subscriptionId },
        },
        lines: { data: value.lines.map(item => ({
            id: item.id, amount: item.amount,
            parent: { type: 'subscription_item_details', subscription_item_details: {
                subscription: item.subscriptionId, proration: item.proration,
            } },
            period: { start: item.periodStart === null ? null : epochSeconds(item.periodStart),
                end: item.periodEnd === null ? null : epochSeconds(item.periodEnd) },
        })) },
    }, at);
}

function fakeStripe() {
    const subscriptions = new Map<string, StripeSubscription>();
    const invoices = new Map<string, StripeInvoice>();
    const charges = new Map<string, StripeCharge>();
    const paymentStates = new Map<string, StripeInvoicePaymentState>();
    function read<T>(rows: Map<string, T>, id: string): T {
        const row = rows.get(id);
        if (!row) throw new Error(`Unexpected Stripe read: ${id}`);
        return structuredClone(row);
    }
    const unused = async (): Promise<never> => { throw new Error('Unexpected Stripe API operation'); };
    const api: StripeApi = {
        listProducts: unused, retrieveProduct: unused, retrievePackPrice: unused, retrieveCoupon: unused, retrieveCheckoutLineItems: unused,
        resolvePrice: unused, previewUpgrade: unused, confirmUpgrade: unused, scheduleDowngrade: unused, cancelScheduledChange: unused, setCancelAtPeriodEnd: unused,
        retrieveSubscription: async id => read(subscriptions, id), retrieveInvoice: async id => read(invoices, id),
        retrieveInvoicePaymentState: async id => paymentStates.get(id) ?? 'failed',
        retrieveCharge: async id => read(charges, id), retrieveCheckoutSession: unused, createCustomer: unused,
        createCheckoutSession: unused, createPortalSession: unused, listInvoices: unused,
    };
    return { api, subscriptions, invoices, charges, paymentStates };
}

/** A disposable migrated Postgres, with one connection and a rollback for every scenario. */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('v2 processor and summary with Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let store: BillingStore;
    let stripe: ReturnType<typeof fakeStripe>;
    let a: Tenant;
    let b: Tenant;
    let now: Date;

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        db = drizzle(client, { schema });
        store = createBillingStore(db);
    });
    beforeEach(async () => {
        await client`begin`;
        a = tenant();
        b = tenant();
        now = NOW;
        stripe = fakeStripe();
        await client`insert into auth.users (id, created_at) values
            (${a.userId}::uuid, ${START.toISOString()}::timestamptz),
            (${b.userId}::uuid, ${START.toISOString()}::timestamptz)`;
        await db.insert(computers).values([
            { id: a.computerId, userId: a.userId, slot: 1 }, { id: b.computerId, userId: b.userId, slot: 1 },
        ]);
        await store.linkCustomer(a.userId, a.customerId);
        await store.linkCustomer(b.userId, b.customerId);
        stripe.subscriptions.set(a.subscriptionId, subscription(a));
        stripe.subscriptions.set(b.subscriptionId, subscription(b));
    });
    afterEach(async () => { await client`rollback`; });
    afterAll(async () => { await client?.end(); });

    const receipt = (value: StripeEventLike) => ({
        eventId: value.id, type: value.type, livemode: value.livemode,
        payloadSha256: createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    });
    async function deliver(value: StripeEventLike) {
        const status = await store.recordEvent(receipt(value));
        if (status === 'processed') return { receipt: status, outcome: 'duplicate' };
        const outcome = await processStripeEvent(value, { store, stripe: stripe.api, now: () => now });
        await store.markEventProcessed(value.id, outcome);
        return { receipt: status, outcome };
    }
    async function paid(owner: Tenant, sku: SellableSku = 'standard_monthly_v2') {
        const sub = subscription(owner, sku);
        stripe.subscriptions.set(sub.id, sub);
        const value = invoice(sub);
        stripe.invoices.set(value.id, value);
        expect((await deliver(invoiceEvent(value))).outcome).toBe('applied');
        return value;
    }
    async function acceptOverage(owner: Tenant) {
        return store.recordConsent({
            userId: owner.userId, subscriptionId: owner.subscriptionId, enabled: true, capCents: 2500,
            termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: 2, rateCentsPerStdHour: 25,
            actor: 'user', acceptedAt: START,
        });
    }
    async function summary(owner: Tenant) {
        const [subs, userCreatedAt, planChanges] = await Promise.all([
            store.subscriptionsFor(owner.userId), store.userCreatedAt(owner.userId), store.openPlanChanges(owner.userId),
        ]);
        const plan = planFromSubscriptions({ subs, userCreatedAt, now });
        const selectedWindow = { start: new Date(plan.window.start), end: new Date(plan.window.end) };
        const [epochs, grants, consent, paymentIssues, storage, sizePreference, customer] = await Promise.all([
            store.epochsFor(owner.userId, selectedWindow.start),
            store.grantsForPeriod(owner.userId, selectedWindow, summaryMeters(plan.family)),
            plan.subscriptionId === null ? null : store.latestConsent(owner.userId, plan.subscriptionId),
            store.openPaymentIssues(owner.userId), store.latestStorageFor(owner.userId),
            store.sizePreference(owner.userId), store.stripeCustomerFor(owner.userId),
        ]);
        return buildSummaryV2({ config, now, userCreatedAt, subs, epochs, grants, consent, paymentIssues,
            planChanges, storage, sizePreference, hasCustomer: customer !== null });
    }

    it.each(['customer.subscription.updated', 'customer.subscription.pending_update_applied'])
        ('applies a scheduled downgrade on %s only after the matching subscription upsert', async type => {
            await paid(a, 'compute_monthly_v2');
            await store.recordPlanChange({ userId: a.userId, subscriptionId: a.subscriptionId, kind: 'downgrade',
                fromSku: 'compute_monthly_v2', toSku: 'standard_monthly_v2', state: 'scheduled',
                stripeScheduleId: 'sched_fixture', stripeInvoiceId: null, hostedInvoiceUrl: null, effectiveAt: END, expiresAt: null });
            expect((await deliver(event(type, { id: a.subscriptionId }))).outcome).toBe('applied');
            expect((await store.openPlanChanges(a.userId))[0].state).toBe('scheduled');
            const renewed = { ...subscription(a), currentPeriodStart: END, currentPeriodEnd: new Date('2026-12-01T00:00:00Z') };
            stripe.subscriptions.set(a.subscriptionId, renewed);
            // The older event must not apply a change when its upsert was rejected as stale.
            await deliver(event(type, { id: a.subscriptionId }, START));
            expect((await store.openPlanChanges(a.userId))[0].state).toBe('scheduled');
            const delivery = event(type, { id: a.subscriptionId }, END);
            expect((await deliver(delivery)).outcome).toBe('applied');
            expect(await store.openPlanChanges(a.userId)).toEqual([]);
            const changes = await client`select state, effective_at from ezil_billing_plan_changes where user_id = ${a.userId}::uuid`;
            expect(changes).toEqual([expect.objectContaining({ state: 'applied' })]);
            expect(new Date(changes[0].effective_at).getTime()).toBe(END.getTime());
            await deliver({ ...delivery, id: `evt_${randomUUID()}` });
            expect(await store.openPlanChanges(a.userId)).toEqual([]);
        });

    it('replays the same event and invoice once, also deduplicating distinct invoices for one subscription period', async () => {
        const value = invoice(subscription(a));
        stripe.invoices.set(value.id, value);
        const delivery = invoiceEvent(value);
        expect(await deliver(delivery)).toEqual({ receipt: 'new', outcome: 'applied' });
        expect(await deliver(delivery)).toEqual({ receipt: 'processed', outcome: 'duplicate' });
        expect(await deliver({ ...delivery, id: `evt_${randomUUID()}` })).toEqual({ receipt: 'new', outcome: 'applied' });
        const duplicatePeriod = { ...value, id: `in_${randomUUID()}` };
        stripe.invoices.set(duplicatePeriod.id, duplicatePeriod);
        expect((await deliver(invoiceEvent(duplicatePeriod))).outcome).toBe('applied');
        const grants = await store.grantsForPeriod(a.userId, window, ['compute_std_seconds']);
        expect(grants).toEqual([expect.objectContaining({
            userId: a.userId, subscriptionId: a.subscriptionId, meter: 'compute_std_seconds', kind: 'plan_period',
            amount: BigInt(216000), sourceId: value.id,
        })]);
        expect(await store.grantsBySource('invoice', duplicatePeriod.id)).toEqual([]);
    });

    it('grants a delayed Standard create invoice after upgrade, replays once, then grants a Compute renewal', async () => {
        const sub = subscription(a, 'compute_monthly_v2');
        stripe.subscriptions.set(sub.id, sub);
        const value = invoice(sub, { billingReason: 'subscription_create', lines: [line(sub, 'standard_monthly_v2')] });
        stripe.invoices.set(value.id, value);
        const delivery = invoiceEvent(value);
        expect((await deliver(delivery)).outcome).toBe('applied');
        const expected = expect.objectContaining({
            userId: a.userId, subscriptionId: sub.id, kind: 'plan_period', meter: 'compute_std_seconds',
            amount: BigInt(216_000), periodStart: START, periodEnd: END, sourceId: value.id,
        });
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toEqual([expected]);
        expect((await store.subscriptionsFor(a.userId))[0].sku).toBe('compute_monthly_v2');
        expect((await deliver({ ...delivery, id: `evt_${randomUUID()}` })).outcome).toBe('applied');
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toEqual([expected]);

        const nextEnd = new Date('2026-12-01T00:00:00Z');
        const renewed = { ...sub, currentPeriodStart: END, currentPeriodEnd: nextEnd };
        stripe.subscriptions.set(sub.id, renewed);
        const renewal = invoice(renewed, { lines: [line(renewed, 'compute_monthly_v2')] });
        stripe.invoices.set(renewal.id, renewal);
        expect((await deliver(invoiceEvent(renewal, 'invoice.paid', END))).outcome).toBe('applied');
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toEqual([expected]);
        expect(await store.grantsForPeriod(a.userId, { start: END, end: nextEnd }, ['compute_std_seconds'])).toEqual([
            expect.objectContaining({ userId: a.userId, subscriptionId: sub.id, kind: 'plan_period', meter: 'compute_std_seconds',
                amount: BigInt(1_800_000), periodStart: END, periodEnd: nextEnd, sourceId: renewal.id }),
        ]);
    });

    it.each(['subscription_cycle', 'subscription_update'])('keeps same-second 3DS issues requires_action in both delivery orders for %s', async billingReason => {
        const sub = subscription(a);
        for (const firstType of ['invoice.payment_action_required', 'invoice.payment_failed']) {
            const value = invoice(sub, { status: 'open', billingReason });
            stripe.invoices.set(value.id, value);
            stripe.paymentStates.set(value.id, 'requires_action');
            if (billingReason === 'subscription_update') {
                await store.recordPlanChange({ userId: a.userId, subscriptionId: sub.id, kind: 'upgrade',
                    fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2', state: 'pending',
                    stripeInvoiceId: value.id, stripeScheduleId: null, hostedInvoiceUrl: value.hostedInvoiceUrl,
                    effectiveAt: null, expiresAt: END });
            }
            const secondType = firstType === 'invoice.payment_failed' ? 'invoice.payment_action_required' : 'invoice.payment_failed';
            for (const type of [firstType, secondType]) {
                expect((await deliver(invoiceEvent(value, type, NOW))).outcome).toBe('applied');
                const issues = await store.openPaymentIssues(a.userId);
                expect(issues.find(issue => issue.stripeInvoiceId === value.id)).toMatchObject({
                    issue: 'requires_action', stripeEventCreated: NOW,
                });
                if (billingReason === 'subscription_update') {
                    expect(await store.openPlanChanges(a.userId)).toEqual([expect.objectContaining({
                        stripeInvoiceId: value.id, state: 'requires_action',
                    })]);
                }
            }
            if (billingReason === 'subscription_update') {
                await store.setPlanChangeState({ userId: a.userId, subscriptionId: sub.id, kind: 'upgrade', state: 'expired' });
            }
        }
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toEqual([]);
    });

    it.each(['refund', 'dispute'] as const)('retries a %s delivered before its grant, then applies one negative row', async kind => {
        const value = invoice(subscription(a));
        stripe.invoices.set(value.id, value);
        const charge: StripeCharge = {
            id: `ch_${randomUUID()}`, customer: a.customerId, invoiceId: value.id, paymentIntentId: null,
            amount: 2000, amountRefunded: kind === 'refund' ? 2000 : 0, refunded: kind === 'refund',
        };
        stripe.charges.set(charge.id, charge);
        const sourceId = `${kind === 'refund' ? 're' : 'dp'}_${randomUUID()}`;
        const reversal = event(kind === 'refund' ? 'refund.created' : 'charge.dispute.created', { id: sourceId, charge: charge.id });
        const first = await deliver(reversal);
        expect(first.receipt).toBe('new');
        expect(first.outcome).toMatch(/^failed:/);
        expect(await store.recordEvent(receipt(reversal))).toBe('unprocessed');
        expect(await store.grantsBySource(kind, sourceId)).toEqual([]);
        expect((await deliver(invoiceEvent(value))).outcome).toBe('applied');
        expect(await deliver(reversal)).toEqual({ receipt: 'unprocessed', outcome: 'applied' });
        expect(await deliver(reversal)).toEqual({ receipt: 'processed', outcome: 'duplicate' });
        expect((await deliver({ ...reversal, id: `evt_${randomUUID()}` })).outcome).toBe('applied');
        expect(await store.grantsBySource(kind, sourceId)).toEqual([expect.objectContaining({
            userId: a.userId, subscriptionId: a.subscriptionId, meter: 'compute_std_seconds',
            kind: kind === 'refund' ? 'revoke' : 'suspend', amount: BigInt(-216000),
        })]);
        expect((await summary(a)).compute.allowanceStdSeconds).toBe(0);
    });

    it('grants only the prorated upgrade difference and keeps pre-upgrade usage in the summary', async () => {
        await paid(a);
        await store.openEpoch({ userId: a.userId, computerId: a.computerId, subscriptionId: a.subscriptionId,
            size: 'std-2', readyAt: new Date('2026-10-10T00:00:00Z') });
        await store.closeEpoch({ computerId: a.computerId, endedAt: new Date('2026-10-10T01:00:00Z'), reason: 'user_stop' });
        const before = await summary(a);
        expect(before.compute).toMatchObject({ allowanceStdSeconds: 216000, usedStdSeconds: 3600 });
        const effectiveAt = new Date('2026-10-16T12:00:00Z');
        const sub = subscription(a, 'compute_monthly_v2');
        stripe.subscriptions.set(sub.id, sub);
        const upgrade = invoice(sub, { billingReason: 'subscription_update', lines: [
            line(sub, 'standard_monthly_v2', { proration: true, amount: -1000, periodStart: effectiveAt }),
            line(sub, 'compute_monthly_v2', { proration: true, amount: 5000, periodStart: effectiveAt }),
        ] });
        stripe.invoices.set(upgrade.id, upgrade);
        await store.recordPlanChange({
            userId: a.userId, subscriptionId: a.subscriptionId, kind: 'upgrade', fromSku: 'standard_monthly_v2',
            toSku: 'compute_monthly_v2', stripeInvoiceId: upgrade.id, stripeScheduleId: null,
            hostedInvoiceUrl: upgrade.hostedInvoiceUrl, state: 'pending', effectiveAt, expiresAt: END,
        });
        expect((await deliver(invoiceEvent(upgrade))).outcome).toBe('applied');
        expect((await deliver(invoiceEvent(upgrade))).outcome).toBe('applied');
        const difference = upgradeGrantStdSeconds({ fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2',
            periodStart: START.toISOString(), periodEnd: END.toISOString(), effectiveAt: effectiveAt.toISOString() });
        expect(difference).toBe(792000);
        expect(await store.grantsBySource('invoice', upgrade.id)).toEqual([expect.objectContaining({
            kind: 'upgrade_prorated', amount: BigInt(difference), meter: 'compute_std_seconds',
            periodStart: START, periodEnd: END,
        })]);
        expect(await store.openPlanChanges(a.userId)).toEqual([]);
        const after = await summary(a);
        expect(after.plan).toMatchObject({ family: 'compute', status: 'active', pendingUpgrade: null });
        expect(after.compute).toMatchObject({ allowanceStdSeconds: 216000 + difference, usedStdSeconds: before.compute.usedStdSeconds,
            remainingStdSeconds: 216000 + difference - 3600 });
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toHaveLength(2);
    });

    it('acknowledges a refund on an overage invoice without writing a grant', async () => {
        const value = invoice(subscription(a), { metadataKind: 'overage', billingReason: 'manual', subscriptionId: null });
        stripe.invoices.set(value.id, value);
        const charge: StripeCharge = {
            id: `ch_${randomUUID()}`, customer: a.customerId, invoiceId: value.id, paymentIntentId: null,
            amount: 25, amountRefunded: 25, refunded: true,
        };
        stripe.charges.set(charge.id, charge);
        const sourceId = `re_${randomUUID()}`;
        const reversal = event('refund.created', { id: sourceId, charge: charge.id });
        expect(await deliver(reversal)).toEqual({ receipt: 'new', outcome: 'review:refund_on_overage_invoice' });
        expect(await deliver(reversal)).toEqual({ receipt: 'processed', outcome: 'duplicate' });
        expect(await store.grantsBySource('invoice', value.id)).toEqual([]);
        expect(await store.grantsBySource('refund', sourceId)).toEqual([]);
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toEqual([]);
    });

    it('settles a paid overage subscription_cycle with a valid base line without a plan_period grant', async () => {
        const sub = subscription(a);
        const value = invoice(sub, { metadataKind: 'overage', status: 'paid', subscriptionId: sub.id,
            billingReason: 'subscription_cycle', lines: [line(sub, 'standard_monthly_v2')] });
        stripe.invoices.set(value.id, value);
        const record = await store.upsertOverageInvoice({ userId: a.userId, subscriptionId: sub.id,
            periodStart: START, periodEnd: END, ratingVersion: 2, stdSecondsOver: BigInt(3600), cents: 25 });
        await store.attachOverageStripeInvoice(record.row.id, value.id);
        expect((await deliver(invoiceEvent(value))).outcome).toBe('applied');
        expect(await store.grantsBySource('invoice', value.id)).toEqual([]);
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toEqual([]);
        expect((await store.overageInvoiceByStripeId(value.id))?.status).toBe('paid');
    });

    it.each(['invoice.payment_failed', 'invoice.payment_action_required'])('never grants for overage and disables consent on %s', async failureType => {
        await paid(a, 'compute_monthly_v2');
        await acceptOverage(a);
        const sub = stripe.subscriptions.get(a.subscriptionId)!;
        const value = invoice(sub, { metadataKind: 'overage', billingReason: 'manual', subscriptionId: null,
            lines: [line(sub, 'compute_monthly_v2', { lookupKey: OVERAGE_PRICE_LOOKUP_KEY, subscriptionId: null, amount: 25 })] });
        stripe.invoices.set(value.id, value);
        const record = await store.upsertOverageInvoice({ userId: a.userId, subscriptionId: a.subscriptionId,
            periodStart: START, periodEnd: END, ratingVersion: 2, stdSecondsOver: BigInt(3600), cents: 25 });
        await store.attachOverageStripeInvoice(record.row.id, value.id);
        expect((await deliver(invoiceEvent(value))).outcome).toBe('applied');
        expect(await store.grantsBySource('invoice', value.id)).toEqual([]);
        expect((await store.overageInvoiceByStripeId(value.id))?.status).toBe('paid');
        expect((await store.latestConsent(a.userId, a.subscriptionId))?.enabled).toBe(true);

        // A separate invoice in the next period fails; paid invoices do not turn back into open invoices.
        const failed = { ...value, id: `in_${randomUUID()}`, status: 'open' };
        stripe.invoices.set(failed.id, failed);
        stripe.paymentStates.set(failed.id, failureType === 'invoice.payment_action_required' ? 'requires_action' : 'failed');
        const next = await store.upsertOverageInvoice({ userId: a.userId, subscriptionId: a.subscriptionId,
            periodStart: END, periodEnd: new Date('2026-12-01T00:00:00Z'), ratingVersion: 2, stdSecondsOver: BigInt(3600), cents: 25 });
        await store.attachOverageStripeInvoice(next.row.id, failed.id);
        const failedEvent = invoiceEvent(failed, failureType);
        expect((await deliver(failedEvent)).outcome).toBe('applied');
        expect((await deliver({ ...failedEvent, id: `evt_${randomUUID()}` })).outcome).toBe('applied');
        expect(await store.grantsBySource('invoice', failed.id)).toEqual([]);
        expect(await store.latestConsent(a.userId, a.subscriptionId)).toMatchObject({
            enabled: false, capCents: 2500, actor: 'system:overage_payment_issue',
        });
        const result = await summary(a);
        expect(result.compute.allowanceStdSeconds).toBe(1800000);
        expect(result.plan.paymentIssue).toBe('overage_unpaid');
        expect(result.overage).toMatchObject({ available: false, enabled: false, pausedReason: 'payment_failed' });
    });

    it('does not refresh allowance for an unpaid renewal, even when a paid event arrives for the open invoice', async () => {
        await paid(a);
        now = new Date('2026-11-02T00:00:00Z');
        const sub = { ...subscription(a), status: 'past_due', currentPeriodStart: END,
            currentPeriodEnd: new Date('2026-12-01T00:00:00Z') };
        stripe.subscriptions.set(sub.id, sub);
        const renewal = invoice(sub, { status: 'open', billingReason: 'subscription_cycle' });
        stripe.invoices.set(renewal.id, renewal);
        expect((await deliver(invoiceEvent(renewal, 'invoice.payment_failed', now))).outcome).toBe('applied');
        expect((await deliver(invoiceEvent(renewal, 'invoice.paid', now))).outcome).toBe('ignored');
        expect(await store.grantsBySource('invoice', renewal.id)).toEqual([]);
        expect(await store.grantsForPeriod(a.userId, { start: END, end: sub.currentPeriodEnd }, ['compute_std_seconds'])).toEqual([]);
        expect((await store.grantsForPeriod(a.userId, window, ['compute_std_seconds']))).toHaveLength(1);
        const result = await summary(a);
        expect(result.plan).toMatchObject({ family: 'standard', status: 'past_due',
            periodStart: '2026-11-01T00:00:00Z', periodEnd: '2026-12-01T00:00:00Z', paymentIssue: 'payment_failed' });
        expect(result.compute).toMatchObject({ allowanceStdSeconds: 0, remainingStdSeconds: 0, state: 'exhausted' });
    });

    it('isolates user reads and reviews foreign invoice grants, refunds and disputes without affecting the owner', async () => {
        const aInvoice = await paid(a, 'compute_monthly_v2');
        await paid(b);
        const aConsent = await acceptOverage(a);
        const bConsent = await acceptOverage(b);
        for (const owner of [a, b]) {
            await store.openEpoch({ userId: owner.userId, computerId: owner.computerId, subscriptionId: owner.subscriptionId,
                size: 'std-2', readyAt: new Date('2026-10-18T11:00:00Z') });
        }
        const before = await summary(a);
        const aEpochs = await store.epochsFor(a.userId, START);
        const aGrants = await store.grantsForPeriod(a.userId, window, ['compute_std_seconds']);
        expect(await store.epochsFor(b.userId, START)).toEqual([expect.objectContaining({ userId: b.userId, computerId: b.computerId })]);
        expect(await store.grantsForPeriod(b.userId, window, ['compute_std_seconds'])).toEqual([
            expect.objectContaining({ userId: b.userId, subscriptionId: b.subscriptionId, amount: BigInt(216000) }),
        ]);
        expect(await store.latestConsent(b.userId, a.subscriptionId)).toBeNull();
        expect(await store.latestConsent(a.userId, b.subscriptionId)).toBeNull();
        expect(await store.latestConsent(b.userId, b.subscriptionId)).toEqual(bConsent);
        expect((await summary(b)).compute.allowanceStdSeconds).toBe(216000);
        await expect(store.openEpoch({ userId: b.userId, computerId: a.computerId, subscriptionId: b.subscriptionId,
            size: 'std-2', readyAt: NOW })).rejects.toThrow('Computer does not belong to billing user');

        const foreign = { ...aInvoice, customer: b.customerId };
        stripe.invoices.set(foreign.id, foreign);
        expect((await deliver(invoiceEvent(foreign))).outcome).toBe('review:customer_mismatch');
        const charge: StripeCharge = { id: `ch_${randomUUID()}`, customer: b.customerId, invoiceId: aInvoice.id,
            paymentIntentId: null, amount: 10000, amountRefunded: 10000, refunded: true };
        stripe.charges.set(charge.id, charge);
        for (const type of ['refund.created', 'charge.dispute.created']) {
            expect((await deliver(event(type, { id: `reversal_${randomUUID()}`, charge: charge.id }))).outcome).toBe('review:customer_mismatch');
        }
        // A paid invoice cannot gain an issue from a stale payment event.
        expect((await deliver(invoiceEvent(foreign, 'invoice.payment_action_required'))).outcome).toBe('ignored');
        expect(await store.openPaymentIssues(b.userId)).toEqual([]);
        // Open invoice-only issues still resolve to B's mapped customer, even with A's subscription reference.
        const openForeign = { ...foreign, id: `in_${randomUUID()}`, status: 'open' };
        stripe.invoices.set(openForeign.id, openForeign);
        stripe.paymentStates.set(openForeign.id, 'requires_action');
        expect((await deliver(invoiceEvent(openForeign, 'invoice.payment_action_required'))).outcome).toBe('applied');
        expect(await store.openPaymentIssues(b.userId)).toEqual([expect.objectContaining({ userId: b.userId })]);
        expect(await store.openPaymentIssues(a.userId)).toEqual([]);
        expect(await store.epochsFor(a.userId, START)).toEqual(aEpochs);
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toEqual(aGrants);
        expect(await store.latestConsent(a.userId, a.subscriptionId)).toEqual(aConsent);
        expect(await summary(a)).toEqual(before);
    });

    it('does not let B overwrite A through an already-owned subscription id', async () => {
        await paid(a, 'compute_monthly_v2');
        await paid(b);
        await acceptOverage(a);
        await store.openEpoch({ userId: a.userId, computerId: a.computerId, subscriptionId: a.subscriptionId,
            size: 'cmp-4', readyAt: new Date('2026-10-18T11:00:00Z') });
        const before = await summary(a);
        const previousSubscriptions = await store.subscriptionsFor(a.userId);
        const previousGrants = await store.grantsForPeriod(a.userId, window, ['compute_std_seconds']);
        const previousEpochs = await store.epochsFor(a.userId, START);
        const previousConsent = await store.latestConsent(a.userId, a.subscriptionId);
        // Both freshly retrieved provider objects claim B, but the subscription id is already owned by A.
        const conflicting = { ...subscription(b), id: a.subscriptionId, status: 'past_due' };
        stripe.subscriptions.set(a.subscriptionId, conflicting);
        const foreign = invoice(conflicting, { status: 'open' });
        stripe.invoices.set(foreign.id, foreign);
        const result = await deliver(invoiceEvent(foreign, 'invoice.payment_failed', new Date(NOW.getTime() + 1000)));
        expect(result.outcome).toBe('review:customer_mismatch');
        expect(await store.openPaymentIssues(b.userId)).toEqual([]);
        expect(await store.subscriptionsFor(a.userId)).toEqual(previousSubscriptions);
        expect(await store.grantsForPeriod(a.userId, window, ['compute_std_seconds'])).toEqual(previousGrants);
        expect(await store.epochsFor(a.userId, START)).toEqual(previousEpochs);
        expect(await store.latestConsent(a.userId, a.subscriptionId)).toEqual(previousConsent);
        expect(await summary(a)).toEqual(before);
    });

});

/** HF2 (round 4 S-D): the store's reversal transaction is a savepoint inside this rollback-only test transaction. */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('HF2 refund over operator correction rows with Postgres', () => {
    let client: ReturnType<typeof postgres>, base: Database, db: Database, store: BillingStore, owner: Tenant;
    let finishTest: () => void, transactionDone: Promise<void>;
    const rollbackTest = Symbol('rollback hf2 test');
    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        base = drizzle(client, { schema });
    });
    beforeEach(async () => {
        const finished = new Promise<void>(resolve => { finishTest = resolve; });
        let ready!: () => void, failed!: (error: unknown) => void;
        const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
        transactionDone = base.transaction(async tx => {
            db = tx as unknown as Database; store = createBillingStore(db); owner = tenant();
            await db.insert(authUsers).values({ id: owner.userId });
            await store.linkCustomer(owner.userId, owner.customerId);
            ready(); await finished; throw rollbackTest;
        }).catch(error => { if (error !== rollbackTest) { failed(error); throw error; } });
        await started;
    });
    afterEach(async () => { finishTest?.(); await transactionDone; });
    afterAll(async () => { await client?.end(); });

    it.each(['root first', 'correction first'] as const)(
        'a full refund reverses compute and only the correction, in either insertion order (%s)', async order => {
            const stripe = fakeStripe();
            const invoiceId = `in_${randomUUID()}`;
            await store.insertGrant({ userId: owner.userId, meter: 'compute_std_seconds', kind: 'plan_period', amount: BigInt(144000),
                subscriptionId: owner.subscriptionId, periodStart: START, periodEnd: END, sourceType: 'invoice', sourceId: invoiceId });
            const root = aiCreditOutboxItem(owner.userId, aiCreditEntitlement({ userId: owner.userId, sku: 'standard_monthly_v3',
                subscriptionId: owner.subscriptionId, periodStart: START, periodEnd: END, invoiceId }), 'grant', invoiceId);
            Object.assign(root.payload, { credits: 4000, accountPublicId: 'canary-payer' });
            const ROOT = String(root.payload.entitlementId), CORR = `${ROOT}:correction-20261028`;
            const note = { operatorNote: 'r3-20261028 legacy amount correction' };
            const revoke = aiCreditRevokeItem(root);
            Object.assign(revoke.payload, { invoiceId: null, ...note });
            const correction = aiCreditOutboxItem(owner.userId, { entitlementId: CORR, credits: 200,
                expiresAt: String(root.payload.expiresAt) }, 'grant', invoiceId);
            Object.assign(correction.payload, { accountPublicId: 'canary-payer', ...note });
            for (const item of order === 'root first' ? [root, revoke, correction] : [correction, revoke, root]) await store.enqueueOutbox(item);
            // The receipt read has no ORDER BY, so heap order is not insertion order: hand the planner each order explicitly.
            const want = order === 'root first' ? [ROOT, CORR] : [CORR, ROOT];
            let reads = 0;
            const ordered: BillingStore = { ...store, aiCreditGrantsByInvoice: async (userId, invoice) => {
                const rows = await store.aiCreditGrantsByInvoice!(userId, invoice);
                expect(rows.map(r => String(r.payload.entitlementId)).sort()).toEqual([ROOT, CORR].sort());
                reads++;
                return want.map(id => rows.find(r => r.payload.entitlementId === id)!);
            } };
            const charge: StripeCharge = { id: `ch_${randomUUID()}`, customer: owner.customerId, invoiceId, paymentIntentId: null,
                amount: 2000, amountRefunded: 2000, refunded: true };
            stripe.charges.set(charge.id, charge);
            const refundId = `re_${randomUUID()}`;
            const deps = { store: ordered, stripe: stripe.api, now: () => NOW };
            const outbox = () => db.select().from(schema.billingOutbox).where(eq(schema.billingOutbox.userId, owner.userId));
            const before = await outbox();
            expect(await processStripeEvent(event('refund.created', { id: refundId, charge: charge.id }), deps)).toBe('applied');
            expect(reads).toBe(1);
            expect(await store.grantsBySource('refund', refundId)).toEqual([expect.objectContaining({ userId: owner.userId,
                meter: 'compute_std_seconds', kind: 'revoke', amount: BigInt(-144000), subscriptionId: owner.subscriptionId })]);
            const after = await outbox();
            expect(after.filter(row => !before.some(prior => prior.id === row.id))).toEqual([expect.objectContaining({
                eventKey: `${CORR}:revoke:refund:${refundId}`, kind: 'ai_revoke',
                payload: expect.objectContaining({ entitlementId: CORR, credits: 200, invoiceId, accountPublicId: 'canary-payer' }) })]);
            expect(await processStripeEvent(event('refund.updated', { id: refundId, charge: charge.id }), deps)).toBe('applied');
            expect(await outbox()).toEqual(after);
            expect(await store.grantsBySource('refund', refundId)).toHaveLength(1);
        },
    );
});
