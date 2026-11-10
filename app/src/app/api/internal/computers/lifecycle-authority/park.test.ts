import { createHash, createHmac } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildLifecycleWork, type LifecycleWork } from '@/server/lib/compute/aws-intent';
import { fixtureDeployment } from '@/server/lib/compute/aws-intent.test-support';
import { NOW } from '@/server/lib/compute/aws-failed-release.test-support';
import { parkSetup } from '@/server/lib/compute/aws-failed-release-park.test-support';
import { POOL_PARK_RECOVERY_PREFIX, parkReplay, type ParkReplay } from '@/server/lib/compute/aws-failed-release-park';
import type { Row } from '@/server/lib/compute/fake-placement-db.test-support';

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/server/db', () => ({ db: { execute } }));
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
const { POST } = await import('./route');
const KEY = 'ab'.repeat(32), PATH = '/api/internal/computers/lifecycle-authority';
const OTHER = '11111111-1111-4111-8111-111111111112';
const authorityFor = (w: LifecycleWork) => ({ schemaVersion: 1, computerId: w.intent.computerId, jobId: w.intent.jobId, digest: w.digest, leaseEpoch: w.intent.leaseEpoch });
/** A signed request exactly as the workflow's observer sends it (same HMAC path and headers as the real caller). */
function request(w: LifecycleWork, patch: Row = {}) {
    const body = JSON.stringify({ ...authorityFor(w), ...patch }), timestamp = String(NOW.getTime() / 1000);
    const signature = createHmac('sha256', Buffer.from(KEY, 'hex')).update(['ezil-lifecycle-authority-v1', 'POST', PATH, timestamp,
        createHash('sha256').update(body).digest('hex')].join('\n')).digest('hex');
    return new Request('https://app.example.test' + PATH, { method: 'POST', body, headers: {
        'content-type': 'application/json', 'x-ezil-workflow-timestamp': timestamp, 'x-ezil-workflow-signature': signature } });
}
beforeEach(() => { vi.stubEnv('EZIL_AWS_LIFECYCLE_AUTHORITY_SECRET', KEY); vi.spyOn(Date, 'now').mockReturnValue(NOW.getTime()); });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

/** The REAL reservation writes the row and starts the stop; the route then answers the observer's callback for that job. */
async function parked() {
    const s = parkSetup();
    execute.mockImplementation(s.db.execute);
    expect(await s.reserve()).toEqual({ outcome: 'reserved', error: null });
    expect(s.starts).toHaveLength(1);
    return { ...s, work: s.starts[0]! };
}
type Parked = Awaited<ReturnType<typeof parked>>;
const document = (s: Parked): ParkReplay => JSON.parse(String(s.placements[0]!.last_error).slice(POOL_PARK_RECOVERY_PREFIX.length));
const save = (s: Parked, doc: unknown) => { s.placements[0]!.last_error = POOL_PARK_RECOVERY_PREFIX + JSON.stringify(doc); };
/** Rewrite the saved intent (and the placement's digest to match it), so only the tampering itself can make the route refuse. */
function retarget(s: Parked, intent: Record<string, unknown>) {
    const changed = buildLifecycleWork({ ...s.work.intent, ...intent } as LifecycleWork['intent']);
    save(s, { ...document(s), intent: changed.intent });
    s.placements[0]!.lifecycle_digest = changed.digest;
    return changed;
}

it('authorizes the ordinary STOP started by the real park reservation (exact answer, no-store) and never the failed release', async () => {
    const s = await parked();
    expect(s.work.intent.operation).toBe('stop');
    expect(s.work.intent.jobId).not.toBe(s.original.intent.jobId);
    const response = await POST(request(s.work));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ authorized: true, ...authorityFor(s.work) });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await POST(request(s.original))).status).toBe(403); // the failed release's job is no longer the placement's
});

it.each([['job', { jobId: OTHER }], ['digest', { digest: 'ef'.repeat(32) }], ['epoch', { leaseEpoch: 99 }], ['computer', { computerId: OTHER }]])
('refuses a park authority request with a mismatched %s', async (_name, patch) => {
    const s = await parked();
    expect((await POST(request(s.work, patch))).status).toBe(403);
});

it.each([
    ['job', { lifecycle_job_id: OTHER }], ['digest', { lifecycle_digest: 'ef'.repeat(32) }], ['epoch', { lease_epoch: 99 }],
    ['provider', { provider: 'cloudflare', workspace_store: 'r2' }], ['generation', { generation: 9 }], ['fence', { fence_token: OTHER }],
    ['instance', { instance_id: 'i-99999999999999999' }], ['volume', { volume_id: 'vol-99999999999999999' }], ['type', { instance_type: 'c6i.xlarge' }],
    ['region', { region: 'us-east-1' }], ['zone', { zone_id: 'aps1-az2' }],
    ['state UNCONFIRMED', { state: 'UNCONFIRMED' }], ['state STOPPED', { state: 'STOPPED' }], ['state RUNNING', { state: 'RUNNING' }],
])('refuses a park placement with a mismatched %s', async (_name, patch) => {
    const s = await parked();
    Object.assign(s.placements[0]!, patch);
    expect((await POST(request(s.work))).status).toBe(403);
});

it.each([
    ['a release', { operation: 'release' }], ['a retire', { operation: 'retire' }], ['a start', { operation: 'start' }],
    ['a non-pool deployment', { deployment: fixtureDeployment('ap-south-1') }],
    ['another job than the placement\'s', { jobId: OTHER }],
    ['carried user data', { userData: 'x' }], ['a previous generation', { previousGeneration: 1 }],
    ['a previous instance', { previousInstanceId: 'i-99999999999999999' }], ['a previous fence', { previousFenceToken: OTHER }],
])('refuses a park document whose saved intent is %s', async (_name, intent) => {
    const s = await parked();
    let changed: LifecycleWork;
    try { changed = retarget(s, intent); }
    catch { // an intent the schema itself refuses can never be saved with a digest at all
        save(s, { ...document(s), intent: { ...s.work.intent, ...intent } });
        expect((await POST(request(s.work))).status).toBe(403);
        return;
    }
    // Authorizing "the job named by the saved document" must still fail: only an ordinary current stop qualifies.
    expect((await POST(request(changed))).status).toBe(403);
    if ((intent as Record<string, unknown>).jobId !== undefined) expect((await POST(request(s.work))).status).toBe(403);
});

it.each([
    ['source job equal to the new stop job', (d: ParkReplay, s: Parked) => ({ ...d, sourceJobId: s.work.intent.jobId })],
    ['source job not a uuid', (d: ParkReplay) => ({ ...d, sourceJobId: 'not-a-job' })],
    ['source digest equal to the new stop digest', (d: ParkReplay, s: Parked) => ({ ...d, sourceDigest: s.work.digest })],
    ['malformed source digest', (d: ParkReplay) => ({ ...d, sourceDigest: 'abc' })],
    ['source execution of another job', (d: ParkReplay) => ({ ...d, sourceExecutionArn: d.sourceExecutionArn.replace(d.sourceJobId, OTHER) })],
    ['source execution of another state machine', (d: ParkReplay) => ({ ...d, sourceExecutionArn: d.sourceExecutionArn.replace('ezil-mum-lifecycle', 'ezil-blr-lifecycle') })],
    ['source version of another state machine', (d: ParkReplay) => ({ ...d, sourceStateMachineVersionArn: d.sourceStateMachineVersionArn.replace('ezil-mum-lifecycle', 'ezil-blr-lifecycle') })],
    ['malformed snapshot id (tampered backup proof)', (d: ParkReplay) => ({ ...d, snapshotId: 'snap-xyz' })],
    ['missing snapshot id', (d: ParkReplay) => ({ ...d, snapshotId: '' })],
    ['unparseable physical stop time', (d: ParkReplay) => ({ ...d, hostStoppedAt: 'never' })],
    ['physical stop before the failed release began', (d: ParkReplay) => ({ ...d, hostStoppedAt: new Date(Date.parse(d.sourceStartedAt) - 1000).toISOString() })],
    ['source interval reversed', (d: ParkReplay) => ({ ...d, sourceStoppedAt: new Date(Date.parse(d.sourceStartedAt) - 1000).toISOString() })],
    ['missing intent', (d: ParkReplay) => ({ ...d, intent: undefined })],
])('refuses a tampered park proof binding: %s', async (_name, mutate) => {
    const s = await parked();
    save(s, mutate(document(s), s));
    expect((await POST(request(s.work))).status).toBe(403);
});

it.each([null, 'failed:LifecycleUnconfirmed', 'image_recovery', 'deleted_recovery', 'pool_park_recovery:{', 'pool_park_recovery:null', 'pool_park_recovery:{}',
    'pool_park_recovery:{"v":1,"intent":{}}'])('refuses a RECOVERING row without a valid park document %j', async last_error => {
    const s = await parked();
    s.placements[0]!.last_error = last_error;
    expect((await POST(request(s.work))).status).toBe(403);
});

it('does not turn the park prefix into authority for a release: a park-prefixed row never answers as the release replay and vice versa', async () => {
    const s = await parked();
    const doc = document(s);
    // The same saved release-shaped document under the park prefix is refused (operation must be stop)...
    const asRelease = retarget(s, { operation: 'release' });
    expect((await POST(request(asRelease))).status).toBe(403);
    // ...and a stop document under the release replay prefix stays refused by the existing guard.
    const stop = buildLifecycleWork(doc.intent);
    s.placements[0]!.last_error = 'pool_release_recovery:' + JSON.stringify({ intent: stop.intent, stoppedAt: NOW.toISOString(), sourceJobId: s.original.intent.jobId, error: null });
    s.placements[0]!.lifecycle_digest = stop.digest;
    expect((await POST(request(stop))).status).toBe(403);
});

it.each(['deleted', 'missing', 'owner'] as const)('refuses a %s computer even with a valid park document', async kind => {
    const s = await parked();
    if (kind === 'missing') s.computers.length = 0;
    else if (kind === 'deleted') s.computers[0]!.deleted_at = NOW;
    else s.computers[0]!.user_id = OTHER;
    expect((await POST(request(s.work))).status).toBe(403);
});

it('refuses while an image reservation exists for the computer (ImageJobConflictError is a refusal, not a 503)', async () => {
    const s = await parked();
    s.placements[0]!.image_upgrade_job_id = OTHER;
    expect((await POST(request(s.work))).status).toBe(403);
});

it('the reservation row is exactly what the validator reads: parkReplay of the written row parses and matches the started stop', async () => {
    const s = await parked();
    const written = parkReplay((await s.current()));
    expect(written?.intent.jobId).toBe(s.work.intent.jobId);
    expect(written?.sourceJobId).toBe(s.original.intent.jobId);
});
