/**
 * Which size an AWS computer gets: `free` (2 vCPU / 4 GiB) or `plus`
 * (2 vCPU / 8 GiB) — founder decision 2026-10-14, `AWS_TIERS` in
 * `./aws-config.ts`.
 *
 * 🔴 `plus` is granted ONLY on positive evidence: an entitlement record that is
 * `active` AND names a plan the operator listed in `EZIL_AWS_PLUS_PLAN_IDS`.
 * Everything else — no reader, no record, a cancelled/expired/past-due record,
 * an unlisted plan, a reader that throws, an empty plan list — is `free`.
 * Missing data never upgrades anyone (the cost cap depends on it).
 *
 * Today there is NO entitlement source in this app's database: the paid
 * subscription and wallet live outside EZiL OS. Until a reader for that source
 * is wired in, `resolveTier` answers `free` for every user. The reader is an
 * interface so that source can be plugged in without touching the providers.
 */

import type { AwsTier, Env } from './aws-config';

export type EntitlementStatus = 'active' | 'trialing' | 'past_due' | 'cancelled' | 'expired';

/** One user's current paid entitlement, as the subscription source reports it. */
export interface EntitlementRecord {
    status: EntitlementStatus | (string & {});
    planId: string | null;
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
    if (typeof record.planId !== 'string' || !plusPlans.has(record.planId)) return 'free';
    return 'plus';
}

export async function resolveTier(userId: string, reader: EntitlementReader | undefined, env: Env = process.env): Promise<AwsTier> {
    if (!reader) return 'free';
    let record: EntitlementRecord | null;
    try {
        record = await reader.read(userId);
    } catch (err) {
        // Unknown is free: a broken subscription read must never hand out the larger size.
        console.warn('[compute.tier] entitlement read failed; using free', { error: err instanceof Error ? err.message : String(err) });
        return 'free';
    }
    return tierForEntitlement(record, plusPlanIds(env));
}
