/** Migration-only boot records. Normal routing continues to read the published placement. */
import { sql } from 'drizzle-orm';
import type { LifecycleDeployment } from './aws-intent';
import { checkEnrollmentDigest, consumeEnrollmentNonce, finishEnrollment, ImageJobConflictError, readPlacement, validLowerAttestation,
    ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED, ENROLLMENT_FAILED, type LowerAttestation,
    type Placement, type PlacementDb, type PlacementExecutor, type ResolvedPlacement, type TransitionResult } from './placement';
import { createProviderMigrationStore, MigrationConflictError, type ComputeMigration } from './provider-migrate-store';
import { pendingRecovery } from './provider-migrate';

export interface MigrationProvision {
    placement: Placement;
    deployment: LifecycleDeployment;
    source: Placement | null;
    reservedAt: string;
    /** The stale sweep releases failed boots only after execution and instance checks. */
    released?: boolean;
    /**
     * The lower this boot's host attested when its nonce was consumed, at the server's time. Written once, by that
     * consume only, and published with the AWS placement (`flipPlacementToAws`): the published row has no column for it
     * before the flip, and without it the first cold open after the move is refused as `computer_rebase_required`.
     */
    lowerAttestation?: LowerAttestation;
}
function hydrate(p: Placement): Placement {
    return { ...p, updatedAt: new Date(p.updatedAt), enrollExpiresAt: p.enrollExpiresAt && new Date(p.enrollExpiresAt),
        leaseUntil: p.leaseUntil && new Date(p.leaseUntil), presenceAt: p.presenceAt && new Date(p.presenceAt) };
}
export function provisionFor(m: ComputeMigration): MigrationProvision | null {
    const value = m.workspaceHead?._awsProvision as MigrationProvision | undefined;
    return value ? { ...value, placement: hydrate(value.placement), source: value.source && hydrate(value.source) } : null;
}
export async function readEnrollmentPlacement(db: PlacementExecutor, computerId: string): Promise<ResolvedPlacement> {
    const published = await readPlacement(db, computerId);
    if (published.provider === 'aws-ec2') return published;
    const m = await createProviderMigrationStore(db).readActiveByComputer(computerId);
    const intent = m && !pendingRecovery(m) && ['exported', 'provisioning'].includes(m.state) ? provisionFor(m) : null;
    return intent ? { provider: 'aws-ec2', store: 'ebs', record: intent.placement } : published;
}

async function activeIntent(db: PlacementExecutor, computerId: string): Promise<{ m: ComputeMigration; intent: MigrationProvision } | null> {
    const m = await createProviderMigrationStore(db).readActiveByComputer(computerId);
    const intent = m && !pendingRecovery(m) && ['exported', 'provisioning'].includes(m.state) ? provisionFor(m) : null;
    return m && intent ? { m, intent } : null;
}
async function updateEnrollment(db: PlacementDb, computerId: string, update: (intent: MigrationProvision) => MigrationProvision | null): Promise<TransitionResult | null> {
    return db.transaction(async tx => {
        // Row lock prevents an enrollment write from racing a state transition or publication.
        await tx.execute(sql`SELECT id FROM public.ezil_compute_migrations WHERE computer_id = ${computerId}::uuid
            AND state IN ('exported', 'provisioning') FOR UPDATE`);
        const active = await activeIntent(tx, computerId);
        if (!active) return null;
        const next = update(active.intent);
        if (!next) return { ok: false, reason: 'cas_conflict' };
        try { await createProviderMigrationStore(tx).saveProvision(active.m, next); }
        catch (error) { if (error instanceof MigrationConflictError) return { ok: false, reason: 'cas_conflict' }; throw error; }
        return { ok: true, placement: next.placement };
    });
}
export async function consumeMigrationEnrollment(db: PlacementDb, input: Parameters<typeof consumeEnrollmentNonce>[1]): Promise<TransitionResult> {
    // The published AWS path retains its original SQL guards.
    if ((await readPlacement(db, input.computerId)).provider === 'aws-ec2') return consumeEnrollmentNonce(db, input);
    // As that path (`consumeEnrollmentNonce`): an attested lower must be well formed and observed now, or nothing is written.
    let lowerAttestation: LowerAttestation | undefined;
    if (input.lowerImageDigest !== undefined) {
        lowerAttestation = { lowerImageDigest: input.lowerImageDigest, observedAt: input.observedAt && Number.isFinite(input.observedAt.getTime()) ? input.observedAt.toISOString() : '' };
        if (!validLowerAttestation(lowerAttestation)) throw new ImageJobConflictError();
    }
    return await updateEnrollment(db, input.computerId, intent => {
        const p = intent.placement;
        if (p.state !== 'PROVISIONING' || p.generation !== input.expected.generation || p.leaseEpoch !== input.expected.leaseEpoch
            || p.enrollNonceHash !== input.nonceHash || !p.enrollExpiresAt || p.enrollExpiresAt.getTime() <= Date.now()
            || (p.instanceId !== null && p.instanceId !== input.fields.instanceId) || intent.lowerAttestation !== undefined) return null;
        return { ...intent, placement: { ...p, ...input.fields, enrollNonceHash: null, enrollConsumedHash: input.nonceHash, lastError: ENROLLMENT_PENDING },
            ...(lowerAttestation ? { lowerAttestation } : {}) };
    }) ?? { ok: false, reason: 'cas_conflict' };
}
/**
 * `checkEnrollmentDigest` for a pending or replayed migration boot: before the flip its consume is recorded on the
 * migration intent, not on the published (Cloudflare) row, so the published check could never match. The boot must be
 * the consumed one (generation, epoch, nonce proof, instance) and its attestation exactly this digest; a boot that
 * attested nothing never acquires one here (fail closed, as a NULL published lower).
 */
export async function checkMigrationEnrollmentDigest(db: PlacementExecutor, p: Placement, digest: string): Promise<boolean> {
    if ((await readPlacement(db, p.computerId)).provider === 'aws-ec2') return checkEnrollmentDigest(db, p, digest);
    const active = await activeIntent(db, p.computerId);
    const q = active?.intent.placement, attested = active?.intent.lowerAttestation;
    return !!q && !!attested && q.generation === p.generation && q.leaseEpoch === p.leaseEpoch && q.enrollConsumedHash !== null
        && q.enrollConsumedHash === p.enrollConsumedHash && q.instanceId === p.instanceId && attested.lowerImageDigest === digest;
}
export async function finishMigrationEnrollment(db: PlacementDb, input: Parameters<typeof finishEnrollment>[1]): Promise<TransitionResult> {
    if ((await readPlacement(db, input.computerId)).provider === 'aws-ec2') return finishEnrollment(db, input);
    return await updateEnrollment(db, input.computerId, intent => {
        const p = intent.placement;
        if (p.state !== 'PROVISIONING' || p.generation !== input.expected.generation || p.leaseEpoch !== input.expected.leaseEpoch
            || p.instanceId !== input.expected.instanceId || p.enrollNonceHash !== null || !p.enrollConsumedHash
            || p.lastError !== ENROLLMENT_PENDING) return null;
        return { ...intent, placement: { ...p, state: input.success ? p.state : 'UNCONFIRMED', lastError: input.success ? ENROLLMENT_SUCCEEDED : ENROLLMENT_FAILED,
            ...(input.success ? {} : { enrollConsumedHash: null, enrollExpiresAt: null }) } };
    }) ?? { ok: false, reason: 'cas_conflict' };
}
