import { createHash } from 'node:crypto';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { z } from 'zod';
import { buildLifecycleWork, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { buildAdoptRecoveryWork } from './aws-pool-recovery';
import { lifecycleExecutionArn, LifecycleReceiptSchema, type LifecycleExecutionReader, type ReceiptDeps } from './aws-receipts';
import { replacementNeverLaunched, replacementWorkFromExecution, settleReplacementGeneration } from './aws-rebase-generation';
import { assertNoImageReservation, readCanaryComputer, readPlacement } from './placement';

type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;

/** A failed replace's previous instance that EC2 no longer lists (terminated and aged out) is never
 * presumed gone. This proves it from the release execution that retired it: the exact execution, its
 * immutable input and receipt bound to the replace's source identity, finished before the replace
 * started, with a complete history whose TerminateInstances result positively reported `terminated`
 * for exactly that instance. The ARN is only a lookup hint; every binding is re-read and checked. */
export interface HistoricalSourceProof { instanceId: string; releaseExecutionArn: string }

const KNOWN: ReadonlySet<string> = new Set(['ExecutionStarted', 'ExecutionSucceeded',
    'PassStateEntered', 'PassStateExited', 'TaskStateEntered', 'TaskStateExited', 'ChoiceStateEntered', 'ChoiceStateExited',
    'WaitStateEntered', 'WaitStateExited',
    'LambdaFunctionScheduled', 'LambdaFunctionStarted', 'LambdaFunctionSucceeded', 'LambdaFunctionFailed', 'LambdaFunctionTimedOut',
    'LambdaFunctionStartFailed', 'LambdaFunctionScheduleFailed',
    'TaskScheduled', 'TaskStarted', 'TaskSucceeded', 'TaskFailed', 'TaskTimedOut', 'TaskStartFailed', 'TaskSubmitted', 'TaskSubmitFailed']);
const named = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const truncated = (event: HistoryEvent) => Object.values(event).some(v => v && typeof v === 'object'
    && ((v as { inputDetails?: { truncated?: boolean } }).inputDetails?.truncated || (v as { outputDetails?: { truncated?: boolean } }).outputDetails?.truncated));
function parse(text: string | undefined): unknown {
    if (typeof text !== 'string') return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
}

/** The release work exactly as the execution received it: a normal release or an adopt-recovery release. */
function releaseWork(input: string | undefined): LifecycleWork | null {
    try {
        const envelope = JSON.parse(input ?? '') as { schemaVersion?: unknown; document?: unknown; digest?: unknown };
        if (envelope.schemaVersion !== 1 || typeof envelope.document !== 'string' || typeof envelope.digest !== 'string'
            || Object.keys(envelope).length !== 3 || createHash('sha256').update(envelope.document).digest('hex') !== envelope.digest) return null;
        const document = JSON.parse(envelope.document) as Record<string, unknown>;
        const work = document.adoptRecoverRelease !== undefined ? buildAdoptRecoveryWork(document) as LifecycleWork : buildLifecycleWork(document as LifecycleWork['intent']);
        return work.digest === envelope.digest && work.input === input && work.intent.operation === 'release' ? work : null;
    } catch { return null; }
}

/** Strict, complete history of a SUCCEEDED release with a positive termination witness for `instanceId`. */
export function terminationWitnessed(events: readonly HistoryEvent[], input: string, instanceId: string): boolean {
    if (events.length < 2 || events[0]?.type !== 'ExecutionStarted' || events[0].executionStartedEventDetails?.input !== input
        || events.at(-1)?.type !== 'ExecutionSucceeded') return false;
    const valid = events.every((event, index) => {
        const type = event.type ?? '';
        if (event.id !== index + 1 || !Number.isInteger(event.previousEventId) || event.previousEventId! < 0 || event.previousEventId! >= event.id
            || (index === 0 && event.previousEventId !== 0) || !(event.timestamp instanceof Date) || !Number.isFinite(event.timestamp.getTime())
            || !KNOWN.has(type) || type.startsWith('Execution') !== (index === 0 || index === events.length - 1) || truncated(event)) return false;
        if (type.endsWith('StateEntered') && !named(event.stateEnteredEventDetails?.name)) return false;
        if (type.endsWith('StateExited') && !named(event.stateExitedEventDetails?.name)) return false;
        return true;
    });
    if (!valid) return false;
    // Every termination request in this release names exactly this instance, and none is unanswered.
    const scheduled = events.filter(e => e.type === 'TaskScheduled' && /terminateinstances/i.test(e.taskScheduledEventDetails?.resource ?? ''));
    if (!scheduled.length) return false;
    let witnessed = false;
    for (const s of scheduled) {
        const d = s.taskScheduledEventDetails!;
        const parameters = parse(d.parameters) as { InstanceIds?: unknown } | undefined;
        const entered = events.find(e => e.id === s.previousEventId);
        if (d.resource !== 'terminateInstances' || d.resourceType !== 'aws-sdk:ec2' || entered?.type !== 'TaskStateEntered'
            || entered.stateEnteredEventDetails?.name !== 'terminateInstances'
            || !Array.isArray(parameters?.InstanceIds) || parameters.InstanceIds.length !== 1 || parameters.InstanceIds[0] !== instanceId) return false;
        const started = events.find(e => e.type === 'TaskStarted' && e.previousEventId === s.id);
        const done = started && events.find(e => e.previousEventId === started.id && e.type?.startsWith('Task') && e.type !== 'TaskStateExited');
        if (!done) return false;
        if (done.type !== 'TaskSucceeded') continue;
        const out = parse(done.taskSucceededEventDetails?.output) as { TerminatingInstances?: { InstanceId?: unknown; CurrentState?: { Code?: unknown; Name?: unknown } }[] } | undefined;
        const items = out?.TerminatingInstances;
        if (done.taskSucceededEventDetails?.resource !== 'terminateInstances' || !Array.isArray(items) || items.length !== 1
            || items[0]?.InstanceId !== instanceId) return false;
        if (items[0]?.CurrentState?.Code === 48 && items[0]?.CurrentState?.Name === 'terminated') witnessed = true;
    }
    return witnessed;
}

/** Binds the release to the replace's source identity and timing; see HistoricalSourceProof. */
export function proveHistoricalSource(source: Execution, events: readonly HistoryEvent[], replace: LifecycleWork, replaceStartedAt: Date | null | undefined): HistoricalSourceProof | null {
    const r = replace.intent;
    if (r.operation !== 'replace' || r.rebasePreparation || !r.previousInstanceId || !r.previousFenceToken || !r.previousGeneration || !r.dataVolumeId) return null;
    if (source.status !== 'SUCCEEDED' || source.redriveCount !== 0 || source.stateMachineAliasArn || !source.input || !source.output
        || !(source.stopDate instanceof Date) || !(replaceStartedAt instanceof Date) || !Number.isFinite(source.stopDate.getTime())
        || !(source.stopDate.getTime() <= replaceStartedAt.getTime())) return null;
    const work = releaseWork(source.input);
    if (!work) return null;
    const i = work.intent, d = i.deployment;
    if (source.executionArn !== lifecycleExecutionArn(d, i.jobId) || source.stateMachineVersionArn !== work.stateMachineArn
        || i.computerId !== r.computerId || i.providerInstanceId !== r.previousInstanceId || i.dataVolumeId !== r.dataVolumeId
        || i.targetGeneration !== r.previousGeneration || i.fenceToken !== r.previousFenceToken || !(i.leaseEpoch < r.leaseEpoch)
        || (['accountId', 'region', 'zoneId', 'namespace'] as const).some(k => d[k] !== r.deployment[k])) return null;
    const receipt = LifecycleReceiptSchema.safeParse(parse(source.output));
    if (!receipt.success) return null;
    const x = receipt.data;
    if (x.jobId !== i.jobId || x.digest !== work.digest || x.computerId !== i.computerId || x.generation !== i.targetGeneration
        || x.leaseEpoch !== i.leaseEpoch || x.fenceToken !== i.fenceToken || x.instanceId !== i.providerInstanceId
        || x.volumeId !== i.dataVolumeId || x.state !== 'retired' || x.instanceLost) return null;
    if (!terminationWitnessed(events, source.input, r.previousInstanceId)) return null;
    return { instanceId: r.previousInstanceId, releaseExecutionArn: source.executionArn };
}

const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
/** `reconcile-replacement` on the signed image-rebase operator route. */
export const ReconcileReplacementRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('reconcile-replacement'),
    computerId: Uuid, expectedJobId: Uuid, sourceRetirementExecutionArn: z.string().min(1).max(300) }).strict();
export type ReconcileReplacementRequest = z.infer<typeof ReconcileReplacementRequestSchema>;
export type ReconcileReplacementOutcome = 'settled' | 'unconfirmed' | 'generation_drift' | 'not_applicable' | 'launch_not_disproven' | 'source_not_proven';
/** Read-only EC2 and Step Functions readers only: this path has no starter and never starts or mutates provider resources. */
export type ReconcileReplacementDeps = Pick<ReceiptDeps, 'db' | 'now' | 'clock'> & {
    executions: LifecycleExecutionReader; describer: NonNullable<ReceiptDeps['describer']>;
    /** Required: settlement always fences the failed generation's tunnel. */
    tunnels: NonNullable<ReceiptDeps['tunnels']>;
};

/** Operator-supplied lookup hint for the failed replace named by `expectedJobId`, stuck on a source EC2 no longer
 * lists. Nothing in the request is trusted: the placement's own failed replace, its no-launch history, the named
 * release execution and its termination witness are re-read, and settlement uses the normal tunnel fence + CAS.
 * Only the failed-replacement branch runs (never image recovery, ensure or applyLifecycleReceipt). */
export async function reconcileReplacementWithHistoricalSource(deps: ReconcileReplacementDeps, deployments: Record<string, LifecycleDeployment>,
    request: ReconcileReplacementRequest): Promise<ReconcileReplacementOutcome> {
    await assertNoImageReservation(deps.db, request.computerId);
    const computer = await readCanaryComputer(deps.db, request.computerId);
    const p = (await readPlacement(deps.db, request.computerId)).record;
    const d = p?.region ? deployments[p.region] : undefined;
    if (!computer || computer.deleted || !p || !d || p.ownerUserId !== computer.userId || p.provider !== 'aws-ec2'
        || p.lifecycleJobId !== request.expectedJobId || !p.lifecycleDigest || !deps.executions.history) return 'not_applicable';
    const settleDeps: ReceiptDeps = { db: deps.db, executions: deps.executions, describer: deps.describer, tunnels: deps.tunnels,
        ...(deps.now ? { now: deps.now } : {}), ...(deps.clock ? { clock: deps.clock } : {}) };
    const e = await deps.executions.describe(p.region!, lifecycleExecutionArn(d, request.expectedJobId));
    const work = replacementWorkFromExecution(p, d, e);
    if (!work) return 'not_applicable';
    if (!await replacementNeverLaunched(settleDeps, p, work, e)) return 'launch_not_disproven';
    // The hint must name an execution of the replace's own lifecycle machine; its job id is then re-derived.
    const job = /:computer-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(request.sourceRetirementExecutionArn)?.[1];
    if (!job || job === work.intent.jobId || lifecycleExecutionArn(work.intent.deployment, job) !== request.sourceRetirementExecutionArn) return 'source_not_proven';
    const source = await deps.executions.describe(p.region!, request.sourceRetirementExecutionArn);
    const proof = proveHistoricalSource(source, await deps.executions.history(p.region!, request.sourceRetirementExecutionArn), work, e.startDate);
    if (!proof) return 'source_not_proven';
    return settleReplacementGeneration(settleDeps, p, work, false, true, proof);
}
