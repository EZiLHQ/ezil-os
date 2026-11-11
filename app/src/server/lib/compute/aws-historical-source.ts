import { createHash } from 'node:crypto';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { z } from 'zod';
import { buildLifecycleWork, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { isExecutionAbsent } from './aws-errors';
import { storedPoolWork } from './aws-pool-dispatch';
import { buildAdoptRecoveryWork } from './aws-pool-recovery';
import { lifecycleExecutionArn, LifecycleReceiptSchema, type LifecycleExecutionReader, type ReceiptDeps } from './aws-receipts';
import { replacementNeverLaunched, replacementWorkFromExecution, settleReplacementGeneration } from './aws-rebase-generation';
import { assertNoImageReservation, readCanaryComputer, readPlacement, type Placement } from './placement';

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
export function canonicalReleaseWork(input: string | undefined): LifecycleWork | null {
    try {
        const envelope = JSON.parse(input ?? '') as { schemaVersion?: unknown; document?: unknown; digest?: unknown };
        if (envelope.schemaVersion !== 1 || typeof envelope.document !== 'string' || typeof envelope.digest !== 'string'
            || Object.keys(envelope).length !== 3 || createHash('sha256').update(envelope.document).digest('hex') !== envelope.digest) return null;
        const document = JSON.parse(envelope.document) as Record<string, unknown>;
        const work = document.adoptRecoverRelease !== undefined ? buildAdoptRecoveryWork(document) as LifecycleWork : buildLifecycleWork(document as LifecycleWork['intent']);
        return work.digest === envelope.digest && work.input === input && work.intent.operation === 'release' ? work : null;
    } catch { return null; }
}

/** The recorded execution this history must match: input, output and its own start/stop interval. */
export interface WitnessBounds { input: string; output: string; startedAt: Date; stoppedAt: Date; region: string }
/** Complete SUCCEEDED execution history: canonical input/output, contiguous IDs, bounded timestamps, known events and no truncation. */
export function executionHistoryBound(events: readonly HistoryEvent[], bounds: WitnessBounds): boolean {
    const from = bounds.startedAt.getTime(), to = bounds.stoppedAt.getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to) || from > to) return false;
    if (events.length < 2 || events[0]?.type !== 'ExecutionStarted' || events[0].executionStartedEventDetails?.input !== bounds.input
        || events.at(-1)?.type !== 'ExecutionSucceeded' || events.at(-1)!.executionSucceededEventDetails?.output !== bounds.output) return false;
    const valid = events.every((event, index) => {
        const type = event.type ?? '';
        if (event.id !== index + 1 || !Number.isInteger(event.previousEventId) || event.previousEventId! < 0 || event.previousEventId! >= event.id
            || (index === 0 && event.previousEventId !== 0) || !(event.timestamp instanceof Date) || !Number.isFinite(event.timestamp.getTime())
            || event.timestamp.getTime() < from || event.timestamp.getTime() > to
            || !KNOWN.has(type) || type.startsWith('Execution') !== (index === 0 || index === events.length - 1) || truncated(event)) return false;
        if (type.endsWith('StateEntered') && !named(event.stateEnteredEventDetails?.name)) return false;
        if (type.endsWith('StateExited') && !named(event.stateExitedEventDetails?.name)) return false;
        return true;
    });
    return valid;
}

export function terminationWitnessed(events: readonly HistoryEvent[], bounds: WitnessBounds, instanceId: string): boolean {
    if (!executionHistoryBound(events, bounds)) return false;
    // Every termination request in this release names exactly this instance, and none is unanswered.
    const scheduled = events.filter(e => e.type === 'TaskScheduled' && /terminateinstances/i.test(e.taskScheduledEventDetails?.resource ?? ''));
    if (!scheduled.length) return false;
    let witnessed = false;
    for (const s of scheduled) {
        const d = s.taskScheduledEventDetails!;
        const parameters = parse(d.parameters) as { InstanceIds?: unknown } | undefined;
        const entered = events.find(e => e.id === s.previousEventId);
        if (d.resource !== 'terminateInstances' || d.resourceType !== 'aws-sdk:ec2' || d.region !== bounds.region || entered?.type !== 'TaskStateEntered'
            || entered.stateEnteredEventDetails?.name !== 'terminateInstances'
            || !Array.isArray(parameters?.InstanceIds) || parameters.InstanceIds.length !== 1 || parameters.InstanceIds[0] !== instanceId) return false;
        const started = events.find(e => e.type === 'TaskStarted' && e.previousEventId === s.id);
        if (started?.taskStartedEventDetails?.resource !== 'terminateInstances' || started.taskStartedEventDetails.resourceType !== 'aws-sdk:ec2') return false;
        const done = events.find(e => e.previousEventId === started.id && e.type?.startsWith('Task') && e.type !== 'TaskStateExited');
        if (!done) return false;
        if (done.type !== 'TaskSucceeded') continue;
        const out = parse(done.taskSucceededEventDetails?.output) as { TerminatingInstances?: { InstanceId?: unknown; CurrentState?: { Code?: unknown; Name?: unknown } }[] } | undefined;
        const items = out?.TerminatingInstances;
        if (done.taskSucceededEventDetails?.resource !== 'terminateInstances' || done.taskSucceededEventDetails.resourceType !== 'aws-sdk:ec2'
            || !Array.isArray(items) || items.length !== 1
            || items[0]?.InstanceId !== instanceId) return false;
        if (items[0]?.CurrentState?.Code === 48 && items[0]?.CurrentState?.Name === 'terminated') witnessed = true;
    }
    return witnessed;
}

/** Binds the release to the replace's source identity and timing; see HistoricalSourceProof. */
export function proveHistoricalSource(source: Execution, events: readonly HistoryEvent[], replace: LifecycleWork, replaceStartedAt: Date | null | undefined,
    requestedArn: string): HistoricalSourceProof | null {
    const r = replace.intent;
    if (r.operation !== 'replace' || r.rebasePreparation || !r.previousInstanceId || !r.previousFenceToken || !r.previousGeneration || !r.dataVolumeId) return null;
    if (source.executionArn !== requestedArn || source.status !== 'SUCCEEDED' || source.redriveCount !== 0 || source.stateMachineAliasArn
        || !source.input || !source.output || !(source.startDate instanceof Date) || !(source.stopDate instanceof Date) || !(replaceStartedAt instanceof Date)
        || !Number.isFinite(source.startDate.getTime()) || !Number.isFinite(source.stopDate.getTime())
        || !(source.startDate.getTime() <= source.stopDate.getTime()) || !(source.stopDate.getTime() < replaceStartedAt.getTime())) return null;
    const work = canonicalReleaseWork(source.input);
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
    if (!terminationWitnessed(events, { input: source.input, output: source.output, startedAt: source.startDate, stoppedAt: source.stopDate,
        region: d.region }, r.previousInstanceId)) return null;
    return { instanceId: r.previousInstanceId, releaseExecutionArn: source.executionArn };
}

/** DESIGN R (I7): a STOPPED computer's released warm-pool host as an image-rebase source. The retired claim row is only a
 * lookup hint and cross-check, never provider evidence:
 * (b) its pool-provision execution (input byte-equal to the row, SUCCEEDED, a strict receipt naming exactly this host and the
 *     placement's instance) supplies the launch tuple, AMI included;
 * (a) the operator-named release execution (a lookup hint, re-derived) proves this exact allocation (computer, instance,
 *     volume, generation, fence, lease epoch) was retired, with a witnessed `terminated` for exactly that instance.
 * EC2 absence is never termination. */
export interface ReleasedPoolHostProof { poolHostId: string; lifecycleDigest: string; releaseExecutionArn: string; provisioned: LifecycleDeployment }
const ProvisionReceiptSchema = z.object({ schemaVersion: z.literal(1), jobId: z.string(), digest: z.string(), computerId: z.string(),
    generation: z.number(), leaseEpoch: z.number(), fenceToken: z.string(), instanceId: z.string().regex(/^i-[a-f0-9]{17}$/), volumeId: z.null(),
    state: z.literal('running'), poolHostId: z.string(), poolGeneration: z.number() }).strict();
const RELEASE_JOB = /^arn:aws:states:[a-z0-9-]+:[0-9]{12}:execution:[A-Za-z0-9_-]{1,80}:computer-([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const sameAuthority = (a: LifecycleDeployment, b: LifecycleDeployment) => (['accountId', 'region', 'zoneId', 'namespace'] as const).every(k => a[k] === b[k]);

export function proveReleasedPoolHost(p: Placement, d: LifecycleDeployment, row: Record<string, unknown>, provision: Execution,
    release: Execution, events: readonly HistoryEvent[], requestedArn: string, now: Date): ReleasedPoolHostProof | null {
    try {
        if (p.state !== 'STOPPED' || !p.instanceId || !p.volumeId || !p.fenceToken || p.region !== d.region || p.zoneId !== d.zoneId) return null;
        const w = storedPoolWork(row), i = w.intent;
        if (i.operation !== 'pool-provision' || row.instance_id !== p.instanceId || !sameAuthority(i.deployment, d)
            || provision.executionArn !== lifecycleExecutionArn(i.deployment, i.jobId) || provision.input !== w.input
            || provision.stateMachineVersionArn !== w.stateMachineArn || provision.stateMachineAliasArn || provision.redriveCount !== 0
            || provision.status !== 'SUCCEEDED' || !(provision.stopDate instanceof Date) || !Number.isFinite(provision.stopDate.getTime())) return null;
        const pr = ProvisionReceiptSchema.safeParse(parse(provision.output ?? undefined));
        if (!pr.success || pr.data.jobId !== i.jobId || pr.data.digest !== w.digest || pr.data.computerId !== i.computerId
            || pr.data.generation !== i.targetGeneration || pr.data.leaseEpoch !== i.leaseEpoch || pr.data.fenceToken !== i.fenceToken
            || pr.data.poolHostId !== i.poolHostId || pr.data.poolGeneration !== i.poolGeneration || pr.data.instanceId !== p.instanceId) return null;
        // The hint names an execution of this namespace's lifecycle machine; its job is re-derived and every binding re-read.
        const job = RELEASE_JOB.exec(requestedArn)?.[1];
        if (!job || job === i.jobId || lifecycleExecutionArn(d, job) !== requestedArn || release.executionArn !== requestedArn
            || release.status !== 'SUCCEEDED' || release.redriveCount !== 0 || release.stateMachineAliasArn || !release.input || !release.output
            || !(release.startDate instanceof Date) || !(release.stopDate instanceof Date)
            || !(provision.stopDate.getTime() < release.startDate.getTime()) || !(release.startDate.getTime() <= release.stopDate.getTime())
            || !(release.stopDate.getTime() <= now.getTime())) return null;
        const work = canonicalReleaseWork(release.input);
        if (!work) return null;
        const r = work.intent;
        if (release.executionArn !== lifecycleExecutionArn(r.deployment, r.jobId) || release.stateMachineVersionArn !== work.stateMachineArn
            || r.computerId !== p.computerId || r.providerInstanceId !== p.instanceId || r.dataVolumeId !== p.volumeId
            || r.targetGeneration !== p.generation || r.fenceToken !== p.fenceToken || r.leaseEpoch !== p.leaseEpoch || !sameAuthority(r.deployment, d)) return null;
        const receipt = LifecycleReceiptSchema.safeParse(parse(release.output));
        if (!receipt.success) return null;
        const x = receipt.data;
        if (x.jobId !== r.jobId || x.digest !== work.digest || x.computerId !== p.computerId || x.generation !== p.generation
            || x.leaseEpoch !== p.leaseEpoch || x.fenceToken !== p.fenceToken || x.instanceId !== p.instanceId
            || x.volumeId !== p.volumeId || x.state !== 'retired' || x.instanceLost) return null;
        if (!terminationWitnessed(events, { input: release.input, output: release.output, startedAt: release.startDate,
            stoppedAt: release.stopDate, region: d.region }, p.instanceId)) return null;
        return { poolHostId: i.poolHostId!, lifecycleDigest: w.digest, releaseExecutionArn: requestedArn, provisioned: i.deployment };
    } catch { return null; }
}

/** Read-only SFN reads for proveReleasedPoolHost. No hint or history reader, a malformed hint or an absent execution is
 * "not proven" before or instead of any further read; other read failures propagate (uncertain, never a refusal). */
export async function readReleasedPoolHostProof(executions: LifecycleExecutionReader, p: Placement, d: LifecycleDeployment,
    row: Record<string, unknown>, requestedArn: string | undefined, now: Date): Promise<ReleasedPoolHostProof | null> {
    const job = requestedArn ? RELEASE_JOB.exec(requestedArn)?.[1] : undefined;
    if (!requestedArn || !job || lifecycleExecutionArn(d, job) !== requestedArn || !executions.history || !p.region) return null;
    let w: LifecycleWork;
    try { w = storedPoolWork(row); } catch { return null; }
    try {
        const provision = await executions.describe(p.region, lifecycleExecutionArn(w.intent.deployment, w.intent.jobId));
        const release = await executions.describe(p.region, requestedArn);
        return proveReleasedPoolHost(p, d, row, provision, release, await executions.history(p.region, requestedArn), requestedArn, now);
    } catch (error) { if (isExecutionAbsent(error)) return null; throw error; }
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
    const proof = proveHistoricalSource(source, await deps.executions.history(p.region!, request.sourceRetirementExecutionArn), work, e.startDate,
        request.sourceRetirementExecutionArn);
    if (!proof) return 'source_not_proven';
    return settleReplacementGeneration(settleDeps, p, work, false, true, proof);
}
