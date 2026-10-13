import { Duration, Names, aws_events as events, aws_iam as iam, aws_kms as kms, aws_lambda as lambda, aws_sqs as sqs } from 'aws-cdk-lib';

/** A rule's ARN from its fixed name. Built as a literal so key and queue
 * policies can name the rule without a dependency cycle (rule → queue → key). */
export const ruleArn = (region: string, account: string, name: string) => `arn:aws:events:${region}:${account}:rule/${name}`;

/** Confused-deputy guard for every grant to events.amazonaws.com: the exact
 * rule (aws:SourceArn) in this account (aws:SourceAccount). */
export const sourceConditions = (arn: string, account: string) => ({ ArnEquals: { 'aws:SourceArn': arn }, StringEquals: { 'aws:SourceAccount': account } });
const events_ = () => new iam.ServicePrincipal('events.amazonaws.com');

/** Lets one rule deliver to one KMS-encrypted queue, and nothing else. */
export function allowRuleToQueue(queue: sqs.IQueue, key: kms.IKey, arn: string, account: string) {
    const conditions = sourceConditions(arn, account);
    queue.addToResourcePolicy(new iam.PolicyStatement({ principals: [events_()], actions: ['sqs:SendMessage'], resources: [queue.queueArn], conditions }));
    key.addToResourcePolicy(new iam.PolicyStatement({ principals: [events_()], actions: ['kms:Decrypt', 'kms:GenerateDataKey'], resources: ['*'], conditions }));
}

type Destination = { queue: sqs.IQueue; key: kms.IKey } | { fn: lambda.IFunction };
/** Replaces targets.SqsQueue / targets.LambdaFunction. Those grant an
 * encrypted queue's key to events.amazonaws.com with no condition at all. */
export class GuardedTarget implements events.IRuleTarget {
    constructor(private readonly destination: Destination, private readonly o: { ruleArn: string; account: string;
        deadLetter?: { queue: sqs.IQueue; key: kms.IKey }; retryAttempts?: number; maxEventAge?: Duration }) {}
    bind(rule: events.IRule): events.RuleTargetConfig {
        const d = this.destination;
        if ('queue' in d) allowRuleToQueue(d.queue, d.key, this.o.ruleArn, this.o.account);
        else d.fn.addPermission(`AllowEvents${Names.nodeUniqueId(rule.node)}`, { principal: events_(),
            action: 'lambda:InvokeFunction', sourceArn: this.o.ruleArn, sourceAccount: this.o.account });
        if (this.o.deadLetter) allowRuleToQueue(this.o.deadLetter.queue, this.o.deadLetter.key, this.o.ruleArn, this.o.account);
        return {
            arn: 'queue' in d ? d.queue.queueArn : d.fn.functionArn,
            ...(this.o.deadLetter ? { deadLetterConfig: { arn: this.o.deadLetter.queue.queueArn } } : {}),
            ...(this.o.retryAttempts !== undefined || this.o.maxEventAge ? { retryPolicy: {
                ...(this.o.retryAttempts !== undefined ? { maximumRetryAttempts: this.o.retryAttempts } : {}),
                ...(this.o.maxEventAge ? { maximumEventAgeInSeconds: this.o.maxEventAge.toSeconds() } : {}) } } : {}),
        };
    }
}
