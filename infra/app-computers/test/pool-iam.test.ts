import assert from 'node:assert/strict';
import test from 'node:test';
import { controllerStatements } from '../lib/computer-lifecycle.js';
import { killSwitchStatements } from '../lib/ops.js';
import { IdentityConfigSchema, boundaryStatements, identityGuardrailStatements } from '../lib/identity.js';
import { evaluate } from './iam-evaluate.js';
import { launchParameters } from '../lib/lifecycle/helper.js';
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
            if (operator === 'StringNotEquals') return values.every(v => !wanted.includes(v));
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
const pool = { ...base, 'aws:ResourceTag/ezil:namespace': 'pilot', 'aws:ResourceTag/ezil:pool': '1', 'ec2:InstanceType': 'm6i.large' };

test('pool IAM: attach and claim require a pool host, configured type, namespace and zone', () => {
    const keys = ['ezil:computer', 'ezil:generation', 'ezil:fence'];
    for (const type of ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']) {
        assert.equal(permits('ec2:AttachVolume', 'instance', { ...pool, 'ec2:InstanceType': type }), true);
        assert.equal(permits('ec2:CreateTags', 'instance', { ...pool, 'ec2:InstanceType': type, 'aws:TagKeys': keys }), true);
    }
    for (const patch of [
        { 'aws:ResourceTag/ezil:pool': undefined }, { 'aws:ResourceTag/ezil:pool': '0' },
        { 'ec2:InstanceType': 'c6i.xlarge' }, { 'ec2:InstanceType': 't3.medium' },
        { 'aws:ResourceTag/ezil:namespace': 'foreign' }, { 'aws:ResourceTag/ezil:namespace': undefined }, { 'ec2:InstanceType': 'm6i.4xlarge' }, { 'ec2:InstanceType': undefined },
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
    const released = { ...base, 'aws:ResourceTag/ezil:namespace': 'pilot', 'aws:ResourceTag/ezil:computer': 'tenant', 'ec2:InstanceType': 'm6i.xlarge' };
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

test('pool-retire IAM: only unclaimed, namespaced pool hosts of the exact pool types may terminate', () => {
    for (const instanceType of ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']) {
        assert.equal(permits('ec2:TerminateInstances', 'instance', { ...pool, 'ec2:InstanceType': instanceType }), true);
    }
    for (const patch of [
        { 'aws:ResourceTag/ezil:pool': undefined }, { 'aws:ResourceTag/ezil:pool': '0' },
        { 'aws:ResourceTag/ezil:namespace': undefined }, { 'aws:ResourceTag/ezil:namespace': 'foreign' },
        { 'ec2:ResourceTag/ezil:stage': 'foreign' }, { 'ec2:ResourceTag/ezil:managed-by': undefined },
        { 'aws:RequestedRegion': 'us-east-1' }, { 'ec2:InstanceType': undefined }, { 'ec2:InstanceType': 't3.medium' },
        { 'aws:ResourceTag/ezil:computer': 'tenant' }, { 'aws:ResourceTag/ezil:computer': '' },
        { 'aws:ResourceTag/ezil:computer-id': 'tenant' },
        { 'aws:ResourceTag/ezil:computer': 'tenant', 'aws:ResourceTag/ezil:computer-id': 'tenant' },
    ]) assert.equal(permits('ec2:TerminateInstances', 'instance', { ...pool, ...patch }), false, JSON.stringify(patch));
    for (const action of ['ec2:StopInstances', 'ec2:StartInstances', 'ec2:DeleteVolume'])
        assert.equal(permits(action, 'instance', pool), false);
    assert.equal(permits('ec2:TerminateInstances', 'volume', pool), false);
});

test('release IAM: aliases cannot bypass pool type/namespace limits; cold data may detach', () => {
    for (const patch of [{ 'ec2:InstanceType': 't3.medium' }, { 'aws:ResourceTag/ezil:namespace': undefined }])
        assert.equal(permits('ec2:TerminateInstances', 'instance', { ...base, 'aws:ResourceTag/ezil:computer': 'tenant',
            'aws:ResourceTag/ezil:computer-id': 'tenant', 'aws:ResourceTag/ezil:namespace': 'pilot', 'ec2:InstanceType': 'm6i.large', ...patch }), false);
    const cold = { ...base, 'aws:ResourceTag/ezil:computer-id': 'tenant' };
    assert.equal(permits('ec2:DetachVolume', 'volume', cold), true);
    for (const patch of [{ 'aws:ResourceTag/ezil:computer-id': undefined }, { 'ec2:ResourceTag/ezil:stage': 'foreign' },
        { 'ec2:ResourceTag/ezil:managed-by': undefined }, { 'ec2:AvailabilityZoneId': 'aps1-az2' }, { 'aws:RequestedRegion': 'us-east-1' }])
        assert.equal(permits('ec2:DetachVolume', 'volume', { ...cold, ...patch }), false);
});

test('release IAM: detach authorizes both cold host and retained volume with managed computer-id tags', () => {
    const cold = { ...base, 'aws:ResourceTag/ezil:computer-id': 'tenant' };
    for (const kind of ['instance', 'volume']) {
        assert.equal(permits('ec2:DetachVolume', kind, cold), true, kind);
        for (const patch of [
            { 'aws:ResourceTag/ezil:computer-id': undefined },
            { 'ec2:ResourceTag/ezil:managed-by': undefined }, { 'ec2:ResourceTag/ezil:managed-by': 'foreign' },
            { 'ec2:ResourceTag/ezil:stage': undefined }, { 'ec2:ResourceTag/ezil:stage': 'foreign' },
            { 'aws:RequestedRegion': undefined }, { 'aws:RequestedRegion': 'us-east-1' },
        ]) assert.equal(permits('ec2:DetachVolume', kind, { ...cold, ...patch }), false, `${kind} ${JSON.stringify(patch)}`);
    }
    // EC2 evaluates both resources; the volume grant binds detachment to the AZ.
    for (const zone of [undefined, 'aps1-az2'])
        assert.equal(permits('ec2:DetachVolume', 'volume', { ...cold, 'ec2:AvailabilityZoneId': zone }), false);
    assert.equal(permits('ec2:DetachVolume', 'instance', { ...cold, 'aws:ResourceTag/ezil:pool': '1' }), false);
    assert.equal(permits('ec2:DetachVolume', 'instance', { ...cold, 'aws:ResourceTag/ezil:computer': 'tenant' }), false);
    assert.equal(permits('ec2:DetachVolume', 'snapshot', cold), false);
});

test('release IAM: adopted host detach keeps namespace, type and completed-claim limits', () => {
    const claimed = { ...base, 'aws:ResourceTag/ezil:namespace': 'pilot', 'aws:ResourceTag/ezil:computer': 'tenant', 'ec2:InstanceType': 'm6i.large' };
    for (const instanceType of ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']) {
        assert.equal(permits('ec2:DetachVolume', 'instance', { ...claimed, 'ec2:InstanceType': instanceType }), true);
        assert.equal(permits('ec2:DetachVolume', 'volume', claimed), true);
    }
    for (const aliases of [{}, { 'aws:ResourceTag/ezil:computer-id': 'tenant' }]) for (const patch of [
        { 'aws:ResourceTag/ezil:namespace': undefined }, { 'aws:ResourceTag/ezil:namespace': 'foreign' },
        { 'ec2:InstanceType': undefined }, { 'ec2:InstanceType': 't3.medium' }, { 'ec2:InstanceType': 'c6i.xlarge' },
        { 'aws:ResourceTag/ezil:pool': '1' }, { 'aws:ResourceTag/ezil:pool': '0' },
        { 'ec2:ResourceTag/ezil:managed-by': undefined }, { 'ec2:ResourceTag/ezil:managed-by': 'foreign' },
        { 'ec2:ResourceTag/ezil:stage': undefined }, { 'ec2:ResourceTag/ezil:stage': 'foreign' },
        { 'aws:RequestedRegion': undefined }, { 'aws:RequestedRegion': 'us-east-1' },
    ]) assert.equal(permits('ec2:DetachVolume', 'instance', { ...claimed, ...aliases, ...patch }), false, JSON.stringify(patch));
    assert.equal(permits('ec2:DetachVolume', 'instance', { ...claimed, 'aws:ResourceTag/ezil:computer': undefined }), false);
    assert.equal(permits('ec2:DetachVolume', 'instance', pool), false);
});

test('release IAM: every detach grant is resource-scoped and conditioned; both instance variants exist', () => {
    const statements = controllerStatements(lifecycleFixture().settings).map(s => s.toStatementJson());
    const detach = statements.filter(s => s.Effect === 'Allow' && list(s.Action).includes('ec2:DetachVolume'));
    assert.equal(detach.length, 4);
    assert.equal(detach.filter(s => s.Resource === 'arn:aws:ec2:ap-south-1:123456789012:instance/*').length, 2);
    for (const statement of detach) {
        assert.match(statement.Resource, /^arn:aws:ec2:ap-south-1:123456789012:(instance|volume)\/\*$/);
        assert.equal(statement.Condition.StringEquals['ec2:ResourceTag/ezil:managed-by'], 'app-computer-platform');
        assert.equal(statement.Condition.StringEquals['ec2:ResourceTag/ezil:stage'], 'pilot');
        assert.equal(statement.Condition.StringEquals['aws:RequestedRegion'], 'ap-south-1');
        if (statement.Resource.includes(':volume/'))
            assert.equal(statement.Condition.StringEquals['ec2:AvailabilityZoneId'], 'aps1-az1');
        assert.ok(Object.entries(statement.Condition.Null).some(([key, value]) =>
            ['aws:ResourceTag/ezil:computer-id', 'aws:ResourceTag/ezil:computer'].includes(key) && value === 'false'));
    }
});

async function launchContext() {
    const f = lifecycleFixture('pool-provision'), p = await launchParameters(f.i, f.digest, f.deps);
    const tags = p.TagSpecifications!.find(s => s.ResourceType === 'instance')!.Tags!;
    return { f, context: { 'aws:RequestedRegion': f.i.deployment.region,
        ...Object.fromEntries(tags.map(t => ['aws:RequestTag/' + t.Key, t.Value])),
        'ec2:InstanceType': p.InstanceType, 'ec2:MetadataHttpTokens': p.MetadataOptions!.HttpTokens,
        'ec2:InstanceMetadataTags': p.MetadataOptions!.InstanceMetadataTags, 'ec2:AvailabilityZoneId': f.i.deployment.zoneId,
        'ec2:MetadataHttpPutResponseHopLimit': p.MetadataOptions!.HttpPutResponseHopLimit,
        'ec2:LaunchTemplate': `arn:aws:ec2:ap-south-1:123456789012:launch-template/${p.LaunchTemplate!.LaunchTemplateId}` } };
}
const hostArn = 'arn:aws:ec2:ap-south-1:123456789012:instance/example';
test('pool-provision IAM uses the same exact type set as pool intents, while cold 2xlarge remains available', async () => {
    const { f, context } = await launchContext(), policy = controllerStatements(f.settings).map(s => s.toStatementJson());
    for (const instanceType of ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge', 'c6i.xlarge'])
        assert.equal(evaluate(policy, 'ec2:RunInstances', hostArn, { ...context, 'ec2:InstanceType': instanceType }).allowed,
            ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge'].includes(instanceType));
    assert.equal(evaluate(policy, 'ec2:RunInstances', hostArn, { ...context, 'aws:RequestTag/ezil:pool': undefined, 'ec2:InstanceType': 'm6i.2xlarge' }).allowed, true);
});

test('kill-switch denies pool-provision RunInstances at the controller, boundary and identity layers', async () => {
    const { f, context } = await launchContext();
    const cfg = IdentityConfigSchema.parse({ namespace: 'pilot', accountId: '123456789012', region: 'ap-south-1',
        githubOidcProviderArn: 'arn:aws:iam::123456789012:oidc-provider/token.actions.githubusercontent.com',
        deploySubject: 'repo:org@123/repo@456:environment:aws-pilot', assetBucketName: 'ezil-pilot-assets-123456789012',
        killSwitch: true, poolLifecycle: true });
    const allowed = controllerStatements(f.settings).map(s => s.toStatementJson());
    assert.equal(evaluate(allowed, 'ec2:RunInstances', hostArn, context).allowed, true);
    for (const layer of [killSwitchStatements(), boundaryStatements(cfg), identityGuardrailStatements(cfg)]) {
        const denies = layer.map(s => s.toStatementJson()).filter(s => s.Effect === 'Deny' && list(s.Action).includes('ec2:RunInstances'));
        for (const instanceType of ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']) {
            const result = evaluate([...allowed, ...denies], 'ec2:RunInstances', hostArn, { ...context, 'ec2:InstanceType': instanceType });
            assert.equal(result.allowed, false); assert.equal(result.denied, true);
        }
        // Draining remains possible on the controller when launch is blocked.
        const retired = evaluate(denies, 'ec2:TerminateInstances', hostArn, pool);
        assert.equal(retired.denied, false);
    }
});
