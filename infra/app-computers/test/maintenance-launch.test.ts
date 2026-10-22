import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { tagList, tagsFor, token } from '../lib/lifecycle/contract.js';
import { machineArn } from '../lib/lifecycle/recovery-contract.js';
import { runImageRecovery } from './image-recovery-fixture.js';
import { envelopeFor } from './rebase-fixture.js';

async function maintenanceFixture() {
    const f = await runImageRecovery();
    Object.assign(f.f.state.executions[f.executionArn]!, { status: 'SUCCEEDED', output: JSON.stringify(f.result.output), stopDate: new Date(f.f.state.now) });
    const i = f.rebind.intent, machine = machineArn(i.deployment.stateMachineVersionArn);
    const executionArn = machine.replace(':stateMachine:', ':execution:') + ':computer-' + i.jobId;
    f.f.state.now = Date.parse(f.rebind.lease.ebsRestore.issuedAt);
    f.f.state.executions[executionArn] = { executionArn, stateMachineArn: machine, stateMachineVersionArn: i.deployment.stateMachineVersionArn,
        name: 'computer-' + i.jobId, input: JSON.stringify(f.rebind.envelope), status: 'RUNNING', redriveCount: 0, startDate: new Date(f.f.state.now) };
    const deps = { ...f.f.deps, template: f.deps.template! };
    const helper = createLifecycleHelper({ ...f.f.settings, deployment: i.deployment }, deps);
    const volume = f.f.state.volumes.find(v => v.VolumeId === i.dataVolumeId)!;
    return { ...f, i, volume, deps, helper, maintenanceExecutionArn: executionArn,
        call: () => helper({ executionArn, phase: 'initial' }) };
}
test('real maintenance fixture launches the retained source lower on the different restored volume', async () => {
    const f = await maintenanceFixture(), result = await f.call();
    assert.equal(result.decision, 'runInstances');
    const parameters = result.parameters as any;
    assert.equal(parameters.UserData, f.i.userData); assert.equal(parameters.ImageId, f.document.deployment.amiId);
    assert.equal(f.volume.Tags!.find(t => t.Key === 'ezil:generation')!.Value, String(f.document.sourceGeneration));
    assert.equal(f.f.volume.VolumeId, f.document.originalVolumeId); assert.equal(f.f.volume.Attachments!.length, 0);
});
const mutations: Record<string, (f: Awaited<ReturnType<typeof maintenanceFixture>>) => void> = {
    'unsuccessful recovery': f => { f.f.state.executions[f.executionArn]!.status = 'RUNNING'; },
    'redriven recovery': f => { f.f.state.executions[f.executionArn]!.redriveCount = 1; },
    'wrong recovered volume': f => { const e = f.f.state.executions[f.executionArn]!; e.output = JSON.stringify({ ...JSON.parse(e.output!), volumeId: f.document.originalVolumeId }); },
    'pending snapshot': f => { f.f.state.snapshots[0]!.State = 'pending'; },
    'wrong snapshot lineage': f => { f.volume.SnapshotId = 'snap-99999999999999999'; },
    'wrong encryption key': f => { f.volume.KmsKeyId = 'foreign'; },
    'wrong size': f => { f.volume.Size = 21; },
    'wrong AZ': f => { f.volume.AvailabilityZoneId = 'aps1-az2'; },
    'missing lineage tag': f => { f.volume.Tags!.pop(); },
    'duplicate identity tag': f => { f.volume.Tags!.push(f.volume.Tags![0]!); },
    'attached clone': f => { f.volume.Attachments = [{ InstanceId: 'i-99999999999999999' }]; },
    'failed writer still alive': f => { f.writer.State = { Name: 'running' }; },
    'original no longer quarantined': f => { f.f.volume.State = 'in-use'; f.f.volume.Attachments = [{ InstanceId: f.writer.InstanceId }]; },
    'expired permit': f => { f.f.state.now += 600000; },
    'stale DB authority': f => { f.f.state.authorized = false; },
};
for (const [label, mutate] of Object.entries(mutations)) test('maintenance refuses ' + label, async () => {
    const f = await maintenanceFixture(); mutate(f); await assert.rejects(f.call());
});
test('maintenance epoch must exceed the failed launch epoch as well as the snapshot epoch', async () => {
    const f = await maintenanceFixture();
    const lease = structuredClone(f.rebind.lease); lease.leaseEpoch = f.launch.leaseEpoch; lease.ebsRestore.leaseEpoch = lease.leaseEpoch;
    const i = { ...f.i, leaseEpoch: lease.leaseEpoch, userData: Buffer.from(JSON.stringify(lease)).toString('base64') };
    f.f.state.executions[f.maintenanceExecutionArn]!.input = JSON.stringify(envelopeFor(i));
    await assert.rejects(f.call(), /restore_lineage_mismatch/);
});
test('maintenance rechecks recovery evidence after template reads and before RunInstances', async () => {
    const f = await maintenanceFixture(), template = f.deps.template;
    f.deps.template = async (...args) => { const value = await template(...args); f.f.state.executions[f.executionArn]!.redriveCount = 1; return value; };
    await assert.rejects(f.call(), /restore_lineage_mismatch/);
});
test('maintenance retags only the clone; attachment waits for both observed target tags', async () => {
    const f = await maintenanceFixture(), d = f.i.deployment;
    f.f.state.instances.push({ InstanceId: 'i-33333333333333333', ClientToken: token(f.rebind.envelope.digest, 'instance'), State: { Name: 'running' },
        ImageId: d.amiId, InstanceType: f.i.instanceType!, Architecture: 'x86_64', RootDeviceType: 'ebs', RootDeviceName: d.storage.rootDeviceName,
        SubnetId: d.subnetId, Placement: { AvailabilityZoneId: d.zoneId }, SecurityGroups: [{ GroupId: d.securityGroupId }],
        MetadataOptions: { HttpTokens: 'required', HttpPutResponseHopLimit: 1, InstanceMetadataTags: 'disabled' }, Tags: tagList(tagsFor(f.i)) });
    const originalTags = structuredClone(f.f.volume.Tags);
    const retag = await f.call(); assert.equal(retag.decision, 'createTags');
    assert.deepEqual((retag.parameters as any).Resources, [f.volume.VolumeId]);
    const wait = await f.helper({ executionArn: f.maintenanceExecutionArn, phase: 'tagged' }); assert.equal(wait.decision, 'wait');
    f.volume.Tags = f.volume.Tags!.map(t => t.Key === 'ezil:generation' ? { ...t, Value: String(f.i.targetGeneration) }
        : t.Key === 'ezil:fence-token' ? { ...t, Value: f.i.fenceToken } : t);
    const attach = await f.call(); assert.equal(attach.decision, 'attachVolume');
    assert.deepEqual(f.f.volume.Tags, originalTags);
});
