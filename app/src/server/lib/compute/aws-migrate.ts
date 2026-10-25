/** Offline reducer for ONE computer's global migration authority. No AWS calls.
 * Persist/serialize one canonical state per computer (the writer-leases SQL PK)
 * before using this in a live path; independent reducer copies are not a lock.
 * Events represent verified control-plane receipts, never guest assertions. */
import { AWS_REGION_PATTERN } from './aws-config';

export interface MigrateIntent {
    computerId: string;
    from: string;
    to: string;
    generation: number;
    snapshotId?: string;
    replicaSnapshotAt?: Date;
    maxReplicaAgeSeconds: number;
}
export type MigrateStatus = 'requested' | 'writer_lease_acquired' | 'old_writer_fenced'
    | 'snapshot_ready' | 'copied_reencrypted' | 'restoring' | 'active_in_target' | 'recovery_required';
export interface WriterLease {
    computerId: string; region: string; generation: number; holder: string;
    expiresAt: Date; fencedAt: Date | null;
}
export interface MigrateState {
    status: MigrateStatus;
    intent: MigrateIntent;
    generation: number;
    writerLease: WriterLease | null;
    oldWriterFencedAt?: Date;
    snapshotId?: string;
    replicaSnapshotAt?: Date;
    copiedSnapshotId?: string;
    targetKeyId?: string;
    volumeSerial?: string;
    recoveryReason?: string;
}
interface Receipt { computerId: string; generation: number; holder: string }
export type MigrateEvent =
    | { type: 'request'; trigger: 'operator' | 'automatic'; intent: MigrateIntent }
    | (Receipt & { type: 'acquire_writer_lease'; expiresAt: Date })
    | (Receipt & { type: 'fence_old_writer'; instanceStopped: boolean; taggedGeneration: number })
    | (Receipt & { type: 'snapshot_ready'; snapshotId?: string; replicaSnapshotAt?: Date })
    | (Receipt & { type: 'copy_reencrypted'; copyKind: 'snapshot'; sourceSnapshotId: string;
        copiedSnapshotId: string; targetRegion: string; targetKeyId?: string })
    | (Receipt & { type: 'restore' })
    | (Receipt & { type: 'activate'; attached: boolean; volumeSerial?: string; deviceName?: string })
    | (Receipt & { type: 'failed'; reason: string });
export type MigrateRefusal = 'invalid_intent' | 'invalid_time' | 'automatic_trigger' | 'writer_lease_held'
    | 'writer_lease_required' | 'lease_mismatch' | 'generation_fenced' | 'computer_mismatch'
    | 'invalid_transition' | 'old_writer_not_fenced' | 'snapshot_required'
    | 'target_reencrypt_required' | 'volume_serial_required' | 'terminal_state';
export type MigrateResult = { ok: true; state: MigrateState } | { ok: false; reason: MigrateRefusal };
const refuse = (reason: MigrateRefusal): MigrateResult => ({ ok: false, reason });
const nonempty = (s: string | undefined) => typeof s === 'string' && s.trim().length > 0;
const time = (d: Date | undefined) => d?.getTime() ?? NaN;

/** Explicit operator intent only. A reverse move needs its own new intent. */
export function requestMigrate(intent: MigrateIntent): MigrateResult {
    if (!nonempty(intent.computerId) || !AWS_REGION_PATTERN.test(intent.from) || !AWS_REGION_PATTERN.test(intent.to)
        || intent.from === intent.to || !Number.isSafeInteger(intent.generation) || intent.generation < 1
        || intent.generation >= Number.MAX_SAFE_INTEGER || !Number.isFinite(intent.maxReplicaAgeSeconds)
        || intent.maxReplicaAgeSeconds < 0) return refuse('invalid_intent');
    return { ok: true, state: {
        status: 'requested', intent: { ...intent }, generation: intent.generation, writerLease: null,
        snapshotId: intent.snapshotId, replicaSnapshotAt: intent.replicaSnapshotAt,
    } };
}

export function step(state: MigrateState, event: MigrateEvent, now: Date): MigrateResult {
    const at = time(now);
    if (!Number.isFinite(at)) return refuse('invalid_time');
    const next = (patch: Partial<MigrateState>): MigrateResult => ({ ok: true, state: { ...state, ...patch } });
    const recovery = (reason: string) => next({ status: 'recovery_required', recoveryReason: reason });
    const held = state.writerLease !== null && time(state.writerLease.expiresAt) > at;
    if (event.type === 'request') {
        if (event.trigger !== 'operator') return refuse('automatic_trigger');
        if (held) return refuse('writer_lease_held');
        // Recovery requires operator reconciliation outside this reducer. A terminal
        // successful move permits a NEW intent, starting at its current region/epoch.
        if (state.status !== 'active_in_target') return refuse('invalid_transition');
        if (event.intent.computerId !== state.intent.computerId) return refuse('computer_mismatch');
        if (event.intent.generation !== state.generation) return refuse('generation_fenced');
        if (event.intent.from !== state.intent.to) return refuse('invalid_intent');
        return requestMigrate(event.intent);
    }
    if (event.computerId !== state.intent.computerId) return refuse('computer_mismatch');
    if (event.generation !== state.generation) return refuse('generation_fenced');
    if (event.type === 'acquire_writer_lease') {
        if (held) return refuse('writer_lease_held');
        if (state.status !== 'requested') return refuse('invalid_transition');
        if (!nonempty(event.holder) || !Number.isFinite(time(event.expiresAt)) || time(event.expiresAt) <= at) return refuse('lease_mismatch');
        return next({ status: 'writer_lease_acquired', writerLease: {
            computerId: event.computerId, region: state.intent.from, generation: state.generation,
            holder: event.holder, expiresAt: event.expiresAt, fencedAt: null,
        } });
    }
    if (state.status === 'active_in_target' || state.status === 'recovery_required') return refuse('terminal_state');
    if (!state.writerLease) return refuse('writer_lease_required');
    if (!held) return recovery('writer_lease_expired');
    if (state.writerLease.holder !== event.holder || state.writerLease.generation !== event.generation) return refuse('lease_mismatch');
    if (event.type === 'failed') return recovery(nonempty(event.reason) ? event.reason : 'migration_failed');
    switch (event.type) {
        case 'fence_old_writer':
            if (state.status !== 'writer_lease_acquired') return refuse('invalid_transition');
            if (!event.instanceStopped || event.taggedGeneration !== state.generation + 1) return refuse('old_writer_not_fenced');
            return next({ status: 'old_writer_fenced', oldWriterFencedAt: now,
                writerLease: { ...state.writerLease, fencedAt: now } });
        case 'snapshot_ready': {
            if (state.status !== 'old_writer_fenced') return refuse('invalid_transition');
            const snapshotId = event.snapshotId ?? state.snapshotId;
            if (!nonempty(snapshotId)) return refuse('snapshot_required');
            return next({ status: 'snapshot_ready', snapshotId,
                replicaSnapshotAt: event.replicaSnapshotAt
                    ?? (snapshotId === state.snapshotId ? state.replicaSnapshotAt : undefined) });
        }
        case 'copy_reencrypted':
            if (state.status !== 'snapshot_ready') return refuse('invalid_transition');
            if (event.copyKind !== 'snapshot' || event.sourceSnapshotId !== state.snapshotId
                || !nonempty(event.copiedSnapshotId) || event.copiedSnapshotId === state.snapshotId
                || event.targetRegion !== state.intent.to || !nonempty(event.targetKeyId)) return refuse('target_reencrypt_required');
            // A full KMS ARN, when supplied, must also name the target region.
            if (event.targetKeyId!.startsWith('arn:') && event.targetKeyId!.split(':')[3] !== state.intent.to) return refuse('target_reencrypt_required');
            return next({ status: 'copied_reencrypted', copiedSnapshotId: event.copiedSnapshotId, targetKeyId: event.targetKeyId });
        case 'restore': {
            if (!state.oldWriterFencedAt || !state.writerLease.fencedAt) return refuse('old_writer_not_fenced');
            if (state.status !== 'copied_reencrypted') return refuse('invalid_transition');
            const replicaAt = time(state.replicaSnapshotAt);
            if (!Number.isFinite(replicaAt) || replicaAt > at || (at - replicaAt) / 1_000 > state.intent.maxReplicaAgeSeconds) return recovery('replica_stale');
            const generation = state.generation + 1;
            return next({ status: 'restoring', generation,
                writerLease: { ...state.writerLease, generation, region: state.intent.to } });
        }
        case 'activate':
            if (state.status !== 'restoring') return refuse('invalid_transition');
            if (!event.attached || !nonempty(event.volumeSerial) || !/^vol-?[0-9a-f]+$/.test(event.volumeSerial!)) return refuse('volume_serial_required');
            return next({ status: 'active_in_target', volumeSerial: event.volumeSerial });
    }
}
