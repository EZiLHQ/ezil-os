import assert from 'node:assert/strict';
import test from 'node:test';
import { createLifecycleHelper, lifecycleError } from '../lib/lifecycle/helper.js';
import { lifecycleDefinition } from '../lib/lifecycle/definition.js';
import { claimTagsFor, tagList, tagsFor } from '../lib/lifecycle/contract.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { runAsl } from './asl.js';

// The app's failed-release recovery (aws-pool-release-recovery.ts, incident 2026-10-25) replays an ordinary release after
// the failed one already terminated the host and freed the disk. That replay must settle `retired` with NO provider call.
for (const [name, cold, absent] of [['cold (canonical) host terminated', true, false], ['adopted host terminated', false, false],
    ['host aged out of EC2', true, true]] as const) test(`release replay, ${name}: retired with zero EC2 mutations`, async () => {
    const f = lifecycleFixture('release');
    const host = f.state.instances[0]!, volume = f.state.volumes[0]!;
    if (cold) {
        host.Tags = [...tagList(tagsFor(f.i)), { Key: 'aws:ec2launchtemplate:id', Value: f.i.deployment.launchTemplateId }];
        volume.Tags = tagList(tagsFor(f.i));
    } else assert.ok(host.Tags!.some(t => t.Key === Object.keys(claimTagsFor(f.i))[0]));
    host.State = { Name: 'terminated' }; host.BlockDeviceMappings = []; delete host.SubnetId;
    volume.State = 'available'; volume.Attachments = [];
    if (absent) f.state.instances = [];
    const helper = createLifecycleHelper(f.settings, f.deps), graph = lifecycleDefinition('helper');
    const calls: string[] = [];
    const result = await runAsl(graph, {
        input: f.envelope, executionArn: f.executionArn, sleep: seconds => { f.state.now += seconds * 1000; },
        invoke: async (resource, parameters, step) => {
            if (resource === 'helper') { try { return await helper(parameters); } catch (error) { throw lifecycleError(error); } }
            calls.push(step); return {};
        },
    });
    assert.equal(result.error, undefined);
    assert.deepEqual(calls, []);
    assert.equal(result.output.state, 'retired');
    assert.equal(result.output.instanceId, f.i.providerInstanceId);
    assert.equal(result.output.volumeId, f.i.dataVolumeId);
});

test('release replay refuses (never mutates) a terminated host whose disk is attached elsewhere', async () => {
    const f = lifecycleFixture('release');
    const host = f.state.instances[0]!, volume = f.state.volumes[0]!;
    host.State = { Name: 'terminated' }; host.BlockDeviceMappings = []; delete host.SubnetId;
    volume.State = 'in-use'; volume.Attachments = [{ InstanceId: 'i-99999999999999999', VolumeId: volume.VolumeId, State: 'attached' }];
    const helper = createLifecycleHelper(f.settings, f.deps), graph = lifecycleDefinition('helper');
    const calls: string[] = [];
    const result = await runAsl(graph, {
        input: f.envelope, executionArn: f.executionArn, sleep: seconds => { f.state.now += seconds * 1000; },
        invoke: async (resource, parameters, step) => {
            if (resource === 'helper') { try { return await helper(parameters); } catch (error) { throw lifecycleError(error); } }
            calls.push(step); return {};
        },
    });
    assert.notEqual(result.error, undefined);
    assert.deepEqual(calls, []);
});
