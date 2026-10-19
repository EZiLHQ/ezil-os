/**
 * QA FINDINGS (Postgres). Each test states a CONTRACT-v2 rule and FAILS at base
 * 14195711. They are intentionally red: a passing run here means the defect is fixed.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/utils/supabase/server', () => ({ createClient: vi.fn() }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('inject deps'); } }));

import { createBillingRouter } from '@/server/api/routers/billing';
import type { BillingDeps, BillingStore } from '../../ports';
import { ingestUsageEvents, processStripeEvent } from '../../processor';
import { closePeriodAndInvoiceOverage } from '../close-period';
import { GRANT_METER_COMPUTE, OVERAGE_TERMS_VERSION, SESSION_MAX_SECONDS } from '../contract';
import { rateWindow } from '../rating';
import {
    END, NOW, START, config, connect, fakeStripe, fakeUsage, invoicePaidEvent, seedTenant, stripeSubscription, tenant,
    type Database, type Tenant,
} from './harness';

const H = 3600 * 1000;
const AFTER_CLOSE = new Date(END.getTime() + 2 * H);

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('qa FINDINGS (Postgres)', () => {
    let conn: ReturnType<typeof connect>;
    let db: Database;
    let store: BillingStore;
    let stripe: ReturnType<typeof fakeStripe>;
    let usage: ReturnType<typeof fakeUsage>;
    let a: Tenant;

    beforeAll(() => { conn = connect(); db = conn.db as Database; store = conn.store; });
    beforeEach(async () => {
        await conn.client`begin`;
        a = tenant(); stripe = fakeStripe(); usage = fakeUsage();
        await seedTenant(conn.client, db, store, a);
    });
    afterEach(async () => { await conn.client`rollback`; });
    afterAll(async () => { await conn.client?.end(); });

    async function subscribe(owner: Tenant, sku: 'standard_monthly_v2' | 'compute_monthly_v2', cancelAtPeriodEnd = false) {
        stripe.subscriptions.set(owner.subscriptionId, { ...stripeSubscription(owner, sku), cancelAtPeriodEnd });
        await store.upsertSubscription({
            stripeSubscriptionId: owner.subscriptionId, userId: owner.userId, status: 'active', sku,
            currentPeriodStart: START, currentPeriodEnd: END, cancelAtPeriodEnd, stripeEventCreated: START,
        });
        await store.insertGrant({
            userId: owner.userId, subscriptionId: owner.subscriptionId, meter: GRANT_METER_COMPUTE, kind: 'plan_period',
            amount: BigInt(sku === 'compute_monthly_v2' ? 1_800_000 : 216_000), periodStart: START, periodEnd: END,
            sourceType: 'invoice', sourceId: `in_seed_${owner.subscriptionId}`,
        });
    }
    async function burn(owner: Tenant, from: Date, n: number, size: 'std-2' | 'cmp-8' = 'cmp-8') {
        for (let i = 0; i < n; i++) {
            const ready = new Date(from.getTime() + i * 6 * H);
            await store.openEpoch({ userId: owner.userId, computerId: owner.computerId, subscriptionId: owner.subscriptionId, size, readyAt: ready });
            await store.closeEpoch({ computerId: owner.computerId, endedAt: new Date(ready.getTime() + 6 * H), reason: 'session_max' });
        }
    }
    const consent = (owner: Tenant, at: Date, enabled = true, capCents = 2_500, termsVersion: string = OVERAGE_TERMS_VERSION, actor = owner.userId) => store.recordConsent({
        userId: owner.userId, subscriptionId: owner.subscriptionId, enabled, capCents, termsVersion,
        catalogVersion: 2, rateCentsPerStdHour: 25, actor, acceptedAt: at,
    });
    const caller = (owner: Tenant, now = NOW) => createBillingRouter((): BillingDeps => ({ config, store, stripe: stripe.api, usage: usage.port, now: () => now }))
        .createCaller({ db: {} as never, headers: new Headers(), user: { id: owner.userId, email: null, aud: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: START.toISOString() } } as never);

    it('F-STALE-TERMS: a consent to a superseded terms version never bills overage', async () => {
        await subscribe(a, 'compute_monthly_v2');
        await consent(a, START, true, 2_500, 'overage-v1-2026-01-01');
        await burn(a, new Date('2026-10-02T00:00:00Z'), 25);
        const result = await closePeriodAndInvoiceOverage({ store, usage: usage.port }, { userId: a.userId, now: AFTER_CLOSE });
        expect(usage.requests).toEqual([]);
        expect(result).toMatchObject({ status: 'skipped' });
    });

    it('F-STALE-TERMS: the summary does not present a superseded consent as enabled overage', async () => {
        await subscribe(a, 'compute_monthly_v2');
        await consent(a, START, true, 2_500, 'overage-v1-2026-01-01');
        const s = await caller(a).summary();
        expect(s.enabled && s.overage?.enabled).toBe(false);
        expect(s.enabled && s.estimate.worstCaseOverageCents).toBe(0);
    });

    it('F-OPT-OUT: a Compute subscriber who set cancel-at-period-end can still turn overage OFF', async () => {
        await subscribe(a, 'compute_monthly_v2', true);
        await consent(a, START, true, 2_500);
        const s = await caller(a).summary();
        expect(s.enabled && s.actions.overage).toBe(true); // the UI offers the toggle
        await expect(caller(a).setOverage({ enabled: false, capCents: 2_500, termsVersion: OVERAGE_TERMS_VERSION })).resolves.toMatchObject({ enabled: false });
    });

    it('F-LATE-FAILURE: an overage payment failure delivered after a later cap change still stops billing from the failure on', async () => {
        await subscribe(a, 'compute_monthly_v2');
        // Previous period's overage invoice, already issued.
        const prevStart = new Date('2026-09-01T00:00:00Z');
        await store.upsertOverageInvoice({ userId: a.userId, subscriptionId: a.subscriptionId, periodStart: prevStart, periodEnd: START,
            ratingVersion: 1, stdSecondsOver: BigInt(144_000), cents: 1_000 });
        const [row] = await store.overageInvoicesFor(a.userId);
        await store.attachOverageStripeInvoice(row.id, 'in_prev_overage');
        await consent(a, new Date('2026-09-15T00:00:00Z'), true, 2_500);
        // The invoice fails on Oct 2 (event created then), but the webhook is delayed until Oct 4.
        const failedAt = new Date('2026-10-02T00:00:00Z');
        // Oct 3: the customer, unaware, raises the cap; the router allows it (no issue recorded yet).
        await caller(a, new Date('2026-10-03T00:00:00Z')).setOverage({ enabled: true, capCents: 10_000, termsVersion: OVERAGE_TERMS_VERSION });
        stripe.invoices.set('in_prev_overage', { id: 'in_prev_overage', customer: a.customerId, status: 'open', subscriptionId: null,
            billingReason: 'manual', metadataKind: 'overage', hostedInvoiceUrl: null, lines: [], periodStart: null, periodEnd: null });
        await processStripeEvent(invoicePaidEvent(stripe.invoices.get('in_prev_overage')!, failedAt, 'invoice.payment_failed'),
            { store, stripe: stripe.api, now: () => new Date('2026-10-04T00:00:00Z') });
        // Summary now says overage is off / paused for payment.
        const s = await caller(a, new Date('2026-10-04T00:00:00Z')).summary();
        expect(s.enabled && [s.overage?.enabled, s.overage?.pausedReason]).toEqual([false, 'payment_failed']);
        // Heavy usage after the failure, with the issue still unpaid at close.
        await burn(a, new Date('2026-10-05T00:00:00Z'), 30);
        await closePeriodAndInvoiceOverage({ store, usage: usage.port }, { userId: a.userId, now: AFTER_CLOSE });
        expect(usage.requests).toEqual([]);
    });

    it('F-EPOCH-REPLAY: a late (replayed) ready for an epoch that is already closed does not reopen it or double-count', async () => {
        const ready = new Date('2026-10-02T00:00:00Z');
        await store.openEpoch({ userId: a.userId, computerId: a.computerId, subscriptionId: null, size: 'std-2', readyAt: ready });
        await store.closeEpoch({ computerId: a.computerId, endedAt: new Date(ready.getTime() + H), reason: 'user_stop' });
        await store.openEpoch({ userId: a.userId, computerId: a.computerId, subscriptionId: null, size: 'std-2', readyAt: ready });
        const epochs = await store.epochsFor(a.userId, START);
        expect(epochs.filter(e => e.endedAt === null)).toEqual([]);
        expect(rateWindow({ epochs, window: { start: START.toISOString(), end: END.toISOString() }, now: '2026-10-03T00:00:00Z' }).stdSeconds).toBe(3_600);
    });

    it('F-CONCURRENCY: two computers of one subscription cannot both be running (maxConcurrentComputers = 1, server side)', async () => {
        await subscribe(a, 'compute_monthly_v2');
        const ready = new Date('2026-10-02T00:00:00Z');
        const results = await Promise.allSettled([a.computerId, a.computerId2].map(computerId => store.openEpoch({
            userId: a.userId, computerId, subscriptionId: a.subscriptionId, size: 'cmp-8', readyAt: ready,
        })));
        const open = (await store.epochsFor(a.userId, START)).filter(e => e.endedAt === null);
        expect(open.length).toBeLessThanOrEqual(1);
        expect(results.filter(r => r.status === 'fulfilled' && r.value.status === 'opened').length).toBeLessThanOrEqual(1);
    });

    it('F-NOT-WIRED: usage the Worker reports through /api/billing/usage reaches the v2 meter shown in Billing', async () => {
        const startAt = new Date('2026-10-10T00:00:00Z');
        await ingestUsageEvents([
            { type: 'start', computerId: a.computerId, at: startAt.toISOString() },
            { type: 'stop', computerId: a.computerId, at: new Date(startAt.getTime() + H).toISOString() },
        ], { store });
        const s = await caller(a).summary();
        expect(s.enabled && s.compute.usedStdSeconds).toBe(3_600);
    });

    it('F-DEADLINE: the running session\'s activeDeadline honours the remaining allowance, not just 6 h', async () => {
        await subscribe(a, 'standard_monthly_v2');
        // 59.5 h used; a session started with 1,800 std-s of headroom can run 30 min, not 6 h.
        await burn(a, new Date('2026-10-02T00:00:00Z'), 9, 'std-2'); // 54 h
        await store.openEpoch({ userId: a.userId, computerId: a.computerId, subscriptionId: a.subscriptionId, size: 'std-2', readyAt: new Date('2026-10-05T00:00:00Z') });
        await store.closeEpoch({ computerId: a.computerId, endedAt: new Date('2026-10-05T05:30:00Z'), reason: 'user_stop' }); // 59.5 h
        const ready = new Date('2026-10-18T11:59:00Z');
        await store.openEpoch({ userId: a.userId, computerId: a.computerId, subscriptionId: a.subscriptionId, size: 'std-2', readyAt: ready });
        const s = await caller(a).summary();
        const deadline = s.enabled ? s.compute.session.activeDeadline : null;
        expect(deadline).not.toBeNull();
        expect(Date.parse(deadline!) - ready.getTime()).toBeLessThanOrEqual(1_800 * 1000);
        expect(Date.parse(deadline!) - ready.getTime()).toBeLessThan(SESSION_MAX_SECONDS * 1000);
    });
});
