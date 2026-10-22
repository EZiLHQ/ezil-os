import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { buildLifecycleWork } from './aws-intent';
import { parseEnrollmentUserData } from './aws-rebase-lease';
import { buildRebasePreparation, RebaseSnapshotReceiptSchema, validateRebaseSnapshotReceipt } from './aws-rebase-preparation';
import { parseRebaseJson, RebaseCounter, RebaseDigest, RebaseHash, RebaseSnapshot, RebaseTime, RebaseUuid, RebaseVolume } from './aws-rebase-json';
import { parseRebaseRelease, RebaseReleaseSchema } from './aws-rebase-release';
import { ImageJobConflictError, lockImagePlacement, setImageReservation, withAdmission, type PlacementDb, type PlacementExecutor } from './placement';

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
    lowerImageDigest: RebaseDigest, observedAt: RebaseTime }).strict();

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
    sourceRelease: RebaseReleaseSchema,
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
    parseRebaseRelease(j.sourceRelease, p.intent.sourceDeployment, repository);
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
            if (JSON.parse(w.input).document !== doc || w.digest !== digest || i.jobId !== id || i.computerId !== j.computerId
                || i.targetGeneration !== generation || i.leaseEpoch !== epoch || i.fenceToken !== fence || !j.snapshotEvidence
                || i.rebasePreparation?.preparationJobId !== j.jobId || i.rebasePreparation.digest !== j.preparationDigest
                || i.rebasePreparation.executionArn !== j.preparationExecutionArn
                || arn !== w.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${w.name}`)) throw new ImageJobConflictError();
        }
    }
    if (!allOrNone([j.recoveryJobId, j.recoveryDocument, j.recoveryDigest, j.recoveryExecutionArn])) throw new ImageJobConflictError();
    // Recovery input/evidence must be implemented before recovery rows are admitted.
    if (j.recoveryDocument !== null || j.rebindDocument !== null) throw new Error('operator_required');
    if (['launch_pending', 'verifying', 'succeeded'].includes(j.phase) && !j.launchDocument) throw new ImageJobConflictError();
    if (j.hostEvidence && (j.hostEvidence.computerId !== j.computerId || j.hostEvidence.fsUuid !== j.fsUuid
        || j.hostEvidence.volumeId !== j.sourceVolumeId || j.hostEvidence.generation !== j.targetGeneration
        || j.hostEvidence.leaseEpoch !== j.targetLeaseEpoch || j.hostEvidence.lowerImageDigest !== j.toDigest)) throw new ImageJobConflictError();
    if (j.phase === 'succeeded' && (!j.hostEvidence || !j.completedAt || !j.retainUntil
        || Date.parse(j.retainUntil) < Date.parse(j.completedAt) + 604800000)) throw new ImageJobConflictError();
    if (!isTerminalImageJob(j.phase) && (!j.retentionHold || j.completedAt !== null)) throw new ImageJobConflictError();
    if (['failed', 'unconfirmed'].includes(j.phase) && !j.failureCode) throw new ImageJobConflictError();
    return j;
}

/** No nonce is issued by reservation or preparation. */
export function newReservedImageJob(input: {
    preparation: ReturnType<typeof buildRebasePreparation>; ownerUserId: string;
    sourceRelease: z.infer<typeof RebaseReleaseSchema>; targetRelease: z.infer<typeof RebaseReleaseSchema>; parentJobId?: string;
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

export function createImageJobStore(db: PlacementDb) {
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
    return {
        read: (jobId: string) => read(db, jobId),
        async reserve(candidate: ImageJob, approvedRepositoryUri: string): Promise<ImageJob> {
            const j = validateImageJob(candidate);
            const prep = buildRebasePreparation(parseRebaseJson(j.preparationDocument) as Parameters<typeof buildRebasePreparation>[0]);
            parseRebaseRelease(j.sourceRelease, prep.intent.sourceDeployment, approvedRepositoryUri);
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
            const next = validateImageJob(candidate);
            const selfReconcile = next.phase === expected.phase && columns.filter(([k]) => !['updatedAt', 'reconciledAt'].includes(k)).every(([k]) => equal(expected[k], next[k]));
            if (isTerminalImageJob(expected.phase) || (!selfReconcile && !IMAGE_JOB_NEXT[expected.phase].includes(next.phase))
                || Date.parse(next.updatedAt) <= Date.parse(expected.updatedAt)
                || immutable.some(k => !equal(expected[k], next[k]))
                || writeOnce.some(k => expected[k] !== null && !equal(expected[k], next[k]))) throw new ImageJobConflictError();
            // Completion/recovery require atomic placement custody and host/health integration.
            if (!['fencing', 'snapshot_pending', 'snapshot_ready', 'failed', 'unconfirmed'].includes(next.phase)) throw new Error('operator_required');
            return withAdmission(db, async (tx, lock) => {
                const p = await lockImagePlacement(tx, lock, expected.computerId);
                await assertOwner(tx, expected);
                const current = await active(tx, expected.computerId);
                if (!p || p.imageUpgradeJobId !== expected.jobId || p.ownerUserId !== expected.ownerUserId
                    || !current || !equal(current, expected) || p.generation !== expected.sourceGeneration
                    || p.leaseEpoch !== expected.sourceLeaseEpoch || p.fenceToken !== expected.sourceFenceToken) throw new ImageJobConflictError();
                const rows = rowsOf(await tx.execute(sql`UPDATE public.ezil_computer_image_jobs SET
                    ${sql.join(columns.filter(([k]) => !(immutable as readonly string[]).includes(k)).map(([key, name, type]) => sql`${sql.raw(name)} = ${valueSql(next, key, type)}`), sql`, `)}
                    WHERE job_id = ${expected.jobId}::uuid AND computer_id = ${expected.computerId}::uuid
                      AND phase = ${expected.phase} AND updated_at = ${expected.updatedAt}::timestamptz
                      AND source_generation = ${expected.sourceGeneration} AND source_lease_epoch = ${expected.sourceLeaseEpoch}
                      AND source_fence_token = ${expected.sourceFenceToken}::uuid AND owner_user_id = ${expected.ownerUserId}::uuid
                    RETURNING ${columnNames}`));
                if (rows.length !== 1) throw new ImageJobConflictError();
                return parseImageJobRow(rows[0]!);
            });
        },
    };
}
