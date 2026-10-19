/**
 * QA: grants, upgrades, refunds and webhook tenancy against a real Postgres.
 * Spec: CONTRACT-v2 §3, contract.ts "Grants (ledger rules)", golden.json upgradeGrant.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { billingGrants } from '@/server/db/schema/billing';
import { eq } from 'drizzle-orm';
import { handleStripeWebhook } from '../../http/stripe-webhook';
import type { BillingDeps, BillingStore } from '../../ports';
import { processStripeEvent } from '../../processor';
import golden from '../fixtures/golden.json';
import { CATALOG_V2, GRANT_METER_COMPUTE, OVERAGE_PRICE_LOOKUP_KEY } from '../contract';
import {
    END, NOW, START, baseLine, config, connect, fakeStripe, invoicePaidEvent, paidInvoice, seedTenant, sign,
    stripeEvent, stripeSubscription, tenant, type Database, type Tenant,
} from './harness';

const DELTA = CATALOG_V2.compute_monthly_v2.allowanceStdSeconds - CATALOG_V2.standard_monthly_v2.allowanceStdSeconds;

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('qa grants (Postgres)', () => {
    let conn: ReturnType<typeof connect>;
    let db: Database;
    let store: BillingStore;
    let stripe: ReturnType<typeof fakeStripe>;
    let a: Tenant;
    let b: Tenant;

    beforeAll(() => { conn = connect(); db = conn.db as Database; store = conn.store; });
    beforeEach(async () => {
        await conn.client`begin`;
        a = tenant(); b = tenant(); stripe = fakeStripe();
        await seedTenant(conn.client, db, store, a);
        await seedTenant(conn.client, db, store, b);
        stripe.subscriptions.set(a.subscriptionId, stripeSubscription(a, 'compute_monthly_v2'));
        stripe.subscriptions.set(b.subscriptionId, stripeSubscription(b, 'compute_monthly_v2'));
    });
    afterEach(async () => { await conn.client`rollback`; });
    afterAll(async () => { await conn.client?.end(); });

    const deps = () => ({ store, stripe: stripe.api, now: () => NOW });
    const computeGrants = async (userId: string) => (await db.select().from(billingGrants).where(eq(billingGrants.userId, userId)))
        .filter(g => g.meter === GRANT_METER_COMPUTE);
    const deliver = async (inv: ReturnType<typeof paidInvoice>, at = NOW) => {
        stripe.invoices.set(inv.id, inv);
        return processStripeEvent(invoicePaidEvent(inv, at), deps());
    };

    describe('what never grants', () => {
        it.each(['manual', 'subscription_threshold', 'subscription', 'automatic_pending_invoice_item_invoice', 'quote_accept', 'upcoming'])(
            'a paid invoice with billing_reason=%s grants nothing', async reason => {
                await deliver(paidInvoice(stripe.subscriptions.get(a.subscriptionId)!, { billingReason: reason }));
                expect(await computeGrants(a.userId)).toEqual([]);
            });

        it('a paid invoice with no billing_reason grants nothing', async () => {
            await deliver(paidInvoice(stripe.subscriptions.get(a.subscriptionId)!, { billingReason: null }));
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it('an overage invoice (metadata.kind=overage) grants nothing even if it claims subscription_cycle and carries a base line', async () => {
            await deliver(paidInvoice(stripe.subscriptions.get(a.subscriptionId)!, { metadataKind: 'overage' }));
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it('a non-upgrade subscription_update (Compute→Standard proration) grants nothing', async () => {
            const sub = stripe.subscriptions.get(a.subscriptionId)!;
            const mid = new Date('2026-10-10T00:00:00Z');
            await deliver(paidInvoice(sub, { billingReason: 'subscription_update', lines: [
                baseLine(sub, 'ezil_compute_monthly_v2', { amount: -7_000, proration: true, periodStart: mid }),
                baseLine(sub, 'ezil_standard_monthly_v2', { amount: 1_400, proration: true, periodStart: mid }),
            ] }));
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it('a subscription_update with only a Compute line (no Standard credit) grants nothing', async () => {
            const sub = stripe.subscriptions.get(a.subscriptionId)!;
            await deliver(paidInvoice(sub, { billingReason: 'subscription_update', lines: [
                baseLine(sub, 'ezil_compute_monthly_v2', { amount: 5_000, proration: true, periodStart: new Date('2026-10-10T00:00:00Z') }),
            ] }));
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it.each([
            ['no lookup key', null],
            ['the overage price', OVERAGE_PRICE_LOOKUP_KEY],
            ['a v1/unknown price', 'ezil_pro_monthly_v1'],
            ['a lookalike key', 'ezil_compute_monthly_v2_old'],
        ])('a subscription_cycle whose base line has %s grants nothing', async (_label, key) => {
            const sub = stripe.subscriptions.get(a.subscriptionId)!;
            await deliver(paidInvoice(sub, { lines: [baseLine(sub, key, { amount: 10_000 })] }));
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it('a base line owned by another subscription grants nothing', async () => {
            const sub = stripe.subscriptions.get(a.subscriptionId)!;
            await deliver(paidInvoice(sub, { lines: [baseLine(sub, 'ezil_compute_monthly_v2', { subscriptionId: b.subscriptionId })] }));
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it.each(['open', 'void', 'uncollectible', 'draft'])('invoice.paid whose provider re-read says %s grants nothing', async status => {
            await deliver(paidInvoice(stripe.subscriptions.get(a.subscriptionId)!, { status }));
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it('an unpaid renewal (invoice.payment_failed) grants nothing', async () => {
            const inv = paidInvoice(stripe.subscriptions.get(a.subscriptionId)!, { status: 'open' });
            stripe.invoices.set(inv.id, inv);
            await processStripeEvent(invoicePaidEvent(inv, NOW, 'invoice.payment_failed'), deps());
            expect(await computeGrants(a.userId)).toEqual([]);
        });
    });

    describe('what grants, exactly once', () => {
        it('a paid subscription_cycle grants the base line offer for the base line period (not the decoy first line)', async () => {
            expect(await deliver(paidInvoice(stripe.subscriptions.get(a.subscriptionId)!))).toBe('applied');
            const grants = await computeGrants(a.userId);
            expect(grants.map(g => [g.kind, g.amount, g.subscriptionId, g.periodStart?.toISOString(), g.periodEnd?.toISOString()])).toEqual([
                ['plan_period', BigInt(1_800_000), a.subscriptionId, START.toISOString(), END.toISOString()],
            ]);
        });

        it('the same invoice delivered twice (two event ids) grants once', async () => {
            const inv = paidInvoice(stripe.subscriptions.get(a.subscriptionId)!);
            await deliver(inv);
            await deliver(inv, new Date(NOW.getTime() + 60_000));
            expect(await computeGrants(a.userId)).toHaveLength(1);
        });

        it('two different paid invoices for the same (subscription, period_start) grant once', async () => {
            const sub = stripe.subscriptions.get(a.subscriptionId)!;
            await deliver(paidInvoice(sub, { billingReason: 'subscription_create' }));
            await deliver(paidInvoice(sub, { billingReason: 'subscription_cycle' }));
            const grants = await computeGrants(a.userId);
            expect(grants).toHaveLength(1);
            expect(grants[0].amount).toBe(BigInt(1_800_000));
        });

        it('a Standard invoice grants the Standard allowance (60 std-hours), never Compute', async () => {
            stripe.subscriptions.set(a.subscriptionId, stripeSubscription(a, 'standard_monthly_v2'));
            await deliver(paidInvoice(stripe.subscriptions.get(a.subscriptionId)!));
            expect((await computeGrants(a.userId)).map(g => g.amount)).toEqual([BigInt(216_000)]);
        });
    });

    describe('upgrade grants follow the oracle', () => {
        const upgradeInvoice = (owner: Tenant, effectiveAt: Date, periodEnd = END) => {
            const sub = stripe.subscriptions.get(owner.subscriptionId)!;
            return paidInvoice(sub, { billingReason: 'subscription_update', lines: [
                baseLine(sub, 'ezil_standard_monthly_v2', { amount: -1_000, proration: true, periodStart: effectiveAt, periodEnd }),
                baseLine(sub, 'ezil_compute_monthly_v2', { amount: 5_000, proration: true, periodStart: effectiveAt, periodEnd }),
            ] });
        };

        it.each(golden.upgradeGrant.filter(c => Date.parse(c.input.effectiveAt) < Date.parse(c.input.periodEnd)).map(c => [c.name, c] as const))(
            'processor grant for %s equals the oracle and is upgrade_prorated', async (_n, c) => {
                const ps = new Date(c.input.periodStart); const pe = new Date(c.input.periodEnd);
                stripe.subscriptions.set(a.subscriptionId, stripeSubscription(a, 'compute_monthly_v2', ps, pe));
                const inv = upgradeInvoice(a, new Date(c.input.effectiveAt), pe);
                await deliver(inv, new Date(c.input.effectiveAt));
                await deliver(inv, new Date(c.input.effectiveAt)); // replay
                const grants = await computeGrants(a.userId);
                expect(grants).toHaveLength(1);
                expect(grants[0].kind).toBe('upgrade_prorated');
                expect(grants[0].amount).toBe(BigInt(c.expected));
                expect(grants[0].amount <= BigInt(DELTA)).toBe(true);
            });

        it('an upgrade invoice whose period belongs to a previous renewal grants nothing', async () => {
            // Subscription has since renewed to November; the October upgrade invoice arrives late.
            stripe.subscriptions.set(a.subscriptionId, stripeSubscription(a, 'compute_monthly_v2', END, new Date('2026-12-01T00:00:00Z')));
            await deliver(upgradeInvoice(a, new Date('2026-10-20T00:00:00Z')));
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it('an unpaid upgrade proration (requires_action) grants nothing', async () => {
            const inv = { ...upgradeInvoice(a, new Date('2026-10-10T00:00:00Z')), status: 'open' };
            await deliver(inv);
            expect(await computeGrants(a.userId)).toEqual([]);
        });
    });

    describe('refunds and disputes', () => {
        const webhookDeps = (): BillingDeps => ({ config, store, stripe: stripe.api, usage: null, now: () => NOW });
        const post = (body: string, signature: string | null) => handleStripeWebhook(new Request('https://os.example/api/billing/stripe/webhook', {
            method: 'POST', body, headers: signature === null ? {} : { 'stripe-signature': signature },
        }), webhookDeps(), processStripeEvent);

        it('a full refund that arrives before its grant is retried (5xx), then revokes once the grant exists', async () => {
            const inv = paidInvoice(stripe.subscriptions.get(a.subscriptionId)!);
            stripe.invoices.set(inv.id, inv);
            stripe.charges.set('ch_1', { id: 'ch_1', customer: a.customerId, invoiceId: inv.id, paymentIntentId: 'pi_1', amount: 10_000, amountRefunded: 10_000, refunded: true });
            const refund = JSON.stringify(stripeEvent('refund.created', { id: 're_1', charge: 'ch_1' }, NOW, 'evt_refund_qa'));
            const first = await post(refund, sign(refund, NOW));
            expect(first.status).toBeGreaterThanOrEqual(500);
            expect(await computeGrants(a.userId)).toEqual([]);

            const paid = JSON.stringify(invoicePaidEvent(inv, NOW));
            expect((await post(paid, sign(paid, NOW))).status).toBe(200);
            // Stripe retries the SAME event id.
            const retry = await post(refund, sign(refund, NOW));
            expect(retry.status).toBe(200);
            const grants = await computeGrants(a.userId);
            expect(grants.map(g => g.kind).sort()).toEqual(['plan_period', 'revoke']);
            expect(grants.reduce((s, g) => s + g.amount, BigInt(0))).toBe(BigInt(0));
            // A further replay is a no-op.
            await post(refund, sign(refund, NOW));
            expect(await computeGrants(a.userId)).toHaveLength(2);
        });

        it('a refund on B\'s charge that points at A\'s invoice never revokes A', async () => {
            const inv = paidInvoice(stripe.subscriptions.get(a.subscriptionId)!);
            await deliver(inv);
            stripe.charges.set('ch_x', { id: 'ch_x', customer: b.customerId, invoiceId: inv.id, paymentIntentId: null, amount: 10_000, amountRefunded: 10_000, refunded: true });
            const outcome = await processStripeEvent(stripeEvent('refund.created', { id: 're_x', charge: 'ch_x' }), deps());
            expect(outcome).toMatch(/^review:/);
            expect((await computeGrants(a.userId)).map(g => g.kind)).toEqual(['plan_period']);
            expect(await computeGrants(b.userId)).toEqual([]);
        });

        it('a partial refund never revokes a period', async () => {
            const inv = paidInvoice(stripe.subscriptions.get(a.subscriptionId)!);
            await deliver(inv);
            stripe.charges.set('ch_p', { id: 'ch_p', customer: a.customerId, invoiceId: inv.id, paymentIntentId: null, amount: 10_000, amountRefunded: 100, refunded: false });
            await processStripeEvent(stripeEvent('refund.created', { id: 're_p', charge: 'ch_p' }), deps());
            expect((await computeGrants(a.userId)).map(g => g.kind)).toEqual(['plan_period']);
        });
    });

    describe('webhook tenancy and transport', () => {
        const webhookDeps = (): BillingDeps => ({ config, store, stripe: stripe.api, usage: null, now: () => NOW });
        const post = (init: RequestInit) => handleStripeWebhook(new Request('https://os.example/api/billing/stripe/webhook', { method: 'POST', ...init }), webhookDeps(), processStripeEvent);

        it('an invoice for customer B never grants to user A', async () => {
            const inv = paidInvoice(stripe.subscriptions.get(b.subscriptionId)!);
            stripe.invoices.set(inv.id, inv);
            const body = JSON.stringify(invoicePaidEvent(inv));
            expect((await post({ body, headers: { 'stripe-signature': sign(body, NOW) } })).status).toBe(200);
            expect(await computeGrants(a.userId)).toEqual([]);
            expect(await computeGrants(b.userId)).toHaveLength(1);
        });

        it('an invoice with customer B naming A\'s subscription grants nobody', async () => {
            const inv = { ...paidInvoice(stripe.subscriptions.get(a.subscriptionId)!), customer: b.customerId };
            await deliver(inv);
            expect(await computeGrants(a.userId)).toEqual([]);
            expect(await computeGrants(b.userId)).toEqual([]);
        });

        it.each([
            ['wrong secret', (body: string) => sign(body, NOW, 'whsec_attacker')],
            ['stale timestamp', (body: string) => sign(body, new Date(NOW.getTime() - 3_600_000))],
            ['missing header', () => null],
            ['garbage header', () => 't=abc,v1=zz'],
        ])('a forged signature (%s) returns 400 and grants nothing', async (_l, make) => {
            const inv = paidInvoice(stripe.subscriptions.get(a.subscriptionId)!);
            stripe.invoices.set(inv.id, inv);
            const body = JSON.stringify(invoicePaidEvent(inv));
            const signature = make(body);
            const res = await post({ body, headers: signature === null ? {} : { 'stripe-signature': signature } });
            expect(res.status).toBe(400);
            expect(await computeGrants(a.userId)).toEqual([]);
        });

        it('a signed body tampered after signing returns 400', async () => {
            const inv = paidInvoice(stripe.subscriptions.get(a.subscriptionId)!);
            stripe.invoices.set(inv.id, inv);
            const body = JSON.stringify(invoicePaidEvent(inv));
            const res = await post({ body: body.replace(a.customerId, b.customerId), headers: { 'stripe-signature': sign(body, NOW) } });
            expect(res.status).toBe(400);
        });

        it('a huge body returns 413 even with a lying or absent Content-Length', async () => {
            const huge = JSON.stringify({ id: 'evt_huge', pad: 'x'.repeat(300 * 1024) });
            for (const headers of [{}, { 'content-length': '10' }] as Record<string, string>[]) {
                const stream = new ReadableStream<Uint8Array>({
                    start(controller) {
                        const bytes = new TextEncoder().encode(huge);
                        for (let i = 0; i < bytes.length; i += 16 * 1024) controller.enqueue(bytes.slice(i, i + 16 * 1024));
                        controller.close();
                    },
                });
                const res = await post({ body: stream, headers: { ...headers, 'stripe-signature': sign(huge, NOW) }, duplex: 'half' } as RequestInit);
                expect(res.status).toBe(413);
            }
        });
    });
});
