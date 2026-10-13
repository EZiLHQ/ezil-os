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
import { applyWorkloadIdentity, tagWorkload, workloadSynthesizer } from '../lib/workload-identity.js';
import { lifecycleFixture, REGION } from './lifecycle-fixture.js';
import { LifecycleDeploymentSchema } from '../lib/lifecycle/deployment.js';

const A = '123456789012', R = REGION;
const cfg = IdentityConfigSchema.parse({ namespace: 'pilot', accountId: A, region: R,
    githubOidcProviderArn: `arn:aws:iam::${A}:oidc-provider/token.actions.githubusercontent.com`,
    deploySubject: 'repo:example-org@1000/example-repo@2000:environment:aws-pilot', assetBucketName: `ezil-pilot-deploy-assets-${A}` });
const BOUNDARY = `arn:aws:iam::${A}:policy/ezil/identity/ezil-pilot-boundary`, EXEC = `arn:aws:iam::${A}:role/ezil/identity/ezil-pilot-cfn-exec`;
const json = (s: { toStatementJson(): unknown }[]) => s.map(x => x.toStatementJson());
const opsCfg = OpsConfigSchema.parse({ namespace: 'pilot', accountId: A, region: R, monthlyBudgetUsd: 100, egressBytesPer5Min: 3_000_000_000 });

const ROLES = `arn:aws:iam::${A}:role/ezil/pilot/*`, BUCKET = `arn:aws:s3:::ezil-pilot-deploy-assets-${A}`;
const BASIC = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';
test('I5 boundary is an allowlist plus explicit denies, exactly as reviewed', () => {
    const roleWrites = ['iam:CreateRole', 'iam:DeleteRole', 'iam:UpdateRole', 'iam:UpdateRoleDescription', 'iam:UpdateAssumeRolePolicy',
        'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePermissionsBoundary',
        'iam:TagRole', 'iam:UntagRole'];
    assert.deepEqual(json(boundaryStatements(cfg)), [
        { Sid: 'AllowWorkloadServices', Effect: 'Allow', Resource: '*', Action: ['states:*', 'lambda:*', 'logs:*', 'sqs:*', 'events:*',
            'cloudwatch:*', 'sns:Publish', 'sns:GetTopicAttributes', 'sns:ListTopics', 'sns:ListSubscriptionsByTopic',
            'secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret', 'ecr:CreateRepository', 'ecr:DescribeRepositories',
            'ecr:PutImageScanningConfiguration', 'ecr:PutImageTagMutability', 'ecr:TagResource', 'ecr:ListTagsForResource',
            'cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet',
            'cloudformation:DeleteChangeSet', 'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents',
            'cloudformation:GetTemplate', 'cloudformation:GetTemplateSummary', 'cloudformation:ListStackResources',
            'cloudformation:ValidateTemplate', 'iam:Get*', 'iam:List*'] },
        { Sid: 'AllowEc2Scoped', Effect: 'Allow', Resource: '*', Action: ['ec2:Describe*', 'ec2:CreateTags', 'ec2:CreateVpc', 'ec2:CreateSubnet',
            'ec2:CreateInternetGateway', 'ec2:CreateRouteTable', 'ec2:CreateSecurityGroup', 'ec2:CreateLaunchTemplate', 'ec2:ModifyVpcAttribute',
            'ec2:DeleteVpc', 'ec2:AttachInternetGateway', 'ec2:DetachInternetGateway', 'ec2:DeleteInternetGateway', 'ec2:CreateRoute',
            'ec2:ReplaceRoute', 'ec2:DeleteRoute', 'ec2:DeleteRouteTable', 'ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable',
            'ec2:ModifySubnetAttribute', 'ec2:DeleteSubnet', 'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress',
            'ec2:DeleteSecurityGroup', 'ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate', 'ec2:DeleteLaunchTemplate',
            'ec2:RunInstances', 'ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:AttachVolume', 'ec2:CreateVolume',
            'ec2:ModifyInstanceAttribute'] },
        { Sid: 'AllowKmsScoped', Effect: 'Allow', Resource: '*', Action: ['kms:CreateKey', 'kms:DescribeKey', 'kms:GetKeyPolicy',
            'kms:PutKeyPolicy', 'kms:EnableKeyRotation', 'kms:GetKeyRotationStatus', 'kms:TagResource', 'kms:ListResourceTags',
            'kms:ListAliases', 'kms:Encrypt', 'kms:Decrypt', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:CreateGrant'] },
        { Sid: 'AllowOwnBucket', Effect: 'Allow', Action: ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation'],
            Resource: [BUCKET, `${BUCKET}/*`] },
        { Sid: 'AllowRoleWritesUnderWorkloadPath', Effect: 'Allow', Action: roleWrites, Resource: ROLES },
        { Sid: 'AllowPassWorkloadAndExecRoles', Effect: 'Allow', Action: 'iam:PassRole', Resource: [ROLES, EXEC] },
        { Sid: 'RegionLock', Effect: 'Deny', NotAction: 'iam:*', Resource: '*', Condition: { StringNotEquals: { 'aws:RequestedRegion': R } } },
        { Sid: 'NoUsersGroupsKeysOrBoundaryRemoval', Effect: 'Deny', Resource: '*', Action: ['iam:*User*', 'iam:*Group*', 'iam:*MFADevice*',
            'iam:*LoginProfile*', 'iam:*AccessKey*', 'iam:*SSHPublicKey*', 'iam:*ServiceSpecificCredential*', 'iam:*SigningCertificate*',
            'iam:DeleteRolePermissionsBoundary'] },
        { Sid: 'RolesCarryThisBoundary', Effect: 'Deny', Resource: '*', Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary',
            'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:UpdateAssumeRolePolicy',
            'iam:UpdateRole', 'iam:DeleteRole'], Condition: { StringNotEquals: { 'iam:PermissionsBoundary': BOUNDARY } } },
        { Sid: 'OnlyLambdaBasicManagedPolicy', Effect: 'Deny', Resource: '*', Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
            Condition: { ArnNotEquals: { 'iam:PolicyARN': BASIC } } },
        { Sid: 'IamWritesOnlyUnderWorkloadPath', Effect: 'Deny', NotResource: ROLES, Action: [...roleWrites, 'iam:CreatePolicy',
            'iam:DeletePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:SetDefaultPolicyVersion', 'iam:TagPolicy',
            'iam:UntagPolicy', 'iam:CreateInstanceProfile', 'iam:AddRoleToInstanceProfile'] },
        { Sid: 'PassOnlyWorkloadAndExecRoles', Effect: 'Deny', Action: 'iam:PassRole', NotResource: [ROLES, EXEC] },
        { Sid: 'AssumeOnlyWorkloadRoles', Effect: 'Deny', Action: 'sts:AssumeRole', NotResource: ROLES },
        { Sid: 'NoIdentityProviderWrites', Effect: 'Deny', Resource: '*', Action: ['iam:CreateOpenIDConnectProvider',
            'iam:DeleteOpenIDConnectProvider', 'iam:UpdateOpenIDConnectProviderThumbprint', 'iam:AddClientIDToOpenIDConnectProvider',
            'iam:RemoveClientIDFromOpenIDConnectProvider', 'iam:TagOpenIDConnectProvider', 'iam:UntagOpenIDConnectProvider',
            'iam:CreateSAMLProvider', 'iam:UpdateSAMLProvider', 'iam:DeleteSAMLProvider', 'iam:TagSAMLProvider', 'iam:UntagSAMLProvider'] },
        { Sid: 'NoStorageDeletionOrDetach', Effect: 'Deny', Resource: '*',
            Action: ['ec2:DeleteVolume', 'ec2:DeleteSnapshot', 'ec2:DetachVolume', 'ec2:DeleteTags'] },
        { Sid: 'BackupTagOnlyAtCreation', Effect: 'Deny', Resource: '*', Action: 'ec2:CreateTags',
            Condition: { 'ForAnyValue:StringEquals': { 'aws:TagKeys': ['ezil:backup'] }, Null: { 'ec2:CreateAction': 'true' } } },
        { Sid: 'NoOrgAccountBillingWrites', Effect: 'Deny', Resource: '*', Action: ['organizations:*', 'account:Accept*', 'account:Close*',
            'account:Delete*', 'account:Disable*', 'account:Enable*', 'account:Put*', 'account:Start*', 'aws-portal:Modify*',
            'billing:Create*', 'billing:Delete*', 'billing:Put*', 'billing:Update*', 'payments:*', 'tax:Batch*', 'tax:Delete*', 'tax:Put*',
            'ce:Create*', 'ce:Delete*', 'ce:Update*'] },
        { Sid: 'NoEdgeOrBudgetWrites', Effect: 'Deny', Resource: '*', Action: ['route53:Associate*', 'route53:Change*', 'route53:Create*',
            'route53:Delete*', 'route53:Disassociate*', 'route53:Update*', 'route53domains:*', 'cloudfront:Associate*', 'cloudfront:Create*',
            'cloudfront:Delete*', 'cloudfront:Update*', 'budgets:Create*', 'budgets:Delete*', 'budgets:Execute*', 'budgets:Modify*',
            'budgets:Update*'] },
        { Sid: 'NoPurchasesOrReservations', Effect: 'Deny', Resource: '*', Action: ['ec2:Purchase*', 'ec2:AllocateHosts', 'ec2:ModifyHosts',
            'ec2:CreateCapacityReservation*', 'ec2:CreateReservedInstancesListing', 'ec2:AcceptReservedInstancesExchangeQuote',
            'ec2:RequestSpot*', 'ec2:CreateFleet', 'savingsplans:*', 'rds:PurchaseReserved*', 'elasticache:PurchaseReserved*',
            'redshift:PurchaseReserved*', 'es:PurchaseReserved*', 'dynamodb:PurchaseReserved*', 'aws-marketplace:Subscribe',
            'aws-marketplace:AcceptAgreement*'] },
    ]);
    assert.deepEqual([...GLOBAL_SERVICES], ['iam:*']);
});

test('item 1: namespaces are lowercase alphanumeric, never reserved, never identity', () => {
    for (const ns of ['identity', 'operators', 'ops', 'pilot-prod', 'Pilot', '1pilot', '', 'a'.repeat(22)])
        assert.equal(IdentityConfigSchema.safeParse({ ...cfg, namespace: ns }).success, false, ns);
    for (const ns of ['identity', 'pilot-prod']) assert.equal(OpsConfigSchema.safeParse({ ...opsCfg, namespace: ns }).success, false, ns);
    const f = lifecycleFixture();
    assert.equal(LifecycleDeploymentSchema.safeParse({ ...f.settings.deployment, namespace: 'identity' }).success, false);
    assert.equal(LifecycleDeploymentSchema.safeParse({ ...f.settings.deployment, namespace: 'pilot-prod' }).success, false);
    // State machines must be named ezil-<ns>-*, which the execution role is scoped to.
    assert.equal(LifecycleDeploymentSchema.safeParse({ ...f.settings.deployment,
        stateMachineVersionArn: `arn:aws:states:${R}:${A}:stateMachine:ezil-other-lifecycle:1` }).success, false);
    assert.equal(IdentityConfigSchema.safeParse({ ...cfg, namespace: 'pilot2' }).success, true);
    // A valid namespace can never collide with another's prefix: no '-' inside a namespace.
    assert.ok(!`ezil-pilot2-x`.startsWith(identityNames(cfg).stackPrefix));
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
    for (const bad of ['repo:<org>/*:environment:aws-pilot', 'repo:org@1/repo@2:environment:production', 'repo:org/repo:ref:refs/heads/main',
        'repo:org@1/repo@2:environment:aws-pilot:x', 'repo:o:rg@1/repo@2:environment:aws-pilot', 'repo:org@x/repo@2:environment:aws-pilot'])
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
    // Item 8/M3: TLS-only bucket policy.
    const bucketPolicy = Object.values(t.findResources('AWS::S3::BucketPolicy'))[0] as any;
    assert.ok(bucketPolicy.Properties.PolicyDocument.Statement.some((s: any) => s.Effect === 'Deny'
        && s.Condition?.Bool?.['aws:SecureTransport'] === 'false' && s.Principal?.AWS === '*'));
    t.hasResourceProperties('AWS::S3::Bucket', { PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true,
        IgnorePublicAcls: true, RestrictPublicBuckets: true }, VersioningConfiguration: { Status: 'Enabled' } });
    assert.doesNotMatch(JSON.stringify(t.toJSON()), /AdministratorAccess|PowerUserAccess/);
});

/** Every resource type the CI-deployed workload stacks create, and the
 * action the execution policy must grant for it. An unmapped type fails. The
 * ops stack is founder-deployed and deliberately absent. */
const CREATE_ACTION: Record<string, string> = {
    'AWS::EC2::VPC': 'ec2:CreateVpc', 'AWS::EC2::InternetGateway': 'ec2:CreateInternetGateway', 'AWS::EC2::VPCGatewayAttachment': 'ec2:AttachInternetGateway',
    'AWS::EC2::RouteTable': 'ec2:CreateRouteTable', 'AWS::EC2::Route': 'ec2:CreateRoute', 'AWS::EC2::Subnet': 'ec2:CreateSubnet',
    'AWS::EC2::SubnetRouteTableAssociation': 'ec2:AssociateRouteTable', 'AWS::EC2::SecurityGroup': 'ec2:CreateSecurityGroup',
    'AWS::EC2::LaunchTemplate': 'ec2:CreateLaunchTemplate', 'AWS::ECR::Repository': 'ecr:CreateRepository', 'AWS::KMS::Key': 'kms:CreateKey',
    'AWS::Logs::LogGroup': 'logs:CreateLogGroup', 'AWS::Lambda::Function': 'lambda:CreateFunction', 'AWS::Lambda::Version': 'lambda:PublishVersion',
    'AWS::Lambda::Permission': 'lambda:AddPermission', 'AWS::Lambda::EventInvokeConfig': 'lambda:PutFunctionEventInvokeConfig',
    'AWS::IAM::Role': 'iam:CreateRole', 'AWS::IAM::Policy': 'iam:PutRolePolicy',
    'AWS::StepFunctions::StateMachine': 'states:CreateStateMachine', 'AWS::StepFunctions::StateMachineVersion': 'states:PublishStateMachineVersion',
    'AWS::SQS::Queue': 'sqs:CreateQueue', 'AWS::SQS::QueuePolicy': 'sqs:SetQueueAttributes', 'AWS::Events::Rule': 'events:PutRule',
    'AWS::CloudWatch::Alarm': 'cloudwatch:PutMetricAlarm',
};
function stacks() {
    const f = lifecycleFixture(), app = new App();
    const foundationStack = new AppComputerFoundationStack(app, 'ezil-pilot-foundation', { env: { region: R }, synthesizer: new BootstraplessSynthesizer(),
        config: { stage: 'pilot', region: R, zoneIds: ['aps1-az1'], instanceType: 'm6i.large', rootVolumeGiB: 20 } });
    tagWorkload(foundationStack, 'pilot');
    const lifecycleStack = new Stack(app, 'ezil-pilot-lifecycle', { env: { account: A, region: R }, synthesizer: workloadSynthesizer({ assetBucketName: cfg.assetBucketName }) });
    const lifecycle = new ComputerLifecycle(lifecycleStack, 'Lifecycle', { settings: f.settings, authorityKeyArn: `arn:aws:kms:${R}:${A}:key/22222222-2222-4222-8222-222222222222` });
    new ComputerLifecycleRecovery(lifecycleStack, 'Recovery', { settings: { lifecycle: f.settings,
        recoveryVersionArn: `arn:aws:states:${R}:${A}:stateMachine:ezil-pilot-recovery:1` }, sourceHistoryKey: lifecycle.historyKey });
    applyWorkloadIdentity(lifecycleStack, A, 'pilot');
    const opsStack = new OpsStack(app, 'ezil-pilot-ops', { config: opsCfg, synthesizer: new BootstraplessSynthesizer(), env: { account: A, region: R } });
    const t = (s: Stack) => assertions.Template.fromStack(s).toJSON() as { Resources: Record<string, any> };
    return { foundation: t(foundationStack), lifecycle: t(lifecycleStack), ops: t(opsStack) };
}
const actionsOf = (statements: any[]) => statements.flatMap(s => ([] as string[]).concat(s.Action));
/** Fn::Join with AWS::Partition resolves to the aws partition here. */
const resolveArn = (v: any): string => typeof v === 'string' ? v : v['Fn::Join'][1].map((p: any) => p.Ref === 'AWS::Partition' ? 'aws' : p).join('');
test('I5 execution policy covers every resource type and managed-policy attachment the CI stacks create; no admin, no ops', () => {
    const exec = json(execStatements(cfg)) as any[], granted = new Set(actionsOf(exec)), s = stacks();
    for (const t of [s.foundation, s.lifecycle]) for (const r of Object.values(t.Resources)) {
        assert.ok(CREATE_ACTION[r.Type], `unmapped resource type ${r.Type}: extend the execution policy and this map deliberately`);
        assert.ok(granted.has(CREATE_ACTION[r.Type]!), `${r.Type} needs ${CREATE_ACTION[r.Type]}`);
    }
    // Item 4: CDK attaches AWSLambdaBasicExecutionRole to Lambda roles; the
    // exec role must be able to attach and detach exactly that, and list it.
    const managed = new Set(Object.values(s.lifecycle.Resources).filter(r => r.Type === 'AWS::IAM::Role')
        .flatMap(r => (r.Properties.ManagedPolicyArns ?? []).map(resolveArn)));
    assert.deepEqual([...managed], [BASIC]);
    const attach = exec.find(x => actionsOf([x]).includes('iam:AttachRolePolicy'));
    assert.deepEqual(attach, { Effect: 'Allow', Action: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], Resource: ROLES,
        Condition: { StringEquals: { 'iam:PermissionsBoundary': BOUNDARY }, ArnEquals: { 'iam:PolicyARN': BASIC } } });
    assert.ok(granted.has('iam:ListAttachedRolePolicies'));
    for (const action of granted) assert.ok(!/^\*$|:\*$/.test(action), `wildcard service grant ${action}`);
    for (const forbidden of ['dlm:', 'budgets:', 'sns:', 'iam:CreatePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicy', 'ec2:DeleteVolume', 'ec2:CreateVolume'])
        assert.ok(![...granted].some(g => g.startsWith(forbidden)), `exec must not hold ${forbidden}`);
});
test('I5 execution policy: role writes need the boundary, EC2/KMS writes need the namespace tag, names need the namespace prefix', () => {
    const exec = json(execStatements(cfg)) as any[], find = (a: string) => exec.find(x => actionsOf([x]).includes(a));
    assert.deepEqual(find('iam:CreateRole'), { Effect: 'Allow', Action: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy',
        'iam:DeleteRolePolicy', 'iam:UpdateAssumeRolePolicy', 'iam:UpdateRole', 'iam:DeleteRole'], Resource: ROLES,
        Condition: { StringEquals: { 'iam:PermissionsBoundary': BOUNDARY } } });
    const tag = (k: string) => ({ [`aws:${k}Tag/ezil:namespace`]: 'pilot' });
    assert.deepEqual(find('ec2:CreateVpc').Condition, { StringEquals: { 'aws:RequestedRegion': R, ...tag('Request') } });
    assert.deepEqual(find('ec2:DeleteVpc').Condition, { StringEquals: { 'aws:RequestedRegion': R, ...tag('Resource') } });
    assert.deepEqual(find('ec2:CreateTags').Condition, { StringEquals: { 'aws:RequestedRegion': R, ...tag('Request'),
        'ec2:CreateAction': ['CreateVpc', 'CreateSubnet', 'CreateInternetGateway', 'CreateRouteTable', 'CreateSecurityGroup', 'CreateLaunchTemplate'] } });
    assert.deepEqual(find('kms:CreateKey').Condition, { StringEquals: { 'aws:RequestedRegion': R, ...tag('Request') } });
    assert.deepEqual(find('kms:PutKeyPolicy').Condition, { StringEquals: { 'aws:RequestedRegion': R, ...tag('Resource') } });
    assert.equal(find('states:UpdateStateMachine').Resource, `arn:aws:states:${R}:${A}:stateMachine:ezil-pilot-*`);
    assert.equal(find('logs:DeleteLogGroup').Resource, `arn:aws:logs:${R}:${A}:log-group:ezil-pilot-*`);
    assert.equal(find('lambda:CreateFunction').Resource, `arn:aws:lambda:${R}:${A}:function:ezil-pilot-*`);
});
test('workload stacks: no CDK bootstrap; every role under /ezil/pilot/ with the boundary; every taggable resource carries the namespace tag', () => {
    const s = stacks();
    for (const t of [s.foundation, s.lifecycle, s.ops]) assert.equal(JSON.stringify(t).includes('BootstrapVersion'), false);
    for (const [id, r] of Object.entries(s.lifecycle.Resources)) if (r.Type === 'AWS::IAM::Role') {
        assert.equal(r.Properties.Path, '/ezil/pilot/', id); assert.equal(r.Properties.PermissionsBoundary, BOUNDARY, id);
    }
    const ns = (tags: any[] | undefined) => (tags ?? []).some((t: any) => t.Key === 'ezil:namespace' && t.Value === 'pilot');
    // Launch templates take their own tags through TagSpecifications.
    const tagged = (r: any) => ns(r.Properties.Tags) || (r.Properties.TagSpecifications ?? []).some((ts: any) => ns(ts.Tags));
    for (const type of ['AWS::EC2::VPC', 'AWS::EC2::Subnet', 'AWS::EC2::InternetGateway', 'AWS::EC2::RouteTable', 'AWS::EC2::SecurityGroup',
        'AWS::EC2::LaunchTemplate']) for (const [id, r] of Object.entries(s.foundation.Resources).filter(([, r]) => r.Type === type))
        assert.ok(tagged(r), `${id} (${type}) lacks the namespace tag the exec role requires`);
    for (const [id, r] of Object.entries(s.lifecycle.Resources).filter(([, r]) => r.Type === 'AWS::KMS::Key')) assert.ok(tagged(r), id);
});
test('identity and execution policy match the reviewed snapshot', () => {
    const t = assertions.Template.fromStack(identityStack()).toJSON() as { Resources: Record<string, any> };
    const actual = Object.fromEntries(Object.entries(t.Resources).filter(([, r]) => r.Type.startsWith('AWS::IAM::')).map(([k, r]) => [k, r]));
    const file = join(__dirname, '__snapshots__', 'identity.json');
    if (process.env.UPDATE_IAM_SNAPSHOT === '1') writeFileSync(file, JSON.stringify(actual, null, 2) + '\n');
    assert.ok(existsSync(file)); assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
});

test('I6 kill switch: exact statements and an operator path no bounded principal can write', () => {
    assert.deepEqual(json(killSwitchStatements()), [
        { Sid: 'KillSwitchNoCompute', Effect: 'Deny', Resource: '*', Action: ['ec2:RunInstances', 'ec2:StartInstances', 'ec2:AttachVolume',
            'ec2:CreateVolume', 'ec2:CreateFleet', 'ec2:RequestSpot*'] },
        { Sid: 'KillSwitchNoWorkflows', Effect: 'Deny', Resource: '*', Action: ['states:StartExecution', 'states:StartSyncExecution', 'states:RedriveExecution'] },
    ]);
    const policy = Object.values(stacks().ops.Resources).find(r => r.Type === 'AWS::IAM::ManagedPolicy')!.Properties;
    assert.equal(policy.Path, '/ezil/operators/'); assert.equal(policy.ManagedPolicyName, 'ezil-pilot-kill-switch');
    assert.equal(policy.Roles, undefined, 'never attached by code');
    assert.ok(!policy.Path.startsWith(identityNames(cfg).workloadPath));
});
test('I6 ops: DLM volumes only, 12-hourly retain 14; budget 50/80/100; egress alarm; exact topic publishers; env guard', () => {
    const ops = stacks().ops, of = (type: string) => Object.values(ops.Resources).filter(r => r.Type === type).map(r => r.Properties);
    const [policy] = of('AWS::DLM::LifecyclePolicy');
    assert.equal(policy.ExecutionRoleArn, `arn:aws:iam::${A}:role/service-role/AWSDataLifecycleManagerDefaultRole`);
    assert.equal(policy.PolicyDetails.PolicyType, 'EBS_SNAPSHOT_MANAGEMENT');
    assert.deepEqual(policy.PolicyDetails.ResourceTypes, ['VOLUME']);
    assert.deepEqual(policy.PolicyDetails.TargetTags, [{ Key: 'ezil:backup', Value: 'pilot' }]);
    assert.equal(policy.PolicyDetails.Schedules.length, 1);
    assert.deepEqual(policy.PolicyDetails.Schedules[0].CreateRule, { Interval: 12, IntervalUnit: 'HOURS' });
    assert.deepEqual(policy.PolicyDetails.Schedules[0].RetainRule, { Count: 14 });
    assert.equal(policy.PolicyDetails.Schedules[0].CrossRegionCopyRules, undefined); assert.equal(policy.PolicyDetails.Schedules[0].ShareRules, undefined);
    const [budget] = of('AWS::Budgets::Budget');
    assert.deepEqual(budget.NotificationsWithSubscribers.map((n: any) => n.Notification.Threshold), [50, 80, 100]);
    assert.ok(budget.NotificationsWithSubscribers.every((n: any) => n.Notification.NotificationType === 'ACTUAL'));
    assert.deepEqual(budget.Budget.BudgetLimit, { Amount: 100, Unit: 'USD' });
    const [alarm] = of('AWS::CloudWatch::Alarm');
    assert.equal(alarm.Threshold, 3_000_000_000); assert.match(alarm.Metrics[0].Expression, /MAX\(NetworkOut\)/);
    const [topicPolicy] = of('AWS::SNS::TopicPolicy');
    const publishers = topicPolicy.PolicyDocument.Statement.map((s: any) => ({ service: s.Principal.Service, condition: s.Condition }));
    assert.deepEqual(publishers, [
        { service: 'cloudwatch.amazonaws.com', condition: { StringEquals: { 'aws:SourceAccount': A }, ArnLike: { 'aws:SourceArn': `arn:aws:cloudwatch:${R}:${A}:alarm:ezil-pilot-*` } } },
        { service: 'budgets.amazonaws.com', condition: { StringEquals: { 'aws:SourceAccount': A }, ArnLike: { 'aws:SourceArn': `arn:aws:budgets::${A}:budget/ezil-pilot-monthly` } } },
    ]);
    assert.equal(of('AWS::IAM::Role').length, 0, 'ops creates no role');
    assert.throws(() => new OpsStack(new App(), 'X', { config: opsCfg, env: { account: '210987654321', region: R } }), /env must equal/);
    assert.throws(() => new OpsStack(new App(), 'Y', { config: opsCfg, env: { account: A, region: 'eu-west-2' } }), /env must equal/);
    assert.throws(() => identityStackWith({ account: A, region: 'eu-west-2' }), /env must equal/);
});
function identityStackWith(env: { account: string; region: string }) {
    return new DeployIdentityStack(new App(), 'Z', { config: cfg, synthesizer: new BootstraplessSynthesizer(), env });
}
