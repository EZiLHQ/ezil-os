import { CfnOutput, Stack, type StackProps, aws_budgets as budgets, aws_cloudwatch as cloudwatch, aws_dlm as dlm,
    aws_iam as iam, aws_sns as sns } from 'aws-cdk-lib';
import { createHash } from 'node:crypto';
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
    /** Founder inboxes subscribed (EMAIL) to the ops alert topic: every alarm below and the budget. */
    alertEmails: z.array(z.string().email()).max(5).default([]),
    /** Alert when running On-Demand Standard vCPUs reach this share of the account quota. */
    quotaAlarmPercent: z.number().int().min(1).max(100).default(80),
    /** Alert when running On-Demand Standard vCPUs reach this many: set it near the app's
     * EZIL_AWS_MAX_RUNNING_* × vCPU per computer, so the founder hears before new users fall
     * back to Cloudflare (e.g. 16 = 80 % of 10 computers × 2 vCPU). */
    capacityAlarmVcpus: z.number().int().min(1).max(100000),
}).strict();
export type OpsConfig = z.infer<typeof OpsConfigSchema>;

export const SNAPSHOT_INTERVAL_HOURS = 12, SNAPSHOT_RETAIN_COUNT = 14;
/** The AWS-managed DLM role (created once by `aws dlm create-default-role`).
 * It is outside the boundary on purpose: DLM must delete the snapshots it
 * rotated, which every bounded principal is denied. It can touch only
 * snapshots created by its own policies. That command creates it at path "/";
 * a service-role/ ARN names no role and DLM fails with sts:AssumeRole. */
export const dlmRoleArn = (accountId: string) => `arn:aws:iam::${accountId}:role/AWSDataLifecycleManagerDefaultRole`;

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
        this.topic.addToResourcePolicy(publisher('budgets.amazonaws.com', `arn:aws:budgets::${a}:budget/ezil-${c.namespace}-monthly*`));
        // The founder's inboxes. Each address must confirm the AWS subscription email once.
        c.alertEmails.forEach((endpoint, i) => new sns.Subscription(this, `AlertEmail${i}`, {
            topic: this.topic, protocol: sns.SubscriptionProtocol.EMAIL, endpoint }));

        // R3: 12-hourly snapshots, 14 kept, of data volumes carrying this
        // namespace's backup tag (set only at creation; root disks lack it).
        new dlm.CfnLifecyclePolicy(this, 'DataSnapshots', {
            // DLM accepts only [0-9A-Za-z _-] in descriptions (a colon or comma fails the live create).
            description: `ezil ${c.namespace} data volumes 12-hourly retain ${SNAPSHOT_RETAIN_COUNT}`,
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

        // Capacity. Both alarms read the same account-wide usage metric: running On-Demand
        // Standard (A, C, D, H, I, M, R, T, Z) vCPUs in this region, which every AWS computer
        // tier (t3a/t3/m6i) counts against.
        const runningVcpus = { namespace: 'AWS/Usage', metricName: 'ResourceCount', period: 300, stat: 'Maximum',
            dimensions: [{ name: 'Service', value: 'EC2' }, { name: 'Type', value: 'Resource' },
                { name: 'Resource', value: 'vCPU' }, { name: 'Class', value: 'Standard/OnDemand' }] };
        const usageMetric = (id: string, returnData: boolean): cloudwatch.CfnAlarm.MetricDataQueryProperty => ({ id, returnData,
            metricStat: { metric: { namespace: runningVcpus.namespace, metricName: runningVcpus.metricName, dimensions: runningVcpus.dimensions },
                period: runningVcpus.period, stat: runningVcpus.stat } });
        new cloudwatch.CfnAlarm(this, 'VcpuQuotaHigh', {
            alarmName: `ezil-${c.namespace}-vcpu-quota-high`,
            alarmDescription: `Running On-Demand Standard vCPUs in ${c.region} reached ${c.quotaAlarmPercent}% of the account quota. `
                + 'New AWS computers will soon be refused by EC2. Request a higher "Running On-Demand Standard (A, C, D, H, I, M, R, T, Z) instances" '
                + 'quota in Service Quotas, or lower EZIL_AWS_MAX_RUNNING_* until it is granted.',
            metrics: [usageMetric('m1', false), { id: 'e1', returnData: true, label: 'vCPU quota used (%)',
                expression: '(m1/SERVICE_QUOTA(m1))*100' }],
            comparisonOperator: 'GreaterThanOrEqualToThreshold', threshold: c.quotaAlarmPercent,
            evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: 'notBreaching',
            alarmActions: [this.topic.topicArn], okActions: [this.topic.topicArn],
        });
        new cloudwatch.CfnAlarm(this, 'ComputersCapacityHigh', {
            alarmName: `ezil-${c.namespace}-computers-capacity-high`,
            alarmDescription: `Running On-Demand Standard vCPUs in ${c.region} reached ${c.capacityAlarmVcpus}: AWS computers are nearly at the app cap, `
                + 'and new users will fall back to Cloudflare. Raise EZIL_AWS_MAX_RUNNING_* (and capacityAlarmVcpus) if the vCPU quota allows, '
                + 'or request a higher quota first.',
            metrics: [usageMetric('m1', true)],
            comparisonOperator: 'GreaterThanOrEqualToThreshold', threshold: c.capacityAlarmVcpus,
            evaluationPeriods: 3, datapointsToAlarm: 2, treatMissingData: 'notBreaching',
            alarmActions: [this.topic.topicArn], okActions: [this.topic.topicArn],
        });

        // §4: budget alarms are alerts, not enforcement.
        // Actual 50/80/100 % plus a FORECASTED 100 %: the founder hears before the month overruns.
        const budgetNotifications = [
            ...[50, 80, 100].map(threshold => ({ type: 'ACTUAL', threshold })),
            { type: 'FORECASTED', threshold: 100 },
        ];
        // Changing a budget's notifications REPLACES it, and CloudFormation creates the new one
        // before deleting the old: a fixed name collides ("same name but a different internalId",
        // live 2026-10-15). The name carries a hash of what forces replacement, so a replacement
        // always gets a fresh name; the topic policy admits the ezil-<ns>-monthly* prefix.
        const budgetRevision = createHash('sha256').update(JSON.stringify({ budgetNotifications, emails: c.budgetEmails })).digest('hex').slice(0, 8);
        new budgets.CfnBudget(this, 'Monthly', {
            budget: { budgetName: `ezil-${c.namespace}-monthly-${budgetRevision}`, budgetType: 'COST', timeUnit: 'MONTHLY',
                budgetLimit: { amount: c.monthlyBudgetUsd, unit: 'USD' } },
            notificationsWithSubscribers: budgetNotifications.map(({ type, threshold }) => ({
                notification: { notificationType: type, comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
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
