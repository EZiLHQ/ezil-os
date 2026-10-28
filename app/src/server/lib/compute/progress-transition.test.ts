/** Round 3: switch/restart transitions and the server-stamped opening (contract v3 OpeningProgressV3). */
import { describe, expect, it } from 'vitest';
import { OPENING_MILESTONES_V3 } from '@/server/billing/v3/contract';
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
