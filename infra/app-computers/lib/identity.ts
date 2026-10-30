import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps, aws_iam as iam, aws_s3 as s3 } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { DEFAULT_STORAGE, INSTANCE_TYPES, NamespaceSchema, REGION_PATTERN, LifecycleDeploymentSchema } from './lifecycle/deployment.js';

import { ImageJobBoundary, imageJobBoundaryArn, imageJobRoleArns, imageJobRoleNameArns } from './image-job-boundary.js';

/** I5 deploy identity. Created ONCE by the founder with their own admin
 * identity (README "Founder bootstrap"); never deployed by CI. No CDK
 * bootstrap: the stack holds its own asset bucket, a scoped CloudFormation
 * execution role and the GitHub OIDC deploy role. Only workload roles carry
 * the boundary; identity roles retain the old denies as an attached policy. */
const DEPLOY_SUBJECT = /^repo:[A-Za-z0-9_.-]{1,39}@\d{1,20}\/[A-Za-z0-9_.-]{1,100}@\d{1,20}:environment:(aws-[a-z0-9-]{1,40})$/;
/** The GitHub deploy environment the deploy role trusts (the subject's pinned suffix). */
export function deployEnvironment(c: { deploySubject: string }): string {
    return DEPLOY_SUBJECT.exec(c.deploySubject)![1]!;
}
export const IdentityConfigSchema = z.object({
    namespace: NamespaceSchema,
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(REGION_PATTERN),
    /** The account's existing GitHub OIDC provider (reused, not created). */
    githubOidcProviderArn: z.string(),
    /** Immutable-ID subject of one GitHub deploy environment named `aws-<label>`,
     * chosen per namespace (mum: aws-pilot; prd: aws-prd). Never a bare environment
     * such as `production`. e.g. repo:<org>@<orgId>/<repo>@<repoId>:environment:aws-pilot */
    deploySubject: z.string().max(256).regex(DEPLOY_SUBJECT),
    /** No dots: one DNS label, so virtual-host S3 URLs and TLS stay simple. */
    assetBucketName: z.string().regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/),
    /** Founder-controlled §4 kill switch, enforced by the boundary and identity guardrails. */
    killSwitch: z.boolean().default(false),
    /** Founder-approved warm-pool lifecycle: opt in to DetachVolume/DeleteTags
     * in the shared workload boundary. Off preserves the live storage denies;
     * identity guardrails and the image-job boundary always retain them. */
    poolLifecycle: z.boolean().default(false),
    /** Reviewed image-job data scope; founder publishes its boundary before workflows. */
    imageJobDeployment: LifecycleDeploymentSchema.optional(),
    /** Cost cap for any bounded principal: largest EBS volume it may create. */
    maxVolumeGiB: z.number().int().min(8).max(16384).default(DEFAULT_STORAGE.dataMaxGiB),
    /** C-6 userData nonce delivery. Off (default): the boundary denies
     * ec2:ModifyInstanceAttribute outright, so no bounded role can change an
     * instance's type, disk flags or anything else after launch. On (set only
     * together with the lifecycle's userDataNonce + userDataAttributeKeyVerified,
     * after the README staging proof): allowed for ec2:Attribute=userData on
     * compute-tagged instances, denied for any other or missing attribute. */
    userDataAttributeKeyVerified: z.boolean().default(false),
}).strict().superRefine((c, ctx) => {
    if (c.imageJobDeployment && (['namespace', 'accountId', 'region'] as const).some(k => c.imageJobDeployment![k] !== c[k]))
        ctx.addIssue({ code: 'custom', message: 'image_job_boundary_scope_mismatch' });
    if (c.imageJobDeployment && c.imageJobDeployment.storage.dataMaxGiB > c.maxVolumeGiB)
        ctx.addIssue({ code: 'custom', message: 'image_job_boundary_size_cap' });
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
function networkCreateStatements(c: { region: string; accountId: string; namespace: string },
    extra: Record<string, unknown> = {}) {
    const ec2 = (kind: string) => `arn:aws:ec2:${c.region}:${c.accountId}:${kind}/*`;
    const tag = (k: string) => ({ StringEquals: { ...extra, [`aws:${k}Tag/${NAMESPACE_TAG}`]: c.namespace } });
    return [
        new iam.PolicyStatement({ actions: ['ec2:CreateVpc', 'ec2:CreateInternetGateway', 'ec2:CreateLaunchTemplate'],
            resources: [ec2('vpc'), ec2('internet-gateway'), ec2('launch-template')], conditions: tag('Request') }),
        new iam.PolicyStatement({ actions: [...EC2_CREATES_IN_VPC],
            resources: [ec2('subnet'), ec2('route-table'), ec2('security-group')], conditions: tag('Request') }),
        new iam.PolicyStatement({ actions: [...EC2_CREATES_IN_VPC], resources: [ec2('vpc')],
            conditions: tag('Resource') }),
    ];
}
const EC2_NETWORK_MUTATIONS = ['ec2:ModifyVpcAttribute', 'ec2:DeleteVpc', 'ec2:AttachInternetGateway', 'ec2:DetachInternetGateway',
    'ec2:DeleteInternetGateway', 'ec2:CreateRoute', 'ec2:ReplaceRoute', 'ec2:DeleteRoute', 'ec2:DeleteRouteTable',
    'ec2:AssociateRouteTable', 'ec2:DisassociateRouteTable', 'ec2:ModifySubnetAttribute', 'ec2:DeleteSubnet',
    'ec2:AuthorizeSecurityGroupEgress', 'ec2:RevokeSecurityGroupEgress', 'ec2:DeleteSecurityGroup',
    'ec2:CreateLaunchTemplateVersion', 'ec2:ModifyLaunchTemplate', 'ec2:DeleteLaunchTemplate'] as const;
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
    // None of these services is used by deployment or lifecycle roles (tested).
    // Denying the whole service preserves purchase bans with less policy text.
    'savingsplans:*', 'rds:*', 'elasticache:*', 'redshift:*', 'es:*', 'dynamodb:*', 'aws-marketplace:*'] as const;

/** Workload reads and Step Functions log delivery need account-level resources.
 * Keep actions explicit: no deployment, IAM, KMS administration or EC2 Describe*
 * in the workload allowlist. */
export const WORKLOAD_UNSCOPABLE = ['ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeImages',
    'ec2:DescribeSnapshots',
    'ec2:DescribeLaunchTemplateVersions', 'ec2:DescribeAvailabilityZones', 'logs:DescribeLogGroups',
    'logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery',
    'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies'] as const;
/** §4 kill switch, enforced by the founder-owned boundary on workload roles
 * (including roles created later) and by the attached identity guardrails.
 * Set `killSwitch: true` in the identity config and update the identity stack. */
export const KILL_SWITCH_ACTIONS = ['ec2:RunInstances', 'ec2:StartInstances', 'ec2:AttachVolume', 'ec2:CreateVolume', 'ec2:CreateFleet',
    'ec2:RequestSpot*', 'states:StartExecution', 'states:StartSyncExecution', 'states:RedriveExecution', 'lambda:InvokeFunction',
    'events:PutTargets'] as const;

const allow = (actions: readonly string[], resources: string[], conditions?: Record<string, Record<string, unknown>>) =>
    new iam.PolicyStatement({ actions: [...actions], resources, ...(conditions ? { conditions } : {}) });
const deny = (actions: readonly string[], extra: Partial<iam.PolicyStatementProps> = {}) =>
    new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: [...actions], resources: ['*'], ...extra });

/** Merge only statements with identical effect, resources and conditions.
 * Never combine resource lists across distinct actions (that creates grants).
 * NotAction statements remain separate. Sids are intentionally omitted. */
export function compactStatements(statements: iam.PolicyStatement[]): iam.PolicyStatement[] {
    const groups = new Map<string, iam.PolicyStatement>();
    const result: iam.PolicyStatement[] = [];
    for (const statement of statements) {
        const { Action, ...scope } = statement.toStatementJson();
        if (!Action) { result.push(statement); continue; }
        const key = JSON.stringify(scope);
        const existing = groups.get(key);
        if (existing) existing.addActions(...statement.actions);
        else { groups.set(key, statement); result.push(statement); }
    }
    return result;
}

/** These fences apply to workload roles AND the founder-created identities. */
function commonDenies(c: IdentityConfig, poolLifecycle = false): iam.PolicyStatement[] {
    const r = c.region, a = c.accountId;
    return [
        deny(PURCHASES),
        deny([], { actions: undefined, notActions: [...GLOBAL_SERVICES],
            conditions: { StringNotEquals: { 'aws:RequestedRegion': c.region } } }),
        deny(['ec2:DeleteVolume', 'ec2:DeleteSnapshot', ...(poolLifecycle ? [] : ['ec2:DetachVolume', 'ec2:DeleteTags'])]),
        deny(['ec2:CreateTags'], { conditions: {
            'ForAnyValue:StringEquals': { 'aws:TagKeys': ['ezil:backup'] }, Null: { 'ec2:CreateAction': 'true' } } }),
        deny(['ec2:DescribeInstanceAttribute'], { resources: [`arn:aws:ec2:${r}:${a}:instance/*`],
            conditions: { StringNotEquals: { 'aws:ResourceTag/ezil:stage': c.namespace } } }),
        // Type, disk-flag and every other attribute change after launch is denied for
        // every bounded role; only the flagged userData nonce write is carved out.
        ...(c.userDataAttributeKeyVerified ? [
            deny(['ec2:ModifyInstanceAttribute'],
                { conditions: { 'ForAnyValue:StringNotEquals': { 'ec2:Attribute': 'userData' } } }),
            deny(['ec2:ModifyInstanceAttribute'], { conditions: { Null: { 'ec2:Attribute': 'true' } } }),
        ] : [deny(['ec2:ModifyInstanceAttribute'])]),
        ...(c.killSwitch ? [deny(KILL_SWITCH_ACTIONS)] : []),
    ];
}

/** Every historical boundary deny is retained here. This policy grants nothing;
 * it replaces the denies the exec/deploy roles used to inherit from the boundary.
 * The frozen pre-Design-A fixture proves their unchanged inline allows are each
 * contained in an old boundary allow, including resources and conditions. */
export function identityGuardrailStatements(c: IdentityConfig): iam.PolicyStatement[] {
    const n = identityNames(c);
    return compactStatements([
        ...commonDenies(c),
        deny(IDENTITY_PRINCIPAL_WRITES),
        deny(BOUNDARY_KEYED, { conditions: { StringNotEquals: { 'iam:PermissionsBoundary': c.imageJobDeployment
            ? [n.boundaryArn, imageJobBoundaryArn(c.accountId, c.namespace)] : n.boundaryArn } } }),
        ...(c.imageJobDeployment ? [deny(BOUNDARY_KEYED, { resources: undefined, notResources: imageJobRoleArns(c.accountId, c.namespace),
            conditions: { StringEquals: { 'iam:PermissionsBoundary': imageJobBoundaryArn(c.accountId, c.namespace) } } })] : []),
        deny(['iam:AttachRolePolicy', 'iam:DetachRolePolicy'],
            { conditions: { ArnNotEquals: { 'iam:PolicyARN': LAMBDA_BASIC_EXECUTION } } }),
        deny(IAM_WRITES_ANYWHERE, { resources: undefined, notResources: [n.workloadRoles] }),
        deny(['iam:PassRole'], { resources: undefined, notResources: [n.workloadRoles, n.execRoleArn] }),
        deny(['sts:AssumeRole'], { resources: undefined, notResources: [n.workloadRoles] }),
        deny(PROVIDER_WRITES),
        deny(ACCOUNT_WRITES),
        deny(EDGE_AND_BUDGET_WRITES),
        // Alarms may not drive EC2/SSM automation (e.g. terminate any instance);
        // with ops founder-only, bounded principals get no alarm actions at all.
        deny(['cloudwatch:PutMetricAlarm', 'cloudwatch:PutCompositeAlarm'], { conditions: {
            'ForAnyValue:StringLike': { 'cloudwatch:AlarmActions': ['arn:aws:automate:*', 'arn:aws:ssm*'] } } }),
        deny(['cloudwatch:PutMetricAlarm', 'cloudwatch:PutCompositeAlarm'], { conditions: {
            Null: { 'cloudwatch:AlarmActions': 'false' } } }),
    ]);
}

/** Workload-only ceiling: lifecycle/recovery Lambdas, workflows and app caller.
 * Explicit actions and the old tag/resource conditions make this a subset of
 * the historical boundary. A CI-planted role cannot administer infrastructure.
 * No workload uses IAM, STS, account/billing/edge services or alarms; blanket
 * denies for those services also cover all of their historical deny patterns. */
export function boundaryStatements(c: IdentityConfig): iam.PolicyStatement[] {
    const n = identityNames(c), r = c.region, a = c.accountId, p = n.stackPrefix;
    const ec2 = (kind: string) => `arn:aws:ec2:${r}:${a}:${kind}/*`;
    const nsTag = (k: 'Request' | 'Resource') => ({ [`aws:${k}Tag/${NAMESPACE_TAG}`]: c.namespace });
    const compute = (k: 'Request' | 'Resource') => ({ [`aws:${k}Tag/ezil:managed-by`]: 'app-computer-platform', [`aws:${k}Tag/ezil:stage`]: c.namespace });
    return compactStatements([
        allow(['lambda:InvokeFunction'], [`arn:aws:lambda:${r}:${a}:function:${p}*`]),
        allow(['states:StartExecution', 'states:ListExecutions'], [`arn:aws:states:${r}:${a}:stateMachine:${p}*`]),
        allow(['states:DescribeExecution', 'states:GetExecutionHistory'], [`arn:aws:states:${r}:${a}:execution:${p}*`]),
        allow(['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:PutLogEvents'], [`arn:aws:logs:${r}:${a}:log-group:${p}*`]),
        allow(['sqs:SendMessage'], [`arn:aws:sqs:${r}:${a}:${p}*`]),
        allow(WORKLOAD_UNSCOPABLE, ['*']),
        allow(['secretsmanager:GetSecretValue'], [`arn:aws:secretsmanager:${r}:${a}:secret:ezil/${c.namespace}/*`]),
        allow(['kms:Encrypt', 'kms:Decrypt', 'kms:ReEncryptFrom', 'kms:ReEncryptTo', 'kms:GenerateDataKey',
            'kms:GenerateDataKeyWithoutPlaintext', 'kms:DescribeKey', 'kms:CreateGrant'], [`arn:aws:kms:${r}:${a}:key/*`],
            { StringEquals: nsTag('Resource') }),
        allow(['ec2:RunInstances'], [ec2('instance')],
            { StringEquals: { ...compute('Request'), 'ec2:InstanceType': [...INSTANCE_TYPES] } }),
        allow(['ec2:RunInstances', 'ec2:CreateVolume'], [ec2('volume')],
            { StringEquals: { ...compute('Request'), 'ec2:VolumeType': 'gp3' }, Bool: { 'ec2:Encrypted': 'true' },
                NumericLessThanEquals: { 'ec2:VolumeSize': String(c.maxVolumeGiB) } }),
        allow(['ec2:RunInstances'], [ec2('network-interface')], { StringEquals: compute('Request') }),
        allow(['ec2:RunInstances'], [ec2('subnet'), ec2('security-group'), ec2('launch-template')],
            { StringEquals: nsTag('Resource') }),
        allow(['ec2:RunInstances'], [`arn:aws:ec2:${r}::image/*`]),
        // The boundary caps compute permissions by managed namespace. The
        // explicitly enabled pool lifecycle further restricts detach/untag to
        // release and pool claims. Keep the default live storage denies.
        allow(['ec2:StartInstances', 'ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:AttachVolume', 'ec2:CreateTags',
            ...(c.poolLifecycle ? ['ec2:DetachVolume', 'ec2:DeleteTags'] : [])],
            [ec2('instance'), ec2('volume')], { StringEquals: compute('Resource') }),
        ...(c.userDataAttributeKeyVerified ? [allow(['ec2:ModifyInstanceAttribute'], [ec2('instance')],
            { StringEquals: { ...compute('Resource'), 'ec2:Attribute': 'userData' } })] : []),
        // Create-time tags only. The primary ENI RunInstances creates must carry the compute
        // request tags (network-interface grant above), so it is tagged by the same call.
        allow(['ec2:CreateTags'], [ec2('instance'), ec2('volume'), ec2('network-interface')],
            { StringEquals: { 'ec2:CreateAction': ['RunInstances', 'CreateVolume'] } }),
        ...commonDenies(c, c.poolLifecycle),
        deny(['iam:*', 'sts:*', 'organizations:*', 'account:*', 'aws-portal:*', 'billing:*', 'payments:*', 'tax:*', 'ce:*',
            'route53:*', 'route53domains:*', 'cloudfront:*', 'budgets:*', 'cloudwatch:*']),
    ]);
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
        ...networkCreateStatements(c, inRegion),
        regional(['ec2:CreateTags'], ['*'], { StringEquals: { [`aws:RequestTag/${NAMESPACE_TAG}`]: c.namespace, 'ec2:CreateAction': [...EC2_NETWORK_CREATES.map(x => x.slice(4))] } }),
        regional([...EC2_NETWORK_MUTATIONS], ['*'], resourceTag),
        regional(['ecr:CreateRepository', 'ecr:DescribeRepositories', 'ecr:PutImageScanningConfiguration', 'ecr:PutImageTagMutability',
            'ecr:TagResource', 'ecr:ListTagsForResource'], [own('ecr', 'repository/')]),
        regional(['kms:CreateKey'], ['*'], requestTag),
        regional(['kms:ListAliases']),
        regional(['kms:DescribeKey', 'kms:GetKeyPolicy', 'kms:PutKeyPolicy', 'kms:EnableKeyRotation', 'kms:GetKeyRotationStatus',
            'kms:TagResource', 'kms:ListResourceTags'], [`arn:aws:kms:${r}:${a}:key/*`], resourceTag),
        // CreateStateMachine/DescribeStateMachine with a customer key call KMS as the caller, via Step Functions.
        regional(['kms:GenerateDataKey', 'kms:Decrypt'], [`arn:aws:kms:${r}:${a}:key/*`],
            { StringEquals: { [`aws:ResourceTag/${NAMESPACE_TAG}`]: c.namespace, 'kms:ViaService': `states.${r}.amazonaws.com` } }),
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
        ...(c.imageJobDeployment ? [new iam.PolicyStatement({ actions: ['iam:CreateRole', 'iam:PutRolePermissionsBoundary', 'iam:PutRolePolicy',
            'iam:DeleteRolePolicy', 'iam:UpdateAssumeRolePolicy', 'iam:UpdateRole', 'iam:DeleteRole'],
            resources: imageJobRoleArns(c.accountId, c.namespace),
            conditions: { StringEquals: { 'iam:PermissionsBoundary': imageJobBoundaryArn(c.accountId, c.namespace) } } }),
            new iam.PolicyStatement({ actions: ['iam:GetRole'], resources: imageJobRoleNameArns(c.accountId, c.namespace) })] : []),
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
            description: 'EZiL workload permission boundary (AWS-COMPUTERS.md §5)', document: new iam.PolicyDocument({ statements: boundaryStatements(c) }) });
        if (c.imageJobDeployment) new ImageJobBoundary(this, c, c.imageJobDeployment);
        const guardrails = new iam.ManagedPolicy(this, 'IdentityGuardrails', {
            managedPolicyName: `ezil-${c.namespace}-identity-guardrails`, path: n.identityPath,
            description: 'Historical boundary denies for founder-created deployment identities; grants nothing',
            document: new iam.PolicyDocument({ statements: identityGuardrailStatements(c) }),
        });
        const bucket = new s3.Bucket(this, 'AssetBucket', { bucketName: c.assetBucketName, encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, enforceSSL: true, versioned: true, removalPolicy: RemovalPolicy.RETAIN,
            lifecycleRules: [{ noncurrentVersionExpiration: Duration.days(90) }] });
        const exec = new iam.Role(this, 'ExecRole', { roleName: n.execRoleName, path: n.identityPath, managedPolicies: [guardrails],
            assumedBy: new iam.ServicePrincipal('cloudformation.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': c.accountId } } }),
            inlinePolicies: { exec: new iam.PolicyDocument({ statements: execStatements(c) }) } });
        const deploy = new iam.Role(this, 'DeployRole', { roleName: n.deployRoleName, path: n.identityPath, managedPolicies: [guardrails],
            maxSessionDuration: Duration.hours(1), description: `GitHub OIDC deploy (environment ${deployEnvironment(c)}): change sets via the execution role`,
            assumedBy: new iam.FederatedPrincipal(c.githubOidcProviderArn, deployTrust(c).conditions, 'sts:AssumeRoleWithWebIdentity'),
            inlinePolicies: { deploy: new iam.PolicyDocument({ statements: deployStatements(c) }) } });
        new CfnOutput(this, 'BoundaryArn', { value: boundary.managedPolicyArn });
        new CfnOutput(this, 'ExecRoleArn', { value: exec.roleArn });
        new CfnOutput(this, 'DeployRoleArn', { value: deploy.roleArn });
        new CfnOutput(this, 'AssetBucketName', { value: bucket.bucketName });
    }
}
