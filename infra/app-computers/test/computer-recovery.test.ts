import assert from 'node:assert/strict';
import test from 'node:test';
import type { Tag } from '@aws-sdk/client-ec2';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { createRecoveryHelper } from '../lib/lifecycle/recovery-helper.js';
import { token, tagList, tagsFor } from '../lib/lifecycle/contract.js';
import { type RecoveryDependencies } from '../lib/lifecycle/recovery-aws.js';
import { machineArn, type RecoverySettings } from '../lib/lifecycle/recovery-contract.js';
import { computerRecoveryFixture } from './computer-recovery-fixture.js';

test('v2 launches a fresh writer, retags and attaches the same disk, then verifies preservation', async () => {
    const f = computerRecoveryFixture(), helper = createLifecycleHelper(f.settings, f.deps);
    const run = (phase: string) => helper({ executionArn: f.executionArn, phase });
    const launch = await run('initial'); assert.equal(launch.decision, 'runInstances');
    assert.equal((launch.parameters as { ClientToken: string }).ClientToken, token(f.digest, 'instance', 2));
    assert.deepEqual(await run('instance'), launch); // A lost allocation response reuses the exact token.
    const target = f.instance(); f.state.instances.push(target);
    const retag = await run('instance'); assert.equal(retag.decision, 'createTags');
    assert.deepEqual((retag.parameters as { Resources: string[] }).Resources, [f.i.dataVolumeId]);
    f.volume.Tags = (retag.parameters as { Tags: Tag[] }).Tags;
    const attach = await run('tagged'); assert.equal(attach.decision, 'attachVolume');
    assert.deepEqual(attach.parameters, { Device: '/dev/sdf', InstanceId: target.InstanceId, VolumeId: f.i.dataVolumeId });
    f.attach(f.volume, target);
    const preserve = await run('attached'); assert.equal(preserve.decision, 'modifyInstanceAttribute');
    assert.equal((preserve.parameters as any).BlockDeviceMappings[0].Ebs.DeleteOnTermination, false);
    const success = await run('preserved'); assert.equal(success.decision, 'success');
    assert.deepEqual(success.receipt, { schemaVersion: 2, jobId: f.i.jobId, computerId: f.i.computerId, digest: f.digest,
        generation: 2, fenceToken: f.i.fenceToken, instanceId: target.InstanceId, volumeId: f.i.dataVolumeId, state: 'running' });
    assert.equal(f.old.State?.Name, 'terminated'); assert.equal(f.state.volumes.length, 1);
});
test('v2 never creates a missing disk or attaches one with another writer or storage scope', async () => {
    const changes: ((f: ReturnType<typeof computerRecoveryFixture>) => void)[] = [f => { f.state.volumes = []; },
        f => { f.volume.Encrypted = false; }, f => { f.volume.Tags = []; }, f => { f.volume.AvailabilityZone = 'us-east-1b'; },
        f => { f.volume.State = 'in-use'; f.volume.Attachments = [{ InstanceId: 'i-44444444444444444', VolumeId: f.i.dataVolumeId }]; }];
    for (const change of changes) { const f = computerRecoveryFixture(); change(f);
        await assert.rejects(createLifecycleHelper(f.settings, f.deps)({ executionArn: f.executionArn, phase: 'initial' })); }
});
test('only signed historical fencing allows expired IDs; stopped or fresh identities cannot be reused', async () => {
    const gone = computerRecoveryFixture(); gone.state.instances = [];
    assert.equal((await createLifecycleHelper(gone.settings, gone.deps)({ executionArn: gone.executionArn, phase: 'initial' })).decision, 'runInstances');
    const changes: ((f: ReturnType<typeof computerRecoveryFixture>) => void)[] = [f => { f.old.State = { Name: 'stopped' }; },
        f => { f.writers[0]!.generation = 2; }, f => { f.writers[0]!.fencedAt = new Date(f.state.now + 60000).toISOString(); },
        f => { f.deps.recoveryAuthority = undefined; }, f => { f.old.Tags = []; }];
    for (const change of changes) { const f = computerRecoveryFixture(); change(f);
        await assert.rejects(createLifecycleHelper(f.settings, f.deps)({ executionArn: f.executionArn, phase: 'initial' })); }
});
test('revocation or changed writer evidence during reads prevents the next mutation', async () => {
    for (const change of ['revoked', 'writers']) {
        const f = computerRecoveryFixture(), read = f.deps.volumes;
        f.deps.volumes = async ids => { const value = await read(ids);
            if (change === 'revoked') f.state.authorized = false; else f.writers.length = 0; return value; };
        await assert.rejects(createLifecycleHelper(f.settings, f.deps)({ executionArn: f.executionArn, phase: 'initial' }), /authority_denied/);
    }
});
test('envelope downgrade and extra request authority are rejected before any provider mutation', async () => {
    const f = computerRecoveryFixture(); f.state.execution.input = JSON.stringify({ ...f.envelope, schemaVersion: 1 });
    await assert.rejects(createLifecycleHelper(f.settings, f.deps)({ executionArn: f.executionArn, phase: 'initial' }), /lifecycle_invalid/);
    const g = computerRecoveryFixture(); await assert.rejects(createLifecycleHelper(g.settings, g.deps)({ executionArn: g.executionArn, phase: 'initial', writers: g.writers }));
});
function cleanupFixture(allocated: boolean) {
    const f = computerRecoveryFixture(), settings: RecoverySettings = { lifecycle: f.settings,
        recoveryVersionArn: 'arn:aws:states:us-east-1:123456789012:stateMachine:ezil-lifecycle-recovery:1' };
    const machine = machineArn(settings.recoveryVersionArn), name = `cleanup-computer-${f.i.jobId}`, arn = machine.replace(':stateMachine:', ':execution:') + ':' + name;
    const source = { ...f.state.execution, status: 'FAILED', startDate: new Date(f.state.now - 120000), stopDate: new Date(f.state.now - 61000) };
    const execution = { executionArn: arn, name, stateMachineArn: machine, stateMachineVersionArn: settings.recoveryVersionArn,
        redriveCount: 0, status: 'RUNNING', startDate: new Date(f.state.now - 1000), input: JSON.stringify({ sourceExecutionArn: f.executionArn }) };
    const history: HistoryEvent[] = [{ id: 1, type: 'ExecutionStarted', timestamp: source.startDate },
        ...(allocated ? [{ id: 2, type: 'TaskStateEntered' as const, timestamp: source.startDate, stateEnteredEventDetails: { name: 'runInstances' } }] : []),
        { id: allocated ? 3 : 2, type: 'ExecutionFailed', timestamp: source.stopDate }];
    const target = f.instance(); if (allocated) { f.state.instances.push(target); f.volume.Tags = tagList(tagsFor(f.i)); f.attach(f.volume, target); }
    const deps: RecoveryDependencies = { ...f.deps, execution: async id => structuredClone(id === arn ? execution : source) as any, history: async () => history };
    return { ...f, settings, arn, source, history, target, deps };
}
test('v2 failure cleanup fences only its new target and preserves the retained disk', async () => {
    const f = cleanupFixture(true), helper = createRecoveryHelper(f.settings, f.deps);
    assert.equal((await helper({ executionArn: f.arn, phase: 'initial' })).decision, 'stop-target');
    f.target.State = { Name: 'stopped' };
    assert.equal((await helper({ executionArn: f.arn, phase: 'target-stopped' })).decision, 'terminate-target');
    f.target.State = { Name: 'terminated' }; f.target.BlockDeviceMappings = []; f.volume.State = 'available'; f.volume.Attachments = [];
    const result = await helper({ executionArn: f.arn, phase: 'target-terminated' }); assert.equal(result.decision, 'success');
    assert.deepEqual((result.receipt as any).instances, [{ instanceId: f.target.InstanceId, generation: 2, fenceToken: f.i.fenceToken, state: 'terminated' }]);
    assert.equal((result.receipt as any).schemaVersion, 2); assert.equal((result.receipt as any).volumeId, f.i.dataVolumeId);
    assert.equal(f.old.State?.Name, 'terminated');
});
test('data-only v2 cleanup preserves old disk tags; uncertain allocation cannot disappear from history', async () => {
    const f = cleanupFixture(false), result = await createRecoveryHelper(f.settings, f.deps)({ executionArn: f.arn, phase: 'initial' });
    assert.equal(result.decision, 'success'); assert.equal((result.receipt as any).volumeId, f.i.dataVolumeId); assert.deepEqual((result.receipt as any).instances, []);
    const g = cleanupFixture(true); g.state.instances = [g.old]; g.volume.Attachments = []; g.volume.State = 'available';
    assert.equal((await createRecoveryHelper(g.settings, g.deps)({ executionArn: g.arn, phase: 'initial' })).decision, 'wait');
    const h = cleanupFixture(true); h.history[1]!.stateEnteredEventDetails!.name = 'createVolume';
    await assert.rejects(createRecoveryHelper(h.settings, h.deps)({ executionArn: h.arn, phase: 'initial' }));
    const succeeded = cleanupFixture(true); succeeded.source.status = 'SUCCEEDED';
    await assert.rejects(createRecoveryHelper(succeeded.settings, succeeded.deps)({ executionArn: succeeded.arn, phase: 'initial' }));
});
