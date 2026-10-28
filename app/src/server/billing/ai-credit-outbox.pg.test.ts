import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';
import { authUsers, billingOutbox, billingGrants } from '@/server/db/schema';
import { aiCreditEntitlement, aiCreditOutboxItem, aiTopupOutboxItem, aiCreditRevokeItem, hasAiTopupReceipts, hasAiReversals, aiCreditRestoreItem } from './ai-credits';
import { findPack } from './catalog';
import { createAiCreditOutboxStore, requeueFailedAiCredits } from './ai-credit-outbox-store';
import { CATALOG_V3 } from './v3/contract';
import { drainAiCreditOutbox, type AiCreditOutboxStore } from './ai-credit-outbox';
import { enqueueFreeAiCredits } from './ai-balance';
import { createBillingStore } from './store';
import { processStripeEvent } from './processor';
import type { BillingStore, StripeApi, StripeInvoice, StripeSubscription } from './ports';
import type { StripeEventLike } from './stripe/events';

vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ schedulePaidMigration: vi.fn() }));
type Database = typeof import('@/server/db').db;
const NOW = Date.parse('2026-10-21T00:00:00Z');
const start = new Date('2026-10-01Z'), end = new Date('2026-11-01Z');

/** A disposable migrated database only; every test rolls back, and no test opens a connection without opt-in. */
describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('AI credit outbox with Postgres', () => {
    let client: ReturnType<typeof postgres>, base: Database, db: Database, billing: BillingStore, store: AiCreditOutboxStore, userId: string;
    let finishTest: () => void, transactionDone: Promise<void>;
    const rollbackTest = Symbol('rollback billing test');
    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        base = drizzle(client, { schema });
    });
    beforeEach(async () => {
        const finished = new Promise<void>(resolve => { finishTest = resolve; });
        let ready!: () => void, failed!: (error: unknown) => void;
        const started = new Promise<void>((resolve, reject) => { ready = resolve; failed = reject; });
        transactionDone = base.transaction(async tx => {
            // Store transactions are savepoints inside this rollback-only test transaction.
            db = tx as unknown as Database; billing = createBillingStore(db); store = createAiCreditOutboxStore(db);
            userId = randomUUID(); await db.insert(authUsers).values({ id: userId });
            ready(); await finished; throw rollbackTest;
        }).catch(error => { if (error !== rollbackTest) { failed(error); throw error; } });
        await started;
    });
    afterEach(async () => { finishTest?.(); await transactionDone; });
    afterAll(async () => { await client?.end(); });
    const rows = () => db.select().from(billingOutbox).where(eq(billingOutbox.userId, userId));
    const item = (action: 'grant' | 'revoke' = 'grant') => aiCreditOutboxItem(userId, aiCreditEntitlement({ userId,
        sku: 'standard_monthly_v3', subscriptionId: `sub_${userId}`, periodStart: start, periodEnd: end, invoiceId: 'in' }), action, 'in');

    async function restoreFixture() {
        await billing.linkCustomer(userId, `cus_${userId}`);
        const grant = item(); grant.payload.accountPublicId = 'frozen-payer';
        await billing.insertGrant({ userId, subscriptionId: `sub_${userId}`, meter: 'compute_std_seconds', kind: 'plan_period',
            amount: BigInt(144000), periodStart: start, periodEnd: end, sourceType: 'invoice', sourceId: 'in' });
        await billing.enqueueOutbox(grant);
        const first = (await store.claim(NOW))!;
        await store.finish(first, { status: 'done', reason: null }, NOW);
        const originals = await billing.grantsBySource('invoice', 'in');
        const input = { action: 'suspend' as const, userId, customerId: `cus_${userId}`, chargeId: 'ch_test',
            causeId: `dp_${userId}`, originals, receipts: [grant] };
        if (!hasAiReversals(billing)) throw new Error('missing reversal port');
        expect(await billing.recordAiReversal(input)).toBe('applied');
        expect(await billing.recordAiReversal({ ...input, action: 'restore' })).toBe('applied');
        return { grant, input, restoreKey: aiCreditRestoreItem(grant, input.causeId).eventKey };
    }
    it('claims restore only after its exact D revoke is delivered, ignoring creation timestamps', async () => {
        const f = await restoreFixture();
        await db.update(billingOutbox).set({ createdAt: new Date(NOW - 1000) }).where(eq(billingOutbox.eventKey, f.restoreKey));
        const revoked = (await store.claim(NOW))!;
        expect(revoked.kind).toBe('ai_revoke');
        expect(await store.claim(NOW)).toBeNull();
        expect((await rows()).find(r => r.eventKey === f.restoreKey)!.attempts).toBe(0);
        await store.finish(revoked, { status: 'done', reason: null }, NOW);
        const restore = (await store.claim(NOW))!;
        expect(restore.eventKey).toBe(f.restoreKey);
        expect(restore.restoreConflict).toBe(false);
        await store.finish(restore, { status: 'done', reason: null, outcome: 'restore_expired' }, NOW);
        expect((await rows()).find(r => r.eventKey === f.restoreKey)!.payload).toMatchObject({ delivery: { status: 'done', outcome: 'restore_expired' } });
    });
    it('persists hold waits beyond ten attempts and fences a replaced restore lease', async () => {
        const f = await restoreFixture();
        const revoked = (await store.claim(NOW))!;
        await store.finish(revoked, { status: 'done', reason: null }, NOW);
        for (let attempt = 1; attempt <= 12; attempt++) {
            const at = NOW + attempt * 3_600_000;
            const restore = (await store.claim(at))!;
            expect(restore).toMatchObject({ eventKey: f.restoreKey, attempts: attempt, dependencyWaits: attempt - 1 });
            await store.finish(restore, { status: 'retry', reason: 'restore_hold_pending', nextAttemptAt: at + 3_600_000 }, at);
        }
        const at = NOW + 13 * 3_600_000;
        const stale = (await store.claim(at))!;
        const current = (await store.claim(at + 30_000))!;
        expect(await store.pinAccount(stale, 'frozen-payer')).toBe(false);
        await store.finish(stale, { status: 'failed', reason: 'event_conflict' }, at + 30_000);
        await store.finish(current, { status: 'done', reason: null, outcome: 'restored' }, at + 30_001);
        expect((await rows()).find(r => r.eventKey === f.restoreKey)!.payload).toMatchObject({ delivery: { status: 'done', outcome: 'restored', dependencyWaits: 12 } });
    });
    it('claims a mismatched payer for explicit review without delivering it', async () => {
        const f = await restoreFixture();
        const revoked = (await store.claim(NOW))!;
        await store.finish(revoked, { status: 'done', reason: null }, NOW);
        const restore = (await rows()).find(r => r.eventKey === f.restoreKey)!;
        await db.update(billingOutbox).set({ payload: { ...(restore.payload as object), accountPublicId: 'wrong' } }).where(eq(billingOutbox.id, restore.id));
        expect(await store.claim(NOW)).toMatchObject({ eventKey: f.restoreKey, restoreConflict: true });
    });
    it('sees a queued terminal refund before sending an earlier queued restore', async () => {
        const f = await restoreFixture();
        if (!hasAiReversals(billing)) throw new Error('missing reversal port');
        expect(await billing.recordAiReversal({ ...f.input, action: 'revoke', causeId: 're_final' })).toBe('applied');
        await db.update(billingOutbox).set({ createdAt: new Date(NOW - 1000) }).where(eq(billingOutbox.eventKey, f.restoreKey));
        expect(await store.claim(NOW)).toMatchObject({ eventKey: f.restoreKey, restoreDisposition: 'terminal' });
    });

    it('keeps one Free grant and its original expiry across later summaries', async () => {
        await enqueueFreeAiCredits(billing, userId, 'free_v3', new Date(NOW));
        await enqueueFreeAiCredits(billing, userId, 'free_v3', new Date(NOW + 86400000));
        expect(await rows()).toEqual([expect.objectContaining({ eventKey: `ezil-os:v1:free-once:${userId}:grant`,
            payload: expect.objectContaining({ expiresAt: '2027-10-21T00:00:00.000Z', credits: CATALOG_V3.free_v3.aiCredits.amount }) })]);
    });
    it('round 3 D5: requeues only failed, unexpired, unrevoked grants; dry run writes nothing', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const grant = (sub: string, periodEnd = end) => aiCreditOutboxItem(userId, aiCreditEntitlement({ userId, sku: 'standard_monthly_v3',
            subscriptionId: sub, periodStart: start, periodEnd, invoiceId: `in_${sub}` }), 'grant', `in_${sub}`);
        const eligible = grant('sub_ok'), expired = grant('sub_old', new Date('2026-10-10Z')), revoked = grant('sub_rev'), permanent = grant('sub_perm');
        for (const item of [eligible, expired, revoked, permanent]) await billing.enqueueOutbox(item);
        await billing.enqueueOutbox(aiCreditRevokeItem(revoked));
        const fail = async (eventKey: string, reason: string, attempts: number) => db.update(billingOutbox).set({ attempts, lastError: reason,
            payload: sql`jsonb_set(payload, '{delivery}', ${JSON.stringify({ status: 'failed', nextAttemptAt: null })}::jsonb)` })
            .where(eq(billingOutbox.eventKey, eventKey));
        await fail(eligible.eventKey, 'attempts_exhausted', 10);
        await fail(expired.eventKey, 'expired', 4);
        await fail(revoked.eventKey, 'no_ai_account', 3);
        await fail(permanent.eventKey, 'event_conflict', 1);
        const before = await rows();
        const dry = await requeueFailedAiCredits(db, { userId, apply: false, now: NOW });
        expect(Object.fromEntries(dry.decisions.map(d => [d.eventKey, d.decision]))).toEqual({ [eligible.eventKey]: 'eligible',
            [expired.eventKey]: 'still_expired', [revoked.eventKey]: 'revoked', [permanent.eventKey]: 'not_retryable' });
        expect(await rows()).toEqual(before);
        expect(await store.claim(NOW)).toMatchObject({ kind: 'ai_revoke' }); // Only the queued revoke is claimable before the reset.
        expect(await store.claim(NOW)).toBeNull();
        const applied = await requeueFailedAiCredits(db, { eventKeys: [eligible.eventKey, expired.eventKey], apply: true, now: NOW });
        expect(applied).toMatchObject({ dryRun: false, selected: 2, requeued: 1 });
        const reset = (await rows()).find(r => r.eventKey === eligible.eventKey)!;
        expect(reset).toMatchObject({ attempts: 0, lastError: null, deliveredAt: null,
            payload: expect.objectContaining({ delivery: { status: 'retry', nextAttemptAt: NOW, requeuedAt: NOW, requeuedFrom: 'attempts_exhausted' } }) });
        expect((await rows()).find(r => r.eventKey === expired.eventKey)).toEqual(before.find(r => r.eventKey === expired.eventKey));
        expect((await store.claim(NOW))?.eventKey).toBe(eligible.eventKey);
        expect((await requeueFailedAiCredits(db, { userId, apply: true, now: NOW })).requeued).toBe(0);
        info.mockRestore();
    });
    it('round 3 D2: reads one user\'s grant receipts with delivery state, never revokes or other users', async () => {
        const grant = item(); await billing.enqueueOutbox(grant);
        const claimed = (await store.claim(NOW))!;
        await store.finish(claimed, { status: 'done', reason: null }, NOW);
        await billing.enqueueOutbox(aiCreditRevokeItem(grant));
        expect(await store.receiptsFor!(userId)).toEqual([{ entitlementId: grant.payload.entitlementId, credits: 200,
            expiresAt: '2026-11-04T00:00:00.000Z', deliveredAt: new Date(NOW).toISOString() }]);
        expect(await store.receiptsFor!(randomUUID())).toEqual([]);
    });
    it('claims only whole-credit rows and marks success once', async () => {
        await billing.enqueueOutbox({ eventKey: `legacy:${userId}`, userId, kind: 'ai_grant', payload: { amountUsdMicro: '100000' } });
        await billing.enqueueOutbox(item());
        const claimed = (await store.claim(NOW))!;
        expect(claimed.eventKey).toBe(item().eventKey); expect(claimed.attempts).toBe(1);
        expect(await store.claim(NOW)).toBeNull();
        expect(await store.pinAccount(claimed, 'works-account')).toBe(true);
        await store.finish(claimed, { status: 'done', reason: null }, NOW);
        expect(await store.claim(NOW + 86400000)).toBeNull();
        expect((await rows()).find(r => r.eventKey === item().eventKey)).toMatchObject({ deliveredAt: new Date(NOW), attempts: 1,
            payload: expect.objectContaining({ accountPublicId: 'works-account', delivery: { status: 'done', nextAttemptAt: null } }) });
    });
    it('retries only when persisted backoff is due', async () => {
        await billing.enqueueOutbox(item());
        const first = (await store.claim(NOW))!;
        await store.finish(first, { status: 'retry', reason: 'http_503', nextAttemptAt: NOW + 60_000 }, NOW);
        expect(await store.claim(NOW + 59_999)).toBeNull();
        expect(await store.claim(NOW + 60_000)).toMatchObject({ id: first.id, attempts: 2 });
    });
    it.each(['no_ai_account', 'account_not_found'])('persists %s waits beyond ten claims, including a crashed lease', async reason => {
        await billing.enqueueOutbox(item());
        for (let attempt = 1; attempt <= 20; attempt++) {
            const at = NOW + attempt * 3_600_000;
            const row = (await store.claim(at))!;
            expect(row).toMatchObject({ attempts: attempt, dependencyWaits: attempt - 1, exhausted: false });
            await store.finish(row, { status: 'retry', reason, nextAttemptAt: at + 3_600_000 }, at);
            expect(await store.claim(at + 3_599_999)).toBeNull();
        }
        const at = NOW + 21 * 3_600_000;
        const crashed = (await store.claim(at))!;
        const recovered = (await store.claim(at + 30_000))!;
        expect(recovered).toMatchObject({ attempts: 22, dependencyWaits: 20, exhausted: false });
        expect(await store.pinAccount(crashed, 'stale')).toBe(false);
        await store.finish(crashed, { status: 'failed', reason: 'stale' }, at + 30_001);
        expect(await store.pinAccount(recovered, 'ready')).toBe(true);
        await store.finish(recovered, { status: 'done', reason: null }, at + 30_002);
        expect((await rows())[0]).toMatchObject({ deliveredAt: new Date(at + 30_002),
            payload: expect.objectContaining({ accountPublicId: 'ready', delivery: { status: 'done', nextAttemptAt: null, dependencyWaits: 20 } }) });
    });
    it('recovers expired leases and fences writes from the old worker', async () => {
        await billing.enqueueOutbox(item());
        const first = (await store.claim(NOW))!;
        expect(await store.claim(NOW + 29_999)).toBeNull();
        const second = (await store.claim(NOW + 30_000))!;
        expect(second).toMatchObject({ id: first.id, attempts: 2 });
        expect(await store.pinAccount(first, 'late-account')).toBe(false);
        await store.finish(first, { status: 'done', reason: null }, NOW + 30001);
        expect((await rows())[0]!.deliveredAt).toBeNull();
        await store.finish(second, { status: 'failed', reason: 'event_conflict' }, NOW + 30002);
        expect(await store.claim(NOW + 86400000)).toBeNull();
    });
    it('crashed tenth attempts terminate without an eleventh HTTP request', async () => {
        await billing.enqueueOutbox(item());
        for (let i = 0; i < 10; i++) expect((await store.claim(NOW + i * 30_000))!.attempts).toBe(i + 1);
        const fetcher = vi.fn<typeof fetch>();
        await drainAiCreditOutbox({ config: { fundingUrl: 'https://gateway.test', fundingHmacSecret: 'test-key' },
            aiCredits: store, clock: () => NOW + 300_000, fetch: fetcher }, { limit: 1, deadlineMs: NOW + 340_000 });
        expect(fetcher).not.toHaveBeenCalled();
        expect((await rows())[0]).toMatchObject({ attempts: 10, lastError: 'attempts_exhausted',
            payload: expect.objectContaining({ delivery: { status: 'failed', nextAttemptAt: null } }) });
        expect(await store.claim(NOW + 86400000)).toBeNull();
    });
    it('a revoke retains the original grant account without requiring the Works view', async () => {
        await billing.enqueueOutbox(item());
        const grant = (await store.claim(NOW))!;
        await store.pinAccount(grant, 'original-works-account');
        await store.finish(grant, { status: 'done', reason: null }, NOW);
        await billing.enqueueOutbox(item('revoke'));
        const revoke = (await store.claim(NOW))!;
        expect(await store.accountFor(revoke)).toBe('original-works-account');
    });
    it.each(['refund', 'dispute'] as const)('replayed invoice.paid enqueues one grant and %s enqueues one revoke', async kind => {
        const subId = `sub_${userId}`, customer = `cus_${userId}`, invoiceId = `in_${userId}`;
        await billing.linkCustomer(userId, customer);
        const subscription = { id: subId, customer, status: 'active', sku: 'standard_monthly_v3', currentPeriodStart: start,
            currentPeriodEnd: end, cancelAtPeriodEnd: false } as StripeSubscription;
        const invoice: StripeInvoice = { id: invoiceId, customer, status: 'paid', subscriptionId: subId,
            billingReason: 'subscription_cycle', metadataKind: null, hostedInvoiceUrl: null, periodStart: start, periodEnd: end,
            lines: [{ id: 'line', lookupKey: 'ezil_standard_monthly_v3', subscriptionId: subId,
                amount: 2000, proration: false, periodStart: start, periodEnd: end }] };
        const stripe = { retrieveInvoice: async () => invoice, retrieveSubscription: async () => subscription,
            retrieveCharge: async () => ({ id: 'charge', customer, invoiceId, paymentIntentId: null, refunded: true, amount: 2000, amountRefunded: 2000 }) } as unknown as StripeApi;
        const deps = { store: billing, stripe, now: () => new Date(NOW) };
        const event = (type: string, object: Record<string, unknown>): StripeEventLike => ({
            id: `evt_${randomUUID()}`, type, livemode: false, created: NOW / 1000, data: { object },
        });
        const unix = (d: Date) => Math.floor(d.getTime() / 1000);
        const paid = event('invoice.paid', { id: invoiceId, customer, billing_reason: 'subscription_cycle',
            parent: { subscription_details: { subscription: subId } },
            lines: { data: [{ id: 'line', subscription: subId, type: 'subscription', period: { start: unix(start), end: unix(end) } }] } });
        await processStripeEvent(paid, deps); await processStripeEvent(paid, deps);
        await processStripeEvent({ ...paid, id: `evt_${randomUUID()}` }, deps);
        expect(await rows()).toHaveLength(1);
        const reversal = kind === 'refund' ? event('charge.refunded', { id: 'charge', refunds: { data: [{ id: 'refund' }] } })
            : event('charge.dispute.created', { id: 'dispute', charge: 'charge', status: 'needs_response' });
        await processStripeEvent(reversal, deps); await processStripeEvent(reversal, deps);
        expect((await rows()).map(r => r.kind).sort()).toEqual(['ai_grant', 'ai_revoke']);
    });
});

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('atomic topup receipts with Postgres', () => {
    it('freezes one receipt, rolls back a failed insert, and never converts a legacy purchase', async () => {
        const client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        const db = drizzle(client, { schema });
        const rollback = new Error('fixture rollback');
        try {
            await expect(db.transaction(async tx => {
                const store = createBillingStore(tx as unknown as Database);
                if (!hasAiTopupReceipts(store)) throw new Error('missing topup store');
                const userId = randomUUID();
                await tx.insert(authUsers).values({ id: userId });
                const pack = { ...findPack('ai_pack_10_v1')!, aiCredits: 1234 };
                const make = (id: string) => {
                    const receipt = aiTopupOutboxItem(userId, pack, id, end)!;
                    const grant = { userId, meter: 'ai_usd_micro' as const, kind: 'topup' as const, amount: BigInt(10_000_000),
                        sourceType: 'payment_intent' as const, sourceId: id, periodStart: start, periodEnd: end };
                    return { grant, receipt };
                };
                const first = make(`pi_${userId.replaceAll('-', '')}`);
                expect(await store.recordAiTopup(first.grant, first.receipt)).toBe('applied');
                await store.enqueueOutbox(aiCreditRevokeItem(first.receipt));
                const changed = { ...first.receipt, payload: { ...first.receipt.payload, credits: 9999 } };
                expect(await store.recordAiTopup(first.grant, changed)).toBe('applied');
                expect((await store.aiTopupReceipt(userId, first.grant.sourceId))?.payload.credits).toBe(1234);
                expect(await tx.select().from(billingGrants).where(eq(billingGrants.userId, userId))).toHaveLength(1);
                expect(await tx.select().from(billingOutbox).where(eq(billingOutbox.userId, userId))).toHaveLength(2);

                const collision = make(`pi_collision${userId.replaceAll('-', '')}`);
                collision.receipt.eventKey = first.receipt.eventKey;
                await expect(store.recordAiTopup(collision.grant, collision.receipt)).rejects.toThrow('ai_topup_receipt_conflict');
                expect(await tx.select().from(billingGrants).where(eq(billingGrants.sourceId, collision.grant.sourceId))).toHaveLength(0);

                const legacy = make(`pi_legacy${userId.replaceAll('-', '')}`);
                await store.insertGrant(legacy.grant);
                const old = { userId, eventKey: `payment_intent:${legacy.grant.sourceId}:ai_topup`, kind: 'ai_grant' as const,
                    payload: { amountUsdMicro: '10000000', bucket: 'purchased' } };
                await store.enqueueOutbox(old);
                expect(await store.recordAiTopup(legacy.grant, legacy.receipt)).toBe('review:legacy_topup_unfunded');
                expect(await store.aiTopupReceipt(userId, legacy.grant.sourceId)).toBeNull();
                throw rollback;
            })).rejects.toBe(rollback);
        } finally { await client.end(); }
    });
});

describe.skipIf(!process.env.BILLING_TEST_DATABASE_URL)('AI outbox concurrent claim', () => {
    it('skips a row locked by another transaction without waiting or delivering twice', async () => {
        const client = postgres(process.env.BILLING_TEST_DATABASE_URL!, {
            max: 2, prepare: false, connection: { statement_timeout: 1000 },
        });
        const db = drizzle(client, { schema });
        const billing = createBillingStore(db), store = createAiCreditOutboxStore(db), userId = randomUUID();
        try {
            await db.insert(authUsers).values({ id: userId });
            await enqueueFreeAiCredits(billing, userId, 'free_v3', new Date(NOW));
            await client.begin(async tx => {
                await tx`select id from ezil_billing_outbox where user_id = ${userId}::uuid for update`;
                expect(await store.claim(NOW)).toBeNull();
            });
            expect(await store.claim(NOW)).toMatchObject({ userId, attempts: 1 });
        } finally {
            await db.delete(authUsers).where(eq(authUsers.id, userId));
            await client.end();
        }
    });
});
