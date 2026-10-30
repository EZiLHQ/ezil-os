import assert from 'node:assert/strict';
import test from 'node:test';
import { parseLifecycleWork } from '../lib/lifecycle/intent.js';
import { assertPermitTime, parseLease } from '../lib/lifecycle/lease.js';
import { decodeLeaseJson, strictJson } from '../lib/lifecycle/strict-json.js';
import { LifecycleDeploymentSchema } from '../lib/lifecycle/deployment.js';
import { parsePreparationInput } from '../lib/lifecycle/preparation-contract.js';
import { envelopeFor, rebaseFixture } from './rebase-fixture.js';

function parse(i: unknown) { return parseLifecycleWork({ ...envelopeFor(i), createdAt: new Date('2026-10-22T12:00:00.000Z') }); }
test('local rebase-replace fixture preserves bytes, schema order and preparation document digest', () => {
    const f = rebaseFixture();
    assert.deepEqual(parse(f.intent), f.intent);
    assert.equal(parsePreparationInput(JSON.stringify(f.preparationEnvelope)).envelope.digest, f.reference.digest);
    assert.equal(JSON.stringify(parse(f.intent)), f.envelope.document);
});
for (const field of ['computerId', 'generation', 'leaseEpoch', 'volumeId', 'fsUuid', 'provision', 'v'] as const)
    test('lease identity rejects mutation: ' + field, () => {
        const f = rebaseFixture(); f.lease[field] = typeof f.lease[field] === 'number' ? 99 : typeof f.lease[field] === 'boolean' ? true : '33333333-3333-4333-8333-333333333333';
        assert.throws(() => parse({ ...f.intent, userData: Buffer.from(JSON.stringify(f.lease)).toString('base64') }));
    });
for (const field of ['v', 'preparationJobId', 'launchJobId', 'computerId', 'fsUuid', 'generation', 'leaseEpoch', 'fenceToken', 'issuedAt', 'expiresAt'])
    test('permit rejects mutation: ' + field, () => {
        const f = rebaseFixture(); (f.lease.rebasePermit as any)[field] = 'invalid';
        assert.throws(() => parse({ ...f.intent, userData: Buffer.from(JSON.stringify(f.lease)).toString('base64') }));
    });
test('reference, digest pair, unsupported predecessor and mutually exclusive modes fail closed', () => {
    for (const change of [ { rebasePreparation: undefined }, { rebasePreparation: null },
        { rebasePreparation: { ...rebaseFixture().reference, executionArn: rebaseFixture().reference.executionArn.replace('pilot', 'foreign') } },
        { rebasePreparation: { ...rebaseFixture().reference, v: 2 } },
        { rebasePreparation: { ...rebaseFixture().reference, digest: 'A'.repeat(64) } },
        { deployment: { ...rebaseFixture().intent.deployment, previousLowerImageDigest: null } } ]) assert.throws(() => parse({ ...rebaseFixture().intent, ...change }));
    for (const mutation of [(l: any) => delete l.rebase, (l: any) => delete l.rebasePermit,
        (l: any) => l.rebase.fromDigest = l.rebase.toDigest, (l: any) => l.rebase.extra = true,
        (l: any) => l.restore = {}, (l: any) => l.ebsRestore = {}, (l: any) => l.provision = true,
        (l: any) => l.rebasePermit.issuedAt = '2026-02-30T12:00:00.000Z']) {
        const f = rebaseFixture(); mutation(f.lease);
        assert.throws(() => parse({ ...f.intent, userData: Buffer.from(JSON.stringify(f.lease)).toString('base64') }));
    }
});
test('strict JSON rejects duplicate escaped keys, infinity and excessive nesting', () => {
    for (const raw of ['{"v":1,"v":1}', '{"v":1,"\\u0076":1}', '{"a":{"x":1,"x":2}}', '{"n":1e999}', '[NaN]', '{"v":1,}', '['.repeat(34) + '0' + ']'.repeat(34)])
        assert.throws(() => strictJson(raw, 16384));
    const f = rebaseFixture(), document = f.envelope.document.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1');
    assert.throws(() => parseLifecycleWork({ ...envelopeFor(null), document, digest: (awaitHash(document)), createdAt: new Date() }));
});
import { hash as awaitHash } from './rebase-fixture.js';
test('canonical base64 and decoded-byte boundaries', () => {
    for (const raw of ['e30', 'e31=', ' e30=', 'e30=\n', '_w==', '/w==', 'ZXppbC1ub25jZQ==']) assert.throws(() => parseLease(raw));
    assert.deepEqual(decodeLeaseJson(Buffer.from(' '.repeat(3070) + '{}').toString('base64')), Object.create(null));
    assert.throws(() => decodeLeaseJson(Buffer.from(' '.repeat(3071) + '{}').toString('base64')));
});
test('permit time checks use the injected clock and do not expire historical parsing', () => {
    const f = rebaseFixture(), lease = parseLease(f.intent.userData!);
    const issued = Date.parse(f.lease.rebasePermit.issuedAt), expiry = Date.parse(f.lease.rebasePermit.expiresAt);
    assert.doesNotThrow(() => assertPermitTime(lease, issued - 30000));
    assert.throws(() => assertPermitTime(lease, issued - 30001), /permit_invalid/);
    assert.doesNotThrow(() => assertPermitTime(lease, expiry - 120001));
    assert.throws(() => assertPermitTime(lease, expiry - 120000), /enrollment_time_insufficient/);
    assert.throws(() => assertPermitTime(lease, expiry), /permit_expired/);
    assert.doesNotThrow(() => parse(f.intent));
});
test('deployment release fields are all-or-none and workflow names, region and versions are exact', () => {
    const d = rebaseFixture().intent.deployment;
    for (const field of ['lowerImageDigest', 'previousLowerImageDigest', 'preparationStateMachineVersionArn', 'recoveryStateMachineVersionArn']) {
        const partial = { ...d }; delete (partial as any)[field]; assert.equal(LifecycleDeploymentSchema.safeParse(partial).success, false);
    }
    for (const arn of [d.preparationStateMachineVersionArn!.replace(/:1$/, ':alias'), d.preparationStateMachineVersionArn!.replace('pilot', 'other'), d.stateMachineVersionArn])
        assert.equal(LifecycleDeploymentSchema.safeParse({ ...d, preparationStateMachineVersionArn: arn }).success, false);
});
