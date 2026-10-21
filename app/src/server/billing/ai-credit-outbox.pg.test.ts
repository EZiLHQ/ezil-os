import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as schema from '@/server/db/schema';
import { authUsers, billingOutbox } from '@/server/db/schema';
import { aiCreditEntitlement, aiCreditOutboxItem } from './ai-credits';
import { createAiCreditOutboxStore } from './ai-credit-outbox-store';
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
    let client: ReturnType<typeof postgres>, db: Database, billing: BillingStore, store: AiCreditOutboxStore, userId: string;
    beforeAll(() => {
        client = postgres(process.env.BILLING_TEST_DATABASE_URL!, { max: 1, prepare: false });
        db = drizzle(client, { schema }); billing = createBillingStore(db); store = createAiCreditOutboxStore(db);
    });
    beforeEach(async () => { await client`begin`; userId = randomUUID(); await db.insert(authUsers).values({ id: userId }); });
    afterEach(async () => { await client`rollback`; });
    afterAll(async () => { await client?.end(); });
    const rows = () => db.select().from(billingOutbox).where(eq(billingOutbox.userId, userId));
    const item = (action: 'grant' | 'revoke' = 'grant') => aiCreditOutboxItem(userId, aiCreditEntitlement({ userId,
        sku: 'standard_monthly_v3', subscriptionId: `sub_${userId}`, periodStart: start, periodEnd: end, invoiceId: 'in' }), action, 'in');

    it('keeps one Free grant and its original expiry across later summaries', async () => {
        await enqueueFreeAiCredits(billing, userId, 'free_v3', new Date(NOW));
        await enqueueFreeAiCredits(billing, userId, 'free_v3', new Date(NOW + 86400000));
        expect(await rows()).toEqual([expect.objectContaining({ eventKey: `ezil-os:v1:free-once:${userId}:grant`,
            payload: expect.objectContaining({ expiresAt: '2027-10-21T00:00:00.000Z', credits: 500 }) })]);
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
        const paid = event('invoice.paid', { id: invoiceId, billing_reason: 'subscription_cycle',
            parent: { subscription_details: { subscription: subId } }, lines: { data: [] } });
        await processStripeEvent(paid, deps); await processStripeEvent(paid, deps);
        await processStripeEvent({ ...paid, id: `evt_${randomUUID()}` }, deps);
        expect(await rows()).toHaveLength(1);
        const reversal = kind === 'refund' ? event('charge.refunded', { id: 'charge', refunds: { data: [{ id: 'refund' }] } })
            : event('charge.dispute.created', { id: 'dispute', charge: 'charge', status: 'needs_response' });
        await processStripeEvent(reversal, deps); await processStripeEvent(reversal, deps);
        expect((await rows()).map(r => r.kind).sort()).toEqual(['ai_grant', 'ai_revoke']);
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
