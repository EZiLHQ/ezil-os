import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ placement: vi.fn(), migration: vi.fn() }));
vi.mock('./placement', async original => ({ ...await original<typeof import('./placement')>(), readPlacement: h.placement }));
vi.mock('./provider-migrate-store', () => ({ createProviderMigrationStore: () => ({ readByComputer: h.migration }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ billingV2EntitlementReader: () => ({ read: async () => null }) }));
import { describeProgress, readComputerProgress } from './progress';
import { PlacementOwnerError, type Placement } from './placement';
import type { ComputeMigration } from './provider-migrate-store';
const computer = { computerId: 'c', userId: 'u' };
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_COMPUTE_PLACEMENT_READS: '1', EZIL_AWS_KILL_SWITCH: '0' };
const placement = { provider: 'aws-ec2', state: 'STOPPED', instanceType: 'm6i.large', updatedAt: new Date('2026-10-26T10:00:00Z') } as Placement;
const migration = { computerId: 'c', userId: 'u', state: 'provisioning', createdAt: '2026-10-26T10:00:00Z', updatedAt: '2026-10-26T10:01:00Z', lastError: null, restoreTokenSha256: 'secret', workspaceHead: { secret: 'private' } } as unknown as ComputeMigration;
beforeEach(() => { h.placement.mockReset().mockResolvedValue({ record: placement }); h.migration.mockReset().mockResolvedValue(null); });
describe('read-only progress', () => {
    it('cutoff overrides active migration without fabricating transfer metrics', () => {
        const result = describeProgress('c', placement, migration, { ...env, EZIL_AWS_KILL_SWITCH: '1' });
        expect(result).toMatchObject({ stage: 'operations_paused', recordedStage: 'provisioning', paused: true, durable: true, bytes: { transferred: null, total: null }, percent: null, etaSeconds: null });
        expect(JSON.stringify(result)).not.toMatch(/secret|private|workspaceHead|restoreToken/);
    });
    it('stopped placement does not reuse a completed historical migration as active transfer', () => {
        expect(describeProgress('c', placement, { ...migration, state: 'committed' }, env)).toMatchObject({ operation: 'none', stage: 'stopped', durable: false, startedAt: null });
    });
    it('distinguishes recovery and terminal source reopened', () => {
        expect(describeProgress('c', null, { ...migration, lastError: 'recovery:abort:provision' }, env).recordedStage).toBe('recovering');
        expect(describeProgress('c', null, { ...migration, state: 'failed_reopened' }, env)).toMatchObject({ stage: 'failed_reopened', durable: false });
    });
    it.each(['failed_needs_operator', 'failed_reopened'] as const)('recent %s remains visible with a stopped placement, but a newer running placement supersedes it', state => {
        const failure = { ...migration, state };
        expect(describeProgress('c', placement, failure, env)).toMatchObject({
            stage: state === 'failed_needs_operator' ? 'needs_operator' : 'failed_reopened',
            needsOperator: state === 'failed_needs_operator', active: false, durable: false,
        });
        const newer = { ...placement, state: 'RUNNING' as const, updatedAt: new Date('2026-10-26T10:02:00Z') };
        expect(describeProgress('c', newer, failure, env)).toMatchObject({ stage: 'running', needsOperator: false, active: false });
        expect(describeProgress('c', placement, failure, { ...env, EZIL_AWS_KILL_SWITCH: '1' }).stage).toBe('operations_paused');
    });

    it('queued and operations-paused never animate; selected hardware is distinct from current hardware', () => {
        const entitlement = { source: 'billing_v2', status: 'active', provider: 'aws', size: 'cmp-4', planId: 'premium_monthly_v3' } as const;
        const result = describeProgress('c', placement, { ...migration, state: 'requested' }, env, new Date(), entitlement);
        expect(result).toMatchObject({ stage: 'queued', active: false, hardware: { instanceType: 'm6i.large' },
            selectedNextOpenHardware: { size: 'cmp-4', vcpu: 4, memoryGiB: 16, effective: 'next_open' } });
        expect(describeProgress('c', placement, migration, { ...env, EZIL_AWS_KILL_SWITCH: '1' }).active).toBe(false);
        expect(describeProgress('c', null, null, { ...env, EZIL_AWS_KILL_SWITCH: '1' }, new Date(), entitlement)).toMatchObject({ stage: 'operations_paused', active: false });
        expect(describeProgress('c', placement, null, env, new Date(), { ...entitlement, status: 'past_due' }).selectedNextOpenHardware).toBeNull();
    });

    it('reads only stored placement and latest migration', async () => {
        const result = await readComputerProgress({} as never, computer, env);
        expect(result?.stage).toBe('stopped');
        expect(h.placement).toHaveBeenCalledWith({}, 'c', 'u');
        expect(h.migration).toHaveBeenCalledWith('c');
    });
    it('foreign placement prevents the migration read', async () => {
        h.placement.mockRejectedValue(new PlacementOwnerError('c'));
        expect(await readComputerProgress({} as never, computer, env)).toBeNull();
        expect(h.migration).not.toHaveBeenCalled();
    });
    it('foreign migration is not exposed', async () => {
        h.migration.mockResolvedValue({ ...migration, userId: 'foreign' });
        expect(await readComputerProgress({} as never, computer, env)).toBeNull();
    });
    it('disabled reads and failed reads do not claim progress', async () => {
        expect((await readComputerProgress({} as never, computer, {}))?.stage).toBe('unavailable');
        expect(h.placement).not.toHaveBeenCalled();
        h.placement.mockRejectedValue(new Error('secret database detail'));
        expect((await readComputerProgress({} as never, computer, env))?.stage).toBe('unavailable');
    });
});
