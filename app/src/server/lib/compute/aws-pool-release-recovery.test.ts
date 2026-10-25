import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import { PgDialect } from 'drizzle-orm/pg-core';
import { buildLifecycleWork, type LifecycleWork } from './aws-intent';
import { fixtureDeployment, fixtureIntent } from './aws-intent.test-support';
import { createFakePlacementDb, DEFAULT_OWNER, placementRow } from './fake-placement-db.test-support';
import { applyLifecycleReceipt, lifecycleExecutionArn, reconcileAwsFleet, type LifecycleExecutionReader, type ReceiptDeps } from './aws-receipts';
import { readPlacement, type PlacementDb } from './placement';
import type { Ec2EnrollmentView } from './aws-enroll';
import type { Ec2VolumeView } from './aws-clients';

afterEach(() => vi.restoreAllMocks());

const NOW = new Date('2026-10-24T12:00:00Z');
const START = new Date('2026-10-24T04:48:02Z');
// Fixture only: staging's exact execution stopDate was not supplied.
const STOP = new Date('2026-10-24T04:56:00Z');
const D = { ...fixtureDeployment('ap-south-1'), namespace: 'mum',
    stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-mum-lifecycle:1' };
type Execution = Awaited<ReturnType<LifecycleExecutionReader['describe']>>;
function setup(operation: 'release' | 'stop' = 'release') {
    const original = buildLifecycleWork({ ...fixtureIntent('stop'), operation, deployment: D, targetGeneration: 3 });
    const i = original.intent;
    const computers = [{ id: i.computerId, user_id: DEFAULT_OWNER, deleted_at: null as Date | null }];
    const fake = createFakePlacementDb({ computers,
        placements: [placementRow({ computer_id: i.computerId, state: 'UNCONFIRMED', generation: i.targetGeneration,
            lease_epoch: i.leaseEpoch, region: D.region, zone_id: D.zoneId, instance_type: i.instanceType,
            instance_id: i.providerInstanceId, volume_id: i.dataVolumeId, fence_token: i.fenceToken,
            lifecycle_job_id: i.jobId, lifecycle_digest: original.digest, last_error: 'failed:LifecycleUnconfirmed' })],
        usage: [{ computer_id: i.computerId, user_id: DEFAULT_OWNER, instance_id: i.providerInstanceId,
            instance_type: i.instanceType, started_at: START, stopped_at: null, observed_by: 'original', updated_at: START }],
    }, { clock: () => NOW });
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': D.namespace,
        'ezil:computer-id': i.computerId, 'ezil:generation': '3', 'ezil:fence-token': i.fenceToken };
    const host = { stateTransitionAt: undefined as Date | null | undefined, instanceId: i.providerInstanceId!, state: 'stopped', instanceType: i.instanceType,
        availabilityZone: 'ap-south-1a', availabilityZoneId: D.zoneId, publicIp: null, tags: { ...tags }, rootDeviceName: '/dev/sda1',
        volumes: [{ volumeId: 'vol-22222222222222222', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} },
            { volumeId: i.dataVolumeId!, deviceName: '/dev/sdf', deleteOnTermination: false, tags: { ...tags } }] } satisfies Ec2EnrollmentView;
    const volume = { volumeId: i.dataVolumeId!, state: 'in-use', encrypted: true as boolean, kmsKeyId: D.dataKeyArn,
        zoneId: D.zoneId, tags: { ...tags }, attachments: [{ instanceId: i.providerInstanceId!, state: 'attached' }] } satisfies Ec2VolumeView;
    const originalExecution: Execution = { status: 'FAILED', error: 'LifecycleUnconfirmed', cause: 'AccessDenied:DetachVolume',
        input: original.input, executionArn: lifecycleExecutionArn(D, i.jobId), stateMachineVersionArn: original.stateMachineArn,
        redriveCount: 0, startDate: START, stopDate: STOP };
    const executions = new Map<string, Execution>([[originalExecution.executionArn!, originalExecution]]);
    const starts: LifecycleWork[] = [];
    const log = vi.spyOn(console, 'info').mockImplementation(() => {});
    const meter = { ready: vi.fn(async () => {}), stopped: vi.fn(async (_value: { userId: string; computerId: string; endedAt: Date; reason: string }) => {}), heartbeat: vi.fn(async () => {}) };
    const deps: ReceiptDeps = { db: fake.db, now: () => NOW, clock: () => NOW, meter, sleep: async () => {},
        executions: { describe: vi.fn(async (_region, arn) => {
            const e = executions.get(arn);
            if (!e) throw Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } });
            return e;
        }) },
        describer: { describeForEnrollment: vi.fn(async () => host), describeVolume: vi.fn(async () => volume) },
        starter: { start: vi.fn(async (_region, request) => {
            const work = buildLifecycleWork(JSON.parse(JSON.parse(request.input).document));
            starts.push(work);
            const executionArn = lifecycleExecutionArn(work.intent.deployment, work.intent.jobId);
            executions.set(executionArn, { status: 'RUNNING', input: work.input, executionArn,
                stateMachineVersionArn: work.stateMachineArn, redriveCount: 0, startDate: NOW });
        }) },
    };
    const current = async () => (await readPlacement(fake.db, i.computerId)).record!;
    const tick = async () => applyLifecycleReceipt(deps, await current(), D);
    const finish = (status = 'SUCCEEDED') => {
        const work = starts.at(-1)!;
        const execution = executions.get(lifecycleExecutionArn(work.intent.deployment, work.intent.jobId))!;
        Object.assign(execution, { status, stopDate: NOW, output: JSON.stringify({ schemaVersion: 1, jobId: work.intent.jobId,
            digest: work.digest, computerId: i.computerId, generation: i.targetGeneration, leaseEpoch: i.leaseEpoch,
            fenceToken: i.fenceToken, instanceId: i.providerInstanceId, volumeId: i.dataVolumeId, state: 'retired' }) });
        if (status === 'SUCCEEDED') { volume.state = 'available'; volume.attachments = []; }
        return execution;
    };
    return { ...fake, computers, deps, current, tick, finish, starts, executions, original, originalExecution, host, volume, meter, log };
}
type Fixture = ReturnType<typeof setup>;
const recoveryContext = async (s: Fixture) => JSON.parse((await s.current()).lastError!.slice('pool_release_recovery:'.length));

describe('proven recovery billing time', () => {
    it.each([START, STOP, NOW])('persists bounded physical-stop proof %s at the reservation CAS', async stoppedAt => {
        const s = setup(); s.host.stateTransitionAt = stoppedAt;
        const start = s.deps.starter!.start;
        s.deps.starter!.start = async (...args) => {
            expect(await recoveryContext(s)).toMatchObject({ basis: 'ec2_state_transition', stoppedAt: stoppedAt.toISOString(),
                sourceStartedAt: START.toISOString() });
            await start(...args);
        };
        await s.tick(); s.finish();
        // Completion/replay must use the proof saved before StartExecution.
        s.host.stateTransitionAt = null;
        const stale = await s.current();
        await Promise.all([s.tick(), applyLifecycleReceipt(s.deps, stale, D)]);
        await applyLifecycleReceipt(s.deps, stale, D);
        expect(s.usage[0].stopped_at).toEqual(stoppedAt);
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endedAt: stoppedAt }));
        expect(s.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'pool-recovery-usage-close',
            computer: s.original.intent.computerId.slice(0, 8), basis: 'ec2_state_transition', stoppedAt: stoppedAt.toISOString() }));
        expect(s.deps.describer!.describeForEnrollment).toHaveBeenCalledOnce();
    });

    it.each([
        ['absent', undefined], ['null', null], ['unparseable', new Date(NaN)],
        ['before original start', new Date(START.getTime() - 1)], ['after observation', new Date(NOW.getTime() + 1)],
    ] as const)('uses recovery success for %s physical-stop proof', async (_name, stoppedAt) => {
        const s = setup(); s.host.stateTransitionAt = stoppedAt;
        await s.tick();
        expect(await recoveryContext(s)).toMatchObject({ basis: 'recovery_success', stoppedAt: null });
        const e = s.finish(); e.startDate = new Date(NOW.getTime() - 60000);
        e.stopDate = new Date(NOW.getTime() - 30000);
        await s.tick(); await s.tick();
        expect(s.usage[0].stopped_at).toEqual(e.stopDate);
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endedAt: e.stopDate }));
        expect(s.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'pool-recovery-usage-close',
            computer: s.original.intent.computerId.slice(0, 8), basis: 'recovery_success', stoppedAt: e.stopDate.toISOString() }));
    });

    it('refuses a running host even with an in-bounds transition timestamp', async () => {
        const s = setup(); s.host.state = 'running'; s.host.stateTransitionAt = STOP;
        await s.tick(); expect(s.starts).toHaveLength(0);
        expect(s.usage[0].stopped_at).toBeNull(); expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    const invalidSuccess: [string, (e: Execution) => void][] = [
        ['missing start', e => { delete e.startDate; }],
        ['invalid start', e => { e.startDate = new Date(NaN); }],
        ['missing stop', e => { delete e.stopDate; }],
        ['invalid stop', e => { e.stopDate = new Date(NaN); }],
        ['stop before recovery start', e => { e.stopDate = new Date(NOW.getTime() - 1); }],
        ['stop after now', e => { e.stopDate = new Date(NOW.getTime() + 1); }],
    ];
    it.each(invalidSuccess)('waits for valid recovery success time: %s', async (_name, mutate) => {
        const s = setup(); await s.tick(); const e = s.finish(); mutate(e);
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'RECOVERING', lastError: expect.stringContaining('recovery_success_time_missing_or_invalid') });
        expect(s.usage[0].stopped_at).toBeNull(); expect(s.meter.stopped).not.toHaveBeenCalled();
        expect(s.log).not.toHaveBeenCalled();
        Object.assign(e, { startDate: NOW, stopDate: NOW }); await s.tick();
        expect(s.usage[0].stopped_at).toEqual(NOW);
    });

    it.each(['FAILED', 'TIMED_OUT', 'ABORTED'])('keeps persisted physical proof across a %s retry', async status => {
        const s = setup(); s.host.stateTransitionAt = STOP;
        await s.tick(); s.finish(status); await s.tick(); s.host.stateTransitionAt = undefined;
        const next = { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(/:1$/, ':2') };
        await applyLifecycleReceipt(s.deps, await s.current(), next);
        expect(await recoveryContext(s)).toMatchObject({ basis: 'ec2_state_transition', stoppedAt: STOP.toISOString() });
        s.finish(); await applyLifecycleReceipt(s.deps, await s.current(), next);
        expect(s.usage[0].stopped_at).toEqual(STOP);
    });

    it('bounds newly observed retry proof by the original execution start', async () => {
        const s = setup(); await s.tick(); s.finish('TIMED_OUT'); await s.tick();
        s.host.stateTransitionAt = STOP; // Before the recovery start, after the original start.
        const next = { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(/:1$/, ':2') };
        await applyLifecycleReceipt(s.deps, await s.current(), next);
        expect(await recoveryContext(s)).toMatchObject({ basis: 'ec2_state_transition', stoppedAt: STOP.toISOString() });
        s.finish(); await applyLifecycleReceipt(s.deps, await s.current(), next);
        expect(s.usage[0].stopped_at).toEqual(STOP);
    });

    it.each(['TIMED_OUT', 'ABORTED'])('rechecks resource ownership before retrying %s under a new version', async status => {
        const s = setup(); await s.tick(); s.finish(status); await s.tick();
        s.host.tags['ezil:fence-token'] = 'wrong';
        await applyLifecycleReceipt(s.deps, await s.current(), { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(/:1$/, ':2') });
        expect(s.starts).toHaveLength(1); expect(s.usage[0].stopped_at).toBeNull();
        expect((await s.current()).lastError).toContain('instance_identity');
    });

    it('ignores a legacy replay timestamp without a physical-proof basis', async () => {
        const s = setup(); await s.tick(); const saved = await recoveryContext(s);
        delete saved.basis; delete saved.sourceStartedAt; saved.stoppedAt = STOP.toISOString();
        s.placements[0].last_error = 'pool_release_recovery:' + JSON.stringify(saved);
        s.finish(); await s.tick();
        expect(s.usage[0].stopped_at).toEqual(NOW);
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endedAt: NOW }));
    });

    it.each([null, 'not-a-date'])('rejects corrupt persisted physical proof: %s', async stoppedAt => {
        const s = setup(); s.host.stateTransitionAt = STOP; await s.tick();
        const saved = await recoveryContext(s); saved.stoppedAt = stoppedAt;
        s.placements[0].last_error = 'pool_release_recovery:' + JSON.stringify(saved);
        s.finish(); await s.tick();
        expect((await s.current()).lastError).toContain('replay_identity');
        expect(s.usage[0].stopped_at).toBeNull(); expect(s.meter.stopped).not.toHaveBeenCalled();
    });
});

describe('normal release billing time bounds', () => {
    it.each([
        ['valid', START, STOP, STOP], ['at start', START, START, START], ['at now', START, NOW, NOW],
        ['missing start', undefined, STOP, NOW], ['invalid start', new Date(NaN), STOP, NOW],
        ['missing stop', START, undefined, NOW], ['invalid stop', START, new Date(NaN), NOW],
        ['before start', START, new Date(START.getTime() - 1), NOW],
        ['after now', START, new Date(NOW.getTime() + 1), NOW],
    ] as const)('%s uses a bounded stopDate or the existing DB clock', async (name, startDate, stopDate, expected) => {
        const s = setup(); s.placements[0].state = 'STOPPING';
        const i = s.original.intent;
        Object.assign(s.originalExecution, { status: 'SUCCEEDED', startDate, stopDate,
            output: JSON.stringify({ schemaVersion: 1, jobId: i.jobId, digest: s.original.digest,
                computerId: i.computerId, generation: i.targetGeneration, leaseEpoch: i.leaseEpoch,
                fenceToken: i.fenceToken, instanceId: i.providerInstanceId, volumeId: i.dataVolumeId, state: 'retired' }) });
        await s.tick();
        expect((await s.current()).state).toBe('STOPPED');
        expect(s.usage[0].stopped_at).toEqual(expected);
        const close = s.statements.find(q => q.sql.includes('placement:usage-close */'))!;
        expect(close.sql).toContain(['valid', 'at start', 'at now'].includes(name) ? 'SET stopped_at = $1::timestamptz' : 'SET stopped_at = now()');
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ endedAt: expected }));
    });
});

describe('live UNCONFIRMED pool release recovery', () => {
    it.each(['release', 'stop'] as const)('recovers a failed %s, closes at recovery success without physical-stop proof, and replays once', async operation => {
        const s = setup(operation);
        await s.tick();
        expect(await s.current()).toMatchObject({ state: 'RECOVERING', generation: 3 });
        expect(s.starts).toHaveLength(1);
        expect(s.starts[0].intent).toMatchObject({ operation: 'release', targetGeneration: 3, userData: null });
        expect(s.starts[0].intent.jobId).not.toBe(s.original.intent.jobId);
        expect(s.starts[0].input).not.toMatch(/force/i);
        expect(s.usage[0].stopped_at).toBeNull();
        s.finish();
        const stale = await s.current();
        await Promise.all([s.tick(), applyLifecycleReceipt(s.deps, stale, D)]);
        await applyLifecycleReceipt(s.deps, stale, D);
        expect(await s.current()).toMatchObject({ state: 'STOPPED', lastError: 'pool_released', lifecycleJobId: null });
        expect(s.usage[0].stopped_at).toEqual(NOW);
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith({ userId: DEFAULT_OWNER, computerId: s.original.intent.computerId,
            endedAt: NOW, reason: 'provider_stop' });
        expect(s.statements.filter(q => q.sql.includes('placement:usage-close */'))).toHaveLength(1);
        const close = s.statements.find(q => q.sql.includes('placement:usage-close */'))!;
        expect(close.sql).toContain('SET stopped_at = $1::timestamptz');
        expect(close.sql).toContain('AND stopped_at IS NULL');
        expect(close.params[0]).toBe(NOW.toISOString());
    });

    const negatives: [string, (s: Fixture) => void, string][] = [
        ['running execution', s => { s.originalExecution.status = 'RUNNING'; }, 'execution_not_failed'],
        ['successful execution', s => { s.originalExecution.status = 'SUCCEEDED'; }, 'execution_not_failed'],
        ['timed out', s => { s.originalExecution.status = 'TIMED_OUT'; }, 'execution_not_failed'],
        ['aborted', s => { s.originalExecution.status = 'ABORTED'; }, 'execution_not_failed'],
        ['redrive', s => { s.originalExecution.redriveCount = 1; }, 'execution_authority'],
        ['unknown redrive', s => { delete s.originalExecution.redriveCount; }, 'execution_authority'],
        ['alias', s => { s.originalExecution.stateMachineAliasArn = 'alias'; }, 'execution_authority'],
        ['execution ARN', s => { s.originalExecution.executionArn += 'other'; }, 'execution_authority'],
        ['version ARN', s => { s.originalExecution.stateMachineVersionArn += '9'; }, 'execution_authority'],
        ['input absent', s => { delete s.originalExecution.input; }, 'execution_identity'],
        ['digest', s => { s.placements[0].lifecycle_digest = 'a'.repeat(64); }, 'execution_identity'],
        ['job', s => { s.originalExecution.input = buildLifecycleWork({ ...s.original.intent, jobId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).input; }, 'execution_identity'],
        ['computer binding', s => { s.originalExecution.input = buildLifecycleWork({ ...s.original.intent, computerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }).input; }, 'execution_identity'],
        ['instance type', s => { s.placements[0].instance_type = 'c6i.xlarge'; }, 'execution_identity'],
        ['placement zone', s => { s.placements[0].zone_id = 'aps1-az2'; }, 'execution_identity'],
        ['start timestamp absent', s => { delete s.originalExecution.startDate; }, 'stop_time_missing_or_invalid'],
        ['generation', s => { s.placements[0].generation = 4; }, 'execution_identity'],
        ['epoch', s => { s.placements[0].lease_epoch = 4; }, 'execution_identity'],
        ['fence', s => { s.placements[0].fence_token = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'; }, 'execution_identity'],
        ['instance', s => { s.placements[0].instance_id = 'i-33333333333333333'; }, 'execution_identity'],
        ['volume', s => { s.placements[0].volume_id = 'vol-33333333333333333'; }, 'execution_identity'],
        ['stop timestamp absent', s => { delete s.originalExecution.stopDate; }, 'stop_time_missing_or_invalid'],
        ['stop timestamp invalid', s => { s.originalExecution.stopDate = new Date(NaN); }, 'stop_time_missing_or_invalid'],
        ['stop timestamp future', s => { s.originalExecution.stopDate = new Date(NOW.getTime() + 1000); }, 'stop_time_missing_or_invalid'],
        ['stop timestamp before start', s => { s.originalExecution.stopDate = new Date(START.getTime() - 1000); }, 'stop_time_missing_or_invalid'],
        ['running host', s => { s.host.state = 'running'; }, 'instance_identity'],
        ['missing host', s => { s.deps.describer!.describeForEnrollment = async () => null; }, 'instance_identity'],
        ['host generation', s => { s.host.tags['ezil:generation'] = '2'; }, 'instance_identity'],
        ['host fence', s => { s.host.tags['ezil:fence-token'] = 'wrong'; }, 'instance_identity'],
        ['conflicting host alias', s => { Object.assign(s.host.tags, { 'ezil:fence': 'wrong' }); }, 'instance_identity'],
        ['host computer', s => { s.host.tags['ezil:computer-id'] = 'wrong'; }, 'instance_identity'],
        ['host zone', s => { s.host.availabilityZoneId = 'aps1-az2'; }, 'instance_identity'],
        ['pool host', s => { Object.assign(s.host.tags, { 'ezil:pool': '1' }); }, 'instance_identity'],
        ['extra disk', s => { s.host.volumes.push({ ...s.host.volumes[1], volumeId: 'vol-33333333333333333', deviceName: '/dev/sdg' }); }, 'instance_disks'],
        ['missing root', s => { s.host.volumes.shift(); }, 'instance_disks'],
        ['wrong root', s => { s.host.rootDeviceName = '/dev/xvda'; }, 'instance_disks'],
        ['destructive data attachment', s => { s.host.volumes[1].deleteOnTermination = true; }, 'instance_disks'],
        ['other data disk', s => { s.host.volumes[1].volumeId = 'vol-33333333333333333'; }, 'instance_disks'],
        ['volume generation', s => { s.volume.tags!['ezil:generation'] = '2'; }, 'volume_identity'],
        ['volume fence', s => { s.volume.tags!['ezil:fence-token'] = 'wrong'; }, 'volume_identity'],
        ['unencrypted volume', s => { s.volume.encrypted = false; }, 'volume_identity'],
        ['wrong key', s => { s.volume.kmsKeyId = 'wrong'; }, 'volume_identity'],
        ['volume absent', s => { s.deps.describer!.describeVolume = async () => null; }, 'volume_identity'],
        ['available volume', s => { s.volume.state = 'available'; s.volume.attachments = []; }, 'volume_attachment'],
        ['wrong attachment', s => { s.volume.attachments![0].instanceId = 'i-33333333333333333'; }, 'volume_attachment'],
        ['detaching volume', s => { s.volume.attachments![0].state = 'detaching'; }, 'volume_attachment'],
        ['multi attach', s => { s.volume.attachments!.push({ ...s.volume.attachments![0] }); }, 'volume_attachment'],
        ['describe unavailable', s => { s.deps.describer!.describeVolume = async () => { throw new Error('lost'); }; }, 'describe_unavailable'],
        ['starter absent', s => { delete s.deps.starter; }, 'starter_missing'],
    ];
    it.each(negatives)('refuses %s with a precise diagnostic and no usage write', async (_name, mutate, code) => {
        const s = setup(); mutate(s); await s.tick();
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: expect.stringContaining(code) });
        expect(s.starts).toHaveLength(0);
        expect(s.usage[0].stopped_at).toBeNull();
    });

    it.each(['STOPPED', 'RUNNING', 'PROVISIONING', 'RECOVERING'] as const)('does not trigger from unrelated %s', async state => {
        const s = setup(); s.placements[0].state = state;
        const { reconcilePoolReleaseRecovery } = await import('./aws-pool-release-recovery');
        expect(await reconcilePoolReleaseRecovery(s.deps, await s.current(), D)).toBe(false);
        expect(s.starts).toHaveLength(0);
    });
    it.each(['deleted', 'missing', 'other owner', 'provider', 'pool off', 'operation'] as const)('does not trigger for %s', async condition => {
        const s = setup(); let p = await s.current();
        if (condition === 'deleted') s.computers[0].deleted_at = NOW;
        if (condition === 'missing') s.computers.splice(0);
        if (condition === 'other owner') s.computers[0].user_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        if (condition === 'provider') p = { ...p, provider: 'cloudflare' };
        if (condition === 'operation') {
            const work = buildLifecycleWork({ ...s.original.intent, operation: 'retire' });
            s.originalExecution.input = work.input; p.lifecycleDigest = work.digest;
        }
        const { reconcilePoolReleaseRecovery } = await import('./aws-pool-release-recovery');
        expect(await reconcilePoolReleaseRecovery(s.deps, p, condition === 'pool off' ? { ...D, namespace: 'off' } : D)).toBe(false);
        expect(s.starts).toHaveLength(0);
    });

    it('concurrent opens CAS one new job', async () => {
        const s = setup(); await Promise.all([s.tick(), s.tick(), s.tick()]);
        expect(s.starts).toHaveLength(1);
        expect(await s.current()).toMatchObject({ state: 'RECOVERING', lifecycleJobId: s.starts[0].intent.jobId });
    });
    it('restarts the exact persisted job after a crash before StartExecution, across a deployment version change', async () => {
        const s = setup(); const db = s.deps.db;
        s.deps.db = { ...db, transaction: async fn => {
            await db.transaction(fn);
            throw new Error('process disappeared after commit');
        } };
        await expect(s.tick()).rejects.toThrow('process disappeared after commit');
        const p = await s.current(); expect(p.state).toBe('RECOVERING');
        expect(s.starts).toHaveLength(0);
        s.deps.db = db;
        await applyLifecycleReceipt(s.deps, p, { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(/:1$/, ':2') });
        expect(s.starts).toHaveLength(1);
        expect(s.starts[0]).toMatchObject({ digest: p.lifecycleDigest, intent: { jobId: p.lifecycleJobId } });
    });
    it('a lost start response reuses one execution; a lost receipt read stays pending', async () => {
        const s = setup(); const start = s.deps.starter!.start;
        s.deps.starter!.start = async (...args) => { await start(...args); throw new Error('response lost'); };
        await s.tick();
        expect(new Set(s.starts.map(w => w.intent.jobId)).size).toBe(1);
        s.finish();
        const read = s.deps.executions!.describe;
        s.deps.executions!.describe = async () => { throw new Error('read lost'); };
        await s.tick(); expect((await s.current()).state).toBe('RECOVERING');
        expect(s.usage[0].stopped_at).toBeNull();
        s.deps.executions!.describe = read; await s.tick();
        expect(s.usage[0].stopped_at).toEqual(NOW);
    });
    it.each(['FAILED', 'TIMED_OUT', 'ABORTED'])('a %s recovery retries only under a new lifecycle version', async status => {
        const s = setup(); await s.tick(); s.finish(status); await s.tick();
        expect((await s.current()).state).toBe('UNCONFIRMED'); expect(s.usage[0].stopped_at).toBeNull();
        // The same deployment never churns: repeated opens and reconciler passes start nothing.
        await s.tick(); await s.tick(); await reconcileAwsFleet(s.deps, { [D.region]: D });
        expect(s.starts).toHaveLength(1);
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: expect.stringContaining('recovery_retry_awaits_new_deployment') });
        const next = { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(/:1$/, ':2') };
        await applyLifecycleReceipt(s.deps, await s.current(), next); expect(s.starts).toHaveLength(2);
        expect(s.starts[1].intent.jobId).not.toBe(s.starts[0].intent.jobId);
        expect(s.starts[1].stateMachineArn).toBe(next.stateMachineVersionArn);
        s.finish(); await applyLifecycleReceipt(s.deps, await s.current(), next);
        expect(s.usage[0].stopped_at).toEqual(NOW);
        expect(s.meter.stopped).toHaveBeenCalledOnce();
    });
    it('a successful receipt waits for volume availability and tunnel fencing', async () => {
        const s = setup(); await s.tick(); s.finish(); s.volume.state = 'in-use';
        await s.tick(); expect((await s.current()).state).toBe('RECOVERING');
        s.volume.state = 'available';
        s.deps.tunnels = { deleteTunnel: vi.fn(async () => ({ ok: false })) } as unknown as ReceiptDeps['tunnels'];
        await s.tick(); expect(s.usage[0].stopped_at).toBeNull();
        delete s.deps.tunnels; await s.tick(); expect(s.usage[0].stopped_at).toEqual(NOW);
    });
    it.each(['digest', 'jobId', 'generation', 'leaseEpoch', 'fenceToken', 'instanceId', 'volumeId', 'state'])('rejects a success receipt with wrong %s', async key => {
        const s = setup(); await s.tick(); const e = s.finish(); const receipt = JSON.parse(e.output!);
        receipt[key] = typeof receipt[key] === 'number' ? receipt[key] + 1 : 'wrong'; e.output = JSON.stringify(receipt);
        await s.tick(); expect((await s.current()).state).toBe('UNCONFIRMED'); expect(s.usage[0].stopped_at).toBeNull();
    });
    it('the fleet reconciler starts recovery and claims RECOVERING for completion', async () => {
        const s = setup(); await reconcileAwsFleet(s.deps, { [D.region]: D });
        expect(s.starts).toHaveLength(1); s.finish();
        await reconcileAwsFleet(s.deps, { [D.region]: D });
        expect((await s.current()).state).toBe('STOPPED');
    });
    it.each(['lifecycle_job_id', 'lifecycle_digest', 'fence_token', 'volume_id', 'instance_id', 'generation', 'lease_epoch', 'state', 'last_error', 'updated_at'])('a concurrent %s change defeats the recovery CAS', async column => {
        const s = setup(); const describe = s.deps.describer!.describeForEnrollment;
        s.deps.describer!.describeForEnrollment = async (...args) => {
            const host = await describe(...args);
            const row = s.placements[0]; row[column] = column === 'updated_at' ? new Date(NOW.getTime() + 1) : typeof row[column] === 'number' ? Number(row[column]) + 1 : column === 'state' ? 'RETIRING' : 'changed';
            return host;
        };
        await s.tick(); expect(s.starts).toHaveLength(0); expect(s.usage[0].stopped_at).toBeNull();
    });
    it('a deployment zone change cannot start recovery against another zone', async () => {
        const s = setup(); await applyLifecycleReceipt(s.deps, await s.current(), { ...D, zoneId: 'aps1-az2' });
        expect(s.starts).toHaveLength(0);
        expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lastError: expect.stringContaining('deployment_identity') });
    });
    it('a deletion after observation defeats the live recovery CAS', async () => {
        const s = setup(); const describe = s.deps.describer!.describeForEnrollment;
        s.deps.describer!.describeForEnrollment = async (...args) => {
            const host = await describe(...args); s.computers[0].deleted_at = NOW; return host;
        };
        await s.tick(); expect(s.starts).toHaveLength(0); expect((await s.current()).state).toBe('UNCONFIRMED');
    });
    it('a definite start refusal preserves the recorded job for a later retry', async () => {
        const s = setup(); const start = s.deps.starter!.start;
        s.deps.starter!.start = async () => { throw Object.assign(new Error('denied'), {
            name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 },
        }); };
        await s.tick(); const p = await s.current();
        expect(p.state).toBe('RECOVERING'); expect(p.lastError).toContain('start_refused');
        s.deps.starter!.start = start; await s.tick();
        expect(s.starts[0].intent.jobId).toBe(p.lifecycleJobId);
    });
    it('a redriven failed recovery cannot start another release', async () => {
        const s = setup(); await s.tick(); const failed = s.finish('FAILED'); failed.redriveCount = 1;
        await s.tick(); await s.tick(); expect(s.starts).toHaveLength(1);
        expect((await s.current()).state).toBe('UNCONFIRMED'); expect(s.usage[0].stopped_at).toBeNull();
    });
    it('accepts matching adopted-host tag aliases and uses the current release version', async () => {
        const s = setup(); s.host.tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': D.namespace,
            'ezil:generation': '3', 'ezil:computer': s.original.intent.computerId, 'ezil:fence': s.original.intent.fenceToken } as unknown as typeof s.host.tags;
        const d = { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(/:1$/, ':2') };
        await applyLifecycleReceipt(s.deps, await s.current(), d);
        expect(s.starts[0].stateMachineArn).toBe(d.stateMachineVersionArn);
    });
    it('usage failure rolls back STOPPED and a receipt replay retries the transaction', async () => {
        const s = setup(); await s.tick(); s.finish();
        const db = s.deps.db; const dialect = new PgDialect();
        s.deps.db = { ...db, transaction: fn => db.transaction(tx => fn({ execute: async query => {
            const r = await tx.execute(query);
            if (dialect.sqlToQuery(query).sql.includes('placement:usage-close')) throw new Error('usage unavailable');
            return r;
        } })) } satisfies PlacementDb;
        await expect(s.tick()).rejects.toThrow('usage unavailable');
        expect((await s.current()).state).toBe('RECOVERING'); expect(s.usage[0].stopped_at).toBeNull();
        s.deps.db = db; await s.tick(); expect(s.usage[0].stopped_at).toEqual(NOW);
    });
});


describe('independent historical stop-time proof', () => {
    it('does not backdate usage from a failed stop before any physical-stop proof', async () => {
        const s = setup('release');
        // StopInstances was denied in the old execution. The unchanged owned
        // source is stopped now, after a later operator stop; that current view
        // does not prove it was stopped at the failed execution end time.
        s.originalExecution.error = 'LifecycleUnconfirmed';
        s.originalExecution.cause = 'AccessDenied:StopInstances';
        await s.tick();
        s.finish();
        await s.tick();
        expect(s.usage[0].stopped_at).not.toEqual(STOP);
        expect(s.meter.stopped.mock.calls.some(([value]) => value.endedAt.getTime() === STOP.getTime())).toBe(false);
    });
});
