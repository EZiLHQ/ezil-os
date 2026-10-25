import assert from 'node:assert/strict';
import { recoveryDefinition } from '../lib/lifecycle/recovery-definition.js';
import { restoreToken } from '../lib/lifecycle/recovery-contract.js';
import { runAsl, taskError } from './asl.js';
import type { Instance, Volume } from '@aws-sdk/client-ec2';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { SettingsSchema, tagList, tagsFor, token } from '../lib/lifecycle/contract.js';
import { preparationReceipt } from '../lib/lifecycle/preparation-evidence.js';
import { ImageRecoveryDocumentSchema, imageRecoveryControl, machineArn, restoreTags } from '../lib/lifecycle/recovery-contract.js';
import type { RecoveryDependencies } from '../lib/lifecycle/recovery-aws.js';
import { createRecoveryHelper } from '../lib/lifecycle/recovery-helper.js';
import { preparationFixture } from './preparation-fixture.js';
import { envelopeFor, rebindFixture } from './rebase-fixture.js';

export function imageRecoveryFixture(f = preparationFixture(), rebind = rebindFixture()) {
    const p = f.preparation;
    f.state.now = Date.parse('2026-10-22T11:05:00.000Z');
    const snapshot = f.snapshot(); f.state.snapshots.push(snapshot);
    const receipt = preparationReceipt(p, f.preparationEnvelope.digest, snapshot, '2026-10-22T11:01:00.000Z',
        '2026-10-22T11:09:00.000Z', '2026-10-22T11:09:00.000Z');
    Object.assign(f.state.executions[f.reference.executionArn]!, { status: 'SUCCEEDED', output: JSON.stringify(receipt), stopDate: new Date('2026-10-22T11:10:00.000Z') });
    const launch = structuredClone(f.intent), lease = structuredClone(f.lease);
    launch.jobId = '44444444-4444-4444-8444-444444444444'; launch.fenceToken = '55555555-5555-4555-8555-555555555555';
    Object.assign(lease.rebasePermit, { launchJobId: launch.jobId, fenceToken: launch.fenceToken,
        issuedAt: '2026-10-22T11:40:00.000Z', expiresAt: '2026-10-22T11:50:00.000Z' });
    launch.userData = Buffer.from(JSON.stringify(lease)).toString('base64');
    const launchEnvelope = envelopeFor(launch), sourceExecutionArn = machineArn(launch.deployment.stateMachineVersionArn).replace(':stateMachine:', ':execution:') + ':computer-' + launch.jobId;
    f.state.executions[sourceExecutionArn] = { executionArn: sourceExecutionArn, stateMachineArn: machineArn(launch.deployment.stateMachineVersionArn),
        stateMachineVersionArn: launch.deployment.stateMachineVersionArn, name: 'computer-' + launch.jobId, status: 'FAILED', redriveCount: 0,
        input: JSON.stringify(launchEnvelope), startDate: new Date('2026-10-22T11:40:00.000Z'), stopDate: new Date('2026-10-22T11:50:00.000Z') };
    f.instance.State = { Name: 'terminated' }; f.instance.BlockDeviceMappings = [];
    const writer: Instance = { InstanceId: 'i-22222222222222222', ImageId: launch.deployment.amiId,
        ClientToken: token(launchEnvelope.digest, 'instance'), State: { Name: 'running' }, SubnetId: launch.deployment.subnetId,
        Placement: { AvailabilityZoneId: launch.deployment.zoneId }, RootDeviceName: '/dev/sda1', Tags: tagList(tagsFor(launch)),
        BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeId: 'vol-00000000000000000', Status: 'attached', DeleteOnTermination: true } },
            { DeviceName: '/dev/sdf', Ebs: { VolumeId: f.volume.VolumeId, Status: 'attached', DeleteOnTermination: false } }] };
    f.state.instances.push(writer);
    f.volume.Tags = tagList({ ...tagsFor(launch), 'ezil:backup': p.deployment.namespace });
    f.volume.Attachments = [{ InstanceId: writer.InstanceId, VolumeId: f.volume.VolumeId, Device: '/dev/sdf', State: 'attached', DeleteOnTermination: false }];
    const document = ImageRecoveryDocumentSchema.parse({ schemaVersion: 1, jobId: rebind.lease.ebsRestore.recoveryJobId,
        imageJobId: p.jobId, sourceExecutionArn, rebasePreparation: f.reference, computerId: p.computerId,
        originalVolumeId: p.sourceVolumeId, fsUuid: p.fsUuid, sourceGeneration: p.sourceGeneration,
        sourceLeaseEpoch: p.sourceLeaseEpoch, sourceFenceToken: p.sourceFenceToken, fromDigest: p.fromDigest,
        snapshotId: snapshot.SnapshotId, deployment: rebind.intent.deployment, createdAt: '2026-10-22T11:51:00.000Z' });
    const envelope = envelopeFor(document), recoveryVersionArn = document.deployment.recoveryStateMachineVersionArn!;
    const executionArn = machineArn(recoveryVersionArn).replace(':stateMachine:', ':execution:') + ':computer-' + document.jobId;
    f.state.now = Date.parse(document.createdAt);
    f.state.executions[executionArn] = { executionArn, stateMachineArn: machineArn(recoveryVersionArn), stateMachineVersionArn: recoveryVersionArn,
        name: 'computer-' + document.jobId, status: 'RUNNING', redriveCount: 0, startDate: new Date(f.state.now), input: JSON.stringify(envelope) };
    const history: HistoryEvent[] = [{ id: 1, type: 'ExecutionStarted', timestamp: new Date('2026-10-22T11:40:00.000Z') },
        { id: 2, type: 'TaskStateEntered', stateEnteredEventDetails: { name: 'runInstances' }, timestamp: new Date('2026-10-22T11:41:00.000Z') },
        { id: 3, type: 'ExecutionFailed', timestamp: new Date('2026-10-22T11:50:00.000Z') }];
    const deps: RecoveryDependencies = { ...f.deps, history: async () => structuredClone(history),
        template: async (id, version) => ({ LaunchTemplateId: id, VersionNumber: Number(version), LaunchTemplateData: {
            ImageId: document.deployment.amiId, SecurityGroupIds: [document.deployment.securityGroupId], BlockDeviceMappings: [{ DeviceName: '/dev/sda1' }] } }),
        restoredVolumes: async tags => structuredClone(f.state.volumes.filter(v => Object.entries(tags).every(([key, value]) => v.Tags?.some(t => t.Key === key && t.Value === value)))) };
    const settings = { lifecycle: f.settings, recoveryVersionArn };
    const restored = (): Volume => ({ VolumeId: rebind.intent.dataVolumeId!, SnapshotId: document.snapshotId, VolumeType: 'gp3', Size: p.volumeGiB,
        Iops: 3000, Throughput: 125, Encrypted: true, KmsKeyId: document.deployment.dataKeyArn, AvailabilityZoneId: document.deployment.zoneId,
        State: 'available', MultiAttachEnabled: false, Attachments: [], CreateTime: new Date(f.state.now), Tags: tagList(restoreTags(document)) });
    const helper = createRecoveryHelper(settings, deps);
    const event = { mode: 'image', executionArn, phase: 'initial', control: structuredClone(imageRecoveryControl) };
    return { f, rebind, document, envelope, launch, launchEnvelope, sourceExecutionArn, executionArn, settings, deps, history, writer, restored, helper, event };
}

export async function runImageRecovery(options: { lost?: boolean; invisibleOnce?: boolean; duplicate?: boolean; pending?: boolean } = {}, f = imageRecoveryFixture()) {
    const calls: { name: string; parameters: any }[] = [];
    const result = await runAsl(recoveryDefinition('observer:1', true), { input: f.envelope, executionArn: f.executionArn,
        sleep: seconds => { f.f.state.now += seconds * 1000; }, invoke: async (_resource, parameters, name) => {
            if (name.startsWith('ImageObserve-')) return f.helper(parameters);
            calls.push({ name, parameters });
            if (name === 'Image-stop-target') { f.writer.State = { Name: 'stopped' }; return {}; }
            if (name === 'Image-terminate-target') { f.writer.State = { Name: 'terminated' }; f.writer.BlockDeviceMappings = [];
                f.f.volume.State = 'available'; f.f.volume.Attachments = []; return {}; }
            assert.equal(name, 'Image-createVolume');
            assert.equal(f.writer.State?.Name, 'terminated'); assert.equal(f.f.volume.Attachments!.length, 0);
            assert.equal(parameters.ClientToken, restoreToken(f.document));
            if (options.invisibleOnce && calls.filter(c => c.name === name).length === 1) throw taskError('States.Timeout');
            const v = f.restored(); if (options.pending) v.State = 'creating';
            f.f.state.volumes.push(v);
            if (options.duplicate) f.f.state.volumes.push({ ...v, VolumeId: 'vol-33333333333333333' });
            if (options.lost) throw taskError('States.Timeout');
            return { VolumeId: v.VolumeId };
        }, maxSteps: options.pending ? 5000 : 120 });
    return { ...f, calls, result };
}
