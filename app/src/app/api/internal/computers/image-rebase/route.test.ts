import { createHash, createHmac } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { rebaseSetup } from '@/server/lib/compute/aws-rebase.test-support';
const mocks = vi.hoisted(() => ({ execute: vi.fn(), transaction: vi.fn(), collaborators: vi.fn(), tunnels: vi.fn() }));
vi.mock('@/server/billing/v2/compute-meter', () => ({ billingComputeMeter: () => ({ ready: async () => {}, stopped: async () => {}, heartbeat: async () => {} }) }));
vi.mock('@/server/db', () => ({ db: { execute: mocks.execute, transaction: mocks.transaction } }));
vi.mock('@/server/lib/compute/aws-clients', async importOriginal => ({ ...await importOriginal<typeof import('@/server/lib/compute/aws-clients')>(), sharedAwsSdkCollaborators: mocks.collaborators }));
vi.mock('@/server/lib/compute/aws-enroll', async importOriginal => ({ ...await importOriginal<typeof import('@/server/lib/compute/aws-enroll')>(), workerTunnelClientFromEnv: mocks.tunnels }));
const { POST } = await import('./route');
const path = '/api/internal/computers/image-rebase', key = 'ab'.repeat(32), time = new Date('2026-10-22T12:00:00.000Z');
function request(body: string, signedPath = path, timestamp = String(time.getTime() / 1000)) {
    const signature = createHmac('sha256', Buffer.from(key, 'hex')).update(['ezil-lifecycle-authority-v1', 'POST', signedPath,
        timestamp, createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
    return new Request('https://os.example.com' + path, { method: 'POST', body,
        headers: { 'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature } });
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(time); vi.stubEnv('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', key); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.clearAllMocks(); });
describe('closed image-rebase HMAC route', () => {
    it('runs real plan and prepare with a bounded response and immutable job', async () => {
        const s = rebaseSetup(); for (const [k, v] of Object.entries(s.env)) vi.stubEnv(k, v);
        mocks.execute.mockImplementation(s.fake.db.execute); mocks.transaction.mockImplementation(s.fake.db.transaction);
        mocks.collaborators.mockReturnValue(s.deps);
        for (const operation of ['plan', 'prepare']) {
            const response = await POST(request(JSON.stringify({ schemaVersion: 1, operation, computerId: s.source.computerId, jobId: null })));
            expect(response.status).toBe(operation === 'plan' ? 200 : 202);
            const data = await response.json(); expect(Object.keys(data)).toEqual(['schemaVersion', 'computerId', 'jobId', 'phase', 'eligible', 'failureCode']);
            expect(JSON.stringify(data)).not.toMatch(/nonce|document|userData/); expect(response.headers.get('cache-control')).toBe('no-store');
        }
    });
    it.each(['duplicate', 'unknown', 'oversize', 'wrong-path', 'stale', 'recover-no-job'])('refuses %s before dependencies', async mode => {
        const base = { schemaVersion: 1, operation: 'plan', computerId: '11111111-1111-4111-8111-111111111111', jobId: null };
        let body = JSON.stringify(base);
        if (mode === 'duplicate') body = body.replace('"operation":"plan"', '"operation":"prepare","operation":"plan"');
        if (mode === 'unknown') body = JSON.stringify({ ...base, manifest: {} });
        if (mode === 'oversize') body += ' '.repeat(4096);
        if (mode === 'recover-no-job') body = JSON.stringify({ ...base, operation: 'recover' });
        const response = await POST(request(body, mode === 'wrong-path' ? '/api/internal/computers/lifecycle-authority' : path,
            mode === 'stale' ? '1' : undefined));
        expect(response.status).toBe(403); expect(mocks.collaborators).not.toHaveBeenCalled();
    });
});

describe('reconcile-replacement on the same signed route', () => {
    it('settles the canary-shaped failed replace through the real handler with read-only readers and no starter', async () => {
        const { historicalSourceSetup } = await import('@/server/lib/compute/aws-historical-source.test-support');
        const s = await historicalSourceSetup();
        vi.stubEnv('AWS_REGIONS', s.deployment.region);
        vi.stubEnv('EZIL_AWS_LIFECYCLE_DEPLOYMENTS', JSON.stringify({ [s.deployment.region]: s.deployment }));
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_WORKER_URL', 'https://worker.example.com');
        vi.stubEnv('CLOUDFLARE_GUACAMOLE_HMAC_SECRET', 'c'.repeat(64));
        mocks.execute.mockImplementation(s.db.execute); mocks.transaction.mockImplementation(s.db.transaction);
        mocks.collaborators.mockReturnValue({ executions: s.executions, describer: s.describer });
        mocks.tunnels.mockReturnValue(s.tunnels);
        const response = await POST(request(JSON.stringify(s.request)));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ schemaVersion: 1, computerId: s.request.computerId, jobId: s.request.expectedJobId, outcome: 'settled' });
        expect(s.placements[0]).toMatchObject({ state: 'STOPPED', generation: s.stopped.generation, lease_epoch: s.replace.intent.leaseEpoch, lifecycle_job_id: null });
        expect(s.starts).toHaveLength(1);
        const replay = await POST(request(JSON.stringify(s.request)));
        expect((await replay.json()).outcome).toBe('not_applicable');
    });
    it.each(['extra field', 'missing job', 'two hints', 'oversize hint'])('refuses a malformed reconcile body (%s) before dependencies', async mode => {
        const base = { schemaVersion: 1, operation: 'reconcile-replacement', computerId: '11111111-1111-4111-8111-111111111111',
            expectedJobId: '22222222-2222-4222-8222-222222222222', sourceRetirementExecutionArn: 'arn:aws:states:ap-south-1:123456789012:execution:ezil-mum-lifecycle:computer-33333333-3333-4333-8333-333333333333' };
        const body = mode === 'extra field' ? { ...base, jobId: null } : mode === 'missing job' ? { ...base, expectedJobId: undefined }
            : mode === 'two hints' ? { ...base, sourceRetirementExecutionArns: [base.sourceRetirementExecutionArn] } : { ...base, sourceRetirementExecutionArn: 'a'.repeat(301) };
        const response = await POST(request(JSON.stringify(body)));
        expect(response.status).toBe(403); expect(mocks.collaborators).not.toHaveBeenCalled();
    });
    it('an unsigned or wrongly signed reconcile request never reaches dependencies', async () => {
        const body = JSON.stringify({ schemaVersion: 1, operation: 'reconcile-replacement', computerId: '11111111-1111-4111-8111-111111111111',
            expectedJobId: '22222222-2222-4222-8222-222222222222', sourceRetirementExecutionArn: 'x' });
        const response = await POST(request(body, '/api/internal/computers/lifecycle-authority'));
        expect(response.status).toBe(403); expect(mocks.collaborators).not.toHaveBeenCalled();
    });
});
