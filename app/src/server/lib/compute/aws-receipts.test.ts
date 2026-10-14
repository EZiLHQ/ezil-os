/**
 * Lifecycle receipts (aws-receipts.ts) through the provider's `status`, against
 * the fake placement database, a scripted Step Functions reader and a recording
 * GW-1 client. No network. Ends with one full walk: provision → enroll →
 * RUNNING → stop → STOPPED (tunnel fenced) → wake by replace → enroll → RUNNING.
 */

import { describe, expect, it } from 'vitest';

import { createAwsEc2Provider, type LifecycleStarter } from './aws-ec2';
import { handleAwsEnrollment, nonceHashOf, type Ec2EnrollmentView, type TunnelClient } from './aws-enroll';
import { AWS_IDENTITY_CERTS_ENV } from './aws-identity';
import { LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleIntent } from './aws-intent';
import { fixtureDeployment } from './aws-intent.test-support';
import fx from './aws-identity.fixtures.json';
import { lifecycleExecutionArn, lifecycleFailureCode, nextInstanceTypeAfterCapacity, type LifecycleExecutionReader } from './aws-receipts';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { PlacementOwnerError } from './placement';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
// After the identity fixture certificate's notBefore.
const NOW = new Date('2026-10-20T00:00:00Z');
const ctx = { correlationId: 'corr' };
const opts = { sessionId: 's', desktopMode: 'neko' } as const;
const TYPES = ['t3a.medium', 't3.medium', 'm6i.large'];
const D = fixtureDeployment('ap-south-1', TYPES);
const JOB = 'ababab00-abab-4bab-8bab-abababababab';
const DIGEST = 'd'.repeat(64);
const FENCE = 'fdfdfdfd-fdfd-4dfd-8dfd-fdfdfdfdfdfd';
const I_OLD = 'i-11111111111111111';
const I_NEW = 'i-22222222222222222'; // the identity fixture's instance
const VOL = 'vol-11111111111111111';
const NONCE_BYTES = Buffer.alloc(32, 3);
const NONCE = NONCE_BYTES.toString('base64url');

const env = (over: Record<string, string> = {}) => ({
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    AWS_MAX_RUNNING: '10',
    EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50',
    EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1',
    EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': D }),
    EZIL_AWS_ENROLL_URL: 'https://app.example.test/api/compute/aws/enroll',
    [AWS_IDENTITY_CERTS_ENV]: JSON.stringify({ 'ap-south-1': fx.cert_rsa }),
    ...over,
});

type Exec = { status: string; output?: string | null; error?: string | null; cause?: string | null };

function receiptOf(o: { jobId?: string; digest?: string; generation?: number; leaseEpoch?: number; fenceToken?: string; instanceId?: string; volumeId?: string; state?: string } = {}) {
    return JSON.stringify({
        schemaVersion: 1, jobId: JOB, digest: DIGEST, computerId: C1, generation: 2, leaseEpoch: 3, fenceToken: FENCE, instanceId: I_NEW, volumeId: VOL, state: 'running', ...o,
    });
}

/** A boot in progress: replace to generation 2, epoch 3, job JOB. */
const row = (over: Record<string, unknown> = {}) =>
    placementRow({
        computer_id: C1, owner_user_id: U1, state: 'STARTING', generation: 2, lease_epoch: 3, region: 'ap-south-1', zone_id: 'aps1-az1', instance_type: 't3a.medium',
        instance_id: I_OLD, volume_id: VOL, fs_uuid: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5', fence_token: FENCE, lifecycle_job_id: JOB, lifecycle_digest: DIGEST,
        enroll_nonce_hash: nonceHashOf(NONCE), enroll_expires_at: new Date(NOW.getTime() + 300_000), ...over,
    });

function setup(rows: Record<string, unknown>[], exec: Exec | ((arn: string) => Exec) | 'throw' = { status: 'RUNNING' }, opts: { noTunnels?: boolean } = {}) {
    const fake = createFakePlacementDb({ placements: rows, computers: [{ id: C1, user_id: U1 }] });
    const read: string[] = [];
    const executions: LifecycleExecutionReader = {
        async describe(region, arn) {
            read.push(`${region} ${arn}`);
            if (exec === 'throw') throw new Error('throttled');
            return typeof exec === 'function' ? exec(arn) : exec;
        },
    };
    const deleted: unknown[] = [];
    const created: unknown[] = [];
    const tunnels: TunnelClient = {
        createTunnel: async (_o, req) => (created.push(req), { ok: true, tunnelToken: 'tok-' + 'x'.repeat(30) }),
        deleteTunnel: async (o, req) => (deleted.push({ owner: o, req }), { ok: true }),
    };
    const starts: { region: string; intent: LifecycleIntent; digest: string; name: string }[] = [];
    const starter: LifecycleStarter = {
        async start(region, work) {
            const env_ = JSON.parse(work.input) as { document: string; digest: string };
            starts.push({ region, intent: JSON.parse(env_.document), digest: env_.digest, name: work.name });
        },
    };
    const provider = createAwsEc2Provider({
        db: fake.db, env: () => env(), now: () => NOW, newId: () => crypto.randomUUID(), starter, tierFor: async () => 'free',
        randomBytes: () => Buffer.from(NONCE_BYTES), executions, ...(opts.noTunnels ? {} : { tunnels }),
    });
    const status = () => provider.status(ctx, { userId: U1, computerId: C1 });
    return { ...fake, provider, status, read, deleted, created, starts, tunnels };
}

describe('the execution read', () => {
    it('reads exactly the placement job in its region (version ARN → execution under the machine)', async () => {
        const { status, read } = setup([row()]);
        await status();
        expect(read).toEqual([`ap-south-1 arn:aws:states:ap-south-1:123456789012:execution:ezil-pilot-lifecycle:computer-${JOB}`]);
        expect(lifecycleExecutionArn(D, JOB)).toBe(`arn:aws:states:ap-south-1:123456789012:execution:ezil-pilot-lifecycle:computer-${JOB}`);
    });

    it.each([
        ['still running', { status: 'RUNNING' }],
        ['describe failed', 'throw'],
    ] as const)('%s → nothing changes', async (_n, exec) => {
        const { status, placements } = setup([row()], exec as never);
        const before = { ...placements[0] };
        expect(await status()).toMatchObject({ state: 'starting', placementState: 'STARTING' });
        expect(placements[0]).toEqual(before);
    });

    it('no job recorded, or a settled state → no read at all', async () => {
        const a = setup([row({ lifecycle_job_id: null })]);
        await a.status();
        expect(a.read).toEqual([]);
        const b = setup([row({ state: 'STOPPED' })]);
        await b.status();
        expect(b.read).toEqual([]);
    });

    it("another user's placement: refused before any read", async () => {
        const { provider, read } = setup([row({ owner_user_id: U2 })], { status: 'SUCCEEDED', output: receiptOf() });
        await expect(provider.status(ctx, { userId: U1, computerId: C1 })).rejects.toBeInstanceOf(PlacementOwnerError);
        expect(read).toEqual([]);
    });
});

describe('boot receipts (provider says running)', () => {
    it('receipt before the host enrolled: STARTING → MOUNTING, instance + volume recorded, job cleared; still "starting"', async () => {
        const { status, placements } = setup([row()], { status: 'SUCCEEDED', output: receiptOf() });
        expect(await status()).toMatchObject({ state: 'starting', placementState: 'MOUNTING' });
        expect(placements[0]).toMatchObject({ instance_id: I_NEW, volume_id: VOL, lifecycle_job_id: null, lifecycle_digest: null });
    });

    it('then the host enrolls (nonce consumed) → next poll goes RUNNING without another read', async () => {
        const s = setup([row()], { status: 'SUCCEEDED', output: receiptOf() });
        await s.status();
        s.placements[0]!.enroll_nonce_hash = null;
        s.placements[0]!.enroll_expires_at = null;
        const reads = s.read.length;
        expect(await s.status()).toMatchObject({ ok: true, state: 'running', placementState: 'RUNNING' });
        expect(s.read).toHaveLength(reads);
    });

    it('receipt applied (job cleared) but the host has NOT enrolled: stays MOUNTING, no read, never RUNNING', async () => {
        const { status, read, placements } = setup([row({ state: 'MOUNTING', lifecycle_job_id: null, lifecycle_digest: null, instance_id: I_NEW })]);
        expect(await status()).toMatchObject({ state: 'starting', placementState: 'MOUNTING' });
        expect(placements[0]).toMatchObject({ state: 'MOUNTING' });
        expect(read).toEqual([]);
    });

    it('host enrolled first (instance recorded by enrollment): the receipt takes it straight to RUNNING', async () => {
        const { status, placements } = setup([row({ enroll_nonce_hash: null, enroll_expires_at: null, instance_id: I_NEW })], { status: 'SUCCEEDED', output: receiptOf() });
        expect(await status()).toMatchObject({ state: 'running', placementState: 'RUNNING' });
        expect(placements[0]).toMatchObject({ lifecycle_job_id: null });
    });

    it('a LEASED row whose start was accepted (provider crashed before STARTING) still lands', async () => {
        const { status } = setup([row({ state: 'LEASED' })], { status: 'SUCCEEDED', output: receiptOf() });
        expect(await status()).toMatchObject({ placementState: 'MOUNTING' });
    });

    it('provision: waits in PROVISIONING until enrolled, then RUNNING with the receipt instance and volume', async () => {
        const pending = setup([row({ state: 'PROVISIONING', generation: 1, lease_epoch: 1, instance_id: null, volume_id: null })], {
            status: 'SUCCEEDED', output: receiptOf({ generation: 1, leaseEpoch: 1 }),
        });
        expect(await pending.status()).toMatchObject({ placementState: 'PROVISIONING' });
        const done = setup([row({ state: 'PROVISIONING', generation: 1, lease_epoch: 1, instance_id: I_NEW, volume_id: VOL, enroll_nonce_hash: null, enroll_expires_at: null })], {
            status: 'SUCCEEDED', output: receiptOf({ generation: 1, leaseEpoch: 1 }),
        });
        expect(await done.status()).toMatchObject({ placementState: 'RUNNING', state: 'running' });
        expect(done.placements[0]).toMatchObject({ instance_id: I_NEW, volume_id: VOL, lifecycle_job_id: null });
    });
});

describe('receipts that do not match the job are conflicts (UNCONFIRMED, recovery decides)', () => {
    it.each([
        ['another job', receiptOf({ jobId: 'acacacac-acac-4cac-8cac-acacacacacac' })],
        ['another digest', receiptOf({ digest: 'e'.repeat(64) })],
        ['another generation', receiptOf({ generation: 1 })],
        ['another epoch', receiptOf({ leaseEpoch: 2 })],
        ['another fence', receiptOf({ fenceToken: 'fefefefe-fefe-4efe-8efe-fefefefefefe' })],
        ['another volume', receiptOf({ volumeId: 'vol-99999999999999999' })],
        ['stopped for a boot', receiptOf({ state: 'stopped' })],
        ['not JSON', '{'],
        ['extra field', JSON.stringify({ ...JSON.parse(receiptOf()), extra: 1 })],
    ])('%s', async (_n, output) => {
        const { status, placements } = setup([row()], { status: 'SUCCEEDED', output });
        expect(await status()).toMatchObject({ ok: false, state: 'error', placementState: 'UNCONFIRMED' });
        expect(placements[0]!.last_error).toMatch(/^receipt_(conflict|invalid)$/);
        // The job is kept for recovery.
        expect(placements[0]).toMatchObject({ lifecycle_job_id: JOB });
    });

    it('an enrolled boot whose receipt names a different instance than the host proved', async () => {
        const { status } = setup([row({ enroll_nonce_hash: null, instance_id: 'i-33333333333333333' })], { status: 'SUCCEEDED', output: receiptOf() });
        expect(await status()).toMatchObject({ placementState: 'UNCONFIRMED' });
    });
});

describe('stop receipts', () => {
    const stopping = (over: Record<string, unknown> = {}) => row({ state: 'STOPPING', instance_id: I_NEW, enroll_nonce_hash: null, enroll_expires_at: null, ...over });

    it('STOPPING → STOPPED, job cleared, and the generation tunnel is fenced (GW-1 DELETE)', async () => {
        const { status, placements, deleted } = setup([stopping()], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }) });
        expect(await status()).toMatchObject({ state: 'stopped', placementState: 'STOPPED' });
        expect(placements[0]).toMatchObject({ lifecycle_job_id: null });
        expect(deleted).toEqual([{ owner: { userId: U1 }, req: { computerId: C1, sandboxId: 'c1c1c1c1c1c14c1c', generation: 2, leaseEpoch: 3 } }]);
    });

    it('keeps a failed tunnel fence pending and retries on the next poll', async () => {
        const s = setup([stopping()], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }) });
        s.tunnels.deleteTunnel = async () => ({ ok: false, status: 502 });
        expect(await s.status()).toMatchObject({ placementState: 'STOPPING' });
        expect(s.placements[0]).toMatchObject({ lifecycle_job_id: JOB, lifecycle_digest: DIGEST });
        s.tunnels.deleteTunnel = async () => ({ ok: true });
        expect(await s.status()).toMatchObject({ placementState: 'STOPPED' });
        expect(s.placements[0]).toMatchObject({ lifecycle_job_id: null });
    });

    it('with no tunnel client, a stop still completes (nothing to fence)', async () => {
        const s = setup([stopping()], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }) }, { noTunnels: true });
        expect(await s.status()).toMatchObject({ placementState: 'STOPPED' });
        expect(s.deleted).toEqual([]);
    });

    it('DRAINING (start accepted, STOPPING not yet written) → STOPPING → STOPPED', async () => {
        const { status } = setup([stopping({ state: 'DRAINING' })], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }) });
        expect(await status()).toMatchObject({ placementState: 'STOPPED' });
    });

    it('a stop receipt naming another instance is a conflict, no fence call', async () => {
        const { status, deleted } = setup([stopping()], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped', instanceId: 'i-33333333333333333' }) });
        expect(await status()).toMatchObject({ placementState: 'UNCONFIRMED' });
        expect(deleted).toEqual([]);
    });
});

describe('failed executions', () => {
    it('a capacity refusal records capacity:<code>:<type>; ensure then answers capacity_unavailable (never another region)', async () => {
        const { status, placements, provider, starts } = setup([row()], { status: 'FAILED', error: 'LifecycleRefused', cause: 'InsufficientInstanceCapacity' });
        expect(await status()).toMatchObject({ placementState: 'UNCONFIRMED' });
        expect(placements[0]).toMatchObject({ last_error: 'capacity:InsufficientInstanceCapacity:t3a.medium', lifecycle_job_id: JOB });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toEqual({
            ok: false, error: 'capacity:InsufficientInstanceCapacity:t3a.medium', errorCode: 'capacity_unavailable', retryable: false,
        });
        expect(starts).toEqual([]);
    });

    it.each([
        ['an unconfirmed failure', { status: 'FAILED', error: 'LifecycleUnconfirmed', cause: 'lifecycle_volume_invalid' }, 'failed:LifecycleUnconfirmed'],
        ['a timeout', { status: 'TIMED_OUT' }, 'failed:TIMED_OUT'],
        ['an abort', { status: 'ABORTED' }, 'failed:ABORTED'],
    ])('%s → UNCONFIRMED %s', async (_n, exec, code) => {
        const { status, placements } = setup([row()], exec);
        await status();
        expect(placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: code });
    });

    it('lifecycleFailureCode sanitises and only trusts LifecycleRefused + a known capacity code', () => {
        expect(lifecycleFailureCode({ status: 'FAILED', error: 'LifecycleRefused', cause: 'VcpuLimitExceeded' }, 't3.medium')).toBe('capacity:VcpuLimitExceeded:t3.medium');
        expect(lifecycleFailureCode({ status: 'FAILED', error: 'LifecycleRefused', cause: 'Something else' }, 't3.medium')).toBe('failed:LifecycleRefused');
        expect(lifecycleFailureCode({ status: 'FAILED', error: 'Other', cause: 'InsufficientInstanceCapacity' }, null)).toBe('failed:Other');
        expect(lifecycleFailureCode({ status: 'FAILED', error: 'a b<script>' }, null)).toBe('failed:abscript');
    });

    it('nextInstanceTypeAfterCapacity: free falls back t3a.medium → t3.medium, then nothing; plus has no fallback', () => {
        expect(nextInstanceTypeAfterCapacity('free', 't3a.medium')).toBe('t3.medium');
        expect(nextInstanceTypeAfterCapacity('free', 't3.medium')).toBeNull();
        expect(nextInstanceTypeAfterCapacity('plus', 'm6i.large')).toBeNull();
        expect(nextInstanceTypeAfterCapacity('free', 'm6i.large')).toBeNull();
    });
});

describe('one computer, end to end (fake AWS; real admission, provider, enrollment and receipts)', () => {
    it('provision → enroll → RUNNING → stop → STOPPED (fenced) → wake by replace → enroll → RUNNING', async () => {
        // The scripted provider: every execution succeeds with the receipt its intent implies.
        const instanceFor = (i: LifecycleIntent) => (i.operation === 'provision' || i.operation === 'replace' ? I_NEW : i.providerInstanceId!);
        // The reader runs only after setup returned, so it may refer to `s`.
        const s: ReturnType<typeof setup> = setup([], (arn) => {
            const job = arn.split(':computer-')[1]!;
            const st = s.starts.find((x) => x.intent.jobId === job)!;
            const i = st.intent;
            return {
                status: 'SUCCEEDED',
                output: JSON.stringify({
                    schemaVersion: 1, jobId: i.jobId, digest: st.digest, computerId: i.computerId, generation: i.targetGeneration, leaseEpoch: i.leaseEpoch,
                    fenceToken: i.fenceToken, instanceId: instanceFor(i), volumeId: i.dataVolumeId ?? VOL, state: i.operation === 'stop' ? 'stopped' : 'running',
                }),
            };
        });
        const view = (): Ec2EnrollmentView => {
            const p = s.placements[0]!;
            const tags = {
                'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot', 'ezil:computer-id': C1, 'ezil:generation': String(p.generation), 'ezil:fence-token': String(p.fence_token),
            };
            return {
                instanceId: I_NEW, state: 'running', availabilityZone: 'ap-south-1a', availabilityZoneId: 'aps1-az1', publicIp: '13.0.0.5', tags,
                volumes: [{ volumeId: VOL, deleteOnTermination: false, tags }],
            };
        };
        const enroll = () =>
            handleAwsEnrollment(
                { db: s.db, env: env(), now: () => NOW, randomBytes: () => Buffer.alloc(32, 9), describer: { describeForEnrollment: async () => view() }, tunnels: s.tunnels },
                {
                    computerId: C1, generation: Number(s.placements[0]!.generation), leaseEpoch: Number(s.placements[0]!.lease_epoch), nonce: NONCE,
                    identityDocument: fx.document, signature: fx.pkcs7_rsa_detached,
                },
            );

        // 1. First open: provision (generation 1, epoch 1).
        expect(await s.provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'computer_starting' });
        expect(s.starts[0]!.intent).toMatchObject({ operation: 'provision', instanceType: 't3a.medium', leaseEpoch: 1 });
        expect((await enroll()).status).toBe(200);
        expect(await s.status()).toMatchObject({ state: 'running', placementState: 'RUNNING' });

        // 2. Stop (user or idle): stop intent with the generation's fence → STOPPED → tunnel fenced.
        await s.provider.stop(ctx, { userId: U1, computerId: C1 }, 'user');
        expect(s.starts[1]!.intent).toMatchObject({ operation: 'stop', fenceToken: s.starts[0]!.intent.fenceToken, providerInstanceId: I_NEW });
        expect(await s.status()).toMatchObject({ state: 'stopped', placementState: 'STOPPED' });
        expect(s.deleted).toHaveLength(1);

        // 3. Reopen: cold boot by replace on the SAME volume (generation 2, epoch 2).
        expect(await s.provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'computer_starting' });
        expect(s.starts[2]!.intent).toMatchObject({
            operation: 'replace', targetGeneration: 2, leaseEpoch: 2, dataVolumeId: VOL, previousGeneration: 1, previousInstanceId: I_NEW, previousFenceToken: s.starts[0]!.intent.fenceToken,
        });
        expect(await s.status()).toMatchObject({ placementState: 'MOUNTING' });
        expect((await enroll()).status).toBe(200);
        expect(await s.status()).toMatchObject({ state: 'running', placementState: 'RUNNING' });
        expect(s.placements[0]).toMatchObject({ generation: 2, lease_epoch: 2, volume_id: VOL, enroll_nonce_hash: null, lifecycle_job_id: null });
        // Every boot's tunnel was created once, for its own generation and epoch.
        expect(s.created).toMatchObject([{ generation: 1, leaseEpoch: 1 }, { generation: 2, leaseEpoch: 2 }]);
    });
});
