import { randomUUID } from 'node:crypto';
import { and, count, eq, isNull, lt } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '@/server/db/schema';
import {
    authUsers,
    billingEvents,
    billingOutbox,
    billingStorageSamples,
    billingSubscriptions,
    billingUsageIntervals,
    computers,
} from '@/server/db/schema';
import type { BillingStore, GrantInsert, SubscriptionUpsert } from './ports';
import { createBillingStore } from './store';
import { PgDialect } from 'drizzle-orm/pg-core';
import { aiTopupOutboxItem, hasAiReversals, planAiReversal } from './ai-credits';
import { findPack } from './catalog';
import { billingGrants } from '@/server/db/schema/billing';
import type { GrantRow } from './ports';

type Database = typeof import('@/server/db').db;
const instant = (seconds: number) => new Date(Date.UTC(2026, 0, 1) + seconds * 1000);

describe('billing inbox receipt comparison without a database connection', () => {
    const receipt = { eventId: 'event', type: 'invoice.paid', livemode: false, payloadSha256: 'a'.repeat(64) };
    it.each([{ payloadSha256: 'b'.repeat(64) }, { type: 'invoice.updated' }, { livemode: true }])('conflicts on changed receipt fields %j even before processing', async change => {
        for (const processedAt of [null, instant(1)]) {
            const returning = vi.fn().mockResolvedValue([]);
            const limit = vi.fn().mockResolvedValue([{ ...receipt, processedAt, outcome: 'applied' }]);
            const db = { insert: () => ({ values: () => ({ onConflictDoNothing: () => ({ returning }) }) }),
                select: () => ({ from: () => ({ where: () => ({ limit }) }) }) } as unknown as Database;
            expect(await createBillingStore(db).recordEvent({ ...receipt, ...change })).toBe('conflict');
        }
    });
});

/**
 * Run against a disposable migrated database. A single connection keeps each
 * case inside its rollback, including append-only rows and the global stale
 * sweep. No application connection or environment loader is imported here.
 */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('createBillingStore', () => {
    let client: ReturnType<typeof postgres>;
    let db: Database;
    let store: BillingStore;
    let userId: string;
    let otherUserId: string;
    let computerId: string;
    let secondComputerId: string;
    let otherComputerId: string;
    let otherSecondComputerId: string;

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
        otherSecondComputerId = randomUUID();
        await db.insert(authUsers).values([{ id: userId }, { id: otherUserId }]);
        await db.insert(computers).values([
            { id: computerId, userId, slot: 1 },
            { id: secondComputerId, userId, slot: 2 },
            { id: otherComputerId, userId: otherUserId, slot: 1 },
            { id: otherSecondComputerId, userId: otherUserId, slot: 2 },
        ]);
    });

    afterEach(async () => {
        await client`rollback`;
    });

    afterAll(async () => {
        await client?.end();
    });

    it('links customers once and refuses both directions of ownership conflict', async () => {
        const customerId = `cus_${randomUUID()}`;
        const otherCustomerId = `cus_${randomUUID()}`;
        expect(await store.stripeCustomerFor(userId)).toBeNull();
        expect(await store.userForStripeCustomer(customerId)).toBeNull();
        expect(await store.linkCustomer(userId, customerId)).toBe('linked');
        expect(await store.stripeCustomerFor(userId)).toBe(customerId);
        expect(await store.userForStripeCustomer(customerId)).toBe(userId);
        expect(await store.linkCustomer(userId, customerId)).toBe('exists');
        expect(await store.linkCustomer(userId, otherCustomerId)).toBe('conflict');
        expect(await store.linkCustomer(otherUserId, customerId)).toBe('conflict');
        expect(await store.stripeCustomerFor(userId)).toBe(customerId);
        expect(await store.userForStripeCustomer(customerId)).toBe(userId);
        expect(await store.stripeCustomerFor(otherUserId)).toBeNull();
        expect(await store.linkCustomer(otherUserId, otherCustomerId)).toBe('linked');
        expect(await store.stripeCustomerFor(otherUserId)).toBe(otherCustomerId);
        expect(await store.userForStripeCustomer(otherCustomerId)).toBe(otherUserId);
    });

    it('distinguishes new, retryable and successfully processed event receipts', async () => {
        const event = {
            eventId: `evt_${randomUUID()}`,
            type: 'invoice.paid',
            livemode: false,
            payloadSha256: 'a'.repeat(64),
        };
        expect(await store.recordEvent(event)).toBe('new');
        expect(await store.recordEvent(event)).toBe('unprocessed');
        const [initial] = await db.select().from(billingEvents).where(eq(billingEvents.eventId, event.eventId));
        expect(initial).toMatchObject({ ...event, processedAt: null, outcome: null });
        expect(initial.receivedAt).toBeInstanceOf(Date);

        await store.markEventProcessed(event.eventId, 'applied');
        expect(await store.recordEvent(event)).toBe('processed');
        const [processed] = await db.select().from(billingEvents).where(eq(billingEvents.eventId, event.eventId));
        expect(processed.processedAt).toBeInstanceOf(Date);
        expect(processed.outcome).toBe('applied');

        for (const outcome of ['failed', 'failed: temporary error']) {
            await store.markEventProcessed(event.eventId, outcome);
            expect(await store.recordEvent(event)).toBe('unprocessed');
            await store.markEventProcessed(event.eventId, 'applied');
            expect(await store.recordEvent(event)).toBe('processed');
        }
        await store.markEventProcessed(event.eventId, 'ignored_not_failed');
        expect(await store.recordEvent({ ...event, type: 'changed', payloadSha256: 'b'.repeat(64) })).toBe('conflict');
        const [unchanged] = await db.select().from(billingEvents).where(eq(billingEvents.eventId, event.eventId));
        expect(unchanged).toMatchObject(event);

        await db.update(billingEvents).set({ outcome: null }).where(eq(billingEvents.eventId, event.eventId));
        expect(await store.recordEvent(event)).toBe('processed');
        await db.update(billingEvents).set({ processedAt: null, outcome: 'applied' })
            .where(eq(billingEvents.eventId, event.eventId));
        expect(await store.recordEvent(event)).toBe('unprocessed');
    });

    it('applies equal and newer subscription events but preserves ownership and rejects older state', async () => {
        const row: SubscriptionUpsert = {
            stripeSubscriptionId: `sub_${randomUUID()}`,
            userId,
            status: 'active',
            sku: 'pro_monthly_v1',
            currentPeriodStart: instant(0),
            currentPeriodEnd: instant(1000),
            cancelAtPeriodEnd: false,
            stripeEventCreated: instant(10),
        };
        expect(await store.subscriptionsFor(userId)).toEqual([]);
        expect(await store.upsertSubscription(row)).toBe('applied');
        expect(await store.subscriptionsFor(userId)).toEqual([{
            stripeSubscriptionId: row.stripeSubscriptionId,
            status: row.status,
            sku: row.sku,
            currentPeriodStart: row.currentPeriodStart,
            currentPeriodEnd: row.currentPeriodEnd,
            cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        }]);
        expect(await store.upsertSubscription({ ...row, status: 'canceled', stripeEventCreated: instant(9) })).toBe('stale');
        expect((await store.subscriptionsFor(userId))[0].status).toBe('active');
        expect(await store.upsertSubscription({ ...row, status: 'trialing', cancelAtPeriodEnd: true })).toBe('applied');
        expect((await store.subscriptionsFor(userId))[0]).toMatchObject({ status: 'trialing', cancelAtPeriodEnd: true });

        const newer = {
            ...row, status: 'canceled', sku: 'free_v1',
            currentPeriodStart: null, currentPeriodEnd: null, stripeEventCreated: instant(11),
        };
        expect(await store.upsertSubscription(newer)).toBe('applied');
        const [stored] = await db.select().from(billingSubscriptions)
            .where(eq(billingSubscriptions.stripeSubscriptionId, row.stripeSubscriptionId));
        expect(stored).toMatchObject({ ...newer, userId });
        expect(stored.updatedAt).toBeInstanceOf(Date);
        expect(await store.subscriptionsFor(otherUserId)).toEqual([]);
        const other = { ...row, userId: otherUserId, stripeSubscriptionId: `sub_${randomUUID()}` };
        expect(await store.upsertSubscription(other)).toBe('applied');
        expect((await store.subscriptionsFor(otherUserId)).map(sub => sub.stripeSubscriptionId)).toEqual([other.stripeSubscriptionId]);
        expect((await store.subscriptionsFor(userId)).map(sub => sub.stripeSubscriptionId)).toEqual([row.stripeSubscriptionId]);
    });

    it('rejects another owner of an existing subscription for older, equal and newer events without changing the row', async () => {
        const row: SubscriptionUpsert = {
            stripeSubscriptionId: `sub_${randomUUID()}`, userId, status: 'active', sku: 'compute_monthly_v2',
            currentPeriodStart: instant(0), currentPeriodEnd: instant(1000), cancelAtPeriodEnd: false,
            stripeEventCreated: instant(10),
        };
        expect(await store.upsertSubscription(row)).toBe('applied');
        const before = await db.select().from(billingSubscriptions)
            .where(eq(billingSubscriptions.stripeSubscriptionId, row.stripeSubscriptionId));
        for (const created of [9, 10, 11]) {
            expect(await store.upsertSubscription({ ...row, userId: otherUserId, status: 'past_due',
                sku: 'standard_monthly_v2', currentPeriodStart: instant(1000), currentPeriodEnd: instant(2000),
                cancelAtPeriodEnd: true, stripeEventCreated: instant(created) })).toBe('conflict');
            expect(await db.select().from(billingSubscriptions)
                .where(eq(billingSubscriptions.stripeSubscriptionId, row.stripeSubscriptionId))).toEqual(before);
        }
        expect(await store.subscriptionsFor(otherUserId)).toEqual([]);
    });

    it('deduplicates grants by the full source/meter/kind key and preserves bigint amounts', async () => {
        const grant: GrantInsert = {
            userId, meter: 'ai_usd_micro', kind: 'pro_period', amount: BigInt('9007199254740993'),
            periodStart: instant(0), periodEnd: instant(100), sourceType: 'invoice', sourceId: randomUUID(),
        };
        expect(await store.insertGrant(grant)).toBe('inserted');
        expect(await store.insertGrant({ ...grant, amount: BigInt(1) })).toBe('duplicate');
        const [stored] = await store.grantsBySource('invoice', grant.sourceId);
        expect(stored).toMatchObject(grant);
        expect(stored.id).toEqual(expect.any(String));
        expect(stored.createdAt).toBeInstanceOf(Date);
        expect(await store.insertGrant({ ...grant, meter: 'workspace_seconds', amount: BigInt(72000) })).toBe('inserted');
        expect(await store.insertGrant({ ...grant, kind: 'revoke', amount: -grant.amount })).toBe('inserted');
        expect(await store.insertGrant({ ...grant, sourceType: 'refund', kind: 'revoke', amount: -grant.amount, periodStart: null, periodEnd: null })).toBe('inserted');
        const otherSourceId = randomUUID();
        expect(await store.insertGrant({ ...grant, sourceId: otherSourceId })).toBe('inserted');
        expect(await store.grantsBySource('invoice', grant.sourceId)).toHaveLength(3);
        expect(await store.grantsBySource('invoice', otherSourceId)).toHaveLength(1);
        expect(await store.grantsBySource('refund', grant.sourceId)).toEqual([
            expect.objectContaining({ amount: -grant.amount, periodStart: null, periodEnd: null, sourceType: 'refund' }),
        ]);
        expect(await store.grantsBySource('dispute', grant.sourceId)).toEqual([]);
        expect(await store.grantsBySource('invoice', randomUUID())).toEqual([]);
    });

    it('queues outbox items once without replacing their payload or delivery state', async () => {
        const item = {
            eventKey: randomUUID(), userId, kind: 'ai_grant' as const,
            payload: { amount: '3000000', source: { invoice: randomUUID() } },
        };
        expect(await store.enqueueOutbox(item)).toBe('queued');
        expect(await store.enqueueOutbox({ ...item, payload: { amount: '1' } })).toBe('duplicate');
        const rows = await db.select().from(billingOutbox).where(eq(billingOutbox.eventKey, item.eventKey));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ ...item, deliveredAt: null, attempts: 0, lastError: null });
        expect(rows[0].createdAt).toBeInstanceOf(Date);
        expect(await store.enqueueOutbox({ ...item, eventKey: randomUUID(), kind: 'ai_revoke' })).toBe('queued');
        expect(await db.select().from(billingOutbox).where(eq(billingOutbox.userId, userId))).toHaveLength(2);
    });

    it('retains ownership for soft-deleted computers', async () => {
        expect(await store.computerOwner(computerId)).toBe(userId);
        expect(await store.computerOwner(otherComputerId)).toBe(otherUserId);
        await db.update(computers).set({ deletedAt: instant(10) }).where(eq(computers.id, computerId));
        expect(await store.computerOwner(computerId)).toBe(userId);
        expect(await store.computerOwner(randomUUID())).toBeNull();
    });

    it('deduplicates starts, advances heartbeats, closes only open intervals and permits a restart', async () => {
        await store.openInterval(userId, computerId, instant(10), 'start');
        await store.openInterval(userId, computerId, instant(20), 'retry');
        const rowsForComputer = () => db.select().from(billingUsageIntervals)
            .where(eq(billingUsageIntervals.computerId, computerId)).orderBy(billingUsageIntervals.startedAt);
        expect(await rowsForComputer()).toEqual([expect.objectContaining({
            startedAt: instant(10), lastSeenAt: instant(10), endedAt: null, closeReason: null, source: 'start',
        })]);
        await store.touchInterval(computerId, instant(30));
        expect((await rowsForComputer())[0].lastSeenAt).toEqual(instant(30));
        await store.touchInterval(computerId, instant(5));
        expect((await rowsForComputer())[0].lastSeenAt).toEqual(instant(30));
        await store.closeInterval(computerId, instant(40), 'stop');
        const closed = (await rowsForComputer())[0];
        expect(closed).toMatchObject({ endedAt: instant(40), closeReason: 'stop' });
        await store.touchInterval(computerId, instant(100));
        await store.closeInterval(computerId, instant(100), 'retry');
        expect((await rowsForComputer())[0]).toEqual(closed);

        await store.openInterval(userId, computerId, instant(50), 'restart');
        await store.closeInterval(computerId, instant(45), 'clock_skew');
        expect(await rowsForComputer()).toEqual([
            closed, expect.objectContaining({ startedAt: instant(50), endedAt: instant(50), closeReason: 'clock_skew' }),
        ]);
        await store.touchInterval(secondComputerId, instant(10));
        await store.closeInterval(secondComputerId, instant(10), 'missing');
        expect(await db.select().from(billingUsageIntervals)
            .where(eq(billingUsageIntervals.computerId, secondComputerId))).toEqual([]);
    });

    it('reads overlapping intervals inclusively and scopes them to the user', async () => {
        await store.openInterval(userId, computerId, instant(0), 'start');
        await store.closeInterval(computerId, instant(9), 'stop');
        await store.openInterval(userId, computerId, instant(9), 'start');
        await store.closeInterval(computerId, instant(10), 'stop');
        await store.openInterval(userId, computerId, instant(20), 'start');
        await store.closeInterval(computerId, instant(30), 'stop');
        await store.openInterval(userId, secondComputerId, instant(-100), 'start');
        await store.openInterval(otherUserId, otherComputerId, instant(0), 'start');
        const rows = await store.intervalsFor(userId, instant(10));
        expect(rows).toHaveLength(3);
        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ startedAt: instant(9), endedAt: instant(10) }),
            expect.objectContaining({ startedAt: instant(20), endedAt: instant(30) }),
            expect.objectContaining({ startedAt: instant(-100), endedAt: null, lastSeenAt: instant(-100) }),
        ]));
        expect(await store.intervalsFor(userId, instant(0))).toHaveLength(4);
        expect(await store.intervalsFor(otherUserId, instant(10))).toEqual([expect.objectContaining({ startedAt: instant(0), endedAt: null })]);
        expect(await store.intervalsFor(randomUUID(), instant(10))).toEqual([]);
    });

    it('closes stale intervals at last seen, preserving the cutoff boundary and existing closures', async () => {
        const cutoff = instant(100);
        const [baseline] = await db.select({ count: count() }).from(billingUsageIntervals)
            .where(and(isNull(billingUsageIntervals.endedAt), lt(billingUsageIntervals.lastSeenAt, cutoff)));
        await store.openInterval(userId, computerId, instant(0), 'start');
        await store.closeInterval(computerId, instant(5), 'stop');
        await store.openInterval(userId, computerId, instant(10), 'restart');
        await store.touchInterval(computerId, instant(99));
        await store.openInterval(otherUserId, otherComputerId, instant(20), 'start');
        await store.openInterval(userId, secondComputerId, cutoff, 'start');
        await store.openInterval(otherUserId, otherSecondComputerId, instant(101), 'start');
        expect(await store.closeStaleIntervals(cutoff, 'heartbeat_timeout')).toBe(baseline.count + 2);
        const rows = await db.select().from(billingUsageIntervals)
            .where(eq(billingUsageIntervals.userId, userId)).orderBy(billingUsageIntervals.startedAt);
        expect(rows).toEqual([
            expect.objectContaining({ endedAt: instant(5), closeReason: 'stop' }),
            expect.objectContaining({ endedAt: instant(99), lastSeenAt: instant(99), closeReason: 'heartbeat_timeout' }),
            expect.objectContaining({ endedAt: null, lastSeenAt: cutoff, closeReason: null }),
        ]);
        const otherRows = await db.select().from(billingUsageIntervals)
            .where(eq(billingUsageIntervals.userId, otherUserId)).orderBy(billingUsageIntervals.startedAt);
        expect(otherRows).toEqual([
            expect.objectContaining({ endedAt: instant(20), closeReason: 'heartbeat_timeout' }),
            expect.objectContaining({ endedAt: null, lastSeenAt: instant(101) }),
        ]);
        expect(await store.closeStaleIntervals(cutoff, 'retry')).toBe(0);
    });

    it('returns the newest storage sample per computer, including soft-deleted computers', async () => {
        const newest = { computerId, bytes: BigInt('9007199254740993'), measuredAt: instant(20) };
        const second = { computerId: secondComputerId, bytes: BigInt(0), measuredAt: instant(30) };
        const other = { computerId: otherComputerId, bytes: BigInt(123), measuredAt: instant(40) };
        await store.insertStorageSample(userId, { ...newest, source: 'storage' });
        await store.insertStorageSample(userId, { ...newest, bytes: BigInt(1), measuredAt: instant(10), source: 'late' });
        await store.insertStorageSample(userId, { ...second, bytes: BigInt(456), measuredAt: instant(10), source: 'storage' });
        await store.insertStorageSample(userId, { ...second, source: 'storage' });
        await store.insertStorageSample(otherUserId, { ...other, source: 'storage' });
        await db.update(computers).set({ deletedAt: instant(30) }).where(eq(computers.id, computerId));
        const samples = await store.latestStorageFor(userId);
        expect(samples).toHaveLength(2);
        expect(samples).toEqual(expect.arrayContaining([newest, second]));
        expect(await store.latestStorageFor(otherUserId)).toEqual([other]);
        expect(await store.latestStorageFor(randomUUID())).toEqual([]);
        const history = await db.select().from(billingStorageSamples).where(eq(billingStorageSamples.userId, userId));
        expect(history).toHaveLength(4);
        expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ ...newest, source: 'storage' })]));
    });
});


describe('atomic canonical restore store without a database connection', () => {
    function fixture() {
        const original: GrantRow = { id: 'original', userId: 'user', subscriptionId: null, meter: 'ai_usd_micro', kind: 'topup',
            amount: BigInt(10_000_000), sourceType: 'payment_intent', sourceId: 'pi_test',
            periodStart: instant(0), periodEnd: instant(100), createdAt: instant(0) };
        const root = aiTopupOutboxItem('user', { ...findPack('ai_pack_10_v1')!, aiCredits: 1234 }, 'pi_test', original.periodEnd!)!;
        root.payload.accountPublicId = 'payer';
        const input = { action: 'restore' as const, userId: 'user', customerId: 'cus_test', chargeId: 'ch_test',
            causeId: 'dp_test', originals: [original], receipts: [root] };
        const suspend = planAiReversal({ ...input, action: 'suspend' }, { originals: [original], corrections: [], receipts: [root] });
        const negative: GrantRow = { ...suspend.grants[0]!, subscriptionId: null, id: 'suspend', createdAt: instant(1) };
        const selects: unknown[][] = [[{ userId: 'user' }], [original], [root, ...suspend.outbox], [negative]];
        const applied: { table: unknown; value: unknown }[] = [];
        const execute = vi.fn().mockResolvedValue([]);
        const insert = vi.fn((table: unknown) => ({ values: (value: unknown) => ({ onConflictDoNothing: () => ({
            returning: async () => { applied.push({ table, value }); return [{ id: 'inserted' }]; },
        }) }) }));
        const readWhere = vi.fn(async (_query: unknown) => selects.shift() ?? []);
        const tx = { execute, select: () => ({ from: () => ({ where: readWhere }) }), insert };
        const transaction = vi.fn(async (run: (tx: unknown) => Promise<unknown>) => {
            const count = applied.length;
            try { return await run(tx); } catch (error) { applied.splice(count); throw error; }
        });
        const db = { transaction, insert: vi.fn(() => { throw new Error('must use transaction'); }) } as unknown as Database;
        const store = createBillingStore(db);
        if (!hasAiReversals(store)) throw new Error('missing restore port');
        return { input, store, selects, applied, transaction, execute, insert, db, readWhere };
    }
    it('locks the dispute then root, revalidates in the transaction and inserts both effects there', async () => {
        const f = fixture();
        expect(await f.store.recordAiReversal(f.input)).toBe('applied');
        expect(f.transaction).toHaveBeenCalledTimes(1);
        expect(f.db.insert).not.toHaveBeenCalled();
        const locks = f.execute.mock.calls.map(([query]) => new PgDialect().sqlToQuery(query));
        expect(locks.map(q => q.params[0])).toEqual(['billing:ai_cause:dispute:dp_test', `billing:ai_root:${f.input.receipts[0]!.payload.entitlementId}`]);
        expect(locks.every(q => q.sql.includes('pg_advisory_xact_lock'))).toBe(true);
        expect(f.applied.map(a => a.table)).toEqual([billingGrants, billingOutbox]);
        expect(f.applied[0]!.value).toMatchObject({ kind: 'restore', sourceId: 'dp_test', amount: BigInt(10_000_000) });
        expect(f.applied[1]!.value).toMatchObject({ kind: 'ai_restore' });
    });
    it('loads earlier dispute corrections for a different refund cause and commits a zero local delta plus terminal event', async () => {
        const f = fixture();
        expect(await f.store.recordAiReversal({ ...f.input, action: 'revoke', causeId: 're_terminal' })).toBe('applied');
        const query = new PgDialect().sqlToQuery(f.readWhere.mock.calls[3]![0] as Parameters<PgDialect['sqlToQuery']>[0]);
        expect(query.params).toEqual(['refund', 're_terminal', 'dispute', 'dp_test']);
        expect(f.applied[0]!.value).toMatchObject({ kind: 'revoke', sourceType: 'refund', sourceId: 're_terminal', amount: BigInt(0) });
        expect(f.applied[1]!.value).toMatchObject({ kind: 'ai_revoke',
            eventKey: `${f.input.receipts[0]!.payload.entitlementId}:revoke:refund:re_terminal`,
            payload: { accountPublicId: 'payer', localDeltas: [{ originalGrantId: 'original', meter: 'ai_usd_micro', amount: '0' }] } });
    });
    it('rolls back the zero local audit when its distinct terminal refund insert conflicts', async () => {
        const f = fixture();
        f.insert.mockImplementationOnce(table => ({ values: value => ({ onConflictDoNothing: () => ({
            returning: async () => { f.applied.push({ table, value }); return [{ id: 'local' }]; },
        }) }) })).mockImplementationOnce(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) }));
        await expect(f.store.recordAiReversal({ ...f.input, action: 'revoke', causeId: 're_terminal' })).rejects.toThrow('ai_reversal_receipt_conflict');
        expect(f.applied).toEqual([]);
    });
    it('reviews an unproven local history without creating another negative or compensating positive', async () => {
        const f = fixture();
        // A receipt without its local correction must not be treated as an available allowance.
        f.selects[3] = [];
        expect(await f.store.recordAiReversal({ ...f.input, action: 'revoke', causeId: 're_terminal' })).toBe('review:local_reversal_mismatch');
        expect(f.insert).not.toHaveBeenCalled();
    });
    it('rolls back when the outbox key conflicts after the local insert', async () => {
        const f = fixture();
        f.insert.mockImplementationOnce(table => ({ values: value => ({ onConflictDoNothing: () => ({
            returning: async () => { f.applied.push({ table, value }); return [{ id: 'local' }]; },
        }) }) })).mockImplementationOnce(() => ({ values: () => ({ onConflictDoNothing: () => ({ returning: async () => [] }) }) }));
        await expect(f.store.recordAiReversal(f.input)).rejects.toThrow('ai_reversal_receipt_conflict');
        expect(f.applied).toEqual([]);
    });
    it.each(['owner', 'suspend'])('performs no insert when the fresh %s check fails', async defect => {
        const f = fixture();
        f.selects[defect === 'owner' ? 0 : 3] = [];
        expect(await f.store.recordAiReversal(f.input)).toBe(defect === 'owner' ? 'review:customer_mismatch' : 'review:restore_mismatch');
        expect(f.insert).not.toHaveBeenCalled();
    });
});
