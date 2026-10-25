import { expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import { adoptRecoverySetup } from './aws-pool-adopt-recovery.test-support';
import { writeLivePoolRecovery, type PlacementFields } from './placement';
const fields: PlacementFields = { lifecycleJobId: null, lifecycleDigest: null, lastError: 'pool_released', leaseUntil: null };
it.each(['ordinary', 'state', 'digest', 'job', 'epoch', 'fence', 'host', 'volume', 'nonce', 'claim', 'session', 'fields', 'usage', 'ledger'])
('unopened completion mode refuses an unbound %s', async fault => {
    const s = adoptRecoverySetup(); await s.tick(); const p = await s.current();
    if (fault === 'ordinary') p.lastError = 'pool_release_recovery:other';
    if (fault === 'state') p.state = 'UNCONFIRMED';
    if (fault === 'digest') p.lifecycleDigest = 'ab'.repeat(32);
    if (fault === 'job') p.lifecycleJobId = s.original.intent.jobId;
    if (fault === 'epoch') p.leaseEpoch++;
    if (fault === 'fence') p.fenceToken = s.original.intent.jobId;
    if (fault === 'host') p.instanceId = 'i-99999999999999999';
    if (fault === 'volume') p.volumeId = 'vol-99999999999999999';
    if (fault === 'nonce') s.placements[0]!.enroll_nonce_hash = 'ab'.repeat(32);
    if (fault === 'claim') s.pool.claim_generation = 5;
    if (fault === 'session') s.pool.session_ready_at = new Date();
    if (fault === 'ledger') s.usage.push({ computer_id: p.computerId, instance_id: p.instanceId, stopped_at: null });
    expect(await writeLivePoolRecovery(s.db, p, 'STOPPED', fault === 'fields' ? { ...fields, instanceId: null } : fields,
        fault === 'usage' ? { kind: 'close', observedBy: 'test' } : undefined, 'unopened-adopt')).toMatchObject({ ok: false });
    expect((await s.current()).state).toBe('RECOVERING'); expect(s.statements.filter(q => q.sql.includes('usage-'))).toEqual([]);
});
it('ordinary live recovery completion still closes all open usage', async () => {
    const s = adoptRecoverySetup(); await s.tick(); s.usage.push({ computer_id: s.original.intent.computerId, instance_id: 'i-old', stopped_at: null });
    expect(await writeLivePoolRecovery(s.db, await s.current(), 'STOPPED', fields)).toMatchObject({ ok: true });
    expect(s.usage[0]!.stopped_at).toBeInstanceOf(Date);
    expect(s.statements.filter(q => q.sql.includes('usage-close'))).toHaveLength(1);
});
