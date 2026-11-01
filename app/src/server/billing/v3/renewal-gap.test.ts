/**
 * The renewal gap (release review 10-31), walked in Stripe's own event order through the real processor, the real
 * compute-access read and the real Billing and Usage tabs (bundled from shell/ezil/ui/Settings, as ui-copy.qa does).
 * At renewal T Stripe moves the subscription into its new period (customer.subscription.updated) but keeps the renewal
 * invoice a draft for about an hour before charging it; the period's receipt is written only on invoice.paid. Until the
 * invoice is paid or fails the plan reads as pending, never "used up" with an Upgrade offer, and nothing is granted.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { readBillingConfig } from '../config';
import type { BillingDeps, BillingStore, GrantInsert, GrantRow, PaymentIssueInsert, PaymentIssueRow, StoredComputeEpoch, StripeApi, StripeInvoice,
    StripeInvoicePaymentState, StripeSubscription, SubscriptionUpsert } from '../ports';
import { processStripeEvent } from '../processor';
import type { StripeEventLike } from '../stripe/events';
import { billingV2EntitlementReader, loadComputeBillingState } from '../v2/compute-access';
import { epochSeconds } from '../v2/time';
import { CATALOG_V3, type BillingSummaryV3 } from './contract';
import { buildSummaryV3, RENEWAL_PENDING_SECONDS } from './summary';
import { buildUsageV3 } from './usage';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));
vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ schedulePaidMigration: vi.fn() }));

const ROOT = path.resolve(__dirname, '../../../../..');
const appRequire = createRequire(path.join(ROOT, 'app/package.json'));
const shellRequire = createRequire(path.join(ROOT, 'shell/package.json'));
const { buildSync } = appRequire('esbuild');
const { JSDOM } = shellRequire('jsdom');
const bundle = buildSync({
    stdin: { contents: `
        import { summaryV3Html } from './tabs/billing.js';
        import { usageHtml } from './tabs/usage.js';
        window.renewalSeam = { summaryV3Html, usageHtml };
    `, resolveDir: path.join(ROOT, 'shell/ezil/ui/Settings') },
    bundle: true, write: false, format: 'iife', target: 'es2022',
}).outputFiles[0].text;
const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/os' });
dom.window.html_encode = (text: string) => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
dom.window.structuredClone = structuredClone;
dom.window.eval(bundle);
const shell = dom.window.renewalSeam;
afterAll(() => dom.window.close());

const USER = 'user_renewal', CUSTOMER = 'cus_renewal', SUB = 'sub_renewal';
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
/** The first real renewals land around 2026-11-30. */
const T = new Date('2026-11-30T09:00:00Z');
const P1 = { start: new Date(T.getTime() - 30 * DAY), end: T };
const P2 = { start: T, end: new Date(T.getTime() + 30 * DAY) };
const at = (ms: number) => new Date(T.getTime() + ms);
const STANDARD = CATALOG_V3.standard_monthly_v3;
const config = readBillingConfig({ BILLING_TAB_ENABLED: '1', CHECKOUT_ENABLED: '1', STRIPE_SECRET: 'sk_test_fixture' });

/** Only what the processor and the compute-access read touch; anything else throws. */
function memoryStore() {
    const subs = new Map<string, SubscriptionUpsert>();
    const grants: GrantRow[] = [];
    const issues = new Map<string, PaymentIssueRow>();
    const epochs: StoredComputeEpoch[] = [];
    const methods: Partial<BillingStore> = {
        userForStripeCustomer: async customer => customer === CUSTOMER ? USER : null,
        upsertSubscription: async row => {
            const previous = subs.get(row.stripeSubscriptionId);
            if (previous && previous.stripeEventCreated > row.stripeEventCreated) return 'stale';
            subs.set(row.stripeSubscriptionId, { ...row });
            return 'applied';
        },
        insertGrant: async (grant: GrantInsert) => {
            if (grants.some(row => row.sourceId === grant.sourceId && row.kind === grant.kind && row.meter === grant.meter)) return 'duplicate';
            grants.push({ ...grant, subscriptionId: grant.subscriptionId ?? null, id: `grant_${grants.length}`, createdAt: T });
            return 'inserted';
        },
        enqueueOutbox: async () => 'queued',
        recordPaymentIssue: async ({ eventCreated, ...issue }: PaymentIssueInsert) => {
            issues.set(issue.stripeInvoiceId, { ...issue, stripeEventCreated: eventCreated, resolvedAt: null, updatedAt: eventCreated });
        },
        resolvePaymentIssue: async (id, eventCreated) => {
            const row = issues.get(id);
            if (row && row.stripeEventCreated <= eventCreated) Object.assign(row, { resolvedAt: eventCreated, stripeEventCreated: eventCreated });
        },
        openPaymentIssues: async userId => [...issues.values()].filter(row => row.userId === userId && row.resolvedAt === null),
        openPlanChanges: async () => [],
        subscriptionsFor: async userId => [...subs.values()].filter(row => row.userId === userId),
        userCreatedAt: async () => new Date('2026-09-01T00:00:00Z'),
        epochsFor: async () => [...epochs],
        grantsForPeriod: async (userId, window, meters) => grants.filter(grant => grant.userId === userId && meters.includes(grant.meter)
            && grant.periodStart! < window.end && grant.periodEnd! > window.start),
        sizePreference: async () => null,
    };
    const store = new Proxy(methods, {
        get(target, key) {
            if (!(key in target)) throw new Error(`Unexpected store access: ${String(key)}`);
            return target[key as keyof typeof target];
        },
    }) as BillingStore;
    return { store, subs, grants, issues, epochs };
}

function invoice(id: string, period: typeof P1, billingReason: string, status = 'paid'): StripeInvoice {
    return { id, customer: CUSTOMER, status, subscriptionId: SUB, billingReason, metadataKind: null, hostedInvoiceUrl: null,
        periodStart: period.start, periodEnd: period.end,
        lines: [{ id: `il_${id}`, lookupKey: STANDARD.stripeLookupKey, subscriptionId: SUB, proration: false,
            amount: STANDARD.priceCents, periodStart: period.start, periodEnd: period.end }] };
}

function fakeStripe() {
    const subscription: StripeSubscription = { id: SUB, customer: CUSTOMER, status: 'active', sku: 'standard_monthly_v3',
        cancelAtPeriodEnd: false, currentPeriodStart: P1.start, currentPeriodEnd: P1.end, pendingUpdateExpiresAt: null,
        defaultPaymentMethod: null, scheduleId: null, latestInvoiceId: null,
        items: [{ id: 'si_renewal', priceId: 'price_standard', lookupKey: STANDARD.stripeLookupKey }] };
    const invoices = new Map<string, StripeInvoice>();
    const paymentStates = new Map<string, StripeInvoicePaymentState>();
    const methods: Partial<StripeApi> = {
        retrieveSubscription: async () => structuredClone(subscription),
        retrieveInvoice: async id => structuredClone(invoices.get(id)!),
        retrieveInvoicePaymentState: async id => paymentStates.get(id) ?? 'failed',
    };
    const api = new Proxy(methods, {
        get(target, key) {
            if (!(key in target)) throw new Error(`Unexpected Stripe API operation: ${String(key)}`);
            return target[key as keyof typeof target];
        },
    }) as StripeApi;
    return { api, subscription, invoices, paymentStates };
}

let sequence = 0;
function event(type: string, object: Record<string, unknown>, created: Date): StripeEventLike {
    return { id: `evt_renewal_${++sequence}`, type, created: epochSeconds(created), livemode: false, data: { object } };
}
const invoiceEvent = (type: string, id: string, created: Date) => event(type,
    { id, customer: CUSTOMER, parent: { subscription_details: { subscription: SUB } }, lines: { data: [] } }, created);

describe('renewal gap: a renewed Stripe period reads as pending until its invoice is paid or fails', () => {
    let f: ReturnType<typeof memoryStore>;
    let stripe: ReturnType<typeof fakeStripe>;
    const deliver = (delivery: StripeEventLike) => processStripeEvent(delivery, { store: f.store, stripe: stripe.api, now: () => new Date(delivery.created * 1000) });
    const deps = (now: Date): BillingDeps => ({ config, store: f.store, stripe: null, usage: null, now: () => now });

    beforeEach(async () => {
        vi.spyOn(console, 'info').mockImplementation(() => {});
        f = memoryStore();
        stripe = fakeStripe();
        // The first purchase: paid, so P1 has its receipt.
        stripe.invoices.set('in_first', invoice('in_first', P1, 'subscription_create'));
        expect(await deliver(invoiceEvent('invoice.paid', 'in_first', new Date(P1.start.getTime() + MIN)))).toBe('applied');
        // Renewal T: Stripe starts P2 and drafts its invoice (charged about an hour later).
        Object.assign(stripe.subscription, { currentPeriodStart: P2.start, currentPeriodEnd: P2.end });
        stripe.invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle', 'draft'));
        expect(await deliver(event('customer.subscription.updated', { id: SUB }, T))).toBe('applied');
        expect(f.subs.get(SUB)).toMatchObject({ currentPeriodStart: P2.start, currentPeriodEnd: P2.end, status: 'active' });
    });

    /**
     * The router's reads (billing.summary through compute-access, billing.usage), then the shell's two tabs. With `ai`
     * (the Gateway read billing.summary adds) the summary is rebuilt from the same rows with it. `usageAt`: billing.usage
     * is its own request, so it can be read a little before the summary.
     */
    async function read(now: Date, ai?: Parameters<typeof buildSummaryV3>[0]['ai'], usageAt = now) {
        const state = await loadComputeBillingState(deps(now), USER, now);
        const rows = { config, now, userCreatedAt: new Date('2026-09-01T00:00:00Z'), subs: await f.store.subscriptionsFor(USER),
            epochs: await f.store.epochsFor(USER, P2.start), grants: [...f.grants], consent: null, planChanges: [],
            paymentIssues: await f.store.openPaymentIssues(USER), storage: [], sizePreference: null, hasCustomer: false };
        const summary = ai ? buildSummaryV3({ ...rows, ai }) : state.summary as BillingSummaryV3;
        const usage = buildUsageV3({ ...rows, now: usageAt });
        const wire = (value: unknown) => dom.window.JSON.parse(JSON.stringify(value));
        const billing = dom.window.document.createElement('div');
        billing.innerHTML = shell.summaryV3Html(wire(summary), wire(usage));
        const usageTab = dom.window.document.createElement('div');
        usageTab.innerHTML = shell.usageHtml(wire(usage), wire(summary));
        const entitlement = await billingV2EntitlementReader(() => deps(now)).read(USER);
        return { state, summary, usage, billing, usageTab, entitlement };
    }
    const offers = (el: Element) => el.querySelector('[data-action="upgrade"], [data-action="usage-upgrade"], [data-action="checkout"]');

    async function expectPending(now: Date, ai?: Parameters<typeof read>[1], usageAt = now) {
        const view = await read(now, ai, usageAt);
        expect(view.summary.fairUse.status).toBe('awaiting_payment');
        expect(view.summary.computer.standing).toBe('paid');
        expect(view.summary.actions.upgrade).toBe(false);
        // Nothing is granted before the payment: no allowance, and the AWS entitlement stays unpaid (as at first purchase).
        expect(view.state.allowanceStdSeconds).toBe(0);
        expect(view.usage.period.allowanceStandardSeconds).toBe(0);
        expect(view.entitlement).toMatchObject({ status: 'expired' });
        for (const el of [view.billing, view.usageTab]) {
            expect(el.textContent).not.toMatch(/used up|paused/i);
            expect(offers(el)).toBeNull();
        }
        expect(view.billing.querySelector('[data-role="fair-use-paused"]')).toBeNull();
        expect(view.billing.querySelector('[data-role="meter-time"]')!.textContent).toContain('Pending');
        expect(view.billing.querySelector('[data-role="fair-use"]')!.getAttribute('data-status')).toBe('awaiting_payment');
        expect(view.billing.querySelector('[data-role="fair-use"]')!.textContent).toBe("This period's time is added once your payment goes through.");
        expect(view.usageTab.querySelector('[data-usage="compute"]')!.getAttribute('data-state')).toBe('pending');
        expect(view.usageTab.querySelector('[data-usage="compute"]')!.textContent).toContain("This period's time is added once your payment goes through.");
        return view;
    }
    async function expectSettled(now: Date) {
        const view = await read(now);
        expect(view.summary.fairUse.status).toBe('ok');
        expect(view.summary.actions.upgrade).toBe(true);
        expect(view.state.allowanceStdSeconds).toBe(STANDARD.fairUseSeconds);
        expect(view.entitlement).toMatchObject({ status: 'active', provider: 'aws', size: 'std-2' });
        expect(view.billing.querySelector('[data-role="meter-time"]')!.textContent).toContain('40 h left');
        expect(view.usageTab.querySelector('[data-usage="compute"]')!.getAttribute('data-state')).toBe('ok');
        return view;
    }

    it('invoice.paid about an hour after the period starts: pending until it lands, then the period is granted', async () => {
        for (const ms of [0, MIN, 30 * MIN, 59 * MIN]) await expectPending(at(ms));
        stripe.invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle', 'paid'));
        expect(await deliver(invoiceEvent('invoice.paid', 'in_renewal', at(HOUR)))).toBe('applied');
        expect(f.grants.filter(grant => grant.periodStart?.getTime() === P2.start.getTime()))
            .toEqual([expect.objectContaining({ subscriptionId: SUB, kind: 'plan_period', amount: BigInt(STANDARD.fairUseSeconds) })]);
        await expectSettled(at(HOUR + MIN));
    });

    it('a late invoice.paid (T+3 h): still pending at T+2 h 59 m, granted once it lands', async () => {
        await expectPending(at(3 * HOUR - MIN));
        stripe.invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle', 'paid'));
        expect(await deliver(invoiceEvent('invoice.paid', 'in_renewal', at(3 * HOUR)))).toBe('applied');
        await expectSettled(at(3 * HOUR + MIN));
    });

    it('invoice.payment_failed ends in the existing payment-issue path (grace, D17), never pending', async () => {
        await expectPending(at(30 * MIN));
        stripe.subscription.status = 'past_due';
        stripe.invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle', 'open'));
        stripe.paymentStates.set('in_renewal', 'failed');
        expect(await deliver(invoiceEvent('invoice.payment_failed', 'in_renewal', at(HOUR)))).toBe('applied');
        const failed = await read(at(HOUR + MIN));
        expect(failed.summary.plan).toMatchObject({ status: 'past_due', paymentIssue: 'payment_failed', graceEndsAt: '2026-12-07T10:00:00Z' });
        expect(failed.summary.computer.standing).toBe('grace');
        expect(failed.summary.fairUse.status).not.toBe('awaiting_payment');
        expect(failed.summary.actions.upgrade).toBe(false);
        // Unchanged D17: grace keeps the plan's fair use for the unpaid period.
        expect(failed.state.allowanceStdSeconds).toBe(STANDARD.fairUseSeconds);
        expect(failed.billing.querySelector('[data-role="payment-grace"]')!.textContent).toContain("Your last payment didn't go through");
        expect(failed.usageTab.querySelector('[data-usage="compute"]')!.getAttribute('data-state')).not.toBe('pending');
        // A Smart Retry that pays resolves the issue and grants the period.
        stripe.subscription.status = 'active';
        stripe.invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle', 'paid'));
        expect(await deliver(invoiceEvent('invoice.paid', 'in_renewal', at(2 * DAY)))).toBe('applied');
        await expectSettled(at(2 * DAY + MIN));
    });

    it('invoice.voided: a voided renewal invoice will never be paid, so the period is not pending (reads as before the fix)', async () => {
        await expectPending(at(30 * MIN));
        stripe.invoices.set('in_renewal', invoice('in_renewal', P2, 'subscription_cycle', 'void'));
        expect(await deliver(invoiceEvent('invoice.voided', 'in_renewal', at(HOUR)))).toBe('applied');
        expect([...f.issues.values()]).toEqual([expect.objectContaining({ stripeInvoiceId: 'in_renewal', subscriptionId: SUB,
            invoiceKind: 'subscription', issue: 'voided', resolvedAt: null })]);
        const voided = await read(at(HOUR + MIN));
        // Standing ignores a voided invoice (still paid, no payment issue); only the pending state is withdrawn.
        expect(voided.summary.computer.standing).toBe('paid');
        expect(voided.summary.plan.paymentIssue).toBeNull();
        expect(voided.summary.fairUse.status).toBe('paused');
        expect(voided.state.allowanceStdSeconds).toBe(0);
        expect(voided.billing.querySelector('[data-role="fair-use"][data-status="awaiting_payment"]')).toBeNull();
        expect(voided.usageTab.querySelector('[data-usage="compute"]')!.getAttribute('data-state')).not.toBe('pending');
    });

    it('a first purchase stored active before its first invoice.paid (a bank debit) is pending with the same copy, then granted', async () => {
        // A fresh account, not the renewal set up above: T is the purchase, and the subscription has no earlier receipt.
        f = memoryStore();
        stripe = fakeStripe();
        Object.assign(stripe.subscription, { currentPeriodStart: P2.start, currentPeriodEnd: P2.end });
        stripe.invoices.set('in_first', invoice('in_first', P2, 'subscription_create', 'open'));
        expect(await deliver(event('customer.subscription.created', { id: SUB }, T))).toBe('applied');
        expect(f.subs.get(SUB)).toMatchObject({ status: 'active', currentPeriodStart: P2.start });
        expect(f.grants).toEqual([]);
        // A US bank debit confirms in up to 4 business days.
        for (const ms of [MIN, 2 * DAY]) await expectPending(at(ms));
        stripe.invoices.set('in_first', invoice('in_first', P2, 'subscription_create'));
        expect(await deliver(invoiceEvent('invoice.paid', 'in_first', at(3 * DAY)))).toBe('applied');
        await expectSettled(at(3 * DAY + MIN));
    });

    it('a session open while pending: no fair-use deadline of "now", so the Usage tab names no end beside Pending', async () => {
        // Started at T+10 m (nothing refuses it with enforcement off), its heartbeat fresh.
        f.epochs.push({ id: 'epoch_pending', userId: USER, computerId: 'computer_renewal', size: 'std-2', weight: 1,
            readyAt: at(10 * MIN).toISOString(), endedAt: null, endReason: null, overheadSeconds: 0, deadlineAt: null,
            lastHeartbeatAt: at(29 * MIN).toISOString() });
        // billing.usage answered 30 s before billing.summary: a deadline of the summary's "now" would still be ahead of it.
        const view = await expectPending(at(30 * MIN), undefined, at(30 * MIN - 30_000));
        const session = view.usageTab.querySelector('[data-usage="session"]')!.textContent;
        expect(session).toMatch(/^This session: .* · running$/);
        expect(session).not.toMatch(/ends/);
        expect(view.summary.computer).toMatchObject({ sessionMaxSeconds: null, activeDeadline: null });
    });

    it('AI credits while pending: the last period\'s live credits, never used up', async () => {
        // P1's credits were delivered and are still live in their 3-day tail; P2 has no receipt until invoice.paid.
        const expiresAt = new Date(P1.end.getTime() + 3 * DAY).toISOString();
        const ai = { receipts: [{ entitlementId: `ezil-os:v1:standard_monthly_v3:${SUB}:${P1.start.toISOString()}`, credits: 200, expiresAt,
            deliveredAt: new Date(P1.start.getTime() + 2 * MIN).toISOString() }],
        gatewayGrants: [{ creditsMicro: '200000000', remainingMicro: '150000000', expiresAt, live: true }], balanceMicro: '150000000' };
        const view = await expectPending(at(30 * MIN), ai);
        expect(view.summary.ai).toMatchObject({ state: 'ok', balance: 150, previous: { remaining: 150 } });
        expect(view.billing.querySelector('[data-role="meter-ai"]')!.textContent).toContain('150 of 200 left');
        expect(view.usageTab.querySelector('[data-usage="ai"]')!.textContent).toContain('150 of 200 left');
        for (const el of [view.billing, view.usageTab]) expect(el.textContent).not.toMatch(/No credits|0 of 0/i);
    });

    it('is bounded: with no outcome after RENEWAL_PENDING_SECONDS the period reads as it did before the fix', async () => {
        expect(RENEWAL_PENDING_SECONDS).toBe(7 * 86_400);
        await expectPending(at(RENEWAL_PENDING_SECONDS * 1000 - 1000));
        const lapsed = await read(at(RENEWAL_PENDING_SECONDS * 1000));
        expect(lapsed.summary.fairUse.status).toBe('paused');
        expect(lapsed.state.allowanceStdSeconds).toBe(0);
    });

    it('operator-granted rows (no sub_ id, no invoice) keep working and never wait for a renewal', async () => {
        const op = 'op_canary_renewal';
        await f.store.upsertSubscription({ stripeSubscriptionId: op, userId: USER, status: 'active', sku: 'premium_monthly_v3',
            currentPeriodStart: T, currentPeriodEnd: new Date('2027-01-30T09:00:00Z'), cancelAtPeriodEnd: false, stripeEventCreated: T });
        // With no grant the operator row is not pending: no invoice will come for it.
        const ungranted = await read(at(MIN));
        expect(ungranted.summary.plan.sku).toBe('premium_monthly_v3');
        expect(ungranted.summary.fairUse.status).toBe('paused');
        await f.store.insertGrant({ userId: USER, subscriptionId: op, meter: 'compute_std_seconds', kind: 'plan_period',
            amount: BigInt(CATALOG_V3.premium_monthly_v3.fairUseSeconds), periodStart: T, periodEnd: new Date('2027-01-30T09:00:00Z'),
            sourceType: 'invoice', sourceId: 'op_grant_renewal' });
        const granted = await read(at(MIN));
        expect(granted.summary.fairUse.status).toBe('ok');
        expect(granted.state.allowanceStdSeconds).toBe(CATALOG_V3.premium_monthly_v3.fairUseSeconds);
        // No Stripe-backed action on an operator row (promotion review), unchanged.
        expect(granted.summary.actions).toMatchObject({ upgrade: false, downgrade: false, cancel: false, portal: false });
    });
});
