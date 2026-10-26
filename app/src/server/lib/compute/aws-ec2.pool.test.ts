import { createHash } from 'node:crypto';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { Ec2EnrollmentView } from './aws-enroll';
import type { Ec2VolumeView } from './aws-clients';
import { POOL_OPEN_RELEASE_FAILED } from './aws-pool-recovery';
import { PoolCapacityPressure } from './aws-pool-errors';
import { describe, expect, it, vi } from 'vitest';
vi.mock('@/server/billing/deps', () => ({ getBillingDeps: vi.fn(() => { throw new Error('inject billing'); }) }));
import { createAwsEc2Provider, type AwsProviderDeps } from './aws-ec2';
import { applyLifecycleReceipt, enforceSessionLimits, isPoolMode, POOL_RELEASED, reconcileGuestStop,
    lifecycleExecutionArn, reconcileAwsFleet, sessionEndWork, type PoolDeps, type PoolHostRow } from './aws-receipts';
import { fixtureDeployment } from './aws-intent.test-support';
import { buildLifecycleWork, LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleIntent, type LifecycleWork } from './aws-intent';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { consumeEnrollmentNonce, finishEnrollment, ImageJobConflictError, publishAttachedPoolClaim, readPlacement,
    reservePoolHostForBoot, type PlacementDb, type PlacementExecutor, type Placement } from './placement';
import { poolPriorityForEntitlement } from './select';
import { stopComputerForPolicy } from './stop-policy';
import type { EntitlementRecord } from './tier';

const U = '11111111-1111-4111-8111-111111111111';
const C = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const HOST = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INSTANCE = 'i-22222222222222222';
const VOLUME = 'vol-11111111111111111';
const NOW = new Date('2026-10-23T12:00:00Z');
const ctx = { correlationId: 'pool-test' };
const computer = { computerId: C, userId: U };
const options = { sessionId: 'session', desktopMode: 'neko' } as const;
const D = { ...fixtureDeployment('ap-south-1', ['t3a.medium', 'm6i.large', 'm6i.xlarge', 'm6i.2xlarge']), namespace: 'mum',
    stateMachineVersionArn: 'arn:aws:states:ap-south-1:123456789012:stateMachine:ezil-mum-lifecycle:1' };
const paid: EntitlementRecord = { status: 'active', source: 'billing_v2', provider: 'aws', planId: 'standard_monthly_v2', size: 'std-2' };
const host: PoolHostRow = { poolHostId: HOST, poolGeneration: 1, region: D.region, zoneId: D.zoneId, instanceType: 'm6i.large',
    instanceId: INSTANCE, state: 'leased', readyAt: new Date(NOW.getTime() - 120_000), enrolledAt: NOW,
    leasedComputerId: C, leasedAt: NOW, claimGeneration: null, claimLeaseEpoch: null, claimFence: null, claimVolumeSerial: null };

const workOf = buildLifecycleWork;
function untrustedWork(intent: LifecycleIntent): LifecycleWork {
    const document = JSON.stringify(intent), digest = createHash('sha256').update(document).digest('hex');
    return { intent, digest, input: JSON.stringify({ schemaVersion: 1, document, digest }), name: `computer-${intent.jobId}`,
        stateMachineArn: intent.deployment.stateMachineVersionArn };
}
function stopped(over: Record<string, unknown> = {}) {
    return placementRow({ computer_id: C, owner_user_id: U, region: D.region, zone_id: D.zoneId, instance_type: 'm6i.large',
        instance_id: 'i-11111111111111111', volume_id: VOLUME, generation: 3, lease_epoch: 4,
        fs_uuid: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', fence_token: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        state: 'STOPPED', last_error: POOL_RELEASED, ...over });
}
function setup(o: { rows?: Record<string, unknown>[]; host?: PoolHostRow | null; entitlement?: EntitlementRecord | null;
    noPool?: boolean; deployment?: typeof D; lostStart?: boolean; env?: Record<string, string> } = {}) {
    let clock = NOW;
    let executionStatus = 'RUNNING';
    let inputOverride: string | undefined;
    let outputOverride: Record<string, unknown> = {};
    let executionOverride: Record<string, unknown> = {};
    const leasedHost = { ...host };
    const sourceTags = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': D.namespace,
        'ezil:computer-id': C, 'ezil:generation': '3', 'ezil:fence-token': 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
    const volume: Ec2VolumeView = { volumeId: VOLUME, state: 'available', attachments: [], encrypted: true,
        kmsKeyId: D.dataKeyArn, zoneId: D.zoneId, tags: sourceTags };
    const source: Ec2EnrollmentView = { instanceId: 'i-11111111111111111', state: o.rows?.[0]?.state === 'RUNNING' ? 'running' : 'stopped', instanceType: 'm6i.large',
        availabilityZone: 'ap-south-1a', availabilityZoneId: D.zoneId, publicIp: null, tags: sourceTags,
        volumes: [{ volumeId: VOLUME, deleteOnTermination: false, tags: sourceTags }] };
    const poolView: Ec2EnrollmentView = { ...source, instanceId: INSTANCE, state: 'running', rootDeviceName: '/dev/sda1',
        tags: { 'ezil:pool': '1', 'ezil:pool-host': HOST, 'ezil:namespace': D.namespace, 'ezil:stage': D.namespace,
            'ezil:managed-by': 'app-computer-platform' },
        volumes: [{ volumeId: 'vol-22222222222222222', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} }] };
    const fake = createFakePlacementDb({ computers: [{ id: C, user_id: U }], placements: o.rows }, { clock: () => clock });
    const wrap = (tx: PlacementExecutor): PlacementExecutor => ({ execute: async query => {
        const q = new PgDialect().sqlToQuery(query);
        if (q.sql.includes('pool:refused-adopt')) {
            const matches = q.params[0] === leasedHost.poolHostId && q.params[1] === leasedHost.instanceId
                && q.params[2] === leasedHost.leasedComputerId && leasedHost.state === 'leased'
                && [leasedHost.claimGeneration, leasedHost.claimLeaseEpoch, leasedHost.claimFence, leasedHost.claimVolumeSerial].every(v => v === null);
            if (!matches) return [];
            leasedHost.state = 'retiring'; leasedHost.leasedComputerId = null; return [{ id: HOST }];
        }
        return tx.execute(query);
    } });
    const db: PlacementDb = { ...wrap(fake.db), transaction: fn => fake.db.transaction(tx => fn(wrap(tx))) };
    const d = o.deployment ?? D;
    const e = { EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', AWS_REGIONS: d.region,
        EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '10', EZIL_AWS_MAX_RUNNING_US_EAST_1: '10',
        EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
        EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200',
        EZIL_AWS_ENROLL_URL: 'https://app.example.test/api/compute/aws/enroll',
        EZIL_AWS_WAKE_MODE: 'start', EZIL_AWS_LIFECYCLE_USERDATA_NONCE: '1',
        [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify({ [d.region]: d }), ...o.env };
    const starts: (LifecycleWork | LifecycleWork)[] = [];
    const pool: PoolDeps = {
        validateCapacity: vi.fn(async (_tx, p) => { expect(fake.placements[0]!.instance_id).toBe(p.instanceId); }),
        leasePoolHost: vi.fn(async () => o.host === undefined ? { ...host } : o.host),
        publishPoolClaim: vi.fn(async () => ({ ...host })),
        buildWork: vi.fn(workOf),
        replenish: vi.fn(async () => {
            expect(fake.statements.at(-1)?.sql).toBe('COMMIT');
            expect(fake.placements[0]?.lifecycle_digest).toBeTruthy();
        }),
    };
    const meter = { ready: vi.fn(async () => {}), stopped: vi.fn(async () => {}), heartbeat: vi.fn(async () => {}) };
    const deps: AwsProviderDeps = { db, env: () => e, now: () => clock, randomBytes: () => Buffer.alloc(32, 7),
        entitlement: o.entitlement === undefined ? paid : o.entitlement, pool: o.noPool ? undefined : pool, meter, sleep: async () => {},
        describer: { describeVolume: vi.fn(async () => volume),
            describeForEnrollment: vi.fn(async (_region, id) => id === INSTANCE ? poolView : source) },
        starter: { start: vi.fn(async (_region, work) => {
            executionStatus = 'RUNNING';
            const envelope = JSON.parse(work.input);
            starts.push({ ...work, digest: envelope.digest, intent: JSON.parse(envelope.document) });
            if (o.lostStart) throw new Error('lost response');
        }) },
        executions: { describe: vi.fn(async () => {
            const work = starts.at(-1)!;
            const i = work.intent;
            return { status: executionStatus, input: inputOverride ?? work.input, startDate: NOW, redriveCount: 0,
                executionArn: lifecycleExecutionArn(d, i.jobId), stateMachineVersionArn: work.stateMachineArn, ...executionOverride,
                output: JSON.stringify({ schemaVersion: 1, jobId: i.jobId, digest: work.digest, computerId: C,
                    generation: i.targetGeneration, leaseEpoch: i.leaseEpoch, fenceToken: i.fenceToken,
                    instanceId: i.providerInstanceId ?? INSTANCE, volumeId: i.dataVolumeId ?? VOLUME,
                    state: i.operation === 'release' ? 'retired' : i.operation === 'stop' ? 'stopped' : 'running', ...outputOverride }) };
        }) },
    };
    const provider = createAwsEc2Provider(deps);
    const placement = async () => (await readPlacement(fake.db, C)).record!;
    return { ...fake, db, pool, deps, meter, starts, provider, placement, volume, source, poolView, leasedHost,
        executionFields: (fields: Record<string, unknown>) => { executionOverride = fields; },
        ensure: () => provider.ensure(ctx, computer, options), status: () => provider.status(ctx, computer),
        at: (seconds: number) => { clock = new Date(NOW.getTime() + seconds * 1000); },
        execution: (status: string) => { executionStatus = status; },
        input: (input: string) => { inputOverride = input; },
        receipt: (fields: Record<string, unknown>) => { outputOverride = fields; },
        ready: async () => {
            const p = await placement();
            // Simulate the nonce issued by the claim endpoint after attachment.
            if (!p.enrollNonceHash) {
                p.enrollNonceHash = 'a'.repeat(64);
                p.enrollExpiresAt = new Date(clock.getTime() + 600_000);
                fake.placements[0]!.enroll_nonce_hash = p.enrollNonceHash;
                fake.placements[0]!.enroll_expires_at = p.enrollExpiresAt;
            }
            const consumed = await consumeEnrollmentNonce(fake.db, { computerId: C, expected: p, nonceHash: p.enrollNonceHash!,
                fields: { instanceId: INSTANCE, volumeId: VOLUME } });
            expect(consumed.ok).toBe(true);
            if (!consumed.ok) throw new Error('nonce not consumed');
            const initial = await finishEnrollment(fake.db, { computerId: C, expected: consumed.placement, success: true, poolClaim: true });
            expect(initial.ok).toBe(true);
            expect((await placement()).lastError).toBe('pool_session_pending');
            expect(meter.ready).not.toHaveBeenCalled();
            expect((await finishEnrollment(fake.db, { computerId: C, expected: (await placement()), success: true,
                poolClaim: true, sessionReady: true })).ok).toBe(true);
        },
    };
}

describe('POOL-OPEN warm lifecycle', () => {
    it.each([false, true])('lease/adopt/claim/ready bills only at claim completion, reopen=%s', async reopen => {
        const s = setup({ rows: reopen ? [stopped()] : [] });
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting', retryable: true });
        expect(s.pool.leasePoolHost).toHaveBeenCalledWith(expect.anything(), { region: D.region, zoneId: D.zoneId, instanceType: 'm6i.large', deployment:D }, C, 1, NOW);
        expect(s.pool.validateCapacity).toHaveBeenCalledOnce();
        expect(s.pool.replenish).toHaveBeenCalledOnce();
        expect(s.starts).toHaveLength(1);
        expect((await s.placement()).enrollNonceHash).toBeNull();
        expect(s.starts[0].intent.userData).toBeNull();
        expect(s.starts[0].intent).toMatchObject({ operation: 'adopt', poolHostId: HOST, providerInstanceId: INSTANCE,
            targetGeneration: reopen ? 4 : 1, leaseEpoch: reopen ? 5 : 1,
            ...(reopen ? { dataVolumeId: VOLUME } : { dataVolumeId: null, dataVolumeGiB: 50 }) });
        expect(await s.status()).toMatchObject({ state: 'starting' });
        expect(s.pool.publishPoolClaim).not.toHaveBeenCalled();
        s.execution('SUCCEEDED'); s.at(5);
        expect(await s.status()).toMatchObject({ state: 'starting' });
        expect(s.pool.publishPoolClaim).toHaveBeenCalledWith(expect.anything(), HOST, {
            computerId: C, generation: reopen ? 4 : 1, leaseEpoch: reopen ? 5 : 1,
            fence: s.starts[0].intent.fenceToken, volumeSerial: VOLUME.replace('-', ''),
        }, new Date(NOW.getTime() + 5000));
        expect(s.usage).toHaveLength(0);
        expect(s.meter.ready).not.toHaveBeenCalled();
        expect((await s.placement()).lifecycleJobId).toBe(s.starts[0].intent.jobId);
        s.at(20); await s.ready();
        const completedAt = (await s.placement()).updatedAt;
        expect(completedAt.getTime()).toBeGreaterThanOrEqual(NOW.getTime() + 20_000);
        expect(completedAt.getTime()).toBeLessThan(NOW.getTime() + 21_000);
        s.at(60); expect(await s.status()).toMatchObject({ state: 'running' });
        expect(s.meter.ready).toHaveBeenCalledExactlyOnceWith({ userId: U, computerId: C, size: 'std-2',
            readyAt: completedAt, overheadSeconds: 20 });
        expect(s.usage).toHaveLength(1);
        expect(s.usage[0].started_at).toEqual(completedAt);
        expect(await s.ensure()).toEqual({ ok: true });
        expect(s.starts).toHaveLength(1);
    });

    it.each([false, true])('empty pool uses cold provision/replace, reopen=%s', async reopen => {
        const s = setup({ rows: reopen ? [stopped({ last_error: null })] : [], host: null });
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting' });
        expect(s.starts[0].intent.operation).toBe(reopen ? 'replace' : 'provision');
        expect(s.pool.replenish).not.toHaveBeenCalled();
    });

    it.each(['compute_monthly_v2', 'pro_monthly_v1'])('Premium %s passes priority 2 on the same large host', async planId => {
        const s = setup({ entitlement: { ...paid, planId } });
        await s.ensure();
        expect(s.pool.leasePoolHost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ instanceType: 'm6i.large' }), C, 2, NOW);
    });
    it.each(['cmp-4', 'cmp-8'] as const)('Premium selected %s uses a compatible spare or truthfully cold starts', async size => {
        const instanceType = size === 'cmp-4' ? 'm6i.xlarge' : 'm6i.2xlarge';
        for (const available of [true, false]) {
            const s = setup({host: available ? {...host, instanceType} : null,
                entitlement:{...paid,planId:'premium_monthly_v3',size}});
            expect(await s.ensure()).toMatchObject({errorCode:'computer_starting'});
            expect(s.pool.leasePoolHost).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({instanceType}),C,2,NOW);
            expect(s.starts[0].intent.operation).toBe(available ? 'adopt' : 'provision');
            expect(s.starts[0].intent.instanceType).toBe(instanceType);
        }
    });
    it.each(['cmp-4', 'cmp-8'] as const)('stopped selected %s preserves the disk with matching pool or fresh capacity', async size => {
        const instanceType = size === 'cmp-4' ? 'm6i.xlarge' : 'm6i.2xlarge';
        for (const available of [true, false]) {
            const s = setup({ rows: [stopped()], host: available ? { ...host, instanceType } : null,
                entitlement: { ...paid, planId: 'premium_monthly_v3', size } });
            expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting' });
            expect(s.pool.leasePoolHost).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ instanceType }), C, 2, NOW);
            expect(s.starts[0].intent).toMatchObject({ operation: available ? 'adopt' : 'replace', instanceType,
                dataVolumeId: VOLUME, targetGeneration: 4, leaseEpoch: 5 });
        }
    });
    it('a running size change retains the current host and disk until normal stop', async () => {
        const s = setup({ rows: [stopped({ state: 'RUNNING', instance_type: 'm6i.xlarge', last_error: null,
            lease_until: new Date(NOW.getTime() + 3600_000) })] });
        expect(await s.ensure()).toEqual({ ok: true });
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled();
        expect(s.starts).toHaveLength(0);
        expect(await s.placement()).toMatchObject({ state: 'RUNNING', instanceType: 'm6i.xlarge', volumeId: VOLUME, generation: 3, leaseEpoch: 4 });
    });
    it('missing P8 wiring on reopen refuses without changing the stopped placement', async () => {
        const s = setup({ rows: [stopped()], noPool: true });
        expect(await s.ensure()).toMatchObject({ errorCode: 'aws_intent_invalid' });
        expect((await s.placement()).state).toBe('STOPPED'); expect(s.starts).toHaveLength(0);
    });
    it('an ambiguous accepted adoption still enables enrollment after its receipt', async () => {
        const s = setup({ rows: [stopped()], lostStart: true }); await s.ensure();
        expect((await s.placement()).state).toBe('LEASED');
        s.execution('SUCCEEDED'); await s.status(); expect((await s.placement()).state).toBe('STARTING');
        s.at(20); await s.ready(); expect(await s.status()).toMatchObject({ state: 'running' });
        expect(s.starts.every(w => w.intent.operation === 'adopt')).toBe(true);
    });
    it('free opens stay cold', async () => {
        const s = setup({ entitlement: null }); await s.ensure();
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled();
        expect(s.starts[0].intent.operation).toBe('provision');
    });
    it('an unpaid reopen of a retained large machine cannot lease a paid host', async () => {
        const s = setup({ rows: [stopped()], entitlement: null }); await s.ensure();
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled(); expect(s.starts[0].intent.operation).toBe('replace');
    });
    it('other namespaces retain start in place', async () => {
        const s = setup({ rows: [stopped({ last_error: null })], deployment: { ...D, namespace: 'pilot',
            stateMachineVersionArn: D.stateMachineVersionArn.replace('mum', 'pilot') } });
        await s.ensure(); expect(s.starts[0].intent.operation).toBe('start');
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled();
    });
    it('a released adopted host never starts in place with pool mode off', async () => {
        const s = setup({ rows: [stopped()], deployment: { ...D, namespace: 'pilot',
            stateMachineVersionArn: D.stateMachineVersionArn.replace('mum', 'pilot') } });
        await s.ensure(); expect(s.starts[0].intent.operation).toBe('replace');
    });
    it('mode requires both Mumbai and mum', () => {
        expect(isPoolMode(D)).toBe(true);
        expect(isPoolMode({ ...D, region: 'us-east-1' })).toBe(false);
        expect(isPoolMode({ ...D, namespace: 'pilot' })).toBe(false);
        expect(poolPriorityForEntitlement(undefined)).toBe(1);
    });

    it('missing P8 wiring fails closed before committing any boot', async () => {
        const s = setup({ noPool: true });
        expect(await s.ensure()).toMatchObject({ errorCode: 'aws_intent_invalid' });
        expect(s.starts).toHaveLength(0); expect(s.placements).toHaveLength(0);
    });
    it.each([{ EZIL_AWS_KILL_SWITCH: '1' }, { AWS_MAX_RUNNING: '0' }] as Record<string, string>[])('admission refusal never leases a pool host: %j', async env => {
        const s = setup({ env }); await s.ensure();
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled(); expect(s.starts).toHaveLength(0);
    });
    it.each(['state', 'leasedComputerId', 'instanceId', 'region', 'zoneId', 'instanceType'] as const)('invalid leased host %s aborts reservation', async key => {
        const s = setup({ host: { ...host, [key]: key === 'instanceId' ? null : 'wrong' } });
        expect(await s.ensure()).toMatchObject({ errorCode: 'aws_intent_invalid' });
        expect(s.starts).toHaveLength(0); expect(s.placements).toHaveLength(0);
    });
    it('image reservation blocks lease and adopt', async () => {
        const s = setup({ rows: [stopped({ image_upgrade_job_id: HOST })] });
        await expect(s.ensure()).rejects.toBeInstanceOf(ImageJobConflictError);
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled(); expect(s.starts).toHaveLength(0);
    });
    it('ambiguous adoption never falls through to cold, including a concurrent open', async () => {
        const s = setup({ rows: [stopped()], lostStart: true });
        await Promise.all([s.ensure(), s.ensure()]);
        expect(s.starts).toHaveLength(3);
        expect(s.starts.every(w => w.intent.operation === 'adopt')).toBe(true);
        expect(new Set(s.starts.map(w => w.input)).size).toBe(1);
        await s.ensure(); expect(s.starts).toHaveLength(3);
    });
    it('replenish failure preserves the committed adoption', async () => {
        const s = setup(); vi.mocked(s.pool.replenish).mockRejectedValue(new Error('planner failed'));
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        try { await s.ensure(); expect(s.starts[0].intent.operation).toBe('adopt'); }
        finally { log.mockRestore(); }
    });
});

describe('POOL-OPEN claim guards', () => {
    it.each(['FAILED', 'TIMED_OUT', 'ABORTED'])('%s adoption cannot cold retry', async status => {
        const s = setup(); await s.ensure(); s.execution(status); await s.status(); await s.ensure();
        expect(s.pool.publishPoolClaim).not.toHaveBeenCalled(); expect(s.starts).toHaveLength(1);
        expect((await s.placement()).state).toBe('UNCONFIRMED');
    });
    it.each(['', '{}', 'bad json', 'bad digest', 'bad document', 'unknown operation', 'bad pool id'])('untrusted execution input %s publishes nothing', async mutation => {
        const s = setup(); await s.ensure(); s.execution('SUCCEEDED');
        let input = mutation;
        if (mutation === 'bad digest') input = JSON.stringify({ ...JSON.parse(s.starts[0].input), digest: 'a'.repeat(64) });
        if (mutation === 'bad document') input = JSON.stringify({ ...JSON.parse(s.starts[0].input), document: JSON.stringify({ ...s.starts[0].intent, poolHostId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }) });
        if (mutation === 'unknown operation' || mutation === 'bad pool id') {
            const work = untrustedWork({ ...s.starts[0].intent, operation: mutation === 'unknown operation' ? 'unknown' : 'adopt', poolHostId: 'invalid' } as LifecycleIntent);
            s.placements[0].lifecycle_digest = work.digest; input = work.input;
        }
        s.input(input); await s.status();
        expect(s.pool.publishPoolClaim).not.toHaveBeenCalled(); expect(s.meter.ready).not.toHaveBeenCalled();
        expect((await s.placement()).state).toBe('PROVISIONING');
    });
    it('conflicting attach receipt never publishes a claim', async () => {
        const s = setup(); await s.ensure(); s.execution('SUCCEEDED'); s.receipt({ instanceId: 'i-33333333333333333' }); await s.status();
        expect(s.pool.publishPoolClaim).not.toHaveBeenCalled(); expect((await s.placement()).state).toBe('UNCONFIRMED');
    });
    it('missing publisher leaves adopt pending and unbilled', async () => {
        const s = setup(); await s.ensure(); s.execution('SUCCEEDED');
        await applyLifecycleReceipt({ ...s.deps, pool: undefined }, await s.placement(), D);
        expect(s.pool.publishPoolClaim).not.toHaveBeenCalled(); expect(s.meter.ready).not.toHaveBeenCalled();
        expect((await s.placement()).lifecycleJobId).toBeTruthy();
    });
    it('claim publication failure rolls back the attached disk record and can retry', async () => {
        const s = setup(); await s.ensure(); s.execution('SUCCEEDED');
        vi.mocked(s.pool.publishPoolClaim).mockRejectedValueOnce(new Error('write failed'));
        await expect(s.status()).rejects.toThrow('write failed');
        expect((await s.placement()).volumeId).toBeNull();
        expect(await s.status()).toMatchObject({ state: 'starting' });
        expect((await s.placement()).volumeId).toBe(VOLUME);
    });
    it('stale publication CAS cannot expose a claim', async () => {
        const s = setup(); await s.ensure(); const old = await s.placement();
        s.placements[0].lease_epoch = old.leaseEpoch + 1;
        await publishAttachedPoolClaim(s.db, old, VOLUME, tx => s.pool.publishPoolClaim(tx, HOST, {
            computerId: C, generation: old.generation, leaseEpoch: old.leaseEpoch, fence: old.fenceToken!, volumeSerial: VOLUME.replace('-', ''),
        }, NOW));
        expect(s.pool.publishPoolClaim).not.toHaveBeenCalled();
    });
    it('untrusted readback after enrollment cannot complete an adoption as a cold boot', async () => {
        const s = setup(); await s.ensure(); s.execution('SUCCEEDED'); await s.status(); await s.ready();
        s.input('{}'); await s.status(); expect(s.meter.ready).not.toHaveBeenCalled();
        expect((await s.placement()).state).toBe('PROVISIONING');
    });
    it.each([false, true])('a lost receipt transition race cannot publish or bill, enrolled=%s', async enrolled => {
        const s = setup({ rows: [stopped()], lostStart: true }); await s.ensure(); s.execution('SUCCEEDED');
        if (enrolled) { await s.status(); await s.ready(); }
        const p = await s.placement(); s.placements[0].state = 'DRAINING';
        vi.mocked(s.pool.publishPoolClaim).mockClear();
        await applyLifecycleReceipt(s.deps, p, D);
        expect(s.pool.publishPoolClaim).not.toHaveBeenCalled(); expect(s.meter.ready).not.toHaveBeenCalled();
    });
    it.each(['instance_id', 'lifecycle_job_id', 'lifecycle_digest', 'fence_token', 'last_error', 'updated_at', 'provider'])('publication is fenced by %s', async column => {
        const s = setup(); await s.ensure(); const p = await s.placement();
        const changes: Record<string, unknown> = { instance_id: 'i-33333333333333333', lifecycle_job_id: HOST,
            lifecycle_digest: 'a'.repeat(64), fence_token: HOST, last_error: 'enroll_succeeded',
            updated_at: new Date(NOW.getTime() + 1000), provider: 'cloudflare' };
        s.placements[0][column] = changes[column];
        if (column === 'provider') s.placements[0].workspace_store = 'r2';
        const publish = vi.fn(async () => {});
        await publishAttachedPoolClaim(s.db, p, VOLUME, publish);
        expect(publish).not.toHaveBeenCalled();
    });
    it.each(['owner_user_id', 'provider', 'lifecycle_job_id', 'lifecycle_digest'])('boot reservation binding is fenced by %s', async column => {
        const s = setup(); await s.ensure(); const p = await s.placement();
        const changes: Record<string, unknown> = { owner_user_id: HOST, provider: 'cloudflare', lifecycle_job_id: HOST, lifecycle_digest: 'a'.repeat(64) };
        await expect(reservePoolHostForBoot(s.db, async () => ({ admitted: true, placement: p }), async () => {
            s.placements[0][column] = changes[column];
            if (column === 'provider') s.placements[0].workspace_store = 'r2';
            return { instanceId: 'i-33333333333333333' };
        })).rejects.toThrow('pool_reservation_conflict');
    });
    it('image reservation inserted after adopt also blocks publication', async () => {
        const s = setup(); await s.ensure(); const p = await s.placement(); s.placements[0].image_upgrade_job_id = HOST;
        await expect(publishAttachedPoolClaim(s.db, p, VOLUME, async () => { throw new Error('published'); })).rejects.toBeInstanceOf(ImageJobConflictError);
    });
    it('reservation CAS failure aborts the transaction', async () => {
        const s = setup({ rows: [stopped()] }); const before = await s.placement();
        await expect(reservePoolHostForBoot(s.db, async () => ({ admitted: true, placement: { ...before, leaseEpoch: 999 } }),
            async () => ({ lifecycleJobId: HOST }))).rejects.toThrow('pool_reservation_conflict');
    });
});

describe('POOLFIX retained attachments and refused adoption', () => {
    const refusal = () => ({ error: 'LifecycleUnconfirmed', cause: JSON.stringify({
        lastError: { Error: 'none', Cause: 'none' }, throttles: 0,
        observeError: { Error: 'LifecycleFailure', Cause: JSON.stringify({ errorType: 'LifecycleFailure', errorMessage: 'lifecycle_volume_invalid' }) },
    }) });
    const attach = (s: ReturnType<typeof setup>) => {
        s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.source.instanceId, state: 'attached' }];
    };
    const refused = async (legacy = false) => {
        const s = setup({ rows: [stopped({ last_error: null })] });
        await s.ensure();
        s.execution('FAILED'); s.executionFields(refusal());
        if (legacy) {
            attach(s);
            s.placements[0].state = 'UNCONFIRMED'; s.placements[0].last_error = 'failed:LifecycleUnconfirmed';
        }
        return s;
    };
    it.each([null, POOL_RELEASED])('releases attached retained volume before leasing, even with stale marker %s', async last_error => {
        const s = setup({ rows: [stopped({ last_error })] }); attach(s);
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting' });
        expect(s.starts.map(w => w.intent.operation)).toEqual(['release']);
        expect(s.starts[0].intent.providerInstanceId).toBe(s.source.instanceId);
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled();
        expect(await s.status()).toMatchObject({ state: 'starting' });
        await s.ensure(); expect(s.starts).toHaveLength(1);
        s.execution('SUCCEEDED'); s.volume.state = 'available'; s.volume.attachments = []; s.source.state = 'terminated';
        await s.ensure(); expect(s.starts.map(w => w.intent.operation)).toEqual(['release', 'adopt']);
        expect(s.pool.leasePoolHost).toHaveBeenCalledOnce();
        s.execution('SUCCEEDED'); await s.status(); await s.ready();
        expect(await s.status()).toMatchObject({ state: 'running' });
        expect((await s.placement()).instanceId).toBe(INSTANCE);
    });
    it.each(['FAILED', 'TIMED_OUT', 'ABORTED', 'start-refused'])('release %s falls back cold without leasing', async failure => {
        const s = setup({ rows: [stopped({ last_error: null })] }); attach(s);
        if (failure === 'start-refused') vi.mocked(s.deps.starter!.start).mockRejectedValueOnce(Object.assign(new Error('denied'), {
            name: 'AccessDeniedException', $metadata: { httpStatusCode: 400 },
        }));
        await s.ensure();
        if (failure !== 'start-refused') { s.execution(failure); await s.status(); }
        expect((await s.placement()).lastError).toBe(POOL_OPEN_RELEASE_FAILED);
        // Even if release freed the disk before failing, this open stays cold.
        s.volume.state = 'available'; s.volume.attachments = [];
        await s.ensure(); expect(s.starts.at(-1)!.intent.operation).toBe('replace');
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled();
    });
    it('a lost release acknowledgement stays starting and cannot lease before its receipt', async () => {
        const s = setup({ rows: [stopped()], lostStart: true }); attach(s);
        await s.ensure(); await s.ensure();
        expect(await s.status()).toMatchObject({ state: 'starting' });
        expect(s.starts.every(w => w.intent.operation === 'release')).toBe(true);
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled();
        s.execution('SUCCEEDED'); s.volume.state = 'available'; s.volume.attachments = []; s.source.state = 'terminated';
        await s.ensure(); expect(s.starts.at(-1)!.intent.operation).toBe('adopt');
    });
    it.each(['elsewhere', 'missing-attachments', 'unknown', 'race'])('never leases/adopts with %s attachment evidence', async kind => {
        const s = setup({ rows: [stopped()] });
        if (kind === 'elsewhere') { attach(s); s.volume.attachments = [{ instanceId: 'i-33333333333333333', state: 'attached' }]; }
        if (kind === 'missing-attachments') s.volume.attachments = undefined;
        if (kind === 'unknown') vi.mocked(s.deps.describer!.describeVolume!).mockRejectedValue(new Error('unavailable'));
        if (kind === 'race') vi.mocked(s.deps.describer!.describeVolume!).mockResolvedValueOnce({ ...s.volume }).mockImplementation(async () => {
            attach(s); return s.volume;
        });
        await s.ensure(); expect(s.starts[0].intent.operation).toBe('replace');
        expect(s.pool.leasePoolHost).not.toHaveBeenCalled();
    });
    it('definite refusal restores source authority and burns the unclaimed host atomically', async () => {
        const s = await refused(); await s.status();
        expect(await s.placement()).toMatchObject({ state: 'STOPPED', instanceId: s.source.instanceId, volumeId: VOLUME,
            generation: 3, leaseEpoch: 5, fenceToken: s.source.tags['ezil:fence-token'], lastError: 'lifecycle_volume_invalid',
            lifecycleJobId: null, lifecycleDigest: null, enrollNonceHash: null });
        expect(s.leasedHost.state).toBe('retiring'); expect(s.meter.ready).not.toHaveBeenCalled();
        await s.status(); expect((await s.placement()).state).toBe('STOPPED');
    });
    it('a lost start acknowledgement preserves the source for a later definite refusal', async () => {
        const s = setup({ rows: [stopped()], lostStart: true }); await s.ensure();
        s.execution('FAILED'); s.executionFields(refusal()); await s.status();
        expect(await s.placement()).toMatchObject({ state: 'STOPPED', instanceId: s.source.instanceId });
        expect(s.leasedHost.state).toBe('retiring');
    });
    it('an ambiguous failure on a fresh adopt keeps the job and becomes UNCONFIRMED', async () => {
        const s = await refused(); s.executionFields({ error: 'States.Timeout' });
        const p = await s.placement(); await s.status();
        expect(await s.placement()).toMatchObject({ state: 'UNCONFIRMED', instanceId: INSTANCE,
            lifecycleJobId: p.lifecycleJobId, lifecycleDigest: p.lifecycleDigest, lastError: 'failed:States.Timeout' });
        expect(s.leasedHost.state).toBe('leased');
    });
    it.each(['status', 'fleet', 'ensure'])('heals existing UNCONFIRMED row through %s without a saved source', async path => {
        const s = await refused(true);
        if (path === 'fleet') await reconcileAwsFleet(s.deps, { [D.region]: D }, 10);
        else if (path === 'ensure') await s.ensure();
        else await s.status();
        expect(await s.placement()).toMatchObject({ state: path === 'ensure' ? 'STOPPING' : 'STOPPED', instanceId: s.source.instanceId, volumeId: VOLUME });
        expect(s.leasedHost.state).toBe('retiring');
        if (path === 'ensure') expect(s.starts.at(-1)!.intent.operation).toBe('release');
    });
    it.each(['timeout', 'task-error', 'wrong-observer', 'redrive', 'execution', 'digest', 'pool-tag', 'tenant-tag',
        'extra-disk', 'wrong-root', 'attached-to-pool', 'retagged-volume', 'source-running', 'source-fence', 'claimed', 'stale-placement'])('ambiguous %s remains UNCONFIRMED with lease reserved', async kind => {
        const s = await refused(true);
        if (kind === 'timeout') s.execution('TIMED_OUT');
        if (kind === 'task-error') {
            const f = refusal(), c = JSON.parse(f.cause); c.lastError = { Error: 'Ec2.ServiceException', Cause: 'lost' };
            s.executionFields({ ...f, cause: JSON.stringify(c) });
        }
        if (kind === 'wrong-observer') s.executionFields({ ...refusal(), cause: refusal().cause.replaceAll('LifecycleFailure', 'Error') });
        if (kind === 'redrive') s.executionFields({ ...refusal(), redriveCount: 1 });
        if (kind === 'execution') s.executionFields({ ...refusal(), executionArn: 'wrong' });
        if (kind === 'digest') s.input('{}');
        if (kind === 'pool-tag') s.poolView.tags = { ...s.poolView.tags, 'ezil:pool': '0' };
        if (kind === 'tenant-tag') s.poolView.tags = { ...s.poolView.tags, 'ezil:computer': C };
        if (kind === 'extra-disk') s.poolView.volumes = [...s.poolView.volumes, ...s.source.volumes];
        if (kind === 'wrong-root') s.poolView.rootDeviceName = '/dev/xvda';
        if (kind === 'attached-to-pool') s.volume.attachments = [{ instanceId: INSTANCE, state: 'attached' }];
        if (kind === 'retagged-volume') s.volume.tags = { ...s.volume.tags, 'ezil:generation': '4' };
        if (kind === 'source-running') s.source.state = 'running';
        if (kind === 'source-fence') s.source.tags = { ...s.source.tags, 'ezil:fence-token': HOST };
        if (kind === 'claimed') s.leasedHost.claimGeneration = 4;
        const p = await s.placement();
        if (kind === 'stale-placement') s.placements[0].lifecycle_digest = 'a'.repeat(64);
        await applyLifecycleReceipt(s.deps, p, D);
        expect((await s.placement()).state).toBe('UNCONFIRMED'); expect(s.leasedHost.state).toBe('leased');
    });
});

describe('POOL-OPEN release at every session end', () => {
    const running = () => stopped({ state: 'RUNNING', last_error: null, lease_until: new Date(NOW.getTime() + 3600_000) });
    it.each(['user_stop', 'session_max', 'allowance_exhausted', 'overage_cap'] as const)('policy %s issues release', async reason => {
        const s = setup({ rows: [running()] });
        const result = await stopComputerForPolicy(s.db, computer, reason, { route: (async () => ({ kind: 'aws-ec2', provider: s.provider })) as never });
        expect(result.result.outcome).toBe('stopping'); expect(s.starts[0].intent.operation).toBe('release');
        s.execution('SUCCEEDED'); expect(await s.status()).toMatchObject({ state: 'stopped' });
        expect((await s.placement()).lastError).toBe(POOL_RELEASED);
        expect((await s.placement()).volumeId).toBe(VOLUME);
        expect(s.meter.stopped).toHaveBeenCalledOnce();
        await s.ensure(); expect(s.starts.at(-1)!.intent.operation).toBe('adopt');
    });
    it.each(['lease_expired', 'user_hours_cap', 'global_hours_cap'] as const)('limit %s issues release', async reason => {
        const s = setup({ rows: [running()] }); const p = await s.placement();
        if (reason === 'lease_expired') p.leaseUntil = NOW;
        const totals = { hours: 1, weightedSeconds: 3600, egressBytes: 0 };
        const limit = await enforceSessionLimits(s.deps, p, D, { now: NOW, caps: {
            userMonthlyHours: reason === 'user_hours_cap' ? 1 : 100, globalMonthlyHours: reason === 'global_hours_cap' ? 1 : 100,
        }, usage: { byUser: new Map([[U, totals]]), global: totals } });
        expect(limit).toBe(reason); expect(s.starts[0].intent.operation).toBe('release');
    });
    it('guest shutdown issues release even on a cold fallback host', async () => {
        const s = setup({ rows: [running()] });
        expect(await reconcileGuestStop({ ...s.deps, describer: { describeForEnrollment: async () => ({
            instanceId: 'i-11111111111111111', state: 'stopped', availabilityZone: 'ap-south-1a', availabilityZoneId: D.zoneId,
            publicIp: null, tags: {}, volumes: [],
        }) } }, await s.placement(), D)).toBe(true);
        expect(s.starts[0].intent.operation).toBe('release');
    });
    it('pool mode off keeps the ordinary stop', async () => {
        const s = setup({ rows: [running()], deployment: { ...D, namespace: 'pilot', stateMachineVersionArn: D.stateMachineVersionArn.replace('mum', 'pilot') } });
        await s.provider.stop(ctx, computer, 'user'); expect(s.starts[0].intent.operation).toBe('stop');
    });
    it('missing release builder cannot silently retain a stopped instance', async () => {
        const s = setup({ rows: [running()], noPool: true });
        expect(await s.provider.stop(ctx, computer, 'user')).toMatchObject({ outcome: 'aws_intent_invalid' });
        expect(s.starts).toHaveLength(0); expect((await s.placement()).state).toBe('RUNNING');
    });
    it('ambiguous release retries the same release after settled execution absence', async () => {
        const s = setup({ rows: [running()], lostStart: true }); await s.provider.stop(ctx, computer, 'user');
        s.at(301);
        const absent = { describe: async () => { throw Object.assign(new Error('absent'), { name: 'ExecutionDoesNotExist', $metadata: { httpStatusCode: 400 } }); } };
        await applyLifecycleReceipt({ ...s.deps, executions: absent, clock: s.deps.now }, await s.placement(), D);
        expect(s.starts).toHaveLength(6);
        expect(s.starts.every(w => w.intent.operation === 'release')).toBe(true);
        expect(new Set(s.starts.map(w => w.input)).size).toBe(1);
    });
});

it('billing uses the durable session-ready time even after placement progress changes updated_at', async () => {
    const s = setup(); await s.ensure(); s.execution('SUCCEEDED'); await s.status(); s.at(20); await s.ready();
    const at = (await s.placement()).updatedAt;
    s.pool.readyAt = vi.fn(async () => at);
    s.placements[0]!.updated_at = new Date(NOW.getTime() + 50_000);
    s.at(60); await s.status();
    expect(s.meter.ready).toHaveBeenCalledWith(expect.objectContaining({ readyAt: at }));
});
it('a missing durable readiness timestamp cannot open a tenant epoch', async () => {
    const s = setup(); await s.ensure(); s.execution('SUCCEEDED'); await s.status(); s.at(20); await s.ready();
    s.pool.readyAt = vi.fn(async () => null);
    expect(await s.status()).toMatchObject({ state: 'starting' });
    expect(s.meter.ready).not.toHaveBeenCalled();
});


describe('RECOVER-UNCONF product open', () => {
    it('open/status poll recovery as starting, then the next normal open adopts', async () => {
        const s = setup({ rows: [stopped({ state: 'UNCONFIRMED', last_error: 'failed:LifecycleUnconfirmed' })] });
        const failed = sessionEndWork(await s.placement(), D, 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', s.pool);
        s.starts.push(failed);
        Object.assign(s.placements[0], { lifecycle_job_id: failed.intent.jobId, lifecycle_digest: failed.digest });
        s.source.rootDeviceName = '/dev/sda1';
        s.source.volumes = [{ volumeId: 'vol-33333333333333333', deviceName: '/dev/sda1', deleteOnTermination: true, tags: {} },
            { volumeId: VOLUME, deviceName: '/dev/sdf', deleteOnTermination: false, tags: s.source.tags }];
        s.volume.state = 'in-use'; s.volume.attachments = [{ instanceId: s.source.instanceId, state: 'attached' }];
        const stopDate = new Date(NOW.getTime() - 3600_000);
        s.execution('FAILED'); s.executionFields({ startDate: new Date(stopDate.getTime() - 60_000), stopDate });
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting', retryable: true });
        expect((await s.placement()).state).toBe('RECOVERING');
        expect(s.starts.map(w => w.intent.operation)).toEqual(['release', 'release']);
        expect(await s.status()).toMatchObject({ ok: true, state: 'starting' });
        s.execution('SUCCEEDED'); s.volume.state = 'available'; s.volume.attachments = [];
        expect(await s.status()).toMatchObject({ ok: true, state: 'stopped' });
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting', retryable: true });
        expect(s.starts.map(w => w.intent.operation)).toEqual(['release', 'release', 'adopt']);
    });

    it('normal release closes legacy usage and the billing epoch at the same execution stopDate', async () => {
        const s = setup({ rows: [stopped({ state: 'RUNNING', last_error: null })] });
        s.usage.push({ computer_id: C, user_id: U, instance_id: s.source.instanceId, instance_type: 'm6i.large',
            started_at: new Date(NOW.getTime() - 7200_000), stopped_at: null, observed_by: 'original', updated_at: NOW });
        await s.provider.stop(ctx, computer, 'user');
        const stopDate = new Date(NOW.getTime() - 60_000);
        // A real execution starts before it stops; a stopDate before its startDate is refused as evidence.
        s.execution('SUCCEEDED'); s.executionFields({ startDate: new Date(stopDate.getTime() - 60_000), stopDate }); await s.status();
        expect(s.usage[0].stopped_at).toEqual(stopDate);
        expect(s.meter.stopped).toHaveBeenCalledExactlyOnceWith({ userId: U, computerId: C, endedAt: stopDate, reason: 'user_stop' });
    });
});

// RETRY-118: an open whose capacity attempt expired answers a distinct, non-retryable code carrying
// that attempt's id (the only thing an explicit user Retry may reset), for create and wake alike.
describe('RETRY-118 capacity_attempt_expired', () => {
    const ATTEMPT = '0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e';
    const pressured = (s: ReturnType<typeof setup>) => {
        s.pool.validateCapacity = vi.fn(async () => {
            throw new PoolCapacityPressure({ computerId: C, region: D.region, zoneId: D.zoneId, instanceType: 'm6i.large' });
        });
        s.pool.reserveDemand = vi.fn(async () => ({ outcome: 'expired' as const, attemptId: ATTEMPT }));
    };
    it('first-ever create: the expired attempt id, no placement, no launch', async () => {
        const s = setup();
        pressured(s);
        expect(await s.ensure()).toEqual({ ok: false, error: 'capacity_attempt_expired', errorCode: 'capacity_attempt_expired',
            retryable: false, capacityAttemptId: ATTEMPT });
        expect(s.pool.reserveDemand).toHaveBeenCalledOnce();
        expect(vi.mocked(s.pool.reserveDemand!).mock.calls[0]![0]).toMatchObject({ kind: 'create', computerId: C, userId: U, source: null });
        expect(s.placements).toEqual([]);
        expect(s.starts).toEqual([]);
    });
    it('wake of a stopped computer: the expired attempt id, the placement untouched, no launch', async () => {
        const row = stopped();
        const s = setup({ rows: [row] });
        const before = structuredClone(s.placements[0]);
        pressured(s);
        expect(await s.ensure()).toEqual({ ok: false, error: 'capacity_attempt_expired', errorCode: 'capacity_attempt_expired',
            retryable: false, capacityAttemptId: ATTEMPT });
        expect(vi.mocked(s.pool.reserveDemand!).mock.calls[0]![0]).toMatchObject({ kind: 'wake', computerId: C,
            source: { generation: 3, leaseEpoch: 4 } });
        expect(s.placements[0]).toEqual(before);
        expect(s.starts).toEqual([]);
    });
    it('every other demand outcome is unchanged (no attempt id leaks)', async () => {
        for (const [outcome, expected] of [['refused', { errorCode: 'capacity_unavailable', error: 'region_capacity', retryable: false }],
            ['waiting', { errorCode: 'computer_starting', retryable: true }]] as const) {
            const s = setup();
            pressured(s);
            s.pool.reserveDemand = vi.fn(async () => outcome);
            const result = await s.ensure();
            expect(result).toMatchObject({ ok: false, ...expected });
            expect(result).not.toHaveProperty('capacityAttemptId');
        }
    });
});

// WARM-118 (root ROOT-WARM-OPTIMIZATIONS-118 #2): the committed adoption is launched BEFORE the full spare
// replenishment is awaited, so pool planning overlaps the lifecycle execution.
describe('WARM-118 adoption launches before replenishment', () => {
    it.each([false, true])('a held replenishment never delays the adoption, which starts exactly once (reopen=%s)', async reopen => {
        const s = setup({ rows: reopen ? [stopped()] : [] });
        let release!: () => void;
        s.pool.replenish = vi.fn(() => new Promise<void>(r => { release = r; }));
        let settled = false;
        const pending = s.ensure().then(r => { settled = true; return r; });
        for (let i = 0; i < 200 && vi.mocked(s.pool.replenish).mock.calls.length === 0; i++) await new Promise(r => setTimeout(r, 0));
        expect(s.starts).toHaveLength(1); // launched BEFORE the planner was even asked, and it is still running
        expect(s.starts[0]!.intent).toMatchObject({ operation: 'adopt', poolHostId: HOST });
        expect(s.pool.replenish).toHaveBeenCalledOnce();
        expect(settled).toBe(false); // the ensure still awaits the replenishment it began
        release();
        expect(await pending).toMatchObject({ errorCode: 'computer_starting', retryable: true });
        expect(s.starts).toHaveLength(1);
        expect((await s.placement()).lifecycleJobId).toBe(s.starts[0]!.intent.jobId);
    });
    it.each([false, true])('a planner failure cannot undo the adoption, trigger a cold fallback or open usage early (reopen=%s)', async reopen => {
        const s = setup({ rows: reopen ? [stopped()] : [] });
        s.pool.replenish = vi.fn(async () => { throw new Error('planner exploded'); });
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting', retryable: true });
        expect(s.starts).toHaveLength(1);
        expect(s.starts[0]!.intent.operation).toBe('adopt'); // never a cold provision
        const p = await s.placement();
        expect(p.lifecycleJobId).toBe(s.starts[0]!.intent.jobId);
        expect(['PROVISIONING', 'LEASED', 'STARTING']).toContain(p.state); // the adopt state, never rolled back
        expect(s.meter.ready).not.toHaveBeenCalled();
        expect(s.usage).toHaveLength(0);
        // A repeat open while the adoption runs does not launch again.
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting' });
        expect(s.starts).toHaveLength(1);
    });
    it('a lost StartExecution answer still gets its replenishment, and only the same job is retried (no new launch)', async () => {
        const s = setup({ lostStart: true });
        expect(await s.ensure()).toMatchObject({ errorCode: 'computer_starting' });
        expect(new Set(s.starts.map(w => w.intent.jobId)).size).toBe(1); // the start helper's own retries of ONE job
        expect(s.pool.replenish).toHaveBeenCalledOnce();
    });
});
