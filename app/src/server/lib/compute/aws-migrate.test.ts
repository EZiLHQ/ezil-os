import { describe, expect, it } from 'vitest';
import { requestMigrate, step, type MigrateEvent, type MigrateIntent, type MigrateResult, type MigrateState } from './aws-migrate';

const NOW = new Date('2026-10-19T12:00:00Z');
const EXPIRES = new Date(NOW.getTime() + 600_000);
const COMPUTER = '00000000-0000-4000-8000-000000000001';
const intent: MigrateIntent = { computerId: COMPUTER, from: 'ap-south-1', to: 'us-east-1', generation: 7, maxReplicaAgeSeconds: 60 };
const receipt = { computerId: COMPUTER, generation: 7, holder: 'operator-move-1' };
const unwrap = (result: MigrateResult): MigrateState => {
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    return result.state;
};
const requested = (overrides: Partial<MigrateIntent> = {}) => unwrap(requestMigrate({ ...intent, ...overrides }));
const acquire = (state = requested()) => unwrap(step(state, { ...receipt, type: 'acquire_writer_lease', expiresAt: EXPIRES }, NOW));
const fence = (state = acquire()) => unwrap(step(state, { ...receipt, type: 'fence_old_writer', instanceStopped: true, taggedGeneration: 8 }, NOW));
const snapshot = (state = fence(), replicaSnapshotAt: Date | undefined = NOW) => unwrap(step(state, { ...receipt, type: 'snapshot_ready', snapshotId: 'snap-source', replicaSnapshotAt }, NOW));
const copyEvent: MigrateEvent = { ...receipt, type: 'copy_reencrypted', copyKind: 'snapshot', sourceSnapshotId: 'snap-source',
    copiedSnapshotId: 'snap-copy', targetRegion: 'us-east-1', targetKeyId: 'arn:aws:kms:us-east-1:123456789012:key/target' };
const copy = (state = snapshot()) => unwrap(step(state, copyEvent, NOW));
const restore = (state = copy()) => unwrap(step(state, { ...receipt, type: 'restore' }, NOW));
const activate = (state = restore()) => unwrap(step(state, { ...receipt, generation: 8, type: 'activate', attached: true, volumeSerial: 'vol0123456789abcdef0' }, NOW));

describe('offline explicit Mumbai to US migrate', () => {
    it('takes every happy-path state and records the fence, re-encryption key, new epoch and serial', () => {
        const states = [requested(), acquire(), fence(), snapshot(), copy(), restore(), activate()];
        expect(states.map(s => s.status)).toEqual(['requested', 'writer_lease_acquired', 'old_writer_fenced', 'snapshot_ready', 'copied_reencrypted', 'restoring', 'active_in_target']);
        expect(states[2]).toMatchObject({ generation: 7, oldWriterFencedAt: NOW, writerLease: { fencedAt: NOW } });
        expect(states[5]).toMatchObject({ generation: 8, writerLease: { generation: 8, region: 'us-east-1' } });
        expect(states[6]).toMatchObject({ targetKeyId: copyEvent.targetKeyId, copiedSnapshotId: 'snap-copy', volumeSerial: 'vol0123456789abcdef0' });
    });

    it('requires the global writer lease before every operational event', () => {
        const events: MigrateEvent[] = [
            { ...receipt, type: 'fence_old_writer', instanceStopped: true, taggedGeneration: 8 },
            { ...receipt, type: 'snapshot_ready', snapshotId: 'snap-source' }, copyEvent,
            { ...receipt, type: 'restore' }, { ...receipt, type: 'activate', attached: true, volumeSerial: 'vol123' },
            { ...receipt, type: 'failed', reason: 'provider_failure' },
        ];
        for (const event of events) expect(step(requested(), event, NOW)).toEqual({ ok: false, reason: 'writer_lease_required' });
    });

    it('refuses a second migrate or lease acquisition while the global holder is live', () => {
        const state = acquire();
        expect(step(state, { type: 'request', trigger: 'operator', intent }, NOW)).toEqual({ ok: false, reason: 'writer_lease_held' });
        expect(step(state, { ...receipt, holder: 'second-operator', type: 'acquire_writer_lease', expiresAt: EXPIRES }, NOW)).toEqual({ ok: false, reason: 'writer_lease_held' });
        expect(state.status).toBe('writer_lease_acquired');
    });

    it('refuses a different computer or holder even when generation matches', () => {
        expect(step(acquire(), { ...receipt, computerId: 'other', type: 'restore' }, NOW)).toEqual({ ok: false, reason: 'computer_mismatch' });
        expect(step(acquire(), { ...receipt, holder: 'other', type: 'restore' }, NOW)).toEqual({ ok: false, reason: 'lease_mismatch' });
    });

    it.each([
        { instanceStopped: false, taggedGeneration: 8 },
        { instanceStopped: true, taggedGeneration: 7 },
        { instanceStopped: true, taggedGeneration: 9 },
    ])('requires stopped AND next-generation-tagged old writer: %j', proof => {
        expect(step(acquire(), { ...receipt, type: 'fence_old_writer', ...proof }, NOW)).toEqual({ ok: false, reason: 'old_writer_not_fenced' });
    });

    it('refuses restore before the old writer is fenced and before snapshot copy finishes', () => {
        expect(step(acquire(), { ...receipt, type: 'restore' }, NOW)).toEqual({ ok: false, reason: 'old_writer_not_fenced' });
        for (const state of [fence(), snapshot()]) expect(step(state, { ...receipt, type: 'restore' }, NOW)).toEqual({ ok: false, reason: 'invalid_transition' });
    });

    it('increments generation exactly once at restore and refuses every late old-generation receipt', () => {
        const state = restore();
        expect(state.generation).toBe(8);
        for (const event of [
            { ...receipt, type: 'restore' }, { ...receipt, type: 'failed', reason: 'late' },
            { ...receipt, type: 'activate', attached: true, volumeSerial: 'vol123' },
        ] satisfies MigrateEvent[]) expect(step(state, event, NOW)).toEqual({ ok: false, reason: 'generation_fenced' });
        expect(step(state, { ...receipt, generation: 8, type: 'restore' }, NOW)).toEqual({ ok: false, reason: 'invalid_transition' });
        expect(step(activate(), { ...receipt, type: 'failed', reason: 'late' }, NOW)).toEqual({ ok: false, reason: 'generation_fenced' });
    });

    it.each([
        { targetKeyId: undefined }, { targetKeyId: ' ' }, { targetRegion: 'ap-south-1' },
        { targetKeyId: 'arn:aws:kms:ap-south-1:123456789012:key/wrong' },
        { sourceSnapshotId: 'snap-wrong' }, { copiedSnapshotId: 'snap-source' }, { copiedSnapshotId: '' },
    ])('refuses incomplete or wrong-region snapshot re-encryption: %j', patch => {
        expect(step(snapshot(), { ...copyEvent, ...patch }, NOW)).toEqual({ ok: false, reason: 'target_reencrypt_required' });
    });

    it('requires a snapshot copy, not a generic volume copy', () => {
        expect(step(snapshot(), { ...copyEvent, copyKind: 'volume' } as unknown as MigrateEvent, NOW)).toEqual({ ok: false, reason: 'target_reencrypt_required' });
        expect(step(fence(), { ...receipt, type: 'snapshot_ready' }, NOW)).toEqual({ ok: false, reason: 'snapshot_required' });
    });

    it.each([undefined, new Date(NOW.getTime() - 60_001), new Date('invalid'), new Date(NOW.getTime() + 1)])('fails closed on stale/unknown/invalid/future replica time %s', replicaSnapshotAt => {
        const state = copy(unwrap(step(fence(), { ...receipt, type: 'snapshot_ready', snapshotId: 'snap-source', replicaSnapshotAt }, NOW)));
        const failed = unwrap(step(state, { ...receipt, type: 'restore' }, NOW));
        expect(failed).toMatchObject({ status: 'recovery_required', recoveryReason: 'replica_stale', generation: 7 });
        expect(step(failed, { ...receipt, type: 'restore' }, NOW)).toEqual({ ok: false, reason: 'terminal_state' });
    });

    it('accepts the exact maximum age and rechecks freshness at restore time', () => {
        expect(restore(copy(snapshot(fence(), new Date(NOW.getTime() - 60_000))))).toMatchObject({ status: 'restoring', generation: 8 });
        expect(unwrap(step(copy(), { ...receipt, type: 'restore' }, new Date(NOW.getTime() + 60_001)))).toMatchObject({ status: 'recovery_required', recoveryReason: 'replica_stale' });
    });

    it('supports snapshot metadata carried by the explicit intent', () => {
        const state = fence(acquire(requested({ snapshotId: 'snap-source', replicaSnapshotAt: NOW })));
        const ready = unwrap(step(state, { ...receipt, type: 'snapshot_ready' }, NOW));
        expect(restore(copy(ready)).status).toBe('restoring');
    });

    it('never borrows freshness metadata from a different snapshot', () => {
        const state = fence(acquire(requested({ snapshotId: 'snap-other', replicaSnapshotAt: NOW })));
        const ready = unwrap(step(state, { ...receipt, type: 'snapshot_ready', snapshotId: 'snap-source' }, NOW));
        expect(restore(copy(ready))).toMatchObject({ status: 'recovery_required', recoveryReason: 'replica_stale' });
    });

    it('lease expiry enters recovery and cannot restart or steal the lease', () => {
        const state = acquire();
        const failed = unwrap(step(state, { ...receipt, type: 'restore' }, EXPIRES));
        expect(failed).toMatchObject({ status: 'recovery_required', recoveryReason: 'writer_lease_expired' });
        expect(step(failed, { type: 'request', trigger: 'operator', intent }, EXPIRES)).toEqual({ ok: false, reason: 'invalid_transition' });
        expect(step(failed, { ...receipt, type: 'acquire_writer_lease', expiresAt: new Date(EXPIRES.getTime() + 1_000) }, EXPIRES)).toEqual({ ok: false, reason: 'invalid_transition' });
    });

    it('records provider failures as terminal recovery, never an automatic retry', () => {
        for (const state of [acquire(), fence(), snapshot(), copy(), restore()]) {
            const failed = unwrap(step(state, { ...receipt, generation: state.generation, type: 'failed', reason: 'restore_failed' }, NOW));
            expect(failed).toMatchObject({ status: 'recovery_required', recoveryReason: 'restore_failed' });
            expect(step(failed, { ...receipt, generation: state.generation, type: 'restore' }, NOW)).toEqual({ ok: false, reason: 'terminal_state' });
        }
    });

    it('has no automatic failback; a reverse move is a new explicit intent with the current generation', () => {
        const active = activate();
        const back = { ...intent, from: 'us-east-1', to: 'ap-south-1', generation: 8 };
        expect(step(active, { type: 'request', trigger: 'automatic', intent: back }, NOW)).toEqual({ ok: false, reason: 'automatic_trigger' });
        expect(step(active, { ...receipt, generation: 8, type: 'restore' }, NOW)).toEqual({ ok: false, reason: 'terminal_state' });
        expect(step(active, { type: 'request', trigger: 'operator', intent: back }, NOW)).toEqual({ ok: false, reason: 'writer_lease_held' });
        const newIntent = unwrap(step(active, { type: 'request', trigger: 'operator', intent: back }, EXPIRES));
        expect(newIntent).toMatchObject({ status: 'requested', intent: back, writerLease: null, generation: 8 });
        expect(newIntent.volumeSerial).toBeUndefined();
        expect(step(active, { type: 'request', trigger: 'operator', intent: { ...back, generation: 7 } }, EXPIRES)).toEqual({ ok: false, reason: 'generation_fenced' });
    });

    it.each([
        { attached: true, deviceName: '/dev/nvme1n1' }, { attached: true, volumeSerial: '/dev/nvme1n1' },
        { attached: false, volumeSerial: 'vol0123456789abcdef0' }, { attached: true, volumeSerial: '' },
    ])('refuses activation without an attached disk identified by volume serial: %j', disk => {
        expect(step(restore(), { ...receipt, generation: 8, type: 'activate', ...disk }, NOW)).toEqual({ ok: false, reason: 'volume_serial_required' });
    });

    it('does not mutate its input state or receipt', () => {
        const state = copy();
        const event: MigrateEvent = { ...receipt, type: 'restore' };
        const before = JSON.stringify({ state, event });
        step(state, event, NOW);
        expect(JSON.stringify({ state, event })).toBe(before);
    });
});
