import { CfnOutput, Stack, type StackProps, aws_budgets as budgets, aws_cloudwatch as cloudwatch, aws_dlm as dlm,
    aws_iam as iam, aws_sns as sns } from 'aws-cdk-lib';
import type { Construct } from 'constructs';
import { z } from 'zod';
import { REGION_PATTERN } from './lifecycle/deployment.js';
import { BACKUP_TAG } from './lifecycle/contract.js';
import { NamespaceSchema } from './lifecycle/deployment.js';

/** I6 operational guardrails. Alerts only: nothing here stops or deletes. */
export const OpsConfigSchema = z.object({
    namespace: NamespaceSchema,
    accountId: z.string().regex(/^\d{12}$/),
    region: z.string().regex(REGION_PATTERN),
    /** Monthly cost budget in USD; alerts at 50/80/100 % of actual spend. */
    monthlyBudgetUsd: z.number().int().min(1).max(100000),
    budgetEmails: z.array(z.string().email()).max(5).default([]),
    /** Out-of-guest egress backstop: bytes sent by any one instance in 5 min. */
    egressBytesPer5Min: z.number().int().min(1_000_000).max(1_000_000_000_000),
}).strict();
export type OpsConfig = z.infer<typeof OpsConfigSchema>;

export const SNAPSHOT_INTERVAL_HOURS = 12, SNAPSHOT_RETAIN_COUNT = 14;
/** The AWS-managed DLM role (created once by `aws dlm create-default-role`).
 * It is outside the boundary on purpose: DLM must delete the snapshots it
 * rotated, which every bounded principal is denied. It can touch only
 * snapshots created by its own policies. */
export const dlmRoleArn = (accountId: string) => `arn:aws:iam::${accountId}:role/service-role/AWSDataLifecycleManagerDefaultRole`;

/** Founder-owned operator objects live here, outside every bounded path. */
export const OPERATOR_PATH = '/ezil/operators/';
/** §4 kill switch. Attached by an operator to the lifecycle controller role and
 * the recovery reconciler's role; detached to lift it. Graceful StopInstances
 * stays allowed; nothing deletes a volume. It is authoritative only because
 * the ops stack is founder-deployed: no bounded principal can create, change,
 * attach or detach it. Exported for exact-equality tests. */
export function killSwitchStatements(): iam.PolicyStatement[] {
    return [
        new iam.PolicyStatement({ sid: 'KillSwitchNoCompute', effect: iam.Effect.DENY, resources: ['*'],
            actions: ['ec2:RunInstances', 'ec2:StartInstances', 'ec2:AttachVolume', 'ec2:CreateVolume', 'ec2:CreateFleet', 'ec2:RequestSpot*'] }),
        new iam.PolicyStatement({ sid: 'KillSwitchNoWorkflows', effect: iam.Effect.DENY, resources: ['*'],
            actions: ['states:StartExecution', 'states:StartSyncExecution', 'states:RedriveExecution'] }),
    ];
}

export class OpsStack extends Stack {
    readonly topic: sns.Topic;
    constructor(scope: Construct, id: string, props: StackProps & { config: OpsConfig }) {
        super(scope, id, props);
        const c = OpsConfigSchema.parse(props.config), a = c.accountId;
        if (props.env?.region !== c.region || props.env?.account !== a) throw new Error('stack env must equal the ops config');

        // One alert topic the app (and operators) can subscribe to. Unencrypted
        // on purpose: CloudWatch and Budgets cannot publish to an aws/sns-encrypted
        // topic, and alerts carry no user data.
        this.topic = new sns.Topic(this, 'Alerts', { topicName: `ezil-${c.namespace}-ops-alerts` });
        const publisher = (service: string, sourceArn: string) => new iam.PolicyStatement({ principals: [new iam.ServicePrincipal(service)],
            actions: ['sns:Publish'], resources: [this.topic.topicArn],
            conditions: { StringEquals: { 'aws:SourceAccount': a }, ArnLike: { 'aws:SourceArn': sourceArn } } });
        this.topic.addToResourcePolicy(publisher('cloudwatch.amazonaws.com', `arn:aws:cloudwatch:${c.region}:${a}:alarm:ezil-${c.namespace}-*`));
        this.topic.addToResourcePolicy(publisher('budgets.amazonaws.com', `arn:aws:budgets::${a}:budget/ezil-${c.namespace}-monthly`));

        // R3: 12-hourly snapshots, 14 kept, of data volumes carrying this
        // namespace's backup tag (set only at creation; root disks lack it).
        new dlm.CfnLifecyclePolicy(this, 'DataSnapshots', {
            description: `ezil ${c.namespace} data volumes: 12-hourly, retain ${SNAPSHOT_RETAIN_COUNT}`,
            state: 'ENABLED', executionRoleArn: dlmRoleArn(a),
            policyDetails: { policyType: 'EBS_SNAPSHOT_MANAGEMENT', resourceTypes: ['VOLUME'],
                targetTags: [{ key: BACKUP_TAG, value: c.namespace }],
                schedules: [{ name: '12-hourly', copyTags: true,
                    createRule: { interval: SNAPSHOT_INTERVAL_HOURS, intervalUnit: 'HOURS' },
                    retainRule: { count: SNAPSHOT_RETAIN_COUNT },
                    tagsToAdd: [{ key: 'ezil:snapshot-policy', value: `${c.namespace}-12h` }] }] },
        });

        // R6/§4 egress backstop, measured outside the guest. One alarm over the
        // per-instance maximum: it fires when ANY instance in the region sends
        // more than the threshold in 5 minutes. Per-instance alarms need the
        // lifecycle to create them at launch (README, open items).
        new cloudwatch.CfnAlarm(this, 'EgressBackstop', {
            alarmName: `ezil-${c.namespace}-egress-any-instance`,
            alarmDescription: 'Any EC2 instance in the region exceeded the 5-minute NetworkOut threshold',
            metrics: [{ id: 'q', returnData: true, period: 300,
                expression: 'SELECT MAX(NetworkOut) FROM SCHEMA("AWS/EC2", InstanceId)' }],
            comparisonOperator: 'GreaterThanThreshold', threshold: c.egressBytesPer5Min,
            evaluationPeriods: 1, treatMissingData: 'notBreaching',
            alarmActions: [this.topic.topicArn], okActions: [this.topic.topicArn],
        });

        // §4: budget alarms are alerts, not enforcement.
        new budgets.CfnBudget(this, 'Monthly', {
            budget: { budgetName: `ezil-${c.namespace}-monthly`, budgetType: 'COST', timeUnit: 'MONTHLY',
                budgetLimit: { amount: c.monthlyBudgetUsd, unit: 'USD' } },
            notificationsWithSubscribers: [50, 80, 100].map(threshold => ({
                notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
                subscribers: [{ subscriptionType: 'SNS', address: this.topic.topicArn },
                    ...c.budgetEmails.map(address => ({ subscriptionType: 'EMAIL', address }))],
            })),
        });

        const killSwitch = new iam.ManagedPolicy(this, 'KillSwitch', { managedPolicyName: `ezil-${c.namespace}-kill-switch`,
            path: OPERATOR_PATH, description: 'Attach to the lifecycle controller and reconciler roles to stop all compute starts',
            document: new iam.PolicyDocument({ statements: killSwitchStatements() }) });
        new CfnOutput(this, 'AlertTopicArn', { value: this.topic.topicArn });
        new CfnOutput(this, 'KillSwitchPolicyArn', { value: killSwitch.managedPolicyArn });
    }
}
