import { afterEach, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { createPoolDispatchStore, poolJobAuthority, storedPoolWork } from './aws-pool-dispatch';
import { poolWork, runPoolReplenish, withPoolReplenishLock } from './aws-pool-replenish';
import { createPoolDeps } from './aws-pool-runtime';
import * as data from './ready-pool';
import { poolFixture, NOW } from './aws-pool-test-support';
import { lifecycleExecutionArn } from './aws-receipts';
import { AwsClientError } from './aws-errors';
import { withAdmission, type PlacementDb } from './placement';
import { handlePoolSessionReady } from './aws-pool-session';
import * as placement from './placement';
import { handlePoolClaim } from './aws-pool-claim';
import { buildLifecycleWork } from './aws-intent';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });
function harness() {
    vi.stubEnv('AWS_REGIONS', 'ap-south-1'); vi.stubEnv('EZIL_AWS_MAX_RUNNING_AP_SOUTH_1', '5'); vi.stubEnv('EZIL_AWS_KILL_SWITCH', '0');
    const f = poolFixture(); const c = { region: f.row.region, zoneId: f.row.zoneId, instanceType: 'm6i.large' as const };
    const row: Record<string, unknown> = { id: f.row.poolHostId, generation: 1, region: c.region, zone_id: c.zoneId,
        instance_type: c.instanceType, instance_id: null, state: 'booting', leased_computer_id: null,
        claim_generation: null, claim_lease_epoch: null, claim_fence: null, claim_volume_serial: null,
        lifecycle_job_id: null, dispatch_status: null };
    const trace: string[] = []; const state = { subscribers: 1, vcpu: 0, migrations: 0, insert: true, save: true };
    const db: PlacementDb = { execute: vi.fn(async query => {
        const q = new PgDialect().sqlToQuery(query); trace.push(q.sql); const p = q.params;
        if (/WITH\s+effective/.test(q.sql)) return [{ opens: 0, standard: state.subscribers, premium: 0, spares: 0, vcpu: state.vcpu,
            boot_minutes: null, idle_ready: [], booting: [] }];
        if (q.sql.includes('SELECT count(*) AS count')) return [{ count: state.migrations }];
        if (q.sql.includes('INSERT INTO public.ezil_compute_pool_hosts')) { row.id = p[0]; return state.insert ? [row] : []; }
        if (q.sql.includes('SELECT id FROM public.ezil_compute_pool_hosts')) {
            expect(q.sql).toContain("(lifecycle_job_id IS NULL OR dispatch_status = 'settled')");
            expect(q.sql).not.toContain('LIMIT');
            return row.state === p[3] && row.instance_id !== null && row.leased_computer_id === null
                && [row.claim_generation, row.claim_lease_epoch, row.claim_fence, row.claim_volume_serial].every(v => v === null)
                && (row.lifecycle_job_id === null || row.dispatch_status === 'settled') ? [{ id: row.id }] : [];
        }
        if (q.sql.includes('SELECT instance_id, lifecycle_job_id')) {
            return row.leased_computer_id === null
                && [row.claim_generation, row.claim_lease_epoch, row.claim_fence, row.claim_volume_serial].every(v => v === null) ? [row] : [];
        }
        if (/SET state = \$1, updated_at/.test(q.sql)) {
            if (row.id !== p[2] || !p.slice(3).includes(row.state)) return [];
            row.state = p[0]; return [row];
        }
        if (q.sql.includes("dispatch_status = 'pending'")) {
            if (row.lifecycle_job_id !== null && row.dispatch_status !== 'settled') return [];
            Object.assign(row, { lifecycle_job_id: p[0], lifecycle_digest: p[1], lifecycle_input: p[2], dispatch_status: 'pending' });
            return state.save ? [{ id: row.id }] : [];
        }
        if (q.sql.includes('SET dispatch_status =')) {
            if (row.lifecycle_job_id === p[4] && row.lifecycle_digest === p[5]) {
                row.dispatch_status = p[0];
                if (p[1] === 'refused') row.state = p[2] === 'pool-provision' ? 'retired' : 'failed';
            }
            return [];
        }
        if (q.sql.includes('SET instance_id =')) {
            expect(q.sql).toContain('AND lifecycle_job_id =');
            expect(q.sql).toContain('AND lifecycle_digest =');
            if (row.lifecycle_job_id === p[3] && row.lifecycle_digest === p[4]) {
                row.instance_id = p[0]; row.dispatch_status = 'settled';
                if (p[1] === 'pool-retire' && q.sql.includes("THEN 'retired'")) row.state = 'retired';
            }
            return [];
        }
        if (q.sql.includes('SELECT * FROM public.ezil_compute_pool_hosts')) {
            return !q.sql.includes('WHERE dispatch_status IN') || ['pending', 'unknown', 'started'].includes(String(row.dispatch_status)) ? [row] : [];
        }
        if (q.sql.includes('pg_try_advisory')) return [{ locked: true }];
        if (q.sql.includes('placement:lock-admission')) return [{ pg_advisory_xact_lock: '', isolation: 'read committed' }];
        return [];
    }), transaction: async fn => { trace.push('BEGIN'); const value = await fn(db); trace.push('COMMIT'); return value; } };
    const sdk = { starter: { start: vi.fn(async () => { trace.push('START'); }) }, executions: { describe: vi.fn() } };
    const env: Record<string,string|undefined> = { ...f.deps.env, EZIL_AWS_KILL_SWITCH: '0' };
    const store = createPoolDispatchStore(db, env, sdk);
    const prepare = () => db.transaction(tx => store.prepare(tx, c, 'pool-provision', h => poolWork(c, f.deployment, 'pool-provision', h)));
    const receipt = (w: Awaited<ReturnType<typeof prepare>>) => ({ schemaVersion: 1, jobId: w.intent.jobId, digest: w.digest,
        computerId: w.intent.computerId, generation: 1, leaseEpoch: 1, fenceToken: w.intent.fenceToken,
        instanceId: f.row.instanceId, poolHostId: row.id, poolGeneration: 1, volumeId: null, state: 'running' });
    const execution = (w: Awaited<ReturnType<typeof prepare>>) => ({ status: 'SUCCEEDED', input: w.input,
        output: JSON.stringify(receipt(w)), executionArn: lifecycleExecutionArn(f.deployment, w.intent.jobId), stateMachineVersionArn: w.stateMachineArn });
    return { f, c, db, row, state, trace, sdk, store, env, prepare, receipt, execution };
}
it('reserves booting generation and immutable job before dispatch, then retries the same job after a lost dispatch', async () => {
    const h = harness(); const w = await h.prepare();
    expect(h.row).toMatchObject({ state: 'booting', generation: 1, lifecycle_job_id: w.intent.jobId, lifecycle_digest: w.digest, lifecycle_input: w.input });
    expect(h.trace.findIndex(s => s.includes('INSERT INTO'))).toBeLessThan(h.trace.findIndex(s => s.includes("dispatch_status = 'pending'")));
    expect(h.trace.find(s => s.includes('INSERT INTO'))).toContain(", 1,");
    expect(h.trace.find(s => s.includes('INSERT INTO'))).toContain("'booting'");
    expect(h.sdk.starter.start).not.toHaveBeenCalled();
    h.sdk.executions.describe.mockRejectedValue(new AwsClientError('aws_config', false, 'ExecutionDoesNotExist'));
    await h.store.reconcile!(); await h.store.reconcile!();
    expect(h.sdk.starter.start).toHaveBeenCalledTimes(2);
    for (const [, request] of vi.mocked(h.sdk.starter.start).mock.calls as unknown as [string, unknown][]) expect(request).toEqual({ name: w.name, input: w.input, stateMachineArn: w.stateMachineArn });
    expect(h.trace.indexOf('COMMIT')).toBeLessThan(h.trace.indexOf('START'));
});
it.each(['kill', 'capacity', 'migration', 'migration-invalid', 'insert', 'save'] as const)('refuses dispatch guard %s before launch', async guard => {
    const h = harness();
    if (guard === 'kill') h.env.EZIL_AWS_KILL_SWITCH = '1';
    if (guard === 'capacity') h.state.vcpu = 10;
    if (guard === 'migration') h.state.migrations = 5;
    if (guard === 'migration-invalid') h.state.migrations = NaN;
    if (guard === 'insert') h.state.insert = false;
    if (guard === 'save') h.state.save = false;
    await expect(h.prepare()).rejects.toThrow(guard === 'insert' ? 'dispatch_reserved' : guard === 'save' ? 'dispatch_saved' : 'dispatch_capacity');
    expect(h.sdk.starter.start).not.toHaveBeenCalled();
});
it('rechecks eligible subscribers under admission lock before provisioning', async () => {
    const h=harness(); h.state.subscribers=0;
    await expect(h.prepare()).rejects.toThrow('dispatch_capacity');
    expect(h.trace.some(q=>q.includes('INSERT INTO public.ezil_compute_pool_hosts'))).toBe(false);
});
it('requires the reserved host and operation', async () => {
    const h = harness();
    await expect(h.store.prepare(h.db, h.c, 'pool-retire', () => { throw Error('builder reached'); }, { ...h.f.row, state: 'leased' })).rejects.toThrow('dispatch_host');
    await expect(h.store.prepare(h.db, h.c, 'pool-provision', host => ({ ...poolWork(h.c, h.f.deployment, 'pool-provision', host), intent: { ...poolWork(h.c, h.f.deployment, 'pool-provision', host).intent, operation: 'release' } }))).rejects.toThrow('dispatch_operation');
});
it.each(['lifecycle_job_id', 'lifecycle_digest', 'id', 'generation', 'region', 'zone_id', 'instance_type'])('rejects durable work tampering: %s', async key => {
    const h = harness(); await h.prepare(); h.row[key] = 'wrong';
    expect(() => storedPoolWork(h.row)).toThrow('dispatch_work_binding');
});
it.each(['jobId', 'digest', 'computerId', 'leaseEpoch', 'poolGeneration', 'operation', 'state', 'leased_computer_id', 'kill'])('authority refuses mismatched %s', async key => {
    const h = harness(); const w = await h.prepare();
    const a = { computerId: w.intent.computerId, jobId: w.intent.jobId, digest: w.digest, leaseEpoch: 1,
        poolHostId: String(h.row.id), poolGeneration: 1, operation: 'pool-provision' };
    expect(await poolJobAuthority(h.db, a, h.env)).toBe(true);
    if (key === 'kill') h.env.EZIL_AWS_KILL_SWITCH = '1';
    else if (key === 'operation') { a.operation = 'pool-retire'; h.row.state = 'retiring'; }
    else if (key === 'state' || key === 'leased_computer_id') h.row[key] = 'leased';
    else Object.assign(a, { [key]: typeof a[key as keyof typeof a] === 'number' ? 2 : 'wrong' });
    expect(await poolJobAuthority(h.db, a, h.env)).toBe(false);
});
it.each(['executionArn', 'input', 'stateMachineVersionArn', 'stateMachineAliasArn'])('reconciliation refuses execution %s', async field => {
    const h = harness(); const w = await h.prepare(); h.sdk.executions.describe.mockResolvedValue({ ...h.execution(w), [field]: 'wrong' });
    await expect(h.store.reconcile!()).rejects.toThrow('dispatch_execution'); expect(h.sdk.starter.start).not.toHaveBeenCalled();
});
it.each(['schemaVersion', 'jobId', 'digest', 'computerId', 'generation', 'leaseEpoch', 'fenceToken', 'poolHostId', 'poolGeneration', 'volumeId', 'instanceId', 'state'])('reconciliation refuses receipt %s', async field => {
    const h = harness(); const w = await h.prepare();
    h.sdk.executions.describe.mockResolvedValue({ ...h.execution(w), output: JSON.stringify({ ...h.receipt(w), [field]: 'wrong' }) });
    await expect(h.store.reconcile!()).rejects.toThrow('dispatch_receipt');
});
it('settles observed success without another launch', async () => {
    const h = harness(); const w = await h.prepare(); h.sdk.executions.describe.mockResolvedValue(h.execution(w));
    await h.store.reconcile!(); expect(h.sdk.starter.start).not.toHaveBeenCalled();
    expect(h.trace.at(-1)).toContain("dispatch_status = 'settled'");
});
it('production pool dependencies are the P8 implementations and shared intent builder', () => {
    const h = harness(); const deps = createPoolDeps(h.db, {});
    expect(deps.leasePoolHost).toBe(data.leasePoolHost); expect(deps.publishPoolClaim).toBe(data.publishPoolClaim);
    expect(deps.buildWork).toBe(buildLifecycleWork);
});
it('the replenish transaction includes demand and reservations and commits before launch', async () => {
    const h = harness(); const demand = vi.fn(async (tx: unknown) => { expect(tx).toBe(h.db); return { opens15m: 0, activeStandard: 1, activePremium: 0,
        bootMinutes: null, spares: 0, vcpuInUse: 0, regionVcpuCap: 10, killSwitch: false, idleReady: [], booting: [] }; });
    await runPoolReplenish({ db: h.db, data: { ...data, readPoolDemand: demand }, store: { ...h.store, reconcile: undefined },
        classes: [h.c], deployments: { [h.c.region]: h.f.deployment }, now: () => NOW,
        withLock: run => withPoolReplenishLock(h.db, run), starter: h.sdk.starter, log: vi.fn() });
    expect(h.trace.indexOf('COMMIT')).toBeLessThan(h.trace.indexOf('START'));
    expect(h.trace.filter(s => s === 'BEGIN')).toHaveLength(1);
});
it('first-volume claim explicitly grants initialization with the reserved filesystem UUID', async () => {
    const f = poolFixture(true); const w = buildLifecycleWork({ ...f.work.intent, dataVolumeId: null, dataVolumeGiB: 20 });
    f.p.lifecycleDigest = w.digest;
    Object.assign(f.execution, { input: w.input, output: JSON.stringify({ ...f.receipt, digest: w.digest }) });
    const res = await handlePoolClaim(f.request('claim'), f.deps);
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({ createVolume: true, fsUuid: f.p.fsUuid, enrollNonce: expect.any(String) });
});
function session() {
    const f = poolFixture(true); f.p.lastError = placement.POOL_SESSION_PENDING; f.p.enrollConsumedHash = 'a'.repeat(64);
    const timestamp = vi.spyOn(data, 'recordPoolSessionReady').mockResolvedValue(true);
    const finish = vi.spyOn(placement, 'finishEnrollment').mockResolvedValue({ ok: true, placement: f.p });
    const request = () => new Request(f.request('claim'), { method: 'POST', body: JSON.stringify({ sessionReady: true }) });
    return { ...f, finish, timestamp, request };
}
it('records pool enrollment completion only at session-ready and leaves replay timestamp intact', async () => {
    const f = session(); expect((await handlePoolSessionReady(f.request(), f.deps)).status).toBe(200);
    expect(f.finish).toHaveBeenCalledWith(expect.anything(), { computerId: f.p.computerId, expected: f.p, success: true, poolClaim: true, sessionReady: true });
    f.p.lastError = placement.ENROLLMENT_SUCCEEDED;
    expect((await handlePoolSessionReady(f.request(), f.deps)).status).toBe(200); expect(f.finish).toHaveBeenCalledOnce();
});
it.each(['health', 'claim', 'binding', 'tags', 'pending', 'finished', 'timestamp'])('session readiness refuses %s', async guard => {
    const f = session(); let req = f.request();
    if (guard === 'health') req = new Request(req, { body: JSON.stringify({ sessionReady: false }) });
    if (guard === 'claim') vi.mocked(f.deps.data.readPoolClaim).mockResolvedValue(null);
    if (guard === 'binding') f.p.leaseEpoch++;
    if (guard === 'tags') f.view.tags['ezil:fence'] = 'wrong';
    if (guard === 'pending') f.p.lastError = placement.ENROLLMENT_PENDING;
    if (guard === 'timestamp') f.timestamp.mockResolvedValue(false);
    if (guard === 'finished') f.finish.mockResolvedValue({ ok: false, reason: 'cas_conflict' });
    expect((await handlePoolSessionReady(req, f.deps)).status).toBe(['finished', 'timestamp'].includes(guard) ? 503 : 403);
    if (!['finished', 'timestamp'].includes(guard)) expect(f.finish).not.toHaveBeenCalled();
});

it('pool retirement cannot discard an unknown launch or a consumed host', async () => {
    const h = harness();
    for (const record of [[], [{ instance_id: null, dispatch_status: 'settled' }],
        ...['pending', 'unknown', 'started', null].map(dispatch_status => [{ instance_id: h.f.row.instanceId, lifecycle_job_id: h.row.id, dispatch_status }])]) {
        vi.mocked(h.db.execute).mockResolvedValueOnce(record);
        expect(await h.store.canRetire!(h.db, String(h.row.id))).toBe(false);
    }
    vi.mocked(h.db.execute).mockResolvedValueOnce([{ instance_id: h.f.row.instanceId, dispatch_status: 'settled' }]);
    expect(await h.store.canRetire!(h.db, String(h.row.id))).toBe(true);
    vi.mocked(h.db.execute).mockResolvedValueOnce([{ instance_id: h.f.row.instanceId, lifecycle_job_id: null, dispatch_status: null }]);
    expect(await h.store.canRetire!(h.db, String(h.row.id))).toBe(true);
});
it.each(['failed', 'retiring'] as const)('the %s sweep includes hosts without a job or settled jobs and no published claim', async state => {
    const h = harness();
    await h.store.retirementCandidates!(h.db, h.c, state);
    const query = h.trace.at(-1)!;
    expect(query).toContain('state = $4');
    expect(query).toContain('leased_computer_id IS NULL');
    expect(query).toContain("dispatch_status = 'settled'");
    expect(query).toContain('lifecycle_job_id IS NULL');
    for (const column of ['claim_generation', 'claim_lease_epoch', 'claim_fence', 'claim_volume_serial'])
        expect(query).toContain(`${column} IS NULL`);
});

function retiringHarness() {
    const h = harness();
    Object.assign(h.row, { state: 'retiring', instance_id: h.f.row.instanceId });
    const pass = () => runPoolReplenish({ db: h.db, data: { ...data, readPoolDemand: async () => ({
        opens15m: 0, activeStandard: 0, activePremium: 0, bootMinutes: null, spares: 1,
        vcpuInUse: 2, regionVcpuCap: 10, killSwitch: false, idleReady: [], booting: [],
    }) }, store: h.store, classes: [h.c], deployments: { [h.c.region]: h.f.deployment }, now: () => NOW,
    withLock: run => withPoolReplenishLock(h.db, run), starter: h.sdk.starter, log: vi.fn(), sleep: async () => {} });
    const work = () => storedPoolWork(h.row);
    const running = () => ({ ...h.execution(work()), status: 'RUNNING' });
    return { ...h, pass, work, running };
}
it.each(['no job', 'settled provision'])('dispatches exactly once for a stranded retiring row with %s using the real state CAS', async prior => {
    const h = retiringHarness();
    if (prior === 'settled provision') Object.assign(h.row, { lifecycle_job_id: h.f.work.intent.jobId, dispatch_status: 'settled' });
    const record = (await h.pass())![0];
    expect(h.sdk.starter.start).toHaveBeenCalledOnce();
    expect(record.retired).toBe(1);
    const w = h.work();
    expect(w.intent.operation).toBe('pool-retire');
    expect(w.intent.providerInstanceId).toBe(h.f.row.instanceId);
    expect(record).toMatchObject({ retired: 1, retirements: [{ poolHostId: h.row.id, jobId: w.intent.jobId, outcome: 'started' }] });
    expect(h.row.dispatch_status).toBe('started');
    const lock = h.trace.findIndex(s => s.includes('pg_try_advisory_xact_lock'));
    const saved = h.trace.findIndex(s => s.includes("dispatch_status = 'pending'"));
    expect(lock).toBeLessThan(saved);
    expect(saved).toBeLessThan(h.trace.indexOf('COMMIT'));
    expect(h.trace.indexOf('COMMIT')).toBeLessThan(h.trace.indexOf('START'));
    h.sdk.executions.describe.mockResolvedValue(h.running());
    await h.pass();
    expect(h.sdk.starter.start).toHaveBeenCalledOnce();
    expect(h.work().intent.jobId).toBe(w.intent.jobId);
});
it.each(['pending', 'unknown', 'started'])('does not dispatch a retiring row with a live %s job', async dispatch_status => {
    const h = retiringHarness(); await h.pass();
    h.sdk.starter.start.mockClear(); h.row.dispatch_status = dispatch_status;
    h.sdk.executions.describe.mockResolvedValue(h.running());
    const w = h.work();
    expect((await h.pass())![0].retirements).toEqual([]);
    expect(h.sdk.starter.start).not.toHaveBeenCalled();
    expect(h.work().intent.jobId).toBe(w.intent.jobId);
});
it('settles the pool-retire receipt to retired without another launch', async () => {
    const h = retiringHarness(); await h.pass(); const w = h.work();
    h.sdk.executions.describe.mockResolvedValue({ ...h.execution(w), output: JSON.stringify({ ...h.receipt(w), state: 'retired' }) });
    await h.pass(); await h.pass();
    expect(h.row).toMatchObject({ state: 'retired', dispatch_status: 'settled', lifecycle_job_id: w.intent.jobId });
    expect(h.sdk.starter.start).toHaveBeenCalledOnce();
    expect(h.sdk.executions.describe).toHaveBeenCalledOnce();
});
it('cannot settle a retirement receipt over a different current job', async () => {
    const h = retiringHarness(); await h.pass(); const w = h.work();
    h.sdk.executions.describe.mockImplementation(async () => {
        h.row.lifecycle_job_id = h.f.work.intent.jobId;
        return { ...h.execution(w), output: JSON.stringify({ ...h.receipt(w), state: 'retired' }) };
    });
    await h.store.reconcile!();
    expect(h.row).toMatchObject({ state: 'retiring', dispatch_status: 'started', lifecycle_job_id: h.f.work.intent.jobId });
    expect(h.sdk.starter.start).toHaveBeenCalledOnce();
});
it.each(['jobId', 'instanceId', 'state'])('refuses a mismatched pool-retire receipt %s', async field => {
    const h = retiringHarness(); await h.pass(); const w = h.work();
    const changed = { jobId: h.f.work.intent.jobId, instanceId: 'i-22222222222222222', state: 'running' };
    h.sdk.executions.describe.mockResolvedValue({ ...h.execution(w), output: JSON.stringify({
        ...h.receipt(w), state: 'retired', [field]: changed[field as keyof typeof changed],
    }) });
    await expect(h.pass()).rejects.toThrow('dispatch_receipt');
    expect(h.row).toMatchObject({ state: 'retiring', dispatch_status: 'started', lifecycle_job_id: w.intent.jobId });
    expect(h.sdk.starter.start).toHaveBeenCalledOnce();
});
it('reconciles a lost retirement response by its saved job ID without relaunching', async () => {
    const h = retiringHarness();
    h.sdk.starter.start.mockRejectedValue(new Error('lost response'));
    expect((await h.pass())![0].retirements[0].outcome).toBe('unknown');
    expect(h.row.dispatch_status).toBe('unknown');
    const w = h.work();
    for (const [, request] of h.sdk.starter.start.mock.calls as unknown as [string, { name: string; input: string }][]) {
        expect(request).toMatchObject({ name: w.name, input: w.input });
    }
    h.sdk.starter.start.mockClear();
    h.sdk.executions.describe.mockResolvedValue({ ...h.execution(w), output: JSON.stringify({ ...h.receipt(w), state: 'retired' }) });
    await h.pass();
    expect(h.sdk.executions.describe).toHaveBeenCalledWith(h.c.region, lifecycleExecutionArn(h.f.deployment, w.intent.jobId));
    expect(h.sdk.starter.start).not.toHaveBeenCalled();
    expect(h.row.state).toBe('retired');
    expect(h.row.lifecycle_job_id).toBe(w.intent.jobId);
});
it('replays a missing retirement execution with the exact saved job and input', async () => {
    const h = retiringHarness(); await h.pass(); const w = h.work();
    h.sdk.starter.start.mockClear(); h.row.dispatch_status = 'pending';
    h.sdk.executions.describe.mockRejectedValue(new AwsClientError('aws_config', false, 'ExecutionDoesNotExist'));
    await h.pass();
    expect(h.sdk.starter.start).toHaveBeenCalledExactlyOnceWith(h.c.region, { name: w.name, input: w.input, stateMachineArn: w.stateMachineArn });
    expect(h.row.lifecycle_job_id).toBe(w.intent.jobId);
});
it('release and nonce SQL preserve instance, epoch and single-use guards', async () => {
    const h = harness();
    await data.retirePoolLease(h.db, h.f.p);
    expect(h.trace.at(-1)).toMatch(/state = 'leased'.*instance_id[\s\S]*leased_computer_id[\s\S]*claim_generation[\s\S]*claim_lease_epoch/);
    await placement.savePoolEnrollmentNonce(h.db, h.f.p, { nonceHash: 'a'.repeat(64), expiresAt: NOW });
    expect(h.trace.at(-1)).toMatch(/generation =[\s\S]*lease_epoch =[\s\S]*instance_id =[\s\S]*enroll_consumed_hash IS NULL AND enroll_nonce_hash IS NULL/);
});

it('production post-lease replenishment invokes the configured planner', async () => {
    const h = harness();
    await expect(createPoolDeps(h.db, {}).replenish(h.c, NOW)).rejects.toThrow('cron_enabled');
});

it.each(['spares', 'migrations', 'kill', 'invalid'])('post-bind admission refuses %s without allocating another host', async guard => {
    const h = harness(); const deps = createPoolDeps(h.db, h.env);
    if (guard === 'spares') h.state.vcpu = 12;
    if (guard === 'migrations') { h.state.vcpu = 10; h.state.migrations = 1; }
    if (guard === 'kill') h.env.EZIL_AWS_KILL_SWITCH = '1';
    if (guard === 'invalid') h.state.migrations = NaN;
    await expect(withAdmission(h.db, (tx, lock) => deps.validateCapacity!(tx, h.f.p, lock))).rejects.toThrow('open_pool_capacity');
    expect(h.sdk.starter.start).not.toHaveBeenCalled();
});
it('post-bind admission accepts the exact regional cap', async () => {
    const h = harness(); h.state.vcpu = 10;
    await expect(withAdmission(h.db, (tx, lock) => createPoolDeps(h.db, h.env).validateCapacity!(tx, h.f.p, lock))).resolves.toBeUndefined();
});

it('session-ready time is immutable and read only for its bound epoch', async () => {
    const h = harness();
    vi.mocked(h.db.execute).mockResolvedValueOnce([{ id: h.row.id }]);
    expect(await data.recordPoolSessionReady(h.db, String(h.row.id), h.f.p, NOW)).toBe(true);
    expect(h.db.execute).toHaveBeenCalled();
    const query = new PgDialect().sqlToQuery(vi.mocked(h.db.execute).mock.calls.at(-1)![0]);
    expect(query.sql).toMatch(/claim_generation =[\s\S]*claim_lease_epoch =[\s\S]*session_ready_at IS NULL RETURNING id/);
    vi.mocked(h.db.execute).mockResolvedValueOnce([{ session_ready_at: NOW }]);
    expect(await data.readPoolSessionReadyAt(h.db, String(h.row.id), h.f.p)).toEqual(NOW);
    for (const rows of [[], [{ session_ready_at: null }], [{ session_ready_at: 'invalid' }], [{ session_ready_at: NOW }, { session_ready_at: NOW }]]) {
        vi.mocked(h.db.execute).mockResolvedValueOnce(rows);
        expect(await data.readPoolSessionReadyAt(h.db, String(h.row.id), h.f.p)).toBeNull();
    }
});

it.each(['cancelled','deployment','unknown'])('absent provision replay rechecks %s and preserves the reservation', async fault => {
    const h=harness(), w=await h.prepare();
    h.sdk.executions.describe.mockRejectedValue(new AwsClientError('aws_config',false,'ExecutionDoesNotExist'));
    if(fault==='cancelled')h.state.subscribers=0;
    if(fault==='deployment')h.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS=JSON.stringify({[h.c.region]:{...h.f.deployment,amiId:'ami-99999999999999999'}});
    if(fault==='unknown')h.db.execute=vi.fn(async()=>{throw new Error('unavailable');});
    // Unknown initial inventory may reject the pass; it must never launch or free its reservation.
    await h.store.reconcile!().catch(()=>{});
    expect(h.sdk.starter.start).not.toHaveBeenCalled();
    expect(h.row).toMatchObject({state:'booting',dispatch_status:'pending',lifecycle_input:w.input,lifecycle_digest:w.digest});
    if(fault==='cancelled')expect(h.trace.filter(q=>/WITH\s+effective/.test(q)).length).toBeGreaterThan(1);
});
it.each(['cancelled','deployment','unknown'])('provision authority rechecks %s rather than trusting a stored reservation', async fault=>{
    const h=harness(),w=await h.prepare(),i=w.intent;
    if(fault==='cancelled')h.state.subscribers=0;
    if(fault==='deployment')h.env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS='{}';
    if(fault==='unknown') {const execute=h.db.execute; h.db.execute=vi.fn(q=>new PgDialect().sqlToQuery(q).sql.match(/WITH\s+effective/)?Promise.reject(new Error('unavailable')):execute(q));}
    expect(await poolJobAuthority(h.db,{computerId:i.computerId,jobId:i.jobId,digest:w.digest,leaseEpoch:i.leaseEpoch,
        poolHostId:i.poolHostId!,poolGeneration:i.poolGeneration!,operation:i.operation},h.env)).toBe(false);
});
