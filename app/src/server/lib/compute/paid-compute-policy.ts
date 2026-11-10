/**
 * Paid compute policy v1 (founder decision e713d157, 4 Nov 2026; request paid-compute-staging-e713d157-20261104-v1).
 *
 * Verified active Standard and Premium, the Standard trial and the existing seven-day renewal grace included, have NO
 * monthly computer-hours cutoff: no product fair-use refusal or forced stop, and no per-person monthly operational-hours
 * gate (`user_hours_cap`). Runtime is still recorded (the usage ledger and billing epochs are untouched). Everything
 * else stays: authentication, entitlement validity, ownership, one running computer per user, the fleet-wide hour cap
 * (`global_hours_cap`), regional/fleet capacity, the kill switch and payment standing. Free keeps its allowance.
 *
 * Decided on the server from the billing entitlement only: never an email list or a named account. Unknown, unreadable,
 * inactive, cancelled, unpaid and Free accounts are NOT exempt (fail closed).
 */
import type { EntitlementReader, EntitlementRecord } from './tier';

export const PAID_COMPUTE_POLICY_VERSION = 1 as const;

/** The plans whose computer time is recorded but never capped per person or per month. */
export const UNMETERED_PAID_PLAN_IDS: readonly string[] = Object.freeze(['standard_monthly_v3', 'premium_monthly_v3']);

/**
 * True only for a paid Standard/Premium entitlement read from billing with paid access: 'active' (this period's
 * paid-period receipt, or the existing seven-day renewal grace of a previously paid plan, which has none yet), or a
 * renewal whose grant is still landing (`grantPending`). A payment issue outside the grace is not exempt.
 */
export function paidComputeUnmetered(entitlement: EntitlementRecord | null | undefined): boolean {
    return !!entitlement && entitlement.source === 'billing_v2' && entitlement.paymentIssue !== true
        && (entitlement.status === 'active' || entitlement.grantPending === true)
        && UNMETERED_PAID_PLAN_IDS.includes(entitlement.planId ?? '');
}

/** Whether an owner's running or starting AWS computer is exempt from the per-person monthly hour cap. */
export type UserHoursExemption = (userId: string) => Promise<boolean>;

/**
 * The billing-backed exemption, one read per owner per instance (each fleet pass builds one). Any failure is "not exempt",
 * so the per-person cap keeps applying. The default reader is loaded on use: billing imports this layer.
 */
export function paidUserHoursExemption(reader?: EntitlementReader): UserHoursExemption {
    const answers = new Map<string, Promise<boolean>>();
    return userId => {
        const key = userId.toLowerCase();
        let answer = answers.get(key);
        if (!answer) {
            answer = (async () => {
                try {
                    const source = reader ?? (await import('@/server/billing/v2/compute-access')).billingV2EntitlementReader();
                    return paidComputeUnmetered(await source.read(userId));
                } catch {
                    return false;
                }
            })();
            answers.set(key, answer);
        }
        return answer;
    };
}
