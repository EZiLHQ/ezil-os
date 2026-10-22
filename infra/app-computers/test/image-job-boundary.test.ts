import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, assertions } from 'aws-cdk-lib';
import { IdentityConfigSchema, boundaryStatements, identityGuardrailStatements, execStatements, DeployIdentityStack } from '../lib/identity.js';
import { imageJobBoundaryStatements, recoveryRestoreStatements, imageJobBoundaryArn } from '../lib/image-job-boundary.js';
import { preparationStatements } from '../lib/rebase-preparation.js';
import { preparationFixture } from './preparation-fixture.js';
import { evaluate, list } from './iam-evaluate.js';

const json = (s: { toStatementJson(): any }[]) => s.map(x => x.toStatementJson());
const cfg = IdentityConfigSchema.parse(JSON.parse(readFileSync(join(__dirname, '../config/identity.example.json'), 'utf8')));
const d = preparationFixture().settings.deployment;
const contextFor = (s: any) => Object.fromEntries(Object.entries(s.Condition ?? {}).flatMap(([op, entries]) => Object.entries(entries as any)
    .filter(([, v]) => op !== 'Null' || v === 'false')
    .map(([key, v]) => [key, op === 'Null' ? 'present' : op.startsWith('For') ? v : list(v)[0]])));

test('image boundary fits 6144 bytes at longest namespace/region with every feature and volume cap', () => {
    for (const poolLifecycle of [false, true]) for (const killSwitch of [false, true]) for (const userDataAttributeKeyVerified of [false, true]) {
        const c = { ...cfg, namespace: 'a'.repeat(21), region: 'ap-northeast-1', killSwitch, userDataAttributeKeyVerified, maxVolumeGiB: 16384, poolLifecycle };
        const deployment = JSON.parse(JSON.stringify(d).replaceAll('pilot', c.namespace).replaceAll('ap-south-1', c.region).replaceAll('aps1-az1', 'apne1-az1'));
        deployment.storage.dataMinGiB = 16384; deployment.storage.dataMaxGiB = 16384;
        const document = { Version: '2012-10-17', Statement: json(imageJobBoundaryStatements(c, deployment)) };
        assert.ok(Buffer.byteLength(JSON.stringify(document)) <= 6144, String(Buffer.byteLength(JSON.stringify(document))));
    }
});
test('snapshot and restore grants retain conditions under the boundary, including all missing tags and foreign scope', () => {
    const ceiling = json(imageJobBoundaryStatements(cfg, d));
    const roles = json([...preparationStatements(preparationFixture().settings), ...recoveryRestoreStatements(d)]);
    for (const s of roles.filter(s => s.Effect === 'Allow' && list(s.Action).some(a => a.startsWith('ec2:Create')))) {
        const context = contextFor(s);
        // Null presence must not overwrite exact values in our fixture.
        Object.assign(context, s.Condition?.StringEquals, s.Condition?.ArnEquals, s.Condition?.Bool);
        for (const action of list(s.Action)) for (const resource of list(s.Resource).map(r => r.replace('*', 'test'))) {
            assert.equal(evaluate(roles, action, resource, context).allowed, true, action);
            assert.equal(evaluate(ceiling, action, resource, context).allowed, true, action);
            for (const key of Object.keys(context)) {
                const missing = { ...context, [key]: undefined };
                if (!evaluate(roles, action, resource, missing).allowed)
                    assert.equal(evaluate(ceiling, action, resource, missing).allowed, false, action + ':' + key);
            }
            for (const key of Object.keys(context).filter(k => /stage|RequestedRegion|KmsKeyId|AvailabilityZoneId/.test(k)))
                assert.equal(evaluate(ceiling, action, resource, { ...context, [key]: 'foreign' }).allowed, false, key);
        }
    }
});
test('all shared global denies survive; snapshot sharing, storage destruction, tag edits and kill switch stay denied', () => {
    for (const poolLifecycle of [false, true]) for (const killSwitch of [false, true]) {
        const c = { ...cfg, killSwitch, poolLifecycle }, ceiling = json(imageJobBoundaryStatements(c, d));
        for (const s of json(boundaryStatements(c)).filter(s => s.Effect === 'Deny')) {
            const context = contextFor(s);
            for (const key of Object.keys(s.Condition?.StringNotEquals ?? {})) context[key] = 'foreign';
            for (const action of list(s.Action ?? ['ec2:RunInstances'])) for (const resource of list(s.Resource ?? ['*']))
                assert.equal(evaluate(ceiling, action.replace('*', 'Example'), resource.replace('*', 'test'), context).denied, true, action);
        }
        for (const action of ['ec2:CopySnapshot', 'ec2:ModifySnapshotAttribute', 'ec2:ResetSnapshotAttribute', 'ec2:DetachVolume', 'ec2:DeleteTags', 'iam:PassRole', 'ec2:ModifyInstanceMetadataOptions'])
            assert.equal(evaluate(ceiling, action, '*', { 'aws:RequestedRegion': d.region }).denied, true);
    }
});
test('recovery existing effective allows are equal before/after boundary, with restore as the only EC2 addition', () => {
    const before = json(boundaryStatements(cfg)), after = json(imageJobBoundaryStatements(cfg, d));
    const oldActions = ['ec2:StopInstances', 'ec2:TerminateInstances', 'lambda:InvokeFunction', 'kms:Encrypt', 'kms:Decrypt', 'kms:ReEncryptFrom',
        'kms:ReEncryptTo', 'kms:GenerateDataKey', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:DescribeKey', 'logs:CreateLogDelivery', 'logs:DeleteLogDelivery'];
    for (const action of oldActions) for (const stage of ['pilot', 'foreign', undefined]) for (const region of [d.region, 'us-east-1', undefined]) {
        const service = action.split(':')[0];
        const resource = service === 'ec2' ? `arn:aws:ec2:${d.region}:${d.accountId}:instance/i-test`
            : service === 'kms' ? d.dataKeyArn : service === 'lambda' ? `arn:aws:lambda:${d.region}:${d.accountId}:function:ezil-pilot-recovery-observer:1` : '*';
        const context = { 'aws:RequestedRegion': region, 'aws:ResourceTag/ezil:managed-by': 'app-computer-platform',
            'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform', 'aws:ResourceTag/ezil:stage': stage,
            'ec2:ResourceTag/ezil:stage': stage, 'aws:ResourceTag/ezil:namespace': stage };
        assert.equal(evaluate(after, action, resource, context).allowed, evaluate(before, action, resource, context).allowed, action);
    }
    assert.deepEqual([...new Set(after.filter(s => s.Effect === 'Allow').flatMap(s => list(s.Action)).filter(a => a.startsWith('ec2:')))].sort(),
        ['ec2:CreateSnapshot', 'ec2:CreateTags', 'ec2:CreateVolume', 'ec2:StopInstances', 'ec2:TerminateInstances']);
});
test('founder policy and deployment exceptions name only preparation/recovery roles and preserve observer boundary', () => {
    const c = IdentityConfigSchema.parse({ ...cfg, imageJobDeployment: d });
    const stack = new DeployIdentityStack(new App(), 'ImageBoundaryIdentity', { config: c, env: { account: c.accountId, region: c.region } });
    const policies = assertions.Template.fromStack(stack).findResources('AWS::IAM::ManagedPolicy');
    assert.equal(Object.values(policies).filter((p: any) => p.Properties.ManagedPolicyName === 'ezil-pilot-image-job-boundary').length, 1);
    const all = [...json(execStatements(c)), ...json(identityGuardrailStatements(c))], boundary = imageJobBoundaryArn(c.accountId, c.namespace);
    for (const role of ['rebase-preparation', 'recovery', 'observer', 'app-caller']) {
        const arn = `arn:aws:iam::${c.accountId}:role/ezil/${c.namespace}/ezil-${c.namespace}-${role}`;
        assert.equal(evaluate(all, 'iam:CreateRole', arn, { 'iam:PermissionsBoundary': boundary }).allowed, ['rebase-preparation', 'recovery'].includes(role));
    }
    assert.equal(IdentityConfigSchema.safeParse({ ...c, imageJobDeployment: { ...d, namespace: 'foreign' } }).success, false);
});

test('image boundary has a reviewed exact policy snapshot', () => {
    const expected = JSON.parse(readFileSync(join(__dirname, '__snapshots__/image-job-boundary.json'), 'utf8'));
    assert.deepEqual(json(imageJobBoundaryStatements(cfg, d)), expected);
    // The shared storage denies change insertion order only; image permissions
    // and every guardrail condition remain identical when the pool is enabled.
    const sortActions = (statements: any[]) => statements.map(s => ({ ...s, Action: Array.isArray(s.Action) ? [...s.Action].sort() : s.Action }));
    assert.deepEqual(sortActions(json(imageJobBoundaryStatements({ ...cfg, poolLifecycle: true }, d))), sortActions(expected));
});

test('poolLifecycle changes only the shared workload policy, preserving image and identity guardrails in the synthesized stack', () => {
    for (const imageJobDeployment of [undefined, d]) for (const killSwitch of [false, true])
        for (const userDataAttributeKeyVerified of [false, true]) {
            const rest = (poolLifecycle: boolean) => {
                const config = IdentityConfigSchema.parse({ ...cfg, imageJobDeployment, killSwitch, userDataAttributeKeyVerified, poolLifecycle });
                const stack = new DeployIdentityStack(new App({ autoSynth: false }), 'PoolIsolation', {
                    config, env: { account: cfg.accountId, region: cfg.region },
                });
                const template = assertions.Template.fromStack(stack).toJSON();
                for (const [id, resource] of Object.entries(template.Resources) as [string, any][]) {
                    if (resource.Type !== 'AWS::IAM::ManagedPolicy') continue;
                    const name = resource.Properties.ManagedPolicyName;
                    if (name === 'ezil-pilot-boundary') { delete template.Resources[id]; continue; }
                    const statements = resource.Properties.PolicyDocument.Statement;
                    for (const action of ['ec2:DetachVolume', 'ec2:DeleteTags']) {
                        assert.equal(evaluate(statements, action, '*', { 'aws:RequestedRegion': cfg.region }).denied, true, name + ':' + action);
                        assert.equal(statements.some((s: any) => s.Effect === 'Allow' && list(s.Action).includes(action)), false);
                    }
                    // Image compaction merges the same denies in a different
                    // action order; preserve every other part of the template.
                    if (name === 'ezil-pilot-image-job-boundary')
                        for (const s of statements) if (Array.isArray(s.Action)) s.Action.sort();
                }
                return template;
            };
            assert.deepEqual(rest(true), rest(false));
        }
});

test('data-key role/boundary intersection rejects foreign keys, missing namespace and unscoped grants', () => {
    const role = json(recoveryRestoreStatements(d)), ceiling = json(imageJobBoundaryStatements(cfg, d));
    const valid = { 'aws:RequestedRegion': d.region, 'aws:ResourceTag/ezil:namespace': d.namespace,
        'kms:ViaService': `ec2.${d.region}.amazonaws.com`, 'kms:GrantIsForAWSResource': 'true' };
    const allowed = (action: string, resource: string, context: Record<string, unknown>) =>
        evaluate(role, action, resource, context).allowed && evaluate(ceiling, action, resource, context).allowed;
    for (const action of ['kms:CreateGrant', 'kms:Decrypt', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncryptFrom', 'kms:ReEncryptTo']) {
        assert.equal(allowed(action, d.dataKeyArn, valid), true);
        assert.equal(allowed(action, d.dataKeyArn.replace('123456789012', '999999999999'), valid), false);
        for (const key of ['aws:RequestedRegion', 'aws:ResourceTag/ezil:namespace', 'kms:ViaService'])
            assert.equal(allowed(action, d.dataKeyArn, { ...valid, [key]: undefined }), false);
    }
    assert.equal(allowed('kms:CreateGrant', d.dataKeyArn, { ...valid, 'kms:GrantIsForAWSResource': undefined }), false);
});
