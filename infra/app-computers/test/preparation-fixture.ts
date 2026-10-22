import type { Instance, Snapshot, Volume } from '@aws-sdk/client-ec2';
import type { DescribeExecutionOutput } from '@aws-sdk/client-sfn';
import type { Dependencies } from '../lib/lifecycle/aws.js';
import { SettingsSchema, tagList } from '../lib/lifecycle/contract.js';
import { preparationSourceTags, preparationTags } from '../lib/lifecycle/preparation-contract.js';
import { rebaseFixture } from './rebase-fixture.js';

export function preparationFixture(f = rebaseFixture()) {
    const i = f.preparation, d = i.deployment;
    const state = { now: Date.parse(i.createdAt), authorized: true, authorityCalls: 0,
        instances: [] as Instance[], volumes: [] as Volume[], snapshots: [] as Snapshot[], executions: {} as Record<string, DescribeExecutionOutput> };
    const root = { DeviceName: '/dev/sda1', Ebs: { VolumeId: 'vol-00000000000000000', Status: 'attached' as const, DeleteOnTermination: true } };
    const instance: Instance = { InstanceId: i.sourceInstanceId, State: { Name: 'running' }, ImageId: i.sourceDeployment.amiId,
        SubnetId: d.subnetId, Placement: { AvailabilityZoneId: d.zoneId }, RootDeviceName: '/dev/sda1',
        Tags: tagList(Object.fromEntries(Object.entries(preparationSourceTags(i)).filter(([k]) => k !== 'ezil:backup'))),
        BlockDeviceMappings: [root, { DeviceName: '/dev/sdf', Ebs: { VolumeId: i.sourceVolumeId, Status: 'attached', DeleteOnTermination: false } }] };
    const volume: Volume = { VolumeId: i.sourceVolumeId, State: 'in-use', VolumeType: 'gp3', Size: i.volumeGiB, Encrypted: true,
        KmsKeyId: d.dataKeyArn, MultiAttachEnabled: false, AvailabilityZoneId: d.zoneId, Tags: tagList(preparationSourceTags(i)),
        Attachments: [{ InstanceId: i.sourceInstanceId, VolumeId: i.sourceVolumeId, Device: '/dev/sdf', State: 'attached', DeleteOnTermination: false }] };
    state.instances.push(instance); state.volumes.push(volume);
    state.executions[f.reference.executionArn] = { executionArn: f.reference.executionArn,
        stateMachineArn: d.preparationStateMachineVersionArn!.replace(/:1$/, ''), stateMachineVersionArn: d.preparationStateMachineVersionArn,
        name: 'computer-' + i.jobId, status: 'RUNNING', startDate: new Date(state.now), redriveCount: 0, input: JSON.stringify(f.preparationEnvelope) };
    const settings = SettingsSchema.parse({ deployment: d, authorityOrigin: 'https://control.example',
        authoritySecretArn: 'arn:aws:secretsmanager:ap-south-1:123456789012:secret:ezil/pilot/lifecycle-key-abcdef' });
    const deps: Dependencies = { now: () => state.now, execution: async arn => structuredClone(state.executions[arn]!),
        authority: async () => { state.authorityCalls++; return state.authorized; },
        imageAuthority: async () => { state.authorityCalls++; return state.authorized; },
        instances: async ids => state.instances.filter(v => Array.isArray(ids) ? ids.includes(v.InstanceId!) : v.ClientToken === ids.token).map(instance => ({ instance: structuredClone(instance), owner: d.accountId })),
        volumes: async ids => structuredClone(state.volumes.filter(v => Array.isArray(ids) && ids.includes(v.VolumeId!))),
        snapshots: async selector => structuredClone(state.snapshots.filter(v => Array.isArray(selector) ? selector.includes(v.SnapshotId!)
            : Object.entries(selector.tags).every(([key, value]) => v.Tags?.some(t => t.Key === key && t.Value === value)))),
        image: async id => ({ ImageId: id, State: 'available', Architecture: 'x86_64', RootDeviceType: 'ebs', RootDeviceName: '/dev/sda1',
            VirtualizationType: 'hvm', BlockDeviceMappings: [{ DeviceName: '/dev/sda1', Ebs: { VolumeSize: 20 } }] }),
        template: async (id, version) => ({ LaunchTemplateId: id, VersionNumber: Number(version), LaunchTemplateData: {
            ImageId: d.amiId, SecurityGroupIds: [d.securityGroupId], BlockDeviceMappings: [{ DeviceName: '/dev/sda1' }] } }),
    };
    const snapshot = (): Snapshot => ({ SnapshotId: f.lease.rebase.snapshotId, OwnerId: d.accountId, VolumeId: i.sourceVolumeId,
        VolumeSize: i.volumeGiB, Encrypted: true, KmsKeyId: d.dataKeyArn, StartTime: new Date(state.now), State: 'completed', Tags: tagList(preparationTags(i)) });
    return { ...f, state, settings, deps, instance, volume, snapshot };
}
