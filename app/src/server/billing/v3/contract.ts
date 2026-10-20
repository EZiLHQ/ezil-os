/**
 * Billing contract v3 — PINNED (lead only). Simple plans: Free / Standard /
 * Premium. The paid difference is felt, not metered: longer sessions and a
 * dedicated AWS computer in Mumbai; Premium chooses 2, 4 or 8 vCPU. Monthly
 * time is a fair-use guardrail in standard-seconds (a size of weight w uses w
 * per second), shown as a status, never as a meter. Founder 2026-10-20:
 * Free / Standard $20 / Premium $100. No speed promise until it is measured.
 *
 * v2 (Standard/Compute, overage, std-hour meters) stays in the codebase,
 * dormant: already-sold v2 subscriptions keep their v2 terms, new checkouts
 * sell v3 only. See docs/billing/CONTRACT-v3.md.
 *
 * Grounding:
 * - real usage 2026-09-19..10-18 (Cloudflare containers metrics): session minutes p50 14 / p90 77 / p95 139 / p99 390; monthly
 *   hours per computer p50 0.25 / p90 7.05. 1 h covers ~87% of
 *   sessions, 2 h ~93%, 6 h ~99%.
 * - cold open today (boot_summary since 10-04): p50 9.4 s, p90 36.2 s.
 *   Measured AWS warm disk attach ≈ 2 s (docs/billing/AWS-PROBE-2026-10-18.md).
 */
import type { ComputeProvider, SizeCode } from '../v2/contract';

export const CATALOG_V3_VERSION = 3 as const;

export type PlanSkuV3 = 'free_v3' | 'standard_monthly_v3' | 'premium_monthly_v3';
export type SellableSkuV3 = 'standard_monthly_v3' | 'premium_monthly_v3';
export type PlanTierV3 = 'free' | 'standard' | 'premium';

/** How a computer opens. `fast`/`fastest` lease a pre-booted host from the warm pool. */
export type OpeningSpeed = 'standard' | 'fast' | 'fastest';

/** Pool priority: higher leases first when spares are short. 0 = never uses the pool. */
export type PoolPriority = 0 | 1 | 2;

export const FAIR_USE_NEAR_RATIO = 0.8;

export interface PlanOfferV3 {
    sku: PlanSkuV3;
    tier: PlanTierV3;
    /** Display name. Plain words only (no "compute", no "standard-hours"). */
    name: 'Free' | 'Standard' | 'Premium';
    /** One audience line under the name. */
    tagline: string;
    priceCents: number;
    currency: 'usd';
    interval: 'month' | null;
    /** Immutable Stripe Price lookup key; null = not sold via Stripe. */
    stripeLookupKey: string | null;
    size: SizeCode;
    provider: ComputeProvider;
    vcpu: number;
    memoryGiB: number;
    /** Hard wall-clock bound of one session. */
    sessionMaxSeconds: number;
    opening: OpeningSpeed;
    poolPriority: PoolPriority;
    /**
     * Fair-use guardrail in STANDARD seconds per allowance window (UTC month
     * for Free, paid billing period otherwise): a running size of weight w
     * (std-2 = 1, cmp-4 = 2, cmp-8 = 4) uses w per second. Enforced
     * server-side; shown only as a status and in the FAQ.
     */
    fairUseSeconds: number;
    /** Free accounts created before FREE_V2_EFFECTIVE_AT keep 8 h. */
    legacyFairUseSeconds: number | null;
    highlighted: boolean;
    badge: 'Most popular' | null;
    /** Sizes the user may choose; the first is the default. */
    machineChoice: readonly SizeCode[];
    /** "Everything in X, plus:" bullets, plain language, 3–4 max. */
    bullets: readonly string[];
}

const H = 3600;

export const CATALOG_V3: Readonly<Record<PlanSkuV3, PlanOfferV3>> = Object.freeze({
    free_v3: {
        sku: 'free_v3', tier: 'free', name: 'Free', tagline: 'Try EZiL OS and build small projects.',
        priceCents: 0, currency: 'usd', interval: null, stripeLookupKey: null,
        size: 'free-cf', provider: 'cloudflare', vcpu: 2, memoryGiB: 6,
        sessionMaxSeconds: 1 * H, opening: 'standard', poolPriority: 0,
        fairUseSeconds: 5 * H, legacyFairUseSeconds: 8 * H,
        highlighted: false, badge: null, machineChoice: ['free-cf'],
        bullets: ['A real desktop in your browser', 'VS Code and a browser built in', '2 vCPU · 6 GB computer', 'Sessions up to 1 hour'],
    },
    standard_monthly_v3: {
        sku: 'standard_monthly_v3', tier: 'standard', name: 'Standard', tagline: 'For regular work, every day.',
        priceCents: 2_000, currency: 'usd', interval: 'month', stripeLookupKey: 'ezil_standard_monthly_v3',
        size: 'std-2', provider: 'aws', vcpu: 2, memoryGiB: 8,
        sessionMaxSeconds: 2 * H, opening: 'standard', poolPriority: 1,
        fairUseSeconds: 40 * H, legacyFairUseSeconds: null,
        highlighted: false, badge: null, machineChoice: ['std-2'],
        bullets: ['Your own 2 vCPU · 8 GB computer in Mumbai', 'Sessions up to 2 hours'],
    },
    premium_monthly_v3: {
        sku: 'premium_monthly_v3', tier: 'premium', name: 'Premium', tagline: 'For heavy builds and long sessions.',
        priceCents: 10_000, currency: 'usd', interval: 'month', stripeLookupKey: 'ezil_premium_monthly_v3',
        size: 'std-2', provider: 'aws', vcpu: 2, memoryGiB: 8,
        sessionMaxSeconds: 6 * H, opening: 'standard', poolPriority: 2,
        fairUseSeconds: 500 * H, legacyFairUseSeconds: null,
        highlighted: true, badge: null, machineChoice: ['std-2', 'cmp-4', 'cmp-8'],
        bullets: ['Choose 2, 4 or 8 vCPU (8, 16 or 32 GB) in Mumbai', 'Sessions up to 6 hours', 'Bigger computers use your monthly time faster'],
    },
});

/** Upgrade path: Free → Standard | Premium (checkout); Standard → Premium (paid proration, pending-if-incomplete). */
export const UPGRADE_TARGET_V3: Readonly<Partial<Record<PlanSkuV3, SellableSkuV3>>> = Object.freeze({
    standard_monthly_v3: 'premium_monthly_v3',
});

// ── Fair use ─────────────────────────────────────────────────────────────────

export type FairUseStatus = 'ok' | 'near' | 'paused';

/**
 * ok: used < 80% of fair use; near: ≥ 80%; paused: ≥ 100% (no new session
 * until the window resets or the user upgrades). Integer seconds in, no floats.
 */
export type FairUseStatusOf = (input: { usedSeconds: number; fairUseSeconds: number }) => FairUseStatus;

// ── Admission (v3) ───────────────────────────────────────────────────────────

export type AdmitRefusalV3 = 'no_plan' | 'fair_use_paused' | 'payment_issue' | 'concurrent_limit' | 'upgrade_pending';

export type AdmitDecisionV3 =
    | { admit: true; size: SizeCode; maxRunSeconds: number; deadline: string; fromPool: boolean; poolPriority: PoolPriority }
    | { admit: false; reason: AdmitRefusalV3 };

/**
 * maxRunSeconds = min(sessionMaxSeconds, fairUseSeconds − used). Refuse below
 * 60 s left (fair_use_paused). One running computer per user. Pool only for
 * poolPriority > 0 and only when a ready host exists (else cold path, fromPool false).
 */
export type AdmitStartV3 = (input: {
    sku: PlanSkuV3 | null;
    planActive: boolean;
    paymentIssue: boolean;
    usedSeconds: number;
    legacyFree: boolean;
    runningComputers: number;
    poolHostAvailable: boolean;
    now: string;
}) => AdmitDecisionV3;

// ── Wire DTOs ────────────────────────────────────────────────────────────────

export type PlanStatusV3 = 'free' | 'active' | 'cancels' | 'past_due' | 'incomplete' | 'upgrade_pending';

export interface BillingSummaryV3 {
    enabled: true;
    version: 3;
    plan: {
        sku: PlanSkuV3 | 'legacy';
        name: string;
        status: PlanStatusV3;
        /** "Your plan renews on <date> for <amount>" (Grammarly pattern). */
        renewal: { at: string; amountCents: number } | null;
        cancelsAt: string | null;
        scheduledChange: { toSku: SellableSkuV3; effectiveAt: string } | null;
        pendingUpgrade: { toSku: SellableSkuV3; expiresAt: string; hostedInvoiceUrl: string | null } | null;
        paymentIssue: 'payment_failed' | 'requires_action' | null;
    };
    computer: {
        /** The size the next session opens with (the chosen size on Premium). */
        size: SizeCode;
        vcpu: number;
        memoryGiB: number;
        sessionMaxSeconds: number;
        opening: OpeningSpeed;
        /** Deadline of the running session, if any. */
        activeDeadline: string | null;
        /** Sizes this plan may choose (one entry unless Premium); x86 only until ARM is verified. */
        machineChoice: readonly MachineOptionV3[];
    };
    fairUse: { status: FairUseStatus; resetsAt: string };
    storage: { usedBytes: string; capBytes: string; state: 'ok' | 'low' | 'exhausted' | 'unavailable' };
    actions: { checkout: boolean; upgrade: boolean; downgrade: boolean; cancel: boolean; portal: boolean };
    catalog: { version: typeof CATALOG_V3_VERSION; offers: PublicOfferV3[] };
}

export type BillingSummaryV3Result = BillingSummaryV3 | { enabled: false };

export interface PublicOfferV3 {
    sku: PlanSkuV3;
    name: string;
    tagline: string;
    priceCents: number;
    vcpu: number;
    memoryGiB: number;
    sessionMaxSeconds: number;
    opening: OpeningSpeed;
    /** Shown in the FAQ only: "Fair use: about N hours a month". */
    fairUseHours: number;
    highlighted: boolean;
    badge: 'Most popular' | null;
    /** Sizes the user may choose; the first is the default. */
    machineChoice: readonly SizeCode[];
    bullets: readonly string[];
}

/** Router (v3): summary, createCheckout({sku: SellableSkuV3}), previewUpgrade/confirmUpgrade({toSku:'premium_monthly_v3'}),
 *  scheduleDowngrade({toSku:'standard_monthly_v3'}), cancelAtPeriodEnd, history, portal, checkoutStatus.
 *  Input/output shapes otherwise as v2 (PreviewUpgradeOutput etc. with toSku widened). No overage, no selectSize. */
export const ROUTER_V3_PROCEDURES = [
    'summary', 'createCheckout', 'previewUpgrade', 'confirmUpgrade', 'scheduleDowngrade', 'cancelAtPeriodEnd',
    'history', 'portal', 'checkoutStatus',
] as const;

// ── Machine choice (Premium) ─────────────────────────────────────────────────

export interface MachineOptionV3 {
    size: SizeCode;
    vcpu: number;
    memoryGiB: number;
    /** Standard-seconds used per running second (1, 2 or 4). */
    weight: number;
    arch: 'x86_64';
}

/** `billing.selectMachine` input. Refused unless `size` is in the plan's `machineChoice`. */
export interface SelectMachineInputV3 {
    size: SizeCode;
}

/** Takes effect when the next session opens; a running session keeps its size. */
export interface SelectMachineOutputV3 {
    size: SizeCode;
    effective: 'next_open';
}
