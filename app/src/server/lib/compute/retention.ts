/**
 * Purge eligibility, DRY RUN ONLY (docs/AWS-COMPUTERS.md §6, R11).
 *
 * Lists computers whose retained volume may be purged by the separate,
 * operator-run purge action. Performs no write of any kind: it does not even
 * move a placement to PURGE_ELIGIBLE. The pure function never mutates its
 * input; `listPurgeEligible` issues only `placement.ts`'s read-only query.
 *
 * Eligible when, 14 days or more ago, either:
 *   - the placement became RETIRED (its `updated_at`, see `readRetentionCandidates`), or
 *   - the computer was cancelled (`cancelledAt`, injected: C-2 has no
 *     cancellation column) and the placement is not in a running-class state.
 */

import { readRetentionCandidates, RUNNING_CLASS_STATES, type PlacementExecutor, type PlacementState } from './placement';

export const PURGE_AFTER_DAYS = 14;
const DAY_MS = 86_400_000;

export interface RetentionCandidate {
    computerId: string;
    state: PlacementState;
    updatedAt: Date;
}

export interface Cancellation {
    computerId: string;
    cancelledAt: Date;
}

export interface PurgeEligible {
    computerId: string;
    basis: 'retired' | 'cancelled';
    since: Date;
}

export function purgeEligibility(input: {
    placements: readonly RetentionCandidate[];
    cancellations: readonly Cancellation[];
    now: Date;
}): PurgeEligible[] {
    const cutoff = input.now.getTime() - PURGE_AFTER_DAYS * DAY_MS;
    const cancelled = new Map(input.cancellations.map((c) => [c.computerId, c.cancelledAt] as const));
    const out: PurgeEligible[] = [];
    for (const p of input.placements) {
        if (p.state === 'RETIRED' && p.updatedAt.getTime() <= cutoff) {
            out.push({ computerId: p.computerId, basis: 'retired', since: new Date(p.updatedAt.getTime()) });
            continue;
        }
        const at = cancelled.get(p.computerId);
        if (at && at.getTime() <= cutoff && p.state !== 'PURGE_ELIGIBLE' && !RUNNING_CLASS_STATES.includes(p.state)) {
            out.push({ computerId: p.computerId, basis: 'cancelled', since: new Date(at.getTime()) });
        }
    }
    return out;
}

export async function listPurgeEligible(
    db: PlacementExecutor,
    input: { cancellations: readonly Cancellation[]; now: Date },
): Promise<PurgeEligible[]> {
    const placements = await readRetentionCandidates(db);
    return purgeEligibility({ placements, cancellations: input.cancellations, now: input.now });
}
