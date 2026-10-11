import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRO_PLAN } from './catalog';
import type {
    BillingStore, GrantInsert, GrantRow, GrantSource, OutboxInsert, ProcessorDeps,
    StorageSample, StripeApi, StripeCharge, StripeCheckoutSession, StripeInvoice,
    StripeSubscription, SubscriptionUpsert, UsageEvent,
} from './ports';
import { ingestUsageEvents, processStripeEvent } from './processor';
import type { StripeEventLike } from './stripe/events';

const now = new Date('2026-10-11T12:00:00.000Z');
const periodStart = new Date('2026-10-01T00:00:00.000Z');
const periodEnd = new Date('2026-11-01T00:00:00.000Z');

type Interval = {
    userId: string; computerId: string; startedAt: Date; lastSeenAt: Date;
    endedAt: Date | null; source: string; reason?: string;
};

/** Match the database's unique keys so replay tests exercise persisted effects. */
class MemoryStore implements BillingStore {
    customers = new Map<string, string>([['cus_local', 'user_local']]);
    computers = new Map<string, string>([['computer_local', 'user_local']]);
    subscriptions = new Map<string, SubscriptionUpsert>();
    grants = new Map<string, GrantRow>();
    outbox = new Map<string, OutboxInsert>();
    intervals: Interval[] = [];
    samples: (StorageSample & { userId: string; source: string })[] = [];
    writes: string[] = [];
    owners: string[] = [];
    sourceReads: string[] = [];
    usageCalls: string[] = [];

    async stripeCustomerFor(userId: string) {
        return [...this.customers].find(([, user]) => user === userId)?.[0] ?? null;
    }
    async userForStripeCustomer(customer: string) {
        this.owners.push(customer);
        return this.customers.get(customer) ?? null;
    }
    async subscriptionsFor(userId: string) {
        return [...this.subscriptions.values()].filter(row => row.userId === userId);
    }
    async intervalsFor(userId: string, since: Date) {
        return this.intervals.filter(row => row.userId === userId && (row.endedAt === null || row.endedAt >= since));
    }
    async latestStorageFor(userId: string) {
        const latest = new Map<string, StorageSample>();
        for (const sample of this.samples.filter(row => row.userId === userId)) {
            if (!latest.has(sample.computerId) || latest.get(sample.computerId)!.measuredAt < sample.measuredAt) {
                latest.set(sample.computerId, sample);
            }
        }
        return [...latest.values()];
    }
    async grantsBySource(sourceType: GrantSource, sourceId: string) {
        this.sourceReads.push(`${sourceType}:${sourceId}`);
        return [...this.grants.values()].filter(row => row.sourceType === sourceType && row.sourceId === sourceId);
    }
    async computerOwner(computerId: string) { return this.computers.get(computerId) ?? null; }
    async linkCustomer(userId: string, customer: string): Promise<'linked' | 'exists' | 'conflict'> {
        const owner = this.customers.get(customer);
        if (owner === userId) return 'exists';
        if (owner !== undefined || await this.stripeCustomerFor(userId) !== null) return 'conflict';
        this.customers.set(customer, userId);
        this.writes.push('customer');
        return 'linked';
    }
    async recordEvent() { return 'new' as const; }
    async markEventProcessed() {}
    async upsertSubscription(row: SubscriptionUpsert): Promise<'applied' | 'stale'> {
        const previous = this.subscriptions.get(row.stripeSubscriptionId);
        if (previous && previous.stripeEventCreated > row.stripeEventCreated) return 'stale';
        if (JSON.stringify(previous) !== JSON.stringify(row)) {
            this.subscriptions.set(row.stripeSubscriptionId, { ...row });
            this.writes.push('subscription');
        }
        return 'applied';
    }
    async insertGrant(grant: GrantInsert): Promise<'inserted' | 'duplicate'> {
        const key = [grant.sourceType, grant.sourceId, grant.meter, grant.kind].join(':');
        if (this.grants.has(key)) return 'duplicate';
        this.grants.set(key, { ...grant, id: key, createdAt: now });
        this.writes.push(key);
        return 'inserted';
    }
    async enqueueOutbox(item: OutboxInsert): Promise<'queued' | 'duplicate'> {
        if (this.outbox.has(item.eventKey)) return 'duplicate';
        this.outbox.set(item.eventKey, item);
        this.writes.push(item.eventKey);
        return 'queued';
    }
    async openInterval(userId: string, computerId: string, at: Date, source: string) {
        this.usageCalls.push(`open:${source}`);
        if (!this.intervals.some(row => row.computerId === computerId && row.endedAt === null)) {
            this.intervals.push({ userId, computerId, startedAt: at, lastSeenAt: at, endedAt: null, source });
        }
    }
    async touchInterval(computerId: string, at: Date) {
        this.usageCalls.push('touch');
        const interval = this.intervals.find(row => row.computerId === computerId && row.endedAt === null);
        if (interval && at > interval.lastSeenAt) interval.lastSeenAt = at;
    }
    async closeInterval(computerId: string, at: Date, reason: string) {
        this.usageCalls.push(`close:${reason}`);
        const interval = this.intervals.find(row => row.computerId === computerId && row.endedAt === null);
        if (interval) { interval.endedAt = at; interval.reason = reason; }
    }
    async insertStorageSample(userId: string, sample: StorageSample & { source: string }) {
        this.samples.push({ userId, ...sample });
    }
    async closeStaleIntervals(staleBefore: Date, reason: string) {
        const stale = this.intervals.filter(row => row.endedAt === null && row.lastSeenAt < staleBefore);
        for (const row of stale) await this.closeInterval(row.computerId, row.lastSeenAt, reason);
        return stale.length;
    }
}

class MemoryStripe implements StripeApi {
    reads: string[] = [];
    subscription: StripeSubscription = {
        id: 'sub_local', customer: 'cus_local', sku: PRO_PLAN.sku, status: 'active',
        cancelAtPeriodEnd: false, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd,
    };
    invoice: StripeInvoice = {
        id: 'in_local', customer: 'cus_local', status: 'paid', subscriptionId: 'sub_local', periodStart, periodEnd,
    };
    session: StripeCheckoutSession = {
        id: 'cs_local', customer: 'cus_local', clientReferenceId: 'user_local',
        mode: 'payment', status: 'complete', paymentStatus: 'paid', paymentIntentId: 'pi_local', sku: 'ai_pack_10_v1',
    };
    charge: StripeCharge = {
        id: 'ch_local', customer: 'cus_local', invoiceId: null, paymentIntentId: 'pi_local',
        amount: 1084, amountRefunded: 1084, refunded: true,
    };
    async createCustomer(): Promise<never> { throw new Error('Unexpected createCustomer'); }
    async createCheckoutSession(): Promise<never> { throw new Error('Unexpected createCheckoutSession'); }
    async createPortalSession(): Promise<never> { throw new Error('Unexpected createPortalSession'); }
    async retrieveSubscription(id: string) { this.reads.push(`subscription:${id}`); return this.subscription; }
    async retrieveInvoice(id: string) { this.reads.push(`invoice:${id}`); return this.invoice; }
    async retrieveCheckoutSession(id: string) { this.reads.push(`session:${id}`); return this.session; }
    async retrieveCharge(id: string) { this.reads.push(`charge:${id}`); return this.charge; }
}

function fixture() {
    const store = new MemoryStore();
    const stripe = new MemoryStripe();
    const deps: ProcessorDeps = { store, stripe, now: () => new Date(now) };
    return { store, stripe, deps };
}

function event(type: string, object: Record<string, unknown>): StripeEventLike {
    return { id: 'evt_local', type, created: now.getTime() / 1000, livemode: false, data: { object } };
}
function checkout(link = true) {
    return event(link ? 'checkout.session.completed' : 'checkout.session.async_payment_succeeded', {
        id: 'cs_local', customer: 'cus_payload', client_reference_id: 'user_local',
        mode: 'payment', payment_status: 'paid', payment_intent: 'pi_payload',
    });
}
function invoice() {
    return event('invoice.paid', {
        id: 'in_local', customer: 'cus_payload', subscription: 'sub_payload',
        lines: { data: [{ period: { start: 100, end: 200 } }] },
    });
}
function sync() { return event('customer.subscription.updated', { id: 'sub_local' }); }
function refund() {
    return event('charge.refunded', { id: 'ch_local', refunds: { data: [{ id: 're_local' }] } });
}
function dispute(restore = false) {
    return event(restore ? 'charge.dispute.closed' : 'charge.dispute.created', {
        id: 'dp_local', charge: 'ch_local', status: 'won',
    });
}
async function seedTopup(store: MemoryStore) {
    await store.insertGrant({
        userId: 'user_local', meter: 'ai_usd_micro', kind: 'topup', amount: BigInt(10_000_000),
        sourceType: 'payment_intent', sourceId: 'pi_local', periodStart, periodEnd,
    });
}

afterEach(() => vi.restoreAllMocks());

describe('processStripeEvent', () => {
    it('links only a re-read server checkout and applies the subsequent top-up in order', async () => {
        const { store, stripe, deps } = fixture();
        store.customers.clear();
        expect(await processStripeEvent(checkout(), deps)).toBe('applied');
        expect(store.customers.get('cus_local')).toBe('user_local');
        expect(store.owners).toEqual(['cus_local']);
        expect(store.writes[0]).toBe('customer');
        expect(stripe.reads).toEqual(['session:cs_local', 'session:cs_local']);
        expect([...store.grants.values()][0]).toMatchObject({ userId: 'user_local', sourceId: 'pi_local' });
    });

    it.each([
        ['missing server sku', { sku: null }, 'review:unknown_sku'],
        ['changed reference', { clientReferenceId: 'someone_else' }, 'review:client_reference_mismatch'],
        ['missing customer', { customer: null }, 'unattributed:customer'],
    ] as const)('refuses linking for %s, with a valid checkout control', async (_, fields, outcome) => {
        const good = fixture();
        good.store.customers.clear();
        expect(await processStripeEvent(checkout(), good.deps)).toBe('applied');
        expect(good.store.customers.size).toBe(1);
        const bad = fixture();
        bad.store.customers.clear();
        Object.assign(bad.stripe.session, fields);
        expect(await processStripeEvent(checkout(), bad.deps)).toBe(outcome);
        expect(bad.store.writes).toEqual([]);
    });

    it('preserves the first review outcome while later actions use the existing customer owner', async () => {
        const good = fixture();
        expect(await processStripeEvent(checkout(), good.deps)).toBe('applied');
        expect(good.store.grants.size).toBe(1);
        const bad = fixture();
        bad.store.customers.set('cus_local', 'existing_owner');
        expect(await processStripeEvent(checkout(), bad.deps)).toBe('review:customer_conflict');
        expect(bad.store.customers.get('cus_local')).toBe('existing_owner');
        expect([...bad.store.grants.values()][0].userId).toBe('existing_owner');
    });

    it('grants an invoice before checkout delivery using the mapping created at checkout creation', async () => {
        const { store, stripe, deps } = fixture();
        expect(await processStripeEvent(invoice(), deps)).toBe('applied');
        expect(stripe.reads).toEqual(['invoice:in_local', 'subscription:sub_local']);
        expect(store.owners).toEqual(['cus_local']);
        expect([...store.grants.values()]).toEqual([expect.objectContaining({
            userId: 'user_local', meter: 'workspace_seconds', kind: 'pro_period',
            amount: BigInt(PRO_PLAN.workspaceSeconds), periodStart, periodEnd,
            sourceType: 'invoice', sourceId: 'in_local',
        })]);
        expect(store.subscriptions.get('sub_local')).toMatchObject({
            status: 'active', sku: PRO_PLAN.sku, stripeEventCreated: now, currentPeriodStart: periodStart,
        });
        expect(store.outbox.get('invoice:in_local:ai_included')).toEqual({
            eventKey: 'invoice:in_local:ai_included', userId: 'user_local', kind: 'ai_grant',
            payload: { amountUsdMicro: '3000000', bucket: 'included', periodStart: periodStart.toISOString(),
                periodEnd: periodEnd.toISOString(), provider: 'stripe', providerObjectId: 'in_local' },
        });
        expect(await processStripeEvent(checkout(), deps)).toBe('applied');
    });

    it.each([
        { status: 'open' }, { subscriptionId: null },
    ])('ignores an invoice that is no longer a paid subscription invoice: %j', async fields => {
        const good = fixture();
        expect(await processStripeEvent(invoice(), good.deps)).toBe('applied');
        expect(good.store.grants.size).toBe(1);
        const bad = fixture();
        Object.assign(bad.stripe.invoice, fields);
        expect(await processStripeEvent(invoice(), bad.deps)).toBe('ignored');
        expect(bad.store.writes).toEqual([]);
    });

    it.each([null, 'unrecognized_v1'])('reviews unknown subscription sku %s', async sku => {
        for (const input of [invoice(), sync()]) {
            const good = fixture();
            expect(await processStripeEvent(input, good.deps)).toBe('applied');
            expect(good.store.subscriptions.size).toBe(1);
            const bad = fixture();
            bad.stripe.subscription.sku = sku;
            expect(await processStripeEvent(input, bad.deps)).toBe('review:unknown_sku');
            expect(bad.store.writes).toEqual([]);
        }
    });

    it.each([
        { periodStart: null }, { periodEnd: null }, { periodEnd: periodStart },
        { periodStart: new Date('invalid') },
    ])('reviews invalid re-read periods without retrying: %j', async fields => {
        const good = fixture();
        expect(await processStripeEvent(invoice(), good.deps)).toBe('applied');
        expect(good.store.outbox.size).toBe(1);
        const bad = fixture();
        Object.assign(bad.stripe.invoice, fields);
        expect(await processStripeEvent(invoice(), bad.deps)).toBe('review:invalid_period');
        expect(bad.store.writes).toEqual([]);
    });

    it('reviews mismatched invoice and subscription customers', async () => {
        const good = fixture();
        expect(await processStripeEvent(invoice(), good.deps)).toBe('applied');
        expect(good.store.grants.size).toBe(1);
        const bad = fixture();
        bad.stripe.subscription.customer = 'cus_foreign';
        expect(await processStripeEvent(invoice(), bad.deps)).toBe('review:customer_mismatch');
        expect(bad.store.writes).toEqual([]);
    });

    it.each([invoice, sync, () => checkout(false), refund, dispute, () => dispute(true)])(
        'never attributes a foreign customer through payload metadata %#', async makeEvent => {
            const good = fixture();
            await seedTopup(good.store);
            expect(await processStripeEvent(makeEvent(), good.deps)).toBe('applied');
            expect(good.store.owners).toEqual(['cus_local']);
            const bad = fixture();
            await seedTopup(bad.store);
            bad.store.customers.clear();
            const before = [...bad.store.writes];
            const input = makeEvent();
            input.data.object.metadata = { user_id: 'user_local' };
            expect(await processStripeEvent(input, bad.deps)).toBe('unattributed:customer');
            expect(bad.store.writes).toEqual(before);
        },
    );

    it('never reads metadata from the event or re-read provider objects', async () => {
        const { stripe, deps, store } = fixture();
        const input = checkout();
        for (const object of [input.data.object, stripe.session]) {
            Object.defineProperty(object, 'metadata', { get() { throw new Error('metadata read'); } });
        }
        expect(await processStripeEvent(input, deps)).toBe('applied');
        expect([...store.grants.values()][0].userId).toBe('user_local');
        const missingReference = checkout();
        missingReference.data.object.client_reference_id = null;
        missingReference.data.object.metadata = { user_id: 'user_local' };
        const unlinked = fixture();
        unlinked.store.customers.clear();
        expect(await processStripeEvent(missingReference, unlinked.deps)).toBe('unattributed:customer');
        expect(unlinked.store.writes).toEqual([]);
    });

    it.each(['customer.subscription.created', 'customer.subscription.updated', 'customer.subscription.deleted', 'invoice.payment_failed'])(
        'syncs re-read state for %s and accepts stale delivery', async type => {
            const { store, stripe, deps } = fixture();
            stripe.subscription.status = 'past_due';
            stripe.subscription.cancelAtPeriodEnd = true;
            const input = event(type, { id: 'sub_local', subscription: 'sub_local', status: 'active' });
            expect(await processStripeEvent(input, deps)).toBe('applied');
            expect(store.subscriptions.get('sub_local')).toMatchObject({ status: 'past_due', cancelAtPeriodEnd: true, stripeEventCreated: now });
            const writes = [...store.writes];
            stripe.subscription.status = 'active';
            expect(await processStripeEvent({ ...input, created: input.created - 1 }, deps)).toBe('applied');
            expect(store.writes).toEqual(writes);
            expect(store.subscriptions.get('sub_local')?.status).toBe('past_due');
        },
    );

    it.each([['ai_pack_10_v1', '10000000'], ['ai_pack_25_v1', '25000000']])('credits %s at face value', async (sku, amount) => {
        const { stripe, store, deps } = fixture();
        stripe.session.sku = sku;
        expect(await processStripeEvent(checkout(false), deps)).toBe('applied');
        expect([...store.grants.values()][0]).toMatchObject({ meter: 'ai_usd_micro', kind: 'topup', amount: BigInt(amount), sourceId: 'pi_local' });
        expect(store.outbox.get('payment_intent:pi_local:ai_topup')).toMatchObject({
            kind: 'ai_grant', payload: { amountUsdMicro: amount, bucket: 'purchased', expiresAt: '2027-10-11T12:00:00.000Z', providerObjectId: 'pi_local' },
        });
    });

    it('uses a stable twelve-month expiry for a delayed leap-day purchase', async () => {
        const { store, deps } = fixture();
        const input = { ...checkout(false), created: Date.parse('2024-02-29T12:00:00Z') / 1000 };
        expect(await processStripeEvent(input, deps)).toBe('applied');
        expect(store.outbox.get('payment_intent:pi_local:ai_topup')?.payload.expiresAt).toBe('2025-02-28T12:00:00.000Z');
    });

    it.each([
        [{ mode: 'subscription' }, 'ignored'], [{ mode: 'setup' }, 'ignored'],
        [{ paymentStatus: 'unpaid' }, 'ignored'], [{ paymentStatus: 'no_payment_required' }, 'ignored'],
        [{ sku: null }, 'review:unknown_sku'], [{ sku: PRO_PLAN.sku }, 'review:unknown_sku'],
        [{ sku: 'unknown_pack' }, 'review:unknown_sku'], [{ paymentIntentId: null }, 'review:missing_payment_intent'],
        [{ customer: null }, 'unattributed:customer'],
    ] as const)('checks the re-read top-up facts %j', async (fields, outcome) => {
        const good = fixture();
        expect(await processStripeEvent(checkout(false), good.deps)).toBe('applied');
        expect(good.store.grants.size).toBe(1);
        const bad = fixture();
        Object.assign(bad.stripe.session, fields);
        expect(await processStripeEvent(checkout(false), bad.deps)).toBe(outcome);
        expect(bad.store.writes).toEqual([]);
    });

    it.each([['revoke', refund], ['suspend', dispute], ['restore', () => dispute(true)]] as const)(
        'appends %s with the original meter and period and queues its AI correction', async (kind, makeEvent) => {
            const { store, stripe, deps } = fixture();
            await seedTopup(store);
            expect(await processStripeEvent(makeEvent(), deps)).toBe('applied');
            expect(stripe.reads).toEqual(['charge:ch_local']);
            expect(store.sourceReads).toEqual(['payment_intent:pi_local']);
            expect([...store.grants.values()][1]).toMatchObject({
                kind, meter: 'ai_usd_micro', amount: BigInt(kind === 'restore' ? 10_000_000 : -10_000_000),
                periodStart, periodEnd, sourceType: kind === 'revoke' ? 'refund' : 'dispute',
                sourceId: kind === 'revoke' ? 're_local' : 'dp_local',
            });
            expect([...store.outbox.values()][0]).toMatchObject({
                eventKey: kind === 'revoke' ? 'refund:re_local:ai_revoke' : `dispute:dp_local:ai_${kind}`,
                kind: kind === 'restore' ? 'ai_grant' : 'ai_revoke', payload: { amountUsdMicro: '10000000' },
            });
        },
    );

    it('reverses an invoice workspace grant and its included AI credit', async () => {
        const { store, stripe, deps } = fixture();
        expect(await processStripeEvent(invoice(), deps)).toBe('applied');
        stripe.charge.invoiceId = 'in_local';
        expect(await processStripeEvent(refund(), deps)).toBe('applied');
        expect(store.sourceReads).toEqual(['invoice:in_local']);
        expect([...store.grants.values()][1]).toMatchObject({ meter: 'workspace_seconds', amount: -BigInt(PRO_PLAN.workspaceSeconds), periodStart, periodEnd });
        expect(store.outbox.get('refund:re_local:ai_revoke')).toMatchObject({ kind: 'ai_revoke', payload: { amountUsdMicro: '3000000', bucket: 'included' } });
    });

    it('requires a full refund before revoking', async () => {
        const { store, stripe, deps } = fixture();
        await seedTopup(store);
        const before = [...store.writes];
        stripe.charge.refunded = false;
        stripe.charge.amountRefunded = 100;
        expect(await processStripeEvent(refund(), deps)).toBe('review:partial_refund');
        expect(store.writes).toEqual(before);
        stripe.charge.refunded = true;
        stripe.charge.amountRefunded = stripe.charge.amount;
        expect(await processStripeEvent(refund(), deps)).toBe('applied');
        expect([...store.grants.values()][1].kind).toBe('revoke');
    });

    it.each([refund, dispute, () => dispute(true)])('reviews a correction with missing or mismatched originals %#', async makeEvent => {
        const { store, deps } = fixture();
        expect(await processStripeEvent(makeEvent(), deps)).toMatch(/^review:no_grant_for_/);
        expect(store.writes).toEqual([]);
        await seedTopup(store);
        const original = [...store.grants.values()][0];
        original.userId = 'another_user';
        const before = [...store.writes];
        expect(await processStripeEvent(makeEvent(), deps)).toBe('review:customer_mismatch');
        expect(store.writes).toEqual(before);
        original.userId = 'user_local';
        expect(await processStripeEvent(makeEvent(), deps)).toBe('applied');
        expect(store.grants.size).toBe(2);
    });

    it.each([checkout, invoice, sync, () => checkout(false), refund, dispute, () => dispute(true)])(
        'does not add persisted effects on duplicate delivery %#', async makeEvent => {
            const { store, deps } = fixture();
            const input = makeEvent();
            if (input.type.startsWith('charge.')) await seedTopup(store);
            expect(await processStripeEvent(input, deps)).toBe('applied');
            expect(store.writes.length).toBeGreaterThan(0);
            const writes = [...store.writes];
            expect(await processStripeEvent(input, deps)).toBe('applied');
            expect(store.writes).toEqual(writes);
        },
    );

    it('records both suspend and restore for the same dispute id', async () => {
        const { store, deps } = fixture();
        await seedTopup(store);
        expect(await processStripeEvent(dispute(), deps)).toBe('applied');
        expect(await processStripeEvent(dispute(true), deps)).toBe('applied');
        expect([...store.grants.values()].map(row => row.kind)).toEqual(['topup', 'suspend', 'restore']);
        expect([...store.grants.values()].reduce((sum, row) => sum + row.amount, BigInt(0))).toBe(BigInt(10_000_000));
    });

    it('applies every planned refund action and every original meter in order', async () => {
        const { store, stripe, deps } = fixture();
        expect(await processStripeEvent(invoice(), deps)).toBe('applied');
        await store.insertGrant({
            userId: 'user_local', meter: 'ai_usd_micro', kind: 'pro_period', amount: PRO_PLAN.aiIncludedMicro,
            periodStart, periodEnd, sourceType: 'invoice', sourceId: 'in_local',
        });
        stripe.charge.invoiceId = 'in_local';
        const input = refund();
        input.data.object.refunds = { data: [{ id: 're_first' }, { id: 're_second' }] };
        expect(await processStripeEvent(input, deps)).toBe('applied');
        expect([...store.grants.values()].filter(row => row.kind === 'revoke').map(row => [row.sourceId, row.meter])).toEqual([
            ['re_first', 'workspace_seconds'], ['re_first', 'ai_usd_micro'],
            ['re_second', 'workspace_seconds'], ['re_second', 'ai_usd_micro'],
        ]);
        expect([...store.outbox.keys()]).toEqual(['invoice:in_local:ai_included', 'refund:re_first:ai_revoke', 'refund:re_second:ai_revoke']);
        const before = [...store.writes];
        expect(await processStripeEvent(input, deps)).toBe('applied');
        expect(store.writes).toEqual(before);
    });

    it('propagates Stripe failures, including TypeError from a failed fetch, and succeeds on retry', async () => {
        const { stripe, deps, store } = fixture();
        const failure = new TypeError('fetch failed');
        vi.spyOn(stripe, 'retrieveInvoice').mockRejectedValueOnce(failure);
        await expect(processStripeEvent(invoice(), deps)).rejects.toBe(failure);
        expect(store.writes).toEqual([]);
        expect(await processStripeEvent(invoice(), deps)).toBe('applied');
        expect(store.grants.size).toBe(1);
    });

    it('repairs the outbox after a transient failure following the grant insert', async () => {
        const { store, deps } = fixture();
        const failure = new Error('database unavailable');
        vi.spyOn(store, 'enqueueOutbox').mockRejectedValueOnce(failure);
        await expect(processStripeEvent(invoice(), deps)).rejects.toBe(failure);
        expect(store.grants.size).toBe(1);
        expect(store.outbox.size).toBe(0);
        expect(await processStripeEvent(invoice(), deps)).toBe('applied');
        expect(store.grants.size).toBe(1);
        expect(store.outbox.size).toBe(1);
    });

    it('acknowledges unsupported and malformed events without writes', async () => {
        const good = fixture();
        expect(await processStripeEvent(invoice(), good.deps)).toBe('applied');
        expect(good.store.grants.size).toBe(1);
        const bad = fixture();
        expect(await processStripeEvent(event('ignored.event', {}), bad.deps)).toBe('ignored');
        expect(await processStripeEvent(event('invoice.paid', { subscription: 'sub_local' }), bad.deps)).toBe('review:invalid_event');
        expect(bad.store.writes).toEqual([]);
        expect(bad.stripe.reads).toEqual([]);
    });
});

describe('ingestUsageEvents', () => {
    beforeEach(() => { vi.spyOn(Date, 'now').mockReturnValue(now.getTime()); });

    function usage(type: 'start' | 'heartbeat' | 'stop', offset = 0): Extract<UsageEvent, { reason?: string }> {
        return { type, computerId: 'computer_local', at: new Date(now.getTime() + offset).toISOString() };
    }

    it('opens and touches starts/heartbeats, then closes with the supplied reason', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
        const { store } = fixture();
        expect(await ingestUsageEvents([usage('start'), usage('start'), usage('heartbeat', 60_000), {
            ...usage('stop', 120_000), reason: 'sleep',
        }], { store })).toEqual({ accepted: 4, rejected: 0 });
        expect(store.usageCalls).toEqual(['open:start', 'touch', 'open:start', 'touch', 'open:heartbeat', 'touch', 'close:sleep']);
        expect(store.intervals).toEqual([expect.objectContaining({
            userId: 'user_local', startedAt: now, lastSeenAt: new Date(now.getTime() + 60_000),
            endedAt: new Date(now.getTime() + 120_000), reason: 'sleep', source: 'start',
        })]);
    });

    it('recovers a missed start from a heartbeat and defaults the stop reason', async () => {
        const { store } = fixture();
        expect(await ingestUsageEvents([usage('heartbeat'), usage('stop')], { store })).toEqual({ accepted: 2, rejected: 0 });
        expect(store.intervals[0]).toMatchObject({ source: 'heartbeat', reason: 'stop', endedAt: now });
    });

    it.each(['start', 'stop', 'heartbeat', 'storage'] as const)('rejects an unknown computer for %s with a known-owner control', async type => {
        const { store } = fixture();
        const input: UsageEvent = type === 'storage'
            ? { type, computerId: 'computer_local', at: now.toISOString(), bytes: '1' }
            : usage(type);
        expect(await ingestUsageEvents([input], { store })).toEqual({ accepted: 1, rejected: 0 });
        const before = { calls: [...store.usageCalls], samples: [...store.samples] };
        expect(await ingestUsageEvents([{ ...input, computerId: 'unknown' }], { store })).toEqual({ accepted: 0, rejected: 1 });
        expect({ calls: store.usageCalls, samples: store.samples }).toEqual(before);
    });

    it.each(['invalid', '', '2026-10-11T12:05:00.001Z'])('rejects invalid or future timestamps %s and accepts the five-minute boundary', async at => {
        vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
        const { store } = fixture();
        expect(await ingestUsageEvents([{ ...usage('start'), at }], { store })).toEqual({ accepted: 0, rejected: 1 });
        expect(store.intervals).toEqual([]);
        expect(await ingestUsageEvents([usage('start', 300_000)], { store })).toEqual({ accepted: 1, rejected: 0 });
        expect(store.intervals).toHaveLength(1);
    });

    it.each(['-1', '1.5', '1e3', '+1', ' 1', '1 ', '1\n', '1\r\n', '', '0x10', 'NaN'])('rejects non-decimal storage %s with exact bigint and zero controls', async bytes => {
        const { store } = fixture();
        const input: UsageEvent = { type: 'storage', computerId: 'computer_local', at: now.toISOString(), bytes };
        expect(await ingestUsageEvents([input, { ...input, bytes: '0' }, { ...input, bytes: '9007199254740993' }], { store })).toEqual({ accepted: 2, rejected: 1 });
        expect(store.samples).toEqual([
            { userId: 'user_local', computerId: 'computer_local', bytes: BigInt(0), measuredAt: now, source: 'worker' },
            { userId: 'user_local', computerId: 'computer_local', bytes: BigInt('9007199254740993'), measuredAt: now, source: 'worker' },
        ]);
    });

    it('propagates a transient usage store error and accepts the retry', async () => {
        const { store } = fixture();
        const failure = new Error('database unavailable');
        vi.spyOn(store, 'computerOwner').mockRejectedValueOnce(failure);
        await expect(ingestUsageEvents([usage('start')], { store })).rejects.toBe(failure);
        expect(store.intervals).toEqual([]);
        expect(await ingestUsageEvents([usage('start')], { store })).toEqual({ accepted: 1, rejected: 0 });
        expect(store.intervals).toHaveLength(1);
    });
});
