/** Period-isolated compute funding, shared by billing, admission and the signed entitlement source. */
import type { GrantRow } from '../ports';
import type { ResolvedPlanV3 } from './catalog';
import type { ComputeStandingV3 } from './contract';
import { paidAccess } from './standing';

/** Paid receipts and reversals keep the same subscription/period isolation as v2. */
export function fairUseAllowance(plan: ResolvedPlanV3, grants: readonly GrantRow[], options: { grace?: boolean } = {}): number {
    if (plan.sku === 'legacy') throw new TypeError('Legacy allowances use v2 rating');
    if (plan.sku === 'free_v3') return plan.legacyFree ? plan.offer.legacyFairUseSeconds! : plan.offer.fairUseSeconds;
    // Product entitlements v1: an operator grant has no Stripe receipt; the plan's own fair use stands (paid compute
    // policy v1 leaves it unmetered, so it is never a cutoff).
    if (plan.operator) return plan.offer.fairUseSeconds;
    const start = new Date(plan.window.start), end = new Date(plan.window.end);
    const rows = grants.filter(grant => grant.meter === 'compute_std_seconds' && grant.subscriptionId === plan.subscriptionId
        && grant.periodStart !== null && grant.periodEnd !== null && grant.periodStart < end && grant.periodEnd > start);
    // Round 4 D17: an unpaid renewal has no receipt yet. In grace the paid computer stays usable on the plan's
    // fair use; any receipt or reversal (a refund, D19) for the period still wins.
    if (options.grace && rows.length === 0) return plan.offer.fairUseSeconds;
    const amount = rows.reduce((sum, grant) => sum + grant.amount, BigInt(0));
    return Number(amount < BigInt(0) ? BigInt(0) : amount > BigInt(plan.offer.fairUseSeconds) ? BigInt(plan.offer.fairUseSeconds) : amount);
}

/** Round 6 R2-3: how long after a paid period starts a missing compute grant reads as not landed yet, never as used up. */
export const GRANT_PENDING_SECONDS = 10 * 60;

/**
 * Round 6 R2-3: a paid AWS plan with paid access (not its grace, which has an allowance of its own) whose current period
 * has no compute grant row yet, within GRANT_PENDING_SECONDS of the period start (Stripe reports the period before its
 * invoice receipt is processed). A refund or revoke row is a real zero, not a grant still to come. One definition for
 * the start gate (compute-access.ts) and the summary (paid compute policy v1), so neither shows a renewal as used up.
 */
export function renewalGrantPending(plan: ResolvedPlanV3, standing: ComputeStandingV3, grants: readonly GrantRow[], now: Date): boolean {
    if (plan.sku === 'legacy' || plan.sku === 'free_v3' || plan.operator || plan.offer.provider !== 'aws' || !paidAccess(standing) || standing === 'grace') return false;
    const start = Date.parse(plan.window.start);
    return !grants.some(grant => grant.meter === 'compute_std_seconds' && grant.subscriptionId === plan.subscriptionId)
        && now.getTime() >= start && now.getTime() - start < GRANT_PENDING_SECONDS * 1000;
}
