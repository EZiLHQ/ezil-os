import assert from 'node:assert/strict';
import test from 'node:test';
import { LifecycleDeploymentSchema, SourceLifecycleDeploymentSchema, recoveryDeploymentFor } from '../lib/lifecycle/deployment.js';
import { parsePreparationInput } from '../lib/lifecycle/preparation-contract.js';
import { createPreparationHelper } from '../lib/lifecycle/preparation-helper.js';
import { preparationDefinition } from '../lib/lifecycle/preparation-definition.js';
import { verifyImageRecoverySource } from '../lib/lifecycle/image-recovery-evidence.js';
import { matchesLifecycleDeployment, verifyPreparation } from '../lib/lifecycle/preparation-evidence.js';
import { parseReleaseManifest } from '../lib/lifecycle/release-manifest.js';
import { createRecoveryHelper } from '../lib/lifecycle/recovery-helper.js';
import { machineArn } from '../lib/lifecycle/recovery-contract.js';
import { parseLifecycleWork } from '../lib/lifecycle/intent.js';
import { parseImageRecoveryInput } from '../lib/lifecycle/recovery-contract.js';
import { golden, goldenInput, goldenPreparationFixture, legacyRecoveryFixture, legacyMaintenanceFixture } from './rebase-legacy-fixture.js';
import { envelopeFor, rebaseFixture } from './rebase-fixture.js';
import { runImageRecovery } from './image-recovery-fixture.js';
import { runAsl } from './asl.js';

test('legacy golden round-trips exact bytes; full-tuple sources still parse', () => {
    const p = golden();
    assert.equal(JSON.stringify(p.document), p.envelope.document);
    assert.equal(JSON.stringify(p.envelope), goldenInput);
    assert.equal(p.document.sourceDeployment.preparationStateMachineVersionArn, null);
    assert.equal(p.document.sourceDeployment.recoveryStateMachineVersionArn, null);
    assert.equal(p.document.sourceDeployment.previousLowerImageDigest, null);
    const full = rebaseFixture();
    assert.deepEqual(parsePreparationInput(JSON.stringify(full.preparationEnvelope)).document, full.preparation);
});

test('legacy golden preparation runs through fencing, snapshot and verified receipt', async () => {
    const f = goldenPreparationFixture(), helper = createPreparationHelper(f.settings, f.deps), calls: string[] = [];
    const result = await runAsl(preparationDefinition('observer:1'), { input: f.preparationEnvelope, executionArn: f.reference.executionArn,
        sleep: seconds => { f.state.now += seconds * 1000; }, invoke: async (_resource, parameters, name) => {
            if (name.startsWith('Observe-')) return helper(parameters);
            calls.push(name);
            if (name === 'stopInstances') { f.instance.State = { Name: 'stopped' }; return {}; }
            if (name === 'terminateInstances') { f.instance.State = { Name: 'terminated' }; f.instance.BlockDeviceMappings = [];
                f.volume.State = 'available'; f.volume.Attachments = []; return {}; }
            assert.equal(name, 'createSnapshot'); assert.equal(f.instance.State?.Name, 'terminated');
            const snapshot = f.snapshot(); f.state.snapshots.push(snapshot); return { SnapshotId: snapshot.SnapshotId };
        } });
    assert.equal(result.output?.state, 'snapshot_ready');
    assert.deepEqual(calls, ['stopInstances', 'terminateInstances', 'createSnapshot']);
    Object.assign(f.state.executions[f.reference.executionArn]!, { status: 'SUCCEEDED', stopDate: new Date(f.state.now), output: JSON.stringify(result.output) });
    assert.equal((await verifyPreparation(f.reference, f.settings.deployment.preparationStateMachineVersionArn!, f.deps)).receipt.digest, f.preparationEnvelope.digest);
});

test('legacy source recovery fences the failed writer and restores a new volume', async () => {
    const f = await runImageRecovery({}, legacyRecoveryFixture());
    assert.equal(f.result.output?.state, 'restore_volume_ready');
    assert.deepEqual(f.calls.map(c => c.name), ['Image-stop-target', 'Image-terminate-target', 'Image-createVolume']);
    assert.deepEqual(parseImageRecoveryInput(JSON.stringify(f.envelope)).document, f.document);
    assert.notEqual(f.result.output.volumeId, f.document.originalVolumeId);
    assert.equal(f.document.deployment.amiId, f.f.preparation.sourceDeployment.amiId);
    assert.equal(f.document.deployment.launchTemplateVersion, '3');
    assert.equal(f.document.deployment.stateMachineVersionArn, f.f.settings.deployment.stateMachineVersionArn);
});

test('legacy maintenance rebind uses the source AMI with current deployed workflow settings', async () => {
    const f = await legacyMaintenanceFixture(), result = await f.call();
    assert.equal(result.decision, 'runInstances');
    assert.equal((result.parameters as any).ImageId, f.f.preparation.sourceDeployment.amiId);
    assert.equal((result.parameters as any).LaunchTemplate.Version, '3');
    assert.equal((result.parameters as any).UserData, f.i.userData);
    assert.deepEqual(parseLifecycleWork({ ...f.rebind.envelope, createdAt: new Date(f.f.state.now) }), f.i);
});

test('legacy schema guards source identity, complete pins and digest lineage without relaxing targets', () => {
    const { document: p } = golden(), s = p.sourceDeployment;
    assert.equal(SourceLifecycleDeploymentSchema.safeParse(s).success, true);
    for (const key of ['lowerImageDigest', 'previousLowerImageDigest', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn']) {
        const missing = { ...s }; delete (missing as any)[key];
        assert.equal(SourceLifecycleDeploymentSchema.safeParse(missing).success, false, key);
    }
    for (const patch of [{ lowerImageDigest: null }, { previousLowerImageDigest: s.lowerImageDigest },
        { zoneId: 'euw2-az1' }, { dataKeyArn: 'foreign' }, { stateMachineVersionArn: s.stateMachineVersionArn.replace('123456789012', '999999999999') },
        { preparationStateMachineVersionArn: p.deployment.recoveryStateMachineVersionArn },
        { recoveryStateMachineVersionArn: p.deployment.recoveryStateMachineVersionArn!.replace(/:1$/, ':LIVE') }])
        assert.equal(SourceLifecycleDeploymentSchema.safeParse({ ...s, ...patch }).success, false, JSON.stringify(patch));
    for (const field of ['preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn'] as const) {
        assert.equal(SourceLifecycleDeploymentSchema.safeParse({ ...s, [field]: p.deployment[field] }).success, true);
        for (const value of [null, undefined, 'foreign']) {
            assert.throws(() => parsePreparationInput(JSON.stringify(envelopeFor({ ...p, deployment: { ...p.deployment, [field]: value } }))));
            assert.equal(LifecycleDeploymentSchema.safeParse({ ...p.deployment, [field]: value }).success, false);
        }
    }
    const full = { ...s, preparationStateMachineVersionArn: p.deployment.preparationStateMachineVersionArn!, recoveryStateMachineVersionArn: p.deployment.recoveryStateMachineVersionArn! };
    assert.deepEqual(recoveryDeploymentFor(full, p.deployment), full);
    assert.equal(SourceLifecycleDeploymentSchema.safeParse({ ...full, stateMachineVersionArn: full.preparationStateMachineVersionArn }).success, false);
    assert.throws(() => parsePreparationInput(JSON.stringify(envelopeFor({ ...p, fromDigest: p.toDigest }))));
    assert.throws(() => parsePreparationInput(JSON.stringify(envelopeFor({ ...p, sourceDeployment: { ...s, lowerImageDigest: 'sha256:' + 'c'.repeat(64) } }))));
    for (const patch of [{ accountId: '999999999999' }, { zoneId: 'aps1-az2' }, { lowerImageDigest: p.toDigest }])
        assert.throws(() => recoveryDeploymentFor({ ...s, ...patch }, p.deployment));
    const noncanonical = JSON.stringify({ ...p, sourceDeployment: Object.fromEntries(Object.entries(s).reverse()) });
    assert.throws(() => parsePreparationInput(JSON.stringify({ schemaVersion: 1, document: noncanonical, digest: envelopeFor(JSON.parse(noncanonical)).digest })));
});

test('legacy recovery rejects resource or workflow substitutions before cloning', async () => {
    const f = legacyRecoveryFixture();
    await verifyImageRecoverySource(f.document, f.deps);
    for (const patch of [{ amiId: f.f.preparation.deployment.amiId }, { launchTemplateVersion: '99' },
        { stateMachineVersionArn: f.f.preparation.sourceDeployment.stateMachineVersionArn }])
        await assert.rejects(verifyImageRecoverySource({ ...f.document, deployment: { ...f.document.deployment, ...patch } }, f.deps), /restore_lineage_mismatch/);
});

test('legacy maintenance admission requires restore permit, exact source resources and configured preparation', async () => {
    const f = await legacyMaintenanceFixture();
    assert.equal((await f.call()).decision, 'runInstances');
    const configured = f.f.settings.deployment;
    for (const i of [{ ...f.i, rebasePreparation: undefined }, { ...f.i, userData: null },
        { ...f.i, userData: f.launch.userData }, { ...f.i, deployment: { ...f.i.deployment, amiId: 'ami-99999999999999999' } }])
        assert.equal(await matchesLifecycleDeployment(i, configured, f.deps), false);
    assert.equal(await matchesLifecycleDeployment(f.i, { ...configured, preparationStateMachineVersionArn: undefined }, f.deps), false);
    assert.equal(await matchesLifecycleDeployment(f.i, { ...configured, launchTemplateVersion: '99' }, f.deps), false);
    const full = await legacyMaintenanceFixture(), p = full.f.preparation;
    p.sourceDeployment.preparationStateMachineVersionArn = p.deployment.preparationStateMachineVersionArn!;
    p.sourceDeployment.recoveryStateMachineVersionArn = p.deployment.recoveryStateMachineVersionArn!;
    const envelope = envelopeFor(p), execution = full.f.state.executions[full.f.reference.executionArn]!;
    execution.input = JSON.stringify(envelope);
    execution.output = JSON.stringify({ ...JSON.parse(execution.output!), digest: envelope.digest });
    const historical = { ...full.i, deployment: LifecycleDeploymentSchema.parse(p.sourceDeployment),
        rebasePreparation: { ...full.i.rebasePreparation!, digest: envelope.digest } };
    assert.equal(await matchesLifecycleDeployment(historical, p.deployment, full.deps), false, 'workflow version must equal the executing configured version');
    f.f.state.executions[f.f.reference.executionArn]!.redriveCount = 1;
    await assert.rejects(f.call());
});


test('legacy release manifest accepts its actual source deployment only in source mode', () => {
    const d = golden().document.sourceDeployment, repository = `${d.accountId}.dkr.ecr.${d.region}.amazonaws.com/ezil/desktop`;
    const manifest = { schemaVersion: 1, accountId: d.accountId, region: d.region, namespace: d.namespace, amiId: d.amiId,
        recipeVersion: '1.0.2', lowerImageDigest: d.lowerImageDigest, lowerImageRef: repository + '@' + d.lowerImageDigest,
        previousLowerImageDigest: null, previousLowerImageRef: null, agentCommit: 'e'.repeat(40),
        stateMachineVersionArn: d.stateMachineVersionArn, preparationStateMachineVersionArn: null, recoveryStateMachineVersionArn: null,
        launchTemplateId: d.launchTemplateId, launchTemplateVersion: d.launchTemplateVersion, createdAt: '2026-10-22T11:00:00.000Z' };
    assert.deepEqual(parseReleaseManifest(JSON.stringify(manifest), d, repository, 'source'), manifest);
    for (const mode of ['target', 'maintenance'] as const) assert.throws(() => parseReleaseManifest(JSON.stringify(manifest), d, repository, mode));
});

test('legacy rebind failure remains eligible for automatic cleanup on the current workflow', async () => {
    const f = await legacyMaintenanceFixture(), state = f.f.state;
    assert.equal((await f.call()).decision, 'runInstances');
    // A definite failed launch with no RunInstances entry has no new writer.
    state.now += 120000;
    const source = state.executions[f.maintenanceExecutionArn]!;
    Object.assign(source, { status: 'FAILED', stopDate: new Date(state.now - 60000) });
    const machine = machineArn(f.settings.recoveryVersionArn), name = 'cleanup-computer-' + f.i.jobId;
    const executionArn = machine.replace(':stateMachine:', ':execution:') + ':' + name;
    state.executions[executionArn] = { executionArn, stateMachineArn: machine, stateMachineVersionArn: f.settings.recoveryVersionArn,
        name, status: 'RUNNING', redriveCount: 0, startDate: new Date(state.now), input: JSON.stringify({ sourceExecutionArn: f.maintenanceExecutionArn }) };
    const deps = { ...f.deps, history: async () => [
        { id: 1, type: 'ExecutionStarted' as const, timestamp: source.startDate },
        { id: 2, type: 'ExecutionFailed' as const, timestamp: source.stopDate },
    ] };
    const result = await createRecoveryHelper(f.settings, deps)({ executionArn, phase: 'initial' });
    assert.equal(result.decision, 'success');
});
