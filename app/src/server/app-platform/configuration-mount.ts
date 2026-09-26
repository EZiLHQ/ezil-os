import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { computerConfigurations, computerDataMountAuthorizations as grants,
    computerDataMountDeliveries as deliveries, computerLifecycleJobs } from '@/server/db/schema';
import type { ConfigurationProducerOptions } from './computer-configuration';
import { ComputerMountReceiptSchema } from './computer-mount-protocol';

type Transaction = Parameters<Parameters<ConfigurationProducerOptions['database']['transaction']>[0]>[0];
const envelope = z.object({ suspended: z.boolean(), preparedInstallations: z.array(z.unknown()),
    approvedInstallations: z.array(z.unknown()) });

/** Call only after recompiling current authority and locking the computer.
 * Desired metadata may exist before mounting; host delivery and installation
 * acknowledgement require the exact completed mount for this lifecycle job.
 * This is recorded evidence, not a live filesystem or application health probe. */
export async function configurationMountConfirmed(tx: Transaction, target: typeof computerConfigurations.$inferSelect): Promise<boolean> {
    let parsed: ReturnType<typeof envelope.safeParse>;
    try { parsed = envelope.safeParse(JSON.parse(target.configuration)); } catch { return false; }
    if (!parsed.success) return false;
    // Removing all authority must remain possible after mount revocation.
    // A suspended flag alone cannot exempt a configuration containing apps.
    if (parsed.data.suspended) return parsed.data.preparedInstallations.length === 0 && parsed.data.approvedInstallations.length === 0;
    const [candidate] = await tx.select({ id: grants.id }).from(grants)
        .innerJoin(deliveries, eq(deliveries.authorizationId, grants.id))
        .innerJoin(computerLifecycleJobs, eq(computerLifecycleJobs.id, grants.lifecycleJobId)).where(and(
            eq(grants.computerId, target.computerId), eq(grants.computerGeneration, target.computerGeneration),
            eq(grants.fenceToken, target.fenceToken), eq(grants.providerInstanceId, target.providerInstanceId),
            eq(grants.dataVolumeId, target.dataVolumeId), isNotNull(deliveries.mountedAt)))
        // Grants issued in the same second are ordered by lifecycle history,
        // never by their random UUIDs or second-rounded execution timestamps.
        .orderBy(desc(computerLifecycleJobs.createdAt), desc(grants.id)).limit(1);
    if (!candidate) return false;
    // Lock computer/runtime/job/writer before the grant, matching mount receipt
    // settlement. This also rejects a later stop/start on the SAME generation.
    const [current] = await tx.execute<{ current: boolean }>(sql`SELECT public.ezil_data_mount_current(${grants}) AS current
        FROM ${grants} WHERE ${grants.id}=${candidate.id}`);
    if (!current?.current) return false;
    // Re-read after locking: revocation may have committed during the first
    // read. Retain grant authority through the caller's acknowledgement commit;
    // a completed delivery is immutable and needs no separate row lock.
    const [record] = await tx.select({ grant: grants, delivery: deliveries }).from(grants)
        .innerJoin(deliveries, eq(deliveries.authorizationId, grants.id))
        .where(eq(grants.id, candidate.id)).limit(1).for('share', { of: grants });
    if (!record || record.grant.revokedAt || !record.delivery.mountedAt || !record.delivery.receipt) return false;
    const { grant: a, delivery: d } = record;
    // Grant expiry bounds mount execution, not continued use of a completed
    // mount. Receipt acceptance must have happened within that original grant.
    if (d.mountedAt! < a.issuedAt || d.mountedAt! >= a.expiresAt) return false;
    try {
        const r = ComputerMountReceiptSchema.safeParse(JSON.parse(d.receipt!));
        return r.success && r.data.authorizationId === a.id && r.data.digest === a.digest
            && r.data.computerId === a.computerId && r.data.volumeId === a.dataVolumeId && r.data.filesystemUuid === a.filesystemUuid
            && r.data.scope.computerId === a.computerId && r.data.scope.computerGeneration === a.computerGeneration
            && r.data.scope.fenceToken === a.fenceToken && r.data.scope.providerInstanceId === a.providerInstanceId
            && r.data.scope.dataVolumeId === a.dataVolumeId;
    } catch { return false; }
}
