import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { paidCloudflareCandidates, reconcilePaidCloudflareUsers, reconcilePaidMigrations } from './provider-migrate-reconcile';

const fake = vi.hoisted(() => ({ execute: vi.fn(), entitlement: vi.fn(), create: vi.fn(), advance: vi.fn(), admission: vi.fn() }));
vi.mock('./provider-migrate-runtime', () => ({ createMigrationRuntime: () => ({ store: { createOrGetActive: fake.create } }) }));
vi.mock('./provider-migrate-orchestrator', () => ({ advanceMigration: fake.advance }));
vi.mock('@/server/billing/v2/compute-access', () => ({ billingV2EntitlementReader: () => ({ read: fake.entitlement }) }));
vi.mock('./placement', async original => ({ ...await original<typeof import('./placement')>(),
    withAdmission: (_db: unknown, run: (tx: unknown, lock: unknown) => unknown) => run({}, {}), readAdmissionCounters: async () => ({}) }));
vi.mock('./admission', () => ({ decideAdmission: fake.admission }));
vi.mock('@/server/db', () => ({ db: { execute: fake.execute } }));
afterEach(() => { vi.restoreAllMocks(); for (const mock of Object.values(fake)) mock.mockReset(); });
const candidate = { userId: 'u', computerId: 'c', toSize: 'standard' as const };
const setup = () => ({ enabled: true, startedAt: 0, now: vi.fn(() => 0),
    candidates: vi.fn(async () => [candidate]), admitted: vi.fn(async () => true),
    create: vi.fn(async () => ({ id: 'migration' })), advance: vi.fn(async () => {}) });

describe('paid Cloudflare reconciliation', () => {
    it('uses the existing idempotent creation and advances only admitted candidates', async () => {
        const f = setup();
        expect(await reconcilePaidMigrations(f)).toBe(1);
        expect(f.candidates).toHaveBeenCalledExactlyOnceWith(10);
        expect(f.create).toHaveBeenCalledExactlyOnceWith(candidate);
        expect(f.advance).toHaveBeenCalledExactlyOnceWith('migration');
        f.admitted.mockResolvedValue(false); f.create.mockClear(); f.advance.mockClear();
        expect(await reconcilePaidMigrations(f)).toBe(0);
        expect(f.create).not.toHaveBeenCalled(); expect(f.advance).not.toHaveBeenCalled();
    });
    it('bounds the number of launches even if a reader returns too many', async () => {
        const f = setup(); f.candidates.mockResolvedValue(Array.from({ length: 20 }, () => candidate));
        expect(await reconcilePaidMigrations(f)).toBe(10);
        expect(f.create).toHaveBeenCalledTimes(10); expect(f.advance).toHaveBeenCalledTimes(10);
    });
    it('does not query or create when AWS is disabled and logs once', async () => {
        const f = setup(); const log = vi.spyOn(console, 'info').mockImplementation(() => {});
        expect(await reconcilePaidMigrations({ ...f, enabled: false })).toBe(0);
        expect(f.candidates).not.toHaveBeenCalled(); expect(f.create).not.toHaveBeenCalled(); expect(log.mock.calls.length).toBeLessThanOrEqual(1);
    });
    it.each(['before-query', 'after-query', 'after-admission', 'after-create', 'after-advance'])('enforces the shared 40s budget %s', async point => {
        const f = setup(); let clock = point === 'before-query' ? 40000 : 39999;
        f.now.mockImplementation(() => clock);
        f.candidates.mockImplementation(async () => { if (point === 'after-query') clock = 40000; return [candidate, candidate]; });
        f.admitted.mockImplementation(async () => { if (point === 'after-admission') clock = 40000; return true; });
        f.create.mockImplementation(async () => { if (point === 'after-create') clock = 40000; return { id: 'migration' }; });
        f.advance.mockImplementation(async () => { clock = 40000; });
        expect(await reconcilePaidMigrations(f)).toBe(point === 'after-advance' ? 1 : 0);
        expect(f.candidates).toHaveBeenCalledTimes(point === 'before-query' ? 0 : 1);
        expect(f.create).toHaveBeenCalledTimes(['after-create', 'after-advance'].includes(point) ? 1 : 0);
        expect(f.advance).toHaveBeenCalledTimes(point === 'after-advance' ? 1 : 0);
    });
    it('defers a failed candidate and continues to the next owner', async () => {
        const f = setup(); f.candidates.mockResolvedValue([candidate, candidate]); f.create.mockRejectedValueOnce(new Error('race'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        expect(await reconcilePaidMigrations(f)).toBe(1); expect(f.create).toHaveBeenCalledTimes(2);
    });
    const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100',
        EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
        AWS_REGIONS: 'ap-south-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2' };
    it.each([null, { status: 'past_due' }, { paymentIssue: true }, { provider: 'cloudflare' },
        { planId: 'standard_monthly_v2' }, { size: 'free-cf' }, { size: undefined }])(
        'rechecks entitlement %j before creating or fencing', async patch => {
            fake.execute.mockResolvedValue([{ user_id: 'u', computer_id: 'c', sku: 'standard_monthly_v3' }]);
            fake.entitlement.mockResolvedValue(patch === null ? null : { status: 'active', paymentIssue: false,
                provider: 'aws', planId: 'standard_monthly_v3', size: 'std-2', ...patch });
            fake.admission.mockReturnValue({ admit: true }); fake.create.mockResolvedValue({ id: 'm' });
            await reconcilePaidCloudflareUsers(Date.now(), env);
            expect(fake.create).not.toHaveBeenCalled(); expect(fake.advance).not.toHaveBeenCalled();
        });
    it.each([false, true])('production wiring respects admission %s and advances the existing runtime', async admit => {
        fake.execute.mockResolvedValue([{ user_id: 'u', computer_id: 'c', sku: 'premium_monthly_v3' }]);
        fake.entitlement.mockResolvedValue({ status: 'active', provider: 'aws', planId: 'premium_monthly_v3', size: 'cmp-8' });
        fake.admission.mockReturnValue({ admit }); fake.create.mockResolvedValue({ id: 'm' });
        await reconcilePaidCloudflareUsers(Date.now(), env);
        expect(fake.admission).toHaveBeenCalledWith(expect.objectContaining({ instanceType: 'm6i.2xlarge' }));
        expect(fake.create).toHaveBeenCalledTimes(Number(admit)); expect(fake.advance).toHaveBeenCalledTimes(Number(admit));
        if (admit) expect(fake.create).toHaveBeenCalledWith({ userId: 'u', computerId: 'c', toSize: 'premium' });
    });
    it.each([{ EZIL_AWS_COMPUTERS_ENABLED: '0' }, { EZIL_AWS_KILL_SWITCH: '1' }, { AWS_MAX_RUNNING: '' }])(
        'production wrapper refuses disabled/kill/invalid config %j before touching storage', async patch => {
            const log = vi.spyOn(console, 'info').mockImplementation(() => {});
            await reconcilePaidCloudflareUsers(Date.now(), { ...env, ...patch });
            expect(fake.execute).not.toHaveBeenCalled(); expect(log.mock.calls.length).toBeLessThanOrEqual(1);
        });
});

describe('paid candidate SQL guards', () => {
    const dialect = new PgDialect();
    it.each([
        "s.sku IN ('standard_monthly_v3', 'premium_monthly_v3')", "s.status = 'active'",
        's.current_period_start <=', 's.current_period_end >', 'c.deleted_at IS NULL',
        'c.user_id = s.user_id', 'p.computer_id = c.id', "(p.computer_id IS NULL OR p.provider = 'cloudflare')",
        'SELECT DISTINCT ON (s.user_id)', 'm.user_id = s.user_id',
        "m.state NOT IN ('committed', 'failed_reopened', 'failed_needs_operator')", 'OR m.updated_at >=',
    ])('requires %s', async guard => {
        const execute = vi.fn(async (_query: SQL) => []);
        await paidCloudflareCandidates({ execute }, new Date('2026-10-20T12:00:00Z'));
        const query = dialect.sqlToQuery(execute.mock.calls[0]![0]);
        expect(query.sql).toContain(guard);
        expect(query.params).toContain('2026-10-20T11:50:00.000Z');
        expect(query.params.at(-1)).toBe(10);
    });
    it.each([0, -1, NaN, Infinity])('does not query for an invalid/empty limit %s', async limit => {
        const execute = vi.fn(async (_query: SQL) => []);
        expect(await paidCloudflareCandidates({ execute }, new Date(), limit)).toEqual([]);
        expect(execute).not.toHaveBeenCalled();
    });
    it('caps requested limits and maps both paid tiers from array and rows results', async () => {
        for (const wrap of [false, true]) {
            const rows = [{ user_id: 's', computer_id: 'c1', sku: 'standard_monthly_v3' }, { user_id: 'p', computer_id: 'c2', sku: 'premium_monthly_v3' }];
            const execute = vi.fn(async (_query: SQL) => wrap ? { rows } : rows);
            expect(await paidCloudflareCandidates({ execute }, new Date(), 20)).toEqual([
                { userId: 's', computerId: 'c1', toSize: 'standard' }, { userId: 'p', computerId: 'c2', toSize: 'premium' }]);
            expect(dialect.sqlToQuery(execute.mock.calls[0]![0]).params.at(-1)).toBe(10);
        }
    });
});

describe('disabled AWS logging', () => {
    it('logs the disabled state at most once per process across sweeps', async () => {
        vi.resetModules();
        const { reconcilePaidCloudflareUsers } = await import('./provider-migrate-reconcile');
        const log = vi.spyOn(console, 'info').mockImplementation(() => {});
        for (let i = 0; i < 3; i++) await reconcilePaidCloudflareUsers(Date.now(), { EZIL_AWS_COMPUTERS_ENABLED: '0' });
        expect(log.mock.calls.filter(c => String(c[0]).includes('AWS admission disabled'))).toHaveLength(1);
        log.mockRestore();
    });
});
