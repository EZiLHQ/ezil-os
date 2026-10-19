/**
 * QA: overage close/invoice, consent, failure handling and router guards against a real Postgres.
 * Spec: CONTRACT-v2 §2 (period), §4 (overage), §6 (router), contract.ts overage constants.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('inject deps'); } }));

import { createBillingRouter } from '@/server/api/routers/billing';
import { billingOverageConsents, billingOverageInvoices } from '@/server/db/schema/billing';
import { eq } from 'drizzle-orm';
import type { BillingDeps, BillingStore } from '../../ports';
import { processStripeEvent } from '../../processor';
import { closePeriodAndInvoiceOverage } from '../close-period';
import { GRANT_METER_COMPUTE, OVERAGE_TERMS_VERSION, type SizeCode } from '../contract';
import {
    END, NOW, START, config, connect, fakeStripe, fakeUsage, invoicePaidEvent, seedTenant, stripeSubscription, tenant,
    type Database, type Tenant,
} from './harness';

const AFTER_CLOSE = new Date(END.getTime() + 2 * 3600 * 1000);
const H = 3600 * 1000;

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('qa overage (Postgres)', () => {
    let conn: ReturnType<typeof connect>;
    let db: Database;
    let store: BillingStore;
    let stripe: ReturnType<typeof fakeStripe>;
    let usage: ReturnType<typeof fakeUsage>;
    let a: Tenant;
    let b: Tenant;

    beforeAll(() => { conn = connect(); db = conn.db as Database; store = conn.store; });
    beforeEach(async () => {
        await conn.client`begin`;
        a = tenant(); b = tenant(); stripe = fakeStripe(); usage = fakeUsage();
        await seedTenant(conn.client, db, store, a);
        await seedTenant(conn.client, db, store, b);
    });
    afterEach(async () => { await conn.client`rollback`; });
    afterAll(async () => { await conn.client?.end(); });

    async function subscribe(owner: Tenant, sku: 'standard_monthly_v2' | 'compute_monthly_v2', start = START, end = END) {
        stripe.subscriptions.set(owner.subscriptionId, stripeSubscription(owner, sku, start, end));
        await store.upsertSubscription({
            stripeSubscriptionId: owner.subscriptionId, userId: owner.userId, status: 'active', sku,
            currentPeriodStart: start, currentPeriodEnd: end, cancelAtPeriodEnd: false, stripeEventCreated: start,
        });
        await store.insertGrant({
            userId: owner.userId, subscriptionId: owner.subscriptionId, meter: GRANT_METER_COMPUTE, kind: 'plan_period',
            amount: BigInt(sku === 'compute_monthly_v2' ? 1_800_000 : 216_000), periodStart: start, periodEnd: end,
            sourceType: 'invoice', sourceId: `in_seed_${owner.subscriptionId}_${start.getTime()}`,
        });
    }
    /** n back-to-back 6 h sessions from `from` (stays well inside October for n ≤ 50). */
    async function burn(owner: Tenant, from: Date, n: number, size: SizeCode = 'cmp-8') {
        for (let i = 0; i < n; i++) {
            const ready = new Date(from.getTime() + i * 6 * H);
            await store.openEpoch({ userId: owner.userId, computerId: owner.computerId, subscriptionId: owner.subscriptionId, size, readyAt: ready });
            await store.closeEpoch({ computerId: owner.computerId, endedAt: new Date(ready.getTime() + 6 * H), reason: 'session_max' });
        }
    }
    const consent = (owner: Tenant, at: Date, enabled = true, capCents = 2_500, termsVersion: string = OVERAGE_TERMS_VERSION) => store.recordConsent({
        userId: owner.userId, subscriptionId: owner.subscriptionId, enabled, capCents, termsVersion,
        catalogVersion: 2, rateCentsPerStdHour: 25, actor: owner.userId, acceptedAt: at,
    });
    const close = (owner: Tenant, now = AFTER_CLOSE) => closePeriodAndInvoiceOverage({ store, usage: usage.port }, { userId: owner.userId, now });
    const invoices = (owner: Tenant) => db.select().from(billingOverageInvoices).where(eq(billingOverageInvoices.userId, owner.userId));

    describe('close period', () => {
        it('is never billed for Standard, even with a (forged) enabled consent and heavy usage', async () => {
            await subscribe(a, 'standard_monthly_v2');
            await consent(a, START);
            await burn(a, new Date('2026-10-02T00:00:00Z'), 10, 'std-2');
            expect(await close(a)).toMatchObject({ status: 'skipped' });
            expect(usage.requests).toEqual([]);
            expect(await invoices(a)).toEqual([]);
        });

        it('is never billed for Free (no subscription)', async () => {
            await burn(a, new Date('2026-10-02T00:00:00Z'), 3, 'free-cf');
            expect(await close(a)).toMatchObject({ status: 'skipped' });
            expect(usage.requests).toEqual([]);
        });

        it('is never billed without consent', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await burn(a, new Date('2026-10-02T00:00:00Z'), 25);
            expect(await close(a)).toEqual({ status: 'skipped', reason: 'overage_disabled' });
            expect(usage.requests).toEqual([]);
        });

        it('usage before the consent was given is not billed', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await burn(a, new Date('2026-10-02T00:00:00Z'), 25); // ends 2026-10-08T06:00Z, 2,160,000 std-s
            await consent(a, new Date('2026-10-09T00:00:00Z'));
            expect(await close(a)).toEqual({ status: 'skipped', reason: 'nothing_to_bill' });
        });

        it('is never above the cap and is a whole number of cents', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await consent(a, START, true, 1_000);
            await burn(a, new Date('2026-10-02T00:00:00Z'), 40);
            expect(await close(a)).toMatchObject({ status: 'invoiced' });
            expect(usage.requests).toHaveLength(1);
            expect(usage.requests[0].cents).toBe(1_000);
            const [row] = await invoices(a);
            expect(row.cents).toBe(1_000);
        });

        it('an exact over-allowance amount bills floor(over / 144) cents', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await consent(a, START, true, 10_000);
            await burn(a, new Date('2026-10-02T00:00:00Z'), 22); // 22 × 86,400 = 1,900,800 → over 100,800 → 700¢
            await close(a);
            expect(usage.requests.map(r => r.cents)).toEqual([700]);
            expect(usage.requests[0].periodStart.toISOString()).toBe(START.toISOString());
        });

        it('re-running the close never creates a second invoice', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await consent(a, START);
            await burn(a, new Date('2026-10-02T00:00:00Z'), 25);
            const first = await close(a);
            const second = await close(a);
            const third = await close(a, new Date(AFTER_CLOSE.getTime() + 24 * H));
            expect(first).toMatchObject({ status: 'invoiced' });
            expect(second).toMatchObject({ status: 'exists' });
            expect(third).toMatchObject({ status: 'exists' });
            expect(usage.requests).toHaveLength(1);
            expect(await invoices(a)).toHaveLength(1);
        });

        it('a crash after the provider draft resumes that draft instead of creating another', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await consent(a, START);
            await burn(a, new Date('2026-10-02T00:00:00Z'), 25);
            usage.port.failAfterDraft = true;
            await expect(close(a)).rejects.toThrow();
            usage.port.failAfterDraft = false;
            await close(a);
            expect(usage.requests).toHaveLength(2);
            expect(usage.requests[0].existingInvoiceId ?? null).toBeNull();
            expect(usage.requests[1].existingInvoiceId).toBe('in_overage_1');
            const rows = await invoices(a);
            expect(rows.map(r => [r.stripeInvoiceId, r.status])).toEqual([['in_overage_1', 'open']]);
        });

        it('B\'s consent rows never enable overage on A, and A\'s usage never bills B', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await subscribe(b, 'compute_monthly_v2');
            // A consent stored under B's user id but naming A's subscription.
            await store.recordConsent({ userId: b.userId, subscriptionId: a.subscriptionId, enabled: true, capCents: 2_500,
                termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: 2, rateCentsPerStdHour: 25, actor: b.userId, acceptedAt: START });
            await consent(b, START);
            await burn(a, new Date('2026-10-02T00:00:00Z'), 25);
            expect(await close(a)).toEqual({ status: 'skipped', reason: 'overage_disabled' });
            expect(await close(b)).toEqual({ status: 'skipped', reason: 'nothing_to_bill' });
            expect(usage.requests).toEqual([]);
        });
    });

    describe('a failed overage invoice turns overage off', () => {
        it('disables consent, pauses with payment_failed, refuses re-enabling and stops the next period from billing', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await consent(a, START);
            await burn(a, new Date('2026-10-02T00:00:00Z'), 25);
            await close(a);
            const failedAt = new Date(AFTER_CLOSE.getTime() + H);
            stripe.invoices.set('in_overage_1', {
                id: 'in_overage_1', customer: a.customerId, status: 'open', subscriptionId: null, billingReason: 'manual',
                metadataKind: 'overage', hostedInvoiceUrl: null, lines: [], periodStart: null, periodEnd: null,
            });
            const outcome = await processStripeEvent(invoicePaidEvent(stripe.invoices.get('in_overage_1')!, failedAt, 'invoice.payment_failed'), { store, stripe: stripe.api, now: () => failedAt });
            expect(outcome).toBe('applied');
            expect((await store.latestConsent(a.userId, a.subscriptionId))?.enabled).toBe(false);
            expect((await invoices(a))[0].status).toBe('payment_failed');

            // Renewed into November; the router refuses enabling overage while the issue is open.
            const NOV_END = new Date('2026-12-01T00:00:00Z');
            await subscribe(a, 'compute_monthly_v2', END, NOV_END);
            const deps: BillingDeps = { config, store, stripe: stripe.api, usage: usage.port, now: () => new Date(END.getTime() + 3 * 86_400_000) };
            const caller = createBillingRouter(() => deps).createCaller(ctxFor(a));
            await expect(caller.setOverage({ enabled: true, capCents: 2_500, termsVersion: OVERAGE_TERMS_VERSION })).rejects.toThrow();
            const summary = await caller.summary();
            expect(summary.enabled && summary.overage).toMatchObject({ enabled: false, pausedReason: 'payment_failed' });

            // November heavy usage is not billed.
            for (let i = 0; i < 25; i++) {
                const ready = new Date(END.getTime() + 86_400_000 + i * 6 * H);
                await store.openEpoch({ userId: a.userId, computerId: a.computerId, subscriptionId: a.subscriptionId, size: 'cmp-8', readyAt: ready });
                await store.closeEpoch({ computerId: a.computerId, endedAt: new Date(ready.getTime() + 6 * H), reason: 'session_max' });
            }
            expect(await close(a, new Date(NOV_END.getTime() + 2 * H))).toMatchObject({ status: 'skipped' });
            expect(usage.requests).toHaveLength(1);
        });
    });

    describe('router guards', () => {
        const deps = (): BillingDeps => ({ config, store, stripe: stripe.api, usage: usage.port, now: () => NOW });
        const caller = (owner: Tenant) => createBillingRouter(deps).createCaller(ctxFor(owner));
        const consents = (owner: Tenant) => db.select().from(billingOverageConsents).where(eq(billingOverageConsents.userId, owner.userId));

        it.each([-100, -1, 1, 2_550, 10_001, 10_100, 2_500.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21])(
            'setOverage refuses cap %s and records nothing', async cap => {
                await subscribe(a, 'compute_monthly_v2');
                await expect(caller(a).setOverage({ enabled: true, capCents: cap, termsVersion: OVERAGE_TERMS_VERSION })).rejects.toThrow();
                expect(await consents(a)).toEqual([]);
            });

        it.each([0, 100, 2_500, 10_000])('setOverage accepts whole-dollar cap %s within 0..10000', async cap => {
            await subscribe(a, 'compute_monthly_v2');
            const out = await caller(a).setOverage({ enabled: true, capCents: cap, termsVersion: OVERAGE_TERMS_VERSION });
            expect(out).toMatchObject({ enabled: true, capCents: cap, termsVersion: OVERAGE_TERMS_VERSION, acceptedVersion: OVERAGE_TERMS_VERSION });
            const [row] = await consents(a);
            expect(row).toMatchObject({ enabled: true, capCents: cap, termsVersion: OVERAGE_TERMS_VERSION, rateCentsPerStdHour: 25, catalogVersion: 2, actor: a.userId });
        });

        it('setOverage refuses a stale terms version', async () => {
            await subscribe(a, 'compute_monthly_v2');
            await expect(caller(a).setOverage({ enabled: true, capCents: 2_500, termsVersion: 'overage-v1' } as never)).rejects.toThrow(/terms_version_mismatch/);
            expect(await consents(a)).toEqual([]);
        });

        it('setOverage refuses Standard and Free', async () => {
            await subscribe(a, 'standard_monthly_v2');
            await expect(caller(a).setOverage({ enabled: true, capCents: 2_500, termsVersion: OVERAGE_TERMS_VERSION })).rejects.toThrow();
            await expect(caller(b).setOverage({ enabled: true, capCents: 2_500, termsVersion: OVERAGE_TERMS_VERSION })).rejects.toThrow();
            expect([...(await consents(a)), ...(await consents(b))]).toEqual([]);
        });

        it('a Compute subscriber starts with overage OFF (no auto-enrolment)', async () => {
            await subscribe(a, 'compute_monthly_v2');
            const s = await caller(a).summary();
            expect(s.enabled && s.overage).toMatchObject({ enabled: false, acceptedVersion: null, capCents: 2_500 });
            expect(s.enabled && s.estimate.worstCaseOverageCents).toBe(0);
        });

        it('summary for A never shows B\'s grants, epochs or overage', async () => {
            await subscribe(b, 'compute_monthly_v2');
            await consent(b, START);
            await burn(b, new Date('2026-10-02T00:00:00Z'), 25);
            const s = await caller(a).summary();
            expect(s.enabled && [s.plan.family, s.compute.usedStdSeconds, s.overage]).toEqual(['free', 0, null]);
        });

        it.each([
            ['free', null, 'std-2'], ['free', null, 'cmp-8'], ['standard', 'standard_monthly_v2', 'cmp-4'], ['compute', 'compute_monthly_v2', 'free-cf'],
        ] as const)('selectSize refuses a size the %s plan does not include (%s → %s)', async (_f, sku, size) => {
            if (sku) await subscribe(a, sku);
            await expect(caller(a).selectSize({ size })).rejects.toThrow(/size_not_allowed/);
        });

        it('checkoutStatus never reveals another user\'s session', async () => {
            stripe.sessions.set('cs_b', { id: 'cs_b', customer: b.customerId, clientReferenceId: b.userId, mode: 'subscription', status: 'complete', paymentStatus: 'paid', paymentIntentId: null, sku: 'compute_monthly_v2' });
            await expect(caller(a).checkoutStatus({ sessionId: 'cs_b' })).rejects.toThrow();
            await expect(caller(b).checkoutStatus({ sessionId: 'cs_b' })).resolves.toEqual({ status: 'complete' });
        });
    });
});

function ctxFor(owner: Tenant) {
    return {
        db: {} as never, headers: new Headers({ origin: 'https://os.example' }),
        user: { id: owner.userId, email: null, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: START.toISOString() },
    } as never;
}
