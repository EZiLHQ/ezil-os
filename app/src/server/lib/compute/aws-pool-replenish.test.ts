import { describe, expect, it, vi } from 'vitest';
import { AwsClientError } from './aws-errors';
import { newPoolPassLogMemo, poolPassLine, runPoolReplenish, withPoolReplenishLock, type PoolPassEntry, type PoolPassRecord, type PoolReplenishDeps } from './aws-pool-replenish';
import type { PoolClass } from './ready-pool';
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
    expect(deps.log).toHaveBeenCalledExactlyOnceWith([{ c: deps.classes[0], record: records![0] }], false);
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
// Round 6 (codeopen review, deferred to integration): a stalled boot that commits ready between readPoolDemand and
// its booting→failed mark is a healthy spare. Its fail mark updates nothing, so it is not reserved for retirement.
it('does not retire a planned-fail spare that became ready before its fail mark', async () => {
    const { deps, plan, f } = fixture(); plan.provision = 0; plan.fail = [HOST];
    deps.data.markPoolHost = vi.fn(async (_tx, id, from, to) => from.length === 1 && from[0] === 'booting'
        ? null : { ...f.row, poolHostId: id, state: to });
    const records = await runPoolReplenish(deps);
    expect(deps.data.markPoolHost).toHaveBeenCalledExactlyOnceWith(deps.db, HOST, ['booting'], 'failed', NOW);
    expect(deps.store.prepare).not.toHaveBeenCalled(); expect(deps.starter.start).not.toHaveBeenCalled();
    expect(records![0]).toMatchObject({ retired: 0, retirements: [] });
});
it('retires a planned-fail boot its own mark failed, in plan order, and skips the one that raced to ready', async () => {
    const { deps, plan, f } = fixture(); plan.provision = 0; plan.fail = [HOST, OTHER];
    deps.data.markPoolHost = vi.fn(async (_tx, id, from, to) => from[0] === 'booting' && from.length === 1 && id === OTHER
        ? null : { ...f.row, poolHostId: id, state: to });
    const records = await runPoolReplenish(deps);
    expect(vi.mocked(deps.data.markPoolHost).mock.calls.map(c => [c[1], c[3]])).toEqual([[HOST, 'failed'], [OTHER, 'failed'], [HOST, 'retiring']]);
    expect(records![0]).toMatchObject({ retired: 1, retirements: [{ poolHostId: HOST, outcome: 'started' }] });
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
    expect(deps.log).toHaveBeenCalledExactlyOnceWith([{ c: deps.classes[0], record }], false);
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
    expect(deps.log).toHaveBeenCalledExactlyOnceWith([{ c: deps.classes[0], record: expect.objectContaining({ slowHosts }) }], false);
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
    expect(deps.starter.start).not.toHaveBeenCalled();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith([{ c: deps.classes[0], record: expect.objectContaining({ provisioned: 0 }) }], true);
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
    expect(deps.log).not.toHaveBeenCalled(); // D4: a skipped (lock-busy) pass is not a failed pass

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

// D4 (round 5): one compact single-line JSON per pass, only when something changed, plus a 15-minute heartbeat.
const CLASS_L: PoolClass = { region: 'ap-south-1', zoneId: 'aps1-az1', instanceType: 'm6i.large' };
const CLASS_XL: PoolClass = { region: 'ap-south-1', zoneId: 'aps1-az1', instanceType: 'm6i.xlarge' };
const idle = (spares = 1, target = 1): PoolPassRecord => ({ target, recent: 0, base: 1, spares, provisioned: 0, retired: 0, retirements: [], slowHosts: [] });
const pass = (...records: PoolPassRecord[]): PoolPassEntry[] => records.map((record, i) => ({ c: i === 0 ? CLASS_L : CLASS_XL, record }));
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);
describe('poolPassLine (D4 pool-replenish log)', () => {
    it('emits one single-line JSON with every class on the first pass', () => {
        const memo = newPoolPassLogMemo();
        const line = poolPassLine(pass(idle(1, 1), idle(0, 0)), memo, NOW);
        expect(line).not.toBeNull(); expect(line).not.toContain('\n');
        expect(JSON.parse(line!)).toEqual({ event: 'pool-replenish', classes: [
            { region: 'ap-south-1', type: 'm6i.large', target: 1, spares: 1, provisioned: 0, retired: 0, retirements: [], slowHosts: [] },
            { region: 'ap-south-1', type: 'm6i.xlarge', target: 0, spares: 0, provisioned: 0, retired: 0, retirements: [], slowHosts: [] }] });
    });
    it('stays silent for unchanged idle passes and heartbeats once per 15 minutes', () => {
        const memo = newPoolPassLogMemo();
        expect(poolPassLine(pass(idle(), idle(0, 0)), memo, NOW)).not.toBeNull();
        for (let m = 1; m < 15; m++) expect(poolPassLine(pass(idle(), idle(0, 0)), memo, at(m)), `minute ${m}`).toBeNull();
        const beat = poolPassLine(pass(idle(), idle(0, 0)), memo, at(15));
        expect(JSON.parse(beat!)).toMatchObject({ event: 'pool-replenish', heartbeat: true });
        expect(poolPassLine(pass(idle(), idle(0, 0)), memo, at(16))).toBeNull();
        expect(poolPassLine(pass(idle(), idle(0, 0)), memo, at(29))).toBeNull();
        expect(poolPassLine(pass(idle(), idle(0, 0)), memo, at(30))).not.toBeNull();
    });
    it.each<[string, (r: PoolPassRecord) => void]>([
        ['provisioned', r => { r.provisioned = 1; }],
        ['retired', r => { r.retired = 1; }],
        ['retirements', r => { r.retirements = [{ poolHostId: HOST, jobId: 'job', outcome: 'refused' }]; }],
        ['slowHosts', r => { r.slowHosts = [{ poolHostId: HOST, instanceId: null, createdAt: NOW.toISOString(), enrolledAt: null, health: 'unknown' }]; }],
        ['target', r => { r.target = 2; }],
        ['spares', r => { r.spares = 2; }],
    ])('emits a changed pass (%s) without the heartbeat flag', (_name, change) => {
        const memo = newPoolPassLogMemo();
        poolPassLine(pass(idle()), memo, NOW);
        const record = idle(); change(record);
        const line = poolPassLine(pass(record), memo, at(1));
        expect(line).not.toBeNull(); expect(JSON.parse(line!).heartbeat).toBeUndefined();
    });
    it('re-arms the signature: a new steady state is logged once, then silent', () => {
        const memo = newPoolPassLogMemo();
        poolPassLine(pass(idle(1)), memo, NOW);
        expect(poolPassLine(pass(idle(2)), memo, at(1))).not.toBeNull();
        expect(poolPassLine(pass(idle(2)), memo, at(2))).toBeNull();
    });
    it('a failed pass always emits, flagged', () => {
        const memo = newPoolPassLogMemo();
        poolPassLine(pass(idle()), memo, NOW);
        expect(JSON.parse(poolPassLine(pass(idle()), memo, at(1), { failed: true })!)).toMatchObject({ event: 'pool-replenish', failed: true });
    });
    it('logs recovery: the first good pass after a failed one emits (same signature), then silence resumes', () => {
        const memo = newPoolPassLogMemo();
        poolPassLine(pass(idle()), memo, NOW);
        poolPassLine(pass(idle()), memo, at(1), { failed: true });
        const recovered = poolPassLine(pass(idle()), memo, at(2));
        expect(recovered).not.toBeNull();
        expect(JSON.parse(recovered!)).not.toHaveProperty('failed');
        expect(JSON.parse(recovered!)).not.toHaveProperty('heartbeat');
        expect(poolPassLine(pass(idle()), memo, at(3))).toBeNull();
    });
    it('class order is not a change: the signature is sorted (the planner reorders classes)', () => {
        const memo = newPoolPassLogMemo();
        const a = { c: CLASS_L, record: idle(1, 1) }, b = { c: CLASS_XL, record: idle(0, 0) };
        expect(poolPassLine([a, b], memo, NOW)).not.toBeNull();
        expect(poolPassLine([b, a], memo, at(1))).toBeNull();
    });
    it('the signature carries the region: swapping targets between two regions of one type is a change', () => {
        const memo = newPoolPassLogMemo();
        const mum: PoolClass = { ...CLASS_L, region: 'ap-south-1' }, use: PoolClass = { ...CLASS_L, region: 'us-east-1', zoneId: 'use1-az1' };
        expect(poolPassLine([{ c: mum, record: idle(1, 2) }, { c: use, record: idle(1, 1) }], memo, NOW)).not.toBeNull();
        expect(poolPassLine([{ c: mum, record: idle(1, 1) }, { c: use, record: idle(1, 2) }], memo, at(1))).not.toBeNull();
    });
});
it('a dispatch-phase failure after the lock commits is logged once as failed, then rethrown', async () => {
    const { deps, plan } = fixture(); plan.provision = 1;
    deps.store.outcome = vi.fn(async () => { throw new Error('outcome failure'); });
    await expect(runPoolReplenish(deps)).rejects.toThrow('outcome failure');
    expect(deps.starter.start).toHaveBeenCalledOnce();
    expect(deps.log).toHaveBeenCalledExactlyOnceWith([{ c: deps.classes[0], record: expect.objectContaining({ target: 4 }) }], true);
});
it('logs each pass exactly once, pairing every record with its own class', async () => {
    const { deps, demand } = fixture(); deps.classes.push({ ...CLASS_XL, zoneId: deps.classes[0]!.zoneId });
    deps.data.readPoolDemand = vi.fn(async (_db, c) => ({ ...demand, spares: c.instanceType === 'm6i.xlarge' ? 7 : 3 }));
    const records = await runPoolReplenish(deps);
    expect(deps.log).toHaveBeenCalledOnce();
    const [entries, failed] = vi.mocked(deps.log).mock.calls[0]!;
    expect(failed).toBe(false);
    expect(entries.map(e => e.record)).toEqual(records);
    for (const e of entries) expect(e.record.spares).toBe(e.c.instanceType === 'm6i.xlarge' ? 7 : 3);
});
