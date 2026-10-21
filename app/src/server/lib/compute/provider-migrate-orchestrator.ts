import { after } from 'next/server';
import { pendingRecovery, TERMINAL_MIGRATION_STATES } from './provider-migrate';
import { MigrationConflictError, type ComputeMigration, type createProviderMigrationStore, type MigrationFailureReason, type MigrationStoreEvent } from './provider-migrate-store';
import type { MigrateBeginResult, MigrateCommitInput, MigrateResult } from '../cloudflare-guacamole-provider';
import type { SnapshotHead } from './provider-migrate';

export interface MigrationDeps {
    store: Pick<ReturnType<typeof createProviderMigrationStore>, 'readById' | 'applyTransition'>;
    /** Cross-process lock; a busy migration returns immediately. */
    exclusive(id: string, run: () => Promise<void>): Promise<void>;
    begin(m: ComputeMigration): Promise<MigrateResult<MigrateBeginResult>>;
    head(m: ComputeMigration, kind: 'workspace' | 'system'): Promise<MigrateResult<SnapshotHead>>;
    exportEtag(m: ComputeMigration): Promise<string>;
    provision(m: ComputeMigration): Promise<void>;
    releaseProvision(m: ComputeMigration): Promise<void>;
    restored(m: ComputeMigration): Promise<boolean>;
    flip(m: ComputeMigration): Promise<void>;
    rollback(m: ComputeMigration): Promise<void>;
    commit(m: ComputeMigration, input: MigrateCommitInput): Promise<MigrateResult<unknown>>;
    abort(m: ComputeMigration): Promise<MigrateResult<unknown>>;
    reopen(m: ComputeMigration, etag: string): Promise<MigrateResult<unknown>>;
    stopCloudflare(m: ComputeMigration): Promise<void>;
}
export class MigrationStepError extends Error {
    constructor(readonly retryable: boolean, readonly reason?: MigrationFailureReason) { super('migration_step_failed'); }
}
function checked<T>(result: MigrateResult<T>): T {
    if (!result.ok) throw new MigrationStepError(result.error === 'unavailable', result.error === 'conflict' ? result.reason : undefined);
    return result.data;
}

/** One durable step. External effects are idempotent; CAS loss never triggers compensation. */
export async function advanceMigration(deps: MigrationDeps, migrationId: string): Promise<void> {
    try {
        await deps.exclusive(migrationId, async () => {
            const m = await deps.store.readById(migrationId);
            if (!m) return;
            if (TERMINAL_MIGRATION_STATES.includes(m.state)) {
                if (m.state !== 'committed') await deps.releaseProvision(m);
                return;
            }
            const transition = async (event: MigrationStoreEvent) => {
                const current = await deps.store.readById(migrationId);
                if (!current || current.state !== m.state) throw new MigrationConflictError();
                const result = await deps.store.applyTransition(current, event);
                if (!result.accepted) throw new MigrationConflictError();
                return result;
            };
            const recover = async (effect: 'abort' | 'reopen') => {
                try {
                    // Undo publication before re-enabling Cloudflare; no AWS user writes were admitted.
                    const current = await deps.store.readById(migrationId);
                    if (!current || pendingRecovery(current) !== effect) throw new MigrationConflictError();
                    await deps.rollback(current);
                    if (effect === 'reopen') checked(await deps.reopen(current, await deps.exportEtag(current)));
                    else checked(await deps.abort(current));
                    await transition({ type: 'reopened' });
                } catch (error) {
                    if (error instanceof MigrationConflictError) throw error;
                    await transition({ type: 'error', step: effect, retryable: false,
                        reason: error instanceof MigrationStepError ? error.reason : undefined });
                }
            };
            const recovery = pendingRecovery(m);
            if (recovery) { await recover(recovery); return; }
            let step: string = m.state;
            try {
                switch (m.state) {
                    case 'requested': {
                        step = 'begin';
                        const begin = checked(await deps.begin(m));
                        await transition({ type: 'fenced', etag: begin.etag, systemEtag: begin.systemEtag, generation: begin.generation });
                        break;
                    }
                    case 'fenced': {
                        step = 'export';
                        const workspaceHead = { ...checked(await deps.head(m, 'workspace')) };
                        // This namespace belongs to the server, never to exported snapshot JSON.
                        delete workspaceHead._awsProvision;
                        const system = await deps.head(m, 'system');
                        const systemHead = !system.ok && system.error === 'not_found' ? null : checked(system);
                        if (workspaceHead.generation !== m.generation)
                            throw new MigrationStepError(false, 'generation_mismatch');
                        if ((m.sourceSystemEtag === null) !== (systemHead === null))
                            throw new MigrationStepError(false, 'system_head_mismatch');
                        await transition({ type: 'exported', workspaceHead, systemHead });
                        break;
                    }
                    case 'exported':
                        step = 'provision';
                        await deps.provision(m);
                        await transition({ type: 'provisioned' });
                        break;
                    case 'provisioning':
                        step = 'restore';
                        if (await deps.restored(m)) await transition({ type: 'host_restored', generation: m.generation! });
                        break;
                    case 'restored': {
                        step = 'flip';
                        await deps.flip(m);
                        step = 'commit';
                        checked(await deps.commit(m, { targetProvider: 'aws-ec2', expectedEtag: m.sourceEtag!, expectedSystemEtag: m.sourceSystemEtag }));
                        const migratedEtag = await deps.exportEtag(m);
                        // Stop remains replayable if the process dies before the final CAS.
                        await deps.stopCloudflare(m);
                        await transition({ type: 'committed', migratedEtag });
                        break;
                    }
                }
            } catch (error) {
                if (error instanceof MigrationConflictError) throw error;
                // Commit uncertainty needs compensation, not a blind second commit.
                const result = await transition({ type: 'error', step,
                    reason: error instanceof MigrationStepError ? error.reason : undefined,
                    retryable: step !== 'commit' && error instanceof MigrationStepError && error.retryable });
                if (result.effect === 'abort' || result.effect === 'reopen') await recover(result.effect);
            }
        });
    } catch (error) {
        if (!(error instanceof MigrationConflictError)) throw error;
    }
}

export async function sweepMigrations(input: {
    claimStale(limit: number): Promise<ComputeMigration[]>;
    advance(id: string): Promise<void>;
    now?: () => number;
    startedAt?: number;
    log?: (id: string) => void;
}): Promise<number> {
    const now = input.now ?? Date.now, startedAt = input.startedAt ?? now();
    if (now() - startedAt >= 40_000) return 0;
    const migrations = await input.claimStale(10);
    let launched = 0;
    for (const m of migrations.slice(0, 10)) {
        if (now() - startedAt >= 40_000) break;
        launched++;
        try { await input.advance(m.id); } catch { input.log?.(m.id); }
    }
    return launched;
}

/** Called after the grant write. Neither import, scheduling nor migration failure escapes. */
export function schedulePaidMigration(userId: string, sku: string, eventType: string,
    schedule: (work: () => Promise<void>) => void = work => {
        try { after(work); } catch { void work().catch(() => {}); }
    },
    run: (userId: string, sku: string) => Promise<void> = async (user, plan) => {
        const runtime = await import('./provider-migrate-runtime');
        await runtime.startPaidMigration(user, plan);
    }): void {
    if (eventType !== 'invoice.paid' || !['standard_monthly_v3', 'premium_monthly_v3'].includes(sku)) return;
    try { schedule(async () => { try { await run(userId, sku); } catch { /* No id exists yet; no customer/error logging. */ } }); }
    catch { /* A scheduling failure cannot fail a paid webhook. Cron handles recorded work. */ }
}

export async function migrationStatusFor(userId: string): Promise<'preparing' | 'failed' | null> {
    const { migrationStore } = await import('./provider-migrate-runtime');
    return (await migrationStore()).statusFor(userId);
}

export async function advanceStaleMigrations(startedAt = Date.now()): Promise<void> {
    try {
        const { defaultMigrationDeps } = await import('./provider-migrate-runtime');
        const deps = await defaultMigrationDeps();
        await sweepMigrations({ claimStale: deps.store.claimStale, advance: id => advanceMigration(deps, id), startedAt,
            log: id => console.warn('[compute.migration]', { migrationId: id }) });
    } catch { /* Preserve the billing sweep if migration storage is unavailable. */ }
}
