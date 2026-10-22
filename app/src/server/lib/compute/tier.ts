/**
 * Billing v2 grants an explicit paid AWS size. Legacy sources still require an
 * active entitlement on an operator-listed plan. Missing data never upgrades.
 */

import type { SizeCode } from '../../billing/v2/contract';
import { awsTierForSize, type AwsTier, type Env } from './aws-config';

export type EntitlementStatus = 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';

/** One user's current paid entitlement, as the subscription source reports it. */
export interface EntitlementRecord {
    status: EntitlementStatus | (string & {});
    planId: string | null;
    source?: 'billing_v2';
    size?: SizeCode;
    provider?: 'cloudflare' | 'aws';
    paymentIssue?: boolean;
}

export interface EntitlementReader {
    /** `null` = no entitlement on record. Must not be defaulted by the reader. */
    read(userId: string): Promise<EntitlementRecord | null>;
}

/** Operator-listed plan ids that buy the `plus` size. Unset/empty → nobody is `plus`. */
export function plusPlanIds(env: Env = process.env): ReadonlySet<string> {
    const raw = env.EZIL_AWS_PLUS_PLAN_IDS ?? '';
    return new Set(raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0));
}

/** Pure decision: the tier one entitlement record buys. */
export function tierForEntitlement(record: EntitlementRecord | null | undefined, plusPlans: ReadonlySet<string>): AwsTier {
    if (!record || typeof record !== 'object') return 'free';
    // Paid and current only. `trialing` is not paid; `past_due` is not current.
    if (record.status !== 'active') return 'free';
    if (record.source === 'billing_v2') {
        if (record.provider !== 'aws' || record.paymentIssue || !record.size
            || typeof record.planId !== 'string' || record.planId.length === 0) return 'free';
        return awsTierForSize(record.size) ?? 'free';
    }
    if (record.source !== undefined) return 'free';
    if (typeof record.planId !== 'string' || !plusPlans.has(record.planId)) return 'free';
    return 'plus';
}

export async function resolveEntitlement(userId: string, reader: EntitlementReader | undefined): Promise<EntitlementRecord | null> {
    if (!reader) return null;
    try {
        return await reader.read(userId) ?? null;
    } catch (err) {
        // Unknown is free: a broken subscription read must never hand out the larger size.
        console.warn('[compute.tier] entitlement read failed; using free', { error: err instanceof Error ? err.message : String(err) });
        return null;
    }
}

export async function resolveTier(userId: string, reader: EntitlementReader | undefined, env: Env = process.env): Promise<AwsTier> {
    return tierForEntitlement(await resolveEntitlement(userId, reader), plusPlanIds(env));
}
