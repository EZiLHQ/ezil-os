import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions } from 'aws-cdk-lib';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { lifecycleFixture, REGION } from './lifecycle-fixture.js';

const RECOVERY_ARN = `arn:aws:states:${REGION}:123456789012:stateMachine:ezil-pilot-recovery:1`;
function synth(recovery = false) {
    const f = lifecycleFixture(), app = new App(), stack = new Stack(app, 'LifecycleTest', { env: { account: f.settings.deployment.accountId, region: REGION } });
    const lifecycle = new ComputerLifecycle(stack, 'Lifecycle', { settings: f.settings, authorityKeyArn: f.settings.deployment.dataKeyArn });
    if (recovery) new ComputerLifecycleRecovery(stack, 'Recovery', { settings: { lifecycle: f.settings, recoveryVersionArn: RECOVERY_ARN },
        sourceHistoryKey: lifecycle.historyKey });
    return { f, t: assertions.Template.fromStack(stack) };
}
type Statement = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
/** Statements from AWS::IAM::Policy resources (DefaultPolicy included), not only roles. */
function statements(t: assertions.Template, prefix = ''): Statement[] {
    const policies = Object.entries(t.findResources('AWS::IAM::Policy')).filter(([name]) => name.startsWith(prefix));
    assert.ok(policies.length > 0, 'expected IAM policy resources');
    return policies.flatMap(([, p]: [string, any]) => p.Properties.PolicyDocument.Statement as Statement[]);
}
const actions = (s: Statement) => ([] as string[]).concat(s.Action);
const allows = (all: Statement[], action: string, resource?: RegExp) => all.filter(s => s.Effect === 'Allow' && actions(s).includes(action)
    && (!resource || JSON.stringify(s.Resource).match(resource)));

test('lifecycle CDK synthesizes a pinned Standard graph, scoped roles, encryption and disabled notifications', () => {
    const { t } = synth();
    t.resourceCountIs('AWS::EC2::Instance', 0); t.resourceCountIs('AWS::EC2::Volume', 0);
    t.resourceCountIs('AWS::StepFunctions::StateMachine', 1); t.resourceCountIs('AWS::StepFunctions::StateMachineVersion', 1);
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD', EncryptionConfiguration: { Type: 'CUSTOMER_MANAGED_KMS_KEY' },
        LoggingConfiguration: { IncludeExecutionData: false, Level: 'ERROR' } });
    t.hasResourceProperties('AWS::Events::Rule', { State: 'DISABLED', EventPattern: { detail: { status: ['FAILED', 'TIMED_OUT', 'ABORTED'] } } });
    t.hasResourceProperties('AWS::Lambda::Function', { Timeout: 55, ReservedConcurrentExecutions: 2 });
    for (const queue of Object.values(t.findResources('AWS::SQS::Queue')) as any[]) { assert.ok(queue.Properties.KmsMasterKeyId); assert.equal(queue.DeletionPolicy, 'Retain'); }
    assert.equal((Object.values(t.findResources('AWS::StepFunctions::StateMachineVersion')) as any[])[0].DeletionPolicy, 'Retain');
    assert.doesNotMatch(JSON.stringify(t.toJSON()), /us-east-1|m7i/);
});

test('item 3: no instance profiles, no PassRole, no AWS-managed host policy', () => {
    const { t } = synth(true), all = statements(t);
    t.resourceCountIs('AWS::IAM::InstanceProfile', 0);
    assert.equal(allows(all, 'iam:PassRole').length, 0);
    assert.doesNotMatch(JSON.stringify(t.toJSON()), /AmazonSSMManagedInstanceCore|instance-profile/);
    const run = allows(all, 'ec2:RunInstances', /:instance\/\*/);
    assert.equal(run.length, 1); assert.equal(run[0]!.Condition!.Null!['ec2:InstanceProfile'], 'true');
});

test('item 2: RunInstances instance types use StringEquals on a closed allowlist; type changes are impossible', () => {
    const { t, f } = synth(), all = statements(t);
    const run = allows(all, 'ec2:RunInstances', /:instance\/\*/)[0]!;
    assert.deepEqual(run.Condition!.StringEquals!['ec2:InstanceType'], f.settings.deployment.instanceTypes);
    assert.ok(!JSON.stringify(all).includes('IfExists'), 'no IfExists condition operators');
    assert.equal(allows(all, 'ec2:ModifyInstanceAttribute').length, 0);
    assert.ok(all.some(s => s.Effect === 'Deny' && actions(s).includes('ec2:ModifyInstanceAttribute')));
});

test('item 4/6: RunInstances requires IMDSv2, hop limit <= 1, metadata tags off, configured ZoneId, encrypted bounded root', () => {
    const { t } = synth(), all = statements(t);
    const run = allows(all, 'ec2:RunInstances', /:instance\/\*/)[0]!;
    assert.equal(run.Condition!.StringEquals!['ec2:MetadataHttpTokens'], 'required');
    assert.equal(run.Condition!.StringEquals!['ec2:InstanceMetadataTags'], 'disabled');
    assert.equal(run.Condition!.StringEquals!['ec2:AvailabilityZoneId'], 'aps1-az1');
    assert.equal(run.Condition!.NumericLessThanEquals!['ec2:MetadataHttpPutResponseHopLimit'], '1');
    const root = allows(all, 'ec2:RunInstances', /:volume\/\*/);
    assert.equal(root.length, 1);
    assert.equal(root[0]!.Condition!.Bool!['ec2:Encrypted'], 'true');
    assert.equal(root[0]!.Condition!.NumericLessThanEquals!['ec2:VolumeSize'], '30');
});

test('item 5/6: CreateVolume is pinned to the ZoneId, encrypted, gp3 and the configured size range', () => {
    const { t, f } = synth(), all = statements(t);
    const create = allows(all, 'ec2:CreateVolume');
    assert.equal(create.length, 1);
    const c = create[0]!.Condition!;
    assert.equal(c.StringEquals!['ec2:AvailabilityZoneId'], 'aps1-az1');
    assert.equal(c.StringEquals!['ec2:VolumeType'], 'gp3');
    assert.equal(c.Bool!['ec2:Encrypted'], 'true');
    assert.equal(c.ArnEquals!['ec2:KmsKeyId'], f.settings.deployment.dataKeyArn);
    assert.equal(c.NumericGreaterThanEquals!['ec2:VolumeSize'], '20');
    assert.equal(c.NumericLessThanEquals!['ec2:VolumeSize'], '100');
    assert.ok(!JSON.stringify(all).includes('NumericEquals"'), 'no fixed-size NumericEquals');
    const attach = allows(all, 'ec2:AttachVolume')[0]!;
    assert.equal(attach.Condition!.StringEquals!['ec2:AvailabilityZoneId'], 'aps1-az1');
});

test('item 6: identity tags only at creation; pool claims and volume retags have exact key lists', () => {
    const { t } = synth(), all = statements(t);
    const tags = allows(all, 'ec2:CreateTags');
    assert.equal(tags.length, 4);
    for (const s of tags) {
        const createAction = s.Condition!.StringEquals?.['ec2:CreateAction'];
        const keys = s.Condition!['ForAllValues:StringEquals']?.['aws:TagKeys'] as string[] | undefined;
        assert.ok(createAction || keys, 'every CreateTags allow is bounded by CreateAction or a key list');
        if (keys) {
            if (s.Condition!.StringEquals?.['aws:ResourceTag/ezil:pool'])
                assert.deepEqual(keys, ['ezil:computer', 'ezil:generation', 'ezil:fence']);
            else if (s.Condition!.StringEquals?.['aws:RequestTag/ezil:computer'])
                assert.deepEqual(keys, ['ezil:computer', 'ezil:generation', 'ezil:fence', 'ezil:fence-token']);
            else assert.deepEqual([...keys].sort(), ['ezil:fence-token', 'ezil:generation']);
            assert.equal(s.Condition!.Null!['aws:TagKeys'], 'false', 'an empty tag set must not satisfy ForAllValues');
        }
        else assert.deepEqual(createAction, ['RunInstances', 'CreateVolume']);
    }
    const deny = all.find(s => s.Effect === 'Deny' && actions(s).includes('ec2:CreateTags'))!;
    assert.deepEqual(deny.Condition!['ForAnyValue:StringEquals']!['aws:TagKeys'], ['ezil:computer-id', 'ezil:managed-by', 'ezil:stage', 'ezil:backup']);
    assert.equal(deny.Condition!.Null!['ec2:CreateAction'], 'true');
});

test('item 6: storage deletion is denied; only lifecycle may detach an owned volume', () => {
    const { t } = synth(true), all = statements(t);
    for (const action of ['ec2:DeleteVolume', 'ec2:DeleteSnapshot']) {
        assert.equal(allows(all, action).length, 0, action);
        // Each workflow role carries its own explicit deny.
        for (const prefix of ['LifecycleControllerRole', 'RecoveryRecoveryRole']) {
            assert.ok(statements(t, prefix).some(s => s.Effect === 'Deny' && actions(s).includes(action)), `${prefix} denies ${action}`);
        }
    }
    const detach = allows(all, 'ec2:DetachVolume'); assert.equal(detach.length, 4);
    assert.equal(detach[0]!.Condition!.Null!['aws:ResourceTag/ezil:computer-id'], 'false');
    assert.equal(detach[1]!.Condition!.Null!['aws:ResourceTag/ezil:computer'], 'false');
    for (const statement of detach) {
        assert.equal(statement.Condition!.StringEquals!['ec2:ResourceTag/ezil:managed-by'], 'app-computer-platform');
        assert.equal(statement.Condition!.StringEquals!['ec2:ResourceTag/ezil:stage'], 'pilot');
        if (JSON.stringify(statement.Resource).includes(':volume/'))
            assert.equal(statement.Condition!.StringEquals!['ec2:AvailabilityZoneId'], 'aps1-az1');
    }
    assert.ok(statements(t, 'RecoveryRecoveryRole').some(s => s.Effect === 'Deny' && actions(s).includes('ec2:DetachVolume')));
    assert.ok(!all.some(s => s.Effect === 'Allow' && actions(s).some(a => a === 'ec2:*' || a === '*' || a === 'iam:CreateRole')));
    const stop = allows(all, 'ec2:StopInstances');
    for (const s of stop) assert.equal(s.Condition!.StringEquals!['ec2:ResourceTag/ezil:managed-by'], 'app-computer-platform');
});

test('recovery synthesis gives no launch, storage deletion, attachment, modify, secret, or redrive permissions', () => {
    const { t } = synth(true);
    t.resourceCountIs('AWS::EC2::Instance', 0); t.resourceCountIs('AWS::EC2::Volume', 0);
    t.resourceCountIs('AWS::StepFunctions::StateMachine', 2);
    t.resourceCountIs('AWS::StepFunctions::StateMachineVersion', 2);
    const recovery = statements(t, 'Recovery'), allowed = recovery.filter(s => s.Effect === 'Allow').flatMap(actions);
    for (const forbidden of ['ec2:RunInstances', 'ec2:StartInstances', 'ec2:CreateVolume', 'ec2:DeleteVolume', 'ec2:ModifyInstanceAttribute',
        'ec2:AttachVolume', 'ec2:DetachVolume', 'ec2:CreateTags', 'iam:PassRole', 'secretsmanager:GetSecretValue', 'states:RedriveExecution']) {
        assert.ok(!allowed.includes(forbidden), forbidden);
    }
    for (const required of ['states:GetExecutionHistory', 'states:StartExecution', 'ec2:StopInstances', 'ec2:TerminateInstances']) {
        assert.ok(allowed.includes(required), required);
    }
    for (const [, rule] of Object.entries(t.findResources('AWS::Events::Rule')).filter(([name]) => name.startsWith('Recovery')) as [string, any][]) {
        assert.equal(rule.Properties.State, 'DISABLED');
    }
    const graphs = Object.entries(t.findResources('AWS::StepFunctions::StateMachine')).filter(([name]) => name.startsWith('Recovery'));
    assert.equal(graphs.length, 1);
    const definition = JSON.stringify((graphs[0]![1] as any).Properties.DefinitionString);
    assert.ok(definition.includes('terminateInstances')); assert.ok(!definition.includes('runInstances')); assert.ok(!definition.includes('modifyInstanceAttribute'));
});

test('state machine definitions record errors instead of discarding them', () => {
    const { t } = synth(true);
    for (const machine of Object.values(t.findResources('AWS::StepFunctions::StateMachine')) as any[]) {
        const body = JSON.stringify(machine.Properties.DefinitionString);
        assert.ok(!/\\"ResultPath\\":null/.test(body), 'no ResultPath:null catches');
        assert.match(body, /ctl\.lastError/);
    }
});
