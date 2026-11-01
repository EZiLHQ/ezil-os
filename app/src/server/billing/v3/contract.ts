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
 * Round 5 pins (W0, 2026-10-29; additive, defaults change no behaviour):
 * - D1 AI enrollment: `ai.enrollment`, `ai.waiting`, `actions.ezilId`.
 * - D3 storage: `PlanOfferV3.storageGiB` / `PublicOfferV3.storageGiB` (plan storage),
 *   `MachineOptionV3.diskGiB` (null until a grow path exists), `computer.disk.growsOnSwitch`.
 * - D2 switch heal: reason codes `SWITCH_HEAL_REASONS_V3` (reasons only; `SwitchPhaseV3` unchanged).
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
    /**
     * Round 5 D3 (additive): the plan's disk for a new computer in GiB (Standard 50, Premium 100);
     * null = no GB figure is shown (Free).
     */
    storageGiB: number | null;
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
        storageGiB: null,
    },
    standard_monthly_v3: {
        sku: 'standard_monthly_v3', tier: 'standard', name: 'Standard', tagline: 'For regular work, every day.',
        priceCents: 2_000, currency: 'usd', interval: 'month', stripeLookupKey: 'ezil_standard_monthly_v3',
        size: 'std-2', provider: 'aws', vcpu: 2, memoryGiB: 8,
        sessionMaxSeconds: null, opening: 'standard', poolPriority: 1,
        fairUseSeconds: 40 * H, legacyFairUseSeconds: null,
        highlighted: false, badge: null, machineChoice: ['std-2'], aiCredits: { amount: 200, per: 'period' },
        bullets: ['Your own 2 vCPU · 8 GB computer on AWS (India)', '50 GB disk for your projects', 'No session time limit'],
        storageGiB: 50,
    },
    premium_monthly_v3: {
        sku: 'premium_monthly_v3', tier: 'premium', name: 'Premium', tagline: 'For bigger projects and long sessions.',
        priceCents: 10_000, currency: 'usd', interval: 'month', stripeLookupKey: 'ezil_premium_monthly_v3',
        size: 'std-2', provider: 'aws', vcpu: 2, memoryGiB: 8,
        sessionMaxSeconds: null, opening: 'standard', poolPriority: 2,
        fairUseSeconds: 500 * H, legacyFairUseSeconds: null,
        highlighted: true, badge: null, machineChoice: ['std-2', 'cmp-4', 'cmp-8'], aiCredits: { amount: 1_000, per: 'period' },
        bullets: ['Choose 2, 4 or 8 vCPU (8, 16 or 32 GB) on AWS (India)', '100 GB disk for your projects', 'No session time limit', 'Bigger sizes count more of your monthly time'],
        storageGiB: 100,
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

/**
 * Round 4 (additive): `files_on_aws` = a Free user's computer is still an AWS computer larger than
 * std-2; the D16 hold opens only std-2, so it stays closed until an upgrade (copy: the files are kept).
 */
export type AdmitRefusalV3 = 'no_plan' | 'fair_use_paused' | 'payment_issue' | 'concurrent_limit' | 'upgrade_pending' | 'files_on_aws';

/**
 * Round 4 D16 (additive): `hold: true` = the C8 hold. A Free user whose computer is still on AWS
 * opens it at std-2 (weight 1) under Free limits: the Free session cap and Free fair use. Never a
 * resize. Carried so the ready-time decision (`openComputeEpochAtReady`) admits the same session.
 */
export type AdmitDecisionV3 =
    | { admit: true; size: SizeCode; maxRunSeconds: number; deadline: string; fromPool: boolean; poolPriority: PoolPriority; hold?: true }
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

/**
 * Round 4 (plan §12 D16-D19; docs/billing/STANDING-CONTRACT.md). Derived on every read, never stored:
 * - `paid`: a current paid period, no unresolved subscription payment issue.
 * - `grace` (D17): the payment didn't go through; the paid computer stays usable until `plan.graceEndsAt`
 *   (first unresolved issue + 7 days, or Stripe's final action, whichever is first).
 * - `plan_ending` (D18): cancel at period end; paid until `plan.planEndsAt`.
 * - `files_on_aws` (D16): on Free while the computer is still the AWS computer. It opens at std-2 under Free
 *   limits; nothing has been moved.
 * - `free`: on Free with the files on Cloudflare.
 */
export type ComputeStandingV3 = 'paid' | 'grace' | 'plan_ending' | 'files_on_aws' | 'free';

/** Reserved for Phase B (the AWS → Cloudflare move, D20/D21). Always null in round 4. */
export interface ComputerMoveV3 {
    direction: 'to_cloudflare' | 'to_aws';
    stage: string;
    bytesDone: string;
    bytesTotal: string | null;
}

/**
 * Phase B (docs/compute/REVERSE-MOVE-CONTRACT.md §6.1): the AWS → Cloudflare move of a held Free user's files, on the
 * additive key `summary.computer.reverseMove` (never `computer.move`, which an old cached shell renders with a
 * [Try again] that opens the computer). Also `computer.move.start`'s answer (§5.9), from the same pure builder.
 */
export interface ComputerReverseMoveV3 {
    direction: 'to_cloudflare';
    /** `REVERSE_MOVE_DTO_STAGE[state]`: saving, copying, checking, flipping, or the terminal state itself. */
    stage: 'saving' | 'copying' | 'checking' | 'flipping' | 'committed' | 'failed_reopened' | 'failed_needs_operator' | string;
    /** Decimal: the import's bytes, '0' before copying. */
    bytesDone: string;
    /** Decimal: the export head's bytes once known. */
    bytesTotal: string | null;
    /** `failed_*` only: the row's code from the closed list (§5.5); null in flight and once committed. */
    reason: string | null;
    /** The export head's skipped count; null before the head. */
    skipped: number | null;
    /** ISO; committed only (the AWS disk is kept until then). */
    retainUntil: string | null;
    /** `failed_*` only, from the §5.5 class: Try again now, only after an AWS session, or never (null otherwise). */
    retry: 'now' | 'after_aws_session' | 'no' | null;
    /** `failed_needs_operator` whose commit may have been sent, or whose code blocks Open (§5.3). */
    openBlocked: boolean;
    /** The D16 hold can open this AWS computer (its size meters as the hold size); null once it is not an AWS computer. */
    holdOpenable: boolean | null;
}

/** `computer.move.start` / `computer.move.retry` refusals (§5.9), in check order. Values, never thrown. */
export type ComputerMoveRefusalV3 = 'move_unsupported' | 'move_in_progress' | 'move_not_held' | 'move_paused' | 'move_busy'
    | 'move_unavailable' | 'move_computer_running' | 'move_computer_unsettled';
export type ComputerMoveStartOutputV3 = { ok: true; move: ComputerReverseMoveV3 } | { ok: false; reason: ComputerMoveRefusalV3 };

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
        /** Round 4 (additive): set only in `grace`, when the paid computer stops being usable without a payment. */
        graceEndsAt?: string | null;
        /** Round 4 (additive): a cancel at period end, the paid period's end ("Premium ends on <date>"). */
        planEndsAt?: string | null;
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
        disk?: {
            provisionedGiB: number | null; usedBytes: string | null;
            /** Round 5 D3 (additive): true once a configuration switch can grow the disk (Phase B infra); false until then. */
            growsOnSwitch: boolean;
        };
        /** Round 4 (additive): what the computer can do under the plan now (see `ComputeStandingV3`). */
        standing?: ComputeStandingV3;
        /** Round 4 (additive): where the files are, from the user's placement (any live aws-ec2 row → 'aws'). */
        filesOn?: 'aws' | 'cloudflare';
        /** Round 4 (additive): `files_on_aws` only, when Free began; null when not recorded (an immediate cancel). */
        heldSince?: string | null;
        /** Round 4 (additive): always null until Phase B moves files (D20/D21). */
        move?: ComputerMoveV3 | null;
        /**
         * Round 6 (additive; R4-02): the user's AWS computer as placed now (its instance type), whatever `size`
         * says: under the D16 hold only a 2 vCPU one opens (it is never resized), so a 4 or 8 vCPU one stays
         * closed. null when there is no AWS computer, its type is unreadable or unlisted, or the user's AWS
         * computers differ.
         */
        awsSize?: { size: SizeCode; vcpu: number; memoryGiB: number } | null;
        /**
         * Phase B (additive, §6.1): the move computer's newest reverse row, while it holds or for 24 h (DB clock) after it
         * ended; a `failed_needs_operator` row always. Absent or null: none, or this database has no reverse moves.
         */
        reverseMove?: ComputerReverseMoveV3 | null;
        /** Phase B (§6.1): the next open of this held computer starts the move (the pre-move card's copy). */
        moveOnOpen?: boolean;
        /** Phase B (§6.1): a Move action can work here; without it no move action is shown. */
        moveAvailable?: boolean;
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
        /**
         * Round 6 (additive; R1-10/R4-05): credits still live from an EARLIER paid period or plan (on Free after
         * a cancel, or a paid period's 3-day tail); they are kept until they expire. `expiresAt` = the earliest
         * expiry. null when none or unknown.
         */
        previous?: { remaining: number; expiresAt: string } | null;
        /** The plan's period amount the next renewal adds when this period has no grant of it yet (e.g. right after an upgrade). */
        pendingFromRenewal?: { credits: number; at: string } | null;
        /**
         * Round 5 D1 (additive). Whether this account can receive AI credits on the Gateway:
         * `enrolled` = it has a Gateway member; `activating` = an EZiL ID is linked and enrollment is
         * pending; `needs_ezil_id` = no EZiL ID on this account (sign in with EZiL ID, same email).
         * Computed by the server, never from the Gateway status. Default `enrolled`.
         */
        enrollment: 'enrolled' | 'activating' | 'needs_ezil_id';
        /** Round 5 D1 (additive): whole credits granted but parked until enrollment; null when none. */
        waiting: { credits: number } | null;
        /**
         * Identity-based credits (additive; always present from this server, so a shell can tell an
         * unavailable balance from an older server that omits the key). See `AiAccountV3`.
         */
        account?: AiAccountV3;
    };
    fairUse: { status: FairUseStatus; resetsAt: string };
    storage: { usedBytes: string; capBytes: string; state: 'ok' | 'low' | 'exhausted' | 'unavailable' };
    actions: {
        checkout: boolean; topup: boolean; upgrade: boolean; downgrade: boolean; cancel: boolean; portal: boolean;
        /** Round 5 D1 (additive): the EZiL ID sign-in link for the `needs_ezil_id` CTA; null otherwise. */
        ezilId: string | null;
    };
    catalog: {
        version: typeof CATALOG_V3_VERSION;
        offers: PublicOfferV3[];
        packs: { sku: string; aiCredits: number; creditCents: number; discountPercent: number; totalCents: number; currency: 'usd' }[];
        customTopup: { minCents: 1000; maxCents: 1000000; centsPerCredit: 10 };
    };
}

export type BillingSummaryV3Result = BillingSummaryV3 | { enabled: false };

/** How a live Gateway grant is labelled. Receipt matching only labels; it never gates `totalMicro`. */
export type AiGrantKindV3 = 'plan' | 'purchased' | 'added' | 'starter' | 'previous';

/**
 * The signed-in identity's AI credits, from the Gateway's `GET /v1/me/balance` only (never `/v1/me/limits`,
 * which are rate and budget ceilings, not a balance). Amounts are decimal microcredit strings
 * (1 credit = 1,000,000), exact: never rounded, never derived from the catalog.
 * - `totalMicro`: Σ `credits_micro` of LIVE grants (unrevoked, unexpired); null when the grant list is
 *   unreadable or does not add up to `available_micro`.
 * - `remainingMicro`: `available_micro` (already net of holds); null = balance unavailable.
 * - `heldMicro`: `held_micro` (credits reserved by requests in progress or being settled).
 * - `usedMicro`: total − remaining − held, only when that identity is proven for this read (no open
 *   request, or every open hold visible and placed while all of today's non-live grants were already
 *   dead); else null. Settled cost on live grants; uncovered `overrun` cost is never part of it.
 * - `planBaselineMicro`: the plan's catalog allowance per period, a label only (never a denominator).
 * - `labelled`: false when receipts could not label the grants (no Plan/Added split is shown then).
 * - `state`: the Gateway's balance state, or 'unavailable' when the balance could not be read.
 * - `userId`: the user this block was read for; a shell drops a block that is not its signed-in user's.
 */
export interface AiAccountV3 {
    userId: string | null;
    state: 'ok' | 'exhausted' | 'paused_operations' | 'paused_reconciliation' | 'unavailable';
    asOf: string;
    totalMicro: string | null;
    remainingMicro: string | null;
    heldMicro: string | null;
    usedMicro: string | null;
    planBaselineMicro: string | null;
    labelled: boolean;
    /** Live grants only, earliest expiry first. */
    grants: { kind: AiGrantKindV3; creditsMicro: string; remainingMicro: string; expiresAt: string }[];
}

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
    /**
     * Shown in the FAQ only: "Fair use: about N hours a month". Round 6 (R1-06): in billing.summary the Free
     * offer carries the hours the viewer's account gets on Free (8 for accounts created before
     * FREE_V2_EFFECTIVE_AT); `publicOffers()` without a viewer keeps the catalog's figure.
     */
    fairUseHours: number;
    highlighted: boolean;
    badge: 'Most popular' | null;
    /** Sizes the user may choose; the first is the default. */
    machineChoice: readonly SizeCode[];
    aiCredits: AiCreditGrantV3;
    bullets: readonly string[];
    /** Round 5 D3 (additive): the plan's disk in GiB (Free null, Standard 50, Premium 100). */
    storageGiB: number | null;
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
    /**
     * Round 5 D3 (additive): the disk this configuration gets, in GiB. null = no per-configuration
     * figure (every configuration keeps the computer's disk until a grow path exists, Phase B).
     */
    diskGiB: number | null;
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

export type SwitchRefusalV3 = 'switch_in_progress' | 'not_entitled' | 'capacity_unavailable' | 'computer_busy' | 'foreign_computer' | 'aws_monthly_cap';

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

/**
 * Round 5 D2 (additive): transition REASON codes for the pool-release heal; no new phase.
 * - `stop_healing`: in flight, phase stays `stopping` while the release heal is pending.
 * - `release_heal_failed` / `release_heal_timeout` (the existing stop bound): phase `failed`,
 *   non-retryable, needs attention. The preference is never reverted during a heal.
 * Other reasons stay free-form codes (`/^[a-z0-9_:]{1,64}$/`, stored transition schema).
 */
export const SWITCH_HEAL_REASONS_V3 = ['stop_healing', 'release_heal_failed', 'release_heal_timeout'] as const;
export type SwitchHealReasonV3 = typeof SWITCH_HEAL_REASONS_V3[number];

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
