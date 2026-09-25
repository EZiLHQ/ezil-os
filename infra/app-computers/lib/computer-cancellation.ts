import { join } from 'node:path';
import { Duration, RemovalPolicy, aws_cloudwatch as cloudwatch, aws_iam as iam, aws_kms as kms,
    aws_lambda as lambda, aws_lambda_nodejs as nodejs, aws_logs as logs, aws_stepfunctions as states } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { CancellationSettingsSchema, type CancellationSettings } from './lifecycle/cancellation-contract.js';
import { cancellationDefinition } from './lifecycle/cancellation-definition.js';
import { machineArn } from './lifecycle/recovery-contract.js';

/** No periodic or failure-triggered cancellation producer. Only the explicit
 * cancellation outbox may start this separately pinned Standard workflow. */
export class ComputerCancellation extends Construct {
    readonly machine: states.CfnStateMachine;
    readonly version: states.CfnStateMachineVersion;
    readonly historyKey: kms.Key;
    constructor(scope: Construct, id: string, props: { settings: CancellationSettings; sourceHistoryKey: kms.IKey; authorityKey: kms.IKey }) {
        super(scope, id);
        const s = CancellationSettingsSchema.parse(props.settings), d = s.lifecycle.deployment;
        const machine = machineArn(s.cancellationVersionArn), original = machineArn(d.stateMachineVersionArn);
        const key = this.historyKey = new kms.Key(this, 'HistoryKey', { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
        key.addToResourcePolicy(new iam.PolicyStatement({ principals: [new iam.ServicePrincipal('logs.us-east-1.amazonaws.com')],
            actions: ['kms:Encrypt*', 'kms:Decrypt*', 'kms:ReEncrypt*', 'kms:GenerateDataKey*', 'kms:Describe*'], resources: ['*'],
            conditions: { ArnLike: { 'kms:EncryptionContext:aws:logs:arn': `arn:aws:logs:us-east-1:${d.accountId}:log-group:*` } } }));
        const log = (name: string) => new logs.LogGroup(this, name, { encryptionKey: key,
            retention: logs.RetentionDays.ONE_WEEK, removalPolicy: RemovalPolicy.RETAIN });
        const observer = new nodejs.NodejsFunction(this, 'Observer', { entry: join(__dirname, 'lifecycle/cancellation-helper.ts'),
            handler: 'handler', runtime: lambda.Runtime.NODEJS_24_X, timeout: Duration.seconds(55), memorySize: 256,
            reservedConcurrentExecutions: 2, logGroup: log('ObserverLogs'), depsLockFilePath: join(__dirname, '../package-lock.json'),
            bundling: { minify: true, sourceMap: false, externalModules: [] }, environment: { EZIL_CANCELLATION_SETTINGS: JSON.stringify(s) } });
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: [
            original.replace(':stateMachine:', ':execution:') + ':computer-*', machine.replace(':stateMachine:', ':execution:') + ':cancel-computer-*'] }));
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:GetExecutionHistory'], resources: [original.replace(':stateMachine:', ':execution:') + ':computer-*'] }));
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances', 'ec2:DescribeVolumes'], resources: ['*'],
            conditions: { StringEquals: { 'aws:RequestedRegion': 'us-east-1' } } }));
        observer.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [s.cancellationSecretArn] }));
        props.authorityKey.grantDecrypt(observer); props.sourceHistoryKey.grantDecrypt(observer); key.grantDecrypt(observer);
        const role = new iam.Role(this, 'WorkflowRole', { assumedBy: new iam.ServicePrincipal('states.amazonaws.com', {
            conditions: { StringEquals: { 'aws:SourceAccount': d.accountId }, ArnEquals: { 'aws:SourceArn': machine } } }) });
        observer.currentVersion.grantInvoke(role); key.grantEncryptDecrypt(role); props.sourceHistoryKey.grantEncryptDecrypt(role);
        role.addToPolicy(new iam.PolicyStatement({ actions: ['states:StopExecution'], resources: [original.replace(':stateMachine:', ':execution:') + ':computer-*'] }));
        role.addToPolicy(new iam.PolicyStatement({ actions: ['ec2:StopInstances', 'ec2:TerminateInstances', 'ec2:ModifyInstanceAttribute'],
            resources: [`arn:aws:ec2:us-east-1:${d.accountId}:instance/*`], conditions: { StringEquals: {
                'aws:RequestedRegion': 'us-east-1', 'ec2:ResourceTag/ezil:managed-by': 'app-computer-platform', 'ec2:ResourceTag/ezil:stage': d.namespace } } }));
        role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogDelivery', 'logs:GetLogDelivery', 'logs:UpdateLogDelivery',
            'logs:DeleteLogDelivery', 'logs:ListLogDeliveries', 'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'], resources: ['*'] }));
        const workflowLog = log('WorkflowLogs');
        this.machine = new states.CfnStateMachine(this, 'Workflow', { stateMachineName: machine.split(':').at(-1), stateMachineType: 'STANDARD',
            roleArn: role.roleArn, definitionString: JSON.stringify(cancellationDefinition(observer.currentVersion.functionArn)),
            encryptionConfiguration: { type: 'CUSTOMER_MANAGED_KMS_KEY', kmsKeyId: key.keyArn },
            loggingConfiguration: { level: 'ERROR', includeExecutionData: false, destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: workflowLog.logGroupArn + ':*' } }] } });
        this.machine.node.addDependency(role);
        this.version = new states.CfnStateMachineVersion(this, 'Version', { stateMachineArn: this.machine.ref, stateMachineRevisionId: this.machine.attrStateMachineRevisionId });
        this.version.applyRemovalPolicy(RemovalPolicy.RETAIN);
        new cloudwatch.Alarm(this, 'FailureAlarm', { metric: new cloudwatch.Metric({ namespace: 'AWS/States', metricName: 'ExecutionsFailed',
            dimensionsMap: { StateMachineArn: this.machine.ref }, statistic: 'Sum', period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1 });
        new cloudwatch.Alarm(this, 'TimeoutAlarm', { metric: new cloudwatch.Metric({ namespace: 'AWS/States', metricName: 'ExecutionsTimedOut',
            dimensionsMap: { StateMachineArn: this.machine.ref }, statistic: 'Sum', period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1 });
    }
}
