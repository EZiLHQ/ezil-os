/**
 * QA harness: a real migrated Postgres (BILLING_TEST_DATABASE_URL), the real
 * store, and an in-memory Stripe that only answers what a scenario put in it.
 * Written by the independent QA reviewer; shares no code with the lanes' tests.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import * as schema from '@/server/db/schema';
import { computers } from '@/server/db/schema';
import { readBillingConfig } from '../../config';
import type {
    BillingStore, OverageInvoiceRequest, OverageInvoiceResult, StripeApi, StripeCharge, StripeCheckoutSession, StripeInvoice,
    StripeInvoicePaymentState, StripeSubscription, UsageBillingPort,
} from '../../ports';
import { createBillingStore } from '../../store';
import type { StripeEventLike } from '../../stripe/events';
import { CATALOG_V2, type SellableSku } from '../contract';

export type Database = ReturnType<typeof drizzle<typeof schema>>;
export type Tenant = { userId: string; computerId: string; computerId2: string; customerId: string; subscriptionId: string };

export const START = new Date('2026-10-01T00:00:00Z');
export const END = new Date('2026-11-01T00:00:00Z');
export const NOW = new Date('2026-10-18T12:00:00Z');
export const WEBHOOK_SECRET = 'whsec_qa_fixture_only';
export const config = readBillingConfig({
    BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'fixture-only', STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
});

export const sec = (d: Date) => Math.floor(d.getTime() / 1000);

export function tenant(): Tenant {
    return {
        userId: randomUUID(), computerId: randomUUID(), computerId2: randomUUID(),
        customerId: `cus_${randomUUID()}`, subscriptionId: `sub_${randomUUID()}`,
    };
}

export function stripeSubscription(owner: Tenant, sku: SellableSku = 'compute_monthly_v2', start = START, end = END): StripeSubscription {
    return {
        id: owner.subscriptionId, customer: owner.customerId, status: 'active', sku, cancelAtPeriodEnd: false,
        currentPeriodStart: start, currentPeriodEnd: end, pendingUpdateExpiresAt: null,
        defaultPaymentMethod: null, scheduleId: null, latestInvoiceId: null,
        items: [{ id: 'si_1', priceId: `price_${sku}`, lookupKey: CATALOG_V2[sku].stripeLookupKey }],
    };
}

type Line = StripeInvoice['lines'][number];
export function baseLine(sub: StripeSubscription, lookupKey: string | null, overrides: Partial<Line> = {}): Line {
    return {
        id: `il_${randomUUID()}`, lookupKey, subscriptionId: sub.id, proration: false, amount: 2_000,
        periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd, ...overrides,
    };
}

export function paidInvoice(sub: StripeSubscription, overrides: Partial<StripeInvoice> = {}): StripeInvoice {
    return {
        id: `in_${randomUUID()}`, customer: sub.customer, status: 'paid', subscriptionId: sub.id,
        billingReason: 'subscription_cycle', metadataKind: null, hostedInvoiceUrl: null,
        periodStart: sub.currentPeriodStart, periodEnd: sub.currentPeriodEnd,
        lines: [
            // A decoy first line: only the lookup key may select the base line.
            baseLine(sub, null, { amount: 1 }),
            baseLine(sub, CATALOG_V2[sub.sku as SellableSku].stripeLookupKey),
        ],
        ...overrides,
    };
}

export function stripeEvent(type: string, object: Record<string, unknown>, at = NOW, id = `evt_${randomUUID()}`): StripeEventLike {
    return { id, type, created: sec(at), livemode: false, data: { object } };
}

/** 2025+ (endive) wire shape: subscription under parent.subscription_details. */
export function invoicePaidEvent(inv: StripeInvoice, at = NOW, type = 'invoice.paid', id?: string): StripeEventLike {
    return stripeEvent(type, {
        id: inv.id, customer: inv.customer, status: inv.status, billing_reason: inv.billingReason,
        metadata: inv.metadataKind === null ? {} : { kind: inv.metadataKind },
        parent: inv.subscriptionId === null ? null : { type: 'subscription_details', subscription_details: { subscription: inv.subscriptionId } },
        lines: { data: inv.lines.map(l => ({
            id: l.id, amount: l.amount,
            parent: { type: 'subscription_item_details', subscription_item_details: { subscription: l.subscriptionId, proration: l.proration } },
            period: { start: l.periodStart === null ? null : sec(l.periodStart), end: l.periodEnd === null ? null : sec(l.periodEnd) },
        })) },
    }, at, id);
}

export function fakeStripe() {
    const subscriptions = new Map<string, StripeSubscription>();
    const invoices = new Map<string, StripeInvoice>();
    const charges = new Map<string, StripeCharge>();
    const sessions = new Map<string, StripeCheckoutSession>();
    const paymentStates = new Map<string, StripeInvoicePaymentState>();
    const calls: string[] = [];
    function read<T>(rows: Map<string, T>, id: string): T {
        const row = rows.get(id);
        if (!row) throw new Error(`Unexpected Stripe read: ${id}`);
        return structuredClone(row);
    }
    const unused = (name: string) => async (): Promise<never> => { calls.push(name); throw new Error(`Unexpected Stripe call ${name}`); };
    const api: StripeApi = {
        resolvePrice: unused('resolvePrice'), previewUpgrade: unused('previewUpgrade'), confirmUpgrade: unused('confirmUpgrade'),
        scheduleDowngrade: unused('scheduleDowngrade'), cancelScheduledChange: unused('cancelScheduledChange'),
        setCancelAtPeriodEnd: unused('setCancelAtPeriodEnd'), createCustomer: unused('createCustomer'),
        createCheckoutSession: unused('createCheckoutSession'), createPortalSession: unused('createPortalSession'),
        listInvoices: async () => [],
        retrieveSubscription: async id => read(subscriptions, id),
        retrieveInvoice: async id => read(invoices, id),
        retrieveInvoicePaymentState: async id => paymentStates.get(id) ?? 'failed',
        retrieveCharge: async id => read(charges, id),
        retrieveCheckoutSession: async id => read(sessions, id),
    };
    return { api, subscriptions, invoices, charges, sessions, paymentStates, calls };
}

/** Records every overage invoice request; persists the draft id like the Stripe adapter does. */
export function fakeUsage() {
    const requests: OverageInvoiceRequest[] = [];
    let n = 0;
    const port: UsageBillingPort & { failAfterDraft: boolean } = {
        failAfterDraft: false,
        async invoiceOverage(input, hooks): Promise<OverageInvoiceResult> {
            requests.push(structuredClone(input));
            const id = input.existingInvoiceId ?? `in_overage_${++n}`;
            if (!input.existingInvoiceId) await hooks?.onDraftCreated?.(id);
            if (port.failAfterDraft) throw new Error('provider dropped the connection after the draft');
            return { status: 'invoiced', invoiceId: id, invoiceStatus: 'open', hostedInvoiceUrl: null };
        },
    };
    return { port, requests };
}

export function sign(body: string, at: Date, secret = WEBHOOK_SECRET): string {
    const t = sec(at);
    return `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
}

export function connect() {
    const client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    const db = drizzle(client, { schema });
    return { client, db, store: createBillingStore(db as never) as BillingStore };
}

export async function seedTenant(client: ReturnType<typeof postgres>, db: Database, store: BillingStore, owner: Tenant) {
    await client`insert into auth.users (id, created_at) values (${owner.userId}::uuid, ${START.toISOString()}::timestamptz)`;
    await db.insert(computers).values([
        { id: owner.computerId, userId: owner.userId, slot: 1 },
        { id: owner.computerId2, userId: owner.userId, slot: 2 },
    ]);
    await store.linkCustomer(owner.userId, owner.customerId);
}

/** Sold-v2 meter QA stays on the v2 summary after the public router moves to v3. */
export async function legacySummary(store: import('../../ports').BillingStore, userId: string, now: Date = NOW) {
    const { planFromSubscriptions } = await import('../catalog');
    const { buildSummaryV2, summaryMeters } = await import('../summary');
    const subs = await store.subscriptionsFor(userId);
    const userCreatedAt = await store.userCreatedAt(userId);
    const plan = planFromSubscriptions({ subs, userCreatedAt, now });
    const window = { start: new Date(plan.window.start), end: new Date(plan.window.end) };
    return buildSummaryV2({ config, now, subs, userCreatedAt,
        epochs: await store.epochsFor(userId, window.start), grants: await store.grantsForPeriod(userId, window, summaryMeters(plan.family)),
        consent: plan.subscriptionId ? await store.latestConsent(userId, plan.subscriptionId) : null,
        planChanges: await store.openPlanChanges(userId), paymentIssues: await store.openPaymentIssues(userId),
        overageInvoices: await store.overageInvoicesFor(userId), storage: await store.latestStorageFor(userId),
        sizePreference: await store.sizePreference(userId), hasCustomer: !!(await store.stripeCustomerFor(userId)),
    });
}
