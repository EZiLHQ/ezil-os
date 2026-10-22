import { z } from 'zod';
import { buildLifecycleWork, type LifecycleWork } from './aws-intent';
import type { LifecycleExecutionReader } from './aws-receipts';
import type { Ec2EnrollmentView } from './aws-enroll';
import type { Ec2VolumeView } from './aws-clients';
import { buildRebasePreparation, validateRebaseSnapshotReceipt } from './aws-rebase-preparation';
import { parseRebaseJson, RebaseCounter, RebaseHash, RebaseUuid, RebaseVolume } from './aws-rebase-json';
import type { ImageJob } from './aws-rebase-store';

export interface RebaseSnapshotView {
    snapshotId: string; ownerId: string; volumeId: string; volumeGiB: number; state: string;
    encrypted: boolean; kmsKeyId: string; startedAt: Date; tags: Readonly<Record<string, string>>;
}
export interface RebaseSnapshotDescriber {
    describeSnapshot(region: string, snapshotId: string): Promise<RebaseSnapshotView | null>;
}
export const preparationFor = (j: ImageJob) => buildRebasePreparation(parseRebaseJson(j.preparationDocument) as Parameters<typeof buildRebasePreparation>[0]);
export const launchFor = (j: ImageJob, mode: 'launch' | 'rebind' = 'launch') => buildLifecycleWork(parseRebaseJson((mode === 'launch' ? j.launchDocument : j.rebindDocument)!) as LifecycleWork['intent']);
export type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
export function assertImageExecution(e: Execution, w: { input: string; stateMachineArn: string; name: string }) {
    const arn = w.stateMachineArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:${w.name}`);
    if (e.executionArn !== arn || e.stateMachineVersionArn !== w.stateMachineArn || e.stateMachineAliasArn || e.redriveCount !== 0
        || e.input !== w.input || !['RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED'].includes(e.status)) throw new Error('authority_revoked');
}
export function verifyImageSnapshot(j: ImageJob, e: Execution, v: RebaseSnapshotView | null, now: Date) {
    const p = preparationFor(j); assertImageExecution(e, p);
    if (e.status !== 'SUCCEEDED' || !e.output) throw new Error('snapshot_pending');
    const r = validateRebaseSnapshotReceipt(parseRebaseJson(e.output, 8192), p, now);
    if (!v) throw new Error('snapshot_missing');
    if (v.state === 'error') throw new Error('snapshot_error');
    if (v.state !== 'completed') throw new Error('snapshot_pending');
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': p.intent.deployment.namespace,
        'ezil:computer-id': j.computerId, 'ezil:source-volume-id': j.sourceVolumeId,
        'ezil:source-generation': String(j.sourceGeneration), 'ezil:source-fence-token': j.sourceFenceToken,
        'ezil:preparation-job-id': j.jobId, 'ezil:purpose': 'pre-rebase' };
    if (v.snapshotId !== r.snapshotId || v.volumeId !== j.sourceVolumeId || v.ownerId !== r.snapshotOwnerId
        || v.volumeGiB !== r.snapshotVolumeGiB || v.encrypted !== true || v.kmsKeyId !== r.snapshotKmsKeyArn
        || !Number.isFinite(v.startedAt.getTime()) || v.startedAt.toISOString() !== r.snapshotStartedAt
        || Object.keys(v.tags).length !== 8 || Object.entries(tags).some(([k, value]) => v.tags[k] !== value)) throw new Error('snapshot_identity_mismatch');
    return r;
}
export const ImageLaunchReceiptSchema = z.object({ schemaVersion: z.literal(1), jobId: RebaseUuid, digest: RebaseHash,
    computerId: RebaseUuid, generation: RebaseCounter, leaseEpoch: RebaseCounter, fenceToken: RebaseUuid,
    instanceId: z.string().regex(/^i-[0-9a-f]{17}$/), volumeId: RebaseVolume, state: z.literal('running') }).strict();
export type ImageLaunchReceipt = z.infer<typeof ImageLaunchReceiptSchema>;
export function verifyImageLaunch(j: ImageJob, e: Execution, host: Ec2EnrollmentView | null, volume: Ec2VolumeView | null, mode: 'launch' | 'rebind' = 'launch'): ImageLaunchReceipt {
    const w = launchFor(j, mode); assertImageExecution(e, w);
    if (e.status !== 'SUCCEEDED' || !e.output) throw new Error('launch_unconfirmed');
    const r = ImageLaunchReceiptSchema.parse(parseRebaseJson(e.output, 8192));
    if (r.jobId !== w.intent.jobId || r.digest !== w.digest || r.computerId !== j.computerId
        || r.generation !== w.intent.targetGeneration || r.leaseEpoch !== w.intent.leaseEpoch || r.fenceToken !== w.intent.fenceToken
        || r.volumeId !== w.intent.dataVolumeId) throw new Error('generation_drift');
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': w.intent.deployment.namespace,
        'ezil:computer-id': j.computerId, 'ezil:generation': String(r.generation), 'ezil:fence-token': r.fenceToken };
    const matches = (t: Readonly<Record<string, string>> | undefined) => t && t['ezil:pool'] === undefined && Object.entries(tags).every(([k, v]) => t[k] === v);
    if (!host || host.instanceId !== r.instanceId || host.state !== 'running' || host.availabilityZoneId !== j.zoneId
        || !matches(host.tags) || host.volumes.filter(v => v.volumeId === r.volumeId && v.deleteOnTermination === false).length !== 1
        || !volume || volume.volumeId !== r.volumeId || volume.state !== 'in-use' || !matches(volume.tags)
        || volume.tags?.['ezil:backup'] !== w.intent.deployment.namespace || volume.encrypted !== true || volume.kmsKeyId !== w.intent.deployment.dataKeyArn
        || volume.attachments?.length !== 1 || volume.attachments[0]!.instanceId !== r.instanceId || volume.attachments[0]!.state !== 'attached') throw new Error('generation_drift');
    return r;
}
