import { createHmac, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';
import { authUsers, billingOutbox, billingGrants } from '@/server/db/schema';
import { aiCreditEntitlement, aiCreditOutboxItem, aiTopupOutboxItem, aiCreditRevokeItem, hasAiTopupReceipts, hasAiReversals, aiCreditRestoreItem } from './ai-credits';
import { customTopupPack, findPack } from './catalog';
import { signAiGatewayBody } from './ai-gateway-client';
import { deliverPaidTopup } from './ai-topup-delivery';
import { AI_CREDIT_KICK_SQL, createAiCreditOutboxStore, requeueFailedAiCredits } from './ai-credit-outbox-store';
import { AI_CREDIT_PROTOCOL } from './ai-credits';
import { CATALOG_V3 } from './v3/contract';
import { drainAiCreditOutbox, type AiCreditOutboxStore } from './ai-credit-outbox';
import { enqueueFreeAiCredits } from './ai-balance';
import { createBillingStore } from './store';
import { processStripeEvent } from './processor';
import type { BillingDeps, BillingStore, StripeApi, StripeInvoice, StripeSubscription } from './ports';
import { readBillingConfig } from './config';
import { handleStripeWebhook } from './http/stripe-webhook';
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
    it('round 5 D1 review fix: marks a terminally failed undelivered grant receipt as failed (never waiting)', async () => {
        await billing.enqueueOutbox(item());
        const claimed = (await store.claim(NOW))!;
        await store.finish(claimed, { status: 'failed', reason: 'attempts_exhausted' }, NOW);
        expect(await store.receiptsFor!(userId)).toEqual([{ entitlementId: item().payload.entitlementId, credits: 200,
            expiresAt: '2026-11-04T00:00:00.000Z', deliveredAt: null, failed: true }]);
        await requeueFailedAiCredits(db, { userId, apply: true, now: NOW });
        expect((await store.receiptsFor!(userId))[0]).not.toHaveProperty('failed');
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
    describe('round 5 D1: needs_ezil_id park and the sign-in kick', () => {
        const grantFor = (owner: string, suffix: string) => aiCreditOutboxItem(owner, aiCreditEntitlement({ userId: owner,
            sku: 'standard_monthly_v3', subscriptionId: `sub_${suffix}_${owner}`, periodStart: start, periodEnd: end, invoiceId: 'in' }), 'grant', 'in');
        const DAY = 24 * 3_600_000;
        async function kick(owner: string, at: number) {
            // The exact statement text the sign-in enrollment sends, bound inside this rollback-only transaction.
            await db.execute(sql.raw(`prepare r5_kick(uuid, bigint, text) as ${AI_CREDIT_KICK_SQL}`));
            try { await db.execute(sql.raw(`execute r5_kick('${owner}', ${at}, '${AI_CREDIT_PROTOCOL}')`)); }
            finally { await db.execute(sql.raw('deallocate r5_kick')); }
        }
        const byKey = async () => new Map((await db.select().from(billingOutbox)).map(r => [r.eventKey, r]));

        it('the drain parks a needs_ezil_id grant for 24 h as a dependency wait with blockedBy, never failed', async () => {
            await billing.enqueueOutbox(item());
            const parked = { ...store, accountFor: async () => null, enrollFor: vi.fn(async () => 'needs_ezil_id' as const) };
            const counts = await drainAiCreditOutbox({ config: { fundingUrl: 'https://gateway.test', fundingHmacSecret: 'test-key' },
                aiCredits: parked, clock: () => NOW, fetch: vi.fn<typeof fetch>() }, { limit: 5, deadlineMs: NOW + 40_000 });
            expect(counts).toMatchObject({ claimed: 1, retry: 1, failed: 0, skipped: 1 });
            expect(parked.enrollFor).toHaveBeenCalledExactlyOnceWith(userId);
            expect((await rows())[0]).toMatchObject({ attempts: 1, lastError: 'no_ai_account', deliveredAt: null,
                payload: expect.objectContaining({ delivery: { status: 'retry', nextAttemptAt: NOW + DAY, dependencyWaits: 1, blockedBy: 'needs_ezil_id' } }) });
            expect(await store.claim(NOW + DAY - 1)).toBeNull();
            await kick(userId, NOW + 60_000);
            expect(await store.claim(NOW + 60_000)).toMatchObject({ userId, attempts: 2, dependencyWaits: 1 });
        });

        it('wakes only this user\'s retry rows waiting on the account; processing, other errors, delivered and other users stay', async () => {
            const other = randomUUID(); await db.insert(authUsers).values({ id: other });
            const waiting = grantFor(userId, 'a'), notFound = grantFor(userId, 'b'), gateway = grantFor(userId, 'c');
            const held = grantFor(userId, 'd'), delivered = grantFor(userId, 'e'), foreign = grantFor(other, 'f');
            for (const [i, row] of [waiting, notFound, gateway, held, delivered, foreign].entries()) {
                await billing.enqueueOutbox(row);
                await db.update(billingOutbox).set({ createdAt: new Date(NOW - 10_000 + i) }).where(eq(billingOutbox.eventKey, row.eventKey));
            }
            const finishes: [string, Parameters<AiCreditOutboxStore['finish']>[1]][] = [
                [waiting.eventKey, { status: 'retry', reason: 'no_ai_account', blockedBy: 'needs_ezil_id', nextAttemptAt: NOW + DAY }],
                [notFound.eventKey, { status: 'retry', reason: 'account_not_found', nextAttemptAt: NOW + 3_600_000 }],
                [gateway.eventKey, { status: 'retry', reason: 'http_503', nextAttemptAt: NOW + 3_600_000 }],
                [held.eventKey, { status: 'retry', reason: 'no_ai_account', nextAttemptAt: NOW + 1 }],
                [delivered.eventKey, { status: 'done', reason: null }],
                [foreign.eventKey, { status: 'retry', reason: 'no_ai_account', nextAttemptAt: NOW + DAY }],
            ];
            for (const [key, result] of finishes) {
                const claimed = (await store.claim(NOW))!;
                expect(claimed.eventKey).toBe(key);
                await store.finish(claimed, result, NOW);
            }
            // `held` is re-claimed by a worker (processing under its lease) before the kick.
            const leased = (await store.claim(NOW + 1))!;
            expect(leased.eventKey).toBe(held.eventKey);
            // Another protocol's row with the same wait reason is never woken by a v1 kick.
            const v2Key = `ezil-ai-credits-v2:${userId}:grant`;
            await db.insert(billingOutbox).values({ eventKey: v2Key, userId, kind: 'ai_grant', lastError: 'no_ai_account',
                payload: { protocol: 'ezil-ai-credits-v2', delivery: { status: 'retry', nextAttemptAt: NOW + DAY } } });
            const before = await byKey();
            await kick(userId, NOW + 5_000);
            const after = await byKey();
            const delivery = (key: string) => (after.get(key)!.payload as { delivery: Record<string, unknown> }).delivery;
            expect(delivery(waiting.eventKey)).toEqual({ status: 'retry', nextAttemptAt: NOW + 5_000, dependencyWaits: 1, blockedBy: 'needs_ezil_id' });
            expect(delivery(notFound.eventKey)).toEqual({ status: 'retry', nextAttemptAt: NOW + 5_000, dependencyWaits: 1 });
            for (const key of [gateway.eventKey, held.eventKey, delivered.eventKey, foreign.eventKey, v2Key]) {
                expect(after.get(key)!.payload).toEqual(before.get(key)!.payload);
            }
            for (const [key, row] of after) expect(row.attempts).toBe(before.get(key)!.attempts);
            // The held worker's fence still matches: the kick did not touch its delivery JSON.
            await store.finish(leased, { status: 'done', reason: null }, NOW + 6_000);
            expect((await byKey()).get(held.eventKey)!.deliveredAt).not.toBeNull();
            expect((await store.claim(NOW + 5_000))!.eventKey).toBe(waiting.eventKey);
            expect((await store.claim(NOW + 5_000))!.eventKey).toBe(notFound.eventKey);
            expect(await store.claim(NOW + 5_000)).toBeNull();
        });

        it('review fix (lost wakeup): a kick that lands while the drain holds the row cannot strand it for a day', async () => {
            const info = vi.spyOn(console, 'info').mockImplementation(() => {});
            await billing.enqueueOutbox(item());
            let linked = false;
            // Stale admin read (before the bridge linked the subject); the bridge then enrolls and kicks.
            const racing = { ...store, accountFor: async () => (linked ? 'works-public-id' : null),
                enrollFor: vi.fn(async () => { linked = true; await kick(userId, NOW + 1); return 'needs_ezil_id' as const; }) };
            const counts = await drainAiCreditOutbox({ config: { fundingUrl: 'https://gateway.test', fundingHmacSecret: 'test-key' },
                aiCredits: racing, clock: () => NOW, fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 })) },
            { limit: 1, deadlineMs: NOW + 40_000 });
            expect(counts).toMatchObject({ claimed: 1, done: 1 });
            expect((await rows())[0]).toMatchObject({ deliveredAt: new Date(NOW),
                payload: expect.objectContaining({ accountPublicId: 'works-public-id' }) });
            info.mockRestore();
        });
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
            billingReason: 'subscription_cycle', metadataKind: null, hostedInvoiceUrl: null, total: 2000, amountPaid: 2000, periodStart: start, periodEnd: end,
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
    it.each(['refund', 'dispute'] as const)('round 3 D1: a replayed paid upgrade enqueues one prorated AI grant and a %s reverses it', async kind => {
        const subId = `sub_${userId.replace(/-/g, '')}`, customer = `cus_${userId}`, invoiceId = `in_up_${userId}`;
        const effective = new Date('2026-10-11T12:00:00Z');
        await billing.linkCustomer(userId, customer);
        const subscription = { id: subId, customer, status: 'active', sku: 'premium_monthly_v3', currentPeriodStart: start,
            currentPeriodEnd: end, cancelAtPeriodEnd: false } as StripeSubscription;
        const invoice: StripeInvoice = { id: invoiceId, customer, status: 'paid', subscriptionId: subId,
            billingReason: 'subscription_update', metadataKind: null, hostedInvoiceUrl: null, total: 4000, amountPaid: 4000, periodStart: start, periodEnd: end,
            lines: [{ id: 'credit', lookupKey: 'ezil_standard_monthly_v3', subscriptionId: subId, amount: -1000, proration: true, periodStart: effective, periodEnd: end },
                { id: 'premium', lookupKey: 'ezil_premium_monthly_v3', subscriptionId: subId, amount: 5000, proration: true, periodStart: effective, periodEnd: end }] };
        const stripe = { retrieveInvoice: async () => invoice, retrieveSubscription: async () => subscription,
            retrieveCharge: async () => ({ id: 'charge', customer, invoiceId, paymentIntentId: null, refunded: kind === 'refund', amount: 4000, amountRefunded: 4000 }) } as unknown as StripeApi;
        const deps = { store: billing, stripe, now: () => new Date(NOW) };
        const event = (type: string, object: Record<string, unknown>): StripeEventLike => ({
            id: `evt_${randomUUID()}`, type, livemode: false, created: NOW / 1000, data: { object },
        });
        const paid = event('invoice.paid', { id: invoiceId, customer, billing_reason: 'subscription_update',
            parent: { subscription_details: { subscription: subId } }, lines: { data: [] } });
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await processStripeEvent(paid, deps)).toBe('applied');
        await processStripeEvent(paid, deps); await processStripeEvent({ ...paid, id: `evt_${randomUUID()}` }, deps);
        const root = `ezil-os:v1:premium_monthly_v3:${subId}:${effective.toISOString()}:upgrade`;
        expect(await rows()).toEqual([expect.objectContaining({ eventKey: `${root}:grant`, kind: 'ai_grant',
            payload: expect.objectContaining({ entitlementId: root, credits: 529, expiresAt: '2026-11-04T00:00:00.000Z', invoiceId }) })]);
        const reversal = kind === 'refund' ? event('charge.refunded', { id: 'charge', refunds: { data: [{ id: 'refund' }] } })
            : event('charge.dispute.created', { id: 'dispute', charge: 'charge', status: 'needs_response' });
        expect(await processStripeEvent(reversal, deps)).toBe('applied');
        await processStripeEvent(reversal, deps);
        expect((await rows()).map(r => [r.kind, (r.payload as Record<string, unknown>).entitlementId, (r.payload as Record<string, unknown>).credits]).sort()).toEqual([
            ['ai_grant', root, 529], ['ai_revoke', root, 529]]);
        info.mockRestore();
    });

    describe('a paid top-up is delivered without the sweep (deliverPaidTopup on the real store)', () => {
        const CONFIG = { fundingUrl: 'https://gateway.test', fundingHmacSecret: 'topup-pg-test-secret' };
        const ACCOUNT = 'a3c1f0de-1111-4222-8333-444455556666', OTHER_ACCOUNT = 'b4d2e1cf-1111-4222-8333-444455556666';
        const CREDITS_MICRO = BigInt(250) * BigInt(1_000_000);
        /** The member contract's account for this user; the claim, lease, pin and finish stay the real store's. */
        const deps = () => ({ config: CONFIG, aiCredits: { ...store, accountFor: async () => ACCOUNT } });
        const receiptOf = async (intent: string) => (await rows()).find(row => row.kind === 'ai_grant'
            && (row.payload as Record<string, unknown>).paymentIntentId === intent)!;
        const delivery = async (intent: string) => (await receiptOf(intent)).payload as { accountPublicId?: string; delivery?: Record<string, unknown> };

        /** What the verified webhook commits for a paid checkout: the ledger grant and its receipt, atomically. */
        async function paid(owner = userId, intent = `pi_${randomUUID().replaceAll('-', '')}`) {
            if (!hasAiTopupReceipts(billing)) throw new Error('missing topup store');
            const receipt = aiTopupOutboxItem(owner, customTopupPack(2500)!, intent, end)!;
            expect(await billing.recordAiTopup({ userId: owner, meter: 'ai_usd_micro', kind: 'topup', amount: BigInt(25_000_000),
                sourceType: 'payment_intent', sourceId: intent, periodStart: start, periodEnd: end }, receipt)).toBe('applied');
            return { intent, receipt, scope: { userId: owner, eventKey: receipt.eventKey, kind: 'ai_grant' as const, soleReceipt: true as const } };
        }

        /** A Gateway that checks the HMAC, applies each event id once, and keeps a balance per account. */
        function gateway() {
            const seen = new Map<string, string>(), granted = new Map<string, bigint>();
            let failures = 0, loseResponses = 0;
            const fetcher = vi.fn<typeof fetch>(async (url, init) => {
                const body = String(init!.body), headers = new Headers(init!.headers);
                expect(String(url)).toBe('https://gateway.test/v1/integrations/entitlements');
                expect(headers.get('x-ezil-signature')).toBe(signAiGatewayBody(CONFIG.fundingHmacSecret, headers.get('x-ezil-timestamp')!, body));
                if (failures > 0) { failures--; return new Response(null, { status: 503 }); }
                const event = JSON.parse(body) as { eventId: string; accountPublicId: string; credits: number };
                if (seen.has(event.eventId) && seen.get(event.eventId) !== body) return Response.json({ error: { code: 'event_conflict' } }, { status: 409 });
                if (!seen.has(event.eventId)) {
                    seen.set(event.eventId, body);
                    granted.set(event.accountPublicId, (granted.get(event.accountPublicId) ?? BigInt(0)) + BigInt(event.credits) * BigInt(1_000_000));
                }
                if (loseResponses > 0) { loseResponses--; throw new Error('response lost'); }
                return Response.json({ ok: true });
            });
            return { fetcher, balance: (account: string) => granted.get(account) ?? BigInt(0),
                failNext: (count: number) => { failures = count; }, loseNext: (count: number) => { loseResponses = count; } };
        }
        beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });
        afterEach(() => { vi.restoreAllMocks(); });

        it('funds the exact account once, at once; a duplicate webhook, a later poll and the sweep then find nothing to send', async () => {
            const { intent, scope } = await paid();
            const g = gateway();
            expect(await store.topupScope!({ paymentIntentId: intent })).toEqual(scope);
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: g.fetcher, clock: () => NOW })).toBe('delivered');
            expect(g.fetcher).toHaveBeenCalledTimes(1);
            expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
            expect(g.balance(OTHER_ACCOUNT)).toBe(BigInt(0));
            expect(await receiptOf(intent)).toMatchObject({ deliveredAt: new Date(NOW), attempts: 1, lastError: null,
                payload: expect.objectContaining({ accountPublicId: ACCOUNT, credits: 250, delivery: { status: 'done', nextAttemptAt: null } }) });
            // The status read the payer's poll uses: this receipt, delivered.
            if (!hasAiTopupReceipts(billing)) throw new Error('missing topup store');
            expect(((await billing.aiTopupReceipt(userId, intent))!.payload.delivery as { status: string }).status).toBe('done');
            expect(await store.topupScope!({ paymentIntentId: intent })).toBeNull();
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: g.fetcher, clock: () => NOW + 1 })).toBe('skipped');
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, userId, fetch: g.fetcher, clock: () => NOW + 86_400_000 })).toBe('skipped');
            expect(await store.claim(NOW + 86_400_000)).toBeNull();
            expect(g.fetcher).toHaveBeenCalledTimes(1);
            expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
        });

        it('a transient Gateway failure stays pending under the stored backoff: polls inside it send nothing, the first poll after it funds once', async () => {
            const { intent } = await paid();
            const g = gateway();
            g.failNext(1);
            const poll = (at: number) => deliverPaidTopup(deps(), { paymentIntentId: intent, userId, fetch: g.fetcher, clock: () => at });
            expect(await poll(NOW)).toBe('queued');
            expect(g.balance(ACCOUNT)).toBe(BigInt(0));
            expect(await receiptOf(intent)).toMatchObject({ deliveredAt: null, attempts: 1, lastError: 'http_503',
                payload: expect.objectContaining({ delivery: { status: 'retry', nextAttemptAt: NOW + 60_000 } }) });
            for (const at of [NOW + 1_500, NOW + 3_000, NOW + 59_999]) expect(await poll(at)).toBe('queued');
            expect(g.fetcher).toHaveBeenCalledTimes(1);
            expect((await receiptOf(intent)).attempts).toBe(1);
            expect(await poll(NOW + 60_000)).toBe('delivered');
            expect(g.fetcher).toHaveBeenCalledTimes(2);
            expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
            expect(await receiptOf(intent)).toMatchObject({ deliveredAt: new Date(NOW + 60_000), attempts: 2, lastError: null });
        });

        it('a response lost after the Gateway applied the event is retried with the same event id and funds once', async () => {
            const { intent, receipt } = await paid();
            const g = gateway();
            g.loseNext(1);
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: g.fetcher, clock: () => NOW })).toBe('queued');
            expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
            expect(await delivery(intent)).toMatchObject({ accountPublicId: ACCOUNT, delivery: { status: 'retry' } });
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: g.fetcher, clock: () => NOW + 60_000 })).toBe('delivered');
            expect(g.fetcher.mock.calls.map(call => JSON.parse(String(call[1]!.body)).eventId)).toEqual([receipt.eventKey, receipt.eventKey]);
            expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
        });

        it('a receipt leased by another worker (the webhook, a poll or the sweep) is not sent twice; after the lease it recovers and the old worker is fenced', async () => {
            const { intent, scope } = await paid();
            const g = gateway();
            const held = (await store.claim(NOW, scope))!;
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: g.fetcher, clock: () => NOW + 1 })).toBe('queued');
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: g.fetcher, clock: () => NOW + 29_999 })).toBe('queued');
            expect(g.fetcher).not.toHaveBeenCalled();
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: g.fetcher, clock: () => NOW + 30_000 })).toBe('delivered');
            await store.finish(held, { status: 'failed', reason: 'stale' }, NOW + 30_001);
            expect(await receiptOf(intent)).toMatchObject({ deliveredAt: new Date(NOW + 30_000), attempts: 2, lastError: null });
            expect(g.fetcher).toHaveBeenCalledTimes(1);
            expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
        });

        it('ownership: another signed-in user gets no scope and no attempt for this payment, and their own payment funds only its own event', async () => {
            const other = randomUUID();
            await db.insert(authUsers).values({ id: other });
            const mine = await paid(), theirs = await paid(other);
            const g = gateway();
            expect(await store.topupScope!({ paymentIntentId: mine.intent, userId: other })).toBeNull();
            expect(await store.topupScope!({ paymentIntentId: mine.intent, userId })).toEqual(mine.scope);
            expect(await deliverPaidTopup(deps(), { paymentIntentId: mine.intent, userId: other, fetch: g.fetcher, clock: () => NOW })).toBe('skipped');
            expect(g.fetcher).not.toHaveBeenCalled();
            expect(await receiptOf(mine.intent)).toMatchObject({ attempts: 0, deliveredAt: null });
            // The other user's own poll delivers their receipt and never claims mine.
            const theirDeps = { config: CONFIG, aiCredits: { ...store, accountFor: async () => OTHER_ACCOUNT } };
            expect(await deliverPaidTopup(theirDeps, { paymentIntentId: theirs.intent, userId: other, fetch: g.fetcher, clock: () => NOW })).toBe('delivered');
            expect(JSON.parse(String(g.fetcher.mock.calls[0]![1]!.body))).toMatchObject({ eventId: theirs.receipt.eventKey, accountPublicId: OTHER_ACCOUNT });
            expect(g.balance(OTHER_ACCOUNT)).toBe(CREDITS_MICRO);
            expect(g.balance(ACCOUNT)).toBe(BigInt(0));
            expect(await receiptOf(mine.intent)).toMatchObject({ attempts: 0, deliveredAt: null });
        });

        it('a reversed payment is never funded from a request: a refund or dispute receipt on it removes the scope', async () => {
            for (const cause of [{ type: 'refund' as const, id: 're_fixture' }, { type: 'dispute' as const, id: 'dp_fixture' }, undefined]) {
                const { intent, receipt } = await paid();
                await billing.enqueueOutbox(aiCreditRevokeItem(receipt, cause));
                const g = gateway();
                expect(await store.topupScope!({ paymentIntentId: intent })).toBeNull();
                expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, userId, fetch: g.fetcher, clock: () => NOW })).toBe('skipped');
                expect(g.fetcher).not.toHaveBeenCalled();
                expect(await receiptOf(intent)).toMatchObject({ kind: 'ai_grant', attempts: 0, deliveredAt: null });
            }
        });

        it('a reversal committed between the scope read and the claim is decided by the claim itself: no lease, no attempt, no send', async () => {
            for (const cause of [{ type: 'refund' as const, id: 're_between' }, { type: 'dispute' as const, id: 'dp_between' }]) {
                const { intent, receipt, scope } = await paid();
                const g = gateway();
                let scopeRead: unknown = null;
                // The store exactly as it is, with the reversal landing after the scope read and before the claim.
                const racing: AiCreditOutboxStore = { ...store, accountFor: async () => ACCOUNT,
                    topupScope: async input => { scopeRead = await store.topupScope!(input); return scopeRead as Awaited<ReturnType<NonNullable<AiCreditOutboxStore['topupScope']>>>; },
                    claim: async (now, claimScope) => {
                        await billing.enqueueOutbox(aiCreditRevokeItem(receipt, cause));
                        return store.claim(now, claimScope);
                    } };
                expect(await deliverPaidTopup({ config: CONFIG, aiCredits: racing }, { paymentIntentId: intent, userId, fetch: g.fetcher, clock: () => NOW })).toBe('queued');
                // The scope read saw a deliverable receipt; the claim refused it.
                expect(scopeRead).toEqual(scope);
                expect(g.fetcher).not.toHaveBeenCalled();
                expect(g.balance(ACCOUNT)).toBe(BigInt(0));
                const untouched = await receiptOf(intent);
                expect(untouched).toMatchObject({ kind: 'ai_grant', attempts: 0, deliveredAt: null, lastError: null });
                expect((untouched.payload as Record<string, unknown>).delivery).toBeUndefined();
                expect((untouched.payload as Record<string, unknown>).accountPublicId).toBeUndefined();
                // Every later request finds no scope at all, so a webhook redelivery ends 2xx and a poll stays "processing".
                expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: g.fetcher, clock: () => NOW + 60_000 })).toBe('skipped');
                expect(g.fetcher).not.toHaveBeenCalled();
            }
        });

        it('the sole-receipt rule is the paid top-up scope\'s only: a plain scope and the sweep still claim a grant that has a reversal beside it', async () => {
            const { receipt, scope } = await paid();
            await billing.enqueueOutbox(aiCreditRevokeItem(receipt, { type: 'refund', id: 're_ordered' }));
            expect(await store.claim(NOW, scope)).toBeNull();
            // The same row, without the rule (the Free starter's scope shape): claimed.
            const plain = (await store.claim(NOW, { userId, eventKey: receipt.eventKey, kind: 'ai_grant' }))!;
            expect(plain).toMatchObject({ eventKey: receipt.eventKey, attempts: 1 });
            await store.finish(plain, { status: 'retry', reason: 'http_503', nextAttemptAt: NOW }, NOW);
            // The sweep (no scope) delivers both rows, as before this change.
            const kinds: string[] = [];
            for (let pass = 0; pass < 2; pass++) {
                const row = (await store.claim(NOW))!;
                kinds.push(row.kind);
                await store.finish(row, { status: 'done', reason: null }, NOW);
            }
            expect(kinds.sort()).toEqual(['ai_grant', 'ai_revoke']);
            expect(await store.claim(NOW + 86_400_000)).toBeNull();
        });

        it('a terminal refusal ends in review with the receipt failed; no later request reopens it', async () => {
            const { intent, scope } = await paid();
            const conflict = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'event_conflict' } }, { status: 409 }));
            const alert = vi.spyOn(console, 'error').mockImplementation(() => {});
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, fetch: conflict, clock: () => NOW })).toBe('review');
            expect(await receiptOf(intent)).toMatchObject({ deliveredAt: null, attempts: 1, lastError: 'event_conflict',
                payload: expect.objectContaining({ delivery: { status: 'failed', nextAttemptAt: null } }) });
            expect(alert).toHaveBeenCalledTimes(1);
            expect(await store.topupScope!({ paymentIntentId: intent })).toBeNull();
            const g = gateway();
            expect(await deliverPaidTopup(deps(), { paymentIntentId: intent, userId, fetch: g.fetcher, clock: () => NOW + 86_400_000 })).toBe('skipped');
            expect(await store.claim(NOW + 86_400_000, scope)).toBeNull();
            expect(g.fetcher).not.toHaveBeenCalled();
        });

        describe('through the signed webhook alone: the payer closed every tab and no sweep runs', () => {
            const SECRET = 'fixture-only-webhook-secret';
            const sign = (body: string, at: number) => new Request('https://app.example/api/billing/stripe/webhook', { method: 'POST', body,
                headers: { 'stripe-signature': `t=${Math.floor(at / 1000)},v1=${createHmac('sha256', SECRET).update(`${Math.floor(at / 1000)}.${body}`).digest('hex')}` } });

            /** One paid custom top-up checkout of this user, as Stripe reports it and as its webhook event carries it. */
            async function checkout(g: ReturnType<typeof gateway>, aiCredits: AiCreditOutboxStore = { ...store, accountFor: async () => ACCOUNT }) {
                const intent = `pi_${randomUUID().replaceAll('-', '')}`, customer = `cus_${userId.replaceAll('-', '')}`;
                await billing.linkCustomer(userId, customer);
                const retrieveCheckoutSession = vi.fn<StripeApi['retrieveCheckoutSession']>(async () => ({ id: 'cs_fixture', customer, clientReferenceId: userId,
                    mode: 'payment', status: 'complete', paymentStatus: 'paid', paymentIntentId: intent, sku: 'ai_custom_v2', amountTotal: 2500, currency: 'usd',
                    metadataCredits: '250', trialId: null }));
                const body = JSON.stringify({ id: `evt_${intent.slice(3)}`, type: 'checkout.session.completed', created: Math.floor(NOW / 1000), livemode: false,
                    data: { object: { id: 'cs_fixture', mode: 'payment', payment_status: 'paid', payment_intent: intent, customer, client_reference_id: userId } } });
                const hookDeps: BillingDeps = { usage: null, store: billing, aiCredits, stripe: { retrieveCheckoutSession } as unknown as StripeApi, now: () => new Date(),
                    config: readBillingConfig({ STRIPE_SECRET: 'sk_test_fixture', STRIPE_WEBHOOK_SECRET: SECRET, BILLING_FUNDING_URL: CONFIG.fundingUrl,
                        BILLING_FUNDING_HMAC_SECRET: CONFIG.fundingHmacSecret }) };
                vi.stubGlobal('fetch', g.fetcher);
                /** Stripe signs every delivery attempt afresh over the same body. */
                const deliver = async (at: number) => {
                    vi.setSystemTime(at);
                    const response = await handleStripeWebhook(sign(body, at), hookDeps, processStripeEvent);
                    return [response.status, await response.json()] as const;
                };
                const ledger = () => db.select().from(billingGrants).where(eq(billingGrants.sourceId, intent));
                return { intent, deliver, retrieveCheckoutSession, ledger };
            }
            beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); });
            afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

            it('healthy: the first delivery commits the receipt, funds the exact account once and answers 2xx', async () => {
                const g = gateway();
                const c = await checkout(g);
                expect(await c.deliver(NOW)).toEqual([200, { received: true }]);
                expect(g.fetcher).toHaveBeenCalledTimes(1);
                expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
                expect(await receiptOf(c.intent)).toMatchObject({ deliveredAt: new Date(NOW), attempts: 1 });
                expect(await c.ledger()).toHaveLength(1);
                expect(await c.deliver(NOW + 5_000)).toEqual([200, { received: true, duplicate: true }]);
                expect(g.fetcher).toHaveBeenCalledTimes(1);
            });

            it.each([
                ['the Gateway is unreachable', (g: ReturnType<typeof gateway>) => g.failNext(1), BigInt(0)],
                ['the Gateway applied the grant but its acknowledgement was lost', (g: ReturnType<typeof gateway>) => g.loseNext(1), CREDITS_MICRO],
            ] as const)('pending exit, %s: 503 until the same signed event is redelivered after the backoff, then exactly one grant and a final 2xx', async (_name, fault, afterFirst) => {
                const g = gateway();
                fault(g);
                const c = await checkout(g);
                expect(await c.deliver(NOW)).toEqual([503, { error: 'delivery_pending' }]);
                expect(g.balance(ACCOUNT)).toBe(afterFirst);
                // Committed once, marked processed, receipt pending under its stored backoff.
                expect(await c.ledger()).toHaveLength(1);
                expect(await receiptOf(c.intent)).toMatchObject({ deliveredAt: null, attempts: 1,
                    payload: expect.objectContaining({ accountPublicId: ACCOUNT, delivery: { status: 'retry', nextAttemptAt: NOW + 60_000 } }) });
                const stripeReads = c.retrieveCheckoutSession.mock.calls.length;
                // A redelivery inside the backoff sends nothing and stays pending.
                expect(await c.deliver(NOW + 30_000)).toEqual([503, { error: 'delivery_pending' }]);
                expect(g.fetcher).toHaveBeenCalledTimes(1);
                expect(await c.deliver(NOW + 60_000)).toEqual([200, { received: true, duplicate: true }]);
                expect(g.fetcher).toHaveBeenCalledTimes(2);
                expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
                expect(g.balance(OTHER_ACCOUNT)).toBe(BigInt(0));
                expect(await receiptOf(c.intent)).toMatchObject({ deliveredAt: new Date(NOW + 60_000), attempts: 2, lastError: null });
                // The charge and the ledger were never rerun, and nothing is left to redeliver.
                expect(c.retrieveCheckoutSession).toHaveBeenCalledTimes(stripeReads);
                expect(await c.ledger()).toHaveLength(1);
                expect(await c.deliver(NOW + 120_000)).toEqual([200, { received: true, duplicate: true }]);
                expect(g.fetcher).toHaveBeenCalledTimes(2);
            });

            it('partial storage outage: the Gateway applied but the receipt could not be finished; the lease keeps the state and the redelivery funds nothing twice', async () => {
                const g = gateway();
                let outage = true;
                const c = await checkout(g, { ...store, accountFor: async () => ACCOUNT,
                    finish: async (...args) => { if (outage) { outage = false; throw new Error('db down'); } return store.finish(...args); } });
                expect(await c.deliver(NOW)).toEqual([503, { error: 'delivery_pending' }]);
                expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
                expect(await receiptOf(c.intent)).toMatchObject({ deliveredAt: null, attempts: 1,
                    payload: expect.objectContaining({ accountPublicId: ACCOUNT, delivery: expect.objectContaining({ status: 'processing', nextAttemptAt: NOW + 30_000 }) }) });
                expect(await c.deliver(NOW + 10_000)).toEqual([503, { error: 'delivery_pending' }]);
                expect(g.fetcher).toHaveBeenCalledTimes(1);
                expect(await c.deliver(NOW + 30_000)).toEqual([200, { received: true, duplicate: true }]);
                expect(g.fetcher).toHaveBeenCalledTimes(2);
                expect(g.balance(ACCOUNT)).toBe(CREDITS_MICRO);
                expect(await receiptOf(c.intent)).toMatchObject({ deliveredAt: new Date(NOW + 30_000), attempts: 2 });
            });

            it('permanent exit: a refused paid entitlement answers a terminal 2xx with one sanitized alert, and a redelivery does not loop', async () => {
                const g = gateway();
                const refused = vi.fn<typeof fetch>(async () => Response.json({ error: { code: 'event_conflict', message: 'provider body' } }, { status: 409 }));
                const c = await checkout(g);
                vi.stubGlobal('fetch', refused);
                const alert = vi.spyOn(console, 'error').mockImplementation(() => {});
                expect(await c.deliver(NOW)).toEqual([200, { received: true }]);
                expect(await receiptOf(c.intent)).toMatchObject({ deliveredAt: null, lastError: 'event_conflict',
                    payload: expect.objectContaining({ delivery: { status: 'failed', nextAttemptAt: null } }) });
                expect(alert.mock.calls.map(call => JSON.parse(String(call[0])))).toEqual([{ event: 'ai-topup-delivery-alert', alert: 'paid_topup_not_credited', reason: 'event_conflict' }]);
                const logged = alert.mock.calls.map(call => String(call[0])).join('\n');
                for (const needle of [c.intent, userId, ACCOUNT, 'cs_fixture', 'cus_', 'provider body']) expect(logged).not.toContain(needle);
                expect(await c.deliver(NOW + 3_600_000)).toEqual([200, { received: true, duplicate: true }]);
                expect(refused).toHaveBeenCalledTimes(1);
                expect(alert).toHaveBeenCalledTimes(1);
                expect(await c.ledger()).toHaveLength(1);
            });

            it('a refund that lands while the receipt is pending ends the redelivery 2xx without funding it', async () => {
                const g = gateway();
                g.failNext(1);
                const c = await checkout(g);
                expect(await c.deliver(NOW)).toEqual([503, { error: 'delivery_pending' }]);
                const pending = await receiptOf(c.intent);
                await billing.enqueueOutbox(aiCreditRevokeItem({ eventKey: pending.eventKey, userId, kind: 'ai_grant', payload: pending.payload as Record<string, unknown> },
                    { type: 'refund', id: 're_fixture' }));
                expect(await c.deliver(NOW + 60_000)).toEqual([200, { received: true, duplicate: true }]);
                expect(g.fetcher).toHaveBeenCalledTimes(1);
                expect(g.balance(ACCOUNT)).toBe(BigInt(0));
            });
        });

        it('no charge, no receipt, no delivery: an unknown payment, a receipt without its ledger grant, a colliding second receipt, a non-top-up grant', async () => {
            const g = gateway();
            const attempt = (paymentIntentId: string) => deliverPaidTopup(deps(), { paymentIntentId, fetch: g.fetcher, clock: () => NOW });
            // A checkout that was never paid wrote nothing for its payment.
            expect(await store.topupScope!({ paymentIntentId: 'pi_neverpaid' })).toBeNull();
            expect(await attempt('pi_neverpaid')).toBe('skipped');
            for (const malformed of ['', 'cs_fixture', 'pi_bad id', "pi_x' or '1'='1"]) expect(await store.topupScope!({ paymentIntentId: malformed })).toBeNull();
            // A receipt row with no ledger grant behind it (not what recordAiTopup writes).
            const orphan = aiTopupOutboxItem(userId, customTopupPack(2500)!, 'pi_orphanreceipt', end)!;
            await billing.enqueueOutbox(orphan);
            expect(await store.topupScope!({ paymentIntentId: 'pi_orphanreceipt' })).toBeNull();
            // Two receipt rows naming one payment (a collision recordAiTopup refuses): neither is delivered from a request.
            const { intent } = await paid();
            await billing.enqueueOutbox({ ...orphan, eventKey: `ezil-os:v1:topup:ai_custom_v2:pi_collision:grant`,
                payload: { ...orphan.payload, entitlementId: 'ezil-os:v1:topup:ai_custom_v2:pi_collision', eventId: 'ezil-os:v1:topup:ai_custom_v2:pi_collision:grant', paymentIntentId: intent } });
            expect(await store.topupScope!({ paymentIntentId: intent })).toBeNull();
            expect(await attempt(intent)).toBe('skipped');
            // A plan-period grant is the sweep's, whatever payment it names.
            await billing.enqueueOutbox(item());
            expect(await attempt('pi_orphanreceipt')).toBe('skipped');
            expect(g.fetcher).not.toHaveBeenCalled();
            expect((await rows()).every(row => row.attempts === 0 && row.deliveredAt === null)).toBe(true);
        });
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

    it('a paid top-up claim is ordered against a reversal in flight by the root lock: no claim while it is held, never a wait', async () => {
        const client = postgres(process.env.BILLING_TEST_DATABASE_URL!, {
            max: 2, prepare: false, connection: { statement_timeout: 1000 },
        });
        const db = drizzle(client, { schema });
        const billing = createBillingStore(db), store = createAiCreditOutboxStore(db), userId = randomUUID();
        const receipt = aiTopupOutboxItem(userId, customTopupPack(2500)!, `pi_${userId.replaceAll('-', '')}`, end)!;
        const root = String(receipt.payload.entitlementId);
        const scope = { userId, eventKey: receipt.eventKey, kind: 'ai_grant' as const, soleReceipt: true as const };
        try {
            await db.insert(authUsers).values({ id: userId });
            await billing.enqueueOutbox(receipt);
            // A reversal being written (`recordAiReversal` takes this lock first) on another connection.
            await client.begin(async tx => {
                await tx`select pg_advisory_xact_lock(hashtextextended(${`billing:ai_root:${root}`}, 0))`;
                const started = Date.now();
                expect(await store.claim(NOW, scope)).toBeNull();
                expect(Date.now() - started).toBeLessThan(900);
                // Its row is written but not committed yet: invisible to the claim, which the lock alone still refuses.
                await tx`insert into ezil_billing_outbox (event_key, user_id, kind, payload) values (${`${root}:revoke:refund:re_inflight`},
                    ${userId}::uuid, 'ai_revoke', (${JSON.stringify(aiCreditRevokeItem(receipt, { type: 'refund', id: 're_inflight' }).payload)}::text)::jsonb)`;
                expect(await store.claim(NOW, scope)).toBeNull();
            });
            // The reversal committed: the claim is free to run and now refuses on what it reads.
            expect(await store.claim(NOW, scope)).toBeNull();
            expect((await db.select().from(billingOutbox).where(eq(billingOutbox.eventKey, receipt.eventKey)))[0]).toMatchObject({ attempts: 0, deliveredAt: null });
            // Without the reversal the same scoped claim takes the row once the lock is free.
            await db.delete(billingOutbox).where(eq(billingOutbox.eventKey, `${root}:revoke:refund:re_inflight`));
            expect(await store.claim(NOW, scope)).toMatchObject({ userId, eventKey: receipt.eventKey, attempts: 1 });
        } finally {
            await db.delete(authUsers).where(eq(authUsers.id, userId));
            await client.end();
        }
    });
});
