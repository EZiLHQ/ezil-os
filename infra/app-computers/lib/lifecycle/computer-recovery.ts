import { createHash } from 'node:crypto';
import { z } from 'zod';
import { LifecycleDeploymentSchema, parseLifecycleWork, type LifecycleIntent, type LifecycleWork } from './intent.js';
import type { Dependencies } from './aws.js';

const uuid = z.string().uuid().regex(/^[a-f0-9-]+$/), generation = z.number().int().min(1).max(2147483647);
export const ComputerRecoveryIntentV2Schema = z.object({ schemaVersion: z.literal(2), operation: z.literal('recover'),
    jobId: uuid, computerId: uuid, revision: generation, targetGeneration: generation, fenceToken: uuid,
    source: z.object({ schemaVersion: z.union([z.literal(1), z.literal(2)]), jobId: uuid, digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
    dataVolumeId: z.string().regex(/^vol-[a-f0-9]{17}$/), dataScope: z.object({ generation, fenceToken: uuid }).strict(), deployment: LifecycleDeploymentSchema,
}).strict().refine(i => i.source.jobId !== i.jobId && i.targetGeneration > i.dataScope.generation && i.fenceToken !== i.dataScope.fenceToken);
export type ComputerRecoveryIntent = z.infer<typeof ComputerRecoveryIntentV2Schema>;
export type ComputerLifecycleIntent = LifecycleIntent | ComputerRecoveryIntent;
export function parseComputerLifecycleWork(work: LifecycleWork): ComputerLifecycleIntent {
    try {
        if (!work || typeof work.document !== 'string' || Buffer.byteLength(work.document) > 16384
            || !/^[a-f0-9]{64}$/.test(work.digest) || !(work.createdAt instanceof Date) || !Number.isFinite(work.createdAt.getTime())
            || createHash('sha256').update(work.document).digest('hex') !== work.digest) throw new Error();
        return JSON.parse(work.document).schemaVersion === 2 ? ComputerRecoveryIntentV2Schema.parse(JSON.parse(work.document)) : parseLifecycleWork(work);
    } catch { throw new Error('lifecycle_invalid'); }
}
export const FencedWritersSchema = z.array(z.object({ instanceId: z.string().regex(/^i-[a-f0-9]{17}$/), generation, fenceToken: uuid,
    observedAt: z.string().datetime(), fencedAt: z.string().datetime() }).strict()).max(128)
    .refine(rows => new Set(rows.map(r => r.instanceId)).size === rows.length && new Set(rows.map(r => r.generation)).size === rows.length);
export type FencedWriters = z.infer<typeof FencedWritersSchema>;

/** Historical identities come only from signed current control-plane authority.
 * Missing EC2 history is acceptable only for an already recorded old fence;
 * this function must never observe newly allocated or uncertain target IDs. */
export async function observeRecoveryWriters(i: ComputerRecoveryIntent, writers: FencedWriters, started: number, deps: Dependencies) {
    FencedWritersSchema.parse(writers);
    if (writers.some(w => w.generation >= i.targetGeneration || w.fenceToken === i.fenceToken
        || Date.parse(w.observedAt) > Date.parse(w.fencedAt) + 5000 || Date.parse(w.fencedAt) > started + 5000)) throw new Error('lifecycle_fence_invalid');
    for (let offset = 0; offset < writers.length; offset += 8) await Promise.all(writers.slice(offset, offset + 8).map(async w => {
        let rows;
        try { rows = await deps.instances([w.instanceId]); }
        catch (error) { if (error instanceof Error && error.name === 'InvalidInstanceID.NotFound') return; throw error; }
        if (!rows.length) return;
        const row = rows[0], v = row?.instance, d = i.deployment;
        const expected = { 'ezil:managed-by': 'app-computer-platform', 'ezil:stage': d.namespace, 'ezil:computer-id': i.computerId,
            'ezil:generation': String(w.generation), 'ezil:fence-token': w.fenceToken };
        if (rows.length !== 1 || row?.owner !== d.accountId || v?.InstanceId !== w.instanceId || v.State?.Name !== 'terminated'
            || v.Placement?.AvailabilityZone !== d.availabilityZone || !Object.entries(expected).every(([key,value]) =>
                v.Tags?.filter(t => t.Key === key).length === 1 && v.Tags.find(t => t.Key === key)?.Value === value)) throw new Error('lifecycle_fence_invalid');
    }));
}
