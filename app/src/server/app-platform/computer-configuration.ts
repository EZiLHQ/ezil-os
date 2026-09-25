import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { db } from '@/server/db';
import { appInstallations, appJobs, appOutbox, appRuntimeCommands, computerConfigurations,
    computerConfigurationDeliveries, computerConfigurationInstallations, computerInstances,
    computerLifecycleJobs, computerRuntimes, computers } from '@/server/db/schema';
import { compilePreparedInstallation, RuntimePlanError, sameRuntimePlan,
    type PreparedInstallation, type RuntimePlan } from './runtime-plan';
import { currentInstallationRelease, currentStartPlan, hasCurrentOsAccess, type OsAccessMode } from './runtime-authority';
import { ApprovedComputerAppPolicyV2Schema } from './approved-computer-app-policy';

/** Provisioning must install this fixed layout; no publisher/browser selects
 * host paths, listener ports, writer identity, or the app memory reservation. */
export const COMPUTER_HOST_LAYOUT = Object.freeze({ dataRoot: '/srv/ezil-data',
    stateDirectory: '/var/lib/ezil-supervisor', stagingRoot: '/run/ezil-supervisor/mounts',
    controlPort: 8181, memoryBudgetMiB: 3072 });
export interface ComputerConfiguration {
    schemaVersion: 1; configurationRevision: number; computerId: string; computerGeneration: number;
    volumeId: string; dataRoot: string; stateDirectory: string; stagingRoot: string; controlPort: number;
    memoryBudgetMiB: number; suspended: boolean; preparedInstallations: PreparedInstallation[];
    approvedInstallations: { installationId: string; plan: RuntimePlan }[];
}
/** Matches supervisor/control-protocol canonicalJson, including bytewise key
 * sorting (localeCompare is not the host's ordering) and all explicit defaults. */
export function canonicalConfiguration(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map(canonicalConfiguration).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
        .map(([key, item]) => `${JSON.stringify(key)}:${canonicalConfiguration(item)}`).join(',')}}`;
    return JSON.stringify(value);
}
type Binding = Pick<typeof computerConfigurationInstallations.$inferInsert,
    'computerId' | 'installationId' | 'appId' | 'releaseId' | 'authGeneration' | 'installJobId' | 'runtimeJobId'>;
export interface ConfigurationProducerOptions {
    database: typeof db;
    /** Internal worker settings only. No public handler or scheduled producer
     * is enabled by this module. A disabled call performs no database access. */
    enabled: boolean;
    osAccessMode: OsAccessMode;
}
export type ConfigurationResult = { state: 'disabled' | 'unavailable' }
    | { state: 'created' | 'reused'; configurationId: string; revision: number; digest: string };

/** Compile a full computer snapshot, never an installation-sized replacement.
 * This records desired configuration only: it does not transfer files, prepare
 * a host, start compute, acknowledge delivery, or complete an installation job.
 * Delivery must recheck authority; historical snapshots are not credentials. */
export async function produceComputerConfiguration(options: ConfigurationProducerOptions, computerId: string): Promise<ConfigurationResult> {
    if (!options.enabled) return { state: 'disabled' };
    try {
        return await options.database.transaction(async tx => {
            // Computer lock serializes revisions with install, launch, stop and
            // replacement. Other authority rows stay locked through commit.
            const [computer] = await tx.select().from(computers).where(eq(computers.id, computerId)).limit(1).for('update');
            if (!computer || computer.provider !== 'aws-ec2' || computer.deletedAt) return { state: 'unavailable' };
            const [runtime] = await tx.select().from(computerRuntimes).where(eq(computerRuntimes.computerId, computerId)).limit(1).for('share');
            const [writer] = await tx.select().from(computerInstances).where(and(eq(computerInstances.computerId, computerId),
                isNull(computerInstances.fencedAt))).limit(1).for('share');
            if (!runtime?.dataVolumeId || !writer?.providerInstanceId || runtime.region !== 'us-east-1'
                || !/^us-east-1[a-z]$/.test(runtime.availabilityZone ?? '')
                || !/^vol-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(runtime.dataVolumeId)
                || !/^i-(?:[a-f0-9]{8}|[a-f0-9]{17})$/.test(writer.providerInstanceId)) return { state: 'unavailable' };
            const [stopping] = await tx.select({ id: computerLifecycleJobs.id }).from(computerLifecycleJobs)
                .where(and(eq(computerLifecycleJobs.computerId, computerId),
                    inArray(computerLifecycleJobs.operation, ['stop', 'replace', 'retire', 'migrate']),
                    inArray(computerLifecycleJobs.status, ['queued', 'running']))).limit(1).for('share');
            const authorized = await hasCurrentOsAccess(tx, computer.userId, options.osAccessMode);
            const config: ComputerConfiguration = { schemaVersion: 1, configurationRevision: 1, computerId,
                computerGeneration: writer.generation, volumeId: runtime.dataVolumeId, ...COMPUTER_HOST_LAYOUT,
                suspended: !authorized || runtime.desiredState !== 'running' || Boolean(stopping),
                preparedInstallations: [], approvedInstallations: [] };
            const bindings: Binding[] = [];
            let runningLimit = 2;
            if (!config.suspended) {
                const installations = await tx.select().from(appInstallations).where(and(eq(appInstallations.computerId, computerId),
                    isNull(appInstallations.uninstalledAt), inArray(appInstallations.status, ['pending', 'installed'])))
                    .orderBy(asc(appInstallations.id)).limit(129).for('update');
                // A suspended empty snapshot removes old authority even when
                // corrupted/excess records cannot fit the bounded host format.
                if (installations.length > 128) config.suspended = true;
                else for (const installation of installations) {
                    if (installation.installedBy !== computer.userId) continue;
                    const authority = await currentInstallationRelease(tx, installation, computer.userId);
                    if (!authority) continue;
                    let prepared: PreparedInstallation;
                    try { prepared = compilePreparedInstallation({ installationId: installation.id, ...authority }); }
                    catch (error) { if (error instanceof RuntimePlanError) continue; throw error; }
                    // Retain the exact successful job binding as well, so an
                    // acknowledged install does not cause a needless revision.
                    const [installJob] = await tx.select({ job: appJobs }).from(appJobs)
                        .innerJoin(appOutbox, eq(appOutbox.jobId, appJobs.id))
                        .where(and(eq(appJobs.installationId, installation.id), eq(appJobs.computerId, computerId),
                            eq(appJobs.operation, 'install'), eq(appJobs.requestedBy, computer.userId),
                            inArray(appJobs.status, installation.status === 'pending' ? ['queued', 'running'] : ['queued', 'running', 'succeeded'])))
                        .orderBy(desc(appJobs.createdAt), desc(appJobs.id)).limit(1).for('share', { of: appJobs });
                    if (installation.status === 'pending' && !installJob) continue;
                    const binding: Binding = { computerId, installationId: installation.id, appId: installation.appId,
                        releaseId: installation.releaseId, authGeneration: installation.authGeneration,
                        installJobId: installJob?.job.id ?? null, runtimeJobId: null };
                    config.preparedInstallations.push(prepared); bindings.push(binding);
                    if (config.suspended || writer.observedState !== 'running' || !writer.observedAt) continue;
                    const [command] = await tx.select().from(appRuntimeCommands)
                        .where(eq(appRuntimeCommands.installationId, installation.id))
                        .orderBy(desc(appRuntimeCommands.generation)).limit(1);
                    if (!command || command.operation !== 'start' || command.computerGeneration !== writer.generation) continue;
                    const [job] = await tx.select().from(appJobs).where(and(eq(appJobs.id, command.jobId),
                        eq(appJobs.requestedBy, computer.userId), inArray(appJobs.status, ['queued', 'running', 'succeeded'])))
                        .limit(1).for('share');
                    if (!job) continue;
                    const plan = await currentStartPlan(tx, command, installation, computer.userId, options.osAccessMode);
                    if (plan) {
                        runningLimit = Math.min(runningLimit, ApprovedComputerAppPolicyV2Schema.parse(authority.release.policy).quotas.runningAppsPerComputer);
                        config.approvedInstallations.push({ installationId: installation.id, plan }); binding.runtimeJobId = job.id;
                    }
                }
            }
            // The host reserves built-in capacity separately. Excess execution
            // authority is removed as a whole; never choose a silent winner.
            if (config.approvedInstallations.length > runningLimit
                || config.approvedInstallations.reduce((sum, item) => sum + item.plan.resources.memoryMiB, 0) > config.memoryBudgetMiB) {
                config.suspended = true;
            }
            // Reserve nine extra digits for the maximum revision. Normalize
            // oversized state before reuse comparison to avoid revision churn.
            if (Buffer.byteLength(canonicalConfiguration(config)) + 9 > 262144) config.suspended = true;
            if (config.suspended) {
                config.preparedInstallations = []; config.approvedInstallations = []; bindings.length = 0;
            }
            // Suspension is empty: a host skips image/disk preparation while
            // suspended, so this receipt must never complete an install job.
            const [latest] = await tx.select().from(computerConfigurations).where(eq(computerConfigurations.computerId, computerId))
                .orderBy(desc(computerConfigurations.revision)).limit(1);
            if (latest) {
                config.configurationRevision = latest.revision;
                const [delivery] = await tx.select().from(computerConfigurationDeliveries)
                    .where(eq(computerConfigurationDeliveries.configurationId, latest.id)).limit(1).for('update');
                const previous = await tx.select({ computerId: computerConfigurationInstallations.computerId,
                    installationId: computerConfigurationInstallations.installationId, appId: computerConfigurationInstallations.appId,
                    releaseId: computerConfigurationInstallations.releaseId, authGeneration: computerConfigurationInstallations.authGeneration,
                    installJobId: computerConfigurationInstallations.installJobId, runtimeJobId: computerConfigurationInstallations.runtimeJobId })
                    .from(computerConfigurationInstallations).where(eq(computerConfigurationInstallations.configurationId, latest.id))
                    .orderBy(asc(computerConfigurationInstallations.installationId));
                if (delivery && !delivery.supersededAt && latest.providerInstanceId === writer.providerInstanceId
                    && latest.fenceToken === writer.fenceToken && latest.configuration === canonicalConfiguration(config)
                    && sameRuntimePlan(previous, bindings)) {
                    return { state: 'reused', configurationId: latest.id, revision: latest.revision, digest: latest.digest };
                }
                config.configurationRevision++;
            }
            if (config.configurationRevision > 2_147_483_647) throw new Error('configuration_revision_exhausted');
            const configuration = canonicalConfiguration(config);
            const [snapshot] = await tx.insert(computerConfigurations).values({ computerId, computerGeneration: writer.generation,
                revision: config.configurationRevision, providerInstanceId: writer.providerInstanceId, fenceToken: writer.fenceToken,
                dataVolumeId: runtime.dataVolumeId, configuration }).returning();
            if (!snapshot) throw new Error('configuration_insert_failed');
            if (bindings.length) await tx.insert(computerConfigurationInstallations).values(bindings.map(binding => ({ ...binding, configurationId: snapshot.id })));
            await tx.insert(computerConfigurationDeliveries).values({ configurationId: snapshot.id });
            // Supersede pending older attempts, preserving all loaded receipts.
            await tx.update(computerConfigurationDeliveries).set({ supersededAt: sql`clock_timestamp()`, leaseUntil: null })
                .where(and(isNull(computerConfigurationDeliveries.loadedAt), isNull(computerConfigurationDeliveries.supersededAt),
                    sql`${computerConfigurationDeliveries.configurationId} in (select id from ${computerConfigurations}
                        where computer_id=${computerId} and revision < ${snapshot.revision})`));
            return { state: 'created', configurationId: snapshot.id, revision: snapshot.revision, digest: snapshot.digest };
        });
    } catch { throw new Error('computer_configuration_unavailable'); }
}
