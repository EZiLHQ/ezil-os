import { describe, expect, it, vi } from 'vitest';
import { advanceMigration, MigrationStepError, schedulePaidMigration, sweepMigrations, type MigrationDeps } from './provider-migrate-orchestrator';
import { reduceMigration, restoreLeaseFor, type MigrationState } from './provider-migrate';
import { MigrationConflictError, type ComputeMigration } from './provider-migrate-store';
import { buildAwsProvisionUserData } from './aws-ec2';
const C = '11111111-1111-4111-8111-111111111111', G = '22222222-2222-4222-8222-222222222222';
function fixture(state: MigrationState = 'requested') {
    let m: ComputeMigration = { id: G, userId: G, computerId: C, state, fromProvider: 'cloudflare', toProvider: 'aws-ec2', toSize: 'standard',
        generation: G, sourceEtag: 'source', sourceSystemEtag: null, workspaceHead: { generation: G }, systemHead: null,
        migratedEtag: null, attempts: 0, lastError: null, restoreTokenSha256: null, restoreTokenExpiresAt: null, createdAt: '0', updatedAt: '0' };
    let locked = false, version = 0;
    const calls: string[] = [];
    const deps: MigrationDeps = {
        store: { readById: vi.fn(async () => structuredClone(m)), applyTransition: vi.fn(async (expected, event) => {
            if (expected.updatedAt !== m.updatedAt) throw new MigrationConflictError();
            const result = reduceMigration(expected, event); m = { ...m, ...result.migration, updatedAt: String(++version) };
            return { ...result, migration: m };
        }) },
        exclusive: async (_, run) => { if (locked) return; locked = true; try { await run(); } finally { locked = false; } },
        begin: vi.fn(async () => { calls.push('begin'); return { ok: true as const, data: { etag: 'source', systemEtag: null, generation: G, chunkCount: 1, totalBytes: 1, sha256: 'hash' } }; }),
        head: vi.fn(async (_, kind) => { calls.push(kind); return kind === 'workspace' ? { ok: true as const, data: { generation: G } } : { ok: false as const, error: 'not_found' as const }; }),
        exportEtag: vi.fn(async () => 'migrated'),
        provision: vi.fn(async current => {
            calls.push('provision');
            const restore = restoreLeaseFor(current, 'a'.repeat(43), `https://app.example/api/compute/restore/${C}`);
            const data = buildAwsProvisionUserData({ computerId: C, fsUuid: G, volumeId: null, generation: 1, leaseEpoch: 1,
                nonce: 'b'.repeat(43), provision: true, enrollUrl: 'https://app.example/api/compute/enroll', restore });
            expect(JSON.parse(Buffer.from(data, 'base64').toString()).restore).toEqual({ kind: 'cf-snapshot', migrationId: G,
                generation: G, system: false, identityToken: 'a'.repeat(43), fetchBase: `https://app.example/api/compute/restore/${C}` });
        }),
        freshProvision: vi.fn(async () => { m = { ...m, state: 'committed', lastError: 'fresh_provision' }; }),
        releaseProvision: vi.fn(async () => {}),
        restored: vi.fn(async () => { calls.push('ready'); return true; }),
        flip: vi.fn(async () => { calls.push('flip'); }), rollback: vi.fn(async () => { calls.push('rollback'); }),
        commit: vi.fn(async () => { calls.push('commit'); return { ok: true as const, data: {} }; }),
        abort: vi.fn(async () => ({ ok: true as const, data: {} })), reopen: vi.fn(async () => ({ ok: true as const, data: {} })),
        stopCloudflare: vi.fn(async () => { calls.push('stop'); }),
    };
    return { deps, calls, get: () => m, set: (patch: Partial<ComputeMigration>) => { m = { ...m, ...patch }; }, advance: () => advanceMigration(deps, G) };
}
describe('migration orchestration', () => {
    it('does one step per call, provisions by reference, then flips and commits', async () => {
        const f = fixture();
        for (const state of ['fenced', 'exported', 'provisioning', 'restored', 'committed']) { await f.advance(); expect(f.get().state).toBe(state); }
        expect(f.calls).toEqual(['begin', 'workspace', 'system', 'provision', 'ready', 'flip', 'commit', 'stop']);
        expect(f.deps.commit).toHaveBeenCalledWith(expect.anything(), { targetProvider: 'aws-ec2', expectedEtag: 'source', expectedSystemEtag: null });
        await f.advance(); expect(f.calls).toHaveLength(8); expect(f.deps.store.readById).toHaveBeenCalledTimes(11);
    });
    it.each(['begin', 'export', 'provision', 'restore', 'flip', 'commit', 'stop'] as const)('compensates %s failure', async step => {
        const states = { begin: 'requested', export: 'fenced', provision: 'exported', restore: 'provisioning', flip: 'restored', commit: 'restored', stop: 'restored' } as const;
        const key = { begin: 'begin', export: 'head', provision: 'provision', restore: 'restored', flip: 'flip', commit: 'commit', stop: 'stopCloudflare' } as const;
        const f = fixture(states[step]); vi.mocked(f.deps[key[step]]).mockRejectedValueOnce(new Error('redacted'));
        await f.advance(); expect(f.get().state).toBe('failed_reopened'); expect(f.deps.rollback).toHaveBeenCalledOnce();
        if (step === 'commit' || step === 'stop') expect(f.deps.reopen).toHaveBeenCalledWith(expect.anything(), 'migrated');
        else expect(f.deps.abort).toHaveBeenCalledOnce();
    });
    it.each(['abort', 'reopen'] as const)('marks failed %s for an operator', async effect => {
        const f = fixture(effect === 'abort' ? 'requested' : 'restored');
        vi.mocked(effect === 'abort' ? f.deps.begin : f.deps.commit).mockRejectedValueOnce(new Error());
        vi.mocked(f.deps[effect]).mockRejectedValueOnce(new Error()); await f.advance(); expect(f.get().state).toBe('failed_needs_operator');
    });
    it('resumes durable recovery without redoing the failed step', async () => {
        const f = fixture('exported'); f.set({ lastError: 'recovery:abort:provision' });
        await f.advance(); expect(f.get().state).toBe('failed_reopened'); expect(f.deps.provision).not.toHaveBeenCalled();
    });
    it('caps transient refusals at five retries', async () => {
        const f = fixture('exported'); vi.mocked(f.deps.provision).mockRejectedValue(new MigrationStepError(true));
        for (let i = 1; i <= 5; i++) { await f.advance(); expect(f.get()).toMatchObject({ state: 'exported', attempts: i }); }
        await f.advance(); expect(f.get().state).toBe('failed_reopened'); await f.advance(); expect(f.deps.provision).toHaveBeenCalledTimes(6);
    });
    it('polls readiness without provisioning again', async () => {
        const f = fixture('provisioning'); vi.mocked(f.deps.restored).mockResolvedValue(false);
        await f.advance(); await f.advance(); expect(f.get().state).toBe('provisioning'); expect(f.deps.provision).not.toHaveBeenCalled();
    });
    it('concurrent calls execute a single external effect', async () => {
        const f = fixture(); await Promise.all([f.advance(), f.advance(), f.advance()]); expect(f.deps.begin).toHaveBeenCalledOnce();
    });
    it('CAS loss never compensates', async () => {
        const f = fixture(); vi.mocked(f.deps.store.applyTransition).mockRejectedValueOnce(new MigrationConflictError());
        await expect(f.advance()).resolves.toBeUndefined(); expect(f.deps.abort).not.toHaveBeenCalled();
    });
    it('re-reads before transitioning and refuses a changed state', async () => {
        const f = fixture(); const original = f.deps.begin;
        f.deps.begin = async m => { f.set({ state: 'failed_reopened' }); return original(m); };
        await f.advance(); expect(f.deps.store.applyTransition).not.toHaveBeenCalled();
    });
    it.each([
        [{ generation: C }, 'generation_mismatch'],
        [{ sourceSystemEtag: 'system' }, 'system_head_mismatch'],
    ] as const)('rejects inconsistent export %j with a distinct reason', async (patch, reason) => {
        const f = fixture('fenced'); f.set(patch); await f.advance(); expect(f.get().state).toBe('failed_reopened');
        expect(f.deps.store.applyTransition).toHaveBeenCalledWith(expect.anything(),
            { type: 'error', step: 'export', retryable: false, reason });
    });
    it.each(['head_moved', 'other'] as const)('passes conflict reason %s to persistence without changing the recovery step', async reason => {
        const f = fixture('fenced');
        vi.mocked(f.deps.head).mockResolvedValueOnce({ ok: false, error: 'conflict', reason });
        await f.advance();
        expect(f.deps.store.applyTransition).toHaveBeenCalledWith(expect.anything(),
            { type: 'error', step: 'export', retryable: false, reason });
        expect(f.deps.abort).toHaveBeenCalledOnce();
        expect(f.get().state).toBe('failed_reopened');
    });
    it.each(['abort', 'reopen'] as const)('carries the reason when %s recovery fails', async effect => {
        const f = fixture('fenced'); f.set({ lastError: `recovery:${effect}:export:head_moved` });
        vi.mocked(f.deps[effect]).mockResolvedValueOnce({ ok: false, error: 'conflict', reason: 'not_migrated' });
        await f.advance();
        expect(f.deps.store.applyTransition).toHaveBeenCalledWith(expect.anything(),
            { type: 'error', step: effect, retryable: false, reason: 'not_migrated' });
        expect(f.get().state).toBe('failed_needs_operator');
    });
    it('strips the server namespace from exported data', async () => {
        const f = fixture('fenced'); vi.mocked(f.deps.head).mockResolvedValueOnce({ ok: true as const, data: { generation: G, _awsProvision: {} } });
        await f.advance(); expect(f.get().workspaceHead).toEqual({ generation: G });
    });
    it.each(['committed', 'failed_reopened', 'failed_needs_operator'] as const)('ignores terminal %s', async state => {
        const f = fixture(state); await f.advance(); expect(f.calls).toEqual([]);
        expect(f.deps.releaseProvision).toHaveBeenCalledTimes(state === 'committed' ? 0 : 1);
    });
});
describe('bounded cron', () => {
    it('claims and launches at most ten', async () => {
        const claimStale = vi.fn(async () => Array(12).fill(fixture().get())), advance = vi.fn(async () => {});
        expect(await sweepMigrations({ claimStale, advance })).toBe(10); expect(claimStale).toHaveBeenCalledWith(10); expect(advance).toHaveBeenCalledTimes(10);
    });
    it('counts existing billing time and stops launching at forty seconds', async () => {
        let time = 25_000; const claimStale = vi.fn(async () => Array(10).fill(fixture().get()));
        const advance = vi.fn(async () => { time += 5_000; });
        expect(await sweepMigrations({ claimStale, advance, now: () => time, startedAt: 0 })).toBe(3);
        expect(await sweepMigrations({ claimStale, advance, now: () => time, startedAt: 0 })).toBe(0); expect(claimStale).toHaveBeenCalledOnce();
    });
    it('isolates failures and logs only the migration id', async () => {
        const m = fixture().get(), log = vi.fn(), advance = vi.fn().mockRejectedValueOnce(new Error('secret')).mockResolvedValue(undefined);
        expect(await sweepMigrations({ claimStale: async () => [m, m], advance, log })).toBe(2); expect(log).toHaveBeenCalledWith(m.id);
    });
});
describe('nonblocking scheduling', () => {
    it.each(['free', 'standard_monthly_v2', 'compute_monthly_v2', 'pro_monthly'])('ignores %s', sku => {
        const schedule = vi.fn(); schedulePaidMigration(G, sku, 'invoice.paid', schedule); expect(schedule).not.toHaveBeenCalled();
    });
    it.each(['standard_monthly_v3', 'premium_monthly_v3'])('schedules only paid %s', sku => {
        const schedule = vi.fn(); schedulePaidMigration(G, sku, 'invoice.payment_failed', schedule); expect(schedule).not.toHaveBeenCalled();
        schedulePaidMigration(G, sku, 'invoice.paid', schedule); expect(schedule).toHaveBeenCalledOnce();
    });
    it('does not await work and swallows scheduling and background failures', async () => {
        let task!: () => Promise<void>; const run = vi.fn(async () => { throw new Error('secret'); });
        expect(schedulePaidMigration(G, 'standard_monthly_v3', 'invoice.paid', work => { task = work; }, run)).toBeUndefined();
        expect(run).not.toHaveBeenCalled(); await expect(task()).resolves.toBeUndefined();
        expect(() => schedulePaidMigration(G, 'standard_monthly_v3', 'invoice.paid', () => { throw new Error(); })).not.toThrow();
    });
});

describe('fresh provisioning', () => {
    it('accepts only Worker-proven no_workspace and skips restore and abort', async () => {
        const f = fixture();
        vi.mocked(f.deps.begin).mockResolvedValue({ ok: false, error: 'conflict', reason: 'no_workspace' });
        await f.advance();
        expect(f.get()).toMatchObject({ state: 'committed', lastError: 'fresh_provision' });
        expect(f.deps.freshProvision).toHaveBeenCalledOnce();
        expect(f.deps.provision).not.toHaveBeenCalled();
        expect(f.deps.abort).not.toHaveBeenCalled();
    });
    it.each(['no_context', 'no_checkpoint'] as const)('never treats %s alone as empty', async reason => {
        const f = fixture();
        vi.mocked(f.deps.begin).mockResolvedValue({ ok: false, error: 'conflict', reason });
        await f.advance();
        expect(f.deps.freshProvision).not.toHaveBeenCalled();
        expect(f.get().state).toBe('failed_reopened');
    });
});
