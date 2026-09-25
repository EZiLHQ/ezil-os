import assert from 'node:assert/strict';
import test from 'node:test';
import { App, Stack, assertions, aws_kms as kms } from 'aws-cdk-lib';
import { ComputerCancellation } from '../lib/computer-cancellation.js';
import { cancellationFixture } from './cancellation-fixture.js';

test('cancellation synthesis confines mutation to Standard and grants only the dedicated authority secret', () => {
    const f = cancellationFixture(), app = new App(), stack = new Stack(app, 'CancellationTest', { env: { account: '123456789012', region: 'us-east-1' } });
    const sourceKey = kms.Key.fromKeyArn(stack, 'SourceKey', f.settings.lifecycle.deployment.dataKeyArn);
    const authorityKey = kms.Key.fromKeyArn(stack, 'AuthorityKey', 'arn:aws:kms:us-east-1:123456789012:key/22222222-2222-4222-8222-222222222222');
    new ComputerCancellation(stack, 'Cancellation', { settings: f.settings, sourceHistoryKey: sourceKey, authorityKey });
    const t = assertions.Template.fromStack(stack);
    t.resourceCountIs('AWS::EC2::Instance', 0); t.resourceCountIs('AWS::EC2::Volume', 0); t.resourceCountIs('AWS::Events::Rule', 0);
    t.hasResourceProperties('AWS::StepFunctions::StateMachine', { StateMachineType: 'STANDARD', EncryptionConfiguration: { Type: 'CUSTOMER_MANAGED_KMS_KEY' },
        LoggingConfiguration: { IncludeExecutionData: false, Level: 'ERROR' } });
    t.resourceCountIs('AWS::StepFunctions::StateMachineVersion', 1); t.resourceCountIs('AWS::CloudWatch::Alarm', 2);
    const policies = Object.entries(t.findResources('AWS::IAM::Policy')) as [string, any][];
    const observer = policies.filter(([name]) => name.includes('Observer')).flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
    const workflow = policies.filter(([name]) => name.includes('WorkflowRole')).flatMap(([, p]) => p.Properties.PolicyDocument.Statement);
    const actions = (statements: any[]) => statements.flatMap(s => ([] as string[]).concat(s.Action));
    assert.ok(actions(observer).includes('secretsmanager:GetSecretValue'));
    assert.equal(observer.find(s => actions([s]).includes('secretsmanager:GetSecretValue')).Resource, f.settings.cancellationSecretArn);
    for (const forbidden of ['ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:ModifyInstanceAttribute', 'states:StopExecution']) assert.ok(!actions(observer).includes(forbidden));
    assert.ok(actions(workflow).includes('states:StopExecution')); assert.ok(!actions(workflow).includes('secretsmanager:GetSecretValue'));
    assert.equal(workflow.find(s => actions([s]).includes('states:StopExecution')).Resource, 'arn:aws:states:us-east-1:123456789012:execution:ezil-lifecycle:computer-*');
    for (const forbidden of ['ec2:RunInstances', 'ec2:StartInstances', 'ec2:DeleteVolume', 'ec2:DetachVolume', 'ec2:AttachVolume', 'states:StartExecution', 'states:RedriveExecution', 'iam:PassRole'])
        assert.ok(!actions([...observer, ...workflow]).includes(forbidden));
    const ec2 = workflow.find(s => actions([s]).includes('ec2:TerminateInstances'));
    assert.equal(ec2.Condition.StringEquals['ec2:ResourceTag/ezil:stage'], 'pilot');
    assert.equal(ec2.Condition.StringEquals['ec2:ResourceTag/ezil:managed-by'], 'app-computer-platform');
    const version = Object.values(t.findResources('AWS::StepFunctions::StateMachineVersion'))[0] as any; assert.equal(version.DeletionPolicy, 'Retain');
});
