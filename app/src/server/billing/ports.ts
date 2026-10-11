/**
 * Billing ports — the interfaces the wave-2 modules meet at
 * (docs/billing/CONTRACT.md §5.2). The DB store, the Stripe REST client, the
 * webhook processor and the routes are built in parallel against THIS file,
 * so a contract described in two briefs cannot become two contracts.
 *
 * Every user id here comes from the session (tRPC), from `ezil_computers`
 * (usage ingest) or from `ezil_billing_customers` (webhooks) — never from a
 * Stripe payload's metadata.
 */
import type { IntervalRow, SubscriptionRow } from './meters';

// ── Store (implemented by `store.ts` over drizzle) ───────────────────────────

export interface StorageSample {
    computerId: string;
    bytes: bigint;
    measuredAt: Date;
}

export interface SubscriptionUpsert {
    stripeSubscriptionId: string;
    userId: string;
    status: string;
    sku: string;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    cancelAtPeriodEnd: boolean;
    /** `created` of the Stripe event that produced this state; older states never overwrite newer ones. */
    stripeEventCreated: Date;
}

export type GrantMeter = 'workspace_seconds' | 'ai_usd_micro';
export type GrantKind = 'pro_period' | 'topup' | 'revoke' | 'suspend' | 'restore';
export type GrantSource = 'invoice' | 'payment_intent' | 'refund' | 'dispute';

export interface GrantInsert {
    userId: string;
    meter: GrantMeter;
    kind: GrantKind;
    /** Negative for revoke/suspend. */
    amount: bigint;
    periodStart: Date | null;
    periodEnd: Date | null;
    sourceType: GrantSource;
    sourceId: string;
}

export interface GrantRow extends GrantInsert {
    id: string;
    createdAt: Date;
}

export interface OutboxInsert {
    /** Unique; the Gateway's idempotency key. */
    eventKey: string;
    userId: string;
    kind: 'ai_grant' | 'ai_revoke';
    payload: Record<string, unknown>;
}

export interface BillingStore {
    // reads
    stripeCustomerFor(userId: string): Promise<string | null>;
    userForStripeCustomer(stripeCustomerId: string): Promise<string | null>;
    subscriptionsFor(userId: string): Promise<SubscriptionRow[]>;
    /** Intervals that overlap `[since, ∞)`, open ones included. */
    intervalsFor(userId: string, since: Date): Promise<IntervalRow[]>;
    /** Newest sample per computer. */
    latestStorageFor(userId: string): Promise<StorageSample[]>;
    grantsBySource(sourceType: GrantSource, sourceId: string): Promise<GrantRow[]>;
    computerOwner(computerId: string): Promise<string | null>;

    // writes — each idempotent
    linkCustomer(userId: string, stripeCustomerId: string): Promise<'linked' | 'exists' | 'conflict'>;
    recordEvent(event: { eventId: string; type: string; livemode: boolean; payloadSha256: string }): Promise<'new' | 'duplicate'>;
    markEventProcessed(eventId: string, outcome: string): Promise<void>;
    upsertSubscription(row: SubscriptionUpsert): Promise<'applied' | 'stale'>;
    insertGrant(grant: GrantInsert): Promise<'inserted' | 'duplicate'>;
    enqueueOutbox(item: OutboxInsert): Promise<'queued' | 'duplicate'>;

    // usage ingest (computer ownership already checked by the caller)
    openInterval(userId: string, computerId: string, at: Date, source: string): Promise<void>;
    touchInterval(computerId: string, at: Date): Promise<void>;
    closeInterval(computerId: string, at: Date, reason: string): Promise<void>;
    insertStorageSample(userId: string, sample: StorageSample & { source: string }): Promise<void>;
}

// ── Stripe (implemented by `stripe/client.ts`) ───────────────────────────────

export interface StripeSubscription {
    id: string;
    customer: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodStart: Date | null;
    currentPeriodEnd: Date | null;
    /** `subscription_data.metadata.sku` set by our own checkout. */
    sku: string | null;
}

export interface StripeInvoice {
    id: string;
    customer: string;
    status: string;
    subscriptionId: string | null;
    periodStart: Date | null;
    periodEnd: Date | null;
}

export interface StripeCheckoutSession {
    id: string;
    customer: string | null;
    clientReferenceId: string | null;
    mode: 'payment' | 'subscription' | 'setup';
    status: 'open' | 'complete' | 'expired';
    paymentStatus: 'paid' | 'unpaid' | 'no_payment_required';
    paymentIntentId: string | null;
    /** `metadata.sku` set by our own checkout. */
    sku: string | null;
}

export interface StripeCharge {
    id: string;
    customer: string | null;
    invoiceId: string | null;
    paymentIntentId: string | null;
    amount: number;
    amountRefunded: number;
    refunded: boolean;
}

export interface CheckoutRequest {
    customerId: string;
    userId: string;
    sku: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
}

export interface StripeApi {
    createCustomer(input: { userId: string; email: string | null; idempotencyKey: string }): Promise<{ id: string }>;
    createCheckoutSession(input: CheckoutRequest): Promise<{ id: string; url: string }>;
    createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
    retrieveSubscription(id: string): Promise<StripeSubscription>;
    retrieveInvoice(id: string): Promise<StripeInvoice>;
    retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;
    retrieveCharge(id: string): Promise<StripeCharge>;
}
