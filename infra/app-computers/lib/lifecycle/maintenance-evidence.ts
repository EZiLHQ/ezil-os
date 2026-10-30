import type { Volume } from '@aws-sdk/client-ec2';
import type { Dependencies } from './aws.js';
import { equal, tagsFor, token } from './contract.js';
import type { LifecycleIntent } from './intent.js';
import { assertPermitTime, parseLease } from './lease.js';
import { ImageRecoveryReceiptSchema, machineArn, parseImageRecoveryInput } from './recovery-contract.js';
import { assertQuarantinedVolume, assertRestoredVolume, verifyImageRecoverySource } from './image-recovery-evidence.js';
import { strictJson } from './strict-json.js';
import { tagged } from './helper.js';

/** The successful recovery is the positive fence/quarantine receipt. Re-read
 * the failed disk and all visible historical writers before each new mutation;
 * image-job rebind authority separately proves durable DB custody/quarantine. */
export async function verifyMaintenance(i: LifecycleIntent, volume: Volume, deps: Dependencies, beforeLaunch = false) {
    const lease = parseLease(i.userData!), permit = lease.ebsRestore, d = i.deployment;
    if (!permit || !i.rebasePreparation || !d.recoveryStateMachineVersionArn) throw new Error('restore_lineage_mismatch');
    const machine = machineArn(d.recoveryStateMachineVersionArn), arn = machine.replace(':stateMachine:', ':execution:') + ':computer-' + permit.recoveryJobId;
    const execution = await deps.execution(arn);
    if (execution.executionArn !== arn || execution.stateMachineArn !== machine || execution.stateMachineVersionArn !== d.recoveryStateMachineVersionArn
        || execution.stateMachineAliasArn || execution.redriveCount !== 0 || execution.status !== 'SUCCEEDED'
        || execution.name !== 'computer-' + permit.recoveryJobId || !execution.input || !execution.output || !execution.startDate || !execution.stopDate)
        throw new Error('restore_lineage_mismatch');
    const { document: recovery, envelope } = parseImageRecoveryInput(execution.input);
    const receipt = ImageRecoveryReceiptSchema.parse(strictJson(execution.output, 8192));
    if (JSON.stringify(receipt) !== execution.output || receipt.digest !== envelope.digest || receipt.volumeId !== volume.VolumeId
        || recovery.jobId !== permit.recoveryJobId || recovery.imageJobId !== permit.preparationJobId
        || !equal(recovery.rebasePreparation, i.rebasePreparation) || !equal(recovery.deployment, d)
        || recovery.computerId !== i.computerId || recovery.fsUuid !== lease.fsUuid || recovery.originalVolumeId !== permit.originalVolumeId
        || recovery.snapshotId !== permit.snapshotId || recovery.fromDigest !== permit.fromDigest
        || recovery.sourceGeneration !== permit.sourceGeneration || recovery.sourceLeaseEpoch !== permit.sourceLeaseEpoch
        || recovery.sourceFenceToken !== i.previousFenceToken
        || (['jobId', 'imageJobId', 'sourceExecutionArn', 'snapshotId', 'originalVolumeId', 'fsUuid', 'sourceGeneration', 'sourceLeaseEpoch', 'sourceFenceToken', 'fromDigest'] as const)
            .some(k => receipt[k] !== recovery[k])) throw new Error('restore_lineage_mismatch');
    const times = [Date.parse(recovery.createdAt), execution.startDate.getTime(), Date.parse(receipt.verifiedAt), execution.stopDate.getTime(), Date.parse(permit.issuedAt)];
    if (times.some((t, n) => !Number.isFinite(t) || (n > 0 && t < times[n - 1]!)) || execution.stopDate.getTime() > deps.now()
        || execution.stopDate.getTime() - execution.startDate.getTime() > 7200000) throw new Error('restore_lineage_mismatch');
    const failed = await verifyImageRecoverySource(recovery, deps), p = failed.preparation.document;
    if (i.previousInstanceId !== p.sourceInstanceId || i.previousGeneration !== p.sourceGeneration
        || i.targetGeneration <= failed.launch.targetGeneration || i.leaseEpoch <= failed.launch.leaseEpoch
        || i.jobId === failed.launch.jobId || i.fenceToken === failed.launch.fenceToken || i.fenceToken === p.sourceFenceToken)
        throw new Error('restore_lineage_mismatch');
    const originals = await deps.volumes([recovery.originalVolumeId]);
    if (originals.length !== 1) throw new Error('restore_lineage_mismatch');
    assertQuarantinedVolume(originals[0]!, recovery, failed);
    for (const [selector, expectedTags, expectedId] of [
        [[p.sourceInstanceId], tagsFor(failed.launch, p.sourceGeneration, p.sourceFenceToken), p.sourceInstanceId],
        [{ token: token(failed.envelope.digest, 'instance') }, tagsFor(failed.launch), undefined],
    ] as const) {
        const rows = await deps.instances(Array.isArray(selector) ? [...selector] : selector as { token: string });
        if (rows.length > 1 || rows.some(row => row.owner !== d.accountId || row.instance.State?.Name !== 'terminated'
            || (expectedId && row.instance.InstanceId !== expectedId) || !tagged(row.instance.Tags, expectedTags)
            || (!expectedId && row.instance.ClientToken !== token(failed.envelope.digest, 'instance')))) throw new Error('writer_not_fenced');
    }
    assertRestoredVolume(volume, recovery, p.volumeGiB, deps.now(), tagsFor(i));
    if (volume.CreateTime!.getTime() > Date.parse(receipt.verifiedAt) || (beforeLaunch && (volume.State !== 'available' || volume.Attachments!.length)))
        throw new Error('restore_lineage_mismatch');
    assertPermitTime(lease, deps.now());
    return failed.preparation;
}
