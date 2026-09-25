import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { db } from '@/server/db';
import { appAuditEvents, appInstallations, appJobs, appOutbox,
    appRuntimeCommands, computerInstances, computerLifecycleJobs,
    computerRuntimes, computers } from '@/server/db/schema';
import { sameRuntimePlan, type RuntimePlan } from './runtime-plan';
import { currentStartPlan } from './runtime-authority';
import { HostControlError, hostIntentDigest, type HostCommand, type HostControlClient, type HostScope } from './host-control-client';

type Database = typeof db;
type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
type Command = typeof appRuntimeCommands.$inferSelect;
export interface RuntimeClaim { id: string; jobId: string; attempt: number }
export interface RuntimeDispatcherOptions {
    database: Database;
    /** Trusted worker configuration, never a browser request parameter. */
    enabled: boolean;
    osAccessMode: 'invite' | 'open';
    /** Provisioning owns the exact origin/key lookup. This must not create a
     * host, start compute, pull images, or return another writer's credentials. */
    resolveHost(scope: HostScope, signal: AbortSignal): Promise<HostControlClient>;
}
export type DispatchResult = 'disabled' | 'empty' | 'stale' | 'waiting' | 'succeeded' | 'cancelled';

async function resolveBounded(options: RuntimeDispatcherOptions, scope: HostScope) {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([options.resolveHost(scope, abort.signal), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { abort.abort(); reject(new HostControlError('host_unavailable')); }, 5000);
        })]);
    } finally { clearTimeout(timer); }
}

/** Claim only immutable runtime commands. Attempts fence delayed workers even
 * after lease takeover. Install/build/inspection jobs have other consumers. */
export async function claimRuntimeCommand(database: Database): Promise<RuntimeClaim | null> {
    return database.transaction(async tx => {
        const [event] = await tx.select({ id: appOutbox.id, jobId: appOutbox.jobId }).from(appOutbox)
            .innerJoin(appRuntimeCommands, eq(appRuntimeCommands.jobId, appOutbox.jobId))
            .innerJoin(appJobs, eq(appJobs.id, appOutbox.jobId))
            .where(and(isNull(appOutbox.deliveredAt), sql`${appOutbox.availableAt} <= clock_timestamp()`,
                sql`(${appOutbox.leaseUntil} is null or ${appOutbox.leaseUntil} <= clock_timestamp())`,
                sql`(${appJobs.status} in ('queued','running') or (${appJobs.status}='succeeded' and ${appRuntimeCommands.operation}='start'))`,
                sql`${appOutbox.attempts} < 2147483647`))
            .orderBy(asc(appOutbox.availableAt), asc(appOutbox.id)).limit(1).for('update', { of: appOutbox, skipLocked: true });
        if (!event) return null;
        const [claimed] = await tx.update(appOutbox).set({ leaseUntil: sql`clock_timestamp() + interval '45 seconds'`,
            attempts: sql`${appOutbox.attempts} + 1` }).where(eq(appOutbox.id, event.id)).returning();
        return { id: event.id, jobId: event.jobId, attempt: claimed!.attempts };
    });
}
const ownsLease = (claim: RuntimeClaim) => and(eq(appOutbox.id, claim.id), eq(appOutbox.jobId, claim.jobId),
    eq(appOutbox.attempts, claim.attempt), isNull(appOutbox.deliveredAt), sql`${appOutbox.leaseUntil} > clock_timestamp()`);

/** Cancellation alone would strand a runtime if a previous HTTP reply was
 * lost. Queue a Stop for current Start intent without forging a user receipt. */
async function recordStop(tx: Transaction, command: Command, userId: string, reason: string) {
    const [job] = await tx.insert(appJobs).values({ installationId: command.installationId, computerId: command.computerId,
        requestedBy: userId, operation: 'stop', idempotencyKey: `dispatcher-stop:${command.jobId}` }).returning();
    await tx.insert(appOutbox).values({ jobId: job!.id });
    await tx.insert(appRuntimeCommands).values({ ...command, jobId: job!.id, generation: command.generation + 1,
        operation: 'stop', createdAt: new Date() });
    await tx.insert(appAuditEvents).values({ appId: command.appId, releaseId: command.releaseId,
        installationId: command.installationId, computerId: command.computerId,
        action: 'installation.runtime-stop-requested', reasonCode: reason });
}
async function finish(tx: Transaction, claim: RuntimeClaim, status: 'succeeded' | 'cancelled', code: string | null) {
    const [event] = await tx.update(appOutbox).set({ deliveredAt: sql`clock_timestamp()`, leaseUntil: null })
        .where(ownsLease(claim)).returning({ id: appOutbox.id });
    if (!event) throw new Error('delivery_lease_lost');
    await tx.update(appJobs).set({ status, errorCode: code, completedAt: sql`clock_timestamp()` })
        .where(and(eq(appJobs.id, claim.jobId), inArray(appJobs.status, ['queued', 'running'])));
    return status;
}
async function defer(tx: Transaction, claim: RuntimeClaim, code: string | null) {
    const [event] = await tx.update(appOutbox).set({ availableAt: sql`clock_timestamp() + interval '5 seconds'`, leaseUntil: null })
        .where(ownsLease(claim)).returning({ id: appOutbox.id });
    if (!event) return 'stale' as const;
    await tx.update(appJobs).set({ status: sql`case when ${appJobs.status}='queued' then 'running' else ${appJobs.status} end`,
        errorCode: code, startedAt: sql`coalesce(${appJobs.startedAt}, clock_timestamp())` })
        .where(and(eq(appJobs.id, claim.jobId), inArray(appJobs.status, ['queued', 'running', 'succeeded'])));
    return 'waiting' as const;
}

/** No public endpoint/cron activates this consumer. Revalidate authority under
 * computer -> installation -> outbox locks. Host revisions fence old traffic. */
export async function dispatchRuntimeClaim(options: RuntimeDispatcherOptions, claim: RuntimeClaim): Promise<DispatchResult> {
    if (!options.enabled) return 'disabled';
    try {
        return await options.database.transaction(async tx => {
            const [command] = await tx.select().from(appRuntimeCommands).where(eq(appRuntimeCommands.jobId, claim.jobId)).limit(1);
            if (!command) return 'stale';
            const [computer] = await tx.select().from(computers).where(eq(computers.id, command.computerId)).limit(1).for('update');
            const [installation] = await tx.select().from(appInstallations).where(eq(appInstallations.id, command.installationId))
                .limit(1).for('update');
            const [event] = await tx.select().from(appOutbox).where(ownsLease(claim)).limit(1).for('update');
            if (!event) return 'stale';
            const [job] = await tx.select().from(appJobs).where(eq(appJobs.id, command.jobId)).limit(1).for('update');
            const [latest] = await tx.select().from(appRuntimeCommands).where(eq(appRuntimeCommands.installationId, command.installationId))
                .orderBy(desc(appRuntimeCommands.generation)).limit(1);
            if (!job || !['queued', 'running', 'succeeded'].includes(job.status) || latest?.jobId !== command.jobId) {
                return finish(tx, claim, 'cancelled', 'command_superseded');
            }
            const [runtime] = await tx.select().from(computerRuntimes).where(eq(computerRuntimes.computerId, command.computerId)).limit(1).for('share');
            const [writer] = await tx.select().from(computerInstances).where(and(eq(computerInstances.computerId, command.computerId),
                eq(computerInstances.generation, command.computerGeneration))).limit(1).for('share');
            if (!computer || !installation || !runtime || !writer) return defer(tx, claim, 'computer_not_prepared');
            if (writer.fencedAt) return finish(tx, claim, 'cancelled', 'writer_fenced');
            let plan = command.plan as unknown as RuntimePlan;
            if (command.operation === 'start') {
                const [stopping] = await tx.select({ id: computerLifecycleJobs.id }).from(computerLifecycleJobs)
                    .where(and(eq(computerLifecycleJobs.computerId, command.computerId),
                        inArray(computerLifecycleJobs.operation, ['stop', 'replace', 'retire', 'migrate']),
                        inArray(computerLifecycleJobs.status, ['queued', 'running']))).limit(1).for('share');
                const approved = computer.userId === job.requestedBy && !computer.deletedAt && computer.provider === 'aws-ec2'
                    && runtime.desiredState === 'running' && !stopping
                    ? await currentStartPlan(tx, command, installation, computer.userId, options.osAccessMode) : null;
                if (!approved) {
                    await recordStop(tx, command, job.requestedBy, 'authority_changed');
                    return finish(tx, claim, 'cancelled', 'authority_changed');
                }
                plan = approved;
            }
            // This evidence is from the provider controller. No host call or
            // computer start is needed to stop an already observed stopped VM.
            if (command.operation === 'stop' && writer.observedState === 'stopped' && writer.observedAt) {
                return finish(tx, claim, 'succeeded', null);
            }
            if (writer.observedState !== 'running' || !writer.providerInstanceId || !runtime.dataVolumeId) {
                return defer(tx, claim, 'computer_not_running');
            }
            const scope: HostScope = { computerId: computer.id, computerGeneration: writer.generation,
                providerInstanceId: writer.providerInstanceId, dataVolumeId: runtime.dataVolumeId, fenceToken: writer.fenceToken };
            const client = await resolveBounded(options, scope);
            if (!sameRuntimePlan(scope, client.scope)) throw new HostControlError('host_rejected');
            // Two HTTP calls have an 8s deadline each; require remaining time
            // before sending. The database clock, not worker time, owns leases.
            const [fresh] = await tx.select({ id: appOutbox.id }).from(appOutbox)
                .where(and(ownsLease(claim), sql`${appOutbox.leaseUntil} > clock_timestamp() + interval '20 seconds'`));
            if (!fresh) return defer(tx, claim, 'delivery_lease_short');
            const request: HostCommand = { schemaVersion: 1, requestId: command.jobId, computerId: command.computerId,
                computerGeneration: command.computerGeneration, installationId: command.installationId,
                operation: 'reconcile', generation: command.generation, desired: command.operation === 'start' ? 'running' : 'stopped', plan };
            const observed = await client.observe(command.installationId);
            if (observed && observed.generation >= command.generation) {
                if (observed.computerId !== command.computerId || observed.computerGeneration !== command.computerGeneration
                    || observed.installationId !== command.installationId || observed.generation !== command.generation
                    || observed.desired !== request.desired || observed.intentDigest !== hostIntentDigest(request)) {
                    throw new HostControlError('host_response_invalid');
                }
                if (command.operation === 'start' && observed.runtimeDeadlineMs !== null && observed.runtimeDeadlineMs <= Date.now()) {
                    await recordStop(tx, command, job.requestedBy, 'runtime_expired');
                    return finish(tx, claim, 'cancelled', 'runtime_expired');
                }
                if (observed.settled && observed.state === request.desired) {
                    if (command.operation === 'stop') return finish(tx, claim, 'succeeded', null);
                    if (observed.runtimeDeadlineMs === null) throw new HostControlError('host_response_invalid');
                    // Keep independently observing active Start intent after
                    // initial success. Otherwise expiry/revocation would never
                    // be reconciled once its delivery event was acknowledged.
                    const [renewed] = await tx.update(appOutbox).set({ leaseUntil: null,
                        availableAt: sql`clock_timestamp() + interval '30 seconds'` }).where(ownsLease(claim)).returning();
                    if (!renewed) throw new Error('delivery_lease_lost');
                    await tx.update(appJobs).set({ status: 'succeeded', errorCode: null,
                        startedAt: sql`coalesce(${appJobs.startedAt}, clock_timestamp())`,
                        completedAt: sql`coalesce(${appJobs.completedAt}, clock_timestamp())` }).where(eq(appJobs.id, claim.jobId));
                    return 'succeeded';
                }
            }
            // HTTP 202 is a receipt. Only a later matching observation can
            // succeed. Same-generation replay never extends the host deadline.
            await client.reconcile(request);
            return defer(tx, claim, null);
        });
    } catch (error) {
        const code = error instanceof HostControlError ? error.code : 'runtime_dispatch_failed';
        try { return await options.database.transaction(tx => defer(tx, claim, code)); }
        catch { throw new Error('runtime_dispatch_unavailable'); }
    }
}
export async function dispatchNextRuntimeCommand(options: RuntimeDispatcherOptions): Promise<DispatchResult> {
    if (!options.enabled) return 'disabled';
    try {
        const claim = await claimRuntimeCommand(options.database);
        return claim ? await dispatchRuntimeClaim(options, claim) : 'empty';
    } catch { throw new Error('runtime_dispatch_unavailable'); }
}
