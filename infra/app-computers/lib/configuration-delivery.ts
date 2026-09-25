import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Construct } from 'constructs';
import { ArnFormat, CfnOutput, Duration, RemovalPolicy, Stack, aws_iam as iam, aws_lambda as lambda,
    aws_lambda_nodejs as nodejs, aws_stepfunctions as states, aws_ssm as ssm, aws_kms as kms,
    aws_logs as logs, aws_events as events, aws_events_targets as targets, aws_sqs as sqs,
    aws_cloudwatch as cloudwatch, aws_lambda_destinations as destinations } from 'aws-cdk-lib';
import { deliveryDefinition } from './delivery/definition.js';
import type { Settings } from './delivery/contract.js';

export interface ConfigurationDeliveryProps {
    /** All are trusted deployment settings; no secret values or user config. */
    settings: Omit<Settings, 'machineArn' | 'documentName'>;
    machineName: string;
    authorityKeyArn: string;
    /** Default off. Activation also requires scoped caller/host roles and pilot validation. */
    reconciliationEnabled?: boolean;
}

/** Independent from EC2 start/stop and the app scheduler. This construct cannot
 * create, attach, start or destroy a computer or volume. */
export class ConfigurationDelivery extends Construct {
    readonly machine: states.CfnStateMachine;
    readonly version: states.CfnStateMachineVersion;
    constructor(scope: Construct, id: string, props: ConfigurationDeliveryProps) {
        super(scope, id);
        const stack = Stack.of(this), s = props.settings;
        if (!/^[A-Za-z0-9_-]{1,60}$/.test(props.machineName) || stack.region !== 'us-east-1'
            || stack.account !== s.accountId) throw new Error('invalid_delivery_deployment');
        const source = readFileSync(join(__dirname, '../documents/configuration.json'), 'utf8');
        const documentName = `ezil-configuration-${s.stage}-${createHash('sha256').update(source).digest('hex').slice(0,16)}`;
        if ('documentName' in s && s.documentName !== documentName) throw new Error('invalid_delivery_document_name');
        const document = new ssm.CfnDocument(this, 'Document', { name: documentName, content: JSON.parse(source),
            documentType: 'Command', documentFormat: 'JSON', updateMethod: 'NewVersion' });
        document.applyRemovalPolicy(RemovalPolicy.RETAIN);
        const machineArn = stack.formatArn({ service: 'states', resource: 'stateMachine', resourceName: props.machineName,
            arnFormat: ArnFormat.COLON_RESOURCE_NAME });
        const executionArn = machineArn.replace(':stateMachine:', ':execution:') + ':*';
        const historyKey = new kms.Key(this, 'HistoryKey', { enableKeyRotation: true, removalPolicy: RemovalPolicy.RETAIN });
        const helperLogs = new logs.LogGroup(this, 'HelperLogs', { retention: logs.RetentionDays.ONE_WEEK,
            encryptionKey: historyKey, removalPolicy: RemovalPolicy.RETAIN });
        const helper = new nodejs.NodejsFunction(this, 'Helper', { runtime: lambda.Runtime.NODEJS_24_X,
            entry: join(__dirname, 'delivery/helper.ts'), handler: 'handler', timeout: Duration.seconds(35), memorySize: 256,
            reservedConcurrentExecutions: 2, depsLockFilePath: join(__dirname, '../package-lock.json'),
            bundling: { minify: true, sourceMap: false, externalModules: [] },
            environment: { EZIL_DELIVERY_SETTINGS: JSON.stringify({ ...s, machineArn, documentName }) },
            logGroup: helperLogs });
        helper.node.addDependency(document);
        helper.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: [executionArn] }));
        helper.addToRolePolicy(new iam.PolicyStatement({ actions: ['ec2:DescribeInstances', 'ec2:DescribeVolumes',
            'ssm:ListCommands', 'ssm:GetCommandInvocation'], resources: ['*'],
            conditions: { StringEquals: { 'aws:RequestedRegion': s.region } } })); // These read APIs do not support resource scoping
        helper.addToRolePolicy(new iam.PolicyStatement({ actions: ['secretsmanager:GetSecretValue'], resources: [s.authoritySecretArn] }));
        helper.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:Decrypt'], resources: [props.authorityKeyArn],
            conditions: { StringEquals: { 'kms:ViaService': `secretsmanager.${s.region}.amazonaws.com`,
                'kms:EncryptionContext:SecretARN': s.authoritySecretArn } } }));
        const helperVersion = helper.currentVersion;
        const makeMachine = (suffix: string, recovery: boolean) => {
            const role = new iam.Role(this, `${suffix}Role`, { assumedBy: new iam.ServicePrincipal('states.amazonaws.com', {
                conditions: { StringEquals: { 'aws:SourceAccount': s.accountId },
                    ArnEquals: { 'aws:SourceArn': recovery ? `${machineArn}-recovery` : machineArn } },
            }) });
            helperVersion.grantInvoke(role);
            historyKey.grantEncryptDecrypt(role);
            role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:SendCommand'], resources: [
                stack.formatArn({ service: 'ssm', resource: 'document', resourceName: documentName })] }));
            role.addToPolicy(new iam.PolicyStatement({ actions: ['ssm:SendCommand'], resources: [
                stack.formatArn({ service: 'ec2', resource: 'instance', resourceName: '*' })],
            conditions: { StringEquals: { 'ssm:resourceTag/ezil:managed-by': 'app-computer-platform',
                'ssm:resourceTag/ezil:stage': s.stage } } }));
            const log = new logs.LogGroup(this, `${suffix}Logs`, { retention: logs.RetentionDays.ONE_WEEK,
                removalPolicy: RemovalPolicy.RETAIN, encryptionKey: historyKey });
            role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:CreateLogDelivery', 'logs:GetLogDelivery',
                'logs:UpdateLogDelivery', 'logs:DeleteLogDelivery', 'logs:ListLogDeliveries',
                'logs:PutResourcePolicy', 'logs:DescribeResourcePolicies', 'logs:DescribeLogGroups'], resources: ['*'] }));
            const machine = new states.CfnStateMachine(this, suffix, { stateMachineName: props.machineName + (recovery ? '-recovery' : ''),
                stateMachineType: 'STANDARD', roleArn: role.roleArn,
                definitionString: JSON.stringify(deliveryDefinition(helperVersion.functionArn, recovery)),
                encryptionConfiguration: { type: 'CUSTOMER_MANAGED_KMS_KEY', kmsKeyId: historyKey.keyArn },
                loggingConfiguration: { level: 'ERROR', includeExecutionData: false,
                    destinations: [{ cloudWatchLogsLogGroup: { logGroupArn: log.logGroupArn + ':*' } }] } });
            machine.node.addDependency(role);
            historyKey.grantDecrypt(helper);
            new cloudwatch.Alarm(this, `${suffix}Failures`, { metric: new cloudwatch.Metric({ namespace: 'AWS/States',
                metricName: 'ExecutionsFailed', dimensionsMap: { StateMachineArn: machine.ref }, statistic: 'Sum',
                period: Duration.minutes(5) }), threshold: 1, evaluationPeriods: 1 });
            return machine;
        };
        this.machine = makeMachine('Delivery', false);
        this.version = new states.CfnStateMachineVersion(this, 'DeliveryVersion', { stateMachineArn: this.machine.ref,
            stateMachineRevisionId: this.machine.attrStateMachineRevisionId });
        const recovery = makeMachine('Recovery', true);
        const recoveryVersion = new states.CfnStateMachineVersion(this, 'RecoveryVersion', { stateMachineArn: recovery.ref,
            stateMachineRevisionId: recovery.attrStateMachineRevisionId });
        this.version.applyRemovalPolicy(RemovalPolicy.RETAIN); recoveryVersion.applyRemovalPolicy(RemovalPolicy.RETAIN);
        const reaperLogs = new logs.LogGroup(this, 'ReconcilerLogs', { retention: logs.RetentionDays.ONE_WEEK,
            encryptionKey: historyKey, removalPolicy: RemovalPolicy.RETAIN });
        const reaper = new nodejs.NodejsFunction(this, 'Reconciler', { runtime: lambda.Runtime.NODEJS_24_X,
            entry: join(__dirname, 'delivery/reconciler.ts'), handler: 'handler', timeout: Duration.minutes(2), memorySize: 256,
            reservedConcurrentExecutions: 1, depsLockFilePath: join(__dirname, '../package-lock.json'),
            bundling: { minify: true, sourceMap: false, externalModules: [] }, logGroup: reaperLogs,
            environment: { EZIL_DELIVERY_MACHINE_ARN: machineArn, EZIL_RECOVERY_VERSION_ARN: recoveryVersion.ref } });
        reaper.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:DescribeExecution'], resources: [executionArn] }));
        reaper.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:ListExecutions'], resources: [machineArn] }));
        reaper.addToRolePolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [recoveryVersion.ref] }));
        historyKey.grantEncryptDecrypt(reaper);
        const dlq = new sqs.Queue(this, 'ReconciliationFailures', { encryption: sqs.QueueEncryption.KMS,
            encryptionMasterKey: historyKey, retentionPeriod: Duration.days(7), removalPolicy: RemovalPolicy.RETAIN });
        // Lambda targets are asynchronous: function errors need their own DLQ
        // as well as EventBridge's delivery DLQ.
        reaper.configureAsyncInvoke({ retryAttempts: 2, maxEventAge: Duration.hours(1),
            onFailure: new destinations.SqsDestination(dlq) });
        const target = new targets.LambdaFunction(reaper, { deadLetterQueue: dlq, retryAttempts: 2, maxEventAge: Duration.hours(1) });
        new events.Rule(this, 'InterruptedDelivery', { enabled: props.reconciliationEnabled === true,
            eventPattern: { source: ['aws.states'], detailType: ['Step Functions Execution Status Change'],
                detail: { stateMachineArn: [machineArn], status: ['FAILED', 'TIMED_OUT', 'ABORTED'] } }, targets: [target] });
        new events.Rule(this, 'ReconciliationBackstop', { enabled: props.reconciliationEnabled === true,
            schedule: events.Schedule.rate(Duration.minutes(5)), targets: [target] });
        new cloudwatch.Alarm(this, 'ReconciliationDeadLetters', { metric: dlq.metricApproximateNumberOfMessagesVisible(),
            threshold: 1, evaluationPeriods: 1 });
        new CfnOutput(this, 'WorkflowVersionArn', { value: this.version.ref });
        new CfnOutput(this, 'DocumentName', { value: documentName });
    }
}
