/** Read-only progress. Recorded stages are not measured transfer progress or readiness probes. */
import { SIZES } from '@/server/billing/v2/contract';
import type { EntitlementRecord } from './tier';
import { isAwsComputersEnabled, isPlacementReadEnabled, type Env } from './aws-config';
import { PlacementOwnerError, readPlacement, type Placement, type PlacementState, type PlacementExecutor } from './placement';
import { MIGRATION_STATES, pendingRecovery, TERMINAL_MIGRATION_STATES, type MigrationState } from './provider-migrate';
import { createProviderMigrationStore, type ComputeMigration } from './provider-migrate-store';

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
        version: 1 as const, computerId, observedAt: now.toISOString(), operation,
        stage: paused ? 'operations_paused' : needsOperator ? 'needs_operator' : stage === 'requested' ? 'queued' : stage, recordedStage: stage,
        lifecycleState: lifecycle, paused, operationsPaused: paused, needsOperator,
        active: !paused && !needsOperator && operation !== 'none' && stage !== 'requested',
        startedAt: active ? new Date(active.createdAt).toISOString() : null,
        updatedAt: active || relevantFailure ? new Date(migration!.updatedAt).toISOString() : placement?.updatedAt.toISOString() ?? null,
        durable: !!active, resumePolicy: active ? 'saved_workspace_only' as const : 'unavailable' as const,
        bytes: { transferred: null, total: null }, percent: null, etaSeconds: null,
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
