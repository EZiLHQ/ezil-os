import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ControlStore, deliveryKey } from '../src/control-store.js';
import type { Delivery } from '../src/configuration-delivery-contract.js';
import { DeliveryOperationSchema, deliveryObservation, parseSsmDeliveryOperation } from '../src/delivery-operation.js';
import { SystemdDelivery } from '../src/systemd-delivery.js';

function fixture() {
    const computerId = randomUUID(), configurationId = randomUUID();
    const value: Delivery = { schemaVersion: 1, operation: 'prepare', configurationId, revision: 1, digest: 'a'.repeat(64),
        scope: { computerId, computerGeneration: 1, providerInstanceId: 'i-0123456789abcdef0', dataVolumeId: 'vol-0123456789abcdef0', fenceToken: randomUUID() },
        object: { bucket: 'test-bucket', key: `pilot/computers/${computerId}/generations/1/configurations/${configurationId}.json`,
            versionId: 'version-1', bytes: 100, sha256: 'a'.repeat(64) } };
    const directory = mkdtempSync(join(tmpdir(), 'ezil-delivery-store-'));
    const store = new ControlStore(directory, computerId, 1);
    return { store, directory, value, cleanup: () => { store.close(); rmSync(directory, { recursive: true, force: true }); } };
}
test('SSM accepts bounded canonical base64 JSON only, no shell or caller-selected units', () => {
    const f = fixture();
    try {
        const request = { schemaVersion: 1, action: 'start', delivery: f.value, deadline: Date.now() + 90000 };
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
        assert.deepEqual(parseSsmDeliveryOperation(encode(request)), request);
        for (const value of [undefined, '', '$(touch /tmp/bad)', encode(request) + '\n', 'a'.repeat(12300),
            encode({ ...request, command: 'secret-sentinel' }), encode({ ...request, action: 'restart' }), encode({ ...request, schemaVersion: 2 })]) {
            assert.throws(() => parseSsmDeliveryOperation(value), { message: 'delivery_operation_invalid' });
        }
        assert.equal(DeliveryOperationSchema.safeParse({ schemaVersion: 1, action: 'cancel', delivery: f.value, deadline: 1 }).success, false);
        const driver = new SystemdDelivery();
        assert.throws(() => driver.unit('../evil.service'), /delivery_unit_invalid/);
        assert.throws(() => new SystemdDelivery('ssh'), /delivery_unit_invalid/);
    } finally { f.cleanup(); }
});
test('SSM document invokes only the fixed manager and keeps data outside shell interpolation', () => {
    const document = JSON.parse(readFileSync(new URL('../deploy/configuration-document.json', import.meta.url), 'utf8'));
    assert.equal(document.schemaVersion, '2.2');
    assert.equal(document.parameters.Operation.interpolationType, 'ENV_VAR');
    assert.deepEqual(Object.keys(document.parameters), ['Operation']);
    assert.equal(document.mainSteps.length, 1);
    assert.deepEqual(document.mainSteps[0].inputs.runCommand, ['/usr/local/bin/node /opt/ezil-supervisor/dist/delivery-operation.js']);
    assert.doesNotMatch(JSON.stringify(document.mainSteps), /\{\{|SSM_Operation|AWS-RunShellScript/);
    const service = readFileSync(new URL('../deploy/ezil-configuration@.service', import.meta.url), 'utf8');
    assert.match(service, /^KillMode=control-group$/m); assert.match(service, /^RuntimeMaxSec=15min$/m);
    assert.match(service, /^TimeoutStopSec=10$/m); assert.match(service, /^Restart=no$/m);
});
test('one dispatch and one execution survive process restart without extending the original deadline', () => {
    const f = fixture(); let next: ControlStore | undefined;
    try {
        const deadline = Date.now() + 60000;
        assert.equal(f.store.dispatchDelivery(f.value, deadline), true);
        assert.equal(f.store.dispatchDelivery(f.value, deadline + 1000), false);
        assert.equal(f.store.delivery(f.value)?.deadline, deadline);
        assert.equal(f.store.beginDelivery(f.value), true);
        next = new ControlStore(f.directory, f.value.scope.computerId, 1);
        assert.equal(next.dispatchDelivery(f.value, Date.now() + 90000), false);
        assert.equal(next.beginDelivery(f.value), false);
        assert.equal(next.delivery(f.value)?.outcome, 'pending', 'replay rejection must not fail the original execution');
        f.store.finishDelivery(f.value, true);
        assert.equal(next.delivery(f.value)?.outcome, 'succeeded');
        assert.equal(next.beginDelivery(f.value), false);
    } finally { next?.close(); f.cleanup(); }
});
test('cancellation before dispatch fences late requests across a new store connection', () => {
    const f = fixture(); let next: ControlStore | undefined;
    try {
        f.store.cancelDelivery(f.value);
        next = new ControlStore(f.directory, f.value.scope.computerId, 1);
        assert.equal(next.dispatchDelivery(f.value, Date.now() + 90000), false);
        assert.equal(next.beginDelivery(f.value), false);
        assert.equal(next.delivery(f.value)?.cancelled, true);
        assert.equal(next.delivery(f.value)?.dispatched, false);
    } finally { next?.close(); f.cleanup(); }
});
test('cancelled work cannot produce success even when a delayed receiver finishes', () => {
    const f = fixture();
    try {
        f.store.dispatchDelivery(f.value, Date.now() + 90000); f.store.beginDelivery(f.value); f.store.cancelDelivery(f.value);
        f.store.finishDelivery(f.value, true);
        assert.equal(f.store.delivery(f.value)?.outcome, 'failed');
    } finally { f.cleanup(); }
});
test('scope, immutable reference and deadlines reject forgeries without a receipt', () => {
    const f = fixture();
    try {
        assert.throws(() => f.store.dispatchDelivery(f.value, Date.now() - 1), /delivery_deadline_invalid/);
        assert.throws(() => f.store.dispatchDelivery(f.value, Date.now() + 901000), /delivery_deadline_invalid/);
        assert.throws(() => f.store.dispatchDelivery({ ...f.value, scope: { ...f.value.scope, computerId: randomUUID() } }, Date.now() + 10000), /delivery_scope_mismatch/);
        f.store.dispatchDelivery(f.value, Date.now() + 90000);
        assert.throws(() => f.store.finishDelivery(f.value, true), /delivery_not_dispatched/);
        const changed = { ...f.value, digest: 'b'.repeat(64) };
        assert.throws(() => f.store.cancelDelivery(changed), /delivery_reference_conflict/);
        assert.throws(() => f.store.dispatchDelivery(changed, Date.now() + 10000), /delivery_reference_conflict/);
        assert.throws(() => f.store.deliveryByKey('prepare-other'), /delivery_key_invalid/);
    } finally { f.cleanup(); }
});
test('a local result is successful only after the process is quiescent; status never invents a receipt', () => {
    const f = fixture();
    try {
        const quiet = { quiescent: true, present: false, failed: false }, active = { ...quiet, quiescent: false, present: true };
        assert.equal(deliveryObservation(f.value, undefined, quiet).status, 'absent');
        f.store.dispatchDelivery(f.value, Date.now() + 90000);
        assert.equal(deliveryObservation(f.value, f.store.delivery(f.value), quiet).status, 'unknown', 'lost dispatch response is not retried or declared completed');
        f.store.beginDelivery(f.value); f.store.finishDelivery(f.value, true);
        assert.equal(deliveryObservation(f.value, f.store.delivery(f.value), active).status, 'running');
        assert.equal(deliveryObservation(f.value, f.store.delivery(f.value), quiet).status, 'succeeded');
        assert.equal(deliveryObservation(f.value, f.store.delivery(f.value), { ...quiet, failed: true }).status, 'failed');
        f.store.cancelDelivery(f.value);
        assert.equal(deliveryObservation(f.value, f.store.delivery(f.value), active).status, 'cancelling');
        assert.equal(deliveryObservation(f.value, f.store.delivery(f.value), quiet).status, 'cancelled');
        assert.equal(deliveryObservation(f.value, f.store.delivery(f.value), quiet).result, undefined);
        assert.equal(deliveryKey(f.value), `prepare-${f.value.configurationId}`);
    } finally { f.cleanup(); }
});
