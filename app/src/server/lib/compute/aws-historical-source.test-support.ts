import { vi } from 'vitest';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { buildLifecycleWork, type LifecycleWork } from './aws-intent';
import { buildEnrollmentUserData } from './aws-enroll';
import { adoptRecoverySetup, RECOVERY_NOW } from './aws-pool-adopt-recovery.test-support';
import { lifecycleExecutionArn, type LifecycleExecutionReader } from './aws-receipts';
import type { ReconcileReplacementDeps } from './aws-historical-source';

type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
export const REPLACE_JOB = '7762c354-7a0b-4bdf-868b-bff9ea87be7c';
export const REPLACE_FENCE = 'fcfcfcfc-fcfc-4cfc-8cfc-fcfcfcfcfcfc';
const at = (base: Date, ms: number) => new Date(base.getTime() + ms);
const chain = (events: Partial<HistoryEvent>[], start: Date): HistoryEvent[] =>
    events.map((e, n) => ({ ...e, id: n + 1, previousEventId: n, timestamp: at(start, n * 10) })) as HistoryEvent[];
const entered = (type: string, name: string): Partial<HistoryEvent> => ({ type: type as HistoryEvent['type'], stateEnteredEventDetails: { name } });
const exited = (type: string, name: string): Partial<HistoryEvent> => ({ type: type as HistoryEvent['type'], stateExitedEventDetails: { name } });
const lambda = (name: string): Partial<HistoryEvent>[] => [entered('TaskStateEntered', name),
    { type: 'LambdaFunctionScheduled', lambdaFunctionScheduledEventDetails: { resource: 'arn:aws:lambda:ap-south-1:123456789012:function:helper:1' } },
    { type: 'LambdaFunctionStarted' }, { type: 'LambdaFunctionSucceeded', lambdaFunctionSucceededEventDetails: { output: '{}' } }, exited('TaskStateExited', name),
    entered('ChoiceStateEntered', 'Decide'), exited('ChoiceStateExited', 'Decide')];

/** The release's complete history, with a connected TerminateInstances chain answered `terminated` (Code 48). */
export function releaseHistory(input: string, instanceId: string, start: Date, current: { Code: number; Name: string } = { Code: 48, Name: 'terminated' }): HistoryEvent[] {
    return chain([
        { type: 'ExecutionStarted', executionStartedEventDetails: { input } },
        entered('PassStateEntered', 'Init'), exited('PassStateExited', 'Init'),
        ...lambda('Observe-detached'),
        entered('TaskStateEntered', 'terminateInstances'),
        { type: 'TaskScheduled', taskScheduledEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'terminateInstances', region: 'ap-south-1',
            parameters: JSON.stringify({ InstanceIds: [instanceId] }) } },
        { type: 'TaskStarted', taskStartedEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'terminateInstances' } },
        { type: 'TaskSucceeded', taskSucceededEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'terminateInstances',
            output: JSON.stringify({ TerminatingInstances: [{ CurrentState: current, InstanceId: instanceId, PreviousState: { Code: 80, Name: 'stopped' } }] }) } },
        exited('TaskStateExited', 'terminateInstances'),
        ...lambda('Observe-terminated'),
        entered('PassStateEntered', 'Succeeded'), exited('PassStateExited', 'Succeeded'),
        { type: 'ExecutionSucceeded', executionSucceededEventDetails: { output: '{}' } },
    ], start);
}
/** The 1.0.16 canary's failed replace: Observe-initial failed before any launch (10 events). */
export function failedReplaceHistory(input: string, start: Date): HistoryEvent[] {
    return chain([
        { type: 'ExecutionStarted', executionStartedEventDetails: { input } },
        entered('PassStateEntered', 'Init'), exited('PassStateExited', 'Init'), entered('TaskStateEntered', 'Observe-initial'),
        { type: 'LambdaFunctionScheduled', lambdaFunctionScheduledEventDetails: { resource: 'arn:aws:lambda:ap-south-1:123456789012:function:helper:2' } },
        { type: 'LambdaFunctionStarted' }, { type: 'LambdaFunctionFailed', lambdaFunctionFailedEventDetails: { error: 'LifecycleFailure', cause: 'lifecycle_instance_invalid' } },
        exited('TaskStateExited', 'Observe-initial'), entered('FailStateEntered', 'Unconfirmed'),
        { type: 'ExecutionFailed', executionFailedEventDetails: { error: 'LifecycleUnconfirmed' } },
    ], start);
}

/** Real adopt-recovery release (via the product's own recovery), then a cold replace on the newer version that
 * failed before launch, with the released source no longer listed by EC2. Synthetic identities only. */
export async function historicalSourceSetup() {
    const s = adoptRecoverySetup();
    await s.tick();
    const release = s.starts[0]!;
    const releaseExecution = s.finish() as Execution;
    await s.tick();
    const stopped = await s.current();
    const deployment = s.currentDeployment;
    const replace: LifecycleWork = buildLifecycleWork({ schemaVersion: 1, jobId: REPLACE_JOB, computerId: stopped.computerId, revision: 1,
        operation: 'replace', targetGeneration: stopped.generation + 1, fenceToken: REPLACE_FENCE, providerInstanceId: null,
        dataVolumeId: stopped.volumeId, previousGeneration: stopped.generation, previousInstanceId: stopped.instanceId,
        previousFenceToken: stopped.fenceToken, deployment, instanceType: stopped.instanceType!, dataVolumeGiB: null, leaseEpoch: stopped.leaseEpoch + 1,
        userData: buildEnrollmentUserData({ computerId: stopped.computerId, volumeId: stopped.volumeId, fsUuid: stopped.fsUuid ?? '22222222-2222-4222-8222-222222222222',
            generation: stopped.generation + 1, leaseEpoch: stopped.leaseEpoch + 1, nonce: 'n'.repeat(43), provision: false,
            enrollUrl: 'https://os.example.com/api/compute/aws/enroll' }) });
    // Admission cleared instance_id; the failed replace left the row UNCONFIRMED (as the canary's was).
    Object.assign(s.placements[0]!, { state: 'UNCONFIRMED', generation: replace.intent.targetGeneration, lease_epoch: replace.intent.leaseEpoch,
        instance_id: null, fence_token: REPLACE_FENCE, lifecycle_job_id: REPLACE_JOB, lifecycle_digest: replace.digest,
        last_error: 'pool_release_recovery:{"error":"placement_identity"}', enroll_nonce_hash: 'a'.repeat(64), enroll_consumed_hash: null,
        enroll_expires_at: at(RECOVERY_NOW, 600_000) });
    const replaceStart = at(RECOVERY_NOW, 1_000);
    const replaceExecution: Execution = { status: 'FAILED', error: 'LifecycleUnconfirmed', input: replace.input,
        executionArn: lifecycleExecutionArn(deployment, REPLACE_JOB), stateMachineVersionArn: replace.stateMachineArn, redriveCount: 0,
        startDate: replaceStart, stopDate: at(replaceStart, 400) };
    const releaseArn = releaseExecution.executionArn!;
    const histories = new Map<string, HistoryEvent[]>([
        [releaseArn, releaseHistory(release.input, stopped.instanceId!, at(RECOVERY_NOW, -15_000))],
        [replaceExecution.executionArn!, failedReplaceHistory(replace.input, replaceStart)],
    ]);
    const executionMap = new Map<string, Execution>([[releaseArn, releaseExecution], [replaceExecution.executionArn!, replaceExecution]]);
    const volume = { ...s.volume, state: 'available', attachments: [] as { instanceId: string; state: string }[],
        tags: { ...s.volume.tags, 'ezil:backup': deployment.namespace } as Record<string, string> };
    const tunnels = { deleteTunnel: vi.fn(async () => ({ ok: true as const })) };
    const describer = { describeForEnrollment: vi.fn(async () => null as Awaited<ReturnType<NonNullable<ReconcileReplacementDeps['describer']>['describeForEnrollment']>>),
        describeVolume: vi.fn(async () => volume), describeReplacementWriters: vi.fn(async () => [] as never[]) };
    const executions = { describe: vi.fn(async (_region: string, arn: string) => {
        const e = executionMap.get(arn); if (!e) throw Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } });
        return structuredClone(e);
    }), history: vi.fn(async (_region: string, arn: string) => {
        const h = histories.get(arn); if (!h) throw Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } });
        return structuredClone(h);
    }) };
    const deps: ReconcileReplacementDeps = { db: s.db, executions, describer: describer as unknown as ReconcileReplacementDeps['describer'], tunnels: tunnels as unknown as ReconcileReplacementDeps['tunnels'], now: () => at(RECOVERY_NOW, 60_000) };
    const request = { schemaVersion: 1 as const, operation: 'reconcile-replacement' as const, computerId: stopped.computerId,
        expectedJobId: REPLACE_JOB, sourceRetirementExecutionArn: releaseArn };
    return { ...s, release, releaseExecution, releaseArn, replace, replaceExecution, stopped, deployment, histories, executionMap, volume,
        tunnels, describer, executions, deps, request, deployments: { [deployment.region]: deployment } };
}
