/**
 * Billing contract v2 — PINNED. The billing core (lane A), the Settings →
 * Billing / pricing UI (lane B) and the compute admission path (lane C) are
 * built in parallel against THIS file and `docs/billing/CONTRACT-v2.md`, so a
 * contract described in two briefs cannot become two contracts.
 *
 * Change this file only through the lead, never inside a lane.
 *
 * Units, everywhere:
 * - time: integer whole seconds; instants on the wire are ISO-8601 UTC strings;
 * - compute: integer STANDARD seconds (`std-s`): actual seconds × size weight;
 * - money: integer US cents (`number`), before tax. Tax is never revenue.
 * No float ever enters a stored or billed quantity.
 */

// ── Constants ────────────────────────────────────────────────────────────────

export const CATALOG_V2_VERSION = 2 as const;

export const SECONDS_PER_HOUR = 3600;

/** $0.25 per standard-hour = 1 cent per 144 standard-seconds (3600 / 25). */
export const STD_SECONDS_PER_OVERAGE_CENT = 144;
export const OVERAGE_CENTS_PER_STD_HOUR = 25;

/** Hard wall-clock bound of one session, from "ready" to stop. Independent of the monthly allowance. */
export const SESSION_MAX_SECONDS = 21_600;
/** Warnings before the session bound, in seconds remaining. */
export const SESSION_WARN_SECONDS = [900, 300] as const;
/** A genuinely idle computer sleeps after this long. */
export const IDLE_SLEEP_SECONDS = 600;
/** A start is refused when it could run for less than this many ACTUAL seconds. */
export const MIN_START_ACTUAL_SECONDS = 60;

/** Default monthly overage cap shown when a customer turns overage on. */
export const OVERAGE_DEFAULT_CAP_CENTS = 2_500;
/** Platform ceiling a customer may raise the cap to (founder-adjustable constant, not an env var). */
export const OVERAGE_MAX_CAP_CENTS = 10_000;
/** Version of the overage terms a consent record refers to. Bump when the wording or rate changes. */
export const OVERAGE_TERMS_VERSION = 'overage-v2-2026-10-18' as const;

/**
 * Accounts created at or after this instant get `free_v2` (2 h); older ones keep
 * `free_v1_legacy` (8 h). `null` = the new Free policy is NOT yet effective, so
 * every Free account keeps 8 h — nothing is silently revoked. The founder sets
 * the date at release, and the change is disclosed on /pricing.
 */
export const FREE_V2_EFFECTIVE_AT: string | null = null;

// ── Compute sizes ────────────────────────────────────────────────────────────

export type SizeCode = 'free-cf' | 'std-2' | 'cmp-4' | 'cmp-8';
export type SizeWeight = 1 | 2 | 4;
export type ComputeProvider = 'cloudflare' | 'aws';

export interface ComputeSize {
    code: SizeCode;
    vcpu: number;
    memoryGiB: number;
    weight: SizeWeight;
    provider: ComputeProvider;
    /** x86_64 instance type (AWS) or container class (Cloudflare). */
    machine: string;
    /**
     * ARM is recorded for the economics only. It is NEVER selectable until the
     * image/host/supervisor/editor/browser suite passes on arm64.
     */
    arm: { machine: string; archVerified: false } | null;
}

export const SIZES: Readonly<Record<SizeCode, ComputeSize>> = Object.freeze({
    'free-cf': { code: 'free-cf', vcpu: 2, memoryGiB: 6, weight: 1, provider: 'cloudflare', machine: 'cf-custom-2vcpu-6gib', arm: null },
    'std-2': { code: 'std-2', vcpu: 2, memoryGiB: 8, weight: 1, provider: 'aws', machine: 'm6i.large', arm: { machine: 'm7g.large', archVerified: false } },
    'cmp-4': { code: 'cmp-4', vcpu: 4, memoryGiB: 16, weight: 2, provider: 'aws', machine: 'm6i.xlarge', arm: { machine: 'm7g.xlarge', archVerified: false } },
    'cmp-8': { code: 'cmp-8', vcpu: 8, memoryGiB: 32, weight: 4, provider: 'aws', machine: 'm6i.2xlarge', arm: { machine: 'm7g.2xlarge', archVerified: false } },
});

// ── Catalog v2 ───────────────────────────────────────────────────────────────

export type PlanSku = 'free_v2' | 'free_v1_legacy' | 'standard_monthly_v2' | 'compute_monthly_v2' | 'pro_monthly_v1';
export type PlanFamily = 'free' | 'standard' | 'compute' | 'pro_legacy';
export type SellableSku = 'standard_monthly_v2' | 'compute_monthly_v2';

export interface OveragePolicy {
    centsPerStdHour: typeof OVERAGE_CENTS_PER_STD_HOUR;
    stdSecondsPerCent: typeof STD_SECONDS_PER_OVERAGE_CENT;
    defaultCapCents: number;
    maxCapCents: number;
    /** Overage is ALWAYS opt-in: no subscription is ever auto-enrolled. */
    requiresConsent: true;
    /** Usage is invoiced in arrears on its own invoice, separate from the subscription invoice. */
    billedSeparately: true;
}

export interface PlanOffer {
    sku: PlanSku;
    family: PlanFamily;
    catalogVersion: 1 | 2;
    priceCents: number;
    currency: 'usd';
    interval: 'month' | null;
    /**
     * Stripe Price `lookup_key` (immutable, versioned). Resolved at runtime with
     * `GET /v1/prices?lookup_keys[]=…` — no per-price env var. null = not sold via Stripe.
     */
    stripeLookupKey: string | null;
    /** Included standard-seconds per allowance window. */
    allowanceStdSeconds: number;
    /** Free counts per UTC calendar month; paid plans per paid Stripe billing period. */
    allowanceWindow: 'utc_month' | 'stripe_period';
    sizes: readonly SizeCode[];
    defaultSize: SizeCode;
    overage: OveragePolicy | null;
    /** Only the v2 paid offers are sold. Legacy SKUs are honoured, never sold. */
    sellable: boolean;
    /** At most this many computers running at once per subscription (enforced server-side). */
    maxConcurrentComputers: 1;
    /**
     * Persistent workspace target. NOT offered until real capability, quota and
     * persistence are verified; until then the existing storage caps apply.
     */
    storageTargetGB: number | null;
    storageOffered: false;
    /** Explicit $3 managed-AI gate, kept OFF and separate (gate G4). Integer USD micro-units. */
    aiIncludedMicro: string;
}

const OVERAGE_V2: OveragePolicy = Object.freeze({
    centsPerStdHour: OVERAGE_CENTS_PER_STD_HOUR,
    stdSecondsPerCent: STD_SECONDS_PER_OVERAGE_CENT,
    defaultCapCents: OVERAGE_DEFAULT_CAP_CENTS,
    maxCapCents: OVERAGE_MAX_CAP_CENTS,
    requiresConsent: true,
    billedSeparately: true,
});

export const CATALOG_V2: Readonly<Record<PlanSku, PlanOffer>> = Object.freeze({
    free_v2: {
        sku: 'free_v2', family: 'free', catalogVersion: 2, priceCents: 0, currency: 'usd', interval: null,
        stripeLookupKey: null, allowanceStdSeconds: 2 * SECONDS_PER_HOUR, allowanceWindow: 'utc_month',
        sizes: ['free-cf'], defaultSize: 'free-cf', overage: null, sellable: false, maxConcurrentComputers: 1,
        storageTargetGB: null, storageOffered: false, aiIncludedMicro: '0',
    },
    free_v1_legacy: {
        sku: 'free_v1_legacy', family: 'free', catalogVersion: 1, priceCents: 0, currency: 'usd', interval: null,
        stripeLookupKey: null, allowanceStdSeconds: 8 * SECONDS_PER_HOUR, allowanceWindow: 'utc_month',
        sizes: ['free-cf'], defaultSize: 'free-cf', overage: null, sellable: false, maxConcurrentComputers: 1,
        storageTargetGB: null, storageOffered: false, aiIncludedMicro: '0',
    },
    standard_monthly_v2: {
        sku: 'standard_monthly_v2', family: 'standard', catalogVersion: 2, priceCents: 2_000, currency: 'usd', interval: 'month',
        stripeLookupKey: 'ezil_standard_monthly_v2', allowanceStdSeconds: 60 * SECONDS_PER_HOUR, allowanceWindow: 'stripe_period',
        sizes: ['std-2'], defaultSize: 'std-2', overage: null, sellable: true, maxConcurrentComputers: 1,
        storageTargetGB: 60, storageOffered: false, aiIncludedMicro: '3000000',
    },
    compute_monthly_v2: {
        sku: 'compute_monthly_v2', family: 'compute', catalogVersion: 2, priceCents: 10_000, currency: 'usd', interval: 'month',
        stripeLookupKey: 'ezil_compute_monthly_v2', allowanceStdSeconds: 500 * SECONDS_PER_HOUR, allowanceWindow: 'stripe_period',
        sizes: ['std-2', 'cmp-4', 'cmp-8'], defaultSize: 'std-2', overage: OVERAGE_V2, sellable: true, maxConcurrentComputers: 1,
        storageTargetGB: 60, storageOffered: false, aiIncludedMicro: '3000000',
    },
    pro_monthly_v1: {
        sku: 'pro_monthly_v1', family: 'pro_legacy', catalogVersion: 1, priceCents: 2_000, currency: 'usd', interval: 'month',
        stripeLookupKey: null, allowanceStdSeconds: 20 * SECONDS_PER_HOUR, allowanceWindow: 'stripe_period',
        sizes: ['std-2'], defaultSize: 'std-2', overage: null, sellable: false, maxConcurrentComputers: 1,
        storageTargetGB: 20, storageOffered: false, aiIncludedMicro: '3000000',
    },
});

/** Stripe one-time Price for overage: 1 cent per unit, 1 unit = 144 std-s (1/25 standard-hour). */
export const OVERAGE_PRICE_LOOKUP_KEY = 'ezil_compute_overage_v2' as const;

// ── Metering ─────────────────────────────────────────────────────────────────

export type EpochEndReason =
    | 'user_stop'
    | 'idle_sleep'
    | 'session_max'
    | 'allowance_exhausted'
    | 'overage_cap'
    | 'payment_issue'
    | 'resize'
    | 'provider_stop'
    | 'platform_failure';

/**
 * One usage epoch: a computer at ONE size from "ready" (usable resource
 * allocated) to its verified stop. A size change closes the epoch (`resize`) and
 * opens a new one. Provisioning before ready, failed provisioning and platform
 * outages are never in an epoch; they go in `overheadSeconds`.
 *
 * Instants are normalised to whole seconds in the customer's favour:
 * `readyAt` rounds UP, `endedAt` rounds DOWN.
 */
export interface ComputeEpoch {
    id: string;
    userId: string;
    computerId: string;
    size: SizeCode;
    weight: SizeWeight;
    readyAt: string;
    endedAt: string | null;
    endReason: EpochEndReason | null;
    /** Provider time before ready / after stop; recorded, never billed. */
    overheadSeconds: number;
}

export interface Window {
    /** Inclusive, whole-second ISO instant. */
    start: string;
    /** Exclusive, whole-second ISO instant. */
    end: string;
}

export interface WindowUsage {
    /** Actual (wall-clock) seconds inside the window per size. */
    actualSecondsBySize: Partial<Record<SizeCode, number>>;
    /** Σ actual × weight, summed BEFORE any rounding. */
    stdSeconds: number;
}

/**
 * Rate epochs inside one allowance window. An open epoch counts to
 * `min(now, readyAt + SESSION_MAX_SECONDS)`: a missed stop can never bill past
 * the session bound. Epochs are clipped to the window, so one crossing a period
 * or month boundary is split exactly (no second lost or double-counted).
 */
export type RateWindow = (input: { epochs: readonly ComputeEpoch[]; window: Window; now: string }) => WindowUsage;

export interface PeriodRating {
    allowanceStdSeconds: number;
    usedStdSeconds: number;
    /** max(0, allowance − used). */
    remainingStdSeconds: number;
    /** max(0, used − allowance). */
    overStdSeconds: number;
    /** floor(overStdSeconds / 144). */
    overageCents: number;
    /** min(overageCents, capCents) when overage is enabled; 0 otherwise. Never more than the cap. */
    billableOverageCents: number;
}

export type RatePeriod = (input: {
    usedStdSeconds: number;
    allowanceStdSeconds: number;
    overage: { enabled: boolean; capCents: number } | null;
}) => PeriodRating;

/**
 * Upgrade grant (Standard → Compute) after the proration invoice is PAID:
 * floor((toAllowance − fromAllowance) × remainingSeconds / periodSeconds), where
 * remainingSeconds = periodEnd − effectiveAt. Usage carries over; nothing resets.
 */
export type UpgradeGrantStdSeconds = (input: {
    fromSku: PlanSku;
    toSku: PlanSku;
    periodStart: string;
    periodEnd: string;
    effectiveAt: string;
}) => number;

export type AdmitRefusal =
    | 'no_plan'
    | 'size_not_allowed'
    | 'allowance_exhausted'
    | 'overage_cap_reached'
    | 'payment_issue'
    | 'concurrent_limit'
    | 'upgrade_pending';

export type AdmitDecision =
    | {
        admit: true;
        size: SizeCode;
        weight: SizeWeight;
        /** min(SESSION_MAX_SECONDS, floor(headroomStdSeconds / weight)). */
        maxRunSeconds: number;
        /** ISO instant the session must be stopped by. */
        deadline: string;
    }
    | { admit: false; reason: AdmitRefusal };

/**
 * Server-side start gate. headroom = max(0, allowance + (overage enabled ?
 * capCents × 144 : 0) − used). Admit only when floor(headroom / weight) ≥
 * MIN_START_ACTUAL_SECONDS and no other computer of the subscription runs.
 */
export type AdmitStart = (input: {
    planSku: PlanSku | null;
    planActive: boolean;
    paymentIssue: boolean;
    upgradePending: boolean;
    size: SizeCode;
    usedStdSeconds: number;
    allowanceStdSeconds: number;
    overage: { enabled: boolean; capCents: number } | null;
    runningComputers: number;
    now: string;
}) => AdmitDecision;

// ── Grants (ledger rules) ────────────────────────────────────────────────────

/** New ledger meter for compute allowance, in standard-seconds. */
export const GRANT_METER_COMPUTE = 'compute_std_seconds' as const;
/** v2 grant kinds (existing v1 kinds stay valid for legacy rows). */
export type GrantKindV2 = 'plan_period' | 'upgrade_prorated' | 'revoke' | 'suspend' | 'restore';

/**
 * Only these invoice `billing_reason`s may grant a period allowance, and only
 * when the invoice is PAID and its base-price line (matched by Price lookup key,
 * never "first line") covers the period. Overage invoices (`metadata.kind =
 * 'overage'`), manual invoices and unpaid renewals NEVER grant.
 */
export const PERIOD_GRANT_BILLING_REASONS = ['subscription_create', 'subscription_cycle'] as const;
/** The proration invoice of a pending-if-incomplete upgrade grants only `upgrade_prorated`. */
export const UPGRADE_GRANT_BILLING_REASON = 'subscription_update' as const;

// ── Wire DTOs (tRPC; the shell does not decode superjson) ────────────────────

export type MeterState = 'ok' | 'low' | 'exhausted' | 'over_cap' | 'unavailable';

export type PlanStatusV2 = 'free' | 'active' | 'cancels' | 'past_due' | 'incomplete' | 'upgrade_pending';

export type PaymentIssue = 'payment_failed' | 'requires_action' | 'overage_unpaid' | null;

export interface PlanSummaryV2 {
    sku: PlanSku;
    family: PlanFamily;
    status: PlanStatusV2;
    periodStart: string;
    periodEnd: string;
    renewsAt: string | null;
    cancelsAt: string | null;
    /** A period-end change already scheduled (downgrade). */
    scheduledChange: { toSku: SellableSku; effectiveAt: string } | null;
    /** An upgrade waiting for its proration invoice to be paid. Expires; never grants until paid. */
    pendingUpgrade: { toSku: SellableSku; expiresAt: string; hostedInvoiceUrl: string | null } | null;
    paymentIssue: PaymentIssue;
}

export interface SessionPolicyDTO {
    maxSeconds: typeof SESSION_MAX_SECONDS;
    warnSeconds: readonly number[];
    idleSleepSeconds: typeof IDLE_SLEEP_SECONDS;
    /** Deadline of the running session, if any. */
    activeDeadline: string | null;
}

export interface ComputeMeterDTO {
    allowanceStdSeconds: number;
    usedStdSeconds: number;
    remainingStdSeconds: number;
    resetsAt: string;
    state: MeterState;
    /** Remaining ACTUAL seconds at each allowed size = floor(remainingStd / weight) (excluding overage). */
    remainingActualSecondsBySize: Partial<Record<SizeCode, number>>;
    allowedSizes: SizeCode[];
    selectedSize: SizeCode;
    session: SessionPolicyDTO;
}

export interface OverageDTO {
    available: boolean;
    enabled: boolean;
    centsPerStdHour: typeof OVERAGE_CENTS_PER_STD_HOUR;
    capCents: number;
    defaultCapCents: number;
    maxCapCents: number;
    /** Overage accrued this period so far (already capped). */
    accruedCents: number;
    termsVersion: typeof OVERAGE_TERMS_VERSION;
    /** The terms version the customer accepted, if any. */
    acceptedVersion: string | null;
    acceptedAt: string | null;
    pausedReason: 'cap_reached' | 'payment_failed' | null;
}

export interface EstimateDTO {
    nextChargeAt: string | null;
    /** Next subscription charge, before tax. */
    subscriptionCents: number | null;
    /** Overage accrued so far in the current period, before tax; billed on its own invoice. */
    accruedOverageCents: number;
    /** Overage at the cap if usage continues (worst case), before tax. */
    worstCaseOverageCents: number;
    currency: 'usd';
    taxNote: 'before_tax';
}

export interface StorageMeterDTO {
    /** null (state `unavailable`) until a computer has been measured. */
    usedBytes: string | null;
    capBytes: string;
    state: MeterState;
    measuredAt: string | null;
}

export interface AiMeterDTO {
    state: MeterState;
    trialMicro: string;
    includedMicro: string;
    purchasedMicro: string;
    includedExpiresAt: string | null;
}

export interface OfferDTO {
    sku: SellableSku;
    family: 'standard' | 'compute';
    priceCents: number;
    currency: 'usd';
    interval: 'month';
    allowanceStdSeconds: number;
    sizes: SizeCode[];
    overage: { centsPerStdHour: number; defaultCapCents: number; maxCapCents: number } | null;
}

export interface SizeDTO {
    code: SizeCode;
    vcpu: number;
    memoryGiB: number;
    weight: SizeWeight;
}

export interface BillingSummaryV2 {
    enabled: true;
    version: 2;
    plan: PlanSummaryV2;
    compute: ComputeMeterDTO;
    /** null for plans without overage (Free, Standard, legacy). */
    overage: OverageDTO | null;
    estimate: EstimateDTO;
    storage: StorageMeterDTO;
    ai: AiMeterDTO;
    actions: {
        checkout: boolean;
        portal: boolean;
        upgrade: boolean;
        downgrade: boolean;
        cancel: boolean;
        overage: boolean;
        selectSize: boolean;
    };
    catalog: { version: typeof CATALOG_V2_VERSION; offers: OfferDTO[]; sizes: SizeDTO[] };
}

export type BillingSummaryV2Result = BillingSummaryV2 | { enabled: false };

// Procedure inputs/outputs (router `billing.*`).

export interface CreateCheckoutInput { sku: SellableSku }
export type CheckoutStartDTO =
    | { mode: 'embedded'; sessionId: string; clientSecret: string; publishableKey: string }
    | { mode: 'redirect'; sessionId: string; url: string };

export interface PreviewUpgradeInput { toSku: 'compute_monthly_v2' }
export interface PreviewUpgradeOutput {
    toSku: 'compute_monthly_v2';
    /** Unix seconds Stripe prorates from; must be echoed back to `confirmUpgrade`. */
    prorationDate: number;
    amountDueCents: number;
    currency: 'usd';
    lines: { description: string; amountCents: number }[];
    periodEnd: string;
    /** Standard-seconds granted once the proration invoice is paid. */
    grantStdSeconds: number;
}

export interface ConfirmUpgradeInput { toSku: 'compute_monthly_v2'; prorationDate: number }
export interface ConfirmUpgradeOutput {
    /** applied = paid now; requires_action = 3DS etc.; payment_failed = pending update kept until it expires. */
    status: 'applied' | 'requires_action' | 'payment_failed';
    invoiceId: string;
    hostedInvoiceUrl: string | null;
    expiresAt: string | null;
}

export interface ScheduleDowngradeInput { toSku: 'standard_monthly_v2' }
export interface ScheduleDowngradeOutput { effectiveAt: string }

export interface CancelAtPeriodEndInput { cancel: boolean }
export interface CancelAtPeriodEndOutput { cancelsAt: string | null }

export interface SetOverageInput { enabled: boolean; capCents: number; termsVersion: typeof OVERAGE_TERMS_VERSION }
export type SetOverageOutput = OverageDTO;

export interface SelectSizeInput { size: SizeCode }
export interface SelectSizeOutput { selectedSize: SizeCode }

export interface BillingInvoiceDTO {
    id: string;
    number: string | null;
    status: string;
    /** subscription = base fee/proration; overage = separate usage invoice. */
    kind: 'subscription' | 'overage' | 'other';
    amountPaidCents: number;
    amountDueCents: number;
    currency: string;
    created: string;
    url: string | null;
    description: string | null;
}

export type CheckoutStatusDTO = 'pending' | 'complete' | 'expired' | 'unknown';

/** tRPC error messages the UI maps to copy. */
export type BillingErrorCode =
    | 'billing_not_configured'
    | 'unknown_sku'
    | 'already_subscribed'
    | 'not_subscribed'
    | 'upgrade_not_allowed'
    | 'upgrade_pending'
    | 'downgrade_not_allowed'
    | 'cap_out_of_range'
    | 'terms_version_mismatch'
    | 'size_not_allowed'
    | 'customer_conflict'
    | 'stripe_unavailable';
