import { recoveryDeploymentFor } from './deployment.js';
import type { Volume } from '@aws-sdk/client-ec2';
import type { Dependencies } from './aws.js';
import { EnvelopeSchema, equal, tagsFor } from './contract.js';
import { parseLifecycleWork } from './intent.js';
import { parseLease } from './lease.js';
import { tagged } from './helper.js';
import { verifyPreparation } from './preparation-evidence.js';
import { restoreTags, type ImageRecoveryDocument } from './recovery-contract.js';
import { strictJson } from './strict-json.js';

export async function verifyImageRecoverySource(i: ImageRecoveryDocument, deps: Pick<Dependencies, 'execution' | 'snapshots' | 'now'>) {
    const preparation = await verifyPreparation(i.rebasePreparation, i.deployment.preparationStateMachineVersionArn!, deps);
    const p = preparation.document, receipt = preparation.receipt;
    if (!equal(i.deployment, recoveryDeploymentFor(p.sourceDeployment, p.deployment))
        || i.imageJobId !== p.jobId || i.computerId !== p.computerId || i.originalVolumeId !== p.sourceVolumeId
        || i.fsUuid !== p.fsUuid || i.sourceGeneration !== p.sourceGeneration || i.sourceLeaseEpoch !== p.sourceLeaseEpoch
        || i.sourceFenceToken !== p.sourceFenceToken || i.fromDigest !== p.fromDigest || i.snapshotId !== receipt.snapshotId
        || (['accountId', 'region', 'namespace', 'zoneId', 'dataKeyArn'] as const).some(k => i.deployment[k] !== p.deployment[k])
        || i.deployment.lowerImageDigest !== p.fromDigest || p.volumeGiB < i.deployment.storage.dataMinGiB
        || p.volumeGiB > i.deployment.storage.dataMaxGiB) throw new Error('restore_lineage_mismatch');
    const source = await deps.execution(i.sourceExecutionArn), version = p.deployment.stateMachineVersionArn;
    const machine = version.replace(/:[1-9][0-9]*$/, '');
    if (source.executionArn !== i.sourceExecutionArn || source.stateMachineArn !== machine || source.stateMachineVersionArn !== version
        || source.stateMachineAliasArn || source.redriveCount !== 0 || !['FAILED', 'TIMED_OUT', 'ABORTED'].includes(source.status ?? '')
        || !source.startDate || !source.stopDate || !source.input) throw new Error('restore_lineage_mismatch');
    const envelope = EnvelopeSchema.parse(strictJson(source.input, 20000));
    const launch = parseLifecycleWork({ ...envelope, createdAt: source.startDate });
    const lease = parseLease(launch.userData ?? '');
    if (launch.operation !== 'replace' || !lease.rebase || lease.ebsRestore || !equal(launch.rebasePreparation, i.rebasePreparation)
        || !equal(launch.deployment, p.deployment) || launch.computerId !== p.computerId || launch.dataVolumeId !== p.sourceVolumeId
        || launch.previousInstanceId !== p.sourceInstanceId || launch.previousGeneration !== p.sourceGeneration
        || launch.previousFenceToken !== p.sourceFenceToken || lease.fsUuid !== p.fsUuid
        || lease.rebase.snapshotId !== receipt.snapshotId || launch.leaseEpoch <= p.sourceLeaseEpoch
        || launch.jobId === i.jobId || launch.jobId === p.jobId || source.name !== 'computer-' + launch.jobId
        || source.executionArn !== machine.replace(':stateMachine:', ':execution:') + ':' + source.name
        || Date.parse(lease.rebasePermit!.issuedAt) < preparation.stoppedAt) throw new Error('restore_lineage_mismatch');
    const times = [preparation.stoppedAt, source.startDate.getTime(), source.stopDate.getTime(), Date.parse(i.createdAt), deps.now()];
    if (times.some((t, index) => !Number.isFinite(t) || (index > 0 && t < times[index - 1]!))) throw new Error('restore_lineage_mismatch');
    return { preparation, launch, envelope, source };
}

export function assertRestoredVolume(v: Volume, i: ImageRecoveryDocument, size: number, now: number,
    targetTags?: Record<string, string>) {
    const tags = restoreTags(i), originalTags = tagged(v.Tags, tags);
    const movedTags = targetTags && tagged(v.Tags, { ...tags, ...targetTags });
    if (!/^vol-[0-9a-f]{17}$/.test(v.VolumeId ?? '') || v.VolumeId === i.originalVolumeId || v.SnapshotId !== i.snapshotId
        || v.VolumeType !== 'gp3' || v.Size !== size || v.Iops !== 3000 || v.Throughput !== 125
        || v.Encrypted !== true || v.KmsKeyId !== i.deployment.dataKeyArn || v.AvailabilityZoneId !== i.deployment.zoneId
        || v.MultiAttachEnabled !== false || !Array.isArray(v.Attachments) || (!originalTags && !movedTags)
        || v.Tags?.length !== Object.keys(tags).length || !v.CreateTime || !Number.isFinite(v.CreateTime.getTime())
        || v.CreateTime.getTime() < Date.parse(i.createdAt) || v.CreateTime.getTime() > now)
        throw new Error('restore_lineage_mismatch');
}

export function assertQuarantinedVolume(v: Volume, i: ImageRecoveryDocument, failed: Awaited<ReturnType<typeof verifyImageRecoverySource>>, available = true) {
    const p = failed.preparation.document;
    if (v.VolumeId !== i.originalVolumeId || v.Size !== p.volumeGiB || v.VolumeType !== 'gp3' || v.Encrypted !== true
        || v.KmsKeyId !== i.deployment.dataKeyArn || v.AvailabilityZoneId !== i.deployment.zoneId || v.MultiAttachEnabled !== false
        || !Array.isArray(v.Attachments) || v.Tags?.some(t => t.Key === 'ezil:pool')
        || !tagged(v.Tags, { 'ezil:backup': i.deployment.namespace })
        || (!tagged(v.Tags, tagsFor(failed.launch)) && !tagged(v.Tags, tagsFor(failed.launch, p.sourceGeneration, p.sourceFenceToken)))
        || (available && (v.State !== 'available' || v.Attachments.length !== 0))) throw new Error('restore_lineage_mismatch');
}
