/**
 * Lifecycle receipts (aws-receipts.ts) through the provider's `status`, against
 * the fake placement database, a scripted Step Functions reader and a recording
 * GW-1 client. No network. Ends with one full walk: provision → enroll →
 * RUNNING → stop → STOPPED (tunnel fenced) → wake by replace → enroll → RUNNING.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { billingComputeMeter, type ComputeMeter } from '@/server/billing/v2/compute-meter';
import { readBillingConfig } from '@/server/billing/config';
import type { BillingStore } from '@/server/billing/ports';

vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('Inject billing deps'); }) }));
afterEach(() => vi.restoreAllMocks());

import { createAwsEc2Provider, type LifecycleStarter } from './aws-ec2';
import { handleAwsEnrollment, nonceHashOf, type Ec2EnrollmentView, type TunnelClient } from './aws-enroll';
import { AWS_IDENTITY_CERTS_ENV } from './aws-identity';
import { buildLifecycleWork, currentGenerationIntent, LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleIntent } from './aws-intent';
import { fixtureDeployment } from './aws-intent.test-support';
import fx from './aws-identity.fixtures.json';
import {
    applyLifecycleReceipt, FLEET_RECONCILE_LIMIT, reconcileGuestStop, startRetireAsReconciler, lifecycleExecutionArn, lifecycleFailureCode, nextInstanceTypeAfterCapacity, reconcileAwsFleet, reconcileDeletedAwsComputers, recoverDeletedAwsPlacement,
    runAwsBackgroundReconcile, runAwsStopSettlement, sessionLimitFor, enforceSessionLimits, type GuestStopDeps, type LifecycleExecutionReader,
} from './aws-receipts';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import {
    consumeEnrollmentNonce, finishEnrollment, ENROLLMENT_FAILED, ENROLLMENT_PENDING, ENROLLMENT_SUCCEEDED, claimAwsPlacementsPendingRetire, INSTANCE_LOST, PlacementOwnerError, readPlacement, RETIRE_PENDING_STATES,
} from './placement';
import { monthUsageFromRows } from './usage';
import { requestAwsPreview } from './aws-preview';
import { awsPreviewAnswer, awsStatusAnswer } from '@/server/api/routers/compute-dispatch';

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
    EZIL_AWS_BROWSER_ZONE: 'ezil.org',
    ...over,
});

type Exec = { status: string; output?: string | null; error?: string | null; cause?: string | null; startDate?: Date | null; stopDate?: Date | null };

function receiptOf(o: { jobId?: string; digest?: string; generation?: number; leaseEpoch?: number; fenceToken?: string; instanceId?: string; volumeId?: string; state?: string; instanceLost?: true } = {}) {
    return JSON.stringify({
        schemaVersion: 1, jobId: JOB, digest: DIGEST, computerId: C1, generation: 2, leaseEpoch: 3, fenceToken: FENCE, instanceId: I_NEW, volumeId: VOL, state: 'running', ...o,
    });
}

/** A boot in progress: replace to generation 2, epoch 3, job JOB. */
const row = (over: Record<string, unknown> = {}) =>
    placementRow({
        computer_id: C1, owner_user_id: U1, state: 'STARTING', generation: 2, lease_epoch: 3, region: 'ap-south-1', zone_id: 'aps1-az1', instance_type: 't3a.medium',
        instance_id: null, volume_id: VOL, fs_uuid: 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5', fence_token: FENCE, lifecycle_job_id: JOB, lifecycle_digest: DIGEST,
        enroll_nonce_hash: nonceHashOf(NONCE), enroll_expires_at: new Date(NOW.getTime() + 300_000),
        // A wake always leases (aws-ec2.ts): an hour from the scenario clock.
        lease_until: new Date(NOW.getTime() + 3_600_000), ...over,
    });

function setup(rows: Record<string, unknown>[], exec: Exec | ((arn: string) => Exec) | 'throw' = { status: 'RUNNING' }, opts: { noTunnels?: boolean; usage?: Record<string, unknown>[]; meter?: ComputeMeter } = {}) {
    // The database clock is the scenario clock: usage rows are dated by it.
    const fake = createFakePlacementDb({ placements: rows, computers: [{ id: C1, user_id: U1 }], usage: opts.usage }, { clock: () => NOW });
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
        randomBytes: () => Buffer.from(NONCE_BYTES), executions, meter: opts.meter, ...(opts.noTunnels ? {} : { tunnels }),
    });
    const status = () => provider.status(ctx, { userId: U1, computerId: C1 });
    const enroll = () => {
        const p = fake.placements[0]!;
        const tags = {
            'ezil:managed-by': 'app-computer-platform', 'ezil:stage': 'pilot', 'ezil:computer-id': C1,
            'ezil:generation': String(p.generation), 'ezil:fence-token': String(p.fence_token),
        };
        return handleAwsEnrollment(
            {
                db: fake.db, env: env(), now: () => NOW, tunnels, controlKeySecret: 'control-key-secret-for-tests',
                describer: { describeForEnrollment: async () => ({
                    instanceId: I_NEW, state: 'running', availabilityZone: 'ap-south-1a', availabilityZoneId: 'aps1-az1',
                    publicIp: '13.0.0.5', tags, volumes: [{ volumeId: VOL, deleteOnTermination: false, tags }],
                }) },
            },
            {
                computerId: C1, generation: Number(p.generation), leaseEpoch: Number(p.lease_epoch), nonce: NONCE,
                identityDocument: fx.document, signature: fx.pkcs7_rsa_detached,
            },
        );
    };
    return { ...fake, provider, status, enroll, read, deleted, created, starts, tunnels, executions };
}

describe('minute stop settlement', () => {
    const pending = (over: Record<string, unknown> = {}) => row({ state: 'STOPPING', instance_id: I_NEW,
        enroll_nonce_hash: null, enroll_expires_at: null, last_error: 'lease_expired', ...over });
    const stoppedAt = new Date(NOW.getTime() - 42_000);
    const success = { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }), stopDate: stoppedAt };
    const usage = () => [{ computer_id: C1, user_id: U1, instance_id: I_NEW, instance_type: 't3a.medium',
        started_at: new Date(NOW.getTime() - 3_600_000), stopped_at: null, egress_bytes: null, observed_by: 'receipt', updated_at: NOW }];
    const run = (s: ReturnType<typeof setup>) => runAwsStopSettlement(env(), { db: s.db, executions: s.executions, tunnels: s.tunnels });

    it('settles a SUCCEEDED stop, fences the tunnel, clears the job, closes usage and meters the execution stop time exactly once', async () => {
        const meter = { ready: vi.fn(), stopped: vi.fn(), heartbeat: vi.fn() };
        const s = setup([pending()], success, { usage: usage() });
        const pass = () => runAwsStopSettlement(env(), { db: s.db, executions: s.executions, tunnels: s.tunnels, meter });
        expect(await pass()).toEqual({ ok: true, checked: 1, settled: 1 });
        expect(s.placements[0]).toMatchObject({ state: 'STOPPED', lifecycle_job_id: null, lifecycle_digest: null,
            last_error: null, volume_id: VOL, generation: 2, lease_epoch: 3 });
        expect(s.deleted).toEqual([{ owner: { userId: U1 }, req: { computerId: C1,
            sandboxId: expect.any(String), generation: 2, leaseEpoch: 3 } }]);
        expect(s.usage[0]).toMatchObject({ stopped_at: NOW, observed_by: 'lifecycle-receipt' });
        expect(meter.stopped).toHaveBeenCalledExactlyOnceWith({ userId: U1, computerId: C1, endedAt: stoppedAt, reason: 'provider_stop' });
        expect(await pass()).toEqual({ ok: true, checked: 0, settled: 0 });
        expect(s.read).toHaveLength(1);
        expect(s.deleted).toHaveLength(1);
        expect(meter.stopped).toHaveBeenCalledTimes(1);
        expect(s.starts).toEqual([]);
    });

    it('settles a successful retire through the same fence and receipt path', async () => {
        const s = setup([pending({ state: 'RETIRING' })], { status: 'SUCCEEDED', output: receiptOf({ state: 'retired' }) });
        expect(await run(s)).toEqual({ ok: true, checked: 1, settled: 1 });
        expect(s.placements[0]).toMatchObject({ state: 'RETIRED', lifecycle_job_id: null, lifecycle_digest: null, volume_id: VOL });
        expect(s.deleted).toHaveLength(1);
    });

    it.each(['RUNNING', 'PENDING_REDRIVE', 'throw'])('leaves an execution with status/error %s pending', async status => {
        const s = setup([pending()], status === 'throw' ? 'throw' : { status }, { usage: usage() });
        const before = { ...s.placements[0] };
        expect(await run(s)).toEqual({ ok: true, checked: 1, settled: 0 });
        expect(s.placements[0]).toEqual({ ...before, reconciled_at: NOW });
        expect(s.deleted).toEqual([]);
        expect(s.usage[0]!.stopped_at).toBeNull();
    });

    it('does not undo or restart an absent execution after the unknown-start window', async () => {
        const s = setup([pending({ last_error: 'lifecycle_start_unknown:RUNNING', updated_at: new Date(NOW.getTime() - 600_000) })]);
        const before = { ...s.placements[0] };
        s.executions.describe = vi.fn().mockRejectedValue(Object.assign(new Error('missing'), {
            name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 },
        }));
        expect(await runAwsStopSettlement(env(), { db: s.db, executions: s.executions, tunnels: s.tunnels, clock: () => NOW }))
            .toEqual({ ok: true, checked: 1, settled: 0 });
        expect(s.placements[0]).toEqual({ ...before, reconciled_at: NOW });
        expect(s.deleted).toEqual([]);
        expect(s.starts).toEqual([]);
    });

    it('retries a failed tunnel fence before closing usage or clearing the stop job', async () => {
        const s = setup([pending()], success, { usage: usage() });
        const fence = vi.spyOn(s.tunnels, 'deleteTunnel').mockResolvedValueOnce({ ok: false });
        expect(await run(s)).toMatchObject({ checked: 1, settled: 0 });
        expect(s.placements[0]).toMatchObject({ state: 'STOPPING', lifecycle_job_id: JOB, lifecycle_digest: DIGEST });
        expect(s.usage[0]!.stopped_at).toBeNull();
        expect(await run(s)).toMatchObject({ settled: 1 });
        expect(fence).toHaveBeenCalledTimes(2);
        expect(s.usage[0]!.stopped_at).toEqual(NOW);
    });

    it.each(['FAILED', 'TIMED_OUT', 'ABORTED'])('uses existing failure settlement for a terminal %s execution', async status => {
        const s = setup([pending()], { status });
        expect(await run(s)).toMatchObject({ checked: 1, settled: 0 });
        expect(s.placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: `failed:${status}` });
        expect(s.deleted).toEqual([]);
    });

    it('filters other placement states before describing or enforcing expired leases/caps', async () => {
        const s = setup(['RUNNING', 'STARTING', 'UNCONFIRMED'].map((state, i) => pending({ state,
            computer_id: `c0c0c0c0-c0c0-4c0c-8c0c-${String(i).padStart(12, '0')}`, lease_until: new Date(0) })));
        expect(await run(s)).toEqual({ ok: true, checked: 0, settled: 0 });
        expect(s.read).toEqual([]);
        expect(s.statements.some(s => s.sql.includes('usage-month'))).toBe(false);
        expect(s.starts).toEqual([]);
    });

    it('bounds each pass to 20 claims and reaches a stop behind unresolved jobs on the next pass', async () => {
        const rows = Array.from({ length: 25 }, (_, i) => pending({
            computer_id: `c0c0c0c0-c0c0-4c0c-8c0c-${String(i).padStart(12, '0')}`,
            lifecycle_job_id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`,
        }));
        rows.push(pending());
        const s = setup(rows, arn => arn.endsWith(JOB) ? success : { status: 'RUNNING' });
        expect(await run(s)).toEqual({ ok: true, checked: 20, settled: 0 });
        expect(s.read).toHaveLength(20);
        expect(s.placements.filter(p => p.reconciled_at !== null)).toHaveLength(20);
        expect(await run(s)).toEqual({ ok: true, checked: 20, settled: 1 });
        expect(s.placements.at(-1)).toMatchObject({ state: 'STOPPED' });
    });

    it('skips without touching the database when AWS is disabled, configuration is invalid, or the reader is absent', async () => {
        const s = setup([pending()]);
        for (const [environment, executions, skipped] of [
            [env({ EZIL_AWS_COMPUTERS_ENABLED: '0' }), s.executions, 'aws_disabled'],
            [env({ AWS_REGIONS: '' }), s.executions, 'aws_config_invalid'],
            [env({ [LIFECYCLE_DEPLOYMENTS_ENV]: '{}' }), s.executions, 'aws_config_invalid'],
            [env(), undefined, 'aws_executions_unconfigured'],
        ] as const) {
            expect(await runAwsStopSettlement(environment, { db: s.db, executions })).toEqual({ ok: true, skipped });
        }
        expect(s.statements).toEqual([]);
    });

    it('honors cancellation before claiming and between rows', async () => {
        const s = setup([pending(), pending({ computer_id: U2 })]);
        const controller = new AbortController();
        const pass = () => runAwsStopSettlement(env(), { db: s.db, executions: s.executions, signal: controller.signal });
        s.executions.describe = vi.fn(async () => { controller.abort(); return { status: 'RUNNING' }; });
        expect(await pass()).toEqual({ ok: true, checked: 1, settled: 0 });
        expect(s.executions.describe).toHaveBeenCalledTimes(1);
        const statementCount = s.statements.length;
        expect(await pass()).toEqual({ ok: true, checked: 0, settled: 0 });
        expect(s.statements).toHaveLength(statementCount);
    });
});

describe('billing v2 observations', () => {
    const meter = () => ({ ready: vi.fn(async () => {}), stopped: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}) });
    const enrolled = { enroll_nonce_hash: null, last_error: ENROLLMENT_SUCCEEDED, instance_id: I_NEW };
    const stoppedAt = new Date(NOW.getTime() - 42_321);
    const readyInput = { userId: U1, computerId: C1, size: 'cmp-8', readyAt: NOW, overheadSeconds: 12 };

    it.each(['m7g.large', '', null, 'toString', '__proto__', 'constructor'])
    ('unknown instance type %j completes readiness without opening an epoch', async instanceType => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const m = meter();
        const s = setup([row({ state: 'STARTING', ...enrolled, instance_type: instanceType })],
            { status: 'SUCCEEDED', output: receiptOf(), startDate: new Date(NOW.getTime() - 12_999) }, { meter: m });
        expect(await s.status()).toMatchObject({ placementState: 'RUNNING' });
        await s.status();
        expect(s.placements[0]).toMatchObject({ state: 'RUNNING', lifecycle_job_id: null });
        expect(m.ready).not.toHaveBeenCalled();
        expect(m.stopped).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledExactlyOnceWith('[billing.meter] unknown instance type, epoch not opened', { computerId: C1 });
    });

    it('unknown instance type also skips metering when enrollment completes after the receipt', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const m = meter();
        const s = setup([row({ state: 'MOUNTING', ...enrolled, instance_type: 'm7g.large', lifecycle_job_id: null, lifecycle_digest: null })],
            { status: 'RUNNING' }, { meter: m });
        expect(await s.status()).toMatchObject({ placementState: 'RUNNING' });
        expect(m.ready).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledExactlyOnceWith('[billing.meter] unknown instance type, epoch not opened', { computerId: C1 });
    });

    it('provision waits for enrollment, then meters the actual cmp-8 instance once, after commit', async () => {
        const m = meter();
        const s = setup([row({ state: 'PROVISIONING', instance_type: 'm6i.2xlarge', volume_id: null })],
            { status: 'SUCCEEDED', output: receiptOf(), startDate: new Date(NOW.getTime() - 12_999) }, { meter: m });
        let inTransaction = false;
        const transaction = s.db.transaction.bind(s.db);
        s.db.transaction = async fn => {
            inTransaction = true;
            try { return await transaction(fn); } finally { inTransaction = false; }
        };
        const observations: { inTransaction: boolean; state: unknown }[] = [];
        m.ready.mockImplementation(async () => {
            observations.push({ inTransaction, state: s.placements[0]!.state });
        });
        await s.status();
        expect(m.ready).not.toHaveBeenCalled();
        const beforeEnroll = (await readPlacement(s.db, C1)).record!;
        const consumed = await consumeEnrollmentNonce(s.db, { computerId: C1, expected: beforeEnroll,
            nonceHash: nonceHashOf(NONCE), fields: { instanceId: I_NEW, volumeId: VOL } });
        expect(consumed.ok).toBe(true);
        if (!consumed.ok) throw new Error('consume failed');
        expect((await finishEnrollment(s.db, { computerId: C1, expected: consumed.placement, success: true })).ok).toBe(true);
        const stale = (await readPlacement(s.db, C1)).record!;
        expect(await s.status()).toMatchObject({ placementState: 'RUNNING' });
        await s.status();
        await applyLifecycleReceipt({ db: s.db, executions: s.executions, meter: m, now: () => NOW }, stale, D);
        expect(m.ready).toHaveBeenCalledExactlyOnceWith(readyInput);
        expect(observations).toEqual([{ inTransaction: false, state: 'RUNNING' }]);
    });

    it('logs a concurrent AWS ready without rolling back the running receipt', async () => {
        const info = vi.spyOn(console, 'info').mockImplementation(() => {});
        const m = { ...meter(), ready: vi.fn<ComputeMeter['ready']>().mockResolvedValue('concurrent') };
        const s = setup([row({ state: 'STARTING', ...enrolled, instance_type: 'm6i.2xlarge' })],
            { status: 'SUCCEEDED', output: receiptOf() }, { meter: m });
        expect(await s.status()).toMatchObject({ placementState: 'RUNNING' });
        expect(info).toHaveBeenCalledWith('[billing.epoch] concurrent AWS ready', { userId: U1, computerId: C1 });
        expect(m.ready).toHaveBeenCalledTimes(1);
        expect(m.stopped).not.toHaveBeenCalled();
    });

    it.each(['STARTING', 'MOUNTING'])('%s with receipt and enrollment meters first RUNNING', async state => {
        const m = meter();
        const s = setup([row({ state, ...enrolled, instance_type: 'm6i.2xlarge' })],
            { status: 'SUCCEEDED', output: receiptOf(), startDate: new Date(NOW.getTime() - 12_999) }, { meter: m });
        await s.status();
        await s.status();
        expect(m.ready).toHaveBeenCalledExactlyOnceWith(readyInput);
    });

    it('enrollment replay preserves MOUNTING; the next receipt check meters once with unknown overhead zero', async () => {
        const m = meter();
        const s = setup([row()], { status: 'SUCCEEDED', output: receiptOf() }, { meter: m });
        await s.status();
        expect((await s.enroll()).status).toBe(200);
        expect((await s.enroll()).status).toBe(200);
        expect(s.placements[0]!.state).toBe('MOUNTING');
        expect(m.ready).not.toHaveBeenCalled();
        await s.status();
        expect((await s.enroll()).status).toBe(200);
        await s.status();
        expect(m.ready).toHaveBeenCalledExactlyOnceWith({ ...readyInput, size: 'std-2', overheadSeconds: 0 });
    });

    it.each(['FAILED', 'TIMED_OUT', 'ABORTED'])('failed provision (%s) never opens an epoch or bills overhead', async status => {
        const m = meter();
        const s = setup([row({ state: 'PROVISIONING', ...enrolled })],
            { status, startDate: new Date(NOW.getTime() - 300_000) }, { meter: m });
        expect(await s.status()).toMatchObject({ placementState: 'UNCONFIRMED' });
        expect(m.ready).not.toHaveBeenCalled();
        expect(m.stopped).not.toHaveBeenCalled();
    });

    it.each([
        ['STOPPING', 'stopped', undefined, 'user_stop'],
        ['DRAINING', 'stopped', true, 'platform_failure'],
        ['RETIRING', 'retired', undefined, 'provider_stop'],
    ] as const)('%s closes at execution stopDate with %s receipt', async (state, receiptState, instanceLost, reason) => {
        const m = meter();
        const s = setup([row({ state, instance_id: I_NEW })],
            { status: 'SUCCEEDED', output: receiptOf({ state: receiptState, instanceLost }), stopDate: stoppedAt }, { meter: m });
        await s.status();
        await s.status();
        expect(m.stopped).toHaveBeenCalledExactlyOnceWith({ userId: U1, computerId: C1, endedAt: stoppedAt, reason });
    });

    it('missing execution stopDate falls back to transition time', async () => {
        const m = meter();
        const s = setup([row({ state: 'STOPPING', instance_id: I_NEW })],
            { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }) }, { meter: m });
        await s.status();
        expect(m.stopped).toHaveBeenCalledExactlyOnceWith({ userId: U1, computerId: C1, endedAt: NOW, reason: 'user_stop' });
    });

    it.each([true, false])('guest idle stop uses the EC2 observation time when available (%s)', async hasTime => {
        const m = meter();
        const s = setup([row({ state: 'RUNNING', ...enrolled, lifecycle_job_id: null, lifecycle_digest: null })]);
        const p = (await readPlacement(s.db, C1)).record!;
        const started = await reconcileGuestStop({ db: s.db, meter: m, now: () => NOW,
            starter: { start: async () => {} }, newId: () => JOB,
            describer: { describeForEnrollment: async () => ({ state: 'stopped', stateTransitionAt: hasTime ? stoppedAt : null } as Ec2EnrollmentView) },
        }, p, D);
        expect(started).toBe(true);
        expect(s.placements[0]!.state).toBe('STOPPING');
        expect(m.stopped).toHaveBeenCalledExactlyOnceWith({ userId: U1, computerId: C1, endedAt: hasTime ? stoppedAt : NOW, reason: 'idle_sleep' });
    });

    it.each(['lease_expired', 'user_hours_cap', 'global_hours_cap'] as const)('%s leaves closure to the receipt, using provider_stop', async limit => {
        const m = meter();
        const s = setup([row({ state: 'RUNNING', ...enrolled, lifecycle_job_id: null, lifecycle_digest: null,
            ...(limit === 'lease_expired' ? { lease_until: NOW } : {}) })]);
        const p = (await readPlacement(s.db, C1)).record!;
        const deps = { db: s.db, meter: m, now: () => NOW, newId: () => JOB, starter: { start: async () => {} } };
        expect(await enforceSessionLimits(deps, p, D, { now: NOW,
            caps: { userMonthlyHours: limit === 'user_hours_cap' ? 0 : 100, globalMonthlyHours: limit === 'global_hours_cap' ? 0 : 600 },
        })).toBe(limit);
        expect(m.stopped).not.toHaveBeenCalled();
        const stopping = (await readPlacement(s.db, C1)).record!;
        await applyLifecycleReceipt({ ...deps, executions: { describe: async () => ({ status: 'SUCCEEDED', stopDate: stoppedAt,
            output: receiptOf({ state: 'stopped', digest: stopping.lifecycleDigest! }) }) } }, stopping, D);
        expect(m.stopped).toHaveBeenCalledExactlyOnceWith({ userId: U1, computerId: C1, endedAt: stoppedAt, reason: 'provider_stop' });
    });

    it.each(['PROVISIONING', 'STOPPING'] as const)('throwing meters cannot fail or roll back %s transitions', async state => {
        const m = meter();
        m.ready.mockRejectedValue(new Error('meter failed'));
        m.stopped.mockRejectedValue(new Error('meter failed'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const s = setup([row({ state, ...enrolled })],
            { status: 'SUCCEEDED', output: receiptOf({ state: state === 'STOPPING' ? 'stopped' : 'running' }) }, { meter: m });
        await expect(s.status()).resolves.toMatchObject({ placementState: state === 'STOPPING' ? 'STOPPED' : 'RUNNING' });
        expect(warn).toHaveBeenCalledWith('[billing.meter] observation failed', expect.any(Object));
    });

    it('real meter with flags off never accesses the store for AWS readiness or stops', async () => {
        const access = vi.fn(() => { throw new Error('billing tables absent'); });
        const m = billingComputeMeter(() => ({ config: readBillingConfig({}),
            store: new Proxy({} as BillingStore, { get: access }), stripe: null, usage: null, now: () => NOW }));
        for (const state of ['PROVISIONING', 'STOPPING'] as const) {
            const s = setup([row({ state, ...enrolled })],
                { status: 'SUCCEEDED', output: receiptOf({ state: state === 'STOPPING' ? 'stopped' : 'running' }) }, { meter: m });
            expect(await s.status()).toMatchObject({ placementState: state === 'STOPPING' ? 'STOPPED' : 'RUNNING' });
        }
        expect(access).not.toHaveBeenCalled();
    });
});

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
        s.placements[0]!.last_error = ENROLLMENT_SUCCEEDED;
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
        const { status, placements } = setup([row({ enroll_nonce_hash: null, enroll_expires_at: null, instance_id: I_NEW, last_error: ENROLLMENT_SUCCEEDED })], { status: 'SUCCEEDED', output: receiptOf() });
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
        const done = setup([row({ state: 'PROVISIONING', generation: 1, lease_epoch: 1, instance_id: I_NEW, volume_id: VOL, enroll_nonce_hash: null, enroll_expires_at: null, last_error: ENROLLMENT_SUCCEEDED })], {
            status: 'SUCCEEDED', output: receiptOf({ generation: 1, leaseEpoch: 1 }),
        });
        expect(await done.status()).toMatchObject({ placementState: 'RUNNING', state: 'running' });
        expect(done.placements[0]).toMatchObject({ instance_id: I_NEW, volume_id: VOL, lifecycle_job_id: null });
    });
});

describe('enrollment outcomes fence receipt promotion', () => {
    it.each(['PROVISIONING', 'STARTING', 'MOUNTING'])('%s requires explicit success, including after the job is cleared', async (state) => {
        for (const last_error of [null, ENROLLMENT_PENDING]) {
            const s = setup([row({
                state, instance_id: I_NEW, enroll_nonce_hash: null, enroll_expires_at: null, last_error,
                ...(state === 'MOUNTING' ? { lifecycle_job_id: null, lifecycle_digest: null } : {}),
            })], { status: 'SUCCEEDED', output: receiptOf() });
            await s.status();
            expect(s.placements[0]!.state).not.toBe('RUNNING');
        }
    });

    it.each(['PROVISIONING', 'STARTING', 'MOUNTING'])('%s cannot run while GW-1 is pending; failure allows a fresh replace', async (state) => {
        const s = setup([row({ state })], { status: 'SUCCEEDED', output: receiptOf() });
        s.tunnels.createTunnel = async () => {
            expect(s.placements[0]!.last_error).toBe(ENROLLMENT_PENDING);
            await s.status(); // receipt poll between nonce consumption and the tunnel answer
            expect(s.placements[0]!.state).not.toBe('RUNNING');
            // A DEFINITE refusal (an answered 4xx): an ambiguous answer keeps the epoch pending (below).
            return { ok: false, status: 401, code: 'tunnel_http_401' };
        };
        expect((await s.enroll()).status).toBe(502);
        await s.status();
        expect(s.placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED });
        expect(await s.provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'computer_starting' });
        expect(s.starts[0]!.intent).toMatchObject({ operation: 'replace', targetGeneration: 3, leaseEpoch: 4, previousInstanceId: I_NEW });
        expect(s.placements[0]).toMatchObject({ state: 'STARTING', instance_id: null, last_error: null });
    });

    it.each(['PROVISIONING', 'STARTING', 'MOUNTING'])('%s: an AMBIGUOUS GW-1 answer keeps the epoch pending; a receipt still cannot run it', async (state) => {
        const s = setup([row({ state })], { status: 'SUCCEEDED', output: receiptOf() });
        s.tunnels.createTunnel = async () => ({ ok: false, status: 502, code: 'tunnel_create_failed' });
        expect(await s.enroll()).toMatchObject({ status: 503, body: { retryable: true } });
        await s.status();
        expect(s.placements[0]!.last_error).toBe(ENROLLMENT_PENDING);
        expect(s.placements[0]!.state).not.toBe('RUNNING');
        expect(s.placements[0]!.state).not.toBe('UNCONFIRMED');
    });

    it('a receipt during GW-1 success preserves its progress and the success marker', async () => {
        const s = setup([row()], { status: 'SUCCEEDED', output: receiptOf() });
        s.tunnels.createTunnel = async () => {
            await s.status();
            expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', last_error: ENROLLMENT_PENDING });
            return { ok: true, tunnelToken: 'tok-' + 'x'.repeat(30) };
        };
        expect((await s.enroll()).status).toBe(200);
        expect(s.placements[0]).toMatchObject({ state: 'MOUNTING', last_error: ENROLLMENT_SUCCEEDED });
        expect(await s.status()).toMatchObject({ placementState: 'RUNNING' });
    });

    it('a stale receipt snapshot cannot erase a completed enrollment outcome', async () => {
        const s = setup([row({ instance_id: I_NEW, enroll_nonce_hash: null, last_error: ENROLLMENT_PENDING })], { status: 'SUCCEEDED', output: receiptOf() });
        const { record } = await readPlacement(s.db, C1);
        s.placements[0]!.last_error = ENROLLMENT_SUCCEEDED;
        await applyLifecycleReceipt(s, record!, D);
        expect(s.placements[0]).toMatchObject({ state: 'STARTING', last_error: ENROLLMENT_SUCCEEDED });
        expect(await s.status()).toMatchObject({ placementState: 'RUNNING' });
    });

    it('a stale receipt snapshot cannot overwrite an instance bound since its read', async () => {
        const s = setup([row()], { status: 'SUCCEEDED', output: receiptOf() });
        const { record } = await readPlacement(s.db, C1);
        s.placements[0]!.instance_id = I_OLD;
        await applyLifecycleReceipt(s, record!, D);
        expect(s.placements[0]).toMatchObject({ state: 'STARTING', instance_id: I_OLD });
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
        expect(deleted).toEqual([{ owner: { userId: U1 }, req: { computerId: C1, sandboxId: 'guac-1111111111114111-c1c1c1c1c1c14c1c', generation: 2, leaseEpoch: 3 } }]);
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

    // Codex 4278276831: the instance was terminated externally while the stop was pending; infra
    // completes it as a lost-instance stop (`instanceLost`). STOPPED with INSTANCE_LOST, so the
    // next open is a REPLACE onto the retained volume even in start mode; fenced and closed as usual.
    it('a lost-instance stop receipt lands STOPPED with INSTANCE_LOST, fenced', async () => {
        const { status, placements, deleted } = setup([stopping()], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped', instanceLost: true }) });
        expect(await status()).toMatchObject({ state: 'stopped', placementState: 'STOPPED' });
        expect(placements[0]).toMatchObject({ lifecycle_job_id: null, last_error: INSTANCE_LOST });
        expect(deleted).toHaveLength(1);
    });

    it('a normal stop receipt clears last_error (no INSTANCE_LOST)', async () => {
        const { status, placements } = setup([stopping({ last_error: 'x' })], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }) });
        expect(await status()).toMatchObject({ placementState: 'STOPPED' });
        expect(placements[0]).toMatchObject({ last_error: null });
    });

    it('instanceLost on a running receipt is invalid (receipt_invalid), never INSTANCE_LOST', async () => {
        const { status, placements } = setup([row()], { status: 'SUCCEEDED', output: receiptOf({ instanceLost: true }) });
        expect(await status()).toMatchObject({ placementState: 'UNCONFIRMED' });
        expect(placements[0]).toMatchObject({ last_error: 'receipt_invalid' });
    });

    it('a stop receipt naming another instance is a conflict, no fence call', async () => {
        const { status, deleted } = setup([stopping()], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped', instanceId: 'i-33333333333333333' }) });
        expect(await status()).toMatchObject({ placementState: 'UNCONFIRMED' });
        expect(deleted).toEqual([]);
    });
});

describe('Codex #5: the usage ledger is written by confirmed receipts (hour caps are real; egress is not measured)', () => {
    const STARTED = new Date(NOW.getTime() - 2 * 3_600_000);
    const usageRow = (over: Record<string, unknown> = {}) => ({
        computer_id: C1, user_id: U1, instance_id: I_OLD, instance_type: 't3a.medium', started_at: new Date(NOW.getTime() - 9 * 3_600_000),
        stopped_at: null, egress_bytes: null, observed_by: 'lifecycle-receipt', updated_at: NOW, ...over,
    });

    it('a running receipt opens one row for the instance, dated from the job start, egress NULL; re-applying adds nothing', async () => {
        const { status, usage } = setup([row()], { status: 'SUCCEEDED', output: receiptOf(), startDate: STARTED });
        await status();
        expect(usage).toEqual([{
            computer_id: C1, user_id: U1, instance_id: I_NEW, instance_type: 't3a.medium', started_at: STARTED, stopped_at: null, egress_bytes: null,
            observed_by: 'lifecycle-receipt', updated_at: NOW,
        }]);
        await status();
        await status();
        expect(usage).toHaveLength(1);
    });

    it('without an execution start the row is dated by the database clock', async () => {
        const { status, usage } = setup([row()], { status: 'SUCCEEDED', output: receiptOf() });
        await status();
        expect(usage[0]).toMatchObject({ instance_id: I_NEW, started_at: NOW });
    });

    it('a replace closes the old instance\'s open row and opens the new one', async () => {
        const { status, usage } = setup([row()], { status: 'SUCCEEDED', output: receiptOf(), startDate: STARTED }, { usage: [usageRow()] });
        await status();
        expect(usage.map((u) => [u.instance_id, u.stopped_at])).toEqual([[I_OLD, NOW], [I_NEW, null]]);
    });

    it('a stopped receipt closes the open row (at the database clock), only once the transition wins', async () => {
        const stopping = row({ state: 'STOPPING', instance_id: I_NEW, enroll_nonce_hash: null, enroll_expires_at: null });
        const s = setup([stopping], { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }) }, { usage: [usageRow({ instance_id: I_NEW })] });
        s.tunnels.deleteTunnel = async () => ({ ok: false, status: 502 });
        await s.status();
        expect(s.usage[0]).toMatchObject({ stopped_at: null }); // fence pending: still STOPPING, still billed
        s.tunnels.deleteTunnel = async () => ({ ok: true });
        await s.status();
        expect(s.usage[0]).toMatchObject({ stopped_at: NOW });
    });

    it('a conflicting receipt writes no usage', async () => {
        const { status, usage } = setup([row()], { status: 'SUCCEEDED', output: receiptOf({ jobId: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }) });
        expect(await status()).toMatchObject({ placementState: 'UNCONFIRMED' });
        expect(usage).toEqual([]);
    });

    it('end to end: hours written by the receipts stop the session at the cap (Codex 4275911832) and refuse the next wake', async () => {
        let answer: Exec = { status: 'SUCCEEDED', output: receiptOf(), startDate: new Date(NOW.getTime() - 101 * 3_600_000) };
        const s = setup([row()], () => answer);
        const me = { userId: U1, computerId: C1 };
        await s.status(); // STARTING → MOUNTING: row opened 101 h ago
        expect((await s.enroll()).status).toBe(200);
        // The receipt makes it RUNNING; the same poll finds 101 h ≥ the 100 h cap and stops it through the lifecycle.
        expect(await s.status()).toMatchObject({ state: 'stopping', placementState: 'STOPPING' });
        const stop = s.starts.at(-1)!;
        expect(stop.intent.operation).toBe('stop');
        expect(s.placements[0]).toMatchObject({ last_error: 'user_hours_cap', lifecycle_job_id: stop.intent.jobId });
        answer = { status: 'SUCCEEDED', output: receiptOf({ jobId: stop.intent.jobId, digest: stop.digest, state: 'stopped' }) };
        expect(await s.status()).toMatchObject({ placementState: 'STOPPED' });
        expect(s.usage).toEqual([expect.objectContaining({ instance_id: I_NEW, stopped_at: NOW })]);
        expect(await s.provider.ensure(ctx, me, opts)).toMatchObject({ ok: false, error: 'user_hours_cap' });
    });
});

describe('weighted monthly session limits', () => {
    it.each([U1, U2])('one cmp-8 hour reaches a four-hour cap for %s', async userId => {
        const { db } = createFakePlacementDb({ placements: [row({ state: 'RUNNING' })] });
        const placement = (await readPlacement(db, C1)).record!;
        const usage = monthUsageFromRows([{
            computerId: C1, userId, instanceType: 'm6i.2xlarge',
            startedAt: new Date(NOW.getTime() - 3_600_000), stoppedAt: null, egressBytes: null,
        }], NOW);
        expect(sessionLimitFor(placement, { now: NOW, caps: { userMonthlyHours: 4, globalMonthlyHours: 4 } }, usage))
            .toBe(userId === U1 ? 'user_hours_cap' : 'global_hours_cap');
        expect(sessionLimitFor(placement, { now: NOW, caps: { userMonthlyHours: 5, globalMonthlyHours: 5 } }, usage)).toBeNull();
    });
});

describe('retire receipts (computer.delete)', () => {
    const retiring = (over: Record<string, unknown> = {}) => row({ state: 'RETIRING', instance_id: I_NEW, enroll_nonce_hash: null, enroll_expires_at: null, ...over });

    it('RETIRING + retired receipt → tunnel fenced, then RETIRED, job cleared, volume kept, any open usage row closed', async () => {
        const open = { computer_id: C1, user_id: U1, instance_id: I_NEW, instance_type: 't3a.medium', started_at: NOW, stopped_at: null, egress_bytes: null, observed_by: 'x', updated_at: NOW };
        const { status, placements, usage, deleted } = setup([retiring()], { status: 'SUCCEEDED', output: receiptOf({ state: 'retired' }) }, { usage: [open] });
        expect(await status()).toMatchObject({ placementState: 'RETIRED' });
        expect(placements[0]).toMatchObject({ state: 'RETIRED', lifecycle_job_id: null, volume_id: VOL, instance_id: I_NEW });
        expect(usage[0]).toMatchObject({ stopped_at: NOW });
        // A retire may start from RUNNING (Codex 4275269627): its tunnel must not outlive the instance.
        expect(deleted).toEqual([{ owner: { userId: U1 }, req: { computerId: C1, sandboxId: 'guac-1111111111114111-c1c1c1c1c1c14c1c', generation: 2, leaseEpoch: 3 } }]);
    });

    it('a retire whose tunnel fence fails stays RETIRING (job kept) and completes on the next look', async () => {
        const s = setup([retiring()], { status: 'SUCCEEDED', output: receiptOf({ state: 'retired' }) });
        s.tunnels.deleteTunnel = async () => ({ ok: false, status: 502 });
        await s.status();
        expect(s.placements[0]).toMatchObject({ state: 'RETIRING', lifecycle_job_id: JOB });
        s.tunnels.deleteTunnel = async () => ({ ok: true });
        await s.status();
        expect(s.placements[0]).toMatchObject({ state: 'RETIRED', lifecycle_job_id: null });
    });

    it.each([['stopped'], ['running']])('a %s receipt for a retire job is a conflict (UNCONFIRMED)', async (state) => {
        const { status } = setup([retiring()], { status: 'SUCCEEDED', output: receiptOf({ state }) });
        expect(await status()).toMatchObject({ placementState: 'UNCONFIRMED' });
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
    it.each([
        [503, 'aws_desktop_unreachable'],
        [502, 'aws_origin_unavailable'],
        [409, 'relay_busy'],
    ])('cold replacement keeps Code waking through Worker %s %s, then opens the enrolled epoch', async (status, error) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        try {
            const s: ReturnType<typeof setup> = setup([row({
                state: 'STOPPED', generation: 8, lease_epoch: 9, instance_id: I_OLD,
                lifecycle_job_id: null, lifecycle_digest: null, enroll_nonce_hash: null,
            })], () => {
                const job = s.starts[0]!;
                return { status: 'SUCCEEDED', output: receiptOf({ jobId: job.intent.jobId, digest: job.digest,
                    generation: job.intent.targetGeneration, leaseEpoch: job.intent.leaseEpoch, fenceToken: job.intent.fenceToken }) };
            });
            let originReady = false;
            const worker = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
                const token = new Headers(init?.headers).get('x-ezil-auth')!;
                const claims = JSON.parse(Buffer.from(token.split('.')[1]!, 'base64url').toString());
                // The fake Worker trusts the tunnel created by real enrollment, not an inferred generation.
                const tunnel = s.created[0] as { computerId: string; sandboxId: string; generation: number; leaseEpoch: number };
                expect(claims).toMatchObject({ computerId: tunnel.computerId, sandboxId: tunnel.sandboxId,
                    generation: tunnel.generation, leaseEpoch: tunnel.leaseEpoch });
                if (!originReady) return Response.json({ ok: false, error }, { status });
                const url = (port: number) => `https://aws-${port}-${claims.sandboxId}-aws.ezil.org/preview-bootstrap?token=test`;
                return Response.json({ ok: true, provider: 'aws-ec2', mode: 'neko', sandboxId: claims.sandboxId,
                    generation: claims.generation, leaseEpoch: claims.leaseEpoch,
                    guacamoleUrl: url(8181), appPreviewUrl: url(3002), codePreviewUrl: url(8443), expiresAt: NOW.getTime() + 60_000 });
            });
            const preview = () => requestAwsPreview(s.db, { userId: U1, computerId: C1 }, opts,
                { workerUrl: 'https://worker.example.test', isConfigured: true, hasHmacSecret: true }, 'test-secret', 'corr', env());
            const open = async () => awsPreviewAnswer(await s.provider.ensure(ctx, { userId: U1, computerId: C1 }, opts), preview);
            expect(await open()).toMatchObject({ ok: false, errorCode: 'sandbox_starting' });
            expect(worker).not.toHaveBeenCalled();
            expect(s.starts[0]!.intent).toMatchObject({ operation: 'replace', previousGeneration: 8, targetGeneration: 9, leaseEpoch: 10 });
            expect((await s.enroll()).status).toBe(200);
            // A lifecycle receipt makes the desktop API say "up" before its origin services answer.
            expect(awsStatusAnswer(await s.status())).toMatchObject({ guacamoleRunning: true });
            expect(await open()).toMatchObject({ ok: false, errorCode: 'sandbox_starting' });
            expect(await open()).toMatchObject({ ok: false, errorCode: 'sandbox_starting' });
            originReady = true;
            expect(await open()).toMatchObject({ ok: true, generation: 9, leaseEpoch: 10 });
            expect(s.starts).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });

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
                { db: s.db, env: env(), now: () => NOW, controlKeySecret: 'control-key-secret-for-tests', describer: { describeForEnrollment: async () => view() }, tunnels: s.tunnels },
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

describe('Codex 4275269627: a deleted AWS computer is retired in the background (one user delete)', () => {
    const DELETED = [{ id: C1, user_id: U1, deleted_at: NOW }];
    const ready = (over: Record<string, unknown> = {}) =>
        row({ state: 'STOPPED', instance_id: I_NEW, lifecycle_job_id: null, lifecycle_digest: null, enroll_nonce_hash: null, enroll_expires_at: null, ...over });
    function bg(rows: Record<string, unknown>[], computers: { id: string; user_id: string; deleted_at?: Date | null }[], exec: Exec = { status: 'RUNNING' }, failStart = false) {
        const fake = createFakePlacementDb({ placements: rows, computers }, { clock: () => NOW });
        const starts: { region: string; intent: LifecycleIntent }[] = [];
        const starter: LifecycleStarter = {
            async start(region, work) {
                if (failStart) throw Object.assign(new Error('StartExecution refused'), { name: 'ExecutionLimitExceeded', $metadata: { httpStatusCode: 400 } });
                starts.push({ region, intent: JSON.parse((JSON.parse(work.input) as { document: string }).document) });
            },
        };
        const fenced: unknown[] = [];
        const tunnels: TunnelClient = {
            createTunnel: async () => ({ ok: true, tunnelToken: 'tok-' + 'x'.repeat(30) }),
            deleteTunnel: async (_o, req) => (fenced.push(req), { ok: true }),
        };
        let n = 0;
        const deps = {
            db: fake.db, tunnels, starter, newId: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}`,
            executions: { describe: async () => exec } as LifecycleExecutionReader,
        };
        return { ...fake, deps, starts, fenced };
    }
    const deployments = { 'ap-south-1': D };

    it.each(['STOPPED', 'RUNNING'] as const)('a deleted computer that is %s gets its retire started (RETIRING, job recorded)', async (state) => {
        const b = bg([ready({ state })], DELETED);
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 1, retiresStarted: 1, retired: 0, stuck: 0 });
        expect(b.starts.map((x) => x.intent.operation)).toEqual(['retire']);
        expect(b.starts[0]!.intent).toMatchObject({ providerInstanceId: I_NEW, dataVolumeId: VOL, targetGeneration: 2, leaseEpoch: 3, fenceToken: FENCE });
        expect(b.placements[0]).toMatchObject({ state: 'RETIRING', lifecycle_job_id: b.starts[0]!.intent.jobId });
    });

    it('a recorded stop whose receipt landed: fenced → STOPPED, then the retire starts, in one pass', async () => {
        const b = bg([ready({ state: 'STOPPING', lifecycle_job_id: JOB, lifecycle_digest: DIGEST })], DELETED, { status: 'SUCCEEDED', output: receiptOf({ state: 'stopped' }) });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toMatchObject({ retiresStarted: 1 });
        expect(b.fenced).toHaveLength(1);
        expect(b.placements[0]).toMatchObject({ state: 'RETIRING' });
    });

    it('RETIRING + retired receipt → RETIRED (counted), nothing new started', async () => {
        const b = bg([ready({ state: 'RETIRING', lifecycle_job_id: JOB, lifecycle_digest: DIGEST })], DELETED, { status: 'SUCCEEDED', output: receiptOf({ state: 'retired' }) });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 1, retiresStarted: 0, retired: 1, stuck: 0 });
        expect(b.starts).toEqual([]);
        expect(b.placements[0]).toMatchObject({ state: 'RETIRED', lifecycle_job_id: null });
    });

    it('a LIVE computer is never retired by the background pass', async () => {
        const b = bg([ready()], [{ id: C1, user_id: U1, deleted_at: null }]);
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 0, retiresStarted: 0, retired: 0, stuck: 0 });
        expect(b.starts).toEqual([]);
        expect(b.placements[0]).toMatchObject({ state: 'STOPPED' });
    });

    it('a computer row that is gone (account deletion cascade) is retired too', async () => {
        const b = bg([ready()], []);
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toMatchObject({ retiresStarted: 1 });
    });

    it('a refused StartExecution returns the placement to where it was, job cleared, retire_start_failed', async () => {
        const b = bg([ready({ state: 'RUNNING' })], DELETED, { status: 'RUNNING' }, true);
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toMatchObject({ retiresStarted: 0 });
        expect(b.placements[0]).toMatchObject({ state: 'RUNNING', lifecycle_job_id: null, last_error: 'retire_start_failed' });
    });

    it('the cron job: AWS off answers skipped with no statement; on, it retires deleted computers', async () => {
        const off = bg([ready()], DELETED);
        expect(await runAwsBackgroundReconcile(env({ EZIL_AWS_COMPUTERS_ENABLED: '0' }), off.deps)).toEqual({ ok: true, skipped: 'aws_disabled' });
        expect(off.statements).toEqual([]);
        const on = bg([ready()], DELETED);
        expect(await runAwsBackgroundReconcile(env(), on.deps)).toMatchObject({ ok: true, deleted: { retiresStarted: 1 } });
        expect(on.placements[0]).toMatchObject({ state: 'RETIRING' });
    });
});

describe('Codex 4276508568: a deleted computer whose stop/retire failed is recovered by retiring it', () => {
    const DELETED = [{ id: C1, user_id: U1, deleted_at: NOW }];
    const stuck = (over: Record<string, unknown> = {}) =>
        row({ state: 'UNCONFIRMED', instance_id: I_NEW, lifecycle_job_id: null, lifecycle_digest: null, enroll_nonce_hash: null, enroll_expires_at: null,
            last_error: 'failed:States.Timeout', ...over });
    type View = Pick<Ec2EnrollmentView, 'state'> | null | 'throw';
    /** The retained volume `describeVolume` answers; 'none' = the describer has no volume lookup. */
    type Vol = { state: string } | null | 'none';
    function bg(rows: Record<string, unknown>[], computers: { id: string; user_id: string; deleted_at?: Date | null }[],
        opts: { view?: View; exec?: Exec; failStart?: boolean; volume?: Vol; found?: { instances: { instanceId: string; state: string }[]; volumes: { volumeId: string; state: string }[] } } = {}) {
        const fake = createFakePlacementDb({ placements: rows, computers }, { clock: () => NOW });
        const starts: { region: string; intent: LifecycleIntent }[] = [];
        const control = { view: opts.view === undefined ? ({ state: 'stopped' } as View) : opts.view, failStart: opts.failStart ?? false };
        const starter: LifecycleStarter = {
            async start(region, work) {
                if (control.failStart) throw Object.assign(new Error('StartExecution refused'), { name: 'ExecutionLimitExceeded', $metadata: { httpStatusCode: 400 } });
                starts.push({ region, intent: JSON.parse((JSON.parse(work.input) as { document: string }).document) });
            },
        };
        const describes: string[] = [];
        const volume: Vol = opts.volume === undefined ? { state: 'available' } : opts.volume;
        const describer = {
            async describeForEnrollment(_region: string, instanceId: string) {
                describes.push(instanceId);
                if (control.view === 'throw') throw new Error('RequestLimitExceeded');
                return control.view === null ? null : ({ ...control.view, instanceId } as Ec2EnrollmentView);
            },
            ...(volume === 'none' ? {} : { describeVolume: async (_r: string, volumeId: string) => (volume ? { volumeId, ...volume } : null) }),
            ...(opts.found ? { findComputerResources: async () => opts.found! } : {}),
        };
        const tunnels: TunnelClient = { createTunnel: async () => ({ ok: true, tunnelToken: 'tok-' + 'x'.repeat(30) }), deleteTunnel: async () => ({ ok: true }) };
        let n = 0;
        const deps = {
            db: fake.db, tunnels, starter, describer, newId: () => `bbbbbbbb-bbbb-4bbb-8bbb-${String(++n).padStart(12, '0')}`,
            executions: { describe: async () => opts.exec ?? { status: 'RUNNING' } } as LifecycleExecutionReader,
        };
        return { ...fake, deps, starts, describes, control };
    }
    const deployments = { 'ap-south-1': D };

    it('the reported case: a deleted computer\'s retire FAILED → UNCONFIRMED, and the same pass starts a new retire', async () => {
        const b = bg([stuck({ state: 'RETIRING', lifecycle_job_id: JOB, lifecycle_digest: DIGEST, last_error: null })], DELETED,
            { exec: { status: 'FAILED', error: 'States.Timeout' } });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 1, retiresStarted: 1, retired: 0, stuck: 0 });
        expect(b.starts.map((x) => x.intent.operation)).toEqual(['retire']);
        expect(b.starts[0]!.intent).toMatchObject({ providerInstanceId: I_NEW, dataVolumeId: VOL, fenceToken: FENCE });
        expect(b.placements[0]).toMatchObject({ state: 'RETIRING', lifecycle_job_id: b.starts[0]!.intent.jobId, last_error: null });
        expect(b.placements[0]!.lifecycle_job_id).not.toBe(JOB);
    });

    it.each(['stopped', 'running', 'stopping', 'terminated'])('UNCONFIRMED with the instance %s → RECOVERING → RETIRING, retire started (the job resolves the state)', async (state) => {
        const b = bg([stuck()], DELETED, { view: { state } });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 1, retiresStarted: 1, retired: 0, stuck: 0 });
        expect(b.describes).toEqual([I_NEW]);
        expect(b.placements[0]).toMatchObject({ state: 'RETIRING', lifecycle_job_id: b.starts[0]!.intent.jobId });
    });

    it('a RECOVERING placement left by an interrupted recovery goes straight to RETIRING', async () => {
        const b = bg([stuck({ state: 'RECOVERING', last_error: 'deleted_recovery' })], DELETED);
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toMatchObject({ retiresStarted: 1 });
        expect(b.placements[0]).toMatchObject({ state: 'RETIRING' });
    });

    it('a LIVE computer\'s UNCONFIRMED placement is never touched: not claimed, and the recovery itself refuses it', async () => {
        const live = [{ id: C1, user_id: U1, deleted_at: null }];
        const b = bg([stuck()], live);
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 0, retiresStarted: 0, retired: 0, stuck: 0 });
        const { record } = await readPlacement(b.db, C1);
        expect(await recoverDeletedAwsPlacement(b.deps, record!, D)).toBe('skipped');
        expect(b.starts).toEqual([]);
        expect(b.describes).toEqual([]);
        expect(b.placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: 'failed:States.Timeout' });
    });

    it('describe failing is unknown: nothing changes, and the next pass recovers it', async () => {
        const b = bg([stuck()], DELETED, { view: 'throw' });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 1, retiresStarted: 0, retired: 0, stuck: 0 });
        expect(b.placements[0]).toMatchObject({ state: 'UNCONFIRMED' });
        b.control.view = { state: 'stopped' };
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toMatchObject({ retiresStarted: 1 });
        expect(b.placements[0]).toMatchObject({ state: 'RETIRING' });
    });

    it('an instance EC2 no longer knows, with no volume lookup, is reported stuck (operator purge), with no job started', async () => {
        const b = bg([stuck()], DELETED, { view: null, volume: 'none' });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 1, retiresStarted: 0, retired: 0, stuck: 1 });
        expect(b.starts).toEqual([]);
        expect(b.placements[0]).toMatchObject({ state: 'UNCONFIRMED' });
    });

    it('Codex 4278130057: the instance is gone but its retained volume is available → retired (the retire job accepts an absent source)', async () => {
        const b = bg([stuck()], DELETED, { view: null });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 1, retiresStarted: 1, retired: 0, stuck: 0 });
        expect(b.starts.map((x) => x.intent.operation)).toEqual(['retire']);
        expect(b.placements[0]).toMatchObject({ state: 'RETIRING' });
    });

    it('the instance AND its volume are gone → released: RETIRED then PURGE_ELIGIBLE, no job, counted retired', async () => {
        const b = bg([stuck()], DELETED, { view: null, volume: null });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toEqual({ checked: 1, retiresStarted: 0, retired: 1, stuck: 0 });
        expect(b.starts).toEqual([]);
        expect(b.placements[0]).toMatchObject({ state: 'PURGE_ELIGIBLE', last_error: 'released_no_resources' });
    });

    it.each(['in-use', 'error'])('the instance is gone and its volume is %s → stuck, never released', async (state) => {
        const b = bg([stuck()], DELETED, { view: null, volume: { state } });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toMatchObject({ stuck: 1, retired: 0, retiresStarted: 0 });
        expect(b.placements[0]).toMatchObject({ state: 'UNCONFIRMED' });
    });

    it('a deleted failed provision that recorded nothing is released only when the tag search finds nothing', async () => {
        const none = bg([stuck({ instance_id: null, volume_id: null })], DELETED, { found: { instances: [], volumes: [] } });
        expect(await reconcileDeletedAwsComputers(none.deps, deployments)).toMatchObject({ retired: 1, stuck: 0 });
        expect(none.placements[0]).toMatchObject({ state: 'PURGE_ELIGIBLE' });
        const some = bg([stuck({ instance_id: null, volume_id: null })], DELETED, { found: { instances: [{ instanceId: 'i-9', state: 'running' }], volumes: [] } });
        expect(await reconcileDeletedAwsComputers(some.deps, deployments)).toMatchObject({ retired: 0, stuck: 1 });
        expect(some.placements[0]).toMatchObject({ state: 'UNCONFIRMED' });
    });

    it('a refused StartExecution returns it to UNCONFIRMED (retire_start_failed, job cleared); the next pass retries', async () => {
        const b = bg([stuck()], DELETED, { failStart: true });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toMatchObject({ retiresStarted: 0 });
        expect(b.placements[0]).toMatchObject({ state: 'UNCONFIRMED', lifecycle_job_id: null, lifecycle_digest: null, last_error: 'retire_start_failed' });
        b.control.failStart = false;
        expect(await reconcileDeletedAwsComputers(b.deps, deployments)).toMatchObject({ retiresStarted: 1 });
        expect(b.placements[0]).toMatchObject({ state: 'RETIRING' });
    });

    it('rows that cannot progress never starve the rest: the pass rotates past them', async () => {
        const Cn = (i: number) => `c4c4c4c4-c4c4-4c4c-8c4c-${String(i).padStart(12, '0')}`;
        const rows = [1, 2, 3].map((i) => stuck({ computer_id: Cn(i), updated_at: new Date(NOW.getTime() - (10 - i) * 60_000) }));
        const b = bg(rows, [1, 2, 3].map((i) => ({ id: Cn(i), user_id: U1, deleted_at: NOW })), { view: null, volume: 'none' });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments, 2)).toMatchObject({ checked: 2, stuck: 2 });
        expect(await reconcileDeletedAwsComputers(b.deps, deployments, 2)).toMatchObject({ checked: 2, stuck: 2 });
        expect(new Set(b.describes)).toEqual(new Set([I_NEW]));
        expect(b.placements.every((r) => r.reconciled_at != null)).toBe(true);
    });
});

describe('retire-pending claim SQL (the fake models it; the text is pinned here, run on real Postgres 16 in review)', () => {
    it('claims deleted or missing computers least-recently-checked first, stamps reconciled_at, skips locked rows, bounded', async () => {
        const fake = createFakePlacementDb({ placements: [], computers: [] });
        await claimAwsPlacementsPendingRetire(fake.db, 500);
        const text = fake.statements[0]!.sql.replace(/\s+/g, ' ');
        expect(text).toMatch(/\/\* placement:retire-pending-claim \*\//);
        expect(text).toMatch(/UPDATE public\.ezil_computer_placements SET reconciled_at = now\(\)/);
        expect(text).toMatch(/LEFT JOIN public\.ezil_computers c ON c\.id = p\.computer_id/);
        expect(text).toMatch(/WHERE p\.provider = 'aws-ec2' AND p\.state IN \((\$\d+, ){6}\$\d+\) AND \(c\.id IS NULL OR c\.deleted_at IS NOT NULL\)/);
        expect(text).toMatch(/ORDER BY p\.reconciled_at ASC NULLS FIRST, p\.updated_at ASC, p\.computer_id ASC LIMIT \$8 FOR UPDATE OF p SKIP LOCKED/);
        expect(fake.statements[0]!.params).toEqual([...RETIRE_PENDING_STATES, 100]);
        expect(RETIRE_PENDING_STATES).toEqual(expect.arrayContaining(['UNCONFIRMED', 'RECOVERING']));
    });
});

describe('the background pass: lapsed sessions stop (Codex 4275911832) and the fleet rotates (Codex 4275911808)', () => {
    const HOUR = 3_600_000;
    const Cn = (i: number) => `c0c0c0c0-c0c0-4c0c-8c0c-${String(i).padStart(12, '0')}`;
    const In = (i: number) => `i-${String(i).padStart(17, '0')}`;
    /** RUNNING, lease live, no job: row i changed i minutes after the oldest. */
    const live = (i: number, over: Record<string, unknown> = {}) =>
        row({
            computer_id: Cn(i), state: 'RUNNING', instance_id: In(i), lifecycle_job_id: null, lifecycle_digest: null, enroll_nonce_hash: null, enroll_expires_at: null,
            lease_until: new Date(NOW.getTime() + HOUR), updated_at: new Date(NOW.getTime() - (1000 - i) * 60_000), ...over,
        });
    function fleet(rows: Record<string, unknown>[], ec2Stopped: Set<string> = new Set()) {
        // Live computers: the deleted-computer pass must leave every one of them alone.
        const computers = rows.map((r) => ({ id: String(r.computer_id), user_id: U1, deleted_at: null }));
        const fake = createFakePlacementDb({ placements: rows, computers }, { clock: () => NOW });
        const starts: LifecycleIntent[] = [];
        let n = 0;
        const deps: GuestStopDeps = {
            db: fake.db,
            executions: { describe: async () => ({ status: 'RUNNING' }) },
            starter: { async start(_r, work) { starts.push(JSON.parse((JSON.parse(work.input) as { document: string }).document)); } },
            describer: { async describeForEnrollment(_region, instanceId) { return { instanceId, state: ec2Stopped.has(instanceId) ? 'stopped' : 'running' } as never; } },
            newId: () => `aaaaaaaa-aaaa-4aaa-8aaa-${String(++n).padStart(12, '0')}`,
            clock: () => NOW,
        };
        return { ...fake, deps, starts };
    }

    it('the cron pass stops a RUNNING computer whose lease lapsed while EC2 still says running', async () => {
        const f = fleet([live(1, { lease_until: new Date(NOW.getTime() - 1) }), live(2)]);
        expect(await runAwsBackgroundReconcile(env(), f.deps)).toMatchObject({ ok: true, fleet: { checked: 2, stopsStarted: 0, limitStops: 1 } });
        expect(f.starts.map((i) => [i.operation, i.computerId])).toEqual([['stop', Cn(1)]]);
        expect(f.placements.find((r) => r.computer_id === Cn(1))).toMatchObject({ state: 'STOPPING', last_error: 'lease_expired' });
        expect(f.placements.find((r) => r.computer_id === Cn(2))).toMatchObject({ state: 'RUNNING' });
    });

    it('the cron pass stops a computer at the user hour cap, reading the month usage once', async () => {
        const usage = [{
            computer_id: Cn(1), user_id: U1, instance_id: In(1), instance_type: 't3a.medium', started_at: new Date(NOW.getTime() - 100 * HOUR), stopped_at: null,
            egress_bytes: null, observed_by: 'x', updated_at: NOW,
        }];
        const fake = fleet([live(1), live(2)]);
        fake.usage.push(...usage);
        await runAwsBackgroundReconcile(env(), fake.deps);
        // Both rows belong to U1: both are over the cap.
        expect(fake.starts.map((i) => i.operation)).toEqual(['stop', 'stop']);
        expect(fake.statements.filter((s) => s.sql.includes('placement:usage-month'))).toHaveLength(1);
    });

    it('rotation: with more rows than one pass looks at, a guest-stopped row behind them is reached on the next pass', async () => {
        const total = FLEET_RECONCILE_LIMIT + 5;
        const hidden = total; // the most recently changed row: last in updated_at order
        const f = fleet(Array.from({ length: total }, (_, k) => live(k + 1)), new Set([In(hidden)]));
        const first = await reconcileAwsFleet(f.deps, { 'ap-south-1': D }, FLEET_RECONCILE_LIMIT, { now: NOW, caps: null });
        expect(first).toEqual({ checked: FLEET_RECONCILE_LIMIT, stopsStarted: 0, limitStops: 0 });
        expect(f.starts).toEqual([]);
        const second = await reconcileAwsFleet(f.deps, { 'ap-south-1': D }, FLEET_RECONCILE_LIMIT, { now: NOW, caps: null });
        // The second pass claims the 5 never-reconciled rows first (then 15 more): the hidden one is among them.
        expect(second).toMatchObject({ checked: FLEET_RECONCILE_LIMIT, stopsStarted: 1 });
        expect(f.starts.map((i) => [i.operation, i.computerId])).toEqual([['stop', Cn(hidden)]]);
        // Every row has now been looked at once.
        expect(f.placements.every((r) => r.reconciled_at !== null)).toBe(true);
    });
});

describe('Codex 4277262199: settling a recorded job whose start got no answer', () => {
    const absent = () => Object.assign(new Error('missing'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } });
    const SETTLED = new Date(NOW.getTime() - 6 * 60_000);
    const FRESH = new Date(NOW.getTime() - 60_000);
    const base = {
        computer_id: C1, owner_user_id: U1, region: 'ap-south-1', instance_type: 't3a.medium', instance_id: I_OLD, volume_id: VOL, fence_token: FENCE,
        generation: 2, lease_epoch: 3, lifecycle_job_id: JOB, lifecycle_digest: DIGEST, updated_at: SETTLED,
    };
    /** The digest of THIS placement's stop job, exactly as the provider built it. */
    const STOP_DIGEST = buildLifecycleWork(currentGenerationIntent(
        { computerId: C1, generation: 2, fenceToken: FENCE, instanceId: I_OLD, volumeId: VOL, instanceType: 't3a.medium' }, 'stop', D, { jobId: JOB, userData: null, leaseEpoch: 3 },
    )).digest;
    function recorder(fail?: 'refused' | 'lost') {
        const calls: { name: string; digest: string }[] = [];
        const starter: LifecycleStarter = {
            async start(_region, work) {
                calls.push({ name: work.name, digest: (JSON.parse(work.input) as { digest: string }).digest });
                if (fail === 'refused') throw Object.assign(new Error('refused'), { name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 } });
                if (fail === 'lost') throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
            },
        };
        return { starter, calls };
    }
    async function settle(row: Record<string, unknown>, o: { describe?: () => Promise<Exec>; starter?: LifecycleStarter } = {}) {
        const fake = createFakePlacementDb({ placements: [placementRow({ ...base, ...row } as never)] }, { clock: () => NOW });
        const executions: LifecycleExecutionReader = { describe: o.describe ?? (async () => { throw absent(); }) };
        const { record } = await readPlacement(fake.db, C1);
        await applyLifecycleReceipt({ db: fake.db, executions, clock: () => NOW, sleep: async () => {}, ...(o.starter ? { starter: o.starter } : {}) }, record!, D);
        return fake.placements[0]!;
    }

    it('inside the settle window nothing changes: a start may still appear', async () => {
        expect(await settle({ state: 'PROVISIONING', last_error: 'lifecycle_start_unknown:UNCONFIRMED', updated_at: FRESH }))
            .toMatchObject({ state: 'PROVISIONING', lifecycle_job_id: JOB, last_error: 'lifecycle_start_unknown:UNCONFIRMED' });
    });

    it('a provision that never reached Step Functions → UNCONFIRMED, job cleared, lifecycle_start_failed', async () => {
        expect(await settle({ state: 'PROVISIONING', last_error: 'lifecycle_start_unknown:UNCONFIRMED' }))
            .toMatchObject({ state: 'UNCONFIRMED', lifecycle_job_id: null, lifecycle_digest: null, last_error: 'lifecycle_start_failed' });
    });

    it('a replacement with no execution keeps its job reserved and never guesses the source generation', async () => {
        expect(await settle({ state: 'LEASED', last_error: 'lifecycle_start_unknown:UNCONFIRMED' }))
            .toMatchObject({ state: 'UNCONFIRMED', lifecycle_job_id: JOB, lifecycle_digest: DIGEST,
                generation: 2, lease_epoch: 3, enroll_nonce_hash: null, enroll_consumed_hash: null, enroll_expires_at: null });
    });

    it('a start-mode wake that never ran → back to STOPPED, where a refusal would have left it', async () => {
        expect(await settle({ state: 'LEASED', last_error: 'lifecycle_start_unknown:STOPPED' }))
            .toMatchObject({ state: 'STOPPED', lifecycle_job_id: null, last_error: 'lifecycle_start_failed' });
    });

    it('without the mark an absent execution stays unknown (the ordinary in-flight case)', async () => {
        expect(await settle({ state: 'PROVISIONING', last_error: null })).toMatchObject({ state: 'PROVISIONING', lifecycle_job_id: JOB });
    });

    it('any other describe failure is unknown, never settled', async () => {
        const describe = async (): Promise<Exec> => { throw Object.assign(new Error('boom'), { name: 'InternalFailure', $metadata: { httpStatusCode: 500 } }); };
        expect(await settle({ state: 'PROVISIONING', last_error: 'lifecycle_start_unknown:UNCONFIRMED' }, { describe }))
            .toMatchObject({ state: 'PROVISIONING', lifecycle_job_id: JOB });
    });

    it('a stop carries no secret: its exact job is rebuilt (digest-checked) and started again under the same name', async () => {
        const rec = recorder();
        expect(await settle({ state: 'DRAINING', lifecycle_digest: STOP_DIGEST, last_error: 'lifecycle_start_unknown:UNCONFIRMED' }, { starter: rec.starter }))
            .toMatchObject({ state: 'DRAINING', lifecycle_job_id: JOB });
        expect(rec.calls).toEqual([{ name: `computer-${JOB}`, digest: STOP_DIGEST }]);
    });

    it('a refused re-start resolves to the recorded undo', async () => {
        const rec = recorder('refused');
        expect(await settle({ state: 'DRAINING', lifecycle_digest: STOP_DIGEST, last_error: 'lifecycle_start_unknown:UNCONFIRMED' }, { starter: rec.starter }))
            .toMatchObject({ state: 'UNCONFIRMED', lifecycle_job_id: null, last_error: 'lifecycle_start_failed' });
    });

    it('a re-start that again gets no answer is re-marked: a new settle window, nothing undone', async () => {
        const rec = recorder('lost');
        const row = await settle({ state: 'DRAINING', lifecycle_digest: STOP_DIGEST, last_error: 'lifecycle_start_unknown:UNCONFIRMED' }, { starter: rec.starter });
        expect(row).toMatchObject({ state: 'DRAINING', lifecycle_job_id: JOB, last_error: 'lifecycle_start_unknown:UNCONFIRMED' });
        expect(row.updated_at).toEqual(NOW);
    });

    it('a recorded digest that is not exactly this job is never re-started: undo instead', async () => {
        const rec = recorder();
        expect(await settle({ state: 'DRAINING', lifecycle_digest: DIGEST, last_error: 'lifecycle_start_unknown:UNCONFIRMED' }, { starter: rec.starter }))
            .toMatchObject({ state: 'UNCONFIRMED', last_error: 'lifecycle_start_failed' });
        expect(rec.calls).toEqual([]);
    });

    it('an execution that does exist is simply followed (the lost answer was only an answer)', async () => {
        const describe = async (): Promise<Exec> => ({ status: 'SUCCEEDED', output: receiptOf({ state: 'retired', instanceId: I_OLD }) });
        expect(await settle({ state: 'RETIRING', last_error: 'lifecycle_start_unknown:STOPPED' }, { describe }))
            .toMatchObject({ state: 'RETIRED', lifecycle_job_id: null });
    });
});

describe('Codex 4277262205: the background pass stops at its budget', () => {
    it('an aborted signal ends the fleet pass before its next placement', async () => {
        const row = placementRow({ computer_id: C1, owner_user_id: U1, region: 'ap-south-1', state: 'RUNNING', instance_id: I_OLD, volume_id: VOL, fence_token: FENCE, instance_type: 't3a.medium' });
        const aborted = new AbortController();
        aborted.abort();
        const off = createFakePlacementDb({ placements: [{ ...row }] }, { clock: () => NOW });
        expect(await reconcileAwsFleet({ db: off.db, signal: aborted.signal }, { 'ap-south-1': D })).toMatchObject({ checked: 0 });
        const on = createFakePlacementDb({ placements: [{ ...row }] }, { clock: () => NOW });
        expect(await reconcileAwsFleet({ db: on.db }, { 'ap-south-1': D })).toMatchObject({ checked: 1 });
    });
});

describe('Codex 4277262199: the reconciler\'s own starts keep a lost answer reconcilable', () => {
    const lost: LifecycleStarter = { async start() { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); } };
    const row = (over: Record<string, unknown>) => placementRow({
        computer_id: C1, owner_user_id: U1, region: 'ap-south-1', instance_id: I_OLD, volume_id: VOL, fence_token: FENCE, instance_type: 't3a.medium',
        generation: 2, lease_epoch: 3, ...over,
    } as never);
    async function rec(over: Record<string, unknown>, computers: { id: string; user_id: string; deleted_at?: Date | null }[] = []) {
        const fake = createFakePlacementDb({ placements: [row(over)], computers }, { clock: () => NOW });
        const { record } = await readPlacement(fake.db, C1);
        return { fake, p: record! };
    }

    it('a guest-stop whose answer is lost stays DRAINING with its job (never UNCONFIRMED on a guess)', async () => {
        const { fake, p } = await rec({ state: 'RUNNING' });
        const describer = { describeForEnrollment: async () => ({ state: 'stopped' }) as Ec2EnrollmentView };
        expect(await reconcileGuestStop({ db: fake.db, starter: lost, describer, sleep: async () => {} }, p, D)).toBe(true);
        expect(fake.placements[0]).toMatchObject({ state: 'DRAINING', last_error: 'lifecycle_start_unknown:UNCONFIRMED' });
        expect(fake.placements[0]!.lifecycle_job_id).not.toBeNull();
    });

    it('a background retire whose answer is lost stays RETIRING with its job, settling back to where it came from', async () => {
        const { fake, p } = await rec({ state: 'STOPPED' });
        expect(await startRetireAsReconciler({ db: fake.db, starter: lost, sleep: async () => {} }, p, D)).toBe(true);
        expect(fake.placements[0]).toMatchObject({ state: 'RETIRING', last_error: 'lifecycle_start_unknown:STOPPED' });
    });

    it('a deleted computer\'s recovery whose answer is lost stays RETIRING with its job', async () => {
        const { fake, p } = await rec({ state: 'UNCONFIRMED', last_error: 'failed:States.Timeout' }, [{ id: C1, user_id: U1, deleted_at: NOW }]);
        const describer = { describeForEnrollment: async () => ({ state: 'stopped' }) as Ec2EnrollmentView };
        expect(await recoverDeletedAwsPlacement({ db: fake.db, starter: lost, describer, sleep: async () => {} }, p, D)).toBe('retire_started');
        expect(fake.placements[0]).toMatchObject({ state: 'RETIRING', last_error: 'lifecycle_start_unknown:UNCONFIRMED' });
    });
});


describe('Codex 4277613510: a RUNNING placement whose EC2 instance is gone is recovered onto its volume', () => {
    type Vol = string | null | 'throw';
    function lost(view: string | null, volume: Vol, opts: { fenceOk?: boolean; noVolumeDescribe?: boolean } = {}) {
        const fake = createFakePlacementDb({
            placements: [row({ state: 'RUNNING', instance_id: I_NEW, lifecycle_job_id: null, lifecycle_digest: null, enroll_nonce_hash: null, enroll_expires_at: null, last_error: null })],
            computers: [{ id: C1, user_id: U1 }],
            usage: [{ computer_id: C1, user_id: U1, instance_id: I_NEW, instance_type: 't3a.medium', started_at: new Date(NOW.getTime() - 3_600_000), stopped_at: null, egress_bytes: null, observed_by: 'receipt', updated_at: NOW }],
        }, { clock: () => NOW });
        const fences: { generation: number; leaseEpoch: number }[] = [];
        const control = { fenceOk: opts.fenceOk ?? true };
        const tunnels: TunnelClient = {
            createTunnel: async () => ({ ok: true, tunnelToken: 'tok-' + 'x'.repeat(30) }),
            deleteTunnel: async (_owner, req) => { fences.push({ generation: req.generation, leaseEpoch: req.leaseEpoch }); return { ok: control.fenceOk }; },
        };
        const starts: string[] = [];
        const starter: LifecycleStarter = { async start(_region, work) { starts.push(work.input); } };
        const volumes: string[] = [];
        const describer = {
            describeForEnrollment: async (_r: string, instanceId: string) => (view === null ? null : ({ instanceId, state: view } as Ec2EnrollmentView)),
            ...(opts.noVolumeDescribe ? {} : {
                describeVolume: async (_r: string, volumeId: string) => {
                    volumes.push(volumeId);
                    if (volume === 'throw') throw new Error('RequestLimitExceeded');
                    return volume === null ? null : { volumeId, state: volume };
                },
            }),
        };
        return { ...fake, deps: { db: fake.db, tunnels, starter, describer, sleep: async () => {} }, fences, starts, volumes, control };
    }
    const placement = async (db: Parameters<typeof readPlacement>[0]) => (await readPlacement(db, C1)).record!;

    it.each([[null], ['terminated'], ['shutting-down']] as const)('EC2 says %s, volume kept → fenced, usage closed, STOPPED instance_lost (no job started)', async (state) => {
        const l = lost(state, 'available');
        expect(await reconcileGuestStop(l.deps, await placement(l.db), D)).toBe(true);
        expect(l.volumes).toEqual([VOL]);
        expect(l.fences).toEqual([{ generation: 2, leaseEpoch: 3 }]);
        expect(l.starts).toEqual([]);
        expect(l.placements[0]).toMatchObject({ state: 'STOPPED', last_error: 'instance_lost', instance_id: I_NEW, volume_id: VOL, lifecycle_job_id: null, lifecycle_digest: null });
        expect(l.usage[0]).toMatchObject({ observed_by: 'reconcile:instance_lost' });
        expect(l.usage[0]!.stopped_at).not.toBeNull();
    });

    it('the volume is gone too → UNCONFIRMED instance_lost_volume_missing, still fenced and closed', async () => {
        const l = lost('terminated', null);
        expect(await reconcileGuestStop(l.deps, await placement(l.db), D)).toBe(true);
        expect(l.placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: 'instance_lost_volume_missing' });
        expect(l.fences).toHaveLength(1);
        expect(l.usage[0]!.stopped_at).not.toBeNull();
    });

    it('an unknown volume answer or a failed fence changes nothing; the next look recovers it', async () => {
        const l = lost('terminated', 'throw');
        expect(await reconcileGuestStop(l.deps, await placement(l.db), D)).toBe(false);
        expect(l.fences).toEqual([]);
        expect(l.placements[0]).toMatchObject({ state: 'RUNNING' });
        const f = lost('terminated', 'available', { fenceOk: false });
        expect(await reconcileGuestStop(f.deps, await placement(f.db), D)).toBe(false);
        expect(f.placements[0]).toMatchObject({ state: 'RUNNING' });
        expect(f.usage[0]!.stopped_at).toBeNull();
        f.control.fenceOk = true;
        expect(await reconcileGuestStop(f.deps, await placement(f.db), D)).toBe(true);
        expect(f.placements[0]).toMatchObject({ state: 'STOPPED', last_error: 'instance_lost' });
    });

    it('without a volume describe the lost instance is left for a look that can check it', async () => {
        const l = lost('terminated', 'available', { noVolumeDescribe: true });
        expect(await reconcileGuestStop(l.deps, await placement(l.db), D)).toBe(false);
        expect(l.placements[0]).toMatchObject({ state: 'RUNNING' });
    });

    it.each(['running', 'pending'])('a live instance (%s) is never treated as lost', async (state) => {
        const l = lost(state, 'available');
        expect(await reconcileGuestStop(l.deps, await placement(l.db), D)).toBe(false);
        expect(l.volumes).toEqual([]);
        expect(l.placements[0]).toMatchObject({ state: 'RUNNING' });
    });

    it('the fleet pass recovers it too', async () => {
        const l = lost('terminated', 'available');
        const fleet = await reconcileAwsFleet({ ...l.deps, executions: { describe: async () => ({ status: 'RUNNING' }) } as LifecycleExecutionReader }, { 'ap-south-1': D });
        expect(fleet).toMatchObject({ checked: 1 });
        expect(l.placements[0]).toMatchObject({ state: 'STOPPED', last_error: 'instance_lost' });
    });
});
