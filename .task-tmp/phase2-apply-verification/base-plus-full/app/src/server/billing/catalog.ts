import type { CatalogPack, CatalogPro } from './types';

/**
 * Billing catalog, version 1 — the pilot offer recorded in
 * `docs/billing/CONTRACT.md` §2. Prices and allowances come ONLY from here;
 * a client-supplied amount is never read.
 *
 * These are pilot terms. Changing one is a new catalog version, never an
 * in-place edit of a SKU that customers already bought.
 */
export const CATALOG_VERSION = 1;

/**
 * Managed Payments requires an eligible code on every inline product, including
 * pack service fees: Software as a service (SaaS) – personal use. A dashboard
 * Pro Price needs this code on its Product instead (contract §7).
 */
export const MANAGED_PAYMENTS_TAX_CODE = 'txcd_10103000';

const HOUR = 3600;
const GB = BigInt(1_000_000_000);

export const FREE_PLAN = {
    sku: 'free_v1',
    workspaceSeconds: 8 * HOUR,
    storageBytes: BigInt(2) * GB,
    /** One-time AI trial per verified identity, in USD micro-units (provider cost). */
    aiTrialMicro: BigInt(500_000),
} as const;

export const PRO_PLAN = {
    sku: 'pro_monthly_v1',
    unitAmountCents: 2000,
    currency: 'usd',
    interval: 'month',
    workspaceSeconds: 20 * HOUR,
    /**
     * 20 GB is the decided Pro cap, but it may only be OFFERED once the
     * persistence engine supports it (gate G-STOR). Until then
     * `storageCapBytes()` keeps Pro at the Free cap.
     */
    storageBytes: BigInt(20) * GB,
    aiIncludedMicro: BigInt(3_000_000),
} as const;

/**
 * Stripe's US card pricing used to size the service fee, so a pack sold at
 * face value still covers processing: 2.9% + 30¢, +1.5% international cards,
 * +0.5% Stripe Tax. The fee is a flat service fee per pack, charged the same
 * whatever the payment method (contract §2.3).
 */
const FEE_FIXED_CENTS = 30;
const FEE_RATE = 0.029 + 0.015 + 0.005;

/** Smallest whole-cent fee such that (credit + fee) net of fees ≥ credit. */
export function serviceFeeCents(creditCents: number): number {
    const total = Math.ceil((creditCents + FEE_FIXED_CENTS) / (1 - FEE_RATE));
    return total - creditCents;
}

function pack(sku: string, creditCents: number): CatalogPack {
    const fee = serviceFeeCents(creditCents);
    return { sku, aiCredits: null, creditCents, serviceFeeCents: fee, totalCents: creditCents + fee };
}

export const AI_PACKS: readonly CatalogPack[] = Object.freeze([
    pack('ai_pack_10_v1', 1000),
    pack('ai_pack_25_v1', 2500),
]);

export function catalogPro(): CatalogPro {
    return {
        sku: PRO_PLAN.sku,
        unitAmountCents: PRO_PLAN.unitAmountCents,
        currency: PRO_PLAN.currency,
        interval: PRO_PLAN.interval,
    };
}

export function findPack(sku: string): CatalogPack | undefined {
    return AI_PACKS.find(p => p.sku === sku);
}

/** Additional purchase gate: callers must also check their existing checkout flags. */
export function aiPackCheckoutEligible(pack: CatalogPack | null | undefined): pack is CatalogPack & { aiCredits: number } {
    return pack != null && typeof pack.aiCredits === 'number' && Number.isSafeInteger(pack.aiCredits)
        && pack.aiCredits >= 1 && pack.aiCredits <= 1_000_000;
}

/** Pro's storage cap is only raised past Free's once G-STOR is declared met. */
export function storageCapBytes(plan: 'free' | 'pro', largeStorageEnabled: boolean): bigint {
    if (plan === 'pro' && largeStorageEnabled) return PRO_PLAN.storageBytes;
    return FREE_PLAN.storageBytes;
}

export function workspaceAllowanceSeconds(plan: 'free' | 'pro'): number {
    return plan === 'pro' ? PRO_PLAN.workspaceSeconds : FREE_PLAN.workspaceSeconds;
}
