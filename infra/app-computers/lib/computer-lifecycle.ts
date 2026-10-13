import { join } from 'node:path';
import { CfnOutput, Duration, RemovalPolicy, Stack, aws_cloudwatch as cloudwatch,
    aws_events as events, aws_iam as iam, aws_kms as kms, aws_lambda as lambda,
    aws_lambda_nodejs as nodejs, aws_logs as logs, aws_sqs as sqs, aws_stepfunctions as states } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { RETAG_KEYS, SettingsSchema, type Settings } from './lifecycle/contract.js';
import { lifecycleDefinition } from './lifecycle/definition.js';
import { GuardedTarget, ruleArn } from './guarded-target.js';

/** Shared graph and trusted control role; it does not allocate a computer.
 * Hosts launch with no instance role (R5), so there is no iam:PassRole here.
 * No app container gets these control-plane privileges. */
export class ComputerLifecycle extends Construct {
    readonly machine:states.CfnStateMachine;
    readonly version:states.CfnStateMachineVersion;
    readonly historyKey:kms.IKey;
    constructor(scope:Construct,id:string,props:{settings:Settings;authorityKeyArn:string;notificationsEnabled?:boolean}){
        super(scope,id);const s=SettingsSchema.parse(props.settings),d=s.deployment,stack=Stack.of(this),r=d.region;
        const machineArn=d.stateMachineVersionArn.slice(0,d.stateMachineVersionArn.lastIndexOf(':'));
        const machineName=machineArn.split(':').at(-1)!;
        if(!new RegExp(`^arn:aws:kms:${r}:${d.accountId}:key/[a-f0-9-]{36}$`).test(props.authorityKeyArn))throw new Error('invalid_authority_key');
        const key=new kms.Key(this,'HistoryKey',{enableKeyRotation:true,removalPolicy:RemovalPolicy.RETAIN});
        this.historyKey=key;
        key.addToResourcePolicy(new iam.PolicyStatement({principals:[new iam.ServicePrincipal(`logs.${r}.amazonaws.com`)],
            actions:['kms:Encrypt*','kms:Decrypt*','kms:ReEncrypt*','kms:GenerateDataKey*','kms:Describe*'],resources:['*'],
            conditions:{ArnLike:{'kms:EncryptionContext:aws:logs:arn':`arn:aws:logs:${r}:${d.accountId}:log-group:*`}}}));
        const helperLogs=new logs.LogGroup(this,'HelperLogs',{encryptionKey:key,retention:logs.RetentionDays.ONE_WEEK,removalPolicy:RemovalPolicy.RETAIN});
        const helper=new nodejs.NodejsFunction(this,'Observer',{entry:join(__dirname,'lifecycle/helper.ts'),handler:'handler',runtime:lambda.Runtime.NODEJS_24_X,
            timeout:Duration.seconds(55),memorySize:256,reservedConcurrentExecutions:2,logGroup:helperLogs,
            depsLockFilePath:join(__dirname,'../package-lock.json'),bundling:{minify:true,sourceMap:false,externalModules:[]},
            environment:{EZIL_LIFECYCLE_SETTINGS:JSON.stringify(s)}});
        helper.addToRolePolicy(new iam.PolicyStatement({actions:['ec2:DescribeInstances','ec2:DescribeVolumes','ec2:DescribeImages','ec2:DescribeLaunchTemplateVersions'],
            resources:['*'],conditions:{StringEquals:{'aws:RequestedRegion':r}}}));
        helper.addToRolePolicy(new iam.PolicyStatement({actions:['states:DescribeExecution'],resources:[machineArn.replace(':stateMachine:',':execution:')+':computer-*']}));
        helper.addToRolePolicy(new iam.PolicyStatement({actions:['secretsmanager:GetSecretValue'],resources:[s.authoritySecretArn]}));
        helper.addToRolePolicy(new iam.PolicyStatement({actions:['kms:Decrypt'],resources:[props.authorityKeyArn],
            conditions:{StringEquals:{'kms:ViaService':`secretsmanager.${r}.amazonaws.com`,'kms:EncryptionContext:SecretARN':s.authoritySecretArn}}}));
        key.grantDecrypt(helper);
        const role=new iam.Role(this,'ControllerRole',{assumedBy:new iam.ServicePrincipal('states.amazonaws.com',{
            conditions:{StringEquals:{'aws:SourceAccount':d.accountId},ArnEquals:{'aws:SourceArn':machineArn}}})});
        helper.currentVersion.grantInvoke(role);key.grantEncryptDecrypt(role);
        for(const statement of controllerStatements(s))role.addToPolicy(statement);
        const workflowLogs=new logs.LogGroup(this,'WorkflowLogs',{encryptionKey:key,retention:logs.RetentionDays.ONE_WEEK,removalPolicy:RemovalPolicy.RETAIN});
        role.addToPolicy(new iam.PolicyStatement({actions:['logs:CreateLogDelivery','logs:GetLogDelivery','logs:UpdateLogDelivery','logs:DeleteLogDelivery',
            'logs:ListLogDeliveries','logs:PutResourcePolicy','logs:DescribeResourcePolicies','logs:DescribeLogGroups'],resources:['*']}));
        this.machine=new states.CfnStateMachine(this,'Workflow',{stateMachineName:machineName,stateMachineType:'STANDARD',roleArn:role.roleArn,
            definitionString:JSON.stringify(lifecycleDefinition(helper.currentVersion.functionArn,s.features)),
            encryptionConfiguration:{type:'CUSTOMER_MANAGED_KMS_KEY',kmsKeyId:key.keyArn},
            loggingConfiguration:{level:'ERROR',includeExecutionData:false,destinations:[{cloudWatchLogsLogGroup:{logGroupArn:workflowLogs.logGroupArn+':*'}}]}});
        this.machine.node.addDependency(role);
        this.version=new states.CfnStateMachineVersion(this,'Version',{stateMachineArn:this.machine.ref,stateMachineRevisionId:this.machine.attrStateMachineRevisionId});
        this.version.applyRemovalPolicy(RemovalPolicy.RETAIN);
        const failures=new sqs.Queue(this,'UnconfirmedExecutions',{encryption:sqs.QueueEncryption.KMS,encryptionMasterKey:key,
            retentionPeriod:Duration.days(14),removalPolicy:RemovalPolicy.RETAIN});
        const dlq=new sqs.Queue(this,'NotificationFailures',{encryption:sqs.QueueEncryption.KMS,encryptionMasterKey:key,retentionPeriod:Duration.days(14),removalPolicy:RemovalPolicy.RETAIN});
        const unconfirmedRule=`ezil-${d.namespace}-lifecycle-unconfirmed`;
        new events.Rule(this,'Unconfirmed',{ruleName:unconfirmedRule,enabled:props.notificationsEnabled===true,eventPattern:{source:['aws.states'],detailType:['Step Functions Execution Status Change'],
            detail:{stateMachineArn:[machineArn],status:['FAILED','TIMED_OUT','ABORTED']}},
            targets:[new GuardedTarget({queue:failures,key},{ruleArn:ruleArn(r,d.accountId,unconfirmedRule),account:d.accountId,
                deadLetter:{queue:dlq,key},retryAttempts:2,maxEventAge:Duration.hours(1)})]});
        new cloudwatch.Alarm(this,'UnconfirmedAlarm',{metric:failures.metricApproximateNumberOfMessagesVisible(),threshold:1,evaluationPeriods:1});
        new cloudwatch.Alarm(this,'FailuresAlarm',{metric:new cloudwatch.Metric({namespace:'AWS/States',metricName:'ExecutionsFailed',
            dimensionsMap:{StateMachineArn:this.machine.ref},statistic:'Sum',period:Duration.minutes(5)}),threshold:1,evaluationPeriods:1});
        new CfnOutput(this,'WorkflowVersionArn',{value:this.version.ref});
        new CfnOutput(this,'UnconfirmedQueueUrl',{value:failures.queueUrl});
    }
}

/** The lifecycle controller's EC2/KMS rights. Exported for tests. */
export function controllerStatements(s:Settings):iam.PolicyStatement[]{
    const d=s.deployment,r=d.region;
    const arn=(kind:string,id='*')=>`arn:aws:ec2:${r}:${d.accountId}:${kind}/${id}`;
    const region={'aws:RequestedRegion':r};
    const managed={'ec2:ResourceTag/ezil:managed-by':'app-computer-platform','ec2:ResourceTag/ezil:stage':d.namespace};
    const existing={StringEquals:{...region,...managed}};
    const requestTags={...region,'aws:RequestTag/ezil:managed-by':'app-computer-platform','aws:RequestTag/ezil:stage':d.namespace};
    const template={ArnEquals:{'ec2:LaunchTemplate':arn('launch-template',d.launchTemplateId)}};
    // C-6 nonce delivery to a stopped instance. The Deny on every other
    // attribute is narrowed only once staging has proven how ec2:Attribute
    // evaluates; until then ModifyInstanceAttribute stays denied outright.
    const userDataOpen=s.features.userDataNonce&&s.features.userDataAttributeKeyVerified;
    const denied=DENIED_ACTIONS.filter(a=>!(userDataOpen&&a==='ec2:ModifyInstanceAttribute'));
    return [
        // ModifyInstanceAttribute is never allowed for type, disk flags or
        // anything but userData (R10, C-6).
        new iam.PolicyStatement({actions:['ec2:StartInstances','ec2:StopInstances','ec2:TerminateInstances'],
            resources:[arn('instance')],conditions:existing}),
        new iam.PolicyStatement({actions:['ec2:AttachVolume'],resources:[arn('instance'),arn('volume')],
            conditions:{StringEquals:{...region,...managed,'ec2:AvailabilityZoneId':d.zoneId}}}),
        // R1/R11: data volumes only in the configured ZoneId, encrypted with the
        // configured key, gp3, inside the configured size range.
        new iam.PolicyStatement({actions:['ec2:CreateVolume'],resources:[arn('volume')],conditions:{
            StringEquals:{...requestTags,'ec2:VolumeType':'gp3','ec2:AvailabilityZoneId':d.zoneId},
            ArnEquals:{'ec2:KmsKeyId':d.dataKeyArn},Bool:{'ec2:Encrypted':'true'},
            NumericGreaterThanEquals:{'ec2:VolumeSize':String(d.storage.dataMinGiB)},
            NumericLessThanEquals:{'ec2:VolumeSize':String(d.storage.dataMaxGiB)}}}),
        new iam.PolicyStatement({actions:['ec2:RunInstances'],resources:[
            `arn:aws:ec2:${r}::image/${d.amiId}`,arn('subnet',d.subnetId),arn('security-group',d.securityGroupId),arn('launch-template',d.launchTemplateId),arn('network-interface')],
            conditions:{StringEquals:region,...template}}),
        // R5/R10: closed type allowlist, IMDSv2 with hop limit 1, metadata
        // tags off, no instance profile, and only in the configured ZoneId.
        new iam.PolicyStatement({actions:['ec2:RunInstances'],resources:[arn('instance')],conditions:{
            StringEquals:{...requestTags,'ec2:InstanceType':[...d.instanceTypes],'ec2:MetadataHttpTokens':'required',
                'ec2:InstanceMetadataTags':'disabled','ec2:AvailabilityZoneId':d.zoneId},
            NumericLessThanEquals:{'ec2:MetadataHttpPutResponseHopLimit':'1'},
            Null:{'ec2:InstanceProfile':'true'},...template}}),
        // The disposable root disk: encrypted gp3 no larger than configured.
        new iam.PolicyStatement({actions:['ec2:RunInstances'],resources:[arn('volume')],conditions:{
            StringEquals:{...requestTags,'ec2:VolumeType':'gp3'},Bool:{'ec2:Encrypted':'true'},
            NumericLessThanEquals:{'ec2:VolumeSize':String(d.storage.rootGiB)},...template}}),
        // Identity tags are written only by the creating call.
        new iam.PolicyStatement({actions:['ec2:CreateTags'],resources:[arn('instance'),arn('volume')],conditions:{
            StringEquals:{...region,'ec2:CreateAction':['RunInstances','CreateVolume']}}}),
        // A managed volume's generation and fence may move; nothing else.
        new iam.PolicyStatement({actions:['ec2:CreateTags'],resources:[arn('volume')],conditions:{...existing,
            'ForAllValues:StringEquals':{'aws:TagKeys':[...RETAG_KEYS]},Null:{'aws:TagKeys':'false'}}}),
        new iam.PolicyStatement({effect:iam.Effect.DENY,actions:['ec2:CreateTags'],resources:['*'],conditions:{
            'ForAnyValue:StringEquals':{'aws:TagKeys':[...IDENTITY_TAG_KEYS]},Null:{'ec2:CreateAction':'true'}}}),
        new iam.PolicyStatement({effect:iam.Effect.DENY,actions:denied,resources:['*']}),
        ...(userDataOpen?[
            new iam.PolicyStatement({actions:['ec2:ModifyInstanceAttribute'],resources:[arn('instance')],
                conditions:{StringEquals:{...region,...managed,'ec2:Attribute':'userData'}}}),
            new iam.PolicyStatement({effect:iam.Effect.DENY,actions:['ec2:ModifyInstanceAttribute'],resources:['*'],
                conditions:{StringNotEquals:{'ec2:Attribute':'userData'}}}),
            new iam.PolicyStatement({effect:iam.Effect.DENY,actions:['ec2:ModifyInstanceAttribute'],resources:['*'],
                conditions:{Null:{'ec2:Attribute':'true'}}}),
        ]:[]),
        new iam.PolicyStatement({actions:['kms:Decrypt','kms:Encrypt','kms:GenerateDataKeyWithoutPlaintext','kms:ReEncrypt*','kms:DescribeKey'],resources:[d.dataKeyArn],
            conditions:{StringEquals:{'kms:ViaService':`ec2.${r}.amazonaws.com`}}}),
        new iam.PolicyStatement({actions:['kms:CreateGrant'],resources:[d.dataKeyArn],conditions:{Bool:{'kms:GrantIsForAWSResource':'true'},
            StringEquals:{'kms:ViaService':`ec2.${r}.amazonaws.com`}}}),
    ];
}
/** R11 and R5: automation never deletes storage, never detaches (and so never
 * force-detaches), never edits instances in place and never passes a role. */
export const DENIED_ACTIONS=['ec2:DeleteVolume','ec2:DeleteSnapshot','ec2:DetachVolume','ec2:ModifyInstanceAttribute',
    'ec2:ModifyInstanceMetadataOptions','ec2:DeleteTags','iam:PassRole'] as const;
export const IDENTITY_TAG_KEYS=['ezil:computer-id','ezil:managed-by','ezil:stage'] as const;
