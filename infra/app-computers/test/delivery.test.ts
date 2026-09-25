import assert from 'node:assert/strict';
import test from 'node:test';
import { canonical, hostObservation, hostOperation, parseDelivery, resultFor, SettingsSchema } from '../lib/delivery/contract.js';
import { requestAuthority, authoritySignature, validWriter } from '../lib/delivery/aws.js';
import { createDeliveryHelper } from '../lib/delivery/helper.js';
import { delivery, fixture, settings } from './delivery-fixture.js';

test('strict references are pinned to deployment bucket, scope and content', () => {
    assert.deepEqual(parseDelivery(delivery, settings), delivery);
    assert.deepEqual(SettingsSchema.parse(settings), settings);
    for (const changed of [{ ...delivery, extra: 'secret' }, { ...delivery, schemaVersion: 2 },
        { ...delivery, object: { ...delivery.object, versionId: 'null' } },
        { ...delivery, object: { ...delivery.object, bucket: 'other-tenant' } },
        { ...delivery, object: { ...delivery.object, key: '../other-tenant' } },
        { ...delivery, object: { ...delivery.object, sha256: 'a'.repeat(64) } }]) {
        assert.throws(() => parseDelivery(changed, settings), /^Error: invalid_delivery$/);
    }
});
test('canonical SSM envelope matches host request and never carries configuration or credentials', () => {
    const encoded = hostOperation(delivery, 'start', 10000);
    assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString()), { schemaVersion: 1, action: 'start', delivery, deadline: 10000 });
    assert.deepEqual(JSON.parse(Buffer.from(hostOperation(delivery, 'cancel', 10000), 'base64').toString()),
        { schemaVersion: 1, action: 'cancel', delivery });
});
test('only an exact successful host outcome produces the app transport receipt', () => {
    const observation = { schemaVersion: 1, configurationId: delivery.configurationId, scope: delivery.scope,
        operation: 'prepare', status: 'succeeded', result: resultFor(delivery) };
    assert.equal(hostObservation(JSON.stringify(observation), delivery), 'succeeded');
    for (const output of [{ ...observation, scope: { ...delivery.scope, computerGeneration: 2 } },
        { ...observation, status: 'running' }, { ...observation, result: undefined }, { ...observation, leaked: 'secret' }]) {
        assert.throws(() => hostObservation(JSON.stringify(output), delivery), /^Error: invalid_host_output$/);
    }
    assert.throws(() => hostObservation('x'.repeat(4097), delivery));
});
test('authority client signs the fixed protocol, denies redirect and bounds output', async () => {
    const key = '1'.repeat(64);
    await requestAuthority(settings.authorityOrigin, key, delivery, async (url, init) => {
        assert.equal(url, 'https://cloud.ezil.org/api/internal/apps/configuration-authority');
        assert.equal(init?.redirect, 'error'); assert.equal(init?.method, 'POST');
        const headers = new Headers(init?.headers), timestamp = headers.get('x-ezil-workflow-timestamp')!;
        assert.equal(headers.get('x-ezil-workflow-signature'), authoritySignature(String(init?.body), key, timestamp));
        assert.equal(headers.has('authorization'), false);
        return Response.json({ authorized: true, ...JSON.parse(String(init?.body)) });
    });
    assert.equal(await requestAuthority(settings.authorityOrigin, key, delivery, async () => Response.json({ code: 'revoked' }, { status: 403 })), false);
    for (const response of [new Response('secret', { status: 302 }), new Response('s'.repeat(4097)), Response.json({ authorized: true })]) {
        const call = requestAuthority(settings.authorityOrigin, key, delivery, async () => response);
        if (response.status === 200 && response.headers.get('content-type') === 'application/json') assert.equal(await call, false);
        else await assert.rejects(call, /^Error: authority_unavailable$/);
    }
});
test('actual writer evidence requires preserved encrypted volume and one exact writer', () => {
    const tags = Object.entries({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot',
        'ezil:computer-id': delivery.scope.computerId, 'ezil:generation': '1', 'ezil:fence-token': delivery.scope.fenceToken })
        .map(([Key, Value]) => ({ Key, Value }));
    const i = { InstanceId: delivery.scope.providerInstanceId, State: { Name: 'running' as const }, Tags: tags,
        Architecture: 'x86_64' as const, InstanceType: 'm7i.large' as const,
        MetadataOptions: { HttpTokens: 'required' as const, HttpPutResponseHopLimit: 1 }, Placement: { AvailabilityZone: 'us-east-1a' },
        BlockDeviceMappings: [{ DeviceName: '/dev/sdf', Ebs: { VolumeId: delivery.scope.dataVolumeId, DeleteOnTermination: false, Status: 'attached' as const } }] };
    const v = { VolumeId: delivery.scope.dataVolumeId, State: 'in-use' as const, Encrypted: true, KmsKeyId: settings.dataKeyArn,
        VolumeType: 'gp3' as const, Size: 50, MultiAttachEnabled: false, AvailabilityZone: 'us-east-1a', Tags: tags,
        Attachments: [{ InstanceId: i.InstanceId, State: 'attached' as const, Device: '/dev/sdf' }] };
    const instances = { Reservations: [{ OwnerId: settings.accountId, Instances: [i] }] };
    assert.equal(validWriter(settings, delivery, instances, { Volumes: [v] }), true);
    for (const volume of [{ ...v, Encrypted: false }, { ...v, MultiAttachEnabled: true }, { ...v, Tags: [] },
        { ...v, AvailabilityZone: 'us-east-1b' }, { ...v, Attachments: [...v.Attachments, ...v.Attachments] },
        { ...v, KmsKeyId: 'other' }, { ...v, Attachments: [{ ...v.Attachments[0], InstanceId: 'i-00000000000000000' }] }]) {
        assert.equal(validWriter(settings, delivery, instances, { Volumes: [volume] }), false);
    }
    const unsafe = structuredClone(instances); unsafe.Reservations[0]!.Instances[0]!.BlockDeviceMappings[0]!.Ebs.DeleteOnTermination = true;
    assert.equal(validWriter(settings, delivery, unsafe, { Volumes: [v] }), false);
});
test('new start revalidates current authority; revoked and unavailable checks choose cancel', async () => {
    const f = fixture(), helper = createDeliveryHelper(settings, f.deps);
    const result = await helper(f.event); assert.equal(result.decision, 'dispatch');
    if (result.decision !== 'dispatch') throw new Error();
    assert.equal(result.attempt.action, 'start'); assert.equal(f.state.authorityCalls, 1);
    assert.equal(JSON.parse(Buffer.from(result.parameters.Parameters.Operation[0]!, 'base64').toString()).deadline, f.start + 900000);
    f.state.authorized = false;
    const cancel = await helper(f.event); assert.equal(cancel.decision === 'dispatch' && cancel.attempt.action, 'cancel');
    f.deps.authority = async () => { throw new Error('SECRET_PROVIDER_BODY'); };
    assert.equal((await helper(f.event)).decision, 'dispatch');
    f.state.writer = false; assert.deepEqual(await helper(f.event), { decision: 'unconfirmed' });
});
test('a lost send response is observed without another start or extended deadline', async () => {
    const f = fixture(), helper = createDeliveryHelper(settings, f.deps);
    const first = await helper(f.event); if (first.decision !== 'dispatch') throw new Error();
    f.state.now += 5000;
    const next = await helper({ ...f.event, mode: 'lost', attempt: first.attempt });
    assert.equal(next.decision === 'dispatch' && next.attempt.action, 'observe');
    f.state.now = f.start + 900000;
    const expired = await helper({ ...f.event, mode: 'lost', attempt: first.attempt });
    assert.equal(expired.decision === 'dispatch' && expired.attempt.action, 'cancel');
});
test('historical cleanup is allowed after revocation and never calls current authority', async () => {
    const f = fixture(); Object.assign(f.state.execution, { status: 'ABORTED' });
    f.deps.authority = async () => { throw new Error('must not call'); };
    const result = await createDeliveryHelper(settings, f.deps)({ ...f.event, recovery: true });
    assert.equal(result.decision === 'dispatch' && result.attempt.action, 'cancel');
    assert.equal(f.state.authorityCalls, 0);
});
test('forged executions, redrives and input references fail with redacted errors', async () => {
    for (const change of [{ stateMachineVersionArn: settings.machineArn + ':2' }, { redriveCount: 1 },
        { input: canonical({ ...delivery, object: { ...delivery.object, key: 'other' } }) }, { input: 'SECRET' },
        { stateMachineAliasArn: settings.machineArn + ':alias' }, { name: 'other' }]) {
        const f = fixture(); Object.assign(f.state.execution, change);
        await assert.rejects(createDeliveryHelper(settings, f.deps)(f.event), /^Error: configuration_workflow_unavailable$/);
    }
});
