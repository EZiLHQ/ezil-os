/**
 * `AwsStopGuard` (aws-ec2.ts): the billing sweep's guarded automatic stop acts only on EXACTLY the placement the caller
 * read, re-confirmed on the fresh row right before the draining compare-and-swap, and cancels no pending demand. The
 * user's own stop (no guard) keeps its cancellation and its answers bit for bit.
 */
import { describe, expect, it, vi } from 'vitest';

import { AWS_STOP_GUARD_MISMATCH, AWS_STOP_GUARD_REFUSED, createAwsEc2Provider, type AwsStopGuard, type LifecycleStarter } from './aws-ec2';
import { LIFECYCLE_DEPLOYMENTS_ENV, type LifecycleIntent } from './aws-intent';
import { fixtureDeployment } from './aws-intent.test-support';
import { createFakePlacementDb, placementRow } from './fake-placement-db.test-support';
import { PlacementOwnerError, type Placement } from './placement';

const U1 = '11111111-1111-4111-8111-111111111111';
const U2 = '22222222-2222-4222-8222-222222222222';
const C1 = 'c1c1c1c1-c1c1-4c1c-8c1c-c1c1c1c1c1c1';
const NOW = new Date('2026-11-25T06:00:00Z');
const ctx = { correlationId: 'corr' };
const FS = 'f5f5f5f5-f5f5-4f5f-8f5f-f5f5f5f5f5f5';
const FENCE = 'fe0fe0fe-fe0f-4e0f-8e0f-e0fe0fe0fe0f';
const JOB = '0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a';
const INSTANCE = 'i-11111111111111111';
const DEPLOYMENTS = { 'ap-south-1': fixtureDeployment('ap-south-1', ['t3a.medium', 'm6i.large']) };
const env = () => ({
    EZIL_AWS_COMPUTERS_ENABLED: '1', AWS_MAX_RUNNING: '10', EZIL_AWS_USER_MONTHLY_HOURS: '100', EZIL_AWS_GLOBAL_MONTHLY_HOURS: '600',
    EZIL_AWS_USER_MONTHLY_EGRESS_GB: '50', EZIL_AWS_GLOBAL_MONTHLY_EGRESS_GB: '200', AWS_REGIONS: 'ap-south-1', EZIL_AWS_MAX_RUNNING_AP_SOUTH_1: '2',
    [LIFECYCLE_DEPLOYMENTS_ENV]: JSON.stringify(DEPLOYMENTS), EZIL_AWS_ENROLL_URL: 'https://app.example.test/api/compute/aws/enroll',
});

const running = (over: Record<string, unknown> = {}) => placementRow({
    computer_id: C1, owner_user_id: U1, state: 'RUNNING', region: 'ap-south-1', instance_type: 't3a.medium', instance_id: INSTANCE,
    volume_id: 'vol-11111111111111111', fs_uuid: FS, fence_token: FENCE, generation: 3, lease_epoch: 4, ...over,
});
/** What the sweep read: the row as `readPlacement` returns it. */
const expected = (over: Partial<AwsStopGuard['expected']> = {}): AwsStopGuard['expected'] =>
    ({ ownerUserId: U1, generation: 3, leaseEpoch: 4, instanceId: INSTANCE, fenceToken: FENCE, ...over });

function setup(placements: Record<string, unknown>[], guard: AwsStopGuard | undefined, options: { refuse?: boolean } = {}) {
    const fake = createFakePlacementDb({ computers: [{ id: C1, user_id: U1 }], placements });
    const calls: LifecycleIntent[] = [];
    const starter: LifecycleStarter = { async start(_region, work) {
        calls.push(JSON.parse((JSON.parse(work.input) as { document: string }).document) as LifecycleIntent);
        if (options.refuse) throw Object.assign(new Error('refused'), { name: 'ExecutionLimitExceeded', $metadata: { httpStatusCode: 400 } });
    } };
    const provider = createAwsEc2Provider({ db: fake.db, env, now: () => NOW, newId: () => JOB, starter, tierFor: async () => 'free',
        sleep: async () => {}, ...(guard ? { stopGuard: guard } : {}) });
    return { ...fake, calls, provider };
}
const me = { userId: U1, computerId: C1 };
const demandCancel = (statements: { sql: string }[]) => statements.filter(s => /demand/i.test(s.sql) && /UPDATE|DELETE/i.test(s.sql));

describe('AwsStopGuard: a guarded automatic stop', () => {
    it('stops exactly the expected RUNNING placement: confirm sees the fresh row, then DRAINING with the stop job (the CAS fences it)', async () => {
        const confirm = vi.fn<AwsStopGuard['confirm']>(async () => true);
        const s = setup([running()], { expected: expected(), confirm });
        expect(await s.provider.stop(ctx, me, 'user')).toEqual({ ok: false, terminated: false, outcome: 'stopping' });
        expect(confirm).toHaveBeenCalledTimes(1);
        expect(confirm.mock.calls[0]![0]).toMatchObject({ computerId: C1, ownerUserId: U1, state: 'RUNNING', generation: 3, leaseEpoch: 4 } satisfies Partial<Placement>);
        expect(s.calls[0]).toMatchObject({ operation: 'stop', providerInstanceId: INSTANCE, leaseEpoch: 4, fenceToken: FENCE });
        expect(s.placements[0]).toMatchObject({ state: 'STOPPING', lifecycle_job_id: JOB });
        // No demand cancellation on the guarded path.
        expect(demandCancel(s.statements)).toEqual([]);
    });

    it.each([
        ['generation', { generation: 2 }],
        ['lease epoch', { leaseEpoch: 3 }],
        ['instance', { instanceId: 'i-22222222222222222' }],
        ['fence token', { fenceToken: '00000000-0000-4000-8000-000000000000' }],
    ])('a changed %s is a mismatch: nothing confirmed, nothing written, no job', async (_what, over) => {
        const confirm = vi.fn<AwsStopGuard['confirm']>(async () => true);
        const s = setup([running()], { expected: expected(over), confirm });
        expect(await s.provider.stop(ctx, me, 'user')).toEqual({ ok: false, terminated: false, outcome: AWS_STOP_GUARD_MISMATCH });
        expect(confirm).not.toHaveBeenCalled();
        expect(s.calls).toEqual([]);
        expect(s.placements[0]).toMatchObject({ state: 'RUNNING', lifecycle_job_id: null });
    });

    it('a lifecycle job on the row (another lease or stop in flight) is a mismatch, as is a placement that is not RUNNING', async () => {
        const confirm = vi.fn<AwsStopGuard['confirm']>(async () => true);
        const withJob = setup([running({ lifecycle_job_id: JOB })], { expected: expected(), confirm });
        expect(await withJob.provider.stop(ctx, me, 'user')).toEqual({ ok: false, terminated: false, outcome: AWS_STOP_GUARD_MISMATCH });
        const stopped = setup([running({ state: 'STOPPED' })], { expected: expected(), confirm });
        expect(await stopped.provider.stop(ctx, me, 'user')).toEqual({ ok: false, terminated: false, outcome: AWS_STOP_GUARD_MISMATCH });
        expect(confirm).not.toHaveBeenCalled();
        expect([...withJob.calls, ...stopped.calls]).toEqual([]);
    });

    it('a refused confirmation (the override expired or changed, or a conflicting move) writes nothing; a throw is a refusal too', async () => {
        const refused = setup([running()], { expected: expected(), confirm: async () => false });
        expect(await refused.provider.stop(ctx, me, 'user')).toEqual({ ok: false, terminated: false, outcome: AWS_STOP_GUARD_REFUSED });
        expect(refused.placements[0]).toMatchObject({ state: 'RUNNING', lifecycle_job_id: null });
        expect(refused.calls).toEqual([]);
        const thrown = setup([running()], { expected: expected(), confirm: async () => { throw new Error('billing down'); } });
        expect(await thrown.provider.stop(ctx, me, 'user')).toEqual({ ok: false, terminated: false, outcome: AWS_STOP_GUARD_REFUSED });
        expect(thrown.calls).toEqual([]);
    });

    it('another owner\'s placement is NOT_FOUND upstream (PlacementOwnerError), never a guarded stop', async () => {
        const confirm = vi.fn<AwsStopGuard['confirm']>(async () => true);
        const s = setup([running({ owner_user_id: U2 })], { expected: expected(), confirm });
        await expect(s.provider.stop(ctx, me, 'user')).rejects.toBeInstanceOf(PlacementOwnerError);
        expect(confirm).not.toHaveBeenCalled();
    });

    it('a refused StartExecution after the guard still takes the ordinary undo (UNCONFIRMED), never RUNNING again', async () => {
        const s = setup([running()], { expected: expected(), confirm: async () => true }, { refuse: true });
        expect(await s.provider.stop(ctx, me, 'user')).toMatchObject({ ok: false, outcome: 'aws_lifecycle_start_failed' });
        expect(s.placements[0]).toMatchObject({ state: 'UNCONFIRMED' });
    });

    it('without a guard the user\'s stop is unchanged: it stops the RUNNING row it reads, confirmation-free', async () => {
        const s = setup([running()], undefined);
        expect(await s.provider.stop(ctx, me, 'user')).toEqual({ ok: false, terminated: false, outcome: 'stopping' });
        expect(s.placements[0]).toMatchObject({ state: 'STOPPING', lifecycle_job_id: JOB });
    });
});
