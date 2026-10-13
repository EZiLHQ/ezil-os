import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { App, BootstraplessSynthesizer, Stack, assertions } from 'aws-cdk-lib';
import { DeployIdentityStack, GLOBAL_SERVICES, IdentityConfigSchema, boundaryStatements, deployStatements, deployTrust,
    execStatements, identityNames } from '../lib/identity.js';
import { OpsConfigSchema, OpsStack, killSwitchStatements } from '../lib/ops.js';
import { AppComputerFoundationStack } from '../lib/foundation.js';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { ComputerLifecycleRecovery } from '../lib/lifecycle-recovery.js';
import { applyWorkloadIdentity, workloadSynthesizer } from '../lib/workload-identity.js';
import { lifecycleFixture, REGION } from './lifecycle-fixture.js';

const A = '123456789012', R = REGION;
const cfg = IdentityConfigSchema.parse({ namespace: 'pilot', accountId: A, region: R,
    githubOidcProviderArn: `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`,
    deploySubject: 'repo:<org>@1000/<repo>@2000:environment:aws-pilot', assetBucketName: `ezil-pilot-deploy-assets-${A}` });
const BOUNDARY = `arn:aws:iam::${A}:policy/ezil/identity/ezil-pilot-boundary`, EXEC = `arn:aws:iam::${A}:role/ezil/identity/ezil-pilot-cfn-exec`;
const json = (s: { toStatementJson(): unknown }[]) => s.map(x => x.toStatementJson());

test('I5 boundary equals the reviewed specification exactly', () => {
    assert.deepEqual(json(boundaryStatements(cfg)), [
        { Sid: 'WithinBoundary', Effect: 'Allow', Action: '*', Resource: '*' },
        { Sid: 'RegionLock', Effect: 'Deny', NotAction: ['iam:*', 'sts:*', 'budgets:*', 'cloudfront:*', 'route53:*', 'support:*', 'health:*'],
            Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': R } } },
        { Sid: 'NoUsersOrKeysOrBoundaryRemoval', Effect: 'Deny', Resource: '*', Action: ['iam:CreateUser', 'iam:CreateAccessKey',
            'iam:CreateLoginProfile', 'iam:DeleteRolePermissionsBoundary', 'iam:DeleteUserPermissionsBoundary'] },
        { Sid: 'RolesCarryThisBoundary', Effect: 'Deny', Resource: '*', Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
            Condition: { StringNotEquals: { 'iam:PermissionsBoundary': BOUNDARY } } },
        { Sid: 'IamOnlyUnderWorkloadPath', Effect: 'Deny', Action: ['iam:CreateRole', 'iam:DeleteRole', 'iam:UpdateRole',
            'iam:UpdateRoleDescription', 'iam:UpdateAssumeRolePolicy', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy',
            'iam:DetachRolePolicy', 'iam:PutRolePermissionsBoundary', 'iam:TagRole', 'iam:UntagRole', 'iam:CreatePolicy', 'iam:DeletePolicy',
            'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:TagPolicy', 'iam:UntagPolicy',
            'iam:CreateInstanceProfile', 'iam:AddRoleToInstanceProfile'],
            NotResource: [`arn:aws:iam::${A}:role/ezil/pilot/*`, `arn:aws:iam::${A}:policy/ezil/pilot/*`] },
        { Sid: 'NoStorageDeletionOrDetach', Effect: 'Deny', Resource: '*',
            Action: ['ec2:DeleteVolume', 'ec2:DeleteSnapshot', 'ec2:DetachVolume', 'ec2:DeleteTags'] },
        { Sid: 'NoAccountOrgBillingWrites', Effect: 'Deny', Resource: '*', Action: ['organizations:Accept*', 'organizations:Attach*',
            'organizations:Create*', 'organizations:Decline*', 'organizations:Delete*', 'organizations:Deregister*', 'organizations:Detach*',
            'organizations:Disable*', 'organizations:Enable*', 'organizations:Invite*', 'organizations:Leave*', 'organizations:Move*',
            'organizations:Register*', 'organizations:Remove*', 'organizations:Tag*', 'organizations:Untag*', 'organizations:Update*',
            'account:Accept*', 'account:Close*', 'account:Delete*', 'account:Disable*', 'account:Enable*', 'account:Put*', 'account:Start*',
            'aws-portal:Modify*', 'billing:Create*', 'billing:Delete*', 'billing:Put*', 'billing:Update*', 'payments:*', 'tax:Batch*',
            'tax:Delete*', 'tax:Put*', 'ce:Create*', 'ce:Delete*', 'ce:Update*'] },
    ]);
    // The identity objects themselves sit outside the writable workload path.
    assert.ok(!identityNames(cfg).boundaryArn.includes('/ezil/pilot/') && !identityNames(cfg).execRoleArn.includes('/ezil/pilot/'));
    assert.ok(!GLOBAL_SERVICES.some(g => g.startsWith('ec2') || g.startsWith('s3')));
});

test('I5 deploy role: exact GitHub OIDC trust and change-set-only rights through the execution role', () => {
    assert.deepEqual(deployTrust(cfg).toStatementJson(), { Effect: 'Allow', Action: 'sts:AssumeRoleWithWebIdentity',
        Principal: { Federated: cfg.githubOidcProviderArn }, Condition: { StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': cfg.deploySubject } } });
    const stacks = `arn:aws:cloudformation:${R}:${A}:stack/ezil-pilot-*/*`, bucket = `arn:aws:s3:::${cfg.assetBucketName}`;
    assert.deepEqual(json(deployStatements(cfg)), [
        { Effect: 'Allow', Action: 'cloudformation:CreateChangeSet', Resource: stacks, Condition: { ArnEquals: { 'cloudformation:RoleArn': EXEC } } },
        { Effect: 'Allow', Action: ['cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet',
            'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:GetTemplate', 'cloudformation:GetTemplateSummary',
            'cloudformation:ListStackResources'], Resource: stacks },
        { Effect: 'Allow', Action: 'cloudformation:ValidateTemplate', Resource: '*' },
        { Effect: 'Allow', Action: 'iam:PassRole', Resource: EXEC, Condition: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } } },
        { Effect: 'Allow', Action: ['s3:PutObject', 's3:GetObject'], Resource: [`${bucket}/assets/*`, `${bucket}/templates/*`] },
        { Effect: 'Allow', Action: ['s3:ListBucket', 's3:GetBucketLocation'], Resource: bucket },
    ]);
    for (const bad of ['repo:<org>/*:environment:aws-pilot', 'repo:<org>@1/<repo>@2:environment:production', 'repo:org/repo:ref:refs/heads/main'])
        assert.equal(IdentityConfigSchema.safeParse({ ...cfg, deploySubject: bad }).success, false, bad);
    assert.equal(IdentityConfigSchema.safeParse({ ...cfg, githubOidcProviderArn: `arn:aws:iam::${A}:oidc-provider/evil.example` }).success, false);
});

function identityStack() {
    const app = new App();
    return new DeployIdentityStack(app, 'ezil-identity-pilot', { config: cfg, synthesizer: new BootstraplessSynthesizer(), env: { account: A, region: R } });
}
test('I5 identity stack: both roles carry the boundary, live under /ezil/identity/, short sessions; nothing else is trusted', () => {
    const t = assertions.Template.fromStack(identityStack()), roles = Object.values(t.findResources('AWS::IAM::Role')) as any[];
    assert.equal(roles.length, 2);
    for (const r of roles) {
        assert.equal(r.Properties.Path, '/ezil/identity/');
        assert.ok(JSON.stringify(r.Properties.PermissionsBoundary).includes('Boundary'));
        assert.equal(r.Properties.ManagedPolicyArns, undefined, 'no AdministratorAccess or other managed policy');
    }
    const exec = roles.find(r => r.Properties.RoleName === 'ezil-pilot-cfn-exec'), deploy = roles.find(r => r.Properties.RoleName === 'ezil-pilot-deploy');
    assert.deepEqual(exec.Properties.AssumeRolePolicyDocument.Statement, [{ Effect: 'Allow', Action: 'sts:AssumeRole',
        Principal: { Service: 'cloudformation.amazonaws.com' }, Condition: { StringEquals: { 'aws:SourceAccount': A } } }]);
    assert.deepEqual(deploy.Properties.AssumeRolePolicyDocument.Statement, [deployTrust(cfg).toStatementJson()]);
    assert.equal(deploy.Properties.MaxSessionDuration, 3600);
    t.hasResourceProperties('AWS::IAM::ManagedPolicy', { ManagedPolicyName: 'ezil-pilot-boundary', Path: '/ezil/identity/' });
    t.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true,
        IgnorePublicAcls: true, RestrictPublicBuckets: true }, VersioningConfiguration: { Status: 'Enabled' } });
    assert.doesNotMatch(JSON.stringify(t.toJSON()), /AdministratorAccess|PowerUserAccess/);
});

/** Every resource type the workload stacks create, and the create action the
 * execution policy must grant for it. An unmapped type fails this test. */
const CREATE_ACTION: Record<string, string> = {
    'AWS::EC2::VPC': 'ec2:CreateVpc', 'AWS::EC2::InternetGateway': 'ec2:CreateInternetGateway', 'AWS::EC2::VPCGatewayAttachment': 'ec2:AttachInternetGateway',
    'AWS::EC2::RouteTable': 'ec2:CreateRouteTable', 'AWS::EC2::Route': 'ec2:CreateRoute', 'AWS::EC2::Subnet': 'ec2:CreateSubnet',
    'AWS::EC2::SubnetRouteTableAssociation': 'ec2:AssociateRouteTable', 'AWS::EC2::SecurityGroup': 'ec2:CreateSecurityGroup',
    'AWS::EC2::LaunchTemplate': 'ec2:CreateLaunchTemplate', 'AWS::ECR::Repository': 'ecr:CreateRepository', 'AWS::KMS::Key': 'kms:CreateKey',
    'AWS::Logs::LogGroup': 'logs:CreateLogGroup', 'AWS::Lambda::Function': 'lambda:CreateFunction', 'AWS::Lambda::Version': 'lambda:PublishVersion',
    'AWS::Lambda::Permission': 'lambda:AddPermission', 'AWS::Lambda::EventInvokeConfig': 'lambda:PutFunctionEventInvokeConfig',
    'AWS::IAM::Role': 'iam:CreateRole', 'AWS::IAM::Policy': 'iam:PutRolePolicy', 'AWS::IAM::ManagedPolicy': 'iam:CreatePolicy',
    'AWS::StepFunctions::StateMachine': 'states:CreateStateMachine', 'AWS::StepFunctions::StateMachineVersion': 'states:PublishStateMachineVersion',
    'AWS::SQS::Queue': 'sqs:CreateQueue', 'AWS::SQS::QueuePolicy': 'sqs:SetQueueAttributes', 'AWS::Events::Rule': 'events:PutRule',
    'AWS::CloudWatch::Alarm': 'cloudwatch:PutMetricAlarm', 'AWS::SNS::Topic': 'sns:CreateTopic', 'AWS::SNS::TopicPolicy': 'sns:SetTopicAttributes',
    'AWS::DLM::LifecyclePolicy': 'dlm:CreateLifecyclePolicy', 'AWS::Budgets::Budget': 'budgets:ModifyBudget',
};
const opsCfg = OpsConfigSchema.parse({ namespace: 'pilot', accountId: A, region: R, monthlyBudgetUsd: 100, egressBytesPer5Min: 3_000_000_000 });
function workloadStacks() {
    const f = lifecycleFixture(), app = new App();
    const foundation = new AppComputerFoundationStack(app, 'ezil-pilot-foundation', { env: { region: R }, synthesizer: new BootstraplessSynthesizer(),
        config: { stage: 'pilot', region: R, zoneIds: ['aps1-az1'], instanceType: 'm6i.large', rootVolumeGiB: 20 } });
    const lifecycleStack = new Stack(app, 'ezil-pilot-lifecycle', { env: { account: A, region: R }, synthesizer: workloadSynthesizer({ assetBucketName: cfg.assetBucketName }) });
    const lifecycle = new ComputerLifecycle(lifecycleStack, 'Lifecycle', { settings: f.settings, authorityKeyArn: `arn:aws:kms:${R}:${A}:key/22222222-2222-4222-8222-222222222222` });
    new ComputerLifecycleRecovery(lifecycleStack, 'Recovery', { settings: { lifecycle: f.settings,
        recoveryVersionArn: `arn:aws:states:${R}:${A}:stateMachine:ezil-lifecycle-recovery:1` }, sourceHistoryKey: lifecycle.historyKey });
    applyWorkloadIdentity(lifecycleStack, A, 'pilot');
    const ops = new OpsStack(app, 'ezil-pilot-ops', { config: opsCfg, synthesizer: new BootstraplessSynthesizer(), env: { account: A, region: R } });
    return [foundation, lifecycleStack, ops].map(s => assertions.Template.fromStack(s).toJSON() as { Resources: Record<string, any>; Parameters?: object; Rules?: object });
}
test('I5 execution policy covers exactly the resource types the workload stacks create, and no admin', () => {
    const granted = new Set(json(execStatements(cfg)).flatMap((s: any) => ([] as string[]).concat(s.Action)));
    const types = new Set(workloadStacks().flatMap(t => Object.values(t.Resources).map(r => r.Type as string)));
    for (const type of types) {
        assert.ok(CREATE_ACTION[type], `unmapped resource type ${type}: extend the execution policy and this map deliberately`);
        assert.ok(granted.has(CREATE_ACTION[type]!), `${type} needs ${CREATE_ACTION[type]}`);
    }
    for (const action of granted) assert.ok(!/^\*$|:\*$/.test(action), `wildcard service grant ${action}`);
    const iamCreate = json(execStatements(cfg)).find((s: any) => ([] as string[]).concat(s.Action).includes('iam:CreateRole')) as any;
    assert.deepEqual(iamCreate, { Effect: 'Allow', Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
        Resource: `arn:aws:iam::${A}:role/ezil/pilot/*`, Condition: { StringEquals: { 'iam:PermissionsBoundary': BOUNDARY } } });
});
test('workload stacks: no CDK bootstrap dependency; every role under /ezil/pilot/ with the boundary', () => {
    for (const t of workloadStacks()) {
        assert.equal(JSON.stringify(t).includes('BootstrapVersion'), false, 'no bootstrap version parameter or rule');
        for (const [id, r] of Object.entries(t.Resources)) if (r.Type === 'AWS::IAM::Role') {
            assert.equal(r.Properties.Path, '/ezil/pilot/', id);
            assert.equal(r.Properties.PermissionsBoundary, BOUNDARY, id);
        }
    }
});
test('identity and execution policy match the reviewed snapshot', () => {
    const t = assertions.Template.fromStack(identityStack()).toJSON() as { Resources: Record<string, any> };
    const actual = Object.fromEntries(Object.entries(t.Resources).filter(([, r]) => r.Type.startsWith('AWS::IAM::')).map(([k, r]) => [k, r]));
    const file = join(__dirname, '__snapshots__', 'identity.json');
    if (process.env.UPDATE_IAM_SNAPSHOT === '1') writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    assert.ok(existsSync(file)); assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
});

test('I6 kill switch denies starts, launches, attaches and workflow starts; it never touches stop or storage', () => {
    assert.deepEqual(json(killSwitchStatements()), [
        { Sid: 'KillSwitchNoCompute', Effect: 'Deny', Resource: '*', Action: ['ec2:RunInstances', 'ec2:StartInstances', 'ec2:AttachVolume'] },
        { Sid: 'KillSwitchNoWorkflows', Effect: 'Deny', Resource: '*', Action: 'states:StartExecution' },
    ]);
});
test('I6 ops: DLM 12-hourly retain 14 on the namespace backup tag, budget 50/80/100 alerts, egress alarm, guarded topic', () => {
    const ops = workloadStacks()[2]!, of = (type: string) => Object.values(ops.Resources).filter(r => r.Type === type).map(r => r.Properties);
    const [policy] = of('AWS::DLM::LifecyclePolicy');
    assert.equal(policy.ExecutionRoleArn, `arn:aws:iam::${A}:role/service-role/AWSDataLifecycleManagerDefaultRole`);
    assert.deepEqual(policy.PolicyDetails.TargetTags, [{ Key: 'ezil:backup', Value: 'pilot' }]);
    assert.deepEqual(policy.PolicyDetails.Schedules[0].CreateRule, { Interval: 12, IntervalUnit: 'HOURS' });
    assert.deepEqual(policy.PolicyDetails.Schedules[0].RetainRule, { Count: 14 });
    const [budget] = of('AWS::Budgets::Budget');
    assert.deepEqual(budget.NotificationsWithSubscribers.map((n: any) => n.Notification.Threshold), [50, 80, 100]);
    assert.ok(budget.NotificationsWithSubscribers.every((n: any) => n.Notification.NotificationType === 'ACTUAL'));
    assert.deepEqual(budget.Budget.BudgetLimit, { Amount: 100, Unit: 'USD' });
    const [alarm] = of('AWS::CloudWatch::Alarm');
    assert.equal(alarm.Threshold, 3_000_000_000); assert.match(alarm.Metrics[0].Expression, /MAX\(NetworkOut\)/);
    const [topicPolicy] = of('AWS::SNS::TopicPolicy');
    for (const s of topicPolicy.PolicyDocument.Statement) {
        assert.equal(s.Condition.StringEquals['aws:SourceAccount'], A); assert.ok(s.Condition.ArnLike['aws:SourceArn']);
    }
    assert.equal(of('AWS::IAM::Role').length, 0, 'ops creates no role');
    for (const type of Object.values(ops.Resources).map(r => r.Type)) assert.ok(!/Lambda|EC2::Instance|StepFunctions/.test(type), type);
});
