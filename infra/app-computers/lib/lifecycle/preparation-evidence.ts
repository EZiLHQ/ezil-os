import { recoveryDeploymentFor, type LifecycleDeployment } from './deployment.js';
import { equal } from './contract.js';
import { parseLease } from './lease.js';
import type { LifecycleIntent } from './intent.js';
import type { Snapshot } from '@aws-sdk/client-ec2';
import type { Dependencies } from './aws.js';
import { parsePreparationInput, preparationTags, PreparationReceiptSchema, REBASE_PREPARATION_TIMEOUT_SECONDS,
    type PreparationDocument, type PreparationReceipt } from './preparation-contract.js';
import { strictJson } from './strict-json.js';
import type { z } from 'zod';
import type { PreparationReferenceSchema } from './lease.js';

export function assertSnapshot(snapshot: Snapshot, i: PreparationDocument, fencedAt: string, now: number, completed = true): void {
    const tags = preparationTags(i), at = snapshot.StartTime?.getTime();
    if (!/^snap-[0-9a-f]{8,17}$/.test(snapshot.SnapshotId ?? '') || snapshot.OwnerId !== i.deployment.accountId
        || snapshot.VolumeId !== i.sourceVolumeId || snapshot.VolumeSize !== i.volumeGiB
        || snapshot.Encrypted !== true || snapshot.KmsKeyId !== i.deployment.dataKeyArn
        || snapshot.Tags?.length !== Object.keys(tags).length
        || Object.entries(tags).some(([key, value]) => snapshot.Tags!.filter(t => t.Key === key).length !== 1
            || snapshot.Tags!.find(t => t.Key === key)?.Value !== value)) throw new Error('snapshot_identity_mismatch');
    if (at === undefined || !Number.isFinite(at) || Date.parse(i.createdAt) > Date.parse(fencedAt)
        || at < Date.parse(fencedAt) || at > now || at - Date.parse(i.createdAt) > REBASE_PREPARATION_TIMEOUT_SECONDS * 1000)
        throw new Error('snapshot_not_fresh');
    if (snapshot.State === 'error') throw new Error('snapshot_error');
    if (snapshot.State !== 'completed' && (completed || snapshot.State !== 'pending')) throw new Error('snapshot_pending');
}

/** Re-read the pinned successful preparation and the actual snapshot on each
 * launch. The database launch authority separately proves the reservation is
 * still current; a document hash is never treated as a signature. */
export async function verifyPreparation(ref: z.infer<typeof PreparationReferenceSchema>, version: string, deps: Pick<Dependencies, 'execution' | 'snapshots' | 'now'>) {
    const machine = version.replace(/:[1-9][0-9]*$/, ''), expectedArn = machine.replace(':stateMachine:', ':execution:') + `:computer-${ref.preparationJobId}`;
    if (ref.executionArn !== expectedArn || !deps.snapshots) throw new Error('preparation_failed');
    const execution = await deps.execution(ref.executionArn), now = deps.now();
    if (execution.executionArn !== ref.executionArn || execution.stateMachineArn !== machine || execution.stateMachineVersionArn !== version
        || execution.stateMachineAliasArn || execution.redriveCount !== 0 || execution.name !== `computer-${ref.preparationJobId}`
        || execution.status !== 'SUCCEEDED' || !execution.input || !execution.output || !execution.startDate || !execution.stopDate)
        throw new Error('preparation_failed');
    const { envelope, document: i } = parsePreparationInput(execution.input);
    const receipt = PreparationReceiptSchema.parse(strictJson(execution.output, 8192));
    const start = execution.startDate.getTime(), stop = execution.stopDate.getTime();
    if (envelope.digest !== ref.digest || i.jobId !== ref.preparationJobId || i.deployment.preparationStateMachineVersionArn !== version
        || JSON.stringify(receipt) !== execution.output || receipt.digest !== ref.digest || receipt.jobId !== i.jobId
        || (['computerId', 'sourceInstanceId', 'sourceVolumeId', 'fsUuid', 'sourceGeneration', 'sourceLeaseEpoch', 'sourceFenceToken', 'fromDigest', 'toDigest'] as const)
            .some(key => receipt[key] !== i[key])
        || receipt.snapshotOwnerId !== i.deployment.accountId || receipt.snapshotVolumeGiB !== i.volumeGiB || receipt.snapshotKmsKeyArn !== i.deployment.dataKeyArn)
        throw new Error('snapshot_identity_mismatch');
    const times = [Date.parse(i.createdAt), start, Date.parse(receipt.fencedAt), Date.parse(receipt.snapshotStartedAt),
        Date.parse(receipt.snapshotCompletedAt), Date.parse(receipt.verifiedAt), stop, now];
    if (times.some((t, n) => !Number.isFinite(t) || (n > 0 && t < times[n - 1]!))
        || stop - start > REBASE_PREPARATION_TIMEOUT_SECONDS * 1000) throw new Error('snapshot_not_fresh');
    const snapshots = await deps.snapshots([receipt.snapshotId]);
    if (snapshots.length !== 1 || snapshots[0]!.SnapshotId !== receipt.snapshotId) throw new Error('snapshot_missing');
    assertSnapshot(snapshots[0]!, i, receipt.fencedAt, now);
    if (snapshots[0]!.StartTime!.toISOString() !== receipt.snapshotStartedAt) throw new Error('snapshot_not_fresh');
    return { document: i, receipt, stoppedAt: stop };
}

export function preparationReceipt(i: PreparationDocument, digest: string, snapshot: Snapshot, fencedAt: string,
    snapshotCompletedAt: string, verifiedAt: string): PreparationReceipt {
    return PreparationReceiptSchema.parse({ schemaVersion: 1, jobId: i.jobId, digest, computerId: i.computerId, state: 'snapshot_ready',
        sourceInstanceId: i.sourceInstanceId, sourceVolumeId: i.sourceVolumeId, fsUuid: i.fsUuid,
        sourceGeneration: i.sourceGeneration, sourceLeaseEpoch: i.sourceLeaseEpoch, sourceFenceToken: i.sourceFenceToken,
        fromDigest: i.fromDigest, toDigest: i.toDigest, snapshotId: snapshot.SnapshotId,
        snapshotOwnerId: snapshot.OwnerId, snapshotVolumeGiB: snapshot.VolumeSize, snapshotKmsKeyArn: snapshot.KmsKeyId,
        fencedAt, snapshotStartedAt: snapshot.StartTime!.toISOString(), snapshotCompletedAt, verifiedAt });
}

/** Only maintenance rebind may use a source AMI under the current workflow.
 * Verify the authoritative preparation before admitting that deployment. */
export async function matchesLifecycleDeployment(i: LifecycleIntent, configured: LifecycleDeployment,
    deps: Pick<Dependencies, 'execution' | 'snapshots' | 'now'>): Promise<boolean> {
    if (equal(i.deployment, configured)) return true;
    if (!i.rebasePreparation || !i.userData || !parseLease(i.userData).ebsRestore || !configured.preparationStateMachineVersionArn
        || i.deployment.stateMachineVersionArn !== configured.stateMachineVersionArn) return false;
    const { document: p } = await verifyPreparation(i.rebasePreparation, configured.preparationStateMachineVersionArn, deps);
    return equal(p.deployment, configured) && equal(i.deployment, recoveryDeploymentFor(p.sourceDeployment, p.deployment));
}
