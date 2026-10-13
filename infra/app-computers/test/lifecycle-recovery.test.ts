import assert from 'node:assert/strict';
import test from 'node:test';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { createRecoveryHelper } from '../lib/lifecycle/recovery-helper.js';
import { recoveryDefinition } from '../lib/lifecycle/recovery-definition.js';
import { machineArn, type RecoverySettings } from '../lib/lifecycle/recovery-contract.js';
import type { RecoveryDependencies } from '../lib/lifecycle/recovery-aws.js';
import { tagsFor, tagList } from '../lib/lifecycle/contract.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
import { runAsl, taskError } from './asl.js';
import { toLambdaError } from '../lib/lifecycle/errors.js';

function fixture(operation: Parameters<typeof lifecycleFixture>[0] = 'provision', allocated = true) {
    const f = lifecycleFixture(operation);
    const settings: RecoverySettings = { lifecycle: f.settings,
        recoveryVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-lifecycle-recovery:1' };
    const name = `cleanup-computer-${f.i.jobId}`;
    const arn = machineArn(settings.recoveryVersionArn).replace(':stateMachine:', ':execution:') + ':' + name;
    const source = { ...f.state.execution, status: 'FAILED', startDate: new Date(f.state.now - 120000), stopDate: new Date(f.state.now - 61000) };
    const recovery = { executionArn: arn, name, stateMachineArn: machineArn(settings.recoveryVersionArn),
        stateMachineVersionArn: settings.recoveryVersionArn, redriveCount: 0, status: 'RUNNING',
        startDate: new Date(f.state.now - 1000), input: JSON.stringify({ sourceExecutionArn: f.executionArn }) };
    const history: HistoryEvent[] = [{ id: 1, type: 'ExecutionStarted', timestamp: source.startDate }];
    const entered = (name: string) => history.splice(history.length - 1, 0, {
        id: 0, type: 'TaskStateEntered', timestamp: source.startDate, stateEnteredEventDetails: { name } });
    history.push({ id: 2, type: 'ExecutionFailed', timestamp: source.stopDate });
    if (operation === 'provision' && allocated) { f.state.volumes.push(f.volume()); entered('createVolume'); }
    if ((operation === 'provision' || operation === 'replace') && allocated) {
        entered('runInstances');
        if (operation === 'replace') {
            const old = f.state.instances[0]!; old.State = { Name: 'terminated' }; old.BlockDeviceMappings = [];
            f.state.volumes[0]!.Tags = tagList(tagsFor(f.i));
        }
        const target = f.instance('i-33333333333333333'); f.state.instances.push(target); f.attach(f.state.volumes[0]!, target);
    }
    // Source history remains immutable for each test, while provider observations advance.
    const deps: RecoveryDependencies = { ...f.deps,
        execution: async id => structuredClone(id === arn ? recovery : source) as any,
        history: async () => structuredClone(history.map((h, index) => ({ ...h, id: index + 1 }))),
    };
    return { ...f, settings, arn, source, recovery, history, entered, deps };
}

async function run(f = fixture(), options: { lose?: string; noEffect?: string; staleOld?: boolean } = {}) {
    const helper = createRecoveryHelper(f.settings, f.deps), graph = recoveryDefinition('helper');
    const calls: { action: string; parameters: any }[] = [];
    let lost = false;
    if (options.staleOld) {
        const original = f.deps.instances; let stale = false;
        f.deps.instances = async selector => {
            const rows = await original(selector);
            if (Array.isArray(selector) && calls.some(c => c.action === 'stopInstances') && !stale) {
                stale = true; rows[0]!.instance.State = { Name: 'stopped' };
            }
            return rows;
        };
    }
    for (const s of Object.values(graph.States) as any[]) if (s.Type === 'Task' && s.Resource !== 'helper') assert.equal(s.Retry, undefined);
    const result = await runAsl(graph, { input: { sourceExecutionArn: f.executionArn }, executionArn: f.arn, maxSteps: 3000,
        sleep: seconds => { f.state.now += seconds * 1000; },
        invoke: async (resource, parameters) => {
            if (resource === 'helper') { try { return await helper(parameters); } catch (error) { throw toLambdaError(error, 'lifecycle_recovery_unconfirmed'); } }
            const action = resource.split(':').at(-1)!; calls.push({ action, parameters });
            const target = f.state.instances.find(i => i.InstanceId === (parameters.InstanceIds?.[0] ?? parameters.InstanceId))!;
            if (action !== options.noEffect) {
                if (action === 'stopInstances') target.State = { Name: 'stopped' };
                else if (action === 'terminateInstances') {
                    assert.equal(target.State?.Name, 'stopped');
                    assert.ok(target.BlockDeviceMappings!.every(m => m.DeviceName === '/dev/xvda' || m.Ebs?.DeleteOnTermination === false));
                    target.State = { Name: 'terminated' }; target.BlockDeviceMappings = [];
                    const v = f.state.volumes[0]!;
                    v.Attachments = v.Attachments!.filter(a => a.InstanceId !== target.InstanceId);
                    if (!v.Attachments.length) v.State = 'available';
                } else assert.fail(`forbidden cleanup action: ${action}`);
            }
            if (action === options.lose && !lost) { lost = true; throw taskError('Ec2.Ec2Exception', 'lost response'); }
            return {};
        } });
    return { error: result.error, cause: result.cause, receipt: result.output, calls, f };
}

for (const operation of ['provision', 'start', 'stop', 'replace', 'retire'] as const) test(`recovery fences ${operation} writers and retains their data disk`, async () => {
    const f = fixture(operation);
    const result = await run(f); assert.equal(result.error, undefined); assert.equal(result.receipt.state, 'fenced');
    assert.equal(result.receipt.jobId, f.i.jobId); assert.equal(result.receipt.volumeId, f.state.volumes[0]!.VolumeId);
    assert.ok(f.state.instances.every(i => i.State?.Name === 'terminated'));
    assert.equal(f.state.volumes[0]!.State, 'available'); assert.equal(f.state.volumes.length, 1);
    assert.equal(f.state.authorityCalls, 0);
});
test('a failure before any allocation can prove no resource effects', async () => {
    const result = await run(fixture('provision', false)); assert.equal(result.error, undefined);
    assert.equal(result.receipt.volumeId, null); assert.deepEqual(result.receipt.instances, []); assert.deepEqual(result.calls, []);
});
test('a data-only allocation is retained without launching a computer', async () => {
    const f = fixture('provision', false); f.state.volumes.push(f.volume()); f.entered('createVolume');
    const result = await run(f); assert.equal(result.error, undefined); assert.equal(result.receipt.volumeId, f.state.volumes[0]!.VolumeId);
    assert.deepEqual(result.calls, []);
});
for (const action of ['createVolume', 'runInstances']) test(`uncertain ${action} cannot be called absent after a lost response`, async () => {
    const f = fixture('provision', false); f.entered('createVolume');
    if (action === 'runInstances') { f.state.volumes.push(f.volume()); f.entered('runInstances'); }
    const result = await run(f); assert.equal(result.error, 'LifecycleRecoveryUnconfirmed'); assert.equal(result.receipt, undefined); assert.deepEqual(result.calls, []);
});
test('a data disk marked DeleteOnTermination is refused, never repaired or terminated', async () => {
    const f = fixture(); f.state.instances.at(-1)!.BlockDeviceMappings!.find(m => m.DeviceName === '/dev/sdf')!.Ebs!.DeleteOnTermination = true;
    f.state.volumes[0]!.Attachments![0]!.DeleteOnTermination = true;
    const result = await run(f); assert.equal(result.error, 'LifecycleRecoveryUnconfirmed'); assert.equal(result.receipt, undefined);
    assert.deepEqual(result.calls, []); assert.match(result.cause!, /lifecycle_recovery_unconfirmed/);
});
test('a delayed allocation is observed and fenced without relaunching it', async () => {
    const f = fixture(), original = f.deps.instances; let reads = 0;
    f.deps.instances = async selector => ++reads < 3 ? [] : original(selector);
    const result = await run(f); assert.equal(result.error, undefined); assert.ok(reads >= 3);
    assert.deepEqual(result.calls.map(c => c.action), ['stopInstances', 'terminateInstances']);
});
for (const action of ['stopInstances', 'terminateInstances']) {
    test(`lost recovery ${action} advances to observation without a second request`, async () => {
        const result = await run(fixture(), { lose: action }); assert.equal(result.error, undefined);
        assert.equal(result.calls.filter(c => c.action === action).length, 1);
    });
    test(`unconfirmed recovery ${action} retains the reservation and cannot claim fencing`, async () => {
        const result = await run(fixture(), { lose: action, noEffect: action }); assert.equal(result.error, 'LifecycleRecoveryUnconfirmed');
        assert.equal(result.receipt, undefined); assert.equal(result.calls.filter(c => c.action === action).length, 1);
    });
}
test('delayed start is positively fenced even when the first read says stopped', async () => {
    const result = await run(fixture('start')); assert.equal(result.error, undefined);
    assert.deepEqual(result.calls.map(c => c.action), ['terminateInstances']);
});
test('an interrupted replacement before allocation fences only the original writer', async () => {
    const result = await run(fixture('replace', false)); assert.equal(result.error, undefined);
    assert.equal(result.receipt.instances.length, 1); assert.equal(result.receipt.instances[0].generation, 1);
});
test('stale old-writer state never retargets recovery or repeats its termination', async () => {
    const result = await run(fixture('replace'), { staleOld: true }); assert.equal(result.error, undefined);
    assert.ok(result.calls.every(c => (c.parameters.InstanceIds ?? [c.parameters.InstanceId])[0] === 'i-33333333333333333'));
});
test('foreign disks, newer generations and unexpected attached disks prohibit cleanup mutations', async () => {
    for (const kind of ['foreign', 'newer', 'attachment', 'extra-disk']) {
        const f = fixture();
        if (kind === 'foreign') f.state.volumes[0]!.Tags = [];
        if (kind === 'newer') f.state.instances[0]!.Tags = tagList(tagsFor(f.i, 9));
        if (kind === 'attachment') f.state.volumes[0]!.Attachments![0]!.InstanceId = 'i-99999999999999999';
        if (kind === 'extra-disk') f.state.instances[0]!.BlockDeviceMappings!.push({ DeviceName: '/dev/sdg', Ebs: { VolumeId: 'vol-99999999999999999', DeleteOnTermination: true } });
        const result = await run(f); assert.equal(result.error, 'LifecycleRecoveryUnconfirmed'); assert.deepEqual(result.calls, []);
    }
});
test('successful/running sources, redrives and forged recovery identity cannot trigger cleanup', async () => {
    for (const kind of ['SUCCEEDED', 'RUNNING', 'redrive', 'version', 'name', 'input']) {
        const f = fixture();
        if (kind === 'SUCCEEDED' || kind === 'RUNNING') f.source.status = kind;
        if (kind === 'redrive') f.source.redriveCount = 1;
        if (kind === 'version') f.recovery.stateMachineVersionArn = f.settings.recoveryVersionArn.replace(':1', ':2');
        if (kind === 'name') f.recovery.name = 'forged';
        if (kind === 'input') f.recovery.input = JSON.stringify({ sourceExecutionArn: f.executionArn, instanceId: 'i-99999999999999999' });
        const result = await run(f); assert.equal(result.error, 'LifecycleRecoveryUnconfirmed'); assert.deepEqual(result.calls, []);
    }
});
test('incomplete history never proves an allocation did not run', async () => {
    for (const kind of ['missing-end', 'missing-name', 'id-gap']) {
        const f = fixture('provision', false);
        if (kind === 'missing-end') f.history.pop();
        if (kind === 'missing-name') f.entered('');
        if (kind === 'id-gap') { const original = f.deps.history; f.deps.history = async arn => (await original(arn)).map(h => ({ ...h, id: h.id! + 1 })); }
        const result = await run(f); assert.equal(result.error, 'LifecycleRecoveryUnconfirmed'); assert.deepEqual(result.calls, []);
    }
});
test('slow recovery reads cannot issue a mutation beyond the original recovery deadline', async () => {
    const f = fixture(), original = f.deps.instances;
    f.deps.instances = async selector => { const rows = await original(selector); f.state.now += 580000; return rows; };
    const result = await run(f); assert.equal(result.error, 'LifecycleRecoveryUnconfirmed'); assert.deepEqual(result.calls, []);
});
test('recovery accepts a grown data disk inside the range and refuses one outside it', async () => {
    for (const [size, ok] of [[80, true], [101, false], [19, false]] as const) {
        const f = fixture(); f.state.volumes[0]!.Size = size;
        const result = await run(f);
        if (ok) assert.equal(result.error, undefined);
        else { assert.equal(result.error, 'LifecycleRecoveryUnconfirmed'); assert.deepEqual(result.calls, []); }
    }
});
test('recovery refuses a data disk under another KMS key or with multi-attach', async () => {
    for (const mutate of [(v: any) => { v.KmsKeyId = v.KmsKeyId.replace(/1111-4111/, '9999-4999'); }, (v: any) => { v.MultiAttachEnabled = true; }]) {
        const f = fixture(); mutate(f.state.volumes[0]!);
        const result = await run(f); assert.equal(result.error, 'LifecycleRecoveryUnconfirmed'); assert.deepEqual(result.calls, []);
    }
});
test('recovery lets interrupted SDK tasks settle for 60 s before reading terminal history', async () => {
    const f = fixture(); f.source.stopDate = new Date(f.state.now - 10000);
    let historyReads = 0; const original = f.deps.history; f.deps.history = async arn => { historyReads++; return original(arn); };
    const first = await createRecoveryHelper(f.settings, f.deps)({ executionArn: f.arn, phase: 'initial' });
    assert.deepEqual(first, { decision: 'wait', phase: 'initial' }); assert.equal(historyReads, 0);
    f.state.now += 51000;
    const later = await createRecoveryHelper(f.settings, f.deps)({ executionArn: f.arn, phase: 'initial' });
    assert.notDeepEqual(later, { decision: 'wait', phase: 'initial' }); assert.ok(historyReads > 0);
});
