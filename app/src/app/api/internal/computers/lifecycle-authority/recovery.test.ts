import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildLifecycleWork, type LifecycleWork } from '@/server/lib/compute/aws-intent';
import { fixtureDeployment, fixtureIntent } from '@/server/lib/compute/aws-intent.test-support';
import { reconcilePoolReleaseRecovery } from '@/server/lib/compute/aws-pool-release-recovery';
import { lifecycleExecutionArn, type ReceiptDeps } from '@/server/lib/compute/aws-receipts';
import { createFakePlacementDb, DEFAULT_OWNER, placementRow, type Row } from '@/server/lib/compute/fake-placement-db.test-support';
import { readPlacement } from '@/server/lib/compute/placement';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/server/db', () => ({ db: { execute } }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
const { POST } = await import('./route');
const KEY = 'ab'.repeat(32), PATH = '/api/internal/computers/lifecycle-authority';
const NOW = new Date('2026-10-24T12:05:00Z');
const D = { ...fixtureDeployment('ap-south-1'), namespace: 'mum',
    stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-mum-lifecycle:1' };
const OTHER = '11111111-1111-4111-8111-111111111112';
const authorityFor = (w: LifecycleWork) => ({ schemaVersion: 1, computerId: w.intent.computerId,
    jobId: w.intent.jobId, digest: w.digest, leaseEpoch: w.intent.leaseEpoch });
function request(w: LifecycleWork, patch: Row = {}) {
    const body = JSON.stringify({ ...authorityFor(w), ...patch }), timestamp = String(NOW.getTime() / 1000);
    const signature = createHmac('sha256', Buffer.from(KEY, 'hex')).update([
        'ezil-lifecycle-authority-v1', 'POST', PATH, timestamp, createHash('sha256').update(body).digest('hex'),
    ].join('\n')).digest('hex');
    return new Request('https://app.example.test' + PATH, { method: 'POST', body, headers: {
        'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature,
    } });
}
beforeEach(() => {
    vi.stubEnv('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', KEY);
    vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime());
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

async function recover(operation: 'stop' | 'release' = 'release') {
    const original = buildLifecycleWork({ ...fixtureIntent('stop'), operation, deployment: D }), i = original.intent;
    const computers = [{ id: i.computerId, user_id: DEFAULT_OWNER, deleted_at: null as Date | null }];
    const fake = createFakePlacementDb({ computers,
        placements: [placementRow({ computer_id: i.computerId, state: 'UNCONFIRMED', generation: i.targetGeneration,
            lease_epoch: i.leaseEpoch, region: D.region, zone_id: D.zoneId, instance_type: i.instanceType,
            instance_id: i.providerInstanceId, volume_id: i.dataVolumeId, fence_token: i.fenceToken,
            lifecycle_job_id: i.jobId, lifecycle_digest: original.digest })] }, { clock: () => NOW });
    execute.mockImplementation(fake.db.execute);
    const tags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': D.namespace,
        'ezil:computer-id': i.computerId, 'ezil:generation': String(i.targetGeneration), 'ezil:fence-token': i.fenceToken };
    const starts: LifecycleWork[] = [], responses: Response[] = [];
    const deps: ReceiptDeps = { db: fake.db, now: () => NOW, sleep: async () => {},
        executions: { describe: async () => ({ status: 'FAILED', input: original.input, redriveCount: 0,
            executionArn: lifecycleExecutionArn(D, i.jobId), stateMachineVersionArn: original.stateMachineArn,
            startDate: new Date(NOW.getTime() - 60000), stopDate: new Date(NOW.getTime() - 30000) }) },
        describer: {
            describeVolume: async () => ({ volumeId: i.dataVolumeId!, state: 'in-use', encrypted: true,
                kmsKeyId: D.dataKeyArn, zoneId: D.zoneId, tags,
                attachments: [{ instanceId: i.providerInstanceId!, state: 'attached' }] }),
            describeForEnrollment: async () => ({ instanceId: i.providerInstanceId!, state: 'stopped', instanceType: i.instanceType,
                availabilityZone: 'ap-south-1a', availabilityZoneId: D.zoneId, publicIp: null, tags, rootDeviceName: '/dev/sda1',
                volumes: [{ volumeId: 'vol-22222222222222222', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} },
                    { volumeId: i.dataVolumeId!, deviceName: '/dev/sdf', deleteOnTermination: false, tags }] }),
        },
        starter: { start: async (_region, input) => {
            const work = buildLifecycleWork(JSON.parse(JSON.parse(input.input).document));
            starts.push(work);
            // First authority observation uses the actual StartExecution input and
            // the placement written by the real reservation CAS, before start returns.
            responses.push(await POST(request(work)));
        } },
    };
    expect(await reconcilePoolReleaseRecovery(deps, (await readPlacement(fake.db, i.computerId)).record!, D)).toBe(true);
    expect(starts).toHaveLength(1);
    return { ...fake, computers, work: starts[0]!, response: responses[0]!, original };
}

it.each(['stop', 'release'] as const)('authorizes the release job started by real %s recovery', async operation => {
    const s = await recover(operation);
    expect(s.placements[0].state).toBe('RECOVERING');
    expect(s.work.intent.operation).toBe('release');
    expect(s.work.intent.jobId).not.toBe(s.original.intent.jobId);
    expect(s.response.status).toBe(200);
    expect(await s.response.json()).toEqual({ authorized: true, ...authorityFor(s.work) });
    expect(s.response.headers.get('cache-control')).toBe('no-store');
    expect((await POST(request(s.original))).status).toBe(403);
});

it.each([
    ['job', { jobId: OTHER }], ['digest', { digest: 'ef'.repeat(32) }],
    ['epoch', { leaseEpoch: 99 }], ['computer', { computerId: OTHER }],
])('refuses recovery request with mismatched %s', async (_name, patch) => {
    const s = await recover();
    expect((await POST(request(s.work, patch))).status).toBe(403);
});
it.each([
    ['job', { lifecycle_job_id: OTHER }], ['digest', { lifecycle_digest: 'ef'.repeat(32) }],
    ['epoch', { lease_epoch: 99 }], ['computer', { computer_id: OTHER }],
    ['provider', { provider: 'cloudflare', workspace_store: 'r2' }], ['generation', { generation: 9 }],
    ['fence', { fence_token: OTHER }], ['instance', { instance_id: 'i-99999999999999999' }],
    ['volume', { volume_id: 'vol-99999999999999999' }], ['type', { instance_type: 'c6i.xlarge' }],
    ['region', { region: 'us-east-1' }], ['zone', { zone_id: 'aps1-az2' }],
    ['unconfirmed', { state: 'UNCONFIRMED' }], ['stopped', { state: 'STOPPED' }],
])('refuses recovery placement with mismatched %s', async (_name, patch) => {
    const s = await recover(); Object.assign(s.placements[0], patch);
    expect((await POST(request(s.work))).status).toBe(403);
});
it.each([null, 'image_recovery', 'deleted_recovery', 'pool_release_recovery:{',
    'pool_release_recovery:null', 'pool_release_recovery:{}', 'pool_release_recovery:{"intent":{}}'])
('refuses non-live or invalid recovery replay %j', async last_error => {
    const s = await recover(); s.placements[0].last_error = last_error;
    expect((await POST(request(s.work))).status).toBe(403);
});
it.each(['deleted', 'missing', 'owner'] as const)('refuses %s computer even with valid recovery replay', async kind => {
    const s = await recover();
    if (kind === 'missing') s.computers.length = 0;
    else if (kind === 'deleted') s.computers[0].deleted_at = NOW;
    else s.computers[0].user_id = OTHER;
    expect((await POST(request(s.work))).status).toBe(403);
});
it.each(['stop', 'non-pool', 'different-replay'] as const)('refuses %s replay despite matching request/placement', async kind => {
    const s = await recover();
    const changed = buildLifecycleWork({ ...s.work.intent,
        ...(kind === 'stop' ? { operation: 'stop' as const } : kind === 'non-pool'
            ? { deployment: fixtureDeployment('ap-south-1') } : { jobId: OTHER }) });
    const saved = JSON.parse(String(s.placements[0].last_error).slice('pool_release_recovery:'.length));
    s.placements[0].last_error = 'pool_release_recovery:' + JSON.stringify({ ...saved, intent: changed.intent });
    if (kind !== 'different-replay') s.placements[0].lifecycle_digest = changed.digest;
    expect((await POST(request(kind === 'different-replay' ? s.work : changed))).status).toBe(403);
});
