import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { vi } from 'vitest';
import type { Ec2VolumeView } from './aws-clients';
import type { Ec2EnrollmentView } from './aws-enroll';
import { buildLifecycleWork, type LifecycleDeployment, type LifecycleWork } from './aws-intent';
import { fixtureDeployment, fixtureIntent } from './aws-intent.test-support';
import { applyLifecycleReceipt, lifecycleExecutionArn, type LifecycleExecutionReader, type ReceiptDeps } from './aws-receipts';
import { createFakePlacementDb, DEFAULT_OWNER, placementRow } from './fake-placement-db.test-support';
import { readPlacement } from './placement';

/** Incident 2026-10-25 shape: a gen-1/epoch-1 cold-launched (canonical tags) computer whose pool release terminated its
 * host at 14:36:08.445Z and then FAILED at the following observe; the retained data volume is free. */
export const NOW = new Date('2026-10-25T16:00:00Z');
export const START = new Date('2026-10-25T14:35:50.756Z');
export const TERMINATED = new Date('2026-10-25T14:36:08.445Z');
export const STOP = new Date('2026-10-25T14:36:08.699Z');
export const OPENED = new Date('2026-10-25T09:10:03Z');
export const D: LifecycleDeployment = { ...fixtureDeployment('ap-south-1'), namespace: 'mum',
    storage: { ...fixtureDeployment('ap-south-1').storage, rootDeviceName: '/dev/sda1' },
    stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-mum-lifecycle:19' };
type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
type Event = HistoryEvent & { id: number; previousEventId: number; timestamp: Date };

/** The failed release's history, structurally like the real 112-event one (one observe per phase, Fail state last). */
export function failedReleaseHistory(work: LifecycleWork, input = work.input): Event[] {
    const i = work.intent, id = i.providerInstanceId!, volume = i.dataVolumeId!;
    const events: Event[] = [];
    let at = START.getTime();
    const push = (type: string, details: Record<string, unknown>, timestamp?: Date) => {
        at = timestamp ? timestamp.getTime() : Math.min(at + 100, TERMINATED.getTime() - 1);
        const n = events.length + 1;
        events.push({ id: n, previousEventId: n - 1, type, timestamp: new Date(at), ...details } as Event);
        return n;
    };
    push('ExecutionStarted', { executionStartedEventDetails: { input, inputDetails: { truncated: false }, stateMachineVersionArn: work.stateMachineArn } }, START);
    push('PassStateEntered', { stateEnteredEventDetails: { name: 'Init' } }); push('PassStateExited', { stateExitedEventDetails: { name: 'Init' } });
    const observe = (name: string, failed = false, timestamp?: Date) => {
        push('TaskStateEntered', { stateEnteredEventDetails: { name } }, timestamp);
        push('LambdaFunctionScheduled', { lambdaFunctionScheduledEventDetails: { resource: 'arn:aws:lambda:ap-south-1:123456789012:function:observer:19', input: '{}' } }, timestamp);
        push('LambdaFunctionStarted', {}, timestamp);
        if (failed) { push('LambdaFunctionFailed', { lambdaFunctionFailedEventDetails: { error: 'LifecycleFailure', cause: '' } }, timestamp); return; }
        push('LambdaFunctionSucceeded', { lambdaFunctionSucceededEventDetails: { output: '{}', outputDetails: { truncated: false } } }, timestamp);
        push('TaskStateExited', { stateExitedEventDetails: { name } }, timestamp);
        push('ChoiceStateEntered', { stateEnteredEventDetails: { name: 'Decide' } }, timestamp); push('ChoiceStateExited', { stateExitedEventDetails: { name: 'Decide' } }, timestamp);
    };
    const task = (resource: string, parameters: unknown, output: unknown, doneAt?: Date) => {
        push('TaskStateEntered', { stateEnteredEventDetails: { name: resource } }, doneAt);
        push('TaskScheduled', { taskScheduledEventDetails: { resourceType: 'aws-sdk:ec2', resource, region: D.region, parameters: JSON.stringify(parameters), timeoutInSeconds: 30 } }, doneAt);
        push('TaskStarted', { taskStartedEventDetails: { resourceType: 'aws-sdk:ec2', resource } }, doneAt);
        push('TaskSucceeded', { taskSucceededEventDetails: { resourceType: 'aws-sdk:ec2', resource, output: JSON.stringify(output), outputDetails: { truncated: false } } }, doneAt);
        push('TaskStateExited', { stateExitedEventDetails: { name: resource } }, doneAt);
    };
    observe('Observe-initial');
    task('stopInstances', { Hibernate: false, Force: false, SkipOsShutdown: false, InstanceIds: [id] },
        { StoppingInstances: [{ CurrentState: { Code: 64, Name: 'stopping' }, InstanceId: id, PreviousState: { Code: 16, Name: 'running' } }] });
    observe('Observe-stopped');
    task('detachVolume', { VolumeId: volume, InstanceId: id, Force: false, Device: '/dev/sdf' },
        { Device: '/dev/sdf', InstanceId: id, State: 'detaching', VolumeId: volume });
    observe('Observe-detached');
    task('terminateInstances', { InstanceIds: [id] },
        { TerminatingInstances: [{ CurrentState: { Code: 48, Name: 'terminated' }, InstanceId: id, PreviousState: { Code: 80, Name: 'stopped' } }] }, TERMINATED);
    observe('Observe-terminated', true, new Date(TERMINATED.getTime() + 100));
    push('TaskStateExited', { stateExitedEventDetails: { name: 'Observe-terminated' } }, new Date(TERMINATED.getTime() + 150));
    push('FailStateEntered', { stateEnteredEventDetails: { name: 'Unconfirmed', input: '{}', inputDetails: { truncated: false } } }, new Date(TERMINATED.getTime() + 195));
    push('ExecutionFailed', { executionFailedEventDetails: { error: 'LifecycleUnconfirmed', cause: 'observe' } }, STOP);
    return events;
}

export function failedReleaseSetup(over: { generation?: number; leaseEpoch?: number } = {}) {
    const generation = over.generation ?? 1, leaseEpoch = over.leaseEpoch ?? 1;
    const original = buildLifecycleWork({ ...fixtureIntent('stop'), operation: 'release', deployment: D, targetGeneration: generation, leaseEpoch });
    const i = original.intent;
    const computers = [{ id: i.computerId, user_id: DEFAULT_OWNER, deleted_at: null as Date | null }];
    const fake = createFakePlacementDb({ computers,
        placements: [placementRow({ computer_id: i.computerId, state: 'UNCONFIRMED', generation, lease_epoch: leaseEpoch, region: D.region,
            zone_id: D.zoneId, instance_type: i.instanceType, instance_id: i.providerInstanceId, volume_id: i.dataVolumeId, fence_token: i.fenceToken,
            lifecycle_job_id: i.jobId, lifecycle_digest: original.digest, last_error: 'failed:LifecycleUnconfirmed', lease_until: new Date('2026-10-25T10:07:44Z') })],
        usage: [{ computer_id: i.computerId, user_id: DEFAULT_OWNER, instance_id: i.providerInstanceId, instance_type: i.instanceType,
            started_at: OPENED, stopped_at: null, observed_by: 'original', updated_at: OPENED }],
    }, { clock: () => NOW });
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': D.namespace, 'ezil:computer-id': i.computerId,
        'ezil:generation': String(generation), 'ezil:fence-token': i.fenceToken };
    const host: Ec2EnrollmentView = { instanceId: i.providerInstanceId!, state: 'terminated', instanceType: i.instanceType, stateTransitionAt: null,
        availabilityZone: 'ap-south-1a', availabilityZoneId: D.zoneId, publicIp: null, rootDeviceName: '/dev/sda1', volumes: [],
        tags: { ...tags, 'aws:ec2launchtemplate:id': D.launchTemplateId, 'aws:ec2launchtemplate:version': '13' } };
    const volume: Ec2VolumeView = { volumeId: i.dataVolumeId!, state: 'available', attachments: [], encrypted: true, kmsKeyId: D.dataKeyArn,
        zoneId: D.zoneId, sizeGiB: 50, volumeType: 'gp3', tags: { ...tags, 'ezil:allocation': 'a'.repeat(64), 'ezil:backup': 'daily' } };
    const failed: Execution = { status: 'FAILED', error: 'LifecycleUnconfirmed', cause: 'observe', input: original.input,
        executionArn: lifecycleExecutionArn(D, i.jobId), stateMachineVersionArn: original.stateMachineArn, redriveCount: 0, startDate: START, stopDate: STOP };
    const executions = new Map<string, Execution>([[failed.executionArn!, failed]]);
    const histories = new Map<string, HistoryEvent[]>([[failed.executionArn!, failedReleaseHistory(original)]]);
    const starts: LifecycleWork[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const meter = { ready: vi.fn(async () => {}), stopped: vi.fn<(value: { userId: string; computerId: string; endedAt: Date; reason: string }) => Promise<void>>(async () => {}), heartbeat: vi.fn(async () => {}) };
    const deps: ReceiptDeps & { executions: LifecycleExecutionReader } = { db: fake.db, now: () => NOW, clock: () => NOW, meter, sleep: async () => {},
        executions: {
            describe: vi.fn(async (_region: string, arn: string) => {
                const e = executions.get(arn);
                if (!e) throw Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } });
                return e;
            }),
            history: vi.fn(async (_region: string, arn: string) => {
                const h = histories.get(arn);
                if (!h) throw Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } });
                return structuredClone(h);
            }),
        },
        describer: { describeForEnrollment: vi.fn(async () => host), describeVolume: vi.fn(async () => volume) },
        starter: { start: vi.fn(async (_region: string, request: { input: string }) => {
            const work = buildLifecycleWork(JSON.parse(JSON.parse(request.input).document));
            starts.push(work);
            const executionArn = lifecycleExecutionArn(work.intent.deployment, work.intent.jobId);
            executions.set(executionArn, { status: 'RUNNING', input: work.input, executionArn, stateMachineVersionArn: work.stateMachineArn, redriveCount: 0, startDate: NOW });
        }) as never },
    };
    const current = async () => (await readPlacement(fake.db, i.computerId)).record!;
    const tick = async () => applyLifecycleReceipt(deps, await current(), D);
    /** The replay release succeeds with a retired receipt (no EC2 mutation: its host is gone and the disk is free). */
    const finish = (status = 'SUCCEEDED', stopDate = NOW) => {
        const work = starts.at(-1)!;
        const execution = executions.get(lifecycleExecutionArn(work.intent.deployment, work.intent.jobId))!;
        Object.assign(execution, { status, stopDate, output: JSON.stringify({ schemaVersion: 1, jobId: work.intent.jobId, digest: work.digest,
            computerId: i.computerId, generation, leaseEpoch, fenceToken: i.fenceToken, instanceId: i.providerInstanceId, volumeId: i.dataVolumeId, state: 'retired' }) });
        return execution;
    };
    const context = async () => JSON.parse((await current()).lastError!.slice('pool_release_recovery:'.length));
    return { ...fake, computers, deps, current, tick, finish, starts, executions, histories, original, failed, host, volume, meter, log, context };
}
