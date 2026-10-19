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
import type { ComputeEpoch, EpochEndReason, GrantKindV2, GRANT_METER_COMPUTE, SizeCode } from './v2/contract';

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

export type GrantMeter = 'workspace_seconds' | 'ai_usd_micro' | typeof GRANT_METER_COMPUTE;
export type GrantKind = 'pro_period' | 'topup' | GrantKindV2;
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
    subscriptionId?: string | null;
}

export interface GrantRow extends GrantInsert {
    subscriptionId: string | null;
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

export interface OpenEpochInput {
    userId: string;
    computerId: string;
    subscriptionId: string | null;
    size: SizeCode;
    readyAt: Date;
}

export interface CloseEpochInput {
    computerId: string;
    endedAt: Date;
    reason: EpochEndReason;
    overheadSeconds?: number;
}

export interface OverageConsentInsert {
    userId: string;
    subscriptionId: string;
    enabled: boolean;
    capCents: number;
    termsVersion: string;
    catalogVersion: number;
    rateCentsPerStdHour: number;
    actor: string;
    acceptedAt: Date;
}

export interface OverageConsentRow extends OverageConsentInsert {
    id: bigint;
}

export type OverageInvoiceStatus = 'pending' | 'open' | 'paid' | 'payment_failed' | 'requires_action' | 'void' | 'uncollectible';

export interface OverageInvoiceInsert {
    userId: string;
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    ratingVersion: number;
    stdSecondsOver: bigint;
    cents: number;
}

export interface OverageInvoiceRow extends OverageInvoiceInsert {
    id: string;
    stripeInvoiceId: string | null;
    status: OverageInvoiceStatus;
    createdAt: Date;
    updatedAt: Date;
}

export type PlanChangeKind = 'upgrade' | 'downgrade' | 'cancel';
export type PlanChangeState = 'pending' | 'requires_action' | 'payment_failed' | 'scheduled' | 'applied' | 'expired' | 'canceled';

export interface PlanChangeInsert {
    userId: string;
    subscriptionId: string;
    kind: PlanChangeKind;
    fromSku: string;
    toSku: string | null;
    stripeInvoiceId: string | null;
    stripeScheduleId: string | null;
    hostedInvoiceUrl: string | null;
    state: PlanChangeState;
    effectiveAt: Date | null;
    expiresAt: Date | null;
}

export interface PlanChangeRow extends PlanChangeInsert {
    id: string;
    createdAt: Date;
    updatedAt: Date;
}

export interface PlanChangeStateUpdate {
    userId: string;
    subscriptionId: string;
    kind: PlanChangeKind;
    state: PlanChangeState;
    stripeInvoiceId?: string | null;
    effectiveAt?: Date | null;
    hostedInvoiceUrl?: string | null;
    expiresAt?: Date | null;
}

export interface PaymentIssueInsert {
    stripeInvoiceId: string;
    userId: string;
    subscriptionId: string | null;
    invoiceKind: 'subscription' | 'upgrade' | 'overage';
    issue: 'payment_failed' | 'requires_action' | 'voided' | 'uncollectible';
    hostedInvoiceUrl: string | null;
    eventCreated: Date;
}

export interface PaymentIssueRow extends Omit<PaymentIssueInsert, 'eventCreated'> {
    stripeEventCreated: Date;
    resolvedAt: Date | null;
    updatedAt: Date;
}

export interface BillingStore {
    // v2 ledger, compute and payment state
    grantsForPeriod(userId: string, window: { start: Date; end: Date }, meters: GrantMeter[]): Promise<GrantRow[]>;
    openEpoch(input: OpenEpochInput): Promise<{ status: 'opened' | 'exists'; epoch: ComputeEpoch }>;
    /** Computer ownership is checked by the caller, as for closeInterval. */
    closeEpoch(input: CloseEpochInput): Promise<'closed' | 'not_open'>;
    epochsFor(userId: string, since: Date): Promise<ComputeEpoch[]>;
    /** Appends each distinct decision once; exact replays retain the original identity. */
    recordConsent(input: OverageConsentInsert): Promise<OverageConsentRow>;
    /** Latest acceptance strictly before the exclusive period end; ties use audit identity. */
    consentAsOf(userId: string, subscriptionId: string, at: Date): Promise<OverageConsentRow | null>;
    /** Latest decision at or before start, then decisions strictly inside the period, ordered by (acceptedAt, id). */
    consentDecisionsForPeriod(userId: string, subscriptionId: string, start: Date, end: Date): Promise<OverageConsentRow[]>;
    latestConsent(userId: string, subscriptionId: string): Promise<OverageConsentRow | null>;
    upsertOverageInvoice(input: OverageInvoiceInsert): Promise<{ status: 'inserted' | 'exists'; row: OverageInvoiceRow }>;
    attachOverageStripeInvoice(id: string, stripeInvoiceId: string): Promise<void>;
    /** Only pending rows become open; webhook outcomes are preserved. */
    markOverageInvoiceOpen(stripeInvoiceId: string): Promise<void>;
    setOverageInvoiceStatus(stripeInvoiceId: string, status: OverageInvoiceStatus): Promise<'updated' | 'not_found'>;
    overageInvoiceByStripeId(stripeInvoiceId: string): Promise<OverageInvoiceRow | null>;
    overageInvoicesFor(userId: string): Promise<OverageInvoiceRow[]>;
    recordPlanChange(input: PlanChangeInsert): Promise<'inserted' | 'exists'>;
    setPlanChangeState(input: PlanChangeStateUpdate): Promise<void>;
    openPlanChanges(userId: string): Promise<PlanChangeRow[]>;
    recordPaymentIssue(input: PaymentIssueInsert): Promise<void>;
    resolvePaymentIssue(stripeInvoiceId: string, eventCreated: Date): Promise<void>;
    openPaymentIssues(userId: string): Promise<PaymentIssueRow[]>;
    setSizePreference(userId: string, size: SizeCode): Promise<void>;
    sizePreference(userId: string): Promise<SizeCode | null>;
    userCreatedAt(userId: string): Promise<Date | null>;

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
    upsertSubscription(row: SubscriptionUpsert): Promise<'applied' | 'stale' | 'conflict'>;
    insertGrant(grant: GrantInsert): Promise<'inserted' | 'duplicate'>;
    enqueueOutbox(item: OutboxInsert): Promise<'queued' | 'duplicate'>;

    // usage ingest (computer ownership already checked by the caller)
    latestIntervalFor(computerId: string): Promise<{ endedAt: Date | null } | null>;
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
    items: { id: string | null; priceId: string | null; lookupKey: string | null }[];
    defaultPaymentMethod: string | null;
    scheduleId: string | null;
    latestInvoiceId: string | null;
    pendingUpdateExpiresAt: Date | null;
    /** Known catalog SKU from metadata or the first recognized item lookup key. */
    sku: string | null;
}

export interface StripeInvoice {
    id: string;
    customer: string;
    status: string;
    subscriptionId: string | null;
    billingReason: string | null;
    metadataKind: string | null;
    hostedInvoiceUrl: string | null;
    lines: {
        id: string;
        lookupKey: string | null;
        subscriptionId: string | null;
        proration: boolean;
        amount: number;
        periodStart: Date | null;
        periodEnd: Date | null;
    }[];
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
     * OS window — `ui_mode=embedded_page`, `return_url` = `returnUrl`,
     * `redirect_on_completion=if_required`, so card / Link / wallet payments
     * finish in place with no redirect. `hosted`: the redirect page, kept for
     * clients that cannot load Stripe.js (`successUrl` / `cancelUrl`).
     */
    uiMode: 'embedded' | 'hosted';
    /** Stripe Tax on the session (`BILLING_AUTOMATIC_TAX=1`). */
    automaticTax: boolean;
    /** Stripe Adaptive Pricing / local currency (`BILLING_ADAPTIVE_PRICING=1`). Optional, default off. */
    adaptivePricing?: boolean;
    /** Stripe is merchant of record; when true, automaticTax/adaptivePricing are ignored. */
    managedPayments?: boolean;
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
    amountDueCents: number;
    metadataKind: string | null;
    billingReason: string | null;
    currency: string;
    created: Date;
    hostedInvoiceUrl: string | null;
    description: string | null;
}

export type StripeInvoicePaymentState = 'paid' | 'requires_action' | 'processing' | 'failed' | 'none';

export interface StripeApi {
    resolvePrice(lookupKey: string): Promise<StripePrice>;
    previewUpgrade(input: { subscriptionId: string; toSku: 'compute_monthly_v2'; prorationDate: number }): Promise<StripeUpgradePreview>;
    confirmUpgrade(input: { subscriptionId: string; toSku: 'compute_monthly_v2'; prorationDate: number; now: Date; idempotencyKey: string }): Promise<StripeUpgradeResult>;
    scheduleDowngrade(input: { subscriptionId: string; toSku: 'standard_monthly_v2'; idempotencyKey: string }): Promise<{ scheduleId: string; effectiveAt: Date }>;
    cancelScheduledChange(input: { scheduleId: string }): Promise<void>;
    setCancelAtPeriodEnd(input: { subscriptionId: string; cancel: boolean; idempotencyKey: string }): Promise<{ cancelsAt: Date | null }>;
    createCustomer(input: { userId: string; email: string | null; idempotencyKey: string }): Promise<{ id: string }>;
    createCheckoutSession(input: CheckoutRequest): Promise<CheckoutSessionCreated>;
    /** Newest first. */
    listInvoices(customerId: string, limit: number): Promise<StripeInvoiceSummary[]>;
    createPortalSession(input: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
    retrieveSubscription(id: string): Promise<StripeSubscription>;
    retrieveInvoice(id: string): Promise<StripeInvoice>;
    retrieveInvoicePaymentState(invoiceId: string): Promise<StripeInvoicePaymentState>;
    retrieveCheckoutSession(id: string): Promise<StripeCheckoutSession>;
    retrieveCharge(id: string): Promise<StripeCharge>;
}

export interface StripePrice {
    id: string;
    lookupKey: string;
    unitAmount: number | null;
    currency: string;
    recurring: boolean;
}

export interface StripeUpgradePreview {
    prorationDate: number;
    amountDueCents: number;
    currency: string;
    lines: { description: string; amountCents: number }[];
    periodStart: Date;
    periodEnd: Date;
}

export interface StripeUpgradeResult {
    status: 'applied' | 'requires_action' | 'payment_failed';
    invoiceId: string;
    hostedInvoiceUrl: string | null;
    expiresAt: Date | null;
}

export interface OverageInvoiceRequest {
    customerId: string;
    subscriptionId: string;
    periodStart: Date;
    periodEnd: Date;
    ratingVersion: number;
    cents: number;
    overageEnabled: boolean;
    now: Date;
    existingInvoiceId?: string | null;
}

export type OverageInvoiceResult =
    | { status: 'invoiced'; invoiceId: string; invoiceStatus: string; hostedInvoiceUrl: string | null }
    | { status: 'skipped'; reason: 'overage_disabled' | 'nothing_to_bill' | 'period_not_closed' };

export interface UsageBillingPort {
    invoiceOverage(input: OverageInvoiceRequest, hooks?: { onDraftCreated?: (invoiceId: string) => Promise<void> }): Promise<OverageInvoiceResult>;
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
    usage: UsageBillingPort | null;
    now: () => Date;
}
