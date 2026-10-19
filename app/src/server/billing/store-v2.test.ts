import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import { billingComputeEpochs, billingOverageConsents, billingPaymentIssues, billingPlanChanges, computers } from '@/server/db/schema';
import type { BillingStore, GrantInsert, OverageConsentInsert, OverageInvoiceInsert, PaymentIssueInsert, PlanChangeInsert } from './ports';
import { createBillingStore } from './store';
import { CATALOG_V2_VERSION, GRANT_METER_COMPUTE, OVERAGE_CENTS_PER_STD_HOUR, OVERAGE_DEFAULT_CAP_CENTS, OVERAGE_TERMS_VERSION } from './v2/contract';

type Database = typeof import('@/server/db').db;
const instant = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);

it('bounds openEpoch retries when each conflicting epoch closes before the read', async () => {
    const where = vi.fn().mockResolvedValueOnce([{ id: 'computer_local' }]).mockResolvedValue([]);
    // The fourth call stops the old unbounded loop, making this regression fail
    // deterministically instead of hanging the test process.
    const returning = vi.fn().mockRejectedValue(new Error('Unexpected fourth epoch insert'))
        .mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const db = {
        select: () => ({ from: () => ({ where }) }),
        insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) }),
    } as unknown as Database;
    await expect(createBillingStore(db).openEpoch({ userId: 'user_local', computerId: 'computer_local',
        subscriptionId: 'sub_local', size: 'cmp-4', readyAt: instant(0) }))
        .rejects.toThrow('Could not open compute epoch after 3 attempts');
    expect(returning).toHaveBeenCalledTimes(3);
});

/** A disposable, migrated Postgres; one connection and a rollback per test. */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('createBillingStore v2', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let store: BillingStore;
    let userId: string;
    let otherUserId: string;
    let computerId: string;
    let secondComputerId: string;
    let otherComputerId: string;
    let subscriptionId: string;

    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        db = drizzle(client, { schema });
        store = createBillingStore(db);
    });

    beforeEach(async () => {
        await client`begin`;
        userId = randomUUID();
        otherUserId = randomUUID();
        computerId = randomUUID();
        secondComputerId = randomUUID();
        otherComputerId = randomUUID();
        subscriptionId = `sub_${randomUUID()}`;
        // created_at stays outside our auth.users schema declaration.
        await client`insert into auth.users (id, created_at) values
            (${userId}::uuid, ${instant(-100).toISOString()}::timestamptz),
            (${otherUserId}::uuid, ${instant(-200).toISOString()}::timestamptz)`;
        await db.insert(computers).values([
            { id: computerId, userId, slot: 1 },
            { id: secondComputerId, userId, slot: 2 },
            { id: otherComputerId, userId: otherUserId, slot: 1 },
        ]);
    });

    afterEach(async () => { await client`rollback`; });
    afterAll(async () => { await client?.end(); });

    // Postgres aborts a transaction after an error; savepoints keep both the
    // following assertions and the outer test rollback meaningful.
    async function rejectsSql(query: () => PromiseLike<unknown>, code = '23514') {
        await client`savepoint rejected_write`;
        try {
            await expect(query()).rejects.toMatchObject({ code });
        } finally {
            await client`rollback to savepoint rejected_write`;
            await client`release savepoint rejected_write`;
        }
    }

    const epoch = (readyAt = instant(0)) => ({ userId, computerId, subscriptionId, size: 'cmp-4' as const, readyAt });
    const consent = (overrides: Partial<OverageConsentInsert> = {}): OverageConsentInsert => ({
        userId, subscriptionId, enabled: true, capCents: OVERAGE_DEFAULT_CAP_CENTS,
        termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: CATALOG_V2_VERSION,
        rateCentsPerStdHour: OVERAGE_CENTS_PER_STD_HOUR, actor: 'user', acceptedAt: instant(10), ...overrides,
    });
    const grant = (overrides: Partial<GrantInsert> = {}): GrantInsert => ({
        userId, subscriptionId, meter: GRANT_METER_COMPUTE, kind: 'plan_period', amount: BigInt(216000),
        periodStart: instant(0), periodEnd: instant(100), sourceType: 'invoice', sourceId: randomUUID(), ...overrides,
    });
    const overage = (overrides: Partial<OverageInvoiceInsert> = {}): OverageInvoiceInsert => ({
        userId, subscriptionId, periodStart: instant(0), periodEnd: instant(100),
        ratingVersion: 1, stdSecondsOver: BigInt('9007199254740993'), cents: 2500, ...overrides,
    });
    const change = (overrides: Partial<PlanChangeInsert> = {}): PlanChangeInsert => ({
        userId, subscriptionId, kind: 'upgrade', fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2',
        stripeInvoiceId: null, stripeScheduleId: null, hostedInvoiceUrl: null, state: 'pending',
        effectiveAt: null, expiresAt: instant(100), ...overrides,
    });
    const issue = (overrides: Partial<PaymentIssueInsert> = {}): PaymentIssueInsert => ({
        stripeInvoiceId: `in_${randomUUID()}`, userId, subscriptionId, invoiceKind: 'overage',
        issue: 'payment_failed', hostedInvoiceUrl: 'https://invoice.example/test', eventCreated: instant(10), ...overrides,
    });

    it('selects consent strictly before the boundary, by acceptance time then audit identity', async () => {
        expect(await store.consentAsOf(userId, subscriptionId, instant(100))).toBeNull();
        await store.recordConsent(consent({ acceptedAt: instant(10) }));
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(20) }));
        const latest = await store.recordConsent(consent({ capCents: 5000, acceptedAt: instant(20) }));
        // Late delivery of an older decision does not change historical consent.
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(15) }));
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(100) }));
        await store.recordConsent(consent({ capCents: 100, acceptedAt: instant(101) }));
        expect(await store.consentAsOf(userId, subscriptionId, instant(100))).toEqual(latest);
        expect(await store.consentAsOf(otherUserId, subscriptionId, instant(100))).toBeNull();
        expect(await store.consentAsOf(userId, 'foreign_subscription', instant(100))).toBeNull();
        expect(await store.consentAsOf(userId, subscriptionId, instant(10))).toBeNull();
    });

    it('returns the start decision and all interior decisions in time/identity order, scoped to the tenant and subscription', async () => {
        await store.recordConsent(consent({ acceptedAt: instant(0) }));
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(10) }));
        const initial = await store.recordConsent(consent({ capCents: 5000, acceptedAt: instant(10) }));
        // An older decision delivered later must not replace the initial decision.
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(5) }));
        const paused = await store.recordConsent(consent({ enabled: false, acceptedAt: instant(20) }));
        const enabled = await store.recordConsent(consent({ acceptedAt: instant(20) }));
        const earlier = await store.recordConsent(consent({ capCents: 1000, acceptedAt: instant(15) }));
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(100) }));
        await store.recordConsent(consent({ capCents: 100, acceptedAt: instant(101) }));
        for (const acceptedAt of [instant(10), instant(30)]) {
            await store.recordConsent(consent({ userId: otherUserId, acceptedAt }));
            await store.recordConsent(consent({ subscriptionId: 'another_subscription', acceptedAt }));
        }
        expect(await store.consentDecisionsForPeriod(userId, subscriptionId, instant(10), instant(100)))
            .toEqual([initial, earlier, paused, enabled]);
        expect(await store.consentDecisionsForPeriod(otherUserId, 'another_subscription', instant(10), instant(100))).toEqual([]);
    });

    it('carries only the latest decision before start into a period without a decision at start', async () => {
        await store.recordConsent(consent({ acceptedAt: instant(-20) }));
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(-10) }));
        const initial = await store.recordConsent(consent({ capCents: 1000, acceptedAt: instant(-10) }));
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(-15) }));
        const paused = await store.recordConsent(consent({ enabled: false, actor: 'system:overage_payment_issue', acceptedAt: instant(50) }));
        expect(await store.consentDecisionsForPeriod(userId, subscriptionId, instant(0), instant(100))).toEqual([initial, paused]);
    });

    it('returns interior decisions without initial consent and excludes decisions at or after the end', async () => {
        expect(await store.consentDecisionsForPeriod(userId, subscriptionId, instant(0), instant(100))).toEqual([]);
        const enabled = await store.recordConsent(consent({ acceptedAt: instant(20) }));
        await store.recordConsent(consent({ enabled: false, acceptedAt: instant(100) }));
        await store.recordConsent(consent({ acceptedAt: instant(101) }));
        expect(await store.consentDecisionsForPeriod(userId, subscriptionId, instant(0), instant(100))).toEqual([enabled]);
        expect(await store.consentDecisionsForPeriod(userId, subscriptionId, instant(0), instant(20))).toEqual([]);
    });

    it.each(['paid', 'payment_failed', 'requires_action', 'void', 'uncollectible'] as const)
        ('opens only pending overage invoices and preserves webhook %s', async status => {
            const { row } = await store.upsertOverageInvoice(overage());
            const invoiceId = `in_${randomUUID()}`;
            await store.attachOverageStripeInvoice(row.id, invoiceId);
            await store.markOverageInvoiceOpen(invoiceId);
            expect((await store.overageInvoiceByStripeId(invoiceId))?.status).toBe('open');
            await store.setOverageInvoiceStatus(invoiceId, status);
            await store.markOverageInvoiceOpen(invoiceId);
            expect((await store.overageInvoiceByStripeId(invoiceId))?.status).toBe(status);
            await store.markOverageInvoiceOpen('in_missing');
            expect(await store.overageInvoiceByStripeId('in_missing')).toBeNull();
        });

    it('updates optional plan-change details only when provided and only on open owned rows', async () => {
        await store.recordPlanChange(change());
        const update = { userId, subscriptionId, kind: 'upgrade' as const };
        await store.setPlanChangeState({ ...update, state: 'requires_action', stripeInvoiceId: 'in_upgrade',
            hostedInvoiceUrl: 'https://invoice.example/action', expiresAt: instant(90) });
        expect((await store.openPlanChanges(userId))[0]).toMatchObject({ state: 'requires_action', stripeInvoiceId: 'in_upgrade',
            hostedInvoiceUrl: 'https://invoice.example/action', expiresAt: instant(90) });
        await store.setPlanChangeState({ ...update, state: 'payment_failed' });
        expect((await store.openPlanChanges(userId))[0]).toMatchObject({ hostedInvoiceUrl: 'https://invoice.example/action', expiresAt: instant(90) });
        await store.setPlanChangeState({ ...update, userId: otherUserId, state: 'canceled', hostedInvoiceUrl: null, expiresAt: null });
        expect((await store.openPlanChanges(userId))[0].state).toBe('payment_failed');
        await store.setPlanChangeState({ ...update, state: 'applied', effectiveAt: instant(30), hostedInvoiceUrl: null, expiresAt: null });
        const [closed] = await db.select().from(billingPlanChanges).where(eq(billingPlanChanges.userId, userId));
        expect(closed).toMatchObject({ state: 'applied', effectiveAt: instant(30), hostedInvoiceUrl: null, expiresAt: null });
        await store.setPlanChangeState({ ...update, state: 'requires_action', hostedInvoiceUrl: 'https://invoice.example/stale', expiresAt: instant(200) });
        expect(await db.select().from(billingPlanChanges).where(eq(billingPlanChanges.userId, userId))).toEqual([closed]);
    });

    it('reads the latest usage interval for just that computer, including closed intervals', async () => {
        expect(await store.latestIntervalFor(computerId)).toBeNull();
        await store.openInterval(userId, computerId, instant(0), 'start');
        expect(await store.latestIntervalFor(computerId)).toEqual({ endedAt: null });
        await store.closeInterval(computerId, instant(10), 'stop');
        expect(await store.latestIntervalFor(computerId)).toEqual({ endedAt: instant(10) });
        await store.openInterval(userId, secondComputerId, instant(30), 'start');
        expect(await store.latestIntervalFor(computerId)).toEqual({ endedAt: instant(10) });
        await store.openInterval(userId, computerId, instant(20), 'start');
        expect(await store.latestIntervalFor(computerId)).toEqual({ endedAt: null });
        await store.closeInterval(computerId, instant(40), 'stop');
        expect(await store.latestIntervalFor(computerId)).toEqual({ endedAt: instant(40) });
    });

    it('opens once, rounds ready up/end down, closes once and starts a new epoch after close', async () => {
        const opened = await store.openEpoch(epoch(instant(0.001)));
        expect(opened).toMatchObject({ status: 'opened', epoch: {
            userId, computerId, size: 'cmp-4', weight: 2, readyAt: '2026-01-01T00:00:01Z',
            endedAt: null, endReason: null, overheadSeconds: 0,
        } });
        const retry = await store.openEpoch({ ...epoch(instant(20)), size: 'cmp-8' });
        expect(retry).toEqual({ status: 'exists', epoch: opened.epoch });
        expect(await db.select().from(billingComputeEpochs).where(eq(billingComputeEpochs.computerId, computerId)))
            .toEqual([expect.objectContaining({ subscriptionId, readyAt: instant(1), weight: 2 })]);
        expect(await store.closeEpoch({ computerId, endedAt: instant(10.999), reason: 'resize', overheadSeconds: 3 })).toBe('closed');
        expect(await store.closeEpoch({ computerId, endedAt: instant(50), reason: 'user_stop', overheadSeconds: 99 })).toBe('not_open');
        const [closed] = await store.epochsFor(userId, instant(0));
        expect(closed).toMatchObject({ endedAt: '2026-01-01T00:00:10Z', endReason: 'resize', overheadSeconds: 3 });
        const restarted = await store.openEpoch({ ...epoch(instant(11)), size: 'cmp-8' });
        expect(restarted.status).toBe('opened');
        expect(restarted.epoch.id).not.toBe(opened.epoch.id);
        expect(restarted.epoch.weight).toBe(4);
        expect(await store.epochsFor(userId, instant(0))).toHaveLength(2);
    });

    it.each([
        ['date rounds down', instant(100.999), '2026-01-01T00:01:40Z'],
        ['string rounds down', instant(100.999).toISOString(), '2026-01-01T00:01:40Z'],
        ['clamps before readiness', instant(-100), '2026-01-01T00:00:01Z'],
        ['clamps at six hours', instant(50000), '2026-01-01T06:00:01Z'],
        ['legacy null', null, null],
        ['legacy omitted', undefined, null],
    ] as const)('stores deadline: %s', async (_name, deadlineAt, expected) => {
        expect(await store.openEpochFor(computerId)).toBeNull();
        const opened = await store.openEpoch({ ...epoch(instant(0.001)), deadlineAt, overheadSeconds: 12 });
        expect(opened.epoch).toMatchObject({ readyAt: '2026-01-01T00:00:01Z', deadlineAt: expected, lastHeartbeatAt: null, overheadSeconds: 12 });
        expect(await store.openEpochFor(computerId)).toEqual(opened.epoch);
        expect(await store.epochsFor(userId, instant(0))).toEqual([opened.epoch]);
        // Retrying readiness must not extend the stored deadline or change overhead.
        expect(await store.openEpoch({ ...epoch(instant(20)), deadlineAt: instant(300), overheadSeconds: 99 }))
            .toEqual({ status: 'exists', epoch: opened.epoch });
    });

    it.each([-1, 21601])('raw SQL cannot store an out-of-bounds deadline (%s seconds)', async seconds => {
        await rejectsSql(() => client`insert into ezil_billing_compute_epochs
            (user_id, computer_id, size, weight, ready_at, deadline_at)
            values (${userId}::uuid, ${computerId}::uuid, 'std-2', 1,
                ${instant(0).toISOString()}::timestamptz, ${instant(seconds).toISOString()}::timestamptz)`);
    });

    it('raw SQL rejects a heartbeat before readiness', async () => {
        await rejectsSql(() => client`insert into ezil_billing_compute_epochs
            (user_id, computer_id, size, weight, ready_at, last_heartbeat_at)
            values (${userId}::uuid, ${computerId}::uuid, 'std-2', 1,
                ${instant(0).toISOString()}::timestamptz, ${instant(-1).toISOString()}::timestamptz)`);
    });

    it('touches only the open epoch, only forwards, and never before readiness', async () => {
        expect(await store.touchEpoch(computerId, instant(0))).toBe('not_open');
        await store.openEpoch(epoch());
        expect(await store.touchEpoch(computerId, instant(-1))).toBe('touched');
        expect((await store.openEpochFor(computerId))?.lastHeartbeatAt).toBe('2026-01-01T00:00:00Z');
        expect(await store.touchEpoch(computerId, instant(10))).toBe('touched');
        expect(await store.touchEpoch(computerId, instant(5))).toBe('touched');
        expect((await store.openEpochFor(computerId))?.lastHeartbeatAt).toBe('2026-01-01T00:00:10Z');
        await store.closeEpoch({ computerId, endedAt: instant(20), reason: 'user_stop' });
        expect(await store.openEpochFor(computerId)).toBeNull();
        expect(await store.touchEpoch(computerId, instant(30))).toBe('not_open');
        const closed = (await store.epochsFor(userId, instant(-1)))[0];
        expect(closed?.lastHeartbeatAt).toBe('2026-01-01T00:00:10Z');
        await store.openEpoch(epoch(instant(40)));
        expect(await store.touchEpoch(computerId, instant(50))).toBe('touched');
        expect(await store.epochsFor(userId, instant(-1))).toEqual([
            closed, expect.objectContaining({ lastHeartbeatAt: '2026-01-01T00:00:50Z', endedAt: null }),
        ]);
    });

    it('sweeps all open epochs by effective deadline, including legacy rows, across users with a limit', async () => {
        const closed = await store.openEpoch({ ...epoch(), deadlineAt: instant(1) });
        await store.closeEpoch({ computerId, endedAt: instant(1), reason: 'user_stop' });
        const latest = await store.openEpoch({ ...epoch(), deadlineAt: instant(100) });
        const legacy = await store.openEpoch({ ...epoch(instant(-21550)), computerId: secondComputerId });
        const earliest = await store.openEpoch({ ...epoch(), userId: otherUserId, computerId: otherComputerId, deadlineAt: instant(10) });
        expect(await store.openEpochsForSweep({ limit: 200 })).toEqual([earliest.epoch, legacy.epoch, latest.epoch]);
        expect(await store.openEpochsForSweep({ limit: 2 })).toEqual([earliest.epoch, legacy.epoch]);
        expect(await store.openEpochsForSweep({ limit: 0 })).toEqual([]);
        expect((await store.openEpochsForSweep({ limit: 200 })).map(epoch => epoch.id)).not.toContain(closed.epoch.id);
    });

    it('caps the sweep batch at 200 even when the caller requests more', async () => {
        const owners = await client<{ id: string }[]>`insert into auth.users (id)
            select gen_random_uuid() from generate_series(1, 201) returning id`;
        const rows = owners.map(owner => ({ id: randomUUID(), userId: owner.id, slot: 1 }));
        await db.insert(computers).values(rows);
        await db.insert(billingComputeEpochs).values(rows.map((row, index) => ({
            userId: row.userId, computerId: row.id, size: 'std-2' as const, weight: 1 as const, readyAt: instant(index),
        })));
        const swept = await store.openEpochsForSweep({ limit: 999 });
        expect(swept).toHaveLength(200);
        expect(swept.map(epoch => epoch.computerId)).toEqual(rows.slice(0, 200).map(row => row.id));
    });

    it('finds only recent policy closes, across owners, excluding computers with any open epoch', async () => {
        await store.openEpoch(epoch());
        await store.closeEpoch({ computerId, endedAt: instant(10), reason: 'session_max' });
        await store.openEpoch({ ...epoch(), computerId: secondComputerId });
        await store.closeEpoch({ computerId: secondComputerId, endedAt: instant(20), reason: 'allowance_exhausted' });
        await store.openEpoch({ ...epoch(), computerId: otherComputerId, userId: otherUserId });
        await store.closeEpoch({ computerId: otherComputerId, endedAt: instant(30), reason: 'overage_cap' });

        expect((await store.policyClosedEpochsSince(instant(10), 50)).map(row => row.endReason))
            .toEqual(['overage_cap', 'allowance_exhausted', 'session_max']);
        expect((await store.policyClosedEpochsSince(instant(20), 50)).map(row => row.computerId))
            .toEqual([otherComputerId, secondComputerId]);
        expect(await store.policyClosedEpochsSince(instant(31), 50)).toEqual([]);
        expect(await store.policyClosedEpochsSince(instant(0), 0)).toEqual([]);
        expect((await store.policyClosedEpochsSince(instant(0), 1)).map(row => row.computerId)).toEqual([otherComputerId]);

        // A new session, even for the same owner, must not be stopped by an old close.
        await store.openEpoch({ ...epoch(instant(40)), computerId: secondComputerId });
        expect((await store.policyClosedEpochsSince(instant(0), 50)).map(row => row.computerId))
            .toEqual([otherComputerId, computerId]);
        await store.closeEpoch({ computerId: secondComputerId, endedAt: instant(50), reason: 'user_stop' });
        await store.openEpoch({ ...epoch(instant(60)), computerId: secondComputerId });
        await store.closeEpoch({ computerId: secondComputerId, endedAt: instant(70), reason: 'idle_sleep' });
        expect((await store.policyClosedEpochsSince(instant(21), 50)).map(row => row.endReason)).toEqual(['overage_cap']);
    });

    it('caps recent policy closes at 200 rows', async () => {
        const owners = await client<{ id: string }[]>`insert into auth.users (id)
            select gen_random_uuid() from generate_series(1, 201) returning id`;
        const rows = owners.map(owner => ({ id: randomUUID(), userId: owner.id, slot: 1 }));
        await db.insert(computers).values(rows);
        await db.insert(billingComputeEpochs).values(rows.map((row, index) => ({
            userId: row.userId, computerId: row.id, size: 'std-2' as const, weight: 1 as const,
            readyAt: instant(0), endedAt: instant(index + 1), endReason: 'session_max' as const,
        })));
        const recent = await store.policyClosedEpochsSince(instant(0), 999);
        expect(recent).toHaveLength(200);
        expect(recent.map(row => row.computerId)).toEqual(rows.slice(1).reverse().map(row => row.id));
    });

    it('clamps a subsecond or skewed stop at readiness and handles missing computers', async () => {
        await store.openEpoch({ ...epoch(instant(1.1)), size: 'free-cf', subscriptionId: null });
        expect(await store.closeEpoch({ computerId, endedAt: instant(1.9), reason: 'platform_failure' })).toBe('closed');
        const [row] = await db.select().from(billingComputeEpochs).where(eq(billingComputeEpochs.computerId, computerId));
        expect(row).toMatchObject({ readyAt: instant(2), endedAt: instant(2), weight: 1, subscriptionId: null });
        expect(await store.closeEpoch({ computerId: secondComputerId, endedAt: instant(1), reason: 'user_stop' })).toBe('not_open');
        await expect(store.openEpoch({ ...epoch(), computerId: randomUUID() })).rejects.toThrow('does not belong');
    });

    it.each([
        ['bad size', 'unknown', 1, null, null, 0],
        ['weight mismatch', 'cmp-4', 1, null, null, 0],
        ['end reason without end', 'std-2', 1, null, 'user_stop', 0],
        ['end without reason', 'std-2', 1, instant(10), null, 0],
        ['unknown reason', 'std-2', 1, instant(10), 'unknown', 0],
        ['end before ready', 'std-2', 1, instant(-1), 'user_stop', 0],
        ['negative overhead', 'std-2', 1, null, null, -1],
    ] as const)('rejects an epoch with %s', async (_label, size, weight, endedAt, reason, overhead) => {
        await rejectsSql(() => client`insert into ezil_billing_compute_epochs
            (user_id, computer_id, size, weight, ready_at, ended_at, end_reason, overhead_seconds)
            values (${userId}::uuid, ${computerId}::uuid, ${size}, ${weight}, ${instant(0).toISOString()}::timestamptz,
                ${endedAt?.toISOString() ?? null}::timestamptz, ${reason}, ${overhead})`);
        expect(await store.epochsFor(userId, instant(-10))).toEqual([]);
    });

    it('reads epochs overlapping the half-open window, including old open epochs', async () => {
        await store.openEpoch(epoch());
        await store.closeEpoch({ computerId, endedAt: instant(10), reason: 'user_stop' });
        const crossing = await store.openEpoch(epoch(instant(10)));
        await store.closeEpoch({ computerId, endedAt: instant(20), reason: 'user_stop' });
        const future = await store.openEpoch(epoch(instant(30)));
        const oldOpen = await store.openEpoch({ ...epoch(instant(-100)), computerId: secondComputerId });
        expect((await store.epochsFor(userId, instant(10))).map(row => row.id).sort())
            .toEqual([crossing.epoch.id, future.epoch.id, oldOpen.epoch.id].sort());
        expect((await store.epochsFor(userId, instant(20))).map(row => row.id).sort())
            .toEqual([future.epoch.id, oldOpen.epoch.id].sort());
    });

    it('isolates every user-scoped read and prevents use of another tenant’s computer', async () => {
        const opened = await store.openEpoch(epoch());
        await store.insertGrant(grant());
        await store.recordConsent(consent());
        await store.recordPlanChange(change());
        const paymentIssue = issue();
        await store.recordPaymentIssue(paymentIssue);
        await store.setSizePreference(userId, 'cmp-8');
        const invoice = await store.upsertOverageInvoice(overage());
        expect(await store.epochsFor(otherUserId, instant(-10))).toEqual([]);
        expect(await store.grantsForPeriod(otherUserId, { start: instant(0), end: instant(100) }, [GRANT_METER_COMPUTE])).toEqual([]);
        expect(await store.latestConsent(otherUserId, subscriptionId)).toBeNull();
        expect(await store.openPlanChanges(otherUserId)).toEqual([]);
        expect(await store.openPaymentIssues(otherUserId)).toEqual([]);
        expect(await store.sizePreference(otherUserId)).toBeNull();
        expect(await store.overageInvoicesFor(otherUserId)).toEqual([]);
        expect(await store.closeEpoch({ computerId: otherComputerId, endedAt: instant(100), reason: 'user_stop' })).toBe('not_open');
        await expect(store.openEpoch({ ...epoch(), userId: otherUserId })).rejects.toThrow('does not belong');
        await expect(store.openEpoch({ ...epoch(), computerId: otherComputerId })).rejects.toThrow('does not belong');
        expect(await store.epochsFor(userId, instant(-10))).toEqual([opened.epoch]);
        await expect(store.upsertOverageInvoice(overage({ userId: otherUserId }))).rejects.toThrow('ownership conflict');
        expect(await store.overageInvoicesFor(userId)).toEqual([invoice.row]);
        await store.recordPaymentIssue({ ...paymentIssue, userId: otherUserId, issue: 'voided', eventCreated: instant(100) });
        expect(await store.openPaymentIssues(userId)).toEqual([expect.objectContaining({ issue: 'payment_failed', stripeEventCreated: instant(10) })]);
        expect(await store.openPaymentIssues(otherUserId)).toEqual([]);
    });

    it('orders consent by identity despite equal or backwards acceptance times', async () => {
        expect(await store.latestConsent(userId, subscriptionId)).toBeNull();
        const first = await store.recordConsent(consent());
        const second = await store.recordConsent(consent({ enabled: false }));
        const third = await store.recordConsent(consent({ capCents: 0, acceptedAt: instant(1) }));
        expect(typeof first.id).toBe('bigint');
        expect(second.id > first.id && third.id > second.id).toBe(true);
        expect(await store.latestConsent(userId, subscriptionId)).toEqual(third);
        expect(await store.latestConsent(userId, 'another_subscription')).toBeNull();
        expect(await db.select().from(billingOverageConsents).where(eq(billingOverageConsents.userId, userId))).toHaveLength(3);
    });

    it('reuses consent audit identities on exact replay without undoing newer decisions', async () => {
        const input = consent();
        const accepted = await store.recordConsent(input);
        expect(await store.recordConsent(input)).toEqual(accepted);
        const disabled = await store.recordConsent(consent({ enabled: false, acceptedAt: instant(20) }));
        expect(await store.recordConsent(input)).toEqual(accepted);
        expect(await store.latestConsent(userId, subscriptionId)).toEqual(disabled);
        expect(await db.select().from(billingOverageConsents).where(eq(billingOverageConsents.userId, userId))).toHaveLength(2);
    });

    it('refuses consent UPDATE, DELETE and TRUNCATE even on the database-owner connection', async () => {
        const row = await store.recordConsent(consent());
        await rejectsSql(() => client`update ezil_billing_overage_consents set enabled = false where user_id = ${userId}::uuid`, 'P0001');
        await rejectsSql(() => client`delete from ezil_billing_overage_consents where user_id = ${userId}::uuid`, 'P0001');
        await rejectsSql(() => client`truncate ezil_billing_overage_consents`, 'P0001');
        expect(await store.latestConsent(userId, subscriptionId)).toEqual(row);
    });

    it.each([[-1, 25], [10001, 25], [2500, 0], [2500, -1]])('rejects consent cap %i / rate %i', async (cap, rate) => {
        await rejectsSql(() => client`insert into ezil_billing_overage_consents
            (user_id, subscription_id, enabled, cap_cents, terms_version, catalog_version, rate_cents_per_std_hour, actor, accepted_at)
            values (${userId}::uuid, ${subscriptionId}, true, ${cap}, 'test', 2, ${rate}, 'user', now())`);
    });

    it('deduplicates grants both by invoice and by subscription period while allowing upgrades', async () => {
        const period = grant();
        expect(await store.insertGrant(period)).toBe('inserted');
        expect(await store.insertGrant(period)).toBe('duplicate');
        expect(await store.insertGrant({ ...period, sourceId: randomUUID() })).toBe('duplicate');
        const upgrade = { ...period, kind: 'upgrade_prorated' as const, sourceId: randomUUID(), amount: BigInt('9007199254740993') };
        expect(await store.insertGrant(upgrade)).toBe('inserted');
        expect(await store.insertGrant(upgrade)).toBe('duplicate');
        expect(await store.grantsBySource('invoice', period.sourceId)).toEqual([expect.objectContaining(period)]);
        expect(await store.grantsBySource('invoice', upgrade.sourceId)).toEqual([expect.objectContaining(upgrade)]);
        expect(await store.insertGrant({ ...period, sourceId: randomUUID(), meter: 'ai_usd_micro' })).toBe('inserted');
        expect(await store.insertGrant({ ...period, sourceId: randomUUID(), subscriptionId: 'another_subscription' })).toBe('inserted');
        expect(await store.insertGrant({ ...period, sourceId: randomUUID(), periodStart: instant(100), periodEnd: instant(200) })).toBe('inserted');
        const legacy = grant({ kind: 'pro_period', meter: 'workspace_seconds', subscriptionId: undefined });
        expect(await store.insertGrant(legacy)).toBe('inserted');
        expect((await store.grantsBySource('invoice', legacy.sourceId))[0].subscriptionId).toBeNull();
    });

    it.each([['unknown', 'plan_period'], ['compute_std_seconds', 'unknown']])('rejects unknown grant meter/kind %s / %s', async (meter, kind) => {
        await rejectsSql(() => client`insert into ezil_billing_grants (user_id, meter, kind, amount, source_type, source_id)
            values (${userId}::uuid, ${meter}, ${kind}, 1, 'invoice', ${randomUUID()})`);
    });

    it('selects only overlapping bounded grants and requested meters', async () => {
        const expected: string[] = [];
        for (const [start, end, included] of [[-10, 0, false], [0, 10, true], [9, 11, true], [10, 20, false], [-10, 20, true]] as const) {
            const row = grant({ kind: 'upgrade_prorated', periodStart: instant(start), periodEnd: instant(end) });
            await store.insertGrant(row);
            if (included) expected.push(row.sourceId);
        }
        await store.insertGrant(grant({ kind: 'revoke', periodStart: null, periodEnd: null }));
        await store.insertGrant(grant({ meter: 'ai_usd_micro' }));
        const window = { start: instant(0), end: instant(10) };
        const rows = await store.grantsForPeriod(userId, window, [GRANT_METER_COMPUTE]);
        expect(rows.map(row => row.sourceId).sort()).toEqual(expected.sort());
        expect(await store.grantsForPeriod(userId, window, [GRANT_METER_COMPUTE, 'ai_usd_micro'])).toHaveLength(expected.length + 1);
        expect(await store.grantsForPeriod(userId, window, [])).toEqual([]);
    });

    it('creates one overage invoice per period/rating, preserves amounts on replay and links Stripe once', async () => {
        const input = overage();
        const created = await store.upsertOverageInvoice(input);
        expect(created).toMatchObject({ status: 'inserted', row: { ...input, status: 'pending', stripeInvoiceId: null } });
        expect(await store.upsertOverageInvoice({ ...input, cents: 1, stdSecondsOver: BigInt(1) }))
            .toEqual({ status: 'exists', row: created.row });
        expect((await store.upsertOverageInvoice({ ...input, ratingVersion: 2 })).status).toBe('inserted');
        expect((await store.upsertOverageInvoice({ ...input, periodStart: instant(100), periodEnd: instant(200) })).status).toBe('inserted');
        const stripeInvoiceId = `in_${randomUUID()}`;
        expect(await store.overageInvoiceByStripeId(stripeInvoiceId)).toBeNull();
        expect(await store.setOverageInvoiceStatus(stripeInvoiceId, 'open')).toBe('not_found');
        await store.attachOverageStripeInvoice(created.row.id, stripeInvoiceId);
        await store.attachOverageStripeInvoice(created.row.id, stripeInvoiceId);
        await store.attachOverageStripeInvoice(created.row.id, 'in_replacement');
        for (const status of ['open', 'payment_failed', 'requires_action', 'void', 'uncollectible', 'paid'] as const) {
            expect(await store.setOverageInvoiceStatus(stripeInvoiceId, status)).toBe('updated');
            expect(await store.overageInvoiceByStripeId(stripeInvoiceId)).toMatchObject({ ...input, stripeInvoiceId, status });
        }
        expect(await store.overageInvoicesFor(userId)).toHaveLength(3);
        await rejectsSql(() => client`update ezil_billing_overage_invoices set stripe_invoice_id = ${stripeInvoiceId}
            where user_id = ${userId}::uuid and rating_version = 2`, '23505');
        await rejectsSql(() => client`update ezil_billing_overage_invoices set std_seconds_over = -1 where id = ${created.row.id}::uuid`);
        await rejectsSql(() => client`update ezil_billing_overage_invoices set cents = -1 where id = ${created.row.id}::uuid`);
    });

    it('allows one open plan change per subscription/kind and updates only that open change', async () => {
        const input = change();
        expect(await store.recordPlanChange(input)).toBe('inserted');
        const [initial] = await store.openPlanChanges(userId);
        for (const state of ['pending', 'requires_action', 'payment_failed', 'scheduled'] as const) {
            expect(await store.recordPlanChange({ ...input, state })).toBe('exists');
        }
        const stripeInvoiceId = `in_${randomUUID()}`;
        await store.setPlanChangeState({ userId, subscriptionId, kind: 'upgrade', state: 'requires_action', stripeInvoiceId });
        await store.setPlanChangeState({ userId, subscriptionId, kind: 'upgrade', state: 'scheduled' });
        expect(await store.openPlanChanges(userId)).toEqual([expect.objectContaining({ id: initial.id, state: 'scheduled', stripeInvoiceId })]);
        expect(await store.recordPlanChange(change({ kind: 'cancel', toSku: null }))).toBe('inserted');
        expect(await store.openPlanChanges(userId)).toHaveLength(2);
        await store.setPlanChangeState({ userId, subscriptionId, kind: 'upgrade', state: 'applied', effectiveAt: instant(50) });
        await store.setPlanChangeState({ userId, subscriptionId, kind: 'upgrade', state: 'canceled', effectiveAt: instant(60) });
        const [closed] = await db.select().from(billingPlanChanges).where(eq(billingPlanChanges.id, initial.id));
        expect(closed).toMatchObject({ state: 'applied', stripeInvoiceId, effectiveAt: instant(50) });
        expect(await store.recordPlanChange(input)).toBe('inserted');
        expect(await store.openPlanChanges(userId)).toHaveLength(2);
    });

    it('does not let B update A\'s open plan change through A\'s subscription id', async () => {
        await store.recordPlanChange(change());
        const before = await store.openPlanChanges(userId);
        await store.setPlanChangeState({ userId: otherUserId, subscriptionId, kind: 'upgrade', state: 'applied',
            stripeInvoiceId: 'in_foreign', effectiveAt: instant(50) });
        expect(await store.openPlanChanges(userId)).toEqual(before);
        expect(await store.openPlanChanges(otherUserId)).toEqual([]);
        await store.setPlanChangeState({ userId, subscriptionId, kind: 'upgrade', state: 'requires_action' });
        expect(await store.openPlanChanges(userId)).toEqual([expect.objectContaining({ id: before[0].id, state: 'requires_action' })]);
    });

    it('guards issue updates and resolutions against stale events, including replays after resolution', async () => {
        const input = issue();
        await store.resolvePaymentIssue(input.stripeInvoiceId, instant(0));
        await store.recordPaymentIssue(input);
        await store.recordPaymentIssue(input);
        await store.recordPaymentIssue({ ...input, issue: 'voided', eventCreated: instant(9) });
        expect(await store.openPaymentIssues(userId)).toEqual([expect.objectContaining({ issue: 'payment_failed', stripeEventCreated: instant(10) })]);
        await store.recordPaymentIssue({ ...input, issue: 'requires_action' });
        expect((await store.openPaymentIssues(userId))[0].issue).toBe('requires_action');
        await store.resolvePaymentIssue(input.stripeInvoiceId, instant(9));
        expect(await store.openPaymentIssues(userId)).toHaveLength(1);
        await store.resolvePaymentIssue(input.stripeInvoiceId, instant(20));
        await store.resolvePaymentIssue(input.stripeInvoiceId, instant(19));
        await store.recordPaymentIssue(input);
        await store.recordPaymentIssue({ ...input, eventCreated: instant(20) });
        expect(await store.openPaymentIssues(userId)).toEqual([]);
        const [resolved] = await db.select().from(billingPaymentIssues).where(eq(billingPaymentIssues.stripeInvoiceId, input.stripeInvoiceId));
        expect(resolved).toMatchObject({ resolvedAt: instant(20), stripeEventCreated: instant(20) });
        await store.recordPaymentIssue({ ...input, issue: 'uncollectible', eventCreated: instant(21) });
        expect(await store.openPaymentIssues(userId)).toEqual([expect.objectContaining({ issue: 'uncollectible', resolvedAt: null })]);
    });

    it('upserts size preferences and reads auth creation dates without extending auth schema', async () => {
        expect(await store.sizePreference(userId)).toBeNull();
        for (const size of ['free-cf', 'std-2', 'cmp-4', 'cmp-8', 'cmp-8'] as const) {
            await store.setSizePreference(userId, size);
            expect(await store.sizePreference(userId)).toBe(size);
        }
        await rejectsSql(() => client`update ezil_billing_size_preferences set size = 'unknown' where user_id = ${userId}::uuid`);
        expect(await store.userCreatedAt(userId)).toEqual(instant(-100));
        expect(await store.userCreatedAt(otherUserId)).toEqual(instant(-200));
        expect(await store.userCreatedAt(randomUUID())).toBeNull();
    });
});
