import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PRO_PLAN } from './catalog';
import * as catalog from './catalog';
import { aiCreditOutboxItem, aiCreditRevokeItem, planAiReversal, type AiReversalStore, type AiReversalReceipt, type AiTopupReceiptStore } from './ai-credits';
import { drainAiCreditOutbox, type AiCreditOutboxRow } from './ai-credit-outbox';
import type {
    BillingStore, GrantInsert, GrantRow, GrantSource, OutboxInsert, ProcessorDeps,
    StorageSample, StripeApi, StripeCharge, StripeCheckoutSession, StripeInvoice, StripeInvoicePaymentState,
    StripeSubscription, SubscriptionUpsert, UsageEvent, OverageConsentRow, OverageInvoiceRow, PlanChangeRow, PaymentIssueRow, StoredComputeEpoch,
} from './ports';
import { ingestUsageEvents, processStripeEvent } from './processor';
import { packProduct, packPrice } from './stripe/packs.test-support';
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
class MemoryStore implements BillingStore, AiTopupReceiptStore, AiReversalStore {
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
        const epoch = this.epochs.find(e => e.computerId === input.computerId && e.endedAt === null
            && (input.epochId === undefined || e.id === input.epochId)
            && (input.readyBy === undefined || Date.parse(e.readyAt) <= Math.ceil(input.readyBy.getTime() / 1000) * 1000));
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
    outbox = new Map<string, AiReversalReceipt>();
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
    providers = new Map<string, string>();
    async placementProvider(computerId: string) { return this.providers.get(computerId) ?? null; }
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
    async aiTopupReceipt(userId: string, paymentIntentId: string) {
        return [...this.outbox.values()].find(item => item.userId === userId && item.kind === 'ai_grant'
            && item.payload.protocol === 'ezil-ai-credits-v1' && item.payload.paymentIntentId === paymentIntentId) ?? null;
    }
    recordAiTopup: AiTopupReceiptStore['recordAiTopup'] = async (grant, receipt) => {
        const original = [...this.grants.values()].find(row => row.kind === 'topup' && row.sourceId === grant.sourceId);
        if (original && original.userId !== grant.userId) return 'review:customer_mismatch';
        if (await this.aiTopupReceipt(grant.userId, grant.sourceId)) return 'applied';
        if (original || this.outbox.has(`payment_intent:${grant.sourceId}:ai_topup`)) return 'review:legacy_topup_unfunded';
        const before = { grants: new Map(this.grants), outbox: new Map(this.outbox), writes: [...this.writes] };
        try {
            await this.insertGrant(grant);
            await this.enqueueOutbox(receipt);
        } catch (error) {
            this.grants = before.grants; this.outbox = before.outbox; this.writes = before.writes;
            throw error;
        }
        return 'applied';
    };
    private reversalQueue: Promise<unknown> = Promise.resolve();
    recordAiReversal: AiReversalStore['recordAiReversal'] = input => {
        const run = this.reversalQueue.then(async () => {
            const first = input.originals[0]!;
            const plan = planAiReversal(input, {
                originals: [...this.grants.values()].filter(g => g.sourceType === first.sourceType && g.sourceId === first.sourceId),
                corrections: [...this.grants.values()].filter(g => g.sourceType === 'refund' || g.sourceType === 'dispute'),
                receipts: [...this.outbox.values()],
            });
            if (plan.outcome !== 'applied') return plan.outcome;
            const before = { grants: new Map(this.grants), outbox: new Map(this.outbox), writes: [...this.writes] };
            try {
                for (const grant of plan.grants) if (await this.insertGrant(grant) !== 'inserted') throw new Error('conflict');
                for (const item of plan.outbox) if (await this.enqueueOutbox(item) !== 'queued') throw new Error('conflict');
            } catch (error) {
                this.grants = before.grants; this.outbox = before.outbox; this.writes = before.writes;
                throw error;
            }
            return 'applied';
        });
        this.reversalQueue = run.catch(() => {});
        return run;
    };
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
    product = structuredClone(packProduct);
    lines = [{ quantity: 1, price: { ...packPrice } }];
    async listProducts() { return [this.product]; }
    async retrieveProduct() { return this.product; }
    async retrievePackPrice() { return packPrice; }
    async retrieveCoupon() { return null; }
    async retrieveCheckoutLineItems() { return this.lines; }
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
// Historical test-only policies preserve coverage of immutable v1 receipts.
const findPack = catalog.findPack;
beforeEach(() => {
    vi.spyOn(catalog, 'findPack').mockImplementation(sku => {
        const pack = findPack(sku);
        return pack?.sku.endsWith('_v1') ? { ...pack, aiCredits: sku === 'ai_pack_10_v1' ? 1234 : 5678 } : pack;
    });
});
vi.mock('@/server/lib/compute/provider-migrate-orchestrator', () => ({ schedulePaidMigration: vi.fn() }));

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
            if (makeEvent().type.startsWith('charge.')) await seedTopup(good.store);
            expect(await processStripeEvent(makeEvent(), good.deps)).toBe(makeEvent().type === 'charge.dispute.closed'
                ? 'review:restore_refused_terminal' : 'applied');
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
        expect(store.outbox.get(`ezil-os:v1:topup:${sku}:pi_local:grant`)).toMatchObject({
            kind: 'ai_grant', payload: { protocol: 'ezil-ai-credits-v1', credits: sku === 'ai_pack_10_v1' ? 1234 : 5678,
                amountUsdMicro: amount, bucket: 'purchased', expiresAt: '2027-10-11T12:00:00.000Z', providerObjectId: 'pi_local' },
        });
    });

    it('uses a stable twelve-month expiry for a delayed leap-day purchase', async () => {
        const { store, deps } = fixture();
        const input = { ...checkout(false), created: Date.parse('2024-02-29T12:00:00Z') / 1000 };
        expect(await processStripeEvent(input, deps)).toBe('applied');
        expect(store.outbox.get('ezil-os:v1:topup:ai_pack_10_v1:pi_local:grant')?.payload.expiresAt).toBe('2025-02-28T12:00:00.000Z');
    });

    it('keeps historical v1 packs unfunded when their credit policy is unset', async () => {
        vi.mocked(catalog.findPack).mockImplementation(findPack);
        const f = fixture();
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:pack_credits_unset');
        expect(f.store.outbox.size).toBe(0);
        expect(f.store.grants.size).toBe(0);
    });

    function stripePackFixture() {
        const f = fixture();
        Object.assign(f.stripe.session, { sku: 'ai_pack_fixture', metadataCredits: '1000', currency: 'usd', amountTotal: 8000 });
        return f;
    }
    it.each([1000, 5000, 10000])('verifies the Stripe product and grants %i credits exactly once', async credits => {
        const f = stripePackFixture();
        f.stripe.product.metadata.ezil_credits = String(credits);
        f.stripe.session.metadataCredits = String(credits);
        f.stripe.lines[0]!.price.unitAmount = credits * 10;
        const input = checkout(false);
        input.data.object.metadata = { ezil_credits: '999999', sku: 'ai_pack_untrusted' };
        expect(await processStripeEvent(input, f.deps)).toBe('applied');
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('applied');
        expect([...f.store.grants.values()]).toHaveLength(1);
        expect([...f.store.grants.values()][0]).toMatchObject({ kind: 'topup', amount: BigInt(credits * 10) * BigInt(10000) });
        expect([...f.store.outbox.values()]).toHaveLength(1);
        expect([...f.store.outbox.values()][0]).toMatchObject({ eventKey: 'ezil-os:v1:topup:ai_pack_fixture:pi_local:grant',
            kind: 'ai_grant', payload: { credits, packSku: 'ai_pack_fixture' } });
    });
    it.each([undefined, null, '', '999', '1000.0', '10000'])('reviews mismatched pack session credits %s', async metadataCredits => {
        const f = stripePackFixture(); f.stripe.session.metadataCredits = metadataCredits;
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:pack_credits_mismatch');
        expect(f.store.grants.size).toBe(0);
        expect(f.store.outbox.size).toBe(0);
    });
    it.each([{ ezil_kind: 'other' }, { ezil_credits: '0' }, { ezil_credits: '10001' }])('requires pack product metadata %j', async change => {
        const f = stripePackFixture(); Object.assign(f.stripe.product.metadata, change);
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:pack_credits_mismatch');
        expect(f.store.grants.size).toBe(0);
    });
    it.each([{ currency: 'eur' }, { currency: null }, { amountTotal: 10001 }, { amountTotal: null },
        { amountTotal: -1 }, { amountTotal: 8000.5 }])('reviews invalid pack payment %j', async change => {
        const f = stripePackFixture(); Object.assign(f.stripe.session, change);
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:invalid_pack_amount');
        expect(f.store.grants.size).toBe(0);
        expect(f.store.outbox.size).toBe(0);
    });
    it.each([{ currency: 'eur' }, { unitAmount: 8000 }, { type: 'recurring' }])('reviews invalid purchased price %j', async change => {
        const f = stripePackFixture(); Object.assign(f.stripe.lines[0]!.price, change);
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:invalid_pack_price');
        expect(f.store.grants.size).toBe(0);
    });
    it('requires one purchased unit and a SKU matching its product', async () => {
        const f = stripePackFixture(); f.stripe.lines[0]!.quantity = 2;
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:invalid_pack_line');
        f.stripe.lines[0]!.quantity = 1;
        f.stripe.session.sku = 'ai_pack_other';
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:unknown_sku');
        expect(f.store.grants.size).toBe(0);
    });
    it('replays and refunds stored pack terms after the product changes or becomes unavailable', async () => {
        const f = stripePackFixture();
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('applied');
        f.stripe.product.metadata.ezil_credits = '5000';
        vi.spyOn(f.stripe, 'retrieveProduct').mockRejectedValue(new Error('unavailable'));
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('applied');
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect([...f.store.outbox.values()].find(item => item.kind === 'ai_revoke')?.payload.credits).toBe(1000);
    });

    it.each([1000, 12300, 1000000])('derives custom credits from verified amount %i and refunds the stored receipt', async amountTotal => {
        const f = fixture();
        Object.assign(f.stripe.session, { sku: 'ai_custom_v2', amountTotal, currency: 'usd', metadataCredits: String(amountTotal / 10) });
        const paid = checkout(false);
        Object.assign(paid.data.object, { amount_total: 99999999, metadata: { sku: 'ai_custom_v2', credits: '9999999' } });
        expect(await processStripeEvent(paid, f.deps)).toBe('applied');
        expect(await processStripeEvent(paid, f.deps)).toBe('applied');
        expect([...f.store.grants.values()]).toHaveLength(1);
        expect([...f.store.grants.values()][0]).toMatchObject({ kind: 'topup', amount: BigInt(amountTotal) * BigInt(10000) });
        expect([...f.store.outbox.values()][0]).toMatchObject({
            eventKey: 'ezil-os:v1:topup:ai_custom_v2:pi_local:grant', payload: { credits: amountTotal / 10 },
        });
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect([...f.store.outbox.values()].find(item => item.kind === 'ai_revoke')?.payload.credits).toBe(amountTotal / 10);
    });

    it.each([undefined, null, '101', '100.0', '1000', ''])('refuses custom metadata credits %s that disagree with Stripe', async metadataCredits => {
        const f = fixture();
        Object.assign(f.stripe.session, { sku: 'ai_custom_v2', amountTotal: 1000, currency: 'usd', metadataCredits });
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:custom_credits_mismatch');
        expect(f.store.grants.size).toBe(0);
        expect(f.store.outbox.size).toBe(0);
    });

    it.each([undefined, null, 0, 900, 1001, 1000.5, 1000100, NaN, Infinity])('refuses invalid verified custom amount %s', async amountTotal => {
        const f = fixture();
        Object.assign(f.stripe.session, { sku: 'ai_custom_v2', amountTotal, currency: 'usd', metadataCredits: '100' });
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:invalid_custom_amount');
        expect(f.store.grants.size).toBe(0);
        expect(f.store.outbox.size).toBe(0);
    });

    it.each([undefined, null, 'eur'])('refuses custom fulfilment without verified USD (%s)', async currency => {
        const f = fixture();
        Object.assign(f.stripe.session, { sku: 'ai_custom_v2', amountTotal: 1000, currency, metadataCredits: '100' });
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:invalid_custom_amount');
        expect(f.store.grants.size).toBe(0);
        expect(f.store.outbox.size).toBe(0);
    });
    it('preserves first topup amount, expiry and account through later catalog changes, refund and replay', async () => {
        const f = fixture();
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('applied');
        const receipt = [...f.store.outbox.values()][0]!;
        receipt.payload.accountPublicId = 'original-account';
        const snapshot = structuredClone(receipt);
        vi.mocked(catalog.findPack).mockImplementation(sku => ({ ...findPack('ai_pack_10_v1')!, sku, aiCredits: 9999 }));
        expect(await processStripeEvent({ ...checkout(false), id: 'different-event', created: checkout(false).created + 86400 }, f.deps)).toBe('applied');
        expect([...f.store.outbox.values()]).toEqual([snapshot]);
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect(await processStripeEvent({ ...refund(), id: 'another-refund-event' }, f.deps)).toBe('applied');
        const reversal = [...f.store.outbox.values()][1]!;
        expect(reversal).toMatchObject({ eventKey: `${receipt.payload.entitlementId}:revoke:refund:re_local`,
            payload: { entitlementId: receipt.payload.entitlementId, credits: 1234,
                expiresAt: snapshot.payload.expiresAt, accountPublicId: 'original-account' } });
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('applied');
        expect(f.store.outbox.size).toBe(2);
        const beforeRestore = [...f.store.writes];
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_refused_terminal');
        expect(f.store.writes).toEqual(beforeRestore);
    });
    it('retries refund-before-purchase and delivers grant/revoke with one shared v1 entitlement in either order', async () => {
        const f = fixture();
        expect(await processStripeEvent(refund(), f.deps)).toBe('failed:no_grant_for_refund');
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('applied');
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        const items = [...f.store.outbox.values()];
        for (const order of [items, [...items].reverse()]) {
            const pending: AiCreditOutboxRow[] = order.map((item, index) => ({ ...item, id: String(index), attempts: 1 }));
            const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
            await drainAiCreditOutbox({ config: { fundingUrl: 'https://gateway.test', fundingHmacSecret: 'fixture' },
                clock: () => now.getTime(), fetch: fetcher, aiCredits: {
                    claim: async () => pending.shift() ?? null, accountFor: async () => 'account',
                    pinAccount: async () => true, finish: async () => {},
                } }, { limit: 2, deadlineMs: now.getTime() + 40_000 });
            const bodies = fetcher.mock.calls.map(call => JSON.parse(call[1]!.body as string));
            expect(bodies.map(body => body.action)).toEqual(order.map(item => item.payload.action));
            expect(new Set(bodies.map(body => body.entitlementId))).toEqual(new Set(['ezil-os:v1:topup:ai_pack_10_v1:pi_local']));
            expect(bodies.every(body => body.eventId === `${body.entitlementId}:${body.action}${body.action === 'revoke' ? ':refund:re_local' : ''}` && body.credits === 1234)).toBe(true);
        }
    });
    it('does not migrate an existing dollar-only topup on paid replay', async () => {
        const f = fixture();
        await seedTopup(f.store);
        await f.store.enqueueOutbox({ userId: 'user_local', eventKey: 'payment_intent:pi_local:ai_topup', kind: 'ai_grant',
            payload: { amountUsdMicro: '10000000', bucket: 'purchased' } });
        const before = structuredClone([...f.store.outbox.values()]);
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('review:legacy_topup_unfunded');
        expect([...f.store.outbox.values()]).toEqual(before);
        expect(f.store.grants.size).toBe(1);
    });
    it('can retry an interrupted atomic topup without leaving a ledger-only purchase', async () => {
        const f = fixture();
        vi.spyOn(f.store, 'enqueueOutbox').mockRejectedValueOnce(new Error('interrupted'));
        await expect(processStripeEvent(checkout(false), f.deps)).rejects.toThrow('interrupted');
        expect(f.store.grants.size).toBe(0);
        expect(f.store.outbox.size).toBe(0);
        expect(await processStripeEvent(checkout(false), f.deps)).toBe('applied');
        expect(f.store.grants.size).toBe(1);
        expect(f.store.outbox.size).toBe(1);
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

    it.each([['revoke', refund], ['suspend', dispute]] as const)(
        'appends %s with the original meter and period and queues its AI correction', async (kind, makeEvent) => {
            const { store, stripe, deps } = fixture();
            await seedTopup(store);
            expect(await processStripeEvent(makeEvent(), deps)).toBe('applied');
            expect(stripe.reads).toEqual(['charge:ch_local']);
            expect(store.sourceReads).toEqual(['payment_intent:pi_local']);
            expect([...store.grants.values()][1]).toMatchObject({
                kind, meter: 'ai_usd_micro', amount: BigInt(-10_000_000),
                periodStart, periodEnd, sourceType: kind === 'revoke' ? 'refund' : 'dispute',
                sourceId: kind === 'revoke' ? 're_local' : 'dp_local',
            });
            expect([...store.outbox.values()][0]).toMatchObject({
                eventKey: kind === 'revoke' ? 'refund:re_local:ai_revoke' : `dispute:dp_local:ai_${kind}`,
                kind: 'ai_revoke', payload: { amountUsdMicro: '10000000' },
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
        if (makeEvent().type === 'charge.dispute.closed') {
            expect(await processStripeEvent(makeEvent(), deps)).toBe('review:restore_refused_terminal');
            expect(store.grants.size).toBe(1);
            return;
        }
        expect(await processStripeEvent(makeEvent(), deps)).toBe('applied');
        expect(store.grants.size).toBe(2);
    });

    it.each([checkout, invoice, sync, () => checkout(false), refund, dispute, () => dispute(true)])(
        'does not add persisted effects on duplicate delivery %#', async makeEvent => {
            const { store, deps } = fixture();
            const input = makeEvent();
            if (input.type.startsWith('charge.')) await seedTopup(store);
            if (input.type === 'charge.dispute.closed') {
                const before = [...store.writes];
                expect(await processStripeEvent(input, deps)).toBe('review:restore_refused_terminal');
                expect(await processStripeEvent(input, deps)).toBe('review:restore_refused_terminal');
                expect(store.writes).toEqual(before);
                return;
            }
            expect(await processStripeEvent(input, deps)).toBe('applied');
            expect(store.writes.length).toBeGreaterThan(0);
            const writes = [...store.writes];
            expect(await processStripeEvent(input, deps)).toBe('applied');
            expect(store.writes).toEqual(writes);
        },
    );

    it('records both suspend and restore for the same canonical dispute receipt', async () => {
        const { store, stripe, deps } = fixture();
        stripe.charge.refunded = false;
        await processStripeEvent(checkout(false), deps);
        [...store.outbox.values()][0]!.payload.accountPublicId = 'original-account';
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
            expect(close).toHaveBeenCalledExactlyOnceWith({ computerId: 'computer_local', readyBy: new Date(now.getTime() + 120_000),
                endedAt: new Date(now.getTime() + 120_000), reason: expected });
            expect(store.epochs).toHaveLength(1);
            expect(store.epochs[0]).toMatchObject({ lastHeartbeatAt: new Date(now.getTime() + 60_000).toISOString(),
                endedAt: new Date(now.getTime() + 120_000).toISOString(), endReason: expected });
            expect(store.intervals[0]).toMatchObject({ reason: reason ?? 'stop', source: 'start' });
        });

    it('ignores a Worker stop for an AWS computer: its open epoch stays open (the AWS receipts own that close)', async () => {
        const { store } = fixture();
        store.providers.set('computer_local', 'aws-ec2');
        await store.openEpoch({ userId: 'user_local', computerId: 'computer_local', subscriptionId: 'sub_local', size: 'std-2', readyAt: now, overheadSeconds: 0 });
        const close = vi.spyOn(store, 'closeEpoch');
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await ingestUsageEvents([usage('stop', 60_000)], { store })).toEqual({ accepted: 1, rejected: 0 });
        expect(close).not.toHaveBeenCalled();
        expect(store.epochs[0]).toMatchObject({ size: 'std-2', endedAt: null });
        expect(info).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'billing-usage-stop-ignored', computerId: 'computer_local',
            at: new Date(now.getTime() + 60_000).toISOString(), provider: 'aws-ec2' }));
        // A Cloudflare computer's Worker stop still closes its epoch.
        store.providers.set('computer_local', 'cloudflare');
        expect(await ingestUsageEvents([usage('stop', 60_000)], { store })).toEqual({ accepted: 1, rejected: 0 });
        expect(store.epochs[0]?.endedAt).toBe(new Date(now.getTime() + 60_000).toISOString());
    });

    it('a Worker stop stamped before the open epoch became ready never closes it', async () => {
        const { store } = fixture();
        await ingestUsageEvents([usage('start', 120_000)], { store });
        expect(await ingestUsageEvents([usage('stop', 60_000)], { store })).toEqual({ accepted: 1, rejected: 0 });
        expect(store.epochs[0]?.endedAt).toBeNull();
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
                if (kind === 'dispute restore') {
                    const before = [...store.writes];
                    expect(await processStripeEvent(makeEvent(), deps)).toBe('review:restore_refused_terminal');
                    expect(await processStripeEvent(makeEvent(), deps)).toBe('review:restore_refused_terminal');
                    expect(store.writes).toEqual(before);
                    return;
                }
                expect(await processStripeEvent(makeEvent(), deps)).toBe('applied');
                const writes = [...store.writes];
                expect(await processStripeEvent(makeEvent(), deps)).toBe('applied');
                expect(store.writes).toEqual(writes);
                expect([...store.grants.values()]).toEqual([original, expect.objectContaining({
                    kind: kind === 'refund' ? 'revoke' : kind === 'dispute' ? 'suspend' : 'restore',
                    meter: original.meter, subscriptionId: original.subscriptionId,
                    amount: -original.amount,
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
        if (restore) {
            f.stripe.charge.refunded = false;
            expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_receipt_missing');
            expect(f.store.grants.size).toBe(1);
            return;
        }
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
            payload: expect.objectContaining({ entitlementId, credits: sku === 'standard_monthly_v3' ? 200 : 1000,
                action: 'grant', expiresAt: '2026-11-04T00:00:00.000Z' }) })]);
        stripe.charge.invoiceId = stripe.invoice.id;
        stripe.charge.refunded = true;
        const delivery = event('charge.refunded', { id: stripe.charge.id, refunded: true, refunds: { data: [{ id: 're_v3' }] } });
        expect(await processStripeEvent(delivery, deps)).toBe('applied');
        expect([...store.grants.values()].reduce((sum, grant) => sum + grant.amount, BigInt(0))).toBe(BigInt(0));
        expect(store.outbox.size).toBe(2);
        expect(store.outbox.get(`${entitlementId}:revoke:refund:re_v3`)).toMatchObject({ kind: 'ai_revoke',
            payload: { eventId: `${entitlementId}:revoke:refund:re_v3`, entitlementId, action: 'revoke', credits: sku === 'standard_monthly_v3' ? 200 : 1000 } });
        await processStripeEvent({ ...delivery, id: 'evt_refund_replayed' }, deps);
        expect(store.outbox.size).toBe(2);
    });
    it('late Standard invoices retain Standard terms after Premium upgrade', async () => {
        const { store, stripe, deps } = v3Fixture('premium_monthly_v3');
        stripe.invoice.lines[0]!.lookupKey = 'ezil_standard_monthly_v3';
        expect(await processStripeEvent(paidV2(), deps)).toBe('applied');
        expect([...store.grants.values()][0]!.amount).toBe(BigInt(144000));
        expect([...store.outbox.values()][0]!.payload.credits).toBe(200);
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
    it('keeps a refunded disputed period terminal without local restoration', async () => {
        const f = v3Fixture(); await processStripeEvent(paidV2(), f.deps);
        f.stripe.charge.invoiceId = f.stripe.invoice.id;
        await processStripeEvent(dispute(), f.deps); await processStripeEvent(dispute(), f.deps);
        expect([...f.store.outbox.values()].map(item => item.payload.action)).toEqual(['grant', 'revoke']);
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_refused_terminal');
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
    describe('round 3 D1: upgrade AI credits', () => {
        const upgradeRoot = `ezil-os:v1:premium_monthly_v3:sub_local:${now.toISOString()}:upgrade`;
        const upgradeCredits = Number(BigInt(800) * BigInt((periodEnd.getTime() - now.getTime()) / 1000)
            / BigInt((periodEnd.getTime() - periodStart.getTime()) / 1000));
        function upgraded() {
            const f = v3Fixture('premium_monthly_v3');
            f.stripe.invoice.id = 'in_upgrade';
            f.stripe.invoice.billingReason = 'subscription_update';
            f.stripe.invoice.lines = [
                { ...baseLine('standard_monthly_v2'), lookupKey: 'ezil_standard_monthly_v3', amount: -1000, proration: true, periodStart: now },
                { ...baseLine('compute_monthly_v2'), lookupKey: 'ezil_premium_monthly_v3', amount: 2000, proration: true, periodStart: now },
            ];
            f.stripe.charge.invoiceId = 'in_upgrade';
            return f;
        }
        const aiRows = (store: MemoryStore) => [...store.outbox.values()].filter(item => item.kind === 'ai_grant');
        it('enqueues exactly one prorated AI grant with the pinned id and expiry, once across replays', async () => {
            const f = upgraded();
            expect(upgradeCredits).toBe(529); // floor(800 × 20.5 / 31)
            expect(await processStripeEvent(paidV2(), f.deps)).toBe('applied');
            expect(await processStripeEvent(paidV2(), f.deps)).toBe('applied');
            expect(await processStripeEvent({ ...paidV2(), id: 'evt_redelivered' }, f.deps)).toBe('applied');
            expect(aiRows(f.store)).toEqual([{ eventKey: `${upgradeRoot}:grant`, userId: 'user_local', kind: 'ai_grant',
                payload: expect.objectContaining({ entitlementId: upgradeRoot, credits: upgradeCredits, action: 'grant',
                    invoiceId: 'in_upgrade', expiresAt: '2026-11-04T00:00:00.000Z', eventId: `${upgradeRoot}:grant` }) }]);
            expect(f.store.planChanges.every(change => change.state !== 'pending')).toBe(true);
        });
        it('repairs an outbox write interrupted after the compute grant on the next delivery', async () => {
            const f = upgraded();
            vi.spyOn(f.store, 'enqueueOutbox').mockRejectedValueOnce(new Error('interrupted'));
            await expect(processStripeEvent(paidV2(), f.deps)).rejects.toThrow('interrupted');
            expect(f.store.grants.size).toBe(1); expect(aiRows(f.store)).toHaveLength(0);
            expect(await processStripeEvent(paidV2(), f.deps)).toBe('applied');
            expect(f.store.grants.size).toBe(1); expect(aiRows(f.store)).toHaveLength(1);
        });
        it.each(['unpaid', 'late renewal', 'mismatched end', 'v2 credit line', 'no credit line'] as const)('a %s upgrade invoice enqueues no AI credits', async scenario => {
            const f = upgraded();
            if (scenario === 'unpaid') f.stripe.invoice.status = 'open';
            if (scenario === 'late renewal') f.stripe.subscription.currentPeriodEnd = new Date('2026-12-01T00:00:00.000Z');
            if (scenario === 'mismatched end') f.stripe.invoice.lines[1]!.periodEnd = new Date('2026-11-02T00:00:00.000Z');
            if (scenario === 'v2 credit line') f.stripe.invoice.lines[0]!.lookupKey = 'ezil_standard_monthly_v2';
            if (scenario === 'no credit line') f.stripe.invoice.lines.shift();
            const outcome = await processStripeEvent(paidV2(), f.deps);
            expect(outcome).not.toBe('applied');
            expect(aiRows(f.store)).toHaveLength(0);
            expect(f.store.grants.size).toBe(0);
        });
        it('a v2 Compute upgrade keeps compute-only terms', async () => {
            const f = fixture();
            f.stripe.subscription.sku = 'compute_monthly_v2';
            f.stripe.invoice.billingReason = 'subscription_update';
            f.stripe.invoice.lines = [{ ...baseLine('standard_monthly_v2'), amount: -1000, proration: true, periodStart: now },
                { ...baseLine('compute_monthly_v2'), amount: 2000, proration: true, periodStart: now }];
            expect(await processStripeEvent(paidV2(), f.deps)).toBe('applied');
            expect(f.store.grants.size).toBe(1);
            expect(aiRows(f.store)).toHaveLength(0);
        });
        it('skips a zero-credit upgrade in the last instant of the period and logs it', async () => {
            const f = upgraded();
            const last = new Date(periodEnd.getTime() - 1000);
            f.stripe.invoice.lines[1]!.periodStart = last;
            const info = vi.spyOn(console, 'info').mockImplementation(() => {});
            expect(await processStripeEvent(paidV2(), f.deps)).toBe('applied');
            expect(aiRows(f.store)).toHaveLength(0);
            expect(info.mock.calls.map(call => JSON.parse(String(call[0])))).toContainEqual(
                { event: 'ai-upgrade-grant', outcome: 'skipped_zero', invoiceId: 'in_upgrade' });
            info.mockRestore();
        });
        it.each(['refund', 'dispute'] as const)('a %s of the upgrade invoice reverses exactly the upgrade grant', async cause => {
            const f = upgraded();
            await processStripeEvent(paidV2(), f.deps);
            if (cause === 'dispute') f.stripe.charge.refunded = false;
            expect(await processStripeEvent(cause === 'refund' ? refund() : dispute(), f.deps)).toBe('applied');
            const key = cause === 'refund' ? `${upgradeRoot}:revoke:refund:re_local` : `${upgradeRoot}:revoke:dispute:dp_local`;
            expect(f.store.outbox.get(key)).toMatchObject({ kind: 'ai_revoke', payload: { entitlementId: upgradeRoot,
                credits: upgradeCredits, action: 'revoke', expiresAt: '2026-11-04T00:00:00.000Z' } });
            expect(f.store.outbox.size).toBe(2);
            expect([...f.store.grants.values()].reduce((sum, grant) => sum + grant.amount, BigInt(0))).toBe(BigInt(0));
        });
        it('reconstructs the missing upgrade receipt byte-for-byte for a refund', async () => {
            const kept = upgraded();
            await processStripeEvent(paidV2(), kept.deps);
            await processStripeEvent(refund(), kept.deps);
            const f = upgraded();
            await processStripeEvent(paidV2(), f.deps);
            const original = structuredClone(f.store.outbox.get(`${upgradeRoot}:grant`)!);
            f.store.outbox.clear();
            const reversal = vi.spyOn(f.store, 'recordAiReversal');
            expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
            expect(reversal.mock.calls[0]![0].receipts).toStrictEqual([original]);
            expect(f.store.outbox.get(`${upgradeRoot}:revoke:refund:re_local`))
                .toStrictEqual(kept.store.outbox.get(`${upgradeRoot}:revoke:refund:re_local`));
        });
        it('refuses a stored upgrade receipt whose expiry is not the period end plus three days', async () => {
            const f = upgraded();
            await processStripeEvent(paidV2(), f.deps);
            const root = f.store.outbox.get(`${upgradeRoot}:grant`)!;
            expect(root.payload.expiresAt).toBe(new Date(periodEnd.getTime() + 3 * 86_400_000).toISOString());
            root.payload.expiresAt = new Date(periodEnd.getTime() + 2 * 86_400_000).toISOString();
            const before = [...f.store.writes];
            expect(await processStripeEvent(refund(), f.deps)).toBe('review:restore_mismatch');
            expect(f.store.writes).toEqual(before);
        });
        it('sends an upgrade whose AI root cannot be formed to review before any write', async () => {
            const f = upgraded();
            f.stripe.subscription.id = f.stripe.invoice.subscriptionId = 'sub-local';
            for (const line of f.stripe.invoice.lines) line.subscriptionId = 'sub-local';
            const before = [...f.store.writes];
            expect(await processStripeEvent(paidV2(), f.deps)).toBe('review:invalid_ai_upgrade');
            expect(f.store.writes).toEqual(before);
            expect(f.store.grants.size).toBe(0);
            expect(f.store.subscriptions.size).toBe(0);
        });
        it('the renewal after an upgrade grants the full 1,000 once', async () => {
            const f = upgraded();
            await processStripeEvent(paidV2(), f.deps);
            const nextStart = periodEnd, nextEnd = new Date('2026-12-01T00:00:00.000Z');
            Object.assign(f.stripe.subscription, { currentPeriodStart: nextStart, currentPeriodEnd: nextEnd });
            Object.assign(f.stripe.invoice, { id: 'in_renewal', billingReason: 'subscription_cycle', periodStart: nextStart, periodEnd: nextEnd,
                lines: [{ ...baseLine('compute_monthly_v2'), lookupKey: 'ezil_premium_monthly_v3', periodStart: nextStart, periodEnd: nextEnd }] });
            expect(await processStripeEvent({ ...paidV2(), id: 'evt_renewal' }, f.deps)).toBe('applied');
            expect(await processStripeEvent({ ...paidV2(), id: 'evt_renewal_again' }, f.deps)).toBe('applied');
            const renewal = `ezil-os:v1:premium_monthly_v3:sub_local:${nextStart.toISOString()}`;
            expect(aiRows(f.store).map(item => [item.payload.entitlementId, item.payload.credits])).toEqual([
                [upgradeRoot, upgradeCredits], [renewal, 1000]]);
        });
        it('logs one structured line per webhook outcome', async () => {
            const f = upgraded();
            const info = vi.spyOn(console, 'info').mockImplementation(() => {});
            await processStripeEvent(paidV2(), f.deps);
            await processStripeEvent(event('invoice.paid', { id: 'in_local' }), f.deps);
            expect(info.mock.calls.map(call => JSON.parse(String(call[0]))).filter(line => line.event === 'billing-webhook')).toEqual([
                { event: 'billing-webhook', type: 'invoice.paid', outcome: 'applied', eventId: 'evt_local' },
                { event: 'billing-webhook', type: 'invoice.paid', outcome: expect.any(String), eventId: 'evt_local' }]);
            info.mockRestore();
        });
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

describe('W0.3 dispute restore receipts', () => {
    async function funded(v3 = false) {
        const f = fixture();
        f.stripe.charge.refunded = false;
        if (v3) {
            f.stripe.subscription.sku = 'standard_monthly_v3';
            f.stripe.invoice.lines = [{ ...baseLine('standard_monthly_v2'), lookupKey: 'ezil_standard_monthly_v3' }];
            f.stripe.charge.invoiceId = f.stripe.invoice.id;
        }
        expect(await processStripeEvent(v3 ? paidV2() : checkout(false), f.deps)).toBe('applied');
        const root = [...f.store.outbox.values()][0]!;
        root.payload.accountPublicId = 'original-payer';
        return { ...f, root };
    }
    const d = (id: string, won = false) => event(won ? 'charge.dispute.closed' : 'charge.dispute.created',
        { id, charge: 'ch_local', status: 'won' });
    it.each([false, true])('a full refund after a dispute debits the original only once (V3=%s)', async v3 => {
        const f = await funded(v3);
        const original = [...f.store.grants.values()][0]!;
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        f.stripe.charge.refunded = true;
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect([...f.store.grants.values()].map(g => g.amount)).toEqual([original.amount, -original.amount, BigInt(0)]);
        const terminal = f.store.outbox.get(`${f.root.payload.entitlementId}:revoke:refund:re_local`)!;
        expect(terminal.payload).toMatchObject({ action: 'revoke', entitlementId: f.root.payload.entitlementId,
            credits: f.root.payload.credits, accountPublicId: 'original-payer',
            localDeltas: [{ originalGrantId: original.id, meter: original.meter, amount: '0' }] });
        const before = [...f.store.writes];
        // A refunded purchase stays terminal even if the later charge read omits the refund flag.
        f.stripe.charge.refunded = false;
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_refused_terminal');
        expect(f.store.writes).toEqual(before);
        expect([...f.store.grants.values()].filter(g => g.kind === 'restore')).toHaveLength(0);
    });
    it('counts earlier valid receipts without the new optional local-delta audit field', async () => {
        const f = await funded(true);
        await processStripeEvent(dispute(), f.deps);
        const suspended = f.store.outbox.get(`${f.root.payload.entitlementId}:revoke:dispute:dp_local`)!;
        delete suspended.payload.localDeltas;
        const frozen = structuredClone(suspended);
        f.stripe.charge.refunded = true;
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect([...f.store.grants.values()].at(-1)!.amount).toBe(BigInt(0));
        expect(suspended).toEqual(frozen);
    });
    it('does not repair already-corrupt history by appending an invented positive or another negative', async () => {
        const f = await funded(true);
        await processStripeEvent(dispute(), f.deps);
        const local = [...f.store.grants.values()].find(g => g.kind === 'suspend')!;
        local.amount *= BigInt(2);
        const before = [...f.store.writes];
        f.stripe.charge.refunded = true;
        expect(await processStripeEvent(refund(), f.deps)).toBe('review:local_reversal_mismatch');
        expect(f.store.writes).toEqual(before);
    });
    it('preserves an independently paid upgrade and the actual displayed allowance', async () => {
        const f = await funded(true);
        const original = [...f.store.grants.values()][0]!;
        await f.store.insertGrant({ ...original, sourceId: 'in_paid_upgrade', kind: 'upgrade_prorated', amount: BigInt(100000) });
        const upgrade = [...f.store.grants.values()][1]!;
        await processStripeEvent(dispute(), f.deps);
        f.stripe.charge.refunded = true;
        await processStripeEvent(refund(), f.deps);
        const grants = [...f.store.grants.values()];
        expect(grants.reduce((total, g) => total + g.amount, BigInt(0))).toBe(BigInt(100000));
        expect(f.store.grants.get(upgrade.id)).toEqual(upgrade);
        const { fairUseAllowance } = await import('./v3/summary');
        const { planFromSubscriptions } = await import('./v3/catalog');
        const plan = planFromSubscriptions({ subs: await f.store.subscriptionsFor('user_local'), now, userCreatedAt: null });
        expect(fairUseAllowance(plan, grants)).toBe(100000);
    });
    it.each([false, true])('a refund after an earned local restore debits that restored amount (delivered=%s)', async delivered => {
        const f = await funded(true);
        const original = [...f.store.grants.values()][0]!;
        await processStripeEvent(dispute(), f.deps);
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('applied');
        const restored = f.store.outbox.get(`${f.root.payload.entitlementId}:restore:dp_local`)!;
        if (delivered) { restored.deliveredAt = now; restored.payload.delivery = { status: 'done', outcome: 'restored' }; }
        f.stripe.charge.refunded = true;
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect([...f.store.grants.values()].map(g => g.amount)).toEqual([original.amount, -original.amount, original.amount, -original.amount]);
        const before = [...f.store.writes];
        f.stripe.charge.refunded = false;
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('applied'); // Immutable replay, never another local restore.
        expect(f.store.writes).toEqual(before);
    });
    it('retains each committed delta on interleaved D and refund replays, including different refund IDs', async () => {
        const f = await funded(true);
        const original = [...f.store.grants.values()][0]!;
        await processStripeEvent(dispute(), f.deps);
        await processStripeEvent(dispute(true), f.deps);
        const before = [...f.store.writes];
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        expect(f.store.writes).toEqual(before);
        f.stripe.charge.refunded = true;
        await processStripeEvent(refund(), f.deps);
        const second = refund(); second.data.object.refunds = { data: [{ id: 're_second' }] };
        expect(await processStripeEvent(second, f.deps)).toBe('applied');
        const after = [...f.store.writes];
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect(await processStripeEvent(second, f.deps)).toBe('applied');
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        expect(f.store.writes).toEqual(after);
        expect([...f.store.grants.values()].map(g => g.amount)).toEqual([original.amount, -original.amount, original.amount, -original.amount, BigInt(0)]);
        expect(f.store.outbox.has(`${f.root.payload.entitlementId}:revoke:refund:re_second`)).toBe(true);
    });
    it('does not double-debit overlapping disputes or let either win revive a terminal refund', async () => {
        const f = await funded(true);
        const original = [...f.store.grants.values()][0]!;
        await processStripeEvent(d('dp_A'), f.deps);
        await processStripeEvent(d('dp_B'), f.deps);
        f.stripe.charge.refunded = true;
        await processStripeEvent(refund(), f.deps);
        expect([...f.store.grants.values()].map(g => g.amount)).toEqual([original.amount, -original.amount, BigInt(0), BigInt(0)]);
        f.stripe.charge.refunded = false;
        for (const id of ['dp_A', 'dp_B']) expect(await processStripeEvent(d(id, true), f.deps)).toBe('review:restore_refused_terminal');
    });
    it('a refund arriving first leaves later suspension at zero and a won dispute refused', async () => {
        const f = await funded(true);
        const original = [...f.store.grants.values()][0]!;
        f.stripe.charge.refunded = true;
        await processStripeEvent(refund(), f.deps);
        f.stripe.charge.refunded = false;
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_refused_terminal');
        expect([...f.store.grants.values()].map(g => g.amount)).toEqual([original.amount, -original.amount, BigInt(0)]);
    });
    it('keeps renewal grants isolated from old-period reversals and their replays', async () => {
        const f = await funded(true);
        await processStripeEvent(dispute(), f.deps);
        f.stripe.charge.refunded = true;
        await processStripeEvent(refund(), f.deps);
        const nextEnd = new Date('2026-12-01T00:00:00Z');
        f.stripe.subscription.currentPeriodStart = periodEnd;
        f.stripe.subscription.currentPeriodEnd = nextEnd;
        f.stripe.invoice = { ...f.stripe.invoice, id: 'in_renewal', periodStart: periodEnd, periodEnd: nextEnd,
            lines: f.stripe.invoice.lines.map(line => ({ ...line, periodStart: periodEnd, periodEnd: nextEnd })) };
        const renewal = { ...paidV2(), created: periodEnd.getTime() / 1000 };
        renewal.data.object.id = 'in_renewal';
        expect(await processStripeEvent(renewal, f.deps)).toBe('applied');
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied'); // charge still references the old invoice.
        expect([...f.store.grants.values()].reduce((total, g) => total + g.amount, BigInt(0))).toBe(BigInt(144000));
        const { fairUseAllowance } = await import('./v3/summary');
        const { planFromSubscriptions } = await import('./v3/catalog');
        const plan = planFromSubscriptions({ subs: await f.store.subscriptionsFor('user_local'), now: periodEnd, userCreatedAt: null });
        expect(fairUseAllowance(plan, [...f.store.grants.values()])).toBe(144000);
        f.stripe.charge.invoiceId = 'in_renewal';
        expect(await processStripeEvent(d('dp_renewal'), f.deps)).toBe('applied');
        expect([...f.store.grants.values()].at(-1)!.amount).toBe(BigInt(-144000));
    });
    it('serializes a concurrent suspend and refund without taking the allowance twice', async () => {
        const f = await funded(true);
        f.stripe.charge.refunded = true;
        expect(await Promise.all([processStripeEvent(dispute(), f.deps), processStripeEvent(refund(), f.deps)])).toEqual(['applied', 'applied']);
        const corrections = [...f.store.grants.values()].filter(g => g.sourceType === 'refund' || g.sourceType === 'dispute');
        expect(corrections.map(g => g.amount).sort()).toEqual([BigInt(-144000), BigInt(0)]);
    });
    it.each([false, true])('restores a matching topup/V3 suspend exactly once with a constant root (V3=%s)', async v3 => {
        const f = await funded(v3);
        await processStripeEvent(dispute(), f.deps);
        const before = [...f.store.writes];
        expect(await Promise.all([processStripeEvent(dispute(true), f.deps), processStripeEvent(dispute(true), f.deps)])).toEqual(['applied', 'applied']);
        const restored = f.store.outbox.get(`${f.root.payload.entitlementId}:restore:dp_local`)!;
        expect(restored).toMatchObject({ kind: 'ai_restore', payload: { action: 'restore',
            entitlementId: f.root.payload.entitlementId, credits: v3 ? 200 : 1234, accountPublicId: 'original-payer',
            expiresAt: f.root.payload.expiresAt } });
        expect(f.store.writes.length - before.length).toBe(2);
        expect([...f.store.grants.values()].map(g => g.kind)).toEqual([v3 ? 'plan_period' : 'topup', 'suspend', 'restore']);
        expect([...f.store.grants.values()].reduce((total, g) => total + g.amount, BigInt(0))).toBe([...f.store.grants.values()][0]!.amount);
        const after = [...f.store.writes];
        expect(await processStripeEvent({ ...dispute(true), id: 'won_replayed' }, f.deps)).toBe('applied');
        expect(f.store.writes).toEqual(after);
    });
    it('won before created waits without a local positive and can complete after its own suspend', async () => {
        const f = await funded();
        const before = [...f.store.writes];
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('failed:restore_suspend_pending');
        expect(f.store.writes).toEqual(before);
        await processStripeEvent(dispute(), f.deps);
        expect(await processStripeEvent(d('dp_wrong', true), f.deps)).toBe('failed:restore_suspend_pending');
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('applied');
    });
    it.each(['local amount', 'local period', 'suspend missing', 'refund only', 'payer', 'root terms', 'charge', 'root owner'])(
        'refuses mismatched %s before any positive effect', async defect => {
            const f = await funded();
            await processStripeEvent(dispute(), f.deps);
            const suspended = [...f.store.grants.values()].find(g => g.kind === 'suspend')!;
            const receipt = [...f.store.outbox.values()].find(r => r.kind === 'ai_revoke')!;
            if (defect === 'local amount') suspended.amount += BigInt(1);
            if (defect === 'local period') suspended.periodEnd = now;
            if (defect === 'suspend missing') f.store.grants.delete(suspended.id);
            if (defect === 'refund only') suspended.sourceType = 'refund';
            if (defect === 'payer') receipt.payload.accountPublicId = 'different-payer';
            if (defect === 'root terms') f.root.payload.credits = 777;
            if (defect === 'charge') f.stripe.charge.id = 'ch_different';
            if (defect === 'root owner') receipt.userId = 'other-user';
            const before = [...f.store.writes];
            expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_mismatch');
            expect(f.store.writes).toEqual(before);
        },
    );
    it('waits for the suspended payer to be pinned and never substitutes another account', async () => {
        const f = await funded();
        delete f.root.payload.accountPublicId;
        await processStripeEvent(dispute(), f.deps);
        const before = [...f.store.writes];
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('failed:restore_account_pending');
        expect(f.store.writes).toEqual(before);
        [...f.store.outbox.values()].find(r => r.kind === 'ai_revoke')!.payload.accountPublicId = 'late-payer';
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('applied');
        expect([...f.store.outbox.values()].at(-1)!.payload.accountPublicId).toBe('late-payer');
    });
    it('rolls back a local positive when the atomic outbox insert fails, then retries cleanly', async () => {
        const f = await funded();
        await processStripeEvent(dispute(), f.deps);
        const before = [...f.store.writes];
        vi.spyOn(f.store, 'enqueueOutbox').mockRejectedValueOnce(new Error('transaction interrupted'));
        await expect(processStripeEvent(dispute(true), f.deps)).rejects.toThrow('transaction interrupted');
        expect(f.store.writes).toEqual(before);
        expect([...f.store.grants.values()].some(g => g.kind === 'restore')).toBe(false);
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('applied');
    });
    it('emits a distinct terminal refund after a dispute, on the root and frozen payer', async () => {
        const f = await funded();
        await processStripeEvent(dispute(), f.deps);
        f.stripe.charge.refunded = true;
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect(f.store.outbox.get(`${f.root.payload.entitlementId}:revoke:refund:re_local`)).toMatchObject({
            kind: 'ai_revoke', payload: { entitlementId: f.root.payload.entitlementId, accountPublicId: 'original-payer' } });
        // Even a later provider read that omits the refund cannot erase the terminal receipt.
        f.stripe.charge.refunded = false;
        const before = [...f.store.writes];
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_refused_terminal');
        expect(f.store.writes).toEqual(before);
    });
    it('keeps a legacy root revoke terminal', async () => {
        const f = await funded();
        await processStripeEvent(dispute(), f.deps);
        const { aiCreditRevokeItem } = await import('./ai-credits');
        await f.store.enqueueOutbox(aiCreditRevokeItem(f.root));
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_refused_terminal');
        expect([...f.store.grants.values()].some(g => g.kind === 'restore')).toBe(false);
    });
    it('marks overlapping disputes for review, regardless of which win arrives first', async () => {
        const f = await funded();
        await processStripeEvent(d('dp_A'), f.deps);
        await processStripeEvent(d('dp_B'), f.deps);
        const before = [...f.store.writes];
        for (const id of ['dp_A', 'dp_B']) expect(await processStripeEvent(d(id, true), f.deps)).toBe('review:restore_review_required');
        expect(f.store.writes).toEqual(before);
    });
    it('supports successive completed chains without using fractional restored-head values in the body', async () => {
        const f = await funded();
        for (const id of ['dp_A', 'dp_B', 'dp_C']) {
            expect(await processStripeEvent(d(id), f.deps)).toBe('applied');
            expect(await processStripeEvent(d(id, true), f.deps)).toBe('applied');
            const r = f.store.outbox.get(`${f.root.payload.entitlementId}:restore:${id}`)!;
            expect(r.payload).toMatchObject({ credits: 1234, entitlementId: f.root.payload.entitlementId });
            r.deliveredAt = now;
            r.payload.delivery = { status: 'done', outcome: 'restored' };
        }
        expect(f.store.outbox.size).toBe(7);
        f.stripe.charge.refunded = true;
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect([...f.store.outbox.values()].at(-1)!.payload.entitlementId).toBe(f.root.payload.entitlementId);
    });
    it('cannot reuse a D suspend from another purchase with the same amount and payer', async () => {
        const f = await funded();
        await processStripeEvent(dispute(), f.deps);
        f.stripe.session.paymentIntentId = 'pi_another';
        f.stripe.charge.paymentIntentId = 'pi_another';
        await processStripeEvent(checkout(false), f.deps);
        [...f.store.outbox.values()].at(-1)!.payload.accountPublicId = 'original-payer';
        const before = [...f.store.writes];
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_mismatch');
        expect(f.store.writes).toEqual(before);
    });
    it('reviews oversize causal IDs before writing even a suspension', async () => {
        const f = await funded();
        const before = [...f.store.writes];
        expect(await processStripeEvent(d('dp_' + 'x'.repeat(200)), f.deps)).toBe('review:invalid_ai_event_id');
        expect(f.store.writes).toEqual(before);
    });
});

describe('HF2 operator correction rows', () => {
    type Rows = { root: AiReversalReceipt; revoke: OutboxInsert; correction: OutboxInsert; ROOT: string; CORR: string };
    /** Canary shape: paid root, operator bare revoke (invoice cleared), same-invoice 200-credit correction. */
    async function canary(order: 'root first' | 'correction first' = 'root first',
        options: { revoke?: boolean; correction?: boolean; defect?: (rows: Rows) => OutboxInsert[] | void } = {}) {
        const f = fixture();
        f.stripe.charge.refunded = false;
        f.stripe.subscription.sku = 'standard_monthly_v3';
        f.stripe.invoice.lines = [{ ...baseLine('standard_monthly_v2'), lookupKey: 'ezil_standard_monthly_v3' }];
        f.stripe.charge.invoiceId = f.stripe.invoice.id;
        expect(await processStripeEvent(paidV2(), f.deps)).toBe('applied');
        const root = [...f.store.outbox.values()][0]!;
        Object.assign(root.payload, { credits: 4000, accountPublicId: 'canary-payer' });
        const ROOT = String(root.payload.entitlementId), CORR = `${ROOT}:correction-20261028`;
        const note = { operatorNote: 'r3-20261028 legacy amount correction' };
        const revoke = aiCreditRevokeItem(root);
        Object.assign(revoke.payload, { invoiceId: null, ...note });
        const correction = aiCreditOutboxItem('user_local', { entitlementId: CORR, credits: 200,
            expiresAt: String(root.payload.expiresAt) }, 'grant', String(root.payload.invoiceId));
        Object.assign(correction.payload, { accountPublicId: 'canary-payer', ...note });
        const extra = options.defect?.({ root, revoke, correction, ROOT, CORR }) ?? [];
        if (options.revoke !== false) await f.store.enqueueOutbox(revoke);
        if (options.correction !== false) await f.store.enqueueOutbox(correction);
        for (const item of extra) await f.store.enqueueOutbox(item);
        if (order === 'correction first') { f.store.outbox.delete(root.eventKey); f.store.outbox.set(root.eventKey, root); }
        const compute = [...f.store.grants.values()].find(g => g.kind === 'plan_period')!;
        return { ...f, root, revoke, correction, ROOT, CORR, compute };
    }
    const rekey = (item: OutboxInsert, entitlementId: string) => {
        item.eventKey = `${entitlementId}:grant`;
        Object.assign(item.payload, { entitlementId, eventId: item.eventKey });
    };

    it.each(['root first', 'correction first'] as const)(
        'a full refund reverses compute and the correction only, never the operator-revoked parent (%s)', async order => {
            const f = await canary(order);
            expect(f.compute.amount).toBe(BigInt(144000));
            const before = [...f.store.writes];
            f.stripe.charge.refunded = true;
            expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
            expect(f.store.writes.slice(before.length)).toEqual(['refund:re_local:compute_std_seconds:revoke', `${f.CORR}:revoke:refund:re_local`]);
            expect(f.store.grants.get('refund:re_local:compute_std_seconds:revoke')).toMatchObject({ amount: BigInt(-144000),
                meter: 'compute_std_seconds', kind: 'revoke', sourceType: 'refund', sourceId: 're_local', subscriptionId: f.compute.subscriptionId });
            expect(f.store.outbox.get(`${f.CORR}:revoke:refund:re_local`)).toMatchObject({ kind: 'ai_revoke', userId: 'user_local',
                payload: { action: 'revoke', entitlementId: f.CORR, credits: 200, expiresAt: f.root.payload.expiresAt,
                    invoiceId: f.root.payload.invoiceId, accountPublicId: 'canary-payer',
                    reversal: { causeType: 'refund', causeId: 're_local' },
                    localDeltas: [{ originalGrantId: f.compute.id, meter: 'compute_std_seconds', amount: '-144000' }] } });
            expect([...f.store.outbox.keys()].filter(key => key.startsWith(`${f.ROOT}:revoke:`))).toEqual([]);
        },
    );
    it.each(['root first', 'correction first'] as const)('replays of the same refund write nothing (%s)', async order => {
        const f = await canary(order);
        f.stripe.charge.refunded = true;
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        const after = [...f.store.writes];
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect(await processStripeEvent(event('refund.updated', { id: 're_local', charge: 'ch_local' }), f.deps)).toBe('applied');
        expect(f.store.writes).toEqual(after);
    });
    it.each([
        ['correction expiry', (r: Rows) => { r.correction.payload.expiresAt = '2026-12-01T00:00:00.000Z'; }],
        ['correction credits above the parent', (r: Rows) => { r.correction.payload.credits = 4001; }],
        ['correction foreign account', (r: Rows) => { r.correction.payload.accountPublicId = 'other-payer'; }],
        ['correction payment intent', (r: Rows) => { r.correction.payload.paymentIntentId = 'pi_other'; }],
        ['orphan correction', (r: Rows) => rekey(r.correction, `${r.ROOT.replace(':sub_local:', ':sub_other:')}:correction-20261028`)],
        ['malformed correction suffix', (r: Rows) => rekey(r.correction, `${r.ROOT}:correction-2026102`)],
        ['chained correction', (r: Rows) => {
            const chained = structuredClone(r.correction);
            rekey(chained, `${r.CORR}:correction-20261029`);
            return [chained];
        }],
        ['bare revoke credits', (r: Rows) => { r.revoke.payload.credits = 3999; }],
        ['bare revoke expiry', (r: Rows) => { r.revoke.payload.expiresAt = '2026-12-01T00:00:00.000Z'; }],
        ['bare revoke foreign invoice', (r: Rows) => { r.revoke.payload.invoiceId = 'in_other'; }],
        ['bare revoke foreign account', (r: Rows) => { r.revoke.payload.accountPublicId = 'other-payer'; }],
        ['bare revoke owner', (r: Rows) => { r.revoke.userId = 'other-user'; }],
        ['bare revoke kind', (r: Rows) => { r.revoke.kind = 'ai_grant'; }],
        ['bare revoke action', (r: Rows) => { r.revoke.payload.action = 'grant'; }],
        ['bare revoke event id', (r: Rows) => { r.revoke.payload.eventId = `${r.ROOT}:revoke:operator`; }],
    ] as const)('refuses a %s with zero writes, compute included', async (_, defect) => {
        for (const order of ['root first', 'correction first'] as const) {
            const f = await canary(order, { defect });
            const before = [...f.store.writes];
            f.stripe.charge.refunded = true;
            expect(await processStripeEvent(refund(), f.deps)).toBe('review:restore_mismatch');
            expect(f.store.writes).toEqual(before);
        }
    });
    it('refuses a correction whose invoice differs from its parent when the planner is handed it', async () => {
        const f = await canary();
        const plan = (correction: OutboxInsert) => planAiReversal({ action: 'revoke', causeId: 're_local', chargeId: 'ch_local',
            customerId: 'cus_local', userId: 'user_local', originals: [f.compute], receipts: [f.root, correction] },
        { originals: [f.compute], corrections: [], receipts: [...f.store.outbox.values()].map(r => r.eventKey === correction.eventKey ? correction : r) });
        expect(plan(f.correction)).toMatchObject({ outcome: 'applied', outbox: [{ eventKey: `${f.CORR}:revoke:refund:re_local` }] });
        for (const invoiceId of ['in_other', null]) {
            const foreign = structuredClone(f.correction);
            foreign.payload.invoiceId = invoiceId;
            expect(plan(foreign)).toEqual({ outcome: 'review:restore_mismatch', grants: [], outbox: [] });
        }
    });
    it('reverses compute alone when every root is operator-revoked, and its replays are applied with zero writes', async () => {
        const f = await canary('root first', { correction: false });
        f.stripe.charge.refunded = true;
        const before = [...f.store.writes];
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect(f.store.writes.slice(before.length)).toEqual(['refund:re_local:compute_std_seconds:revoke']);
        const after = [...f.store.writes];
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect(await processStripeEvent(event('refund.updated', { id: 're_local', charge: 'ch_local' }), f.deps)).toBe('applied');
        expect(f.store.writes).toEqual(after);
    });
    it('suspends compute alone when every root is operator-revoked, and its replay is applied with zero writes', async () => {
        const f = await canary('root first', { correction: false });
        const before = [...f.store.writes];
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        expect(f.store.writes.slice(before.length)).toEqual(['dispute:dp_local:compute_std_seconds:suspend']);
        const after = [...f.store.writes];
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        expect(f.store.writes).toEqual(after);
    });
    it.each([
        ['without an operator revoke', { revoke: false }, BigInt(-144000)],
        ['with a partial amount under an operator revoke', {}, BigInt(-100000)],
    ] as const)('refuses an unbound local refund row %s with zero writes', async (_, options, amount) => {
        const f = await canary('root first', { correction: false, ...options });
        const { id: _id, createdAt: _at, ...compute } = f.compute;
        await f.store.insertGrant({ ...compute, kind: 'revoke', amount, sourceType: 'refund', sourceId: 're_local' });
        f.stripe.charge.refunded = true;
        const before = [...f.store.writes];
        expect(await processStripeEvent(refund(), f.deps)).toBe('review:local_reversal_mismatch');
        expect(f.store.writes).toEqual(before);
    });
    it('refuses a full unbound refund row once an earlier dispute already took the compute, with zero writes', async () => {
        const f = await canary('root first', { correction: false, revoke: false });
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        await f.store.enqueueOutbox(f.revoke);
        const { id: _id, createdAt: _at, ...compute } = f.compute;
        await f.store.insertGrant({ ...compute, kind: 'revoke', amount: BigInt(-144000), sourceType: 'refund', sourceId: 're_local' });
        f.stripe.charge.refunded = true;
        const before = [...f.store.writes];
        expect(await processStripeEvent(refund(), f.deps)).toBe('review:local_reversal_mismatch');
        expect(f.store.writes).toEqual(before);
    });
    it('reverses a correction whose credits equal the parent', async () => {
        const f = await canary('correction first', { defect: r => { r.correction.payload.credits = 4000; } });
        f.stripe.charge.refunded = true;
        expect(await processStripeEvent(refund(), f.deps)).toBe('applied');
        expect(f.store.outbox.get(`${f.CORR}:revoke:refund:re_local`)).toMatchObject({ kind: 'ai_revoke',
            payload: { entitlementId: f.CORR, credits: 4000 } });
    });
    it('suspends the correction alone on a dispute; a win then stays terminal with zero writes', async () => {
        const f = await canary('correction first');
        const before = [...f.store.writes];
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        expect(f.store.writes.slice(before.length)).toEqual(['dispute:dp_local:compute_std_seconds:suspend', `${f.CORR}:revoke:dispute:dp_local`]);
        expect(f.store.grants.get('dispute:dp_local:compute_std_seconds:suspend')!.amount).toBe(BigInt(-144000));
        expect(f.store.outbox.get(`${f.CORR}:revoke:dispute:dp_local`)).toMatchObject({ kind: 'ai_revoke',
            payload: { entitlementId: f.CORR, credits: 200, accountPublicId: 'canary-payer', overlappingDisputes: false } });
        const after = [...f.store.writes];
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_refused_terminal');
        expect(f.store.writes).toEqual(after);
        expect([...f.store.grants.values()].some(g => g.kind === 'restore')).toBe(false);
    });
    it('suspends and restores a correction child under its own root when no operator revoke exists', async () => {
        const f = await canary('root first', { revoke: false });
        expect(await processStripeEvent(dispute(), f.deps)).toBe('applied');
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('applied');
        for (const root of [f.ROOT, f.CORR]) {
            expect(f.store.outbox.get(`${root}:revoke:dispute:dp_local`)).toMatchObject({ kind: 'ai_revoke' });
            expect(f.store.outbox.get(`${root}:restore:dp_local`)).toMatchObject({ kind: 'ai_restore',
                payload: { entitlementId: root, credits: root === f.CORR ? 200 : 4000, accountPublicId: 'canary-payer' } });
        }
        expect([...f.store.grants.values()].map(g => g.amount)).toEqual([BigInt(144000), BigInt(-144000), BigInt(144000)]);
    });
});

describe('legacy restore refusal', () => {
    it('does not credit legacy dollar-only rows even after a same-D negative entry', async () => {
        const f = fixture(); f.stripe.charge.refunded = false;
        await seedTopup(f.store);
        await processStripeEvent(dispute(), f.deps);
        const before = [...f.store.writes];
        expect(await processStripeEvent(dispute(true), f.deps)).toBe('review:restore_receipt_missing');
        expect(f.store.writes).toEqual(before);
        expect([...f.store.grants.values()].some(g => g.kind === 'restore')).toBe(false);
    });
});
