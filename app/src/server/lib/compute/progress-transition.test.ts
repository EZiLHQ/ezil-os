/** Round 3: switch/restart transitions and the server-stamped opening (contract v3 OpeningProgressV3). */
import { describe, expect, it } from 'vitest';
import { OPENING_MILESTONES_V3, SWITCH_HEAL_REASONS_V3 } from '@/server/billing/v3/contract';
import { SWITCH_DEMAND_WINDOW_MS } from './ready-pool';
import type { Placement } from './placement';
import {
    canonicalJson, describeOpening, describeProgress, expectedOpeningSeconds, parseOpening, parseTransition, resolveTransition, transitionView,
    TRANSITION_MAX_AGE_MS, TRANSITION_STOP_GRACE_MS, TRANSITION_STOP_TIMEOUT_MS, TRANSITION_WAKE_TIMEOUT_MS, type ComputerTransition, type OpeningRecord,
} from './progress';

const C = 'abcdefab-abcd-4abc-8abc-abcdefabcdef';
const U = '11111111-1111-4111-8111-111111111111';
const T0 = new Date('2026-10-28T10:00:00.000Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
const env = { EZIL_AWS_COMPUTERS_ENABLED: '1', EZIL_COMPUTE_PLACEMENT_READS: '1' };
const placement = (over: Partial<Placement> = {}): Placement => ({
    computerId: C, ownerUserId: U, provider: 'aws-ec2', store: 'ebs', generation: 3, leaseEpoch: 7, state: 'RUNNING',
    region: 'ap-south-1', zoneId: 'aps1-az1', instanceId: 'i-1', instanceType: 'm6i.large', volumeId: 'vol-1', fsUuid: null, tunnelId: null,
    enrollNonceHash: null, enrollExpiresAt: null, enrollConsumedHash: null, leaseUntil: null, presenceAt: null, fenceToken: 'f',
    lifecycleJobId: null, lifecycleDigest: null, lastError: null, updatedAt: T0, ...over,
});
const transition = (over: Partial<ComputerTransition> = {}): ComputerTransition => ({
    v: 1, transitionId: '22222222-2222-4222-8222-222222222222', requestId: 'request-0001', kind: 'switch', computerId: C, userId: U,
    current: 'std-2', target: 'cmp-8', phase: 'stopping', reason: null, fromGeneration: 3, fromLeaseEpoch: 7,
    requestedAt: T0.toISOString(), stoppingAt: T0.toISOString(), wakingAt: null, endedAt: null, ...over,
});

describe('resolveTransition: the phase is derived from the placement, never trusted from the record', () => {
    it('RUNNING on a later lease epoch on the target type is done; on another type it failed', () => {
        expect(resolveTransition(transition(), placement({ leaseEpoch: 8, generation: 4, instanceType: 'm6i.2xlarge' }), at(60))).toEqual({ phase: 'done', reason: null });
        expect(resolveTransition(transition(), placement({ leaseEpoch: 8, instanceType: 'm6i.xlarge' }), at(60))).toEqual({ phase: 'failed', reason: 'size_not_applied' });
    });
    it('the old epoch still running is stopping until the stop budget (plus grace) passes', () => {
        expect(resolveTransition(transition(), placement({ state: 'DRAINING' }), at(100))).toEqual({ phase: 'stopping', reason: null });
        const limit = (TRANSITION_STOP_TIMEOUT_MS + TRANSITION_STOP_GRACE_MS) / 1000;
        expect(resolveTransition(transition(), placement(), at(limit))).toEqual({ phase: 'stopping', reason: null });
        expect(resolveTransition(transition(), placement(), at(limit + 1))).toEqual({ phase: 'failed', reason: 'stop_timeout' });
    });
    it('STOPPED or a new lease is waking until the wake budget passes', () => {
        expect(resolveTransition(transition(), placement({ state: 'STOPPED' }), at(30))).toEqual({ phase: 'waking', reason: null });
        expect(resolveTransition(transition({ phase: 'waking', wakingAt: at(30).toISOString() }), placement({ state: 'LEASED', leaseEpoch: 8 }), at(600)))
            .toEqual({ phase: 'waking', reason: null });
        expect(resolveTransition(transition({ phase: 'waking', wakingAt: at(30).toISOString() }), placement({ state: 'STARTING', leaseEpoch: 8 }),
            at(30 + TRANSITION_WAKE_TIMEOUT_MS / 1000 + 1))).toEqual({ phase: 'failed', reason: 'wake_timeout' });
    });
    it('UNCONFIRMED (capacity included) and RECOVERING fail with a reason', () => {
        expect(resolveTransition(transition(), placement({ state: 'UNCONFIRMED', leaseEpoch: 8, lastError: 'capacity:region' }), at(90)))
            .toEqual({ phase: 'failed', reason: 'capacity_unavailable' });
        expect(resolveTransition(transition(), placement({ state: 'UNCONFIRMED', leaseEpoch: 8, lastError: 'enroll_tunnel_failed' }), at(90)))
            .toEqual({ phase: 'failed', reason: 'unconfirmed' });
        expect(resolveTransition(transition(), placement({ state: 'RECOVERING' }), at(90)).phase).toBe('failed');
        expect(resolveTransition(transition(), null, at(1))).toEqual({ phase: 'failed', reason: 'placement_missing' });
    });
    it('a stored terminal phase is kept as is', () => {
        expect(resolveTransition(transition({ phase: 'failed', reason: 'stop_timeout' }), placement({ leaseEpoch: 9 }), at(1))).toEqual({ phase: 'failed', reason: 'stop_timeout' });
    });
    it('only a failed SWITCH to another size offers the revert', () => {
        expect(transitionView(transition(), { phase: 'failed', reason: 'wake_timeout' }).revertAvailable).toBe(true);
        expect(transitionView(transition({ kind: 'restart', target: 'std-2' }), { phase: 'failed', reason: 'wake_timeout' }).revertAvailable).toBe(false);
        expect(transitionView(transition(), { phase: 'waking', reason: null }).revertAvailable).toBe(false);
    });
    it('the pool demand window equals the transition budget', () => {
        expect(SWITCH_DEMAND_WINDOW_MS).toBe(TRANSITION_MAX_AGE_MS);
    });
});

describe('advisory records are parsed strictly and bound to the owner (the column is owner-writable)', () => {
    it('refuses another owner, another computer, unknown sizes or extra keys', () => {
        const t = transition();
        expect(parseTransition(t, { computerId: C, userId: U })).toEqual(t);
        expect(parseTransition(JSON.stringify(t), { computerId: C.toUpperCase(), userId: U })).toEqual(t);
        expect(parseTransition(t, { computerId: C, userId: '33333333-3333-4333-8333-333333333333' })).toBeNull();
        expect(parseTransition({ ...t, target: 'gpu-1' }, { computerId: C, userId: U })).toBeNull();
        expect(parseTransition({ ...t, extra: 1 }, { computerId: C, userId: U })).toBeNull();
        expect(parseTransition('not json', { computerId: C, userId: U })).toBeNull();
        expect(parseOpening({ v: 1, generation: 1, leaseEpoch: 1, startedAt: 'x', path: 'cold', milestones: {} })).toBeNull();
    });
    it('canonical JSON ignores jsonb key order', () => {
        expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
    });
});

describe('describeOpening: one server-stamped opening, monotonic milestones', () => {
    const keys = (o: OpeningRecord | null) => OPENING_MILESTONES_V3.filter(k => o?.milestones[k]);
    const times = (o: OpeningRecord | null) => OPENING_MILESTONES_V3.flatMap(k => o?.milestones[k] ? [Date.parse(o.milestones[k]!)] : []);
    const nonce = (s: number) => new Date(at(s).getTime() + 600_000);

    it('a cold open: start = the lease nonce issue time; milestones never regress or reorder across repeated reads', () => {
        let stored: OpeningRecord | null = null;
        const read = (p: Placement, s: number) => (stored = describeOpening({ placement: p, stored, transition: null, pool: null, migrating: false, now: at(s) }));
        const leased = read(placement({ state: 'LEASED', leaseEpoch: 8, enrollExpiresAt: nonce(0) }), 5);
        expect(leased).toMatchObject({ leaseEpoch: 8, startedAt: T0.toISOString(), path: 'cold' });
        expect(keys(leased)).toEqual(['requested', 'host_claimed']);
        // A poll of an EARLIER-looking state never removes a reached milestone.
        expect(keys(read(placement({ state: 'STARTING', leaseEpoch: 8, enrollExpiresAt: nonce(0) }), 20))).toEqual(['requested', 'host_claimed']);
        const mounting = read(placement({ state: 'MOUNTING', leaseEpoch: 8, enrollExpiresAt: nonce(0) }), 40);
        expect(keys(mounting)).toEqual(['requested', 'host_claimed', 'files_attached']);
        // Enrolled: desktop starting.
        const enrolled = read(placement({ state: 'MOUNTING', leaseEpoch: 8, enrollExpiresAt: nonce(0), enrollConsumedHash: 'a'.repeat(64) }), 60);
        expect(keys(enrolled)).toEqual(['requested', 'host_claimed', 'files_attached', 'desktop_starting']);
        const ready = read(placement({ state: 'RUNNING', leaseEpoch: 8 }), 90);
        expect(keys(ready)).toEqual([...OPENING_MILESTONES_V3]);
        expect(ready!.milestones.files_attached).toBe(at(40).toISOString());
        expect(ready!.startedAt).toBe(T0.toISOString());
        // Later reads change nothing.
        expect(read(placement({ state: 'RUNNING', leaseEpoch: 8 }), 300)).toEqual(ready);
        const t = times(ready);
        expect(t).toEqual([...t].sort((a, b) => a - b));
    });
    it('a later milestone seen first fills every earlier one with its own time (never later before earlier)', () => {
        const o = describeOpening({ placement: placement({ state: 'RUNNING', leaseEpoch: 8 }), stored: { v: 1, generation: 3, leaseEpoch: 8,
            startedAt: T0.toISOString(), path: 'cold', milestones: { requested: T0.toISOString() } }, transition: null, pool: null, migrating: false, now: at(50) });
        expect(keys(o)).toEqual([...OPENING_MILESTONES_V3]);
        expect(times(o).slice(1).every(v => v === at(50).getTime())).toBe(true);
    });
    it('a warm adopt takes the pool lease, claim publish and session-ready times', () => {
        const pool = { leasedAt: at(2), claimPublishedAt: at(6), sessionReadyAt: at(17) };
        const o = describeOpening({ placement: placement({ state: 'RUNNING', leaseEpoch: 8 }), stored: null, transition: null, pool, migrating: false, now: at(20) });
        expect(o).toBeNull(); // RUNNING with no record: it opened before anyone watched.
        const opening = describeOpening({ placement: placement({ state: 'MOUNTING', leaseEpoch: 8, lastError: 'pool_session_pending' }), stored: null, transition: null, pool, migrating: false, now: at(12) });
        expect(opening).toMatchObject({ path: 'warm', startedAt: at(2).toISOString(), milestones: { host_claimed: at(2).toISOString(), files_attached: at(6).toISOString(), desktop_starting: at(12).toISOString() } });
        const done = describeOpening({ placement: placement({ state: 'RUNNING', leaseEpoch: 8 }), stored: opening, transition: null, pool, migrating: false, now: at(25) });
        expect(done!.milestones.desktop_ready).toBe(at(17).toISOString());
    });
    it('a switch is one opening from the click: its start is the request, through stop and the new lease', () => {
        const t = transition({ requestedAt: T0.toISOString() });
        const stopping = describeOpening({ placement: placement({ state: 'DRAINING' }), stored: null, transition: { t, phase: 'stopping' }, pool: null, migrating: false, now: at(30) });
        expect(stopping).toMatchObject({ path: 'switch', leaseEpoch: 8, startedAt: T0.toISOString(), milestones: { requested: T0.toISOString() } });
        expect(keys(stopping)).toEqual(['requested']);
        const leased = describeOpening({ placement: placement({ state: 'LEASED', leaseEpoch: 8, generation: 4 }), stored: stopping, transition: { t, phase: 'waking' }, pool: null, migrating: false, now: at(70) });
        expect(leased).toMatchObject({ path: 'switch', startedAt: T0.toISOString(), milestones: { host_claimed: at(70).toISOString() } });
        const done = describeOpening({ placement: placement({ state: 'RUNNING', leaseEpoch: 8, generation: 4, instanceType: 'm6i.2xlarge' }), stored: leased,
            transition: { t, phase: 'done' }, pool: null, migrating: false, now: at(200) });
        expect(keys(done)).toEqual([...OPENING_MILESTONES_V3]);
        expect(done!.startedAt).toBe(T0.toISOString());
    });
});

describe('describeProgress: OpeningProgressV3 fields, capacity wait, expected seconds', () => {
    it('expectedSeconds: warm from the measured median, cold the 240 s default, both clamped 90-600', () => {
        expect(expectedOpeningSeconds('warm', 22)).toBe(90);
        expect(expectedOpeningSeconds('warm', 130)).toBe(130);
        expect(expectedOpeningSeconds('warm', null)).toBe(90);
        expect(expectedOpeningSeconds('cold', 22)).toBe(240);
        expect(expectedOpeningSeconds('warm', 5000)).toBe(600);
        expect(expectedOpeningSeconds('switch', 40, true)).toBe(100);
        expect(expectedOpeningSeconds('switch', 40, false)).toBe(300);
    });
    it('a capacity wait is an active opening (waiting_capacity), never "stopped"', () => {
        const p = placement({ state: 'STOPPED' });
        expect(describeProgress(C, p, null, env, at(1))).toMatchObject({ stage: 'stopped', operation: 'none', active: false });
        expect(describeProgress(C, p, null, env, at(1), null, { capacityWaiting: true })).toMatchObject({ stage: 'waiting_capacity', operation: 'opening', active: true, recordedStage: 'stopped' });
    });
    it('an in-flight switch reads as an opening with its transition; a failed one does not', () => {
        const view = transitionView(transition(), { phase: 'stopping', reason: null });
        const opening = describeOpening({ placement: placement({ state: 'DRAINING' }), stored: null, transition: { t: transition(), phase: 'stopping' }, pool: null, migrating: false, now: at(10) });
        const result = describeProgress(C, placement({ state: 'DRAINING' }), null, env, at(10), null, { transition: view, opening, warmMedianSeconds: 30 });
        expect(result).toMatchObject({ stage: 'switching', operation: 'opening', active: true, path: 'switch', openingStartedAt: T0.toISOString(),
            expectedSeconds: 300, typicalSeconds: 300, milestones: [{ key: 'requested', at: T0.toISOString() }], transition: { phase: 'stopping', target: 'cmp-8' } });
        const failed = describeProgress(C, placement({ state: 'UNCONFIRMED', leaseEpoch: 8, lastError: 'capacity:region' }), null, env, at(10), null,
            { transition: transitionView(transition(), { phase: 'failed', reason: 'capacity_unavailable' }) });
        expect(failed).toMatchObject({ stage: 'needs_operator', needsOperator: true, transition: { phase: 'failed', reason: 'capacity_unavailable', revertAvailable: true } });
        expect(describeProgress(C, placement({ state: 'RUNNING' }), null, env, at(10), null, { transition: transitionView(transition({ kind: 'restart', target: 'std-2' }), { phase: 'stopping', reason: null }) }).stage)
            .toBe('restarting');
    });
    it('keeps the L-A invariants: expired enrollment is needs_operator; a genuinely starting AWS open stays active', () => {
        const expired = placement({ state: 'MOUNTING', leaseEpoch: 8, enrollNonceHash: 'a'.repeat(64), enrollExpiresAt: at(-120) });
        expect(describeProgress(C, expired, null, env, at(0))).toMatchObject({ stage: 'needs_operator', needsOperator: true, active: false, openingStartedAt: null });
        const starting = placement({ state: 'STARTING', leaseEpoch: 8, enrollNonceHash: 'a'.repeat(64), enrollExpiresAt: nonceIn(600) });
        expect(describeProgress(C, starting, null, env, at(0))).toMatchObject({ stage: 'starting', operation: 'opening', active: true });
    });
    it('no opening: the round-3 fields are present and empty', () => {
        expect(describeProgress(C, placement(), null, env, at(0))).toMatchObject({ openingStartedAt: null, path: null, expectedSeconds: null, milestones: [], transition: null });
    });
});
function nonceIn(s: number) { return new Date(T0.getTime() + s * 1000); }

describe('round 5 D2: a failed pool release being healed keeps the switch in flight (stop_healing)', () => {
    const JOB = '33333333-3333-4333-8333-333333333333';
    const REPLAY_JOB = '44444444-4444-4444-8444-444444444444';
    /** aws-receipts.ts:340-345: a FAILED release execution → UNCONFIRMED `failed:*`, job and digest kept, enrollment cleared. */
    const failedRelease = (over: Partial<Placement> = {}) => placement({ state: 'UNCONFIRMED', lastError: 'failed:LifecycleUnconfirmed',
        lifecycleJobId: JOB, lifecycleDigest: 'd'.repeat(64), ...over });
    /** aws-pool-release-recovery.ts reservation: RECOVERING with the replay intent under the recovery prefix. */
    const replaying = (over: Partial<Placement> = {}) => failedRelease({ state: 'RECOVERING', lifecycleJobId: REPLAY_JOB,
        lastError: `pool_release_recovery:${JSON.stringify({ intent: { operation: 'release', jobId: REPLAY_JOB }, sourceJobId: JOB, stoppedAt: null, error: null })}`, ...over });
    const recoveryError = (error: string) => `pool_release_recovery:${JSON.stringify({ error })}`;
    /** The replay ran and failed (saved intent kept): one recovery per lifecycle version, so terminal. */
    const spentRecovery = (error: string) => `pool_release_recovery:${JSON.stringify({ intent: { operation: 'release', jobId: REPLAY_JOB }, sourceJobId: JOB, stoppedAt: null, error })}`;
    const limit = (TRANSITION_STOP_TIMEOUT_MS + TRANSITION_STOP_GRACE_MS) / 1000;

    it('the reasons are the pinned contract codes (SWITCH_HEAL_REASONS_V3)', () => {
        expect([...SWITCH_HEAL_REASONS_V3]).toEqual(['stop_healing', 'release_heal_failed', 'release_heal_timeout']);
    });
    it('pending: the phase stays (stopping, or requested) with reason stop_healing up to the existing 230 s stop bound', () => {
        expect(resolveTransition(transition(), failedRelease(), at(25))).toEqual({ phase: 'stopping', reason: 'stop_healing' });
        expect(resolveTransition(transition(), replaying(), at(52))).toEqual({ phase: 'stopping', reason: 'stop_healing' });
        expect(resolveTransition(transition({ phase: 'requested', stoppingAt: null }), failedRelease(), at(25))).toEqual({ phase: 'requested', reason: 'stop_healing' });
        expect(resolveTransition(transition(), failedRelease({ lastError: recoveryError('execution_unavailable') }), at(60)))
            .toEqual({ phase: 'stopping', reason: 'stop_healing' });
        expect(resolveTransition(transition(), failedRelease(), at(limit))).toEqual({ phase: 'stopping', reason: 'stop_healing' });
        expect(resolveTransition(transition(), failedRelease(), at(limit + 1))).toEqual({ phase: 'failed', reason: 'release_heal_timeout' });
        expect(resolveTransition(transition(), replaying(), at(limit + 1))).toEqual({ phase: 'failed', reason: 'release_heal_timeout' });
    });
    it('the 230 s bound is measured from stoppingAt (a switch that waited in requested first is not cut short)', () => {
        const late = transition({ stoppingAt: at(60).toISOString() });
        expect(resolveTransition(late, failedRelease(), at(limit + 30))).toEqual({ phase: 'stopping', reason: 'stop_healing' });
        expect(resolveTransition(late, failedRelease(), at(60 + limit + 1))).toEqual({ phase: 'failed', reason: 'release_heal_timeout' });
    });
    it('a heal that fails after its replay ran is release_heal_failed at once (non-retryable)', () => {
        for (const error of ['recovery_retry_awaits_new_deployment', 'termination_not_proven', 'instance_identity', 'execution_not_failed']) {
            expect(resolveTransition(transition(), failedRelease({ lastError: spentRecovery(error) }), at(40))).toEqual({ phase: 'failed', reason: 'release_heal_failed' });
        }
    });
    it('an intent-less recovery error (resources still moving at the first pass) is still healing, up to the bound', () => {
        for (const error of ['instance_identity', 'volume_attachment', 'termination_not_proven']) {
            expect(resolveTransition(transition(), failedRelease({ lastError: recoveryError(error) }), at(40))).toEqual({ phase: 'stopping', reason: 'stop_healing' });
            expect(resolveTransition(transition(), failedRelease({ lastError: recoveryError(error) }), at(limit + 1))).toEqual({ phase: 'failed', reason: 'release_heal_timeout' });
        }
    });
    it('not this switch\'s release: the existing UNCONFIRMED/RECOVERING failures are unchanged', () => {
        expect(resolveTransition(transition(), failedRelease({ leaseEpoch: 8 }), at(40))).toEqual({ phase: 'failed', reason: 'unconfirmed' });
        expect(resolveTransition(transition(), failedRelease({ lifecycleJobId: null }), at(40))).toEqual({ phase: 'failed', reason: 'unconfirmed' });
        expect(resolveTransition(transition(), failedRelease({ lastError: 'capacity:region' }), at(40))).toEqual({ phase: 'failed', reason: 'capacity_unavailable' });
        expect(resolveTransition(transition({ phase: 'waking', wakingAt: at(30).toISOString() }), failedRelease(), at(40))).toEqual({ phase: 'failed', reason: 'unconfirmed' });
        expect(resolveTransition(transition(), placement({ state: 'RECOVERING', lastError: recoveryError('x') }), at(40)).phase).toBe('failed');
    });
    it('the heal settles STOPPED/pool_released → waking (reason null); the adopt on the target is done', () => {
        const settled = placement({ state: 'STOPPED', lastError: 'pool_released' });
        expect(resolveTransition(transition(), settled, at(55))).toEqual({ phase: 'waking', reason: null });
        expect(resolveTransition(transition({ phase: 'waking', wakingAt: at(55).toISOString() }), placement({ leaseEpoch: 8, generation: 4, instanceType: 'm6i.2xlarge' }), at(95)))
            .toEqual({ phase: 'done', reason: null });
    });
    it('describeProgress: stop_healing keeps the switching (or restarting) stage, active, with no operator hold', () => {
        for (const p of [failedRelease(), replaying()]) {
            const resolved = resolveTransition(transition(), p, at(30));
            const view = transitionView(transition(), resolved);
            const opening = describeOpening({ placement: p, stored: null, transition: { t: transition(), phase: resolved.phase }, pool: null, migrating: false, now: at(30) });
            expect(describeProgress(C, p, null, env, at(30), null, { transition: view, opening, warmMedianSeconds: 30 })).toMatchObject({
                stage: 'switching', operation: 'opening', needsOperator: false, active: true, path: 'switch', typicalSeconds: 300, expectedSeconds: 300,
                lifecycleState: p.state, transition: { phase: 'stopping', reason: 'stop_healing' },
            });
            const restart = transition({ kind: 'restart', target: 'std-2' });
            expect(describeProgress(C, p, null, env, at(30), null, { transition: transitionView(restart, resolveTransition(restart, p, at(30))) }))
                .toMatchObject({ stage: 'restarting', needsOperator: false, active: true });
        }
    });
    it('describeProgress: a heal that failed or timed out holds for the operator as before', () => {
        const failed = failedRelease({ lastError: spentRecovery('termination_not_proven') });
        expect(describeProgress(C, failed, null, env, at(30), null, { transition: transitionView(transition(), resolveTransition(transition(), failed, at(30))) }))
            .toMatchObject({ stage: 'needs_operator', needsOperator: true, active: false, transition: { phase: 'failed', reason: 'release_heal_failed' } });
        expect(describeProgress(C, failedRelease(), null, env, at(limit + 1), null,
            { transition: transitionView(transition(), resolveTransition(transition(), failedRelease(), at(limit + 1))) }))
            .toMatchObject({ stage: 'needs_operator', needsOperator: true, transition: { phase: 'failed', reason: 'release_heal_timeout' } });
        // No transition: an UNCONFIRMED failed:* row alone is ambiguous (any failed job writes it) and still holds.
        expect(describeProgress(C, failedRelease(), null, env, at(30))).toMatchObject({ stage: 'needs_operator', needsOperator: true,
            operation: 'none', recordedStage: 'unconfirmed' });
    });
    it('describeProgress: a plain Stop whose release is being replayed (RECOVERING with its intent) reads as stopping', () => {
        expect(describeProgress(C, replaying(), null, env, at(30))).toMatchObject({ stage: 'stopping', operation: 'stopping', needsOperator: false,
            active: true, lifecycleState: 'RECOVERING' });
        // Other RECOVERING rows (deleted/image recovery) are unchanged.
        expect(describeProgress(C, placement({ state: 'RECOVERING', lastError: recoveryError('x') }), null, env, at(30)))
            .toMatchObject({ stage: 'recovering', operation: 'none', active: false });
    });

    it('the 10-29 09:36Z incident replay (4e8347ca std-2 → cmp-4): heal, adopt, done; never failed', () => {
        const T = (iso: string) => new Date(`2026-10-29T${iso}Z`);
        const t = transition({ current: 'std-2', target: 'cmp-4', fromGeneration: 4, fromLeaseEpoch: 11,
            requestedAt: T('09:36:08.000').toISOString(), stoppingAt: T('09:36:08.050').toISOString() });
        const base = { generation: 4, leaseEpoch: 11, instanceType: 'm6i.large', updatedAt: T('09:36:33.000') };
        const steps: [string, Placement, { phase: string; reason: string | null }, string][] = [
            ['09:36:20.000', placement({ ...base, state: 'DRAINING', lifecycleJobId: JOB, lifecycleDigest: 'd'.repeat(64) }), { phase: 'stopping', reason: null }, 'switching'],
            // 09:36:33 compute-transition failed stop_placement_unconfirmed on live: the release FAILED (lifecycle_instance_invalid).
            ['09:36:33.500', failedRelease(base), { phase: 'stopping', reason: 'stop_healing' }, 'switching'],
            // 09:37:00 the replay release (here: the driver's next status look) reserves RECOVERING.
            ['09:37:00.400', replaying(base), { phase: 'stopping', reason: 'stop_healing' }, 'switching'],
            ['09:37:05.900', placement({ ...base, state: 'STOPPED', lastError: 'pool_released' }), { phase: 'waking', reason: null }, 'switching'],
            // 09:37:06 adopt of an m6i.xlarge on the next epoch, then RUNNING.
            ['09:37:06.200', placement({ ...base, state: 'LEASED', generation: 5, leaseEpoch: 12, instanceType: 'm6i.xlarge', instanceId: null }), { phase: 'waking', reason: null }, 'leased'],
            ['09:37:40.000', placement({ ...base, state: 'RUNNING', generation: 5, leaseEpoch: 12, instanceType: 'm6i.xlarge' }), { phase: 'done', reason: null }, 'running'],
        ];
        for (const [time, p, expected, stage] of steps) {
            const resolved = resolveTransition(t, p, T(time));
            expect(resolved, time).toEqual(expected);
            const view = TRANSITION_IN_FLIGHT_PHASES.includes(resolved.phase) ? transitionView(t, resolved) : null;
            expect(describeProgress(C, p, null, env, T(time), null, { transition: view }), time).toMatchObject({ stage, needsOperator: false });
        }
    });
    it('incident variant: the first recovery pass sees the host still moving (intent-less instance_identity), the next heals; never failed', () => {
        const T = (iso: string) => new Date(`2026-10-29T${iso}Z`);
        const t = transition({ current: 'std-2', target: 'cmp-4', fromGeneration: 4, fromLeaseEpoch: 11,
            requestedAt: T('09:36:08.000').toISOString(), stoppingAt: T('09:36:08.050').toISOString() });
        const base = { generation: 4, leaseEpoch: 11, instanceType: 'm6i.large', updatedAt: T('09:36:33.000') };
        const steps: [string, Placement, { phase: string; reason: string | null }][] = [
            ['09:36:33.500', failedRelease(base), { phase: 'stopping', reason: 'stop_healing' }],
            // aws-pool-release-recovery.ts `fail('instance_identity')`: no saved intent, job and digest kept.
            ['09:36:38.600', failedRelease({ ...base, lastError: recoveryError('instance_identity') }), { phase: 'stopping', reason: 'stop_healing' }],
            ['09:36:43.700', replaying(base), { phase: 'stopping', reason: 'stop_healing' }],
            ['09:36:49.000', placement({ ...base, state: 'STOPPED', lastError: 'pool_released' }), { phase: 'waking', reason: null }],
        ];
        for (const [time, p, expected] of steps) {
            const resolved = resolveTransition(t, p, T(time));
            expect(resolved, time).toEqual(expected);
            expect(describeProgress(C, p, null, env, T(time), null, { transition: transitionView(t, resolved) }), time)
                .toMatchObject({ stage: 'switching', needsOperator: false });
        }
    });
});
const TRANSITION_IN_FLIGHT_PHASES: readonly string[] = ['requested', 'stopping', 'waking'];
