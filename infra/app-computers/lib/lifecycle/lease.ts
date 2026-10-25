import { z } from 'zod';
import { COUNTER, DIGEST, HASH, SNAP, TIME, UUID, VOL, decodeLeaseJson } from './strict-json.js';
import type { LifecycleIntent } from './intent.js';

export const ENROLL_NONCE_TTL_SECONDS = 600;
export const REBASE_ENROLL_RESERVE_SECONDS = 120;
export const REBASE_CLOCK_SKEW_SECONDS = 30;
export const PreparationReferenceSchema = z.object({
    v: z.literal(1), preparationJobId: UUID, executionArn: z.string().max(300), digest: HASH,
}).strict();
export const RebasePermitSchema = z.object({
    v: z.literal(1), preparationJobId: UUID, launchJobId: UUID, computerId: UUID, fsUuid: UUID,
    generation: COUNTER, leaseEpoch: COUNTER, fenceToken: UUID, issuedAt: TIME, expiresAt: TIME,
}).strict();
export const EbsRestoreSchema = z.object({
    v: z.literal(1), preparationJobId: UUID, recoveryJobId: UUID, launchJobId: UUID,
    snapshotId: SNAP, originalVolumeId: VOL, volumeId: VOL, computerId: UUID, fsUuid: UUID,
    fromDigest: DIGEST, sourceGeneration: COUNTER, sourceLeaseEpoch: COUNTER,
    generation: COUNTER, leaseEpoch: COUNTER, fenceToken: UUID,
    issuedAt: TIME, expiresAt: TIME, maintenance: z.literal(true),
}).strict();
const EnrollUrl = z.string().max(512).regex(/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/api\/compute\/aws\/enroll$/);
const RestoreSchema = z.object({ kind: z.literal('cf-snapshot'), migrationId: UUID, generation: UUID,
    system: z.boolean(), fetchBase: z.string(), identityToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export const LeaseSchema = z.object({
    v: z.literal(1), computerId: UUID, volumeId: VOL.optional(), fsUuid: UUID, generation: COUNTER,
    leaseEpoch: COUNTER, nonce: z.string().regex(/^[A-Za-z0-9_-]{32,128}$/), provision: z.boolean(), enrollUrl: EnrollUrl,
    restore: RestoreSchema.optional(),
    rebase: z.object({ snapshotId: SNAP, volumeId: VOL, fromDigest: DIGEST, toDigest: DIGEST }).strict().optional(),
    rebasePermit: RebasePermitSchema.optional(), ebsRestore: EbsRestoreSchema.optional(),
}).strict();
export type Lease = z.infer<typeof LeaseSchema>;
export function parseLease(userData: string): Lease { return LeaseSchema.parse(decodeLeaseJson(userData)); }

/** Structural validity is independent of wall time: historical failed jobs
 * and completed executions remain parseable after their nonce expires. */
export function validateIntentLease(i: LifecycleIntent): void {
    if (i.userData === null) {
        if (i.rebasePreparation) throw new Error('permit_invalid');
        return;
    }
    const l = parseLease(i.userData), p = l.rebasePermit ?? l.ebsRestore, ref = i.rebasePreparation;
    const bad = (): never => { throw new Error('permit_invalid'); };
    if (l.computerId !== i.computerId || l.generation !== i.targetGeneration || l.leaseEpoch !== i.leaseEpoch
        || l.provision !== (i.operation === 'provision') || l.volumeId !== (i.dataVolumeId ?? undefined)) return bad();
    if ((l.rebase !== undefined) !== (l.rebasePermit !== undefined)
        || (p !== undefined) !== (ref !== undefined)) return bad();
    if (l.restore) {
        const url = new URL(l.restore.fetchBase);
        if (!l.provision || p || !['http:', 'https:'].includes(url.protocol) || url.username || url.password
            || url.search || url.hash || url.pathname !== `/api/compute/restore/${i.computerId}`) return bad();
    }
    if (!p || !ref) return;
    const d = i.deployment;
    if (i.operation !== 'replace' || l.provision || l.restore || !d.lowerImageDigest || !d.preparationStateMachineVersionArn
        || p.preparationJobId !== ref.preparationJobId || p.preparationJobId === p.launchJobId
        || p.launchJobId !== i.jobId || p.computerId !== i.computerId || p.fsUuid !== l.fsUuid
        || p.generation !== i.targetGeneration || p.leaseEpoch !== i.leaseEpoch || p.fenceToken !== i.fenceToken
        || Date.parse(p.expiresAt) - Date.parse(p.issuedAt) !== ENROLL_NONCE_TTL_SECONDS * 1000
        || ref.executionArn !== d.preparationStateMachineVersionArn.replace(/:[1-9][0-9]*$/, '').replace(':stateMachine:', ':execution:') + `:computer-${ref.preparationJobId}`) return bad();
    if (l.rebase && (l.ebsRestore || l.rebase.volumeId !== l.volumeId || l.rebase.fromDigest === l.rebase.toDigest
        || l.rebase.fromDigest !== d.previousLowerImageDigest || l.rebase.toDigest !== d.lowerImageDigest)) return bad();
    const e = l.ebsRestore;
    if (e && (l.rebase || l.rebasePermit || e.volumeId !== l.volumeId || e.originalVolumeId === e.volumeId
        || e.fromDigest !== d.lowerImageDigest || e.sourceGeneration !== i.previousGeneration
        || e.generation <= e.sourceGeneration || e.leaseEpoch <= e.sourceLeaseEpoch
        || new Set([e.preparationJobId, e.recoveryJobId, e.launchJobId]).size !== 3)) return bad();
}

export function assertPermitTime(lease: Lease, now: number): void {
    const p = lease.rebasePermit ?? lease.ebsRestore;
    if (!p) return;
    if (!Number.isFinite(now) || Date.parse(p.issuedAt) > now + REBASE_CLOCK_SKEW_SECONDS * 1000) throw new Error('permit_invalid');
    const remaining = Date.parse(p.expiresAt) - now;
    if (remaining <= 0) throw new Error('permit_expired');
    if (remaining <= REBASE_ENROLL_RESERVE_SECONDS * 1000) throw new Error('enrollment_time_insufficient');
}
