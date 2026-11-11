import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { createPreparationHelper, preparationControl } from '../lib/lifecycle/preparation-helper.js';
import { preparationDefinition } from '../lib/lifecycle/preparation-definition.js';
import { verifyPreparation } from '../lib/lifecycle/preparation-evidence.js';
import { parsePreparationInput, PreparationDocumentSchema } from '../lib/lifecycle/preparation-contract.js';
import { preparationFixture } from './preparation-fixture.js';
import { envelopeFor, rebaseFixture } from './rebase-fixture.js';
import { createLifecycleHelper } from '../lib/lifecycle/helper.js';
import { authorityFor, tagList } from '../lib/lifecycle/contract.js';
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
// App DESIGN R: a STOPPED computer's released warm-pool host. The document is the app's pinned bytes (aws-rebase-released.fixtures.json).
const pinned = JSON.parse(readFileSync(join(__dirname, '../../../app/src/server/lib/compute/aws-rebase-released.fixtures.json'), 'utf8'))['released-pool-preparation'];
function releasedFixture() {
    const base = rebaseFixture(), released = JSON.parse(pinned.document).releasedPoolHost;
    const preparation = PreparationDocumentSchema.parse({ ...base.preparation, releasedPoolHost: released }), preparationEnvelope = envelopeFor(preparation);
    return { ...base, preparation, preparationEnvelope, reference: { ...base.reference, digest: preparationEnvelope.digest } };
}
type Released = ReturnType<typeof preparationFixture>;
/** EC2 still listing the released host: terminated, claim identity, no canonical or pool tag. */
const terminatedClaim = (f: Released) => Object.assign(f.instance, { State: { Name: 'terminated' }, BlockDeviceMappings: [], Tags: tagList({
    'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot', 'ezil:namespace': 'pilot', 'ezil:pool-host': f.preparation.releasedPoolHost!.poolHostId,
    'ezil:computer': f.preparation.computerId, 'ezil:generation': String(f.preparation.sourceGeneration), 'ezil:fence': f.preparation.sourceFenceToken }) });
async function runReleased(mutate: (f: Released) => void = () => {}) {
    const f = preparationFixture(releasedFixture()), calls: string[] = [];
    f.state.instances = []; f.volume.State = 'available'; f.volume.Attachments = []; mutate(f);
    const helper = createPreparationHelper(f.settings, f.deps);
    const result = await runAsl(preparationDefinition('observer:1'), { input: f.preparationEnvelope, executionArn: f.reference.executionArn,
        sleep: seconds => { f.state.now += seconds * 1000; }, invoke: async (_resource, p, name) => {
            if (name.startsWith('Observe-')) return helper(p);
            calls.push(name); assert.equal(name, 'createSnapshot');
            const snapshot = f.snapshot(); f.state.snapshots.push(snapshot); return { SnapshotId: snapshot.SnapshotId };
        }, maxSteps: 100 });
    return { f, result, calls };
}
const observe = (f: Released, control: Record<string, unknown> = preparationControl, phase: 'initial' | 'snapshot' = 'initial') =>
    createPreparationHelper(f.settings, f.deps)({ executionArn: f.reference.executionArn, phase, control });
test('released pool host: infra re-stringifies the app document byte-for-byte, field last; existing digests unchanged', () => {
    const f = releasedFixture();
    assert.equal(JSON.stringify(f.preparation), pinned.document); assert.equal(f.preparationEnvelope.digest, pinned.digest);
    assert.equal(Object.keys(f.preparation).at(-1), 'releasedPoolHost');
    assert.equal(parsePreparationInput(JSON.stringify(f.preparationEnvelope)).document.releasedPoolHost!.poolHostId, JSON.parse(pinned.document).releasedPoolHost.poolHostId);
    const base = rebaseFixture(); assert.equal(JSON.stringify(base.preparation).includes('releasedPoolHost'), false);
    assert.equal(base.preparationEnvelope.digest, base.intent.rebasePreparation!.digest);
});
test('released pool host: the pre-change strict document shape refuses the field, so an older helper fails closed', () => {
    const old = PreparationDocumentSchema.innerType().omit({ releasedPoolHost: true }).strict(), f = releasedFixture();
    assert.equal(old.safeParse(rebaseFixture().preparation).success, true);
    const r = old.safeParse(f.preparation);
    assert.equal(r.success, false); assert.deepEqual(r.error!.issues.map(i => [i.code, (i as { keys?: string[] }).keys]), [['unrecognized_keys', ['releasedPoolHost']]]);
});
test('released pool host: a release outside this namespace lifecycle machine is release_mismatch', () => {
    const f = releasedFixture(), arn = f.preparation.releasedPoolHost!.releaseExecutionArn;
    for (const releaseExecutionArn of [arn.replace('-lifecycle:', '-recovery:'), arn.replace('123456789012', '999999999999'), arn.replace(':ap-south-1:', ':us-east-1:')])
        assert.throws(() => PreparationDocumentSchema.parse({ ...f.preparation, releasedPoolHost: { ...f.preparation.releasedPoolHost, releaseExecutionArn } }), /release_mismatch/);
});
test('released pool host aged out of EC2: fences at observation, snapshots, never stops or terminates', async () => {
    const { f, result, calls } = await runReleased();
    assert.deepEqual(calls, ['createSnapshot']);
    assert.equal(result.output.state, 'snapshot_ready'); assert.equal(result.output.digest, f.reference.digest);
    assert.ok(Date.parse(result.output.fencedAt) <= Date.parse(result.output.snapshotStartedAt));
});
test('without the released field an absent source stays unfenced (the branch is load-bearing)', async () => {
    const f = preparationFixture(); f.state.instances = []; f.volume.State = 'available'; f.volume.Attachments = [];
    assert.equal((await observe(f)).code, 'writer_not_fenced');
    const r = preparationFixture(releasedFixture()); r.state.instances = []; r.volume.State = 'available'; r.volume.Attachments = [];
    assert.equal((await observe(r)).decision, 'createSnapshot');
});
// Any listed host, even the exact terminated claim of this allocation: launch, recovery and maintenance refuse its claim tags.
for (const state of ['terminated', 'shutting-down', 'running', 'pending', 'stopping', 'stopped']) {
    test(`released pool host: a listed ${state} host is source_identity_mismatch with no provider action`, async () => {
        const { result, calls } = await runReleased(f => { terminatedClaim(f); f.instance.State = { Name: state as 'running' }; f.state.instances = [f.instance]; });
        assert.equal(result.cause, 'source_identity_mismatch'); assert.deepEqual(calls, []);
    });
}
// App DESIGN R2: a regular (non-pool) host retired by a proven normal release; the app's document carries only the release.
function retiredFixture() {
    const base = rebaseFixture(), releaseExecutionArn = JSON.parse(pinned.document).releasedPoolHost.releaseExecutionArn as string;
    const preparation = PreparationDocumentSchema.parse({ ...base.preparation, retiredSource: { releaseExecutionArn } }), preparationEnvelope = envelopeFor(preparation);
    return { ...base, preparation, preparationEnvelope, reference: { ...base.reference, digest: preparationEnvelope.digest } };
}
async function runRetired(mutate: (f: Released) => void = () => {}) {
    const f = preparationFixture(retiredFixture()), calls: string[] = [];
    f.state.instances = []; f.volume.State = 'available'; f.volume.Attachments = []; mutate(f);
    const helper = createPreparationHelper(f.settings, f.deps);
    const result = await runAsl(preparationDefinition('observer:1'), { input: f.preparationEnvelope, executionArn: f.reference.executionArn,
        sleep: seconds => { f.state.now += seconds * 1000; }, invoke: async (_resource, p, name) => {
            if (name.startsWith('Observe-')) return helper(p);
            calls.push(name); assert.equal(name, 'createSnapshot');
            const snapshot = f.snapshot(); f.state.snapshots.push(snapshot); return { SnapshotId: snapshot.SnapshotId };
        }, maxSteps: 100 });
    return { f, result, calls };
}
test('retired regular source: strict last key, never with releasedPoolHost, release on this namespace lifecycle machine only', () => {
    const f = retiredFixture(), arn = f.preparation.retiredSource!.releaseExecutionArn;
    assert.equal(Object.keys(f.preparation).at(-1), 'retiredSource');
    assert.deepEqual(parsePreparationInput(JSON.stringify(f.preparationEnvelope)).document.retiredSource, { releaseExecutionArn: arn });
    assert.equal(JSON.stringify(rebaseFixture().preparation).includes('retiredSource'), false);
    assert.throws(() => PreparationDocumentSchema.parse({ ...releasedFixture().preparation, retiredSource: { releaseExecutionArn: arn } }), /release_mismatch/);
    for (const releaseExecutionArn of [arn.replace('-lifecycle:', '-recovery:'), arn.replace('123456789012', '999999999999'), arn.replace(':ap-south-1:', ':us-east-1:')])
        assert.throws(() => PreparationDocumentSchema.parse({ ...f.preparation, retiredSource: { releaseExecutionArn } }), /release_mismatch/);
    assert.throws(() => PreparationDocumentSchema.parse({ ...f.preparation, retiredSource: { releaseExecutionArn: arn, extra: 1 } }));
    const old = PreparationDocumentSchema.innerType().omit({ retiredSource: true }).strict(), r = old.safeParse(f.preparation);
    assert.equal(r.success, false); assert.deepEqual(r.error!.issues.map(i => [i.code, (i as { keys?: string[] }).keys]), [['unrecognized_keys', ['retiredSource']]]);
});
test('retired regular source aged out of EC2: fences at observation, snapshots, never stops or terminates', async () => {
    const { f, result, calls } = await runRetired();
    assert.deepEqual(calls, ['createSnapshot']);
    assert.equal(result.output.state, 'snapshot_ready'); assert.equal(result.output.digest, f.reference.digest);
    assert.ok(Date.parse(result.output.fencedAt) <= Date.parse(result.output.snapshotStartedAt));
});
// A listed source, even the exact canonical source instance, is refused: the app proved it gone; EC2 disagreeing is never resolved here.
for (const state of ['terminated', 'shutting-down', 'running', 'pending', 'stopping', 'stopped']) {
    test(`retired regular source: a listed ${state} source is source_identity_mismatch with no provider action`, async () => {
        const { result, calls } = await runRetired(f => { f.instance.State = { Name: state as 'running' }; f.state.instances = [f.instance]; });
        assert.equal(result.cause, 'source_identity_mismatch'); assert.deepEqual(calls, []);
    });
}
for (const [name, volume] of [['attached', { State: 'in-use', Attachments: [{ InstanceId: 'i-99999999999999999', VolumeId: 'vol-11111111111111111', State: 'attached' }] }],
    ['attaching', { State: 'available', Attachments: [{ InstanceId: 'i-99999999999999999', VolumeId: 'vol-11111111111111111', State: 'attaching' }] }],
    ['detaching (in-use, empty)', { State: 'in-use', Attachments: [] }]] as const) {
    test(`retired regular source: a ${name} volume is writer_not_fenced at once, never a wait`, async () => {
        const f = preparationFixture(retiredFixture()); f.state.instances = []; Object.assign(f.volume, structuredClone(volume));
        assert.deepEqual(await observe(f), { decision: 'failed', code: 'writer_not_fenced' });
        const { result, calls } = await runRetired(r => Object.assign(r.volume, structuredClone(volume)));
        assert.equal(result.cause, 'writer_not_fenced'); assert.deepEqual(calls, []);
    });
}
for (const [name, volume] of [['attached', { State: 'in-use', Attachments: [{ InstanceId: 'i-99999999999999999', VolumeId: 'vol-11111111111111111', State: 'attached' }] }],
    ['attaching', { State: 'available', Attachments: [{ InstanceId: 'i-99999999999999999', VolumeId: 'vol-11111111111111111', State: 'attaching' }] }],
    ['detaching (in-use, empty)', { State: 'in-use', Attachments: [] }]] as const) {
    test(`released pool host: a ${name} volume is writer_not_fenced at once, never a wait`, async () => {
        const f = preparationFixture(releasedFixture()); f.state.instances = []; Object.assign(f.volume, structuredClone(volume));
        assert.deepEqual(await observe(f), { decision: 'failed', code: 'writer_not_fenced' });
        const { result, calls } = await runReleased(r => Object.assign(r.volume, structuredClone(volume)));
        assert.equal(result.cause, 'writer_not_fenced'); assert.deepEqual(calls, []);
    });
}
test('released pool host: a writer attaching after the fence fails closed while the snapshot is pending', async () => {
    const f = preparationFixture(releasedFixture()); f.state.instances = []; f.volume.State = 'available'; f.volume.Attachments = [];
    const control = { ...preparationControl, fencedAt: f.preparation.createdAt, snapshotId: f.lease.rebase.snapshotId, createAttempted: true };
    f.state.snapshots.push({ ...f.snapshot(), State: 'pending' });
    assert.equal((await observe(f, control, 'snapshot')).decision, 'wait');
    Object.assign(f.volume, { State: 'in-use', Attachments: [{ InstanceId: 'i-99999999999999999', VolumeId: f.volume.VolumeId, State: 'attached' }] });
    assert.deepEqual(await observe(f, control, 'snapshot'), { decision: 'failed', code: 'writer_not_fenced' });
});
/** The launch after a released preparation: the app's launch intent re-bound to the released digest (as the subnet test does). */
async function releasedLaunch(listed: boolean) {
    const { f, result } = await runReleased();
    assert.equal(result.output.state, 'snapshot_ready');
    Object.assign(f.state.executions[f.reference.executionArn]!, { status: 'SUCCEEDED', stopDate: new Date(f.state.now), output: JSON.stringify(result.output) });
    f.state.now = Date.parse(f.lease.rebasePermit.issuedAt);
    if (listed) { terminatedClaim(f); f.state.instances = [f.instance]; }
    f.intent.rebasePreparation!.digest = f.reference.digest;
    const version = f.intent.deployment.stateMachineVersionArn, machine = version.replace(/:1$/, '');
    const executionArn = machine.replace(':stateMachine:', ':execution:') + ':computer-' + f.intent.jobId, document = JSON.stringify(f.intent);
    f.state.executions[executionArn] = { executionArn, stateMachineArn: machine, stateMachineVersionArn: version, name: 'computer-' + f.intent.jobId,
        input: JSON.stringify({ schemaVersion: 1, document, digest: createHash('sha256').update(document).digest('hex') }),
        startDate: new Date(f.state.now), status: 'RUNNING', redriveCount: 0 };
    return { f, executionArn, helper: createLifecycleHelper(f.settings, f.deps) };
}
test('released pool host: the launch re-verifies the released preparation and launches over an aged-out source', async () => {
    const { executionArn, helper } = await releasedLaunch(false);
    assert.equal((await helper({ executionArn, phase: 'initial' })).decision, 'runInstances');
});
test('released pool host: the launch refuses a released claim EC2 still lists, which is why preparation refuses it first', async () => {
    const { executionArn, helper } = await releasedLaunch(true);
    await assert.rejects(helper({ executionArn, phase: 'initial' }), /lifecycle_instance_invalid/);
});
test('released pool host: canonical volume tags are still required', async () => {
    const { result, calls } = await runReleased(f => { f.volume.Tags = f.volume.Tags!.map(t => t.Key === 'ezil:generation' ? { ...t, Value: '2' } : t); });
    assert.equal(result.cause, 'source_identity_mismatch'); assert.deepEqual(calls, []);
});
test('a late preparation authority denial is a bounded failure before the provider mutation', async () => {
    const f = preparationFixture(); let calls = 0;
    f.deps.imageAuthority = async () => ++calls < 2;
    const result = await createPreparationHelper(f.settings, f.deps)({ executionArn: f.reference.executionArn, phase: 'initial', control: preparationControl });
    assert.equal(result.decision, 'failed'); assert.equal(result.code, 'authority_revoked'); assert.equal(result.parameters, undefined);
});
