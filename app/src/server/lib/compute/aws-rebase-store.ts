import { buildImageRecovery, recoveryFor, verifyImageRestore, MaintenanceReportSchema } from './aws-rebase-recovery';
import { decideAdmission } from './admission';
import { readAwsAdmissionConfig, type Env } from './aws-config';
import { createHash } from 'node:crypto';
import { assertImageExecution, launchFor, verifyImageLaunch, type Execution, type ImageLaunchReceipt } from './aws-rebase-evidence';
import type { Ec2EnrollmentView } from './aws-enroll';
import type { Ec2VolumeView } from './aws-clients';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildLifecycleWork, type LifecycleWork } from './aws-intent';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { buildRebasePreparation, RebaseSnapshotReceiptSchema, validateRebaseSnapshotReceipt } from './aws-rebase-preparation';
import { parseRebaseJson, RebaseCounter, RebaseDigest, RebaseHash, RebaseSnapshot, RebaseTime, RebaseUuid, RebaseVolume } from './aws-rebase-json';
import { parseRebaseRelease, parseRebaseSourceRelease, RebaseSourceReleaseSchema, RebaseReleaseSchema } from './aws-rebase-release';
import { ImageJobConflictError, lockImagePlacement, setImageReservation, writeImagePlacement, recordImageUsage, withAdmission, ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED, readImageAdmissionCounters, type ImagePlacement, type ImagePlacementFields, type AdmissionLock, type PlacementDb, type PlacementExecutor } from './placement';

export const IMAGE_JOB_PHASES = ['reserved', 'fencing', 'snapshot_pending', 'snapshot_ready', 'launch_pending', 'verifying', 'failed', 'unconfirmed', 'recovery_pending', 'restore_pending', 'rebind_pending', 'succeeded', 'recovered', 'cancelled'] as const;
export type ImageJobPhase = typeof IMAGE_JOB_PHASES[number];
export const IMAGE_JOB_FAILURE_CODES = ['source_digest_unknown', 'unsupported_predecessor', 'release_mismatch', 'image_job_conflict',
    'authority_revoked', 'source_identity_mismatch', 'writer_not_fenced', 'volume_not_available', 'generation_drift', 'preparation_timeout',
    'preparation_failed', 'snapshot_create_unconfirmed', 'snapshot_pending', 'snapshot_missing', 'snapshot_error', 'snapshot_ambiguous',
    'snapshot_identity_mismatch', 'snapshot_not_fresh', 'launch_failed', 'launch_unconfirmed', 'permit_invalid', 'permit_expired',
    'enrollment_time_insufficient', 'previous_lower_missing', 'rebase_failed', 'rebase_timeout', 'marker_commit_unconfirmed',
    'host_digest_mismatch', 'enrollment_failed', 'desktop_unhealthy', 'restore_failed', 'restore_lineage_mismatch', 'rebind_failed', 'operator_required'] as const;
export const IMAGE_JOB_NEXT: Readonly<Record<ImageJobPhase, readonly ImageJobPhase[]>> = {
    reserved: ['fencing', 'failed', 'unconfirmed'], fencing: ['snapshot_pending', 'failed', 'unconfirmed'],
    snapshot_pending: ['snapshot_ready', 'failed', 'unconfirmed'], snapshot_ready: ['launch_pending', 'cancelled', 'failed', 'unconfirmed'],
    launch_pending: ['verifying', 'recovery_pending', 'failed', 'unconfirmed'], verifying: ['succeeded', 'recovery_pending', 'failed', 'unconfirmed'],
    failed: ['recovery_pending', 'cancelled', 'unconfirmed'],
    unconfirmed: ['fencing', 'snapshot_pending', 'snapshot_ready', 'launch_pending', 'verifying', 'recovery_pending', 'restore_pending', 'rebind_pending', 'recovered', 'failed', 'cancelled'],
    recovery_pending: ['restore_pending', 'failed', 'unconfirmed'], restore_pending: ['rebind_pending', 'failed', 'unconfirmed'],
    rebind_pending: ['recovered', 'failed', 'unconfirmed'], succeeded: [], recovered: [], cancelled: [],
};
export const isTerminalImageJob = (phase: ImageJobPhase) => IMAGE_JOB_NEXT[phase].length === 0;
const instance = z.string().regex(/^i-[0-9a-f]{17}$/);
const execution = z.string().max(300).regex(/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]{1,80}:computer-[0-9a-f-]{36}$/);
export const ImageHostEvidenceSchema = z.object({ v: z.literal(1), computerId: RebaseUuid, instanceId: instance,
    volumeId: RebaseVolume, fsUuid: RebaseUuid, generation: RebaseCounter, leaseEpoch: RebaseCounter,
    lowerImageDigest: RebaseDigest, observedAt: RebaseTime, ebsRestore: MaintenanceReportSchema.optional() }).strict();

const JobSchema = z.object({
    jobId: RebaseUuid,
    computerId: RebaseUuid,
    ownerUserId: RebaseUuid,
    parentJobId: RebaseUuid.nullable(),
    region: z.string().min(1),
    zoneId: z.string().min(1),
    sourceInstanceId: instance,
    sourceVolumeId: RebaseVolume,
    fsUuid: RebaseUuid,
    sourceGeneration: RebaseCounter,
    sourceLeaseEpoch: RebaseCounter,
    sourceFenceToken: RebaseUuid,
    fromDigest: RebaseDigest,
    toDigest: RebaseDigest,
    sourceRelease: RebaseSourceReleaseSchema,
    targetRelease: RebaseReleaseSchema,
    phase: z.enum(IMAGE_JOB_PHASES),
    preparationDocument: z.string().min(1),
    preparationDigest: RebaseHash,
    preparationExecutionArn: execution.nullable(),
    snapshotId: RebaseSnapshot.nullable(),
    snapshotEvidence: RebaseSnapshotReceiptSchema.nullable(),
    launchJobId: RebaseUuid.nullable(),
    launchDocument: z.string().min(1).nullable(),
    launchDigest: RebaseHash.nullable(),
    launchExecutionArn: execution.nullable(),
    targetGeneration: RebaseCounter.nullable(),
    targetLeaseEpoch: RebaseCounter.nullable(),
    targetFenceToken: RebaseUuid.nullable(),
    recoveryJobId: RebaseUuid.nullable(),
    recoveryDocument: z.string().min(1).nullable(),
    recoveryDigest: RebaseHash.nullable(),
    recoveryExecutionArn: execution.nullable(),
    restoredVolumeId: RebaseVolume.nullable(),
    quarantinedVolumeId: RebaseVolume.nullable(),
    rebindJobId: RebaseUuid.nullable(),
    rebindDocument: z.string().min(1).nullable(),
    rebindDigest: RebaseHash.nullable(),
    rebindExecutionArn: execution.nullable(),
    rebindGeneration: RebaseCounter.nullable(),
    rebindLeaseEpoch: RebaseCounter.nullable(),
    rebindFenceToken: RebaseUuid.nullable(),
    hostEvidence: ImageHostEvidenceSchema.nullable(),
    failureCode: z.enum(IMAGE_JOB_FAILURE_CODES).nullable(),
    retentionHold: z.boolean(),
    retainUntil: RebaseTime.nullable(),
    createdAt: RebaseTime,
    updatedAt: RebaseTime,
    reconciledAt: RebaseTime.nullable(),
    completedAt: RebaseTime.nullable(),
}).strict();
export type ImageJob = z.infer<typeof JobSchema>;

const columns = [
    ["jobId", "job_id", "uuid"],
    ["computerId", "computer_id", "uuid"],
    ["ownerUserId", "owner_user_id", "uuid"],
    ["parentJobId", "parent_job_id", "uuid"],
    ["region", "region", "text"],
    ["zoneId", "zone_id", "text"],
    ["sourceInstanceId", "source_instance_id", "text"],
    ["sourceVolumeId", "source_volume_id", "text"],
    ["fsUuid", "fs_uuid", "uuid"],
    ["sourceGeneration", "source_generation", "bigint"],
    ["sourceLeaseEpoch", "source_lease_epoch", "bigint"],
    ["sourceFenceToken", "source_fence_token", "uuid"],
    ["fromDigest", "from_digest", "text"],
    ["toDigest", "to_digest", "text"],
    ["sourceRelease", "source_release", "jsonb"],
    ["targetRelease", "target_release", "jsonb"],
    ["phase", "phase", "text"],
    ["preparationDocument", "preparation_document", "text"],
    ["preparationDigest", "preparation_digest", "text"],
    ["preparationExecutionArn", "preparation_execution_arn", "text"],
    ["snapshotId", "snapshot_id", "text"],
    ["snapshotEvidence", "snapshot_evidence", "jsonb"],
    ["launchJobId", "launch_job_id", "uuid"],
    ["launchDocument", "launch_document", "text"],
    ["launchDigest", "launch_digest", "text"],
    ["launchExecutionArn", "launch_execution_arn", "text"],
    ["targetGeneration", "target_generation", "bigint"],
    ["targetLeaseEpoch", "target_lease_epoch", "bigint"],
    ["targetFenceToken", "target_fence_token", "uuid"],
    ["recoveryJobId", "recovery_job_id", "uuid"],
    ["recoveryDocument", "recovery_document", "text"],
    ["recoveryDigest", "recovery_digest", "text"],
    ["recoveryExecutionArn", "recovery_execution_arn", "text"],
    ["restoredVolumeId", "restored_volume_id", "text"],
    ["quarantinedVolumeId", "quarantined_volume_id", "text"],
    ["rebindJobId", "rebind_job_id", "uuid"],
    ["rebindDocument", "rebind_document", "text"],
    ["rebindDigest", "rebind_digest", "text"],
    ["rebindExecutionArn", "rebind_execution_arn", "text"],
    ["rebindGeneration", "rebind_generation", "bigint"],
    ["rebindLeaseEpoch", "rebind_lease_epoch", "bigint"],
    ["rebindFenceToken", "rebind_fence_token", "uuid"],
    ["hostEvidence", "host_evidence", "jsonb"],
    ["failureCode", "failure_code", "text"],
    ["retentionHold", "retention_hold", "boolean"],
    ["retainUntil", "retain_until", "timestamptz"],
    ["createdAt", "created_at", "timestamptz"],
    ["updatedAt", "updated_at", "timestamptz"],
    ["reconciledAt", "reconciled_at", "timestamptz"],
    ["completedAt", "completed_at", "timestamptz"],
] as const;
const columnNames = sql.raw(columns.map(([, name]) => name).join(', '));
const rowsOf = (r: unknown): Record<string, unknown>[] => {
    const rows = Array.isArray(r) ? r : (r as { rows?: unknown } | null)?.rows;
    if (!Array.isArray(rows)) throw new ImageJobConflictError();
    return rows as Record<string, unknown>[];
};
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const allOrNone = (values: unknown[]) => values.every(v => v === null) || values.every(v => v !== null);

/** Strict on the wire; converts only PostgreSQL's declared bigint/timestamp representations. */
export function parseImageJobRow(row: Record<string, unknown>): ImageJob {
    const out: Record<string, unknown> = {};
    if (Object.keys(row).some(k => !columns.some(([, name]) => name === k))) throw new ImageJobConflictError();
    for (const [key, name, type] of columns) {
        let value = row[name];
        if (type === 'bigint' && typeof value === 'string' && /^[1-9][0-9]*$/.test(value)) value = Number(value);
        if (type === 'timestamptz' && value instanceof Date && Number.isFinite(value.getTime())) value = value.toISOString();
        out[key] = value;
    }
    return validateImageJob(out);
}
export function validateImageJob(raw: unknown): ImageJob {
    const j = JobSchema.parse(raw);
    const p = buildRebasePreparation(parseRebaseJson(j.preparationDocument) as Parameters<typeof buildRebasePreparation>[0]);
    if (p.document !== j.preparationDocument || p.digest !== j.preparationDigest || (j.preparationExecutionArn !== null && j.preparationExecutionArn !== p.executionArn)
        || (['jobId', 'computerId', 'sourceInstanceId', 'sourceVolumeId', 'fsUuid', 'sourceGeneration', 'sourceLeaseEpoch', 'sourceFenceToken', 'fromDigest', 'toDigest'] as const).some(k => j[k] !== p.intent[k])
        || j.region !== p.intent.deployment.region || j.zoneId !== p.intent.deployment.zoneId) throw new ImageJobConflictError();
    const repository = j.sourceRelease.lowerImageRef.split('@')[0]!;
    parseRebaseSourceRelease(j.sourceRelease, p.intent.sourceDeployment, repository);
    parseRebaseRelease(j.targetRelease, p.intent.deployment, repository);
    if (Date.parse(j.sourceRelease.createdAt) > Date.parse(j.createdAt) || Date.parse(j.targetRelease.createdAt) > Date.parse(j.createdAt)) throw new ImageJobConflictError();
    if (Date.parse(j.updatedAt) < Date.parse(j.createdAt) || j.createdAt !== p.intent.createdAt) throw new ImageJobConflictError();
    if (!allOrNone([j.snapshotId, j.snapshotEvidence])) throw new ImageJobConflictError();
    if (j.snapshotEvidence) {
        validateRebaseSnapshotReceipt(j.snapshotEvidence, p, new Date(j.updatedAt));
        if (j.snapshotId !== j.snapshotEvidence.snapshotId || !j.preparationExecutionArn) throw new ImageJobConflictError();
    }
    const needsSnapshot = ['snapshot_ready', 'launch_pending', 'verifying', 'recovery_pending', 'restore_pending', 'rebind_pending', 'recovered', 'succeeded'];
    if (needsSnapshot.includes(j.phase) && !j.snapshotEvidence) throw new ImageJobConflictError();
    for (const mode of ['launch', 'rebind'] as const) {
        const doc = mode === 'launch' ? j.launchDocument : j.rebindDocument;
        const id = mode === 'launch' ? j.launchJobId : j.rebindJobId;
        const digest = mode === 'launch' ? j.launchDigest : j.rebindDigest;
        const arn = mode === 'launch' ? j.launchExecutionArn : j.rebindExecutionArn;
        const generation = mode === 'launch' ? j.targetGeneration : j.rebindGeneration;
        const epoch = mode === 'launch' ? j.targetLeaseEpoch : j.rebindLeaseEpoch;
        const fence = mode === 'launch' ? j.targetFenceToken : j.rebindFenceToken;
        if (!allOrNone([doc, id, digest, arn, generation, epoch, fence])) throw new ImageJobConflictError();
        if (doc) {
            const w = buildLifecycleWork(parseRebaseJson(doc) as Parameters<typeof buildLifecycleWork>[0]);
            const i = w.intent;
            const lease = parseEnrollmentUserData(i.userData!);
            if (mode === 'launch' && (i.operation !== 'replace' || i.previousGeneration !== j.sourceGeneration
                || i.previousInstanceId !== j.sourceInstanceId || i.previousFenceToken !== j.sourceFenceToken
                || i.dataVolumeId !== j.sourceVolumeId || !equal(i.deployment, p.intent.deployment)
                || lease.fsUuid !== j.fsUuid || lease.rebase?.snapshotId !== j.snapshotId || lease.rebase?.fromDigest !== j.fromDigest
                || lease.rebase?.toDigest !== j.toDigest || !lease.rebasePermit
                || Date.parse(lease.rebasePermit.issuedAt) < Date.parse(j.snapshotEvidence!.snapshotCompletedAt)
                || lease.leaseEpoch <= j.sourceLeaseEpoch)) throw new ImageJobConflictError();
            if (mode === 'rebind' && (i.operation !== 'replace' || i.dataVolumeId !== j.restoredVolumeId || !lease.ebsRestore
                || !j.recoveryDocument || !equal(i.deployment, recoveryFor(j).intent.deployment)
                || i.previousInstanceId !== j.sourceInstanceId || i.previousGeneration !== j.sourceGeneration || i.previousFenceToken !== j.sourceFenceToken
                || lease.ebsRestore.recoveryJobId !== j.recoveryJobId || lease.ebsRestore.originalVolumeId !== j.sourceVolumeId
                || lease.ebsRestore.snapshotId !== j.snapshotId || lease.ebsRestore.fromDigest !== j.fromDigest
                || lease.ebsRestore.sourceGeneration !== j.sourceGeneration || lease.ebsRestore.sourceLeaseEpoch !== j.sourceLeaseEpoch
                || lease.generation <= j.targetGeneration! || lease.leaseEpoch <= j.targetLeaseEpoch! || i.fenceToken === j.targetFenceToken
                || i.jobId === j.launchJobId || i.jobId === j.recoveryJobId)) throw new ImageJobConflictError();
            if (JSON.parse(w.input).document !== doc || w.digest !== digest || i.jobId !== id || i.computerId !== j.computerId
                || i.targetGeneration !== generation || i.leaseEpoch !== epoch || i.fenceToken !== fence || !j.snapshotEvidence
                || i.rebasePreparation?.preparationJobId !== j.jobId || i.rebasePreparation.digest !== j.preparationDigest
                || i.rebasePreparation.executionArn !== j.preparationExecutionArn
                || arn !== w.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${w.name}`)) throw new ImageJobConflictError();
        }
    }
    if (!allOrNone([j.recoveryJobId, j.recoveryDocument, j.recoveryDigest, j.recoveryExecutionArn])) throw new ImageJobConflictError();
    if (j.recoveryDocument) {
        const w = recoveryFor(j), i = w.intent;
        if (w.document !== j.recoveryDocument || w.digest !== j.recoveryDigest || w.executionArn !== j.recoveryExecutionArn
            || i.jobId !== j.recoveryJobId || i.imageJobId !== j.jobId || i.computerId !== j.computerId
            || i.sourceExecutionArn !== j.launchExecutionArn || i.originalVolumeId !== j.sourceVolumeId || i.fsUuid !== j.fsUuid
            || i.sourceGeneration !== j.sourceGeneration || i.sourceLeaseEpoch !== j.sourceLeaseEpoch || i.sourceFenceToken !== j.sourceFenceToken
            || i.jobId === j.launchJobId || i.fromDigest !== j.fromDigest || i.snapshotId !== j.snapshotId || i.rebasePreparation.preparationJobId !== j.jobId
            || i.rebasePreparation.executionArn !== j.preparationExecutionArn || i.rebasePreparation.digest !== j.preparationDigest
            || !equal(i.deployment, p.intent.sourceDeployment) || Date.parse(i.createdAt) < Date.parse(j.createdAt)) throw new ImageJobConflictError();
    }
    if (['recovery_pending', 'restore_pending', 'rebind_pending', 'recovered'].includes(j.phase) && !j.recoveryDocument) throw new ImageJobConflictError();
    if (!allOrNone([j.restoredVolumeId, j.quarantinedVolumeId]) || (j.restoredVolumeId !== null
        && (j.restoredVolumeId === j.sourceVolumeId || j.quarantinedVolumeId !== j.sourceVolumeId || !j.recoveryDocument))) throw new ImageJobConflictError();
    if (['rebind_pending', 'recovered'].includes(j.phase) && (!j.rebindDocument || !j.restoredVolumeId)) throw new ImageJobConflictError();
    if (['launch_pending', 'verifying', 'succeeded'].includes(j.phase) && !j.launchDocument) throw new ImageJobConflictError();
    if (j.hostEvidence && (j.hostEvidence.computerId !== j.computerId || j.hostEvidence.fsUuid !== j.fsUuid
        || (j.hostEvidence.ebsRestore ? j.hostEvidence.volumeId !== j.restoredVolumeId || j.hostEvidence.generation !== j.rebindGeneration
            || j.hostEvidence.leaseEpoch !== j.rebindLeaseEpoch || j.hostEvidence.lowerImageDigest !== j.fromDigest
            || j.hostEvidence.ebsRestore.recoveryJobId !== j.recoveryJobId || j.hostEvidence.ebsRestore.volumeId !== j.restoredVolumeId
            || j.hostEvidence.ebsRestore.originalVolumeId !== j.sourceVolumeId || j.hostEvidence.ebsRestore.snapshotId !== j.snapshotId
            || j.hostEvidence.ebsRestore.fsUuid !== j.fsUuid : j.hostEvidence.volumeId !== j.sourceVolumeId || j.hostEvidence.generation !== j.targetGeneration
                || j.hostEvidence.leaseEpoch !== j.targetLeaseEpoch || j.hostEvidence.lowerImageDigest !== j.toDigest))) throw new ImageJobConflictError();
    if (j.hostEvidence && (Date.parse(j.hostEvidence.observedAt) < Date.parse(j.createdAt) || Date.parse(j.hostEvidence.observedAt) > Date.parse(j.updatedAt))) throw new ImageJobConflictError();
    if (j.completedAt && (Date.parse(j.completedAt) < Date.parse(j.createdAt) || Date.parse(j.completedAt) > Date.parse(j.updatedAt))) throw new ImageJobConflictError();
    if (j.phase === 'succeeded' && (!j.hostEvidence || j.hostEvidence.ebsRestore || !j.completedAt || !j.retainUntil
        || Date.parse(j.retainUntil) < Date.parse(j.completedAt) + 604800000)) throw new ImageJobConflictError();
    if (j.phase === 'recovered' && (!j.hostEvidence?.ebsRestore || !j.completedAt || !j.retentionHold)) throw new ImageJobConflictError();
    if (!isTerminalImageJob(j.phase) && (!j.retentionHold || j.completedAt !== null)) throw new ImageJobConflictError();
    if (['failed', 'unconfirmed'].includes(j.phase) && !j.failureCode) throw new ImageJobConflictError();
    return j;
}

/** No nonce is issued by reservation or preparation. */
export function newReservedImageJob(input: {
    preparation: ReturnType<typeof buildRebasePreparation>; ownerUserId: string;
    sourceRelease: z.infer<typeof RebaseSourceReleaseSchema>; targetRelease: z.infer<typeof RebaseReleaseSchema>; parentJobId?: string;
}): ImageJob {
    const p = input.preparation;
    if (p.intent.jobId.split('-')[2]?.[0] !== '4') throw new ImageJobConflictError();
    return validateImageJob({ ...Object.fromEntries(columns.map(([key]) => [key, null])),
        jobId: p.intent.jobId, computerId: p.intent.computerId, ownerUserId: input.ownerUserId, parentJobId: input.parentJobId ?? null,
        region: p.intent.deployment.region, zoneId: p.intent.deployment.zoneId,
        sourceInstanceId: p.intent.sourceInstanceId, sourceVolumeId: p.intent.sourceVolumeId, fsUuid: p.intent.fsUuid,
        sourceGeneration: p.intent.sourceGeneration, sourceLeaseEpoch: p.intent.sourceLeaseEpoch, sourceFenceToken: p.intent.sourceFenceToken,
        fromDigest: p.intent.fromDigest, toDigest: p.intent.toDigest, sourceRelease: input.sourceRelease, targetRelease: input.targetRelease,
        phase: 'reserved', preparationDocument: p.document, preparationDigest: p.digest, preparationExecutionArn: p.executionArn,
        retentionHold: true, createdAt: p.intent.createdAt, updatedAt: p.intent.createdAt });
}

const immutable = ['jobId', 'computerId', 'ownerUserId', 'parentJobId', 'region', 'zoneId', 'sourceInstanceId', 'sourceVolumeId', 'fsUuid',
    'sourceGeneration', 'sourceLeaseEpoch', 'sourceFenceToken', 'fromDigest', 'toDigest', 'sourceRelease', 'targetRelease', 'preparationDocument', 'preparationDigest', 'createdAt'] as const;
const writeOnce = ['preparationExecutionArn', 'snapshotId', 'snapshotEvidence', 'launchJobId', 'launchDocument', 'launchDigest', 'launchExecutionArn',
    'targetGeneration', 'targetLeaseEpoch', 'targetFenceToken', 'recoveryJobId', 'recoveryDocument', 'recoveryDigest', 'recoveryExecutionArn',
    'restoredVolumeId', 'quarantinedVolumeId', 'rebindJobId', 'rebindDocument', 'rebindDigest', 'rebindExecutionArn', 'rebindGeneration', 'rebindLeaseEpoch', 'rebindFenceToken', 'hostEvidence'] as const;
const valueSql = (j: ImageJob, key: keyof ImageJob, type: string) => {
    const value = j[key];
    return sql`${type === 'jsonb' && value !== null ? JSON.stringify(value) : value}::${sql.raw(type)}`;
};

export function createImageJobStore(db: PlacementDb, env: Env = process.env) {
    const read = async (tx: PlacementExecutor, jobId: string): Promise<ImageJob | null> => {
        const rows = rowsOf(await tx.execute(sql`SELECT ${columnNames} FROM public.ezil_computer_image_jobs WHERE job_id = ${RebaseUuid.parse(jobId)}::uuid LIMIT 2`));
        if (rows.length > 1) throw new ImageJobConflictError();
        return rows.length ? parseImageJobRow(rows[0]!) : null;
    };
    const active = async (tx: PlacementExecutor, computerId: string) => {
        const rows = rowsOf(await tx.execute(sql`SELECT ${columnNames} FROM public.ezil_computer_image_jobs
            WHERE computer_id = ${computerId}::uuid AND phase NOT IN ('succeeded', 'recovered', 'cancelled') LIMIT 2 FOR UPDATE`));
        if (rows.length > 1) throw new ImageJobConflictError();
        return rows.length ? parseImageJobRow(rows[0]!) : null;
    };
    const assertOwner = async (tx: PlacementExecutor, j: ImageJob) => {
        const rows = rowsOf(await tx.execute(sql`SELECT user_id::text AS user_id FROM public.ezil_computers
            WHERE id = ${j.computerId}::uuid AND deleted_at IS NULL FOR UPDATE`));
        if (rows.length !== 1 || rows[0]!.user_id !== j.ownerUserId) throw new ImageJobConflictError();
    };
    const context = async (tx: PlacementExecutor, lock: AdmissionLock, expected: ImageJob, locked?: ImagePlacement) => {
        const p = locked ?? await lockImagePlacement(tx, lock, expected.computerId);
        await assertOwner(tx, expected);
        const current = await active(tx, expected.computerId);
        const source = p?.generation === expected.sourceGeneration && p.fenceToken === expected.sourceFenceToken;
        const rebound = expected.rebindGeneration !== null && p?.generation === expected.rebindGeneration && p.fenceToken === expected.rebindFenceToken;
        const target = expected.targetGeneration !== null && p?.generation === expected.targetGeneration && p.fenceToken === expected.targetFenceToken;
        if (!p || p.imageUpgradeJobId !== expected.jobId || p.ownerUserId !== expected.ownerUserId || !current || !equal(current, expected)
            || (!source && !target && !rebound) || p.leaseEpoch !== (expected.rebindLeaseEpoch ?? expected.targetLeaseEpoch ?? expected.sourceLeaseEpoch)
            || p.region !== expected.region || p.zoneId !== expected.zoneId || p.store !== 'ebs' || p.provider !== 'aws-ec2'
            || (!expected.launchDocument && p.instanceId !== expected.sourceInstanceId)
            || (expected.hostEvidence && p.instanceId !== expected.hostEvidence.instanceId)
            || p.volumeId !== (expected.rebindDocument ? expected.restoredVolumeId : expected.sourceVolumeId) || p.fsUuid !== expected.fsUuid
            || (expected.launchJobId !== null && (p.lifecycleJobId !== (expected.rebindJobId ?? expected.launchJobId) || p.lifecycleDigest !== (expected.rebindDigest ?? expected.launchDigest)))) throw new ImageJobConflictError();
        return p;
    };
    const save = async (tx: PlacementExecutor, expected: ImageJob, candidate: ImageJob) => {
        const next = validateImageJob(candidate);
        if (isTerminalImageJob(expected.phase) || (next.phase !== expected.phase && !IMAGE_JOB_NEXT[expected.phase].includes(next.phase))
            || Date.parse(next.updatedAt) <= Date.parse(expected.updatedAt) || immutable.some(k => !equal(expected[k], next[k]))
            || writeOnce.some(k => expected[k] !== null && !equal(expected[k], next[k]))) throw new ImageJobConflictError();
        const rows = rowsOf(await tx.execute(sql`UPDATE public.ezil_computer_image_jobs SET
            ${sql.join(columns.filter(([k]) => !(immutable as readonly string[]).includes(k)).map(([key, name, type]) => sql`${sql.raw(name)} = ${valueSql(next, key, type)}`), sql`, `)}
            WHERE job_id = ${expected.jobId}::uuid AND computer_id = ${expected.computerId}::uuid
              AND phase = ${expected.phase} AND updated_at = ${expected.updatedAt}::timestamptz
              AND source_generation = ${expected.sourceGeneration} AND source_lease_epoch = ${expected.sourceLeaseEpoch}
              AND source_fence_token = ${expected.sourceFenceToken}::uuid AND owner_user_id = ${expected.ownerUserId}::uuid
            RETURNING ${columnNames}`));
        if (rows.length !== 1) throw new ImageJobConflictError();
        return parseImageJobRow(rows[0]!);
    };
    const time = (j: ImageJob, now: Date) => new Date(Math.max(now.getTime(), Date.parse(j.updatedAt) + 1)).toISOString();
    const store = {
        read: (jobId: string) => read(db, jobId),
        async inspect(computerId: string) {
            return withAdmission(db, async (tx, lock) => {
                const placement = await lockImagePlacement(tx, lock, RebaseUuid.parse(computerId));
                const job = await active(tx, computerId);
                if ((job?.jobId ?? null) !== (placement?.imageUpgradeJobId ?? null)) throw new ImageJobConflictError();
                if (placement) {
                    const owner = rowsOf(await tx.execute(sql`SELECT user_id::text AS user_id FROM public.ezil_computers
                        WHERE id = ${computerId}::uuid AND deleted_at IS NULL FOR UPDATE`));
                    if (owner.length !== 1 || owner[0]!.user_id !== placement.ownerUserId) throw new ImageJobConflictError();
                }
                if (job) await context(tx, lock, job, placement!);
                return { placement, job };
            });
        },
        async authority(a: { computerId: string; imageJobId: string; imageJobPhase: 'preparation' | 'launch' | 'recovery' | 'rebind'; jobId: string; leaseEpoch: number; digest: string }, now = new Date()) {
            return withAdmission(db, async (tx, lock) => {
                const j = await read(tx, a.imageJobId);
                if (!j || j.computerId !== a.computerId) return false;
                const p = await context(tx, lock, j);
                if (a.imageJobPhase === 'launch' || a.imageJobPhase === 'rebind') {
                    const document = a.imageJobPhase === 'launch' ? j.launchDocument : j.rebindDocument;
                    if (!document) return false;
                    const lease = parseEnrollmentUserData(JSON.parse(document).userData), permit = lease.rebasePermit ?? lease.ebsRestore!;
                    if (p.enrollExpiresAt?.toISOString() !== permit.expiresAt
                        || (p.enrollNonceHash ?? p.enrollConsumedHash) !== createHash('sha256').update(lease.nonce).digest('hex')) return false;
                }
                if (a.imageJobPhase === 'preparation') return ['reserved', 'fencing', 'snapshot_pending', 'unconfirmed'].includes(j.phase)
                    && !j.launchDocument && a.jobId === j.jobId && a.digest === j.preparationDigest && a.leaseEpoch === j.sourceLeaseEpoch;
                if (a.imageJobPhase === 'launch') return ['launch_pending', 'verifying', 'unconfirmed'].includes(j.phase)
                    && !j.recoveryDocument && Date.parse(parseEnrollmentUserData(JSON.parse(j.launchDocument!).userData).rebasePermit!.expiresAt) > now.getTime() && a.jobId === j.launchJobId && a.digest === j.launchDigest && a.leaseEpoch === j.targetLeaseEpoch;
                if (a.imageJobPhase === 'recovery') return ['recovery_pending', 'restore_pending', 'unconfirmed'].includes(j.phase)
                    && !!j.recoveryDocument && !j.rebindDocument && a.jobId === j.recoveryJobId && a.digest === j.recoveryDigest && a.leaseEpoch === j.sourceLeaseEpoch;
                if (a.imageJobPhase === 'rebind') return ['rebind_pending', 'unconfirmed'].includes(j.phase) && !!j.rebindDocument
                    && a.jobId === j.rebindJobId && a.digest === j.rebindDigest && a.leaseEpoch === j.rebindLeaseEpoch
                    && Date.parse(parseEnrollmentUserData(JSON.parse(j.rebindDocument!).userData).ebsRestore!.expiresAt) > now.getTime();
                return false;
            });
        },
        async reserve(candidate: ImageJob, approvedRepositoryUri: string): Promise<ImageJob> {
            const j = validateImageJob(candidate);
            const prep = buildRebasePreparation(parseRebaseJson(j.preparationDocument) as Parameters<typeof buildRebasePreparation>[0]);
            parseRebaseSourceRelease(j.sourceRelease, prep.intent.sourceDeployment, approvedRepositoryUri);
            parseRebaseRelease(j.targetRelease, prep.intent.deployment, approvedRepositoryUri);
            if (j.phase !== 'reserved' || !j.retentionHold || j.preparationExecutionArn !== prep.executionArn
                || writeOnce.filter(k => k !== 'preparationExecutionArn').some(k => j[k] !== null)) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await lockImagePlacement(tx, lock, j.computerId);
                await assertOwner(tx, j);
                const existing = await active(tx, j.computerId);
                if (!p || p.ownerUserId !== j.ownerUserId) throw new ImageJobConflictError();
                if (existing) {
                    if (p.imageUpgradeJobId !== existing.jobId || !equal(existing, j)) throw new ImageJobConflictError();
                    return existing;
                }
                if (p.imageUpgradeJobId || await read(tx, j.jobId) || p.provider !== 'aws-ec2' || p.lifecycleJobId
                    || !['STOPPED', 'RUNNING'].includes(p.state) || p.lowerImageDigest !== j.fromDigest || !p.lowerDigestObservedAt
                    || p.generation !== j.sourceGeneration || p.leaseEpoch !== j.sourceLeaseEpoch || p.fenceToken !== j.sourceFenceToken
                    || p.instanceId !== j.sourceInstanceId || p.volumeId !== j.sourceVolumeId || p.fsUuid !== j.fsUuid
                    || p.region !== j.region || p.zoneId !== j.zoneId) throw new ImageJobConflictError();
                const migrations = rowsOf(await tx.execute(sql`SELECT id FROM public.ezil_compute_migrations
                    WHERE computer_id = ${j.computerId}::uuid
                      AND state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator') LIMIT 2 FOR UPDATE`));
                if (migrations.length) throw new ImageJobConflictError();
                const pool = rowsOf(await tx.execute(sql`SELECT id FROM public.ezil_compute_pool_hosts
                    WHERE leased_computer_id = ${j.computerId}::uuid AND state = 'leased' LIMIT 2 FOR UPDATE`));
                if (pool.length) throw new ImageJobConflictError();
                const inserted = rowsOf(await tx.execute(sql`INSERT INTO public.ezil_computer_image_jobs (${columnNames})
                    VALUES (${sql.join(columns.map(([key, , type]) => valueSql(j, key, type)), sql`, `)}) RETURNING ${columnNames}`));
                if (inserted.length !== 1) throw new ImageJobConflictError();
                await setImageReservation(tx, lock, p, j.jobId);
                return parseImageJobRow(inserted[0]!);
            });
        },
        async transition(expected: ImageJob, candidate: ImageJob): Promise<ImageJob> {
            if (!['fencing', 'snapshot_pending', 'snapshot_ready', 'failed', 'unconfirmed'].includes(candidate.phase)
                || writeOnce.filter(k => !['snapshotId', 'snapshotEvidence'].includes(k)).some(k => !equal(expected[k], candidate[k]))) throw new ImageJobConflictError();
            // UNCONFIRMED can only resume with exact provider evidence through reconciliation.
            if (expected.phase === 'unconfirmed' && !['failed', 'unconfirmed'].includes(candidate.phase)) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected), next = await save(tx, expected, candidate);
                if (candidate.phase === 'failed') await writeImagePlacement(tx, lock, p, { state: 'UNCONFIRMED', enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null });
                return next;
            });
        },
        async reconcilePreparation(expected: ImageJob, receipt: ImageJob['snapshotEvidence'], now: Date): Promise<ImageJob> {
            if (!receipt || expected.launchDocument || !['snapshot_pending', 'unconfirmed'].includes(expected.phase)) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                const next = await save(tx, expected, { ...expected, phase: 'snapshot_ready', snapshotId: receipt.snapshotId, snapshotEvidence: receipt,
                    failureCode: null, updatedAt: time(expected, now), reconciledAt: now.toISOString() });
                await writeImagePlacement(tx, lock, p, { state: 'STOPPED', enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null });
                await recordImageUsage(tx, lock, p, { kind: 'close', observedBy: 'image-preparation' });
                return next;
            });
        },
        async admitLaunch(expected: ImageJob, work: LifecycleWork, now: Date): Promise<ImageJob> {
            if (expected.phase !== 'snapshot_ready' || expected.launchDocument) throw new ImageJobConflictError();
            const lease = parseEnrollmentUserData(work.intent.userData!);
            const permit = lease.rebasePermit;
            if (!permit || Date.parse(permit.issuedAt) !== now.getTime() || Date.parse(permit.expiresAt) - now.getTime() !== 600000
                || work.intent.jobId.split('-')[2]?.[0] !== '4' || work.intent.fenceToken.split('-')[2]?.[0] !== '4'
                || work.intent.targetGeneration !== expected.sourceGeneration + 1 || work.intent.leaseEpoch <= expected.sourceLeaseEpoch) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                const config = readAwsAdmissionConfig(env);
                const counters = await readImageAdmissionCounters(tx, lock, p, now);
                if (!decideAdmission({ config, counters, userId: p.ownerUserId, now, region: { kind: 'lease', region: p.region }, instanceType: work.intent.instanceType }).admit)
                    throw new Error('operator_required');
                const next = await save(tx, expected, { ...expected, phase: 'launch_pending', launchJobId: work.intent.jobId,
                    launchDocument: JSON.parse(work.input).document as string, launchDigest: work.digest,
                    launchExecutionArn: work.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${work.name}`),
                    targetGeneration: work.intent.targetGeneration, targetLeaseEpoch: work.intent.leaseEpoch, targetFenceToken: work.intent.fenceToken,
                    updatedAt: time(expected, now), failureCode: null });
                await writeImagePlacement(tx, lock, p, { state: 'STARTING', leaseEpoch: next.targetLeaseEpoch!,
                    lifecycleJobId: next.launchJobId, lifecycleDigest: next.launchDigest,
                    enrollNonceHash: createHash('sha256').update(lease.nonce).digest('hex'), enrollConsumedHash: null,
                    enrollExpiresAt: new Date(permit.expiresAt), leaseUntil: new Date(now.getTime() + 3600000), presenceAt: now, lastError: null });
                return next;
            });
        },
        async resumeLaunch(expected: ImageJob, execution: Execution, mode: 'launch' | 'rebind', now: Date) {
            assertImageExecution(execution, launchFor(expected, mode));
            if (expected.phase !== 'unconfirmed' || !['RUNNING', 'SUCCEEDED'].includes(execution.status)) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                await context(tx, lock, expected);
                return save(tx, expected, { ...expected, phase: mode === 'launch' ? 'launch_pending' : 'rebind_pending', failureCode: null,
                    updatedAt: time(expected, now), reconciledAt: now.toISOString() });
            });
        },
        async observeRebind(expected: ImageJob, evidence: { execution: Execution; host: Ec2EnrollmentView | null; volume: Ec2VolumeView | null }, now: Date) {
            const r = verifyImageLaunch(expected, evidence.execution, evidence.host, evidence.volume, 'rebind');
            if (expected.phase !== 'rebind_pending') throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                if (p.instanceId !== expected.sourceInstanceId && p.instanceId !== r.instanceId) throw new ImageJobConflictError();
                const next = await save(tx, expected, { ...expected, failureCode: null, updatedAt: time(expected, now), reconciledAt: now.toISOString() });
                await writeImagePlacement(tx, lock, p, { generation: r.generation, fenceToken: r.fenceToken, instanceId: r.instanceId });
                return next;
            });
        },
        async observeLaunch(expected: ImageJob, evidence: { execution: Execution; host: Ec2EnrollmentView | null; volume: Ec2VolumeView | null }, now: Date): Promise<ImageJob> {
            const r = verifyImageLaunch(expected, evidence.execution, evidence.host, evidence.volume);
            if (!['launch_pending', 'verifying', 'unconfirmed'].includes(expected.phase)) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                if (p.instanceId !== expected.sourceInstanceId && p.instanceId !== r.instanceId) throw new ImageJobConflictError();
                const next = await save(tx, expected, { ...expected, phase: 'verifying', failureCode: null, updatedAt: time(expected, now), reconciledAt: now.toISOString() });
                await writeImagePlacement(tx, lock, p, { state: 'MOUNTING', generation: r.generation, fenceToken: r.fenceToken, instanceId: r.instanceId });
                return next;
            });
        },
        async admitRecovery(expected: ImageJob, work: ReturnType<typeof buildImageRecovery>, failed: Execution, now: Date) {
            assertImageExecution(failed, launchFor(expected));
            if (!['failed', 'unconfirmed'].includes(expected.phase) || expected.hostEvidence || expected.recoveryDocument
                || !['FAILED', 'TIMED_OUT', 'ABORTED', 'SUCCEEDED'].includes(failed.status) || work.intent.jobId.split('-')[2]?.[0] !== '4') throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                if (p.enrollConsumedHash || p.lastError === ENROLLMENT_SUCCEEDED) throw new Error('operator_required');
                const next = await save(tx, expected, { ...expected, phase: 'recovery_pending', failureCode: null,
                    recoveryJobId: work.intent.jobId, recoveryDocument: work.document, recoveryDigest: work.digest,
                    recoveryExecutionArn: work.executionArn, updatedAt: time(expected, now) });
                await writeImagePlacement(tx, lock, p, { state: 'RECOVERING', enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null });
                return next;
            });
        },
        async observeRecovery(expected: ImageJob, execution: Execution, now: Date) {
            assertImageExecution(execution, recoveryFor(expected));
            if (!['recovery_pending', 'unconfirmed'].includes(expected.phase) || !['RUNNING', 'SUCCEEDED'].includes(execution.status)) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                await context(tx, lock, expected);
                return save(tx, expected, { ...expected, phase: 'restore_pending', failureCode: null, updatedAt: time(expected, now), reconciledAt: now.toISOString() });
            });
        },
        async observeRestore(expected: ImageJob, evidence: { execution: Execution; volume: Ec2VolumeView | null; original: Ec2VolumeView | null }, now: Date) {
            const receipt = verifyImageRestore(expected, evidence.execution, evidence.volume, evidence.original, now);
            if (expected.phase !== 'restore_pending' || expected.rebindDocument) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                const next = await save(tx, expected, { ...expected, restoredVolumeId: receipt.volumeId, quarantinedVolumeId: expected.sourceVolumeId,
                    failureCode: null, updatedAt: time(expected, now), reconciledAt: now.toISOString() });
                await writeImagePlacement(tx, lock, p!, { state: 'STOPPED' });
                return next;
            });
        },
        async admitRebind(expected: ImageJob, work: LifecycleWork, now: Date) {
            const lease = parseEnrollmentUserData(work.intent.userData!), permit = lease.ebsRestore;
            if (expected.phase !== 'restore_pending' || !expected.restoredVolumeId || expected.rebindDocument || !permit
                || Date.parse(permit.issuedAt) !== now.getTime() || Date.parse(permit.expiresAt) - now.getTime() !== 600000
                || work.intent.jobId.split('-')[2]?.[0] !== '4' || work.intent.fenceToken.split('-')[2]?.[0] !== '4') throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                const config = readAwsAdmissionConfig(env);
                const counters = await readImageAdmissionCounters(tx, lock, p, now);
                if (!decideAdmission({ config, counters, userId: p.ownerUserId, now, region: { kind: 'lease', region: p.region }, instanceType: work.intent.instanceType }).admit)
                    throw new Error('operator_required');
                const next = await save(tx, expected, { ...expected, phase: 'rebind_pending', rebindJobId: work.intent.jobId,
                    rebindDocument: JSON.parse(work.input).document as string, rebindDigest: work.digest,
                    rebindExecutionArn: work.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${work.name}`),
                    rebindGeneration: work.intent.targetGeneration, rebindLeaseEpoch: work.intent.leaseEpoch, rebindFenceToken: work.intent.fenceToken,
                    updatedAt: time(expected, now), failureCode: null });
                // The independently verified clone carries the snapshot's original confirmed tag pair.
                await writeImagePlacement(tx, lock, p, { state: 'STARTING', volumeId: expected.restoredVolumeId, instanceId: expected.sourceInstanceId,
                    generation: expected.sourceGeneration, fenceToken: expected.sourceFenceToken, leaseEpoch: next.rebindLeaseEpoch!,
                    lifecycleJobId: next.rebindJobId, lifecycleDigest: next.rebindDigest,
                    lowerImageDigest: expected.fromDigest, lowerDigestObservedAt: p.lowerDigestObservedAt,
                    enrollNonceHash: createHash('sha256').update(lease.nonce).digest('hex'), enrollConsumedHash: null,
                    enrollExpiresAt: new Date(permit.expiresAt), leaseUntil: new Date(now.getTime() + 3600000), presenceAt: now, lastError: null });
                return next;
            });
        },
        async enrollMaintenance(expected: ImageJob, input: { nonceHash: string; instanceId: string; lowerImageDigest: string; report: z.infer<typeof MaintenanceReportSchema> }, now: Date) {
            if (expected.phase !== 'rebind_pending' || input.lowerImageDigest !== expected.fromDigest) throw new ImageJobConflictError();
            const report = MaintenanceReportSchema.parse(input.report);
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                if (!p.enrollExpiresAt || p.enrollExpiresAt.getTime() <= now.getTime() || (p.enrollNonceHash ?? p.enrollConsumedHash) !== input.nonceHash
                    || (p.instanceId !== expected.sourceInstanceId && p.instanceId !== input.instanceId)) throw new ImageJobConflictError();
                const evidence = ImageHostEvidenceSchema.parse({ v: 1, computerId: p.computerId, instanceId: input.instanceId,
                    volumeId: expected.restoredVolumeId, fsUuid: expected.fsUuid, generation: expected.rebindGeneration,
                    leaseEpoch: expected.rebindLeaseEpoch, lowerImageDigest: input.lowerImageDigest, observedAt: now.toISOString(), ebsRestore: report });
                if (expected.hostEvidence) {
                    if (!equal({ ...expected.hostEvidence, observedAt: evidence.observedAt }, evidence)) throw new ImageJobConflictError();
                    return p;
                }
                await save(tx, expected, { ...expected, hostEvidence: evidence, updatedAt: time(expected, now) });
                const fields: ImagePlacementFields = { generation: expected.rebindGeneration!, fenceToken: expected.rebindFenceToken,
                    instanceId: input.instanceId, lowerImageDigest: input.lowerImageDigest, lowerDigestObservedAt: now,
                    enrollNonceHash: null, enrollConsumedHash: input.nonceHash, lastError: 'maintenance_accepted' };
                await writeImagePlacement(tx, lock, p, fields);
                return { ...p, ...fields };
            });
        },
        async transferRecovered(expected: ImageJob, evidence: { execution: Execution; host: Ec2EnrollmentView | null; volume: Ec2VolumeView | null }, childId: string, now: Date) {
            const r = verifyImageLaunch(expected, evidence.execution, evidence.host, evidence.volume, 'rebind');
            if (expected.phase !== 'rebind_pending' || expected.hostEvidence?.instanceId !== r.instanceId || !expected.hostEvidence.ebsRestore) throw new ImageJobConflictError();
            const preparation = buildRebasePreparation({ ...JSON.parse(expected.preparationDocument), jobId: childId,
                sourceInstanceId: r.instanceId, sourceVolumeId: r.volumeId, sourceGeneration: r.generation, sourceLeaseEpoch: r.leaseEpoch,
                sourceFenceToken: r.fenceToken, createdAt: now.toISOString() });
            const child = newReservedImageJob({ preparation, ownerUserId: expected.ownerUserId, sourceRelease: expected.sourceRelease,
                targetRelease: expected.targetRelease, parentJobId: expected.jobId });
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                if (p.lastError !== 'maintenance_accepted' || p.lowerImageDigest !== expected.fromDigest || p.instanceId !== r.instanceId
                    || await read(tx, childId)) throw new ImageJobConflictError();
                const recovered = await save(tx, expected, { ...expected, phase: 'recovered', completedAt: now.toISOString(), retentionHold: true,
                    failureCode: null, updatedAt: time(expected, now) });
                const rows = rowsOf(await tx.execute(sql`INSERT INTO public.ezil_computer_image_jobs (${columnNames})
                    VALUES (${sql.join(columns.map(([key, , type]) => valueSql(child, key, type)), sql`, `)}) RETURNING ${columnNames}`));
                if (rows.length !== 1) throw new ImageJobConflictError();
                await writeImagePlacement(tx, lock, p, { state: 'RECOVERING', imageUpgradeJobId: childId, lifecycleJobId: null, lifecycleDigest: null,
                    enrollNonceHash: null, enrollConsumedHash: null, enrollExpiresAt: null });
                return { recovered, child: parseImageJobRow(rows[0]!) };
            });
        },
        async enroll(expected: ImageJob, input: { nonceHash: string; instanceId: string; volumeId: string; lowerImageDigest: string }, now: Date) {
            if (!['launch_pending', 'verifying'].includes(expected.phase) || input.lowerImageDigest !== expected.toDigest
                || input.volumeId !== expected.sourceVolumeId) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                if (!p.enrollExpiresAt || p.enrollExpiresAt.getTime() <= now.getTime()
                    || (p.enrollNonceHash ?? p.enrollConsumedHash) !== input.nonceHash
                    || (p.instanceId !== expected.sourceInstanceId && p.instanceId !== input.instanceId)) throw new ImageJobConflictError();
                const evidence = ImageHostEvidenceSchema.parse({ v: 1, computerId: p.computerId, instanceId: input.instanceId,
                    volumeId: input.volumeId, fsUuid: expected.fsUuid, generation: expected.targetGeneration,
                    leaseEpoch: expected.targetLeaseEpoch, lowerImageDigest: input.lowerImageDigest, observedAt: now.toISOString() });
                if (expected.hostEvidence) {
                    if (!equal({ ...expected.hostEvidence, observedAt: evidence.observedAt }, evidence)) throw new ImageJobConflictError();
                    return p;
                }
                await save(tx, expected, { ...expected, hostEvidence: evidence, updatedAt: time(expected, now) });
                const fields: ImagePlacementFields = { instanceId: input.instanceId, generation: expected.targetGeneration!, fenceToken: expected.targetFenceToken,
                    lowerImageDigest: input.lowerImageDigest, lowerDigestObservedAt: now, enrollNonceHash: null,
                    enrollConsumedHash: input.nonceHash, lastError: ENROLLMENT_PENDING };
                await writeImagePlacement(tx, lock, p, fields);
                return { ...p, ...fields };
            });
        },
        async finishEnroll(expected: ImageJob, input: { instanceId: string; success: boolean }, now: Date) {
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                if (!['launch_pending', 'verifying'].includes(expected.phase) || !expected.hostEvidence || p.instanceId !== input.instanceId
                    || p.enrollNonceHash || !p.enrollConsumedHash || ![ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED].includes(p.lastError ?? '')) throw new ImageJobConflictError();
                const fields: ImagePlacementFields = input.success ? { lastError: ENROLLMENT_SUCCEEDED } : {
                    lastError: 'enroll_tunnel_failed', enrollConsumedHash: null, enrollExpiresAt: null, state: 'UNCONFIRMED' };
                if (!input.success) await save(tx, expected, { ...expected, phase: 'failed', failureCode: 'enrollment_failed', updatedAt: time(expected, now) });
                await writeImagePlacement(tx, lock, p, fields);
                return { ...p, ...fields };
            });
        },
        async succeed(expected: ImageJob, evidence: { execution: Execution; host: Ec2EnrollmentView | null; volume: Ec2VolumeView | null; desktopHealthy: boolean }, now: Date) {
            const r = verifyImageLaunch(expected, evidence.execution, evidence.host, evidence.volume);
            if (expected.phase !== 'verifying' || !evidence.desktopHealthy || !expected.hostEvidence || expected.hostEvidence.instanceId !== r.instanceId) throw new ImageJobConflictError();
            return withAdmission(db, async (tx, lock) => {
                const p = await context(tx, lock, expected);
                if (p.lastError !== ENROLLMENT_SUCCEEDED || p.enrollNonceHash || p.lowerImageDigest !== expected.toDigest
                    || p.instanceId !== r.instanceId || p.generation !== r.generation || p.fenceToken !== r.fenceToken) throw new ImageJobConflictError();
                const next = await save(tx, expected, { ...expected, phase: 'succeeded', completedAt: now.toISOString(),
                    retainUntil: new Date(now.getTime() + 604800000).toISOString(), retentionHold: false, failureCode: null, updatedAt: time(expected, now) });
                await writeImagePlacement(tx, lock, p, { state: 'RUNNING', imageUpgradeJobId: null, lifecycleJobId: null, lifecycleDigest: null });
                await recordImageUsage(tx, lock, p, { kind: 'open', observedBy: 'image-rebase', instanceId: r.instanceId, instanceType: p.instanceType!, startedAt: now });
                return next;
            });
        },
    };
    return store;
}
