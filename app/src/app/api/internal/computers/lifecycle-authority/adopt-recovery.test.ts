import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { adoptRecoverySetup, RECOVERY_NOW, RECOVERY_OTHER } from '@/server/lib/compute/aws-pool-adopt-recovery.test-support';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), sdk: vi.fn() }));
vi.mock('@/server/db', () => ({ db: { execute: mocks.execute, transaction: mocks.transaction } }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
vi.mock('@/server/lib/compute/aws-clients', async original => ({ ...await original<object>(), sharedAwsSdkCollaborators: mocks.sdk }));
const { POST } = await import('./route');
const KEY = 'ab'.repeat(32), PATH = '/api/internal/computers/lifecycle-authority';
function request(body: object, path = PATH, key = KEY) {
    const text = JSON.stringify(body), timestamp = String(RECOVERY_NOW.getTime() / 1000);
    const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(['ezil-lifecycle-authority-v1', 'POST', path, timestamp,
        createHash('sha256').update(text).digest('hex')].join('\n')).digest('hex');
    return new Request('https://app.example.test' + path, { method: 'POST', body: text, headers: { 'content-type': 'application/json',
        'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature } });
}
beforeEach(() => { vi.stubEnv('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', KEY); vi.spyOn(Date, 'now').mockReturnValue(RECOVERY_NOW.getTime()); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
async function setup() {
    const s = adoptRecoverySetup(); mocks.execute.mockImplementation(s.db.execute); mocks.transaction.mockImplementation(s.db.transaction);
    await s.tick(); expect(s.starts).toHaveLength(1); const w = s.starts[0]!;
    const body = { schemaVersion: 1, computerId: w.intent.computerId, jobId: w.intent.jobId, digest: w.digest, leaseEpoch: w.intent.leaseEpoch };
    return { ...s, body };
}
it('authority admits only the saved bound recovery', async () => {
    const s = await setup(); expect((await POST(request(s.body))).status).toBe(200);
    expect((await POST(request({ ...s.body, jobId: s.original.intent.jobId, digest: s.original.digest }))).status).toBe(403);
});
it.each(['lease_token', 'leased_generation', 'instance_id', 'claim_generation', 'claim_lease_epoch', 'claim_fence', 'claim_volume_serial', 'session_ready_at'])
('authority rejects changed pool %s', async key => {
    const s = await setup(); s.pool[key] = s.original.intent.jobId;
    expect((await POST(request(s.body))).status).toBe(403);
});
it.each(['generation', 'lease_epoch', 'instance_id', 'enroll_nonce_hash', 'enroll_consumed_hash', 'enroll_expires_at'])
('authority rejects changed placement %s', async key => {
    const s = await setup(); s.placements[0]![key] = ['generation', 'lease_epoch'].includes(key) ? 99 : key === 'enroll_expires_at' ? RECOVERY_NOW : RECOVERY_OTHER;
    expect((await POST(request(s.body))).status).toBe(403);
});
