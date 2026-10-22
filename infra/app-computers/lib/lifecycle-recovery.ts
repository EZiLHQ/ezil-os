import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Tags, aws_cloudwatch as cloudwatch, aws_events as events,
    aws_iam as iam, aws_kms as kms, aws_lambda as lambda,
    aws_lambda_nodejs as nodejs, aws_logs as logs, aws_sqs as sqs, aws_stepfunctions as states } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RecoverySettingsSchema, machineArn, type RecoverySettings } from './lifecycle/recovery-contract.js';
import { recoveryDefinition } from './lifecycle/recovery-definition.js';
import { DENIED_ACTIONS } from './computer-lifecycle.js';
import { GuardedTarget, ruleArn } from './guarded-target.js';
import { historyReadStatement, imageWorkflowDenies } from './rebase-preparation.js';
import { applyImageJobBoundary, recoveryRestoreStatements } from './image-job-boundary.js';
import { startVersionStatements, registerImageWorkflow, registeredImageWorkflows } from './app-caller.js';

export class ComputerLifecycleRecovery extends Construct {
    readonly machine: states.CfnStateMachine;
    readonly historyKey: kms.IKey;
    readonly version: states.CfnStateMachineVersion;
    constructor(scope: Construct, id: string, props: { settings: RecoverySettings; sourceHistoryKey: kms.IKey; enabled?: boolean }) {
        super(scope, id);
        const s = RecoverySettingsSchema.parse(props.settings), d = s.lifecycle.deployment, r = d.region;
        const originalMachine = machineArn(d.stateMachineVersionArn), recoveryMachine = machineArn(s.recoveryVersionArn);
        const key = new kms.Key(this, 'HistoryKey', { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
        this.historyKey = key;
        Tags.of(key).add('ezil:namespace', d.namespace);
        key.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal(`logs.${r}.amazonaws.com`)],
            actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'], resources: ['*'],
            conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:${r}:${d.accountId}:log-group:*` } } }));
        // Step Functions docs: an encrypted state machine with logging needs vended-log delivery to decrypt.
        key.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')], actions: ['kms:Decrypt'], resources: ['*'] }));
        const log = (name: string) => new logs.LogGroup(this, name, { encryptionKey: key,
            retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN });
        const observer = new nodejs.NodejsFunction(this, 'Observer', {
            entry: join(__dirname, 'lifecycle/recovery-helper.ts'), handler: 'handler', runtime: lambda.Runtime.NODEJS_24_X,
            timeout: Duration.seconds(55), memorySize: 256, reservedConcurrentExecutions: 2, logGroup: log('ObserverLogs'),
            depsLockFilePath: join(__dirname, '../package-lock.json'), bundling: { minify: true, sourceMap: false, externalModules: [] },
            environment: { EZIL_LIFECYCLE_RECOVERY_SETTINGS: JSON.stringify(s) },
        });
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: [
            originalMachine.replace(':stateMachine:', ':execution:') + ':computer-*',
            recoveryMachine.replace(':stateMachine:', ':execution:') + ':cleanup-computer-*'] }));
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:GetExecutionHistory'],
            resources: [originalMachine.replace(':stateMachine:', ':execution:') + ':computer-*'] }));
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances', 'ec2:DescribeVolumes'], resources: ['*'],
            conditions: { StringEquals: { 'aws:RequestedRegion': r } } }));
        if (!d.preparationStateMachineVersionArn) props.sourceHistoryKey.grantDecrypt(observer);
        if (d.preparationStateMachineVersionArn) observer.addToRolePolicy(historyReadStatement(r, key.keyArn, [s.recoveryVersionArn]));
        else key.grantDecrypt(observer);
        if (d.preparationStateMachineVersionArn) {
            const registration = registeredImageWorkflows(this, d.stateMachineVersionArn).find(v => v.version === d.preparationStateMachineVersionArn);
            if (!registration?.authorityKeyArn) throw new Error('preparation_authority_wiring_missing');
            observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeSnapshots', 'ec2:DescribeImages', 'ec2:DescribeLaunchTemplateVersions'], resources: ['*'],
                conditions: { StringEquals: { 'aws:RequestedRegion': r } } }));
            observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: [
                machineArn(d.preparationStateMachineVersionArn).replace(':stateMachine:', ':execution:') + ':computer-*',
                recoveryMachine.replace(':stateMachine:', ':execution:') + ':computer-*'] }));
            observer.addToRolePolicy(historyReadStatement(r, props.sourceHistoryKey.keyArn, [d.preparationStateMachineVersionArn, d.stateMachineVersionArn]));
            observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [s.lifecycle.authoritySecretArn] }));
            observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [registration.authorityKeyArn], conditions: { StringEquals: {
                'kms:ViaService': `secretsmanager.${r}.amazonaws.com`, 'kms:EncryptionContext:SecretARN': s.lifecycle.authoritySecretArn } } }));
            registerImageWorkflow(this, d.stateMachineVersionArn, s.recoveryVersionArn, key.keyArn);
        }
        const role = new iam.Role(this, 'RecoveryRole', { ...(d.preparationStateMachineVersionArn ? { roleName: `ezil-${d.namespace}-recovery`, path: `/ezil/${d.namespace}/` } : {}), assumedBy: new iam.ServicePrincipal('states.amazonaws.com', {
            conditions: { StringEquals: { 'aws:SourceAccount': d.accountId }, ArnEquals: { 'aws:SourceArn': recoveryMachine } } }) });
        if (d.preparationStateMachineVersionArn) {
            applyImageJobBoundary(role, d);
            for (const statement of recoveryRestoreStatements(d)) role.addToPolicy(statement);
            role.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: [...imageWorkflowDenies, 'ec2:CopySnapshot', 'ec2:ModifySnapshotAttribute', 'ec2:ResetSnapshotAttribute'], resources: ['*'] }));
        }
        observer.currentVersion.grantInvoke(role); key.grantEncryptDecrypt(role);
        role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:StopInstances', 'ec2:TerminateInstances'],
            resources: [`arn:aws:ec2:${r}:${d.accountId}:instance/*`], conditions: { StringEquals: {
                'aws:RequestedRegion': r, 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform',
                'ec2:ResourceTag/ezil:stage': d.namespace } } }));
        role.addToPolicy(new iam.PolicyStatement({ effect: iam.Effect.DENY, actions: [...DENIED_ACTIONS,'ec2:DetachVolume','ec2:DeleteTags'], resources: ['*'] }));
        role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery',
            'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'], resources: ['*'] }));
        const workflowLogs = log('WorkflowLogs');
        this.machine = new states.CfnStateMachine(this, 'Workflow', { stateMachineName: recoveryMachine.split(':').at(-1),
            stateMachineType: 'STANDARD', roleArn: role.roleArn, definitionString: JSON.stringify(recoveryDefinition(observer.currentVersion.functionArn, !!d.preparationStateMachineVersionArn)),
            encryptionConfiguration: { type: 'CUSTOMER_MANAGED_KMS_KEY', kmsKeyId: key.keyArn },
            loggingConfiguration: { level: 'ERROR', includeExecutionData: false,
                destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: workflowLogs.logGroupArn } }] } });
        this.machine.node.addDependency(role);
        this.version = new states.CfnStateMachineVersion(this, 'Version', {
            stateMachineArn: this.machine.ref, stateMachineRevisionId: this.machine.attrStateMachineRevisionId });
        this.version.applyRemovalPolicy(RemovalPolicy.RETAIN);
        const dlq = new sqs.Queue(this, 'Unconfirmed', { encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: key,
            retentionPeriod: Duration.days(14), removalPolicy: RemovalPolicy.RETAIN });
        const dispatcher = new nodejs.NodejsFunction(this, 'Reconciler', {
            entry: join(__dirname, 'lifecycle/reconciler.ts'), handler: 'handler', runtime: lambda.Runtime.NODEJS_24_X,
            timeout: Duration.seconds(120), memorySize: 256, reservedConcurrentExecutions: 1, logGroup: log('ReconcilerLogs'),
            depsLockFilePath: join(__dirname, '../package-lock.json'), bundling: { minify: true, sourceMap: false, externalModules: [] },
            environment: { EZIL_LIFECYCLE_RECOVERY_SETTINGS: JSON.stringify(s) },
            deadLetterQueue: dlq, retryAttempts: 1,
        });
        dispatcher.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'],
            resources: [originalMachine.replace(':stateMachine:', ':execution:') + ':computer-*'] }));
        dispatcher.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:ListExecutions'], resources: [originalMachine, d.stateMachineVersionArn] }));
        for (const statement of startVersionStatements([s.recoveryVersionArn])) dispatcher.addToRolePolicy(statement);
        props.sourceHistoryKey.grantDecrypt(dispatcher); key.grantEncryptDecrypt(dispatcher);
        // Every events.amazonaws.com grant names its exact rule and account.
        const names = { interrupted: `ezil-${d.namespace}-recovery-interrupted`, backstop: `ezil-${d.namespace}-recovery-backstop`,
            failed: `ezil-${d.namespace}-recovery-failed` };
        const guarded = (destination: ConstructorParameters<typeof GuardedTarget>[0], name: string, withDlq: boolean) =>
            new GuardedTarget(destination, { ruleArn: ruleArn(r, d.accountId, name), account: d.accountId,
                ...(withDlq ? { deadLetter: { queue: dlq, key }, retryAttempts: 2, maxEventAge: Duration.hours(1) } : {}) });
        new events.Rule(this, 'Interrupted', { ruleName: names.interrupted, enabled: props.enabled === true,
            eventPattern: { source: ['aws.states'], detailType: ['Step Functions Execution Status Change'],
                detail: { stateMachineArn: [originalMachine], status: ['FAILED', 'TIMED_OUT', 'ABORTED'] } },
            targets: [guarded({ fn: dispatcher }, names.interrupted, true)] });
        new events.Rule(this, 'Backstop', { ruleName: names.backstop, enabled: props.enabled === true, schedule: events.Schedule.rate(Duration.minutes(5)),
            targets: [guarded({ fn: dispatcher }, names.backstop, true)] });
        new events.Rule(this, 'FailedRecovery', { ruleName: names.failed, enabled: props.enabled === true,
            eventPattern: { source: ['aws.states'], detailType: ['Step Functions Execution Status Change'],
                detail: { stateMachineArn: [recoveryMachine], status: ['FAILED', 'TIMED_OUT', 'ABORTED'] } },
            targets: [guarded({ queue: dlq, key }, names.failed, false)] });
        new cloudwatch.Alarm(this, 'UnconfirmedAlarm', { metric: dlq.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1 });
        new cloudwatch.Alarm(this, 'RecoveryFailureAlarm', { metric: new cloudwatch.Metric({ namespace: 'AWS/States', metricName: 'ExecutionsFailed',
            dimensionsMap: { StateMachineArn: this.machine.ref }, statistic: 'Sum', period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1 });
        new CfnOutput(this, 'RecoveryVersionArn', { value: this.version.ref });
        new CfnOutput(this, 'RecoveryQueueUrl', { value: dlq.queueUrl });
    }
}
