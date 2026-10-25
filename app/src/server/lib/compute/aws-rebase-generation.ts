import { createHash } from 'node:crypto';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { z } from 'zod';
import { buildLifecycleWork, KNOWN_INSTANCE_TYPES, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import type { HistoricalSourceProof } from './aws-historical-source';
import { parseRebaseJson, RebaseHash } from './aws-rebase-json';
import { reconcileReplacementGeneration, type Placement } from './placement';
import type { LifecycleExecutionReader, ReceiptDeps } from './aws-receipts';

const envelopeSchema = z.object({ schemaVersion: z.literal(1), document: z.string(), digest: RebaseHash }).strict();
type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;

/** The execution input, not today's deployment or generation-1, supplies source authority. */
export function replacementWorkFromExecution(p: Placement, d: LifecycleDeployment, e: Execution): LifecycleWork | null {
    try {
        if (!e.input || !['FAILED', 'TIMED_OUT', 'ABORTED'].includes(e.status)
            || e.stateMachineAliasArn || e.redriveCount !== 0) return null;
        const envelope = envelopeSchema.parse(parseRebaseJson(e.input, 20000));
        if (envelope.digest !== p.lifecycleDigest || createHash('sha256').update(envelope.document).digest('hex') !== envelope.digest) return null;
        const work = buildLifecycleWork(parseRebaseJson(envelope.document) as LifecycleWork['intent']);
        const arn = d.stateMachineVersionArn.replace(':stateMachine:', ':execution:').replace(/:[1-9][0-9]*$/, `:computer-${work.intent.jobId}`);
        if (e.executionArn !== arn || work.digest !== envelope.digest || work.intent.deployment.stateMachineVersionArn !== e.stateMachineVersionArn
            || work.intent.deployment.accountId !== d.accountId || work.intent.deployment.region !== d.region || work.intent.deployment.namespace !== d.namespace) return null;
        return matchesPlacement(work, p) ? work : null;
    } catch { return null; }
}

function matchesPlacement(work: LifecycleWork, p: Placement): boolean {
    const i = work.intent;
    return i.operation === 'replace' && !('rebasePreparation' in i) && i.jobId === p.lifecycleJobId && work.digest === p.lifecycleDigest
        && i.computerId === p.computerId && i.targetGeneration === p.generation && i.leaseEpoch === p.leaseEpoch
        && i.fenceToken === p.fenceToken && i.dataVolumeId === p.volumeId && i.deployment.region === p.region && i.deployment.zoneId === p.zoneId;
}

const LAUNCH_STATES: readonly string[] = ['runInstances', 'runBurstableInstances'];
const TERMINAL_EVENT: Record<string, string> = { FAILED: 'ExecutionFailed', TIMED_OUT: 'ExecutionTimedOut', ABORTED: 'ExecutionAborted' };
/** Every event type the lifecycle graph can record; anything else is unexplained and not proof. */
const KNOWN_EVENTS: ReadonlySet<string> = new Set(['ExecutionStarted', 'ExecutionFailed', 'ExecutionTimedOut', 'ExecutionAborted',
    'PassStateEntered', 'PassStateExited', 'TaskStateEntered', 'TaskStateExited', 'ChoiceStateEntered', 'ChoiceStateExited',
    'WaitStateEntered', 'WaitStateExited', 'FailStateEntered',
    'LambdaFunctionScheduled', 'LambdaFunctionStarted', 'LambdaFunctionSucceeded', 'LambdaFunctionFailed', 'LambdaFunctionTimedOut',
    'LambdaFunctionStartFailed', 'LambdaFunctionScheduleFailed',
    'TaskScheduled', 'TaskStarted', 'TaskSucceeded', 'TaskFailed', 'TaskTimedOut', 'TaskStartFailed', 'TaskSubmitted', 'TaskSubmitFailed']);
const TASK_DETAILS = ['taskScheduledEventDetails', 'taskStartedEventDetails', 'taskSucceededEventDetails', 'taskFailedEventDetails',
    'taskTimedOutEventDetails', 'taskStartFailedEventDetails', 'taskSubmittedEventDetails', 'taskSubmitFailedEventDetails'] as const;
const named = (value: unknown) => typeof value === 'string' && value.length > 0;

function knownEvent(event: HistoryEvent, index: number, count: number): boolean {
    const type = event.type ?? '';
    if (event.id !== index + 1 || !Number.isInteger(event.previousEventId) || event.previousEventId! < 0
        || event.previousEventId! >= event.id || (index === 0 && event.previousEventId !== 0)
        || !(event.timestamp instanceof Date) || !Number.isFinite(event.timestamp.getTime()) || !KNOWN_EVENTS.has(type)
        || (type === 'ExecutionStarted') !== (index === 0) || type.startsWith('Execution') !== (index === 0 || index === count - 1)) return false;
    if (type.endsWith('StateEntered') && (!named(event.stateEnteredEventDetails?.name) || LAUNCH_STATES.includes(event.stateEnteredEventDetails!.name!))) return false;
    if (type.endsWith('StateExited') && (!named(event.stateExitedEventDetails?.name) || LAUNCH_STATES.includes(event.stateExitedEventDetails!.name!))) return false;
    if (type.startsWith('Task') && !type.startsWith('TaskState')) {
        const details = TASK_DETAILS.map(key => event[key] as { resource?: string; resourceType?: string } | undefined).filter(Boolean);
        if (details.length !== 1 || !named(details[0]!.resource) || !named(details[0]!.resourceType) || /runinstances/i.test(details[0]!.resource!)) return false;
    }
    return !Object.values(event).some(v => v && typeof v === 'object' && ((v as { inputDetails?: { truncated?: boolean } }).inputDetails?.truncated
        || (v as { outputDetails?: { truncated?: boolean } }).outputDetails?.truncated));
}

/** Complete, untruncated, never-redriven history of exactly this replacement's execution: known event types only,
 * strict ids/predecessors/timestamps, named state transitions, and neither launch state entered or exited nor a
 * launch call recorded. Anything else is not proof. */
export function proveReplacementNeverLaunched(e: Execution, work: LifecycleWork, events: readonly HistoryEvent[]): boolean {
    const terminal = TERMINAL_EVENT[e.status];
    if (!terminal || e.redriveCount !== 0 || e.stateMachineAliasArn || e.input !== work.input || events.length < 2
        || events[0]?.type !== 'ExecutionStarted' || events[0].executionStartedEventDetails?.input !== work.input
        || events.at(-1)?.type !== terminal) return false;
    return events.every((event, index) => knownEvent(event, index, events.length));
}

/** Reads the history only for a replacement; any read failure is "not proven". */
export async function replacementNeverLaunched(deps: ReceiptDeps, p: Placement, work: LifecycleWork, e: Execution): Promise<boolean> {
    if (work.intent.operation !== 'replace' || !deps.executions?.history || !e.executionArn || !p.region) return false;
    try { return proveReplacementNeverLaunched(e, work, await deps.executions.history(p.region, e.executionArn)); }
    catch { return false; }
}

/** No EC2 writes. Unknown, absent or contradictory evidence keeps provisional authority reserved.
 * `neverLaunched`: the execution's complete history proves no launch, so zero writers is an answer.
 * `historical`: an authenticated release-execution termination proof (aws-historical-source) for a
 * source EC2 no longer lists; used only for exactly that absent source of a proven no-launch replace. */
export async function settleReplacementGeneration(deps: ReceiptDeps, p: Placement, work: LifecycleWork,
    startDefinitelyRefused = false, neverLaunched = false, historical?: HistoricalSourceProof): Promise<'settled' | 'unconfirmed' | 'generation_drift'> {
    if (!matchesPlacement(work, p) || !deps.describer?.describeVolume || !deps.describer.describeReplacementWriters) return 'unconfirmed';
    const i = work.intent;
    const common = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': i.deployment.namespace, 'ezil:computer-id': i.computerId };
    const tagsMatch = (tags: Readonly<Record<string, string>> | undefined, generation: number, fence: string) => !!tags
        && Object.entries({ ...common, 'ezil:generation': String(generation), 'ezil:fence-token': fence }).every(([k, v]) => tags[k] === v)
        && tags['ezil:pool'] === undefined;
    // Every PRESENT source identity alias (cold-launch, claim, namespace) must agree before either alternative.
    const sourceAliasesAgree = (tags: Readonly<Record<string, string>>) => Object.entries({ 'ezil:managed-by': 'app-computer-platform',
        'ezil:stage': i.deployment.namespace, 'ezil:namespace': i.deployment.namespace, 'ezil:computer-id': i.computerId, 'ezil:computer': i.computerId,
        'ezil:generation': String(i.previousGeneration), 'ezil:fence-token': i.previousFenceToken!, 'ezil:fence': i.previousFenceToken! })
        .every(([k, v]) => tags[k] === undefined || tags[k] === v);
    // A source released through the pool carries the claim identity instead; it is accepted only once terminated.
    const releasedPoolSource = (tags: Readonly<Record<string, string>> | undefined) => !!tags
        && Object.entries({ 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': i.deployment.namespace, 'ezil:namespace': i.deployment.namespace,
            'ezil:computer': i.computerId, 'ezil:generation': String(i.previousGeneration), 'ezil:fence': i.previousFenceToken! }).every(([k, v]) => tags[k] === v)
        && !!tags['ezil:pool-host'] && ['ezil:computer-id', 'ezil:fence-token', 'ezil:pool'].every(k => tags[k] === undefined);
    try {
        const token = createHash('sha256').update(`ezil-lifecycle-v1\ninstance\n${work.digest}`).digest('hex');
        const source = await deps.describer.describeForEnrollment(p.region!, i.previousInstanceId!);
        const targets = await deps.describer.describeReplacementWriters(p.region!, token);
        // Positive source fence. An unanswered launch needs positive target termination too;
        // a tag search returning zero is not proof that an uncertain launch did nothing.
        // Absence alone is never termination: an unlisted source needs the historical proof for exactly it.
        const gone = source === null && neverLaunched && !startDefinitelyRefused && historical?.instanceId === i.previousInstanceId;
        const listed = !!source && source.instanceId === i.previousInstanceId && source.availabilityZoneId === i.deployment.zoneId && sourceAliasesAgree(source.tags)
            && (tagsMatch(source.tags, i.previousGeneration!, i.previousFenceToken!) || (source.state === 'terminated' && releasedPoolSource(source.tags)))
            && (source.state === 'terminated' || (startDefinitelyRefused && source.state === 'stopped'));
        if (!(gone || listed) || targets.length > 1 || (!startDefinitelyRefused && !neverLaunched && targets.length !== 1)
            || (neverLaunched && targets.length !== 0)) return 'unconfirmed';
        if (source?.state === 'stopped' && (!source.instanceType || !KNOWN_INSTANCE_TYPES.includes(source.instanceType))) return 'unconfirmed';
        const target = targets[0];
        if (target && (startDefinitelyRefused || target.state !== 'terminated' || target.accountId !== i.deployment.accountId
            || target.clientToken !== token || !/^i-[0-9a-f]{17}$/.test(target.instanceId)
            || !tagsMatch(target.tags, i.targetGeneration, i.fenceToken))) return 'unconfirmed';
        const volume = await deps.describer.describeVolume(p.region!, i.dataVolumeId!);
        if (!volume || volume.volumeId !== i.dataVolumeId || volume.encrypted !== true || volume.kmsKeyId !== i.deployment.dataKeyArn
            || !volume.attachments || volume.tags?.['ezil:backup'] !== i.deployment.namespace) return 'unconfirmed';
        const sourcePair = tagsMatch(volume.tags, i.previousGeneration!, i.previousFenceToken!);
        const targetPair = tagsMatch(volume.tags, i.targetGeneration, i.fenceToken);
        if (!sourcePair && !targetPair) return 'generation_drift';
        if (targetPair && !target) return 'unconfirmed';
        const attachedToStoppedSource = !!source && startDefinitelyRefused && source.state === 'stopped' && sourcePair
            && volume.state === 'in-use' && volume.attachments.length === 1
            && volume.attachments[0]!.instanceId === source.instanceId && volume.attachments[0]!.state === 'attached'
            && source.volumes.some((v) => v.volumeId === volume.volumeId && v.deleteOnTermination === false);
        if (!attachedToStoppedSource && (volume.state !== 'available' || volume.attachments.length !== 0)) return 'unconfirmed';
        if (deps.tunnels) {
            const { awsSandboxId } = await import('./aws-enroll');
            const fenced = await deps.tunnels.deleteTunnel({ userId: p.ownerUserId }, {
                computerId: p.computerId, sandboxId: awsSandboxId(p.ownerUserId, p.computerId), generation: p.generation, leaseEpoch: p.leaseEpoch,
            });
            if (!fenced.ok) return 'unconfirmed';
        }
        const result = await reconcileReplacementGeneration(deps.db, p, {
            generation: sourcePair ? i.previousGeneration! : i.targetGeneration,
            fenceToken: sourcePair ? i.previousFenceToken! : i.fenceToken,
            instanceId: sourcePair ? i.previousInstanceId! : target!.instanceId,
            instanceLost: sourcePair ? gone || source?.state === 'terminated' : true,
            ...(sourcePair && source?.state === 'stopped' ? { instanceType: source.instanceType } : {}),
        });
        return result.ok ? 'settled' : 'unconfirmed';
    } catch { return 'unconfirmed'; }
}
