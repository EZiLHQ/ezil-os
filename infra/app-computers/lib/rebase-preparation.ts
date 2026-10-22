import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Tags, aws_iam as iam, aws_kms as kms, aws_lambda as lambda,
    aws_lambda_nodejs as nodejs, aws_logs as logs, aws_stepfunctions as states } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import type { Settings } from './lifecycle/contract.js';
import { SNAPSHOT_TAG_KEYS } from './lifecycle/preparation-contract.js';
import { preparationDefinition } from './lifecycle/preparation-definition.js';

export const workflowLogActions = ['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery',
    'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'];
export const imageWorkflowDenies = ['ec2:DeleteVolume', 'ec2:DeleteSnapshot', 'ec2:ModifyInstanceAttribute',
    'ec2:ModifyInstanceMetadataOptions', 'iam:PassRole', 'ec2:DetachVolume', 'ec2:DeleteTags'];
export function dataKeyStatements(d: Settings['deployment']) {
    return [new iam.PolicyStatement({ actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncryptFrom', 'kms:ReEncryptTo', 'kms:DescribeKey'],
        resources: [d.dataKeyArn], conditions: { StringEquals: { 'kms:ViaService': `ec2.${d.region}.amazonaws.com` } } }),
    new iam.PolicyStatement({ actions: ['kms:CreateGrant'], resources: [d.dataKeyArn], conditions: {
        StringEquals: { 'kms:ViaService': `ec2.${d.region}.amazonaws.com` }, Bool: { 'kms:GrantIsForAWSResource': 'true' } } })];
}
export function historyReadStatement(region: string, key: string, versions: string[]) {
    return new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [key], conditions: { StringEquals: {
        'kms:ViaService': `states.${region}.amazonaws.com`, 'kms:EncryptionContext:aws:states:stateMachineArn':
            [...new Set(versions.flatMap(v => [v.replace(/:[1-9][0-9]*$/, ''), v]))],
    } } });
}
export function snapshotRequestConditions(d: Settings['deployment']) {
    return { StringEquals: { 'aws:RequestedRegion': d.region, 'aws:RequestTag/ezil:managed-by': 'app-computer-platform',
        'aws:RequestTag/ezil:stage': d.namespace, 'aws:RequestTag/ezil:purpose': 'pre-rebase' },
    Null: Object.fromEntries(['aws:TagKeys', ...SNAPSHOT_TAG_KEYS.map(k => 'aws:RequestTag/' + k)].map(k => [k, 'false'])),
    'ForAllValues:StringEquals': { 'aws:TagKeys': [...SNAPSHOT_TAG_KEYS] } };
}
export function preparationStatements(settings: Settings): iam.PolicyStatement[] {
    const d = settings.deployment, r = d.region, ec2 = (kind: string) => `arn:aws:ec2:${r}:${d.accountId}:${kind}/*`, snapshot = `arn:aws:ec2:${r}::snapshot/*`;
    const existing = { 'aws:RequestedRegion': r, 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform', 'ec2:ResourceTag/ezil:stage': d.namespace };
    const present = { 'aws:ResourceTag/ezil:computer-id': 'false', 'aws:ResourceTag/ezil:pool': 'true' };
    const request = snapshotRequestConditions(d);
    return [
        new iam.PolicyStatement({ actions: ['ec2:StopInstances', 'ec2:TerminateInstances'], resources: [ec2('instance')], conditions: { StringEquals: existing, Null: present } }),
        new iam.PolicyStatement({ actions: ['ec2:CreateSnapshot'], resources: [ec2('volume')], conditions: {
            StringEquals: { ...existing, 'ec2:ResourceTag/ezil:backup': d.namespace }, Null: present } }),
        new iam.PolicyStatement({ actions: ['ec2:CreateSnapshot'], resources: [snapshot], conditions: request }),
        new iam.PolicyStatement({ actions: ['ec2:CreateTags'], resources: [snapshot], conditions: {
            ...request, StringEquals: { ...request.StringEquals, 'ec2:CreateAction': 'CreateSnapshot' } } }),
        ...dataKeyStatements(d),
        new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: imageWorkflowDenies, resources: ['*'] }),
        new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: ['ec2:CreateTags'], resources: ['*'], conditions: {
            'ForAnyValue:StringEquals': { 'aws:TagKeys': [...SNAPSHOT_TAG_KEYS, 'ezil:backup'] }, Null: { 'ec2:CreateAction': 'true' } } }),
    ];
}
export class RebasePreparation extends Construct {
    readonly machine: states.CfnStateMachine;
    readonly version: states.CfnStateMachineVersion;
    constructor(scope: Construct, id: string, props: { settings: Settings; historyKey: kms.IKey; authorityKeyArn: string; lambdaReservedConcurrency?: number | null }) {
        super(scope, id);
        const s = props.settings, d = s.deployment, name = `ezil-${d.namespace}-rebase-preparation`;
        const machineArn = `arn:aws:states:${d.region}:${d.accountId}:stateMachine:${name}`;
        if (!d.preparationStateMachineVersionArn?.startsWith(machineArn + ':')) throw new Error('invalid_preparation_version');
        const log = (id: string, logGroupName: string) => new logs.LogGroup(this, id, { logGroupName, encryptionKey: props.historyKey,
            retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN });
        const observerLogs = log('ObserverLogs', name + '-observer');
        const observerRole = new iam.Role(this, 'ObserverRole', { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), path: `/ezil/${d.namespace}/` });
        observerRole.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
            resources: [`arn:aws:logs:${d.region}:${d.accountId}:log-group:${name}-observer:log-stream:*`] }));
        const observer = new nodejs.NodejsFunction(this, 'Observer', { functionName: name + '-observer', role: observerRole,
            entry: join(__dirname, 'lifecycle/preparation-helper.ts'), handler: 'handler', runtime: lambda.Runtime.NODEJS_24_X,
            timeout: Duration.seconds(55), memorySize: 256,
            ...(props.lambdaReservedConcurrency === null ? {} : { reservedConcurrentExecutions: props.lambdaReservedConcurrency ?? 2 }),
            logGroup: observerLogs, depsLockFilePath: join(__dirname, '../package-lock.json'),
            bundling: { minify: true, sourceMap: false, externalModules: [] }, environment: { EZIL_LIFECYCLE_SETTINGS: JSON.stringify(s) } });
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances', 'ec2:DescribeVolumes', 'ec2:DescribeImages', 'ec2:DescribeLaunchTemplateVersions', 'ec2:DescribeSnapshots'],
            resources: ['*'], conditions: { StringEquals: { 'aws:RequestedRegion': d.region } } }));
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: [machineArn.replace(':stateMachine:', ':execution:') + ':computer-*'] }));
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [s.authoritySecretArn] }));
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [props.authorityKeyArn], conditions: { StringEquals: {
            'kms:ViaService': `secretsmanager.${d.region}.amazonaws.com`, 'kms:EncryptionContext:SecretARN': s.authoritySecretArn } } }));
        observer.addToRolePolicy(historyReadStatement(d.region, props.historyKey.keyArn, [d.preparationStateMachineVersionArn]));
        const role = new iam.Role(this, 'RebasePreparationRole', { roleName: name, path: `/ezil/${d.namespace}/`,
            assumedBy: new iam.ServicePrincipal('states.amazonaws.com', { conditions: { StringEquals: { 'aws:SourceAccount': d.accountId }, ArnEquals: { 'aws:SourceArn': machineArn } } }) });
        role.addToPolicy(new iam.PolicyStatement({ actions: ['lambda:InvokeFunction'], resources: [observer.currentVersion.functionArn] }));
        role.addToPolicy(new iam.PolicyStatement({ actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey'], resources: [props.historyKey.keyArn] }));
        for (const statement of preparationStatements(s)) role.addToPolicy(statement);
        role.addToPolicy(new iam.PolicyStatement({ actions: workflowLogActions, resources: ['*'] }));
        const workflowLogs = log('WorkflowLogs', name + '-workflow');
        this.machine = new states.CfnStateMachine(this, 'Workflow', { stateMachineName: name, stateMachineType: 'STANDARD', roleArn: role.roleArn,
            definitionString: JSON.stringify(preparationDefinition(observer.currentVersion.functionArn)),
            encryptionConfiguration: { type: 'CUSTOMER_MANAGED_KMS_KEY', kmsKeyId: props.historyKey.keyArn },
            loggingConfiguration: { level: 'ERROR', includeExecutionData: false, destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: workflowLogs.logGroupArn } }] } });
        this.machine.node.addDependency(role);
        this.version = new states.CfnStateMachineVersion(this, 'Version', { stateMachineArn: this.machine.ref, stateMachineRevisionId: this.machine.attrStateMachineRevisionId });
        this.version.applyRemovalPolicy(RemovalPolicy.RETAIN);
        new CfnOutput(this, 'PreparationVersionArn', { value: this.version.ref });
        Tags.of(this).add('ezil:namespace', d.namespace);
    }
}
