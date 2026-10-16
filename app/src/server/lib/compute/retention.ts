/**
 * Purge eligibility, DRY RUN ONLY (docs/AWS-COMPUTERS.md §6, R11).
 *
 * Retained data is on hold until an explicit-deletion retention policy exists.
 * Performs no write of any kind: it does not even
 * move a placement to PURGE_ELIGIBLE. The pure function never mutates its
 * input; `listPurgeEligible` issues only `placement.ts`'s read-only query.
 *
 * Inactivity, cancellation and RETIRED placement state are NOT proof that the
 * user deleted the computer. They must never make an undeleted computer's data
 * eligible. There is no durable deletion receipt or approved post-deletion
 * policy here yet, so even the dry run returns no purge candidates. A future
 * policy must verify explicit deletion; do not reinstate an age-only rule.
 */

import { readRetentionCandidates, type PlacementExecutor, type PlacementState } from './placement';

export const PURGE_POLICY_STATUS = 'held_pending_explicit_deletion_policy';

export interface RetentionCandidate {
    computerId: string;
    state: PlacementState;
    updatedAt: Date;
}

export interface Cancellation {
    computerId: string;
    cancelledAt: Date;
}

/** No candidate can be authorized by the current policy. */
export type PurgeEligible = never;

export function purgeEligibility(input: {
    placements: readonly RetentionCandidate[];
    cancellations: readonly Cancellation[];
    now: Date;
}): PurgeEligible[] {
    // Keep the dry-run call shape for existing operators, without interpreting
    // legacy cancellation records as deletion authorization.
    void input;
    return [];
}

export async function listPurgeEligible(
    db: PlacementExecutor,
    input: { cancellations: readonly Cancellation[]; now: Date },
): Promise<PurgeEligible[]> {
    const placements = await readRetentionCandidates(db);
    return purgeEligibility({ placements, cancellations: input.cancellations, now: input.now });
}
