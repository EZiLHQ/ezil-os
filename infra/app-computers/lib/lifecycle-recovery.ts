import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, aws_cloudwatch as cloudwatch, aws_events as events,
    aws_events_targets as targets, aws_iam as iam, aws_kms as kms, aws_lambda as lambda,
    aws_lambda_nodejs as nodejs, aws_logs as logs, aws_sqs as sqs, aws_stepfunctions as states } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RecoverySettingsSchema, machineArn, type RecoverySettings } from './lifecycle/recovery-contract.js';
import { recoveryDefinition } from './lifecycle/recovery-definition.js';

export class ComputerLifecycleRecovery extends Construct {
    readonly machine: states.CfnStateMachine;
    readonly version: states.CfnStateMachineVersion;
    constructor(scope: Construct, id: string, props: { settings: RecoverySettings; sourceHistoryKey: kms.IKey; enabled?: boolean }) {
        super(scope, id);
        const s = RecoverySettingsSchema.parse(props.settings), d = s.lifecycle.deployment;
        const originalMachine = machineArn(d.stateMachineVersionArn), recoveryMachine = machineArn(s.recoveryVersionArn);
        const key = new kms.Key(this, 'HistoryKey', { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
        key.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('logs.us-east-1.amazonaws.com')],
            actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'], resources: ['*'],
            conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:us-east-1:${d.accountId}:log-group:*` } } }));
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
            conditions: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } } }));
        props.sourceHistoryKey.grantDecrypt(observer); key.grantDecrypt(observer);
        const role = new iam.Role(this, 'RecoveryRole', { assumedBy: new iam.ServicePrincipal('states.amazonaws.com', {
            conditions: { StringEquals: { 'aws:SourceAccount': d.accountId }, ArnEquals: { 'aws:SourceArn': recoveryMachine } } }) });
        observer.currentVersion.grantInvoke(role); key.grantEncryptDecrypt(role);
        role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:ModifyInstanceAttribute'],
            resources: [`arn:aws:ec2:us-east-1:${d.accountId}:instance/*`], conditions: { StringEquals: {
                'aws:RequestedRegion': 'us-east-1', 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform',
                'ec2:ResourceTag/ezil:stage': d.namespace } } }));
        role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery',
            'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'], resources: ['*'] }));
        const workflowLogs = log('WorkflowLogs');
        this.machine = new states.CfnStateMachine(this, 'Workflow', { stateMachineName: recoveryMachine.split(':').at(-1),
            stateMachineType: 'STANDARD', roleArn: role.roleArn, definitionString: JSON.stringify(recoveryDefinition(observer.currentVersion.functionArn)),
            encryptionConfiguration: { type: 'CUSTOMER_MANAGED_KMS_KEY', kmsKeyId: key.keyArn },
            loggingConfiguration: { level: 'ERROR', includeExecutionData: false,
                destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: workflowLogs.logGroupArn + ':*' } }] } });
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
        dispatcher.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [s.recoveryVersionArn] }));
        props.sourceHistoryKey.grantDecrypt(dispatcher); key.grantEncryptDecrypt(dispatcher);
        new events.Rule(this, 'Interrupted', { enabled: props.enabled === true,
            eventPattern: { source: ['aws.states'], detailType: ['Step Functions Execution Status Change'],
                detail: { stateMachineArn: [originalMachine], status: ['FAILED', 'TIMED_OUT', 'ABORTED'] } },
            targets: [new targets.LambdaFunction(dispatcher, { deadLetterQueue: dlq, retryAttempts: 2, maxEventAge: Duration.hours(1) })] });
        new events.Rule(this, 'Backstop', { enabled: props.enabled === true, schedule: events.Schedule.rate(Duration.minutes(5)),
            targets: [new targets.LambdaFunction(dispatcher, { deadLetterQueue: dlq, retryAttempts: 2, maxEventAge: Duration.hours(1) })] });
        new events.Rule(this, 'FailedRecovery', { enabled: props.enabled === true,
            eventPattern: { source: ['aws.states'], detailType: ['Step Functions Execution Status Change'],
                detail: { stateMachineArn: [recoveryMachine], status: ['FAILED', 'TIMED_OUT', 'ABORTED'] } },
            targets: [new targets.SqsQueue(dlq)] });
        new cloudwatch.Alarm(this, 'UnconfirmedAlarm', { metric: dlq.metricApproximateNumberOfMessagesVisible(), threshold: 1, evaluationPeriods: 1 });
        new cloudwatch.Alarm(this, 'RecoveryFailureAlarm', { metric: new cloudwatch.Metric({ namespace: 'AWS/States', metricName: 'ExecutionsFailed',
            dimensionsMap: { StateMachineArn: this.machine.ref }, statistic: 'Sum', period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1 });
        new CfnOutput(this, 'RecoveryVersionArn', { value: this.version.ref });
        new CfnOutput(this, 'RecoveryQueueUrl', { value: dlq.queueUrl });
    }
}
