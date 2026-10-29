/**
 * Round 5 D2: a pool release that failed and is being healed (aws-pool-release-recovery.ts).
 *
 * A release that fails (aws-receipts.ts:340-345 writes UNCONFIRMED, `failed:*`, job and digest
 * kept) is reconciled by `reconcilePoolReleaseRecovery` on the next lifecycle-receipt pass: the
 * driver's own status polls (aws-ec2.ts status → reconcileOwn → applyLifecycleReceipt →
 * reconcilePoolReleaseRecovery) or the minute cron. It reserves RECOVERING with a replay
 * intent, replays the release, and settles STOPPED/pool_released. A switch or a Stop waits
 * through that instead of failing on the first UNCONFIRMED look.
 *
 * Pure and dependency-free so progress.ts never pulls in aws-receipts.
 */
import type { Placement } from './placement';
import type { ComputerTransition } from './progress';

/** The lastError prefix of a pool-release recovery context (the replay document and its last error). */
export const POOL_RELEASE_RECOVERY_PREFIX = 'pool_release_recovery:';

export type ReleaseHeal = 'pending' | 'failed' | null;

/** Recovery errors the next pass retries on an UNCONFIRMED row. */
const TRANSIENT_RECOVERY_ERRORS: readonly string[] = ['execution_unavailable', 'describe_unavailable'];

type HealFields = Pick<Placement, 'provider' | 'state' | 'lastError' | 'lifecycleJobId' | 'lifecycleDigest'>;

function recoveryContext(lastError: string): { intent?: unknown; error?: unknown } | null {
    try {
        const parsed: unknown = JSON.parse(lastError.slice(POOL_RELEASE_RECOVERY_PREFIX.length));
        return parsed && typeof parsed === 'object' ? parsed as { intent?: unknown; error?: unknown } : null;
    } catch { return null; }
}

/**
 * The placement-only half: `pending` while a release heal can still settle STOPPED, `failed`
 * once the recovery recorded a non-retryable error, null when the row is not a release heal.
 * - pending: UNCONFIRMED `failed:*` with job and digest (what the recovery accepts);
 *   RECOVERING with a replay intent (`isPoolReleaseRecovering`; its kept errors are retryable);
 *   UNCONFIRMED with the prefix, job and digest, and a transient error.
 * - failed: UNCONFIRMED with the prefix and any other error (one recovery per lifecycle version).
 */
export function releaseHealOf(p: HealFields | null | undefined): ReleaseHeal {
    if (!p || p.provider !== 'aws-ec2' || (p.state !== 'UNCONFIRMED' && p.state !== 'RECOVERING')) return null;
    const error = p.lastError ?? '';
    const job = !!p.lifecycleJobId && !!p.lifecycleDigest;
    if (p.state === 'UNCONFIRMED' && error.startsWith('failed:')) return job ? 'pending' : null;
    if (!error.startsWith(POOL_RELEASE_RECOVERY_PREFIX)) return null;
    const context = recoveryContext(error);
    if (p.state === 'RECOVERING') return context?.intent ? 'pending' : null;
    return job && typeof context?.error === 'string' && TRANSIENT_RECOVERY_ERRORS.includes(context.error) ? 'pending' : 'failed';
}

/**
 * The heal of THIS transition's stop: the transition is still requested/stopping and the
 * placement is on the generation and lease epoch the transition started from (none of the
 * stop, failed-receipt, recovery or settle writes moves either; placement.ts bump {0,0}).
 */
export function releaseHeal(t: Pick<ComputerTransition, 'phase' | 'fromGeneration' | 'fromLeaseEpoch'>, p: Placement | null): ReleaseHeal {
    if (!p || (t.phase !== 'requested' && t.phase !== 'stopping')) return null;
    if (p.leaseEpoch !== t.fromLeaseEpoch || p.generation !== t.fromGeneration) return null;
    return releaseHealOf(p);
}
