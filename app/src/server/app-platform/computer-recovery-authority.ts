import { z } from 'zod';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { db } from '@/server/db';
import { computerInstances, computerLifecycleJobs as jobs, computerLifecycleOutbox as outbox,
    computerLifecycleIntents as intents, computerRecoveryIntents as recoveries } from '@/server/db/schema';
import { parseComputerRecoveryWork, type ComputerRecoveryIntentV2 } from './computer-recovery-protocol';
import { parseLifecycleWork } from './lifecycle-protocol';

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/);
export const ComputerRecoveryAuthorityRequestSchema = z.object({ schemaVersion: z.literal(2),
    computerId: uuid, jobId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type ComputerRecoveryAuthorityRequest = z.infer<typeof ComputerRecoveryAuthorityRequestSchema>;
export const FencedWritersSchema = z.array(z.object({ instanceId: z.string().regex(/^i-[a-f0-9]{17}$/),
    generation: z.number().int().min(1).max(2147483647), fenceToken: uuid,
    observedAt: z.string().datetime(), fencedAt: z.string().datetime(),
}).strict()).max(128).refine(rows => new Set(rows.map(r => r.instanceId)).size === rows.length
    && new Set(rows.map(r => r.generation)).size === rows.length);
export type FencedWriters = z.infer<typeof FencedWritersSchema>;

/** Server records only. This does not itself prove current EC2/EBS state. A
 * workflow must independently observe these exact writers and the retained
 * disk before attaching it; the consumer observes them again before commit. */
export async function loadRecoveryWriters(tx: Transaction, i: ComputerRecoveryIntentV2): Promise<FencedWriters | null> {
    const table = i.source.schemaVersion === 1 ? intents : recoveries;
    const document = i.source.schemaVersion === 1
        ? sql<string>`public.ezil_lifecycle_intent_document(${intents})`
        : sql<string>`public.ezil_computer_recovery_document(${recoveries})`;
    const [source] = await tx.select({ document, digest: table.digest, createdAt: table.createdAt,
        status: jobs.status, errorCode: jobs.errorCode, deliveredAt: outbox.deliveredAt }).from(table)
        .innerJoin(jobs, eq(jobs.id, table.jobId)).innerJoin(outbox, eq(outbox.jobId, table.jobId))
        .where(and(eq(table.jobId, i.source.jobId), eq(table.computerId, i.computerId))).limit(1);
    if (!source || !['failed', 'cancelled'].includes(source.status) || source.errorCode !== 'lifecycle_recovered'
        || !source.deliveredAt || source.digest !== i.source.digest) return null;
    const old = i.source.schemaVersion === 1 ? parseLifecycleWork(source) : parseComputerRecoveryWork(source);
    if (old.computerId !== i.computerId || old.revision + 1 !== i.revision || old.targetGeneration >= i.targetGeneration
        || (old.dataVolumeId !== null && old.dataVolumeId !== i.dataVolumeId)
        || ['accountId', 'region', 'availabilityZone', 'namespace', 'dataKeyArn'].some(key =>
            old.deployment[key as keyof typeof old.deployment] !== i.deployment[key as keyof typeof i.deployment])) return null;
    const scopeMatches = (generation: number | null, fenceToken: string | null) =>
        i.dataScope.generation === generation && i.dataScope.fenceToken === fenceToken;
    if (!scopeMatches(old.targetGeneration, old.fenceToken) && !(old.schemaVersion === 2
        ? scopeMatches(old.dataScope.generation, old.dataScope.fenceToken)
        : scopeMatches(old.previousGeneration, old.previousFenceToken))) return null;
    const rows = await tx.select().from(computerInstances).where(eq(computerInstances.computerId, i.computerId))
        .orderBy(asc(computerInstances.generation)).limit(129).for('update');
    if (rows.some(r => !r.fencedAt || !r.observedAt || r.observedState !== 'stopped' || r.generation >= i.targetGeneration
        || r.fenceToken === i.fenceToken || r.observedAt.getTime() > r.fencedAt.getTime() + 5000
        || r.fencedAt.getTime() > Date.now() + 5000)) return null;
    const parsed = FencedWritersSchema.safeParse(rows.map(r => ({ instanceId: r.providerInstanceId,
        generation: r.generation, fenceToken: r.fenceToken, observedAt: r.observedAt?.toISOString(), fencedAt: r.fencedAt?.toISOString() })));
    return parsed.success ? parsed.data : null;
}
