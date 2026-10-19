import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerStatements } from '../lib/computer-lifecycle.js';
import { lifecycleFixture } from './lifecycle-fixture.js';

// Evaluate the conditions used by these EC2 statements against concrete
// request/resource contexts, including IAM variable substitution and denies.
const list = (v: any): any[] => v === undefined ? [] : [v].flat();
function permits(action: string, kind: string, context: Record<string, any>) {
    const arn = `arn:aws:ec2:ap-south-1:123456789012:${kind}/example`;
    const matches = controllerStatements(lifecycleFixture().settings).map(s => s.toStatementJson()).filter(s =>
        list(s.Action).includes(action) && list(s.Resource).some(r => r === '*' || arn.startsWith(r.replace(/\*$/, '')))
        && Object.entries(s.Condition ?? {}).every(([operator, entries]) => Object.entries(entries as Record<string, any>).every(([key, expected]) => {
            const values = list(context[key]);
            const wanted = list(expected).map(v => typeof v === 'string' && /^\$\{.*\}$/.test(v) ? context[v.slice(2, -1)] : v);
            if (operator === 'Null') return String(values.length === 0) === expected;
            if (operator === 'StringEquals') return values.length > 0 && values.every(v => wanted.includes(v));
            if (operator === 'ForAllValues:StringEquals') return values.every(v => wanted.includes(v));
            if (operator === 'ForAnyValue:StringEquals') return values.some(v => wanted.includes(v));
            assert.fail('unhandled IAM condition ' + operator);
        })));
    return matches.some(s => s.Effect === 'Allow') && !matches.some(s => s.Effect === 'Deny');
}
const base = {
    'aws:RequestedRegion': 'ap-south-1', 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform',
    'ec2:ResourceTag/ezil:stage': 'pilot', 'ec2:AvailabilityZoneId': 'aps1-az1',
};
const pool = { ...base, 'aws:ResourceTag/ezil:pool': '1', 'ec2:InstanceType': 'm6i.large' };

test('pool IAM: attach and claim require a pool host, configured type, namespace and zone', () => {
    const keys = ['ezil:computer', 'ezil:generation', 'ezil:fence'];
    for (const type of ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']) {
        assert.equal(permits('ec2:AttachVolume', 'instance', { ...pool, 'ec2:InstanceType': type }), true);
        assert.equal(permits('ec2:CreateTags', 'instance', { ...pool, 'ec2:InstanceType': type, 'aws:TagKeys': keys }), true);
    }
    for (const patch of [
        { 'aws:ResourceTag/ezil:pool': undefined }, { 'aws:ResourceTag/ezil:pool': '0' },
        { 'ec2:InstanceType': 'c6i.xlarge' }, { 'ec2:InstanceType': 'm6i.4xlarge' }, { 'ec2:InstanceType': undefined },
        { 'ec2:ResourceTag/ezil:stage': 'foreign' }, { 'ec2:ResourceTag/ezil:managed-by': undefined },
    ]) {
        assert.equal(permits('ec2:AttachVolume', 'instance', { ...pool, ...patch }), false);
        assert.equal(permits('ec2:CreateTags', 'instance', { ...pool, ...patch, 'aws:TagKeys': keys }), false);
    }
    assert.equal(permits('ec2:AttachVolume', 'instance', { ...pool, 'ec2:AvailabilityZoneId': 'aps1-az2' }), false);
    // Legacy attach rights cannot bypass the pool's type condition.
    assert.equal(permits('ec2:AttachVolume', 'instance', { ...pool, 'aws:ResourceTag/ezil:computer-id': 'tenant', 'ec2:InstanceType': 'c6i.xlarge' }), false);
    for (const tags of [undefined, [], ['ezil:managed-by'], ['ezil:computer-id'], ['ezil:backup'], ['ezil:pool']])
        assert.equal(permits('ec2:CreateTags', 'instance', { ...pool, 'aws:TagKeys': tags }), false);
});
test('pool IAM: only a claimed pool instance can lose only its pool tag', () => {
    const claimed = { ...pool, 'aws:ResourceTag/ezil:computer': 'tenant', 'aws:TagKeys': ['ezil:pool'] };
    assert.equal(permits('ec2:DeleteTags', 'instance', claimed), true);
    assert.equal(permits('ec2:DeleteTags', 'volume', claimed), false);
    for (const patch of [
        { 'aws:ResourceTag/ezil:pool': undefined }, { 'aws:ResourceTag/ezil:computer': undefined },
        { 'aws:TagKeys': undefined }, { 'aws:TagKeys': [] }, { 'aws:TagKeys': ['ezil:pool', 'ezil:computer'] },
        { 'ec2:InstanceType': 't3.medium' },
    ]) assert.equal(permits('ec2:DeleteTags', 'instance', { ...claimed, ...patch }), false);
});
test('pool IAM: retained volume identity cannot be reassigned to another computer', () => {
    const volume = { ...base, 'aws:ResourceTag/ezil:computer-id': 'tenant', 'aws:RequestTag/ezil:computer': 'tenant',
        'aws:TagKeys': ['ezil:computer', 'ezil:generation', 'ezil:fence', 'ezil:fence-token'] };
    assert.equal(permits('ec2:CreateTags', 'volume', volume), true);
    assert.equal(permits('ec2:CreateTags', 'volume', { ...volume, 'aws:RequestTag/ezil:computer': 'foreign' }), false);
    assert.equal(permits('ec2:CreateTags', 'volume', { ...volume, 'aws:ResourceTag/ezil:computer-id': undefined }), false);
});
test('pool IAM: release requires computer tags, preserves type limits and cannot delete storage', () => {
    const released = { ...base, 'aws:ResourceTag/ezil:computer': 'tenant', 'ec2:InstanceType': 'm6i.xlarge' };
    for (const action of ['ec2:StopInstances', 'ec2:TerminateInstances']) {
        assert.equal(permits(action, 'instance', released), true);
        assert.equal(permits(action, 'instance', { ...released, 'aws:ResourceTag/ezil:computer': undefined }), false);
        assert.equal(permits(action, 'instance', { ...released, 'ec2:InstanceType': 'c6i.xlarge' }), false);
    }
    assert.equal(permits('ec2:DetachVolume', 'volume', released), true);
    assert.equal(permits('ec2:DetachVolume', 'volume', { ...released, 'aws:ResourceTag/ezil:computer': undefined }), false);
    assert.equal(permits('ec2:DetachVolume', 'volume', { ...released, 'ec2:AvailabilityZoneId': 'aps1-az2' }), false);
    assert.equal(permits('ec2:DeleteVolume', 'volume', released), false);
    assert.equal(permits('ec2:DeleteSnapshot', 'snapshot', released), false);
});
test('a deployment without pool types receives no pool instance grants', () => {
    const f = lifecycleFixture('provision', { instanceType: 't3.medium', instanceTypes: ['t3.medium'] });
    const policies = controllerStatements(f.settings).map(s => s.toStatementJson());
    assert.equal(policies.some(s => s.Condition?.StringEquals?.['aws:ResourceTag/ezil:pool']), false);
    assert.ok(policies.every(s => s.Condition?.StringEquals?.['ec2:InstanceType']?.length !== 0));
});
