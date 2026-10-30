import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { PoolReplenishDeps } from '@/server/lib/compute/aws-pool-replenish';
const mocks = vi.hoisted(() => ({ runtime: vi.fn() }));
vi.mock('@/server/db', () => ({ db: {} }));
vi.mock('@/server/lib/compute/aws-pool-runtime', () => ({ createPoolReplenishDeps: mocks.runtime }));
import { GET, maxDuration } from './route';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it.each([undefined, '', 'wrong'])('rejects an absent/mismatched CRON_SECRET %s before accessing dependencies', async secret => {
    vi.stubEnv('CRON_SECRET', secret);
    expect((await GET(new Request('https://test', { headers: { authorization: 'Bearer correct' } }))).status).toBe(404);
    expect(mocks.runtime).not.toHaveBeenCalled();
});
it('the real authenticated GET drives demand, planner, lock and lifecycle dispatch', async () => {
    vi.stubEnv('CRON_SECRET', 'correct');
    const { poolFixture, demandFixture } = await import('@/server/lib/compute/aws-pool-test-support');
    const f = poolFixture();
    f.deps.data.readPoolDemand = vi.fn(async () => demandFixture());
    f.deps.data.planPool = vi.fn(() => ({ target: 1, provision: 1, retire: [], fail: [] }));
    const deps: PoolReplenishDeps = { db: f.deps.db, data: f.deps.data, classes: [{ region: f.row.region, zoneId: f.row.zoneId, instanceType: 'm6i.large' }],
        deployments: { [f.row.region]: f.deployment }, now: () => new Date(), withLock: vi.fn(async fn => fn()), log: vi.fn(),
        starter: { start: vi.fn(async () => {}) }, store: {
            prepare: vi.fn(async (_tx, _c, _op, build) => build({ ...f.row, instanceId: null })), outcome: vi.fn(async () => {}) } };
    mocks.runtime.mockReturnValue(deps);
    const response = await GET(new Request('https://test', { headers: { authorization: 'Bearer correct' } }));
    expect(response.status).toBe(200); expect(deps.starter.start).toHaveBeenCalledOnce();
    expect(deps.withLock).toHaveBeenCalledOnce(); expect(deps.log).toHaveBeenCalledOnce();
});
it('returns a retryable failure while durable pool dispatch integration is unavailable', async () => {
    vi.stubEnv('CRON_SECRET', 'correct'); mocks.runtime.mockImplementation(() => { throw new Error('unwired'); });
    const res = await GET(new Request('https://test', { headers: { authorization: 'Bearer correct' } }));
    expect(res.status).toBe(503); expect(await res.json()).toMatchObject({ retryable: true });
});
it('staging installer enables the service and its minute timer targets the real route', () => {
    const root = path.resolve(__dirname, '../../../../../..');
    const unit = 'ezil-os-staging-pool-replenish';
    const read = (p: string) => readFileSync(path.join(root, p), 'utf8');
    const timer = read(`deploy/aws/os-staging/cron/${unit}.timer`);
    expect(timer).toContain('OnCalendar=*-*-* *:*:00 UTC'); expect(timer).toContain(`Unit=${unit}.service`);
    const service = read(`deploy/aws/os-staging/cron/${unit}.service`);
    expect(service).toContain('Authorization: Bearer ${CRON_SECRET}');
    expect(service).toContain('https://os-staging.ezil.work/api/cron/pool-replenish');
    expect(service).toContain('EnvironmentFile=/etc/ezil-os-staging/cron.env');
    expect(read('deploy/aws/os-staging/install-host.sh')).toMatch(/jobs=\([^)]*\bpool-replenish\b[^)]*\)/);
    expect(maxDuration).toBe(50);
});
