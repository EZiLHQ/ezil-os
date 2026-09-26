import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalJson } from '../src/control-protocol.js';
import { StartRecordsSchema, startedReceipt } from '../src/start-operation-store.js';
import { StartOperationSchema, parseSsmStartOperation } from '../src/start-operation.js';
import { SystemdDelivery } from '../src/systemd-delivery.js';

function records() {
    const scope = { computerId: randomUUID(), computerGeneration: 1, fenceToken: randomUUID(),
        providerInstanceId: 'i-11111111111111111', dataVolumeId: 'vol-11111111111111111' };
    const provisioning = { schemaVersion: 1, scope, accountId: '123456789012', region: 'us-east-1', namespace: 'pilot',
        bucket: 'test-bucket', kmsKeyArn: 'arn:aws:kms:us-east-1:123456789012:key/11111111-1111-4111-8111-111111111111' };
    const configurationId = randomUUID(), configuration = { schemaVersion: 1, operation: 'prepare', configurationId, scope, revision: 1, digest: 'ab'.repeat(32),
        object: { bucket: provisioning.bucket, key: `pilot/computers/${scope.computerId}/generations/1/configurations/${configurationId}.json`,
            versionId: 'version-1', sha256: 'ab'.repeat(32), bytes: 1024 } };
    return StartRecordsSchema.parse({ provisioning, authorization: { schemaVersion: 1, authorizationId: randomUUID(), mountAuthorizationId: randomUUID(),
        configuration, controlDomain: 'control.example.com', secretVersionId: randomUUID(), issuedAt: 1800000000, expiresAt: 1800000300 } });
}
test('startup wire carries exact bounded authority and no key material or selectable command', () => {
    const r = records();
    for (const action of ['start', 'observe', 'cancel']) {
        const value = { schemaVersion: 1, action, records: r };
        assert.deepEqual(parseSsmStartOperation(Buffer.from(canonicalJson(value)).toString('base64')), value);
        for (const extra of [{ deadline: 1900000000 }, { command: 'PRIVATE_VALUE' }, { keyHex: 'ab'.repeat(32) }]) {
            assert.equal(StartOperationSchema.safeParse({ ...value, ...extra }).success, false);
        }
    }
    assert.equal(startedReceipt(r).descriptor.configurationDigest, r.authorization.configuration.digest);
});
test('startup records reject foreign computers, objects, deadlines and reload requests', () => {
    const r = records(), a = r.authorization;
    for (const change of [{ scope: { ...r.provisioning.scope, computerId: randomUUID() } }, { bucket: 'another-bucket' }]) {
        assert.equal(StartRecordsSchema.safeParse({ ...r, provisioning: { ...r.provisioning, ...change } }).success, false);
    }
    for (const change of [{ expiresAt: a.expiresAt+1 }, { keyHex: 'PRIVATE_VALUE' },
        { configuration: { ...a.configuration, operation: 'reload' } },
        { configuration: { ...a.configuration, scope: { ...a.configuration.scope, fenceToken: randomUUID() } } },
        { configuration: { ...a.configuration, object: { ...a.configuration.object, key: 'other/key' } } }]) {
        assert.equal(StartRecordsSchema.safeParse({ ...r, authorization: { ...a, ...change } }).success, false);
    }
});
test('invalid, oversized and noncanonical base64 fails without echoing data', () => {
    for (const value of [undefined, '', 'PRIVATE_VALUE', 'YQ', 'a'.repeat(21849), Buffer.alloc(16385).toString('base64'), Buffer.from('{}').toString('base64')]) {
        assert.throws(() => parseSsmStartOperation(value), /^Error: start_operation_invalid$/);
    }
});
test('startup units cannot name a mount, reload, supervisor or arbitrary unit', () => {
    const id = randomUUID(), start = new SystemdDelivery(undefined, 'start');
    assert.equal(start.unit(`start-${id}`), `ezil-start@start-${id}.service`);
    for (const key of [`mount-${id}`, `reload-${id}`, 'ezil-supervisor.service', '../../sshd']) assert.throws(() => start.unit(key));
    for (const kind of ['mount', 'configuration'] as const) assert.throws(() => new SystemdDelivery(undefined, kind).unit(`start-${id}`));
});
test('SSM uses only a fixed entrypoint and bounded ENV_VAR data; startup never enables boot services', async () => {
    const doc = JSON.parse(await readFile(new URL('../deploy/start-document.json', import.meta.url), 'utf8'));
    assert.equal(doc.parameters.Operation.interpolationType, 'ENV_VAR');
    assert.deepEqual(doc.mainSteps[0].inputs.runCommand, ['/usr/local/bin/node /opt/ezil-supervisor/current/dist/start-operation.js']);
    assert.equal(doc.mainSteps[0].inputs.timeoutSeconds, '150');
    const unit = await readFile(new URL('../deploy/ezil-start@.service', import.meta.url), 'utf8');
    assert.match(unit, /Restart=no/); assert.match(unit, /KillMode=control-group/); assert.doesNotMatch(unit, /\[Install\]|WantedBy|Restart=always/);
});
