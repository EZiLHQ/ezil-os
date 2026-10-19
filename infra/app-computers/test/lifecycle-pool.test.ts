import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { lifecycleDefinition } from '../lib/lifecycle/definition.js';
import { authorityFor, claimTagsFor, tagList, tagsFor, token } from '../lib/lifecycle/contract.js';
import { LifecycleIntentSchema, validateLifecycleReceipt } from '../lib/lifecycle/intent.js';
import { toLambdaError, MAX_THROTTLE_RETRIES } from '../lib/lifecycle/errors.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { runAsl, taskError } from './asl.js';

type Fixture = ReturnType<typeof lifecycleFixture>;
type Options = { lose?: string; noEffect?: string; revokeAfter?: string; fail?: { step: string; error: string; times: number } };
async function run(f: Fixture, options: Options = {}) {
    const helper = createLifecycleHelper(f.settings, f.deps), graph = lifecycleDefinition('helper');
    const calls: { step: string; parameters: any }[] = [];
    let failures = 0;
    const result = await runAsl(graph, {
        input: f.envelope, executionArn: f.executionArn, sleep: seconds => { f.state.now += seconds * 1000; },
        invoke: async (resource, parameters, step) => {
            if (resource === 'helper') {
                try { return await helper(parameters); } catch (error) { throw toLambdaError(error, 'lifecycle_unconfirmed'); }
            }
            assert.equal(graph.States[step].Retry, undefined);
            calls.push({ step, parameters });
            if (options.fail?.step === step && failures++ < options.fail.times) throw taskError(options.fail.error);
            const host = f.state.instances.find(h => h.InstanceId === (parameters.InstanceId ?? parameters.InstanceIds?.[0]));
            if (step !== options.noEffect) {
                if (step === 'runInstances') {
                    const existing = f.state.instances.find(h => h.ClientToken === parameters.ClientToken);
                    if (!existing) {
                        const h = f.instance('i-33333333333333333');
                        h.Tags = parameters.TagSpecifications.find((s: any) => s.ResourceType === 'instance').Tags;
                        h.ClientToken = parameters.ClientToken; f.state.instances.push(h);
                    }
                } else if (step === 'createVolume') {
                    if (!f.state.volumes.length) {
                        const v = f.volume(); v.Tags = parameters.TagSpecifications[0].Tags; v.Size = parameters.Size;
                        f.state.volumes.push(v);
                    }
                } else if (step === 'attachVolume') {
                    assert.equal(f.state.volumes[0]!.State, 'available'); f.attach(f.state.volumes[0]!, host!);
                } else if (step === 'createTags' || step === 'claimInstance') {
                    const target = f.state.instances.find(r => r.InstanceId === parameters.Resources[0])
                        ?? f.state.volumes.find(r => r.VolumeId === parameters.Resources[0]);
                    assert.ok(target);
                    target.Tags = [...(target.Tags ?? []).filter(t => !parameters.Tags.some((n: any) => n.Key === t.Key)), ...parameters.Tags];
                } else if (step === 'deleteTags') {
                    const h = f.state.instances.find(h => h.InstanceId === parameters.Resources[0])!;
                    h.Tags = h.Tags!.filter(t => !parameters.Tags.some((n: any) => n.Key === t.Key && n.Value === t.Value));
                } else if (step === 'stopInstances') {
                    assert.deepEqual(parameters, { InstanceIds: [host!.InstanceId], Force: false, Hibernate: false, SkipOsShutdown: false });
                    host!.State = { Name: 'stopped' };
                } else if (step === 'detachVolume') {
                    assert.equal(host!.State?.Name, 'stopped'); assert.equal(parameters.Force, false);
                    const v = f.state.volumes[0]!; v.State = 'available'; v.Attachments = [];
                    host!.BlockDeviceMappings = host!.BlockDeviceMappings!.filter(m => m.Ebs?.VolumeId !== v.VolumeId);
                } else if (step === 'terminateInstances') {
                    assert.equal(host!.State?.Name, 'stopped'); assert.equal(f.state.volumes[0]!.State, 'available');
                    assert.deepEqual(f.state.volumes[0]!.Attachments, []); assert.equal(host!.BlockDeviceMappings!.length, 1);
                    host!.State = { Name: 'terminated' }; host!.BlockDeviceMappings = [];
                } else assert.fail('unexpected mutation ' + step);
            }
            if (step === options.revokeAfter) f.state.authorized = false;
            if (step === options.lose) throw taskError('States.Timeout', 'lost response');
            return {};
        },
    });
    if (result.output) validateLifecycleReceipt({ ...f.envelope, createdAt: f.state.execution.startDate }, result.output);
    return { ...result, calls };
}

for (const instanceType of ['m6i.large', 'm6i.xlarge'] as const) test(`pool-provision ${instanceType}: pinned root-only launch, pool tags and lease`, async () => {
    const f = lifecycleFixture('pool-provision', { instanceType }), r = await run(f);
    assert.equal(r.error, undefined); assert.deepEqual(r.calls.map(c => c.step), ['runInstances']);
    const p = r.calls[0]!.parameters;
    assert.equal(p.ClientToken, token(f.digest, 'instance'));
    assert.deepEqual(p.LaunchTemplate, { LaunchTemplateId: f.i.deployment.launchTemplateId, Version: f.i.deployment.launchTemplateVersion });
    assert.equal(p.ImageId, f.i.deployment.amiId); assert.equal(p.InstanceType, instanceType);
    assert.equal(p.BlockDeviceMappings.length, 1); assert.equal(p.BlockDeviceMappings[0].DeviceName, '/dev/sda1');
    assert.equal(p.BlockDeviceMappings[0].Ebs.DeleteOnTermination, true);
    assert.equal(p.BlockDeviceMappings[0].Ebs.Encrypted, true);
    const tags = Object.fromEntries(p.TagSpecifications[0].Tags.map((t: any) => [t.Key, t.Value]));
    assert.equal(tags['ezil:pool'], '1'); assert.equal(tags['ezil:pool-host'], f.i.poolHostId); assert.equal(tags['ezil:namespace'], 'pilot');
    assert.equal(tags['ezil:computer'], undefined); assert.equal(tags['ezil:computer-id'], undefined);
    assert.deepEqual(JSON.parse(Buffer.from(p.UserData, 'base64').toString()), { kind: 'pool', poolHostId: f.i.poolHostId, poolGeneration: f.i.poolGeneration });
    assert.equal(f.state.volumes.length, 0); assert.equal(r.output.volumeId, null);
    assert.equal(r.output.poolHostId, f.i.poolHostId); assert.equal(r.output.poolGeneration, 1);
});

test('adopt: owned volume advances generation, attaches in-zone and claims the host', async () => {
    const f = lifecycleFixture('adopt'), r = await run(f);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.calls.map(c => c.step), ['createTags', 'attachVolume', 'claimInstance', 'deleteTags']);
    assert.deepEqual(r.calls[1]!.parameters, { Device: '/dev/sdf', InstanceId: f.i.providerInstanceId, VolumeId: f.i.dataVolumeId });
    assert.deepEqual(r.calls[2]!.parameters.Tags, tagList(claimTagsFor(f.i)));
    assert.deepEqual(r.calls[3]!.parameters.Tags, [{ Key: 'ezil:pool', Value: '1' }]);
    assert.equal(f.state.instances[0]!.Tags!.some(t => t.Key === 'ezil:pool'), false);
    assert.equal(f.state.volumes[0]!.Attachments![0]!.DeleteOnTermination, false);
    assert.equal(f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.DeleteOnTermination, false);
});

test('adopt: first epoch creates encrypted gp3 with ClientToken and retention on attach', async () => {
    const f = lifecycleFixture('adopt', { dataVolumeGiB: 50 }), r = await run(f);
    assert.equal(r.error, undefined);
    assert.deepEqual(r.calls.map(c => c.step), ['createVolume', 'attachVolume', 'claimInstance', 'deleteTags']);
    const p = r.calls[0]!.parameters;
    assert.equal(p.ClientToken, token(f.digest, 'volume')); assert.equal(p.Encrypted, true);
    assert.equal(p.VolumeType, 'gp3'); assert.equal(p.KmsKeyId, f.i.deployment.dataKeyArn);
    assert.equal(p.Size, 50); assert.equal(p.AvailabilityZoneId, f.i.deployment.zoneId);
    assert.equal(f.state.volumes[0]!.Attachments![0]!.DeleteOnTermination, false);
});

test('release: flush stop, wait, non-force detach, wait, terminate; retain user volume', async () => {
    const f = lifecycleFixture('release'), r = await run(f);
    assert.equal(r.error, undefined); assert.equal(r.output.state, 'retired');
    assert.deepEqual(r.calls.map(c => c.step), ['stopInstances', 'detachVolume', 'terminateInstances']);
    assert.equal(f.state.volumes.length, 1); assert.equal(f.state.volumes[0]!.State, 'available');
    assert.deepEqual(f.state.volumes[0]!.Attachments, []);
    assert.ok(r.visited.indexOf('Observe-stopped') < r.visited.indexOf('detachVolume'));
    assert.ok(r.visited.indexOf('Observe-detached') < r.visited.indexOf('terminateInstances'));
});

test('pool-provision waits for pending boot before requiring attached root mappings', async () => {
    const f = lifecycleFixture('pool-provision'), original = f.deps.instances; let pending = true;
    f.deps.instances = async ids => {
        const rows = await original(ids);
        if (rows.length && pending) { pending = false; rows[0]!.instance.State = { Name: 'pending' }; rows[0]!.instance.BlockDeviceMappings = []; }
        return rows;
    };
    const r = await run(f); assert.equal(r.error, undefined); assert.equal(r.calls.length, 1);
    assert.ok(r.visited.includes('Wait'));
});
test('release waits through stopping and detaching without repeating either mutation', async () => {
    const f = lifecycleFixture('release'), instances = f.deps.instances, volumes = f.deps.volumes;
    const attached = structuredClone(f.state.volumes[0]!); let stopping = true, detaching = true;
    f.deps.instances = async ids => {
        const rows = await instances(ids);
        if (rows[0]?.instance.State?.Name === 'stopped' && stopping) { stopping = false; rows[0].instance.State = { Name: 'stopping' }; }
        return rows;
    };
    f.deps.volumes = async ids => {
        const rows = await volumes(ids);
        if (rows[0]?.State === 'available' && detaching) {
            detaching = false; const v = structuredClone(attached); v.Attachments![0]!.State = 'detaching'; return [v];
        }
        return rows;
    };
    const r = await run(f); assert.equal(r.error, undefined);
    assert.deepEqual(r.calls.map(c => c.step), ['stopInstances', 'detachVolume', 'terminateInstances']);
    assert.equal(r.visited.filter(s => s === 'Wait').length, 2);
});
test('release replay accepts an aged-out instance only with a free, owned retained volume', async () => {
    const f = lifecycleFixture('release'), first = await run(f); f.state.instances = [];
    const replay = await run(f); assert.equal(replay.error, undefined); assert.deepEqual(replay.output, first.output); assert.deepEqual(replay.calls, []);
    f.state.volumes[0]!.State = 'in-use';
    const unsafe = await run(f); assert.equal(unsafe.error, 'LifecycleUnconfirmed'); assert.deepEqual(unsafe.calls, []);
});

for (const operation of ['pool-provision', 'adopt', 'release'] as const) test(`${operation}: replay returns the same receipt without mutation`, async () => {
    const f = lifecycleFixture(operation), first = await run(f), replay = await run(f);
    assert.equal(first.error, undefined); assert.equal(replay.error, undefined);
    assert.deepEqual(replay.output, first.output); assert.deepEqual(replay.calls, []);
});
test('adopt: replay of first-volume creation reuses the allocated volume', async () => {
    const f = lifecycleFixture('adopt', { dataVolumeGiB: 50 }), first = await run(f), replay = await run(f);
    assert.equal(first.error, undefined); assert.deepEqual(replay.output, first.output); assert.deepEqual(replay.calls, []);
});

for (const [operation, step] of [
    ['pool-provision', 'runInstances'], ['adopt', 'createTags'], ['adopt', 'attachVolume'], ['adopt', 'claimInstance'], ['adopt', 'deleteTags'],
    ['release', 'stopInstances'], ['release', 'detachVolume'], ['release', 'terminateInstances'],
] as const) test(`${operation}: lost ${step} reply is observed with no duplicate mutation`, async () => {
    const r = await run(lifecycleFixture(operation), { lose: step });
    assert.equal(r.error, undefined); assert.equal(r.calls.filter(c => c.step === step).length, 1);
});
for (const [operation, step] of [
    ['adopt', 'createTags'], ['adopt', 'attachVolume'], ['adopt', 'claimInstance'], ['adopt', 'deleteTags'],
    ['release', 'stopInstances'], ['release', 'detachVolume'], ['release', 'terminateInstances'],
] as const) test(`${operation}: uncertain ${step} with no observed effect fails closed without retry`, async () => {
    const r = await run(lifecycleFixture(operation), { lose: step, noEffect: step });
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.equal(r.output, undefined);
    assert.equal(r.calls.filter(c => c.step === step).length, 1);
    assert.equal(r.calls.at(-1)!.step, step);
});

for (const [label, corrupt] of Object.entries({
    'cross-zone volume': (f: Fixture) => { f.state.volumes[0]!.AvailabilityZoneId = 'aps1-az2'; },
    'cross-zone host': (f: Fixture) => { f.state.instances[0]!.Placement = { AvailabilityZoneId: 'aps1-az2' }; },
    'missing zone': (f: Fixture) => { f.state.instances[0]!.Placement = {}; },
    'non-pool host': (f: Fixture) => { f.state.instances[0]!.Tags = tagList(tagsFor(f.i)); },
    'wrong pool host': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:pool-host')!.Value = randomUUID(); },
    'foreign claim': (f: Fixture) => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:computer', Value: randomUUID() }); },
    'stopped host': (f: Fixture) => { f.state.instances[0]!.State = { Name: 'stopped' }; },
    'foreign volume': (f: Fixture) => { f.state.volumes[0]!.Tags = []; },
    'newer generation': (f: Fixture) => { f.state.volumes[0]!.Tags = tagList(tagsFor(f.i, 3)); },
    'same generation wrong fence': (f: Fixture) => { f.state.volumes[0]!.Tags = tagList(tagsFor(f.i, 2, randomUUID())); },
    'volume already in use': (f: Fixture) => { f.attach(f.state.volumes[0]!, f.instance('i-99999999999999999')); },
    'unencrypted volume': (f: Fixture) => { f.state.volumes[0]!.Encrypted = false; },
    'multi-attach volume': (f: Fixture) => { f.state.volumes[0]!.MultiAttachEnabled = true; },
    'unexpected disk': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdg', Ebs: { VolumeId: 'vol-99999999999999999' } }); },
})) test(`adopt refuses ${label} before mutations`, async () => {
    const f = lifecycleFixture('adopt'); corrupt(f); const r = await run(f);
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});
test('adopt refuses to allocate a first volume on a non-pool host', async () => {
    const f = lifecycleFixture('adopt', { dataVolumeGiB: 50 }); f.state.instances[0]!.Tags = [];
    const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});
for (const corrupt of [
    (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:fence')!.Value = randomUUID(); },
    (f: Fixture) => { f.state.volumes[0]!.Tags = []; },
    (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.DeleteOnTermination = true; },
    (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdg', Ebs: { VolumeId: 'vol-99999999999999999' } }); },
]) test('release refuses foreign fences, foreign volumes, deletable or unexpected disks before shutdown', async () => {
    const f = lifecycleFixture('release'); corrupt(f); const r = await run(f);
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});

for (const operation of ['pool-provision', 'adopt', 'release'] as const) test(`${operation}: immutable envelope, authority recheck and expiry guard mutations`, async () => {
    for (const field of ['redriveCount', 'stateMachineVersionArn', 'digest']) {
        const f = lifecycleFixture(operation);
        if (field === 'redriveCount') f.state.execution.redriveCount = 1;
        else if (field === 'stateMachineVersionArn') f.state.execution.stateMachineVersionArn += '2';
        else f.state.execution.input = JSON.stringify({ ...f.envelope, digest: '0'.repeat(64) });
        const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
    }
    for (const late of [false, true]) {
        const f = lifecycleFixture(operation), original = f.deps.instances;
        f.deps.instances = async ids => { const rows = await original(ids); if (late) f.state.now += 871000; else f.state.authorized = false; return rows; };
        const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
    }
});
for (const [operation, step] of [['adopt', 'attachVolume'], ['release', 'detachVolume']] as const) test(`${operation}: revocation after ${step} stops further mutations`, async () => {
    const r = await run(lifecycleFixture(operation), { revokeAfter: step });
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.equal(r.calls.at(-1)!.step, step);
});
test('pool launch and first-volume retries use identical ClientTokens and parameters', async () => {
    for (const [operation, step, phase] of [['pool-provision', 'runInstances', 'instance'], ['adopt', 'createVolume', 'volume']] as const) {
        const f = lifecycleFixture(operation, { dataVolumeGiB: 50 }), helper = createLifecycleHelper(f.settings, f.deps);
        const first = await helper({ executionArn: f.executionArn, phase: 'initial' });
        const retry = await helper({ executionArn: f.executionArn, phase, lastError: { Error: 'States.Timeout', Cause: 'lost' } });
        assert.equal(first.decision, step); assert.deepEqual(retry, first);
        const r = await run(f, { lose: step }); assert.equal(r.error, undefined); assert.equal(r.calls.filter(c => c.step === step).length, 1);
    }
});
test('pool launch capacity is refused; definite throttling is bounded', async () => {
    const capacity = await run(lifecycleFixture('pool-provision'), { fail: { step: 'runInstances', error: 'Ec2.InsufficientInstanceCapacity', times: 1 } });
    assert.equal(capacity.error, 'LifecycleRefused'); assert.equal(capacity.calls.length, 1);
    const throttled = await run(lifecycleFixture('pool-provision'), { fail: { step: 'runInstances', error: 'Ec2.RequestLimitExceeded', times: 99 } });
    assert.equal(throttled.error, 'LifecycleUnconfirmed'); assert.equal(throttled.calls.length, MAX_THROTTLE_RETRIES + 1);
});
test('pool schema: allowed sizes, pool identity and data creation are bounded', () => {
    for (const operation of ['pool-provision', 'adopt', 'release'] as const) {
        const f = lifecycleFixture(operation); assert.equal(LifecycleIntentSchema.safeParse(f.i).success, true);
        for (const instanceType of ['m6i.2xlarge', 'c6i.xlarge', 't3.medium']) assert.equal(LifecycleIntentSchema.safeParse({ ...f.i, instanceType }).success, false);
    }
    const p = lifecycleFixture('pool-provision').i;
    for (const change of [{ poolHostId: undefined }, { poolGeneration: 0 }, { computerId: randomUUID() }, { targetGeneration: 2 }, { dataVolumeGiB: 50 }, { userData: 'ZXppbA==' }])
        assert.equal(LifecycleIntentSchema.safeParse({ ...p, ...change }).success, false);
    const a = lifecycleFixture('adopt').i;
    for (const change of [{ dataVolumeGiB: 50 }, { poolHostId: undefined }, { dataVolumeId: null }, { dataVolumeId: null, dataVolumeGiB: 101 }])
        assert.equal(LifecycleIntentSchema.safeParse({ ...a, ...change }).success, false);
    assert.deepEqual(authorityFor(p, 'digest'), { schemaVersion: 1, computerId: p.computerId, jobId: p.jobId, leaseEpoch: p.leaseEpoch, digest: 'digest', operation: 'pool-provision', poolHostId: p.poolHostId, poolGeneration: p.poolGeneration });
});
test('pool receipts cannot validate as computer receipts or claim a data disk', async () => {
    const f = lifecycleFixture('pool-provision'), r = await run(f), work = { ...f.envelope, createdAt: f.state.execution.startDate };
    for (const change of [{ volumeId: 'vol-11111111111111111' }, { poolGeneration: 2 }, { poolHostId: randomUUID() }, { poolHostId: undefined }])
        assert.throws(() => validateLifecycleReceipt(work, { ...r.output, ...change }));
    const a = lifecycleFixture('adopt'), adopted = await run(a);
    assert.throws(() => validateLifecycleReceipt({ ...a.envelope, createdAt: a.state.execution.startDate }, { ...adopted.output, volumeId: null }));
});
