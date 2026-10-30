import { vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { HistoryEvent } from '@aws-sdk/client-sfn';
import { buildLifecycleWork } from './aws-intent';
import { fixtureDeployment, fixtureIntent } from './aws-intent.test-support';
import { createFakePlacementDb, DEFAULT_OWNER, placementRow, type Row } from './fake-placement-db.test-support';
import { applyLifecycleReceipt, lifecycleExecutionArn, type LifecycleExecutionReader } from './aws-receipts';
import { readPlacement, type PlacementDb, type PlacementExecutor } from './placement';
import { createSfnExecutionReader } from './aws-clients';
import { buildAdoptRecoveryWork, type AdoptRecoveryDeps, type AdoptRecoveryWork } from './aws-pool-recovery';

export const RECOVERY_NOW = new Date('2026-10-24T18:00:00Z');
export const RECOVERY_OTHER = '11111111-1111-4111-8111-111111111112';
export function adoptRecoverySetup() {
    const source = { ...fixtureDeployment('ap-south-1'), namespace: 'mum', amiId: 'ami-0b4af31ed53e16f98',
        stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-mum-lifecycle:1' };
    const currentDeployment = { ...source, amiId: 'ami-99999999999999999', stateMachineVersionArn: source.stateMachineVersionArn.replace(/:1$/, ':2') };
    const original = buildLifecycleWork({ ...fixtureIntent('stop'), operation: 'adopt', deployment: source, targetGeneration: 5, leaseEpoch: 6,
        poolHostId: RECOVERY_OTHER, providerInstanceId: 'i-0b2c3d4e5f6071829', dataVolumeId: 'vol-0b2c3d4e5f6071829' });
    const i = original.intent;
    const computers = [{ id: i.computerId, user_id: DEFAULT_OWNER, deleted_at: null as Date | null }];
    const fake = createFakePlacementDb({ computers, placements: [placementRow({ computer_id: i.computerId, state: 'UNCONFIRMED',
        generation: 5, lease_epoch: 6, region: source.region, zone_id: source.zoneId, instance_type: i.instanceType,
        instance_id: i.providerInstanceId, volume_id: i.dataVolumeId, fence_token: i.fenceToken,
        lifecycle_job_id: i.jobId, lifecycle_digest: original.digest, last_error: 'failed:LifecycleUnconfirmed',
        enroll_nonce_hash: null, enroll_consumed_hash: null, enroll_expires_at: null })] }, { clock: () => RECOVERY_NOW });
    const pool: Row = { id: i.poolHostId, state: 'leased', instance_id: i.providerInstanceId, leased_computer_id: i.computerId,
        generation: 1, leased_generation: 1, lease_token: RECOVERY_OTHER, region: source.region, zone_id: source.zoneId,
        instance_type: i.instanceType, claim_generation: null, claim_lease_epoch: null, claim_fence: null,
        claim_volume_serial: null, session_ready_at: null };
    const dialect = new PgDialect(), queries: { sql: string; params: unknown[]; transaction: boolean }[] = [];
    let onLock: (() => void) | undefined;
    const execute = (tx: PlacementExecutor, transaction: boolean): PlacementExecutor['execute'] => async query => {
        const q = dialect.sqlToQuery(query); queries.push({ ...q, transaction });
        if (q.sql.startsWith('SELECT computer_id') && q.sql.includes('FOR UPDATE')) {
            if (!transaction) throw new Error('lock outside transaction');
            onLock?.(); onLock = undefined; return { rows: [] };
        }
        if (q.sql.includes('placement:adopt-unopened')) {
            return { rows: fake.usage.filter(u => (u.computer_id === q.params[0] && u.stopped_at == null) || u.instance_id === q.params[1]).slice(0, 1) };
        }
        if (q.sql.includes('public.ezil_compute_pool_hosts')) {
            if (q.sql.startsWith('SELECT')) return { rows: pool.id === q.params[0] ? [{ ...pool }] : [] };
            if (!transaction) throw new Error('pool write outside transaction');
            if (pool.id !== q.params[0] || pool.lease_token !== q.params[1] || pool.state !== 'leased') return { rows: [] };
            pool.state = 'retired'; return { rows: [{ id: pool.id }] };
        }
        return tx.execute(query);
    };
    const db: PlacementDb = { execute: execute(fake.db, false), transaction: fn => fake.db.transaction(async tx => {
        const before = { ...pool };
        try { return await fn({ execute: execute(tx, true) }); } catch (e) { Object.assign(pool, before); throw e; }
    }) };
    const tags: Record<string, string> = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': source.namespace,
        'ezil:computer-id': i.computerId, 'ezil:generation': '5', 'ezil:fence-token': i.fenceToken };
    const host = { instanceId: i.providerInstanceId!, imageId: source.amiId, state: 'running', instanceType: i.instanceType,
        availabilityZone: 'ap-south-1a', availabilityZoneId: source.zoneId, publicIp: null, rootDeviceName: '/dev/sda1',
        tags: { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': source.namespace, 'ezil:namespace': source.namespace,
            'ezil:pool': '1', 'ezil:pool-host': i.poolHostId!, 'aws:ec2launchtemplate:id': source.launchTemplateId,
            'aws:ec2launchtemplate:version': '1' } as Record<string, string>,
        volumes: [{ volumeId: 'vol-22222222222222222', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} },
            { volumeId: i.dataVolumeId!, deviceName: '/dev/sdf', deleteOnTermination: false, tags }] };
    const volume = { volumeId: i.dataVolumeId!, state: 'in-use', encrypted: true, kmsKeyId: source.dataKeyArn,
        zoneId: source.zoneId, tags, attachments: [{ instanceId: i.providerInstanceId!, state: 'attached' }] };
    type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
    const originalExecution: Execution = { status: 'FAILED', error: 'LifecycleUnconfirmed', input: original.input,
        executionArn: lifecycleExecutionArn(source, i.jobId), stateMachineVersionArn: original.stateMachineArn, redriveCount: 0,
        startDate: new Date('2026-10-24T17:19:50Z'), stopDate: new Date('2026-10-24T17:19:55Z') };
    const event = (type: HistoryEvent['type'], details: Partial<HistoryEvent> = {}) => ({ type, ...details });
    const entered = (name: string) => event('TaskStateEntered', { stateEnteredEventDetails: { name } });
    const lambda = (type: HistoryEvent['type']) => event(type);
    // Provider event layout: attach entered 23, scheduled 24, started 25,
    // succeeded 26; Observe-attached 28, LambdaFunctionFailed 31, terminal 34.
    const history: HistoryEvent[] = [
        event('ExecutionStarted', { executionStartedEventDetails: { input: original.input } }),
        entered('Observe-initial'), lambda('LambdaFunctionScheduled'), lambda('LambdaFunctionStarted'), lambda('LambdaFunctionSucceeded'), event('TaskStateExited'),
        event('ChoiceStateEntered'), event('ChoiceStateExited'), entered('createTags'), event('TaskScheduled'), event('TaskStarted'), event('TaskSucceeded'), event('TaskStateExited'),
        entered('Observe-tagged'), lambda('LambdaFunctionScheduled'), lambda('LambdaFunctionStarted'), lambda('LambdaFunctionSucceeded'), event('TaskStateExited'),
        event('ChoiceStateEntered'), event('ChoiceStateExited'), event('PassStateEntered'), event('PassStateExited'),
        entered('attachVolume'),
        event('TaskScheduled', { taskScheduledEventDetails: { region: source.region, resourceType: 'aws-sdk:ec2', resource: 'attachVolume',
            parameters: JSON.stringify({ InstanceId: i.providerInstanceId, VolumeId: i.dataVolumeId, Device: '/dev/sdf' }) } }),
        event('TaskStarted', { taskStartedEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'attachVolume' } }),
        event('TaskSucceeded', { taskSucceededEventDetails: { resourceType: 'aws-sdk:ec2', resource: 'attachVolume' } }),
        event('TaskStateExited'), entered('Observe-attached'), lambda('LambdaFunctionScheduled'), lambda('LambdaFunctionStarted'),
        event('LambdaFunctionFailed', { lambdaFunctionFailedEventDetails: { error: 'LifecycleFailure', cause: '{"errorType":"LifecycleFailure"}' } }),
        event('PassStateEntered'), event('FailStateEntered'), event('ExecutionFailed', { executionFailedEventDetails: { error: 'LifecycleUnconfirmed' } }),
    ].map((e, n) => ({ ...e, id: n + 1, previousEventId: n, timestamp: new Date('2026-10-24T17:19:54.700Z') })) as HistoryEvent[];
    const historyCalls: unknown[] = [];
    const historyReader = createSfnExecutionReader(() => ({ account: source.accountId, client: { send: async command => {
        historyCalls.push(command);
        const { nextToken } = (command as { input: { nextToken?: string } }).input;
        return nextToken === undefined ? { events: history.slice(0, 24), nextToken: 'page-two' } : { events: history.slice(24) };
    } } }));
    const executions = new Map<string, Execution>([[originalExecution.executionArn!, originalExecution]]), starts: AdoptRecoveryWork[] = [];
    const meter = { ready: vi.fn(), stopped: vi.fn(), heartbeat: vi.fn() };
    const deps: AdoptRecoveryDeps = { db, now: () => RECOVERY_NOW, sleep: async () => {}, meter,
        executions: { history: historyReader.history, describe: vi.fn(async (_region, arn) => {
            const e = executions.get(arn); if (!e) throw Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } }); return e;
        }) },
        describer: { describeForEnrollment: vi.fn(async () => host), describeVolume: vi.fn(async () => volume) },
        starter: { start: vi.fn(async (_region, request) => {
            const w = buildAdoptRecoveryWork(JSON.parse(JSON.parse(request.input).document)); starts.push(w);
            const executionArn = lifecycleExecutionArn(w.intent.deployment, w.intent.jobId);
            executions.set(executionArn, { status: 'RUNNING', input: w.input, executionArn, stateMachineVersionArn: w.stateMachineArn,
                redriveCount: 0, startDate: RECOVERY_NOW });
        }) },
    };
    const current = async () => (await readPlacement(db, i.computerId)).record!;
    const tick = async () => applyLifecycleReceipt(deps, await current(), currentDeployment);
    const finish = (status = 'SUCCEEDED') => {
        const w = starts.at(-1)!;
        const e = executions.get(lifecycleExecutionArn(w.intent.deployment, w.intent.jobId))!;
        Object.assign(e, { status, stopDate: RECOVERY_NOW, output: JSON.stringify({ schemaVersion: 1, jobId: w.intent.jobId,
            digest: w.digest, computerId: i.computerId, generation: 5, leaseEpoch: 6, fenceToken: i.fenceToken,
            instanceId: i.providerInstanceId, volumeId: i.dataVolumeId, state: 'retired' }) });
        if (status === 'SUCCEEDED') { host.state = 'terminated'; volume.state = 'available'; volume.attachments = []; }
        return e;
    };
    return { ...fake, db, deps, current, tick, finish, host, volume, pool, original, originalExecution, history, starts, executions,
        currentDeployment, queries, meter, computers, historyCalls, race: (fn: () => void) => { onLock = fn; } };
}
