import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '../src/control-protocol.js';
import { MountRecordsSchema, mountedReceipt } from '../src/mount-operation-store.js';
import { MountOperationSchema, parseSsmMountOperation } from '../src/mount-operation.js';
import { SystemdDelivery } from '../src/systemd-delivery.js';

function records() {
    const scope = { computerId: randomUUID(), computerGeneration: 1, fenceToken: randomUUID(),
        providerInstanceId: 'i-11111111111111111', dataVolumeId: 'vol-11111111111111111' };
    const provisioning = { schemaVersion: 1 as const, scope, accountId: '123456789012', region: 'us-east-1' as const, namespace: 'pilot',
        bucket: 'test-bucket', kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
    const plan = { schemaVersion: 1, computerId: scope.computerId, volumeId: scope.dataVolumeId, filesystemUuid: randomUUID(), mode: 'mount' as const };
    const bytes = Buffer.from(canonicalJson(plan)), digest = createHash('sha256').update(bytes).digest('hex');
    const authorization = { schemaVersion: 1 as const, authorizationId: randomUUID(), scope, filesystemUuid: plan.filesystemUuid,
        mode: plan.mode, digest, issuedAt: 1800000000, expiresAt: 1800000900 };
    const delivery = { schemaVersion: 1 as const, authorizationId: authorization.authorizationId, scope, digest,
        object: { bucket: provisioning.bucket, key: `pilot/computers/${scope.computerId}/generations/1/data-mounts/${authorization.authorizationId}.json`,
            versionId: 'version-1', sha256: digest, bytes: bytes.length } };
    return { provisioning, authorization, delivery };
}
test('SSM mount operations preserve exact records and do not accept an extended deadline or shell', () => {
    const r = records();
    for (const action of ['start','observe','cancel']) {
        const value = { schemaVersion:1, action, records:r };
        assert.deepEqual(parseSsmMountOperation(Buffer.from(canonicalJson(value)).toString('base64')),value);
        assert.equal(MountOperationSchema.safeParse({...value,deadline:1900000000}).success,false);
        assert.equal(MountOperationSchema.safeParse({...value,shell:'PRIVATE_VALUE'}).success,false);
    }
    assert.equal(mountedReceipt(MountRecordsSchema.parse(r)).filesystemUuid,r.authorization.filesystemUuid);
});
test('rejects mismatched provisioning, authority, object scope and extra fields', () => {
    const r = records();
    for (const change of [{ scope:{...r.provisioning.scope,computerId:randomUUID()} },{ bucket:'other-bucket' }]) {
        assert.equal(MountRecordsSchema.safeParse({...r,provisioning:{...r.provisioning,...change}}).success,false);
    }
    for (const change of [{authorizationId:randomUUID()},{digest:'0'.repeat(64)},{scope:{...r.authorization.scope,fenceToken:randomUUID()}}]) {
        assert.equal(MountRecordsSchema.safeParse({...r,authorization:{...r.authorization,...change}}).success,false);
    }
    assert.equal(MountRecordsSchema.safeParse({...r,secret:'PRIVATE_VALUE'}).success,false);
});
test('invalid, oversized and noncanonical base64 never reaches root operations', () => {
    for (const value of [undefined,'','not base64','YQ','a'.repeat(21849),Buffer.from('{}').toString('base64'),Buffer.alloc(16385).toString('base64')]) {
        assert.throws(()=>parseSsmMountOperation(value),/^Error: mount_operation_invalid$/);
    }
});
test('mount and configuration services cannot select each other or arbitrary units', () => {
    const id=randomUUID(), mount=new SystemdDelivery(undefined,'mount'), config=new SystemdDelivery();
    assert.equal(mount.unit(`mount-${id}`),`ezil-mount@mount-${id}.service`);
    assert.equal(config.unit(`prepare-${id}`),`ezil-configuration@prepare-${id}.service`);
    for(const value of [`prepare-${id}`,`reload-${id}`,'docker.service','mount-../../sshd']) assert.throws(()=>mount.unit(value));
    assert.throws(()=>config.unit(`mount-${id}`));
});
