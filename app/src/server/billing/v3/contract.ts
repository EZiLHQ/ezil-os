/**
 * Billing contract v3 — PINNED (lead only). Simple plans: Free / Standard /
 * Premium. The paid difference is felt, not metered: longer sessions and a
 * dedicated AWS computer in Mumbai; Premium chooses 2, 4 or 8 vCPU. Monthly
 * time is a fair-use guardrail in standard-seconds (a size of weight w uses w
 * per second). Round 3 (founder 2026-10-28): the time left is shown in hours
 * at the computer's CURRENT configuration (standard-seconds ÷ weight), with
 * the equivalents at the other sizes; the words "standard-hour" / "compute
 * hours" never appear in user copy (scanCopy). Founder 2026-10-20:
 * Free / Standard $20 / Premium $100. No speed promise until it is measured.
 *
 * Round 3 pins (plan jaunty-singing-tulip §12; implemented by lanes L1/L2/L4):
 * - D1 `upgradeAiCredits`: a paid Standard → Premium upgrade adds the prorated
 *   difference of the two plans' period credits when the proration invoice is
 *   paid (same remaining-fraction as the compute `upgrade_prorated` grant).
 * - D5 one computer, selectable configuration: `SwitchConfiguration*` below.
 * - Opening progress: `OpeningProgressV3` (server start time, path, milestones).
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

/**
 * AI credit policy (founder 2026-10-26): the platform decides how many EZiL AI
 * credits each plan grants; paid credits equal the plan price at $0.10 each.
 * Consumption per model is the AI Gateway's own pricing (credits per token).
 * Keep entitlement identities stable; grants already made retain their stored terms.
 */
export const AI_CREDIT_POLICY_VERSION = 1 as const;

export interface AiCreditGrantV3 {
    /** Whole EZiL AI credits (the Gateway's credit unit). */
    amount: number;
    /** 'period' = every paid billing period; 'once' = a single trial grant per account. */
    per: 'period' | 'once';
}

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
    /** null = no session cap (paid plans, founder 2026-10-20); fair use still applies. */
    sessionMaxSeconds: number | null;
    opening: OpeningSpeed;
    poolPriority: PoolPriority;
    /**
     * Fair-use guardrail in STANDARD seconds per allowance window (UTC month
     * for Free, paid billing period otherwise): a running size of weight w
     * (std-2 = 1, cmp-4 = 2, cmp-8 = 4) uses w per second. Enforced
     * server-side; shown as hours left at the current configuration (round 3,
     * `hoursLeftAtWeight`) plus the near/paused status.
     */
    fairUseSeconds: number;
    /** Free accounts created before FREE_V2_EFFECTIVE_AT keep 8 h. */
    legacyFairUseSeconds: number | null;
    highlighted: boolean;
    badge: 'Most popular' | null;
    /** Sizes the user may choose; the first is the default. */
    machineChoice: readonly SizeCode[];
    /** EZiL AI credits granted on the AI Gateway (plain credit numbers, never shown as money). */
    aiCredits: AiCreditGrantV3;
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
        highlighted: false, badge: null, machineChoice: ['free-cf'], aiCredits: { amount: 100, per: 'once' },
        bullets: ['A real desktop in your browser', 'VS Code and a browser built in', '2 vCPU · 6 GB computer', 'Sessions up to 1 hour'],
    },
    standard_monthly_v3: {
        sku: 'standard_monthly_v3', tier: 'standard', name: 'Standard', tagline: 'For regular work, every day.',
        priceCents: 2_000, currency: 'usd', interval: 'month', stripeLookupKey: 'ezil_standard_monthly_v3',
        size: 'std-2', provider: 'aws', vcpu: 2, memoryGiB: 8,
        sessionMaxSeconds: null, opening: 'standard', poolPriority: 1,
        fairUseSeconds: 40 * H, legacyFairUseSeconds: null,
        highlighted: false, badge: null, machineChoice: ['std-2'], aiCredits: { amount: 200, per: 'period' },
        bullets: ['Your own 2 vCPU · 8 GB computer on AWS (India)', 'No session time limit'],
    },
    premium_monthly_v3: {
        sku: 'premium_monthly_v3', tier: 'premium', name: 'Premium', tagline: 'For heavy builds and long sessions.',
        priceCents: 10_000, currency: 'usd', interval: 'month', stripeLookupKey: 'ezil_premium_monthly_v3',
        size: 'std-2', provider: 'aws', vcpu: 2, memoryGiB: 8,
        sessionMaxSeconds: null, opening: 'standard', poolPriority: 2,
        fairUseSeconds: 500 * H, legacyFairUseSeconds: null,
        highlighted: true, badge: null, machineChoice: ['std-2', 'cmp-4', 'cmp-8'], aiCredits: { amount: 1_000, per: 'period' },
        bullets: ['Choose 2, 4 or 8 vCPU (8, 16 or 32 GB) on AWS (India)', 'No session time limit', 'Bigger computers use your monthly time faster'],
    },
});

/** Upgrade path: Free → Standard | Premium (checkout); Standard → Premium (paid proration, pending-if-incomplete). */
export const UPGRADE_TARGET_V3: Readonly<Partial<Record<PlanSkuV3, SellableSkuV3>>> = Object.freeze({
    standard_monthly_v3: 'premium_monthly_v3',
});

const epochSeconds = (iso: string) => Math.floor(new Date(iso).getTime() / 1000);

/** Suffix of the upgrade grant's entitlement id: `ezil-os:v1:<toSku>:<subscriptionId>:<effectiveAt ISO>:upgrade`. */
export const UPGRADE_AI_ENTITLEMENT_SUFFIX = 'upgrade' as const;

/**
 * Round 3 D1 (founder 2026-10-28). Whole credits added by a paid upgrade:
 * floor((to.period − from.period) × remaining / period), the same integer
 * proration `upgradeGrantSeconds` applies to compute. Renewal grants the full
 * amount of the new plan; credits already granted for the old plan are kept.
 * Reversed only by a refund/dispute of the proration invoice. 0 on any
 * invalid or non-positive input (never throws, never negative).
 */
export function upgradeAiCredits(input: { fromSku: SellableSkuV3; toSku: SellableSkuV3; periodStart: string; periodEnd: string; effectiveAt: string }): number {
    const delta = CATALOG_V3[input.toSku].aiCredits.amount - CATALOG_V3[input.fromSku].aiCredits.amount;
    const start = epochSeconds(input.periodStart), end = epochSeconds(input.periodEnd), at = epochSeconds(input.effectiveAt);
    if (!Number.isSafeInteger(delta) || delta <= 0 || ![start, end, at].every(Number.isFinite)) return 0;
    const duration = end - start;
    if (duration <= 0) return 0;
    const remaining = Math.min(duration, Math.max(0, end - at));
    return Number(BigInt(delta) * BigInt(remaining) / BigInt(duration));
}

/** Round 3 D3 display rule: whole hours left at a configuration of weight w (1, 2 or 4). */
export function hoursLeftAtWeight(remainingStandardSeconds: number, weight: number): number {
    if (!Number.isFinite(remainingStandardSeconds) || remainingStandardSeconds <= 0 || !Number.isInteger(weight) || weight < 1) return 0;
    return Math.floor(remainingStandardSeconds / weight / 3600);
}

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
        /** null = no session cap (paid plans, founder 2026-10-20); fair use still applies. */
    sessionMaxSeconds: number | null;
        opening: OpeningSpeed;
        /** Deadline of the running session, if any. */
        activeDeadline: string | null;
        /** Sizes this plan may choose (one entry unless Premium); x86 only until ARM is verified. */
        machineChoice: readonly MachineOptionV3[];
        /**
         * Round 3 (L1, additive): the computer's data disk. `provisionedGiB` is the AWS data volume
         * (same on every configuration; null on Free/Cloudflare); `usedBytes` only when measured.
         */
        disk?: { provisionedGiB: number | null; usedBytes: string | null };
    };
    /** EZiL AI credits: the plan's grant, and the live Gateway balance when it can be read. */
    ai: {
        grant: AiCreditGrantV3;
        /** Whole credits left on the Gateway, or null when the balance is unavailable. */
        balance: number | null;
        /**
         * Round 3: low/exhausted are judged against the plan's credits for THIS period
         * (`included`), never against a total that mixes earlier periods, top-ups or the
         * starter grant. `exhausted` = nothing spendable at all.
         */
        state: 'ok' | 'low' | 'exhausted' | 'unavailable';
        /**
         * Round 3 (L1, additive). The plan's credits for the current paid period (the
         * period grant plus any upgrade grant); `remaining` null when the Gateway
         * breakdown is unavailable. null on Free and legacy plans.
         */
        included?: { granted: number; remaining: number | null; periodEnd: string } | null;
        /** Live purchased (top-up) credits; `expiresAt` = the earliest expiry. null when none or unknown. */
        purchased?: { remaining: number; expiresAt: string } | null;
        /** The Free starter grant still live; null when none or unknown. */
        starter?: { remaining: number } | null;
        /** The plan's period amount the next renewal adds when this period has no grant of it yet (e.g. right after an upgrade). */
        pendingFromRenewal?: { credits: number; at: string } | null;
    };
    fairUse: { status: FairUseStatus; resetsAt: string };
    storage: { usedBytes: string; capBytes: string; state: 'ok' | 'low' | 'exhausted' | 'unavailable' };
    actions: { checkout: boolean; topup: boolean; upgrade: boolean; downgrade: boolean; cancel: boolean; portal: boolean };
    catalog: {
        version: typeof CATALOG_V3_VERSION;
        offers: PublicOfferV3[];
        packs: { sku: string; aiCredits: number; creditCents: number; discountPercent: number; totalCents: number; currency: 'usd' }[];
        customTopup: { minCents: 1000; maxCents: 1000000; centsPerCredit: 10 };
    };
}

export type BillingSummaryV3Result = BillingSummaryV3 | { enabled: false };

export interface PublicOfferV3 {
    sku: PlanSkuV3;
    name: string;
    tagline: string;
    priceCents: number;
    vcpu: number;
    memoryGiB: number;
    /** null = no session cap (paid plans, founder 2026-10-20); fair use still applies. */
    sessionMaxSeconds: number | null;
    opening: OpeningSpeed;
    /** Shown in the FAQ only: "Fair use: about N hours a month". */
    fairUseHours: number;
    highlighted: boolean;
    badge: 'Most popular' | null;
    /** Sizes the user may choose; the first is the default. */
    machineChoice: readonly SizeCode[];
    aiCredits: AiCreditGrantV3;
    bullets: readonly string[];
}

/** Router (v3): summary, createCheckout({sku: SellableSkuV3}), previewUpgrade/confirmUpgrade({toSku:'premium_monthly_v3'}),
 *  scheduleDowngrade({toSku:'standard_monthly_v3'}), cancelAtPeriodEnd, history, portal, checkoutStatus.
 *  Input/output shapes otherwise as v2 (PreviewUpgradeOutput etc. with toSku widened). No overage, no selectSize. */
export const ROUTER_V3_PROCEDURES = [
    'summary', 'createCheckout', 'createTopupCheckout', 'previewUpgrade', 'confirmUpgrade', 'scheduleDowngrade', 'cancelAtPeriodEnd',
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

/**
 * `next_open`: the next session opens on `size`; a running session keeps its size
 * (`billing.selectMachine`, unchanged). `switching`: round 3 — the change was
 * applied to the RUNNING computer now via `computer.switchConfiguration`.
 */
export interface SelectMachineOutputV3 {
    size: SizeCode;
    effective: 'next_open' | 'switching';
}

// ── One computer, selectable configuration (round 3, founder 2026-10-28, plan §12 D5) ──

/** How a configuration card renders for this user right now. */
export type ConfigurationAvailabilityV3 = 'current' | 'available' | 'locked' | 'unavailable';

export type SwitchRefusalV3 = 'switch_in_progress' | 'not_entitled' | 'capacity_unavailable' | 'computer_busy' | 'foreign_computer';

/** `computer.switchConfiguration` input; `requestId` makes a duplicate click / second tab idempotent. */
export interface SwitchConfigurationInputV3 {
    computerId: string;
    size: SizeCode;
    requestId: string;
}

/**
 * RUNNING → `switching` (server: confirm → stop → start on `target`, same data disk, generation +1).
 * STOPPED → `next_start` (preference stored; nothing starts until the user opens).
 * The server owns current vs target; a different target while one is in flight → `switch_in_progress`.
 * A failed switch reverts the preference to `current` and reports phase `failed` with a reason.
 */
export type SwitchConfigurationOutputV3 =
    | { ok: true; effective: 'switching' | 'next_start'; current: SizeCode; target: SizeCode; transitionId: string }
    | { ok: false; reason: SwitchRefusalV3 };

export type SwitchPhaseV3 = 'requested' | 'stopping' | 'waking' | 'done' | 'failed';

// ── Opening progress (round 3, plan §8 W0.2(e)) ──────────────────────────────

export type OpeningPathV3 = 'warm' | 'cold' | 'switch' | 'migrate' | 'restart';

/** Server milestones in order; the client appends `url_received` and `first_frame` locally. Never regress. */
export const OPENING_MILESTONES_V3 = ['requested', 'host_claimed', 'files_attached', 'desktop_starting', 'desktop_ready'] as const;
export type OpeningMilestoneV3 = typeof OPENING_MILESTONES_V3[number];

export interface OpeningProgressV3 {
    path: OpeningPathV3;
    /** Server-stamped start of this opening (shared by every tab). */
    startedAt: string;
    /** Expected seconds for `path`, from measured timings (warm) or the cold default; never a client guess. */
    expectedSeconds: number;
    milestones: readonly { key: OpeningMilestoneV3; at: string }[];
}
