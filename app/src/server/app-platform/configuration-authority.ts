import { and, eq, isNull, sql } from 'drizzle-orm';
import { computers, computerConfigurations, computerConfigurationDeliveries, computerInstances } from '@/server/db/schema';
import { produceComputerConfigurationInTransaction, type ConfigurationProducerOptions } from './computer-configuration';
import { ConfigurationAuthorityRequestSchema, type ConfigurationAuthorityRequest } from './configuration-authority-protocol';

/** Recompile current authority with per-statement and lock timeouts. A superseded request
 * is denied, while an exact new suspended snapshot can still remove authority
 * after a user's OS access is revoked. The result is a point-in-time check,
 * never a capability, installation receipt or substitute for provider state. */
export async function authorizeConfigurationWork(options: ConfigurationProducerOptions, input: ConfigurationAuthorityRequest): Promise<boolean> {
    if (!options.enabled) return false;
    const parsed = ConfigurationAuthorityRequestSchema.safeParse(input);
    if (!parsed.success) return false;
    const request = parsed.data;
    try {
        return await options.database.transaction(async tx => {
            await tx.execute(sql`set local statement_timeout = '5000ms'`);
            await tx.execute(sql`set local lock_timeout = '2000ms'`);
            // Match the producer/delivery lock order; never lock a delivery row
            // before its computer. Provider work cannot run under these locks.
            const [computer] = await tx.select({ id: computers.id }).from(computers)
                .where(eq(computers.id, request.scope.computerId)).limit(1).for('update');
            if (!computer) return false;
            const [target] = await tx.select().from(computerConfigurations).where(and(
                eq(computerConfigurations.id, request.configurationId), eq(computerConfigurations.computerId, computer.id))).limit(1);
            if (!target || target.revision !== request.revision || target.digest !== request.digest
                || target.computerGeneration !== request.scope.computerGeneration || target.providerInstanceId !== request.scope.providerInstanceId
                || target.dataVolumeId !== request.scope.dataVolumeId || target.fenceToken !== request.scope.fenceToken) return false;
            const current = await produceComputerConfigurationInTransaction(tx, computer.id, options.osAccessMode);
            if (!('configurationId' in current) || current.configurationId !== target.id) return false;
            const [delivery] = await tx.select().from(computerConfigurationDeliveries).where(and(
                eq(computerConfigurationDeliveries.configurationId, target.id), isNull(computerConfigurationDeliveries.supersededAt))).limit(1).for('share');
            if (!delivery || (request.operation === 'reload' && !delivery.preparedAt)) return false;
            const [writer] = await tx.select({ generation: computerInstances.generation }).from(computerInstances).where(and(
                eq(computerInstances.computerId, computer.id), eq(computerInstances.generation, target.computerGeneration),
                eq(computerInstances.providerInstanceId, target.providerInstanceId), eq(computerInstances.fenceToken, target.fenceToken),
                isNull(computerInstances.fencedAt), eq(computerInstances.observedState, 'running'),
                sql`${computerInstances.observedAt} >= clock_timestamp() - interval '5 minutes'`,
                sql`${computerInstances.observedAt} <= clock_timestamp() + interval '30 seconds'`)).limit(1).for('share');
            return Boolean(writer);
        });
    } catch { throw new Error('configuration_authority_unavailable'); }
}
