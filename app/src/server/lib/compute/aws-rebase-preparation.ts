import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleDeploymentSchema, SourceLifecycleDeploymentSchema } from './aws-intent';
import { RebaseCounter, RebaseDigest, RebaseHash, RebaseSnapshot, RebaseTime, RebaseUuid, RebaseVolume } from './aws-rebase-json';

/** DESIGN R: a STOPPED computer's released warm-pool host (retired claim row, provision digest, proven release). Last key and
 * omitted when absent, as in infra's PreparationDocumentSchema: existing documents and digests are byte-identical. */
export const ReleasedPoolHostSchema = z.object({ poolHostId: RebaseUuid, lifecycleDigest: RebaseHash,
    releaseExecutionArn: z.string().max(300).regex(/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]{1,80}:computer-[0-9a-f-]{36}$/) }).strict();
/** DESIGN R2: a STOPPED computer's regular (non-pool) host, retired by a proven normal release and aged out of EC2. Last key,
 * omitted when absent, never together with `releasedPoolHost`; mirrors infra's RetiredSourceSchema. */
export const RetiredSourceSchema = z.object({
    releaseExecutionArn: z.string().max(300).regex(/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]{1,80}:computer-[0-9a-f-]{36}$/) }).strict();
export const RebasePreparationSchema = z.object({
    schemaVersion: z.literal(1), jobId: RebaseUuid, computerId: RebaseUuid,
    sourceInstanceId: z.string().regex(/^i-[0-9a-f]{17}$/), sourceVolumeId: RebaseVolume, fsUuid: RebaseUuid,
    sourceGeneration: RebaseCounter, sourceLeaseEpoch: RebaseCounter, sourceFenceToken: RebaseUuid,
    fromDigest: RebaseDigest, toDigest: RebaseDigest, volumeGiB: z.number().int().min(1).max(16384),
    sourceDeployment: SourceLifecycleDeploymentSchema, deployment: LifecycleDeploymentSchema, createdAt: RebaseTime,
    releasedPoolHost: ReleasedPoolHostSchema.optional(),
    retiredSource: RetiredSourceSchema.optional(),
}).strict().superRefine((p, ctx) => {
    const from = p.sourceDeployment, to = p.deployment;
    const machine = to.stateMachineVersionArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, ':computer-');
    if (p.fromDigest === p.toDigest || p.fromDigest !== from.lowerImageDigest || p.fromDigest !== to.previousLowerImageDigest
        || p.toDigest !== to.lowerImageDigest || !to.preparationStateMachineVersionArn
        || ['accountId', 'region', 'namespace', 'zoneId', 'dataKeyArn'].some((key) => from[key as keyof typeof from] !== to[key as keyof typeof to])
        || p.volumeGiB < to.storage.dataMinGiB || p.volumeGiB > to.storage.dataMaxGiB
        // At most one retired-host proof; the release ran on this namespace's lifecycle machine, in this account and region.
        || (p.releasedPoolHost && p.retiredSource)
        || (p.releasedPoolHost && !p.releasedPoolHost.releaseExecutionArn.startsWith(machine))
        || (p.retiredSource && !p.retiredSource.releaseExecutionArn.startsWith(machine)))
        ctx.addIssue({ code: 'custom', message: 'release_mismatch' });
});
export type RebasePreparation = z.infer<typeof RebasePreparationSchema>;

export function buildRebasePreparation(candidate: RebasePreparation) {
    const intent = RebasePreparationSchema.parse(candidate);
    const document = JSON.stringify(intent);
    const digest = createHash('sha256').update(document, 'utf8').digest('hex');
    const input = JSON.stringify({ schemaVersion: 1, document, digest });
    if (Buffer.byteLength(document) > 16384 || Buffer.byteLength(input) > 20000) throw new Error('release_mismatch');
    const stateMachineArn = intent.deployment.preparationStateMachineVersionArn!;
    const name = `computer-${intent.jobId}`;
    return { intent, document, digest, input, name, stateMachineArn,
        executionArn: stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${name}`) };
}

export const RebaseSnapshotReceiptSchema = z.object({
    schemaVersion: z.literal(1), jobId: RebaseUuid, digest: RebaseHash, computerId: RebaseUuid,
    state: z.literal('snapshot_ready'), sourceInstanceId: z.string().regex(/^i-[0-9a-f]{17}$/),
    sourceVolumeId: RebaseVolume, fsUuid: RebaseUuid, sourceGeneration: RebaseCounter, sourceLeaseEpoch: RebaseCounter,
    sourceFenceToken: RebaseUuid, fromDigest: RebaseDigest, toDigest: RebaseDigest,
    snapshotId: RebaseSnapshot, snapshotOwnerId: z.string().regex(/^[0-9]{12}$/), snapshotVolumeGiB: z.number().int().min(1).max(16384),
    snapshotKmsKeyArn: z.string(), fencedAt: RebaseTime, snapshotStartedAt: RebaseTime, snapshotCompletedAt: RebaseTime, verifiedAt: RebaseTime,
}).strict();

/** Checks the receipt against the immutable preparation. Provider readback remains required. */
export function validateRebaseSnapshotReceipt(raw: unknown, work: ReturnType<typeof buildRebasePreparation>, now: Date) {
    const r = RebaseSnapshotReceiptSchema.parse(raw), p = work.intent;
    if (Buffer.byteLength(JSON.stringify(r)) > 8192 || r.digest !== work.digest
        || (['jobId', 'computerId', 'sourceInstanceId', 'sourceVolumeId', 'fsUuid', 'sourceGeneration', 'sourceLeaseEpoch', 'sourceFenceToken', 'fromDigest', 'toDigest'] as const).some((k) => r[k] !== p[k])
        || r.snapshotOwnerId !== p.deployment.accountId || r.snapshotVolumeGiB !== p.volumeGiB || r.snapshotKmsKeyArn !== p.deployment.dataKeyArn)
        throw new Error('snapshot_identity_mismatch');
    const times = [p.createdAt, r.fencedAt, r.snapshotStartedAt, r.snapshotCompletedAt, r.verifiedAt].map(Date.parse);
    if (!Number.isFinite(now.getTime()) || times[4]! - times[0]! > 7200000 || times.some((v, n) => v > now.getTime() || (n > 0 && v < times[n - 1]!))) throw new Error('snapshot_not_fresh');
    return r;
}
