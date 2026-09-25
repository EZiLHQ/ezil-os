import assert from 'node:assert/strict';
import test from 'node:test';
import { cancellationFixture as fixture, simulateCancellation as run } from './cancellation-fixture.js';
import { createCancellationHelper } from '../lib/lifecycle/cancellation-helper.js';

for (const operation of ['provision', 'start', 'replace', 'recover'] as const) test(`explicit cancellation fences successful ${operation} and retains its disk`, async () => {
    const f = fixture(operation), result = await run(f);
    assert.equal(result.error, undefined); assert.equal(result.receipt.digest, f.digest);
    assert.equal(result.receipt.source.digest, f.scope.source.digest); assert.equal(result.receipt.cancellationId, f.c.cancellationId);
    assert.ok(f.state.instances.every(i => i.State?.Name === 'terminated')); assert.equal(f.state.volumes[0]!.State, 'available');
    assert.ok(result.calls.every(c => c.action !== 'stopExecution'));
});
for (const status of ['RUNNING', 'FAILED', 'ABORTED', 'TIMED_OUT'] as const) test(`explicit cancellation reconciles ${status} original without relaunching it`, async () => {
    const f = fixture(); f.source.status = status; if (status === 'RUNNING') delete f.source.stopDate;
    const result = await run(f); assert.equal(result.error, undefined);
    assert.equal(result.calls.filter(c => c.action === 'stopExecution').length, status === 'RUNNING' ? 1 : 0);
});
test('missing pending cancellation or its revocation prevents every subsequent mutation', async () => {
    const f = fixture(); f.controls.authorized = false; assert.deepEqual((await run(f)).calls, []);
    const g = fixture(); g.source.status = 'RUNNING';
    const result = await run(g, { after: () => { g.controls.authorized = false; } });
    assert.equal(result.error, 'ComputerCancellationUnconfirmed'); assert.deepEqual(result.calls.map(c => c.action), ['stopExecution']);
});
test('a changed authority snapshot during inventory cannot authorize an action', async () => {
    const f = fixture(); f.controls.before = kind => { if (kind === 'authority' && f.controls.authorityCalls === 2) f.scope.dataVolumeId = 'vol-99999999999999999'; };
    const result = await run(f); assert.equal(result.error, 'ComputerCancellationUnconfirmed'); assert.deepEqual(result.calls, []);
});
for (const action of ['stopExecution', 'modifyInstanceAttribute', 'stopInstances', 'terminateInstances']) {
    for (const noEffect of [false, true]) test(`ambiguous ${action} with effect=${!noEffect} is observed without retries`, async () => {
        const f = fixture();
        if (action === 'stopExecution') f.source.status = 'RUNNING';
        if (action === 'modifyInstanceAttribute') { f.state.instances[0]!.BlockDeviceMappings![0]!.Ebs!.DeleteOnTermination = true; f.state.volumes[0]!.Attachments![0]!.DeleteOnTermination = true; }
        const result = await run(f, { lose: action, noEffect: noEffect ? action : undefined });
        assert.equal(result.calls.filter(c => c.action === action).length, 1);
        assert.equal(result.error, noEffect ? 'ComputerCancellationUnconfirmed' : undefined);
    });
}
test('a missing source execution never proves that its in-flight start had no effects', async () => {
    const f = fixture(); f.controls.sourceMissing = true;
    const result = await run(f); assert.equal(result.error, 'ComputerCancellationUnconfirmed'); assert.deepEqual(result.calls, []);
});
test('a missing allocation after entering its task remains unconfirmed', async () => {
    const f = fixture('provision', false); f.tasks.push('createVolume', 'runInstances');
    const result = await run(f); assert.equal(result.error, 'ComputerCancellationUnconfirmed'); assert.deepEqual(result.calls, []);
});
test('a complete pre-allocation terminal history can prove no effects', async () => {
    const f = fixture('provision', false); f.source.status = 'ABORTED';
    const result = await run(f); assert.equal(result.error, undefined); assert.equal(result.receipt.source.volumeId, null); assert.deepEqual(result.calls, []);
});
test('incorrect writer, volume or execution scope prevents destructive decisions', async () => {
    const changes: ((f: ReturnType<typeof fixture>) => void)[] = [f => { f.scope.source.digest = 'b'.repeat(64); },
        f => { f.scope.dataVolumeId = 'vol-99999999999999999'; }, f => { f.scope.writers[0]!.generation = 9; },
        f => { f.state.instances[0]!.Tags = []; }, f => { f.state.volumes[0]!.Encrypted = false; },
        f => { f.source.redriveCount = 1; }, f => { f.execution.redriveCount = 1; }, f => { f.source.input += ' '; },
        f => { f.execution.name = 'forged'; }, f => { f.controls.historyBad = true; }];
    for (const change of changes) { const f = fixture(); change(f); const result = await run(f); assert.equal(result.error, 'ComputerCancellationUnconfirmed'); assert.deepEqual(result.calls, []); }
});
test('historical writers must be positively fenced before expired provider history is accepted', async () => {
    const f = fixture('recover'), historical = f.scope.writers[0]!; f.state.instances.shift();
    assert.equal((await run(f)).error, undefined);
    const g = fixture('recover'); g.scope.writers[0]!.fencedAt = null; g.state.instances.shift();
    assert.equal((await run(g)).error, 'ComputerCancellationUnconfirmed');
    assert.ok(historical.fencedAt);
});
test('late reads, source redrive and authority changes cannot cross into a destructive decision', async () => {
    const f = fixture(), original = f.deps.instances;
    f.deps.instances = async selector => { const rows = await original(selector); f.state.now += 580000; return rows; };
    assert.deepEqual((await run(f)).calls, []);
    const g = fixture(), read = g.deps.instances;
    g.deps.instances = async selector => { const rows = await read(selector); g.source.redriveCount = 1; return rows; };
    assert.deepEqual((await run(g)).calls, []);
});
test('changing SDK response metadata does not change execution identity', async () => {
    const f = fixture(), read = f.deps.execution; let n = 0;
    f.deps.execution = async arn => ({ ...await read(arn), $metadata: { requestId: String(++n) } });
    assert.equal((await run(f)).error, undefined);
});
test('a different recorded writer of the same generation cannot be replaced by historical source authority', async () => {
    const f = fixture('replace'); f.scope.writers[0]!.instanceId = 'i-99999999999999999';
    const result = await run(f); assert.equal(result.error, 'ComputerCancellationUnconfirmed'); assert.deepEqual(result.calls, []);
});
test('an arbitrary Lambda caller cannot pick an upstream execution or phase payload', async () => {
    const f = fixture(), helper = createCancellationHelper(f.settings, f.deps);
    await assert.rejects(helper({ executionArn: f.arn, phase: 'initial', instanceId: 'i-99999999999999999' }));
    await assert.rejects(helper({ executionArn: f.executionArn, phase: 'initial' }));
});
