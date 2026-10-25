import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { assertOnlyExpectedDisks, createLifecycleHelper, lifecycleError } from '../lib/lifecycle/helper.js';
import { lifecycleDefinition } from '../lib/lifecycle/definition.js';
import { authorityFor, claimTagsFor, poolTagsFor, tagList, tagsFor, token } from '../lib/lifecycle/contract.js';
import { LifecycleIntentSchema, validateLifecycleReceipt } from '../lib/lifecycle/intent.js';
import { MAX_THROTTLE_RETRIES } from '../lib/lifecycle/errors.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { runAsl, taskError } from './asl.js';

type Fixture = ReturnType<typeof lifecycleFixture>;
const LEGACY_AMI = 'ami-033dd9578ae2a43d3';
type Options = { lose?: string; noEffect?: string; revokeAfter?: string; fail?: { step: string; error: string; times: number } };
async function run(f: Fixture, options: Options = {}) {
    const helper = createLifecycleHelper(f.settings, f.deps), graph = lifecycleDefinition('helper');
    const calls: { step: string; parameters: any }[] = [];
    let failures = 0;
    const result = await runAsl(graph, {
        input: f.envelope, executionArn: f.executionArn, sleep: seconds => { f.state.now += seconds * 1000; },
        invoke: async (resource, parameters, step) => {
            if (resource === 'helper') {
                try { return await helper(parameters); } catch (error) { throw lifecycleError(error); }
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
                    if (f.i.operation === 'release') {
                        assert.equal(host!.State?.Name, 'stopped'); assert.equal(f.state.volumes[0]!.State, 'available');
                        assert.deepEqual(f.state.volumes[0]!.Attachments, []);
                    } else assert.equal(f.i.operation, 'pool-retire');
                    assert.equal(host!.BlockDeviceMappings!.length, 1);
                    host!.State = { Name: 'terminated' }; host!.BlockDeviceMappings = [];
                } else assert.fail('unexpected mutation ' + step);
            }
            if (step === options.revokeAfter) f.state.authorized = false;
            if (step === options.lose) throw taskError('States.Timeout', 'lost response');
            return {};
        },
    });
    if (result.output) assert.doesNotThrow(() => validateLifecycleReceipt({ ...f.envelope, createdAt: f.state.execution.startDate }, result.output));
    return { ...result, calls };
}

for (const instanceType of ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge'] as const) test(`pool-provision ${instanceType}: pinned root-only launch, pool tags and lease`, async () => {
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

for (const operation of ['pool-provision', 'pool-retire', 'adopt', 'release'] as const) test(`${operation}: replay returns the same receipt without mutation`, async () => {
    const f = lifecycleFixture(operation), first = await run(f), replay = await run(f);
    assert.equal(first.error, undefined); assert.equal(replay.error, undefined);
    assert.deepEqual(replay.output, first.output); assert.deepEqual(replay.calls, []);
});
test('adopt: replay of first-volume creation reuses the allocated volume', async () => {
    const f = lifecycleFixture('adopt', { dataVolumeGiB: 50 }), first = await run(f), replay = await run(f);
    assert.equal(first.error, undefined); assert.deepEqual(replay.output, first.output); assert.deepEqual(replay.calls, []);
});

for (const [operation, step] of [
    ['pool-provision', 'runInstances'], ['pool-retire', 'terminateInstances'], ['adopt', 'createTags'], ['adopt', 'attachVolume'], ['adopt', 'claimInstance'], ['adopt', 'deleteTags'],
    ['release', 'stopInstances'], ['release', 'detachVolume'], ['release', 'terminateInstances'],
] as const) test(`${operation}: lost ${step} reply is observed with no duplicate mutation`, async () => {
    const r = await run(lifecycleFixture(operation), { lose: step });
    assert.equal(r.error, undefined); assert.equal(r.calls.filter(c => c.step === step).length, 1);
});
for (const [operation, step] of [
    ['pool-retire', 'terminateInstances'], ['adopt', 'createTags'], ['adopt', 'attachVolume'], ['adopt', 'claimInstance'], ['adopt', 'deleteTags'],
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
    'non-pool host': (f: Fixture) => { f.state.instances[0]!.Tags = tagList({ ...tagsFor(f.i), 'aws:ec2launchtemplate:id': f.i.deployment.launchTemplateId }); },
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

for (const operation of ['pool-provision', 'pool-retire', 'adopt', 'release'] as const) test(`${operation}: immutable envelope, authority recheck and expiry guard mutations`, async () => {
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
    for (const operation of ['pool-provision', 'pool-retire', 'adopt', 'release'] as const) {
        const f = lifecycleFixture(operation); assert.equal(LifecycleIntentSchema.safeParse(f.i).success, true);
        for (const instanceType of ['c6i.xlarge', 't3.medium']) assert.equal(LifecycleIntentSchema.safeParse({ ...f.i, instanceType }).success, false);
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

for (const instanceType of ['m6i.large', 'm6i.xlarge'] as const) for (const state of ['running', 'stopped', 'stopping', 'pending'] as const)
    test(`pool-retire: ${instanceType} ${state} root-only spare terminates without data operations`, async () => {
        const f = lifecycleFixture('pool-retire', { instanceType }); f.state.instances[0]!.State = { Name: state };
        const r = await run(f);
        assert.equal(r.error, undefined); assert.deepEqual(r.calls.map(c => c.step), ['terminateInstances']);
        assert.equal(r.output.state, 'retired'); assert.equal(r.output.volumeId, null);
        assert.equal(r.output.poolHostId, f.i.poolHostId); assert.equal(r.output.poolGeneration, f.i.poolGeneration);
        assert.equal(f.state.volumes.length, 0);
    });

for (const [label, corrupt] of Object.entries({
    'missing instance': (f: Fixture) => { f.state.instances = []; },
    'missing pool tag': (f: Fixture) => { f.state.instances[0]!.Tags = f.state.instances[0]!.Tags!.filter(t => t.Key !== 'ezil:pool'); },
    'wrong pool tag': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:pool')!.Value = '0'; },
    'wrong host id': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:pool-host')!.Value = randomUUID(); },
    'wrong namespace': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:namespace')!.Value = 'foreign'; },
    'computer tag': (f: Fixture) => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:computer', Value: f.i.computerId }); },
    'empty computer tag': (f: Fixture) => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:computer', Value: '' }); },
    'legacy computer tag': (f: Fixture) => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:computer-id', Value: f.i.computerId }); },
    'missing live networking': (f: Fixture) => { delete f.state.instances[0]!.SecurityGroups; },
    '2xlarge host': (f: Fixture) => { f.state.instances[0]!.InstanceType = 'm6i.2xlarge'; },
    'wrong zone': (f: Fixture) => { f.state.instances[0]!.Placement = { AvailabilityZoneId: 'aps1-az2' }; },
    'unknown status': (f: Fixture) => { f.state.instances[0]!.State = {}; },
    'missing root': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings = []; },
    'missing mappings': (f: Fixture) => { delete f.state.instances[0]!.BlockDeviceMappings; },
    'retained root': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.DeleteOnTermination = false; },
    'data at sdf': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdf', Ebs: { VolumeId: 'vol-99999999999999999' } }); },
    'non-root attachment': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdg', Ebs: { VolumeId: 'vol-99999999999999999' } }); },
    'non-EBS mapping': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdg' }); },
})) test(`pool-retire refuses ${label} before mutations`, async () => {
    const f = lifecycleFixture('pool-retire'); corrupt(f); const r = await run(f);
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});

test('pool-retire schema, receipt and authority bind host, generation and instance', async () => {
    const f = lifecycleFixture('pool-retire');
    for (const patch of [{ poolHostId: undefined }, { poolGeneration: undefined }, { poolGeneration: 0 },
        { computerId: randomUUID() }, { targetGeneration: 2 }, { providerInstanceId: null },
        { dataVolumeId: 'vol-11111111111111111' }, { dataVolumeGiB: 50 }, { userData: 'ZXppbA==' }])
        assert.equal(LifecycleIntentSchema.safeParse({ ...f.i, ...patch }).success, false, JSON.stringify(patch));
    assert.deepEqual(authorityFor(f.i, f.digest), { schemaVersion: 1, computerId: f.i.computerId, jobId: f.i.jobId,
        leaseEpoch: f.i.leaseEpoch, digest: f.digest, operation: 'pool-retire', poolHostId: f.i.poolHostId, poolGeneration: f.i.poolGeneration });
    const r = await run(f), work = { ...f.envelope, createdAt: f.state.execution.startDate };
    for (const patch of [{ state: 'running' }, { poolHostId: undefined }, { poolGeneration: 2 },
        { volumeId: 'vol-11111111111111111' }, { instanceId: 'i-99999999999999999' }])
        assert.throws(() => validateLifecycleReceipt(work, { ...r.output, ...patch }));
});

for (const operation of ['release', 'pool-retire'] as const) test(`${operation}: observe shutting-down then terminated after EC2 clears networking`, async () => {
    const f = lifecycleFixture(operation), instances = f.deps.instances; let shutting = true;
    f.deps.instances = async ids => {
        const rows = await instances(ids), host = rows[0]?.instance;
        if (host?.State?.Name === 'terminated') {
            delete host.SubnetId; delete host.SecurityGroups; delete host.MetadataOptions; delete host.Placement;
            if (shutting) { shutting = false; host.State = { Name: 'shutting-down' }; }
        }
        return rows;
    };
    const r = await run(f); assert.equal(r.error, undefined); assert.ok(r.visited.includes('Wait'));
    assert.equal(r.calls.filter(c => c.step === 'terminateInstances').length, 1);
    assert.equal(r.output.state, 'retired');
});

for (const operation of ['release', 'pool-retire'] as const) for (const state of ['shutting-down', 'terminated'] as const)
    for (const [label, corrupt] of Object.entries({
        'foreign launch template': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'aws:ec2launchtemplate:id')!.Value = 'lt-99999999999999999'; },
        'missing launch template': (f: Fixture) => { f.state.instances[0]!.Tags = f.state.instances[0]!.Tags!.filter(t => t.Key !== 'aws:ec2launchtemplate:id'); },
        'foreign subnet': (f: Fixture) => { f.state.instances[0]!.SubnetId = 'subnet-99999999999999999'; },
        'foreign zone': (f: Fixture) => { f.state.instances[0]!.Placement = { AvailabilityZoneId: 'aps1-az2' }; },
        'foreign type': (f: Fixture) => { f.state.instances[0]!.InstanceType = 'm6i.2xlarge'; },
        'data mapping': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings = [{ DeviceName: '/dev/sdf' }]; },
        'duplicate root': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings = [{ DeviceName: '/dev/sda1' }, { DeviceName: '/dev/sda1' }]; },
        'missing mappings': (f: Fixture) => { delete f.state.instances[0]!.BlockDeviceMappings; },
    })) test(`${operation}: ${state} refuses ${label}`, async () => {
        const f = lifecycleFixture(operation), host = f.state.instances[0]!; host.State = { Name: state }; host.BlockDeviceMappings = [];
        if (operation === 'release') { f.state.volumes[0]!.State = 'available'; f.state.volumes[0]!.Attachments = []; }
        corrupt(f); const r = await run(f);
        assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
    });

for (const image of ['current', 'legacy'] as const) test(`release: ${image} AMI cold fallback host and volume use legacy identity and retain the volume`, async () => {
    const f = lifecycleFixture('release');
    if (image === 'legacy') f.state.instances[0]!.ImageId = LEGACY_AMI;
    f.state.instances[0]!.Tags = tagList({ ...tagsFor(f.i), 'aws:ec2launchtemplate:id': f.i.deployment.launchTemplateId }); f.state.volumes[0]!.Tags = tagList(tagsFor(f.i));
    const r = await run(f); assert.equal(r.error, undefined);
    assert.deepEqual(r.calls.map(c => c.step), ['stopInstances', 'detachVolume', 'terminateInstances']);
    assert.equal(r.output.volumeId, f.i.dataVolumeId); assert.equal(f.state.volumes[0]!.State, 'available');
});

for (const operation of ['release', 'pool-retire'] as const) test(`${operation}: legacy AMI drains successfully without describing the current image or template`, async () => {
    const f = lifecycleFixture(operation), host = f.state.instances[0]!;
    host.ImageId = LEGACY_AMI;
    host.Tags!.push({ Key: 'aws:ec2launchtemplate:version', Value: '99' });
    f.deps.image = async () => assert.fail('draining must not depend on AMI availability');
    f.deps.template = async () => assert.fail('draining must not depend on the current template version');
    const r = await run(f);
    assert.equal(r.error, undefined); assert.equal(r.output.state, 'retired');
    assert.deepEqual(r.calls.map(c => c.step), operation === 'release'
        ? ['stopInstances', 'detachVolume', 'terminateInstances'] : ['terminateInstances']);
    if (operation === 'release') {
        assert.equal(r.output.volumeId, f.i.dataVolumeId); assert.equal(f.state.volumes[0]!.State, 'available');
    } else assert.equal(r.output.volumeId, null);
});

for (const operation of ['release', 'pool-retire'] as const) for (const [label, corrupt] of Object.entries({
    'wrong launch template': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'aws:ec2launchtemplate:id')!.Value = 'lt-99999999999999999'; },
    'missing launch template': (f: Fixture) => { f.state.instances[0]!.Tags = f.state.instances[0]!.Tags!.filter(t => t.Key !== 'aws:ec2launchtemplate:id'); },
    'duplicate launch template': (f: Fixture) => { f.state.instances[0]!.Tags!.push({ Key: 'aws:ec2launchtemplate:id', Value: f.i.deployment.launchTemplateId }); },
    'wrong subnet': (f: Fixture) => { f.state.instances[0]!.SubnetId = 'subnet-99999999999999999'; },
    'foreign SG': (f: Fixture) => { f.state.instances[0]!.SecurityGroups = [{ GroupId: 'sg-99999999999999999' }]; },
    'additional SG': (f: Fixture) => { f.state.instances[0]!.SecurityGroups!.push({ GroupId: 'sg-99999999999999999' }); },
    'wrong type': (f: Fixture) => { f.state.instances[0]!.InstanceType = 'm6i.xlarge'; },
    'IMDSv1': (f: Fixture) => { f.state.instances[0]!.MetadataOptions!.HttpTokens = 'optional'; },
    'metadata hop limit': (f: Fixture) => { f.state.instances[0]!.MetadataOptions!.HttpPutResponseHopLimit = 2; },
    'metadata tags': (f: Fixture) => { f.state.instances[0]!.MetadataOptions!.InstanceMetadataTags = 'enabled'; },
    'wrong root device': (f: Fixture) => { f.state.instances[0]!.RootDeviceName = '/dev/xvda'; },
    'wrong owner': (f: Fixture) => { const instances = f.deps.instances; f.deps.instances = async ids => (await instances(ids)).map(row => ({ ...row, owner: '999999999999' })); },
    'wrong managed-by': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:managed-by')!.Value = 'foreign'; },
    'wrong stage': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:stage')!.Value = 'foreign'; },
})) test(`${operation}: legacy AMI refuses ${label} before mutations`, async () => {
    const f = lifecycleFixture(operation); f.state.instances[0]!.ImageId = LEGACY_AMI; corrupt(f);
    const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});

for (const identity of ['cold', 'adopted'] as const) for (const [key, value] of [
    ['ezil:computer-id', 'foreign'], ['ezil:generation', '1'], ['ezil:fence-token', 'foreign'],
] as const) test(`release: legacy AMI ${identity} host refuses wrong ${key}`, async () => {
    const f = lifecycleFixture('release'), host = f.state.instances[0]!;
    host.ImageId = LEGACY_AMI;
    if (identity === 'cold') host.Tags = tagList({ ...tagsFor(f.i), 'aws:ec2launchtemplate:id': f.i.deployment.launchTemplateId });
    // Adopted hosts may carry canonical aliases too; contradictions must fail.
    host.Tags = [...host.Tags!.filter(t => t.Key !== key), { Key: key, Value: value }];
    const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});

test('pool-retire: legacy AMI refuses the wrong pool-host identity', async () => {
    const f = lifecycleFixture('pool-retire'); f.state.instances[0]!.ImageId = LEGACY_AMI;
    f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:pool-host')!.Value = randomUUID();
    const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});

for (const key of ['ezil:computer', 'ezil:fence']) test(`release: legacy AMI adopted host refuses wrong ${key}`, async () => {
    const f = lifecycleFixture('release'); f.state.instances[0]!.ImageId = LEGACY_AMI;
    f.state.instances[0]!.Tags!.find(t => t.Key === key)!.Value = randomUUID();
    const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});

for (const operation of ['start', 'adopt', 'provision', 'replace', 'pool-provision'] as const)
    test(`${operation}: legacy AMI still refuses before mutations`, async () => {
        const f = lifecycleFixture(operation);
        if (['provision', 'replace', 'pool-provision'].includes(operation)) {
            const instance = f.instance('i-33333333333333333'); instance.ImageId = LEGACY_AMI;
            if (operation === 'pool-provision') instance.Tags = tagList(poolTagsFor(f.i));
            // The target has this execution's client token, so it is validated
            // as the observed launch rather than issuing a new RunInstances.
            f.state.instances.push(instance);
            if (operation === 'provision') f.state.volumes.push(f.volume());
            if (operation === 'replace') {
                f.state.instances.shift(); f.state.volumes[0]!.State = 'available'; f.state.volumes[0]!.Attachments = [];
            }
        } else f.state.instances[0]!.ImageId = LEGACY_AMI;
        await assert.rejects(createLifecycleHelper(f.settings, f.deps)({ executionArn: f.executionArn, phase: 'initial' }), /lifecycle_instance_invalid/);
    });

for (const [label, corrupt] of Object.entries({
    'missing host identity': (f: Fixture) => { f.state.instances[0]!.Tags = []; },
    'old host generation': (f: Fixture) => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:generation')!.Value = '1'; },
    'newer volume generation': (f: Fixture) => { f.state.volumes[0]!.Tags!.find(t => t.Key === 'ezil:generation')!.Value = '3'; },
    'foreign volume fence': (f: Fixture) => { f.state.volumes[0]!.Tags!.find(t => t.Key === 'ezil:fence-token')!.Value = randomUUID(); },
    'foreign volume claim': (f: Fixture) => { f.state.volumes[0]!.Tags!.find(t => t.Key === 'ezil:fence')!.Value = randomUUID(); },
    'conflicting legacy host identity': (f: Fixture) => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:computer-id', Value: randomUUID() }); },
    'pool tag': (f: Fixture) => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:pool', Value: '1' }); },
})) test(`release refuses ${label}`, async () => {
    const f = lifecycleFixture('release'); corrupt(f); const r = await run(f);
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});

test('adopt requires an increasing generation with a fresh fence; equal generation requires the complete current tags', async () => {
    for (const tags of [(f: Fixture) => tagsFor(f.i, 1, f.i.fenceToken), (f: Fixture) => tagsFor(f.i)]) {
        const f = lifecycleFixture('adopt'); f.state.volumes[0]!.Tags = tagList(tags(f)); const r = await run(f);
        assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
    }
});

test('adopt observes the new volume generation and fence before attach and publishes the host fence only after attachment', async () => {
    const f = lifecycleFixture('adopt'), original = f.deps.volumes, old = structuredClone(f.state.volumes[0]!); let lag = true;
    f.deps.volumes = async ids => {
        const rows = await original(ids);
        if (rows[0]?.Tags?.some(t => t.Key === 'ezil:computer') && lag) { lag = false; return [old]; }
        return rows;
    };
    const r = await run(f); assert.equal(r.error, undefined);
    assert.ok(r.visited.indexOf('Observe-tagged') < r.visited.indexOf('attachVolume'));
    assert.ok(r.visited.indexOf('Observe-attached') < r.visited.indexOf('claimInstance'));
    assert.equal(r.visited.filter(s => s === 'Wait').length, 1);
});

test('adopt and release: authority rejects stale lease epochs and binds the reserved generation/fence digest', async () => {
    for (const operation of ['adopt', 'release'] as const) for (const field of ['leaseEpoch', 'targetGeneration', 'fenceToken'] as const) {
        const f = lifecycleFixture(operation), reserved = structuredClone(f.i), digest = f.digest;
        const changed = { ...f.i, [field]: field === 'fenceToken' ? randomUUID() : 1 };
        const document = JSON.stringify(changed);
        f.envelope.document = document; f.envelope.digest = createHash('sha256').update(document).digest('hex');
        f.state.execution.input = JSON.stringify(f.envelope);
        f.deps.authority = async (i, receivedDigest) => i.leaseEpoch === reserved.leaseEpoch && receivedDigest === digest;
        const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
    }
});

test('release waits for both EC2 views of detachment before terminating', async () => {
    const f = lifecycleFixture('release'), instances = f.deps.instances, attached = structuredClone(f.state.instances[0]!.BlockDeviceMappings);
    let lag = true;
    f.deps.instances = async ids => {
        const rows = await instances(ids);
        if (rows[0]?.instance.State?.Name === 'stopped' && rows[0].instance.BlockDeviceMappings?.length === 1 && lag) {
            lag = false; rows[0].instance.BlockDeviceMappings = attached;
        }
        return rows;
    };
    const r = await run(f); assert.equal(r.error, undefined); assert.equal(r.visited.filter(s => s === 'Wait').length, 1);
});

test('release: cold replacement of a prior pool volume uses its current canonical fence and remains replayable', async () => {
    const f = lifecycleFixture('release'); f.state.instances[0]!.Tags = tagList({ ...tagsFor(f.i), 'aws:ec2launchtemplate:id': f.i.deployment.launchTemplateId });
    f.state.volumes[0]!.Tags!.find(t => t.Key === 'ezil:fence')!.Value = randomUUID();
    const r = await run(f); assert.equal(r.error, undefined);
    assert.deepEqual(r.calls.map(c => c.step), ['stopInstances', 'detachVolume', 'terminateInstances']);
    assert.equal(r.output.volumeId, f.i.dataVolumeId); assert.equal(f.state.volumes[0]!.State, 'available');
    f.state.instances = [];
    const replay = await run(f); assert.equal(replay.error, undefined); assert.deepEqual(replay.output, r.output);
});
test('release: a cold replacement still refuses a foreign computer claim on its volume', async () => {
    const f = lifecycleFixture('release'); f.state.instances[0]!.Tags = tagList({ ...tagsFor(f.i), 'aws:ec2launchtemplate:id': f.i.deployment.launchTemplateId });
    f.state.volumes[0]!.Tags!.find(t => t.Key === 'ezil:computer')!.Value = randomUUID();
    const r = await run(f); assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
});

// R111FIX: transient DescribeInstances disk snapshots during release/stop.
const transitionalDisks: Record<string, (f: Fixture) => void> = {
    'root attaching': f => { f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.Status = 'attaching'; },
    'root detaching': f => { f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.Status = 'detaching'; },
    'root detached': f => { f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.Status = 'detached'; },
    'root status absent': f => { delete f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.Status; },
    'root volume absent': f => { delete f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.VolumeId; },
    'root Ebs absent': f => { delete f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs; },
    'data volume absent': f => { delete f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.VolumeId; },
    'data Ebs absent': f => { delete f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs; },
    'data attaching': f => { f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.Status = 'attaching'; },
    'data detaching': f => { f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.Status = 'detaching'; },
};
for (const status of ['stopping', 'stopped'] as const) for (const [label, change] of Object.entries(transitionalDisks))
    test(`release ${status}: ${label} waits in phase, then finishes`, async () => {
        const f = lifecycleFixture('release'), host = f.state.instances[0]!, maps = structuredClone(host.BlockDeviceMappings);
        host.State = { Name: status }; change(f);
        const helper = createLifecycleHelper(f.settings, f.deps);
        for (const phase of ['stopped', 'detached'] as const)
            assert.deepEqual(await helper({ executionArn: f.executionArn, phase }), { decision: 'wait', phase });
        host.BlockDeviceMappings = maps; host.State = { Name: 'stopped' };
        const r = await run(f);
        assert.equal(r.error, undefined, r.cause); assert.equal(r.output.state, 'retired');
        assert.deepEqual(r.calls.map(c => c.step), ['detachVolume', 'terminateInstances']);
    });

test('release stopping: empty mappings wait, then complete without a repeated stop', async () => {
    const f = lifecycleFixture('release'), describe = f.deps.instances;
    let observations = 0;
    f.deps.instances = async selector => {
        const rows = await describe(selector);
        if (rows[0]?.instance.State?.Name === 'stopped' && observations++ < 3) {
            rows[0].instance.State = { Name: 'stopping' }; rows[0].instance.BlockDeviceMappings = [];
        }
        return rows;
    };
    const r = await run(f);
    assert.equal(r.error, undefined, r.cause); assert.equal(r.output.state, 'retired');
    assert.deepEqual(r.calls.map(c => c.step), ['stopInstances', 'detachVolume', 'terminateInstances']);
    assert.equal(r.visited.filter(s => s === 'Observe-stopped').length, 4);
});

for (const [label, change] of Object.entries(transitionalDisks)) test(`release ${label}: unchanged snapshot expires without mutation`, async () => {
    const f = lifecycleFixture('release'); f.state.instances[0]!.State = { Name: 'stopped' }; change(f);
    const r = await run(f);
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.match(r.cause!, /lifecycle_expired/);
    assert.equal(r.output, undefined); assert.deepEqual(r.calls, []);
    assert.ok(f.state.now - f.state.execution.startDate.getTime() > 900000);
});

const unexpectedDisks: Record<string, (f: Fixture) => void> = {
    'other device': f => { f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdg', Ebs: { VolumeId: 'vol-99999999999999999' } }); },
    'other device without Ebs': f => { f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdg' }); },
    'device absent': f => { delete f.state.instances[0]!.BlockDeviceMappings![1]!.DeviceName; },
    'foreign data volume': f => { f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.VolumeId = 'vol-99999999999999999'; },
    'duplicate root': f => { f.state.instances[0]!.BlockDeviceMappings!.push(structuredClone(f.state.instances[0]!.BlockDeviceMappings![0]!)); },
    'missing root': f => { f.state.instances[0]!.BlockDeviceMappings!.shift(); },
    'mappings absent': f => { delete f.state.instances[0]!.BlockDeviceMappings; },
    'invalid root ID': f => { f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.VolumeId = 'invalid'; },
    'retained root': f => { f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.DeleteOnTermination = false; },
    'data used as root': f => { f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.VolumeId = f.i.dataVolumeId!; },
};
for (const status of ['stopping', 'stopped'] as const) for (const [label, change] of Object.entries(unexpectedDisks))
    test(`release ${status}: ${label} fails before mutations`, async () => {
        const f = lifecycleFixture('release'); f.state.instances[0]!.State = { Name: status }; change(f);
        const r = await run(f);
        assert.equal(r.error, 'LifecycleUnconfirmed'); assert.match(r.cause!, /lifecycle_unexpected_disk/);
        assert.deepEqual(r.calls, []); assert.equal(r.output, undefined);
    });

for (const [label, change] of Object.entries(unexpectedDisks).slice(0, 5)) test(`release: ${label} is not hidden by a transient root`, async () => {
    const f = lifecycleFixture('release'); f.state.instances[0]!.State = { Name: 'stopped' };
    transitionalDisks['root volume absent']!(f); change(f);
    const r = await run(f); assert.match(r.cause!, /lifecycle_unexpected_disk/); assert.deepEqual(r.calls, []);
});

test('release: empty mappings on stopped host fail closed', async () => {
    const f = lifecycleFixture('release'); f.state.instances[0]!.State = { Name: 'stopped' };
    f.state.instances[0]!.BlockDeviceMappings = [];
    const r = await run(f); assert.match(r.cause!, /lifecycle_unexpected_disk/); assert.deepEqual(r.calls, []);
});

for (const [label, change] of Object.entries(transitionalDisks)) test(`release free volume: ${label} cannot authorize termination`, async () => {
    const f = lifecycleFixture('release'); f.state.instances[0]!.State = { Name: 'stopped' }; change(f);
    f.state.volumes[0]!.State = 'available'; f.state.volumes[0]!.Attachments = [];
    assert.deepEqual(await createLifecycleHelper(f.settings, f.deps)({ executionArn: f.executionArn, phase: 'detached' }),
        { decision: 'wait', phase: 'detached' });
});

for (const [label, change] of Object.entries(unexpectedDisks).slice(0, 5)) test(`release free volume: ${label} still fails before termination`, async () => {
    const f = lifecycleFixture('release'); f.state.instances[0]!.State = { Name: 'stopped' }; change(f);
    f.state.volumes[0]!.State = 'available'; f.state.volumes[0]!.Attachments = [];
    const r = await run(f); assert.match(r.cause!, /lifecycle_unexpected_disk/); assert.deepEqual(r.calls, []);
});

for (const operation of ['pool-retire', 'adopt'] as const) for (const label of ['root attaching', 'root volume absent', 'root Ebs absent'])
    test(`${operation}: ${label} retains the strict disk guard`, async () => {
        const f = lifecycleFixture(operation); transitionalDisks[label]!(f);
        const r = await run(f); assert.match(r.cause!, /lifecycle_unexpected_disk/); assert.deepEqual(r.calls, []);
    });

for (const [label, change] of Object.entries(unexpectedDisks).slice(0, 5)) test(`terminate guard still refuses ${label}`, () => {
    const f = lifecycleFixture('release'); change(f);
    assert.throws(() => assertOnlyExpectedDisks(f.state.instances[0]!, f.state.volumes[0]!, '/dev/sda1'), /lifecycle_unexpected_disk/);
});

test('unexpected disk failure carries only sanitized device/status/identity evidence through Lambda conversion', async () => {
    const f = lifecycleFixture('release'), host = f.state.instances[0]!;
    host.State = { Name: 'stopped' }; unexpectedDisks['other device']!(f);
    host.BlockDeviceMappings![2]!.Ebs!.Status = 'attaching';
    const r = await run(f);
    assert.match(r.cause!, /lifecycle_unexpected_disk/);
    const message = JSON.parse(r.cause!).observeError.Cause as string;
    const evidence = JSON.parse(message.slice('lifecycle_unexpected_disk '.length));
    assert.deepEqual(evidence, { disks: [
        { device: '/dev/sda1', status: 'attached', matchesRoot: true, matchesData: false },
        { device: '/dev/sdf', status: 'attached', matchesRoot: false, matchesData: true },
        { device: '/dev/sdg', status: 'attaching', matchesRoot: false, matchesData: false },
    ] });
    assert.doesNotMatch(r.cause!, /vol-|i-[0-9a-f]{17}|computerId|fenceToken/);
});

function recoveryFixture() {
    const f = lifecycleFixture('release');
    Object.assign(f.i, { targetGeneration: 5, leaseEpoch: 6, providerInstanceId: 'i-0b2c3d4e5f6071829', dataVolumeId: 'vol-0b2c3d4e5f6071829' });
    const source = { ...f.i, operation: 'adopt' as const, jobId: randomUUID(), poolHostId: randomUUID(),
        deployment: { ...f.i.deployment, amiId: 'ami-0b4af31ed53e16f98' } };
    const document = JSON.stringify(source);
    f.i.adoptRecoverRelease = { sourceDocument: document, sourceDigest: createHash('sha256').update(document).digest('hex'),
        sourceVersion: source.deployment.stateMachineVersionArn,
        executionArn: source.deployment.stateMachineVersionArn.replace(':stateMachine:', ':execution:').replace(/:\d+$/, `:computer-${source.jobId}`),
        leaseToken: randomUUID(), poolGeneration: 1,
        proof: { historyDigest: 'ab'.repeat(32), attachEntered: 10, attachAcknowledged: 13, terminal: 18,
            claimNeverRan: true, redriveCount: 0, status: 'FAILED' } };
    f.i.deployment = { ...f.i.deployment, stateMachineVersionArn: f.i.deployment.stateMachineVersionArn.replace(/:1$/, ':2') };
    f.settings.deployment = f.i.deployment; f.state.execution.stateMachineVersionArn = f.i.deployment.stateMachineVersionArn;
    const h = f.state.instances[0]!, v = f.state.volumes[0]!;
    h.InstanceId = f.i.providerInstanceId!; h.ImageId = source.deployment.amiId;
    h.Tags = tagList({ ...poolTagsFor(source), 'aws:ec2launchtemplate:id': source.deployment.launchTemplateId,
        'aws:ec2launchtemplate:version': '1' });
    h.BlockDeviceMappings = h.BlockDeviceMappings!.slice(0, 1);
    v.VolumeId = f.i.dataVolumeId!; v.Tags = tagList({ ...tagsFor(f.i), ...claimTagsFor(f.i) }); f.attach(v, h);
    refreshRecovery(f);
    return f;
}
function refreshRecovery(f: Fixture) {
    f.envelope.document = JSON.stringify(f.i); f.envelope.digest = createHash('sha256').update(f.envelope.document).digest('hex');
    f.state.execution.input = JSON.stringify(f.envelope);
}
test('RECADOPT3 live generation 5 epoch 6 old pinned AMI: claim then release, never adopt or retag', async () => {
    const f = recoveryFixture(), r = await run(f);
    assert.equal(r.error, undefined, JSON.stringify(r));
    assert.deepEqual(r.calls.map(c => c.step), ['claimInstance', 'deleteTags', 'stopInstances', 'detachVolume', 'terminateInstances']);
    assert.equal(r.output.state, 'retired'); assert.equal(f.state.volumes[0]!.State, 'available');
    assert.deepEqual(f.state.volumes[0]!.Attachments, []);
});
for (const phase of ['initial', 'attached', 'claimed', 'unpooled'] as const)
    test(`RECADOPT3 empty available after attach acknowledgement preserves ${phase} until deadline`, async () => {
        const f = recoveryFixture(); f.state.volumes[0]!.State = 'available'; f.state.volumes[0]!.Attachments = [];
        const h = createLifecycleHelper(f.settings, f.deps);
        assert.deepEqual(await h({ executionArn: f.executionArn, phase }), { decision: 'wait', phase: phase === 'initial' ? 'attached' : phase });
        f.state.now += 901000;
        await assert.rejects(h({ executionArn: f.executionArn, phase }), /lifecycle_expired/);
    });
for (const step of ['claimInstance', 'deleteTags', 'stopInstances', 'detachVolume', 'terminateInstances'])
    test(`RECADOPT3 throttled ${step} preserves the claim/release boundary`, async () => {
        const r = await run(recoveryFixture(), { fail: { step, error: 'Ec2.RequestLimitExceeded', times: 1 } });
        assert.equal(r.error, undefined, JSON.stringify(r)); assert.equal(r.output.state, 'retired');
        assert.ok(r.calls.every(c => !['createTags', 'attachVolume'].includes(c.step)));
    });
const recoveryGuards: [string, (f: Fixture) => void][] = [
    ['foreign attachment', f => { f.state.volumes[0]!.Attachments![0]!.InstanceId = 'i-99999999999999999'; }],
    ['nonempty malformed attachment', f => { f.state.volumes[0]!.Attachments = [{}]; }],
    ['extra disk', f => { f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdg', Ebs: { VolumeId: 'vol-99999999999999999' } }); }],
    ['wrong original AMI', f => { f.state.instances[0]!.ImageId = f.i.deployment.amiId; }],
    ['wrong pool host', f => { f.state.instances[0]!.Tags!.find(t => t.Key === 'ezil:pool-host')!.Value = randomUUID(); }],
    ['foreign computer', f => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:computer', Value: randomUUID() }); }],
    ['canonical computer alias', f => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:computer-id', Value: f.i.computerId }); }],
    ['canonical fence alias', f => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:fence-token', Value: f.i.fenceToken }); }],
    ['partial claim', f => { f.state.instances[0]!.Tags!.push({ Key: 'ezil:generation', Value: '5' }); }],
    ['preexisting complete claim', f => { f.state.instances[0]!.Tags!.push(...tagList(claimTagsFor(f.i))); }],
    ['missing pool tag', f => { f.state.instances[0]!.Tags = f.state.instances[0]!.Tags!.filter(t => t.Key !== 'ezil:pool'); }],
    ['missing system provenance', f => { f.state.instances[0]!.Tags = f.state.instances[0]!.Tags!.filter(t => t.Key !== 'aws:ec2launchtemplate:id'); }],
    ['wrong data tags', f => { f.state.volumes[0]!.Tags!.find(t => t.Key === 'ezil:fence-token')!.Value = randomUUID(); }],
    ['wrong data key', f => { f.state.volumes[0]!.KmsKeyId = 'wrong'; }],
    ['wrong volume id', f => { f.state.volumes[0]!.VolumeId = 'vol-99999999999999999'; }],
    ['multiattach', f => { f.state.volumes[0]!.MultiAttachEnabled = true; }],
    ['data deletion', f => { f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.DeleteOnTermination = true; }],
    ['redrive execution', f => { f.state.execution.redriveCount = 1; }],
    ['wrong digest', f => { f.i.adoptRecoverRelease!.sourceDigest = '00'.repeat(32); }],
    ['wrong source version', f => { f.i.adoptRecoverRelease!.sourceVersion += '9'; }],
    ['wrong source execution', f => { f.i.adoptRecoverRelease!.executionArn += '9'; }],
    ['missing attach acknowledgement', f => { f.i.adoptRecoverRelease!.proof.attachAcknowledged = 0; }],
    ['ack before enter', f => { f.i.adoptRecoverRelease!.proof.attachAcknowledged = 1; }],
    ['ack after terminal', f => { f.i.adoptRecoverRelease!.proof.attachAcknowledged = 99; }],
    ['generation binding', f => { f.i.targetGeneration++; }],
    ['epoch binding', f => { f.i.leaseEpoch++; }],
    ['deployment binding', f => { f.i.deployment = { ...f.i.deployment, subnetId: 'subnet-99999999999999999' }; f.settings.deployment = f.i.deployment; }],
];
for (const [name, mutate] of recoveryGuards) test(`RECADOPT3 refuses ${name}`, async () => {
    const f = recoveryFixture(); mutate(f); refreshRecovery(f);
    const r = await run(f); assert.ok(r.error, JSON.stringify(r)); assert.deepEqual(r.calls, []);
});
for (const step of ['claimInstance', 'deleteTags']) test(`RECADOPT3 acknowledged invisible ${step} never repeats`, async () => {
    const r = await run(recoveryFixture(), { noEffect: step });
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.equal(r.calls.filter(c => c.step === step).length, 1);
});
test('RECADOPT3 binds the pool host after stop as well as before claim', async () => {
    const f = recoveryFixture(), host = f.state.instances[0]!;
    host.Tags = host.Tags!.filter(t => t.Key !== 'ezil:pool'); host.Tags.push(...tagList(claimTagsFor(f.i)));
    host.Tags.find(t => t.Key === 'ezil:pool-host')!.Value = randomUUID(); host.State = { Name: 'stopped' };
    await assert.rejects(createLifecycleHelper(f.settings, f.deps)({ executionArn: f.executionArn, phase: 'stopped' }), /lifecycle_instance_invalid/);
});

test('RECADOPT3 original AMI remains bound after stop', async () => {
    const f = recoveryFixture(), host = f.state.instances[0]!;
    host.Tags = host.Tags!.filter(t => t.Key !== 'ezil:pool'); host.Tags.push(...tagList(claimTagsFor(f.i)));
    host.ImageId = f.i.deployment.amiId; host.State = { Name: 'stopped' };
    await assert.rejects(createLifecycleHelper(f.settings, f.deps)({ executionArn: f.executionArn, phase: 'stopped' }), /lifecycle_instance_invalid/);
});

for (const persistent of [false, true]) test(`adopt mixed views ${persistent ? 'expires' : 'waits then claims'}`, async () => {
    const f = lifecycleFixture('adopt'), original = f.deps.instances;
    let lagged = 0;
    f.deps.instances = async selector => {
        const rows = await original(selector);
        const m = rows[0]?.instance.BlockDeviceMappings?.find(m => m.Ebs?.VolumeId === f.i.dataVolumeId);
        if (m && (persistent || lagged === 0)) { m.Ebs!.Status = 'attaching'; lagged++; }
        return rows;
    };
    const r = await run(f);
    assert.ok(lagged > 0);
    assert.equal(r.calls.filter(c => c.step === 'attachVolume').length, 1);
    if (persistent) {
        assert.equal(r.error, 'LifecycleUnconfirmed');
        assert.match(r.cause ?? '', /lifecycle_expired/);
        assert.equal(r.calls.some(c => c.step === 'claimInstance'), false);
    } else {
        assert.equal(r.error, undefined);
        const observed = r.visited.indexOf('Observe-attached');
        assert.deepEqual(r.visited.slice(observed, observed + 5), ['Observe-attached', 'Decide', 'Wait', 'Resume', 'Observe-attached']);
        assert.ok(r.visited.indexOf('claimInstance') > observed + 4);
        assert.equal(r.calls.filter(c => c.step === 'claimInstance').length, 1);
    }
});
for (const [label, corrupt] of Object.entries({
    'wrong host': (f: Fixture) => { f.state.volumes[0]!.Attachments![0]!.InstanceId = 'i-99999999999999999'; },
    'wrong volume': (f: Fixture) => { f.state.volumes[0]!.Attachments![0]!.VolumeId = 'vol-99999999999999999'; },
    'host device': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings![1]!.DeviceName = '/dev/sdg'; },
    'volume device': (f: Fixture) => { f.state.volumes[0]!.Attachments![0]!.Device = '/dev/sdg'; },
    'host deletion enabled': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.DeleteOnTermination = true; },
    'host deletion unknown': (f: Fixture) => { delete f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.DeleteOnTermination; },
    'volume deletion enabled': (f: Fixture) => { f.state.volumes[0]!.Attachments![0]!.DeleteOnTermination = true; },
    'volume deletion unknown': (f: Fixture) => { delete f.state.volumes[0]!.Attachments![0]!.DeleteOnTermination; },
    'duplicate mappings': (f: Fixture) => { f.state.instances[0]!.BlockDeviceMappings!.push(structuredClone(f.state.instances[0]!.BlockDeviceMappings![1]!)); },
    'duplicate attachments': (f: Fixture) => { f.state.volumes[0]!.Attachments!.push(structuredClone(f.state.volumes[0]!.Attachments![0]!)); },
    'detaching volume': (f: Fixture) => { f.state.volumes[0]!.Attachments![0]!.State = 'detaching'; },
})) test(`adopt mixed views refuses ${label}`, async () => {
    const f = lifecycleFixture('adopt');
    f.state.volumes[0]!.Tags = tagList({ ...tagsFor(f.i), ...claimTagsFor(f.i) });
    f.attach(f.state.volumes[0]!, f.state.instances[0]!);
    f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.Status = 'attaching';
    corrupt(f);
    const r = await run(f);
    assert.equal(r.error, 'LifecycleUnconfirmed'); assert.deepEqual(r.calls, []);
    assert.equal(r.visited.includes('Wait'), false);
});
