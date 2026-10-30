import { randomUUID } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import { computers } from '@/server/db/schema';
import { readBillingConfig } from '../config';
import type { BillingDeps, BillingStore } from '../ports';
import { createBillingStore } from '../store';
import { handleBillingSessionSweep } from '@/app/api/cron/billing-session-sweep/handler';
import { gateComputerStart, loadComputeBillingState, openComputeEpochAtReady } from './compute-access';
import { epochSeconds, isoSeconds } from './time';

vi.mock('../deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));
vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ advanceStaleMigrations: vi.fn() }));
vi.mock('@/server/lib/compute/provider-migrate-reconcile', () => ({ reconcilePaidCloudflareUsers: vi.fn() }));

type Database = typeof import('@/server/db').db;
const DAY = 86_400_000;
const NOW = new Date('2026-10-28T12:00:00Z');
const READY = new Date('2026-10-28T12:05:00Z');

/**
 * Round 4 (D16-D18) against the real store and schema: the issue row's stored event time drives grace,
 * and an 8-day-old unresolved issue drops the plan to Free, where the hold opens std-2 under Free limits.
 */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('round 4 standing with Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let store: BillingStore;
    let userId: string;
    let computerId: string;
    let deps: BillingDeps;

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        db = drizzle(client, { schema });
        store = createBillingStore(db);
    });
    beforeEach(async () => {
        await client`begin`;
        userId = randomUUID();
        computerId = randomUUID();
        await client`insert into auth.users (id, created_at) values (${userId}::uuid, ${new Date(NOW.getTime() - 90 * DAY).toISOString()}::timestamptz)`;
        await db.insert(computers).values([{ id: computerId, userId, slot: 1 }]);
        await store.linkCustomer(userId, `cus_${randomUUID()}`);
        deps = { config: readBillingConfig({ BILLING_TAB_ENABLED: '1', BILLING_ENFORCEMENT: '1' }), store, stripe: null, usage: null, now: () => NOW };
    });
    afterEach(async () => { await client`rollback`; });
    afterAll(async () => { await client?.end(); });

    async function pastDue(issueAgeMs: number) {
        const subscriptionId = `sub_${randomUUID()}`;
        expect(await store.upsertSubscription({ stripeSubscriptionId: subscriptionId, userId, status: 'past_due', sku: 'standard_monthly_v3',
            currentPeriodStart: new Date(NOW.getTime() - 9 * DAY), currentPeriodEnd: new Date(NOW.getTime() + 21 * DAY),
            cancelAtPeriodEnd: false, stripeEventCreated: new Date(NOW.getTime() - issueAgeMs) })).toBe('applied');
        await store.recordPaymentIssue({ stripeInvoiceId: `in_${randomUUID()}`, userId, subscriptionId, invoiceKind: 'subscription',
            issue: 'payment_failed', hostedInvoiceUrl: null, eventCreated: new Date(NOW.getTime() - issueAgeMs) });
    }

    it('an 8-day-old unresolved issue row drops to Free; the AWS computer is held at std-2 with a Free deadline', async () => {
        await pastDue(8 * DAY);
        expect(await loadComputeBillingState(deps, userId, NOW)).toMatchObject({ planSku: 'free_v3', provider: 'cloudflare',
            paymentIssue: false, planActive: true, entitledSize: 'free-cf', sessionMaxSeconds: 3600 });
        expect(await gateComputerStart({ deps, userId, computerId, kind: 'aws-ec2', instanceType: 'm6i.large', now: NOW })).toEqual({ allowed: true });
        expect(await gateComputerStart({ deps, userId, computerId, kind: 'aws-ec2', instanceType: 'm6i.xlarge', now: NOW }))
            .toEqual({ allowed: false, reason: 'files_on_aws' });
        const opened = await openComputeEpochAtReady({ deps, userId, computerId, size: 'std-2', readyAt: READY, overheadSeconds: 0 });
        expect(opened).toMatchObject({ status: 'opened', decision: { admit: true, hold: true, size: 'std-2' } });
        const [row] = await client`select size, weight, ready_at, deadline_at from ezil_billing_compute_epochs where computer_id = ${computerId}::uuid`;
        expect(row).toMatchObject({ size: 'std-2', weight: 1 });
        const deadline = epochSeconds(row!.deadline_at as Date), ready = epochSeconds(row!.ready_at as Date);
        expect(deadline).toBeGreaterThan(ready);
        expect(deadline - ready).toBeLessThanOrEqual(3600);
        expect(isoSeconds(deadline)).toBe(isoSeconds(epochSeconds(READY) + 3600));
    });

    it('a 2-day-old issue row is grace: the paid computer opens at its paid size', async () => {
        await pastDue(2 * DAY);
        expect(await loadComputeBillingState(deps, userId, NOW)).toMatchObject({ planSku: 'standard_monthly_v3', provider: 'aws',
            paymentIssue: false, planActive: true, entitledSize: 'std-2', allowanceStdSeconds: 40 * 3600 });
        expect(await gateComputerStart({ deps, userId, computerId, kind: 'aws-ec2', instanceType: 'm6i.large', now: NOW })).toEqual({ allowed: true });
    });
});

/** Round 6 (L1) against the real store's whole-second rounding and the real sweep. */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('round 6 hold sessions with Postgres', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let store: BillingStore;
    let userId: string;
    let computerId: string;
    let deps: BillingDeps;

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        db = drizzle(client, { schema });
        store = createBillingStore(db);
    });
    beforeEach(async () => {
        await client`begin`;
        // Other suites' rows never reach this sweep: everything here runs in one rolled-back transaction.
        await client`update ezil_billing_compute_epochs set ended_at = greatest(ready_at, now()), end_reason = 'provider_stop' where ended_at is null`;
        userId = randomUUID();
        computerId = randomUUID();
        await client`insert into auth.users (id, created_at) values (${userId}::uuid, ${new Date(NOW.getTime() - 90 * DAY).toISOString()}::timestamptz)`;
        await db.insert(computers).values([{ id: computerId, userId, slot: 1 }]);
        await store.linkCustomer(userId, `cus_${randomUUID()}`);
        deps = { config: readBillingConfig({ BILLING_TAB_ENABLED: '1', BILLING_ENFORCEMENT: '1' }), store, stripe: null, usage: null, now: () => NOW };
        vi.spyOn(console, 'info').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
    });
    afterEach(async () => { vi.restoreAllMocks(); await client`rollback`; });
    afterAll(async () => { await client?.end(); });

    async function subscribe(status: 'active' | 'canceled', periodStart = new Date(NOW.getTime() - 9 * DAY)) {
        const subscriptionId = `sub_${randomUUID()}`;
        expect(await store.upsertSubscription({ stripeSubscriptionId: subscriptionId, userId, status, sku: 'standard_monthly_v3',
            currentPeriodStart: periodStart, currentPeriodEnd: new Date(periodStart.getTime() + 30 * DAY),
            cancelAtPeriodEnd: false, stripeEventCreated: new Date(NOW.getTime() - DAY) })).toBe('applied');
        return subscriptionId;
    }
    const sweep = (at: Date) => {
        const stop = vi.fn(async () => ({ kind: 'aws-ec2' as const, result: { ok: true, terminated: false } }));
        return { stop, run: handleBillingSessionSweep({ deps, now: at, stop, isStillRunning: async () => false }) };
    };
    const row = async () => {
        const [r] = await client`select ready_at, deadline_at, ended_at, end_reason from ezil_billing_compute_epochs where computer_id = ${computerId}::uuid`;
        const at = (v: unknown) => v === null ? null : new Date(v as string);
        return { readyAt: at(r!.ready_at)!, deadlineAt: at(r!.deadline_at)!, endedAt: at(r!.ended_at), endReason: r!.end_reason as string | null };
    };

    it('CR-1: a hold opened at .400 stores ready + 3599 and the sweep closes it session_max at that deadline', async () => {
        await subscribe('canceled');
        const readyAt = new Date('2026-10-28T12:05:00.400Z');
        expect(await openComputeEpochAtReady({ deps, userId, computerId, size: 'std-2', readyAt, overheadSeconds: 0 }))
            .toMatchObject({ status: 'opened', decision: { admit: true, hold: true, maxRunSeconds: 3600 } });
        const opened = await row();
        // The stored values are unchanged by the fix (live 217b9546 shows the same 3599).
        expect(epochSeconds(opened.deadlineAt) - epochSeconds(opened.readyAt)).toBe(3599);
        const early = sweep(new Date('2026-10-28T13:04:59Z'));
        expect(await early.run).toMatchObject({ examined: 1, closed: 0 });
        const due = sweep(new Date('2026-10-28T13:05:00Z'));
        expect(await due.run).toMatchObject({ examined: 1, closed: 1, stopped: 1 });
        expect(due.stop).toHaveBeenCalledExactlyOnceWith({ userId, computerId }, 'session_max');
        expect(await row()).toMatchObject({ endReason: 'session_max', endedAt: new Date('2026-10-28T13:05:00Z') });
    });

    it('R1-04: a Standard session still open after an immediate cancel closes at the sweep that sees it, not ready + 1 h', async () => {
        const subscriptionId = await subscribe('active');
        await store.insertGrant({ userId, subscriptionId, meter: 'compute_std_seconds', kind: 'plan_period', amount: BigInt(40 * 3600),
            periodStart: new Date(NOW.getTime() - 9 * DAY), periodEnd: new Date(NOW.getTime() + 21 * DAY), sourceType: 'invoice', sourceId: `in_${randomUUID()}` });
        expect(await openComputeEpochAtReady({ deps, userId, computerId, size: 'std-2', readyAt: READY, overheadSeconds: 0 }))
            .toMatchObject({ status: 'opened', decision: { admit: true } });
        expect(epochSeconds((await row()).deadlineAt) - epochSeconds(READY)).toBeGreaterThan(3600);
        await subscribe('canceled'); // a second row: the account now has no paid period
        await client`update ezil_billing_subscriptions set status = 'canceled' where stripe_subscription_id = ${subscriptionId}`;
        const later = new Date(READY.getTime() + 18 * 3600_000);
        const swept = sweep(later);
        expect(await swept.run).toMatchObject({ closed: 1, stopped: 1 });
        expect(await row()).toMatchObject({ endReason: 'session_max', endedAt: later });
    });

    it('R2-3: an active Standard period 2 minutes old with no grant yet is pending, and the AWS open passes the gate', async () => {
        await subscribe('active', new Date(NOW.getTime() - 120_000));
        expect(await loadComputeBillingState(deps, userId, NOW)).toMatchObject({ planSku: 'standard_monthly_v3', provider: 'aws',
            allowanceStdSeconds: 0, grantPending: true });
        expect(await gateComputerStart({ deps, userId, computerId, kind: 'aws-ec2', instanceType: 'm6i.large', now: NOW })).toEqual({ allowed: true });
    });
});
