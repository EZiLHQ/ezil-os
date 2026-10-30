import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import { applyLifecycleReceipt, readMigrationReadyReceipt } from './aws-receipts';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { readPlacement, type PlacementDb } from './placement';
import { fixtureDeployment } from './aws-intent.test-support';
import { MIGRATION_STATES } from './provider-migrate';
const C = '11111111-1111-4111-8111-111111111111', M = '22222222-2222-4222-8222-222222222222';
const I = 'i-11111111111111111', V = 'vol-11111111111111111', D = fixtureDeployment('ap-south-1');
function fixture() {
    const f = createFakePlacementDb({ placements: [placementRow({ computer_id: C, owner_user_id: C, state: 'PROVISIONING',
        provider: 'aws-ec2', workspace_store: 'ebs', generation: 1, lease_epoch: 1, region: 'ap-south-1', instance_type: 'm6i.large',
        instance_id: I, volume_id: V, fs_uuid: M, lifecycle_job_id: M, lifecycle_digest: 'a'.repeat(64), fence_token: M,
        enroll_nonce_hash: null, enroll_consumed_hash: 'b'.repeat(64), last_error: 'enroll_succeeded' })] });
    const receipt = { schemaVersion: 1, computerId: C, jobId: M, generation: 1, leaseEpoch: 1, digest: 'a'.repeat(64),
        fenceToken: M, instanceId: I, volumeId: V, state: 'running' };
    const executions = { describe: vi.fn(async () => ({ status: 'SUCCEEDED', output: JSON.stringify(receipt) })) };
    return { f, receipt, executions, p: async () => (await readPlacement(f.db, C)).record! };
}
describe('migration host evidence', () => {
    it('requires matching ready receipt and successful enrollment together', async () => {
        const f = fixture(), p = await f.p(); expect(await readMigrationReadyReceipt(f.executions, p, D)).toBe(true);
        for (const patch of [{ lastError: null }, { lastError: 'enroll_tunnel_pending' }, { enrollNonceHash: 'x' },
            { enrollConsumedHash: null }, { instanceId: null }, { volumeId: null }])
            expect(await readMigrationReadyReceipt(f.executions, { ...p, ...patch }, D)).toBe(false);
        f.executions.describe.mockResolvedValue({ status: 'RUNNING', output: '' });
        expect(await readMigrationReadyReceipt(f.executions, p, D)).toBe(false);
    });
    it.each(['jobId', 'computerId', 'generation', 'leaseEpoch', 'digest', 'fenceToken', 'instanceId', 'volumeId', 'state'] as const)('rejects a receipt for the wrong %s', async field => {
        const f = fixture();
        const value = { jobId: C, computerId: M, generation: 2, leaseEpoch: 2, digest: 'c'.repeat(64), fenceToken: C,
            instanceId: 'i-22222222222222222', volumeId: 'vol-22222222222222222', state: 'stopped' }[field];
        f.executions.describe.mockResolvedValue({ status: 'SUCCEEDED', output: JSON.stringify({ ...f.receipt, [field]: value }) });
        await expect(readMigrationReadyReceipt(f.executions, await f.p(), D)).rejects.toThrow();
    });
    it.each(['FAILED', 'TIMED_OUT', 'ABORTED'])('rejects failed host %s', async status => {
        const f = fixture(); f.executions.describe.mockResolvedValue({ status, output: '' });
        await expect(readMigrationReadyReceipt(f.executions, await f.p(), D)).rejects.toThrow('migration_host_failed');
    });
    it.each(MIGRATION_STATES)('billing epoch is gated on committed, state=%s', async state => {
        const f = fixture(), p = { ...await f.p(), lastError: `migration_pending:${M}` };
        f.f.placements[0]!.last_error = p.lastError;
        const dialect = new PgDialect();
        const db: PlacementDb = { transaction: f.f.db.transaction, execute: async q => {
            if (dialect.sqlToQuery(q).sql.includes('FROM public.ezil_compute_migrations')) return { rows: [{
                id: M, user_id: C, computer_id: C, state, from_provider: 'cloudflare', to_provider: 'aws-ec2', to_size: 'standard',
                generation: M, attempts: 0, created_at: '2026-10-20', updated_at: '2026-10-20' }] };
            return f.f.db.execute(q);
        } };
        const ready = vi.fn(async () => {}), now = new Date('2026-10-20T10:00:00Z');
        await applyLifecycleReceipt({ db, executions: f.executions, now: () => now, meter: { ready, stopped: vi.fn(), heartbeat: vi.fn() } }, p, D);
        expect(ready).toHaveBeenCalledTimes(state === 'committed' ? 1 : 0);
        if (state === 'committed') expect(ready).toHaveBeenCalledWith(expect.objectContaining({ readyAt: now, size: 'std-2', overheadSeconds: 0 }));
        else expect(f.executions.describe).not.toHaveBeenCalled();
    });
});
