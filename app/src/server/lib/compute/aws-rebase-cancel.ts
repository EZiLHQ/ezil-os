import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { z } from 'zod';
import type { Ec2VolumeDescriber } from './aws-clients';
import type { Ec2EnrollmentDescriber } from './aws-enroll';
import { isExecutionAbsent } from './aws-errors';
import { assertImageExecution, preparationFor, type Execution } from './aws-rebase-evidence';
import { RebaseUuid } from './aws-rebase-json';
import type { LifecycleExecutionReader } from './aws-receipts';
import { cancellablePreparation, type createImageJobStore, type ImageJob } from './aws-rebase-store';

/** `cancel-preparation` on the signed image-rebase operator route. `check` never writes; `apply` is the normal store CAS. */
export const CancelPreparationRequestSchema = z.object({ schemaVersion: z.literal(1), operation: z.literal('cancel-preparation'),
    computerId: RebaseUuid, expectedJobId: RebaseUuid, mode: z.enum(['check', 'apply']) }).strict();
export type CancelPreparationRequest = z.infer<typeof CancelPreparationRequestSchema>;
export type CancelPreparationOutcome = 'cancelled' | 'eligible' | 'not_applicable' | 'execution_not_proven' | 'provider_not_proven';
export interface CancelPreparationDeps {
    store: Pick<ReturnType<typeof createImageJobStore>, 'read' | 'inspect' | 'cancelPreparation'>;
    executions: LifecycleExecutionReader; describer: Ec2VolumeDescriber & Pick<Ec2EnrollmentDescriber, 'describeForEnrollment'>;
    now: () => Date;
}

// Only Init -> Observe-initial -> CheckResult -> Failed: the observer's first look refused. stopInstances,
// terminateInstances and createSnapshot (the only EC2 mutations) are reachable only through Decide.
const PATH = ['Init', 'Observe-initial', 'CheckResult', 'Failed'];
const ALLOWED: ReadonlySet<string> = new Set(['ExecutionStarted', 'PassStateEntered', 'PassStateExited', 'TaskStateEntered', 'TaskStateExited',
    'ChoiceStateEntered', 'ChoiceStateExited', 'LambdaFunctionScheduled', 'LambdaFunctionStarted', 'LambdaFunctionSucceeded',
    'LambdaFunctionFailed', 'LambdaFunctionTimedOut', 'FailStateEntered', 'ExecutionFailed']);
const truncated = (event: HistoryEvent) => Object.values(event).some(v => v && typeof v === 'object'
    && ((v as { inputDetails?: { truncated?: boolean } }).inputDetails?.truncated || (v as { outputDetails?: { truncated?: boolean } }).outputDetails?.truncated));
function parse(text: string | undefined): unknown {
    if (typeof text !== 'string') return undefined;
    try { return JSON.parse(text); } catch { return undefined; }
}

/** The preparation execution FAILED at its first observation and its complete history schedules no EC2 task. */
export function preparationNeverMutated(j: ImageJob, e: Execution, events: readonly HistoryEvent[]): boolean {
    try { assertImageExecution(e, preparationFor(j)); } catch { return false; }
    if (e.status !== 'FAILED' || e.error !== 'RebasePreparationFailed' || !j.failureCode || e.cause !== j.failureCode
        || !(e.startDate instanceof Date) || !(e.stopDate instanceof Date) || !(e.startDate.getTime() <= e.stopDate.getTime())) return false;
    if (!events.length || events.some((event, index) => event.id !== index + 1 || !ALLOWED.has(event.type ?? '') || truncated(event)
        || !(event.timestamp instanceof Date) || event.timestamp.getTime() < e.startDate!.getTime() || event.timestamp.getTime() > e.stopDate!.getTime())) return false;
    const first = events[0]!, last = events[events.length - 1]!;
    if (first.type !== 'ExecutionStarted' || first.executionStartedEventDetails?.input !== e.input
        || last.type !== 'ExecutionFailed' || last.executionFailedEventDetails?.error !== 'RebasePreparationFailed'
        || last.executionFailedEventDetails.cause !== j.failureCode || events.slice(0, -1).some(event => event.type === 'ExecutionFailed')) return false;
    const entered = events.filter(event => event.type?.endsWith('StateEntered')).map(event => event.stateEnteredEventDetails?.name);
    if (entered.length !== PATH.length || entered.some((name, index) => name !== PATH[index])) return false;
    const observed = events.filter(event => event.type === 'LambdaFunctionSucceeded');
    if (observed.length !== 1) return false;
    const step = parse(observed[0]!.lambdaFunctionSucceededEventDetails?.output) as Record<string, unknown> | undefined;
    return !!step && Object.keys(step).length === 2 && step.decision === 'failed' && step.code === j.failureCode;
}

/** The source volume is still exactly the reserved source: free, unattached, this generation's identity, never a pool disk. */
export function sourceUntouched(j: ImageJob, volume: Awaited<ReturnType<Ec2VolumeDescriber['describeVolume']>>,
    host: Awaited<ReturnType<Ec2EnrollmentDescriber['describeForEnrollment']>>): boolean {
    const i = preparationFor(j).intent, d = i.deployment;
    const tags: Record<string, string> = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace, 'ezil:computer-id': i.computerId,
        'ezil:generation': String(i.sourceGeneration), 'ezil:fence-token': i.sourceFenceToken, 'ezil:backup': d.namespace };
    if (!volume || volume.volumeId !== j.sourceVolumeId || volume.state !== 'available' || !Array.isArray(volume.attachments) || volume.attachments.length
        || volume.encrypted !== true || volume.kmsKeyId !== d.dataKeyArn || volume.sizeGiB !== i.volumeGiB
        || (volume.zoneId !== undefined && volume.zoneId !== d.zoneId) || !volume.tags || 'ezil:pool' in volume.tags
        || Object.entries(tags).some(([k, v]) => volume.tags![k] !== v)) return false;
    // EC2 may no longer list the source; a listed one must not be a writer.
    return !host || (host.instanceId === j.sourceInstanceId && ['stopped', 'terminated'].includes(host.state));
}

/** Explicit operator cancel of a reserved image job whose preparation failed before any EC2 mutation. Never implied by
 * verify/recover. Everything is re-read; the apply recheck runs under the admission/placement locks with the job CAS. */
export async function cancelFailedPreparation(deps: CancelPreparationDeps, request: CancelPreparationRequest): Promise<CancelPreparationOutcome> {
    const j = await deps.store.read(request.expectedJobId);
    if (!j || j.computerId !== request.computerId) return 'not_applicable';
    if (j.phase === 'cancelled') return cancellablePreparation({ ...j, phase: 'failed', retentionHold: true, completedAt: null }) ? 'cancelled' : 'not_applicable';
    if (!cancellablePreparation(j)) return 'not_applicable';
    const inspected = await deps.store.inspect(request.computerId);
    if (inspected.job?.jobId !== j.jobId || JSON.stringify(inspected.job) !== JSON.stringify(j)) return 'not_applicable';
    if (!deps.executions.history) return 'execution_not_proven';
    let e: Execution;
    try { e = await deps.executions.describe(j.region, j.preparationExecutionArn!); }
    catch (error) { if (isExecutionAbsent(error)) return 'execution_not_proven'; throw error; }
    if (!preparationNeverMutated(j, e, await deps.executions.history(j.region, j.preparationExecutionArn!))) return 'execution_not_proven';
    const [volume, host] = await Promise.all([deps.describer.describeVolume(j.region, j.sourceVolumeId),
        deps.describer.describeForEnrollment(j.region, j.sourceInstanceId)]);
    if (!sourceUntouched(j, volume, host)) return 'provider_not_proven';
    if (request.mode === 'check') return 'eligible';
    await deps.store.cancelPreparation(j, deps.now());
    return 'cancelled';
}
