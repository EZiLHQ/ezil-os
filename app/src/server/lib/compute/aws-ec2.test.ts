/**
 * Real aws-ec2 provider (C-1, C-3) against the fake placement database and a
 * recording lifecycle starter. No AWS calls. Persistence model under test:
 * stop = instance stopped on its retained volume; wake = cold boot of the
 * same instance in the SAME region; a full home region refuses, never hops.
 */

import { describe, expect, it } from 'vitest';

import { AWS_RETIREMENT_UNDERWAY, AWS_STATE_FOR, createAwsEc2Provider, type AwsProviderDeps, type LifecycleStarter } from './aws-ec2';
import type { AwsTier } from './aws-config';
import { LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleIntent } from './aws-intent';
import { fixtureDeployment } from './aws-intent.test-support';
import { nonceHashOf } from './aws-enroll';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { ENROLLMENT_FAILED, PLACEMENT_STATES, PlacementOwnerError, readPlacement, transitionPlacementAsReconciler, type Placement, type PlacementState } from './placement';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const NOW = new Date('2026-10-14T06:00:00Z');
const ctx = { correlationId: 'corr' };
const opts = { sessionId: 's', desktopMode: 'neko' } as const;
const TYPES = ['t3a.medium', 't3.medium', 'm6i.large'];
const DEPLOYMENTS = { 'ap-south-1': fixtureDeployment('ap-south-1', TYPES), 'us-east-1': fixtureDeployment('us-east-1', TYPES) };

const env = (over: Record<string, string> = {}) => ({
    EZIL_AWS_COMPUTERS_ENABLED: '1',
    AWS_MAX_RUNNING: '10',
    EZIL_AWS_USER_MONTHLY_HOURS: '100',
    EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50',
    EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
    AWS_REGIONS: 'ap-south-1,us-east-1',
    EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
    EZIL_AWS_MAX_RUNNING_US_EAST_1: '2',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify(DEPLOYMENTS),
    EZIL_AWS_ENROLL_URL: ENROLL_URL,
    ...over,
});

const ENROLL_URL = 'https://app.example.test/api/compute/aws/enroll';
/** Deterministic nonce bytes: 32 × 0x07 → base64url 'BwcH…' (43 chars). */
const NONCE_BYTES = Buffer.alloc(32, 7);
const NONCE = NONCE_BYTES.toString('base64url');
/** The host lease JSON a launch's user data carries (lease.py). */
const leaseOf = (userData: string | null) => JSON.parse(Buffer.from(userData!, 'base64').toString('utf8')) as Record<string, unknown>;

function recordingStarter(fail = false) {
    const calls: { region: string; stateMachineArn: string; name: string; intent: LifecycleIntent; digest: string }[] = [];
    const starter: LifecycleStarter = {
        async start(region, work) {
            const envelope = JSON.parse(work.input) as { document: string; digest: string };
            calls.push({ region, stateMachineArn: work.stateMachineArn, name: work.name, intent: JSON.parse(envelope.document), digest: envelope.digest });
            if (fail) throw new Error('ExecutionLimitExceeded');
        },
    };
    return { starter, calls };
}

function setup(
    seed: Parameters<typeof createFakePlacementDb>[0] = {},
    over: Partial<AwsProviderDeps> & { e?: Record<string, string>; tier?: AwsTier; failStart?: boolean; dbClock?: () => Date } = {},
) {
    const fake = createFakePlacementDb({ computers: [{ id: C1, user_id: U1 }], ...seed }, over.dbClock ? { clock: over.dbClock } : {});
    const rec = recordingStarter(over.failStart);
    const provider = createAwsEc2Provider({
        db: fake.db,
        env: () => over.e ?? env(),
        now: () => NOW,
        newId: () => crypto.randomUUID(),
        starter: 'starter' in over ? over.starter : rec.starter,
        tierFor: 'tierFor' in over ? over.tierFor : async () => over.tier ?? 'free',
        randomBytes: over.randomBytes ?? (() => Buffer.from(NONCE_BYTES)),
        ...(over.executions ? { executions: over.executions } : {}),
        ...(over.describer ? { describer: over.describer } : {}),
        ...(over.tunnels ? { tunnels: over.tunnels } : {}),
    });
    return { ...fake, ...rec, provider };
}

const FS = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5';
const FENCE = 'fe0fe0fe-fe0f-4e0f-8e0f-e0fe0fe0fe0f';
/** A stopped computer as a completed provision leaves it: instance, volume, fs uuid and generation fence recorded. */
const stopped = (over: Record<string, unknown> = {}) =>
    placementRow({
        computer_id: C1, region: 'ap-south-1', instance_type: 't3a.medium', instance_id: 'i-11111111111111111', volume_id: 'vol-11111111111111111',
        fs_uuid: FS, fence_token: FENCE, ...over,
    });
const startMode = (over: Record<string, string> = {}) => env({ EZIL_AWS_WAKE_MODE: 'start', EZIL_AWS_LIFECYCLE_USERDATA_NONCE: '1', ...over });

describe('configuration refusals happen before any statement', () => {
    it.each([
        ['flag off', { e: { ...env(), EZIL_AWS_COMPUTERS_ENABLED: '0' } }, 'aws_disabled'],
        ['no regions', { e: env({ AWS_REGIONS: '' }) }, 'aws_config_invalid'],
        ['no deployment for a configured region', { e: env({ [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ 'ap-south-1': DEPLOYMENTS['ap-south-1'] }) }) }, 'aws_config_invalid'],
        ['no lifecycle starter', { starter: undefined }, 'aws_lifecycle_unconfigured'],
    ] as const)('%s → %s', async (_n, over, code) => {
        const { provider, statements, calls } = setup({}, over as never);
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toEqual({ ok: false, error: code, errorCode: code, retryable: false });
        expect(statements).toEqual([]);
        expect(calls).toEqual([]);
    });

    it.each([
        ['no tier source', { tierFor: undefined }, 'aws_tier_unavailable'],
        ['tier source fails', { tierFor: async () => { throw new Error('billing down'); } }, 'aws_tier_unavailable'],
        ['no enrollment URL', { e: env({ EZIL_AWS_ENROLL_URL: '' }) }, 'aws_enrollment_unavailable'],
        ['a plain-http enrollment URL', { e: env({ EZIL_AWS_ENROLL_URL: 'http://app.example.test/api/compute/aws/enroll' }) }, 'aws_enrollment_unavailable'],
        ['an enrollment URL on another path', { e: env({ EZIL_AWS_ENROLL_URL: 'https://app.example.test/api/other' }) }, 'aws_enrollment_unavailable'],
    ] as const)('new computer with %s → %s and no placement written', async (_n, over, code) => {
        const { provider, placements, calls } = setup({}, over as never);
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ ok: false, errorCode: code, retryable: false });
        expect(placements).toEqual([]);
        expect(calls).toEqual([]);
    });
});

describe('ensure: a new computer', () => {
    it('Mumbai full → provisioned in the US region with the free tier (2 vCPU / 4 GiB) and its own deployment', async () => {
        const { provider, placements, calls } = setup({}, { e: env({ EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '0' }) });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toEqual({ ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true });
        expect(placements).toHaveLength(1);
        expect(placements[0]).toMatchObject({ region: 'us-east-1', instance_type: 't3a.medium', state: 'PROVISIONING', owner_user_id: U1 });
        expect(calls).toHaveLength(1);
        const [call] = calls;
        expect(call).toMatchObject({ region: 'us-east-1', stateMachineArn: DEPLOYMENTS['us-east-1'].stateMachineVersionArn, name: `computer-${call!.intent.jobId}` });
        expect(call!.intent).toMatchObject({
            operation: 'provision', computerId: C1, instanceType: 't3a.medium', dataVolumeGiB: 20, leaseEpoch: 1, targetGeneration: 1,
            providerInstanceId: null, dataVolumeId: null, deployment: DEPLOYMENTS['us-east-1'],
        });
    });

    it('plus tier records the 2 vCPU / 8 GiB type and a 50 GiB disk', async () => {
        const { provider, placements, calls } = setup({}, { tier: 'plus' });
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        expect(placements[0]).toMatchObject({ region: 'ap-south-1', instance_type: 'm6i.large' });
        expect(calls[0]!.intent).toMatchObject({ instanceType: 'm6i.large', dataVolumeGiB: 50, deployment: DEPLOYMENTS['ap-south-1'] });
    });

    it('every region full → capacity_unavailable, nothing written, nothing started', async () => {
        const { provider, placements, calls } = setup({}, { e: env({ EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '0', EZIL_AWS_MAX_RUNNING_US_EAST_1: '0' }) });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toEqual({ ok: false, error: 'region_capacity', errorCode: 'capacity_unavailable', retryable: false });
        expect(placements).toEqual([]);
        expect(calls).toEqual([]);
    });

    it('a region deployment that does not allow the tier type: the intent is refused inside admission and NO row is written', async () => {
        const e = env({ [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ ...DEPLOYMENTS, 'ap-south-1': fixtureDeployment('ap-south-1', ['m6i.large']) }) });
        const { provider, placements, calls, statements } = setup({}, { e });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ ok: false, errorCode: 'aws_intent_invalid' });
        expect(placements).toEqual([]);
        expect(calls).toEqual([]);
        expect(statements.some((st) => st.sql === 'ROLLBACK')).toBe(true);
    });

    it('StartExecution refused → the placement is UNCONFIRMED, never a PROVISIONING row without an execution', async () => {
        const { provider, placements, calls } = setup({}, { failStart: true });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ ok: false, errorCode: 'aws_lifecycle_start_failed', retryable: false });
        expect(calls).toHaveLength(1);
        expect(placements[0]).toMatchObject({ state: 'UNCONFIRMED' });
    });

});

describe('C-6 nonce issue at provision (step 1)', () => {
    it('the launch user data carries the one-time nonce; the row holds ONLY its sha256 and a ≤10 min deadline, written by the same insert', async () => {
        const { provider, placements, calls, statements } = setup();
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        const lease = leaseOf(calls[0]!.intent.userData);
        expect(lease).toEqual({
            v: 1, computerId: C1, fsUuid: placements[0]!.fs_uuid, generation: 1, leaseEpoch: 1, nonce: NONCE, provision: true, enrollUrl: ENROLL_URL,
        });
        expect(placements[0]).toMatchObject({ enroll_nonce_hash: nonceHashOf(NONCE), enroll_expires_at: new Date(NOW.getTime() + 600_000).toISOString() });
        // The plaintext is never written: no statement parameter holds it.
        expect(JSON.stringify(statements.map((st) => st.params))).not.toContain(NONCE);
        // One insert, carrying hash, deadline, fence, job and digest together.
        const insert = statements.find((st) => st.sql.includes('placement:insert'))!;
        for (const col of ['enroll_nonce_hash', 'enroll_expires_at', 'fence_token', 'lifecycle_job_id', 'lifecycle_digest', 'fs_uuid', 'zone_id']) expect(insert.sql).toContain(col);
    });

    it('the row records the job, digest and fence of exactly the execution that was started', async () => {
        const { provider, placements, calls } = setup();
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        expect(placements[0]).toMatchObject({
            lifecycle_job_id: calls[0]!.intent.jobId, lifecycle_digest: calls[0]!.digest, fence_token: calls[0]!.intent.fenceToken,
            zone_id: DEPLOYMENTS['ap-south-1'].zoneId, region: 'ap-south-1',
        });
        expect(calls[0]!.name).toBe(`computer-${calls[0]!.intent.jobId}`);
    });

    it('every provision gets a fresh nonce (two computers, two different hashes)', async () => {
        const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
        let n = 0;
        const { provider, placements } = setup({ computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U2 }] }, { randomBytes: () => Buffer.alloc(32, ++n) });
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        await provider.ensure(ctx, { userId: U2, computerId: C2 }, opts);
        expect(placements).toHaveLength(2);
        expect(placements[0]!.enroll_nonce_hash).not.toBe(placements[1]!.enroll_nonce_hash);
    });

    it('a short random source is refused before any write', async () => {
        const { provider, placements, calls } = setup({}, { randomBytes: () => Buffer.alloc(16, 1) });
        await expect(provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).rejects.toThrow('32 random bytes');
        expect(placements).toEqual([]);
        expect(calls).toEqual([]);
    });
});

/** The lifecycle receipt path is not built yet (lane A3): tests stand in for it with CAS transitions. */
async function receipt(db: Parameters<typeof transitionPlacementAsReconciler>[0], to: PlacementState, fields: Parameters<typeof transitionPlacementAsReconciler>[1]['fields'] = {}): Promise<Placement> {
    const { record } = await readPlacement(db, C1);
    const r = await transitionPlacementAsReconciler(db, { computerId: C1, expected: record!, to, fields });
    if (!r.ok) throw new Error(`receipt ${record!.state} -> ${to}: ${r.reason}`);
    return r.placement;
}
const INSTANCE_2 = 'i-22222222222222222';

describe('lease epochs: a provisioned computer can wake (C-3/C-4 disk-marker fence)', () => {
    // The host guard (infra/host-agent guard.py) mounts only when the disk marker's
    // epoch is BELOW the lease epoch, and the marker carries the epoch of the last
    // boot. So every wake must lease strictly above the provision's epoch.
    it('provision → receipt (STOPPED) → wake: the wake intent leases strictly above the provision epoch', async () => {
        const { provider, placements, calls, db } = setup();
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        const provisionEpoch = calls[0]!.intent.leaseEpoch;
        expect(calls[0]!.intent.operation).toBe('provision');
        expect(provisionEpoch).toBe(1);
        // The row records the same epoch the provision intent carries (and the host wrote).
        expect(placements[0]).toMatchObject({ state: 'PROVISIONING', lease_epoch: provisionEpoch });
        await receipt(db, 'STOPPED', { instanceId: 'i-11111111111111111', volumeId: 'vol-11111111111111111' });
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        expect(calls[1]!.intent).toMatchObject({ operation: 'replace', previousInstanceId: 'i-11111111111111111', dataVolumeId: 'vol-11111111111111111' });
        expect(calls[1]!.intent.leaseEpoch).toBeGreaterThan(provisionEpoch);
        expect(placements[0]).toMatchObject({ state: 'STARTING', lease_epoch: calls[1]!.intent.leaseEpoch });
    });

    it('provision → receipt RUNNING (boots straight in) → user stop → receipt STOPPED → wake leases above the provision', async () => {
        const { provider, placements, calls, db } = setup();
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        await receipt(db, 'RUNNING', { instanceId: 'i-11111111111111111', volumeId: 'vol-11111111111111111' });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toEqual({ ok: true });
        expect(await provider.stop(ctx, { userId: U1, computerId: C1 }, 'user')).toMatchObject({ outcome: 'stopping' });
        // The stop carries the provision's fence: the instance and volume are tagged with it.
        expect(calls[1]!.intent).toMatchObject({ operation: 'stop', leaseEpoch: calls[0]!.intent.leaseEpoch, fenceToken: calls[0]!.intent.fenceToken });
        await receipt(db, 'STOPPED');
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        expect(calls[2]!.intent.operation).toBe('replace');
        expect(calls[2]!.intent.previousFenceToken).toBe(calls[0]!.intent.fenceToken);
        expect(calls[2]!.intent.leaseEpoch).toBeGreaterThan(calls[0]!.intent.leaseEpoch);
        expect(placements[0]).toMatchObject({ state: 'STARTING' });
    });

    it('every later wake leases above the previous boot and hands its generation fence on (replace → stop → replace)', async () => {
        const { provider, calls, db } = setup();
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        await receipt(db, 'STOPPED', { instanceId: 'i-11111111111111111', volumeId: 'vol-11111111111111111' });
        let marker = calls[0]!.intent.leaseEpoch;
        let fence = calls[0]!.intent.fenceToken;
        let generation = calls[0]!.intent.targetGeneration;
        for (let wake = 0; wake < 2; wake++) {
            await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
            const boot = calls.at(-1)!.intent;
            expect(boot.operation).toBe('replace');
            expect(boot.leaseEpoch).toBeGreaterThan(marker);
            expect(boot).toMatchObject({ previousGeneration: generation, previousFenceToken: fence, targetGeneration: generation + 1 });
            expect(boot.fenceToken).not.toBe(fence);
            marker = boot.leaseEpoch;
            fence = boot.fenceToken;
            generation = boot.targetGeneration;
            await receipt(db, 'MOUNTING');
            await receipt(db, 'RUNNING', { instanceId: wake === 0 ? INSTANCE_2 : 'i-33333333333333333' });
            await receipt(db, 'DRAINING');
            await receipt(db, 'STOPPING');
            await receipt(db, 'STOPPED');
        }
    });
});

describe('ensure: wake by replace (default): a NEW instance on the SAME volume, same region', () => {
    it('STOPPED → leased (generation + 1, epoch + 1, new fence, nonce hash) → replace intent → STARTING', async () => {
        const { provider, placements, calls, statements } = setup({ placements: [stopped({ generation: 3, lease_epoch: 7 })] });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toEqual({ ok: false, error: 'computer_starting', errorCode: 'computer_starting', retryable: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ region: 'ap-south-1', stateMachineArn: DEPLOYMENTS['ap-south-1'].stateMachineVersionArn });
        const i = calls[0]!.intent;
        expect(i).toMatchObject({
            operation: 'replace', targetGeneration: 4, leaseEpoch: 8, providerInstanceId: null, dataVolumeId: 'vol-11111111111111111',
            previousGeneration: 3, previousInstanceId: 'i-11111111111111111', previousFenceToken: FENCE, instanceType: 't3a.medium', dataVolumeGiB: null,
        });
        expect(i.fenceToken).not.toBe(FENCE);
        expect(leaseOf(i.userData)).toEqual({
            v: 1, computerId: C1, volumeId: 'vol-11111111111111111', fsUuid: FS, generation: 4, leaseEpoch: 8, nonce: NONCE, provision: false, enrollUrl: ENROLL_URL,
        });
        expect(placements[0]).toMatchObject({
            state: 'STARTING', generation: 4, lease_epoch: 8, region: 'ap-south-1', fence_token: i.fenceToken, instance_id: null,
            enroll_nonce_hash: nonceHashOf(NONCE), lifecycle_job_id: i.jobId, lifecycle_digest: calls[0]!.digest,
        });
        expect(JSON.stringify(statements.map((st) => st.params))).not.toContain(NONCE);
        // The nonce hash, fence and job are written by the LEASE compare-and-swap itself.
        const lease = statements.find((st) => st.sql.includes('placement:cas') && st.sql.includes("'LEASED'") === false && st.params.includes('LEASED'))!;
        for (const col of ['fence_token', 'enroll_nonce_hash', 'lifecycle_job_id', 'lifecycle_digest']) expect(lease.sql).toContain(col);
    });

    it('a failed enrollment forces replace even in start mode at the running caps', async () => {
        const { provider, placements, calls } = setup({
            placements: [stopped({ state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED, generation: 3, lease_epoch: 7 })],
        }, { e: startMode({ AWS_MAX_RUNNING: '1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '1' }) });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'computer_starting' });
        expect(calls[0]!.intent).toMatchObject({
            operation: 'replace', targetGeneration: 4, leaseEpoch: 8, previousInstanceId: 'i-11111111111111111',
        });
        expect(placements[0]).toMatchObject({ state: 'STARTING', last_error: null, instance_id: null, enroll_nonce_hash: nonceHashOf(NONCE) });
    });

    it('enrollment recovery credits only its own running slot', async () => {
        const { provider, calls } = setup({ placements: [
            stopped({ state: 'UNCONFIRMED', last_error: ENROLLMENT_FAILED }),
            stopped({ computer_id: 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2', owner_user_id: U2, state: 'RUNNING' }),
        ] }, { e: env({ AWS_MAX_RUNNING: '1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '1' }) });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ ok: false });
        expect(calls).toEqual([]);
    });

    it('an unrelated UNCONFIRMED failure cannot enter the enrollment recovery path', async () => {
        const { provider, placements, calls } = setup({ placements: [stopped({ state: 'UNCONFIRMED', last_error: 'receipt_conflict' })] });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'computer_recovering' });
        expect(placements[0]).toMatchObject({ state: 'UNCONFIRMED', last_error: 'receipt_conflict' });
        expect(calls).toEqual([]);
    });

    it('a US computer wakes in the US even though Mumbai comes first', async () => {
        const { provider, calls } = setup({ placements: [stopped({ region: 'us-east-1' })] });
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        expect(calls[0]).toMatchObject({ region: 'us-east-1' });
        expect(calls[0]!.intent.deployment).toEqual(DEPLOYMENTS['us-east-1']);
    });

    it('home region full → capacity_unavailable; never another region, placement untouched', async () => {
        const { provider, placements, calls } = setup({ placements: [stopped()] }, { e: env({ EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '0', EZIL_AWS_MAX_RUNNING_US_EAST_1: '9' }) });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toEqual({ ok: false, error: 'region_capacity', errorCode: 'capacity_unavailable', retryable: false });
        expect(calls).toEqual([]);
        expect(placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 0, generation: 1, region: 'ap-south-1', enroll_nonce_hash: null });
    });

    it('StartExecution refused on a replace → UNCONFIRMED (the generation already moved; recovery decides), never STOPPED on a half-moved row', async () => {
        const { provider, placements } = setup({ placements: [stopped()] }, { failStart: true });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'aws_lifecycle_start_failed' });
        expect(placements[0]).toMatchObject({ state: 'UNCONFIRMED', generation: 2 });
    });

    it.each([
        ['instance', { instance_id: null }],
        ['volume', { volume_id: null }],
        ['fs uuid', { fs_uuid: null }],
        ['generation fence', { fence_token: null }],
    ] as const)('a STOPPED row missing its %s is not woken', async (_n, over) => {
        const { provider, calls, placements } = setup({ placements: [stopped(over)] });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'aws_placement_incomplete' });
        expect(calls).toEqual([]);
        expect(placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 0 });
    });

    it('no enrollment URL → nothing leased, nothing started', async () => {
        const { provider, calls, placements } = setup({ placements: [stopped()] }, { e: env({ EZIL_AWS_ENROLL_URL: '' }) });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'aws_enrollment_unavailable' });
        expect(calls).toEqual([]);
        expect(placements[0]).toMatchObject({ state: 'STOPPED', lease_epoch: 0 });
    });

    it('the replace intent parses with the shared schema and its user data stays under 4096 characters', async () => {
        const { provider, calls } = setup({ placements: [stopped()] });
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        expect(calls[0]!.intent.userData!.length).toBeLessThan(4096);
    });

    it.each([
        ['RUNNING', { ok: true }],
        ['STARTING', { ok: false, errorCode: 'computer_starting', retryable: true }],
        ['MOUNTING', { ok: false, errorCode: 'computer_starting', retryable: true }],
        ['STOPPING', { ok: false, errorCode: 'computer_stopping', retryable: true }],
        ['UNCONFIRMED', { ok: false, errorCode: 'computer_recovering', retryable: false }],
        ['RETIRED', { ok: false, errorCode: 'computer_unavailable', retryable: false }],
    ] as const)('%s answers %j without starting anything', async (state, answer) => {
        const { provider, calls } = setup({ placements: [stopped({ state })] });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject(answer);
        expect(calls).toEqual([]);
    });

    it("another user's placement is NOT_FOUND upstream (PlacementOwnerError), whatever ezil_computers says", async () => {
        const { provider, calls } = setup({ placements: [stopped({ owner_user_id: U2 })] });
        await expect(provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).rejects.toBeInstanceOf(PlacementOwnerError);
        await expect(provider.stop(ctx, { userId: U1, computerId: C1 }, 'user')).rejects.toBeInstanceOf(PlacementOwnerError);
        expect(calls).toEqual([]);
    });
});

describe('wake mode configuration', () => {
    it('start mode WITH the userData-nonce feature: start in place, same generation and fence, nonce in user data', async () => {
        const { provider, placements, calls } = setup({ placements: [stopped({ lease_epoch: 2 })] }, { e: startMode() });
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        const i = calls[0]!.intent;
        expect(i).toMatchObject({
            operation: 'start', providerInstanceId: 'i-11111111111111111', dataVolumeId: 'vol-11111111111111111', targetGeneration: 1, leaseEpoch: 3,
            fenceToken: FENCE, previousGeneration: null, dataVolumeGiB: null,
        });
        expect(leaseOf(i.userData)).toMatchObject({ generation: 1, leaseEpoch: 3, volumeId: 'vol-11111111111111111', nonce: NONCE, provision: false });
        expect(placements[0]).toMatchObject({ state: 'STARTING', generation: 1, lease_epoch: 3, fence_token: FENCE, enroll_nonce_hash: nonceHashOf(NONCE) });
    });

    it('start mode: StartExecution refused → back to STOPPED (only the epoch moved; a later wake raises it again)', async () => {
        const { provider, placements } = setup({ placements: [stopped()] }, { e: startMode(), failStart: true });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ errorCode: 'aws_lifecycle_start_failed' });
        expect(placements[0]).toMatchObject({ state: 'STOPPED', generation: 1 });
    });

    it.each([
        ['start without the userData-nonce feature (a started host could never enroll)', { EZIL_AWS_WAKE_MODE: 'start' }],
        ['start with the feature set to anything but 1', { EZIL_AWS_WAKE_MODE: 'start', EZIL_AWS_LIFECYCLE_USERDATA_NONCE: 'true' }],
        ['an unknown wake mode', { EZIL_AWS_WAKE_MODE: 'hibernate' }],
    ] as const)('%s → aws_config_invalid before any statement', async (_n, over) => {
        const { provider, calls, statements } = setup({ placements: [stopped()] }, { e: env(over) });
        expect(await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts)).toMatchObject({ ok: false, errorCode: 'aws_config_invalid' });
        expect(statements).toEqual([]);
        expect(calls).toEqual([]);
    });

    it("explicit 'replace' equals the default", async () => {
        const { provider, calls } = setup({ placements: [stopped()] }, { e: env({ EZIL_AWS_WAKE_MODE: 'replace' }) });
        await provider.ensure(ctx, { userId: U1, computerId: C1 }, opts);
        expect(calls[0]!.intent.operation).toBe('replace');
    });
});

describe('stop and status', () => {
    it('RUNNING → DRAINING (job recorded) → stop intent with the generation fence → STOPPING; not confirmed until the receipt', async () => {
        const { provider, placements, calls } = setup({ placements: [stopped({ state: 'RUNNING', lease_epoch: 4 })] });
        expect(await provider.stop(ctx, { userId: U1, computerId: C1 }, 'user')).toEqual({ ok: false, terminated: false, outcome: 'stopping' });
        expect(calls[0]!.intent).toMatchObject({
            operation: 'stop', providerInstanceId: 'i-11111111111111111', dataVolumeId: 'vol-11111111111111111', leaseEpoch: 4, fenceToken: FENCE, userData: null,
        });
        expect(placements[0]).toMatchObject({ state: 'STOPPING', lifecycle_job_id: calls[0]!.intent.jobId, lifecycle_digest: calls[0]!.digest });
    });

    it('a RUNNING row without its generation fence is not stopped through the lifecycle', async () => {
        const { provider, calls } = setup({ placements: [stopped({ state: 'RUNNING', fence_token: null })] });
        expect(await provider.stop(ctx, { userId: U1, computerId: C1 }, 'user')).toMatchObject({ ok: false, outcome: 'aws_placement_incomplete' });
        expect(calls).toEqual([]);
    });

    it('stop start failure → UNCONFIRMED (the reconciler decides), never back to RUNNING', async () => {
        const { provider, placements } = setup({ placements: [stopped({ state: 'RUNNING', lease_epoch: 4 })] }, { failStart: true });
        expect(await provider.stop(ctx, { userId: U1, computerId: C1 }, 'user')).toMatchObject({ ok: false, outcome: 'aws_lifecycle_start_failed' });
        expect(placements[0]).toMatchObject({ state: 'UNCONFIRMED' });
    });

    it('an already stopped computer is confirmed stopped without starting anything', async () => {
        const { provider, calls } = setup({ placements: [stopped()] });
        expect(await provider.stop(ctx, { userId: U1, computerId: C1 }, 'idle_reap')).toEqual({ ok: true, terminated: false, outcome: 'already_stopped' });
        expect(calls).toEqual([]);
    });

    it('status maps every placement state (exhaustive) and reports the region', async () => {
        expect(Object.keys(AWS_STATE_FOR).sort()).toEqual([...PLACEMENT_STATES].sort());
        for (const [state, want] of [['RUNNING', 'running'], ['STOPPED', 'stopped'], ['LEASED', 'starting'], ['STOPPING', 'stopping'], ['UNCONFIRMED', 'error']] as const) {
            const { provider } = setup({ placements: [stopped({ state, region: 'us-east-1' })] });
            const s = await provider.status(ctx, { userId: U1, computerId: C1 });
            expect(s).toMatchObject({ ok: want !== 'error', state: want, placementState: state, region: 'us-east-1' });
        }
    });

    it('activity on a stopped computer renews nothing; restart refuses explicitly', async () => {
        const { provider, placements } = setup({ placements: [stopped()] });
        expect(await provider.activity(ctx, { userId: U1, computerId: C1 }, { lastInputAgoMs: 0 })).toEqual({ ok: false, error: 'placement_stopped' });
        expect(placements[0]).toMatchObject({ lease_until: null, presence_at: null });
        expect(await provider.restart(ctx, { userId: U1, computerId: C1 })).toMatchObject({ ok: false, error: 'aws_not_supported' });
    });
});

/** A Step Functions reader whose answer the test sets; receipts are built from the job the provider started. */
function scriptedExecutions() {
    let answer: { status: string; output?: string | null; startDate?: Date | null } = { status: 'RUNNING' };
    const executions: NonNullable<AwsProviderDeps['executions']> = { describe: async () => answer };
    const succeed = (call: { intent: LifecycleIntent; digest: string }, state: 'running' | 'stopped' | 'retired', startDate: Date | null = null) => {
        answer = {
            status: 'SUCCEEDED', startDate,
            output: JSON.stringify({
                schemaVersion: 1, jobId: call.intent.jobId, digest: call.digest, computerId: call.intent.computerId, generation: call.intent.targetGeneration,
                leaseEpoch: call.intent.leaseEpoch, fenceToken: call.intent.fenceToken, instanceId: call.intent.providerInstanceId, volumeId: call.intent.dataVolumeId, state,
            }),
        };
    };
    return { executions, succeed };
}

describe('Codex #3: computer.delete retires an AWS computer before it is soft-deleted', () => {
    const me = { userId: U1, computerId: C1 };

    it('no placement (never provisioned): ok at once, nothing written or started', async () => {
        const { provider, placements, calls } = setup();
        expect(await provider.terminate(ctx, me)).toEqual({ ok: true, terminated: true, outcome: 'no_placement' });
        expect(placements).toEqual([]);
        expect(calls).toEqual([]);
    });

    it('STOPPED → RETIRING with a retire intent of the current generation (volume kept); not ok until the receipt', async () => {
        const { provider, placements, calls } = setup({ placements: [stopped({ lease_epoch: 4 })] });
        expect(await provider.terminate(ctx, me)).toEqual({ ok: false, terminated: false, outcome: 'retiring' });
        expect(calls).toHaveLength(1);
        expect(calls[0]!.intent).toMatchObject({
            operation: 'retire', providerInstanceId: 'i-11111111111111111', dataVolumeId: 'vol-11111111111111111', fenceToken: FENCE, leaseEpoch: 4,
            targetGeneration: 1, userData: null, dataVolumeGiB: null,
        });
        expect(placements[0]).toMatchObject({ state: 'RETIRING', lifecycle_job_id: calls[0]!.intent.jobId, lifecycle_digest: calls[0]!.digest });
    });

    it('the retired receipt lands RETIRED and only then is the delete ok', async () => {
        const { executions, succeed } = scriptedExecutions();
        const { provider, placements, calls } = setup({ placements: [stopped({ lease_epoch: 4 })] }, { executions });
        expect(await provider.terminate(ctx, me)).toMatchObject({ ok: false, outcome: 'retiring' });
        expect(await provider.terminate(ctx, me)).toMatchObject({ ok: false, outcome: 'retiring' }); // execution still running
        succeed(calls[0]!, 'retired');
        expect(await provider.terminate(ctx, me)).toEqual({ ok: true, terminated: true, outcome: 'retired' });
        expect(placements[0]).toMatchObject({ state: 'RETIRED', lifecycle_job_id: null, volume_id: 'vol-11111111111111111' });
        expect(calls).toHaveLength(1);
    });

    it('a RUNNING computer starts its retire at once (the retire job stops it gracefully, then terminates): one delete', async () => {
        const { provider, placements, calls } = setup({ placements: [stopped({ state: 'RUNNING', lease_epoch: 4 })] });
        expect(await provider.terminate(ctx, me)).toEqual({ ok: false, terminated: false, outcome: 'retiring' });
        expect(AWS_RETIREMENT_UNDERWAY).toContain('retiring');
        expect(calls.map((c) => c.intent.operation)).toEqual(['retire']);
        expect(placements[0]).toMatchObject({ state: 'RETIRING', lifecycle_job_id: calls[0]!.intent.jobId });
    });

    it('a refused retire StartExecution of a RUNNING computer goes back to RUNNING (nothing ran) and is not "underway"', async () => {
        const { provider, placements } = setup({ placements: [stopped({ state: 'RUNNING', lease_epoch: 2 })] }, { failStart: true });
        const r = await provider.terminate(ctx, me);
        expect(r).toMatchObject({ ok: false, outcome: 'aws_lifecycle_start_failed' });
        expect(AWS_RETIREMENT_UNDERWAY).not.toContain(r.outcome);
        expect(placements[0]).toMatchObject({ state: 'RUNNING' });
    });

    it.each(['DRAINING', 'STOPPING'] as const)('%s with a recorded stop job answers retire_after_stop (the reconcile retires it once STOPPED)', async (state) => {
        const { provider, calls } = setup({ placements: [stopped({ state, lifecycle_job_id: '99999999-9999-4999-8999-999999999999', lifecycle_digest: 'd'.repeat(64) })] });
        expect(await provider.terminate(ctx, me)).toEqual({ ok: false, terminated: false, outcome: 'retire_after_stop' });
        expect(AWS_RETIREMENT_UNDERWAY).toContain('retire_after_stop');
        expect(calls).toEqual([]);
    });

    it('a refused retire StartExecution goes back to STOPPED (nothing ran)', async () => {
        const { provider, placements } = setup({ placements: [stopped({ lease_epoch: 2 })] }, { failStart: true });
        expect(await provider.terminate(ctx, me)).toMatchObject({ ok: false, outcome: 'aws_lifecycle_start_failed' });
        expect(placements[0]).toMatchObject({ state: 'STOPPED' });
    });

    it.each([
        ['UNCONFIRMED', 'computer_recovering'], ['RECOVERING', 'computer_recovering'], ['STARTING', 'computer_starting'], ['STOPPING', 'stopping'], ['RETIRING', 'computer_unavailable'],
    ] as const)('%s refuses the delete with %s and starts nothing', async (state, outcome) => {
        const { provider, calls } = setup({ placements: [stopped({ state })] });
        expect(await provider.terminate(ctx, me)).toEqual({ ok: false, terminated: false, outcome });
        expect(calls).toEqual([]);
    });

    it("another user's placement is not retired (NOT_FOUND upstream)", async () => {
        const { provider, calls } = setup({ placements: [stopped({ owner_user_id: U2 })] });
        await expect(provider.terminate(ctx, me)).rejects.toBeInstanceOf(PlacementOwnerError);
        expect(calls).toEqual([]);
    });
});

describe('Codex #6: a guest-initiated idle stop is reconciled into the placement', () => {
    const me = { userId: U1, computerId: C1 };
    const describerSaying = (state: string | 'throw' | null) => {
        const asked: string[] = [];
        const describer: NonNullable<AwsProviderDeps['describer']> = {
            async describeForEnrollment(region, instanceId) {
                asked.push(`${region} ${instanceId}`);
                if (state === 'throw') throw new Error('throttled');
                return state === null ? null : ({ instanceId, state } as never);
            },
        };
        return { describer, asked };
    };

    it.each(['stopped', 'stopping'])('status: RUNNING but EC2 says %s → the ordinary stop runs through the lifecycle', async (ec2) => {
        const { describer, asked } = describerSaying(ec2);
        const { provider, placements, calls } = setup({ placements: [stopped({ state: 'RUNNING', lease_epoch: 4 })] }, { describer });
        expect(await provider.status(ctx, me)).toMatchObject({ state: 'stopping', placementState: 'STOPPING' });
        expect(asked).toEqual(['ap-south-1 i-11111111111111111']);
        expect(calls).toHaveLength(1);
        expect(calls[0]!.intent).toMatchObject({ operation: 'stop', providerInstanceId: 'i-11111111111111111', fenceToken: FENCE, leaseEpoch: 4 });
        expect(placements[0]).toMatchObject({ state: 'STOPPING', lifecycle_job_id: calls[0]!.intent.jobId });
    });

    it('…and its stopped receipt lands STOPPED, after which an open wakes it', async () => {
        const { describer } = describerSaying('stopped');
        const { executions, succeed } = scriptedExecutions();
        const { provider, placements, calls } = setup({ placements: [stopped({ state: 'RUNNING', lease_epoch: 4 })] }, { describer, executions });
        await provider.status(ctx, me);
        succeed(calls[0]!, 'stopped');
        expect(await provider.status(ctx, me)).toMatchObject({ state: 'stopped', placementState: 'STOPPED' });
        expect(placements[0]).toMatchObject({ state: 'STOPPED', lifecycle_job_id: null });
        expect(await provider.ensure(ctx, me, opts)).toMatchObject({ ok: false, errorCode: 'computer_starting', retryable: true });
        expect(calls.map((c) => c.intent.operation)).toEqual(['stop', 'replace']);
    });

    it('ensure on an idle-stopped RUNNING row answers "stopping" (the shell keeps waking), never ok', async () => {
        const { describer } = describerSaying('stopped');
        const { provider, calls } = setup({ placements: [stopped({ state: 'RUNNING', lease_epoch: 2 })] }, { describer });
        expect(await provider.ensure(ctx, me, opts)).toEqual({ ok: false, error: 'computer_stopping', errorCode: 'computer_stopping', retryable: true });
        expect(calls.map((c) => c.intent.operation)).toEqual(['stop']);
    });

    it.each([['running'], ['pending'], ['throw'], [null]] as const)('EC2 says %s → nothing changes', async (ec2) => {
        const { describer } = describerSaying(ec2);
        const { provider, placements, calls } = setup({ placements: [stopped({ state: 'RUNNING' })] }, { describer });
        expect(await provider.ensure(ctx, me, opts)).toEqual({ ok: true });
        expect(calls).toEqual([]);
        expect(placements[0]).toMatchObject({ state: 'RUNNING' });
    });

    it('a capacity refusal settles the fleet: another user\'s idle-stopped row is stopped, freeing its slot', async () => {
        const C2 = 'c2c2c2c2-c2c2-4c2c-8c2c-c2c2c2c2c2c2';
        const { describer, asked } = describerSaying('stopped');
        const { provider, placements, calls } = setup(
            { placements: [stopped({ computer_id: C2, owner_user_id: U2, state: 'RUNNING', lease_epoch: 2 })], computers: [{ id: C1, user_id: U1 }, { id: C2, user_id: U2 }] },
            { describer, e: env({ AWS_MAX_RUNNING: '1' }) },
        );
        expect(await provider.ensure(ctx, me, opts)).toMatchObject({ ok: false, errorCode: 'capacity_unavailable' });
        expect(asked).toEqual(['ap-south-1 i-11111111111111111']);
        expect(calls.map((c) => [c.intent.operation, c.intent.computerId])).toEqual([['stop', C2]]);
        expect(placements.find((r) => r.computer_id === C2)).toMatchObject({ state: 'STOPPING', owner_user_id: U2 });
    });
});

describe('Codex 4275911832: the lease deadline and hour caps bind during a session', () => {
    const me = { userId: U1, computerId: C1 };
    const HOUR = 3_600_000;
    const at = (v: unknown) => new Date(v as string | Date).getTime();
    const running = (over: Record<string, unknown> = {}) => stopped({ state: 'RUNNING', lease_epoch: 4, lease_until: new Date(NOW.getTime() + HOUR), ...over });
    /** A closed usage row of `h` hours ending now (inside this UTC month). */
    const hours = (h: number, user = U1) => ({
        computer_id: C1, user_id: user, instance_id: 'i-1', instance_type: 't3a.medium', started_at: new Date(NOW.getTime() - h * HOUR), stopped_at: NOW,
        egress_bytes: null, observed_by: 'x', updated_at: NOW,
    });
    const casCount = (statements: { sql: string }[]) => statements.filter((s) => s.sql.includes('placement:cas')).length;

    it('a provision leases for an hour, like every wake', async () => {
        const { provider, placements } = setup();
        await provider.ensure(ctx, me, opts);
        expect(at(placements[0]!.lease_until)).toBe(NOW.getTime() + HOUR);
    });

    it('status: a lapsed lease stops the instance through the ordinary lifecycle stop (lease_expired)', async () => {
        const { provider, placements, calls } = setup({ placements: [running({ lease_until: new Date(NOW.getTime() - 1) })] });
        expect(await provider.status(ctx, me)).toMatchObject({ state: 'stopping', placementState: 'STOPPING' });
        expect(calls.map((c) => c.intent.operation)).toEqual(['stop']);
        expect(calls[0]!.intent).toMatchObject({ providerInstanceId: 'i-11111111111111111', fenceToken: FENCE, leaseEpoch: 4 });
        expect(placements[0]).toMatchObject({ state: 'STOPPING', last_error: 'lease_expired', lifecycle_job_id: calls[0]!.intent.jobId });
    });

    it('a RUNNING row with no lease at all is treated as lapsed (fail closed)', async () => {
        const { provider, placements, calls } = setup({ placements: [running({ lease_until: null })] });
        expect(await provider.status(ctx, me)).toMatchObject({ state: 'stopping' });
        expect(calls.map((c) => c.intent.operation)).toEqual(['stop']);
        expect(placements[0]).toMatchObject({ last_error: 'lease_expired' });
    });

    it('status is not presence: a live lease is neither renewed nor stopped, and nothing is written', async () => {
        const lease = new Date(NOW.getTime() + 10 * 60_000);
        const { provider, placements, calls, statements } = setup({ placements: [running({ lease_until: lease })] });
        expect(await provider.status(ctx, me)).toMatchObject({ state: 'running' });
        expect(calls).toEqual([]);
        expect(at(placements[0]!.lease_until)).toBe(lease.getTime());
        expect(casCount(statements)).toBe(0);
    });

    it.each([
        ['the user', () => [hours(100)], 'user_hours_cap'],
        ['everyone (global)', () => Array.from({ length: 6 }, () => hours(100, U2)), 'global_hours_cap'],
    ] as const)('status: %s at the monthly hour cap → the running instance is stopped (%s)', async (_n, usage, code) => {
        const { provider, placements, calls } = setup({ placements: [running()], usage: usage() });
        expect(await provider.status(ctx, me)).toMatchObject({ state: 'stopping' });
        expect(calls.map((c) => c.intent.operation)).toEqual(['stop']);
        expect(placements[0]).toMatchObject({ last_error: code });
    });

    it('under the caps with a live lease, nothing stops', async () => {
        const { provider, calls } = setup({ placements: [running()], usage: [hours(99)] });
        expect(await provider.status(ctx, me)).toMatchObject({ state: 'running' });
        expect(calls).toEqual([]);
    });

    it('activity: fresh presence renews the lease from the presence instant, and not on every beat', async () => {
        const { provider, placements, statements } = setup({ placements: [running({ lease_until: new Date(NOW.getTime() + 10 * 60_000) })] });
        expect(await provider.activity(ctx, me, { lastInputAgoMs: 60_000 })).toEqual({ ok: true });
        expect(at(placements[0]!.presence_at)).toBe(NOW.getTime() - 60_000);
        expect(at(placements[0]!.lease_until)).toBe(NOW.getTime() - 60_000 + HOUR);
        // More than half of the renewed lease is left: the next beat writes nothing.
        const before = casCount(statements);
        expect(await provider.activity(ctx, me, { lastInputAgoMs: 0 })).toEqual({ ok: true });
        expect(casCount(statements)).toBe(before);
    });

    it('activity: the release beat (presence 30 min ago) renews nothing, so a lapsed lease is stopped', async () => {
        const { provider, placements, calls } = setup({ placements: [running({ lease_until: new Date(NOW.getTime() - 1) })] });
        expect(await provider.activity(ctx, me, { lastInputAgoMs: 30 * 60_000 })).toEqual({ ok: false, error: 'lease_expired' });
        expect(calls.map((c) => c.intent.operation)).toEqual(['stop']);
        expect(placements[0]).toMatchObject({ state: 'STOPPING', last_error: 'lease_expired', presence_at: null });
    });

    it('activity: an owner at the hour cap is stopped within a beat, presence notwithstanding', async () => {
        const { provider, placements, calls } = setup({ placements: [running()], usage: [hours(100)] });
        expect(await provider.activity(ctx, me, { lastInputAgoMs: 0 })).toEqual({ ok: false, error: 'user_hours_cap' });
        expect(calls.map((c) => c.intent.operation)).toEqual(['stop']);
        expect(placements[0]).toMatchObject({ last_error: 'user_hours_cap' });
    });

    it('activity never shortens a lease', async () => {
        const far = new Date(NOW.getTime() + 5 * HOUR);
        const { provider, placements, statements } = setup({ placements: [running({ lease_until: far })] });
        expect(await provider.activity(ctx, me, { lastInputAgoMs: 0 })).toEqual({ ok: true });
        expect(at(placements[0]!.lease_until)).toBe(far.getTime());
        expect(casCount(statements)).toBe(0);
    });

    it("another user's heartbeat renews nothing (NOT_FOUND upstream)", async () => {
        const lease = new Date(NOW.getTime() + 60_000);
        const { provider, placements } = setup({ placements: [running({ lease_until: lease })] });
        await expect(provider.activity(ctx, { userId: U2, computerId: C1 }, { lastInputAgoMs: 0 })).rejects.toBeInstanceOf(PlacementOwnerError);
        expect(at(placements[0]!.lease_until)).toBe(lease.getTime());
    });

    it('ensure (an explicit open) renews a lapsed lease instead of stopping what the owner is opening', async () => {
        const { provider, placements, calls } = setup({ placements: [running({ lease_until: new Date(NOW.getTime() - 1) })] });
        expect(await provider.ensure(ctx, me, opts)).toEqual({ ok: true });
        expect(calls).toEqual([]);
        expect(at(placements[0]!.lease_until)).toBe(NOW.getTime() + HOUR);
    });

    it('ensure at the hour cap stops the running computer and answers the cap', async () => {
        const { provider, calls } = setup({ placements: [running()], usage: [hours(100)] });
        expect(await provider.ensure(ctx, me, opts)).toMatchObject({ ok: false, errorCode: 'user_hours_cap' });
        expect(calls.map((c) => c.intent.operation)).toEqual(['stop']);
    });
});
