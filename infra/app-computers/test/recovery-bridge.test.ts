import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryBridgeDeploymentFor } from '../lib/lifecycle/deployment.js';
import { verifyPreparation } from '../lib/lifecycle/preparation-evidence.js';
import { imageRecoveryFixture, runImageRecovery } from './image-recovery-fixture.js';
import { preparationFixture } from './preparation-fixture.js';
import { envelopeFor, rebaseFixture, rebindFixture } from './rebase-fixture.js';
import { maintenanceFixtureAfterRestore } from './rebase-legacy-fixture.js';

function bridgeFixture() {
    const source = rebaseFixture(), rebind = rebindFixture();
    const incumbent = source.preparation.sourceDeployment;
    incumbent.preparationStateMachineVersionArn = incumbent.preparationStateMachineVersionArn!.replace(/:[0-9]+$/, ':3');
    incumbent.recoveryStateMachineVersionArn = incumbent.recoveryStateMachineVersionArn!.replace(/:[0-9]+$/, ':4');
    incumbent.launchTemplateVersion = '3';
    const candidate = source.preparation.deployment;
    candidate.preparationStateMachineVersionArn = candidate.preparationStateMachineVersionArn!.replace(/:[0-9]+$/, ':5');
    candidate.recoveryStateMachineVersionArn = candidate.recoveryStateMachineVersionArn!.replace(/:[0-9]+$/, ':6');
    source.preparationEnvelope = envelopeFor(source.preparation);
    source.reference.digest = source.preparationEnvelope.digest;
    source.intent.deployment = candidate;
    source.intent.rebasePreparation = source.reference;
    source.envelope = envelopeFor(source.intent);
    const restoreDeployment = recoveryBridgeDeploymentFor(incumbent, candidate);
    assert.ok(restoreDeployment);
    rebind.intent.deployment = restoreDeployment;
    rebind.intent.rebasePreparation = source.reference;
    rebind.envelope = envelopeFor(rebind.intent);
    return imageRecoveryFixture(preparationFixture(source), rebind, 2);
}

test('V2 verifies the new immutable preparation and restores a clone without altering the old source volume', async () => {
    const fixture = bridgeFixture();
    const incumbent = fixture.f.preparation.sourceDeployment, candidate = fixture.f.preparation.deployment;
    await assert.rejects(verifyPreparation(fixture.f.reference, incumbent.preparationStateMachineVersionArn!, fixture.deps), /preparation_failed/);
    const { document } = await verifyPreparation(fixture.f.reference, candidate.preparationStateMachineVersionArn!, fixture.deps);
    assert.deepEqual(document.sourceDeployment, incumbent);
    assert.deepEqual(document.deployment, candidate);
    const f = await runImageRecovery({}, fixture);
    assert.equal(f.result.output?.state, 'restore_volume_ready');
    assert.deepEqual(f.calls.map(c => c.name), ['Image-stop-target', 'Image-terminate-target', 'Image-createVolume']);
    assert.equal(f.result.output.snapshotId, f.document.snapshotId);
    assert.notEqual(f.result.output.volumeId, f.document.originalVolumeId);
    assert.equal(f.f.volume.State, 'available');
    assert.deepEqual(f.f.volume.Attachments, []);
    assert.equal(f.document.deployment.amiId, incumbent.amiId);
    assert.equal(f.document.deployment.launchTemplateVersion, '3');
    assert.equal(f.document.deployment.lowerImageDigest, incumbent.lowerImageDigest);
    assert.equal(f.document.deployment.recoveryStateMachineVersionArn, candidate.recoveryStateMachineVersionArn);
});

test('V2 fails before EC2 changes on old preparation execution or a relabeled V1 document', async () => {
    for (const [mismatch, error] of [['old-preparation', 'restore_failed'], ['legacy-document', 'restore_lineage_mismatch']]) {
        const f = bridgeFixture(), state = f.f.state;
        if (mismatch === 'old-preparation') {
            state.executions[f.f.reference.executionArn]!.stateMachineVersionArn = f.f.preparation.sourceDeployment.preparationStateMachineVersionArn!;
        } else {
            const envelope = envelopeFor({ ...f.document, schemaVersion: 1 });
            Object.assign(f.envelope, envelope);
            state.executions[f.executionArn]!.input = JSON.stringify(envelope);
        }
        const checkpoint = structuredClone({ instances: state.instances, volumes: state.volumes, snapshots: state.snapshots });
        const result = await runImageRecovery({}, f);
        assert.equal(result.result.cause, error, mismatch);
        assert.deepEqual(result.calls, [], mismatch);
        assert.deepEqual({ instances: state.instances, volumes: state.volumes, snapshots: state.snapshots }, checkpoint, mismatch);
    }
});

test('V2 rebind uses the incumbent AMI and launch template and requires the immutable recovery execution', async () => {
    const f = await maintenanceFixtureAfterRestore(bridgeFixture());
    const result = await f.call();
    assert.equal(result.decision, 'runInstances');
    assert.equal((result.parameters as { ImageId: string }).ImageId, f.f.preparation.sourceDeployment.amiId);
    assert.equal((result.parameters as { LaunchTemplate: { Version: string } }).LaunchTemplate.Version, '3');
    const execution = f.f.state.executions[f.executionArn]!;
    execution.stateMachineVersionArn = f.f.preparation.sourceDeployment.recoveryStateMachineVersionArn!;
    await assert.rejects(f.call());
});
