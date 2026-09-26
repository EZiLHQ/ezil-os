import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/control-protocol.js';
import { validateDataMountDelivery, validateDeliveredMountPlan } from '../src/data-mount-delivery-contract.js';

function fixture(mode: 'mount' | 'initialize' = 'mount') {
    const scope = { computerId: randomUUID(), computerGeneration: 2, fenceToken: randomUUID(),
        providerInstanceId: 'i-11111111111111111', dataVolumeId: 'vol-11111111111111111' };
    const host = { schemaVersion: 1, scope, region: 'us-east-1', accountId: '123456789012', namespace: 'pilot',
        bucket: 'ezil-pilot-config', kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
    const plan = { schemaVersion: 1 as const, computerId: scope.computerId, volumeId: scope.dataVolumeId, filesystemUuid: randomUUID(), mode };
    const bytes = Buffer.from(canonicalJson(plan)), digest = createHash('sha256').update(bytes).digest('hex');
    const now = Math.floor(Date.now() / 1000), authorizationId = randomUUID();
    const authority = { schemaVersion: 1 as const, authorizationId, scope, filesystemUuid: plan.filesystemUuid,
        mode, digest, issuedAt: now, expiresAt: now + 900 };
    const value = { schemaVersion: 1 as const, authorizationId, scope, digest, object: { bucket: host.bucket,
        key: `pilot/computers/${scope.computerId}/generations/2/data-mounts/${authorizationId}.json`,
        versionId: 'immutable-version', sha256: digest, bytes: bytes.length } };
    return { value, host, plan, bytes, authority, now: now * 1000 };
}

for (const mode of ['mount', 'initialize'] as const) test(`${mode} requires matching independent provisioning and explicit authority`, () => {
    const { value, host, authority, now, bytes, plan } = fixture(mode);
    assert.deepEqual(validateDataMountDelivery(value, host, authority, now), { value, host, authority });
    assert.deepEqual(validateDeliveredMountPlan(bytes, value, authority), plan);
    assert.throws(() => validateDataMountDelivery(value, host, undefined, now), /^Error: data_mount_delivery_invalid$/);
    for (const change of [ { computerId: randomUUID() }, { computerGeneration: 3 }, { fenceToken: randomUUID() },
        { providerInstanceId: 'i-22222222222222222' }, { dataVolumeId: 'vol-22222222222222222' } ]) {
        assert.throws(() => validateDataMountDelivery({ ...value, scope: { ...value.scope, ...change } }, host, authority, now), /data_mount_delivery_invalid/);
        assert.throws(() => validateDataMountDelivery(value, host, { ...authority, scope: { ...value.scope, ...change } }, now), /data_mount_delivery_invalid/);
    }
});

test('delivery rejects redirects of identity, content, storage, version and extra authority', () => {
    const { value, host, authority, now } = fixture();
    for (const change of [{ authorizationId: randomUUID() }, { digest: '0'.repeat(64) }, { schemaVersion: 2 },
        { shell: 'SECRET_DO_NOT_ECHO' }, { mode: 'initialize' }]) {
        assert.throws(() => validateDataMountDelivery({ ...value, ...change }, host, authority, now), /^Error: data_mount_delivery_invalid$/);
    }
    for (const change of [{ bucket: 'other-bucket' }, { key: 'other/../data.json' }, { versionId: 'null' },
        { bytes: 4097 }, { sha256: '0'.repeat(64) }]) {
        assert.throws(() => validateDataMountDelivery({ ...value, object: { ...value.object, ...change } }, host, authority, now), /data_mount_delivery_invalid/);
    }
    for (const change of [{ authorizationId: randomUUID() }, { digest: '0'.repeat(64) }, { expiresAt: now / 1000 },
        { issuedAt: now / 1000 + 1 }, { expiresAt: now / 1000 + 901 }, { secret: 'SECRET_DO_NOT_ECHO' }]) {
        assert.throws(() => validateDataMountDelivery(value, host, { ...authority, ...change }, now), /^Error: data_mount_delivery_invalid$/);
    }
    for (const nowValue of [NaN, Infinity, -1, now + 900000]) {
        assert.throws(() => validateDataMountDelivery(value, host, authority, nowValue), /data_mount_delivery_invalid/);
    }
});

test('content must be canonical, digest-pinned and match the authorized disk, filesystem and operation', () => {
    const { value, plan, bytes, authority } = fixture();
    for (const changed of [Buffer.from('SECRET_DO_NOT_ECHO'), Buffer.concat([bytes, Buffer.from('\n')]), Buffer.alloc(bytes.length)]) {
        assert.throws(() => validateDeliveredMountPlan(changed, value, authority), /^Error: data_mount_content_invalid$/);
    }
    for (const change of [{ mode: 'initialize' }, { filesystemUuid: randomUUID() }, { computerId: randomUUID() },
        { volumeId: 'vol-22222222222222222' }, { path: '/dev/SECRET_DO_NOT_ECHO' }]) {
        const changed = Buffer.from(canonicalJson({ ...plan, ...change }));
        const digest = createHash('sha256').update(changed).digest('hex');
        assert.throws(() => validateDeliveredMountPlan(changed, { ...value, digest, object: { ...value.object, bytes: changed.length } }, authority),
            /^Error: data_mount_content_invalid$/);
    }
});
