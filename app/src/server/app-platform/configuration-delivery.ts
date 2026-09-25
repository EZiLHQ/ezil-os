import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { appAuditEvents, appInstallations, appJobs, appOutbox, computerConfigurations,
    computerConfigurationDeliveries, computerConfigurationInstallations, computerInstances, computers } from '@/server/db/schema';
import { produceComputerConfigurationInTransaction, type ConfigurationProducerOptions } from './computer-configuration';
import { HostControlError, HostConfigurationObservationSchema, type HostConfigurationObservation,
    type HostControlClient, type HostScope } from './host-control-client';
import { sameRuntimePlan } from './runtime-plan';

type Transaction = Parameters<Parameters<ConfigurationProducerOptions['database']['transaction']>[0]>[0];
export interface ConfigurationClaim { computerId: string; configurationId: string; attempt: number }
export interface ConfigurationWork {
    readonly configurationId: string; readonly scope: HostScope; readonly revision: number;
    readonly digest: string; readonly configuration: string;
}
const preparationSchema = z.discriminatedUnion('state', [z.object({ state: z.literal('pending') }).strict(),
    z.object({ state: z.literal('prepared'), descriptor: HostConfigurationObservationSchema }).strict()]);
export interface ConfigurationDeliveryOptions extends ConfigurationProducerOptions {
    /** Trusted durable provisioning only. configurationId is the stable
     * idempotency key across polls and lease takeovers; attempts are NOT new
     * provider jobs. Return pending quickly while transfer/pull runs elsewhere.
     * This operation must not start compute, run apps, or select caller paths. */
    advancePreparation(work: ConfigurationWork, signal: AbortSignal): Promise<unknown>;
    /** Reload the provisioned host's protected file. A successful request is
     * not a loaded receipt. No service start/VM wake is permitted here. */
    requestReload(work: ConfigurationWork, signal: AbortSignal): Promise<void>;
    resolveHost(scope: HostScope, signal: AbortSignal): Promise<HostControlClient>;
}
export type ConfigurationDeliveryResult = 'disabled' | 'empty' | 'stale' | 'waiting' | 'loaded';
type CurrentWork = { work: ConfigurationWork; prepared: boolean };
const ownsLease = (claim: ConfigurationClaim) => and(
    eq(computerConfigurationDeliveries.configurationId, claim.configurationId),
    eq(computerConfigurationDeliveries.attempts, claim.attempt),
    isNull(computerConfigurationDeliveries.loadedAt), isNull(computerConfigurationDeliveries.supersededAt),
    sql`${computerConfigurationDeliveries.leaseUntil} > clock_timestamp()`);
const due = () => and(isNull(computerConfigurationDeliveries.loadedAt), isNull(computerConfigurationDeliveries.supersededAt),
    sql`${computerConfigurationDeliveries.availableAt} <= clock_timestamp()`,
    sql`(${computerConfigurationDeliveries.leaseUntil} is null or ${computerConfigurationDeliveries.leaseUntil} <= clock_timestamp())`,
    sql`${computerConfigurationDeliveries.attempts} < 2147483647`);

/** Lock computers before delivery rows: the SQL delivery trigger also locks
 * the computer. Reversing that order can deadlock with snapshot production. */
export async function claimConfigurationDelivery(options: ConfigurationProducerOptions): Promise<ConfigurationClaim | null> {
    if (!options.enabled) return null;
    try {
        return await options.database.transaction(async tx => {
            const [candidate] = await tx.select({ computerId: computers.id }).from(computers)
                .innerJoin(computerConfigurations, eq(computerConfigurations.computerId, computers.id))
                .innerJoin(computerConfigurationDeliveries, eq(computerConfigurationDeliveries.configurationId, computerConfigurations.id))
                .where(due()).orderBy(asc(computerConfigurationDeliveries.availableAt), asc(computerConfigurations.id))
                .limit(1).for('update', { of: computers, skipLocked: true });
            if (!candidate) return null;
            const current = await produceComputerConfigurationInTransaction(tx, candidate.computerId, options.osAccessMode);
            if (!('configurationId' in current)) {
                await tx.update(computerConfigurationDeliveries).set({ supersededAt: sql`clock_timestamp()`, leaseUntil: null })
                    .where(and(isNull(computerConfigurationDeliveries.loadedAt), isNull(computerConfigurationDeliveries.supersededAt),
                        sql`${computerConfigurationDeliveries.configurationId} in (select id from ${computerConfigurations}
                            where computer_id=${candidate.computerId})`));
                return null;
            }
            const [claimed] = await tx.update(computerConfigurationDeliveries)
                .set({ leaseUntil: sql`clock_timestamp() + interval '45 seconds'`, attempts: sql`${computerConfigurationDeliveries.attempts} + 1` })
                .where(and(eq(computerConfigurationDeliveries.configurationId, current.configurationId), due())).returning();
            return claimed ? { computerId: candidate.computerId, configurationId: current.configurationId, attempt: claimed.attempts } : null;
        });
    } catch { throw new Error('configuration_delivery_unavailable'); }
}

async function boundJobs(tx: Transaction, claim: ConfigurationClaim) {
    return tx.select({ binding: computerConfigurationInstallations, job: appJobs }).from(computerConfigurationInstallations)
        .innerJoin(appJobs, eq(appJobs.id, computerConfigurationInstallations.installJobId))
        .where(and(eq(computerConfigurationInstallations.configurationId, claim.configurationId),
            eq(computerConfigurationInstallations.computerId, claim.computerId)))
        .orderBy(asc(appJobs.id)).for('update', { of: appJobs });
}
async function defer(tx: Transaction, claim: ConfigurationClaim, errorCode: string | null, started = false): Promise<'waiting' | 'stale'> {
    const [delivery] = await tx.update(computerConfigurationDeliveries).set({ leaseUntil: null,
        availableAt: sql`clock_timestamp() + interval '5 seconds'`, errorCode }).where(ownsLease(claim)).returning();
    if (!delivery) return 'stale';
    for (const { job } of await boundJobs(tx, claim)) {
        await tx.update(appJobs).set({ errorCode, ...(started && job.status === 'queued' ? { status: 'running' as const,
            startedAt: sql`coalesce(${appJobs.startedAt}, clock_timestamp())` } : {}) }).where(and(eq(appJobs.id, job.id), inArray(appJobs.status, ['queued', 'running'])));
    }
    return 'waiting';
}
/** Refreshing through the producer rechecks identity, owner OS access, grants,
 * release, commands, selected projects and quotas, with locks held to commit.
 * A change creates a newer snapshot instead of acknowledging historical rights. */
async function currentWork(tx: Transaction, options: ConfigurationProducerOptions, claim: ConfigurationClaim): Promise<CurrentWork | 'waiting' | 'stale'> {
    const [computer] = await tx.select({ id: computers.id }).from(computers).where(eq(computers.id, claim.computerId)).limit(1).for('update');
    if (!computer) return 'stale';
    const [target] = await tx.select().from(computerConfigurations).where(and(eq(computerConfigurations.id, claim.configurationId),
        eq(computerConfigurations.computerId, computer.id))).limit(1);
    if (!target) return 'stale';
    const [delivery] = await tx.select().from(computerConfigurationDeliveries).where(ownsLease(claim)).limit(1);
    if (!delivery) return 'stale';
    const current = await produceComputerConfigurationInTransaction(tx, computer.id, options.osAccessMode);
    if (!('configurationId' in current) || current.configurationId !== claim.configurationId) {
        await tx.update(computerConfigurationDeliveries).set({ supersededAt: sql`clock_timestamp()`, leaseUntil: null })
            .where(ownsLease(claim));
        return 'stale';
    }
    const [writer] = await tx.select().from(computerInstances).where(and(eq(computerInstances.computerId, computer.id),
        eq(computerInstances.generation, target.computerGeneration))).limit(1).for('share');
    if (!writer || writer.observedState !== 'running' || !writer.observedAt) return defer(tx, claim, 'computer_not_running');
    const [fresh] = await tx.select({ id: computerConfigurationDeliveries.configurationId }).from(computerConfigurationDeliveries)
        .where(and(ownsLease(claim), sql`${computerConfigurationDeliveries.leaseUntil} > clock_timestamp() + interval '12 seconds'`));
    if (!fresh) return defer(tx, claim, 'configuration_lease_short');
    return { prepared: delivery.preparedAt !== null, work: Object.freeze({ configurationId: target.id,
        scope: Object.freeze({ computerId: target.computerId, computerGeneration: target.computerGeneration,
            providerInstanceId: target.providerInstanceId, dataVolumeId: target.dataVolumeId, fenceToken: target.fenceToken }),
        revision: target.revision, digest: target.digest, configuration: target.configuration }) };
}
const descriptorMatches = (work: ConfigurationWork, descriptor: HostConfigurationObservation) =>
    descriptor.computerId === work.scope.computerId && descriptor.computerGeneration === work.scope.computerGeneration
    && descriptor.configurationRevision === work.revision && descriptor.configurationDigest === work.digest;
async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, milliseconds = 10000): Promise<T> {
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([operation(controller.signal), new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => { reject(new Error('configuration_transport_timeout')); controller.abort(); }, milliseconds);
        })]);
    } finally { clearTimeout(timer); }
}

/** The only completion path: exact authenticated loaded descriptor, current
 * authority and live lease, followed by one atomic receipt/install/job/audit
 * transaction. Preparation and reload requests alone never reach this path. */
async function acknowledge(options: ConfigurationDeliveryOptions, claim: ConfigurationClaim, descriptor: HostConfigurationObservation) {
    return options.database.transaction(async tx => {
        const current = await currentWork(tx, options, claim);
        if (typeof current === 'string') return current;
        if (!current.prepared || !descriptorMatches(current.work, descriptor)) throw new HostControlError('host_response_invalid');
        const [loaded] = await tx.update(computerConfigurationDeliveries)
            .set({ loadedAt: sql`clock_timestamp()`, loadedDigest: current.work.digest, leaseUntil: null, errorCode: null })
            .where(ownsLease(claim)).returning();
        if (!loaded) return 'stale';
        for (const { binding, job } of await boundJobs(tx, claim)) {
            if (job.status === 'succeeded') continue;
            if (!['queued', 'running'].includes(job.status)) throw new Error('installation_job_changed');
            const [installation] = await tx.update(appInstallations).set({ status: 'installed',
                installedAt: sql`coalesce(${appInstallations.installedAt}, clock_timestamp())` })
                .where(and(eq(appInstallations.id, binding.installationId), eq(appInstallations.computerId, claim.computerId),
                    eq(appInstallations.releaseId, binding.releaseId), eq(appInstallations.authGeneration, binding.authGeneration),
                    isNull(appInstallations.uninstalledAt), inArray(appInstallations.status, ['pending', 'installed']))).returning();
            if (!installation) throw new Error('installation_authority_changed');
            await tx.update(appJobs).set({ status: 'succeeded', errorCode: null,
                startedAt: sql`coalesce(${appJobs.startedAt}, clock_timestamp())`, completedAt: sql`clock_timestamp()` }).where(eq(appJobs.id, job.id));
            const [event] = await tx.update(appOutbox).set({ deliveredAt: sql`clock_timestamp()`, leaseUntil: null })
                .where(and(eq(appOutbox.jobId, job.id), isNull(appOutbox.deliveredAt))).returning();
            if (!event) throw new Error('installation_outbox_changed');
            await tx.insert(appAuditEvents).values({ action: 'installation.installed', reasonCode: 'host_configuration_loaded',
                appId: binding.appId, releaseId: binding.releaseId, installationId: binding.installationId, computerId: claim.computerId });
        }
        return 'loaded' as const;
    });
}

/** No public endpoint or cron enables this consumer. Long provisioning runs
 * outside transactions. Every phase and final result is fenced by current
 * database authority and this claim's attempt; status queries never call it. */
export async function dispatchConfigurationClaim(options: ConfigurationDeliveryOptions, claim: ConfigurationClaim): Promise<ConfigurationDeliveryResult> {
    if (!options.enabled) return 'disabled';
    const refresh = () => options.database.transaction(tx => currentWork(tx, options, claim));
    const wait = (errorCode: string | null = null, started = false) => options.database.transaction(async tx => {
        const current = await currentWork(tx, options, claim);
        return typeof current === 'string' ? current : defer(tx, claim, errorCode, started);
    });
    try {
        let current = await refresh(); if (typeof current === 'string') return current;
        if (!current.prepared) {
            const work = current.work;
            const result = preparationSchema.safeParse(await bounded(signal => options.advancePreparation(work, signal)));
            if (!result.success) throw new Error('configuration_preparation_invalid');
            if (result.data.state === 'pending') return await wait(null, true);
            const descriptor = result.data.descriptor;
            if (!descriptorMatches(work, descriptor)) throw new HostControlError('host_response_invalid');
            const recorded = await options.database.transaction(async tx => {
                const fresh = await currentWork(tx, options, claim);
                if (typeof fresh === 'string') return fresh;
                if (!descriptorMatches(fresh.work, descriptor)) {
                    throw new HostControlError('host_response_invalid');
                }
                const [event] = await tx.update(computerConfigurationDeliveries)
                    .set({ preparedAt: sql`coalesce(${computerConfigurationDeliveries.preparedAt}, clock_timestamp())`, errorCode: null })
                    .where(ownsLease(claim)).returning();
                if (!event) return 'stale' as const;
                for (const { job } of await boundJobs(tx, claim)) {
                    await tx.update(appJobs).set({ status: 'running', errorCode: null,
                        startedAt: sql`coalesce(${appJobs.startedAt}, clock_timestamp())` })
                        .where(and(eq(appJobs.id, job.id), eq(appJobs.status, 'queued')));
                }
                return fresh;
            });
            if (typeof recorded === 'string') return recorded;
            current = await refresh(); if (typeof current === 'string') return current;
            await bounded(signal => options.requestReload(work, signal));
            // A reload receipt is not enough. Read the loaded descriptor on a
            // later delivery poll, after service management has applied it.
            return await wait();
        }
        const work = current.work;
        const host = await bounded(signal => options.resolveHost(work.scope, signal), 5000);
        if (!sameRuntimePlan(host.scope, work.scope)) throw new HostControlError('host_rejected');
        current = await refresh(); if (typeof current === 'string') return current;
        const parsed = HostConfigurationObservationSchema.safeParse(await bounded(() => host.configuration()));
        if (!parsed.success) throw new HostControlError('host_response_invalid');
        if (descriptorMatches(work, parsed.data)) return await acknowledge(options, claim, parsed.data);
        if (parsed.data.computerId !== work.scope.computerId || parsed.data.computerGeneration !== work.scope.computerGeneration
            || parsed.data.configurationRevision >= work.revision) throw new HostControlError('host_response_invalid');
        current = await refresh(); if (typeof current === 'string') return current;
        await bounded(signal => options.requestReload(work, signal));
        return await wait();
    } catch (error) {
        const code = error instanceof HostControlError ? error.code : 'configuration_delivery_failed';
        try { return await wait(code); } catch { throw new Error('configuration_delivery_unavailable'); }
    }
}
export async function dispatchNextConfiguration(options: ConfigurationDeliveryOptions): Promise<ConfigurationDeliveryResult> {
    if (!options.enabled) return 'disabled';
    try {
        const claim = await claimConfigurationDelivery(options);
        return claim ? await dispatchConfigurationClaim(options, claim) : 'empty';
    } catch { throw new Error('configuration_delivery_unavailable'); }
}
