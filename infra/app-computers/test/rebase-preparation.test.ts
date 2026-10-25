import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createPreparationHelper, preparationControl } from '../lib/lifecycle/preparation-helper.js';
import { preparationDefinition } from '../lib/lifecycle/preparation-definition.js';
import { verifyPreparation } from '../lib/lifecycle/preparation-evidence.js';
import { preparationFixture } from './preparation-fixture.js';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { authorityFor } from '../lib/lifecycle/contract.js';
import { runAsl, taskError } from './asl.js';

async function run(options: { lost?: boolean; duplicate?: boolean; absent?: boolean; pending?: boolean; revoke?: boolean } = {}) {
    const f = preparationFixture(), helper = createPreparationHelper(f.settings, f.deps), calls: string[] = [];
    const result = await runAsl(preparationDefinition('observer:1'), { input: f.preparationEnvelope, executionArn: f.reference.executionArn,
        sleep: seconds => { f.state.now += seconds * 1000; }, invoke: async (_resource, p, name) => {
            if (name.startsWith('Observe-')) return helper(p);
            calls.push(name);
            if (name === 'stopInstances') { assert.deepEqual(p, { InstanceIds: [f.instance.InstanceId], Force: false, Hibernate: false, SkipOsShutdown: false }); f.instance.State = { Name: 'stopped' }; return {}; }
            if (name === 'terminateInstances') { f.instance.State = { Name: 'terminated' }; f.instance.BlockDeviceMappings = [];
                f.volume.State = 'available'; f.volume.Attachments = []; return {}; }
            assert.equal(name, 'createSnapshot');
            assert.deepEqual(Object.keys(p), ['VolumeId', 'Description', 'TagSpecifications']);
            assert.equal(p.Description, 'EZiL pre-rebase checkpoint');
            assert.equal(f.instance.State?.Name, 'terminated'); assert.equal(f.volume.State, 'available');
            const snapshot = f.snapshot(); if (options.pending) snapshot.State = 'pending';
            if (!options.absent) f.state.snapshots.push(snapshot);
            if (options.duplicate) f.state.snapshots.push({ ...snapshot, SnapshotId: 'snap-22222222222222222' });
            if (options.revoke) f.state.authorized = false;
            if (options.lost) throw taskError('States.Timeout');
            return { SnapshotId: snapshot.SnapshotId };
        }, maxSteps: options.pending ? 4000 : 100 });
    return { f, result, calls };
}
test('preparation fences before snapshot, persists ID, polls and outputs the exact receipt', async () => {
    const { f, result, calls } = await run();
    assert.deepEqual(calls, ['stopInstances', 'terminateInstances', 'createSnapshot']);
    assert.equal(result.output.state, 'snapshot_ready'); assert.equal(result.output.digest, f.reference.digest);
    assert.equal(result.data.ctl.snapshotId, f.lease.rebase.snapshotId);
    assert.ok(Date.parse(result.output.fencedAt) <= Date.parse(result.output.snapshotStartedAt));
    assert.ok(result.visited.includes('PersistSnapshot'));
    Object.assign(f.state.executions[f.reference.executionArn]!, { status: 'SUCCEEDED', stopDate: new Date(f.state.now), output: JSON.stringify(result.output) });
    assert.equal((await verifyPreparation(f.reference, f.settings.deployment.preparationStateMachineVersionArn!, f.deps)).receipt.snapshotId, result.output.snapshotId);
    f.state.snapshots[0]!.Encrypted = false;
    await assert.rejects(verifyPreparation(f.reference, f.settings.deployment.preparationStateMachineVersionArn!, f.deps), /snapshot_identity_mismatch/);
});
test('lost CreateSnapshot response adopts one matching snapshot without another create', async () => {
    const { result, calls } = await run({ lost: true }); assert.equal(result.output.state, 'snapshot_ready'); assert.equal(calls.filter(v => v === 'createSnapshot').length, 1);
});
test('lost CreateSnapshot response with two matches fails snapshot_ambiguous', async () => {
    const { result, calls } = await run({ lost: true, duplicate: true });
    assert.equal(result.error, 'RebasePreparationUnconfirmed'); assert.equal(result.cause, 'snapshot_ambiguous'); assert.equal(calls.filter(v => v === 'createSnapshot').length, 1);
});
test('lost CreateSnapshot response with zero matches remains unconfirmed', async () => {
    const { result, calls } = await run({ lost: true, absent: true });
    assert.equal(result.error, 'RebasePreparationUnconfirmed'); assert.equal(result.cause, 'snapshot_create_unconfirmed'); assert.equal(calls.filter(v => v === 'createSnapshot').length, 1);
});
test('pending snapshot never succeeds and reaches the two-hour deadline', async () => {
    const { result, calls } = await run({ pending: true }); assert.equal(result.cause, 'preparation_timeout'); assert.equal(result.output, undefined); assert.equal(calls.filter(v => v === 'createSnapshot').length, 1);
});
test('revoked reservation cannot produce snapshot_ready', async () => { const { result } = await run({ revoke: true }); assert.equal(result.cause, 'authority_revoked'); });
test('absence alone never proves a fenced source', async () => {
    const f = preparationFixture(); f.state.instances = []; f.volume.Attachments = []; f.volume.State = 'available';
    const result = await createPreparationHelper(f.settings, f.deps)({ executionArn: f.reference.executionArn, phase: 'initial', control: preparationControl });
    assert.equal(result.code, 'writer_not_fenced');
});
test('fixed graph has 7200-second timeout, 15-second polls, no mutation retry and exact create fields', () => {
    const graph = preparationDefinition('observer:1'); assert.equal(graph.TimeoutSeconds, 7200); assert.equal(graph.States.PollSnapshot.Seconds, 15);
    for (const name of ['stopInstances', 'terminateInstances', 'createSnapshot']) assert.equal(graph.States[name].Retry, undefined);
    assert.deepEqual(Object.keys(graph.States.createSnapshot.Parameters), ['VolumeId.$', 'Description.$', 'TagSpecifications.$']);
});
test('snapshot owner, source, key, tags, timestamp, state and stale reservation mismatches fail closed', async () => {
    const mutations: ((f: ReturnType<typeof preparationFixture>) => unknown)[] = [f => f.state.snapshots[0]!.OwnerId = '999999999999',
        f => f.state.snapshots[0]!.VolumeId = 'vol-99999999999999999', f => f.state.snapshots[0]!.KmsKeyId = 'foreign',
        f => f.state.snapshots[0]!.VolumeSize = 21, f => f.state.snapshots[0]!.Tags!.push(f.state.snapshots[0]!.Tags![0]!),
        f => f.state.snapshots[0]!.StartTime = new Date(f.state.now + 1), f => f.state.snapshots[0]!.State = 'error',
        f => f.volume.Tags![3]!.Value = '2'];
    for (const mutate of mutations) {
        const f = preparationFixture(); f.instance.State = { Name: 'terminated' }; f.volume.State = 'available'; f.volume.Attachments = [];
        f.state.snapshots.push(f.snapshot()); mutate(f);
        const result = await createPreparationHelper(f.settings, f.deps)({ executionArn: f.reference.executionArn, phase: 'snapshot', control: {
            ...preparationControl, fencedAt: f.preparation.createdAt, snapshotId: f.lease.rebase.snapshotId, createAttempted: true } });
        assert.equal(result.decision, 'failed');
    }
});

async function launchFixture() {
    const { f, result } = await run();
    Object.assign(f.state.executions[f.reference.executionArn]!, { status: 'SUCCEEDED', stopDate: new Date(f.state.now), output: JSON.stringify(result.output) });
    f.state.now = Date.parse(f.lease.rebasePermit.issuedAt);
    const version = f.intent.deployment.stateMachineVersionArn, machine = version.replace(/:1$/, '');
    const executionArn = machine.replace(':stateMachine:', ':execution:') + ':computer-' + f.intent.jobId;
    f.state.executions[executionArn] = { executionArn, stateMachineArn: machine, stateMachineVersionArn: version,
        name: 'computer-' + f.intent.jobId, input: JSON.stringify(f.envelope), startDate: new Date(f.state.now), status: 'RUNNING', redriveCount: 0 };
    return { f, executionArn, helper: createLifecycleHelper(f.settings, f.deps) };
}
test('launch repeats the successful preparation and snapshot checks then forwards the unchanged lease', async () => {
    const { f, executionArn, helper } = await launchFixture();
    const result = await helper({ executionArn, phase: 'initial' });
    assert.equal(result.decision, 'runInstances'); assert.equal((result.parameters as any).UserData, f.intent.userData);
    assert.deepEqual(authorityFor(f.intent, f.envelope.digest), { schemaVersion: 1, computerId: f.intent.computerId, jobId: f.intent.jobId,
        leaseEpoch: f.intent.leaseEpoch, digest: f.envelope.digest, imageJobId: f.preparation.jobId, imageJobPhase: 'launch' });
});
test('launch refuses pending, foreign, redriven, altered or stale preparation evidence', async () => {
    const mutations: ((f: Awaited<ReturnType<typeof launchFixture>>['f']) => void)[] = [
        f => { f.state.executions[f.reference.executionArn]!.status = 'RUNNING'; },
        f => { f.state.executions[f.reference.executionArn]!.redriveCount = 1; },
        f => { f.state.executions[f.reference.executionArn]!.stateMachineAliasArn = 'alias'; },
        f => { f.state.snapshots[0]!.State = 'pending'; },
        f => { f.state.snapshots[0]!.OwnerId = '999999999999'; },
        f => { f.state.executions[f.reference.executionArn]!.input = f.state.executions[f.reference.executionArn]!.input!.replace(f.preparationEnvelope.digest, 'f'.repeat(64)); },
        f => { f.state.now = Date.parse(f.lease.rebasePermit.expiresAt) - 120000; },
    ];
    for (const mutate of mutations) { const { f, executionArn, helper } = await launchFixture(); mutate(f); await assert.rejects(helper({ executionArn, phase: 'initial' })); }
});
test('authority revoked during snapshot recheck prevents launch', async () => {
    const { f, executionArn, helper } = await launchFixture(), snapshots = f.deps.snapshots!;
    f.deps.snapshots = async selector => { const result = await snapshots(selector); f.state.authorized = false; return result; };
    await assert.rejects(helper({ executionArn, phase: 'initial' }), /lifecycle_authority_denied/);
});

test('retained source uses its own approved subnet instead of the new deployment subnet', async () => {
    const { f, executionArn, helper } = await launchFixture();
    f.preparation.sourceDeployment.subnetId = 'subnet-22222222222222222';
    f.instance.SubnetId = f.preparation.sourceDeployment.subnetId;
    const document = JSON.stringify(f.preparation), digest = createHash('sha256').update(document).digest('hex');
    f.intent.rebasePreparation!.digest = digest;
    const preparationExecution = f.state.executions[f.reference.executionArn]!;
    preparationExecution.input = JSON.stringify({ schemaVersion: 1, document, digest });
    preparationExecution.output = JSON.stringify({ ...JSON.parse(preparationExecution.output!), digest });
    const launchDocument = JSON.stringify(f.intent);
    f.state.executions[executionArn]!.input = JSON.stringify({ schemaVersion: 1, document: launchDocument,
        digest: createHash('sha256').update(launchDocument).digest('hex') });
    assert.equal((await helper({ executionArn, phase: 'initial' })).decision, 'runInstances');
    f.instance.SubnetId = 'subnet-33333333333333333';
    await assert.rejects(helper({ executionArn, phase: 'initial' }), /lifecycle_instance_invalid/);
});
test('a late preparation authority denial is a bounded failure before the provider mutation', async () => {
    const f = preparationFixture(); let calls = 0;
    f.deps.imageAuthority = async () => ++calls < 2;
    const result = await createPreparationHelper(f.settings, f.deps)({ executionArn: f.reference.executionArn, phase: 'initial', control: preparationControl });
    assert.equal(result.decision, 'failed'); assert.equal(result.code, 'authority_revoked'); assert.equal(result.parameters, undefined);
});
