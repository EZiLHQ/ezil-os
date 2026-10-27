import { beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ placement: vi.fn(), migration: vi.fn() }));
vi.mock('./placement', async original => ({ ...await original<typeof import('./placement')>(), readPlacement: h.placement }));
vi.mock('./provider-migrate-store', async original => ({ ...await original<typeof import('./provider-migrate-store')>(), createProviderMigrationStore: () => ({ readByComputer: h.migration }) }));
vi.mock('@/server/billing/v2/compute-access', () => ({ billingV2EntitlementReader: () => ({ read: async () => null }) }));
import { describeProgress, openingTypicalSeconds, readComputerProgress } from './progress';
import { PlacementOwnerError, type Placement } from './placement';
import type { ComputeMigration } from './provider-migrate-store';
const computer = { computerId: 'c', userId: 'u' };
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_COMPUTE_PLACEMENT_READS: '1', EZIL_AWS_KILL_SWITCH: '0' };
const placement = { provider: 'aws-ec2', state: 'STOPPED', instanceType: 'm6i.large', updatedAt: new Date('2026-10-26T10:00:00Z') } as Placement;
const migration = { computerId: 'c', userId: 'u', state: 'provisioning', createdAt: '2026-10-26T10:00:00Z', updatedAt: '2026-10-26T10:01:00Z', lastError: null, restoreTokenSha256: 'secret', workspaceHead: { secret: 'private' } } as unknown as ComputeMigration;
const measured: ComputeMigration = { ...migration,
    workspaceHead: { generation: 'g', chunks: Array.from({ length: 8 }, () => ({ size: 1_000_000 })) },
    systemHead: { generation: 's', chunks: [{ size: 500_000 }, { size: 500_000 }] },
    restoreProgress: { workspace: '07'.padEnd(128, '0'), system: '01'.padEnd(128, '0'), bytes: 3_500_000,
        first: '2026-10-26T10:00:00Z', last: '2026-10-26T10:00:10Z' },
};
beforeEach(() => { h.placement.mockReset().mockResolvedValue({ record: placement }); h.migration.mockReset().mockResolvedValue(null); });
describe('read-only progress', () => {
    it('projects measured workspace and system bytes from the stored migration into v2', async () => {
        h.migration.mockResolvedValue(measured);
        const result = await readComputerProgress({} as never, computer, env);
        expect(result).toMatchObject({ version: 2, bytes: { transferred: 3_500_000, total: 9_000_000 }, percent: 38,
            etaSeconds: 16, typicalSeconds: 92, transferStartedAt: '2026-10-26T10:00:00.000Z', transferUpdatedAt: '2026-10-26T10:00:10.000Z' });
        expect(JSON.stringify(result)).not.toMatch(/workspaceHead|restoreProgress|secret/);
    });
    it.each(['requested', 'fenced', 'committed', 'failed_reopened', 'failed_needs_operator'] as const)('has no transfer metrics for pre-export or non-migration operation %s', state => {
        expect(describeProgress('c', placement, { ...measured, state }, env)).toMatchObject({
            bytes: { transferred: null, total: null }, percent: null, etaSeconds: null, typicalSeconds: null,
            transferStartedAt: null, transferUpdatedAt: null,
        });
    });
    it('keeps unknown heads unmeasured and starts exported heads at zero before any served chunks', () => {
        for (const workspaceHead of [null, { generation: 'g' }, { generation: 'g', chunks: [{ size: '100' }] }])
            expect(describeProgress('c', placement, { ...measured, workspaceHead }, env).bytes).toEqual({ transferred: null, total: null });
        expect(describeProgress('c', placement, { ...measured, systemHead: null, restoreProgress: null }, env)).toMatchObject({
            bytes: { transferred: 0, total: 8_000_000 }, percent: 0, etaSeconds: null, typicalSeconds: 92,
            transferStartedAt: null, transferUpdatedAt: null,
        });
        expect(describeProgress('c', placement, null, env).typicalSeconds).toBeNull();
    });
    it.each([['03', 2_000_000], ['07', 3_000_000]] as const)('does not estimate ETA below four distinct chunks (%s)', (bits, bytes) => {
        expect(describeProgress('c', null, { ...measured, systemHead: null,
            restoreProgress: { ...measured.restoreProgress!, workspace: bits.padEnd(128, '0'), system: '0'.repeat(128), bytes } }, env).etaSeconds).toBeNull();
    });
    it.each([{ bytes: 0 }, { last: '2026-10-26T10:00:00Z' }, { last: '2026-10-26T09:59:59Z' }, { first: 'invalid' }])('has no ETA without a positive measured rate %j', patch => {
        expect(describeProgress('c', null, { ...measured, restoreProgress: { ...measured.restoreProgress!, ...patch } }, env).etaSeconds).toBeNull();
    });
    it('clamps percent and remaining time and recomputes ETA from observed elapsed time', () => {
        expect(describeProgress('c', null, { ...measured, restoreProgress: { ...measured.restoreProgress!, bytes: 10_000_000 } }, env))
            .toMatchObject({ percent: 100, etaSeconds: 0 });
        expect(describeProgress('c', null, { ...measured, restoreProgress: { ...measured.restoreProgress!, bytes: -1 } }, env).percent).toBe(0);
        expect(describeProgress('c', null, { ...measured, restoreProgress: { ...measured.restoreProgress!, last: '2026-10-26T10:00:20Z' } }, env).etaSeconds).toBe(32);
    });
    it.each([[1, 90], [6_000_000, 92], [4_000_000_000, 600]])('estimates typical duration for %i bytes as %i seconds', (size, typicalSeconds) => {
        expect(describeProgress('c', null, { ...measured, workspaceHead: { generation: 'g', chunks: [{ size }] }, systemHead: null }, env).typicalSeconds).toBe(typicalSeconds);
    });
    it('preserves stage precedence and suppresses ETA while paused, operator-blocked, recovering or restored', () => {
        expect(describeProgress('c', placement, measured, { ...env, EZIL_AWS_KILL_SWITCH: '1' }))
            .toMatchObject({ stage: 'operations_paused', percent: 38, etaSeconds: null });
        expect(describeProgress('c', { ...placement, state: 'UNCONFIRMED' }, measured, env))
            .toMatchObject({ stage: 'needs_operator', percent: 38, etaSeconds: null });
        expect(describeProgress('c', null, { ...measured, lastError: 'recovery:abort:provision' }, env))
            .toMatchObject({ stage: 'recovering', etaSeconds: null });
        expect(describeProgress('c', null, { ...measured, state: 'restored' }, env))
            .toMatchObject({ stage: 'restored', percent: 38, etaSeconds: null });
        expect(describeProgress('c', null, { ...measured, state: 'exported' }, env).etaSeconds).toBe(16);
    });
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

    describe('opening progress', () => {
        const NOW = new Date('2026-10-27T12:00:00Z');
        // Explicit nulls: the enrollment predicate never treats a missing field as "no job" or "no presence".
        const mounting = { ...placement, state: 'MOUNTING', lifecycleJobId: null, presenceAt: null, lastError: null,
            enrollExpiresAt: new Date(NOW.getTime() - 60_000), updatedAt: new Date('2026-10-27T11:50:00Z') } as Placement;

        it.each(['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'WARMING', 'CLAIMED'] as const)('%s reports the bounded 240 s default', state => {
            expect(describeProgress('c', { ...placement, state }, null, env)).toMatchObject({
                operation: 'opening', typicalSeconds: 240, bytes: { transferred: null, total: null }, etaSeconds: null });
        });
        it.each([[3, 180], [4.5, 270], [1, 90], [0.1, 90], [20, 600], [0, 240], [-2, 240], [Number.NaN, 240], [Number.POSITIVE_INFINITY, 240], [null, 240]] as const)(
            'derives opening seconds from a pool boot p90 of %s min as %i s (clamped 90-600)', (minutes, seconds) => {
                expect(openingTypicalSeconds(minutes)).toBe(seconds);
                expect(describeProgress('c', { ...placement, state: 'STARTING' }, null, env, new Date(), null, { poolBootP90Minutes: minutes }).typicalSeconds).toBe(seconds);
            });
        it('keeps typicalSeconds null outside an open and while paused', () => {
            expect(describeProgress('c', placement, null, env, NOW, null, { poolBootP90Minutes: 3 }).typicalSeconds).toBeNull();
            expect(describeProgress('c', { ...placement, state: 'RUNNING' }, null, env).typicalSeconds).toBeNull();
            expect(describeProgress('c', { ...placement, state: 'MOUNTING' }, null, { ...env, EZIL_AWS_KILL_SWITCH: '1' }))
                .toMatchObject({ stage: 'operations_paused', active: false, typicalSeconds: null });
        });
        it.each([
            ['no presence', null],
            ['stale presence from an earlier session', new Date(NOW.getTime() - 3_600_000)],
            ['presence 1 ms before this nonce was issued', new Date(NOW.getTime() - 660_001)],
        ] as const)('MOUNTING with an expired enrollment nonce (+60 s grace) and %s reports needs_operator', (_name, presenceAt) => {
            for (const lastError of [null, 'enroll_tunnel_pending']) {
                expect(describeProgress('c', { ...mounting, presenceAt, lastError }, null, env, NOW)).toMatchObject({
                    operation: 'opening', stage: 'needs_operator', recordedStage: 'mounting', lifecycleState: 'MOUNTING',
                    needsOperator: true, active: false, typicalSeconds: null, etaSeconds: null });
            }
        });
        it('a live or failed migration owns the stage; an expired-looking placement never overrides it', () => {
            const live = describeProgress('c', mounting, { ...migration, state: 'provisioning', updatedAt: '2026-10-27T11:59:00Z' }, env, NOW);
            expect(live).toMatchObject({ operation: 'migration', stage: 'provisioning', needsOperator: false, active: true });
            const failed = describeProgress('c', mounting, { ...migration, state: 'failed_reopened', updatedAt: '2026-10-27T11:59:00Z' }, env, NOW);
            expect(failed).toMatchObject({ stage: 'failed_reopened', recordedStage: 'failed_reopened', needsOperator: false });
        });
        it.each([
            ['not yet past the grace', { enrollExpiresAt: new Date(NOW.getTime() - 59_999) }],
            ['still before the nonce deadline', { enrollExpiresAt: new Date(NOW.getTime() + 600_000) }],
            ['no deadline', { enrollExpiresAt: null }],
            ['a recorded lifecycle job', { lifecycleJobId: 'job' }],
            ['host presence', { presenceAt: new Date(NOW.getTime() - 1_000) }],
            ['rebase presence stamped at the nonce issue time', { presenceAt: new Date(NOW.getTime() - 660_000) }],
            ['STARTING (the timeout CAS is MOUNTING-only)', { state: 'STARTING' }],
            ['enrollment success', { lastError: 'enroll_succeeded' }],
            ['a pending pool session', { lastError: 'pool_session_pending' }],
            ['another state', { state: 'PROVISIONING' }],
        ] as const)('stays an active open with %s', (_name, patch) => {
            const result = describeProgress('c', { ...mounting, ...patch } as Placement, null, env, NOW);
            expect(result).toMatchObject({ operation: 'opening', needsOperator: false, active: true, typicalSeconds: 240 });
            expect(result.stage).toBe(result.recordedStage);
        });
        it('never reports an expired enrollment for a non-AWS placement', () => {
            expect(describeProgress('c', { ...mounting, provider: 'cloudflare' } as Placement, null, env, NOW)).toMatchObject({
                needsOperator: false, lifecycleState: null });
        });
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
