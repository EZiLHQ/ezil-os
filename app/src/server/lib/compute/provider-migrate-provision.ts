/** Migration-only boot records. Normal routing continues to read the published placement. */
import { sql } from 'drizzle-orm';
import type { LifecycleDeployment } from './aws-intent';
import { consumeEnrollmentNonce, finishEnrollment, readPlacement, ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED, ENROLLMENT_FAILED,
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
    /** The stale sweep's lifecycle `retire` of a failed boot still running, recorded before its start. */
    retire?: MigrationProvisionRetire;
}
export interface MigrationProvisionRetire {
    jobId: string;
    digest: string;
    requestedAt: string;
}
const FAILED_MIGRATION_STATES: readonly string[] = ['failed_reopened', 'failed_needs_operator'];
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
/**
 * The lifecycle authority's view. After a failed migration reopened Cloudflare, the published
 * placement is the source again, so the failed boot's recorded `retire` job is authorised only
 * through its own unreleased intent, presented as an in-flight RETIRING record of that job.
 */
export async function readLifecycleAuthorityPlacement(db: PlacementExecutor, computerId: string, jobId?: string): Promise<ResolvedPlacement> {
    const resolved = await readEnrollmentPlacement(db, computerId);
    if (resolved.provider === 'aws-ec2' || !jobId) return resolved;
    const m = await createProviderMigrationStore(db).readFailedProvisionRetire(computerId, jobId);
    const intent = m && FAILED_MIGRATION_STATES.includes(m.state) && m.computerId === computerId.toLowerCase() ? provisionFor(m) : null;
    const retire = intent?.released === true ? undefined : intent?.retire;
    if (!intent || !retire || retire.jobId !== jobId) return resolved;
    return { provider: 'aws-ec2', store: 'ebs',
        record: { ...intent.placement, state: 'RETIRING', lifecycleJobId: retire.jobId, lifecycleDigest: retire.digest } };
}

async function updateEnrollment(db: PlacementDb, computerId: string, update: (p: Placement) => Placement | null): Promise<TransitionResult | null> {
    return db.transaction(async tx => {
        // Row lock prevents an enrollment write from racing a state transition or publication.
        await tx.execute(sql`SELECT id FROM public.ezil_compute_migrations WHERE computer_id = ${computerId}::uuid
            AND state IN ('exported', 'provisioning') FOR UPDATE`);
        const store = createProviderMigrationStore(tx), m = await store.readActiveByComputer(computerId);
        const intent = m && !pendingRecovery(m) && ['exported', 'provisioning'].includes(m.state) ? provisionFor(m) : null;
        if (!m || !intent) return null;
        const p = update(intent.placement);
        if (!p) return { ok: false, reason: 'cas_conflict' };
        try { await store.saveProvision(m, { ...intent, placement: p }); }
        catch (error) { if (error instanceof MigrationConflictError) return { ok: false, reason: 'cas_conflict' }; throw error; }
        return { ok: true, placement: p };
    });
}
export async function consumeMigrationEnrollment(db: PlacementDb, input: Parameters<typeof consumeEnrollmentNonce>[1]): Promise<TransitionResult> {
    // The published AWS path retains its original SQL guards.
    if ((await readPlacement(db, input.computerId)).provider === 'aws-ec2') return consumeEnrollmentNonce(db, input);
    return await updateEnrollment(db, input.computerId, p => {
        if (p.state !== 'PROVISIONING' || p.generation !== input.expected.generation || p.leaseEpoch !== input.expected.leaseEpoch
            || p.enrollNonceHash !== input.nonceHash || !p.enrollExpiresAt || p.enrollExpiresAt.getTime() <= Date.now()
            || (p.instanceId !== null && p.instanceId !== input.fields.instanceId)) return null;
        return { ...p, ...input.fields, enrollNonceHash: null, enrollConsumedHash: input.nonceHash, lastError: ENROLLMENT_PENDING };
    }) ?? { ok: false, reason: 'cas_conflict' };
}
export async function finishMigrationEnrollment(db: PlacementDb, input: Parameters<typeof finishEnrollment>[1]): Promise<TransitionResult> {
    if ((await readPlacement(db, input.computerId)).provider === 'aws-ec2') return finishEnrollment(db, input);
    return await updateEnrollment(db, input.computerId, p => {
        if (p.state !== 'PROVISIONING' || p.generation !== input.expected.generation || p.leaseEpoch !== input.expected.leaseEpoch
            || p.instanceId !== input.expected.instanceId || p.enrollNonceHash !== null || !p.enrollConsumedHash
            || p.lastError !== ENROLLMENT_PENDING) return null;
        return { ...p, state: input.success ? p.state : 'UNCONFIRMED', lastError: input.success ? ENROLLMENT_SUCCEEDED : ENROLLMENT_FAILED,
            ...(input.success ? {} : { enrollConsumedHash: null, enrollExpiresAt: null }) };
    }) ?? { ok: false, reason: 'cas_conflict' };
}
