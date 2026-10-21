import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMigrationRuntime, startPaidMigration } from './provider-migrate-runtime';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { fixtureDeployment } from './aws-intent.test-support';
import { LIFECYCLE_DEPLOYMENTS_ENV } from './aws-intent';
import type { ComputeMigration } from './provider-migrate-store';
import { readEnrollmentPlacement, consumeMigrationEnrollment, finishMigrationEnrollment, provisionFor } from './provider-migrate-provision';
import { reduceMigration } from './provider-migrate';
import type { PlacementDb } from './placement';
const fake = vi.hoisted(() => ({ store: {} as Record<string, unknown> }));
vi.mock('./provider-migrate-store', async original => ({ ...await original<typeof import('./provider-migrate-store')>(), createProviderMigrationStore: () => fake.store }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: () => { throw new Error('No DB in tests'); } }));
const C = '11111111-1111-4111-8111-111111111111', M = '22222222-2222-4222-8222-222222222222';
const D = fixtureDeployment('ap-south-1', ['m6i.large', 'm6i.xlarge', 'm6i.2xlarge']);
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600', EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': D }), EZIL_AWS_ENROLL_URL: 'https://app.example/api/compute/aws/enroll' };
function fixture(patch: Record<string, string | undefined> = {}, plan = 'standard_monthly_v3', size: 'std-2' | 'cmp-4' | 'cmp-8' = 'std-2') {
    let m = { id: M, computerId: C, userId: C, state: 'exported', generation: M, workspaceHead: { generation: M }, systemHead: null,
        sourceEtag: 'etag', sourceSystemEtag: null, updatedAt: '1', attempts: 0, lastError: null } as ComputeMigration;
    const mintRestoreToken = vi.fn(async () => 'a'.repeat(43)), saveProvision = vi.fn(async (_: ComputeMigration, provision: unknown) => {
        m = { ...m, workspaceHead: { generation: M, _awsProvision: provision }, updatedAt: '2' };
    });
    const store = { readById: vi.fn(async () => m), readActiveByComputer: vi.fn(async () => m), mintRestoreToken, saveProvision,
        createOrGetActive: vi.fn(async () => m), applyTransition: vi.fn(async (current: ComputeMigration, event: Parameters<typeof reduceMigration>[1]) => {
            const d = reduceMigration(current, event); m = { ...m, ...d.migration }; return { ...d, migration: m };
        }) };
    fake.store = store;
    const db = createFakePlacementDb({ computers: [{ id: C, user_id: C }], placements: [] });
    const start = vi.fn(async () => {}), deps = createMigrationRuntime(db.db, { env: { ...env, ...patch }, collaborators: { starter: { start } },
        entitlement: { read: async () => ({ status: 'active', planId: plan, provider: 'aws', source: 'billing_v2', size }) } });
    return { deps, db, start, store, get: () => m };
}
beforeEach(() => { fake.store = {}; });
describe('real migration admission and provisioning seam', () => {
    it.each([['standard_monthly_v3', 'cmp-8', 'm6i.large'], ['premium_monthly_v3', 'cmp-4', 'm6i.xlarge'],
        ['premium_monthly_v3', 'cmp-8', 'm6i.2xlarge']] as const)('uses entitled size for %s / %s', async (plan, size, machine) => {
        const f = fixture({ EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10' }, plan, size);
        await f.deps.provision(f.get()); expect(f.start).toHaveBeenCalledOnce();
        const [region, work] = f.start.mock.calls[0]! as unknown as [string, { input: string }];
        expect(region).toBe('ap-south-1'); expect(work.input).toContain(machine);
        const saved = f.store.saveProvision.mock.calls[0]![1];
        expect(JSON.stringify(saved)).not.toContain('a'.repeat(43)); expect(JSON.stringify(saved)).not.toContain('identityToken');
        expect(f.db.placements).toEqual([]);
        await f.deps.provision(f.get()); expect(f.start).toHaveBeenCalledOnce(); expect(f.store.mintRestoreToken).toHaveBeenCalledOnce();
    });
    it.each([{ EZIL_AWS_COMPUTERS_ENABLED: '0' }, { EZIL_AWS_KILL_SWITCH: '1' }, { AWS_MAX_RUNNING: '0' },
        { EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '0' }, { AWS_REGIONS: 'us-east-1' }])('refusal %j creates no intent/token/instance', async patch => {
        const f = fixture(patch); await expect(f.deps.provision(f.get())).rejects.toThrow();
        expect(f.start).not.toHaveBeenCalled(); expect(f.store.mintRestoreToken).not.toHaveBeenCalled(); expect(f.store.saveProvision).not.toHaveBeenCalled();
    });
    it.each(['free_v3', 'standard_monthly_v2', 'compute_monthly_v2'])('refuses entitlement %s', async plan => {
        const f = fixture({}, plan); await expect(f.deps.provision(f.get())).rejects.toThrow(); expect(f.start).not.toHaveBeenCalled();
    });
    it.each(['cloudflare', 'aws-ec2', 'none'])('paid trigger filters published placement %s', async provider => {
        const f = fixture();
        if (provider !== 'none') f.db.placements.push(placementRow({ computer_id: C, owner_user_id: C, provider,
            workspace_store: provider === 'cloudflare' ? 'r2' : 'ebs' }));
        const db: PlacementDb = { transaction: f.db.db.transaction, execute: async () => [{ id: C }] };
        // Keep the real placement read; the only direct query here is the owned computer list.
        const { PgDialect } = await import('drizzle-orm/pg-core'); const dialect = new PgDialect();
        db.execute = q => dialect.sqlToQuery(q).sql.includes('FROM public.ezil_computers') ? Promise.resolve([{ id: C }]) : f.db.db.execute(q);
        f.deps.exclusive = async () => {}; // Scheduling is tested separately; no Worker calls.
        await startPaidMigration(C, 'standard_monthly_v3', { db, deps: f.deps });
        expect(f.store.createOrGetActive).toHaveBeenCalledTimes(provider === 'aws-ec2' ? 0 : 1);
        await startPaidMigration(C, 'standard_monthly_v2', { db, deps: f.deps });
        expect(f.store.createOrGetActive).toHaveBeenCalledTimes(provider === 'aws-ec2' ? 0 : 1);
    });
});

describe('migration enrollment intent', () => {
    it('enrolls the hidden boot without publishing an AWS placement', async () => {
        const f = fixture(); await f.deps.provision(f.get());
        const p = (await readEnrollmentPlacement(f.db.db, C)).record!;
        expect(p.provider).toBe('aws-ec2'); expect(f.db.placements).toHaveLength(0);
        const input = { computerId: C, expected: p, nonceHash: p.enrollNonceHash!,
            fields: { instanceId: 'i-11111111111111111', volumeId: 'vol-11111111111111111' } };
        const consumed = await consumeMigrationEnrollment(f.db.db, input);
        expect(consumed.ok).toBe(true);
        expect((await consumeMigrationEnrollment(f.db.db, input)).ok).toBe(false);
        if (!consumed.ok) throw new Error('consume');
        expect((await finishMigrationEnrollment(f.db.db, { computerId: C, expected: consumed.placement, success: true })).ok).toBe(true);
        expect(provisionFor(f.get())!.placement.lastError).toBe('enroll_succeeded');
        expect(f.db.placements).toHaveLength(0);
    });
    it.each(['generation', 'lease', 'nonce', 'instance', 'expired', 'recovery'])('rejects %s enrollment mismatch', async guard => {
        const f = fixture(); await f.deps.provision(f.get()); const intent = provisionFor(f.get())!;
        const p = intent.placement;
        if (guard === 'instance') p.instanceId = 'i-22222222222222222';
        if (guard === 'expired') p.enrollExpiresAt = new Date(0);
        await f.store.saveProvision(f.get(), intent);
        if (guard === 'recovery') f.get().lastError = 'recovery:abort:restore';
        const result = await consumeMigrationEnrollment(f.db.db, { computerId: C,
            expected: { ...p, generation: guard === 'generation' ? 9 : p.generation, leaseEpoch: guard === 'lease' ? 9 : p.leaseEpoch },
            nonceHash: guard === 'nonce' ? 'f'.repeat(64) : p.enrollNonceHash!,
            fields: { instanceId: 'i-11111111111111111', volumeId: 'vol-11111111111111111' } });
        expect(result.ok).toBe(false);
    });
});
