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
    /**
     * Inbox insert. `processed` = seen and successfully applied (acknowledge, do
     * nothing); `unprocessed` = seen before but never finished (re-run: every
     * write below is idempotent, so reprocessing is safe).
     */
    recordEvent(event: { eventId: string; type: string; livemode: boolean; payloadSha256: string }): Promise<'new' | 'processed' | 'unprocessed'>;
    markEventProcessed(eventId: string, outcome: string): Promise<void>;
    upsertSubscription(row: SubscriptionUpsert): Promise<'applied' | 'stale'>;
    insertGrant(grant: GrantInsert): Promise<'inserted' | 'duplicate'>;
    enqueueOutbox(item: OutboxInsert): Promise<'queued' | 'duplicate'>;

    // usage ingest (computer ownership already checked by the caller)
    openInterval(userId: string, computerId: string, at: Date, source: string): Promise<void>;
    touchInterval(computerId: string, at: Date): Promise<void>;
    closeInterval(computerId: string, at: Date, reason: string): Promise<void>;
    insertStorageSample(userId: string, sample: StorageSample & { source: string }): Promise<void>;
    /** Close every open interval last seen before `staleBefore`, ending it at its `last_seen_at`. Returns how many. */
    closeStaleIntervals(staleBefore: Date, reason: string): Promise<number>;
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
    /**
     * `embedded` (default for the OS): Stripe Embedded Checkout mounted in an
     * OS window — `ui_mode=embedded`, `return_url` = `returnUrl`,
     * `redirect_on_completion=if_required`, so card / Link / wallet payments
     * finish in place with no redirect. `hosted`: the redirect page, kept for
     * clients that cannot load Stripe.js (`successUrl` / `cancelUrl`).
     */
    uiMode: 'embedded' | 'hosted';
    /** Stripe Tax on the session (`BILLING_AUTOMATIC_TAX=1`). */
    automaticTax: boolean;
    returnUrl: string;
    successUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
}

export interface CheckoutSessionCreated {
    id: string;
    /** Hosted mode only. */
    url: string | null;
    /** Embedded mode only — handed to Stripe.js `initEmbeddedCheckout`. */
    clientSecret: string | null;
}

export interface StripeInvoiceSummary {
    id: string;
    number: string | null;
    status: string;
    amountPaidCents: number;
    currency: string;
    created: Date;
    hostedInvoiceUrl: string | null;
    description: string | null;
}

export interface StripeApi {
    createCustomer(input: { userId: string; email: string | null; idempotencyKey: string }): Promise<{ id: string }>;
    createCheckoutSession(input: CheckoutRequest): Promise<CheckoutSessionCreated>;
    /** Newest first. */
    listInvoices(customerId: string, limit: number): Promise<StripeInvoiceSummary[]>;
    createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
    retrieveSubscription(id: string): Promise<StripeSubscription>;
    retrieveInvoice(id: string): Promise<StripeInvoice>;
    retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;
    retrieveCharge(id: string): Promise<StripeCharge>;
}

// ── Processor / handlers ──────────────────────────────────────────────────────

/** A signed event from the desktop Worker (`POST /api/billing/usage`). Instants are ISO strings; bytes a decimal string. */
export type UsageEvent =
    | { type: 'start' | 'stop' | 'heartbeat'; computerId: string; at: string; reason?: string }
    | { type: 'storage'; computerId: string; at: string; bytes: string };

export interface ProcessorDeps {
    store: BillingStore;
    stripe: StripeApi;
    now: () => Date;
}

/** What routes and tRPC procedures receive (built once by `deps.ts`). */
export interface BillingDeps {
    config: import('./config').BillingConfig;
    store: BillingStore;
    /** Null unless `STRIPE_SECRET` is set. */
    stripe: StripeApi | null;
    now: () => Date;
}
