import { createHash } from 'node:crypto';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import type { LifecycleWork } from './aws-intent';
import { lifecycleExecutionArn, type LifecycleExecutionReader } from './aws-receipts';
import { parseRebaseJson } from './aws-rebase-json';

type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
const DENIED_LAUNCH_HISTORY = [
    ['ExecutionStarted', 0], ['PassStateEntered', 0, 'Init'], ['PassStateExited', 2, 'Init'],
    ['TaskStateEntered', 3, 'Observe-initial'], ['LambdaFunctionScheduled', 4], ['LambdaFunctionStarted', 5],
    ['LambdaFunctionSucceeded', 6], ['TaskStateExited', 7, 'Observe-initial'],
    ['ChoiceStateEntered', 8, 'Decide'], ['ChoiceStateExited', 9, 'Decide'],
    ['TaskStateEntered', 10, 'runInstances'], ['TaskScheduled', 11], ['TaskStarted', 12], ['TaskFailed', 13],
    ['TaskStateExited', 14, 'runInstances'], ['WaitStateEntered', 15, 'After-runInstances'], ['WaitStateExited', 16, 'After-runInstances'],
    ['TaskStateEntered', 17, 'Observe-instance'], ['LambdaFunctionScheduled', 18], ['LambdaFunctionStarted', 19],
    ['LambdaFunctionSucceeded', 20], ['TaskStateExited', 21, 'Observe-instance'],
    ['ChoiceStateEntered', 22, 'Decide'], ['ChoiceStateExited', 23, 'Decide'],
    ['FailStateEntered', 24, 'Rejected'], ['ExecutionFailed', 25],
] as const satisfies readonly (readonly [HistoryEvent['type'], number, string?])[];

const AUTHORIZATION_DENIED = new RegExp([
    '^You are not authorized to perform this operation\\. User: ',
    'arn:aws:sts::(?<account>[0-9]{12}):assumed-role/(?<role>[A-Za-z0-9+=,.@_-]{1,64})/[A-Za-z0-9+=,.@_-]{1,128}',
    ' is not authorized to perform: ec2:RunInstances on resource: (?<resource>arn:aws:ec2:[a-z0-9-]+::image/ami-[a-f0-9]{17})',
    ' because no identity-based policy allows the ec2:RunInstances action\\. ',
    'Go to https://(?<console>[a-z0-9-]+)\\.console\\.aws\\.amazon\\.com/iam/home\\?region=(?<region>[a-z0-9-]+)#\\S+',
    ' for complete details, or call the GetRequestAuthorizationDetails API with the following authorization id: [A-Za-z0-9+/_=-]+\\. ',
    'Encoded authorization failure message: [A-Za-z0-9+/_=-]+ ',
    '\\(Service: Ec2, Status Code: 403, Request ID: [a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\\) \\(SDK Attempt Count: 1\\)$',
].join(''));

function isRecordedDenial(cause: string | undefined, roleArn: string | undefined, deployment: LifecycleWork['intent']['deployment']): boolean {
    // Match EC2's authorization-denial response envelope, not a 403 in arbitrary error text.
    // Never decode or persist the authorization hint.
    if (!cause || cause.length > 8192 || !roleArn) return false;
    const d = deployment, match = AUTHORIZATION_DENIED.exec(cause);
    const context = match?.groups;
    return !!context && context.account === d.accountId && context.console === d.region && context.region === d.region
        && context.resource === `arn:aws:ec2:${d.region}::image/${d.amiId}`
        && roleArn.startsWith(`arn:aws:iam::${d.accountId}:role/`) && roleArn.split('/').at(-1) === context.role;
}

/** Prove the one EC2 task in this unredriven pool provision was rejected before it could allocate a host.
 * The complete history binds the launch request to the saved work and admits only the observed EC2 denial response.
 * No EC2 absence, generic SDK failure, or text mentioning a 403 can substitute for a denied launch. */
export function provePoolLaunchDenied(e: Execution, events: readonly HistoryEvent[], work: LifecycleWork): boolean {
    const i = work.intent, d = i.deployment;
    if (i.operation !== 'pool-provision' || i.providerInstanceId !== null || i.dataVolumeId !== null
        || e.status !== 'FAILED' || e.redriveCount !== 0 || e.stateMachineAliasArn || e.error !== 'LifecycleUnconfirmed'
        || e.input !== work.input || e.executionArn !== lifecycleExecutionArn(d, i.jobId)
        || e.stateMachineVersionArn !== work.stateMachineArn || !(e.startDate instanceof Date)
        || !(e.stopDate instanceof Date) || events.length !== DENIED_LAUNCH_HISTORY.length) return false;
    const start = e.startDate.getTime(), stop = e.stopDate.getTime();
    if (!Number.isFinite(start) || !Number.isFinite(stop) || start > stop) return false;
    if (!DENIED_LAUNCH_HISTORY.every(([type, previousId, name], index) => {
        const event = events[index]!, time = event.timestamp?.getTime();
        return event.id === index + 1 && event.previousEventId === previousId && event.type === type
            && time !== undefined && time >= start && time <= stop
            && (index === 0 || time >= events[index - 1]!.timestamp!.getTime())
            && (name === undefined || (event.stateEnteredEventDetails?.name ?? event.stateExitedEventDetails?.name) === name);
    })) return false;
    const opening = events[0]!.executionStartedEventDetails;
    const ending = events[25]!.executionFailedEventDetails;
    if (opening?.input !== work.input || opening.stateMachineVersionArn !== work.stateMachineArn
        || opening.stateMachineAliasArn || opening.inputDetails?.truncated
        || ending?.error !== e.error || !e.cause || ending.cause !== e.cause) return false;
    const observers = [events[4]!, events[18]!].map(event => event.lambdaFunctionScheduledEventDetails?.resource);
    if (!observers[0] || observers[0] !== observers[1] ||
        !new RegExp(`^arn:aws:lambda:${d.region}:${d.accountId}:function:[A-Za-z0-9_-]+:[1-9][0-9]*$`).test(observers[0])) return false;
    const scheduled = events[11]!.taskScheduledEventDetails, started = events[12]!.taskStartedEventDetails,
        failed = events[13]!.taskFailedEventDetails;
    if (![scheduled, started, failed].every(action => action?.resource === 'runInstances' && action.resourceType === 'aws-sdk:ec2')
        || scheduled?.region !== d.region || failed?.error !== 'Ec2.Ec2Exception' || !isRecordedDenial(failed.cause, opening.roleArn, d)) return false;
    let request;
    try { request = parseRebaseJson(scheduled.parameters ?? '') as Record<string, unknown>; } catch { return false; }
    const template = request?.LaunchTemplate as Record<string, unknown> | undefined;
    // Matches the pool provision token in infra/app-computers/lib/lifecycle/contract.ts.
    const clientToken = createHash('sha256').update(`ezil-lifecycle-v1\ninstance\n${work.digest}`).digest('hex');
    return request?.ClientToken === clientToken && request.ImageId === d.amiId && request.InstanceType === i.instanceType && request.MinCount === 1 && request.MaxCount === 1
        && template?.LaunchTemplateId === d.launchTemplateId && template.Version === d.launchTemplateVersion;
}
