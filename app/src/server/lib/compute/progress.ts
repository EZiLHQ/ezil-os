/** Read-only progress from recorded stages and successful restore chunk responses. */
import { SIZES } from '@/server/billing/v2/contract';
import type { EntitlementRecord } from './tier';
import { isAwsComputersEnabled, isPlacementReadEnabled, type Env } from './aws-config';
import { isUnenrolledPastGrace, PlacementOwnerError, readPlacement, type Placement, type PlacementState, type PlacementExecutor } from './placement';
import { MIGRATION_STATES, pendingRecovery, TERMINAL_MIGRATION_STATES, type MigrationState } from './provider-migrate';
import { createProviderMigrationStore, snapshotChunkSizes, type ComputeMigration } from './provider-migrate-store';

function transferProgress(migration: ComputeMigration | null, stage: string, stopped: boolean) {
    const workspace = migration && !['requested', 'fenced'].includes(migration.state) ? snapshotChunkSizes(migration.workspaceHead) : null;
    const system = migration?.systemHead ? snapshotChunkSizes(migration.systemHead) : [];
    const total = workspace && system ? [...workspace, ...system].reduce((sum, size) => sum + size, 0) : null;
    const progress = total === null ? null : migration?.restoreProgress;
    const transferred = total === null ? null : progress?.bytes ?? 0;
    const iso = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const transferStartedAt = iso(progress?.first), transferUpdatedAt = iso(progress?.last);
    const seconds = transferStartedAt && transferUpdatedAt ? (Date.parse(transferUpdatedAt) - Date.parse(transferStartedAt)) / 1000 : 0;
    const chunks = [progress?.workspace, progress?.system].reduce((count, bits) => count + (bits && /^[a-f0-9]{128}$/i.test(bits)
        ? [...bits].reduce((sum, hex) => sum + parseInt(hex, 16).toString(2).replaceAll('0', '').length, 0) : 0), 0);
    const rate = transferred !== null && seconds > 0 ? transferred / seconds : 0;
    return {
        bytes: { transferred, total },
        percent: transferred === null || total === null || total === 0 ? null : Math.max(0, Math.min(100, Math.floor(100 * transferred / total))),
        etaSeconds: !stopped && ['exported', 'provisioning'].includes(stage) && chunks >= 4 && rate > 0 && total !== null
            ? Math.ceil(Math.max(0, total - transferred!) / rate) : null,
        transferStartedAt, transferUpdatedAt,
        typicalSeconds: total === null ? null : Math.max(90, Math.min(600, Math.round(90 + total / 4_000_000))),
    };
}

/**
 * Typical seconds for an AWS open (provision or wake through desktop-ready), shown as the
 * shell's meter/countdown denominator. 240 s is the measured cold open (founder runs
 * 2026-10: 215-300 s), which is also the shell's own fallback. When the caller already holds
 * the pool class's boot p90 (ready-pool `boot_minutes`, in MINUTES) it is used instead.
 * Either figure is clamped to the same 90-600 s band as migration estimates, so a corrupt or
 * outlier observation can neither promise an instant open nor a ten-minute-plus one.
 */
export const OPENING_TYPICAL_SECONDS = 240;
export const TYPICAL_SECONDS_MIN = 90;
export const TYPICAL_SECONDS_MAX = 600;

export function openingTypicalSeconds(poolBootP90Minutes?: number | null): number {
    const measured = typeof poolBootP90Minutes === 'number' && Number.isFinite(poolBootP90Minutes) && poolBootP90Minutes > 0
        ? Math.round(poolBootP90Minutes * 60) : OPENING_TYPICAL_SECONDS;
    return Math.max(TYPICAL_SECONDS_MIN, Math.min(TYPICAL_SECONDS_MAX, measured));
}

export interface ProgressOptions {
    /** Pool class boot p90 in minutes, only when the caller already has it; never read here. */
    poolBootP90Minutes?: number | null;
}

export function describeProgress(computerId: string, placement: Placement | null, migration: ComputeMigration | null, env: Env, now = new Date(), entitlement: EntitlementRecord | null = null, options: ProgressOptions = {}) {
    const active = migration && !TERMINAL_MIGRATION_STATES.includes(migration.state) ? migration : null;
    const aws = placement?.provider === 'aws-ec2' || !!active
        || (entitlement?.provider === 'aws' && entitlement.status === 'active' && !entitlement.paymentIssue);
    const paused = aws && (!isAwsComputersEnabled(env) || (env.EZIL_AWS_KILL_SWITCH !== undefined && env.EZIL_AWS_KILL_SWITCH !== '0'));
    const lifecycle = placement?.provider === 'aws-ec2' ? placement.state : null;
    let operation: 'migration' | 'opening' | 'stopping' | 'none' = active ? 'migration' : 'none';
    let stage: Lowercase<PlacementState> | MigrationState | 'recovering' | 'unavailable' = 'unavailable';
    // A terminal failure belongs to the current recorded transition only if it
    // is at least as recent as the placement. A later placement supersedes it.
    const relevantFailure = migration?.state.startsWith('failed_')
        && (!placement || Date.parse(migration.updatedAt) >= placement.updatedAt.getTime());
    if (active) stage = pendingRecovery(active) ? 'recovering' : active.state;
    else if (relevantFailure) stage = migration!.state;
    else if (lifecycle) {
        stage = lifecycle.toLowerCase() as Lowercase<PlacementState>;
        if (['PROVISIONING', 'LEASED', 'STARTING', 'MOUNTING', 'WARMING', 'CLAIMED'].includes(lifecycle)) operation = 'opening';
        if (['STOPPING', 'DRAINING', 'RETIRING'].includes(lifecycle)) operation = 'stopping';
    }
    const selectedSize = entitlement?.source === 'billing_v2' && entitlement.status === 'active' && !entitlement.paymentIssue && entitlement.provider === 'aws' && entitlement.size && entitlement.planId ? SIZES[entitlement.size] : null;
    const selected = selectedSize?.provider === 'aws' ? selectedSize : null;
    // The enrollment nonce (TTL + grace, placement.ts `isUnenrolledPastGrace`) has expired with no
    // host presence this epoch: the open has failed even before the receipt pass records
    // UNCONFIRMED. Same MOUNTING-only predicate as that CAS, so progress never shows a failure
    // that no transition resolves.
    const enrollmentExpired = !active && !relevantFailure && !!placement && isUnenrolledPastGrace(placement, now);
    const needsOperator = stage === 'failed_needs_operator' || lifecycle === 'UNCONFIRMED' || enrollmentExpired;
    // A cutoff must never be presented as active transfer. Keep recordedStage for diagnostics.
    return {
        version: 2 as const, computerId, observedAt: now.toISOString(), operation,
        stage: paused ? 'operations_paused' : needsOperator ? 'needs_operator' : stage === 'requested' ? 'queued' : stage, recordedStage: stage,
        lifecycleState: lifecycle, paused, operationsPaused: paused, needsOperator,
        active: !paused && !needsOperator && operation !== 'none' && stage !== 'requested',
        startedAt: active ? new Date(active.createdAt).toISOString() : null,
        updatedAt: active || relevantFailure ? new Date(migration!.updatedAt).toISOString() : placement?.updatedAt.toISOString() ?? null,
        durable: !!active, resumePolicy: active ? 'saved_workspace_only' as const : 'unavailable' as const,
        ...transferProgress(operation === 'migration' ? migration : null, stage, paused || needsOperator),
        // An open has no byte count; it still has a bounded typical duration while it is underway.
        ...(operation === 'opening' ? { typicalSeconds: paused || needsOperator ? null : openingTypicalSeconds(options.poolBootP90Minutes) } : {}),
        selectedNextOpenHardware: selected ? { size: entitlement!.size!, vcpu: selected.vcpu, memoryGiB: selected.memoryGiB, effective: 'next_open' as const } : null,
        hardware: { instanceType: placement?.instanceType ?? null, source: placement ? 'placement' as const : 'unavailable' as const },
    };
}

/** Caller first checks live computer ownership; this repeats ownership for both stored records. */
export async function readComputerProgress(db: PlacementExecutor, computer: { computerId: string; userId: string }, env: Env = process.env) {
    if (!isPlacementReadEnabled(env)) return describeProgress(computer.computerId, null, null, env);
    try {
        const placement = await readPlacement(db, computer.computerId, computer.userId);
        const migration = await createProviderMigrationStore(db).readByComputer(computer.computerId);
        if (migration && (migration.userId !== computer.userId.toLowerCase() || migration.computerId !== computer.computerId.toLowerCase())) return null;
        if (migration && !MIGRATION_STATES.includes(migration.state)) throw new Error('invalid migration state');
        let entitlement: EntitlementRecord | null = null;
        try {
            const { billingV2EntitlementReader } = await import('@/server/billing/v2/compute-access');
            entitlement = await billingV2EntitlementReader().read(computer.userId);
        } catch { /* An unavailable preference must not hide actual progress. */ }
        return describeProgress(computer.computerId, placement.record, migration, env, new Date(), entitlement);
    } catch (error) {
        if (error instanceof PlacementOwnerError) return null;
        // No raw database/provider errors in the user contract; never infer a running operation.
        return describeProgress(computer.computerId, null, null, env);
    }
}
