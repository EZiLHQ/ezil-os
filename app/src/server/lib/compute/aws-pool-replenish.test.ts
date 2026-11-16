import { expect, it, vi } from 'vitest';
import { AwsClientError } from './aws-errors';
import { runPoolReplenish, withPoolReplenishLock, type PoolReplenishDeps } from './aws-pool-replenish';
import { poolFixture, demandFixture, HOST, OTHER, NOW } from './aws-pool-test-support';
import { fixtureDeployment } from './aws-intent.test-support';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { PlacementExecutor } from './placement';
function fixture() {
    const f = poolFixture();
    const plan = { target: 4, provision: 4, retire: [] as string[], fail: [] as string[] };
    const demand = demandFixture();
    f.deps.data.readPoolDemand = vi.fn(async () => demand);
    f.deps.data.planPool = vi.fn(() => plan);
    const deps: PoolReplenishDeps = { db: f.deps.db, data: f.deps.data, deployments: {
        'ap-south-1': f.deployment, 'us-east-1': fixtureDeployment('us-east-1') },
        classes: [{ region: f.row.region, zoneId: f.row.zoneId, instanceType: 'm6i.large' }],
        now: () => NOW, withLock: vi.fn(async run => run()), log: vi.fn(), sleep: async () => {},
        starter: { start: vi.fn(async () => {}) }, store: {
            prepare: vi.fn(async (_tx, c, _op, build, host) => build(host ?? { ...f.row, ...c, instanceId: null })),
            outcome: vi.fn(async () => {}) } };
    return { f, deps, plan, demand };
}
it('reads P8 demand/planner under the lock, dispatches through the existing start path and logs P2', async () => {
    const { deps } = fixture();
    const records = await runPoolReplenish(deps);
    expect(records).toEqual([{ target: 4, recent: 2, base: 1, spares: 1, provisioned: 2, retired: 0, retirements: [], slowHosts: [] }]);
    expect(deps.withLock).toHaveBeenCalledOnce();
    expect(deps.data.readPoolDemand).toHaveBeenCalledWith(deps.db, deps.classes[0], NOW);
    expect(deps.data.planPool).toHaveBeenCalledWith(deps.classes[0], expect.anything(), NOW);
    expect(deps.log).toHaveBeenCalledWith(records![0]);
    const calls = vi.mocked(deps.starter.start).mock.calls;
    expect(calls).toHaveLength(2);
    for (const [region, w] of calls) {
        const i = JSON.parse(JSON.parse(w.input).document);
        expect(i.operation).toBe('pool-provision'); expect(i.deployment.region).toBe(region);
        expect(i.dataVolumeId).toBeNull(); expect(i.dataVolumeGiB).toBeNull();
    }
});
it('honors the measured boot p90 in the P2 log', async () => {
    const { deps, demand } = fixture(); demand.bootMinutes = 12;
    expect((await runPoolReplenish(deps))![0]!.recent).toBe(4);
});
it('limits provisions globally across classes including unknown outcomes', async () => {
    const { deps } = fixture(); deps.classes.push({ region: 'us-east-1', zoneId: 'use1-az4', instanceType: 'm6i.large' });
    deps.starter.start = vi.fn(async () => { throw new Error('lost response'); });
    const records = await runPoolReplenish(deps).catch(() => null);
    expect(deps.store.prepare).toHaveBeenCalledTimes(2);
    expect(deps.store.outcome).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.store.outcome).mock.calls.every(([, outcome]) => outcome === 'unknown')).toBe(true);
    expect(records!.every(r => r.provisioned === 0)).toBe(true);
    const inputs = vi.mocked(deps.starter.start).mock.calls.map(([, w]) => w.input);
    expect(new Set(inputs).size).toBe(2); // retries preserve the exact input and job
});
it('records definite refusal and never counts it as a provision', async () => {
    const { deps } = fixture(); deps.starter.start = vi.fn(async () => { throw new AwsClientError('aws_capacity', false); });
    expect((await runPoolReplenish(deps))![0]!.provisioned).toBe(0);
    expect(deps.store.outcome).toHaveBeenCalledWith(expect.anything(), 'refused');
});
it('preserves planner retirement order, deduplicates and limits retirement globally', async () => {
    const { deps, plan } = fixture(); plan.provision = 0; plan.retire = [HOST, HOST, OTHER, 'third'];
    deps.classes.push({ region: 'us-east-1', zoneId: 'use1-az4', instanceType: 'm6i.large' });
    const records = await runPoolReplenish(deps).catch(() => null);
    expect(deps.store.prepare).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.data.markPoolHost).mock.calls.map(c => c[1])).toEqual([HOST, OTHER]);
    expect(records!.map(r => r.retired)).toEqual([2, 0]);
});
it('marks stale boots failed and retires them without competing with leases', async () => {
    const { deps, plan } = fixture(); plan.provision = 0; plan.fail = [HOST]; plan.retire = [HOST];
    await runPoolReplenish(deps);
    expect(deps.data.markPoolHost).toHaveBeenNthCalledWith(1, deps.db, HOST, ['booting'], 'failed', NOW);
    expect(deps.data.markPoolHost).toHaveBeenNthCalledWith(2, expect.anything(), HOST, ['ready', 'failed', 'retiring'], 'retiring', NOW);
    expect(deps.starter.start).toHaveBeenCalledOnce();
});
it('does not dispatch a retirement when a lease wins the state CAS', async () => {
    const { deps, plan } = fixture(); plan.provision = 0; plan.retire = [HOST];
    deps.data.markPoolHost = vi.fn(async () => null);
    const records = await runPoolReplenish(deps).catch(() => null);
    expect(deps.store.prepare).not.toHaveBeenCalled(); expect(deps.starter.start).not.toHaveBeenCalled();
    expect(deps.store.outcome).not.toHaveBeenCalled();
    expect(records![0]!.retired).toBe(0);
});
it('dispatches pool-retire for a refused adopt already marked retiring', async () => {
    const { deps, plan, f } = fixture(); plan.provision = 0;
    deps.store.retirementCandidates = vi.fn(async () => [HOST]);
    deps.data.markPoolHost = vi.fn(async (_tx, _id, from) => from.includes('retiring')
        ? { ...f.row, state: 'retiring' as const, leasedComputerId: null } : null);
    expect((await runPoolReplenish(deps))![0].retired).toBe(1);
    const call = vi.mocked(deps.starter.start).mock.calls[0];
    expect(JSON.parse(JSON.parse(call[1].input).document).operation).toBe('pool-retire');
});
it('recovers every stranded retirement independently of the two planned retirements', async () => {
    const { deps, plan, f } = fixture(); plan.provision = 0;
    const ids = [HOST, OTHER, '33333333-3333-4333-8333-333333333333'];
    plan.retire = ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'];
    deps.store.retirementCandidates = vi.fn(async (_tx, _c, state) => state === 'retiring' ? ids : []);
    deps.data.markPoolHost = vi.fn(async (_tx, id) => ({ ...f.row, poolHostId: id, state: 'retiring' as const }));
    const records = await runPoolReplenish(deps);
    expect(deps.starter.start).toHaveBeenCalledTimes(5);
    expect(records![0]).toMatchObject({ retired: 5, retirements: [...ids, ...plan.retire].map(poolHostId => ({
        poolHostId, jobId: expect.any(String), outcome: 'started',
    })) });
});
it.each(['started', 'refused', 'unknown'] as const)('records each retirement dispatch outcome: %s', async outcome => {
    const { deps, plan } = fixture(); plan.provision = 0; plan.retire = [HOST];
    if (outcome !== 'started') deps.starter.start = vi.fn(async () => {
        throw outcome === 'refused' ? new AwsClientError('aws_capacity', false) : new Error('lost response');
    });
    const record = (await runPoolReplenish(deps))![0];
    expect(record.retirements).toEqual([{ poolHostId: HOST, jobId: expect.any(String), outcome }]);
    expect(record.retired).toBe(outcome === 'started' ? 1 : 0);
    expect(deps.log).toHaveBeenCalledWith(record);
});
it('records the read-only readiness diagnostic from the locked pass before failing old boots', async () => {
    const { deps, plan } = fixture(); plan.provision = 0; plan.fail = [HOST];
    const slowHosts = [{ poolHostId: HOST, instanceId: 'i-11111111111111111',
        createdAt: new Date(NOW.getTime() - 11 * 60_000).toISOString(),
        enrolledAt: new Date(NOW.getTime() - 10 * 60_000).toISOString(), health: 'unknown' }];
    const tx = { execute: vi.fn() };
    deps.withLock = async run => run(tx);
    deps.data.readPoolReadinessDiagnostics = vi.fn(async executor => {
        expect(executor).toBe(tx);
        expect(deps.data.markPoolHost).not.toHaveBeenCalled();
        return slowHosts;
    });
    expect((await runPoolReplenish(deps))![0].slowHosts).toEqual(slowHosts);
    expect(deps.log).toHaveBeenCalledWith(expect.objectContaining({ slowHosts }));
});
it('commits reservations and work before starting lifecycle authority callbacks', async () => {
    const { deps, plan } = fixture(); plan.provision = 1;
    let committed = false;
    deps.db.transaction = async run => { const result = await run({ execute: vi.fn() }); committed = true; return result; };
    deps.starter.start = vi.fn(async () => { expect(committed).toBe(true); });
    await runPoolReplenish(deps); expect(deps.starter.start).toHaveBeenCalledOnce();
});
it('does not start work after a reservation failure and still logs the pass', async () => {
    const { deps } = fixture(); deps.store.prepare = vi.fn(async () => { throw new Error('store failure'); });
    await expect(runPoolReplenish(deps)).rejects.toThrow('store failure');
    expect(deps.starter.start).not.toHaveBeenCalled(); expect(deps.log).toHaveBeenCalledOnce();
});
it.each([-1, .5, NaN])('refuses invalid provision counts %s', async count => {
    const { deps, plan } = fixture(); plan.provision = count;
    await expect(runPoolReplenish(deps)).rejects.toThrow('plan_counts'); expect(deps.starter.start).not.toHaveBeenCalled();
});
it('refuses a reserved host in a different class', async () => {
    const { deps } = fixture(); deps.classes[0]!.zoneId = 'aps1-az2';
    await expect(runPoolReplenish(deps)).rejects.toThrow('work_class');
});
const lockAnswer = (locked: boolean) => vi.fn(async (query: Parameters<PlacementExecutor['execute']>[0]) =>
    new PgDialect().sqlToQuery(query).sql.includes('placement:lock-admission') ? [{ pg_advisory_xact_lock: '', isolation: 'read committed' }] : [{ locked }]);
it('performs no work during an overlapping pass', async () => {
    const { deps } = fixture(); deps.withLock = run => withPoolReplenishLock({ execute: vi.fn(),
        transaction: async fn => fn({ execute: lockAnswer(false) }) }, run);
    await expect(runPoolReplenish(deps)).rejects.toMatchObject({ status: 204 });
    expect(deps.data.readPoolDemand).not.toHaveBeenCalled();
});
it('takes the admission lock FIRST, then holds the pool advisory lock until dispatch ends', async () => {
    let done = false;
    const execute = lockAnswer(true);
    const db = { execute, transaction: async <T>(fn: (tx: { execute: typeof execute }) => Promise<T>) => {
        const value = await fn({ execute }); expect(done).toBe(true); return value;
    } };
    expect(await withPoolReplenishLock(db, async (_tx, lock) => { expect(lock).toBeDefined(); done = true; return 7; })).toBe(7);
    const order = execute.mock.calls.map(([q]) => new PgDialect().sqlToQuery(q).sql);
    expect(order).toHaveLength(2);
    expect(order[0]).toContain('placement:lock-admission');
    expect(order[1]).toContain('pg_try_advisory_xact_lock(1163554896, 0)');
});
