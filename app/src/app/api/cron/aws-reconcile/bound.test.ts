/**
 * The REAL runAwsBackgroundReconcile behind the route, with only its two SQL claim
 * helpers replaced: proves the minute pass is bounded by the existing per-pass limits,
 * and that an empty fleet makes no provider call and no placement write.
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fixtureDeployment } from '@/server/lib/compute/aws-intent.test-support';
import { FLEET_RECONCILE_LIMIT, RETIRE_RECONCILE_LIMIT } from '@/server/lib/compute/aws-receipts';
import { LIFECYCLE_DEPLOYMENTS_ENV } from '@/server/lib/compute/aws-intent';

const claims = vi.hoisted(() => ({ fleet: vi.fn(), retire: vi.fn() }));
const forbidden = vi.hoisted(() => {
    const no = (name: string) => vi.fn(() => { throw new Error(`unexpected ${name}`); });
    return { start: no('starter.start'), describe: no('executions.describe'), createTunnel: no('tunnels.createTunnel'),
        deleteTunnel: no('tunnels.deleteTunnel'), describeForEnrollment: no('describer'), ready: no('meter.ready'),
        stopped: no('meter.stopped'), heartbeat: no('meter.heartbeat'), execute: no('db.execute'), transaction: no('db.transaction') };
});
vi.mock('@/env', () => ({ env: { CRON_SECRET: 'cron' } }));
vi.mock('@/server/db', () => ({ db: { execute: forbidden.execute, transaction: forbidden.transaction } }));
vi.mock('@/server/api/routers/compute-dispatch', () => ({ defaultAwsCollaborators: () => ({
    starter: { start: forbidden.start }, executions: { describe: forbidden.describe },
    tunnels: { createTunnel: forbidden.createTunnel, deleteTunnel: forbidden.deleteTunnel },
    describer: { describeForEnrollment: forbidden.describeForEnrollment },
    meter: { ready: forbidden.ready, stopped: forbidden.stopped, heartbeat: forbidden.heartbeat } }) }));
vi.mock('@/server/lib/compute/aws-pool-runtime', () => ({ createPoolDeps: () => ({}) }));
vi.mock('@/server/lib/compute/placement', async (original) => ({
    ...(await original<typeof import('@/server/lib/compute/placement')>()),
    claimAwsPlacementsToReconcile: claims.fleet, claimAwsPlacementsPendingRetire: claims.retire,
}));

const D = fixtureDeployment('ap-south-1', ['t3a.medium', 'm6i.large']);
beforeEach(() => {
    vi.clearAllMocks();
    claims.fleet.mockResolvedValue([]); claims.retire.mockResolvedValue([]);
    vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', '1');
    vi.stubEnv('AWS_REGIONS', 'ap-south-1');
    vi.stubEnv('AWS_MAX_RUNNING', '10');
    vi.stubEnv('EZIL_AWS_MAX_RUNNING_AP_SOUTH_1', '2');
    vi.stubEnv(LIFECYCLE_DEPLOYMENTS_ENV, JSON.stringify({ 'ap-south-1': D }));
});
afterEach(() => { vi.unstubAllEnvs(); });

const run = async () => {
    const { GET } = await import('./route');
    return GET(new Request('https://app.test/api/cron/aws-reconcile', { headers: { authorization: 'Bearer cron' } }));
};

it('claims at most the existing per-pass limits, once each, and nothing more', async () => {
    const res = await run();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, deleted: { checked: 0, retiresStarted: 0, retired: 0, stuck: 0 },
        fleet: { checked: 0, stopsStarted: 0, limitStops: 0, hostRetires: 0 } });
    expect(FLEET_RECONCILE_LIMIT).toBe(20); expect(RETIRE_RECONCILE_LIMIT).toBe(20);
    expect(claims.retire.mock.calls.map(([, limit]) => limit)).toEqual([RETIRE_RECONCILE_LIMIT]);
    expect(claims.fleet.mock.calls.map(([, limit]) => limit)).toEqual([FLEET_RECONCILE_LIMIT]);
    // Empty fleet: no provider call and no placement write beyond the two claims.
    for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
});

it('kill switch: AWS off claims nothing and touches no collaborator', async () => {
    vi.stubEnv('EZIL_AWS_COMPUTERS_ENABLED', '0');
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: 'aws_disabled' });
    expect(claims.fleet).not.toHaveBeenCalled(); expect(claims.retire).not.toHaveBeenCalled();
    for (const fn of Object.values(forbidden)) expect(fn).not.toHaveBeenCalled();
});

it('an unreadable AWS deployment config claims nothing (the function\'s own guard)', async () => {
    vi.stubEnv(LIFECYCLE_DEPLOYMENTS_ENV, '{not json');
    const res = await run();
    expect(await res.json()).toEqual({ ok: true, skipped: 'aws_config_invalid' });
    expect(claims.fleet).not.toHaveBeenCalled(); expect(claims.retire).not.toHaveBeenCalled();
});
