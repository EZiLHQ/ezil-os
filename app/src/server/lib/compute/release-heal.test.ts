/** Round 5 D2: the pure release-heal classifier shared by resolveTransition, describeProgress and the stop driver. */
import { describe, expect, it } from 'vitest';
import type { Placement } from './placement';
import type { ComputerTransition } from './progress';
import { POOL_RELEASE_RECOVERY_PREFIX, releaseHeal, releaseHealOf } from './release-heal';

const C = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const U = '11111111-1111-4111-8111-111111111111';
const T0 = new Date('2026-10-29T09:36:08.000Z');
const JOB = '33333333-3333-4333-8333-333333333333';
const placement = (over: Partial<Placement> = {}): Placement => ({
    computerId: C, ownerUserId: U, provider: 'aws-ec2', store: 'ebs', generation: 5, leaseEpoch: 9, state: 'RUNNING',
    region: 'ap-south-1', zoneId: 'aps1-az1', instanceId: 'i-1', instanceType: 'm6i.large', volumeId: 'vol-1', fsUuid: null, tunnelId: null,
    enrollNonceHash: null, enrollExpiresAt: null, enrollConsumedHash: null, leaseUntil: null, presenceAt: null, fenceToken: 'f',
    lifecycleJobId: null, lifecycleDigest: null, lastError: null, updatedAt: T0, ...over,
});
const transition = (over: Partial<ComputerTransition> = {}): ComputerTransition => ({
    v: 1, transitionId: '22222222-2222-4222-8222-222222222222', requestId: 'request-0001', kind: 'switch', computerId: C, userId: U,
    current: 'std-2', target: 'cmp-4', phase: 'stopping', reason: null, fromGeneration: 5, fromLeaseEpoch: 9,
    requestedAt: T0.toISOString(), stoppingAt: T0.toISOString(), wakingAt: null, endedAt: null, ...over,
});
/** The row aws-receipts.ts:340-345 writes for a FAILED release execution (job and digest kept, enrollment cleared). */
const failedRelease = (over: Partial<Placement> = {}) => placement({ state: 'UNCONFIRMED', lastError: 'failed:LifecycleUnconfirmed',
    lifecycleJobId: JOB, lifecycleDigest: 'd'.repeat(64), ...over });
const recovery = (context: Record<string, unknown>) => POOL_RELEASE_RECOVERY_PREFIX + JSON.stringify(context);
const intent = { operation: 'release', jobId: '44444444-4444-4444-8444-444444444444' };

describe('releaseHealOf: what the placement alone says about a pool-release heal', () => {
    it('the prefix is the one aws-pool-release-recovery writes', () => {
        expect(POOL_RELEASE_RECOVERY_PREFIX).toBe('pool_release_recovery:');
    });
    it('pending: a failed release still holding its job and digest (the recovery accepts exactly this row)', () => {
        expect(releaseHealOf(failedRelease())).toBe('pending');
        expect(releaseHealOf(failedRelease({ lastError: 'failed:FAILED' }))).toBe('pending');
    });
    it('not a heal: a failed row without its job or digest, capacity, drift, or any other state', () => {
        expect(releaseHealOf(failedRelease({ lifecycleJobId: null }))).toBeNull();
        expect(releaseHealOf(failedRelease({ lifecycleDigest: null }))).toBeNull();
        expect(releaseHealOf(failedRelease({ lastError: 'capacity:InsufficientInstanceCapacity:m6i.xlarge' }))).toBeNull();
        expect(releaseHealOf(failedRelease({ lastError: 'generation_drift' }))).toBeNull();
        expect(releaseHealOf(failedRelease({ lastError: null }))).toBeNull();
        for (const state of ['RUNNING', 'DRAINING', 'STOPPING', 'STOPPED'] as const) expect(releaseHealOf(failedRelease({ state }))).toBeNull();
        expect(releaseHealOf(failedRelease({ provider: 'cloudflare' }))).toBeNull();
        expect(releaseHealOf(null)).toBeNull();
    });
    it('pending: RECOVERING with a release replay intent, whatever retryable error it carries', () => {
        expect(releaseHealOf(failedRelease({ state: 'RECOVERING', lastError: recovery({ intent, error: null }) }))).toBe('pending');
        expect(releaseHealOf(failedRelease({ state: 'RECOVERING', lastError: recovery({ intent, error: 'start_refused' }) }))).toBe('pending');
        expect(releaseHealOf(failedRelease({ state: 'RECOVERING', lastError: recovery({ intent, error: 'volume_not_available' }) }))).toBe('pending');
    });
    it('not a release heal: RECOVERING without a replay intent belongs to deleted/image recovery', () => {
        expect(releaseHealOf(failedRelease({ state: 'RECOVERING', lastError: recovery({ error: 'x' }) }))).toBeNull();
        expect(releaseHealOf(failedRelease({ state: 'RECOVERING', lastError: null }))).toBeNull();
        expect(releaseHealOf(failedRelease({ state: 'RECOVERING', lastError: 'pool_release_recovery:{not json' }))).toBeNull();
    });
    it('pending: UNCONFIRMED with a transient recovery error (the next pass retries it)', () => {
        for (const error of ['execution_unavailable', 'describe_unavailable']) {
            expect(releaseHealOf(failedRelease({ lastError: recovery({ error }) }))).toBe('pending');
            expect(releaseHealOf(failedRelease({ lastError: recovery({ intent, error }) }))).toBe('pending');
        }
    });
    it('pending: UNCONFIRMED with an intent-less recovery error (nothing replayed; the next pass re-evaluates the original job)', () => {
        // A host still stopping (instance_identity) or a volume still detaching (volume_attachment) at the first pass.
        for (const error of ['instance_identity', 'volume_attachment', 'termination_not_proven', 'execution_not_failed', 'placement_identity']) {
            expect(releaseHealOf(failedRelease({ lastError: recovery({ error }) }))).toBe('pending');
        }
    });
    it('failed: UNCONFIRMED after the replay ran (saved intent, non-transient error), a malformed context, or no job left to recover', () => {
        for (const error of ['recovery_retry_awaits_new_deployment', 'termination_not_proven', 'instance_identity', 'volume_identity',
            'execution_not_failed', 'execution_authority', 'replay_identity', 'starter_missing', 'receipt_identity']) {
            expect(releaseHealOf(failedRelease({ lastError: recovery({ intent, sourceJobId: JOB, stoppedAt: null, error }) }))).toBe('failed');
        }
        expect(releaseHealOf(failedRelease({ lastError: 'pool_release_recovery:{not json' }))).toBe('failed');
        expect(releaseHealOf(failedRelease({ lastError: recovery({ error: 'execution_unavailable' }), lifecycleJobId: null }))).toBe('failed');
        expect(releaseHealOf(failedRelease({ lastError: recovery({ error: 'instance_identity' }), lifecycleDigest: null }))).toBe('failed');
    });
});

describe('releaseHeal: only the failed release of THIS switch, while it is stopping', () => {
    it('same generation and lease epoch, phase requested or stopping', () => {
        expect(releaseHeal(transition(), failedRelease())).toBe('pending');
        expect(releaseHeal(transition({ phase: 'requested', stoppingAt: null }), failedRelease())).toBe('pending');
        expect(releaseHeal(transition(), failedRelease({ lastError: recovery({ error: 'instance_identity' }) }))).toBe('pending');
        expect(releaseHeal(transition(), failedRelease({ lastError: recovery({ intent, error: 'recovery_retry_awaits_new_deployment' }) }))).toBe('failed');
    });
    it('another epoch or generation, a waking or ended transition, or no placement: not this heal', () => {
        expect(releaseHeal(transition(), failedRelease({ leaseEpoch: 10 }))).toBeNull();
        expect(releaseHeal(transition(), failedRelease({ generation: 6 }))).toBeNull();
        for (const phase of ['waking', 'done', 'failed'] as const) expect(releaseHeal(transition({ phase }), failedRelease())).toBeNull();
        expect(releaseHeal(transition(), null)).toBeNull();
    });
});
