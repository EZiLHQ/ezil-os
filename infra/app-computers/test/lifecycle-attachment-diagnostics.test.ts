import assert from 'node:assert/strict';
import test from 'node:test';
import { assertAttached, createLifecycleHelper, lifecycleError } from '../lib/lifecycle/helper.js';
import { claimTagsFor, tagList, tagsFor } from '../lib/lifecycle/contract.js';
import { lifecycleFixture } from './lifecycle-fixture.js';
function attached() {
    const f = lifecycleFixture('adopt');
    f.state.volumes[0]!.Tags = tagList({ ...tagsFor(f.i), ...claimTagsFor(f.i) });
    f.attach(f.state.volumes[0]!, f.state.instances[0]!);
    return f;
}
function unchanged(error: unknown) {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'lifecycle_attachment_invalid');
    const normalized = lifecycleError(error);
    assert.equal(normalized.name, 'LifecycleFailure');
    assert.equal(normalized.message, 'lifecycle_attachment_invalid');
    return true;
}
const reasons = ['volume_state', 'mapping_count', 'mapping_device', 'mapping_status', 'mapping_deletion_policy',
    'attachment_count', 'attachment_identity', 'attachment_status', 'attachment_device', 'attachment_deletion_policy'] as const;
for (const reason of reasons) test(`strict attachment diagnostic: ${reason}`, t => {
    const log = t.mock.method(console, 'warn', () => {}), f = attached();
    const h = f.state.instances[0]!, v = f.state.volumes[0]!, m = h.BlockDeviceMappings![1]!, a = v.Attachments![0]!;
    switch (reason) {
        case 'volume_state': v.State = 'available'; break;
        case 'mapping_count': h.BlockDeviceMappings!.push(structuredClone(m)); break;
        case 'mapping_device': m.DeviceName = 'PRIVATE_DEVICE'; break;
        case 'mapping_status': m.Ebs!.Status = 'attaching'; break;
        case 'mapping_deletion_policy': m.Ebs!.DeleteOnTermination = true; break;
        case 'attachment_count': v.Attachments = []; break;
        case 'attachment_identity': a.InstanceId = 'PRIVATE_HOST'; break;
        case 'attachment_status': a.State = 'detaching'; break;
        case 'attachment_device': a.Device = 'PRIVATE_DEVICE'; break;
        case 'attachment_deletion_policy': a.DeleteOnTermination = true; break;
    }
    assert.throws(() => assertAttached(h, v, f.i.providerInstanceId!), unchanged);
    // Exact serialized allowlist: no AWS values, extra fields or arguments.
    assert.deepEqual(log.mock.calls.map(c => c.arguments), [[JSON.stringify({event:'lifecycle_attachment_rejected', reason})]]);
});
for (const reason of ['attachment_count', 'attachment_identity', 'claimed_host_without_attachment', 'mapping_deletion_policy']) {
    test(`adopt observer diagnostic: ${reason}`, async t => {
        const log = t.mock.method(console, 'warn', () => {}), f = attached();
        if (reason === 'attachment_count') f.state.volumes[0]!.Attachments!.push(structuredClone(f.state.volumes[0]!.Attachments![0]!));
        if (reason === 'attachment_identity') f.state.volumes[0]!.Attachments![0]!.InstanceId = 'PRIVATE_HOST';
        if (reason === 'claimed_host_without_attachment') {
            f.state.volumes[0]!.State = 'available'; f.state.volumes[0]!.Attachments = [];
            f.state.instances[0]!.BlockDeviceMappings!.pop();
            f.state.instances[0]!.Tags!.push(...tagList(claimTagsFor(f.i)));
        }
        if (reason === 'mapping_deletion_policy') {
            f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.Status = 'attaching';
            f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.DeleteOnTermination = true;
        }
        await assert.rejects(createLifecycleHelper(f.settings, f.deps)({executionArn:f.executionArn, phase:'initial'}), unchanged);
        assert.deepEqual(log.mock.calls.map(c => c.arguments), [[JSON.stringify({event:'lifecycle_attachment_rejected', reason})]]);
    });
}
test('successful strict validation and adopt claim/wait observations log no rejection', async t => {
    const log = t.mock.method(console, 'warn', () => {}), f = attached();
    assertAttached(f.state.instances[0]!, f.state.volumes[0]!, f.i.providerInstanceId!);
    const helper = createLifecycleHelper(f.settings, f.deps);
    const ready = await helper({executionArn:f.executionArn, phase:'attached'});
    assert.equal(ready.decision, 'claimInstance');
    f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.Status = 'attaching';
    const waiting = await helper({executionArn:f.executionArn, phase:'attached'});
    assert.equal(waiting.decision, 'wait'); assert.equal(waiting.phase, 'attached');
    f.state.instances[0]!.BlockDeviceMappings![1]!.Ebs!.Status = 'attached';
    f.state.instances[0]!.Tags = f.state.instances[0]!.Tags!.filter(tag => tag.Key !== 'ezil:pool');
    f.state.instances[0]!.Tags!.push(...tagList(claimTagsFor(f.i)));
    assert.equal((await helper({executionArn:f.executionArn, phase:'unpooled'})).decision, 'success');
    assert.deepEqual(log.mock.calls, []);
});
test('logging failure cannot replace the public rejection', t => {
    t.mock.method(console, 'warn', () => { throw new Error('log unavailable'); });
    const f = attached(); f.state.volumes[0]!.State = 'available';
    assert.throws(() => assertAttached(f.state.instances[0]!, f.state.volumes[0]!, f.i.providerInstanceId!), unchanged);
});
