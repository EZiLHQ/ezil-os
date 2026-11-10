import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { D, NOW } from './aws-failed-release.test-support';
import { HOST_STOPPED, parkSetup, SNAP, STOP_JOB, type Setup } from './aws-failed-release-park.test-support';
import { PARKED_FAILED_RELEASE, parkReplay, POOL_PARK_RECOVERY_PREFIX, reconcileParkedStop, reserveParkedStop,
    type ParkDeps, type ParkFailedReleaseRequest } from './aws-failed-release-park';
import { applyLifecycleReceipt } from './aws-receipts';
import { writeLivePoolRecovery } from './placement';

afterEach(() => vi.restoreAllMocks());

const untouched = async (s: Setup) => {
    expect(s.starts).toHaveLength(0);
    expect(await s.current()).toMatchObject({ state: 'UNCONFIRMED', lifecycleJobId: s.i.jobId, lastError: 'failed:LifecycleUnconfirmed' });
};

describe('park a failed release: reservation', () => {
    it('reserves ONE ordinary stop job (explicit stop intent, current deployment, same tuple), tolerating only the stale legacy fence alias', async () => {
        const s = parkSetup();
        expect(await s.reserve()).toEqual({ outcome: 'reserved', error: null });
        const p = await s.current();
        expect(p).toMatchObject({ state: 'RECOVERING', generation: 1, leaseEpoch: 1, lifecycleJobId: STOP_JOB, instanceId: s.i.providerInstanceId, volumeId: s.i.dataVolumeId });
        expect(p.lifecycleDigest).not.toBe(s.original.digest);
        expect(s.starts).toHaveLength(1);
        const work = s.starts[0]!;
        // Only ever a stop: never a release, retire, detach or terminate.
        expect(work.intent.operation).toBe('stop');
        expect(work.intent).toMatchObject({ jobId: STOP_JOB, computerId: s.i.computerId, targetGeneration: 1, leaseEpoch: 1, fenceToken: s.i.fenceToken,
            providerInstanceId: s.i.providerInstanceId, dataVolumeId: s.i.dataVolumeId, userData: null });
        expect(work.stateMachineArn).toBe(D.stateMachineVersionArn);
        expect(work.digest).toBe(p.lifecycleDigest);
        // The audit of the failed release and the proven backup is in the durable document.
        const doc = parkReplay(p)!;
        expect(doc).toMatchObject({ v: 1, snapshotId: SNAP, hostStoppedAt: HOST_STOPPED.toISOString(), sourceJobId: s.i.jobId, sourceDigest: s.original.digest,
            sourceExecutionArn: s.failed.executionArn, sourceStateMachineVersionArn: s.original.stateMachineArn, sourceError: 'failed:LifecycleUnconfirmed', error: null });
        expect(doc.intent.operation).toBe('stop');
        expect(p.lastError!.startsWith(POOL_PARK_RECOVERY_PREFIX)).toBe(true);
        expect(s.usage[0]!.stopped_at).toBeNull();
        expect(s.meter.stopped).not.toHaveBeenCalled();
    });

    it('is idempotent: the same request again starts nothing; another snapshot is refused while a park is in progress', async () => {
        const s = parkSetup();
        await s.reserve();
        expect(await s.reserve()).toEqual({ outcome: 'already_reserved', error: null });
        expect(await s.reserve({ ...s.request, snapshotId: 'snap-0fedcba9876543210' })).toEqual({ outcome: 'refused', error: 'park_in_progress' });
        expect(s.starts).toHaveLength(1);
    });

    const refusals: [string, string, (s: Setup) => void][] = [
        ['wrong expected job', 'not_applicable', s => { s.request.expectedJobId = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d'; }],
        ['hint naming another execution', 'source_not_proven', s => { s.request.releaseExecutionArn = s.request.releaseExecutionArn.replace(s.i.jobId, '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d'); }],
        ['source execution not FAILED', 'execution_not_failed', s => { s.failed.status = 'TIMED_OUT'; }],
        ['source execution running', 'execution_not_failed', s => { s.failed.status = 'RUNNING'; }],
        ['state-machine alias on the source', 'execution_authority', s => { (s.failed as { stateMachineAliasArn?: string }).stateMachineAliasArn = 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-mum-lifecycle:live'; }],
        ['redriven source', 'execution_authority', s => { s.failed.redriveCount = 1; }],
        ['source digest altered', 'execution_identity', s => { s.failed.input = s.failed.input!.replace(/"digest":"[a-f0-9]{64}"/, `"digest":"${'0'.repeat(64)}"`); }],
        ['source stop time missing', 'stop_time_missing_or_invalid', s => { s.failed.stopDate = undefined; }],
        ['active writer lease', 'writer_lease_active', s => { s.placements[0]!.lease_until = new Date(NOW.getTime() + 60_000); }],
        ['host running', 'instance_identity', s => { s.host.state = 'running'; }],
        ['host of another type', 'instance_identity', s => { s.host.instanceType = 'c7i.large'; }],
        ['host in another zone', 'instance_identity', s => { s.host.availabilityZoneId = 'aps1-az2'; }],
        ['host pool marker', 'instance_identity', s => { s.host.tags['ezil:pool'] = '1'; }],
        ['host alias disagreeing', 'instance_identity', s => { s.host.tags['ezil:fence'] = 'someone-else'; }],
        ['host with a third disk', 'instance_disks', s => { (s.host.volumes as unknown[]).push({ deviceName: '/dev/sdg', volumeId: 'vol-0bbbbbbbbbbbbbbbb', deleteOnTermination: false }); }],
        ['data disk deleted on termination', 'instance_disks', s => { (s.host.volumes as { deleteOnTermination: boolean }[])[1]!.deleteOnTermination = true; }],
        ['stop time unknown', 'stop_time_unknown', s => { s.host.stateTransitionAt = null; }],
        ['volume detached', 'volume_attachment', s => { Object.assign(s.volume, { state: 'available', attachments: [] }); }],
        ['volume attached to another host', 'volume_attachment', s => { Object.assign(s.volume, { attachments: [{ instanceId: 'i-0ffffffffffffffff', state: 'attached' }] }); }],
        ['volume unencrypted', 'volume_identity', s => { s.volume.encrypted = false; }],
        ['volume under another key', 'volume_identity', s => { s.volume.kmsKeyId = 'arn:aws:kms:ap-south-1:123456789012:key/other'; }],
        ['volume in another zone', 'volume_identity', s => { s.volume.zoneId = 'aps1-az2'; }],
        ['volume too small', 'volume_identity', s => { s.volume.sizeGiB = 1; }],
        ['volume canonical fence differs', 'volume_identity', s => { s.volume.tags = { ...s.volume.tags, 'ezil:fence-token': 'another-fence' }; }],
        ['volume canonical generation differs', 'volume_identity', s => { s.volume.tags = { ...s.volume.tags, 'ezil:generation': '2' }; }],
        ['volume legacy COMPUTER alias differs', 'volume_identity', s => { s.volume.tags = { ...s.volume.tags, 'ezil:computer': '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d' }; }],
        ['a SECOND differing alias (namespace)', 'volume_identity', s => { s.volume.tags = { ...s.volume.tags, 'ezil:namespace': 'other' }; }],
        ['volume carries the pool marker', 'volume_identity', s => { s.volume.tags = { ...s.volume.tags, 'ezil:pool': '1' }; }],
        ['snapshot absent', 'snapshot_not_proven', s => { s.describeSnapshot.mockResolvedValue(null); }],
        ['snapshot pending', 'snapshot_not_proven', s => { s.snapshot.state = 'pending'; }],
        ['snapshot of another account', 'snapshot_not_proven', s => { s.snapshot.ownerId = '999999999999'; }],
        ['snapshot of another volume', 'snapshot_not_proven', s => { s.snapshot.volumeId = 'vol-0cccccccccccccccc'; }],
        ['snapshot unencrypted', 'snapshot_not_proven', s => { s.snapshot.encrypted = false; }],
        ['snapshot under another key', 'snapshot_not_proven', s => { s.snapshot.kmsKeyId = 'arn:aws:kms:ap-south-1:123456789012:key/other'; }],
        ['snapshot of another size', 'snapshot_not_proven', s => { s.snapshot.volumeGiB = 49; }],
        ['an OLD routine snapshot (taken before the stop)', 'snapshot_not_post_stop', s => { s.snapshot.startedAt = new Date(HOST_STOPPED.getTime() - 60_000); }],
        ['snapshot in the future', 'snapshot_not_post_stop', s => { s.snapshot.startedAt = new Date(NOW.getTime() + 60_000); }],
    ];
    it.each(refusals)('refuses with nothing written or started: %s', async (_name, error, mutate) => {
        const s = parkSetup();
        mutate(s);
        expect(await s.reserve()).toEqual({ outcome: 'refused', error });
        await untouched(s);
    });

    it('refuses without a starter or a snapshot reader, and for a placement that is not the failed release (nothing written)', async () => {
        const s = parkSetup();
        expect(await s.reserve(s.request, { ...s.deps, starter: undefined })).toEqual({ outcome: 'refused', error: 'starter_missing' });
        const noSnapshotReader = { ...s.deps, describer: { ...s.deps.describer, describeSnapshot: undefined } } as ParkDeps;
        expect(await s.reserve(s.request, noSnapshotReader)).toEqual({ outcome: 'refused', error: 'describer_missing' });
        s.placements[0]!.state = 'STOPPED'; // not UNCONFIRMED
        expect(await s.reserve()).toEqual({ outcome: 'refused', error: 'not_applicable' });
        expect(s.starts).toHaveLength(0);
    });

    it('a concurrent change between proof and reservation loses the CAS: refused, nothing started', async () => {
        const s = parkSetup();
        s.describeSnapshot.mockImplementation(async () => {
            await writeLivePoolRecovery(s.db, await s.current(), 'UNCONFIRMED', { lastError: 'failed:Concurrent' });
            return s.snapshot;
        });
        expect(await s.reserve()).toEqual({ outcome: 'refused', error: 'cas_conflict' });
        expect(s.starts).toHaveLength(0);
        expect((await s.current()).state).toBe('UNCONFIRMED');
    });
});

describe('park a failed release: settlement', () => {
    it('settles RECOVERING -> STOPPED from the NEW stop receipt: usage closed once at the proven stop time, host and volume untouched, audit logged', async () => {
        const s = parkSetup();
        await s.reserve();
        // Waiting while the stop runs: the receipt pass owns the row but changes nothing and starts nothing.
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(await s.current()).toMatchObject({ state: 'RECOVERING', lifecycleJobId: STOP_JOB });
        expect(s.starts).toHaveLength(1);
        s.finishStop();
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(await s.current()).toMatchObject({ state: 'STOPPED', lifecycleJobId: null, lifecycleDigest: null, lastError: PARKED_FAILED_RELEASE,
            instanceId: s.i.providerInstanceId, volumeId: s.i.dataVolumeId, generation: 1, leaseEpoch: 1, fenceToken: s.i.fenceToken });
        expect(s.usage[0]!.stopped_at).toEqual(HOST_STOPPED); // never the failed release's time, never this pass's time
        expect(s.meter.stopped).toHaveBeenCalledTimes(1);
        expect(s.meter.stopped.mock.calls[0]![0]).toMatchObject({ computerId: s.i.computerId, endedAt: HOST_STOPPED, reason: 'provider_stop' });
        expect(s.starts).toHaveLength(1); // still the single stop: no release, retire, detach or terminate was ever requested
        expect(s.deps.tunnels!.deleteTunnel).toHaveBeenCalledTimes(1);
        // A second pass is a no-op.
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(s.meter.stopped).toHaveBeenCalledTimes(1);
        expect(s.starts).toHaveLength(1);
        // The original failure and the proven backup are in the structured settlement event.
        expect(s.log.mock.calls.map(c => String(c[0])).join('\n')).toMatch(new RegExp(`"event":"pool-park-settled".*"snapshot":"${SNAP}"`));
    });

    it('a lost StartExecution is re-started FROM THE SAVED STOP DOCUMENT (same job id): it can never become a release', async () => {
        const s = parkSetup();
        const start = s.deps.starter!.start as ReturnType<typeof vi.fn>;
        const real = start.getMockImplementation()!;
        start.mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost')).mockRejectedValueOnce(new Error('lost'));
        expect(await s.reserve()).toEqual({ outcome: 'reserved', error: null });
        expect(s.starts).toHaveLength(0);
        expect(parkReplay(await s.current())).toMatchObject({ error: 'start_unknown' });
        start.mockImplementation(real);
        await applyLifecycleReceipt(s.deps, await s.current(), D); // execution absent -> start the saved stop
        expect(s.starts).toHaveLength(1);
        expect(s.starts[0]!.intent).toMatchObject({ operation: 'stop', jobId: STOP_JOB });
        expect(s.starts.some(w => w.intent.operation !== 'stop')).toBe(false);
        expect((await s.current()).state).toBe('RECOVERING');
    });

    const blocked: [string, string, (s: Setup) => void][] = [
        ['receipt of a retired release', 'receipt_identity', s => { s.finishStop({ state: 'retired' }); }],
        ['receipt reporting a lost instance', 'receipt_identity', s => { s.finishStop({ instanceLost: true }); }],
        ['receipt for another volume', 'receipt_identity', s => { s.finishStop({ volumeId: 'vol-0cccccccccccccccc' }); }],
        ['receipt with another digest', 'receipt_identity', s => { s.finishStop({ digest: '0'.repeat(64) }); }],
        ['receipt that is not JSON', 'receipt_invalid', s => { s.finishStop().output = 'not json'; }],
        ['stop job failed', 'execution_failed', s => { s.finishStop().status = 'FAILED'; }],
        ['host started and stopped again after the reservation', 'host_changed', s => { s.finishStop(); s.host.stateTransitionAt = new Date(HOST_STOPPED.getTime() + 300_000); }], // 15:25: still before the snapshot, but not the proven stop
        ['host running again', 'instance_identity', s => { s.finishStop(); s.host.state = 'running'; }],
        ['volume detached', 'volume_attachment', s => { s.finishStop(); Object.assign(s.volume, { state: 'available', attachments: [] }); }],
        ['snapshot no longer completed', 'snapshot_not_proven', s => { s.finishStop(); s.snapshot.state = 'error'; }],
        ['source execution rewritten (other stop time)', 'source_identity', s => { s.finishStop(); s.failed.stopDate = new Date(NOW.getTime() - 1000); }],
        ['source execution no longer FAILED', 'source_identity', s => { s.finishStop(); s.failed.status = 'SUCCEEDED'; }],
    ];
    it.each(blocked)('stays RECOVERING with a recorded diagnostic and closes no usage: %s', async (_name, error, mutate) => {
        const s = parkSetup();
        await s.reserve();
        mutate(s);
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        const p = await s.current();
        expect(p.state).toBe('RECOVERING');
        expect(parkReplay(p)).toMatchObject({ error });
        expect(s.usage[0]!.stopped_at).toBeNull();
        expect(s.meter.stopped).not.toHaveBeenCalled();
        expect(s.starts).toHaveLength(1);
    });

    it('does not own rows it did not park: a release-recovery or failed-release row is left to the existing handlers', async () => {
        const s = parkSetup();
        expect(await s.settle()).toBe(false); // UNCONFIRMED failed release
        await writeLivePoolRecovery(s.db, await s.current(), 'RECOVERING', { lastError: 'pool_release_recovery:{"error":"x"}' });
        expect(await s.settle()).toBe(false);
    });

    it('a failed-release recovery pass over an UNCONFIRMED park candidate still behaves as before (stricter alias check, nothing reserved)', async () => {
        const s = parkSetup();
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        const p = await s.current();
        expect(p.state).toBe('UNCONFIRMED'); // the ordinary recovery refuses the legacy alias: unchanged, no weakening
        expect(s.starts).toHaveLength(0);
        // The ordinary recovery only wrote its own diagnostic; the park still reserves from that row.
        expect(await s.reserve()).toEqual({ outcome: 'reserved', error: null });
        expect(s.starts.map(w => w.intent.operation)).toEqual(['stop']);
    });
});

/** Wrap the fake executor (like the migration and reverse-move suites do) so a statement can be answered by the test. */
const dialect = new PgDialect();
function intercepting(deps: ParkDeps, answer: (text: string) => { rows: unknown[] } | null): ParkDeps {
    const wrap = <T extends object>(executor: T): T => new Proxy(executor, { get(target, key, receiver) {
        if (key === 'execute') return async (query: never) => answer(dialect.sqlToQuery(query).sql) ?? (target as { execute: (q: never) => Promise<unknown> }).execute(query);
        if (key === 'transaction') return (cb: (tx: object) => Promise<unknown>, config?: unknown) =>
            (target as { transaction: (c: unknown, k?: unknown) => Promise<unknown> }).transaction((tx: object) => cb(wrap(tx)), config);
        const value = Reflect.get(target, key, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
    } });
    return { ...deps, db: wrap(deps.db) };
}

describe('park a failed release: exclusions under the reservation locks', () => {
    const blockers: [string, string, (text: string) => { rows: unknown[] } | null][] = [
        ['a pool-host lease on the computer', 'blocked_pool_lease', t => t.startsWith('/* placement:park-blockers */') ? { rows: [{ kind: 'pool_lease' }] } : null],
        ['an uncommitted migration', 'blocked_migration', t => t.startsWith('/* placement:park-blockers */') ? { rows: [{ kind: 'migration' }] } : null],
        ['a writer lease row (table present)', 'blocked_writer_lease', t => /to_regclass\('public\.ezil_compute_writer_leases'\)/.test(t) ? { rows: [{ present: true }] }
            : t.startsWith('/* placement:park-writer-lease */') ? { rows: [{ held: 1 }] } : null],
        ['a reverse move that still holds the computer', 'blocked_reverse_move', t => /to_regclass\('public\.ezil_compute_reverse_moves'\)/.test(t) ? { rows: [{ present: true }] }
            : t.startsWith('/* moves:lock-computer */') ? { rows: [{ isolation: 'read committed' }] }
            : /FROM public\.ezil_compute_reverse_moves/.test(t) ? { rows: [{ held: 1 }] } : null],
    ];
    it.each(blockers)('refuses with nothing written or started while there is %s', async (_name, error, answer) => {
        const s = parkSetup();
        expect(await s.reserve(s.request, intercepting(s.deps, answer))).toEqual({ outcome: 'refused', error });
        await untouched(s);
        // The same proof reserves once the blocker is gone.
        expect(await s.reserve()).toEqual({ outcome: 'reserved', error: null });
    });

    it('takes admission, the canonical computer lock and the row lock before it writes (the ordinary lock order)', async () => {
        const s = parkSetup();
        await s.reserve();
        const order = s.statements.map(st => st.sql);
        const at = (needle: string) => order.findIndex(t => t.includes(needle));
        expect(at('placement:lock-admission')).toBeGreaterThanOrEqual(0);
        expect(at('placement:lock-admission')).toBeLessThan(at('placement:lock-computer'));
        expect(at('placement:lock-computer')).toBeLessThan(at('placement:park-row-lock'));
        expect(at('placement:park-row-lock')).toBeLessThan(at('placement:park-blockers'));
        expect(at('placement:park-blockers')).toBeLessThan(order.findIndex(t => t.includes('UPDATE public.ezil_computer_placements')));
        expect(order.findIndex(t => t.includes('UPDATE public.ezil_computer_placements'))).toBeGreaterThan(0);
    });

    it('an image job or orphaned reservation refuses the whole request (409 at the route), before any write', async () => {
        const s = parkSetup();
        s.placements[0]!.image_upgrade_job_id = '0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d';
        await expect(s.reserve()).rejects.toMatchObject({ name: 'ImageJobConflictError' });
        expect(s.starts).toHaveLength(0);
    });
});

describe('park a failed release: versions, authority and durable retry', () => {
    const d36 = { ...D, stateMachineVersionArn: D.stateMachineVersionArn.replace(/:19$/, ':36') };
    it('runs the NEW stop on the current state-machine version while the old failed release keeps ITS OWN version', async () => {
        const s = parkSetup();
        expect(d36.stateMachineVersionArn).not.toBe(D.stateMachineVersionArn);
        expect(await reserveParkedStop(s.deps, { [D.region]: d36 }, s.request)).toEqual({ outcome: 'reserved', error: null });
        expect(s.starts[0]!.stateMachineArn).toBe(d36.stateMachineVersionArn);
        expect(parkReplay(await s.current())).toMatchObject({ sourceStateMachineVersionArn: s.original.stateMachineArn });
        expect(s.original.stateMachineArn).toBe(D.stateMachineVersionArn);
        s.finishStop();
        await applyLifecycleReceipt(s.deps, await s.current(), d36);
        expect(await s.current()).toMatchObject({ state: 'STOPPED', lastError: PARKED_FAILED_RELEASE });
    });

    it.each([
        ['another account', { accountId: '999999999999' }],
        ['another namespace', { namespace: 'blr' }],
        ['another data key', { dataKeyArn: 'arn:aws:kms:ap-south-1:123456789012:key/other' }],
        ['another zone', { zoneId: 'aps1-az2' }],
    ])('refuses a current deployment of %s: the authority must be the failed release\'s', async (_name, over) => {
        const s = parkSetup();
        const outcome = await reserveParkedStop(s.deps, { [D.region]: { ...d36, ...over } }, s.request);
        expect(outcome.outcome).toBe('refused');
        await untouched(s);
    });

    it('refuses a current deployment with another root-device authority (deployment_identity)', async () => {
        const s = parkSetup();
        const other = { ...d36, storage: { ...d36.storage, rootDeviceName: '/dev/xvda' } };
        expect(await reserveParkedStop(s.deps, { [D.region]: other }, s.request)).toEqual({ outcome: 'refused', error: 'deployment_identity' });
        await untouched(s);
    });

    it('repeated passes with a start that keeps failing follow the SAME saved stop (job, digest and failure audit never cleared or replaced)', async () => {
        const s = parkSetup();
        const start = s.deps.starter!.start as ReturnType<typeof vi.fn>;
        const real = start.getMockImplementation()!;
        start.mockRejectedValue(new Error('lost'));
        await s.reserve();
        const first = await s.current();
        for (let pass = 0; pass < 3; pass++) await applyLifecycleReceipt(s.deps, await s.current(), D);
        const after = await s.current();
        expect(after).toMatchObject({ state: 'RECOVERING', lifecycleJobId: STOP_JOB, lifecycleDigest: first.lifecycleDigest });
        expect(parkReplay(after)).toMatchObject({ error: 'start_unknown', sourceJobId: s.i.jobId, sourceDigest: s.original.digest, snapshotId: SNAP });
        expect(s.starts).toHaveLength(0);
        start.mockImplementation(real);
        await applyLifecycleReceipt(s.deps, await s.current(), D);
        expect(s.starts.map(w => [w.intent.operation, w.intent.jobId, w.digest])).toEqual([['stop', STOP_JOB, first.lifecycleDigest]]);
        await applyLifecycleReceipt(s.deps, await s.current(), D); // running: still the same single job
        expect(s.starts).toHaveLength(1);
    });
});
