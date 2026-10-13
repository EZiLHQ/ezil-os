import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, aws_iam as iam, aws_s3 as s3 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { NamespaceSchema, REGION_PATTERN } from './lifecycle/deployment.js';

/** I5 deploy identity. Created ONCE by the founder with their own admin
 * identity (README "Founder bootstrap"); never deployed by CI. No CDK
 * bootstrap: the stack holds its own asset bucket, a scoped CloudFormation
 * execution role and the GitHub OIDC deploy role, all under a boundary. */
export const IdentityConfigSchema = z.object({
    namespace: NamespaceSchema,
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(REGION_PATTERN),
    /** The account's existing GitHub OIDC provider (reused, not created). */
    githubOidcProviderArn: z.string(),
    /** Immutable-ID subject, environment aws-pilot, e.g.
     * repo:<org>@<orgId>/<repo>@<repoId>:environment:aws-pilot */
    deploySubject: z.string().max(256).regex(/^repo:[A-Za-z0-9_.-]{1,39}@\d{1,20}\/[A-Za-z0-9_.-]{1,100}@\d{1,20}:environment:aws-pilot$/),
    /** No dots: one DNS label, so virtual-host S3 URLs and TLS stay simple. */
    assetBucketName: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    /** Founder-controlled §4 kill switch, enforced by the boundary. */
    killSwitch: z.boolean().default(false),
}).strict().superRefine((c, ctx) => {
    if (c.githubOidcProviderArn !== `arn:aws:iam::${c.accountId}:oidc-provider/token.actions.githubusercontent.com`)
        ctx.addIssue({ code: 'custom', path: ['githubOidcProviderArn'], message: 'must be this account\'s GitHub OIDC provider' });
});
export type IdentityConfig = z.infer<typeof IdentityConfigSchema>;

/** Every workload resource carries this tag (valued with the namespace); the
 * execution role's EC2 and KMS writes are conditioned on it. */
export const NAMESPACE_TAG = 'ezil:namespace';
/** The only AWS-managed policy a workload role may carry (CDK attaches it to
 * Lambda service roles). */
export const LAMBDA_BASIC_EXECUTION = 'arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole';

/** Fixed names so workload stacks and the boundary can reference each other
 * as literals. Identity objects live under /ezil/identity/, which the boundary
 * puts out of reach of every bounded principal; workloads live under
 * /ezil/<namespace>/, and reserved namespaces can never equal it. */
export function identityNames(c: IdentityConfig) {
    const iamArn = (kind: string, path: string, name: string) => `arn:aws:iam::${c.accountId}:${kind}${path}${name}`;
    const identityPath = '/ezil/identity/', workloadPath = `/ezil/${c.namespace}/`;
    if (workloadPath === identityPath) throw new Error('reserved_namespace');
    return {
        identityPath, workloadPath, stackPrefix: `ezil-${c.namespace}-`,
        boundaryName: `ezil-${c.namespace}-boundary`, boundaryArn: iamArn('policy', identityPath, `ezil-${c.namespace}-boundary`),
        execRoleName: `ezil-${c.namespace}-cfn-exec`, execRoleArn: iamArn('role', identityPath, `ezil-${c.namespace}-cfn-exec`),
        deployRoleName: `ezil-${c.namespace}-deploy`, deployRoleArn: iamArn('role', identityPath, `ezil-${c.namespace}-deploy`),
        workloadRoles: iamArn('role', workloadPath, '*'),
    };
}

/** After the allowlist, IAM is the only global service a bounded principal
 * can use at all, so it is the only region-lock exemption. */
export const GLOBAL_SERVICES = ['iam:*'] as const;
const EC2_NETWORK_CREATES = ['ec2:CreateVpc', 'ec2:CreateSubnet', 'ec2:CreateInternetGateway', 'ec2:CreateRouteTable',
    'ec2:CreateSecurityGroup', 'ec2:CreateLaunchTemplate'] as const;
/** Creates that also act on an existing parent VPC. */
const EC2_CREATES_IN_VPC = ['ec2:CreateSubnet', 'ec2:CreateRouteTable', 'ec2:CreateSecurityGroup'] as const;
/** Network creates, split so a new resource needs the namespace tag in the
 * request and its parent VPC must already carry it: nothing is created inside
 * a foreign VPC. `extra` adds conditions (the execution role adds its region). */
function networkCreateStatements(c: { region: string; accountId: string; namespace: string }, sid: (s: string) => string | undefined,
    extra: Record<string, unknown> = {}) {
    const ec2 = (kind: string) => `arn:aws:ec2:${c.region}:${c.accountId}:${kind}/*`;
    const tag = (k: string) => ({ StringEquals: { ...extra, [`aws:${k}Tag/${NAMESPACE_TAG}`]: c.namespace } });
    return [
        new iam.PolicyStatement({ sid: sid('AllowEc2TopLevelCreateTagged'), actions: ['ec2:CreateVpc', 'ec2:CreateInternetGateway', 'ec2:CreateLaunchTemplate'],
            resources: [ec2('vpc'), ec2('internet-gateway'), ec2('launch-template')], conditions: tag('Request') }),
        new iam.PolicyStatement({ sid: sid('AllowEc2InVpcCreateTagged'), actions: [...EC2_CREATES_IN_VPC],
            resources: [ec2('subnet'), ec2('route-table'), ec2('security-group')], conditions: tag('Request') }),
        new iam.PolicyStatement({ sid: sid('AllowEc2CreateOnlyInNamespaceVpc'), actions: [...EC2_CREATES_IN_VPC], resources: [ec2('vpc')],
            conditions: tag('Resource') }),
    ];
}
const EC2_NETWORK_MUTATIONS = ['ec2:ModifyVpcAttribute', 'ec2:DeleteVpc', 'ec2:AttachInternetGateway', 'ec2:DetachInternetGateway',
    'ec2:DeleteInternetGateway', 'ec2:CreateRoute', 'ec2:ReplaceRoute', 'ec2:DeleteRoute', 'ec2:DeleteRouteTable',
    'ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable', 'ec2:ModifySubnetAttribute', 'ec2:DeleteSubnet',
    'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress', 'ec2:DeleteSecurityGroup',
    'ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate', 'ec2:DeleteLaunchTemplate'] as const;
/** The lifecycle controller's EC2 writes (its own policy narrows them further). */
const EC2_COMPUTE = ['ec2:RunInstances', 'ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:AttachVolume',
    'ec2:CreateVolume', 'ec2:ModifyInstanceAttribute'] as const;
const KMS_USE = ['kms:CreateKey', 'kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy', 'kms:EnableKeyRotation',
    'kms:GetKeyRotationStatus', 'kms:TagResource', 'kms:ListResourceTags', 'kms:ListAliases', 'kms:Encrypt', 'kms:Decrypt',
    'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:CreateGrant'] as const;
const DEPLOY_CFN = ['cloudformation:CreateChangeSet', 'cloudformation:DescribeChangeSet', 'cloudformation:ExecuteChangeSet',
    'cloudformation:DeleteChangeSet', 'cloudformation:DescribeStacks', 'cloudformation:DescribeStackEvents', 'cloudformation:GetTemplate',
    'cloudformation:GetTemplateSummary', 'cloudformation:ListStackResources', 'cloudformation:ValidateTemplate'] as const;
const ROLE_WRITES = ['iam:CreateRole', 'iam:DeleteRole', 'iam:UpdateRole', 'iam:UpdateRoleDescription', 'iam:UpdateAssumeRolePolicy',
    'iam:PutRolePolicy', 'iam:DeleteRolePolicy', 'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:PutRolePermissionsBoundary',
    'iam:TagRole', 'iam:UntagRole'] as const;
/** Role writes whose request carries the role's boundary (iam:PermissionsBoundary). */
const BOUNDARY_KEYED = ['iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy',
    'iam:AttachRolePolicy', 'iam:DetachRolePolicy', 'iam:UpdateAssumeRolePolicy', 'iam:UpdateRole', 'iam:DeleteRole'] as const;
const IAM_WRITES_ANYWHERE = [...ROLE_WRITES, 'iam:CreatePolicy', 'iam:DeletePolicy', 'iam:CreatePolicyVersion', 'iam:DeletePolicyVersion',
    'iam:SetDefaultPolicyVersion', 'iam:TagPolicy', 'iam:UntagPolicy', 'iam:CreateInstanceProfile', 'iam:AddRoleToInstanceProfile'] as const;
const IDENTITY_PRINCIPAL_WRITES = ['iam:*User*', 'iam:*Group*', 'iam:*MFADevice*', 'iam:*LoginProfile*', 'iam:*AccessKey*',
    'iam:*SSHPublicKey*', 'iam:*ServiceSpecificCredential*', 'iam:*SigningCertificate*', 'iam:DeleteRolePermissionsBoundary'] as const;
const PROVIDER_WRITES = ['iam:CreateOpenIDConnectProvider', 'iam:DeleteOpenIDConnectProvider', 'iam:UpdateOpenIDConnectProviderThumbprint',
    'iam:AddClientIDToOpenIDConnectProvider', 'iam:RemoveClientIDFromOpenIDConnectProvider', 'iam:TagOpenIDConnectProvider',
    'iam:UntagOpenIDConnectProvider', 'iam:CreateSAMLProvider', 'iam:UpdateSAMLProvider', 'iam:DeleteSAMLProvider',
    'iam:TagSAMLProvider', 'iam:UntagSAMLProvider'] as const;
const ACCOUNT_WRITES = ['organizations:*', 'account:Accept*', 'account:Close*', 'account:Delete*', 'account:Disable*', 'account:Enable*',
    'account:Put*', 'account:Start*', 'aws-portal:Modify*', 'billing:Create*', 'billing:Delete*', 'billing:Put*', 'billing:Update*',
    'payments:*', 'tax:Batch*', 'tax:Delete*', 'tax:Put*', 'ce:Create*', 'ce:Delete*', 'ce:Update*'] as const;
const EDGE_AND_BUDGET_WRITES = ['route53:Associate*', 'route53:Change*', 'route53:Create*', 'route53:Delete*', 'route53:Disassociate*',
    'route53:Update*', 'route53domains:*', 'cloudfront:Associate*', 'cloudfront:Create*', 'cloudfront:Delete*', 'cloudfront:Update*',
    'budgets:Create*', 'budgets:Delete*', 'budgets:Execute*', 'budgets:Modify*', 'budgets:Update*'] as const;
const PURCHASES = ['ec2:Purchase*', 'ec2:AllocateHosts', 'ec2:ModifyHosts', 'ec2:CreateCapacityReservation*',
    'ec2:CreateReservedInstancesListing', 'ec2:AcceptReservedInstancesExchangeQuote', 'ec2:RequestSpot*', 'ec2:CreateFleet',
    'savingsplans:*', 'rds:PurchaseReserved*', 'elasticache:PurchaseReserved*', 'redshift:PurchaseReserved*', 'es:PurchaseReserved*',
    'dynamodb:PurchaseReserved*', 'aws-marketplace:Subscribe', 'aws-marketplace:AcceptAgreement*'] as const;

/** Read and log-delivery actions that have no resource type at all (IAM
 * service reference), so they cannot be scoped below `*`:
 * - ec2:Describe*, iam:Get*, iam:List*, kms:ListAliases: reads only.
 * - logs:DescribeLogGroups and the seven log-delivery actions: Step Functions
 *   execution logging is configured through account-level log deliveries and
 *   a CloudWatch Logs resource policy; the state machine role and the
 *   execution role need them. Blast radius: CloudWatch Logs delivery only.
 * - cloudformation:ValidateTemplate: no side effects. */
export const UNSCOPABLE = ['ec2:Describe*', 'iam:Get*', 'iam:List*', 'kms:ListAliases', 'logs:DescribeLogGroups', 'logs:CreateLogDelivery',
    'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy',
    'logs:DescribeResourcePolicies', 'cloudformation:ValidateTemplate'] as const;
/** §4 kill switch, enforced by the founder-owned boundary on every bounded
 * role, including roles created later. Set `killSwitch: true` in the identity
 * config and update the identity stack. */
export const KILL_SWITCH_ACTIONS = ['ec2:RunInstances', 'ec2:StartInstances', 'ec2:AttachVolume', 'ec2:CreateVolume', 'ec2:CreateFleet',
    'ec2:RequestSpot*', 'states:StartExecution', 'states:StartSyncExecution', 'states:RedriveExecution', 'lambda:InvokeFunction',
    'events:PutTargets'] as const;

/** §5 permission boundary: an ALLOWLIST scoped by resource — namespace names,
 * namespace tags, or the compute tags — then explicit denies. A role planted
 * by CI under /ezil/<ns>/ inherits exactly this ceiling. Exported for tests. */
export function boundaryStatements(c: IdentityConfig): iam.PolicyStatement[] {
    const n = identityNames(c), r = c.region, a = c.accountId, p = n.stackPrefix, bucket = `arn:aws:s3:::${c.assetBucketName}`;
    const ec2 = (kind: string) => `arn:aws:ec2:${r}:${a}:${kind}/*`;
    const nsTag = (k: 'Request' | 'Resource') => ({ [`aws:${k}Tag/${NAMESPACE_TAG}`]: c.namespace });
    const compute = (k: 'Request' | 'Resource') => ({ [`aws:${k}Tag/ezil:managed-by`]: 'app-computer-platform', [`aws:${k}Tag/ezil:stage`]: c.namespace });
    const allow = (sid: string, actions: readonly string[], resources: string[], conditions?: Record<string, Record<string, unknown>>) =>
        new iam.PolicyStatement({ sid, actions: [...actions], resources, ...(conditions ? { conditions } : {}) });
    const deny = (sid: string, actions: readonly string[], extra: Partial<iam.PolicyStatementProps> = {}) =>
        new iam.PolicyStatement({ sid, effect: iam.Effect.DENY, actions: [...actions], resources: ['*'], ...extra });
    return [
        allow('AllowNamespacedWorkloadResources', ['states:*', 'lambda:*', 'logs:*', 'sqs:*', 'events:*', 'cloudwatch:*'], [
            `arn:aws:lambda:${r}:${a}:function:${p}*`, `arn:aws:states:${r}:${a}:stateMachine:${p}*`, `arn:aws:states:${r}:${a}:execution:${p}*`,
            `arn:aws:logs:${r}:${a}:log-group:${p}*`, `arn:aws:sqs:${r}:${a}:${p}*`, `arn:aws:events:${r}:${a}:rule/${p}*`,
            `arn:aws:cloudwatch:${r}:${a}:alarm:${p}*`]),
        allow('AllowUnscopableReadsAndLogDelivery', UNSCOPABLE, ['*']),
        allow('AllowNamespaceSecrets', ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
            [`arn:aws:secretsmanager:${r}:${a}:secret:ezil/${c.namespace}/*`]),
        allow('AllowNamespaceRepositories', ['ecr:CreateRepository', 'ecr:DescribeRepositories', 'ecr:PutImageScanningConfiguration',
            'ecr:PutImageTagMutability', 'ecr:TagResource', 'ecr:ListTagsForResource'], [`arn:aws:ecr:${r}:${a}:repository/${p}*`]),
        allow('AllowNamespaceStacks', DEPLOY_CFN.filter(x => x !== 'cloudformation:CreateChangeSet' && x !== 'cloudformation:ValidateTemplate'),
            [`arn:aws:cloudformation:${r}:${a}:stack/${p}*/*`]),
        allow('AllowChangeSetsOnlyViaExec', ['cloudformation:CreateChangeSet'], [`arn:aws:cloudformation:${r}:${a}:stack/${p}*/*`],
            { ArnEquals: { 'cloudformation:RoleArn': n.execRoleArn } }),
        allow('AllowKmsCreateTagged', ['kms:CreateKey'], ['*'], { StringEquals: nsTag('Request') }),
        allow('AllowKmsOnNamespaceKeys', KMS_USE.filter(x => x !== 'kms:CreateKey' && x !== 'kms:ListAliases'), [`arn:aws:kms:${r}:${a}:key/*`],
            { StringEquals: nsTag('Resource') }),
        ...networkCreateStatements(c, x => x),
        allow('AllowEc2NetworkMutateTagged', EC2_NETWORK_MUTATIONS, ['*'], { StringEquals: nsTag('Resource') }),
        allow('AllowLaunchTagged', ['ec2:RunInstances', 'ec2:CreateVolume'], [ec2('instance'), ec2('volume'), ec2('network-interface')],
            { StringEquals: compute('Request') }),
        allow('AllowLaunchIntoNamespaceNetwork', ['ec2:RunInstances'], [ec2('subnet'), ec2('security-group'), ec2('launch-template')],
            { StringEquals: nsTag('Resource') }),
        allow('AllowLaunchImages', ['ec2:RunInstances'], [`arn:aws:ec2:${r}::image/*`]),
        allow('AllowRestoreNamespaceSnapshots', ['ec2:CreateVolume'], [`arn:aws:ec2:${r}::snapshot/*`],
            { StringEquals: { 'aws:ResourceTag/ezil:backup': c.namespace } }),
        allow('AllowComputeOnManaged', ['ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:AttachVolume',
            'ec2:ModifyInstanceAttribute'], [ec2('instance'), ec2('volume')], { StringEquals: compute('Resource') }),
        allow('AllowTagOnCreate', ['ec2:CreateTags'], ['*'], { StringEquals: { 'ec2:CreateAction': [...EC2_NETWORK_CREATES.map(x => x.slice(4)),
            'RunInstances', 'CreateVolume'] } }),
        allow('AllowRetagNamespaceNetwork', ['ec2:CreateTags'], ['*'], { StringEquals: nsTag('Resource') }),
        allow('AllowRetagManagedCompute', ['ec2:CreateTags'], [ec2('instance'), ec2('volume')], { StringEquals: compute('Resource') }),
        allow('AllowOwnBucket', ['s3:GetObject', 's3:PutObject', 's3:ListBucket', 's3:GetBucketLocation'], [bucket, `${bucket}/*`]),
        allow('AllowRoleWritesUnderWorkloadPath', ROLE_WRITES, [n.workloadRoles]),
        allow('AllowPassWorkloadAndExecRoles', ['iam:PassRole'], [n.workloadRoles, n.execRoleArn]),
        deny('RegionLock', [], { actions: undefined, notActions: [...GLOBAL_SERVICES],
            conditions: { StringNotEquals: { 'aws:RequestedRegion': c.region } } }),
        deny('NoUsersGroupsKeysOrBoundaryRemoval', IDENTITY_PRINCIPAL_WRITES),
        deny('RolesCarryThisBoundary', BOUNDARY_KEYED, { conditions: { StringNotEquals: { 'iam:PermissionsBoundary': n.boundaryArn } } }),
        deny('OnlyLambdaBasicManagedPolicy', ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
            { conditions: { ArnNotEquals: { 'iam:PolicyARN': LAMBDA_BASIC_EXECUTION } } }),
        deny('IamWritesOnlyUnderWorkloadPath', IAM_WRITES_ANYWHERE, { resources: undefined, notResources: [n.workloadRoles] }),
        deny('PassOnlyWorkloadAndExecRoles', ['iam:PassRole'], { resources: undefined, notResources: [n.workloadRoles, n.execRoleArn] }),
        deny('AssumeOnlyWorkloadRoles', ['sts:AssumeRole'], { resources: undefined, notResources: [n.workloadRoles] }),
        deny('NoIdentityProviderWrites', PROVIDER_WRITES),
        deny('NoStorageDeletionOrDetach', ['ec2:DeleteVolume', 'ec2:DeleteSnapshot', 'ec2:DetachVolume', 'ec2:DeleteTags']),
        deny('BackupTagOnlyAtCreation', ['ec2:CreateTags'], { conditions: {
            'ForAnyValue:StringEquals': { 'aws:TagKeys': ['ezil:backup'] }, Null: { 'ec2:CreateAction': 'true' } } }),
        deny('NoOrgAccountBillingWrites', ACCOUNT_WRITES),
        deny('NoEdgeOrBudgetWrites', EDGE_AND_BUDGET_WRITES),
        deny('NoPurchasesOrReservations', PURCHASES),
        ...(c.killSwitch ? [deny('KillSwitch', KILL_SWITCH_ACTIONS)] : []),
    ];
}

/** Exactly what CloudFormation needs for the foundation, lifecycle, recovery
 * and app-caller stacks. The ops stack (DLM, budgets, kill switch) is
 * founder-deployed and gets nothing here. No AdministratorAccess. */
export function execStatements(c: IdentityConfig): iam.PolicyStatement[] {
    const n = identityNames(c), r = c.region, a = c.accountId, inRegion = { 'aws:RequestedRegion': r };
    const regional = (actions: string[], resources: string[] = ['*'], extra: Record<string, Record<string, unknown>> = {}) =>
        new iam.PolicyStatement({ actions, resources, conditions: { StringEquals: { ...inRegion, ...(extra.StringEquals ?? {}) },
            ...Object.fromEntries(Object.entries(extra).filter(([k]) => k !== 'StringEquals')) } });
    const requestTag = { StringEquals: { [`aws:RequestTag/${NAMESPACE_TAG}`]: c.namespace } };
    const resourceTag = { StringEquals: { [`aws:ResourceTag/${NAMESPACE_TAG}`]: c.namespace } };
    const own = (service: string, kind: string) => `arn:aws:${service}:${r}:${a}:${kind}${n.stackPrefix}*`;
    return [
        regional(['ec2:Describe*']),
        ...networkCreateStatements(c, () => undefined, inRegion),
        regional(['ec2:CreateTags'], ['*'], { StringEquals: { [`aws:RequestTag/${NAMESPACE_TAG}`]: c.namespace, 'ec2:CreateAction': [...EC2_NETWORK_CREATES.map(x => x.slice(4))] } }),
        regional([...EC2_NETWORK_MUTATIONS], ['*'], resourceTag),
        regional(['ecr:CreateRepository', 'ecr:DescribeRepositories', 'ecr:PutImageScanningConfiguration', 'ecr:PutImageTagMutability',
            'ecr:TagResource', 'ecr:ListTagsForResource'], [own('ecr', 'repository/')]),
        regional(['kms:CreateKey'], ['*'], requestTag),
        regional(['kms:ListAliases']),
        regional(['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy', 'kms:EnableKeyRotation', 'kms:GetKeyRotationStatus',
            'kms:TagResource', 'kms:ListResourceTags'], [`arn:aws:kms:${r}:${a}:key/*`], resourceTag),
        regional(['logs:CreateLogGroup', 'logs:DeleteLogGroup', 'logs:PutRetentionPolicy', 'logs:DeleteRetentionPolicy',
            'logs:AssociateKmsKey', 'logs:TagResource', 'logs:ListTagsForResource'], [own('logs', 'log-group:')]),
        regional(['logs:DescribeLogGroups']),
        // Step Functions execution logging is configured through log deliveries.
        regional(['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery',
            'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies']),
        regional(['lambda:CreateFunction', 'lambda:DeleteFunction', 'lambda:GetFunction', 'lambda:GetFunctionConfiguration',
            'lambda:UpdateFunctionCode', 'lambda:UpdateFunctionConfiguration', 'lambda:PublishVersion', 'lambda:ListVersionsByFunction',
            'lambda:AddPermission', 'lambda:RemovePermission', 'lambda:PutFunctionConcurrency', 'lambda:DeleteFunctionConcurrency',
            'lambda:PutFunctionEventInvokeConfig', 'lambda:UpdateFunctionEventInvokeConfig', 'lambda:GetFunctionEventInvokeConfig',
            'lambda:DeleteFunctionEventInvokeConfig', 'lambda:TagResource', 'lambda:ListTags'], [own('lambda', 'function:')]),
        regional(['states:CreateStateMachine', 'states:UpdateStateMachine', 'states:DeleteStateMachine', 'states:DescribeStateMachine',
            'states:PublishStateMachineVersion', 'states:ListStateMachineVersions', 'states:TagResource', 'states:ListTagsForResource'],
            [own('states', 'stateMachine:')]),
        regional(['sqs:CreateQueue', 'sqs:DeleteQueue', 'sqs:GetQueueAttributes', 'sqs:SetQueueAttributes', 'sqs:TagQueue',
            'sqs:ListQueueTags'], [`arn:aws:sqs:${r}:${a}:${n.stackPrefix}*`]),
        regional(['events:PutRule', 'events:DeleteRule', 'events:DescribeRule', 'events:EnableRule', 'events:DisableRule',
            'events:PutTargets', 'events:RemoveTargets', 'events:TagResource', 'events:ListTagsForResource'], [own('events', 'rule/')]),
        regional(['cloudwatch:PutMetricAlarm', 'cloudwatch:DeleteAlarms', 'cloudwatch:DescribeAlarms', 'cloudwatch:TagResource',
            'cloudwatch:ListTagsForResource'], [own('cloudwatch', 'alarm:')]),
        // Lambda reads its code from the asset bucket with the caller's rights.
        new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [`arn:aws:s3:::${c.assetBucketName}/assets/*`] }),
        // Workload roles: only under the workload path, and only carrying the boundary.
        new iam.PolicyStatement({ actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy', 'iam:DeleteRolePolicy',
            'iam:UpdateAssumeRolePolicy', 'iam:UpdateRole', 'iam:DeleteRole'], resources: [n.workloadRoles],
            conditions: { StringEquals: { 'iam:PermissionsBoundary': n.boundaryArn } } }),
        new iam.PolicyStatement({ actions: ['iam:AttachRolePolicy', 'iam:DetachRolePolicy'], resources: [n.workloadRoles],
            conditions: { StringEquals: { 'iam:PermissionsBoundary': n.boundaryArn }, ArnEquals: { 'iam:PolicyARN': LAMBDA_BASIC_EXECUTION } } }),
        new iam.PolicyStatement({ actions: ['iam:GetRole', 'iam:GetRolePolicy', 'iam:ListRolePolicies', 'iam:ListAttachedRolePolicies',
            'iam:ListRoleTags', 'iam:TagRole', 'iam:UntagRole'], resources: [n.workloadRoles] }),
        new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [n.workloadRoles],
            conditions: { StringEquals: { 'iam:PassedToService': ['lambda.amazonaws.com', 'states.amazonaws.com'] } } }),
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
