import assert from 'node:assert/strict';
import test from 'node:test';
import { recoveryDefinition } from '../lib/lifecycle/recovery-definition.js';
import { RecoveryInputSchema, parseImageRecoveryInput, restoreToken, recoveryAuthority } from '../lib/lifecycle/recovery-contract.js';
import { imageRecoveryFixture, runImageRecovery } from './image-recovery-fixture.js';
import { runAsl, taskError } from './asl.js';
import { envelopeFor } from './rebase-fixture.js';

test('image recovery fences failed writer, quarantines original, creates clone and returns ordered receipt', async () => {
    const r = await runImageRecovery();
    assert.deepEqual(r.calls.map(c => c.name), ['Image-stop-target', 'Image-terminate-target', 'Image-createVolume']);
    assert.equal(r.result.error, undefined); assert.equal(r.result.output.state, 'restore_volume_ready');
    assert.notEqual(r.result.output.volumeId, r.document.originalVolumeId);
    assert.deepEqual(Object.keys(r.result.output), ['schemaVersion', 'jobId', 'digest', 'imageJobId', 'state', 'sourceExecutionArn', 'snapshotId',
        'originalVolumeId', 'volumeId', 'fsUuid', 'sourceGeneration', 'sourceLeaseEpoch', 'sourceFenceToken', 'fromDigest', 'verifiedAt']);
    assert.equal(r.result.data.ctl.volumeId, r.result.output.volumeId);
    assert.deepEqual(Object.keys(r.calls[2]!.parameters), ['SnapshotId', 'AvailabilityZoneId', 'Size', 'VolumeType', 'Iops', 'Throughput', 'Encrypted', 'KmsKeyId', 'ClientToken', 'TagSpecifications']);
});
test('lost CreateVolume reply adopts one lineage match without a second create', async () => {
    const r = await runImageRecovery({ lost: true }); assert.equal(r.result.output.state, 'restore_volume_ready');
    assert.equal(r.calls.filter(c => c.name === 'Image-createVolume').length, 1);
});
test('lost CreateVolume reply with no visible volume repeats exactly the same idempotent request', async () => {
    const r = await runImageRecovery({ invisibleOnce: true }); assert.equal(r.result.output.state, 'restore_volume_ready');
    const calls = r.calls.filter(c => c.name === 'Image-createVolume'); assert.equal(calls.length, 2); assert.deepEqual(calls[0], calls[1]);
});
test('duplicate lineage is unconfirmed and pending clones time out without a success receipt', async () => {
    const duplicate = await runImageRecovery({ lost: true, duplicate: true });
    assert.equal(duplicate.result.error, 'EbsRestoreUnconfirmed'); assert.equal(duplicate.result.cause, 'restore_lineage_mismatch');
    const pending = await runImageRecovery({ pending: true }); assert.equal(pending.result.output, undefined); assert.equal(pending.result.cause, 'restore_failed');
});
test('current image authority is checked before every mutation and before receipt', async () => {
    const f = imageRecoveryFixture(); const requests: unknown[] = [];
    f.deps.imageAuthority = async request => { requests.push(request); return requests.length < 2; };
    const result = await f.helper(f.event); assert.equal(result.code, 'authority_revoked');
    assert.deepEqual(requests, [recoveryAuthority(f.document, f.envelope.digest), recoveryAuthority(f.document, f.envelope.digest)]);
});
test('cleanup execution prefix and input union cannot enter snapshot restore', async () => {
    const f = imageRecoveryFixture();
    assert.equal((await f.helper({ ...f.event, executionArn: f.executionArn.replace(':computer-', ':cleanup-computer-') })).decision, 'failed');
    await assert.rejects(f.helper({ executionArn: f.executionArn, phase: 'initial' }));
    assert.throws(() => parseImageRecoveryInput(JSON.stringify({ sourceExecutionArn: f.sourceExecutionArn })));
    assert.ok(RecoveryInputSchema.safeParse(f.envelope).success);
    assert.ok(RecoveryInputSchema.safeParse({ sourceExecutionArn: f.sourceExecutionArn }).success);
    assert.equal(RecoveryInputSchema.safeParse({ ...f.envelope, sourceExecutionArn: f.sourceExecutionArn }).success, false);
    const graph = recoveryDefinition('observer:1'); assert.equal(graph.TimeoutSeconds, 660);
    assert.ok(!Object.values(graph.States).some((s: any) => s.Resource?.endsWith(':createVolume')));
});
test('closed recovery document rejects unknown keys, duplicate keys, hash, identity and source-lower mismatch', () => {
    const f = imageRecoveryFixture(); assert.deepEqual(parseImageRecoveryInput(JSON.stringify(f.envelope)).document, f.document);
    for (const patch of [{ extra: 1 }, { imageJobId: f.document.jobId }, { fromDigest: 'sha256:' + 'b'.repeat(64) },
        { sourceLeaseEpoch: true }, { createdAt: '2026-02-30T00:00:00.000Z' }])
        assert.throws(() => parseImageRecoveryInput(JSON.stringify(envelopeFor({ ...f.document, ...patch }))));
    assert.throws(() => parseImageRecoveryInput(JSON.stringify({ ...f.envelope, digest: '0'.repeat(64) })));
    const duplicate = f.envelope.document.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    assert.throws(() => parseImageRecoveryInput(JSON.stringify({ ...envelopeFor({}), document: duplicate })));
});
const invalid: Record<string, (f: ReturnType<typeof imageRecoveryFixture>) => void> = {
    'redriven source': f => { f.f.state.executions[f.sourceExecutionArn]!.redriveCount = 1; },
    'successful source': f => { f.f.state.executions[f.sourceExecutionArn]!.status = 'SUCCEEDED'; },
    'wrong source version': f => { f.f.state.executions[f.sourceExecutionArn]!.stateMachineVersionArn += '2'; },
    'wrong source history': f => { f.history[1]!.id = 8; },
    'pending preparation': f => { f.f.state.executions[f.f.reference.executionArn]!.status = 'RUNNING'; },
    'foreign snapshot owner': f => { f.f.state.snapshots[0]!.OwnerId = '999999999999'; },
    'absent possible failed writer': f => { f.f.state.instances.pop(); },
    'foreign writer tags': f => { f.writer.Tags![0]!.Value = 'foreign'; },
    'unsafe termination disk': f => { f.writer.BlockDeviceMappings![1]!.Ebs!.DeleteOnTermination = true; },
    'foreign original volume': f => { f.f.volume.KmsKeyId = 'foreign'; },
    'lost authority': f => { f.f.state.authorized = false; },
};
for (const [label, mutate] of Object.entries(invalid)) test('image recovery refuses ' + label, async () => {
    const f = imageRecoveryFixture(); mutate(f); const result = await f.helper(f.event);
    assert.ok(['failed', 'unconfirmed'].includes(String(result.decision))); assert.equal(result.parameters, undefined);
});
