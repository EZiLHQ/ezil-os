import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleDeploymentSchema, RebasePreparationReferenceSchema } from './aws-intent';
import { RebaseCounter, RebaseDigest, RebaseHash, RebaseSnapshot, RebaseTime, RebaseUuid, RebaseVolume, parseRebaseJson } from './aws-rebase-json';
import { assertImageExecution, type Execution } from './aws-rebase-evidence';
import type { Ec2VolumeView } from './aws-clients';
import type { ImageJob } from './aws-rebase-store';
const execution = z.string().max(300).regex(/^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]{1,80}:computer-[0-9a-f-]{36}$/);
export const ImageRecoverySchema = z.object({ schemaVersion: z.literal(1), jobId: RebaseUuid, imageJobId: RebaseUuid,
    sourceExecutionArn: execution, rebasePreparation: RebasePreparationReferenceSchema, computerId: RebaseUuid,
    originalVolumeId: RebaseVolume, fsUuid: RebaseUuid, sourceGeneration: RebaseCounter, sourceLeaseEpoch: RebaseCounter,
    sourceFenceToken: RebaseUuid, fromDigest: RebaseDigest, snapshotId: RebaseSnapshot, deployment: LifecycleDeploymentSchema, createdAt: RebaseTime }).strict();
export type ImageRecovery = z.infer<typeof ImageRecoverySchema>;
export function buildImageRecovery(raw: ImageRecovery) {
    const intent = ImageRecoverySchema.parse(raw);
    if (intent.fromDigest !== intent.deployment.lowerImageDigest || !intent.deployment.recoveryStateMachineVersionArn
        || intent.jobId === intent.imageJobId || intent.rebasePreparation.preparationJobId !== intent.imageJobId) throw new Error('restore_lineage_mismatch');
    const document = JSON.stringify(intent), digest = createHash('sha256').update(document).digest('hex');
    const input = JSON.stringify({ schemaVersion: 1, document, digest });
    if (Buffer.byteLength(document) > 16384 || Buffer.byteLength(input) > 20000) throw new Error('restore_lineage_mismatch');
    const stateMachineArn = intent.deployment.recoveryStateMachineVersionArn, name = `computer-${intent.jobId}`;
    return { intent, document, digest, input, stateMachineArn, name,
        executionArn: stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${name}`) };
}
export const recoveryFor = (j: ImageJob) => buildImageRecovery(parseRebaseJson(j.recoveryDocument!) as ImageRecovery);
export const ImageRestoreReceiptSchema = z.object({ schemaVersion: z.literal(1), jobId: RebaseUuid, digest: RebaseHash,
    imageJobId: RebaseUuid, state: z.literal('restore_volume_ready'), sourceExecutionArn: execution, snapshotId: RebaseSnapshot,
    originalVolumeId: RebaseVolume, volumeId: RebaseVolume, fsUuid: RebaseUuid, sourceGeneration: RebaseCounter,
    sourceLeaseEpoch: RebaseCounter, sourceFenceToken: RebaseUuid, fromDigest: RebaseDigest, verifiedAt: RebaseTime }).strict();
export function verifyImageRestore(j: ImageJob, e: Execution, v: Ec2VolumeView | null, original: Ec2VolumeView | null, now: Date) {
    const w = recoveryFor(j); assertImageExecution(e, w);
    if (e.status !== 'SUCCEEDED') throw new Error('restore_failed');
    const r = ImageRestoreReceiptSchema.parse(parseRebaseJson(e.output ?? '', 8192));
    if (r.digest !== w.digest || r.volumeId === j.sourceVolumeId || (['jobId', 'imageJobId', 'sourceExecutionArn', 'snapshotId',
        'originalVolumeId', 'fsUuid', 'sourceGeneration', 'sourceLeaseEpoch', 'sourceFenceToken', 'fromDigest'] as const).some(k => r[k] !== w.intent[k])
        || Date.parse(r.verifiedAt) < Date.parse(w.intent.createdAt) || Date.parse(r.verifiedAt) > now.getTime()) throw new Error('restore_lineage_mismatch');
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': w.intent.deployment.namespace, 'ezil:computer-id': j.computerId,
        'ezil:generation': String(j.sourceGeneration), 'ezil:fence-token': j.sourceFenceToken, 'ezil:backup': w.intent.deployment.namespace,
        'ezil:restored-from-snapshot': j.snapshotId!, 'ezil:original-volume-id': j.sourceVolumeId, 'ezil:recovery-job-id': j.recoveryJobId! };
    if (!v || v.volumeId !== r.volumeId || v.state !== 'available' || v.attachments?.length !== 0 || v.encrypted !== true
        || v.kmsKeyId !== w.intent.deployment.dataKeyArn || v.snapshotId !== j.snapshotId || v.zoneId !== j.zoneId || v.sizeGiB !== j.snapshotEvidence!.snapshotVolumeGiB
        || !v.tags || Object.entries(tags).some(([k, value]) => v.tags![k] !== value) || v.tags['ezil:pool'] !== undefined
        || !original || original.volumeId !== j.sourceVolumeId || original.state !== 'available' || original.attachments?.length !== 0
        || original.encrypted !== true || original.kmsKeyId !== w.intent.deployment.dataKeyArn || !original.tags
        || original.tags['ezil:managed-by'] !== tags['ezil:managed-by'] || original.tags['ezil:stage'] !== tags['ezil:stage']
        || original.tags['ezil:computer-id'] !== j.computerId || original.tags['ezil:backup'] !== w.intent.deployment.namespace || original.tags['ezil:pool'] !== undefined
        || ![[j.sourceGeneration, j.sourceFenceToken], [j.targetGeneration, j.targetFenceToken]].some(([generation, fence]) => original.tags!['ezil:generation'] === String(generation) && original.tags!['ezil:fence-token'] === fence)) throw new Error('restore_lineage_mismatch');
    return r;
}
export const MaintenanceReportSchema = z.object({ v: z.literal(1), recoveryJobId: RebaseUuid, snapshotId: RebaseSnapshot,
    originalVolumeId: RebaseVolume, volumeId: RebaseVolume, fsUuid: RebaseUuid }).strict();
