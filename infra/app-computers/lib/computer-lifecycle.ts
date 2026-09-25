import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, aws_cloudwatch as cloudwatch,
    aws_events as events, aws_events_targets as targets, aws_iam as iam, aws_kms as kms, aws_lambda as lambda,
    aws_lambda_nodejs as nodejs, aws_logs as logs, aws_sqs as sqs, aws_stepfunctions as states } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { SettingsSchema, type Settings } from './lifecycle/contract.js';
import { lifecycleDefinition } from './lifecycle/definition.js';

/** Shared graph and trusted control role; it does not allocate a computer.
 * Per-writer instance profiles must be provisioned separately with scoped host
 * access. No app container gets these control-plane privileges. */
export class ComputerLifecycle extends Construct {
    readonly machine:states.CfnStateMachine;
    readonly version:states.CfnStateMachineVersion;
    constructor(scope:Construct,id:string,props:{settings:Settings;authorityKeyArn:string;notificationsEnabled?:boolean}){
        super(scope,id);const s=SettingsSchema.parse(props.settings),d=s.deployment,stack=Stack.of(this);
        const machineArn=d.stateMachineVersionArn.slice(0,d.stateMachineVersionArn.lastIndexOf(':'));
        const machineName=machineArn.split(':').at(-1)!;
        if(!new RegExp(`^arn:aws:kms:us-east-1:${d.accountId}:key/[a-f0-9-]{36}$`).test(props.authorityKeyArn))throw new Error('invalid_authority_key');
        const key=new kms.Key(this,'HistoryKey',{enableKeyRotation:true,removalPolicy:RemovalPolicy.RETAIN});
        key.addToResourcePolicy(new iam.PolicyStatement({principals:[new iam.ServicePrincipal('logs.us-east-1.amazonaws.com')],
            actions:['kms:Encrypt*','kms:Decrypt*','kms:ReEncrypt*','kms:GenerateDataKey*','kms:Describe*'],resources:['*'],
            conditions:{ArnLike:{'kms:EncryptionContext:aws:logs:arn':`arn:aws:logs:us-east-1:${d.accountId}:log-group:*`}}}));
        const helperLogs=new logs.LogGroup(this,'HelperLogs',{encryptionKey:key,retention:logs.RetentionDays.ONE_WEEK,removalPolicy:RemovalPolicy.RETAIN});
        const helper=new nodejs.NodejsFunction(this,'Observer',{entry:join(__dirname,'lifecycle/helper.ts'),handler:'handler',runtime:lambda.Runtime.NODEJS_24_X,
            timeout:Duration.seconds(55),memorySize:256,reservedConcurrentExecutions:2,logGroup:helperLogs,
            depsLockFilePath:join(__dirname,'../package-lock.json'),bundling:{minify:true,sourceMap:false,externalModules:[]},
            environment:{EZIL_LIFECYCLE_SETTINGS:JSON.stringify(s)}});
        helper.addToRolePolicy(new iam.PolicyStatement({actions:['ec2:DescribeInstances','ec2:DescribeVolumes','ec2:DescribeImages','ec2:DescribeLaunchTemplateVersions'],
            resources:['*'],conditions:{StringEquals:{'aws:RequestedRegion':'us-east-1'}}}));
        helper.addToRolePolicy(new iam.PolicyStatement({actions:['states:DescribeExecution'],resources:[machineArn.replace(':stateMachine:',':execution:')+':computer-*']}));
        helper.addToRolePolicy(new iam.PolicyStatement({actions:['secretsmanager:GetSecretValue'],resources:[s.authoritySecretArn]}));
        helper.addToRolePolicy(new iam.PolicyStatement({actions:['kms:Decrypt'],resources:[props.authorityKeyArn],
            conditions:{StringEquals:{'kms:ViaService':'secretsmanager.us-east-1.amazonaws.com','kms:EncryptionContext:SecretARN':s.authoritySecretArn}}}));
        key.grantDecrypt(helper);
        const role=new iam.Role(this,'ControllerRole',{assumedBy:new iam.ServicePrincipal('states.amazonaws.com',{
            conditions:{StringEquals:{'aws:SourceAccount':d.accountId},ArnEquals:{'aws:SourceArn':machineArn}}})});
        helper.currentVersion.grantInvoke(role);key.grantEncryptDecrypt(role);
        const arn=(kind:string,id='*')=>`arn:aws:ec2:us-east-1:${d.accountId}:${kind}/${id}`;
        const region={'aws:RequestedRegion':'us-east-1'};
        const existing={StringEquals:{...region,'ec2:ResourceTag/ezil:managed-by':'app-computer-platform','ec2:ResourceTag/ezil:stage':d.namespace}};
        role.addToPolicy(new iam.PolicyStatement({actions:['ec2:StartInstances','ec2:StopInstances','ec2:TerminateInstances','ec2:ModifyInstanceAttribute'],
            resources:[arn('instance')],conditions:existing}));
        role.addToPolicy(new iam.PolicyStatement({actions:['ec2:AttachVolume'],resources:[arn('instance'),arn('volume')],conditions:existing}));
        const requestTags={...region,'aws:RequestTag/ezil:managed-by':'app-computer-platform','aws:RequestTag/ezil:stage':d.namespace};
        role.addToPolicy(new iam.PolicyStatement({actions:['ec2:CreateVolume'],resources:[arn('volume')],conditions:{StringEquals:{...requestTags,'ec2:VolumeType':'gp3'},
            Bool:{'ec2:Encrypted':'true'},NumericEquals:{'ec2:VolumeSize':'50'}}}));
        role.addToPolicy(new iam.PolicyStatement({actions:['ec2:RunInstances'],resources:[
            `arn:aws:ec2:us-east-1::image/${d.amiId}`,arn('subnet',d.subnetId),arn('security-group',d.securityGroupId),arn('launch-template',d.launchTemplateId),arn('network-interface')],
            conditions:{StringEquals:region,ArnEquals:{'ec2:LaunchTemplate':arn('launch-template',d.launchTemplateId)}}}));
        role.addToPolicy(new iam.PolicyStatement({actions:['ec2:RunInstances'],resources:[arn('instance'),arn('volume')],
            conditions:{StringEquals:requestTags,StringEqualsIfExists:{'ec2:InstanceType':'m7i.large'},ArnEquals:{'ec2:LaunchTemplate':arn('launch-template',d.launchTemplateId)}}}));
        role.addToPolicy(new iam.PolicyStatement({actions:['ec2:CreateTags'],resources:[arn('instance'),arn('volume')],conditions:{
            StringEquals:{...region,'ec2:CreateAction':['RunInstances','CreateVolume']}}}));
        role.addToPolicy(new iam.PolicyStatement({actions:['ec2:CreateTags'],resources:[arn('volume')],conditions:{...existing,
            'ForAllValues:StringEquals':{'aws:TagKeys':['ezil:managed-by','ezil:stage','ezil:computer-id','ezil:generation','ezil:fence-token']}}}));
        role.addToPolicy(new iam.PolicyStatement({actions:['iam:PassRole'],resources:[`arn:aws:iam::${d.accountId}:role/${s.writerRolePathPrefix}/*/g*`],
            conditions:{StringEquals:{'iam:PassedToService':'ec2.amazonaws.com'}}}));
        role.addToPolicy(new iam.PolicyStatement({actions:['kms:Decrypt','kms:Encrypt','kms:GenerateDataKeyWithoutPlaintext','kms:ReEncrypt*','kms:DescribeKey'],resources:[d.dataKeyArn],
            conditions:{StringEquals:{'kms:ViaService':'ec2.us-east-1.amazonaws.com'}}}));
        role.addToPolicy(new iam.PolicyStatement({actions:['kms:CreateGrant'],resources:[d.dataKeyArn],conditions:{Bool:{'kms:GrantIsForAWSResource':'true'},
            StringEquals:{'kms:ViaService':'ec2.us-east-1.amazonaws.com'}}}));
        const workflowLogs=new logs.LogGroup(this,'WorkflowLogs',{encryptionKey:key,retention:logs.RetentionDays.ONE_WEEK,removalPolicy:RemovalPolicy.RETAIN});
        role.addToPolicy(new iam.PolicyStatement({actions:['logs:CreateLogDelivery','logs:GetLogDelivery','logs:UpdateLogDelivery','logs:DeleteLogDelivery',
            'logs:ListLogDeliveries','logs:PutResourcePolicy','logs:DescribeResourcePolicies','logs:DescribeLogGroups'],resources:['*']}));
        this.machine=new states.CfnStateMachine(this,'Workflow',{stateMachineName:machineName,stateMachineType:'STANDARD',roleArn:role.roleArn,
            definitionString:JSON.stringify(lifecycleDefinition(helper.currentVersion.functionArn)),
            encryptionConfiguration:{type:'CUSTOMER_MANAGED_KMS_KEY',kmsKeyId:key.keyArn},
            loggingConfiguration:{level:'ERROR',includeExecutionData:false,destinations:[{cloudWatchLogsLogGroup:{logGroupArn:workflowLogs.logGroupArn+':*'}}]}});
        this.machine.node.addDependency(role);
        this.version=new states.CfnStateMachineVersion(this,'Version',{stateMachineArn:this.machine.ref,stateMachineRevisionId:this.machine.attrStateMachineRevisionId});
        this.version.applyRemovalPolicy(RemovalPolicy.RETAIN);
        const failures=new sqs.Queue(this,'UnconfirmedExecutions',{encryption:sqs.QueueEncryption.KMS,encryptionMasterKey:key,
            retentionPeriod:Duration.days(14),removalPolicy:RemovalPolicy.RETAIN});
        const dlq=new sqs.Queue(this,'NotificationFailures',{encryption:sqs.QueueEncryption.KMS,encryptionMasterKey:key,retentionPeriod:Duration.days(14),removalPolicy:RemovalPolicy.RETAIN});
        new events.Rule(this,'Unconfirmed',{enabled:props.notificationsEnabled===true,eventPattern:{source:['aws.states'],detailType:['Step Functions Execution Status Change'],
            detail:{stateMachineArn:[machineArn],status:['FAILED','TIMED_OUT','ABORTED']}},
            targets:[new targets.SqsQueue(failures,{deadLetterQueue:dlq,retryAttempts:2,maxEventAge:Duration.hours(1)})]});
        new cloudwatch.Alarm(this,'UnconfirmedAlarm',{metric:failures.metricApproximateNumberOfMessagesVisible(),threshold:1,evaluationPeriods:1});
        new cloudwatch.Alarm(this,'FailuresAlarm',{metric:new cloudwatch.Metric({namespace:'AWS/States',metricName:'ExecutionsFailed',
            dimensionsMap:{StateMachineArn:this.machine.ref},statistic:'Sum',period:Duration.minutes(5)}),threshold:1,evaluationPeriods:1});
        new CfnOutput(this,'WorkflowVersionArn',{value:this.version.ref});
        new CfnOutput(this,'UnconfirmedQueueUrl',{value:failures.queueUrl});
    }
}
