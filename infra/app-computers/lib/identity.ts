import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, aws_iam as iam, aws_s3 as s3 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { REGION_PATTERN } from './lifecycle/deployment.js';

/** I5 deploy identity. Created ONCE by the founder with their own admin
 * identity (README "Founder bootstrap"); never deployed by CI. No CDK
 * bootstrap: the stack holds its own asset bucket, a scoped CloudFormation
 * execution role and the GitHub OIDC deploy role, all under a boundary. */
export const IdentityConfigSchema = z.object({
    namespace: z.string().regex(/^[a-z][a-z0-9-]{0,20}$/),
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(REGION_PATTERN),
    /** The account's existing GitHub OIDC provider (reused, not created). */
    githubOidcProviderArn: z.string(),
    /** Immutable-ID subject, environment aws-pilot, e.g.
     * repo:<org>@<orgId>/<repo>@<repoId>:environment:aws-pilot */
    deploySubject: z.string().max(256).regex(/^repo:[^*?\s]+@\d+\/[^*?\s]+@\d+:environment:aws-pilot$/),
    assetBucketName: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
}).strict().superRefine((c, ctx) => {
    if (c.githubOidcProviderArn !== `arn:aws:iam::${c.accountId}:oidc-provider/token.actions.githubusercontent.com`)
        ctx.addIssue({ code: 'custom', path: ['githubOidcProviderArn'], message: 'must be this account\'s GitHub OIDC provider' });
});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;

/** Fixed names so workload stacks and the boundary can reference each other
 * as literals. Identity objects live under /ezil/identity/, which the boundary
 * puts out of reach of every bounded principal; workloads live under
 * /ezil/<namespace>/. */
export function identityNames(c: IdentityConfig) {
    const iamArn = (kind: string, path: string, name: string) => `arn:aws:iam::${c.accountId}:${kind}${path}${name}`;
    const identityPath = '/ezil/identity/', workloadPath = `/ezil/${c.namespace}/`;
    return {
        identityPath, workloadPath, stackPrefix: `ezil-${c.namespace}-`,
        boundaryName: `ezil-${c.namespace}-boundary`, boundaryArn: iamArn('policy', identityPath, `ezil-${c.namespace}-boundary`),
        execRoleName: `ezil-${c.namespace}-cfn-exec`, execRoleArn: iamArn('role', identityPath, `ezil-${c.namespace}-cfn-exec`),
        deployRoleName: `ezil-${c.namespace}-deploy`, deployRoleArn: iamArn('role', identityPath, `ezil-${c.namespace}-deploy`),
        workloadRoles: iamArn('role', workloadPath, '*'), workloadPolicies: iamArn('policy', workloadPath, '*'),
        dlmRoleArn: iamArn('role', '/service-role/', 'AWSDataLifecycleManagerDefaultRole'),
    };
}

/** Global services exempt from the region lock (their endpoints sit in one region). */
export const GLOBAL_SERVICES = ['iam:*', 'sts:*', 'budgets:*', 'cloudfront:*', 'route53:*', 'support:*', 'health:*'] as const;
const IAM_WRITES = ['iam:CreateRole', 'iam:DeleteRole', 'iam:UpdateRole', 'iam:UpdateRoleDescription', 'iam:UpdateAssumeRolePolicy',
    'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePermissionsBoundary',
    'iam:TagRole', 'iam:UntagRole', 'iam:CreatePolicy', 'iam:DeletePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion',
    'iam:SetDefaultPolicyVersion', 'iam:TagPolicy', 'iam:UntagPolicy', 'iam:CreateInstanceProfile', 'iam:AddRoleToInstanceProfile'] as const;
const ACCOUNT_WRITES = ['organizations:Accept*', 'organizations:Attach*', 'organizations:Create*', 'organizations:Decline*',
    'organizations:Delete*', 'organizations:Deregister*', 'organizations:Detach*', 'organizations:Disable*', 'organizations:Enable*',
    'organizations:Invite*', 'organizations:Leave*', 'organizations:Move*', 'organizations:Register*', 'organizations:Remove*',
    'organizations:Tag*', 'organizations:Untag*', 'organizations:Update*', 'account:Accept*', 'account:Close*', 'account:Delete*',
    'account:Disable*', 'account:Enable*', 'account:Put*', 'account:Start*', 'aws-portal:Modify*', 'billing:Create*', 'billing:Delete*',
    'billing:Put*', 'billing:Update*', 'payments:*', 'tax:Batch*', 'tax:Delete*', 'tax:Put*', 'ce:Create*', 'ce:Delete*', 'ce:Update*'] as const;

/** §5 permission boundary for every role a deploy creates, and for the deploy
 * and execution roles themselves. Exported for exact-equality tests. */
export function boundaryStatements(c: IdentityConfig): iam.PolicyStatement[] {
    const n = identityNames(c);
    return [
        new iam.PolicyStatement({ sid: 'WithinBoundary', actions: ['*'], resources: ['*'] }),
        new iam.PolicyStatement({ sid: 'RegionLock', effect: iam.Effect.DENY, notActions: [...GLOBAL_SERVICES], resources: ['*'],
            conditions: { StringNotEquals: { 'aws:RequestedRegion': c.region } } }),
        new iam.PolicyStatement({ sid: 'NoUsersOrKeysOrBoundaryRemoval', effect: iam.Effect.DENY, resources: ['*'], actions: ['iam:CreateUser',
            'iam:CreateAccessKey', 'iam:CreateLoginProfile', 'iam:DeleteRolePermissionsBoundary', 'iam:DeleteUserPermissionsBoundary'] }),
        new iam.PolicyStatement({ sid: 'RolesCarryThisBoundary', effect: iam.Effect.DENY, resources: ['*'],
            actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'],
            conditions: { StringNotEquals: { 'iam:PermissionsBoundary': n.boundaryArn } } }),
        new iam.PolicyStatement({ sid: 'IamOnlyUnderWorkloadPath', effect: iam.Effect.DENY, actions: [...IAM_WRITES],
            notResources: [n.workloadRoles, n.workloadPolicies] }),
        new iam.PolicyStatement({ sid: 'NoStorageDeletionOrDetach', effect: iam.Effect.DENY, resources: ['*'],
            actions: ['ec2:DeleteVolume', 'ec2:DeleteSnapshot', 'ec2:DetachVolume', 'ec2:DeleteTags'] }),
        new iam.PolicyStatement({ sid: 'NoAccountOrgBillingWrites', effect: iam.Effect.DENY, resources: ['*'], actions: [...ACCOUNT_WRITES] }),
    ];
}

/** Exactly what CloudFormation needs for the foundation, lifecycle, recovery,
 * app-caller and ops stacks — no AdministratorAccess. */
export function execStatements(c: IdentityConfig): iam.PolicyStatement[] {
    const n = identityNames(c), r = c.region, a = c.accountId, inRegion = { StringEquals: { 'aws:RequestedRegion': r } };
    const regional = (actions: string[], resources: string[] = ['*']) => new iam.PolicyStatement({ actions, resources, conditions: inRegion });
    return [
        regional(['ec2:Describe*', 'ec2:CreateVpc', 'ec2:DeleteVpc', 'ec2:ModifyVpcAttribute', 'ec2:CreateInternetGateway',
            'ec2:DeleteInternetGateway', 'ec2:AttachInternetGateway', 'ec2:DetachInternetGateway', 'ec2:CreateRouteTable',
            'ec2:DeleteRouteTable', 'ec2:CreateRoute', 'ec2:DeleteRoute', 'ec2:ReplaceRoute', 'ec2:CreateSubnet', 'ec2:DeleteSubnet',
            'ec2:ModifySubnetAttribute', 'ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable', 'ec2:CreateSecurityGroup',
            'ec2:DeleteSecurityGroup', 'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress', 'ec2:CreateLaunchTemplate',
            'ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate', 'ec2:DeleteLaunchTemplate', 'ec2:CreateTags']),
        regional(['ecr:CreateRepository', 'ecr:DescribeRepositories', 'ecr:PutImageScanningConfiguration', 'ecr:PutImageTagMutability',
            'ecr:TagResource', 'ecr:ListTagsForResource'], [`arn:aws:ecr:${r}:${a}:repository/*`]),
        regional(['kms:CreateKey', 'kms:ListAliases']),
        regional(['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy', 'kms:EnableKeyRotation', 'kms:GetKeyRotationStatus',
            'kms:TagResource', 'kms:ListResourceTags'], [`arn:aws:kms:${r}:${a}:key/*`]),
        regional(['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy',
            'logs:AssociateKmsKey', 'logs:TagResource', 'logs:ListTagsForResource', 'logs:DescribeLogGroups'], [`arn:aws:logs:${r}:${a}:log-group:*`]),
        regional(['lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration',
            'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration', 'lambda:PublishVersion', 'lambda:ListVersionsByFunction',
            'lambda:AddPermission', 'lambda:RemovePermission', 'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency',
            'lambda:PutFunctionEventInvokeConfig', 'lambda:UpdateFunctionEventInvokeConfig', 'lambda:GetFunctionEventInvokeConfig',
            'lambda:DeleteFunctionEventInvokeConfig', 'lambda:TagResource', 'lambda:ListTags'], [`arn:aws:lambda:${r}:${a}:function:${n.stackPrefix}*`]),
        // Step Functions execution logging is configured through log deliveries.
        regional(['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery',
            'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies']),
        regional(['states:CreateStateMachine', 'states:UpdateStateMachine', 'states:DeleteStateMachine', 'states:DescribeStateMachine',
            'states:PublishStateMachineVersion', 'states:ListStateMachineVersions', 'states:TagResource', 'states:ListTagsForResource'],
            [`arn:aws:states:${r}:${a}:stateMachine:*`]),
        regional(['sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:GetQueueAttributes', 'sqs:SetQueueAttributes', 'sqs:TagQueue',
            'sqs:ListQueueTags'], [`arn:aws:sqs:${r}:${a}:${n.stackPrefix}*`]),
        regional(['events:PutRule', 'events:DeleteRule', 'events:DescribeRule', 'events:EnableRule', 'events:DisableRule',
            'events:PutTargets', 'events:RemoveTargets', 'events:TagResource', 'events:ListTagsForResource'], [`arn:aws:events:${r}:${a}:rule/ezil-${c.namespace}-*`]),
        regional(['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms', 'cloudwatch:TagResource',
            'cloudwatch:ListTagsForResource'], [`arn:aws:cloudwatch:${r}:${a}:alarm:*`]),
        regional(['sns:CreateTopic', 'sns:DeleteTopic', 'sns:GetTopicAttributes', 'sns:SetTopicAttributes', 'sns:Subscribe',
            'sns:Unsubscribe', 'sns:TagResource', 'sns:ListTagsForResource'], [`arn:aws:sns:${r}:${a}:ezil-${c.namespace}-*`]),
        regional(['dlm:CreateLifecyclePolicy', 'dlm:UpdateLifecyclePolicy', 'dlm:DeleteLifecyclePolicy', 'dlm:GetLifecyclePolicy',
            'dlm:TagResource', 'dlm:ListTagsForResource'], [`arn:aws:dlm:${r}:${a}:policy/*`]),
        new iam.PolicyStatement({ actions: ['budgets:ModifyBudget', 'budgets:ViewBudget'], resources: [`arn:aws:budgets::${a}:budget/ezil-${c.namespace}-*`] }),
        // Lambda reads its code from the asset bucket with the caller's rights.
        new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`arn:aws:s3:::${c.assetBucketName}/assets/*`] }),
        // Workload roles: only under the workload path, and only carrying the boundary.
        new iam.PolicyStatement({ actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary'], resources: [n.workloadRoles],
            conditions: { StringEquals: { 'iam:PermissionsBoundary': n.boundaryArn } } }),
        new iam.PolicyStatement({ actions: ['iam:GetRole', 'iam:DeleteRole', 'iam:UpdateRole', 'iam:UpdateAssumeRolePolicy',
            'iam:PutRolePolicy', 'iam:GetRolePolicy', 'iam:DeleteRolePolicy', 'iam:TagRole', 'iam:UntagRole', 'iam:ListRoleTags'],
            resources: [n.workloadRoles] }),
        new iam.PolicyStatement({ actions: ['iam:CreatePolicy', 'iam:DeletePolicy', 'iam:GetPolicy', 'iam:GetPolicyVersion',
            'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion', 'iam:ListPolicyVersions', 'iam:TagPolicy'], resources: [n.workloadPolicies] }),
        new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [n.workloadRoles],
            conditions: { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'states.amazonaws.com'] } } }),
        new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [n.dlmRoleArn],
            conditions: { StringEquals: { 'iam:PassedToService': 'dlm.amazonaws.com' } } }),
    ];
}

/** The GitHub OIDC deploy role: change sets on this namespace's stacks, run
 * by the execution role only, plus the asset bucket. Nothing else. */
export function deployStatements(c: IdentityConfig): iam.PolicyStatement[] {
    const n = identityNames(c), stacks = `arn:aws:cloudformation:${c.region}:${c.accountId}:stack/${n.stackPrefix}*/*`;
    return [
        new iam.PolicyStatement({ actions: ['cloudformation:CreateChangeSet'], resources: [stacks],
            conditions: { ArnEquals: { 'cloudformation:RoleArn': n.execRoleArn } } }),
        new iam.PolicyStatement({ actions: ['cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet', 'cloudformation:DeleteChangeSet',
            'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:GetTemplate',
            'cloudformation:GetTemplateSummary', 'cloudformation:ListStackResources'], resources: [stacks] }),
        new iam.PolicyStatement({ actions: ['cloudformation:ValidateTemplate'], resources: ['*'] }),
        new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [n.execRoleArn],
            conditions: { StringEquals: { 'iam:PassedToService': 'cloudformation.amazonaws.com' } } }),
        new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:GetObject'],
            resources: [`arn:aws:s3:::${c.assetBucketName}/assets/*`, `arn:aws:s3:::${c.assetBucketName}/templates/*`] }),
        new iam.PolicyStatement({ actions: ['s3:ListBucket', 's3:GetBucketLocation'], resources: [`arn:aws:s3:::${c.assetBucketName}`] }),
    ];
}
export function deployTrust(c: IdentityConfig): iam.PolicyStatement {
    return new iam.PolicyStatement({ actions: ['sts:AssumeRoleWithWebIdentity'], principals: [new iam.FederatedPrincipal(c.githubOidcProviderArn)],
        conditions: { StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': c.deploySubject } } });
}

export class DeployIdentityStack extends Stack {
    constructor(scope: Construct, id: string, props: StackProps & { config: IdentityConfig }) {
        super(scope, id, props);
        const c = IdentityConfigSchema.parse(props.config), n = identityNames(c);
        if (props.env?.region !== c.region || props.env?.account !== c.accountId) throw new Error('stack env must equal the identity config');
        const boundary = new iam.ManagedPolicy(this, 'Boundary', { managedPolicyName: n.boundaryName, path: n.identityPath,
            description: 'EZiL permission boundary (AWS-COMPUTERS.md §5)', document: new iam.PolicyDocument({ statements: boundaryStatements(c) }) });
        const bucket = new s3.Bucket(this, 'AssetBucket', { bucketName: c.assetBucketName, encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, versioned: true, removalPolicy: RemovalPolicy.RETAIN,
            lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90) }] });
        const exec = new iam.Role(this, 'ExecRole', { roleName: n.execRoleName, path: n.identityPath, permissionsBoundary: boundary,
            assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': c.accountId } } }),
            inlinePolicies: { exec: new iam.PolicyDocument({ statements: execStatements(c) }) } });
        const deploy = new iam.Role(this, 'DeployRole', { roleName: n.deployRoleName, path: n.identityPath, permissionsBoundary: boundary,
            maxSessionDuration: Duration.hours(1), description: 'GitHub OIDC deploy (environment aws-pilot): change sets via the execution role',
            assumedBy: new iam.FederatedPrincipal(c.githubOidcProviderArn, deployTrust(c).conditions, 'sts:AssumeRoleWithWebIdentity'),
            inlinePolicies: { deploy: new iam.PolicyDocument({ statements: deployStatements(c) }) } });
        new CfnOutput(this, 'BoundaryArn', { value: boundary.managedPolicyArn });
        new CfnOutput(this, 'ExecRoleArn', { value: exec.roleArn });
        new CfnOutput(this, 'DeployRoleArn', { value: deploy.roleArn });
        new CfnOutput(this, 'AssetBucketName', { value: bucket.bucketName });
    }
}
