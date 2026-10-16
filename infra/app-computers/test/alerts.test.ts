import assert from 'node:assert/strict';
import test from 'node:test';
import { App, BootstraplessSynthesizer, Stack, assertions } from 'aws-cdk-lib';
import { OpsConfigSchema, OpsStack } from '../lib/ops.js';
import { ComputerLifecycle } from '../lib/computer-lifecycle.js';
import { lifecycleFixture, REGION } from './lifecycle-fixture.js';

// Founder decision 2026-10-15: concurrency rises to 10 AWS computers, and the founder is
// emailed when capacity or quota runs low or spend runs high. Alerts only: nothing here stops.
const A = '123456789012', R = 'us-east-1';
const base = { namespace: 'pilot', accountId: A, region: R, monthlyBudgetUsd: 400, egressBytesPer5Min: 3_000_000_000,
    budgetEmails: ['contact@ezil.work'], alertEmails: ['contact@ezil.work', 'ops@example.com'], capacityAlarmVcpus: 16 };
type Resource = { Type: string; Properties: Record<string, any> };
function ops(over: Record<string, unknown> = {}) {
    const config = OpsConfigSchema.parse({ ...base, ...over });
    const stack = new OpsStack(new App(), 'ezil-pilot-ops', { config, synthesizer: new BootstraplessSynthesizer(), env: { account: A, region: R } });
    const resources = assertions.Template.fromStack(stack).toJSON().Resources as Record<string, Resource>;
    const [topicId] = Object.entries(resources).find(([, r]) => r.Type === 'AWS::SNS::Topic')!;
    return { resources, topicId, of: (type: string) => Object.values(resources).filter(r => r.Type === type).map(r => r.Properties) };
}
const alarm = (o: ReturnType<typeof ops>, name: string) => o.of('AWS::CloudWatch::Alarm').find(p => p.AlarmName === name);
const usage = { Namespace: 'AWS/Usage', MetricName: 'ResourceCount', Dimensions: [
    { Name: 'Service', Value: 'EC2' }, { Name: 'Type', Value: 'Resource' }, { Name: 'Resource', Value: 'vCPU' }, { Name: 'Class', Value: 'Standard/OnDemand' }] };

test('every alert email is an EMAIL subscription on the ops alert topic', () => {
    const o = ops();
    const subs = o.of('AWS::SNS::Subscription');
    assert.deepEqual(subs.map(s => s.Endpoint).sort(), ['contact@ezil.work', 'ops@example.com']);
    for (const s of subs) {
        assert.equal(s.Protocol, 'email');
        assert.deepEqual(s.TopicArn, { Ref: o.topicId });
    }
    assert.equal(ops({ alertEmails: [] }).of('AWS::SNS::Subscription').length, 0);
});

test('vCPU quota alarm: SERVICE_QUOTA metric math at quotaAlarmPercent, 2 of 3 five-minute periods, ALARM and OK to the topic', () => {
    const o = ops(), a = alarm(o, 'ezil-pilot-vcpu-quota-high');
    assert.ok(a, 'quota alarm missing');
    assert.deepEqual(a.Metrics, [
        { Id: 'm1', ReturnData: false, MetricStat: { Metric: usage, Period: 300, Stat: 'Maximum' } },
        { Id: 'e1', ReturnData: true, Label: 'vCPU quota used (%)', Expression: '(m1/SERVICE_QUOTA(m1))*100' },
    ]);
    assert.equal(a.Threshold, 80);
    assert.equal(a.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
    assert.equal(a.EvaluationPeriods, 3);
    assert.equal(a.DatapointsToAlarm, 2);
    assert.equal(a.TreatMissingData, 'notBreaching');
    assert.deepEqual(a.AlarmActions, [{ Ref: o.topicId }]);
    assert.deepEqual(a.OKActions, [{ Ref: o.topicId }]);
    assert.match(a.AlarmDescription, /Service Quotas/);
    assert.equal(alarm(ops({ quotaAlarmPercent: 70 }), 'ezil-pilot-vcpu-quota-high')!.Threshold, 70);
});

test('computers capacity alarm: running vCPUs at capacityAlarmVcpus, ALARM and OK to the topic', () => {
    const o = ops(), a = alarm(o, 'ezil-pilot-computers-capacity-high');
    assert.ok(a, 'capacity alarm missing');
    assert.deepEqual(a.Metrics, [{ Id: 'm1', ReturnData: true, MetricStat: { Metric: usage, Period: 300, Stat: 'Maximum' } }]);
    assert.equal(a.Threshold, 16);
    assert.equal(a.ComparisonOperator, 'GreaterThanOrEqualToThreshold');
    assert.equal(a.EvaluationPeriods, 3);
    assert.equal(a.DatapointsToAlarm, 2);
    assert.equal(a.TreatMissingData, 'notBreaching');
    assert.deepEqual(a.AlarmActions, [{ Ref: o.topicId }]);
    assert.deepEqual(a.OKActions, [{ Ref: o.topicId }]);
    assert.match(a.AlarmDescription, /EZIL_AWS_MAX_RUNNING_/);
    assert.equal(alarm(ops({ capacityAlarmVcpus: 40 }), 'ezil-pilot-computers-capacity-high')!.Threshold, 40);
});

test('capacityAlarmVcpus is required; every alarm name stays under the topic policy prefix', () => {
    const { capacityAlarmVcpus, ...without } = base;
    assert.equal(OpsConfigSchema.safeParse(without).success, false);
    for (const p of ops().of('AWS::CloudWatch::Alarm')) assert.match(p.AlarmName, /^ezil-pilot-/);
});

test('budget: actual 50/80/100 % plus FORECASTED 100 %, each to the topic and the budget emails', () => {
    const o = ops(), [budget] = o.of('AWS::Budgets::Budget');
    const n = budget!.NotificationsWithSubscribers as { Notification: Record<string, unknown>; Subscribers: { SubscriptionType: string; Address: unknown }[] }[];
    assert.deepEqual(n.map(x => [x.Notification.NotificationType, x.Notification.Threshold]),
        [['ACTUAL', 50], ['ACTUAL', 80], ['ACTUAL', 100], ['FORECASTED', 100]]);
    for (const x of n) assert.deepEqual(x.Subscribers, [{ SubscriptionType: 'SNS', Address: { Ref: o.topicId } },
        { SubscriptionType: 'EMAIL', Address: 'contact@ezil.work' }]);
});

function lifecycleAlarms(alertTopicArn?: string) {
    const f = lifecycleFixture(), stack = new Stack(new App(), 'LifecycleAlerts', { env: { account: f.settings.deployment.accountId, region: REGION } });
    new ComputerLifecycle(stack, 'Lifecycle', { settings: f.settings, authorityKeyArn: f.settings.deployment.dataKeyArn,
        ...(alertTopicArn === undefined ? {} : { alertTopicArn }) });
    return Object.values(assertions.Template.fromStack(stack).findResources('AWS::CloudWatch::Alarm')).map(r => (r as Resource).Properties);
}
const TOPIC = `arn:aws:sns:${REGION}:123456789012:ezil-pilot-ops-alerts`;

test('lifecycle alarms are named under ezil-<ns>- and notify only when alertTopicArn is set', () => {
    const quiet = lifecycleAlarms();
    assert.deepEqual(quiet.map(p => p.AlarmName).sort(), ['ezil-pilot-lifecycle-failures', 'ezil-pilot-lifecycle-unconfirmed']);
    for (const p of quiet) { assert.equal(p.AlarmActions, undefined); assert.equal(p.OKActions, undefined); }
    const loud = lifecycleAlarms(TOPIC);
    assert.equal(loud.length, 2);
    for (const p of loud) { assert.deepEqual(p.AlarmActions, [TOPIC]); assert.deepEqual(p.OKActions, [TOPIC]); }
});

test('lifecycle refuses an alert topic outside this region, account or namespace', () => {
    for (const bad of [`arn:aws:sns:us-west-2:123456789012:ezil-pilot-ops-alerts`, `arn:aws:sns:${REGION}:999999999999:ezil-pilot-ops-alerts`,
        `arn:aws:sns:${REGION}:123456789012:other-topic`, 'not-an-arn']) {
        assert.throws(() => lifecycleAlarms(bad), /invalid_alert_topic/, bad);
    }
});

// Live 2026-10-15: adding the forecast notification replaced the budget, and CloudFormation's
// create-before-delete collided on the fixed name ("same name but a different internalId").
test('a budget replacement gets a fresh name the topic policy still admits', () => {
    const budgetName = (o: ReturnType<typeof ops>) => (o.of('AWS::Budgets::Budget')[0] as any).Budget.BudgetName as string;
    const a = ops({ budgetEmails: [] }), b = ops({ budgetEmails: ['contact@ezil.work', 'ops@ezil.work'] });
    assert.notEqual(budgetName(a), budgetName(b));
    for (const name of [budgetName(a), budgetName(b)]) assert.match(name, /^ezil-pilot-monthly-[0-9a-f]{8}$/);
    assert.equal(budgetName(a), budgetName(ops({ budgetEmails: [] })), 'stable for identical settings');
    const policy = JSON.stringify(a.of('AWS::SNS::TopicPolicy'));
    assert.match(policy, /budget\/ezil-pilot-monthly\*/);
});

// Live 2026-10-16: ezil-pilot-ops runs the pre-forecast budget (rolled back on 2026-10-15).
// existingBudgetName keeps it byte-for-byte, so the update only adds the two alarms.
const LIVE_PILOT_BUDGET = {
    Budget: { BudgetLimit: { Amount: 250, Unit: 'USD' }, BudgetName: 'ezil-pilot-monthly', BudgetType: 'COST', TimeUnit: 'MONTHLY' },
    NotificationsWithSubscribers: [50, 80, 100].map(Threshold => ({
        Notification: { ComparisonOperator: 'GREATER_THAN', NotificationType: 'ACTUAL', Threshold, ThresholdType: 'PERCENTAGE' },
        Subscribers: [{ SubscriptionType: 'SNS', Address: { Ref: 'Alerts91F83244' } }],
    })),
};

test('existingBudgetName keeps the live budget byte-for-byte and still adds both alarms', () => {
    const o = ops({ monthlyBudgetUsd: 250, budgetEmails: [], existingBudgetName: 'ezil-pilot-monthly' });
    assert.equal(o.topicId, 'Alerts91F83244', 'the topic keeps its live logical id');
    assert.deepEqual(o.of('AWS::Budgets::Budget'), [LIVE_PILOT_BUDGET]);
    assert.ok(alarm(o, 'ezil-pilot-vcpu-quota-high'));
    assert.ok(alarm(o, 'ezil-pilot-computers-capacity-high'));
    const policy = JSON.stringify(o.of('AWS::SNS::TopicPolicy'));
    assert.match(policy, /budget\/ezil-pilot-monthly"/, 'the live budget keeps its exact publish grant');
    assert.doesNotMatch(policy, /budget\/ezil-pilot-monthly\*/);
});

test('existingBudgetName refuses budget emails rather than replacing the live budget', () => {
    assert.throws(() => ops({ budgetEmails: ['contact@ezil.work'], existingBudgetName: 'ezil-pilot-monthly' }), /would replace it/);
});

test('existingBudgetName must be this stack\'s own namespace budget', () => {
    assert.throws(() => ops({ budgetEmails: [], existingBudgetName: 'ezil-prod-monthly' }), /must be ezil-pilot-monthly for namespace pilot/);
});

test('existingBudgetName must be an ezil-<ns>-monthly name', () => {
    for (const name of ['ezil-pilot-monthly-1234abcd', 'other-budget', 'ezil-pilot-monthly ']) {
        assert.throws(() => OpsConfigSchema.parse({ ...base, existingBudgetName: name }));
    }
});
