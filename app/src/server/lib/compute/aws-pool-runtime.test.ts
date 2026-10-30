import { expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ sdk: vi.fn() }));
vi.mock('./aws-clients', () => ({ sharedAwsSdkCollaborators: mocks.sdk }));
import { createPoolReplenishDeps, createPoolHostDeps } from './aws-pool-runtime';
import { poolFixture } from './aws-pool-test-support';
import { runPoolReplenish, type PoolDispatchStore } from './aws-pool-replenish';
import { issueEnrollmentNonce } from './aws-enroll';
import type { Env } from './aws-config';
import { readPoolProof } from './aws-pool-host';
import { PollDeadline, PollStoppedError } from './poll-wait';
const store: PoolDispatchStore = { prepare: vi.fn(), outcome: vi.fn() };
it.each(['disabled', 'starter', 'deployments', 'regions'])('fails closed before cron dispatch when missing %s', missing => {
    const f = poolFixture(); const env: Env = { ...f.deps.env, AWS_REGIONS: 'ap-south-1' };
    mocks.sdk.mockReturnValue({ starter: { start: vi.fn() } });
    if (missing === 'disabled') env.EZIL_AWS_COMPUTERS_ENABLED = '0';
    if (missing === 'starter') mocks.sdk.mockReturnValue({});
    if (missing === 'deployments') env.EZIL_AWS_LIFECYCLE_DEPLOYMENTS = '{}';
    if (missing === 'regions') env.AWS_REGIONS = '';
    expect(() => createPoolReplenishDeps(f.deps.db, env, store)).toThrow();
});
it('maps configured regions to their pinned zone and the P1 host class', () => {
    const f = poolFixture(); mocks.sdk.mockReturnValue({ starter: { start: vi.fn() } });
    const deps = createPoolReplenishDeps(f.deps.db, { ...f.deps.env, AWS_REGIONS: 'ap-south-1' }, store);
    expect(deps.classes.map(c => c.instanceType)).toEqual(deps.deployments['ap-south-1'].instanceTypes.filter(t => ['m6i.large','m6i.xlarge','m6i.2xlarge'].includes(t)));
    expect(deps.classes.every(c => c.deployment === deps.deployments[c.region])).toBe(true);
});
it.each([[], [{ computer_id: 'one' }], [{ computer_id: 'one' }, { computer_id: 'two' }]].map(rows => [rows]))('nonce issuance requires exactly one updated row %s', async rows => {
    const f = poolFixture(); mocks.sdk.mockReturnValue({});
    const deps = createPoolHostDeps(f.deps.db, f.deps.env);
    expect(await deps.saveNonce({ execute: vi.fn(async () => rows) }, f.p, issueEnrollmentNonce(f.deps.now()))).toBe(rows.length === 1);
});

it('replenishes production prd spares with the prd deployment and state machine', async () => {
    const f = poolFixture(); const start = vi.fn(async () => {}); mocks.sdk.mockReturnValue({ starter: { start } });
    const prd = { ...f.deployment, namespace: 'prd', instanceTypes: ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge'],
        stateMachineVersionArn: f.deployment.stateMachineVersionArn.replace('ezil-pilot-', 'ezil-prd-') };
    const prepare = vi.fn<PoolDispatchStore['prepare']>(async (_tx, c, _op, build) => build({ ...f.row, ...c, instanceId: null }));
    const deps = createPoolReplenishDeps(f.deps.db, { ...f.deps.env, AWS_REGIONS: 'ap-south-1',
        EZIL_AWS_LIFECYCLE_DEPLOYMENTS: JSON.stringify({ 'ap-south-1': prd }) }, { prepare, outcome: vi.fn(async () => {}) });
    expect(deps.classes.map(c => [c.instanceType, c.deployment?.namespace])).toEqual([
        ['m6i.large', 'prd'], ['m6i.xlarge', 'prd'], ['m6i.2xlarge', 'prd']]);
    const demand = { opens15m: 0, activeStandard: 1, activePremium: 0, bootMinutes: null, spares: 0, vcpuInUse: 0,
        regionVcpuCap: 20, killSwitch: false, idleReady: [], booting: [] };
    deps.data = { ...deps.data, readPoolDemand: vi.fn(async () => demand), readPoolReadinessDiagnostics: vi.fn(async () => []) };
    deps.withLock = async run => run();
    await runPoolReplenish(deps);
    expect(start).toHaveBeenCalled();
    for (const [region, work] of start.mock.calls as unknown as [string, { input: string; stateMachineArn: string }][]) {
        const intent = JSON.parse(JSON.parse(work.input).document);
        expect(region).toBe('ap-south-1');
        expect(intent).toMatchObject({ operation: 'pool-provision', deployment: { namespace: 'prd' } });
        expect(work.stateMachineArn).toBe(prd.stateMachineVersionArn);
    }
});

it('constructs the durable production store without a bridge', () => {
    const f = poolFixture(); mocks.sdk.mockReturnValue({ starter: { start: vi.fn() } });
    const deps = createPoolReplenishDeps(f.deps.db, { ...f.deps.env, AWS_REGIONS: 'ap-south-1' });
    expect(deps.store.prepare).toBeTypeOf('function');
    expect(deps.store.reconcile).toBeTypeOf('function');
});

it('production host deps forward cancellation to the observer before its first database read', async () => {
    const f = poolFixture(true); mocks.sdk.mockReturnValue({ describer: f.deps.describer, executions: f.deps.executions });
    const deps = createPoolHostDeps(f.deps.db, f.deps.env);
    const controller = new AbortController(); controller.abort();
    await expect(deps.observeAdopt!(readPoolProof(f.request('claim')), f, new PollDeadline(5_000, controller.signal)))
        .rejects.toBeInstanceOf(PollStoppedError);
    expect(f.deps.db.execute).not.toHaveBeenCalled();
    expect(f.deps.db.transaction).not.toHaveBeenCalled();
});
