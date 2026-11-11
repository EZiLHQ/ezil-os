import assert from 'node:assert/strict';
import test from 'node:test';
import { createPreparationHelper, preparationControl } from '../lib/lifecycle/preparation-helper.js';
import { preparationDefinition } from '../lib/lifecycle/preparation-definition.js';
import { parsePreparationInput, PreparationDocumentSchema } from '../lib/lifecycle/preparation-contract.js';
import { preparationFixture } from './preparation-fixture.js';
import { envelopeFor, rebaseFixture } from './rebase-fixture.js';
import { runAsl } from './asl.js';

// Synthetic app evidence; these identifiers are not live execution claims.
function dedicatedFixture() {
    const base = rebaseFixture();
    const prefix = 'arn:aws:states:ap-south-1:123456789012:execution:ezil-pilot-lifecycle:computer-';
    const releasedDedicatedHost = { imageJobId: '33333333-3333-4333-8333-333333333333', provisionDigest: 'a'.repeat(64),
        provisionExecutionArn: prefix + '44444444-4444-4444-8444-444444444444',
        releaseExecutionArn: prefix + '55555555-5555-4555-8555-555555555555' };
    const preparation = PreparationDocumentSchema.parse({ ...base.preparation, releasedDedicatedHost });
    const preparationEnvelope = envelopeFor(preparation);
    return { ...base, preparation, preparationEnvelope, reference: { ...base.reference, digest: preparationEnvelope.digest } };
}
type Fixture = ReturnType<typeof preparationFixture>;
const observe = (f: Fixture, control: Record<string, unknown> = preparationControl, phase: 'initial' | 'snapshot' = 'initial') =>
    createPreparationHelper(f.settings, f.deps)({ executionArn: f.reference.executionArn, phase, control });
function ready() {
    const f = preparationFixture(dedicatedFixture());
    f.state.instances = []; f.volume.State = 'available'; f.volume.Attachments = [];
    return f;
}

test('dedicated preparation has a distinct canonical field and preserves old document digests', () => {
    const f = dedicatedFixture(), input = parsePreparationInput(JSON.stringify(f.preparationEnvelope));
    assert.equal(JSON.stringify(input.document), f.preparationEnvelope.document);
    assert.equal(input.envelope.digest, f.preparationEnvelope.digest);
    assert.equal(Object.keys(input.document).at(-1), 'releasedDedicatedHost');
    assert.equal(input.document.releasedPoolHost, undefined);
    const old = rebaseFixture();
    assert.equal(JSON.stringify(old.preparation).includes('releasedDedicatedHost'), false);
    assert.equal(old.preparationEnvelope.digest, old.intent.rebasePreparation!.digest);
});
test('an older strict preparation schema refuses dedicated evidence', () => {
    const old = PreparationDocumentSchema.innerType().omit({ releasedDedicatedHost: true }).strict();
    assert.equal(old.safeParse(rebaseFixture().preparation).success, true);
    const result = old.safeParse(dedicatedFixture().preparation);
    assert.equal(result.success, false);
    assert.deepEqual(result.error!.issues.map(i => [i.code, (i as { keys?: string[] }).keys]),
        [['unrecognized_keys', ['releasedDedicatedHost']]]);
});
test('dedicated evidence rejects mixed pool identity, same execution, foreign ARN and extra fields', () => {
    const f = dedicatedFixture(), proof = f.preparation.releasedDedicatedHost!;
    const variants = [
        { ...f.preparation, releasedPoolHost: { poolHostId: proof.imageJobId, lifecycleDigest: proof.provisionDigest, releaseExecutionArn: proof.releaseExecutionArn } },
        { ...f.preparation, releasedDedicatedHost: { ...proof, provisionExecutionArn: proof.releaseExecutionArn } },
        ...(['provisionExecutionArn', 'releaseExecutionArn'] as const).flatMap(key => [
            proof[key].replace('-lifecycle:', '-recovery:'),
            proof[key].replace('123456789012', '999999999999'),
            proof[key].replace(':ap-south-1:', ':us-east-1:')
        ].map(arn => ({ ...f.preparation, releasedDedicatedHost: { ...proof, [key]: arn } }))),
        { ...f.preparation, releasedDedicatedHost: { ...proof, poolHostId: proof.imageJobId } },
        { ...f.preparation, releasedDedicatedHost: { ...proof, provisionDigest: '0'.repeat(63) } },
    ];
    for (const variant of variants) assert.equal(PreparationDocumentSchema.safeParse(variant).success, false);
});
test('dedicated evidence cannot authorize absence without a digest-bound execution input', async () => {
    const f = ready(), execution = f.state.executions[f.reference.executionArn]!;
    const envelope = JSON.parse(execution.input!), document = JSON.parse(envelope.document);
    delete document.releasedDedicatedHost;
    execution.input = JSON.stringify({ ...envelope, document: JSON.stringify(document) });
    assert.throws(() => parsePreparationInput(execution.input!), /preparation_failed/);
    assert.deepEqual(await observe(f), { decision: 'failed', code: 'preparation_failed' });
});
test('dedicated aged-out source snapshots once and never stops or terminates', async () => {
    const f = ready(), calls: string[] = [], helper = createPreparationHelper(f.settings, f.deps);
    const result = await runAsl(preparationDefinition('observer:1'), { input: f.preparationEnvelope, executionArn: f.reference.executionArn,
        sleep: seconds => { f.state.now += seconds * 1000; }, invoke: async (_resource, parameters, name) => {
            if (name.startsWith('Observe-')) return helper(parameters);
            calls.push(name); assert.equal(name, 'createSnapshot');
            const snapshot = f.snapshot(); f.state.snapshots.push(snapshot); return { SnapshotId: snapshot.SnapshotId };
        }, maxSteps: 100 });
    assert.deepEqual(calls, ['createSnapshot']);
    assert.equal(result.output.state, 'snapshot_ready'); assert.equal(result.output.digest, f.reference.digest);
    assert.ok(Date.parse(result.output.fencedAt) <= Date.parse(result.output.snapshotStartedAt));
});
for (const state of ['terminated', 'shutting-down', 'running', 'pending', 'stopping', 'stopped'] as const) {
    test(`dedicated source still listed as ${state} fails without provider mutation`, async () => {
        const f = ready(); f.instance.State = { Name: state }; f.state.instances = [f.instance];
        assert.deepEqual(await observe(f), { decision: 'failed', code: 'source_identity_mismatch' });
    });
}
for (const [name, volume] of [
    ['attached', { State: 'in-use', Attachments: [{ InstanceId: 'i-99999999999999999', State: 'attached' }] }],
    ['attaching', { State: 'available', Attachments: [{ InstanceId: 'i-99999999999999999', State: 'attaching' }] }],
    ['detaching', { State: 'in-use', Attachments: [] }],
] as const) {
    test(`dedicated source ${name} volume fails immediately without waiting or provider mutation`, async () => {
        const f = ready(); Object.assign(f.volume, structuredClone(volume));
        assert.deepEqual(await observe(f), { decision: 'failed', code: 'writer_not_fenced' });
    });
}
test('dedicated source rejects a writer attaching after fencing while snapshot is pending', async () => {
    const f = ready(), control = { ...preparationControl, fencedAt: f.preparation.createdAt,
        snapshotId: f.lease.rebase.snapshotId, createAttempted: true };
    f.state.snapshots.push({ ...f.snapshot(), State: 'pending' });
    assert.equal((await observe(f, control, 'snapshot')).decision, 'wait');
    f.volume.State = 'in-use'; f.volume.Attachments = [{ InstanceId: 'i-99999999999999999', VolumeId: f.volume.VolumeId, State: 'attached' }];
    assert.deepEqual(await observe(f, control, 'snapshot'), { decision: 'failed', code: 'writer_not_fenced' });
});
test('dedicated source keeps volume tags and live reservation authority load-bearing', async () => {
    const wrongGeneration = ready();
    wrongGeneration.volume.Tags = wrongGeneration.volume.Tags!.map(tag => tag.Key === 'ezil:generation' ? { ...tag, Value: '999' } : tag);
    assert.deepEqual(await observe(wrongGeneration), { decision: 'failed', code: 'source_identity_mismatch' });
    const revoked = ready(); revoked.state.authorized = false;
    assert.deepEqual(await observe(revoked), { decision: 'failed', code: 'authority_revoked' });
    const late = ready(); let reads = 0; late.deps.imageAuthority = async () => ++reads < 2;
    const result = await observe(late);
    assert.equal(result.decision, 'failed'); assert.equal(result.code, 'authority_revoked'); assert.equal(result.parameters, undefined);
});
