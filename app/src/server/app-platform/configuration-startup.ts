import { and, desc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import { computerConfigurations, computerConfigurationDeliveries, computerDataMountAuthorizations as mounts,
    computerDataMountDeliveries as mountDeliveries, computerLifecycleJobs,
    computerStartAuthorizations as grants, computerStartDeliveries as starts, computerControlBindings as bindings } from '@/server/db/schema';
import { canonicalConfiguration, produceComputerConfigurationInTransaction, type ConfigurationProducerOptions } from './computer-configuration';
import { configurationMountConfirmed } from './configuration-mount';
import type { ConfigurationWork } from './configuration-delivery';
import { issueComputerStart } from './computer-start-issuer';
import { claimComputerStart, dispatchComputerStartClaim, type ComputerStartDeliveryOptions } from './computer-start-delivery';
import { ComputerControlKeyPolicySchema, type ComputerControlKeys } from './computer-control-key';
import type { LifecycleConsumerOptions } from './lifecycle-consumer';

export type ConfigurationStartupTransport = Pick<LifecycleConsumerOptions, 'deployments' | 'advance'>
    & Pick<ComputerStartDeliveryOptions, 'advanceStart'> & { keys: ComputerControlKeys };
type Options = ConfigurationProducerOptions & ConfigurationStartupTransport & { signal: AbortSignal };
export type ConfigurationStartupResult = 'observe' | 'waiting' | 'denied' | 'recovery_required';

type Transaction = Parameters<Parameters<ConfigurationProducerOptions['database']['transaction']>[0]>[0];
async function loadStartup(tx: Transaction, o: ConfigurationProducerOptions, work: ConfigurationWork,
    policy: ComputerControlKeys['policy']) {
    const current = await produceComputerConfigurationInTransaction(tx, work.scope.computerId, o.osAccessMode);
    if (!('configurationId' in current) || current.configurationId !== work.configurationId) return null;
    const [target] = await tx.select().from(computerConfigurations).where(eq(computerConfigurations.id, work.configurationId)).limit(1);
    const [delivery] = await tx.select().from(computerConfigurationDeliveries).where(eq(computerConfigurationDeliveries.configurationId, work.configurationId)).limit(1);
    if (!target || !delivery?.preparedAt || delivery.supersededAt || JSON.parse(target.configuration).suspended !== false
        || canonicalConfiguration({ configurationId: target.id, revision: target.revision, digest: target.digest, configuration: target.configuration,
            scope: { computerId: target.computerId, computerGeneration: target.computerGeneration, providerInstanceId: target.providerInstanceId,
                dataVolumeId: target.dataVolumeId, fenceToken: target.fenceToken } }) !== canonicalConfiguration(work)
        || !await configurationMountConfirmed(tx, target)) return null;
    const [mount] = await tx.select({ id: mounts.id }).from(mounts)
        .innerJoin(mountDeliveries, eq(mountDeliveries.authorizationId, mounts.id))
        .innerJoin(computerLifecycleJobs, eq(computerLifecycleJobs.id, mounts.lifecycleJobId))
        .where(and(eq(mounts.computerId, target.computerId), eq(mounts.computerGeneration, target.computerGeneration),
            eq(mounts.providerInstanceId, target.providerInstanceId), eq(mounts.fenceToken, target.fenceToken),
            eq(mounts.dataVolumeId, target.dataVolumeId), isNull(mounts.revokedAt), isNotNull(mountDeliveries.mountedAt)))
        .orderBy(desc(computerLifecycleJobs.createdAt), desc(mounts.id)).limit(1);
    if (!mount) return null;
    const [start] = await tx.select({ id: grants.id, configurationId: grants.configurationId, startedAt: starts.startedAt,
        active: sql<boolean>`${grants.expiresAt}>clock_timestamp()` }).from(grants)
        .innerJoin(starts, eq(starts.authorizationId, grants.id))
        .innerJoin(bindings, eq(bindings.id, grants.controlBindingId))
        .where(and(eq(grants.computerId, target.computerId), eq(grants.computerGeneration, target.computerGeneration),
            eq(grants.mountAuthorizationId, mount.id), isNull(grants.revokedAt), isNull(bindings.revokedAt),
            eq(bindings.accountId, policy.accountId), eq(bindings.region, policy.region), eq(bindings.namespace, policy.namespace),
            eq(bindings.controlDomain, policy.controlDomain), eq(bindings.kmsKeyArn, policy.kmsKeyArn))).limit(1).for('share', { of: [grants, bindings] });
    return { mountAuthorizationId: mount.id, start };
}
/** Recheck under the acknowledgement transaction's computer/grant locks;
 * revocation or a new mount during a host request invalidates its old receipt. */
export async function configurationStartupConfirmed(tx: Transaction,
    o: ConfigurationProducerOptions & ConfigurationStartupTransport, work: ConfigurationWork) {
    if (!o.enabled) return false;
    const p = ComputerControlKeyPolicySchema.safeParse(o.keys.policy); if (!p.success) return false;
    return !!(await loadStartup(tx, o, work, p.data))?.start?.startedAt;
}

/** A prepared configuration drives the existing startup outbox, never a new
 * provider job. Startup receipt is historical: observe still requires the
 * authenticated host descriptor before installation acknowledgement. */
export async function advanceConfigurationStartup(o: Options, work: ConfigurationWork): Promise<ConfigurationStartupResult> {
    if (!o.enabled || o.signal.aborted) return 'denied';
    const policy = ComputerControlKeyPolicySchema.safeParse(o.keys.policy); if (!policy.success) return 'denied';
    const candidate = await o.database.transaction(tx => loadStartup(tx, o, work, policy.data));
    if (!candidate || !o.enabled || o.signal.aborted) return 'denied';
    // The completed startup can outlive its grant and load newer configurations.
    // A later mount/lifecycle cycle cannot reuse this receipt. An unreachable
    // previously started host is never restarted here as an error fallback.
    if (candidate.start?.startedAt) return 'observe';
    if (candidate.start && !candidate.start.active) return 'recovery_required';
    if (!candidate.start) {
        const result = await issueComputerStart(o, { computerId: work.scope.computerId,
            configurationId: work.configurationId, mountAuthorizationId: candidate.mountAuthorizationId });
        return result.state === 'issued' || result.state === 'unconfirmed' ? 'waiting'
            : result.state === 'recovery_required' ? 'recovery_required' : 'denied';
    }
    if (candidate.start.configurationId !== work.configurationId) return 'recovery_required';
    const claim = await claimComputerStart(o, { computerId: work.scope.computerId, authorizationId: candidate.start.id });
    if (!claim) return 'waiting';
    // Issuance and dispatch occur in separate polls, each with its own bounds.
    // Even a started receipt waits for a later authenticated host observation.
    await dispatchComputerStartClaim(o, claim);
    return 'waiting';
}
