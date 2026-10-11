/**
 * Billing wire types — the frozen contract between the server, the Settings
 * → Billing tab and the public pricing page. See `docs/billing/CONTRACT.md`.
 *
 * The shell's tRPC client does not decode superjson (`shell/ezil/ui/Settings/trpc.js`),
 * so every money and byte amount travels as an integer STRING and every
 * instant as an ISO-8601 UTC string. Seconds fit comfortably in a JS number
 * and stay numbers.
 */

/** A meter's state, as the Billing tab colours it. */
export type MeterState = 'ok' | 'low' | 'exhausted' | 'over_cap' | 'unavailable';

/** `free` has no Stripe subscription; the rest mirror one that grants Pro. */
export type PlanStatus = 'free' | 'active' | 'cancels' | 'past_due';

export type PlanId = 'free' | 'pro';

export interface BillingPlanSummary {
    id: PlanId;
    status: PlanStatus;
    /** The window the workspace-time allowance is counted in. */
    periodStart: string;
    periodEnd: string;
    /** Next renewal for an active Pro subscription; null otherwise. */
    renewsAt: string | null;
    /** When `cancel_at_period_end` is set: the instant Pro ends. */
    cancelsAt: string | null;
}

export interface WorkspaceMeter {
    usedSeconds: number;
    allowanceSeconds: number;
    remainingSeconds: number;
    resetsAt: string;
    state: MeterState;
}

export interface StorageMeter {
    usedBytes: string;
    capBytes: string;
    state: MeterState;
    /** Newest sample the total was built from; null when none exists yet. */
    measuredAt: string | null;
}

export interface AiMeter {
    /**
     * `unavailable` until an OS AI client and the Gateway's USD ledger are live
     * (gate G4). Balances are then read from the Gateway, never from here.
     */
    state: MeterState;
    trialMicro: string;
    includedMicro: string;
    purchasedMicro: string;
    includedExpiresAt: string | null;
}

export interface CatalogPro {
    sku: string;
    unitAmountCents: number;
    currency: 'usd';
    interval: 'month';
}

export interface CatalogPack {
    sku: string;
    creditCents: number;
    serviceFeeCents: number;
    totalCents: number;
}

export interface BillingSummaryEnabled {
    enabled: true;
    version: 1;
    plan: BillingPlanSummary;
    meters: {
        workspace: WorkspaceMeter;
        storage: StorageMeter;
        ai: AiMeter;
    };
    /** Which buttons the tab may show. Each is false unless its flag and keys are present. */
    actions: {
        checkout: boolean;
        portal: boolean;
        topup: boolean;
    };
    catalog: {
        pro: CatalogPro;
        packs: CatalogPack[];
    };
}

export type BillingSummary = BillingSummaryEnabled | { enabled: false };

/** `billing.checkoutStatus` — what the return page polls. It never grants anything. */
export type CheckoutStatus = 'pending' | 'complete' | 'expired' | 'unknown';
