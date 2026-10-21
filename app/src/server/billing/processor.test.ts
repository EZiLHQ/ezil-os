import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRO_PLAN } from './catalog';
import type {
    BillingStore, GrantInsert, GrantRow, GrantSource, OutboxInsert, ProcessorDeps,
    StorageSample, StripeApi, StripeCharge, StripeCheckoutSession, StripeInvoice, StripeInvoicePaymentState,
    StripeSubscription, SubscriptionUpsert, UsageEvent, OverageConsentRow, OverageInvoiceRow, PlanChangeRow, PaymentIssueRow, StoredComputeEpoch,
} from './ports';
import { ingestUsageEvents, processStripeEvent } from './processor';
import { createStripeClient } from './stripe/client';
import type { StripeEventLike } from './stripe/events';
import { CATALOG_V2, OVERAGE_PRICE_LOOKUP_KEY, OVERAGE_TERMS_VERSION } from './v2/contract';
import { upgradeGrantStdSeconds } from './v2/rating';

const now = new Date('2026-10-11T12:00:00.000Z');
const periodStart = new Date('2026-10-01T00:00:00.000Z');
const periodEnd = new Date('2026-11-01T00:00:00.000Z');

type Interval = {
    userId: string; computerId: string; startedAt: Date; lastSeenAt: Date;
    endedAt: Date | null; source: string; reason?: string;
};

/** Match the database's unique keys so replay tests exercise persisted effects. */
class MemoryStore implements BillingStore {
    epochs: StoredComputeEpoch[] = [];
    grantsForPeriod: BillingStore['grantsForPeriod'] = async () => { throw new Error('Unused v2 store stub'); };
    openEpoch: BillingStore['openEpoch'] = async input => {
        const existing = this.epochs.find(e => e.computerId === input.computerId && e.endedAt === null);
        if (existing) return { status: 'exists', epoch: existing };
        const concurrent = this.epochs.find(e => e.userId === input.userId && e.endedAt === null);
        if (concurrent) return { status: 'concurrent', epoch: concurrent };
        const epoch: StoredComputeEpoch = { id: `epoch_${this.epochs.length}`, userId: input.userId,
            computerId: input.computerId, size: input.size, weight: 1, readyAt: input.readyAt.toISOString(),
            endedAt: null, endReason: null, overheadSeconds: input.overheadSeconds ?? 0,
            deadlineAt: null, lastHeartbeatAt: null };
        this.epochs.push(epoch);
        return { status: 'opened', epoch };
    };
    openEpochFor: BillingStore['openEpochFor'] = async () => { throw new Error('Unused v2 store stub'); };
    touchEpoch: BillingStore['touchEpoch'] = async (computerId, at) => {
        const epoch = this.epochs.find(e => e.computerId === computerId && e.endedAt === null);
        if (!epoch) return 'not_open';
        epoch.lastHeartbeatAt = new Date(Math.max(Date.parse(epoch.lastHeartbeatAt ?? epoch.readyAt), at.getTime())).toISOString();
        return 'touched';
    };
    openEpochsForSweep: BillingStore['openEpochsForSweep'] = async () => { throw new Error('Unused v2 store stub'); };
    policyClosedEpochsSince: BillingStore['policyClosedEpochsSince'] = async () => { throw new Error('Unused v2 store stub'); };
    closeEpoch: BillingStore['closeEpoch'] = async input => {
        const epoch = this.epochs.find(e => e.computerId === input.computerId && e.endedAt === null);
        if (!epoch) return 'not_open';
        epoch.endedAt = input.endedAt.toISOString();
        epoch.endReason = input.reason;
        return 'closed';
    };
    epochsFor: BillingStore['epochsFor'] = async () => { throw new Error('Unused v2 store stub'); };
    recordConsent: BillingStore['recordConsent'] = async input => {
        const key = JSON.stringify(input);
        const previous = this.consents.find(row => {
            const { id: _id, ...fields } = row;
            return JSON.stringify(fields) === key;
        });
        if (previous) return previous;
        const row = { ...input, id: BigInt(this.consents.length + 1) };
        this.consents.push(row);
        return row;
    };
    consentAsOf: BillingStore['consentAsOf'] = async () => { throw new Error('Unused v2 store stub'); };
    consentDecisionsForPeriod: BillingStore['consentDecisionsForPeriod'] = async () => { throw new Error('Unused v2 store stub'); };
    markOverageInvoiceOpen: BillingStore['markOverageInvoiceOpen'] = async () => { throw new Error('Unused v2 store stub'); };
    latestConsent: BillingStore['latestConsent'] = async (userId, subscriptionId) => [...this.consents].reverse()
        .find(row => row.userId === userId && row.subscriptionId === subscriptionId) ?? null;
    upsertOverageInvoice: BillingStore['upsertOverageInvoice'] = async input => {
        const previous = this.overageInvoices.find(row => row.userId === input.userId && row.subscriptionId === input.subscriptionId
            && row.periodStart.getTime() === input.periodStart.getTime() && row.ratingVersion === input.ratingVersion);
        if (previous) return { status: 'exists', row: previous };
        const row: OverageInvoiceRow = { ...input, id: `overage_${this.overageInvoices.length}`, status: 'pending', stripeInvoiceId: null, createdAt: now, updatedAt: now };
        this.overageInvoices.push(row);
        return { status: 'inserted', row };
    };
    attachOverageStripeInvoice: BillingStore['attachOverageStripeInvoice'] = async (id, stripeInvoiceId) => {
        const row = this.overageInvoices.find(row => row.id === id);
        if (row && (row.stripeInvoiceId === null || row.stripeInvoiceId === stripeInvoiceId)) row.stripeInvoiceId = stripeInvoiceId;
    };
    setOverageInvoiceStatus: BillingStore['setOverageInvoiceStatus'] = async (id, status) => {
        const row = this.overageInvoices.find(row => row.stripeInvoiceId === id);
        if (!row) return 'not_found';
        row.status = status;
        return 'updated';
    };
    overageInvoiceByStripeId: BillingStore['overageInvoiceByStripeId'] = async id => this.overageInvoices.find(row => row.stripeInvoiceId === id) ?? null;
    overageInvoicesFor: BillingStore['overageInvoicesFor'] = async userId => this.overageInvoices.filter(row => row.userId === userId);
    recordPlanChange: BillingStore['recordPlanChange'] = async input => {
        if (this.planChanges.some(row => row.subscriptionId === input.subscriptionId && row.kind === input.kind && this.isOpenChange(row))) return 'exists';
        this.planChanges.push({ ...input, id: `change_${this.planChanges.length}`, createdAt: now, updatedAt: now });
        return 'inserted';
    };
    setPlanChangeState: BillingStore['setPlanChangeState'] = async input => {
        for (const row of this.planChanges.filter(row => row.userId === input.userId
            && row.subscriptionId === input.subscriptionId && row.kind === input.kind && this.isOpenChange(row))) {
            row.state = input.state;
            if (input.stripeInvoiceId !== undefined) row.stripeInvoiceId = input.stripeInvoiceId;
            if (input.effectiveAt !== undefined) row.effectiveAt = input.effectiveAt;
        }
    };
    openPlanChanges: BillingStore['openPlanChanges'] = async userId => this.planChanges.filter(row => row.userId === userId && this.isOpenChange(row));
    recordPaymentIssue: BillingStore['recordPaymentIssue'] = async ({ eventCreated, ...input }) => {
        const previous = this.issues.get(input.stripeInvoiceId);
        if (previous && (previous.userId !== input.userId || previous.stripeEventCreated > eventCreated
            || (previous.resolvedAt !== null && previous.resolvedAt >= eventCreated))) return;
        this.issues.set(input.stripeInvoiceId, { ...input, stripeEventCreated: eventCreated, resolvedAt: null, updatedAt: now });
    };
    resolvePaymentIssue: BillingStore['resolvePaymentIssue'] = async (id, eventCreated) => {
        const row = this.issues.get(id);
        if (row && row.stripeEventCreated <= eventCreated) {
            row.resolvedAt = eventCreated;
            row.stripeEventCreated = eventCreated;
        }
    };
    openPaymentIssues: BillingStore['openPaymentIssues'] = async userId => [...this.issues.values()].filter(row => row.userId === userId && row.resolvedAt === null);
    setSizePreference: BillingStore['setSizePreference'] = async () => { throw new Error('Unused v2 store stub'); };
    sizePreference: BillingStore['sizePreference'] = async () => { throw new Error('Unused v2 store stub'); };
    userCreatedAt: BillingStore['userCreatedAt'] = async () => { throw new Error('Unused v2 store stub'); };
    consents: OverageConsentRow[] = [];
    overageInvoices: OverageInvoiceRow[] = [];
    planChanges: PlanChangeRow[] = [];
    issues = new Map<string, PaymentIssueRow>();
    isOpenChange(row: PlanChangeRow) { return ['pending', 'requires_action', 'payment_failed', 'scheduled'].includes(row.state); }
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
    async upsertSubscription(row: SubscriptionUpsert): Promise<'applied' | 'stale' | 'conflict'> {
        const previous = this.subscriptions.get(row.stripeSubscriptionId);
        if (previous && previous.userId !== row.userId) return 'conflict';
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
        if (grant.kind === 'plan_period' && grant.subscriptionId != null && grant.periodStart != null
            && [...this.grants.values()].some(row => row.kind === 'plan_period' && row.subscriptionId === grant.subscriptionId
                && row.meter === grant.meter && row.periodStart?.getTime() === grant.periodStart!.getTime())) return 'duplicate';
        this.grants.set(key, { ...grant, subscriptionId: grant.subscriptionId ?? null, id: key, createdAt: now });
        this.writes.push(key);
        return 'inserted';
    }
    async enqueueOutbox(item: OutboxInsert): Promise<'queued' | 'duplicate'> {
        if (this.outbox.has(item.eventKey)) return 'duplicate';
        this.outbox.set(item.eventKey, item);
        this.writes.push(item.eventKey);
        return 'queued';
    }
    async aiCreditGrantsByInvoice(userId: string, invoiceId: string) {
        return [...this.outbox.values()].filter(item => item.userId === userId && item.kind === 'ai_grant'
            && item.payload.protocol === 'ezil-ai-credits-v1' && item.payload.invoiceId === invoiceId);
    }
    async latestIntervalFor(computerId: string) {
        return this.intervals.filter(row => row.computerId === computerId)
            .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0] ?? null;
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
    async resolvePrice(): Promise<never> { throw new Error('Unexpected resolvePrice'); }
    async previewUpgrade(): Promise<never> { throw new Error('Unexpected previewUpgrade'); }
    async confirmUpgrade(): Promise<never> { throw new Error('Unexpected confirmUpgrade'); }
    async scheduleDowngrade(): Promise<never> { throw new Error('Unexpected scheduleDowngrade'); }
    async cancelScheduledChange(): Promise<never> { throw new Error('Unexpected cancelScheduledChange'); }
    async setCancelAtPeriodEnd(): Promise<never> { throw new Error('Unexpected setCancelAtPeriodEnd'); }

    reads: string[] = [];
    subscription: StripeSubscription = {
        id: 'sub_local', customer: 'cus_local', sku: PRO_PLAN.sku, status: 'active',
        cancelAtPeriodEnd: false, currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, items: [], pendingUpdateExpiresAt: null,
        defaultPaymentMethod: null, scheduleId: null, latestInvoiceId: null,
    };
    invoice: StripeInvoice = {
        id: 'in_local', customer: 'cus_local', status: 'paid', subscriptionId: 'sub_local', periodStart, periodEnd,
        billingReason: 'subscription_cycle', metadataKind: null, hostedInvoiceUrl: null, lines: [],
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
    async listInvoices(): Promise<never> { throw new Error('Unexpected listInvoices'); }
    async createPortalSession(): Promise<never> { throw new Error('Unexpected createPortalSession'); }
    async retrieveSubscription(id: string) { this.reads.push(`subscription:${id}`); return this.subscription; }
    async retrieveInvoice(id: string) { this.reads.push(`invoice:${id}`); return this.invoice; }
    paymentState: StripeInvoicePaymentState = 'failed';
    async retrieveInvoicePaymentState(id: string) { this.reads.push(`invoice_payment:${id}`); return this.paymentState; }
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
            stripe.invoice.status = 'open';
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

    it.each([refund, dispute, () => dispute(true)])('retries missing originals and reviews ownership mismatches %#', async makeEvent => {
        const { store, deps } = fixture();
        expect(await processStripeEvent(makeEvent(), deps)).toMatch(/^failed:no_grant_for_/);
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

    it.each([['idle', 'idle_sleep'], ['sleep', 'provider_stop'], [undefined, 'provider_stop']] as const)(
        'drives v2 start/heartbeat/stop with reason %s while retaining v1 reason', async (reason, expected) => {
            const { store } = fixture();
            const open = vi.spyOn(store, 'openEpoch');
            const touch = vi.spyOn(store, 'touchEpoch');
            const close = vi.spyOn(store, 'closeEpoch');
            expect(await ingestUsageEvents([usage('start'), usage('start'), usage('heartbeat', 60_000),
                { ...usage('stop', 120_000), reason }], { store })).toEqual({ accepted: 4, rejected: 0 });
            expect(open).toHaveBeenCalledWith({ userId: 'user_local', computerId: 'computer_local',
                subscriptionId: null, size: 'free-cf', readyAt: now, overheadSeconds: 0 });
            expect(touch).toHaveBeenCalledExactlyOnceWith('computer_local', new Date(now.getTime() + 60_000));
            expect(close).toHaveBeenCalledExactlyOnceWith({ computerId: 'computer_local',
                endedAt: new Date(now.getTime() + 120_000), reason: expected });
            expect(store.epochs).toHaveLength(1);
            expect(store.epochs[0]).toMatchObject({ lastHeartbeatAt: new Date(now.getTime() + 60_000).toISOString(),
                endedAt: new Date(now.getTime() + 120_000).toISOString(), endReason: expected });
            expect(store.intervals[0]).toMatchObject({ reason: reason ?? 'stop', source: 'start' });
        });

    it('accepts a concurrent v2 start and preserves the existing v1 interval behavior', async () => {
        const { store } = fixture();
        await store.openEpoch({ userId: 'user_local', computerId: 'other_computer', subscriptionId: null,
            size: 'free-cf', readyAt: now, overheadSeconds: 0 });
        expect(await ingestUsageEvents([usage('start')], { store })).toEqual({ accepted: 1, rejected: 0 });
        expect(store.epochs).toHaveLength(1);
        expect(store.epochs[0]?.computerId).toBe('other_computer');
        expect(store.intervals[0]?.computerId).toBe('computer_local');
    });

    it('touches v2 even when v1 ignores a heartbeat after close, without reopening either', async () => {
        const { store } = fixture();
        await ingestUsageEvents([usage('start'), usage('stop', 60_000)], { store });
        const touch = vi.spyOn(store, 'touchEpoch');
        expect(await ingestUsageEvents([usage('heartbeat', 120_000)], { store })).toEqual({ accepted: 1, rejected: 0 });
        expect(touch).toHaveBeenCalledExactlyOnceWith('computer_local', new Date(now.getTime() + 120_000));
        expect(store.epochs).toHaveLength(1);
        expect(store.epochs[0]?.endedAt).toBe(new Date(now.getTime() + 60_000).toISOString());
        expect(store.intervals).toHaveLength(1);
    });

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

function v2Fixture(sku: 'standard_monthly_v2' | 'compute_monthly_v2' = 'standard_monthly_v2') {
    const f = fixture();
    f.stripe.subscription.sku = sku;
    f.stripe.subscription.items = [{ id: null, priceId: 'price_base', lookupKey: CATALOG_V2[sku].stripeLookupKey }];
    f.stripe.invoice.lines = [baseLine(sku)];
    return f;
}
function baseLine(sku: 'standard_monthly_v2' | 'compute_monthly_v2'): StripeInvoice['lines'][number] {
    return { id: `il_${sku}`, lookupKey: CATALOG_V2[sku].stripeLookupKey, subscriptionId: 'sub_local',
        proration: false, amount: CATALOG_V2[sku].priceCents, periodStart, periodEnd };
}
function paidV2() {
    return event('invoice.paid', { id: 'in_local', customer: 'cus_payload', billing_reason: 'subscription_cycle',
        parent: { subscription_details: { subscription: 'sub_payload' } }, lines: { data: [] } });
}
function issueEvent(type: string, subscription = false) {
    return event(type, { id: 'in_local', customer: 'cus_payload', metadata: { user_id: 'attacker' },
        parent: subscription ? { subscription_details: { subscription: 'sub_local' } } : null });
}
async function seedChange(store: MemoryStore) {
    await store.recordPlanChange({ userId: 'user_local', subscriptionId: 'sub_local', kind: 'upgrade',
        fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2', stripeInvoiceId: 'in_local', stripeScheduleId: null,
        hostedInvoiceUrl: 'https://invoice.stripe.com/local', state: 'pending', effectiveAt: null, expiresAt: periodEnd });
}
async function seedOverage(f: ReturnType<typeof fixture>) {
    f.stripe.invoice.metadataKind = 'overage';
    f.stripe.invoice.subscriptionId = null;
    f.stripe.invoice.billingReason = 'manual';
    f.stripe.invoice.hostedInvoiceUrl = 'https://invoice.stripe.com/local';
    const { row } = await f.store.upsertOverageInvoice({ userId: 'user_local', subscriptionId: 'sub_local',
        periodStart, periodEnd, ratingVersion: 1, stdSecondsOver: BigInt(1440), cents: 10 });
    await f.store.attachOverageStripeInvoice(row.id, 'in_local');
    await f.store.recordConsent({ userId: 'user_local', subscriptionId: 'sub_local', enabled: true, capCents: 4200,
        termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: 2, rateCentsPerStdHour: 25, actor: 'user', acceptedAt: periodStart });
}

describe('v2 webhook grants', () => {
    it('grants a delayed Standard create invoice after upgrade, replays once, then grants a Compute renewal', async () => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        stripe.invoice.billingReason = 'subscription_create';
        stripe.invoice.lines = [baseLine('standard_monthly_v2')];
        const delivery = paidV2();
        expect(await processStripeEvent(delivery, deps)).toBe('applied');
        const expected = expect.objectContaining({
            subscriptionId: 'sub_local', kind: 'plan_period', meter: 'compute_std_seconds',
            amount: BigInt(216_000), periodStart, periodEnd, sourceId: 'in_local',
        });
        expect([...store.grants.values()]).toEqual([expected]);
        expect(store.subscriptions.get('sub_local')?.sku).toBe('compute_monthly_v2');
        expect(await processStripeEvent({ ...delivery, id: 'evt_replay' }, deps)).toBe('applied');
        expect([...store.grants.values()]).toEqual([expected]);

        const nextEnd = new Date('2026-12-01T00:00:00Z');
        stripe.subscription.currentPeriodStart = periodEnd;
        stripe.subscription.currentPeriodEnd = nextEnd;
        stripe.invoice = { ...stripe.invoice, id: 'in_renewal', billingReason: 'subscription_cycle',
            periodStart: periodEnd, periodEnd: nextEnd,
            lines: [{ ...baseLine('compute_monthly_v2'), periodStart: periodEnd, periodEnd: nextEnd }] };
        const renewal = { ...paidV2(), id: 'evt_renewal', created: periodEnd.getTime() / 1000 };
        renewal.data.object.id = 'in_renewal';
        expect(await processStripeEvent(renewal, deps)).toBe('applied');
        expect([...store.grants.values()]).toEqual([expected, expect.objectContaining({
            subscriptionId: 'sub_local', kind: 'plan_period', meter: 'compute_std_seconds',
            amount: BigInt(1_800_000), periodStart: periodEnd, periodEnd: nextEnd, sourceId: 'in_renewal',
        })]);
        expect(store.outbox.size).toBe(0);
    });

    it.each([false, true])('reviews two distinct sellable base offers regardless of line order (reverse=%s)', async reverse => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        stripe.invoice.lines = [baseLine('standard_monthly_v2'), baseLine('compute_monthly_v2')];
        if (reverse) stripe.invoice.lines.reverse();
        expect(await processStripeEvent(paidV2(), deps)).toBe('review:ambiguous_base_line');
        expect(store.writes).toEqual([]);
    });

    it('accepts repeated lines for one offer and excludes foreign or invalid lines for the other offer', async () => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        stripe.invoice.lines = [
            { ...baseLine('compute_monthly_v2'), subscriptionId: 'sub_foreign' },
            { ...baseLine('compute_monthly_v2'), periodEnd: periodStart },
            { ...baseLine('standard_monthly_v2'), subscriptionId: null },
            { ...baseLine('standard_monthly_v2'), id: 'il_duplicate' },
        ];
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect([...store.grants.values()]).toEqual([expect.objectContaining({
            kind: 'plan_period', amount: BigInt(216_000), periodStart, periodEnd,
        })]);
    });

    it.each(['legacy period', 'v2 period', 'upgrade', 'sync', 'failed invoice', 'plan applied', 'plan expired'] as const)(
        'reviews subscription ownership conflicts before any further write: %s', async scenario => {
            const { store, stripe, deps } = scenario === 'legacy period' ? fixture() : v2Fixture('compute_monthly_v2');
            const ownerRow: SubscriptionUpsert = {
                stripeSubscriptionId: 'sub_local', userId: 'user_owner', status: 'active', sku: 'standard_monthly_v2',
                currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, cancelAtPeriodEnd: false,
                stripeEventCreated: periodStart,
            };
            store.subscriptions.set('sub_local', ownerRow);
            await seedChange(store);
            store.planChanges[0].userId = 'user_owner';
            await store.recordPaymentIssue({ stripeInvoiceId: 'in_local', userId: 'user_owner', subscriptionId: 'sub_local',
                invoiceKind: 'subscription', issue: 'payment_failed', hostedInvoiceUrl: null, eventCreated: periodStart });
            let delivery = scenario === 'legacy period' ? invoice() : paidV2();
            if (scenario === 'upgrade') {
                stripe.invoice.billingReason = 'subscription_update';
                stripe.invoice.lines = [
                    { ...baseLine('standard_monthly_v2'), amount: -1000, proration: true, periodStart: now },
                    { ...baseLine('compute_monthly_v2'), amount: 5000, proration: true, periodStart: now },
                ];
            } else if (scenario === 'sync') {
                delivery = sync();
            } else if (scenario === 'failed invoice') {
                stripe.invoice.status = 'open';
                delivery = issueEvent('invoice.payment_failed', true);
            } else if (scenario === 'plan applied' || scenario === 'plan expired') {
                delivery = event(`customer.subscription.pending_update_${scenario === 'plan applied' ? 'applied' : 'expired'}`, { id: 'sub_local' });
            }
            const writes = [
                vi.spyOn(store, 'insertGrant'), vi.spyOn(store, 'enqueueOutbox'), vi.spyOn(store, 'setPlanChangeState'),
                vi.spyOn(store, 'recordPaymentIssue'), vi.spyOn(store, 'resolvePaymentIssue'),
            ];
            expect(await processStripeEvent(delivery, deps)).toBe('review:customer_mismatch');
            for (const write of writes) expect(write).not.toHaveBeenCalled();
            expect(store.subscriptions.get('sub_local')).toEqual(ownerRow);
            expect(store.planChanges[0].state).toBe('pending');
            expect(store.issues.get('in_local')?.resolvedAt).toBeNull();
            expect(store.writes).toEqual([]);
        },
    );

    it('grants a Compute cycle and saves the Compute SKU despite stale Standard metadata', async () => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        const client = createStripeClient({ secretKey: 'sk_test_fixture', fetch: vi.fn<typeof fetch>().mockResolvedValue(
            Response.json({
                id: 'sub_local', customer: 'cus_local', status: 'active', cancel_at_period_end: false,
                metadata: { sku: 'standard_monthly_v2' },
                items: { data: [{ price: { id: 'price_compute', lookup_key: 'ezil_compute_monthly_v2' },
                    current_period_start: periodStart.getTime() / 1000, current_period_end: periodEnd.getTime() / 1000 }] },
            }),
        ) });
        vi.spyOn(stripe, 'retrieveSubscription').mockImplementation(client.retrieveSubscription);
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect([...store.grants.values()]).toEqual([expect.objectContaining({
            kind: 'plan_period', meter: 'compute_std_seconds', amount: BigInt(1_800_000),
            subscriptionId: 'sub_local', periodStart, periodEnd,
        })]);
        expect(store.subscriptions.get('sub_local')?.sku).toBe('compute_monthly_v2');
    });

    it.each(['standard_monthly_v2', 'compute_monthly_v2'] as const)('grants %s once per invoice and subscription period on create/cycle', async sku => {
        for (const billingReason of ['subscription_create', 'subscription_cycle']) {
            const { store, stripe, deps } = v2Fixture(sku);
            stripe.invoice.billingReason = billingReason;
            expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
            expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
            stripe.invoice.id = 'in_second';
            const second = paidV2();
            second.data.object.id = 'in_second';
            expect(await processStripeEvent(second, deps)).toBe('applied');
            expect([...store.grants.values()]).toEqual([expect.objectContaining({
                sourceId: 'in_local', sourceType: 'invoice', subscriptionId: 'sub_local', kind: 'plan_period',
                meter: 'compute_std_seconds', amount: BigInt(CATALOG_V2[sku].allowanceStdSeconds), periodStart, periodEnd,
            })]);
            expect(store.outbox.size).toBe(0);
            expect(store.subscriptions.get('sub_local')?.sku).toBe(sku);
        }
    });

    it('finds the base lookup key after unrelated and foreign lines, using its period', async () => {
        const { store, stripe, deps } = v2Fixture();
        const base = { ...baseLine('standard_monthly_v2'), subscriptionId: null };
        stripe.invoice.lines = [
            { ...base, lookupKey: OVERAGE_PRICE_LOOKUP_KEY, periodStart: now },
            { ...base, subscriptionId: 'sub_foreign', periodStart: now }, base,
        ];
        stripe.invoice.periodStart = now; // Neither the v1 selection nor the event is authoritative for v2.
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect([...store.grants.values()][0]).toMatchObject({ amount: BigInt(216000), periodStart, periodEnd });
    });

    it.each([
        [], [{ ...baseLine('standard_monthly_v2'), lookupKey: 'unrecognized' }],
        [{ ...baseLine('standard_monthly_v2'), subscriptionId: 'sub_foreign' }],
        [{ ...baseLine('standard_monthly_v2'), periodEnd: periodStart }],
        [{ ...baseLine('standard_monthly_v2'), periodStart: null }],
    ])('reviews missing or invalid base lines %#', async (...lines) => {
        const { store, stripe, deps } = v2Fixture();
        stripe.invoice.lines = lines;
        expect(await processStripeEvent(paidV2(), deps)).toBe('review:no_base_line');
        expect(store.grants.size).toBe(0);
        expect(store.outbox.size).toBe(0);
    });

    it.each([
        { billingReason: 'manual' }, { billingReason: null }, { billingReason: 'subscription_threshold' },
        { status: 'open' }, { subscriptionId: null },
    ])('does not grant for re-read facts %j', async fields => {
        const { store, stripe, deps } = v2Fixture();
        Object.assign(stripe.invoice, fields);
        expect(await processStripeEvent(paidV2(), deps)).toBe('ignored');
        expect(store.grants.size).toBe(0);
        expect(store.outbox.size).toBe(0);
    });

    it('keeps legacy manual invoices from granting or enqueuing AI', async () => {
        const { store, stripe, deps } = fixture();
        stripe.invoice.billingReason = 'manual';
        expect(await processStripeEvent(invoice(), deps)).toBe('ignored');
        expect(store.grants.size).toBe(0);
        expect(store.outbox.size).toBe(0);
    });

    it('grants only the prorated Standard → Compute difference and closes the pending change', async () => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        await seedChange(store);
        stripe.invoice.billingReason = 'subscription_update';
        stripe.invoice.lines = [
            { ...baseLine('standard_monthly_v2'), amount: -1000, proration: true, periodStart: now },
            { ...baseLine('compute_monthly_v2'), amount: 5000, proration: true, periodStart: now },
        ];
        const expected = upgradeGrantStdSeconds({ fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2',
            periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), effectiveAt: now.toISOString() });
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect([...store.grants.values()]).toEqual([expect.objectContaining({
            kind: 'upgrade_prorated', amount: BigInt(expected), meter: 'compute_std_seconds',
            periodStart, periodEnd, subscriptionId: 'sub_local', sourceType: 'invoice', sourceId: 'in_local',
        })]);
        expect(expected).toBeLessThan(CATALOG_V2.compute_monthly_v2.allowanceStdSeconds - CATALOG_V2.standard_monthly_v2.allowanceStdSeconds);
        expect(store.planChanges[0]).toMatchObject({ state: 'applied', effectiveAt: now });
        expect(store.outbox.size).toBe(0);
    });

    it.each(['renewed subscription period', 'different proration end', 'effective date before current period'])('reviews an upgrade with %s without granting or applying the plan change', async scenario => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        await seedChange(store);
        stripe.invoice.billingReason = 'subscription_update';
        stripe.invoice.lines = [
            { ...baseLine('standard_monthly_v2'), amount: -1000, proration: true, periodStart: now },
            { ...baseLine('compute_monthly_v2'), amount: 5000, proration: true, periodStart: now },
        ];
        if (scenario === 'renewed subscription period') {
            stripe.subscription.currentPeriodStart = periodEnd;
            stripe.subscription.currentPeriodEnd = new Date('2026-12-01T00:00:00Z');
        } else if (scenario === 'different proration end') {
            stripe.invoice.lines[1].periodEnd = new Date(periodEnd.getTime() - 1000);
        } else {
            stripe.subscription.currentPeriodStart = new Date(now.getTime() + 1000);
        }
        const setPlanChangeState = vi.spyOn(store, 'setPlanChangeState');
        expect(await processStripeEvent(paidV2(), deps)).toBe('review:upgrade_period_mismatch');
        expect(store.grants.size).toBe(0);
        expect(store.subscriptions.size).toBe(0);
        expect(store.planChanges[0]).toMatchObject({ state: 'pending', effectiveAt: null });
        expect(setPlanChangeState).not.toHaveBeenCalled();
        expect(store.writes).toEqual([]);
    });

    it('uses the proration line end when subscription ends agree to whole seconds', async () => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        stripe.subscription.currentPeriodEnd = new Date(periodEnd.getTime() + 500);
        stripe.invoice.billingReason = 'subscription_update';
        stripe.invoice.lines = [
            { ...baseLine('standard_monthly_v2'), amount: -1000, proration: true, periodStart: now },
            { ...baseLine('compute_monthly_v2'), amount: 5000, proration: true, periodStart: now },
        ];
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect([...store.grants.values()][0].periodEnd).toEqual(periodEnd);
    });

    it.each(['missing credit', 'nonpositive compute', 'foreign credit', 'downgrade'])('ignores subscription_update: %s', async scenario => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        stripe.invoice.billingReason = 'subscription_update';
        const compute = { ...baseLine('compute_monthly_v2'), proration: true, periodStart: now };
        const credit = { ...baseLine('standard_monthly_v2'), amount: -1000, proration: true };
        stripe.invoice.lines = [compute, credit];
        if (scenario === 'missing credit') stripe.invoice.lines = [compute];
        if (scenario === 'nonpositive compute') compute.amount = 0;
        if (scenario === 'foreign credit') credit.subscriptionId = 'sub_foreign';
        if (scenario === 'downgrade') { compute.amount = -5000; credit.amount = 1000; }
        expect(await processStripeEvent(paidV2(), deps)).toBe('ignored');
        expect(store.grants.size).toBe(0);
        expect(store.planChanges).toEqual([]);
    });

    it('recognizes an upgrade from its line keys even when the credit is zero and proration flags are absent', async () => {
        const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
        stripe.invoice.billingReason = 'subscription_update';
        stripe.invoice.lines = [
            { ...baseLine('standard_monthly_v2'), amount: 0, periodStart: now },
            { ...baseLine('compute_monthly_v2'), periodStart: now },
        ];
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        const expected = upgradeGrantStdSeconds({ fromSku: 'standard_monthly_v2', toSku: 'compute_monthly_v2',
            periodStart: periodStart.toISOString(), periodEnd: periodEnd.toISOString(), effectiveAt: now.toISOString() });
        expect([...store.grants.values()][0]).toMatchObject({ kind: 'upgrade_prorated', amount: BigInt(expected) });
    });

    it('settles a standalone overage invoice and resolves its issue without granting', async () => {
        const f = v2Fixture('compute_monthly_v2');
        await seedOverage(f);
        f.stripe.invoice.status = 'open';
        expect(await processStripeEvent(issueEvent('invoice.payment_failed'), f.deps)).toBe('applied');
        f.stripe.invoice.status = 'paid';
        const paid = issueEvent('invoice.paid');
        expect(await processStripeEvent(paid, f.deps)).toBe('applied');
        expect(f.store.overageInvoices[0].status).toBe('paid');
        expect(await f.store.openPaymentIssues('user_local')).toEqual([]);
        expect(f.store.grants.size).toBe(0);
        expect(f.store.outbox.size).toBe(0);
        expect(f.stripe.reads).toEqual(['invoice:in_local', 'invoice_payment:in_local', 'invoice:in_local']);
        f.store.overageInvoices = [];
        expect(await processStripeEvent(paid, f.deps)).toBe('ignored');
    });

    it.each(['standard_monthly_v2', 'compute_monthly_v2'] as const)(
        'settles a paid overage subscription_cycle with a valid %s base line without granting', async sku => {
            const f = v2Fixture(sku);
            await seedOverage(f);
            f.stripe.invoice.subscriptionId = 'sub_local';
            f.stripe.invoice.billingReason = 'subscription_cycle';
            expect(await processStripeEvent(paidV2(), f.deps)).toBe('applied');
            expect(f.store.grants.size).toBe(0);
            expect(f.store.outbox.size).toBe(0);
            expect(f.store.overageInvoices[0].status).toBe('paid');
        },
    );

    describe.each([
        ['refund', refund], ['dispute', dispute], ['dispute restore', () => dispute(true)],
    ] as const)('%s without an original grant', (kind, makeEvent) => {
        it.each(['manual', 'subscription_cycle'])('reviews an overage invoice with billing reason %s without writes', async billingReason => {
            const f = v2Fixture();
            await seedOverage(f);
            f.stripe.invoice.subscriptionId = 'sub_local';
            f.stripe.invoice.billingReason = billingReason;
            f.stripe.charge.invoiceId = 'in_local';
            const before = structuredClone({
                overages: f.store.overageInvoices, consents: f.store.consents, issues: f.store.issues,
            });
            expect(await processStripeEvent(makeEvent(), f.deps)).toBe(
                kind === 'refund' ? 'review:refund_on_overage_invoice' : 'review:dispute_on_overage_invoice',
            );
            expect(f.stripe.reads).toEqual(['charge:ch_local', 'invoice:in_local']);
            expect(f.store.writes).toEqual([]);
            expect(f.store.grants.size).toBe(0);
            expect(f.store.outbox.size).toBe(0);
            expect({ overages: f.store.overageInvoices, consents: f.store.consents, issues: f.store.issues }).toEqual(before);
        });

        it.each([
            { billingReason: 'manual' }, { billingReason: null }, { billingReason: 'subscription_threshold' },
            { billingReason: 'subscription_update' }, { status: 'open' }, { status: 'void' },
            { status: 'uncollectible' }, { subscriptionId: null },
        ])('ignores an invoice that cannot grant: %j', async fields => {
            const { store, stripe, deps } = v2Fixture();
            Object.assign(stripe.invoice, fields);
            stripe.charge.invoiceId = 'in_local';
            expect(await processStripeEvent(makeEvent(), deps)).toBe('ignored');
            expect(stripe.reads).toEqual(['charge:ch_local', 'invoice:in_local']);
            expect(store.writes).toEqual([]);
        });

        it.each(['missing credit', 'nonpositive compute', 'foreign compute', 'foreign credit', 'invalid compute period', 'downgrade'])(
            'ignores a non-upgrade subscription_update: %s', async scenario => {
                const { store, stripe, deps } = v2Fixture('compute_monthly_v2');
                stripe.charge.invoiceId = 'in_local';
                stripe.invoice.billingReason = 'subscription_update';
                const compute = { ...baseLine('compute_monthly_v2'), periodStart: now };
                const credit = { ...baseLine('standard_monthly_v2'), amount: -1000 };
                stripe.invoice.lines = [compute, credit];
                if (scenario === 'missing credit') stripe.invoice.lines = [compute];
                if (scenario === 'nonpositive compute') compute.amount = 0;
                if (scenario === 'foreign compute') compute.subscriptionId = 'sub_foreign';
                if (scenario === 'foreign credit') credit.subscriptionId = 'sub_foreign';
                if (scenario === 'invalid compute period') compute.periodEnd = now;
                if (scenario === 'downgrade') { compute.amount = -5000; credit.amount = 1000; }
                expect(await processStripeEvent(makeEvent(), deps)).toBe('ignored');
                expect(store.writes).toEqual([]);
            },
        );

        it('ignores a charge with neither invoice nor payment intent', async () => {
            const { store, stripe, deps } = fixture();
            stripe.charge.paymentIntentId = null;
            expect(await processStripeEvent(makeEvent(), deps)).toBe('ignored');
            expect(stripe.reads).toEqual(['charge:ch_local']);
            expect(store.sourceReads).toEqual([]);
            expect(store.writes).toEqual([]);
        });

        it.each(['subscription_create', 'subscription_cycle', 'upgrade', 'top-up'] as const)(
            'retries before a %s grant, then applies once', async scenario => {
                const { store, stripe, deps } = v2Fixture(scenario === 'upgrade' ? 'compute_monthly_v2' : 'standard_monthly_v2');
                if (scenario !== 'top-up') {
                    stripe.charge.invoiceId = 'in_local';
                    stripe.invoice.billingReason = scenario === 'upgrade' ? 'subscription_update' : scenario;
                }
                if (scenario === 'upgrade') {
                    stripe.invoice.lines = [
                        { ...baseLine('compute_monthly_v2'), subscriptionId: null, periodStart: now },
                        { ...baseLine('standard_monthly_v2'), subscriptionId: null, amount: 0, periodStart: now },
                    ];
                }
                expect(await processStripeEvent(makeEvent(), deps)).toBe(
                    kind === 'refund' ? 'failed:no_grant_for_refund' : 'failed:no_grant_for_dispute',
                );
                expect(store.writes).toEqual([]);
                expect(await processStripeEvent(scenario === 'top-up' ? checkout(false) : paidV2(), deps)).toBe('applied');
                const original = [...store.grants.values()][0];
                expect(await processStripeEvent(makeEvent(), deps)).toBe('applied');
                const writes = [...store.writes];
                expect(await processStripeEvent(makeEvent(), deps)).toBe('applied');
                expect(store.writes).toEqual(writes);
                expect([...store.grants.values()]).toEqual([original, expect.objectContaining({
                    kind: kind === 'refund' ? 'revoke' : kind === 'dispute' ? 'suspend' : 'restore',
                    meter: original.meter, subscriptionId: original.subscriptionId,
                    amount: kind === 'dispute restore' ? original.amount : -original.amount,
                    periodStart: original.periodStart, periodEnd: original.periodEnd,
                })]);
            },
        );
    });

    it('resolves paid manual invoice issues even without a subscription', async () => {
        const { store, stripe, deps } = v2Fixture();
        stripe.invoice.subscriptionId = null;
        stripe.invoice.billingReason = 'manual';
        stripe.invoice.status = 'open';
        await processStripeEvent(issueEvent('invoice.payment_action_required'), deps);
        stripe.invoice.status = 'paid';
        expect(await processStripeEvent(issueEvent('invoice.paid'), deps)).toBe('ignored');
        expect(await store.openPaymentIssues('user_local')).toEqual([]);
        expect(store.grants.size).toBe(0);
    });

    it('retries a refund before its grant, then revokes v2 compute once with the subscription id', async () => {
        const { store, stripe, deps } = v2Fixture();
        stripe.charge.invoiceId = 'in_local';
        expect(await processStripeEvent(refund(), deps)).toBe('failed:no_grant_for_refund');
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect(await processStripeEvent(refund(), deps)).toBe('applied');
        expect(await processStripeEvent(refund(), deps)).toBe('applied');
        expect([...store.grants.values()]).toHaveLength(2);
        expect([...store.grants.values()][1]).toMatchObject({ kind: 'revoke', meter: 'compute_std_seconds',
            subscriptionId: 'sub_local', amount: -BigInt(216000), periodStart, periodEnd });
        expect(store.outbox.size).toBe(0);
    });

    it.each([false, true])('retries a dispute before its grant (restore=%s)', async restore => {
        const f = v2Fixture();
        f.stripe.charge.invoiceId = 'in_local';
        expect(await processStripeEvent(dispute(restore), f.deps)).toBe('failed:no_grant_for_dispute');
        await processStripeEvent(paidV2(), f.deps);
        expect(await processStripeEvent(dispute(restore), f.deps)).toBe('applied');
        expect([...f.store.grants.values()][1]).toMatchObject({ kind: restore ? 'restore' : 'suspend',
            meter: 'compute_std_seconds', subscriptionId: 'sub_local', amount: BigInt(restore ? 216000 : -216000) });
    });

    it.each([false, true])('lets a failed outcome win over a review in either order (failed first=%s)', async failedFirst => {
        const { store, stripe, deps } = fixture();
        vi.spyOn(stripe, 'retrieveCharge')
            .mockResolvedValueOnce({ ...stripe.charge, refunded: !failedFirst ? false : true })
            .mockResolvedValueOnce({ ...stripe.charge, refunded: failedFirst ? false : true });
        const input = refund();
        input.data.object.refunds = { data: [{ id: 're_first' }, { id: 're_second' }] };
        expect(await processStripeEvent(input, deps)).toBe('failed:no_grant_for_refund');
        expect(store.grants.size).toBe(0);
    });
});

describe('v2 payment issues and plan changes', () => {
    describe.each(['subscription_cycle', 'subscription_update'])('provider payment state for %s', billingReason => {
        it.each(['invoice.payment_action_required', 'invoice.payment_failed'])(
            'records requires_action for both same-second 3DS deliveries, starting with %s', async firstType => {
                const { store, stripe, deps } = v2Fixture();
                stripe.invoice.billingReason = billingReason;
                stripe.invoice.status = 'open';
                stripe.paymentState = 'requires_action';
                if (billingReason === 'subscription_update') await seedChange(store);
                const recordIssue = vi.spyOn(store, 'recordPaymentIssue');
                const secondType = firstType === 'invoice.payment_failed' ? 'invoice.payment_action_required' : 'invoice.payment_failed';
                for (const type of [firstType, secondType]) {
                    const delivery = { ...issueEvent(type, true), id: `evt_${type}` };
                    expect(await processStripeEvent(delivery, deps)).toBe('applied');
                    expect(recordIssue).toHaveBeenLastCalledWith(expect.objectContaining({ issue: 'requires_action', eventCreated: now }));
                    expect(await store.openPaymentIssues('user_local')).toEqual([expect.objectContaining({ issue: 'requires_action' })]);
                    if (billingReason === 'subscription_update') expect(store.planChanges[0].state).toBe('requires_action');
                }
                expect(recordIssue).toHaveBeenCalledTimes(2);
                expect(stripe.reads.filter(read => read === 'invoice_payment:in_local')).toHaveLength(2);
                expect(store.grants.size).toBe(0);
            },
        );

        it.each(['failed', 'none'] as const)('records payment_failed from provider state %s for either issue event', async state => {
            for (const type of ['invoice.payment_failed', 'invoice.payment_action_required']) {
                const { store, stripe, deps } = v2Fixture();
                stripe.invoice.billingReason = billingReason;
                stripe.invoice.status = 'open';
                stripe.paymentState = state;
                if (billingReason === 'subscription_update') await seedChange(store);
                expect(await processStripeEvent(issueEvent(type, true), deps)).toBe('applied');
                expect(await store.openPaymentIssues('user_local')).toEqual([expect.objectContaining({ issue: 'payment_failed' })]);
                if (billingReason === 'subscription_update') expect(store.planChanges[0].state).toBe('payment_failed');
            }
        });
    });

    it('keeps a concurrent 3DS upgrade requires_action when the failed delivery finishes subscription sync last', async () => {
        const { store, stripe, deps } = v2Fixture();
        await seedChange(store);
        stripe.invoice.billingReason = 'subscription_update';
        stripe.invoice.status = 'open';
        stripe.paymentState = 'requires_action';
        let release!: () => void;
        const syncPending = new Promise<void>(resolve => { release = resolve; });
        vi.spyOn(stripe, 'retrieveSubscription').mockImplementation(async () => {
            await syncPending;
            return stripe.subscription;
        });
        const failed = processStripeEvent({ ...issueEvent('invoice.payment_failed', true), id: 'evt_failed' }, deps);
        try {
            expect(await processStripeEvent({ ...issueEvent('invoice.payment_action_required', true), id: 'evt_action' }, deps)).toBe('applied');
        } finally {
            release();
        }
        expect(await failed).toBe('applied');
        expect(await store.openPaymentIssues('user_local')).toEqual([expect.objectContaining({ issue: 'requires_action' })]);
        expect(store.planChanges[0].state).toBe('requires_action');
    });

    it.each([
        ['paid', 'failed'], ['open', 'paid'], ['open', 'processing'],
    ] as const)('ignores stale payment events when invoice=%s and payment=%s without issue effects', async (status, state) => {
        for (const kind of ['subscription', 'upgrade', 'overage']) {
            for (const type of ['invoice.payment_failed', 'invoice.payment_action_required']) {
                const f = v2Fixture();
                if (kind === 'upgrade') {
                    await seedChange(f.store);
                    f.stripe.invoice.billingReason = 'subscription_update';
                }
                if (kind === 'overage') await seedOverage(f);
                f.stripe.invoice.status = status;
                f.stripe.paymentState = state;
                const writes = [vi.spyOn(f.store, 'recordPaymentIssue'), vi.spyOn(f.store, 'setPlanChangeState'),
                    vi.spyOn(f.store, 'setOverageInvoiceStatus'), vi.spyOn(f.store, 'recordConsent')];
                expect(await processStripeEvent(issueEvent(type, kind !== 'overage'), f.deps)).toBe('ignored');
                for (const write of writes) expect(write).not.toHaveBeenCalled();
                expect(f.store.issues.size).toBe(0);
            }
        }
    });

    it.each(['invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible'])('ignores unrelated standalone %s without recording a payment issue', async type => {
        const { store, stripe, deps } = v2Fixture();
        stripe.invoice.subscriptionId = null;
        stripe.invoice.billingReason = 'manual';
        stripe.invoice.status = 'open';
        const recordPaymentIssue = vi.spyOn(store, 'recordPaymentIssue');
        expect(await processStripeEvent(issueEvent(type), deps)).toBe('ignored');
        expect(recordPaymentIssue).not.toHaveBeenCalled();
        expect(store.issues.size).toBe(0);
        expect(store.consents).toEqual([]);
        expect(store.planChanges).toEqual([]);
        expect(store.writes).toEqual([]);
    });

    it.each(['invoice.payment_failed', 'invoice.payment_action_required', 'invoice.voided', 'invoice.marked_uncollectible'])('reviews %s for unknown overage without writes, with a known-row control', async type => {
        const f = v2Fixture('compute_monthly_v2');
        await seedOverage(f);
        f.stripe.invoice.status = 'open';
        const [overage] = f.store.overageInvoices.splice(0);
        const recordPaymentIssue = vi.spyOn(f.store, 'recordPaymentIssue');
        const recordConsent = vi.spyOn(f.store, 'recordConsent');
        const setOverageInvoiceStatus = vi.spyOn(f.store, 'setOverageInvoiceStatus');
        expect(await processStripeEvent(issueEvent(type), f.deps)).toBe('review:unknown_overage_invoice');
        expect(recordPaymentIssue).not.toHaveBeenCalled();
        expect(recordConsent).not.toHaveBeenCalled();
        expect(setOverageInvoiceStatus).not.toHaveBeenCalled();
        expect(f.store.issues.size).toBe(0);
        expect(f.store.writes).toEqual([]);
        expect(await f.store.latestConsent('user_local', 'sub_local')).toMatchObject({ enabled: true });

        f.store.overageInvoices.push(overage);
        expect(await processStripeEvent(issueEvent(type), f.deps)).toBe('applied');
        expect(await f.store.latestConsent('user_local', 'sub_local')).toMatchObject({
            enabled: false, actor: 'system:overage_payment_issue',
        });
        expect(f.store.issues.get('in_local')).toMatchObject({ invoiceKind: 'overage', subscriptionId: 'sub_local' });
    });

    it.each([
        ['invoice.payment_failed', 'payment_failed', 'payment_failed'],
        ['invoice.payment_action_required', 'requires_action', 'requires_action'],
        ['invoice.voided', 'voided', 'void'],
        ['invoice.marked_uncollectible', 'uncollectible', 'uncollectible'],
    ])('records %s on overage and disables consent once', async (type, issue, status) => {
        const f = v2Fixture('compute_monthly_v2');
        await seedOverage(f);
        f.stripe.invoice.status = 'open';
        f.stripe.paymentState = issue === 'requires_action' ? 'requires_action' : issue === 'payment_failed' ? 'failed' : 'paid';
        const paymentState = vi.spyOn(f.stripe, 'retrieveInvoicePaymentState');
        const input = issueEvent(type);
        expect(await processStripeEvent(input, f.deps)).toBe('applied');
        expect(await processStripeEvent(input, f.deps)).toBe('applied');
        expect(await f.store.openPaymentIssues('user_local')).toEqual([expect.objectContaining({
            stripeInvoiceId: 'in_local', userId: 'user_local', subscriptionId: 'sub_local', invoiceKind: 'overage', issue,
            hostedInvoiceUrl: 'https://invoice.stripe.com/local', stripeEventCreated: now,
        })]);
        expect(f.store.overageInvoices[0].status).toBe(status);
        expect(f.store.consents).toHaveLength(2);
        expect(await f.store.latestConsent('user_local', 'sub_local')).toMatchObject({
            enabled: false, capCents: 4200, actor: 'system:overage_payment_issue', acceptedAt: now,
            termsVersion: OVERAGE_TERMS_VERSION, catalogVersion: 2, rateCentsPerStdHour: 25,
        });
        expect(f.store.grants.size).toBe(0);
        if (issue === 'voided' || issue === 'uncollectible') expect(paymentState).not.toHaveBeenCalled();
    });

    it.each([
        ['invoice.payment_failed', 'payment_failed'], ['invoice.payment_action_required', 'requires_action'],
    ])('records %s on an upgrade without granting', async (type, state) => {
        const { store, stripe, deps } = v2Fixture();
        await seedChange(store);
        stripe.invoice.billingReason = 'subscription_update';
        stripe.invoice.status = 'open';
        stripe.paymentState = state === 'requires_action' ? 'requires_action' : 'failed';
        expect(await processStripeEvent(issueEvent(type, true), deps)).toBe('applied');
        expect(store.planChanges[0]).toMatchObject({ state, stripeInvoiceId: 'in_local' });
        expect(await store.openPaymentIssues('user_local')).toEqual([expect.objectContaining({ invoiceKind: 'upgrade', issue: state })]);
        expect(store.grants.size).toBe(0);
        if (type === 'invoice.payment_failed') expect(store.subscriptions.get('sub_local')?.sku).toBe('standard_monthly_v2');
    });

    it('syncs failed subscription payments and records their issue', async () => {
        const { store, stripe, deps } = v2Fixture();
        stripe.subscription.status = 'past_due';
        stripe.invoice.status = 'open';
        expect(await processStripeEvent(issueEvent('invoice.payment_failed', true), deps)).toBe('applied');
        expect(store.subscriptions.get('sub_local')?.status).toBe('past_due');
        expect(await store.openPaymentIssues('user_local')).toEqual([expect.objectContaining({ invoiceKind: 'subscription', issue: 'payment_failed' })]);
        expect(store.grants.size).toBe(0);
    });

    it('scopes upgrade invoice issue plan changes to the resolved user', async () => {
        const { store, stripe, deps } = v2Fixture();
        await seedChange(store);
        store.planChanges[0].userId = 'user_owner';
        stripe.invoice.billingReason = 'subscription_update';
        stripe.invoice.status = 'open';
        stripe.paymentState = 'requires_action';
        const update = vi.spyOn(store, 'setPlanChangeState');
        expect(await processStripeEvent(issueEvent('invoice.payment_action_required', true), deps)).toBe('applied');
        expect(update).toHaveBeenCalledWith({ userId: 'user_local', subscriptionId: 'sub_local', kind: 'upgrade',
            stripeInvoiceId: 'in_local', state: 'requires_action' });
        expect(store.planChanges[0].state).toBe('pending');
    });

    it.each(['applied', 'expired'] as const)('syncs pending update %s and changes only the open upgrade state', async outcome => {
        const { store, stripe, deps } = v2Fixture(outcome === 'applied' ? 'compute_monthly_v2' : 'standard_monthly_v2');
        await seedChange(store);
        expect(await processStripeEvent(event(`customer.subscription.pending_update_${outcome}`, {
            id: 'sub_local', pending_update: null,
        }), deps)).toBe('applied');
        expect(store.planChanges[0].state).toBe(outcome);
        expect(store.subscriptions.get('sub_local')?.sku).toBe(stripe.subscription.sku);
        expect(store.grants.size).toBe(0);
    });

    it('does not use invoice metadata to attribute payment issues', async () => {
        const f = v2Fixture();
        await seedOverage(f);
        f.stripe.invoice.status = 'open';
        f.store.customers.clear();
        expect(await processStripeEvent(issueEvent('invoice.payment_failed'), f.deps)).toBe('unattributed:customer');
        expect(f.store.issues.size).toBe(0);
        expect(f.store.consents).toHaveLength(1);
    });
});

describe('late usage heartbeat', () => {
    it('accepts late heartbeats after stop without opening or touching, and allows an explicit restart', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(now.getTime());
        const { store } = fixture();
        const usage = (type: 'start' | 'stop' | 'heartbeat', seconds: number): UsageEvent => ({
            type, computerId: 'computer_local', at: new Date(now.getTime() + seconds * 1000).toISOString(),
        });
        expect(await ingestUsageEvents([usage('start', 0), usage('stop', 60)], { store })).toEqual({ accepted: 2, rejected: 0 });
        const calls = [...store.usageCalls];
        expect(await ingestUsageEvents([usage('heartbeat', 30), usage('heartbeat', 120)], { store })).toEqual({ accepted: 2, rejected: 0 });
        expect(store.usageCalls).toEqual(calls);
        expect(store.intervals).toHaveLength(1);
        expect(store.intervals[0].endedAt).toEqual(new Date(now.getTime() + 60000));
        await ingestUsageEvents([usage('start', 150), usage('heartbeat', 180)], { store });
        expect(store.intervals).toHaveLength(2);
        expect(store.intervals[1]).toMatchObject({ endedAt: null, lastSeenAt: new Date(now.getTime() + 180000) });
    });
});

describe('scheduled downgrade completion', () => {
    it.each(['customer.subscription.updated', 'customer.subscription.pending_update_applied'])('applies a matching scheduled downgrade on %s once', async type => {
        const { store, stripe, deps } = fixture();
        stripe.subscription.sku = 'standard_monthly_v2';
        stripe.subscription.currentPeriodStart = periodEnd;
        await store.recordPlanChange({ userId: 'user_local', subscriptionId: 'sub_local', kind: 'downgrade',
            fromSku: 'compute_monthly_v2', toSku: 'standard_monthly_v2', state: 'scheduled', stripeScheduleId: 'sched_local',
            stripeInvoiceId: null, hostedInvoiceUrl: null, effectiveAt: periodEnd, expiresAt: null });
        const write = vi.spyOn(store, 'setPlanChangeState');
        await processStripeEvent(event(type, { id: 'sub_local' }), deps);
        expect(store.planChanges[0]).toMatchObject({ state: 'applied', effectiveAt: periodEnd });
        expect(store.grants.size).toBe(0);
        await processStripeEvent(event(type, { id: 'sub_local' }), deps);
        expect(write.mock.calls.filter(([input]) => input.kind === 'downgrade')).toEqual([[{
            userId: 'user_local', subscriptionId: 'sub_local', kind: 'downgrade', state: 'applied', effectiveAt: periodEnd,
        }]]);
    });

    it.each(['wrong sku', 'other subscription', 'other user', 'pending', 'canceled', 'stale', 'conflict'])('does not complete a downgrade for %s', async scenario => {
        const { store, stripe, deps } = fixture();
        stripe.subscription.sku = 'standard_monthly_v2';
        await store.recordPlanChange({ userId: 'user_local', subscriptionId: 'sub_local', kind: 'downgrade',
            fromSku: 'compute_monthly_v2', toSku: 'standard_monthly_v2', state: 'scheduled', stripeScheduleId: 'sched_local',
            stripeInvoiceId: null, hostedInvoiceUrl: null, effectiveAt: periodEnd, expiresAt: null });
        if (scenario === 'wrong sku') stripe.subscription.sku = 'compute_monthly_v2';
        if (scenario === 'other subscription') store.planChanges[0].subscriptionId = 'sub_other';
        if (scenario === 'other user') store.planChanges[0].userId = 'user_other';
        if (scenario === 'pending' || scenario === 'canceled') store.planChanges[0].state = scenario;
        if (scenario === 'stale' || scenario === 'conflict') vi.spyOn(store, 'upsertSubscription').mockResolvedValue(scenario);
        const before = { ...store.planChanges[0] };
        await processStripeEvent(event('customer.subscription.updated', { id: 'sub_local' }), deps);
        expect(store.planChanges[0]).toEqual(before);
    });
});

describe('v3 paid invoice grants', () => {
    function v3Fixture(sku: 'standard_monthly_v3' | 'premium_monthly_v3' = 'standard_monthly_v3') {
        const f = fixture();
        f.stripe.subscription.sku = sku;
        f.stripe.subscription.items = [{ id: 'si_v3', priceId: 'price_v3', lookupKey: `ezil_${sku}` }];
        f.stripe.invoice.lines = [{ ...baseLine('standard_monthly_v2'), lookupKey: `ezil_${sku}` }];
        return f;
    }
    it.each([['standard_monthly_v3', 144000], ['premium_monthly_v3', 1800000]] as const)
    ('%s grants the invoiced period once and reverses it on a refund', async (sku, seconds) => {
        const { store, stripe, deps } = v3Fixture(sku);
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect([...store.grants.values()]).toEqual([expect.objectContaining({ amount: BigInt(seconds), periodStart, periodEnd,
            subscriptionId: 'sub_local', meter: 'compute_std_seconds', kind: 'plan_period' })]);
        const entitlementId = `ezil-os:v1:${sku}:sub_local:${periodStart.toISOString()}`;
        expect([...store.outbox.values()]).toEqual([expect.objectContaining({ eventKey: `${entitlementId}:grant`, kind: 'ai_grant',
            payload: expect.objectContaining({ entitlementId, credits: sku === 'standard_monthly_v3' ? 4000 : 20000,
                action: 'grant', expiresAt: '2026-11-04T00:00:00.000Z' }) })]);
        stripe.charge.invoiceId = stripe.invoice.id;
        stripe.charge.refunded = true;
        const delivery = event('charge.refunded', { id: stripe.charge.id, refunded: true, refunds: { data: [{ id: 're_v3' }] } });
        expect(await processStripeEvent(delivery, deps)).toBe('applied');
        expect([...store.grants.values()].reduce((sum, grant) => sum + grant.amount, BigInt(0))).toBe(BigInt(0));
        expect(store.outbox.size).toBe(2);
        expect(store.outbox.get(`${entitlementId}:revoke`)).toMatchObject({ kind: 'ai_revoke',
            payload: { eventId: `${entitlementId}:revoke`, entitlementId, action: 'revoke', credits: sku === 'standard_monthly_v3' ? 4000 : 20000 } });
        await processStripeEvent({ ...delivery, id: 'evt_refund_replayed' }, deps);
        expect(store.outbox.size).toBe(2);
    });
    it('late Standard invoices retain Standard terms after Premium upgrade', async () => {
        const { store, stripe, deps } = v3Fixture('premium_monthly_v3');
        stripe.invoice.lines[0]!.lookupKey = 'ezil_standard_monthly_v3';
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect([...store.grants.values()][0]!.amount).toBe(BigInt(144000));
        expect([...store.outbox.values()][0]!.payload.credits).toBe(4000);
    });
    it.each(['open', 'manual', 'foreign', 'ambiguous'] as const)('does not grant %s invoices', async scenario => {
        const { store, stripe, deps } = v3Fixture();
        if (scenario === 'open') stripe.invoice.status = 'open';
        if (scenario === 'manual') stripe.invoice.billingReason = 'manual';
        if (scenario === 'foreign') stripe.invoice.lines[0]!.subscriptionId = 'sub_foreign';
        if (scenario === 'ambiguous') stripe.invoice.lines.push({ ...stripe.invoice.lines[0]!, lookupKey: 'ezil_premium_monthly_v3' });
        expect(await processStripeEvent(paidV2(), deps)).toBe(scenario === 'foreign' ? 'review:no_base_line'
            : scenario === 'ambiguous' ? 'review:ambiguous_base_line' : 'ignored');
        expect(store.grants.size).toBe(0);
        expect(store.outbox.size).toBe(0);
    });
    it('repairs an interrupted paid outbox write and enqueues one grant under a different event replay', async () => {
        const f = v3Fixture();
        vi.spyOn(f.store, 'enqueueOutbox').mockRejectedValueOnce(new Error('transient'));
        await expect(processStripeEvent(paidV2(), f.deps)).rejects.toThrow('transient');
        expect(f.store.grants.size).toBe(1); expect(f.store.outbox.size).toBe(0);
        await processStripeEvent(paidV2(), f.deps);
        await processStripeEvent({ ...paidV2(), id: 'evt_another' }, f.deps);
        expect(f.store.grants.size).toBe(1); expect(f.store.outbox.size).toBe(1);
    });
    it('revokes a disputed period once and a won dispute cannot grant an irrevocably revoked entitlement again', async () => {
        const f = v3Fixture(); await processStripeEvent(paidV2(), f.deps);
        f.stripe.charge.invoiceId = f.stripe.invoice.id;
        await processStripeEvent(dispute(), f.deps); await processStripeEvent(dispute(), f.deps);
        expect([...f.store.outbox.values()].map(item => item.payload.action)).toEqual(['grant', 'revoke']);
        await processStripeEvent(dispute(true), f.deps);
        expect(f.store.outbox.size).toBe(2);
    });
    it('revokes the stored policy and account, even when the subscription and invoice adapter now report Premium', async () => {
        const f = v3Fixture(); await processStripeEvent(paidV2(), f.deps);
        const receipt = [...f.store.outbox.values()][0]!;
        Object.assign(receipt.payload, { credits: 1234, accountPublicId: 'original-account', delivery: { status: 'done' } });
        f.stripe.charge.invoiceId = f.stripe.invoice.id;
        f.stripe.subscription.sku = 'premium_monthly_v3';
        f.stripe.invoice.lines[0]!.lookupKey = 'ezil_premium_monthly_v3';
        await processStripeEvent(refund(), f.deps);
        const revoked = [...f.store.outbox.values()][1]!;
        expect(revoked.payload).toMatchObject({ entitlementId: receipt.payload.entitlementId,
            credits: 1234, action: 'revoke', accountPublicId: 'original-account' });
        expect(revoked.payload).not.toHaveProperty('delivery');
    });
    it('a refund between ledger and outbox writes enqueues revoke before the repaired grant', async () => {
        const f = v3Fixture();
        vi.spyOn(f.store, 'enqueueOutbox').mockRejectedValueOnce(new Error('interrupted'));
        await expect(processStripeEvent(paidV2(), f.deps)).rejects.toThrow();
        f.stripe.charge.invoiceId = f.stripe.invoice.id;
        await processStripeEvent(refund(), f.deps);
        await processStripeEvent(paidV2(), f.deps);
        expect([...f.store.outbox.values()].map(item => item.payload.action)).toEqual(['revoke', 'grant']);
    });
    it('does not revoke AI on partial refunds or a charge ownership mismatch', async () => {
        const f = v3Fixture(); await processStripeEvent(paidV2(), f.deps);
        f.stripe.charge.invoiceId = f.stripe.invoice.id;
        f.stripe.charge.refunded = false;
        expect(await processStripeEvent(refund(), f.deps)).toBe('review:partial_refund');
        f.stripe.charge.refunded = true; f.store.customers.set('cus_local', 'another-user');
        expect(await processStripeEvent(refund(), f.deps)).toBe('review:customer_mismatch');
        expect(f.store.outbox.size).toBe(1);
    });
    it('a paid v3 upgrade grants only its prorated delta, and rejects mixed-version credit lines', async () => {
        const { store, stripe, deps } = v3Fixture('premium_monthly_v3');
        stripe.invoice.billingReason = 'subscription_update';
        stripe.invoice.lines = [
            { ...baseLine('standard_monthly_v2'), lookupKey: 'ezil_standard_monthly_v3', amount: -1000, proration: true, periodStart: now },
            { ...baseLine('compute_monthly_v2'), lookupKey: 'ezil_premium_monthly_v3', amount: 2000, proration: true, periodStart: now },
        ];
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        const expected = BigInt(1656000) * BigInt((periodEnd.getTime() - now.getTime()) / 1000) / BigInt((periodEnd.getTime() - periodStart.getTime()) / 1000);
        expect([...store.grants.values()][0]).toMatchObject({ kind: 'upgrade_prorated', amount: expected, periodStart, periodEnd });
        const other = v3Fixture('premium_monthly_v3');
        other.stripe.invoice.billingReason = 'subscription_update';
        other.stripe.invoice.lines = stripe.invoice.lines.map(line => ({ ...line }));
        other.stripe.invoice.lines[0]!.lookupKey = 'ezil_standard_monthly_v2';
        expect(await processStripeEvent(paidV2(), other.deps)).toBe('ignored');
        expect(other.store.grants.size).toBe(0);
    });
    it('resolves Premium from the line lookup key despite stale Standard checkout metadata', async () => {
        const f = v3Fixture('premium_monthly_v3');
        const client = createStripeClient({ secretKey: 'fixture', fetch: vi.fn<typeof fetch>().mockResolvedValue(Response.json({
            id: 'sub_local', customer: 'cus_local', status: 'active', cancel_at_period_end: false, metadata: { sku: 'standard_monthly_v3' },
            items: { data: [{ id: 'si_v3', price: { id: 'price_v3', lookup_key: 'ezil_premium_monthly_v3' },
                current_period_start: periodStart.getTime() / 1000, current_period_end: periodEnd.getTime() / 1000 }] },
        })) });
        vi.spyOn(f.stripe, 'retrieveSubscription').mockImplementation(client.retrieveSubscription);
        expect(await processStripeEvent(paidV2(), f.deps)).toBe('applied');
        expect(f.store.subscriptions.get('sub_local')?.sku).toBe('premium_monthly_v3');
    });
});
