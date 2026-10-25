import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { poolFixture, NOW } from './aws-pool-test-support';
import { handlePoolSessionReady } from './aws-pool-session';
import { handlePoolClaim } from './aws-pool-claim';
import { poolTimingSchema, poolTimingDeltas, POOL_TIMING_PHASES } from './aws-pool-timing';
import { observePoolAdopt } from './aws-pool-adopt';
import { readPoolProof } from './aws-pool-host';
import * as placement from './placement';
import * as data from './ready-pool';
import * as receipts from './aws-receipts';
import { buildLifecycleWork } from './aws-intent';

beforeEach(() => { vi.spyOn(console, 'info').mockImplementation(() => {}); });
afterEach(() => vi.restoreAllMocks());
const timing = { claimObservedMs: 100, guardDoneMs: 200, enrollDoneMs: 500, warmStoppedMs: 600,
    relayAvailableMs: 800, desktopStartedMs: 900, desktopHealthyMs: 1200, claimPublishedAtMs: NOW.getTime() };

it.each([true, false, '100', null, [], {}, -1, Infinity, -Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])(
    'refuses nonnumeric or unbounded timing %s in every phase', value => {
        for (const field of POOL_TIMING_PHASES) expect(poolTimingSchema.safeParse({ [field]: value }).success).toBe(false);
    });
it.each([{ secret: 'never log' }, { claimPublishedAtMs: 4102444800001 }, { claimPublishedAtMs: true },
    { claimObservedMs: 2, desktopHealthyMs: 1 }, { claimObservedMs: 0, desktopHealthyMs: 86400001 }])(
    'refuses unknown fields, invalid publication dates, backwards and excessive spans %j', value => {
        expect(poolTimingSchema.safeParse(value).success).toBe(false);
    });
it('allows partial recovery timings and finite boundary values', () => {
    for (const t of [{}, { claimObservedMs: Number.MAX_SAFE_INTEGER }, { claimObservedMs: 0, desktopHealthyMs: 86400000 },
        { claimPublishedAtMs: 4102444800000 }, { desktopHealthyMs: 1.25 }]) expect(poolTimingSchema.safeParse(t).success).toBe(true);
    expect(poolTimingDeltas(timing)).toEqual({ guardDoneMs: 100, enrollDoneMs: 300, warmStoppedMs: 100,
        relayAvailableMs: 200, desktopStartedMs: 100, desktopHealthyMs: 300, claimToHealthyMs: 1100,
        claimPublishedAtMs: NOW.getTime() });
});
function session() {
    const f = poolFixture(true);
    f.p.lastError = placement.POOL_SESSION_PENDING; f.p.enrollConsumedHash = 'a'.repeat(64);
    vi.spyOn(data, 'recordPoolSessionReady').mockResolvedValue(true);
    const finish = vi.spyOn(placement, 'finishEnrollment').mockResolvedValue({ ok: true, placement: f.p });
    const request = (value: unknown = timing) => new Request(f.request('claim'), { method: 'POST',
        body: JSON.stringify({ sessionReady: true, timing: value }) });
    return { ...f, finish, request };
}
it('logs only numeric phase deltas and a computer prefix after readiness commits, once', async () => {
    const f = session();
    f.deps.db.transaction = async run => {
        const result = await run(f.deps.db); expect(console.info).not.toHaveBeenCalled(); return result;
    };
    expect((await handlePoolSessionReady(f.request(), f.deps)).status).toBe(200);
    expect(console.info).toHaveBeenCalledExactlyOnceWith(JSON.stringify({ event: 'pool-session-timing',
        computer: f.p.computerId.slice(0, 8), ...poolTimingDeltas(timing) }));
    f.p.lastError = placement.ENROLLMENT_SUCCEEDED;
    f.deps.db.transaction = async run => run(f.deps.db);
    expect((await handlePoolSessionReady(f.request(), f.deps)).status).toBe(200);
    expect(console.info).toHaveBeenCalledTimes(1);
});
it.each([{ guardDoneMs: 'secret' }, { desktopHealthyMs: true }, { claimObservedMs: -1 },
    { desktopHealthyMs: Number.MAX_SAFE_INTEGER + 1 }, { secret: 5 }])('rejects invalid telemetry before authentication/writes %j', async value => {
    const f = session(); expect((await handlePoolSessionReady(f.request(value), f.deps)).status).toBe(400);
    expect(f.finish).not.toHaveBeenCalled(); expect(f.deps.describer!.describeForEnrollment).not.toHaveBeenCalled();
    expect(console.info).not.toHaveBeenCalled();
});
it('does not log a readiness success on transaction rollback', async () => {
    const f = session(); f.deps.db.transaction = async run => { await run(f.deps.db); throw Error('rollback'); };
    expect((await handlePoolSessionReady(f.request(), f.deps)).status).toBe(503);
    expect(console.info).not.toHaveBeenCalled();
});
it('returns the numeric publication date without changing the nonce on retry', async () => {
    const f = poolFixture(true); f.row.claimPublishedAt = NOW;
    const response = await handlePoolClaim(f.request('claim'), f.deps);
    expect(await response.json()).toMatchObject({ claimPublishedAtMs: NOW.getTime() });
});

function observer() {
    const f = poolFixture(true);
    const reconcile = vi.spyOn(receipts, "applyLifecycleReceipt");
    const pending = vi.spyOn(data, 'readPendingPoolAdopt').mockResolvedValue(f.row);
    vi.spyOn(placement, 'readPlacement').mockResolvedValue({ record: f.p, provider: 'aws-ec2', store: 'ebs' });
    const publish = vi.spyOn(data, 'publishPoolClaim').mockResolvedValue(f.row);
    // Exercise the real receipt handler; only its transaction boundary is stubbed.
    const attached = vi.spyOn(placement, 'publishAttachedPoolClaim').mockImplementation(async (_db, _p, volume, write) => {
        expect(volume).toBe(f.receipt.volumeId); await write(f.deps.db);
        expect(console.info).not.toHaveBeenCalled();
    });
    const run = () => observePoolAdopt(f.deps, readPoolProof(f.request('claim')),
        { doc: f.doc, view: f.view, deployment: f.deployment });
    return { ...f, pending, publish, attached, reconcile, run };
}
it('host observes and publishes SUCCEEDED immediately using the receipt attachment transaction', async () => {
    const f = observer(); await f.run();
    expect(f.deps.executions!.describe).toHaveBeenCalledTimes(1);
    expect(f.attached).toHaveBeenCalledOnce(); expect(f.publish).toHaveBeenCalledOnce();
    expect(f.deps.saveNonce).not.toHaveBeenCalled();
    expect(console.info).toHaveBeenCalledOnce();
    expect(JSON.parse(vi.mocked(console.info).mock.calls[0]![0])).toEqual({ event: 'pool-claim-timing',
        computer: f.p.computerId.slice(0, 8), adoptObservedToClaimPublishedMs: expect.any(Number) });
});
it('host claim handler invokes the observer before reading the claim or issuing a nonce', async () => {
    const f = poolFixture(true); let observed = false;
    f.deps.observeAdopt = vi.fn(async () => { observed = true; });
    vi.mocked(f.deps.data.readPoolClaim).mockImplementation(async () => { expect(observed).toBe(true); return f.row; });
    expect((await handlePoolClaim(f.request('claim'), f.deps)).status).toBe(200);
    expect(f.deps.observeAdopt).toHaveBeenCalledOnce();
});
it.each(['RUNNING', 'FAILED', 'ABORTED', 'TIMED_OUT'])('never reconciles a non-successful adopt %s', async status => {
    const f = observer(); f.execution.status = status; await f.run();
    expect(f.reconcile).not.toHaveBeenCalled();
    expect(f.attached).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled(); expect(console.info).not.toHaveBeenCalled();
});
it.each(['STOPPED', 'UNCONFIRMED', 'STOPPING', 'RUNNING'] as const)('does not reconcile placement %s', async state => {
    const f = observer(); f.p.state = state; await f.run();
    expect(f.deps.executions!.describe).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
});
it.each(['consumed', 'job', 'digest', 'reader', 'published'])('skips ineligible observation %s', async field => {
    const f = observer();
    if (field === 'consumed') f.p.enrollConsumedHash = 'f'.repeat(64);
    if (field === 'job') f.p.lifecycleJobId = null;
    if (field === 'digest') f.p.lifecycleDigest = null;
    if (field === 'reader') f.deps.executions = null;
    if (field === 'published') f.pending.mockResolvedValue(null);
    await f.run(); expect(f.attached).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
});
it.each(['lease', 'instance', 'provider', 'region', 'arn', 'version', 'alias', 'work', 'fence', 'epoch', 'tags', 'attached', 'deletion'])('refuses observer guard %s', async field => {
    const f = observer();
    if (field === 'lease') f.row.state = 'ready';
    if (field === 'instance') f.p.instanceId = 'i-22222222222222222';
    if (field === 'provider') f.p.provider = 'cloudflare';
    if (field === 'region') f.p.region = 'us-east-1';
    if (field === 'arn') f.execution.executionArn += 'x';
    if (field === 'version') f.execution.stateMachineVersionArn += 'x';
    if (field === 'alias') Object.assign(f.execution, { stateMachineAliasArn: 'alias' });
    if (field === 'work') {
        const w = buildLifecycleWork({ ...f.work.intent, poolHostId: f.p.computerId });
        f.execution.input = w.input; f.p.lifecycleDigest = w.digest;
    }
    if (field === 'fence') f.p.fenceToken = '11111111-1111-4111-8111-111111111111';
    if (field === 'epoch') f.p.leaseEpoch++;
    if (field === 'tags') f.view.tags['ezil:pool'] = '1';
    if (field === 'attached') f.view.volumes.pop();
    if (field === 'deletion') f.view.volumes[1]!.deleteOnTermination = true;
    await expect(f.run()).rejects.toThrow(); expect(f.attached).not.toHaveBeenCalled(); expect(f.publish).not.toHaveBeenCalled();
});
it('receipt conflicts and a lost attachment CAS never publish or log', async () => {
    const f = observer();
    vi.spyOn(placement, 'transitionPlacementAsReconciler').mockResolvedValue({ ok: false, reason: 'cas_conflict' });
    f.execution.output = JSON.stringify({ ...f.receipt, leaseEpoch: f.p.leaseEpoch + 1 });
    await f.run(); expect(f.attached).not.toHaveBeenCalled();
    f.execution.output = JSON.stringify(f.receipt); f.attached.mockResolvedValue();
    await f.run(); expect(f.publish).not.toHaveBeenCalled(); expect(console.info).not.toHaveBeenCalled();
});
it('publication rollback never logs success', async () => {
    const f = observer();
    f.attached.mockImplementation(async (_db, _p, _volume, write) => { await write(f.deps.db); throw Error('rollback'); });
    await expect(f.run()).rejects.toThrow('rollback'); expect(console.info).not.toHaveBeenCalled();
});
it('first-volume receipt uses the existing attachment CAS before the claim is exposed', async () => {
    const f = observer(); const w = buildLifecycleWork({ ...f.work.intent, dataVolumeId: null, dataVolumeGiB: 20 });
    f.p.volumeId = null; f.p.lifecycleDigest = w.digest; f.execution.input = w.input;
    f.execution.output = JSON.stringify({ ...f.receipt, digest: w.digest });
    await f.run(); expect(f.attached).toHaveBeenCalledWith(
        { execute: expect.any(Function), transaction: expect.any(Function) }, f.p, f.receipt.volumeId, expect.any(Function));
    expect(f.publish).toHaveBeenCalledOnce();
});
it('pending reads require a bound lease and all publication fields absent; retry keeps the first timestamp', async () => {
    const f = poolFixture(true); const queries: string[] = [];
    const db = { execute: vi.fn(async (q: Parameters<typeof f.deps.db.execute>[0]) => {
        queries.push(new PgDialect().sqlToQuery(q).sql); return [];
    }) };
    await data.readPendingPoolAdopt(db, f.row.poolHostId, f.row.instanceId!);
    expect(queries[0]).toMatch(/id = .*instance_id = .*state = 'leased'/);
    for (const column of ['claim_generation', 'claim_lease_epoch', 'claim_fence', 'claim_volume_serial'])
        expect(queries[0]).toContain(`${column} IS NULL`);
    await expect(data.publishPoolClaim(db, f.row.poolHostId, { computerId: f.p.computerId, generation: f.p.generation,
        leaseEpoch: f.p.leaseEpoch, fence: f.p.fenceToken!, volumeSerial: f.p.volumeId! }, NOW)).rejects.toThrow('pool_state_conflict');
    expect(queries[1]).toContain('CASE WHEN claim_generation IS NULL THEN');
    expect(queries[1]).toContain('ELSE updated_at END');
});

it.each(['{', ' '.repeat(1024) + '{"sessionReady":true}'])('rejects malformed or oversized session bodies without retrying', async body => {
    const f = session();
    const req = new Request(f.request(), { body });
    expect((await handlePoolSessionReady(req, f.deps)).status).toBe(400);
    expect(f.finish).not.toHaveBeenCalled(); expect(console.info).not.toHaveBeenCalled();
});
