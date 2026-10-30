import type { HistoryEvent } from '@aws-sdk/client-sfn';
import type { LifecycleWork } from './aws-intent';
import { lifecycleExecutionArn, type LifecycleExecutionReader } from './aws-receipts';

type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;

/** A pool release that FAILED after it had positively terminated its host (incident 2026-10-25: the observe step right
 * after TerminateInstances refused a transient view). Proven only from that failed execution's own complete history:
 * the exact execution and immutable input of the failed release job, every provider call a release step naming exactly
 * its host and data volume in its region, a connected TerminateInstances chain whose result reported `terminated`
 * (Code 48) for exactly that host, and a terminal Fail state. An observe Lambda may hang off its own retryable failure
 * (the observe Retry, at most 3 per state entry; 2026-10-28). EC2 absence alone is never evidence. Separate from, and
 * never a substitute for, the SUCCEEDED-release proof replacement recovery uses (aws-historical-source.ts). */
export interface FailedReleaseTermination { instanceId: string; executionArn: string; terminatedAt: Date }

const KNOWN: ReadonlySet<string> = new Set(['ExecutionStarted', 'ExecutionFailed', 'FailStateEntered',
    'PassStateEntered', 'PassStateExited', 'TaskStateEntered', 'TaskStateExited', 'ChoiceStateEntered', 'ChoiceStateExited',
    'WaitStateEntered', 'WaitStateExited',
    'LambdaFunctionScheduled', 'LambdaFunctionStarted', 'LambdaFunctionSucceeded', 'LambdaFunctionFailed', 'LambdaFunctionTimedOut',
    'LambdaFunctionStartFailed', 'LambdaFunctionScheduleFailed',
    'TaskScheduled', 'TaskStarted', 'TaskSucceeded', 'TaskFailed', 'TaskTimedOut', 'TaskStartFailed']);
/** The only provider calls a release makes (infra/app-computers lifecycle helper `observePool`). */
const RELEASE_TASKS: ReadonlySet<string> = new Set(['stopInstances', 'detachVolume', 'terminateInstances']);
const ANSWERS: ReadonlySet<string> = new Set(['TaskSucceeded', 'TaskFailed', 'TaskTimedOut']);
/** Each event type's only legitimate parent (previousEventId) type; every such event is that parent's single child of its kind. */
const PARENT: Readonly<Record<string, string>> = { TaskStarted: 'TaskScheduled', TaskStartFailed: 'TaskScheduled',
    TaskSucceeded: 'TaskStarted', TaskFailed: 'TaskStarted', TaskTimedOut: 'TaskStarted',
    LambdaFunctionScheduled: 'TaskStateEntered', LambdaFunctionScheduleFailed: 'TaskStateEntered', LambdaFunctionStarted: 'LambdaFunctionScheduled',
    LambdaFunctionStartFailed: 'LambdaFunctionScheduled', LambdaFunctionSucceeded: 'LambdaFunctionStarted', LambdaFunctionFailed: 'LambdaFunctionStarted',
    LambdaFunctionTimedOut: 'LambdaFunctionStarted' };
/** A sibling group: at most one start per schedule, one outcome per start. */
const GROUP: Readonly<Record<string, string>> = { TaskStarted: 'start', TaskStartFailed: 'start', TaskSucceeded: 'outcome', TaskFailed: 'outcome',
    TaskTimedOut: 'outcome', LambdaFunctionScheduled: 'schedule', LambdaFunctionScheduleFailed: 'schedule', LambdaFunctionStarted: 'start',
    LambdaFunctionStartFailed: 'start', LambdaFunctionSucceeded: 'outcome', LambdaFunctionFailed: 'outcome', LambdaFunctionTimedOut: 'outcome' };
const FAILURES: ReadonlySet<string> = new Set(['LambdaFunctionFailed', 'LambdaFunctionTimedOut', 'LambdaFunctionStartFailed', 'LambdaFunctionScheduleFailed',
    'TaskFailed', 'TaskTimedOut', 'TaskStartFailed']);
/** The observe states' Retry (infra lifecycle/definition.ts `observationRetry`): these errors, at most 3 retries per state entry.
 * EC2 tasks have no Retry, so only an observer Lambda failure carrying one of these may re-schedule its Lambda. */
const OBSERVE_RETRY_ERRORS: ReadonlySet<string> = new Set(['LifecycleRetryable', 'Lambda.ServiceException', 'Lambda.AWSLambdaException',
    'Lambda.SdkClientException', 'Lambda.TooManyRequestsException']);
const OBSERVE_MAX_RETRIES = 3;
const retryError = (event: HistoryEvent | undefined) => event?.type === 'LambdaFunctionFailed' ? event.lambdaFunctionFailedEventDetails?.error
    : event?.type === 'LambdaFunctionStartFailed' ? event.lambdaFunctionStartFailedEventDetails?.error : undefined;
type TaskDetails = { resource?: string; resourceType?: string };
const taskDetails = (event: HistoryEvent): TaskDetails | undefined => event.taskScheduledEventDetails ?? event.taskStartedEventDetails
    ?? event.taskSucceededEventDetails ?? event.taskFailedEventDetails ?? event.taskTimedOutEventDetails ?? event.taskStartFailedEventDetails;
const named = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const truncated = (event: HistoryEvent) => Object.values(event).some(v => v && typeof v === 'object'
    && ((v as { inputDetails?: { truncated?: boolean } }).inputDetails?.truncated || (v as { outputDetails?: { truncated?: boolean } }).outputDetails?.truncated));
function parse(text: string | undefined): unknown {
    if (typeof text !== 'string') return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
}

export function proveFailedReleaseTermination(e: Execution, events: readonly HistoryEvent[], work: LifecycleWork): FailedReleaseTermination | null {
    const i = work.intent, d = i.deployment, instanceId = i.providerInstanceId, volumeId = i.dataVolumeId;
    if (i.operation !== 'release' || !instanceId || !volumeId) return null;
    if (e.status !== 'FAILED' || e.redriveCount !== 0 || e.stateMachineAliasArn || typeof e.input !== 'string' || e.input !== work.input
        || e.executionArn !== lifecycleExecutionArn(d, i.jobId) || e.stateMachineVersionArn !== work.stateMachineArn || !named(e.error)
        || !(e.startDate instanceof Date) || !(e.stopDate instanceof Date)) return null;
    const from = e.startDate.getTime(), to = e.stopDate.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return null;
    const first = events[0], last = events.at(-1), failState = events.at(-2);
    if (events.length < 3 || first?.type !== 'ExecutionStarted' || first.executionStartedEventDetails?.input !== e.input
        || first.executionStartedEventDetails.stateMachineVersionArn !== work.stateMachineArn
        || last?.type !== 'ExecutionFailed' || last.executionFailedEventDetails?.error !== e.error
        || (typeof e.cause === 'string' && last.executionFailedEventDetails.cause !== e.cause)
        || failState?.type !== 'FailStateEntered' || last.previousEventId !== failState.id) return null;
    const valid = events.every((event, index) => {
        const type = event.type ?? '';
        if (event.id !== index + 1 || !Number.isInteger(event.previousEventId) || event.previousEventId! < 0 || event.previousEventId! >= event.id
            || (index === 0 && event.previousEventId !== 0) || !(event.timestamp instanceof Date) || !Number.isFinite(event.timestamp.getTime())
            || event.timestamp.getTime() < from || event.timestamp.getTime() > to
            || (index > 0 && event.timestamp.getTime() < events[index - 1]!.timestamp!.getTime())
            || !KNOWN.has(type) || type.startsWith('Execution') !== (index === 0 || index === events.length - 1)
            || (type === 'FailStateEntered') !== (index === events.length - 2) || truncated(event)) return false;
        if ((type.endsWith('StateEntered')) && !named(event.stateEnteredEventDetails?.name)) return false;
        if (type.endsWith('StateExited') && !named(event.stateExitedEventDetails?.name)) return false;
        return true;
    });
    if (!valid) return null;
    const byId = new Map(events.map(event => [event.id!, event]));
    // The final failure descends from a failed observe/task: ExecutionFailed <- Fail state <- a state exit <- a failure event.
    const exited = byId.get(failState.previousEventId!), failure = exited && byId.get(exited.previousEventId!);
    if (!exited?.type?.endsWith('StateExited') || !failure || !FAILURES.has(failure.type ?? '')) return null;
    // Every task/Lambda event hangs off exactly one legitimate parent, unique in its sibling group, carrying the same EC2 resource.
    const seen = new Set<string>();
    for (const event of events) {
        const type = event.type ?? '', parentType = PARENT[type];
        if (!parentType) continue;
        const parent = byId.get(event.previousEventId!), key = event.previousEventId + ':' + GROUP[type];
        if (seen.has(key)) return null;
        seen.add(key);
        if (type === 'LambdaFunctionScheduled' && parent?.type !== parentType) {
            // An observe Retry: re-scheduled from its own retryable failure, same Lambda, within the retry budget of one state entry.
            if (!OBSERVE_RETRY_ERRORS.has(retryError(parent) ?? '')) return null;
            let up: HistoryEvent | undefined = parent, retries = 0;
            while (up?.type !== parentType) {
                const schedule = up?.type === 'LambdaFunctionStartFailed' ? byId.get(up.previousEventId!)
                    : up?.type === 'LambdaFunctionFailed' ? byId.get(byId.get(up.previousEventId!)?.previousEventId ?? -1) : undefined;
                if (schedule?.type !== 'LambdaFunctionScheduled' || ++retries > OBSERVE_MAX_RETRIES
                    || schedule.lambdaFunctionScheduledEventDetails?.resource !== event.lambdaFunctionScheduledEventDetails?.resource) return null;
                up = byId.get(schedule.previousEventId!);
            }
            if (!up?.stateEnteredEventDetails?.name?.startsWith('Observe-')) return null;
            continue;
        }
        if (parent?.type !== parentType) return null;
        if (type.startsWith('Task')) {
            const own = taskDetails(event), up = taskDetails(parent);
            if (own?.resourceType !== 'aws-sdk:ec2' || !own.resource || own.resource !== up?.resource || up.resourceType !== 'aws-sdk:ec2') return null;
        }
    }
    // The failure that ended the execution was not also retried.
    if (events.some(event => event.type === 'LambdaFunctionScheduled' && event.previousEventId === failure.id)) return null;
    // Every provider call is a release step naming exactly this host (and, to detach, exactly its data volume).
    const scheduled = events.filter(event => event.type === 'TaskScheduled');
    for (const s of scheduled) {
        const details = s.taskScheduledEventDetails, entered = byId.get(s.previousEventId!);
        const parameters = parse(details?.parameters) as { InstanceIds?: unknown; InstanceId?: unknown; VolumeId?: unknown } | undefined;
        if (!details || details.resourceType !== 'aws-sdk:ec2' || details.region !== d.region || !RELEASE_TASKS.has(details.resource ?? '')
            || entered?.type !== 'TaskStateEntered' || entered.stateEnteredEventDetails?.name !== details.resource || !parameters) return null;
        if (details.resource === 'detachVolume'
            ? parameters.VolumeId !== volumeId || parameters.InstanceId !== instanceId
            : !Array.isArray(parameters.InstanceIds) || parameters.InstanceIds.length !== 1 || parameters.InstanceIds[0] !== instanceId) return null;
    }
    for (const done of events.filter(event => event.type === 'TaskSucceeded')) {
        const d = done.taskSucceededEventDetails!, out = parse(d.output) as Record<string, unknown> | undefined;
        if (!out || d.outputDetails?.truncated) return null;
        if (d.resource === 'detachVolume' ? out.InstanceId !== instanceId || out.VolumeId !== volumeId
            : d.resource === 'stopInstances' ? !Array.isArray(out.StoppingInstances) || out.StoppingInstances.length !== 1
                || (out.StoppingInstances[0] as { InstanceId?: unknown } | undefined)?.InstanceId !== instanceId
            : d.resource === 'terminateInstances' ? !Array.isArray(out.TerminatingInstances) || out.TerminatingInstances.length !== 1
                || (out.TerminatingInstances[0] as { InstanceId?: unknown } | undefined)?.InstanceId !== instanceId
            : true) return null;
    }
    let terminatedAt: Date | null = null;
    for (const s of scheduled.filter(event => event.taskScheduledEventDetails!.resource === 'terminateInstances')) {
        const started = events.find(event => event.type === 'TaskStarted' && event.previousEventId === s.id);
        if (started?.taskStartedEventDetails?.resource !== 'terminateInstances' || started.taskStartedEventDetails.resourceType !== 'aws-sdk:ec2') return null;
        // Only a terminal task outcome answers the request (a following state entry does not).
        const done = events.find(event => event.previousEventId === started.id && ANSWERS.has(event.type ?? ''));
        if (!done) return null; // An unanswered termination request is never a witness.
        if (done.type !== 'TaskSucceeded') continue;
        const out = parse(done.taskSucceededEventDetails?.output) as { TerminatingInstances?: { InstanceId?: unknown; CurrentState?: { Code?: unknown; Name?: unknown } }[] } | undefined;
        const items = out?.TerminatingInstances;
        if (done.taskSucceededEventDetails?.resource !== 'terminateInstances' || done.taskSucceededEventDetails.resourceType !== 'aws-sdk:ec2'
            || !Array.isArray(items) || items.length !== 1 || items[0]?.InstanceId !== instanceId) return null;
        if (items[0]?.CurrentState?.Code === 48 && items[0]?.CurrentState?.Name === 'terminated'
            && (!terminatedAt || done.timestamp!.getTime() < terminatedAt.getTime())) terminatedAt = done.timestamp!;
    }
    return terminatedAt ? { instanceId, executionArn: e.executionArn!, terminatedAt } : null;
}
