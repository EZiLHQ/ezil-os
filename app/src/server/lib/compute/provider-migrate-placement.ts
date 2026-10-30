import { PlacementOwnerError, type PlacementExecutor } from './placement';
import type { ComputeProvider, ComputerRef } from './provider';
import { MIGRATION_STATES, TERMINAL_MIGRATION_STATES } from './provider-migrate';
import { createProviderMigrationStore, MigrationConflictError } from './provider-migrate-store';

/** A destination-labelled wait, never authority to start either migration writer. */
export function migrationStartingAnswer() {
    return { ok: false as const, error: 'computer_migrating', errorCode: 'sandbox_starting',
        retryable: true, computeProvider: 'aws-ec2' as const };
}

const waitingProvider: ComputeProvider = {
    kind: 'aws-ec2',
    ensure: async () => migrationStartingAnswer(),
    status: async () => ({ ...migrationStartingAnswer(), state: 'starting' }),
    activity: async () => ({ ok: false, error: 'computer_migrating' }),
    restart: async () => ({ ok: false, error: 'computer_migrating' }),
    stop: async () => ({ ok: false, terminated: false, outcome: 'computer_migrating' }),
    terminate: async () => ({ ok: false, terminated: false, outcome: 'computer_migrating' }),
};

/** Call only after the published placement's ownership/integrity/reservation checks.
 * Re-read on every request: commit releases this wait so the normal AWS provider
 * applies the migration_pending receipt on that same poll. Recovery stays fenced
 * until the migration orchestrator has restored the source and recorded a terminal state.
 */
export async function providerForPendingMigration(db: PlacementExecutor, computer: ComputerRef): Promise<ComputeProvider | null> {
    const migration = await createProviderMigrationStore(db).readActiveByComputer(computer.computerId);
    if (!migration) return null;
    if (migration.userId !== computer.userId.toLowerCase()) throw new PlacementOwnerError(computer.computerId);
    if (migration.computerId !== computer.computerId.toLowerCase() || migration.fromProvider !== 'cloudflare'
        || migration.toProvider !== 'aws-ec2' || !MIGRATION_STATES.includes(migration.state)
        || TERMINAL_MIGRATION_STATES.includes(migration.state)) throw new MigrationConflictError();
    return waitingProvider;
}
