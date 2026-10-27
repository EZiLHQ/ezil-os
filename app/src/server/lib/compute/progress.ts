/** Read-only progress from recorded stages and successful restore chunk responses. */
import { SIZES } from '@/server/billing/v2/contract';
import type { EntitlementRecord } from './tier';
import { isAwsComputersEnabled, isPlacementReadEnabled, type Env } from './aws-config';
import { PlacementOwnerError, readPlacement, type Placement, type PlacementState, type PlacementExecutor } from './placement';
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

export function describeProgress(computerId: string, placement: Placement | null, migration: ComputeMigration | null, env: Env, now = new Date(), entitlement: EntitlementRecord | null = null) {
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
    const needsOperator = stage === 'failed_needs_operator' || lifecycle === 'UNCONFIRMED';
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
